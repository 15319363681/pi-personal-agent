import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeStore } from '../src/runtime/store.mjs';
import { WorkspaceArtifacts } from '../src/runtime/workspace-artifacts.mjs';
import { WorkspaceAdmission, workspaceIdentity } from '../src/runtime/workspace.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-artifacts-'));
  const root = join(dir, 'workspace');
  await mkdir(root);
  const store = await RuntimeStore.open(join(dir, 'agent.sqlite'));
  let identity = await workspaceIdentity(root);
  const artifacts = new WorkspaceArtifacts({ store, getWorkspace: async () => identity });
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); });
  return { dir, root, store, artifacts, setIdentity: (value) => { identity = value; } };
}

test('prepared artifacts persist exact text and require a content-bound confirmation', async (t) => {
  const { root, store, artifacts } = await fixture(t);
  const item = await artifacts.prepare({ path: 'summary.md', content: '# 真实产物' });
  assert.equal(item.status, 'pending');
  assert.equal((await artifacts.get(item.id)).content, '# 真实产物');
  await assert.rejects(artifacts.create({ id: item.id, sha256: item.sha256 }), /artifact_confirmation_required/);
  await assert.rejects(artifacts.create({ id: item.id, sha256: '0'.repeat(64), confirm: true }), /artifact_content_changed/);
  const created = await artifacts.create({ id: item.id, sha256: item.sha256, confirm: true });
  assert.equal(created.status, 'created');
  assert.equal(await readFile(join(root, 'summary.md'), 'utf8'), '# 真实产物');
  const reopened = new WorkspaceArtifacts({ store, getWorkspace: async () => workspaceIdentity(root) });
  assert.equal(reopened.list()[0].status, 'created');
  assert.equal((await reopened.create({ id: item.id, sha256: item.sha256, confirm: true })).status, 'created');
});

test('concurrent confirmations create once and preserve existing files on conflict', async (t) => {
  const { root, artifacts } = await fixture(t);
  const item = await artifacts.prepare({ path: 'summary.md', content: 'result' });
  const outcomes = await Promise.allSettled([1,2].map(() => artifacts.create({ id: item.id, sha256: item.sha256, confirm: true })));
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(await readFile(join(root, 'summary.md'), 'utf8'), 'result');
  const conflict = await artifacts.prepare({ path: 'summary.md', content: 'replace' });
  await assert.rejects(artifacts.create({ id: conflict.id, sha256: conflict.sha256, confirm: true }), /workspace_file_exists/);
  assert.equal((await artifacts.get(conflict.id)).status, 'failed');
  assert.equal(await readFile(join(root, 'summary.md'), 'utf8'), 'result');
});

test('artifact creation is bound to the authorized workspace and validates requests', async (t) => {
  const { artifacts, root, setIdentity } = await fixture(t);
  await assert.rejects(artifacts.prepare({ path: '../escape.md', content: 'text' }), /workspace_escape/);
  await assert.rejects(artifacts.prepare({ path: 'code.js', content: 'text' }), /workspace_output_invalid/);
  const item = await artifacts.prepare({ path: 'summary.md', content: 'text' });
  setIdentity(null);
  await assert.rejects(artifacts.create({ id: item.id, sha256: item.sha256, confirm: true }), /workspace_not_authorized/);
  const other = join(root, 'other');
  await mkdir(other);
  setIdentity(await workspaceIdentity(other));
  await assert.rejects(artifacts.create({ id: item.id, sha256: item.sha256, confirm: true }), /artifact_workspace_changed/);
  await assert.rejects(artifacts.create({ id: item.id, sha256: item.sha256, confirm: true, path: 'other.md' }), /artifact_request_invalid/);
});

test('startup reconciliation requires recorded file identity plus matching actual bytes', async (t) => {
  const { root, artifacts, store } = await fixture(t);
  const exact = await artifacts.prepare({ path: 'exact.md', content: 'exact' });
  const unknown = await artifacts.prepare({ path: 'unknown.md', content: 'unknown' });
  const modified = await artifacts.prepare({ path: 'modified.md', content: 'expected' });
  for (const item of [exact, modified]) {
    store.db.prepare("UPDATE workspace_artifacts SET status='writing' WHERE id=?").run(item.id);
    const workspace = await WorkspaceAdmission.open(root, 'workspace-write');
    await workspace.createText(item.path, item.content, { onCreated: (identity) => store.db.prepare('UPDATE workspace_artifacts SET file_identity_json=? WHERE id=?').run(JSON.stringify(identity), item.id) });
  }
  await writeFile(join(root, modified.path), 'user edit');
  await writeFile(join(root, unknown.path), unknown.content);
  store.db.prepare("UPDATE workspace_artifacts SET status='writing' WHERE id=?").run(unknown.id);
  await artifacts.reconcile();
  assert.equal((await artifacts.get(exact.id)).status, 'created');
  assert.equal((await artifacts.get(modified.id)).status, 'needs_attention');
  assert.equal((await artifacts.get(unknown.id)).status, 'needs_attention');
  assert.equal(await readFile(join(root, modified.path), 'utf8'), 'user edit');
});
