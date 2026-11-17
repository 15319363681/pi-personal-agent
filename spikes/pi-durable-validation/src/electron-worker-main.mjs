import { app, utilityProcess } from 'electron';
import { readFile, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createJob, cleanupBarrier, assignPid, jobPids, terminateJob, closeHandle } from './win32-process.mjs';
process.stdout.write('CHAIN_BOOT\n');
const payload = JSON.parse(await readFile(process.argv[2], 'utf8'));
process.stdout.write('CHAIN_PAYLOAD\n');
let job, child;
const emit = (data) => process.stdout.write(`CHAIN=${JSON.stringify({ ...data, time: Date.now(), mainPid: process.pid })}\n`);
app.whenReady().then(async () => {
process.stdout.write('CHAIN_APP_READY\n');
try {
  await cleanupBarrier(payload.jobName);
  emit({ type: 'cleanup_complete' });
  job = createJob(payload.jobName);
  child = utilityProcess.fork(resolve(import.meta.dirname, 'electron-worker-runtime.mjs'), [], { stdio: 'pipe' });
  child.stderr.on('data', (text) => process.stderr.write(text));
  child.on('spawn', () => {
    try { assignPid(job, child.pid); emit({ type: 'runtime_assigned', runtimePid: child.pid }); child.postMessage(payload); }
    catch (error) { emit({ type: 'failure', error: String(error) }); app.exit(3); }
  });
  child.on('message', async (message) => {
    try {
      if (message.type === 'failure') throw new Error(message.error);
      const members = jobPids(job);
      if (message.type === 'tree_ready') {
        for (const pid of [message.runtimePid, ...message.pids.map((p) => p.pid)]) if (!members.includes(pid)) throw new Error(`missing_job_member:${pid}`);
        emit({ ...message, members });
        if (payload.terminateRuntime) {
          const deadline=Date.now()+8000;
          while(true){try{await access(payload.trigger);break;}catch{}if(Date.now()>deadline)throw Error('kill_trigger_timeout');await new Promise(r=>setTimeout(r,10));}
          child.kill();
        }
      } else if (message.type === 'complete') { emit(message); await terminateJob(job); closeHandle(job); job = null; app.exit(0); }
    } catch (error) { emit({ type: 'failure', error: String(error) }); if (job) { await terminateJob(job); closeHandle(job); job = null; } app.exit(3); }
  });
  child.once('exit', async () => {
    if (job) { await terminateJob(job); emit({ type: 'tree_empty', members: jobPids(job) }); closeHandle(job); job = null; }
    app.exit(0);
  });
} catch (error) { emit({ type: 'failure', error: String(error) }); if (job) closeHandle(job); app.exit(3); }
});
