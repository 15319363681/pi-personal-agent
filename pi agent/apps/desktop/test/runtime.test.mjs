import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../src/runtime.mjs';

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

test('recovery mode freezes task creation and external dispatch until explicit exit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-product-runtime-freeze-'));
  const runtime = await createRuntime({ dataDir: dir });
  try {
    runtime.store.setMeta('recovery_mode', 'true');
    const blocked = await runtime.handle('chat.send', { text: 'blocked', task: { goal: 'blocked' } });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'recovery_mode');
    const exited = await runtime.handle('recovery.exit');
    assert.equal(exited.ok, true);
    const allowed = await runtime.handle('chat.send', { text: 'allowed', task: { goal: 'allowed' } });
    assert.equal(allowed.ok, true);
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});
