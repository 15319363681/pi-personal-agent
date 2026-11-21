import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeRequestHandler } from '../src/runtime-request.mjs';

test('main-process request bridge encrypts credentials and injects them only for explicit provider calls', async () => {
  const stored = new Map();
  const requests = [];
  let currentSetting = { id: 'default', provider: 'openai-compatible' };
  const runtimeClient = { async request(method, params) { requests.push({ method, params }); if (method === 'settings.get') return { ok: true, result: { settings: [currentSetting] } }; if (method === 'settings.update') currentSetting = params.setting; return { ok: true, result: {} }; } };
  const vault = { async set(id, key) { stored.set(id, key); }, async get(id) { return stored.get(id) ?? null; }, async has(id) { return stored.has(id); } };
  const handle = createRuntimeRequestHandler({ runtimeClient, vault });
  await handle({ method: 'settings.update', params: { setting: { id: 'default', provider: 'openai-compatible', model: 'm', baseUrl: 'https://provider/v1', apiKey: 'fresh-key' } } });
  const updateRequest = requests.find((request) => request.method === 'settings.update');
  assert.equal(updateRequest.params.setting.apiKey, undefined);
  assert.equal(updateRequest.params.setting.hasApiKey, true);
  await handle({ method: 'settings.test', params: { settingId: 'default' } });
  assert.equal(requests.find((request) => request.method === 'settings.test').params.apiKey, 'fresh-key');
  await handle({ method: 'chat.send', params: { text: 'private user input' } });
  const chatRequest = requests.find((request) => request.method === 'chat.send');
  assert.equal(chatRequest.params.modelCredential.apiKey, 'fresh-key');
  assert.equal(chatRequest.params.text, 'private user input');
  assert.equal(JSON.stringify(requests).includes('fresh-key'), true, 'runtime process receives the key only as call-time provider input');
});

test('main-process bridge refuses model calls without a locally stored key', async () => {
  const handle = createRuntimeRequestHandler({ runtimeClient: { request: async () => ({ ok: true, result: { settings: [{ id: 'default' }] } }) }, vault: { has: async () => false, get: async () => null, set: async () => {} } });
  assert.equal((await handle({ method: 'settings.test', params: { settingId: 'default' } })).error.code, 'model_api_key_missing');
  assert.equal((await handle({ method: 'chat.send', params: { text: 'hello' } })).error.code, 'model_api_key_missing');
});

test('local task proposal never asks for or forwards a model credential', async () => {
  const requests = [];
  const handle = createRuntimeRequestHandler({ runtimeClient: { request: async (method, params) => { requests.push({ method, params }); return { ok: true, result: {} }; } }, vault: { has: async () => false, get: async () => null, set: async () => {} } });
  const result = await handle({ method: 'chat.send', params: { text: 'make local report', task: { goal: 'local report' } } });
  assert.equal(result.ok, true);
  assert.deepEqual(requests, [{ method: 'chat.send', params: { text: 'make local report', task: { goal: 'local report' } } }]);
});

test('renderer cannot submit a workspace path and workspace selection is delegated without renderer parameters', async () => {
  const requests = [];
  let selections = 0;
  const runtimeClient = { async request(method, params) { requests.push({ method, params }); return { ok: true, result: { authorized: true, root: params.root } }; } };
  const handle = createRuntimeRequestHandler({
    runtimeClient,
    vault: { has: async () => false, get: async () => null, set: async () => {} },
    selectWorkspace: async (...args) => {
      selections += 1;
      assert.deepEqual(args, []);
      return runtimeClient.request('workspace.authorize', { root: 'C:\\trusted\\selected', controlToken: 'main-only' });
    }
  });

  const forged = await handle({ method: 'workspace.authorize', params: { root: 'C:\\private\\target' } });
  assert.equal(forged.ok, false);
  assert.equal(forged.error.code, 'workspace_authorization_denied');
  assert.deepEqual(requests, []);

  const selected = await handle({ method: 'workspace.select', params: { root: 'C:\\private\\target' } });
  assert.equal(selected.ok, true);
  assert.equal(selected.result.root, 'C:\\trusted\\selected');
  assert.equal(selections, 1);
  assert.equal(requests.length, 1);
});



test('credential updates wait until an in-flight model request finishes', async () => {
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const requestStarted = new Promise((resolve) => { started = resolve; });
  const stored = new Map([['default', 'old-key']]);
  const requests = [];
  let settingRef;
  const runtimeClient = { async request(method, params) {
    requests.push({ method, params });
    if (method === 'settings.get') return { ok: true, result: { settings: [{ id: 'default', ...(settingRef ? { credentialRef: settingRef } : {}) }] } };
    if (method === 'settings.update') settingRef = params.setting.credentialRef;
    if (method === 'chat.send') { started(); await gate; }
    return { ok: true, result: {} };
  } };
  const vault = { async set(id, key) { stored.set(id, key); }, async get(id) { return stored.get(id) ?? null; }, async has(id) { return stored.has(id); }, async delete(id) { stored.delete(id); } };
  const handle = createRuntimeRequestHandler({ runtimeClient, vault });
  const chat = handle({ method: 'chat.send', params: { text: 'question' } });
  await requestStarted;
  const update = handle({ method: 'settings.update', params: { setting: { id: 'default', apiKey: 'new-key' } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stored.get('default'), 'old-key');
  release();
  await Promise.all([chat, update]);
  assert.equal(requests.find((request) => request.method === 'chat.send').params.modelCredential.apiKey, 'old-key');
  assert.equal(stored.get(settingRef), 'new-key');
  assert.equal(stored.has('default'), false);
});
test('failed settings update restores the previous credential before the next chat', async () => {
  const stored = new Map([['default', 'old-key']]);
  const requests = [];
  const runtimeClient = { async request(method, params) {
    requests.push({ method, params });
    if (method === 'settings.update') return { ok: false, error: { code: 'settings_write_failed' } };
    if (method === 'settings.get') return { ok: true, result: { settings: [{ id: 'default', provider: 'openai-compatible', baseUrl: 'https://old-provider/v1' }] } };
    return { ok: true, result: {} };
  } };
  const vault = {
    async set(id, key) { stored.set(id, key); },
    async get(id) { return stored.get(id) ?? null; },
    async has(id) { return stored.has(id); },
    async delete(id) { stored.delete(id); }
  };
  const handle = createRuntimeRequestHandler({ runtimeClient, vault });

  const update = await handle({ method: 'settings.update', params: { setting: {
    id: 'default', provider: 'openai-compatible', baseUrl: 'https://new-provider/v1', apiKey: 'new-key'
  } } });
  assert.equal(update.ok, false);
  assert.equal(stored.get('default'), 'old-key');

  await handle({ method: 'chat.send', params: { text: 'hello' } });
  assert.equal(requests.find((request) => request.method === 'chat.send').params.modelCredential.apiKey, 'old-key');
});
test('RPC failure after committed settings update returns the committed setting and retires the old credential', async () => {
  const stored = new Map([['old-ref', 'old-key']]);
  let setting = { id: 'default', credentialRef: 'old-ref' };
  let requestCount = 0;
  const runtimeClient = { async request(method, params) {
    if (method === 'settings.get') return { ok: true, result: { settings: [setting] } };
    if (method === 'settings.update') {
      setting = params.setting;
      if (requestCount++ === 0) throw new Error('rpc_disconnected_after_commit');
      return { ok: true, result: { setting: params.setting } };
    }
    return { ok: true, result: {} };
  } };
  const vault = {
    async set(id, key) { stored.set(id, key); },
    async get(id) { return stored.get(id) ?? null; },
    async has(id) { return stored.has(id); },
    async delete(id) { stored.delete(id); }
  };
  const handle = createRuntimeRequestHandler({ runtimeClient, vault });

  const result = await handle({ method: 'settings.update', params: { setting: { id: 'default', apiKey: 'new-key' } } });
  assert.equal(result.ok, true);
  assert.equal(result.result.setting.hasApiKey, true);
  assert.equal(result.result.setting.credentialRef, undefined);
  assert.equal(stored.get(setting.credentialRef), 'new-key');
  assert.equal(stored.has('old-ref'), false);
});


test('RPC failure before settings commit removes the unreferenced new credential', async () => {
  const stored = new Map([['old-ref', 'old-key']]);
  const setting = { id: 'default', credentialRef: 'old-ref' };
  const runtimeClient = { async request(method) {
    if (method === 'settings.get') return { ok: true, result: { settings: [setting] } };
    if (method === 'settings.update') throw new Error('rpc_disconnected_before_commit');
    return { ok: true, result: {} };
  } };
  const vault = {
    async set(id, key) { stored.set(id, key); },
    async get(id) { return stored.get(id) ?? null; },
    async has(id) { return stored.has(id); },
    async delete(id) { stored.delete(id); }
  };
  const handle = createRuntimeRequestHandler({ runtimeClient, vault });

  await assert.rejects(handle({ method: 'settings.update', params: { setting: { id: 'default', apiKey: 'new-key' } } }), /rpc_disconnected_before_commit/);
  assert.equal(stored.has('old-ref'), true);
  assert.equal([...stored.values()].includes('new-key'), false);
});


test('RPC failure with unavailable reconciliation retains the new credential', async () => {
  const stored = new Map([['old-ref', 'old-key']]);
  const setting = { id: 'default', credentialRef: 'old-ref' };
  let settingsReads = 0;
  const runtimeClient = { async request(method) {
    if (method === 'settings.get') {
      if (settingsReads++ === 0) return { ok: true, result: { settings: [setting] } };
      throw new Error('runtime_unavailable');
    }
    if (method === 'settings.update') throw new Error('rpc_disconnected_during_update');
    return { ok: true, result: {} };
  } };
  const vault = {
    async set(id, key) { stored.set(id, key); },
    async get(id) { return stored.get(id) ?? null; },
    async has(id) { return stored.has(id); },
    async delete(id) { stored.delete(id); }
  };
  const handle = createRuntimeRequestHandler({ runtimeClient, vault });

  await assert.rejects(handle({ method: 'settings.update', params: { setting: { id: 'default', apiKey: 'new-key' } } }), /rpc_disconnected_during_update/);
  assert.equal([...stored.values()].includes('new-key'), true);
  assert.equal(stored.get('old-ref'), 'old-key');
});


test('MCP bearer credentials stay in the vault and are injected only for authorized runtime operations', async () => {
  const stored = new Map();
  const requests = [];
  let server = null;
  const runtimeClient = {
    async request(method, params) {
      requests.push({ method, params });
      if (method === 'mcp.servers.list_internal') return { ok: true, result: { servers: server ? [server] : [] } };
      if (method === 'mcp.server.save') { server = params.server; return { ok: true, result: { server } }; }
      if (method === 'mcp.server.connect') return { ok: true, result: { tokenReceived: params.mcpCredential?.token ?? null } };
      if (method === 'settings.get') return { ok: true, result: { settings: [] } };
      return { ok: true, result: {} };
    }
  };
  const vault = { async set(id, value) { stored.set(id, value); }, async get(id) { return stored.get(id) ?? null; }, async has(id) { return stored.has(id); }, async delete(id) { stored.delete(id); } };
  const handle = createRuntimeRequestHandler({ runtimeClient, vault });

  const saved = await handle({ method: 'mcp.server.save', params: { server: { id: 'research', name: 'Research', url: 'https://mcp.example.test/mcp' }, bearerToken: 'mcp-secret-token' } });
  assert.equal(saved.ok, true);
  assert.equal(saved.result.server.hasBearerToken, true);
  assert.equal(saved.result.server.credentialRef, undefined);
  assert.equal(JSON.stringify(saved).includes('mcp-secret-token'), false);
  const saveRequest = requests.find((request) => request.method === 'mcp.server.save');
  assert.equal(saveRequest.params.bearerToken, undefined);
  assert.ok(saveRequest.params.server.credentialRef);

  const connected = await handle({ method: 'mcp.server.connect', params: { id: 'research' } });
  assert.equal(connected.result.tokenReceived, 'mcp-secret-token');
  const connectRequest = requests.find((request) => request.method === 'mcp.server.connect');
  assert.equal(connectRequest.params.mcpCredential.token, 'mcp-secret-token');
  assert.equal(connectRequest.params.bearerToken, undefined);
  assert.equal((await handle({ method: 'mcp.servers.list_internal' })).error.code, 'runtime_method_forbidden');
});

test('chat receives MCP credentials for approved servers while renderer list stays redacted', async () => {
  const stored = new Map([['model-ref', 'model-key'], ['mcp-ref', 'mcp-token']]);
  const requests = [];
  const internalServer = { id: 'research', name: 'Research', url: 'https://mcp.example.test/mcp', credentialRef: 'mcp-ref', enabled: true, tools: [{ name: 'lookup', enabled: true }] };
  const runtimeClient = { async request(method, params) {
    requests.push({ method, params });
    if (method === 'settings.get') return { ok: true, result: { settings: [{ id: 'default', credentialRef: 'model-ref' }] } };
    if (method === 'mcp.servers.list') return { ok: true, result: { servers: [{ id: 'research', name: 'Research', url: internalServer.url, enabled: true, tools: internalServer.tools }] } };
    if (method === 'mcp.servers.list_internal') return { ok: true, result: { servers: [internalServer] } };
    if (method === 'chat.send') return { ok: true, result: { received: params.mcpCredentials } };
    return { ok: true, result: {} };
  } };
  const vault = { async get(id) { return stored.get(id) ?? null; }, async has(id) { return stored.has(id); }, async set(id, token) { stored.set(id, token); }, async delete(id) { stored.delete(id); } };
  const handle = createRuntimeRequestHandler({ runtimeClient, vault });

  const listing = await handle({ method: 'mcp.servers.list' });
  assert.equal(listing.result.servers[0].hasBearerToken, true);
  assert.equal(JSON.stringify(listing).includes('mcp-ref'), false);
  const chat = await handle({ method: 'chat.send', params: { text: 'lookup' } });
  assert.deepEqual(chat.result.received, [{ serverId: 'research', token: 'mcp-token' }]);
  const chatRequest = requests.find((request) => request.method === 'chat.send');
  assert.equal(chatRequest.params.mcpCredentials[0].token, 'mcp-token');
  assert.equal(chatRequest.params.modelCredential.apiKey, 'model-key');
});

test('failed MCP credential update retains the previous encrypted credential and removes the staged credential', async () => {
  const stored = new Map([['old-ref', 'old-token']]);
  const requestMethods = [];
  let savedServer = { id: 'research', name: 'Research', url: 'https://mcp.example.test/mcp', credentialRef: 'old-ref', enabled: true };
  const runtimeClient = { async request(method, params) {
    requestMethods.push(method);
    if (method === 'mcp.servers.list_internal') return { ok: true, result: { servers: [savedServer] } };
    if (method === 'mcp.server.save') return { ok: false, error: { code: 'storage_failed', message: 'save failed' } };
    return { ok: true, result: {} };
  } };
  const vault = { async set(id, token) { stored.set(id, token); }, async get(id) { return stored.get(id) ?? null; }, async has(id) { return stored.has(id); }, async delete(id) { stored.delete(id); } };
  const handle = createRuntimeRequestHandler({ runtimeClient, vault });
  const result = await handle({ method: 'mcp.server.save', params: { server: { id: 'research', name: 'Research', url: 'https://mcp.example.test/mcp' }, bearerToken: 'new-token' } });
  assert.equal(result.ok, false);
  assert.equal(stored.get('old-ref'), 'old-token');
  assert.equal([...stored.values()].includes('new-token'), false);
});
test('renderer cannot forge an MCP credential for connect or tool calls', async () => {
  const internalServer = { id: 'public', name: 'Public', url: 'https://mcp.example.test/mcp', enabled: true, tools: [] };
  const requests = [];
  const runtimeClient = { async request(method, params) {
    requests.push({ method, params });
    if (method === 'mcp.servers.list_internal') return { ok: true, result: { servers: [internalServer] } };
    return { ok: true, result: {} };
  } };
  const vault = { async get() { return null; }, async has() { return false; }, async set() {}, async delete() {} };
  const handle = createRuntimeRequestHandler({ runtimeClient, vault });
  await handle({ method: 'mcp.server.connect', params: { id: 'public', mcpCredential: { token: 'renderer-forged' } } });
  await handle({ method: 'mcp.tool.call', params: { serverId: 'public', name: 'lookup', arguments: {}, mcpCredential: { token: 'renderer-forged' } } });
  const forwarded = requests.filter(({ method }) => method === 'mcp.server.connect' || method === 'mcp.tool.call');
  assert.equal(forwarded.length, 2);
  assert.ok(forwarded.every(({ params }) => !Object.hasOwn(params, 'mcpCredential')));
  assert.doesNotMatch(JSON.stringify(forwarded), /renderer-forged/);
});


test('clipboard writes are bounded main-process operations and never reach the runtime', async () => {
  const writes = [];
  const handle = createRuntimeRequestHandler({ copyText: async (text) => writes.push(text), runtimeClient: { request: async () => assert.fail('clipboard reached runtime') } });
  assert.deepEqual(await handle({ method: 'clipboard.write', params: { text: '报告正文' } }), { ok: true, result: { copied: true } });
  assert.deepEqual(writes, ['报告正文']);
  for (const text of [null, 1, 'x'.repeat(65537)]) assert.equal((await handle({ method: 'clipboard.write', params: { text } })).error.code, 'clipboard_text_invalid');
  assert.deepEqual(writes, ['报告正文']);
});
