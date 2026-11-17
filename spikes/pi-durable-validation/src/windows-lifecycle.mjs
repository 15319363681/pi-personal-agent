import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cleanupBarrier, processHandle, isDead, closeHandle, privateJobName } from './win32-process.mjs';
import { launchChain } from './windows-chain-driver.mjs';
import { setTimeout as delay } from 'node:timers/promises';
const dir = await mkdtemp(join(tmpdir(), 'pi-job-'));
const exe = resolve('../windows-worker/bin/Win32Probe.exe');
const jobName = privateJobName(`spike.${process.pid}.${Date.now()}`);
let current; const handles = [];
try {
  // Injected OS-error paths test admission logic, not a real cross-user ACL claim.
  for (const reason of ['access_denied', 'unknown_job_state', 'identity_mismatch']) {
    await assert.rejects(cleanupBarrier(jobName, () => { throw new Error(reason); }), new RegExp(reason));
  }
  for (const cause of ['runtime', 'main']) {
    const dataDir = join(dir, cause); await mkdir(dataDir);
    const trigger = join(dir, `${cause}.trigger`);
    const payload = { mode: 'tree', exe, args: ['tree', dataDir, '2'], cwd: dataDir, databasePath: join(dataDir, 'db.sqlite'), jobName, terminateRuntime: cause === 'runtime', trigger };
    current = await launchChain(payload, join(dir, `${cause}.json`));
    const ready = await current.waitFor('tree_ready');
    const old = [ready.runtimePid, ...ready.pids.map((p) => p.pid)].map(processHandle); handles.push(...old);
    if (cause === 'main') current.child.kill(); else await writeFile(trigger,'kill');
    await current.exited;
    // Restart uses the SAME named Job and SQLite path. Cleanup runs before new Runtime allocation.
    payload.terminateRuntime = false;
    const nextDir = join(dataDir,'generation2'); await mkdir(nextDir);payload.cwd=nextDir;payload.args=['tree',nextDir,'2'];
    current = await launchChain(payload, join(dir, `${cause}-restart.json`));
    const cleanup = await current.waitFor('cleanup_complete');
    const deadline = Date.now() + 8000;
    while (!old.every(isDead)) { if (Date.now() > deadline) throw new Error('old_tree_survived_restart'); await delay(20); }
    const restarted = await current.waitFor('runtime_assigned');
    assert(cleanup.time <= restarted.time);
    // Old marker files must not represent the next generation's readiness.
    console.log(JSON.stringify({ scenario: cause, old: ready, cleanup, restarted, allOldHandlesSignaled: true }));
    current.child.kill(); await current.exited; current = null;
    await cleanupBarrier(jobName);
  }
  console.log('PROBE_PASS job-lifecycle');
} finally {
  if (current && current.child.exitCode === null) { current.child.kill(); await current.exited; }
  for (const h of handles) closeHandle(h);
  await cleanupBarrier(jobName);
  await rm(dir, { recursive: true, force: true });
}
