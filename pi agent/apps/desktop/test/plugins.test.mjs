import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeStore } from '../src/runtime/store.mjs';
import { RuntimePlugins, normalizePluginDefinition } from '../src/runtime/plugins.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RpcClient } from '../src/rpc.mjs';
import { LocalRuntimeLogger } from '../src/runtime/logging.mjs';

const definition = () => ({ id: 'text_stats', name: '文本统计', description: '计算字符数', source: '(input) => ({ length: input.text.length })', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, tests: [{ name: '基本样例', input: { text: 'abc' }, expected: { length: 3 } }] });
async function fixture(run = async () => ({ length: 3 })) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-plugin-state-'));
  const store = await RuntimeStore.open(join(dir, 'agent.sqlite'));
  const plugins = new RuntimePlugins({ store, dataDir: dir, logger: new LocalRuntimeLogger(dir), worker: { run } });
  return { dir, store, plugins, async close() { await plugins.close(); store.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('plugin definitions reject executable capability fields, invalid schema and unbounded payloads', () => {
  assert.equal(normalizePluginDefinition(definition()).id, 'text_stats');
  for (const patch of [{ command: 'node' }, { source: 'x'.repeat(32769) }, { id: '../escape' }, { tests: [] }, { inputSchema: { type: 'object', properties: { ref: { $ref: 'https://example.com' } } } }]) {
    assert.throws(() => normalizePluginDefinition({ ...definition(), ...patch }), { code: 'plugin_definition_invalid' });
  }
});

test('draft versions persist and require matching passing test and explicit user confirmation', async () => {
  const f = await fixture();
  try {
    const draft = await f.plugins.saveDraft({ definition: definition() });
    assert.equal(draft.version, 1);
    assert.equal(draft.enabled, false);
    await assert.rejects(f.plugins.setEnabled({ id: draft.id, version: 1, enabled: true, confirm: true }), { code: 'plugin_test_required' });
    const result = await f.plugins.testPlugin({ id: draft.id, version: 1 });
    assert.equal(result.status, 'passed');
    await assert.rejects(f.plugins.setEnabled({ id: draft.id, version: 1, enabled: true }), { code: 'plugin_confirmation_required' });
    await f.plugins.setEnabled({ id: draft.id, version: 1, enabled: true, confirm: true });
    assert.deepEqual(await f.plugins.run({ id: draft.id, version: 1, arguments: { text: 'abc' } }), { length: 3 });
    const restored = new RuntimePlugins({ store: f.store, dataDir: f.dir, worker: { run: async () => ({ length: 3 }) } });
    assert.equal(restored.list()[0].enabled, true);
    assert.equal(restored.get({ id: draft.id }).tests[0].status, 'passed');
    await restored.close();
  } finally { await f.close(); }
});

test('updates invalidate confirmation and reject stale tools or concurrent draft overwrites', async () => {
  const f = await fixture();
  try {
    await f.plugins.saveDraft({ definition: definition() });
    await f.plugins.testPlugin({ id: 'text_stats', version: 1 });
    await f.plugins.setEnabled({ id: 'text_stats', version: 1, enabled: true, confirm: true });
    await f.plugins.saveDraft({ definition: { ...definition(), name: '新版' }, baseVersion: 1 });
    assert.equal(f.plugins.list()[0].enabled, false);
    assert.equal(f.plugins.get({ id: 'text_stats' }).versions.length, 2);
    await assert.rejects(f.plugins.run({ id: 'text_stats', version: 1, arguments: { text: 'abc' } }), { code: 'plugin_version_conflict' });
    await assert.rejects(f.plugins.saveDraft({ definition: definition(), baseVersion: 1 }), { code: 'plugin_version_conflict' });
    await assert.rejects(f.plugins.setEnabled({ id: 'text_stats', version: 2, enabled: true, confirm: true }), { code: 'plugin_test_required' });
  } finally { await f.close(); }
});

test('bad arguments, revoked tools and unsupported request fields cannot invoke the worker', async () => {
  let calls = 0;
  const f = await fixture(async () => { calls++; return { length: 3 }; });
  try {
    await f.plugins.saveDraft({ definition: definition() });
    await f.plugins.testPlugin({ id: 'text_stats', version: 1 });
    await f.plugins.setEnabled({ id: 'text_stats', version: 1, enabled: true, confirm: true });
    const tool = f.plugins.createPiTools().find((t) => t.name === 'plugin_text_stats_v1');
    await assert.rejects(f.plugins.run({ id: 'text_stats', version: 1, arguments: { text: 7 } }), { code: 'plugin_arguments_invalid' });
    await assert.rejects(f.plugins.setEnabled({ id: 'text_stats', version: 1, enabled: false, source: 'injected' }), { code: 'plugin_request_invalid' });
    await f.plugins.setEnabled({ id: 'text_stats', version: 1, enabled: false });
    await assert.rejects(tool.execute('old-call', { text: 'abc' }), { code: 'plugin_not_enabled' });
    assert.equal(calls, 1);
  } finally { await f.close(); }
});

test('a test finishing after an update cannot approve the new version and logs exclude payloads', async () => {
  let finish;
  const f = await fixture(() => new Promise((resolve) => { finish = resolve; }));
  try {
    const def = { ...definition(), source: '(input) => ({ length: input.secret_payload.length })' };
    await f.plugins.saveDraft({ definition: def });
    const testing = f.plugins.testPlugin({ id: 'text_stats', version: 1 });
    while (!finish) await new Promise((resolve) => setImmediate(resolve));
    await f.plugins.saveDraft({ definition: { ...definition(), name: 'replacement' }, baseVersion: 1 });
    finish({ length: 3 });
    assert.equal((await testing).status, 'passed');
    assert.equal(f.plugins.list()[0].testStatus, 'untested');
    await assert.rejects(f.plugins.setEnabled({ id: 'text_stats', version: 2, enabled: true, confirm: true }), { code: 'plugin_test_required' });
    const logs = await readFile(join(f.dir, 'logs/runtime.jsonl'), 'utf8');
    assert.doesNotMatch(logs, /secret_payload|基本样例|replacement|input.text|length/);
  } finally { await f.close(); }
});

test('failed tests remain visible and cannot enable a draft', async () => {
  const f = await fixture(async () => { throw Object.assign(Error('secret_output'), { code: 'plugin_timeout' }); });
  try {
    await f.plugins.saveDraft({ definition: definition() });
    const result = await f.plugins.testPlugin({ id: 'text_stats', version: 1 });
    assert.equal(result.status, 'failed');
    assert.equal(result.cases[0].errorCode, 'plugin_timeout');
    await assert.rejects(f.plugins.setEnabled({ id: 'text_stats', version: 1, enabled: true, confirm: true }), { code: 'plugin_test_required' });
    assert.doesNotMatch(JSON.stringify(f.plugins.get({ id: 'text_stats' }).tests), /secret_output/);
  } finally { await f.close(); }
});


test('revocation or an update during execution rejects the result of the old approved tool', async () => {
  const f = await fixture();
  try {
    await f.plugins.saveDraft({ definition: definition() });
    await f.plugins.testPlugin({ id: 'text_stats', version: 1 });
    await f.plugins.setEnabled({ id: 'text_stats', version: 1, enabled: true, confirm: true });
    let finish;
    f.plugins.worker.run = () => new Promise((resolve) => { finish = resolve; });
    const running = f.plugins.run({ id: 'text_stats', version: 1, arguments: { text: 'abc' } });
    await f.plugins.setEnabled({ id: 'text_stats', version: 1, enabled: false });
    finish({ length: 3 });
    await assert.rejects(running, { code: 'plugin_not_enabled' });
    await f.plugins.setEnabled({ id: 'text_stats', version: 1, enabled: true, confirm: true });
    const stale = f.plugins.run({ id: 'text_stats', version: 1, arguments: { text: 'abc' } });
    await f.plugins.saveDraft({ definition: definition(), baseVersion: 1 });
    finish({ length: 3 });
    await assert.rejects(stale, { code: 'plugin_version_conflict' });
  } finally { await f.close(); }
});

test('deleting and recreating an id never reuses an old tool version', async () => {
  const f = await fixture();
  try {
    await f.plugins.saveDraft({ definition: definition() });
    await f.plugins.testPlugin({ id: 'text_stats', version: 1 });
    await f.plugins.setEnabled({ id: 'text_stats', version: 1, enabled: true, confirm: true });
    const old = f.plugins.createPiTools()[0];
    await f.plugins.remove({ id: 'text_stats', version: 1 });
    assert.deepEqual(f.plugins.list(), []);
    assert.equal((await f.plugins.saveDraft({ definition: definition() })).version, 2);
    await f.plugins.testPlugin({ id: 'text_stats', version: 2 });
    await f.plugins.setEnabled({ id: 'text_stats', version: 2, enabled: true, confirm: true });
    await assert.rejects(old.execute('old', { text: 'abc' }), { code: 'plugin_version_conflict' });
    assert.equal(f.plugins.get({ id: 'text_stats' }).versions.length, 2);
  } finally { await f.close(); }
});

test('retesting an enabled version revokes approval and keeps the latest failed record authoritative', async () => {
  const f = await fixture();
  try {
    await f.plugins.saveDraft({ definition: definition() });
    await f.plugins.testPlugin({ id: 'text_stats', version: 1 });
    await f.plugins.setEnabled({ id: 'text_stats', version: 1, enabled: true, confirm: true });
    f.plugins.worker.run = async () => ({ length: 99 });
    const record = await f.plugins.testPlugin({ id: 'text_stats', version: 1 });
    assert.equal(record.status, 'failed');
    assert.equal(f.plugins.get({ id: 'text_stats' }).tests.length, 2);
    assert.equal(f.plugins.list()[0].enabled, false);
    await assert.rejects(f.plugins.setEnabled({ id: 'text_stats', version: 1, enabled: true, confirm: true }), { code: 'plugin_test_required' });
  } finally { await f.close(); }
});


test('desktop Runtime EOF waits for an in-flight plugin test and cleans its Worker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-plugin-shutdown-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/runtime.mjs', import.meta.url))], {
    env: { ...process.env, PI_AGENT_DATA_DIR: dir },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const client = new RpcClient(child);
  try {
    assert.equal((await client.request('plugins.save_draft', { definition: definition() })).ok, true);
    const testing = client.request('plugins.test', { id: 'text_stats', version: 1 });
    const closing = client.close();
    const result = await testing;
    await closing;
    assert.equal(result.ok, true, stderr);
    assert.equal(result.result.test.status, 'passed');
    assert.equal(child.exitCode, 0, stderr);
    assert.deepEqual(await readdir(join(dir, 'plugin-runs')), []);
    const store = await RuntimeStore.open(join(dir, 'agent.sqlite'));
    try {
      const restored = new RuntimePlugins({ store, dataDir: dir });
      assert.equal(restored.get({ id: 'text_stats' }).tests[0].status, 'passed');
      await restored.close();
    } finally { store.close(); }
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
