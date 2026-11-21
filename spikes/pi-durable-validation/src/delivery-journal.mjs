import { open, readFile, rename, truncate, unlink, readdir } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';

const checksum = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const setMeta = (db, key, value) => db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, value);
const freeze = db => { setMeta(db, 'recovery_mode', 'true'); setMeta(db, 'reconciled', 'false'); };
const fencePath = (path,id) => `${path}.pending.${checksum(id)}`;
async function durableFile(path,value) {
  const h=await open(path,'wx');
  try {await h.writeFile(JSON.stringify(value));await h.sync();}finally{await h.close();}
}
async function exists(path) {try{await readFile(path);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function fences(path) {
 const prefix=basename(path)+'.pending.';const records=[];
 for(const name of await readdir(dirname(path)))if(name.startsWith(prefix)){
  const data=JSON.parse(await readFile(join(dirname(path),name),'utf8'));
  if(typeof data.id!=='string'||name!==basename(fencePath(path,data.id)))throw Error('pending_fence_corrupt');records.push(data);
 }
 return records;
}

export async function appendJournalRecord(path, record, io = {}) {
  const openFile = io.open ?? open;
  const handle = await openFile(path, 'a');
  const start = await handle.stat();
  try {
    const payload = { version: 1, time: Date.now(), contractHash: 'fixture-contract', providerInstance: 'fake', targetHash: 'fake-target', contentHash: 'fake-content', ...record };
    await handle.writeFile(`${JSON.stringify({ payload, checksum: checksum(payload) })}\n`, 'utf8');
    await (io.sync ?? ((h) => h.sync()))(handle);
  } catch (error) {
    try {
      await handle.close();
      await (io.truncate ?? truncate)(path, start.size);
      const rollback = await open(path, 'r+');
      try { await rollback.sync(); } finally { await rollback.close(); }
    } catch {}
    throw error;
  } finally { await handle.close(); }
}

export function openDeliveryDb(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS delivery(id TEXT PRIMARY KEY, status TEXT NOT NULL); CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  return db;
}

export async function sendDelivery(db, journalPath, id, provider, io) {
  if (typeof id !== 'string' || !id.trim()) throw new Error('delivery_id_required');
  if (db.isTransaction) throw new Error('delivery_intent_must_be_committed');
  guardOperation(db, 'send');
  if(await exists(`${journalPath}.corrupt`)) {freeze(db);throw Error('journal_corrupt');}
  const existing = db.prepare('SELECT status FROM delivery WHERE id=?').get(id)?.status;
  if (existing !== 'intent') throw new Error('delivery_intent_required');
  const claimed = db.prepare("UPDATE delivery SET status='attempting' WHERE id=? AND status='intent'").run(id);
  if (claimed.changes !== 1) throw new Error('delivery_intent_required');
  await appendJournalRecord(journalPath, { id, status: 'attempting' }, io);
  // This conservative uncertainty fence is outside database backups. It is
  // persisted before any provider call, and survives result-write/rollback faults.
  // Process-crash probe only: no NTFS power-loss/directory durability claim.
  await durableFile(fencePath(journalPath,id),{id,createdAt:Date.now()});
  let receipt;
  try { receipt = await provider.send({ id }); }
  catch {
    db.prepare("UPDATE delivery SET status='unknown' WHERE id=?").run(id);
    freeze(db);
    try { await appendJournalRecord(journalPath, { id, status: 'unknown' }, io); } catch { setMeta(db, `journal_fault:${id}`, 'true'); }
    return { status: 'unknown', providerCalls: provider.calls };
  }
  try {
    await appendJournalRecord(journalPath, { id, status: 'delivered', receipt }, io);
  } catch {
    db.prepare("UPDATE delivery SET status='unknown' WHERE id=?").run(id);
    setMeta(db, `journal_fault:${id}`, 'true'); freeze(db);
    return { status: 'unknown', providerCalls: provider.calls };
  }
  db.prepare("UPDATE delivery SET status='delivered' WHERE id=?").run(id);
  try {await unlink(fencePath(journalPath,id));}
  catch {db.prepare("UPDATE delivery SET status='unknown' WHERE id=?").run(id);freeze(db);return {status:'unknown',providerCalls:provider.calls};}
  return { status: 'delivered', receipt, providerCalls: provider.calls };
}

export async function readAndRepairJournal(path) {
  let contents;
  try { contents = await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  let valid = ''; const records = [];
  for (const line of contents.split('\n').slice(0, -1)) {
    try {
      const {payload, checksum: sum} = JSON.parse(line);
      if (!payload || payload.version !== 1 || typeof payload.id !== 'string' || !['attempting','delivered','unknown','failed'].includes(payload.status) || checksum(payload) !== sum || (payload.status === 'delivered' && !payload.receipt)) break;
      records.push(payload); valid += line + '\n';
    } catch { break; }
  }
  const tail = contents.slice(valid.length);
  if (tail) {
    const quarantined=`${path}.tail.${randomUUID()}`;
    if(!await exists(`${path}.corrupt`))await durableFile(`${path}.corrupt`,{quarantined,detectedAt:Date.now()});
    await rename(path, quarantined);
    await (await open(path, 'w')).close();
    const handle = await open(path, 'a');
    try { await handle.writeFile(valid); await handle.sync(); } finally { await handle.close(); }
  }
  return records;
}

export function restoreBackup(db, backupPath) {
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  try { if (backup.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw Error('backup_corrupt'); } finally { backup.close(); }
  // Offline adapter only: no Harness/cache may remain open across this operation.
  // All table contents and the freeze flag change in ONE transaction.
  db.prepare('ATTACH DATABASE ? AS restored').run(backupPath);
  try {
    const tables = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const saved = db.prepare("SELECT name,sql FROM restored.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    if (JSON.stringify(tables) !== JSON.stringify(saved)) throw Error('restore_schema_mismatch');
    const quote = name => '"' + name.replaceAll('"','""') + '"';
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const {name} of tables) { db.exec(`DELETE FROM main.${quote(name)}; INSERT INTO main.${quote(name)} SELECT * FROM restored.${quote(name)}`); }
      freeze(db); db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.exec('DETACH DATABASE restored'); }
}

export function guardOperation(db, kind) {
  if (db.prepare("SELECT value FROM meta WHERE key='recovery_mode'").get()?.value === 'true' && ['model', 'send', 'notification'].includes(kind)) throw new Error('recovery_mode');
}

export async function reconcile(db, journalPath) {
  const records = await readAndRepairJournal(journalPath);
  const pending=await fences(journalPath);
  const corrupted=await exists(`${journalPath}.corrupt`);
  const latest = new Map();
  for (const record of records) latest.set(record.id, record);
  db.exec('BEGIN IMMEDIATE');
  try {
    // Intent without journal evidence cannot prove that no send occurred after the snapshot.
    db.prepare("UPDATE delivery SET status='unknown' WHERE status IN ('attempting','intent')").run();
    for (const [id, record] of latest) {
      const fault = db.prepare('SELECT value FROM meta WHERE key=?').get(`journal_fault:${id}`);
      db.prepare('INSERT OR REPLACE INTO delivery VALUES (?,?)').run(id, !fault && !pending.some(x=>x.id===id) && ['delivered','failed'].includes(record.status) ? record.status : 'unknown');
    }
    for(const {id} of pending)db.prepare("INSERT OR REPLACE INTO delivery VALUES (?,'unknown')").run(id);
    if(corrupted){freeze(db);setMeta(db,'journal_corrupt','true');}
    if(db.prepare("SELECT 1 FROM delivery WHERE status='unknown'").get())freeze(db);
    setMeta(db, 'reconciled', 'true'); db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return [...latest.values()];
}

export function exitRecoveryMode(db, { userConfirmed }) {
  if (!userConfirmed) throw new Error('explicit_user_confirmation_required');
  if(db.prepare("SELECT value FROM meta WHERE key='journal_corrupt'").get()?.value==='true')throw Error('journal_corrupt');
  if (db.prepare("SELECT value FROM meta WHERE key='reconciled'").get()?.value === 'false') throw Error('reconciliation_required');
  if (db.prepare("SELECT 1 FROM delivery WHERE status IN ('unknown','attempting','intent') LIMIT 1").get()) throw new Error('unresolved_delivery');
  db.prepare("INSERT OR REPLACE INTO meta VALUES ('recovery_mode','false')").run();
}

/** @param {{userConfirmed: boolean, decision: string, note: string, receipt?: string}} options */
export async function resolveDelivery(db,path,id,{userConfirmed,decision,note,receipt = undefined}) {
 if(!userConfirmed)throw Error('explicit_user_confirmation_required');
 if(!['delivered','failed'].includes(decision)||!note?.trim()||(decision==='delivered'&&!receipt))throw Error('resolution_evidence_required');
 if(db.prepare('SELECT status FROM delivery WHERE id=?').get(id)?.status!=='unknown')throw Error('not_unknown');
 await appendJournalRecord(path,{id,status:decision,receipt,manual:{actor:'user',note,time:Date.now()}});
 // A crash before removing the fence leaves this unknown and requires review again.
 try{await unlink(fencePath(path,id));}catch(e){if(e.code!=='ENOENT')throw e;}
 db.exec('BEGIN IMMEDIATE');
 try{
  db.prepare('UPDATE delivery SET status=? WHERE id=?').run(decision,id);
  db.prepare('DELETE FROM meta WHERE key=?').run(`journal_fault:${id}`);
  setMeta(db,`delivery_review:${id}`,JSON.stringify({decision,note,receipt,time:Date.now()}));db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
}

export async function acknowledgeJournalCorruption(db,path,{userConfirmed,note}) {
 if(!userConfirmed)throw Error('explicit_user_confirmation_required');
 if(!note?.trim())throw Error('review_note_required');
 if(db.prepare("SELECT 1 FROM delivery WHERE status IN ('unknown','intent','attempting')").get())throw Error('unresolved_delivery');
 // Keep original quarantine bytes; archive the corruption marker rather than deleting evidence.
 if(await exists(`${path}.corrupt`))await rename(`${path}.corrupt`,`${path}.reviewed.${randomUUID()}`);
 db.exec('BEGIN IMMEDIATE');
 try{setMeta(db,'journal_corruption_review',JSON.stringify({note,time:Date.now(),actor:'user'}));setMeta(db,'journal_corrupt','false');db.exec('COMMIT');}
 catch(e){db.exec('ROLLBACK');throw e;}
}
