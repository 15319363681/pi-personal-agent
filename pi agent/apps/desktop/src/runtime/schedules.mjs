import { randomUUID } from 'node:crypto';
const fail = (code, message) => Object.assign(new Error(message), { code });
const decode = row => row ? { ...JSON.parse(row.payload), id: row.id, revision: row.revision, enabled: Boolean(row.enabled), dueAt: row.due_at, completed: Boolean(row.completed) } : null;
const decodeEvent = row => row ? { ...JSON.parse(row.payload), id: row.id, scheduleId: row.schedule_id, dueAt: row.due_at, status: row.status } : null;
export class Schedules {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,enabled INTEGER NOT NULL,due_at INTEGER NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS schedule_events(id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL,due_at INTEGER NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(schedule_id,due_at));`);
    this.db.prepare("UPDATE schedule_events SET status='interrupted' WHERE status='executing'").run();
  }
  list() { return this.db.prepare('SELECT schedules.*, EXISTS(SELECT 1 FROM schedule_events WHERE schedule_id=schedules.id) AS completed FROM schedules ORDER BY due_at,id').all().map(row => ({ ...decode(row), completed: !JSON.parse(row.payload).intervalMs && Boolean(row.completed) })); }
  get(id) { return decode(this.db.prepare("SELECT schedules.*, EXISTS(SELECT 1 FROM schedule_events WHERE schedule_id=schedules.id AND due_at=schedules.due_at) AND json_extract(payload, '$.intervalMs')=0 AS completed FROM schedules WHERE id=?").get(id)); }
  events() { return this.db.prepare('SELECT * FROM schedule_events ORDER BY due_at DESC,id DESC LIMIT 100').all().map(decodeEvent); }
  create(input, binding, now = Date.now()) {
    if (input.confirm !== true) throw fail('schedule_confirmation_required', '请确认计划内容、时间和外发范围。');
    if (!['reminder', 'agent-task'].includes(input.kind) || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2000 || !Number.isSafeInteger(input.dueAt) || input.dueAt < now || input.dueAt > now + 366 * 86400000 || (input.intervalMs !== undefined && (!Number.isSafeInteger(input.intervalMs) || (input.intervalMs !== 0 && (input.intervalMs < 60000 || input.intervalMs > 366 * 86400000))))) throw fail('schedule_invalid', '计划内容或时间无效。首次时间需在未来一年内，重复间隔至少一分钟。');
    if (this.list().length >= 100) throw fail('schedule_limit', '最多保存 100 项计划。');
    const id = randomUUID();
    const payload = { text: input.text.trim(), kind: input.kind, intervalMs: input.intervalMs || 0, binding, createdAt: now };
    this.db.prepare('INSERT INTO schedules VALUES (?,1,1,?,?)').run(id, input.dueAt, JSON.stringify(payload));
    return this.get(id);
  }
  #version(id, revision) {
    const value = this.get(id);
    if (!value || value.revision !== revision) throw fail('schedule_revision_changed', '计划已变更，请刷新后确认。');
    return value;
  }
  setEnabled(id, revision, enabled) {
    if (typeof enabled !== 'boolean') throw fail('schedule_invalid', '计划启用状态无效。');
    const schedule = this.#version(id, revision);
    if (enabled && schedule.completed) throw fail('schedule_completed', '单次计划已触发，请创建新计划。');
    this.db.prepare('UPDATE schedules SET enabled=?,revision=revision+1 WHERE id=?').run(Number(enabled), id);
    return this.get(id);
  }
  delete(id, revision, confirm) {
    if (confirm !== true) throw fail('schedule_confirmation_required', '请确认删除计划。');
    this.#version(id, revision);
    this.db.prepare('DELETE FROM schedules WHERE id=?').run(id);
    this.db.prepare("UPDATE schedule_events SET status='cancelled' WHERE schedule_id=? AND status='pending'").run(id);
  }
  claimDue(now = Date.now()) {
    return this.store.transaction(() => {
      const due = this.db.prepare('SELECT * FROM schedules WHERE enabled=1 AND due_at<=? ORDER BY due_at LIMIT 20').all(now).map(decode);
      for (const schedule of due) {
        const missed = schedule.intervalMs ? Math.floor((now - schedule.dueAt) / schedule.intervalMs) : 0;
        const payload = { text: schedule.text, kind: schedule.kind, binding: schedule.binding, revision: schedule.revision, missed, unread: true };
        this.db.prepare("INSERT OR IGNORE INTO schedule_events VALUES (?,?,?,'pending',?)").run(randomUUID(), schedule.id, schedule.dueAt, JSON.stringify(payload));
        const next = schedule.intervalMs ? schedule.dueAt + (missed + 1) * schedule.intervalMs : schedule.dueAt;
        this.db.prepare('UPDATE schedules SET due_at=?,enabled=? WHERE id=?').run(next, Number(Boolean(schedule.intervalMs)), schedule.id);
      }
      return this.db.prepare("SELECT * FROM schedule_events WHERE status='pending' ORDER BY due_at,id LIMIT 20").all().map(decodeEvent);
    });
  }
  begin(id) {
    return this.store.transaction(() => {
      const event = decodeEvent(this.db.prepare('SELECT * FROM schedule_events WHERE id=?').get(id));
      if (!event || event.status !== 'pending') return null;
      const schedule = this.get(event.scheduleId);
      if (!schedule || schedule.revision !== event.revision) { this.finish(event.id, 'cancelled'); return null; }
      this.db.prepare("UPDATE schedule_events SET status='executing' WHERE id=?").run(id);
      return { ...event, status: 'executing' };
    });
  }
  finish(id, status, patch = {}) {
    const row = this.db.prepare('SELECT status,payload FROM schedule_events WHERE id=?').get(id);
    if (!row || (row.status !== 'executing' && !(row.status === 'pending' && status === 'cancelled'))) return;
    if (!['fired', 'started', 'failed', 'cancelled'].includes(status)) return;
    this.db.prepare('UPDATE schedule_events SET status=?,payload=? WHERE id=? AND status=?').run(status, JSON.stringify({ ...JSON.parse(row.payload), ...patch }), id, row.status);
  }
  read(id) {
    const event = decodeEvent(this.db.prepare('SELECT * FROM schedule_events WHERE id=?').get(id));
    if (event) this.db.prepare('UPDATE schedule_events SET payload=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(this.db.prepare('SELECT payload FROM schedule_events WHERE id=?').get(id).payload), unread: false }), id);
  }
}
