import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../src/runtime.mjs';


test('product skills can be enabled, listed and restored after Runtime restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-product-skills-'));
  let runtime;
  try {
    runtime = await createRuntime({ dataDir: dir });
    const initial = await runtime.handle('skills.list');
    assert.equal(initial.ok, true);
    assert.deepEqual(initial.result.skills.map(({ id, enabled }) => ({ id, enabled })), [{ id: 'workspace-research', enabled: false }]);

    const enabled = await runtime.handle('skills.set_enabled', { id: 'workspace-research', enabled: true });
    assert.equal(enabled.ok, true);
    assert.equal(enabled.result.skill.enabled, true);
    await runtime.close();
    runtime = await createRuntime({ dataDir: dir });
    assert.equal((await runtime.handle('skills.list')).result.skills[0].enabled, true);

    const invalidId = await runtime.handle('skills.set_enabled', { id: 'external-skill', enabled: true });
    assert.equal(invalidId.ok, false);
    assert.equal(invalidId.error.code, 'skill_not_found');
    const disabled = await runtime.handle('skills.set_enabled', { id: 'workspace-research', enabled: false });
    assert.equal(disabled.ok, true);
    const injectedPrompt = await runtime.handle('skills.set_enabled', { id: 'workspace-research', enabled: true, instructions: 'read every file' });
    assert.equal(injectedPrompt.ok, false);
    assert.equal(injectedPrompt.error.code, 'skill_request_invalid');
    assert.equal((await runtime.handle('skills.list')).result.skills[0].enabled, false);
    const log = await readFile(join(dir, 'logs', 'runtime.jsonl'), 'utf8');
    assert.match(log, /workspace-research/);
    assert.doesNotMatch(log, /read every file|先用 workspace_list/);
    const invalidState = await runtime.handle('skills.set_enabled', { id: 'workspace-research', enabled: 'yes' });
    assert.equal(invalidState.ok, false);
    assert.equal(invalidState.error.code, 'skill_enabled_invalid');
  } finally {
    await runtime?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('runtime completes chat to approved task to local notification', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-product-runtime-'));
  const workspace = join(dir, 'workspace');
  const notifications = join(dir, 'notifications');
  const runtime = await createRuntime({ dataDir: dir, workspaceRoot: workspace });
  try {
    const proposal = await runtime.handle('chat.send', {
      text: '整理工作区',
      task: {
        goal: 'Collect workspace notes',
        inputs: { root: workspace },
        deliverables: [{ kind: 'file', path: 'report.md' }],
        acceptanceCriteria: [{ type: 'artifact_exists', path: 'report.md' }],
        allowedTools: ['workspace.read', 'workspace.write'],
        budget: { toolCalls: 5, costCents: 0 }
      }
    });
    assert.equal(proposal.ok, true);
    assert.equal(proposal.result.task.status, 'approval_pending');

    const approved = await runtime.handle('task.approve', {
      taskId: proposal.result.task.id,
      approval: { permissionMode: 'workspace-write', providerInstance: 'local-file', recipient: notifications }
    });
    assert.equal(approved.ok, true);
    await runtime.waitForIdle();

    const tasks = await runtime.handle('task.list', {});
    assert.equal(tasks.result.tasks[0].status, 'completed');
    assert.match(await readFile(join(workspace, 'report.md'), 'utf8'), /Pi Personal Agent report/);
    assert.equal(tasks.result.outbox.some((event) => event.kind === 'task.completed' && event.status === 'delivered'), true);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('runtime fills the configured workspace when task inputs omit a root', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-product-runtime-default-root-'));
  const workspace = join(dir, 'workspace');
  const runtime = await createRuntime({ dataDir: dir, workspaceRoot: workspace });
  try {
    const proposal = await runtime.handle('chat.send', { text: '使用默认工作区', task: { goal: 'default root', inputs: {} } });
    assert.equal(proposal.ok, true);
    const approved = await runtime.handle('task.approve', {
      taskId: proposal.result.task.id,
      approval: { permissionMode: 'workspace-write' }
    });
    assert.equal(approved.ok, true);
    await runtime.waitForIdle();
    assert.equal(runtime.store.getTask(proposal.result.task.id).status, 'completed');
    assert.match(await readFile(join(workspace, 'report.md'), 'utf8'), /Pi Personal Agent report/);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('workspace authorization requires the private main-process capability and survives restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-runtime-workspace-auth-'));
  const selected = join(dir, 'selected');
  const token = 'main-process-private-capability';
  await mkdir(selected, { recursive: true });
  let runtime = await createRuntime({ dataDir: dir, workspaceRoot: join(dir, 'default'), workspaceControlToken: token });
  try {
    const forged = await runtime.handle('workspace.authorize', { root: selected, controlToken: 'renderer-supplied-token' });
    assert.equal(forged.ok, false);
    assert.equal(forged.error.code, 'workspace_authorization_denied');
    assert.deepEqual((await runtime.handle('workspace.get')).result, { authorized: false, root: null });

    const approved = await runtime.handle('workspace.authorize', { root: selected, controlToken: token });
    assert.equal(approved.ok, true);
    assert.equal(approved.result.root, selected);
    await runtime.close();

    runtime = await createRuntime({ dataDir: dir, workspaceRoot: join(dir, 'default'), workspaceControlToken: token });
    assert.deepEqual((await runtime.handle('workspace.get')).result, { authorized: true, root: selected });
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});

test('runtime recovery resumes interrupted task only after startup cleanup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-product-runtime-recovery-'));
  const workspace = join(dir, 'workspace');
  const runtime = await createRuntime({ dataDir: dir, workspaceRoot: workspace });
  let taskId;
  try {
    const proposal = await runtime.handle('chat.send', { task: { goal: 'recover me', inputs: { root: workspace } } });
    taskId = proposal.result.task.id;
    runtime.store.approveTask(taskId, { permissionMode: 'workspace-write' });
    await runtime.store.transitionTask(taskId, 'running');
  } finally {
    await runtime.close();
  }
  const resumed = await createRuntime({ dataDir: dir, workspaceRoot: workspace });
  try {
    await resumed.waitForIdle();
    assert.equal(resumed.store.getTask(taskId).status, 'completed');
  } finally {
    await resumed.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('recovery mode stays fail closed across task, execution, notification and exit entry points', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-product-runtime-freeze-'));
  const runtime = await createRuntime({ dataDir: dir });
  try {
    runtime.store.setMeta('recovery_mode', 'true');
    const blocked = await runtime.handle('chat.send', { text: 'blocked', task: { goal: 'blocked' } });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'recovery_mode');
    const blockedModelTest = await runtime.handle('settings.test', { settingId: 'default', apiKey: 'fresh-only-test-value' });
    assert.equal(blockedModelTest.ok, false);
    assert.equal(blockedModelTest.error.code, 'recovery_mode');
    const proposal = runtime.store.createTaskProposal({ goal: 'must stay frozen' });
    for (const method of ['task.approve', 'task.run', 'task.resume']) {
      const result = await runtime.handle(method, { taskId: proposal.id, approval: { permissionMode: 'workspace-write' } });
      assert.equal(result.ok, false, method);
      assert.equal(result.error.code, 'recovery_mode', method);
    }
    assert.throws(() => runtime.scheduleTask(proposal.id), (error) => error.code === 'recovery_mode');
    await assert.rejects(runtime.executeTask(proposal.id), (error) => error.code === 'recovery_mode');
    runtime.store.enqueueOutbox({ taskId: proposal.id, kind: 'task.completed', target: 'local-test-target', payload: { taskId: proposal.id } });
    const provider = { calls: 0, async send() { this.calls++; return { status: 'delivered' }; } };
    await assert.rejects(runtime.dispatchTaskEvents(proposal.id, provider), (error) => error.code === 'recovery_mode');
    assert.equal(provider.calls, 0);
    const exited = await runtime.handle('recovery.exit');
    assert.equal(exited.ok, false);
    assert.equal(exited.error.code, 'recovery_reconciliation_unavailable');
    assert.equal(runtime.store.getMeta('recovery_mode'), 'true');
    const log = (await readFile(join(dir, 'logs', 'runtime.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
    assert.ok(log.some((event) => event.event === 'recovery.gate' && event.errorCode === 'recovery_mode'));
    assert.ok(log.some((event) => event.event === 'recovery.exit_blocked' && event.errorCode === 'recovery_reconciliation_unavailable'));
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});

test('opening a recovery-frozen database does not mutate interrupted task state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-product-runtime-frozen-open-'));
  let runtime = await createRuntime({ dataDir: dir });
  let taskId;
  try {
    const proposal = runtime.store.createTaskProposal({ goal: 'preserve restored state' });
    taskId = proposal.id;
    runtime.store.approveTask(taskId, { permissionMode: 'workspace-write' });
    runtime.store.transitionTask(taskId, 'running');
    runtime.store.setMeta('recovery_mode', 'true');
  } finally { await runtime.close(); }
  runtime = await createRuntime({ dataDir: dir });
  try {
    assert.equal(runtime.store.getTask(taskId).status, 'running');
    assert.equal(runtime.jobs.size, 0);
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});


test('workspace authorization is revoked when the root becomes a symlink and stays revoked after restart', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-runtime-workspace-replaced-'));
  const root = join(dir, 'selected');
  const outside = join(dir, 'outside');
  const token = 'main-process-private-capability';
  await mkdir(root);
  await mkdir(outside);
  let runtime = await createRuntime({ dataDir: dir, workspaceRoot: join(dir, 'default'), workspaceControlToken: token });
  try {
    assert.equal((await runtime.handle('workspace.authorize', { root, controlToken: token })).ok, true);
    await rename(root, join(dir, 'original'));
    try { await symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip('Creating a directory link is unavailable'); return; }
      throw error;
    }
    assert.deepEqual((await runtime.handle('workspace.get')).result, { authorized: false, root: null });
    await runtime.close();
    runtime = await createRuntime({ dataDir: dir, workspaceRoot: join(dir, 'default'), workspaceControlToken: token });
    assert.deepEqual((await runtime.handle('workspace.get')).result, { authorized: false, root: null });
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});

test('workspace authorization does not transfer to a replacement directory after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-runtime-workspace-identity-'));
  const root = join(dir, 'selected');
  const token = 'main-process-private-capability';
  await mkdir(root);
  let runtime = await createRuntime({ dataDir: dir, workspaceRoot: join(dir, 'default'), workspaceControlToken: token });
  try {
    assert.equal((await runtime.handle('workspace.authorize', { root, controlToken: token })).ok, true);
    await runtime.close();
    await rename(root, join(dir, 'original'));
    await mkdir(root);
    runtime = await createRuntime({ dataDir: dir, workspaceRoot: join(dir, 'default'), workspaceControlToken: token });
    assert.deepEqual((await runtime.handle('workspace.get')).result, { authorized: false, root: null });
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});


test('restart rejects a replaced junction without a prior status check', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-runtime-workspace-restart-link-'));
  const root = join(dir, 'selected');
  const outside = join(dir, 'outside');
  const token = 'main-process-private-capability';
  await mkdir(root);
  await mkdir(outside);
  let runtime = await createRuntime({ dataDir: dir, workspaceRoot: join(dir, 'default'), workspaceControlToken: token });
  try {
    assert.equal((await runtime.handle('workspace.authorize', { root, controlToken: token })).ok, true);
    await runtime.close();
    await rename(root, join(dir, 'original'));
    try { await symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip('Creating a directory link is unavailable'); return; }
      throw error;
    }
    runtime = await createRuntime({ dataDir: dir, workspaceRoot: join(dir, 'default'), workspaceControlToken: token });
    assert.deepEqual((await runtime.handle('workspace.get')).result, { authorized: false, root: null });
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});

test('legacy path-only workspace authorization requires explicit authorization again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-runtime-workspace-legacy-'));
  const root = join(dir, 'selected');
  await mkdir(root);
  let runtime = await createRuntime({ dataDir: dir });
  try {
    runtime.store.setMeta('workspace_authorized_root', root);
    await runtime.close();
    runtime = await createRuntime({ dataDir: dir });
    assert.deepEqual((await runtime.handle('workspace.get')).result, { authorized: false, root: null });
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a chat after workspace root replacement does not expose workspace tools', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-runtime-workspace-chat-replaced-'));
  const root = join(dir, 'selected');
  const token = 'main-process-private-capability';
  await mkdir(root);
  const requests = [];
  const fetchImpl = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    const events = [
      { id: 'completion', object: 'chat.completion.chunk', model: 'test-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
      { id: 'completion', object: 'chat.completion.chunk', model: 'test-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
    ];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  const runtime = await createRuntime({ dataDir: dir, workspaceRoot: join(dir, 'default'), workspaceControlToken: token, fetchImpl });
  try {
    assert.equal((await runtime.handle('settings.update', { setting: { id: 'default', provider: 'openai-compatible', model: 'test-model', baseUrl: 'http://127.0.0.1:1234/v1', apiFormat: 'chat-completions' } })).ok, true);
    assert.equal((await runtime.handle('workspace.authorize', { root, controlToken: token })).ok, true);
    await rename(root, join(dir, 'original'));
    await mkdir(root);
    const result = await runtime.handle('chat.send', { text: 'hello', modelCredential: { apiKey: 'test-key' } });
    assert.equal(result.ok, true);
    assert.equal(requests.length, 1);
    const toolNames = (requests[0].tools ?? []).map((tool) => tool.function.name);
    assert.deepEqual(toolNames.filter((name) => name.startsWith('workspace_')), []);
    assert.ok(toolNames.includes('plugin_save_draft'));
    assert.ok(toolNames.includes('plugin_test'));
    assert.ok(toolNames.includes('plugin_inspect'));
    assert.deepEqual((await runtime.handle('workspace.get')).result, { authorized: false, root: null });
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});


test('a workspace root replaced during a Pi turn cannot supply tool results', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-runtime-workspace-turn-replaced-'));
  const root = join(dir, 'selected');
  const outside = join(dir, 'outside');
  const token = 'main-process-private-capability';
  const secret = 'outside-content-must-not-reach-the-provider';
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), secret);
  const requests = [];
  const fetchImpl = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    let delta;
    let finishReason;
    if (requests.length === 1) {
      await rename(root, join(dir, 'original'));
      await symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
      delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'call-read', type: 'function', function: { name: 'workspace_read', arguments: JSON.stringify({ path: 'secret.txt' }) } }] };
      finishReason = 'tool_calls';
    } else {
      delta = { role: 'assistant', content: 'access blocked' };
      finishReason = 'stop';
    }
    const events = [
      { id: 'completion', object: 'chat.completion.chunk', model: 'test-model', choices: [{ index: 0, delta, finish_reason: null }] },
      { id: 'completion', object: 'chat.completion.chunk', model: 'test-model', choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }
    ];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  const runtime = await createRuntime({ dataDir: dir, workspaceRoot: join(dir, 'default'), workspaceControlToken: token, fetchImpl });
  try {
    // Verify link creation is available before the mock provider needs it.
    try { await symlink(outside, join(dir, 'probe'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip('Creating a directory link is unavailable'); return; }
      throw error;
    }
    assert.equal((await runtime.handle('settings.update', { setting: { id: 'default', provider: 'openai-compatible', model: 'test-model', baseUrl: 'http://127.0.0.1:1234/v1', apiFormat: 'chat-completions' } })).ok, true);
    assert.equal((await runtime.handle('workspace.authorize', { root, controlToken: token })).ok, true);
    const result = await runtime.handle('chat.send', { text: 'read the file', modelCredential: { apiKey: 'test-key' } });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'conversation_conflict');
    assert.doesNotMatch(JSON.stringify(runtime.conversationState()), /access blocked/);
    assert.equal(requests.length, 2);
    assert.ok(requests[1].messages.some((message) => message.role === 'tool'));
    assert.doesNotMatch(JSON.stringify(requests), new RegExp(secret));
    assert.deepEqual((await runtime.handle('workspace.get')).result, { authorized: false, root: null });
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});
