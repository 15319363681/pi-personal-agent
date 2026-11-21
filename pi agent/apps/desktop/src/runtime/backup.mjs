import { mkdir, copyFile, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const modelFields = new Set(['id', 'name', 'provider', 'model', 'baseUrl', 'apiFormat', 'supportsImages', 'revision']);
const requiredColumns = {
  meta: ['key', 'value'],
  tasks: ['id', 'status', 'goal', 'contract_json', 'contract_hash', 'task_version', 'budget_json', 'budget_reserved_cents', 'budget_used_cents', 'permission_json', 'checkpoint_json', 'artifact_json', 'reason_code', 'created_at', 'updated_at'],
  outbox: ['id', 'task_id', 'kind', 'target', 'payload_json', 'status', 'attempts', 'receipt', 'created_at', 'updated_at'],
  settings: ['id', 'provider', 'model', 'config_json', 'created_at', 'updated_at']
};

function validModels(models) {
  const ids = new Set();
  for (const model of models) {
    if (!model || typeof model !== 'object' || Array.isArray(model) ||
        Object.keys(model).some(key => !modelFields.has(key)) ||
        typeof model.id !== 'string' || !model.id.trim() || model.id.length > 120 || ids.has(model.id)) return false;
    for (const [key, value] of Object.entries(model)) {
      if (key === 'supportsImages' ? typeof value !== 'boolean' : typeof value !== 'string' || value.length > 4096) return false;
    }
    ids.add(model.id);
  }
  return true;
}

export class BackupManager {
  constructor(store, dir) { this.store = store; this.dir = dir; }

  async create() {
    await mkdir(this.dir, { recursive: true });
    const path = join(this.dir, `${Date.now()}-${randomUUID()}.sqlite`);
    const source = new DatabaseSync(this.store.path);
    try {
      // DatabaseSync in the supported Electron/Node runtime does not expose
      // the newer backup() helper. VACUUM INTO is SQLite's portable online
      // snapshot primitive and preserves a consistent database image.
      source.prepare('VACUUM INTO ?').run(path);
    } finally {
      try { source.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch {}
      source.close();
    }
    return path;
  }

  async createPackage(models) {
    const snapshot = await this.create();
    try {
      const database = await readFile(snapshot);
      const safeModels = models.map(({ id, name, provider, model, baseUrl, apiFormat, supportsImages, revision }) =>
        ({ id, name, provider, model, baseUrl, apiFormat, supportsImages, revision }));
      const payload = { version: 1, database: database.toString('base64'), models: safeModels };
      const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      const archive = JSON.stringify({ payload, digest });
      if (Buffer.byteLength(archive) > 32 * 1024 * 1024) throw Error('backup_invalid');
      return archive;
    } finally {
      await rm(snapshot, { force: true });
    }
  }

  async inspectPackage(archive) {
    if (typeof archive !== 'string' || Buffer.byteLength(archive) > 32 * 1024 * 1024) throw Error('backup_invalid');
    let parsed;
    try { parsed = JSON.parse(archive); } catch { throw Error('backup_invalid'); }
    const payload = parsed?.payload;
    if (!payload || payload.version !== 1 || !Array.isArray(payload.models) || payload.models.length > 100 || !validModels(payload.models) ||
        typeof payload.database !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.database) ||
        typeof parsed.digest !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.digest) ||
        createHash('sha256').update(JSON.stringify(payload)).digest('hex') !== parsed.digest) throw Error('backup_invalid');
    const database = Buffer.from(payload.database, 'base64');
    if (database.toString('base64') !== payload.database || !database.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) throw Error('backup_invalid');
    await mkdir(this.dir, { recursive: true });
    const path = join(this.dir, `${randomUUID()}.inspect.sqlite`);
    try {
      await writeFile(path, database, { flag: 'wx', mode: 0o600 });
      const check = new DatabaseSync(path, { readOnly: true });
      try {
        if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw Error('backup_invalid');
        const tables = new Set(check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
        for (const [table, required] of Object.entries(requiredColumns)) {
          if (!tables.has(table)) throw Error('backup_invalid');
          const columns = new Set(check.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
          if (!required.every(name => columns.has(name))) throw Error('backup_invalid');
        }
      } finally { check.close(); }
    } catch { throw Error('backup_invalid'); }
    finally { await rm(path, { force: true }); }
    return { database, models: payload.models, modelCount: payload.models.length, digest: parsed.digest };
  }

  async restore(path) {
    const check = new DatabaseSync(path, { readOnly: true });
    try {
      const ok = check.prepare('PRAGMA integrity_check').get().integrity_check === 'ok';
      if (!ok) throw Error('backup_corrupt');
    } finally { check.close(); }

    // Freeze before replacing the image. The caller must close/reopen the
    // writer and explicitly clear recovery_mode after reconciliation.
    this.store.close();
    await copyFile(path, this.store.path);
    // A copied WAL/SHM pair would describe a different snapshot; remove any
    // stale sidecars before the next RuntimeStore.open().
    await Promise.allSettled([
      rm(`${this.store.path}-wal`, { force: true }),
      rm(`${this.store.path}-shm`, { force: true })
    ]);
    const restored = new DatabaseSync(this.store.path);
    try { restored.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run('recovery_mode', 'true'); }
    finally { try { restored.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch {} restored.close(); }
  }
}
