import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeStore } from '../src/runtime/store.mjs';
import { BackupManager } from '../src/runtime/backup.mjs';

test('product backup preserves a consistent database and omits model credentials', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-product-backup-'));
  const store = await RuntimeStore.open(join(dir, 'agent.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  store.setMeta('test_value', 'preserved');
  const manager = new BackupManager(store, join(dir, 'snapshots'));
  const archive = await manager.createPackage([{ id: 'model', provider: 'openai-compatible', model: 'm', baseUrl: 'https://example.invalid/v1', credentialRef: 'private-reference', apiKey: 'secret-value' }]);
  assert.equal(archive.includes('secret-value'), false);
  assert.equal(archive.includes('private-reference'), false);
  const preview = await manager.inspectPackage(archive);
  assert.equal(preview.modelCount, 1);
  assert.match(preview.digest, /^[a-f0-9]{64}$/);
  const file = join(dir, 'snapshot.sqlite');
  await writeFile(file, preview.database);
  const restored = await RuntimeStore.open(file);
  assert.equal(restored.getMeta('test_value'), 'preserved');
  restored.close();
});

test('product backup rejects tampering, malformed data and unrelated SQLite databases', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-product-backup-'));
  const store = await RuntimeStore.open(join(dir, 'agent.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const manager = new BackupManager(store, join(dir, 'snapshots'));
  const archive = await manager.createPackage([]);
  const parsed = JSON.parse(archive);
  parsed.payload.models.push({ id: 'tampered' });
  await assert.rejects(manager.inspectPackage(JSON.stringify(parsed)), /backup_invalid/);
  await assert.rejects(manager.inspectPackage('{}'), /backup_invalid/);
  await assert.rejects(manager.inspectPackage('x'.repeat(32 * 1024 * 1024 + 1)), /backup_invalid/);
});

test('backup inspection rejects a re-signed package with credential fields or duplicate model ids', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-product-backup-'));
  const store = await RuntimeStore.open(join(dir, 'agent.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const manager = new BackupManager(store, join(dir, 'snapshots'));
  const archive = await manager.createPackage([{ id: 'model', provider: 'openai-compatible', model: 'm' }]);
  const sign = payload => JSON.stringify({ payload, digest: createHash('sha256').update(JSON.stringify(payload)).digest('hex') });
  const payload = JSON.parse(archive).payload;
  payload.models[0].credentialRef = 'untrusted';
  await assert.rejects(manager.inspectPackage(sign(payload)), /backup_invalid/);
  delete payload.models[0].credentialRef;
  payload.models.push({ ...payload.models[0] });
  await assert.rejects(manager.inspectPackage(sign(payload)), /backup_invalid/);
});

test('backup inspection rejects an unrelated database with counterfeit table names', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-product-backup-'));
  const store = await RuntimeStore.open(join(dir, 'agent.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const manager = new BackupManager(store, join(dir, 'snapshots'));
  const path = join(dir, 'counterfeit.sqlite');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE meta(x); CREATE TABLE tasks(x); CREATE TABLE outbox(x); CREATE TABLE settings(x);');
  db.close();
  const payload = { version: 1, database: (await readFile(path)).toString('base64'), models: [] };
  const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  await assert.rejects(manager.inspectPackage(JSON.stringify({ payload, digest })), /backup_invalid/);
});

