import { Agent } from '@earendil-works/pi-agent-core';
import { openAICompletionsApi, openAIResponsesApi } from '@earendil-works/pi-ai/compat';
import { PermissionGateway } from './permission-gateway.mjs';
import { WorkspaceAdmission } from './workspace.mjs';
import { createWorkspaceTools } from './pi-tools.mjs';

function validateEndpoint(setting) {
  if (!['openai-compatible', 'openai-responses'].includes(setting.provider)) {
    throw Object.assign(new Error('Unsupported model provider'), { code: 'unsupported_provider' });
  }
  if (!setting.model || !setting.baseUrl) {
    throw Object.assign(new Error('Model and endpoint are required'), { code: 'model_configuration_incomplete' });
  }
  let base;
  try { base = new URL(setting.baseUrl); } catch { throw Object.assign(new Error('Invalid provider endpoint'), { code: 'model_endpoint_invalid' }); }
  const localHttp = base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.protocol !== 'https:' && !localHttp) throw Object.assign(new Error('Provider endpoint must use HTTPS'), { code: 'model_endpoint_must_use_https' });
  if (base.username || base.password || base.search || base.hash) throw Object.assign(new Error('Provider endpoint must not contain credentials or query data'), { code: 'model_endpoint_invalid' });
}

function modelForSetting(setting) {
  const api = setting.provider === 'openai-responses' || setting.apiFormat === 'responses' ? 'openai-responses' : 'openai-completions';
  return {
    id: setting.model,
    name: setting.model,
    api,
    provider: setting.provider,
    baseUrl: setting.baseUrl,
    input: setting.supportsImages ? ['text', 'image'] : ['text'],
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096
  };
}

function assistantText(message) {
  return (message?.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim();
}

function mapUsage(usage) {
  return {
    inputTokens: usage?.input ?? null,
    outputTokens: usage?.output ?? null,
    totalTokens: usage?.totalTokens ?? null,
    costStatus: 'unknown'
  };
}

function summarizeToolResult(result) {
  const details = result?.details;
  if (!details || typeof details !== 'object') return undefined;
  const summary = {};
  for (const key of ['operation', 'status', 'entryCount', 'truncated', 'size']) {
    if (details[key] !== undefined) summary[key] = details[key];
  }
  return summary;
}

const STRUCTURAL_FIELDS = new Set(['role', 'type', 'stopReason', 'api', 'provider', 'name']);
const TRANSCRIPT_FIELDS = new Set([
  'role', 'content', 'type', 'text', 'thinking', 'thinkingSignature', 'textSignature',
  'id', 'name', 'arguments', 'toolCallId', 'toolName', 'isError', 'details', 'timestamp',
  'api', 'provider', 'model', 'usage', 'input', 'output', 'cacheRead', 'cacheWrite',
  'totalTokens', 'cost', 'stopReason', 'errorMessage', 'durationMs', 'status', 'summary'
]);

function redactSecret(value, secret, field) {
  if (typeof value === 'string') {
    if (STRUCTURAL_FIELDS.has(field) && value.includes(secret)) {
      throw Object.assign(new Error('Provider response contains a credential in a structural field'), { code: 'model_response_invalid' });
    }
    return value.split(secret).join('[REDACTED]');
  }
  if (Array.isArray(value)) return value.map((item) => redactSecret(item, secret));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (TRANSCRIPT_FIELDS.has(key) && key.includes(secret)) {
        throw Object.assign(new Error('Provider response conflicts with credential redaction'), { code: 'model_response_invalid' });
      }
      return [key.split(secret).join('[REDACTED]'), redactSecret(item, secret, key)];
    }));
  }
  return value;
}

function omitImageBinary(value) {
  if (Array.isArray(value)) return value.map(omitImageBinary);
  if (!value || typeof value !== 'object') return value;
  if (value.type === 'image') return { type: 'text', text: '[图片内容未持久化。需要再次观察时，请重新读取来源文件。]' };
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, omitImageBinary(item)]));
}

function sanitizeTranscript(messages, secret) {
  const replayable = messages.map((message) => message.role === 'assistant' && message.errorMessage
    ? { ...message, errorMessage: 'Model provider request failed' }
    : message);
  return redactSecret(omitImageBinary(replayable), secret);
}

function normalizeTranscript(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.messages)) return value.messages;
  return [];
}

function errorCodeForAssistant(assistant) {
  const message = assistant?.errorMessage ?? '';
  return /abort|timeout|timed out|time limit/i.test(message) ? 'model_timeout' : 'model_request_failed';
}

export async function runPiAgentTurn({
  setting,
  apiKey,
  text,
  transcript = [],
  systemPrompt = '',
  workspaceRoot,
  workspaceAuthorized = true,
  fetchImpl = fetch,
  timeoutMs = 90_000,
  logger,
  permissionGateway = new PermissionGateway(),
  mcpTools = [],
  pluginTools = [],
  artifacts,
  ensureWorkspaceAuthorized = async () => {},
  signal,
  maxRequests = Infinity,
  maxToolCalls = Infinity
}) {
  validateEndpoint(setting);
  if (!apiKey) throw Object.assign(new Error('Model API key is required'), { code: 'model_api_key_missing' });

  const workspace = workspaceAuthorized ? await WorkspaceAdmission.open(workspaceRoot, 'read-only') : null;
  const contract = { permissionSnapshot: { mode: 'read-only' } };
  const sources = [];
  const tools = [...(workspaceAuthorized ? createWorkspaceTools({ workspace, permissionGateway, contract, artifacts, supportsImages: setting.supportsImages === true, sanitize: (value) => redactSecret(value, apiKey), ensureAuthorized: ensureWorkspaceAuthorized, recordSource: (source) => {
    const index = sources.findIndex((item) => item.path === source.path);
    if (index >= 0) sources[index] = source; else sources.push(source);
  } }) : []), ...mcpTools, ...pluginTools];
  const previousMessageCount = normalizeTranscript(transcript).length;
  const model = modelForSetting(setting);
  const streams = model.api === 'openai-responses' ? openAIResponsesApi() : openAICompletionsApi();
  const toolExecutions = [];
  const activeTools = new Map();
  let requestCount = 0;
  let toolCallCount = 0;
  const agent = new Agent({
    initialState: { model, messages: normalizeTranscript(transcript), tools, ...(systemPrompt ? { systemPrompt } : {}) },
    streamFn: (requestModel, context, options = {}) => {
      signal?.throwIfAborted();
      if (++requestCount > maxRequests) throw Object.assign(new Error('Model request budget exhausted'), { code: 'agent_task_model_budget' });
      return streams.streamSimple(requestModel, context, {
        ...options,
        apiKey,
        fetch: (input, init) => fetchImpl(input, { ...init, redirect: 'error' }),
        timeoutMs,
        cacheRetention: 'none'
      });
    },
    beforeToolCall: async () => {
      if (signal?.aborted || ++toolCallCount > maxToolCalls) return { block: true, terminate: true, reason: 'Tool budget exhausted or turn interrupted' };
    },
    getApiKey: () => apiKey,
    toolExecution: 'sequential'
  });

  const unsubscribe = agent.subscribe(async (event) => {
    if (event.type === 'tool_execution_start') {
      const execution = { id: event.toolCallId, name: event.toolName, status: 'running' };
      activeTools.set(event.toolCallId, execution);
      toolExecutions.push(execution);
      await logger?.('agent.tool.started', { toolName: event.toolName, status: 'started' });
    }
    if (event.type === 'tool_execution_end') {
      const execution = activeTools.get(event.toolCallId) ?? { id: event.toolCallId, name: event.toolName };
      execution.status = event.isError ? 'failed' : 'succeeded';
      execution.durationMs = event.durationMs;
      execution.summary = summarizeToolResult(event.result);
      activeTools.delete(event.toolCallId);
      await logger?.('agent.tool.finished', {
        toolName: event.toolName,
        status: execution.status,
        durationMs: event.durationMs
      });
    }
  });

  const abort = () => agent.abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    await agent.prompt(text);
    await agent.waitForIdle();
    signal?.throwIfAborted();
    if (requestCount > maxRequests || toolCallCount > maxToolCalls) throw Object.assign(new Error('Task execution budget exhausted'), { code: 'agent_task_budget' });
    const messages = agent.state.messages;
    const assistant = messages.slice(previousMessageCount).reverse().find((message) => message.role === 'assistant');
    if (!assistant || ['error', 'aborted'].includes(assistant.stopReason) || assistant.errorMessage) {
      throw Object.assign(new Error('Model provider request failed'), { code: errorCodeForAssistant(assistant), usageStatus: 'unknown' });
    }
    const content = assistantText(assistant);
    if (!content) throw Object.assign(new Error('Provider returned no message'), { code: 'model_empty_response' });
    return { content: redactSecret(content, apiKey), sources: redactSecret(sources, apiKey), usage: mapUsage(assistant.usage), toolExecutions: redactSecret(toolExecutions, apiKey), transcript: sanitizeTranscript(messages, apiKey) };
  } catch (error) {
    if (error.code) throw error;
    throw Object.assign(new Error('Could not reach model provider; provider usage is unknown'), { code: 'model_network_error', usageStatus: 'unknown', cause: error });
  } finally {
    signal?.removeEventListener('abort', abort);
    unsubscribe();
  }
}
