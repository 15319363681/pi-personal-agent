import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../src/runtime.mjs';

test('local MVP closes the approved task and notification loop', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-product-e2e-'));
  const runtime = await createRuntime({ dataDir: dir, workspaceRoot: join(dir, 'workspace') });
  try {
    const proposal = await runtime.handle('chat.send', {
      text: '生成本地工作区报告',
      task: { goal: '生成本地工作区报告', inputs: { root: join(dir, 'workspace') }, deliverables: [{ path: 'report.md' }], acceptanceCriteria: [{ type: 'artifact_exists', path: 'report.md' }] }
    });
    const taskId = proposal.result.task.id;
    const approval = await runtime.handle('task.approve', { taskId, approval: { permissionMode: 'workspace-write', providerInstance: 'local-file', recipient: join(dir, 'notifications') } });
    assert.equal(approval.result.task.status, 'queued');
    await runtime.waitForIdle();
    const view = await runtime.handle('task.list');
    assert.equal(view.result.tasks.find((task) => task.id === taskId).status, 'completed');
    const completion = view.result.outbox.find((event) => event.taskId === taskId && event.kind === 'task.completed');
    assert.equal(completion.status, 'delivered');
    assert.match(await readFile(completion.receipt, 'utf8'), /task.completed/);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
