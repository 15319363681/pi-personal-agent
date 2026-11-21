import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeStore } from '../src/runtime/store.mjs';
import { ReviewedMemory } from '../src/runtime/reviewed-memory.mjs';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-reviewed-memory-'));
  const store = await RuntimeStore.open(join(dir, 'agent.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return { memory: new ReviewedMemory(store), dir };
}
test('memory requires revision-specific approval and editing keeps the approved version until replacement', async t => {
  const { memory } = await fixture(t);
  const first = memory.propose('喜欢中文', 'user');
  assert.equal(memory.snapshot().entries.length, 0);
  assert.throws(() => memory.approve(first.id, 9), { code: 'memory_revision_changed' });
  memory.approve(first.id, first.revision);
  const before = memory.snapshot();
  const edited = memory.update(first.id, first.revision, '喜欢简洁中文');
  assert.equal(memory.snapshot().entries[0].text, '喜欢中文');
  assert.throws(() => memory.approve(first.id, first.revision), { code: 'memory_revision_changed' });
  memory.approve(edited.id, edited.revision);
  assert.notEqual(memory.snapshot().version, before.version);
  assert.equal(memory.snapshot().entries[0].text, '喜欢简洁中文');
  assert.throws(() => memory.delete(first.id, first.revision), { code: 'memory_revision_changed' });
  memory.delete(edited.id, edited.revision);
  assert.equal(memory.snapshot().entries.length, 0);
  assert.equal(memory.list().length, 0);
});
test('rejecting a proposal cannot erase an earlier approved preference', async t => {
  const { memory } = await fixture(t);
  const first = memory.propose('原偏好', 'agent');
  memory.approve(first.id, first.revision);
  const edit = memory.update(first.id, first.revision, '新偏好');
  memory.reject(edit.id, edit.revision);
  assert.equal(memory.snapshot().entries[0].text, '原偏好');
  assert.throws(() => memory.propose('', 'user'), { code: 'memory_text_invalid' });
  assert.throws(() => memory.propose('x'.repeat(2001), 'user'), { code: 'memory_text_invalid' });
});
test('legacy import is pending and idempotent even after a rejected or deleted import', async t => {
  const { memory, dir } = await fixture(t);
  const file = join(dir, 'memory.json');
  await writeFile(file, JSON.stringify([{ id: 'legacy', text: '旧偏好', source: 'old' }, { id: 'gone', text: '已删除', tombstoned: true }, { id: 'bad' }]));
  await memory.importLegacy(file);
  assert.equal(memory.list().length, 1);
  assert.equal(memory.snapshot().entries.length, 0);
  const imported = memory.list()[0];
  memory.reject(imported.id, imported.revision);
  await memory.importLegacy(file);
  assert.equal(memory.list().length, 0);
});
