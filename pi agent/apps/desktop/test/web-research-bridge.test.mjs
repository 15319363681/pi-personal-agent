import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeRequestHandler } from '../src/runtime-request.mjs';

const protectedKey = 'fixture-brave-key';
const modelKey = 'fixture-model-key';
const success = (result) => ({ ok: true, result });

test('bridge stores the search credential in a dedicated vault and injects only trusted values', async () => {
  const requests = [];
  const secrets = new Map();
  const handler = createRuntimeRequestHandler({
    searchVault: {
      get: async (id) => secrets.get(id),
      set: async (id, key) => secrets.set(id, key),
      has: async (id) => secrets.has(id),
      delete: async (id) => secrets.delete(id)
    },
    vault: { get: async (id) => { assert.equal(id, 'model-ref'); return modelKey; } },
    runtimeClient: { request: async (method, params) => {
      requests.push([method, params]);
      if (method === 'settings.get') return success({ activeSettingId: 'profile', settings: [{ id: 'profile', credentialRef: 'model-ref' }] });
      if (method === 'research.run') return success({ kind: 'research' });
      assert.fail(`unexpected method ${method}`);
    } }
  });
  assert.deepEqual(await handler({ method: 'research.settings.get' }), success({ hasKey: false }));
  assert.equal((await handler({ method: 'research.run', params: { text: 'query', searchCredential: { apiKey: 'injection' } } })).error.code, 'research_key_missing');
  assert.deepEqual(await handler({ method: 'research.settings.save', params: { apiKey: protectedKey } }), success({ hasKey: true }));
  assert.deepEqual(await handler({ method: 'research.settings.get' }), success({ hasKey: true }));
  assert.deepEqual(await handler({ method: 'research.run', params: { text: 'query', searchCredential: { apiKey: 'injection' }, modelCredential: { apiKey: 'injection' }, mcpCredentials: ['extraneous'] } }), success({ kind: 'research' }));
  assert.deepEqual(requests, [['settings.get', undefined], ['research.run', { text: 'query', settingId: 'profile', searchCredential: { apiKey: protectedKey }, modelCredential: { apiKey: modelKey } }]]);
  assert.equal((await handler({ method: 'research.settings.remove' })).error.code, 'research_key_confirmation_required');
  assert.deepEqual(await handler({ method: 'research.settings.remove', params: { confirm: true } }), success({ hasKey: false }));
  assert.equal(secrets.size, 0);
});
