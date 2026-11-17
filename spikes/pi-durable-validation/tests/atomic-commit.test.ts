import { test, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessFixture } from '../src/harness-fixture.mjs';

test('business_transition_is_all_or_nothing_in_one_SQLite_transaction', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-atomic-'));
  let f: Awaited<ReturnType<typeof createHarnessFixture>> | undefined;
  try {
    const path = join(dir, 'db.sqlite');
    f = await createHarnessFixture(path);
    f.failNextTransaction();
    await expect(f.atomicTransition()).rejects.toThrow('injected_before_commit');
    await f.harness.closed;
    f = await createHarnessFixture(path);
    expect((await f.root.entries({}, 100, undefined, f.context)).items.filter((e: any) => e.kind.startsWith('spike.business.'))).toHaveLength(0);
    expect((await f.harness.inspect(f.context)).tasks).toHaveLength(0);
    const id = await f.atomicTransition();
    await f.close();
    f = await createHarnessFixture(path);
    const rows = (await f.root.entries({}, 100, undefined, f.context)).items.filter((e: any) => e.kind.startsWith('spike.business.'));
    expect(rows.map((e: any) => e.kind).sort()).toEqual(['approval', 'budgetReservation', 'outbox', 'permissionSnapshot', 'pluginVersion', 'task'].map((s) => `spike.business.${s}`).sort());
    expect((await f.harness.getTask(id, f.context))?.state).toMatchObject({ status: 'pending', checkpoint: { phase: 'saved', marker: 42 } });
    expect(new Set(await f.entrySequences(rows)).size).toBe(1);
    expect(await f.integrity()).toBe('ok');
    await f.close();
  } finally { if (f) await f.close().catch(() => {}); await rm(dir, { recursive: true, force: true }); }
});
