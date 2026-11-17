import { test, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createHarnessFixture } from '../src/harness-fixture.mjs';

test('reopens_the_same_conversation_and_does_not_duplicate_request_id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-conversation-'));
  try {
    let f = await createHarnessFixture(join(dir, 'db.sqlite'));
    const original = await f.root.submit({ type: 'input', content: 'hello', requestId: 'stable-1' }, f.context);
    expect((await original.wait(f.context)).status).toBe('done');
    const id = f.root.id;
    await f.close();
    f = await createHarnessFixture(join(dir, 'db.sqlite'));
    expect(f.root.id).toBe(id);
    const duplicate = await f.root.submit({ type: 'input', content: 'hello', requestId: 'stable-1' }, f.context);
    expect(duplicate.id).toBe(original.id);
    expect(f.fake.state.callCount).toBe(0);
    expect(await f.integrity()).toBe('ok');
    await f.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('persists_a_custom_task_checkpoint', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-checkpoint-'));
  try {
    let f = await createHarnessFixture(join(dir, 'db.sqlite'));
    const id = await f.createCheckpoint();
    await f.close();
    f = await createHarnessFixture(join(dir, 'db.sqlite'));
    expect((await f.harness.getTask(id, f.context))?.state).toMatchObject({ status: 'pending', checkpoint: { phase: 'saved', marker: 42 } });
    await f.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const scenario of ['blockedModel', 'safeTool', 'unsafeTool']) {
  test(`crash_recovery_${scenario}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-crash-'));
    const path = join(dir, 'db.sqlite');
    const child = spawn(process.execPath, [resolve('src/crash-worker.mjs'), path, scenario], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let errors = '';
    try {
      await new Promise<void>((ready, reject) => {
        const timer = setTimeout(() => reject(new Error(`boundary timeout: ${output} ${errors}`)), 10000);
        child.stderr.on('data', (data) => { errors += data; });
        child.stdout.on('data', (data) => { output += data; if (output.includes('BOUNDARY=')) { clearTimeout(timer); ready(); } });
        child.once('error', reject);
        child.once('exit', (code) => { if (!output.includes('BOUNDARY=')) { clearTimeout(timer); reject(new Error(`early exit=${code}: ${errors}`)); } });
      });
      const exited = new Promise<void>((done) => child.once('exit', () => done()));
      child.kill(); await exited;
      const f = await createHarnessFixture(path, scenario, true);
      expect(await f.integrity()).toBe('ok');
      f.harness.resume();
      await f.harness.waitForIdle(f.context);
      const rows = await f.root.entries({}, 50, undefined, f.context);
      if (scenario === 'blockedModel') {
        expect(f.fake.state.callCount).toBe(1);
        expect(rows.items.filter((e: any) => e.kind === 'pi.user')).toHaveLength(1);
      } else {
        expect(f.toolCalls.length).toBe(scenario === 'safeTool' ? 1 : 0);
        const result = rows.items.find((e: any) => e.kind === 'pi.tool-result');
        expect(result).toBeDefined();
        if (scenario === 'unsafeTool') expect(JSON.stringify(result)).toContain('interrupted');
      }
      await f.close();
    } finally { if (child.exitCode === null) child.kill(); await rm(dir, { recursive: true, force: true }); }
  });
}
