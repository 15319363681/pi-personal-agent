import { test, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHarnessFixture } from '../src/harness-fixture.mjs';
import { openObserver } from '../src/readonly-observer.mjs';
import koffi from 'koffi';
const require = createRequire(import.meta.url);
function launch(path: string, mode = 'hold') {
  const child = spawn(require('electron'), [resolve('src/electron-lock-main.mjs'), resolve('src/electron-owner-runtime.mjs'), path, mode], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = ''; let closed = false;
  child.stdout!.on('data', c => { output += c; }); child.stderr!.on('data', c => { output += c; });
  const exited = new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('close', c => { closed = true; done(c); }); });
  return { child, exited, text: () => output, async until(token: string) {
    const deadline = Date.now() + 12000;
    while (!output.includes(token)) { if (closed || Date.now() > deadline) throw Error(`missing ${token}: ${output}`); await new Promise(r => setTimeout(r, 10)); }
    return output;
  } };
}
test('independent_runtime_competition_and_main_death_keep_one_actual_database_writer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-owner-contract-')); const path = join(dir, 'db.sqlite');
  let owner: ReturnType<typeof launch> | undefined; let runtimePid = 0;
  try {
    owner = launch(path); const out = await owner.until('OWNER_READY');
    runtimePid = Number(/RUNTIME_PID=(\d+)/.exec(out)![1]);
    const competitor = launch(path, 'once'); expect(await competitor.exited).toBe(0);
    expect(competitor.text()).toContain('REJECTED=writer_busy');
    for (const marker of ['writable_open','harness_open','resume','submit','committed']) expect(competitor.text()).not.toContain(`MARK=${marker}`);
    // Forced Main death bypasses its cleanup; old utility Runtime must still own its lease.
    const kernel = koffi.load('kernel32.dll'); const nt = koffi.load('ntdll.dll');
    const handle = kernel.func('void * __stdcall OpenProcess(uint32_t, int, uint32_t)')(0x00100800, 0, runtimePid);
    expect(handle).toBeTruthy();
    const suspend = nt.func('int32_t __stdcall NtSuspendProcess(void *)');
    const resume = nt.func('int32_t __stdcall NtResumeProcess(void *)');
    expect(suspend(handle)).toBe(0);
    owner.child.kill(); await owner.exited;
    process.kill(runtimePid, 0);
    const restart = launch(path, 'once'); expect(await restart.exited).toBe(0);
    expect(restart.text()).toContain('REJECTED=writer_busy'); expect(restart.text()).not.toContain('MARK=writable_open');
    await writeFile(`${path}.stop`, 'stop');
    expect(resume(handle)).toBe(0);
    const wait=kernel.func('uint32_t __stdcall WaitForSingleObject(void *,uint32_t)');
    const deadline=Date.now()+8000;while(wait(handle,0)!==0){if(Date.now()>deadline)throw Error('old_runtime_not_exited');await new Promise(r=>setTimeout(r,10));}
    kernel.func('int __stdcall CloseHandle(void *)')(handle);
    const recovery = launch(path, 'once'); expect(await recovery.exited).toBe(0);
    expect(recovery.text()).toContain('MARK=cleanup_complete'); expect(recovery.text()).toContain('MARK=integrity_ok');
    expect(recovery.text().indexOf('MARK=lease_acquired')).toBeLessThan(recovery.text().indexOf('MARK=writable_open'));
    expect(recovery.text().indexOf('MARK=cleanup_complete')).toBeLessThan(recovery.text().indexOf('MARK=harness_open'));
    expect(recovery.text()).toContain('MARK=committed'); runtimePid = 0;
  } finally { if (runtimePid) { try { process.kill(runtimePid); } catch {} } if (owner?.child.exitCode === null) { owner.child.kill(); await owner.exited; } await rm(dir, {recursive:true, force:true}); }
});
test('Electron_Main_single_instance_lock_rejects_duplicate_before_Runtime_spawn',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-single-main-'));const path=join(dir,'db.sqlite');let first:any;
 try{first=launch(path,'single-hold');await first.until('OWNER_READY');const second=launch(path,'single-once');await second.exited;expect(second.text()).toContain('MAIN_REJECTED=single_instance');expect(second.text()).not.toContain('RUNTIME_PID=');await writeFile(`${path}.stop`,'stop');await first.exited;}
 finally{if(first?.child.exitCode===null){first.child.kill();await first.exited;}await rm(dir,{recursive:true,force:true});}
});
test('cleanup_uncertainty_and_corrupt_database_fail_closed_and_release_lease', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-owner-error-')); const path = join(dir, 'db.sqlite'); const events: string[] = [];
  try {
    await expect(createHarnessFixture(path, 'normal', false, { marker: (x: string) => events.push(x), cleanup: () => { throw Error('cleanup_unknown'); } })).rejects.toThrow('cleanup_unknown');
    expect(events).toEqual(['lease_acquired']);
    await writeFile(path, 'not a SQLite database');
    await expect(createHarnessFixture(path)).rejects.toThrow();
    await rm(path);
    const f = await createHarnessFixture(path); await f.close();
  } finally { await rm(dir, {recursive:true, force:true}); }
});
test('readonly_observer_never_recovers_schedules_or_writes_even_with_pending_tasks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-observer-')); const path = join(dir,'db.sqlite'); let writer: any; let observer: any;
  try {
    writer = await createHarnessFixture(path); await writer.createCheckpoint();
    const before = await writer.db.get('SELECT next_seq FROM durable_metadata WHERE singleton=1');
    observer = await openObserver(path);
    const snapshot = await observer.harness.inspect(observer.context); expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0].record.state.status).toBe('pending');
    expect(() => observer.harness.resume()).toThrow();
    const conversation = await observer.harness.conversation(writer.root.id, observer.context);
    await expect(conversation.commit((tx: any) => tx.appendEntry(writer.root.id, {kind:'spike.illegal',data:{}}), observer.context)).rejects.toThrow();
    await new Promise(r => setTimeout(r, 30));
    expect(await writer.db.get('SELECT next_seq FROM durable_metadata WHERE singleton=1')).toEqual(before);
    expect(await observer.writes()).toBe(0); expect(observer.modelCalls()).toBe(0);
  } finally { await observer?.close(); await writer?.close(); await rm(dir, {recursive:true, force:true}); }
});
