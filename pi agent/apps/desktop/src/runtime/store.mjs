import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { makeProposal, transitions, hashContract } from './contracts.mjs';
import { assertTransition } from './state-machine.mjs';
import { recoverInterruptedTasks } from './recovery.mjs';
import { randomUUID } from 'node:crypto';

const json = (value) => JSON.stringify(value ?? {});
const parse = (value, fallback = {}) => { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } };

export class RuntimeStore {
  constructor(db, path) { this.db = db; this.path = path; }
  static async open(path) {
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    db.exec(`CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,status TEXT NOT NULL,goal TEXT NOT NULL,contract_json TEXT NOT NULL,contract_hash TEXT NOT NULL,task_version INTEGER NOT NULL,budget_json TEXT NOT NULL,budget_reserved_cents INTEGER NOT NULL DEFAULT 0,budget_used_cents INTEGER NOT NULL DEFAULT 0,permission_json TEXT NOT NULL DEFAULT '{}',checkpoint_json TEXT NOT NULL DEFAULT '{}',artifact_json TEXT NOT NULL DEFAULT '{}',reason_code TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,task_id TEXT,kind TEXT NOT NULL,target TEXT,payload_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,receipt TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(id TEXT PRIMARY KEY,provider TEXT,model TEXT,config_json TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    const store = new RuntimeStore(db, path);
    if (store.getMeta('recovery_mode') !== 'true') recoverInterruptedTasks(store);
    return store;
  }
  close() {
    // WAL keeps sidecar handles alive on Windows until the log is checkpointed.
    // Checkpoint before closing so callers can safely remove temporary stores.
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch {}
    this.db.close();
  }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; } }
  recoverInterruptedTasks() { this.db.prepare("UPDATE tasks SET status='interrupted', reason_code='runtime_restart', updated_at=? WHERE status IN ('running','waiting','retry_wait')").run(Date.now()); }
  createTaskProposal(input) { const p = makeProposal(input); this.db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(p.id,p.status,p.contract.goal,json(p.contract),p.contractHash,p.taskVersion,json(p.contract.budget),0,0,'{}','{}','{}',null,p.createdAt,p.updatedAt); return this.getTask(p.id); }
  getTask(id) { const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id); return row ? this.#task(row) : null; }
  listTasks() { return this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all().map((r) => this.#task(r)); }
  #task(row) { return { id:row.id,status:row.status,goal:row.goal,contract:parse(row.contract_json),contractHash:row.contract_hash,taskVersion:row.task_version,budget:parse(row.budget_json),budgetReservedCents:row.budget_reserved_cents,budgetUsedCents:row.budget_used_cents,permissionSnapshot:parse(row.permission_json),checkpoint:parse(row.checkpoint_json),artifact:parse(row.artifact_json),reasonCode:row.reason_code,createdAt:row.created_at,updatedAt:row.updated_at }; }
  approveTask(id, approval) { return this.transaction(() => { const task=this.getTask(id); if (!task || task.status !== 'approval_pending') throw Error('approval_required'); const permission={ mode:approval.permissionMode ?? 'read-only', recipient:approval.recipient, providerInstance:approval.providerInstance }; const reserve=Number(task.budget.costCents ?? 0); this.db.prepare("UPDATE tasks SET status='queued',permission_json=?,budget_reserved_cents=?,updated_at=? WHERE id=?").run(json(permission),reserve,Date.now(),id); this.db.prepare('INSERT INTO outbox VALUES (?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),id,'task.approved',approval.recipient ?? null,json({taskId:id}), 'pending',0,null,Date.now(),Date.now()); return this.getTask(id); }); }
  transitionTask(id, next, reasonCode = null) { return this.transaction(() => { const task=this.getTask(id); if (!task) throw Error(`invalid_transition:missing->${next}`); assertTransition(task.status, next); this.db.prepare('UPDATE tasks SET status=?,reason_code=?,updated_at=? WHERE id=?').run(next,reasonCode,Date.now(),id); return this.getTask(id); }); }
  completeTask(id, artifact) { return this.transaction(() => { const t=this.getTask(id); if (!t || !transitions[t.status]?.has('completed')) throw Error('invalid_completion'); this.db.prepare("UPDATE tasks SET status='completed',artifact_json=?,checkpoint_json=?,updated_at=? WHERE id=?").run(json(artifact),json({step:'acceptance',at:Date.now()}),Date.now(),id); this.db.prepare('INSERT INTO outbox VALUES (?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),id,'task.completed',t.permissionSnapshot.recipient ?? null,json({taskId:id,artifact}), 'pending',0,null,Date.now(),Date.now()); return this.getTask(id); }); }
  listOutbox() { return this.db.prepare('SELECT * FROM outbox ORDER BY created_at').all().map((r)=>({id:r.id,taskId:r.task_id,kind:r.kind,target:r.target,payload:parse(r.payload_json),status:r.status,attempts:r.attempts,receipt:r.receipt,createdAt:r.created_at,updatedAt:r.updated_at})); }
  getOutbox(id) { return this.listOutbox().find((x)=>x.id===id) ?? null; }
  enqueueOutbox(event) { const id=event.id ?? randomUUID(); const now=Date.now(); this.db.prepare('INSERT INTO outbox VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,event.taskId ?? null,event.kind,event.target ?? null,json(event.payload ?? event), 'pending',0,null,now,now); return this.getOutbox(id); }
  updateOutbox(id, status, receipt = null, options = {}) { const increment = options.increment ?? true; this.db.prepare(`UPDATE outbox SET status=?,attempts=attempts+${increment ? 1 : 0},receipt=?,updated_at=? WHERE id=?`).run(status,receipt,Date.now(),id); return this.getOutbox(id); }
  setMeta(key,value) { this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key,String(value)); }
  getMeta(key) { return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value; }
}
