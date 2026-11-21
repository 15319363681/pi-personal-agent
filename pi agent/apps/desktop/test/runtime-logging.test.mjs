import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../src/runtime.mjs';

test('runtime logs lifecycle and notification events without prompts or credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-runtime-log-'));
  try {
    const runtime = await createRuntime({ dataDir: dir });
    try {
      const event = JSON.parse((await readFile(join(dir, 'logs', 'runtime.jsonl'), 'utf8')).trim());
      const systemStatus = await runtime.handle('system.status');
      assert.equal(systemStatus.result.logPath, join(dir, 'logs', 'runtime.jsonl'));
      assert.equal(event.event, 'runtime.started');
      assert.equal(event.correlationId.length > 0, true);
      assert.equal(event.status, 'ready');
      assert.doesNotMatch(JSON.stringify(event), /apiKey|prompt|file content/);
      const proposal = await runtime.handle('chat.send', { text: 'private prompt must not be logged', task: { goal: 'private task goal' } });
      await runtime.handle('task.approve', { taskId: proposal.result.task.id, approval: { permissionMode: 'workspace-write', providerInstance: 'local-file', recipient: join(dir, 'notify') } });
      await runtime.waitForIdle();
      const lines = (await readFile(join(dir, 'logs', 'runtime.jsonl'), 'utf8')).trim().split(/\r?\n/);
      const events = lines.map((line) => JSON.parse(line));
      for (const name of ['task.proposed', 'task.approved', 'task.running', 'notification.attempt', 'notification.result']) assert.ok(events.some((entry) => entry.event === name), name);
      const joined = lines.join('\n');
      assert.doesNotMatch(joined, /private prompt must not be logged|private task goal|apiKey|authorization/i);
      assert.ok(events.filter((entry) => entry.event.startsWith('notification.')).every((entry) => entry.taskId && entry.deliveryId && entry.correlationId));
    } finally { await runtime.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
