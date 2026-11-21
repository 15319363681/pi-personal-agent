import { createHash, randomUUID } from 'node:crypto';
import { WorkspaceAdmission, assertWorkspaceIdentity } from './workspace.mjs';

const failure = (code) => Object.assign(new Error(code), { code });
const hash = (content) => createHash('sha256').update(content).digest('hex');
const sameIdentity = (left, right) => left && right && ['dev', 'ino', 'birthtimeNs'].every((key) => left[key] === right[key]);

export class WorkspaceArtifacts {
  constructor({ store, getWorkspace, logger }) {
    this.store = store;
    this.getWorkspace = getWorkspace;
    this.logger = logger;
    this.pendingWrites = new Set();
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS workspace_artifacts (' +
      'id TEXT PRIMARY KEY,path TEXT NOT NULL,content TEXT NOT NULL,sha256 TEXT NOT NULL,' +
      'workspace_json TEXT NOT NULL,sources_json TEXT NOT NULL,status TEXT NOT NULL,' +
      'reason_code TEXT,file_identity_json TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)'
    );
  }

  #item(row) {
    if (!row) throw failure('artifact_not_found');
    return { id: row.id, path: row.path, content: row.content, sha256: row.sha256,
      workspace: JSON.parse(row.workspace_json), sources: JSON.parse(row.sources_json),
      status: row.status, reasonCode: row.reason_code, createdAt: row.created_at,
      updatedAt: row.updated_at, fileIdentity: row.file_identity_json ? JSON.parse(row.file_identity_json) : null };
  }

  list() { return this.store.db.prepare('SELECT * FROM workspace_artifacts ORDER BY created_at DESC, id DESC LIMIT 100').all().map((row) => {
    const { content, fileIdentity, ...item } = this.#item(row);
    return { ...item, size: Buffer.byteLength(content) };
  }); }

  get(id) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw failure('artifact_request_invalid');
    return this.#item(this.store.db.prepare('SELECT * FROM workspace_artifacts WHERE id=?').get(id));
  }

  async #workspace() {
    const identity = await this.getWorkspace();
    if (!identity) throw failure('workspace_not_authorized');
    await assertWorkspaceIdentity(identity);
    return identity;
  }

  async prepare({ path, content }, sources = []) {
    const identity = await this.#workspace();
    const workspace = await WorkspaceAdmission.open(identity.root);
    if (!sameIdentity(workspace.identity, identity)) throw failure('artifact_workspace_changed');
    await workspace.validateTextTarget(path, content);
    const current = await this.#workspace();
    if (current.root !== identity.root || !sameIdentity(current, identity)) throw failure('artifact_workspace_changed');
    const id = randomUUID(), now = Date.now();
    this.store.db.prepare('INSERT INTO workspace_artifacts VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
      id, path, content, hash(content), JSON.stringify(identity), JSON.stringify(sources), 'pending', null, null, now, now
    );
    await this.#log('artifact.prepared', { artifactId: id, status: 'pending' });
    return this.get(id);
  }

  async create(params) {
    const operation = this.#create(params);
    this.pendingWrites.add(operation);
    try { return await operation; }
    finally { this.pendingWrites.delete(operation); }
  }

  async waitForIdle() {
    while (this.pendingWrites.size) await Promise.allSettled([...this.pendingWrites]);
  }

  async #create(params) {
    if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some((key) => !['id','sha256','confirm'].includes(key))) throw failure('artifact_request_invalid');
    if (params.confirm !== true) throw failure('artifact_confirmation_required');
    const item = this.get(params.id);
    if (params.sha256 !== item.sha256 || hash(item.content) !== item.sha256) throw failure('artifact_content_changed');
    const identity = await this.#workspace();
    if (identity.root !== item.workspace.root || !sameIdentity(identity, item.workspace)) throw failure('artifact_workspace_changed');
    if (item.status === 'created') return item;
    const changed = this.store.db.prepare("UPDATE workspace_artifacts SET status='writing',reason_code=NULL,updated_at=? WHERE id=? AND status='pending'").run(Date.now(), item.id);
    if (!changed.changes) throw failure('artifact_not_pending');
    try {
      const workspace = await WorkspaceAdmission.open(identity.root, 'workspace-write');
      if (!sameIdentity(workspace.identity, identity)) throw failure('artifact_workspace_changed');
      await workspace.createText(item.path, item.content, { onCreated: (fileIdentity) => {
        this.store.db.prepare('UPDATE workspace_artifacts SET file_identity_json=?,updated_at=? WHERE id=?').run(JSON.stringify(fileIdentity), Date.now(), item.id);
      } });
      this.#state(item.id, 'created');
      await this.#log('artifact.created', { artifactId: item.id, status: 'created' });
      return this.get(item.id);
    } catch (error) {
      const code = error.code?.startsWith('artifact_') ? error.code : /^workspace_[a-z_]+$/.test(error.message) ? error.message : 'artifact_write_failed';
      this.#state(item.id, this.get(item.id).fileIdentity ? 'needs_attention' : 'failed', code);
      await this.#log('artifact.failed', { artifactId: item.id, status: this.get(item.id).status, errorCode: code });
      throw failure(code);
    }
  }

  #state(id, status, reasonCode = null) {
    this.store.db.prepare('UPDATE workspace_artifacts SET status=?,reason_code=?,updated_at=? WHERE id=?').run(status, reasonCode, Date.now(), id);
  }

  async reconcile() {
    const rows = this.store.db.prepare("SELECT * FROM workspace_artifacts WHERE status='writing'").all();
    for (const row of rows) {
      const item = this.#item(row);
      try {
        const identity = await this.#workspace();
        if (!item.fileIdentity || identity.root !== item.workspace.root || !sameIdentity(identity, item.workspace)) throw failure('artifact_result_unknown');
        const workspace = await WorkspaceAdmission.open(identity.root);
        const actual = await workspace.read(item.path);
        if (actual.status !== 'ok' || !sameIdentity(actual.identity, item.fileIdentity) || hash(actual.data) !== item.sha256) throw failure('artifact_result_unknown');
        this.store.db.prepare("UPDATE workspace_artifacts SET status='created',reason_code=NULL,updated_at=? WHERE id=? AND status='writing'").run(Date.now(), item.id);
      } catch {
        this.store.db.prepare("UPDATE workspace_artifacts SET status='needs_attention',reason_code='artifact_result_unknown',updated_at=? WHERE id=? AND status='writing'").run(Date.now(), item.id);
      }
      await this.#log('artifact.reconciled', { artifactId: item.id, status: this.get(item.id).status });
    }
  }

  async #log(event, fields) { try { await this.logger?.write(event, fields); } catch {} }
}
