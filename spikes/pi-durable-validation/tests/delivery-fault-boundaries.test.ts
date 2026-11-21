import { test, expect } from 'vitest';
import { mkdtemp, rm, open, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { openDeliveryDb, sendDelivery, reconcile, restoreBackup, exitRecoveryMode, appendJournalRecord, resolveDelivery, acknowledgeJournalCorruption, guardOperation } from '../src/delivery-journal.mjs';

test('result_fsync_and_rollback_failure_remain_unknown_even_after_old_backup_restore', async () => {
 const dir=await mkdtemp(join(tmpdir(),'pi-fault-fence-'));const path=join(dir,'db.sqlite');let db:any;
 try {
  db=openDeliveryDb(path);const snapshot=join(dir,'backup.sqlite');const journal=join(dir,'journal');
  db.prepare("INSERT INTO delivery VALUES ('delivery-1','intent')").run();
  db.exec(`VACUUM INTO '${snapshot.replaceAll("'","''")}'`);
  let syncs=0;const p={calls:0,async send(){this.calls++;return 'accepted';}};
  const io={sync:async(h:any)=>{if(++syncs===2)throw Error('result_fsync_failed');await h.sync();},truncate:async()=>{throw Error('rollback_failed');}};
  expect(await sendDelivery(db,journal,'delivery-1',p,io)).toMatchObject({status:'unknown'});
  expect(await readFile(journal,'utf8')).toContain('delivered'); // rollback itself was injected to fail
  db.close();db=openDeliveryDb(path);
  expect(db.prepare('SELECT status FROM delivery').get().status).toBe('unknown');
  await expect(sendDelivery(db,journal,'delivery-1',p)).rejects.toThrow();expect(p.calls).toBe(1);
  restoreBackup(db,snapshot);await reconcile(db,journal);
  expect(db.prepare('SELECT status FROM delivery').get().status).toBe('unknown');
  expect(()=>exitRecoveryMode(db,{userConfirmed:true})).toThrow('unresolved_delivery');
  await resolveDelivery(db,journal,'delivery-1',{userConfirmed:true,decision:'failed',note:'User checked fake inbox: do not retry'});
  exitRecoveryMode(db,{userConfirmed:true});expect(p.calls).toBe(1);
 }finally{db?.close();await rm(dir,{recursive:true,force:true});}
});

test('corrupted_journal_only_record_stays_frozen_until_explicit_audited_manual_review',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-corrupt-freeze-'));let db:any;
 try{
  db=openDeliveryDb(join(dir,'db.sqlite'));const journal=join(dir,'journal');
  await writeFile(journal,'{"payload":"damaged after backup"}\n');await reconcile(db,journal);
  expect(()=>guardOperation(db,'model')).toThrow('recovery_mode');
  expect(()=>exitRecoveryMode(db,{userConfirmed:true})).toThrow('journal_corrupt');
  await expect(acknowledgeJournalCorruption(db,journal,{userConfirmed:false,note:'review'})).rejects.toThrow();
  await acknowledgeJournalCorruption(db,journal,{userConfirmed:true,note:'Inspected quarantined bytes and fake provider receipts; no unresolved deliveries'});
  await reconcile(db,journal);exitRecoveryMode(db,{userConfirmed:true});
  expect(db.prepare("SELECT value FROM meta WHERE key='journal_corruption_review'").get().value).toContain('Inspected');
 }finally{db?.close();await rm(dir,{recursive:true,force:true});}
});

test('fake_provider_accept_then_process_kill_before_result_journal_never_resends',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-send-crash-'));const path=join(dir,'db.sqlite');let child:any,db:any;
 try{
  child=spawn(process.execPath,[resolve('src/delivery-crash-worker.mjs'),path],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  let out='';child.stdout.on('data',(s:any)=>{out+=s;});child.stderr.on('data',(s:any)=>{out+=s;});
  let closed=false;const exited=new Promise(r=>child.once('close',()=>{closed=true;r(null);}));
  const until=Date.now()+8000;while(!out.includes('PROVIDER_ACCEPTED')){if(closed||Date.now()>until)throw Error(out||'accept_boundary_missing');await new Promise(r=>setTimeout(r,10));}
  child.kill();await exited;
  db=openDeliveryDb(path);await reconcile(db,join(dir,'journal'));
  expect(db.prepare('SELECT status FROM delivery').get().status).toBe('unknown');
  const p={calls:0,async send(){this.calls++;return 'duplicate';}};
  await expect(sendDelivery(db,join(dir,'journal'),'delivery-1',p)).rejects.toThrow();expect(p.calls).toBe(0);
  expect((await readFile(join(dir,'accepted'),'utf8')).trim()).toBe('delivery-1');
 }finally{if(child?.exitCode===null)child.kill();db?.close();await rm(dir,{recursive:true,force:true});}
});

test('backup_only_intent_needs_manual_resolution',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-intent-'));const db=openDeliveryDb(join(dir,'db.sqlite'));
 try{
  db.prepare("INSERT INTO delivery VALUES ('backup-intent','intent')").run();
  await reconcile(db,join(dir,'journal'));expect(db.prepare('SELECT status FROM delivery').get()!.status).toBe('unknown');
  await expect(resolveDelivery(db,join(dir,'journal'),'backup-intent',{userConfirmed:false,decision:'failed',note:'skip'})).rejects.toThrow();
  await resolveDelivery(db,join(dir,'journal'),'backup-intent',{userConfirmed:true,decision:'failed',note:'User chooses no further delivery'});
  expect(db.prepare('SELECT status FROM delivery').get()!.status).toBe('failed');
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
});
