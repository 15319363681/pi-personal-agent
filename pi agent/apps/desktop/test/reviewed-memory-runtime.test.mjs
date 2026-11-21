import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../src/runtime.mjs';
function reply(value) {
  const delta = typeof value === 'string' ? { content: value } : { tool_calls: [{ index: 0, id: 'mem-tool', type: 'function', function: value }] };
  return new Response([{ ...delta, role: 'assistant' }, {}].map((part, i) => 'data: ' + JSON.stringify({ id: 'memory-test', choices: [{ index: 0, delta: part, finish_reason: i ? typeof value === 'string' ? 'stop' : 'tool_calls' : null }] }) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}
async function fixture(t, respond) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-memory-runtime-'));
  const runtime = await createRuntime({ dataDir: dir, fetchImpl: async (_url, init) => reply(await respond(JSON.parse(init.body))) });
  t.after(async () => { await runtime.close(); await rm(dir, { recursive: true, force: true }); });
  await runtime.handle('settings.update', { setting: { id: 'default', provider: 'openai-compatible', model: 'fixture', baseUrl: 'https://model.invalid/v1' } });
  return runtime;
}
const modelCredential = { apiKey: 'fixture-memory-model' };
const chat = runtime => runtime.handle('chat.send', { text: '测试偏好', modelCredential });
test('only approved memory reaches Pi and deletion removes old transcript on next turn', async t => {
  const bodies = [];
  const runtime = await fixture(t, body => { bodies.push(JSON.stringify(body.messages)); return '好的'; });
  const memory = (await runtime.handle('memory.propose', { text: '唯一私有偏好' })).result.memory;
  assert.equal((await chat(runtime)).ok, true);
  assert.ok(!bodies[0].includes('唯一私有偏好'));
  assert.equal((await runtime.handle('memory.approve', memory)).ok, true);
  assert.equal((await chat(runtime)).ok, true);
  assert.match(bodies[1], /唯一私有偏好/);
  assert.equal((await runtime.handle('memory.delete', memory)).ok, true);
  assert.equal((await chat(runtime)).ok, true);
  assert.ok(!bodies[2].includes('唯一私有偏好'));
  assert.equal(JSON.parse(bodies[2]).filter(item => item.role === 'user').length, 1);
});
test('Pi can propose memory but cannot approve it', async t => {
  let calls = 0;
  const runtime = await fixture(t, body => {
    const tools = body.tools.map(tool => tool.function.name);
    assert.ok(tools.includes('memory_propose'));
    assert.ok(!tools.includes('memory_approve'));
    return ++calls === 1 ? { name: 'memory_propose', arguments: JSON.stringify({ text: '用户提议' }) } : '请审核记忆';
  });
  assert.equal((await chat(runtime)).ok, true);
  const rows = (await runtime.handle('memory.list')).result.memories;
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].source, 'agent');
  assert.equal(runtime.memory.snapshot().entries.length, 0);
});
test('memory changes fence an in-flight chat and task and prevent stale resume', async t => {
  let finish;
  const runtime = await fixture(t, () => new Promise(resolve => { finish = resolve; }));
  const memory = runtime.memory.propose('将被删除的记忆');
  runtime.memory.approve(memory.id, memory.revision);
  const pending = chat(runtime);
  while (!finish) await new Promise(resolve => setTimeout(resolve, 10));
  runtime.memory.delete(memory.id, memory.revision);
  finish('迟到回复');
  assert.equal((await pending).error.code, 'conversation_conflict');
  finish = null;
  const started = await runtime.handle('agent_task.start', { text: '执行目标', modelCredential });
  assert.equal(started.ok, true);
  while (!finish) await new Promise(resolve => setTimeout(resolve, 10));
  const next = runtime.memory.propose('新审核记忆');
  runtime.memory.approve(next.id, next.revision);
  finish(JSON.stringify({ steps: [{ title: '总结', instruction: '总结' }] }));
  await runtime.waitForIdle();
  const id = started.result.task.id;
  assert.equal(runtime.agentTasks.store.get(id).reasonCode, 'agent_task_memory_changed');
  assert.equal((await runtime.handle('agent_task.resume', { id, modelCredential })).error.code, 'agent_task_memory_changed');
});
