import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { RuntimeStore } from './runtime/store.mjs';
import { TaskRunner } from './runtime/task-runner.mjs';
import { Outbox } from './runtime/outbox.mjs';
import { MemoryStore } from './runtime/memory.mjs';
import { ModelSettings } from './runtime/model-settings.mjs';
import { Telemetry } from './runtime/telemetry.mjs';
import { LocalFileProvider } from './runtime/providers/local-file.mjs';
import { encode } from './rpc.mjs';

async function loadJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export class RuntimeController {
  constructor({ store, dataDir, workspaceRoot }) {
    this.store = store;
    this.dataDir = dataDir;
    this.workspaceRoot = workspaceRoot;
    this.runner = new TaskRunner(store);
    this.outbox = new Outbox(store);
    this.memory = new MemoryStore(join(dataDir, 'memory.json'));
    this.modelSettings = new ModelSettings(join(dataDir, 'model-settings.json'));
    this.telemetry = new Telemetry({ maxBytes: 5 * 1024 * 1024 });
    this.localProvider = new LocalFileProvider();
    this.jobs = new Map();
    this.closed = false;
    this.conversationPath = join(dataDir, 'conversation.json');
  }

  async init() {
    if (this.store.getMeta('recovery_mode') === 'true') return this;
    const tasks = this.store.listTasks().filter((task) => task.status === 'interrupted');
    for (const task of tasks) {
      if (task.permissionSnapshot?.mode) this.scheduleTask(task.id);
    }
    return this;
  }

  scheduleTask(taskId) {
    if (this.jobs.has(taskId)) return this.jobs.get(taskId);
    const job = this.executeTask(taskId).finally(() => this.jobs.delete(taskId));
    this.jobs.set(taskId, job);
    return job;
  }

  async executeTask(taskId) {
    if (this.store.getMeta('recovery_mode') === 'true') throw Error('recovery_mode');
    const started = Date.now();
    await this.telemetry.emit({ event: 'task.started', taskId });
    try {
      const result = await this.runner.run(taskId);
      await this.dispatchTaskEvents(taskId);
      await this.telemetry.emit({ event: 'task.completed', taskId, durationMs: Date.now() - started });
      return result;
    } catch (error) {
      const task = this.store.getTask(taskId);
      if (task && !['failed', 'cancelled', 'completed'].includes(task.status)) {
        try { this.store.transitionTask(taskId, 'needs_attention', error.message); } catch {}
        this.store.enqueueOutbox({
          taskId,
          kind: 'task.attention',
          target: task.permissionSnapshot?.recipient ?? null,
          payload: { taskId, reason: error.message }
        });
      }
      await this.dispatchTaskEvents(taskId);
      await this.telemetry.emit({ event: 'task.attention', taskId, error: error.message });
      throw error;
    }
  }

  async dispatchTaskEvents(taskId) {
    if (this.store.getMeta('recovery_mode') === 'true') return;
    const task = this.store.getTask(taskId);
    const provider = task?.permissionSnapshot?.providerInstance === 'local-file' ? this.localProvider : null;
    if (!provider) return;
    const events = this.store.listOutbox().filter((event) => event.taskId === taskId && event.target && event.status === 'pending' && ['task.completed', 'task.attention', 'task.failed'].includes(event.kind));
    for (const event of events) {
      await this.outbox.dispatch(event.id, provider);
    }
  }

  async messages() { return loadJson(this.conversationPath, []); }

  async appendMessage(role, content, extra = {}) {
    const messages = await this.messages();
    messages.push({ id: randomUUID(), role, content, createdAt: Date.now(), ...extra });
    await writeFile(this.conversationPath, JSON.stringify(messages, null, 2));
    return messages.at(-1);
  }

  async handle(method, params = {}) {
    if (this.closed) return { ok: false, error: { code: 'runtime_closed', message: 'Runtime is closed' } };
    try {
      if (this.store.getMeta('recovery_mode') === 'true' && ['chat.send', 'task.approve', 'task.run', 'task.resume'].includes(method)) throw Object.assign(Error('Recovery mode freezes task execution and external side effects'), { code: 'recovery_mode' });
      if (method === 'recovery.exit') { this.store.setMeta('recovery_mode', 'false'); return { ok: true, result: { recoveryMode: false } }; }
      if (method === 'chat.send') {
        const user = await this.appendMessage('user', params.text ?? '');
        if (params.task) {
          const task = this.store.createTaskProposal({
            ...params.task,
            inputs: { ...(params.task.inputs ?? {}), root: params.task.inputs?.root ?? this.workspaceRoot }
          });
          const assistant = await this.appendMessage('assistant', `已创建待审批任务：${task.goal}`, { taskId: task.id });
          return { ok: true, result: { kind: 'task_proposal', task, user, assistant } };
        }
        const assistant = await this.appendMessage('assistant', `已收到：${params.text ?? ''}`);
        return { ok: true, result: { kind: 'assistant', user, assistant } };
      }
      if (method === 'task.list') return { ok: true, result: { tasks: this.store.listTasks(), outbox: this.store.listOutbox(), recoveryMode: this.store.getMeta('recovery_mode') === 'true' } };
      if (method === 'task.approve') {
        const task = this.store.approveTask(params.taskId, params.approval ?? {});
        this.scheduleTask(task.id);
        return { ok: true, result: { task } };
      }
      if (method === 'task.run') { const task = this.store.getTask(params.taskId); if (!task) throw Error('task_not_found'); this.scheduleTask(task.id); return { ok: true, result: { task: this.store.getTask(task.id) } }; }
      if (method === 'task.pause') return { ok: true, result: { task: this.store.transitionTask(params.taskId, 'paused', 'user_pause') } };
      if (method === 'task.resume') { const task = this.store.transitionTask(params.taskId, 'queued', 'user_resume'); this.scheduleTask(task.id); return { ok: true, result: { task } }; }
      if (method === 'task.cancel') return { ok: true, result: { task: this.store.transitionTask(params.taskId, 'cancelled', 'user_cancel') } };
      if (method === 'settings.get') return { ok: true, result: { settings: await this.modelSettings.list() } };
      if (method === 'settings.update') return { ok: true, result: { setting: await this.modelSettings.upsert(params.setting ?? params) } };
      if (method === 'memory.search') return { ok: true, result: { memories: await this.memory.search(params.query ?? '') } };
      if (method === 'memory.put') return { ok: true, result: { memory: await this.memory.put(params.memory ?? params) } };
      if (method === 'conversation.list') return { ok: true, result: { messages: await this.messages() } };
      if (method === 'system.status') return { ok: true, result: { jobs: this.jobs.size, recoveryMode: this.store.getMeta('recovery_mode') === 'true' } };
      throw Object.assign(Error(`unknown_method:${method}`), { code: 'unknown_method' });
    } catch (error) {
      return { ok: false, error: { code: error.code ?? 'runtime_error', message: error.message } };
    }
  }

  async waitForIdle() {
    while (this.jobs.size) await Promise.allSettled([...this.jobs.values()]);
  }

  async close() {
    this.closed = true;
    await this.waitForIdle();
    this.store.close();
  }
}

export async function createRuntime({ dataDir, workspaceRoot = join(dataDir, 'workspace'), dbPath = join(dataDir, 'agent.sqlite') }) {
  await mkdir(dataDir, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  const store = await RuntimeStore.open(dbPath);
  return new RuntimeController({ store, dataDir, workspaceRoot }).init();
}

export async function runStdio() {
  const dataDir = resolve(process.env.PI_AGENT_DATA_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '.data'));
  const workspaceRoot = resolve(process.env.PI_AGENT_WORKSPACE ?? join(dataDir, 'workspace'));
  const runtime = await createRuntime({ dataDir, workspaceRoot });
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  process.on('SIGTERM', async () => { await runtime.close(); process.exit(0); });
  for await (const line of input) {
    if (!line.trim()) continue;
    let request;
    try { request = JSON.parse(line); } catch { process.stdout.write(`${encode({ id: null, ok: false, error: { code: 'invalid_json', message: 'Invalid JSON' } })}\n`); continue; }
    const response = await runtime.handle(request.method, request.params);
    process.stdout.write(`${encode({ id: request.id, ...response })}\n`);
  }
  await runtime.close();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runStdio();
