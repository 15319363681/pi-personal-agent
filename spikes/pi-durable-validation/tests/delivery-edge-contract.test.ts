import {test, expect} from 'vitest';
import {mkdtemp, rm, writeFile, open} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openDeliveryDb, sendDelivery, restoreBackup, reconcile, exitRecoveryMode, appendJournalRecord, readAndRepairJournal, guardOperation} from '../src/delivery-journal.mjs';
test('restore_really_rolls_back_data_and_reconciliation_reconstructs_journal_only_delivery', async () => {
 const dir=await mkdtemp(join(tmpdir(),'pi-real-restore-')); let db:any;
 try {
  db=openDeliveryDb(join(dir,'db.sqlite')); const backup=join(dir,'backup.sqlite'); const journal=join(dir,'delivery.jsonl');
  db.prepare("INSERT INTO meta VALUES ('snapshot','old')").run(); db.exec(`VACUUM INTO '${backup.replaceAll("'","''")}'`);
  db.prepare("UPDATE meta SET value='new' WHERE key='snapshot'").run();
  const p={calls:0,async send(){this.calls++;return 'receipt';}}; await sendDelivery(db,journal,p);
  restoreBackup(db,backup);
  expect(db.prepare("SELECT value FROM meta WHERE key='snapshot'").get().value).toBe('old');
  expect(db.prepare('SELECT * FROM delivery').all()).toHaveLength(0);
  await expect(sendDelivery(db,journal,p)).rejects.toThrow('recovery_mode'); expect(p.calls).toBe(1);
  await reconcile(db,journal); expect(()=>guardOperation(db,'model')).toThrow('recovery_mode');
  expect(db.prepare('SELECT status FROM delivery').get().status).toBe('delivered');
  expect(()=>exitRecoveryMode(db,{userConfirmed:false})).toThrow(); exitRecoveryMode(db,{userConfirmed:true});
 } finally {db?.close();await rm(dir,{recursive:true,force:true});}
});
test('attempting_and_provider_exceptions_never_automatically_resend_across_reopen', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-unknown-'));const path=join(dir,'db.sqlite');let db:any;
 try {
  db=openDeliveryDb(path); const p={calls:0,async send(){this.calls++;throw Error('network_response_lost');}};
  await expect(sendDelivery(db,join(dir,'journal'),p)).resolves.toMatchObject({status:'unknown'});
  db.close();db=openDeliveryDb(path);
  expect(db.prepare('SELECT status FROM delivery').get().status).toBe('unknown');
  await expect(sendDelivery(db,join(dir,'journal'),p)).rejects.toThrow(); expect(p.calls).toBe(1);
  db.prepare("UPDATE delivery SET status='attempting'").run(); await expect(sendDelivery(db,join(dir,'journal'),p)).rejects.toThrow();expect(p.calls).toBe(1);
 } finally {db?.close();await rm(dir,{recursive:true,force:true});}
});
test('corrupt_complete_line_or_checksum_cannot_be_a_success_receipt',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-corrupt-journal-'));const path=join(dir,'journal');
 try {
  await appendJournalRecord(path,{id:'d1',status:'attempting'});
  await writeFile(path,'{"id":"d1","status":"delivered","receipt":"forged"}\n',{flag:'a'});
  const records=await readAndRepairJournal(path); expect(records).toHaveLength(1);expect(records[0].status).toBe('attempting');
 } finally {await rm(dir,{recursive:true,force:true});}
});
test('backup_only_attempt_and_unreconciled_restore_cannot_thaw',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-backup-only-'));const db=openDeliveryDb(join(dir,'db.sqlite'));
 try {
  const backup=join(dir,'backup.sqlite'); db.prepare("INSERT INTO delivery VALUES ('only-in-backup','attempting')").run();db.exec(`VACUUM INTO '${backup.replaceAll("'","''")}'`);restoreBackup(db,backup);
  expect(()=>exitRecoveryMode(db,{userConfirmed:true})).toThrow('reconciliation_required');
  await reconcile(db,join(dir,'journal'));expect(db.prepare('SELECT status FROM delivery').get()!.status).toBe('unknown');
  expect(()=>exitRecoveryMode(db,{userConfirmed:true})).toThrow('unresolved_delivery');
 } finally {db.close();await rm(dir,{recursive:true,force:true});}
});
