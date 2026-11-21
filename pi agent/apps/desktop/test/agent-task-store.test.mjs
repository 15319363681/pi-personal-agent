import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeStore } from '../src/runtime/store.mjs';
import { AgentTaskStore } from '../src/runtime/agent-task-store.mjs';

const binding = { settingId: 'alpha', revision: 'rev-1', workspace: null };

test('durable Agent tasks reject stale commits and resume their completed prefix after restart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-agent-task-store-'));
  const path = join(directory, 'test.sqlite');
  let runtimeStore = await RuntimeStore.open(path);
  t.after(async () => { runtimeStore.close(); await rm(directory, { recursive: true, force: true }); });
  let tasks = new AgentTaskStore(runtimeStore);
  const first = tasks.start('整理说明', binding);
  assert.equal(first.status, 'running');
  assert.throws(() => tasks.start('并发任务', binding), { code: 'agent_task_busy' });
  assert.equal(tasks.commit(first.id, first.attemptId, { steps: [{ title: '阅读' }, { title: '整理' }] }), true);
  assert.equal(tasks.commit(first.id, first.attemptId, { results: [{ text: '已阅读' }] }), true);
  const paused = tasks.control(first.id, 'paused');
  assert.equal(paused.status, 'paused');
  assert.equal(tasks.commit(first.id, first.attemptId, { status: 'completed' }), false);
  const second = tasks.resume(first.id);
  assert.notEqual(second.attemptId, first.attemptId);
  assert.equal(tasks.commit(first.id, first.attemptId, { status: 'completed' }), false);
  runtimeStore.close();
  runtimeStore = await RuntimeStore.open(path);
  tasks = new AgentTaskStore(runtimeStore);
  tasks.recover();
  assert.equal(tasks.get(first.id).status, 'interrupted');
  assert.equal(tasks.get(first.id).results[0].text, '已阅读');
  assert.equal(tasks.get(first.id).steps[1].title, '整理');
  const third = tasks.resume(first.id);
  assert.equal(tasks.commit(first.id, third.attemptId, { status: 'completed', results: [{ text: '已阅读' }, { text: '已整理' }] }), true);
  assert.throws(() => tasks.control(first.id, 'cancelled'), { code: 'agent_task_transition_invalid' });
  assert.equal(tasks.list()[0].status, 'completed');
});
