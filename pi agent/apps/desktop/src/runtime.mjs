import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { RuntimeStore } from './runtime/store.mjs';
import { TaskRunner } from './runtime/task-runner.mjs';
import { Outbox } from './runtime/outbox.mjs';
import { ReviewedMemory, memoryPrompt } from './runtime/reviewed-memory.mjs';
import { ModelSettings } from './runtime/model-settings.mjs';
import { Telemetry } from './runtime/telemetry.mjs';
import { LocalFileProvider } from './runtime/providers/local-file.mjs';
import { LocalRuntimeLogger } from './runtime/logging.mjs';
import { ModelClient } from './runtime/model-client.mjs';
import { PermissionGateway } from './runtime/permission-gateway.mjs';
import { assertWorkspaceIdentity, withWorkspaceIdentity, workspaceIdentity } from './runtime/workspace.mjs';
import { runPiAgentTurn } from './runtime/pi-agent.mjs';
import { buildSkillsSystemPrompt, listProductSkills, normalizeEnabledSkillIds, setSkillEnabled } from './runtime/skills.mjs';
import { RuntimeMcp } from './runtime/mcp.mjs';
import { RuntimePlugins } from './runtime/plugins.mjs';
import { WorkspaceArtifacts } from './runtime/workspace-artifacts.mjs';
import { PluginWorker } from './runtime/plugin-worker.mjs';
import { encode } from './rpc.mjs';
import { AgentTasks } from './runtime/agent-tasks.mjs';
import { WecomInbox } from './runtime/wecom-inbox.mjs';
import { Schedules } from './runtime/schedules.mjs';
import { searchPublicWeb, normalizeResearchQuery, synthesizeResearch } from './runtime/web-research.mjs';

async function normalizeWorkspaceRoot(root) {
  if (typeof root !== 'string' || !root.trim()) throw Object.assign(new Error('Workspace directory is required'), { code: 'workspace_root_required' });
  try {
    const canonical = await realpath(root);
    const info = await stat(canonical);
    if (!info.isDirectory()) throw Object.assign(new Error('Workspace root must be a directory'), { code: 'workspace_root_not_directory' });
    return canonical;
  } catch (error) {
    if (error.code?.startsWith('workspace_')) throw error;
    throw Object.assign(new Error('Workspace directory is unavailable'), { code: 'workspace_root_unavailable' });
  }
}

async function loadJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

const CONVERSATION_STATE_KEY = 'conversation_state_v1';
const SETTINGS_REVISION_KEY = 'model_settings_revision';
const ACTIVE_MODEL_KEY = 'active_model_setting_id';
const ENABLED_SKILLS_KEY = 'product_skills_enabled_v1';

function contextId(setting, enabledSkillIds = [], mcpTools = [], pluginTools = [], workspace = null, memoryVersion = '0') {
  const identity = [setting.id, setting.provider, setting.baseUrl, setting.model, setting.apiFormat ?? 'chat-completions', setting.supportsImages === true, setting.revision ?? '', enabledSkillIds, mcpTools, pluginTools, workspace, memoryVersion];
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content.filter((part) => part.type === 'text').map((part) => part.text).join('').trim();
}

function migrateConversation(messages, legacyTranscript) {
  if (!Array.isArray(messages)) throw Error('conversation_invalid_legacy_history');
  const transcript = Array.isArray(legacyTranscript) ? legacyTranscript : legacyTranscript?.messages;
  if (!Array.isArray(transcript)) throw Error('conversation_invalid_legacy_transcript');
  const uiTurns = [];
  const taskMessages = new Set();
  messages.forEach((message, index) => {
    if (!message.taskId) return;
    taskMessages.add(message);
    if (messages[index - 1]?.role === 'user') taskMessages.add(messages[index - 1]);
  });
  const modelMessages = messages.filter((message) => !taskMessages.has(message) && message.modelConversation !== false);
  for (let index = 0; index + 1 < modelMessages.length; index += 2) {
    const user = modelMessages[index];
    const assistant = modelMessages[index + 1];
    if (user.role !== 'user' || assistant.role !== 'assistant') break;
    uiTurns.push({ user, assistant });
  }
  const turns = [];
  for (const message of transcript) {
    if (message.role === 'user') turns.push([message]);
    else if (turns.length) turns.at(-1).push(message);
  }
  const accepted = [];
  const matched = new Set();
  let uiIndex = 0;
  for (const turn of turns) {
    const assistant = [...turn].reverse().find((message) => message.role === 'assistant');
    if (!assistant || turn.at(-1) !== assistant || ['error', 'aborted', 'toolUse'].includes(assistant.stopReason) ||
        turn.some((message) => message.role === 'assistant' && message.errorMessage) || !messageText(assistant)) continue;
    const uiTurn = uiTurns[uiIndex];
    if (!uiTurn || typeof uiTurn.user.content !== 'string' || typeof uiTurn.assistant.content !== 'string' ||
        messageText(turn[0]) !== uiTurn.user.content.trim() || messageText(assistant) !== uiTurn.assistant.content.trim()) break;
    accepted.push(...turn);
    matched.add(uiTurn.user);
    matched.add(uiTurn.assistant);
    uiIndex += 1;
  }
  return {
    version: 1,
    messages: messages.map((message) => !taskMessages.has(message) && !matched.has(message) &&
      (message.modelConversation !== false || message.modelErrorCode === 'legacy_history_unverified')
      ? { ...message, modelConversation: false, modelErrorCode: 'legacy_history_unverified' }
      : message),
    transcript: accepted,
    historyVerificationVersion: 1
  };
}

function parseConversationState(value) {
  const state = JSON.parse(value);
  if (state?.version !== 1 || !Array.isArray(state.messages) || !Array.isArray(state.transcript)) {
    throw Error('conversation_invalid_state');
  }
  return state;
}

async function writeJsonMirror(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export class RuntimeController {
  constructor({ store, dataDir, workspaceRoot, workspaceControlToken, modelClient = new ModelClient(), fetchImpl = fetch, modelTimeoutMs = 90_000, agentTaskStepTimeoutMs = 120_000 }) {
    this.store = store;
    this.dataDir = dataDir;
    this.workspaceRoot = workspaceRoot;
    this.defaultWorkspaceRoot = workspaceRoot;
    this.workspaceControlToken = workspaceControlToken;
    this.workspaceAuthorizationVersion = 0;
    this.workspaceAuthorized = false;
    this.workspaceIdentity = null;
    this.runner = new TaskRunner(store);
    this.outbox = new Outbox(store);
    this.memory = new ReviewedMemory(store);
    this.wecom = new WecomInbox(store);
    this.schedules = new Schedules(store);
    this.modelSettings = new ModelSettings(join(dataDir, 'model-settings.json'));
    this.modelClient = modelClient;
    this.fetchImpl = fetchImpl;
    this.modelTimeoutMs = modelTimeoutMs;
    this.agentTaskStepTimeoutMs = agentTaskStepTimeoutMs;
    this.permissionGateway = new PermissionGateway();
    this.telemetry = new Telemetry({ maxBytes: 5 * 1024 * 1024 });
    this.logger = new LocalRuntimeLogger(dataDir);
    this.mcp = new RuntimeMcp({ store, logger: this.logger, permissionGateway: this.permissionGateway, fetchImpl });
    this.plugins = new RuntimePlugins({ store, dataDir, logger: this.logger, worker: new PluginWorker({ dataDir }) });
    this.artifacts = new WorkspaceArtifacts({ store, logger: this.logger, getWorkspace: async () => {
      await this.refreshWorkspaceAuthorization();
      return this.workspaceAuthorized ? this.workspaceIdentity : null;
    } });
    this.localProvider = new LocalFileProvider();
    this.jobs = new Map();
    this.closed = false;
    this.chatTail = Promise.resolve();
    this.conversationPath = join(dataDir, 'conversation.json');
    this.piTranscriptPath = join(dataDir, 'pi-transcript.json');
  }

  async init() {
    await this.initConversation();
    await this.memory.importLegacy(join(this.dataDir, 'memory.json'));
    this.agentTasks = new AgentTasks({
      store: this.store, fetchImpl: this.fetchImpl, timeoutMs: this.modelTimeoutMs, stepTimeoutMs: this.agentTaskStepTimeoutMs, getMemory: () => this.memory.snapshot(),
      getSetting: async (id) => {
        const setting = await this.modelSettings.get(id ?? (await this.modelConfiguration()).activeSettingId);
        if (!setting) throw Object.assign(Error('任务模型配置不可用。'), { code: 'model_configuration_missing' });
        return setting;
      },
      getWorkspace: async () => {
        await this.refreshWorkspaceAuthorization();
        return { identity: this.workspaceAuthorized ? this.workspaceIdentity : null, version: this.workspaceAuthorizationVersion };
      },
      logger: (event, fields) => this.log(event, fields)
    });
    const persistedIdentity = this.store.getMeta('workspace_authorized_identity');
    const legacyRoot = this.store.getMeta('workspace_authorized_root');
    if (persistedIdentity || legacyRoot) {
      try {
        const identity = JSON.parse(persistedIdentity);
        await assertWorkspaceIdentity(identity);
        this.workspaceRoot = identity.root;
        this.workspaceIdentity = identity;
        this.workspaceAuthorized = true;
      } catch {
        await this.revokeWorkspaceAuthorization();
      }
    }
    if (this.store.getMeta('recovery_mode') === 'true') {
      await this.log('runtime.recovery_blocked', { status: 'frozen', recoveryMode: true, reasonCode: 'reconciliation_unavailable' });
      return this;
    }
    await this.artifacts.reconcile();
    const tasks = this.store.listTasks().filter((task) => task.status === 'interrupted');
    await this.log('runtime.started', { status: 'ready', recoveryMode: false });
    if (tasks.length) await this.log('runtime.recovery_started', { status: 'resuming', attempt: tasks.length });
    for (const task of tasks) {
      if (task.permissionSnapshot?.mode) this.scheduleTask(task.id);
    }
    return this;
  }

  conversationState(key = CONVERSATION_STATE_KEY) {
    const value = this.store.getMeta(key);
    return value ? parseConversationState(value) : { version: 1, messages: [], transcript: [], historyVerificationVersion: 1 };
  }

  enabledSkillIds() {
    try { return normalizeEnabledSkillIds(JSON.parse(this.store.getMeta(ENABLED_SKILLS_KEY) ?? '[]')); }
    catch { return []; }
  }

  async setSkillEnabled(id, enabled) {
    const enabledIds = setSkillEnabled(this.enabledSkillIds(), id, enabled);
    this.store.transaction(() => this.store.setMeta(ENABLED_SKILLS_KEY, JSON.stringify(enabledIds)));
    await this.log('skill.state_changed', { skillId: id, status: enabled ? 'enabled' : 'disabled' });
    return listProductSkills(enabledIds).find((skill) => skill.id === id);
  }

  async initConversation() {
    if (!this.store.getMeta(CONVERSATION_STATE_KEY)) {
      const messages = await loadJson(this.conversationPath, []);
      const transcript = await loadJson(this.piTranscriptPath, []);
      const migrated = migrateConversation(messages, transcript);
      this.store.transaction(() => {
        if (!this.store.getMeta(CONVERSATION_STATE_KEY)) {
          this.store.setMeta(CONVERSATION_STATE_KEY, JSON.stringify(migrated));
        }
      });
    }
    this.store.transaction(() => {
      const state = this.conversationState();
      if (!state.historyVerificationVersion) {
        const verified = migrateConversation(state.messages, state.transcript);
        state.messages = verified.messages;
        state.historyVerificationVersion = 1;
        this.store.setMeta(CONVERSATION_STATE_KEY, JSON.stringify(state));
      }
    });
    await this.syncConversationMirrors();
  }

  async syncConversationMirrors() {
    let snapshot;
    do {
      let state;
      try { state = this.conversationState(); }
      catch {
        await this.log('conversation.mirror_failed', { status: 'failed', errorCode: 'conversation_mirror_failed' });
        return;
      }
      snapshot = JSON.stringify(state);
      for (const [path, value] of [
        [this.conversationPath, state.messages],
        [this.piTranscriptPath, { version: 1, messages: state.transcript }]
      ]) {
        try { await writeJsonMirror(path, value); }
        catch { await this.log('conversation.mirror_failed', { status: 'failed', errorCode: 'conversation_mirror_failed' }); }
      }
    } while (JSON.stringify(this.conversationState()) !== snapshot);
  }

  async revokeWorkspaceAuthorization() {
    this.workspaceAuthorizationVersion += 1;
    this.workspaceRoot = this.defaultWorkspaceRoot;
    this.workspaceIdentity = null;
    this.workspaceAuthorized = false;
    this.store.transaction(() => {
      this.store.setMeta('workspace_authorized_root', '');
      this.store.setMeta('workspace_authorized_identity', '');
    });
    await this.log('workspace.authorization', { status: 'invalid' });
  }

  async refreshWorkspaceAuthorization() {
    if (!this.workspaceAuthorized) return;
    try {
      await assertWorkspaceIdentity(this.workspaceIdentity);
    } catch {
      await this.revokeWorkspaceAuthorization();
    }
  }

  scheduleTask(taskId) {
    this.assertRecoveryAllowed('task.schedule', taskId);
    if (this.jobs.has(taskId)) return this.jobs.get(taskId);
    const job = this.executeTask(taskId).finally(() => this.jobs.delete(taskId));
    this.jobs.set(taskId, job);
    return job;
  }

  async executeTask(taskId) {
    this.assertRecoveryAllowed('task.execute', taskId);
    await this.log('task.running', { taskId, status: 'running' });
    const started = Date.now();
    await this.telemetry.emit({ event: 'task.started', taskId });
    try {
      const result = await this.runner.run(taskId);
      await this.dispatchTaskEvents(taskId);
      await this.log('task.finished', { taskId, status: result.status ?? 'completed' });
      await this.telemetry.emit({ event: 'task.completed', taskId, durationMs: Date.now() - started });
      return result;
    } catch (error) {
      const task = this.store.getTask(taskId);
      await this.log('task.failed', { taskId, status: 'needs_attention', errorCode: 'task_execution_failed' });
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

  async dispatchTaskEvents(taskId, providerOverride = undefined) {
    this.assertRecoveryAllowed('notification.dispatch', taskId);
    const task = this.store.getTask(taskId);
    const provider = providerOverride ?? (task?.permissionSnapshot?.providerInstance === 'local-file' ? this.localProvider : null);
    if (!provider) return;
    const events = this.store.listOutbox().filter((event) => event.taskId === taskId && event.target && event.status === 'pending' && ['task.completed', 'task.attention', 'task.failed'].includes(event.kind));
    for (const event of events) {
      const correlationId = randomUUID();
      await this.log('notification.attempt', { correlationId, taskId, deliveryId: event.id, provider: task?.permissionSnapshot?.providerInstance ?? 'test-provider', status: 'attempting' });
      const result = await this.outbox.dispatch(event.id, provider);
      await this.log('notification.result', { correlationId, taskId, deliveryId: event.id, status: result.status ?? 'unknown', errorCode: result.status === 'unknown' ? 'delivery_result_unknown' : undefined });
    }
  }

  async log(event, fields = {}) {
    try { await this.logger.write(event, fields); } catch { /* Local diagnostic I/O must not change task state. */ }
  }

  assertRecoveryAllowed(operation, taskId) {
    if (this.store.getMeta('recovery_mode') !== 'true') return;
    void this.log('recovery.gate', { taskId, status: 'blocked', decision: operation, errorCode: 'recovery_mode', recoveryMode: true });
    throw Object.assign(new Error('Recovery mode freezes task execution and external side effects'), { code: 'recovery_mode' });
  }

  async modelConfiguration() {
    const settings = await this.modelSettings.list();
    const savedId = this.store.getMeta(ACTIVE_MODEL_KEY);
    const active = settings.find((entry) => entry.id === savedId) ?? settings.find((entry) => entry.id === 'default') ?? settings[0];
    return { settings, activeSettingId: active?.id ?? null };
  }

  async messages() { return this.conversationState().messages; }

  enqueueChat(operation) {
    const next = this.chatTail.then(operation, operation);
    this.chatTail = next.then(() => undefined, () => undefined);
    return next;
  }

  async handleChat(params) {
    const conversationKey = params.conversationKey ?? CONVERSATION_STATE_KEY;
    if (params.task) {
      const user = await this.appendMessage('user', params.text ?? '');
      const task = this.store.createTaskProposal({
        ...params.task,
        inputs: { ...(params.task.inputs ?? {}), root: params.task.inputs?.root ?? this.workspaceRoot }
      });
      await this.log('task.proposed', { taskId: task.id, status: task.status });
      const assistant = await this.appendMessage('assistant', `已创建待审批任务：${task.goal}`, { taskId: task.id });
      return { ok: true, result: { kind: 'task_proposal', task, user, assistant } };
    }
    await this.refreshWorkspaceAuthorization();
    const configuration = await this.modelConfiguration();
    const settingId = params.settingId ?? configuration.activeSettingId;
    const settingsRevision = this.store.getMeta(SETTINGS_REVISION_KEY);
    const setting = await this.modelSettings.get(settingId);
    if (!setting) throw Object.assign(Error('请先保存模型配置'), { code: 'model_configuration_missing' });
    const secret = params.modelCredential?.apiKey ? params.modelCredential : await this.modelSettings.getSecret(settingId);
    if (!secret?.apiKey) throw Object.assign(Error('请先保存 API Key 并测试连接'), { code: 'model_api_key_missing' });
    const correlationId = randomUUID();
    const startedAt = Date.now();
    await this.log('model.request', { correlationId, provider: setting.provider, status: 'started' });
    const initialState = this.conversationState(conversationKey);
    this.mcp.setCredentials(params.mcpCredentials);
    const enabledSkillIds = this.enabledSkillIds();
    const mcpTools = this.mcp.createPiTools();
    const memorySnapshot = this.memory.snapshot();
    const pluginTools = [...this.plugins.createDevelopmentTools(), ...this.plugins.createPiTools(), {
      name: 'memory_propose', label: '提议个人记忆', description: '将用户明确希望长期记住的偏好提交到待审核列表。用户批准后才提供给模型。',
      parameters: { type: 'object', properties: { text: { type: 'string', maxLength: 2000 } }, required: ['text'], additionalProperties: false },
      execute: async (_id, input) => {
        const proposal = this.memory.propose(input.text, 'agent');
        return { content: [{ type: 'text', text: '已提交，等待用户在个人记忆中审核。' }], details: { id: proposal.id, revision: proposal.revision } };
      }
    }];
    const initialWorkspace = this.workspaceIdentity;
    const initialWorkspaceAuthorized = this.workspaceAuthorized;
    const initialWorkspaceAuthorizationVersion = this.workspaceAuthorizationVersion;
    const selectedContextId = contextId(setting, enabledSkillIds, mcpTools.map((tool) => tool.name), this.plugins.createPiTools().map((tool) => tool.name), initialWorkspace, memorySnapshot.version);
    const transcript = initialState.contextId === selectedContextId ? initialState.transcript : [];
    let completion;
    try {
      completion = await withWorkspaceIdentity(this.workspaceIdentity, () => runPiAgentTurn({
        setting,
        apiKey: secret.apiKey,
        text: params.text ?? '',
        transcript,
        systemPrompt: buildSkillsSystemPrompt(enabledSkillIds) + memoryPrompt(memorySnapshot),
        mcpTools,
        pluginTools,
        artifacts: this.artifacts,
        ensureWorkspaceAuthorized: async () => {
          await this.refreshWorkspaceAuthorization();
          if (!this.workspaceAuthorized || this.workspaceAuthorizationVersion !== initialWorkspaceAuthorizationVersion || JSON.stringify(this.workspaceIdentity) !== JSON.stringify(initialWorkspace)) {
            throw Object.assign(Error('Workspace authorization changed'), { code: 'workspace_authorization_changed' });
          }
        },
        workspaceRoot: this.workspaceRoot,
        workspaceAuthorized: this.workspaceAuthorized,
        fetchImpl: this.fetchImpl,
        timeoutMs: this.modelTimeoutMs,
        permissionGateway: this.permissionGateway,
        logger: (event, fields) => this.log(event, { correlationId, ...fields })
      }));
    } catch (error) {
      await this.appendMessage('user', params.text ?? '', { modelConversation: false, modelErrorCode: error.code ?? 'model_request_failed' }, conversationKey);
      await this.log('model.error', { correlationId, provider: setting.provider, status: 'failed', latencyMs: Date.now() - startedAt, errorCode: error.code ?? 'model_request_failed', usageStatus: error.usageStatus ?? 'unknown' });
      throw Object.assign(error, { correlationId });
    } finally {
      this.mcp.clearCredentials();
    }

    await this.refreshWorkspaceAuthorization();
    const user = { id: randomUUID(), role: 'user', content: params.text ?? '', createdAt: Date.now(), modelConversation: true };
    const assistant = {
      id: randomUUID(), role: 'assistant', content: completion.content, createdAt: Date.now(),
      model: setting.model, modelConversation: true, memoryIds: memorySnapshot.entries.map((item) => item.id), toolExecutions: completion.toolExecutions, sources: completion.sources
    };
    this.store.transaction(() => {
      const state = this.conversationState(conversationKey);
      if (this.memory.version() !== memorySnapshot.version || this.store.getMeta(SETTINGS_REVISION_KEY) !== settingsRevision || contextId(setting, this.enabledSkillIds(), this.mcp.createPiTools().map((tool) => tool.name)) !== contextId(setting, enabledSkillIds, mcpTools.map((tool) => tool.name)) ||
          (this.workspaceAuthorized !== initialWorkspaceAuthorized || this.workspaceAuthorizationVersion !== initialWorkspaceAuthorizationVersion || JSON.stringify(this.workspaceIdentity) !== JSON.stringify(initialWorkspace)) || state.contextId !== initialState.contextId || JSON.stringify(state.transcript) !== JSON.stringify(initialState.transcript)) {
        throw Object.assign(Error('Conversation changed while the model request was running'), { code: 'conversation_conflict' });
      }
      state.messages.push(user, assistant);
      const currentContextId = contextId(setting, this.enabledSkillIds(), this.mcp.createPiTools().map((tool) => tool.name), this.plugins.createPiTools().map((tool) => tool.name), this.workspaceIdentity, this.memory.version());
      state.transcript = currentContextId === selectedContextId ? completion.transcript : [];
      state.contextId = currentContextId;
      this.store.setMeta(conversationKey, JSON.stringify(state));
    });
    if (conversationKey === CONVERSATION_STATE_KEY) await this.syncConversationMirrors();
    await this.log('model.result', { correlationId, provider: setting.provider, status: 'succeeded', latencyMs: Date.now() - startedAt, inputTokens: completion.usage.inputTokens, outputTokens: completion.usage.outputTokens, costStatus: completion.usage.costStatus });
    return { ok: true, result: { kind: 'assistant', user, assistant, toolExecutions: completion.toolExecutions, usage: completion.usage, costStatus: completion.usage.costStatus, correlationId } };
  }

  async handleWecomMessage(params) {
    this.assertRecoveryAllowed('wecom.reply');
    this.wecom.assertRevision(params.revision);
    const namespace = this.wecom.namespace();
    const row = this.wecom.get(params.msgid);
    if (!row || row.status !== 'processing' || row.text !== params.text) throw Object.assign(Error('渠道消息状态已改变。'), { code: 'wecom_message_changed' });
    let text;
    try {
      const command = params.text.trim();
      if (command.startsWith('/任务 ') && !/^\/任务 [a-f0-9-]{36}$/i.test(command)) {
        const task = await this.agentTasks.start({ text: command.slice(4), modelCredential: params.modelCredential });
        text = '任务已启动，ID ' + task.id + '。可在桌面查看步骤，或发送 /任务 ' + task.id;
      } else if (command === '/任务列表') {
        text = this.agentTasks.store.list().slice(0, 10).map(item => item.id + ' · ' + item.status + ' · ' + item.goal).join('\n') || '暂无任务。';
      } else if (/^\/(暂停|继续|取消|任务)\s+/.test(command)) {
        const [action, id] = command.split(/\s+/);
        let task;
        if (action === '/继续') task = await this.agentTasks.resume({ id, modelCredential: params.modelCredential });
        else if (action === '/任务') task = this.agentTasks.store.get(id);
        else task = this.agentTasks.control(id, action === '/暂停' ? 'paused' : 'cancelled');
        if (!task) throw Object.assign(Error('任务不存在。'), { code: 'agent_task_not_found' });
        text = task.goal + '\n' + task.status + ' · ' + task.results.length + '/' + task.steps.length + '\n' + (task.results.at(-1)?.text ?? '');
      } else {
        const result = await this.handleChat({ text: params.text, modelCredential: params.modelCredential, conversationKey: this.wecom.conversationKey() });
        text = result.result.assistant.content;
      }
      this.wecom.finish(params.msgid, text, 'processed', namespace);
      return { ok: true, result: { text } };
    } catch (error) {
      this.wecom.finish(params.msgid, '处理失败，请在桌面查看状态。', 'failed', namespace);
      throw error;
    }
  }

  async handleResearch(params) {
    this.assertRecoveryAllowed('research.run');
    const { activeSettingId } = await this.modelConfiguration();
    const settingsRevision = this.store.getMeta(SETTINGS_REVISION_KEY);
    const setting = await this.modelSettings.get(params.settingId ?? activeSettingId);
    if (!setting) throw Object.assign(Error('请先保存模型配置'), { code: 'model_configuration_missing' });
    const modelKey = params.modelCredential?.apiKey;
    if (!modelKey) throw Object.assign(Error('请先保存模型 API Key'), { code: 'model_api_key_missing' });
    const searchKey = params.searchCredential?.apiKey;
    const text = normalizeResearchQuery(params.text, [searchKey, modelKey]);
    const correlationId = randomUUID();
    const start = Date.now();
    await this.log('research.request', { correlationId, provider: 'brave-search', status: 'started' });
    try {
      const evidence = await searchPublicWeb({ query: text, apiKey: searchKey, modelSecret: modelKey, fetchImpl: this.fetchImpl });
      const research = await synthesizeResearch({ query: text, evidence, searchKey, complete: async (input, systemPrompt) => {
        return runPiAgentTurn({ setting, apiKey: modelKey, text: input, systemPrompt, workspaceAuthorized: false,
          fetchImpl: this.fetchImpl, timeoutMs: this.modelTimeoutMs });
      } });
      const user = { id: randomUUID(), role: 'user', content: text, createdAt: Date.now() };
      const assistant = {
        id: randomUUID(), role: 'assistant', content: research.status === 'empty' ? '未找到可用的公开网页摘要。' :
          research.status === 'unverified' ? '现有资料不足以给出可核实的结论。' : '根据公开搜索摘要整理如下。',
        createdAt: Date.now(), research
      };
      this.store.transaction(() => {
        if (this.store.getMeta(SETTINGS_REVISION_KEY) !== settingsRevision || this.store.getMeta('recovery_mode') === 'true') {
          throw Object.assign(Error('调研期间运行配置发生变化，请重试。'), { code: 'conversation_conflict' });
        }
        const state = this.conversationState();
        state.messages.push(user, assistant);
        this.store.setMeta(CONVERSATION_STATE_KEY, JSON.stringify(state));
      });
      await this.syncConversationMirrors();
      await this.log('research.result', { correlationId, provider: 'brave-search', status: research.status, latencyMs: Date.now() - start });
      return { ok: true, result: { kind: 'research', user, assistant, correlationId } };
    } catch (error) {
      await this.log('research.result', { correlationId, provider: 'brave-search', status: 'failed', latencyMs: Date.now() - start, errorCode: error.code });
      throw Object.assign(error, { correlationId });
    }
  }

  async appendMessage(role, content, extra = {}, key = CONVERSATION_STATE_KEY) {
    const message = { id: randomUUID(), role, content, createdAt: Date.now(), ...extra };
    this.store.transaction(() => {
      const state = this.conversationState(key);
      state.messages.push(message);
      this.store.setMeta(key, JSON.stringify(state));
    });
    if (key === CONVERSATION_STATE_KEY) await this.syncConversationMirrors();
    return message;
  }

  async handle(method, params = {}) {
    if (this.closed) return { ok: false, error: { code: 'runtime_closed', message: 'Runtime is closed' } };
    try {
      if (this.store.getMeta('recovery_mode') === 'true' && ['chat.send', 'research.run', 'task.approve', 'task.run', 'task.resume'].includes(method)) this.assertRecoveryAllowed(method, params.taskId);
      if (method === 'recovery.exit') {
        if (this.store.getMeta('recovery_mode') !== 'true') return { ok: true, result: { recoveryMode: false } };
        await this.log('recovery.exit_blocked', { status: 'frozen', errorCode: 'recovery_reconciliation_unavailable', recoveryMode: true });
        throw Object.assign(Error('Recovery reconciliation is not implemented; recovery mode remains frozen'), { code: 'recovery_reconciliation_unavailable' });
      }
      if (method === 'wecom.config.get') return { ok: true, result: { config: this.wecom.config() } };
      if (method === 'wecom.config.save') return { ok: true, result: { config: this.wecom.save(params) } };
      if (method === 'wecom.history') return { ok: true, result: { messages: this.wecom.history() } };
      if (method === 'wecom.inbox.claim') return { ok: true, result: this.wecom.claim(params) };
      if (method === 'wecom.inbox.fail' || method === 'wecom.inbox.delivery') {
        this.wecom.assertRevision(params.revision);
        const row = this.wecom.get(params.msgid);
        if (row && method === 'wecom.inbox.fail' && row.status === 'processing') this.wecom.finish(params.msgid, '处理失败，请在桌面查看状态。', 'failed');
        if (row && method === 'wecom.inbox.delivery' && row.status === 'processed') this.wecom.finish(params.msgid, row.reply, params.status === 'delivered' ? 'delivered' : 'delivery_unknown');
        return { ok: true, result: {} };
      }
      if (method === 'wecom.reply') return await this.enqueueChat(() => this.handleWecomMessage(params));
      if (method === 'chat.send') {
        return await this.enqueueChat(() => this.handleChat(params));
      }
      if (method === 'research.run') {
        return await this.enqueueChat(() => this.handleResearch(params));
      }
      if (method === 'schedule.list') return { ok: true, result: { schedules: this.schedules.list(), events: this.schedules.events() } };
      if (method === 'schedule.create') {
        this.assertRecoveryAllowed(method);
        let binding = null;
        if (params.kind === 'agent-task') {
          await this.refreshWorkspaceAuthorization();
          const configuration = await this.modelConfiguration();
          const setting = await this.modelSettings.get(configuration.activeSettingId);
          if (!setting) throw Object.assign(Error('请先配置任务使用的模型。'), { code: 'model_configuration_missing' });
          binding = { settingId: setting.id, revision: setting.revision, workspace: this.workspaceIdentity };
        }
        return { ok: true, result: { schedule: this.schedules.create(params, binding) } };
      }
      if (method === 'schedule.set_enabled') {
        this.assertRecoveryAllowed(method);
        return { ok: true, result: { schedule: this.schedules.setEnabled(params.id, params.revision, params.enabled) } };
      }
      if (method === 'schedule.delete') { this.schedules.delete(params.id, params.revision, params.confirm); return { ok: true, result: {} }; }
      if (method === 'schedule.read') { this.schedules.read(params.id); return { ok: true, result: {} }; }
      if (method === 'schedule.tick') { this.assertRecoveryAllowed(method); return { ok: true, result: { events: this.schedules.claimDue() } }; }
      if (method === 'schedule.run') {
        this.assertRecoveryAllowed(method);
        const event = this.schedules.begin(params.id);
        if (!event) return { ok: true, result: { event: null } };
        try {
          let task = null;
          if (event.kind === 'agent-task') task = await this.agentTasks.start({ text: event.text, settingId: event.binding.settingId, modelCredential: params.modelCredential, expectedBinding: event.binding });
          this.schedules.finish(event.id, task ? 'started' : 'fired', { taskId: task?.id });
          await this.log('schedule.fired', { taskId: task?.id, status: task ? 'started' : 'fired' });
          return { ok: true, result: { event: { ...event, taskId: task?.id, status: task ? 'started' : 'fired' } } };
        } catch (error) {
          this.schedules.finish(event.id, 'failed', { reasonCode: error.code ?? 'schedule_failed' });
          return { ok: true, result: { event: { ...event, status: 'failed', reasonCode: error.code ?? 'schedule_failed' } } };
        }
      }
      if (method.startsWith('agent_task.')) {
        if (method === 'agent_task.list') {
          const tasks = this.agentTasks.store.list().map(({ id, goal, status, steps, results, reasonCode }) => ({ id, goal, status, titles: steps.map((step) => step.title), completedSteps: results.length, reasonCode }));
          return { ok: true, result: { tasks } };
        }
        if (method === 'agent_task.get') return { ok: true, result: { task: this.agentTasks.store.get(params.id) } };
        if (method === 'agent_task.start' || method === 'agent_task.resume') {
          this.assertRecoveryAllowed(method);
          const task = method === 'agent_task.start' ? await this.agentTasks.start(params) : await this.agentTasks.resume(params);
          return { ok: true, result: { task } };
        }
        if (method === 'agent_task.pause' || method === 'agent_task.cancel') {
          const task = this.agentTasks.control(params.id, method === 'agent_task.pause' ? 'paused' : 'cancelled');
          return { ok: true, result: { task } };
        }
      }
      if (method === 'task.list') return { ok: true, result: { tasks: this.store.listTasks(), outbox: this.store.listOutbox(), recoveryMode: this.store.getMeta('recovery_mode') === 'true' } };
      if (method === 'task.approve') {
        const task = this.store.approveTask(params.taskId, params.approval ?? {});
        await this.log('task.approved', { taskId: task.id, status: task.status, decision: 'approved' });
        this.scheduleTask(task.id);
        return { ok: true, result: { task } };
      }
      if (method === 'task.run') { const task = this.store.getTask(params.taskId); if (!task) throw Error('task_not_found'); this.scheduleTask(task.id); return { ok: true, result: { task: this.store.getTask(task.id) } }; }
      if (method === 'task.pause') return { ok: true, result: { task: this.store.transitionTask(params.taskId, 'paused', 'user_pause') } };
      if (method === 'task.resume') { const task = this.store.transitionTask(params.taskId, 'queued', 'user_resume'); this.scheduleTask(task.id); return { ok: true, result: { task } }; }
      if (method === 'task.cancel') return { ok: true, result: { task: this.store.transitionTask(params.taskId, 'cancelled', 'user_cancel') } };
      if (method.startsWith('artifacts.')) {
        const fields = method === 'artifacts.list' ? [] : method === 'artifacts.get' ? ['id'] : method === 'artifacts.create' ? ['id','sha256','confirm'] : null;
        if (!fields || !params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some((key) => !fields.includes(key))) throw Object.assign(Error('artifact_request_invalid'), { code: 'artifact_request_invalid' });
        if (method === 'artifacts.list') return { ok: true, result: { artifacts: this.artifacts.list() } };
        if (method === 'artifacts.get') return { ok: true, result: { artifact: this.artifacts.get(params.id) } };
        this.assertRecoveryAllowed(method);
        return { ok: true, result: { artifact: await this.artifacts.create(params) } };
      }
      if (method.startsWith('plugins.') && !['plugins.list', 'plugins.get'].includes(method)) this.assertRecoveryAllowed(method);
      if (method === 'plugins.list') {
        if (!params || Object.keys(params).length) throw Object.assign(Error('plugin_request_invalid'), { code: 'plugin_request_invalid' });
        return { ok: true, result: { plugins: this.plugins.list() } };
      }
      if (method === 'plugins.get') return { ok: true, result: { plugin: this.plugins.get(params) } };
      if (method === 'plugins.save_draft') return { ok: true, result: { plugin: await this.plugins.saveDraft(params) } };
      if (method === 'plugins.test') return { ok: true, result: { test: await this.plugins.testPlugin(params) } };
      if (method === 'plugins.set_enabled') return { ok: true, result: { plugin: await this.plugins.setEnabled(params) } };
      if (method === 'plugins.run') return { ok: true, result: { output: await this.plugins.run(params) } };
      if (method === 'plugins.remove') return { ok: true, result: await this.plugins.remove(params) };
      if (method === 'skills.list') return { ok: true, result: { skills: listProductSkills(this.enabledSkillIds()) } };
      if (method === 'skills.set_enabled') {
        const validParams = params && typeof params === 'object' && !Array.isArray(params) &&
          Object.keys(params).length === 2 && Object.hasOwn(params, 'id') && Object.hasOwn(params, 'enabled');
        if (!validParams) throw Object.assign(Error('Skill request contains unsupported fields'), { code: 'skill_request_invalid' });
        const skill = await this.setSkillEnabled(params.id, params.enabled);
        return { ok: true, result: { skill } };
      }
      if (method === 'mcp.servers.list') return { ok: true, result: { servers: this.mcp.list() } };
      if (method === 'mcp.servers.list_internal') return { ok: true, result: { servers: this.mcp.list().map(({ id }) => this.mcp.getInternal(id)) } };
      if (method === 'mcp.server.save') {
        const server = params?.server;
        if (!params || Object.keys(params).some((key) => key !== 'server') || !server) {
          throw Object.assign(Error('MCP server request contains unsupported fields'), { code: 'mcp_server_invalid' });
        }
        return { ok: true, result: { server: this.mcp.save(server) } };
      }
      if (method === 'mcp.server.connect') {
        if (Object.keys(params ?? {}).some((key) => !['id', 'mcpCredential'].includes(key))) throw Object.assign(Error('MCP connect request contains unsupported fields'), { code: 'mcp_server_invalid' });
        const tools = await this.mcp.connect(params.id, params.mcpCredential?.token ?? null);
        return { ok: true, result: { tools } };
      }
      if (method === 'mcp.server.set_enabled') return { ok: true, result: { server: this.mcp.setServerEnabled(params.id, params.enabled) } };
      if (method === 'mcp.tool.set_enabled') return { ok: true, result: { tool: this.mcp.setToolEnabled(params.serverId, params.name, params.enabled) } };
      if (method === 'mcp.tool.call') {
        if (Object.keys(params ?? {}).some((key) => !['serverId', 'name', 'arguments', 'mcpCredential'].includes(key))) throw Object.assign(Error('MCP tool call contains unsupported fields'), { code: 'mcp_tool_invalid' });
        if (params.mcpCredential !== undefined && (typeof params.mcpCredential?.token !== 'string' || params.mcpCredential.token.length > 8192)) throw Object.assign(Error('MCP credential is invalid'), { code: 'mcp_server_invalid' });
        this.mcp.setCredentials(params.mcpCredential?.token ? [{ serverId: params.serverId, token: params.mcpCredential.token }] : []);
        try { return { ok: true, result: await this.mcp.callTool(params.serverId, params.name, params.arguments ?? {}) }; }
        finally { this.mcp.clearCredentials(); }
      }
      if (method === 'mcp.server.remove') { await this.mcp.remove(params.id); return { ok: true, result: { removed: true } }; }
      if (method === 'settings.get') return { ok: true, result: await this.modelConfiguration() };
      if (method === 'settings.activate') {
        const setting = await this.modelSettings.get(params.id);
        if (!setting) throw Object.assign(Error('模型配置不存在'), { code: 'model_configuration_missing' });
        this.store.transaction(() => {
          this.store.setMeta(ACTIVE_MODEL_KEY, setting.id);
          this.store.setMeta(SETTINGS_REVISION_KEY, randomUUID());
        });
        await this.log('model.configuration', { status: 'activated' });
        return { ok: true, result: { activeSettingId: setting.id } };
      }
      if (method === 'settings.remove') {
        if (params.confirm !== true || typeof params.id !== 'string' || !params.id) {
          throw Object.assign(Error('请确认删除具体模型配置'), { code: 'model_confirmation_required' });
        }
        const previous = await this.modelConfiguration();
        this.store.setMeta(SETTINGS_REVISION_KEY, randomUUID());
        try {
          const removed = await this.modelSettings.remove(params.id);
          if (!removed) throw Object.assign(Error('模型配置不存在'), { code: 'model_configuration_missing' });
          const remaining = await this.modelSettings.list();
          const activeSettingId = previous.activeSettingId === params.id ? remaining[0]?.id ?? null : previous.activeSettingId;
          this.store.setMeta(ACTIVE_MODEL_KEY, activeSettingId ?? '');
          await this.log('model.configuration', { status: 'removed' });
          return { ok: true, result: { removed: true, activeSettingId } };
        } finally { this.store.setMeta(SETTINGS_REVISION_KEY, randomUUID()); }
      }
      if (method === 'settings.update') {
        this.store.setMeta(SETTINGS_REVISION_KEY, randomUUID());
        try {
          const setting = await this.modelSettings.upsert(params.setting ?? params);
          const configuration = await this.modelConfiguration();
          if (!this.store.getMeta(ACTIVE_MODEL_KEY)) this.store.setMeta(ACTIVE_MODEL_KEY, configuration.activeSettingId ?? '');
          return { ok: true, result: { setting } };
        }
        finally { this.store.setMeta(SETTINGS_REVISION_KEY, randomUUID()); }
      }
      if (method === 'workspace.get') {
        await this.refreshWorkspaceAuthorization();
        return { ok: true, result: { authorized: this.workspaceAuthorized, root: this.workspaceAuthorized ? this.workspaceRoot : null } };
      }
      if (method === 'workspace.authorize') {
        if (!this.workspaceControlToken || params.controlToken !== this.workspaceControlToken) {
          throw Object.assign(Error('Workspace authorization is restricted to the Electron main process'), { code: 'workspace_authorization_denied' });
        }
        const root = await normalizeWorkspaceRoot(params.root);
        const identity = await workspaceIdentity(root);
        this.store.transaction(() => {
          this.store.setMeta('workspace_authorized_root', root);
          this.store.setMeta('workspace_authorized_identity', JSON.stringify(identity));
        });
        this.workspaceAuthorizationVersion += 1;
        this.workspaceRoot = root;
        this.workspaceIdentity = identity;
        this.workspaceAuthorized = true;
        await this.log('workspace.authorization', { status: 'succeeded' });
        return { ok: true, result: { authorized: true, root } };
      }
      if (method === 'settings.test') {
        this.assertRecoveryAllowed('model.connection_test');
        const configuration = await this.modelConfiguration();
        const setting = await this.modelSettings.get(params.settingId ?? configuration.activeSettingId);
        if (!setting) throw Object.assign(Error('请先保存模型配置'), { code: 'model_configuration_missing' });
        const secret = params.apiKey ? { apiKey: params.apiKey } : await this.modelSettings.getSecret(setting.id);
        if (!secret?.apiKey) throw Object.assign(Error('请先保存 API Key'), { code: 'model_api_key_missing' });
        const correlationId = randomUUID();
        const startedAt = Date.now();
        await this.log('model.connection_test', { correlationId, provider: setting.provider, status: 'started' });
        try {
          const result = await this.modelClient.testConnection(setting, secret.apiKey);
          await this.log('model.connection_test', { correlationId, provider: setting.provider, status: 'succeeded', latencyMs: Date.now() - startedAt, costStatus: result.usage.costStatus });
          return { ok: true, result: { ...result, correlationId } };
        } catch (error) {
          await this.log('model.connection_test', { correlationId, provider: setting.provider, status: 'failed', latencyMs: Date.now() - startedAt, errorCode: error.code ?? 'model_request_failed', usageStatus: error.usageStatus ?? 'unknown' });
          throw Object.assign(error, { correlationId });
        }
      }
      if (method === 'memory.list' || method === 'memory.search') {
        const query = String(params.query ?? '').toLowerCase();
        return { ok: true, result: { memories: this.memory.list().filter((item) => item.text.toLowerCase().includes(query)) } };
      }
      if (method === 'memory.put' || method === 'memory.propose') return { ok: true, result: { memory: this.memory.propose((params.memory ?? params).text, 'user') } };
      if (['memory.approve', 'memory.update', 'memory.reject', 'memory.delete'].includes(method)) {
        this.assertRecoveryAllowed(method);
        const memory = this.memory[method.split('.')[1]](params.id, params.revision, params.text);
        return { ok: true, result: { memory } };
      }
      if (method === 'conversation.list') return { ok: true, result: { messages: await this.messages() } };
      if (method === 'system.status') return { ok: true, result: { jobs: this.jobs.size, recoveryMode: this.store.getMeta('recovery_mode') === 'true', logPath: this.logger.path } };
      throw Object.assign(Error(`unknown_method:${method}`), { code: 'unknown_method' });
    } catch (error) {
      await this.log('runtime.error', { correlationId: params.correlationId, taskId: params.taskId, errorCode: error.code ?? 'runtime_error', status: 'error' });
      return { ok: false, error: { code: error.code ?? 'runtime_error', message: error.message, correlationId: error.correlationId, usageStatus: error.usageStatus } };
    }
  }

  async waitForIdle() {
    await this.chatTail.catch(() => {});
    await this.agentTasks.waitForIdle();
    await this.artifacts.waitForIdle();
    while (this.jobs.size) await Promise.allSettled([...this.jobs.values()]);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.agentTasks.close();
    await this.waitForIdle();
    await this.plugins.close();
    await this.mcp.close();
    this.store.close();
  }
}

export async function createRuntime({ dataDir, workspaceRoot = join(dataDir, 'workspace'), dbPath = join(dataDir, 'agent.sqlite'), workspaceControlToken, fetchImpl = fetch, modelTimeoutMs = 90_000, agentTaskStepTimeoutMs = 120_000 }) {
  await mkdir(dataDir, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  const store = await RuntimeStore.open(dbPath);
  try {
    return await new RuntimeController({ store, dataDir, workspaceRoot, workspaceControlToken, fetchImpl, modelTimeoutMs, agentTaskStepTimeoutMs, modelClient: new ModelClient({ fetchImpl, timeoutMs: modelTimeoutMs }) }).init();
  } catch (error) {
    store.close();
    throw error;
  }
}

export async function runStdio() {
  const dataDir = resolve(process.env.PI_AGENT_DATA_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '.data'));
  const workspaceRoot = resolve(process.env.PI_AGENT_WORKSPACE ?? join(dataDir, 'workspace'));
  const runtime = await createRuntime({ dataDir, workspaceRoot, workspaceControlToken: process.env.PI_AGENT_WORKSPACE_CONTROL_TOKEN });
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
