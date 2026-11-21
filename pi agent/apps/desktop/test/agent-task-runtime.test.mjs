import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../src/runtime.mjs';

const modelCredential = { apiKey: 'agent-task-model-fixture' };
const setting = { id: 'default', provider: 'openai-compatible', model: 'fixture', baseUrl: 'https://model.invalid/v1' };
const secretDocument = '唯一授权的工作区测试文本';
const plan = JSON.stringify({ steps: [{ title: '阅读文件', instruction: '读 input.txt' }, { title: '总结资料', instruction: '总结读取内容' }] });
function reply(result) {
  const delta = typeof result === 'string' ? { content: result } : { tool_calls: [{ index: 0, id: 'read-1', type: 'function', function: result }] };
  return new Response([{ ...delta, role: 'assistant' }, {}].map((chunk, index) => 'data: ' + JSON.stringify({
    id: 'agent-task', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: chunk, finish_reason: index === 0 ? null : typeof result === 'string' ? 'stop' : 'tool_calls' }]
  }) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}

async function fixture(t, respond, overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pi-agent-task-run-'));
  const options = { dataDir, workspaceControlToken: 'control-task-fixture', ...overrides, fetchImpl: async (_url, init) => reply(await respond(JSON.parse(init.body), init.signal)) };
  let runtime = await createRuntime(options);
  t.after(async () => { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); });
  const workspace = join(dataDir, 'workspace');
  await writeFile(join(workspace, 'input.txt'), secretDocument);
  assert.equal((await runtime.handle('settings.update', { setting })).ok, true);
  assert.equal((await runtime.handle('workspace.authorize', { root: workspace, controlToken: 'control-task-fixture' })).ok, true);
  return { get runtime() { return runtime; },
    start: () => runtime.handle('agent_task.start', { text: '总结本地说明', modelCredential }),
    async restart() { await runtime.close(); runtime = await createRuntime(options); },
    get: async (id) => (await runtime.handle('agent_task.get', { id })).result?.task };
}
async function until(condition) {
  for (let i = 0; i < 100; i++) {
    const value = await condition();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('task condition timed out');
}

test('Pi task plans, uses only read tools, pauses, restarts, and resumes without replaying a committed step', async (t) => {
  let stage = 0;
  let skipped = false;
  const app = await fixture(t, async (body, signal) => {
    stage++;
    if (stage === 1) { assert.equal(body.tools?.length ?? 0, 0); return plan; }
    if (stage === 2) {
      const tools = body.tools.map((tool) => tool.function.name);
      assert.ok(tools.includes('workspace_read'));
      assert.ok(!tools.includes('workspace_prepare_text'));
      assert.ok(!tools.some((tool) => /plugin|mcp/.test(tool)));
      return { name: 'workspace_read', arguments: JSON.stringify({ path: 'input.txt' }) };
    }
    if (stage === 3) {
      assert.match(JSON.stringify(body.messages), new RegExp(secretDocument));
      return '读完 input.txt';
    }
    if (stage === 4) return new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    skipped = !JSON.stringify(body.messages).includes('读 input.txt');
    assert.match(JSON.stringify(body.messages), /读完 input.txt/);
    return '最终摘要';
  });
  const started = await app.start();
  assert.equal(started.ok, true, JSON.stringify(started));
  const { id } = started.result.task;
  await until(() => stage === 4);
  assert.equal((await app.runtime.handle('agent_task.pause', { id })).result?.task.status, 'paused');
  await app.restart();
  assert.equal((await app.get(id)).results.length, 1);
  assert.equal((await app.runtime.handle('agent_task.resume', { id, modelCredential })).ok, true);
  const complete = await until(async () => { const task = await app.get(id); return task.status === 'completed' && task; });
  assert.equal(skipped, true);
  assert.equal(complete.results[0].toolExecutions[0].name, 'workspace_read');
  assert.equal(complete.results[0].sources[0].path, 'input.txt');
  assert.equal(complete.results[1].text, '最终摘要');
});

test('cancel fences late output and a changed model blocks resume', async (t) => {
  let called = false;
  const app = await fixture(t, async (_body, signal) => {
    called = true;
    return new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const first = await app.start();
  assert.equal(first.ok, true, JSON.stringify(first));
  await until(() => called);
  assert.equal((await app.runtime.handle('agent_task.cancel', { id: first.result.task.id })).result?.task.status, 'cancelled');
  await app.runtime.waitForIdle();
  assert.equal((await app.get(first.result.task.id)).steps.length, 0);
  const second = await app.start();
  assert.equal(second.ok, true);
  const id = second.result.task.id;
  assert.equal((await app.runtime.handle('agent_task.pause', { id })).ok, true);
  assert.equal((await app.runtime.handle('settings.update', { setting: { ...setting, model: 'other' } })).ok, true);
  assert.equal((await app.runtime.handle('agent_task.resume', { id, modelCredential })).error?.code, 'agent_task_model_changed');
});


test('revoked or replaced workspace prevents an in-flight step from committing', async (t) => {
  for (const change of ['revoke', 'reauthorize', 'replace']) {
    await t.test(change, async (t) => {
      let resolveStep;
      let calls = 0;
      const app = await fixture(t, async () => {
        if (++calls === 1) return JSON.stringify({ steps: [{ title: '读取', instruction: '阅读说明' }] });
        return new Promise((resolve) => { resolveStep = resolve; });
      });
      const id = (await app.start()).result.task.id;
      await until(() => resolveStep);
      const root = app.runtime.workspaceRoot;
      if (change === 'revoke') await app.runtime.revokeWorkspaceAuthorization();
      if (change === 'reauthorize') await app.runtime.handle('workspace.authorize', { root, controlToken: 'control-task-fixture' });
      if (change === 'replace') {
        const { rename, mkdir } = await import('node:fs/promises');
        await rename(root, root + '-old');
        await mkdir(root);
      }
      resolveStep('迟到的结果');
      await app.runtime.waitForIdle();
      const task = await app.get(id);
      assert.equal(task.status, 'failed');
      assert.equal(task.reasonCode, 'agent_task_workspace_changed');
      assert.equal(task.results.length, 0);
      if (change !== 'reauthorize') assert.equal((await app.runtime.handle('agent_task.resume', { id, modelCredential })).error?.code, 'agent_task_workspace_changed');
    });
  }
});

test('invalid plan and repeated tool calls fail with durable bounded outcomes', async (t) => {
  await t.test('invalid plan', async (t) => {
    const app = await fixture(t, async () => '无法规划');
    const id = (await app.start()).result.task.id;
    await app.runtime.waitForIdle();
    assert.equal((await app.get(id)).reasonCode, 'agent_task_plan_invalid');
    assert.equal((await app.get(id)).steps.length, 0);
  });
  await t.test('tool budget', async (t) => {
    let calls = 0;
    const app = await fixture(t, async () => ++calls === 1
      ? JSON.stringify({ steps: [{ title: '阅读', instruction: '读取资料' }] })
      : { name: 'workspace_read', arguments: JSON.stringify({ path: 'input.txt' }) });
    const id = (await app.start()).result.task.id;
    await app.runtime.waitForIdle();
    const task = await app.get(id);
    assert.equal(task.status, 'failed');
    assert.equal(task.reasonCode, 'agent_task_budget');
    assert.ok(calls <= 10);
    assert.equal(task.results.length, 0);
  });
});

test('whole-step timeout produces an actionable failure and shutdown preserves interruption', async (t) => {
  await t.test('timeout', async (t) => {
    const app = await fixture(t, async (_body, signal) => new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), { agentTaskStepTimeoutMs: 100 });
    const id = (await app.start()).result.task.id;
    await Promise.race([app.runtime.waitForIdle(), new Promise((_, reject) => setTimeout(() => reject(Error('step timeout was ignored')), 1500))]);
    const task = await app.get(id);
    assert.equal(task.status, 'failed');
    assert.equal(task.reasonCode, 'agent_task_timeout');
  });
  await t.test('shutdown', async (t) => {
    let entered = false;
    const app = await fixture(t, async (_body, signal) => {
      entered = true;
      return new Promise((_, reject) => signal.aborted ? reject(signal.reason) : signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const id = (await app.start()).result.task.id;
    await until(() => entered);
    await app.restart();
    assert.equal((await app.get(id)).status, 'interrupted');
    assert.equal((await app.get(id)).results.length, 0);
  });
});
