import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelSettings } from '../src/runtime/model-settings.mjs';

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-model-profiles-'));
  try { await run(new ModelSettings(join(dir, 'settings.json')), dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

const setting = (id) => ({ id, name: id + ' 模型', provider: 'openai-compatible', model: 'model-' + id, baseUrl: 'https://example.test/v1', supportsImages: true });

test('profile names and capabilities survive restart while legacy arrays stay readable', async () => fixture(async (store, dir) => {
  await writeFile(store.path, JSON.stringify([{ id: 'default', provider: 'openai-compatible', model: 'old', baseUrl: 'https://old.test/v1', credentialRef: 'encrypted-reference' }]));
  await store.upsert({ ...setting('second'), apiKey: 'only-in-memory' });
  const reopened = new ModelSettings(store.path);
  assert.equal((await reopened.get('default')).model, 'old');
  assert.equal((await reopened.get('second')).name, 'second 模型');
  assert.equal((await reopened.get('second')).supportsImages, true);
  assert.doesNotMatch(await readFile(store.path, 'utf8'), /only-in-memory|apiKey/);
  assert.deepEqual(await readdir(dir), ['settings.json']);
}));

test('concurrent profile mutations retain every configuration and remove only the selected item', async () => fixture(async (store) => {
  await Promise.all(Array.from({ length: 20 }, (_, index) => store.upsert(setting('model' + index))));
  assert.equal((await store.list()).length, 20);
  const removed = await store.remove('model9');
  assert.equal(removed.id, 'model9');
  assert.equal((await store.list()).length, 19);
  assert.equal(await store.get('model9'), null);
  assert.equal(await store.remove('missing'), null);
  await store.upsert({ ...setting('model9'), apiKey: 'temporary-key' });
  await store.remove('model9');
  assert.equal(await store.getSecret('model9'), null);
}));

test('invalid profile metadata preserves saved configurations and allows a later valid save', async () => fixture(async (store) => {
  await store.upsert(setting('stable'));
  const original = await readFile(store.path, 'utf8');
  for (const input of [{ ...setting('stable'), name: 'a'.repeat(81) }, { ...setting('stable'), supportsImages: 'yes' }, { ...setting('stable'), id: '' }]) {
    await assert.rejects(store.upsert(input), { code: 'model_setting_invalid' });
    assert.equal(await readFile(store.path, 'utf8'), original);
  }
  await store.upsert({ ...setting('stable'), name: '已修改' });
  assert.equal((await store.get('stable')).name, '已修改');
}));


const { createRuntime } = await import('../src/runtime.mjs');
const { createRuntimeRequestHandler } = await import('../src/runtime-request.mjs');

function providerResponse(model) {
  const delta = { id: 'profiles', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content: 'profile reply' }, finish_reason: null }] };
  const finish = { ...delta, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
  return new Response([delta, finish].map((item) => 'data: ' + JSON.stringify(item) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}

test('active profile controls real Pi routing, connection tests, context isolation and restart', async () => fixture(async (_store, dir) => {
  const requests = [];
  const checks = [];
  const options = { dataDir: dir, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    if (!body.stream) {
      checks.push({ url, body });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }], usage: {} }));
    }
    requests.push({ url, body });
    return providerResponse(body.model);
  } };
  let runtime = await createRuntime(options);
  try {
    for (const id of ['default', 'second']) assert.equal((await runtime.handle('settings.update', { setting: setting(id) })).ok, true);
    assert.equal((await runtime.handle('settings.get')).result.activeSettingId, 'default');
    assert.equal((await runtime.handle('chat.send', { text: 'first profile secret prompt', modelCredential: { apiKey: 'first-key' } })).ok, true);
    assert.equal((await runtime.handle('settings.activate', { id: 'second' })).ok, true);
    assert.equal((await runtime.handle('settings.test', { apiKey: 'second-key' })).ok, true);
    assert.equal(checks[0].body.model, 'model-second');
    assert.equal((await runtime.handle('chat.send', { text: 'second profile prompt', modelCredential: { apiKey: 'second-key' } })).ok, true);
    assert.equal(requests[1].body.model, 'model-second');
    assert.doesNotMatch(JSON.stringify(requests[1].body.messages), /first profile secret prompt/);
    await runtime.close();
    runtime = await createRuntime(options);
    assert.equal((await runtime.handle('settings.get')).result.activeSettingId, 'second');
    assert.equal((await runtime.handle('settings.activate', { id: 'missing' })).error.code, 'model_configuration_missing');
    assert.equal((await runtime.handle('settings.remove', { id: 'second' })).error.code, 'model_confirmation_required');
    assert.equal((await runtime.handle('settings.remove', { id: 'second', confirm: true })).ok, true);
    assert.equal((await runtime.handle('settings.get')).result.activeSettingId, 'default');
    assert.equal((await runtime.handle('settings.remove', { id: 'default', confirm: true })).ok, true);
    assert.equal((await runtime.handle('settings.get')).result.activeSettingId, null);
  } finally { await runtime.close(); }
}));

test('main bridge uses active profile credentials and removes only a confirmed deleted profile key', async () => {
  let settings = [ { id: 'default', credentialRef: 'key-one' }, { id: 'second', credentialRef: 'key-two' } ];
  const calls = [];
  const secrets = new Map([['key-one', 'first-secret'], ['key-two', 'second-secret']]);
  const handle = createRuntimeRequestHandler({
    runtimeClient: { request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'settings.get') return { ok: true, result: { settings: structuredClone(settings), activeSettingId: 'second' } };
      if (method === 'mcp.servers.list_internal') return { ok: true, result: { servers: [] } };
      if (method === 'settings.remove') {
        if (!params.confirm) return { ok: false, error: { code: 'model_confirmation_required' } };
        settings = settings.filter((entry) => entry.id !== params.id);
      }
      return { ok: true, result: {} };
    } },
    vault: { has: async (id) => secrets.has(id), get: async (id) => secrets.get(id), delete: async (id) => secrets.delete(id) }
  });
  await handle({ method: 'chat.send', params: { text: 'active question' } });
  const request = calls.find((call) => call.method === 'chat.send');
  assert.equal(request.params.modelCredential.apiKey, 'second-secret');
  assert.equal(request.params.settingId, 'second');
  await handle({ method: 'settings.test' });
  assert.equal(calls.find((call) => call.method === 'settings.test').params.apiKey, 'second-secret');
  assert.equal((await handle({ method: 'settings.remove', params: { id: 'second' } })).ok, false);
  assert.equal(secrets.has('key-two'), true);
  await handle({ method: 'settings.remove', params: { id: 'second', confirm: true } });
  assert.equal(secrets.has('key-two'), false);
  assert.equal(secrets.get('key-one'), 'first-secret');
});

test('uncertain profile deletion reconciles committed state before cleaning encrypted credentials', async () => {
  let settings = [{ id: 'second', credentialRef: 'key-two' }];
  const deleted = [];
  const handle = createRuntimeRequestHandler({ runtimeClient: { request: async (method) => {
    if (method === 'settings.get') return { ok: true, result: { settings: structuredClone(settings), activeSettingId: 'second' } };
    if (method === 'settings.remove') { settings = []; throw Error('reply lost'); }
    return { ok: true, result: {} };
  } }, vault: { has: async () => true, delete: async (id) => deleted.push(id) } });
  const result = await handle({ method: 'settings.remove', params: { id: 'second', confirm: true } });
  assert.equal(result.ok, true);
  assert.deepEqual(deleted, ['key-two']);
});


test('each saved profile revision changes even when only its credential reference changes', async () => fixture(async (store) => {
  const first = await store.upsert({ ...setting('revisioned'), credentialRef: 'one' });
  const second = await store.upsert({ ...setting('revisioned'), credentialRef: 'two' });
  assert.equal(typeof first.revision, 'string');
  assert.notEqual(first.revision, second.revision);
}));


for (const committed of [true, false]) {
  test('application-error profile save reconciles committed=' + committed + ' before credential cleanup', async () => {
    let settings = [{ id: 'default', credentialRef: 'old-key' }];
    const secrets = new Map([['old-key', 'old-secret']]);
    const handle = createRuntimeRequestHandler({ runtimeClient: { request: async (method, params) => {
      if (method === 'settings.get') return { ok: true, result: { settings: structuredClone(settings), activeSettingId: 'default' } };
      if (method === 'settings.update') {
        if (committed) settings = [structuredClone(params.setting)];
        return { ok: false, error: { code: 'meta_write_failed' } };
      }
    } }, vault: { has: async (id) => secrets.has(id), set: async (id, value) => secrets.set(id, value), delete: async (id) => secrets.delete(id) } });
    const result = await handle({ method: 'settings.update', params: { setting: { ...setting('default'), apiKey: 'new-secret' } } });
    assert.equal(result.ok, committed);
    assert.equal(secrets.get(settings[0].credentialRef), committed ? 'new-secret' : 'old-secret');
    assert.equal(secrets.size, 1);
    assert.doesNotMatch(JSON.stringify(result), /old-secret|new-secret/);
  });
}

test('application-error profile save retains staged and old credentials when state is unknown', async () => {
  let reads = 0;
  const secrets = new Map([['old-key', 'old-secret']]);
  const handle = createRuntimeRequestHandler({ runtimeClient: { request: async (method) => {
    if (method === 'settings.get') {
      reads++;
      if (reads > 1) throw Error('state unavailable');
      return { ok: true, result: { settings: [{ id: 'default', credentialRef: 'old-key' }] } };
    }
    return { ok: false, error: { code: 'partial_save_unknown' } };
  } }, vault: { has: async (id) => secrets.has(id), set: async (id, value) => secrets.set(id, value), delete: async (id) => secrets.delete(id) } });
  const result = await handle({ method: 'settings.update', params: { setting: { ...setting('default'), apiKey: 'new-secret' } } });
  assert.equal(result.error.code, 'partial_save_unknown');
  assert.equal(secrets.size, 2);
  assert.equal(secrets.get('old-key'), 'old-secret');
});

for (const shared of [false, true]) {
  test('application-error profile deletion reconciles committed state, shared=' + shared, async () => {
    let settings = [{ id: 'default', credentialRef: 'shared-key' }, ...(shared ? [{ id: 'other', credentialRef: 'shared-key' }] : [])];
    const deleted = [];
    const handle = createRuntimeRequestHandler({ runtimeClient: { request: async (method) => {
      if (method === 'settings.get') return { ok: true, result: { settings: structuredClone(settings), activeSettingId: shared ? 'other' : null } };
      if (method === 'settings.remove') {
        settings = settings.filter((entry) => entry.id !== 'default');
        return { ok: false, error: { code: 'meta_write_failed' } };
      }
    } }, vault: { has: async () => true, delete: async (id) => deleted.push(id) } });
    const result = await handle({ method: 'settings.remove', params: { id: 'default', confirm: true } });
    assert.equal(result.ok, true);
    assert.deepEqual(deleted, shared ? [] : ['shared-key']);
  });
}

test('successful profile updates preserve a credential still referenced by another legacy profile', async () => {
  let settings = [{ id: 'default', credentialRef: 'shared-key' }, { id: 'other', credentialRef: 'shared-key' }];
  const secrets = new Map([['shared-key', 'shared-secret']]);
  const handle = createRuntimeRequestHandler({ runtimeClient: { request: async (method, params) => {
    if (method === 'settings.get') return { ok: true, result: { settings: structuredClone(settings) } };
    if (method === 'settings.update') { settings[0] = structuredClone(params.setting); return { ok: true, result: { setting: structuredClone(settings[0]) } }; }
  } }, vault: { has: async (id) => secrets.has(id), set: async (id, value) => secrets.set(id, value), delete: async (id) => secrets.delete(id) } });
  assert.equal((await handle({ method: 'settings.update', params: { setting: { ...setting('default'), apiKey: 'new-secret' } } })).ok, true);
  assert.equal(secrets.get('shared-key'), 'shared-secret');
  assert.equal(secrets.get(settings[0].credentialRef), 'new-secret');
});

for (const hasDefaultKey of [true, false]) {
  test(`connection testing uses the selected legacy profile without credentialRef (default key present=${hasDefaultKey})`, async () => {
    const settings = [{ id: 'default' }, { id: 'legacy' }];
    const secrets = new Map([['legacy', 'legacy-key'], ...(hasDefaultKey ? [['default', 'default-key']] : [])]);
    const handle = createRuntimeRequestHandler({ runtimeClient: { request: async (method, params) => {
      if (method === 'settings.get') return { ok: true, result: { settings, activeSettingId: 'legacy' } };
      assert.equal(method, 'settings.test');
      assert.equal(params.settingId, 'legacy');
      assert.equal(params.apiKey, 'legacy-key');
      return { ok: true };
    } }, vault: { get: async (id) => secrets.get(id) } });
    assert.equal((await handle({ method: 'settings.test' })).ok, true);
  });
}
