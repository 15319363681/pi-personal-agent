import { spawnSuspended, parseSid } from './win32-process.mjs';
import { createHarnessFixture } from './harness-fixture.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
process.parentPort.once('message', async ({ data }) => {
  let child, sid, fixture;
  try {
    fixture = await createHarnessFixture(data.databasePath);
    if (data.sid) sid = parseSid(data.sid);
    child = spawnSuspended(data.exe, data.args, { sid: sid?.sid, cwd: data.cwd });
    if (!child.inJob()) throw new Error('worker_not_in_job_before_resume');
    child.resume();
    if (data.mode === 'tree') {
      const deadline = Date.now() + 8000; const pids = [];
      for (let depth = 2; depth >= 0; depth--) {
        const path = join(data.cwd, `pid-${depth}`);
        while (true) {
          try { const [pid, creationTicks] = (await readFile(path, 'utf8')).split(','); if (pid && creationTicks) { pids.push({ pid: Number(pid), creationTicks }); break; } } catch {}
          if (Date.now() > deadline) throw new Error('worker_tree_readiness_timeout');
          await delay(20);
        }
      }
      process.parentPort.postMessage({ type: 'tree_ready', runtimePid: process.pid, pids, workerPid: child.pid });
    } else {
      const exit = await child.wait(65000); child.close(); child = null;
      if (exit !== 0) throw new Error(`restricted_worker_exit:${exit}`);
      await fixture.close(); fixture = null;
      process.parentPort.postMessage({ type: 'complete', runtimePid: process.pid });
    }
  } catch (error) { process.parentPort.postMessage({ type: 'failure', error: String(error), runtimePid: process.pid }); }
  finally { sid?.close(); }
});
