import {test,expect} from 'vitest';
import {DatabaseSync, backup} from 'node:sqlite';
import {NodeSqliteDatabase} from '@earendil-works/chord/sqlite/node';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHarnessFixture} from '../src/harness-fixture.mjs';
import {openDeliveryDb,sendDelivery,restoreBackup,reconcile,guardOperation,exitRecoveryMode} from '../src/delivery-journal.mjs';

test('Durable_business_records_and_delivery_intent_share_one_transaction_and_actual_backup_restore_freezes', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-durable-delivery-'));const path=join(dir,'db.sqlite');let f:any,raw:any;let intent=false;
 let recoveryModelGuardCalls=0;
 const start=async(restore?:string, guarded=false)=>createHarnessFixture(path,'normal',false,{
  databaseFactory:async(p:string)=>{raw=openDeliveryDb(p);if(restore)restoreBackup(raw,restore);return new NodeSqliteDatabase(raw);},
  beforeCommit:async(tx:any)=>{if(intent)await tx.run("INSERT INTO delivery VALUES ('delivery-1','intent')");},
  beforeModelCall:guarded?()=>{recoveryModelGuardCalls++;guardOperation(raw,'model');}:undefined,
 });
 try {
  f=await start();const backupPath=join(dir,'backup.sqlite');await backup(raw,backupPath);
  intent=true;f.failNextTransaction();await expect(f.atomicTransition()).rejects.toThrow('injected_before_commit');await f.harness.closed;intent=false;
  f=await start();expect(raw.prepare('SELECT * FROM delivery').all()).toHaveLength(0);
  intent=true;await f.atomicTransition();intent=false;
  const rows=(await f.root.entries({},100,undefined,f.context)).items.filter((e:any)=>e.kind.startsWith('spike.business.'));
  expect(rows).toHaveLength(6);expect(new Set(await f.entrySequences(rows)).size).toBe(1);
  expect(raw.prepare('SELECT status FROM delivery').get().status).toBe('intent');
  const p={calls:0,async send(){this.calls++;return 'fake-receipt';}};const journal=join(dir,'journal');
  await sendDelivery(raw,journal,'delivery-1',p);expect(p.calls).toBe(1);await f.close();
  // Restore the ENTIRE database before opening Harness, with the lease already held.
  f=await start(backupPath,true);
  expect((await f.root.entries({},100,undefined,f.context)).items.filter((e:any)=>e.kind.startsWith('spike.business.'))).toHaveLength(0);
  for(const kind of ['model','send','notification'])expect(()=>guardOperation(raw,kind)).toThrow('recovery_mode');
  const blockedSubmission=await f.root.submit({type:'input',content:'must not reach model',requestId:'recovery-model-1'},f.context);
  f.harness.resume();await f.harness.waitForIdle(f.context);
  expect(await blockedSubmission.status(f.context)).toMatchObject({status:'unanswered'});
  expect(recoveryModelGuardCalls).toBe(1);expect(f.fake.state.callCount).toBe(0);
  await expect(sendDelivery(raw,journal,'delivery-1',p)).rejects.toThrow('recovery_mode');expect(p.calls).toBe(1);
  await reconcile(raw,journal);expect(raw.prepare('SELECT status FROM delivery').get().status).toBe('delivered');
  expect(()=>guardOperation(raw,'notification')).toThrow('recovery_mode');exitRecoveryMode(raw,{userConfirmed:true});
  expect(()=>guardOperation(raw,'model')).not.toThrow();expect(await f.integrity()).toBe('ok');
 }finally{await f?.close().catch(()=>{});await rm(dir,{recursive:true,force:true});}
});
