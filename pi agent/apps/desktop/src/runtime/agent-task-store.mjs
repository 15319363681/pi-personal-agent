import { randomUUID } from 'node:crypto';

const controllable = new Set(['running', 'paused', 'interrupted', 'failed']);
function taskError(code, message) { return Object.assign(new Error(message), { code }); }

export class AgentTaskStore {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS agent_tasks_status_idx ON agent_tasks(status);`);
  }

  #decode(row) {
    if (!row) return null;
    return { ...JSON.parse(row.payload), id: row.id, status: row.status, attemptId: row.attempt_id, updatedAt: row.updated_at };
  }

  get(id) {
    if (typeof id !== 'string') return null;
    return this.#decode(this.db.prepare('SELECT * FROM agent_tasks WHERE id=?').get(id));
  }

  list() {
    return this.db.prepare('SELECT * FROM agent_tasks ORDER BY updated_at DESC, id DESC LIMIT 100').all().map((row) => this.#decode(row));
  }

  recover() {
    this.db.prepare("UPDATE agent_tasks SET status='interrupted', updated_at=? WHERE status='running'").run(Date.now());
  }

  #assertAvailable() {
    if (this.db.prepare("SELECT 1 FROM agent_tasks WHERE status='running' LIMIT 1").get()) {
      throw taskError('agent_task_busy', '已有 Agent 任务正在运行。');
    }
  }

  start(goal, binding) {
    return this.store.transaction(() => {
      this.#assertAvailable();
      const id = randomUUID();
      const now = Date.now();
      const payload = { goal, binding, steps: [], results: [], createdAt: now, reasonCode: null };
      this.db.prepare("INSERT INTO agent_tasks VALUES (?, 'running', ?, ?, ?)").run(id, randomUUID(), JSON.stringify(payload), now);
      return this.get(id);
    });
  }

  resume(id) {
    return this.store.transaction(() => {
      const task = this.get(id);
      if (!task || !['paused', 'interrupted', 'failed'].includes(task.status)) {
        throw taskError('agent_task_transition_invalid', '当前任务无法继续。');
      }
      this.#assertAvailable();
      this.#write(task, { status: 'running', attemptId: randomUUID(), reasonCode: null });
      return this.get(id);
    });
  }

  control(id, status) {
    return this.store.transaction(() => {
      const task = this.get(id);
      if (!task || !controllable.has(task.status) || !['paused', 'cancelled'].includes(status) || (status === 'paused' && task.status !== 'running')) {
        throw taskError('agent_task_transition_invalid', '当前任务状态不支持此操作。');
      }
      this.#write(task, { status, reasonCode: status === 'paused' ? 'user_pause' : 'user_cancel' });
      return this.get(id);
    });
  }

  commit(id, attemptId, patch) {
    return this.store.transaction(() => {
      const task = this.get(id);
      if (task?.status !== 'running' || task.attemptId !== attemptId) return false;
      this.#write(task, patch);
      return true;
    });
  }

  #write(task, patch) {
    const { id, status, attemptId, updatedAt: _updatedAt, ...payload } = { ...task, ...patch };
    this.db.prepare('UPDATE agent_tasks SET status=?, attempt_id=?, payload=?, updated_at=? WHERE id=?')
      .run(status, attemptId, JSON.stringify(payload), Date.now(), id);
  }
}
