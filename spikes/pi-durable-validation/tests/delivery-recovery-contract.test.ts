import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from 'vitest';
import { openDeliveryDb, sendDelivery, appendJournalRecord, readAndRepairJournal, restoreBackup, guardOperation, reconcile, exitRecoveryMode } from '../src/delivery-journal.mjs';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'pi-delivery-'));
  const dbPath = join(dir, 'state.sqlite');
  const journal = join(dir, 'delivery.jsonl');
  return { dir, dbPath, journal, db: openDeliveryDb(dbPath) };
}

test('pre_send_journal_write_or_fsync_failure_never_calls_provider', async () => {
  for (const fault of ['write', 'sync']) {
    const f = await fixture();
    try {
      const provider = { calls: 0, async send() { this.calls++; return 'receipt'; } };
      f.db.prepare("INSERT INTO delivery VALUES ('delivery-1','intent')").run();
      const io = fault === 'write'
        ? { open: async () => ({ async stat() { return { size: 0 }; }, async writeFile() { throw new Error('disk write failed'); }, async truncate() {}, async sync() {}, async close() {} }) }
        : { sync: async () => { throw new Error('fsync failed'); } };
      await expect(sendDelivery(f.db, f.journal, 'delivery-1', provider, io)).rejects.toThrow();
      expect(provider.calls).toBe(0);
    } finally { f.db.close(); await rm(f.dir, { recursive: true, force: true }); }
  }
});

test('post_send_journal_write_or_fsync_failure_stays_unknown_and_never_retries', async () => {
  for (const fault of ['write', 'sync']) {
    const f = await fixture();
    try {
      let syncs = 0;
      const provider = { calls: 0, async send() { this.calls++; return 'accepted'; } };
      f.db.prepare("INSERT INTO delivery VALUES ('delivery-1','intent')").run();
      let writes = 0;
      const io = fault === 'write'
        ? { open: async () => { const h = await import('node:fs/promises').then((m) => m.open(f.journal, 'a')); return { stat: () => h.stat(), truncate: (size: number) => h.truncate(size), writeFile: async (data: string) => { writes++; if (writes === 2) throw new Error('result write failed'); await h.writeFile(data); }, sync: () => h.sync(), close: () => h.close() }; } }
        : { sync: async (h: any) => { syncs++; if (syncs === 2) throw new Error('result fsync failed'); await h.sync(); } };
      await expect(sendDelivery(f.db, f.journal, 'delivery-1', provider, io)).resolves.toMatchObject({ status: 'unknown' });
      expect(provider.calls).toBe(1);
      expect(f.db.prepare('SELECT status FROM delivery').get()?.status).toBe('unknown');
      f.db.close();f.db=openDeliveryDb(f.dbPath);
      expect(f.db.prepare('SELECT status FROM delivery').get()?.status).toBe('unknown');
      const records = await readAndRepairJournal(f.journal);
      expect(records.at(-1).status, fault).toBe('attempting');
      await reconcile(f.db, f.journal);
      expect(f.db.prepare('SELECT status FROM delivery').get()?.status).toBe('unknown');
      expect(() => guardOperation(f.db, 'send')).toThrow('recovery_mode');
      await expect(sendDelivery(f.db, f.journal, 'delivery-1', provider)).rejects.toThrow('recovery_mode');
      expect(provider.calls).toBe(1);
    } finally { f.db.close(); await rm(f.dir, { recursive: true, force: true }); }
  }
});

test('incomplete_journal_tail_is_quarantined_and_never_counts_as_success', async () => {
  const f = await fixture();
  try {
    await appendJournalRecord(f.journal, { id: 'd1', status: 'attempting' });
    await writeFile(f.journal, '{"id":"d1","status":"delivered","receipt":"bad', { flag: 'a' });
    const records = await readAndRepairJournal(f.journal);
    expect(records).toMatchObject([{ id: 'd1', status: 'attempting' }]);
    const marker=JSON.parse(await readFile(`${f.journal}.corrupt`,'utf8'));
    expect(await readFile(marker.quarantined, 'utf8')).toContain('delivered');
    await reconcile(f.db, f.journal);
    expect(f.db.prepare('SELECT status FROM delivery WHERE id=?').get('d1')?.status).toBe('unknown');
  } finally { f.db.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('backup_restore_freezes_all_external_operations_until_reconcile_and_explicit_user_exit', async () => {
  const f = await fixture();
  try {
    const backupPath = join(f.dir, 'backup.sqlite');
    f.db.prepare("INSERT INTO meta VALUES ('recovery_mode','false')").run();
    f.db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
    restoreBackup(f.db, backupPath);
    for (const kind of ['model', 'send', 'notification']) expect(() => guardOperation(f.db, kind)).toThrow('recovery_mode');
    await appendJournalRecord(f.journal, { id: 'd1', status: 'delivered', receipt: 'r1' });
    await reconcile(f.db, f.journal);
    expect(() => guardOperation(f.db, 'send')).toThrow('recovery_mode');
    exitRecoveryMode(f.db, { userConfirmed: true });
    expect(() => guardOperation(f.db, 'send')).not.toThrow();
  } finally { f.db.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('recovery_mode_cannot_be_exited_with_unknown_delivery_or_without_user_confirmation', async () => {
  const f = await fixture();
  try {
    f.db.prepare("INSERT INTO meta VALUES ('recovery_mode','true')").run();
    f.db.prepare("INSERT INTO delivery VALUES ('d1','unknown')").run();
    expect(() => exitRecoveryMode(f.db, { userConfirmed: true })).toThrow('unresolved_delivery');
    f.db.prepare('DELETE FROM delivery').run();
    expect(() => exitRecoveryMode(f.db, { userConfirmed: false })).toThrow('explicit_user_confirmation_required');
  } finally { f.db.close(); await rm(f.dir, { recursive: true, force: true }); }
});
