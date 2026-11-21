import assert from 'node:assert/strict';
import test from 'node:test';
import { ScheduleService } from '../src/schedule-service.mjs';

test('credential vault failure is recorded without blocking later reminders', async () => {
  const calls = [];
  const runtimeClient = { request: async (method, params = {}) => {
    calls.push({ method, params });
    if (method === 'schedule.tick') return { ok: true, result: { events: [
      { id: 'task', kind: 'agent-task', binding: { settingId: 'model' } },
      { id: 'reminder', kind: 'reminder', text: '提醒' }
    ] } };
    if (method === 'settings.get') return { ok: true, result: { settings: [{ id: 'model' }] } };
    if (method === 'schedule.run') return { ok: true, result: { event: { kind: params.id === 'reminder' ? 'reminder' : 'agent-task', status: params.id === 'reminder' ? 'fired' : 'failed' } } };
  } };
  const notifications = [];
  const service = new ScheduleService({ runtimeClient, vault: { get: async () => { throw Error('vault unavailable'); } }, notify: async text => notifications.push(text) });
  await service.tick();
  assert.deepEqual(calls.filter(call => call.method === 'schedule.run').map(call => call.params.id), ['task', 'reminder']);
  assert.deepEqual(notifications, ['提醒']);
});
