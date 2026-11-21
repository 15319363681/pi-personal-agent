import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeRequestHandler } from '../src/runtime-request.mjs';

test('task bridge binds resume to its original profile and ignores renderer credentials', async () => {
  const calls = [];
  const handler = createRuntimeRequestHandler({
    vault: { get: async (ref) => { assert.equal(ref, 'bound-ref'); return 'protected-task-key'; } },
    runtimeClient: { request: async (method, params) => {
      calls.push([method, params]);
      if (method === 'settings.get') return { ok: true, result: { activeSettingId: 'active', settings: [{ id: 'active', credentialRef: 'other-ref' }, { id: 'bound', credentialRef: 'bound-ref' }] } };
      if (method === 'agent_task.get') return { ok: true, result: { task: { binding: { settingId: 'bound' } } } };
      return { ok: true, result: { task: { id: 'task', status: 'running' } } };
    } }
  });
  await handler({ method: 'agent_task.start', params: { text: 'goal', settingId: 'bound', modelCredential: { apiKey: 'untrusted' }, tools: ['write'] } });
  assert.deepEqual(calls.at(-1), ['agent_task.start', { text: 'goal', settingId: 'bound', modelCredential: { apiKey: 'protected-task-key' } }]);
  await handler({ method: 'agent_task.resume', params: { id: 'task', settingId: 'active', modelCredential: { apiKey: 'untrusted' } } });
  assert.deepEqual(calls.at(-1), ['agent_task.resume', { id: 'task', modelCredential: { apiKey: 'protected-task-key' } }]);
});

test('task controls remain available while a model configuration request is pending', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const handler = createRuntimeRequestHandler({ vault: {}, runtimeClient: { request: async (method) => {
    if (method === 'settings.activate') { entered(); await gate; }
    return { ok: true, result: {} };
  } } });
  const queued = handler({ method: 'settings.activate', params: { id: 'profile' } });
  await ready;
  try {
    const response = await Promise.race([handler({ method: 'agent_task.pause', params: { id: 'task' } }), new Promise((_, reject) => setTimeout(() => reject(Error('pause blocked')), 500))]);
    assert.equal(response.ok, true);
  } finally { release(); await queued; }
});
