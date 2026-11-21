import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../src/runtime.mjs';
import { runPiAgentTurn } from '../src/runtime/pi-agent.mjs';
import { createMcpPiTools } from '../src/runtime/mcp.mjs';

function sseResponse(response, payload) {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'close' });
  for (const chunk of payload) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end('data: [DONE]\n\n');
}

function textCompletion(model, content, id = 'chatcmpl-text') {
  return [
    { id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
    { id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
  ];
}

function namedToolCompletion(model, name, args, id = 'chatcmpl-named-tool') {
  return [
    {
      id,
      object: 'chat.completion.chunk',
      model,
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{ index: 0, id: 'call-mcp-tool', type: 'function', function: { name, arguments: JSON.stringify(args) } }]
        },
        finish_reason: null
      }]
    },
    { id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
  ];
}

function toolCompletion(model, path, id = 'chatcmpl-tool') {
  return [
    {
      id,
      object: 'chat.completion.chunk',
      model,
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{ index: 0, id: 'call-workspace-read', type: 'function', function: { name: 'workspace_read', arguments: JSON.stringify({ path }) } }]
        },
        finish_reason: null
      }]
    },
    { id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
  ];
}

async function startSseProvider(onRequest) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    try {
      sseResponse(response, await onRequest(body, requests.length));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

async function configureRuntime(runtime, baseUrl) {
  const result = await runtime.handle('settings.update', { setting: { id: 'default', provider: 'openai-compatible', model: 'test-model', baseUrl, apiFormat: 'chat-completions' } });
  assert.equal(result.ok, true);
}

async function authorizeWorkspace(runtime, root) {
  const result = await runtime.handle('workspace.authorize', { root, controlToken: 'test-main-process-capability' });
  assert.equal(result.ok, true);
}

test('Pi Agent does not expose workspace tools before workspace authorization', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-agent-unauthorized-'));
  const workspace = join(dir, 'workspace');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'private.txt'), 'unauthorized-workspace-secret');
  let provider;
  let runtime;
  try {
    provider = await startSseProvider(async (body) => {
      assert.ok(!(body.tools ?? []).some((tool) => tool.function.name.startsWith('workspace_')));
      return textCompletion('test-model', '请先选择工作区。');
    });
    runtime = await createRuntime({ dataDir: dir, workspaceRoot: workspace });
    await configureRuntime(runtime, provider.baseUrl);
    const result = await runtime.handle('chat.send', { text: '读取文件', modelCredential: { apiKey: 'test-key' } });
    assert.equal(result.ok, true);
    assert.deepEqual(result.result.toolExecutions, []);
    assert.doesNotMatch(JSON.stringify(provider.requests), /unauthorized-workspace-secret/);
  } finally {
    await runtime?.close();
    await provider?.close();
    await rm(dir, { recursive: true, force: true });
  }
});


test('enabled product skills reach Pi and skill changes isolate the previous transcript', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-agent-product-skill-'));
  const workspace = join(dir, 'workspace');
  await mkdir(workspace, { recursive: true });
  const requests = [];
  let provider;
  let runtime;
  try {
    provider = await startSseProvider(async (body, index) => {
      requests.push(body);
      return textCompletion('test-model', `回答 ${index}`, `skill-chat-${index}`);
    });
    runtime = await createRuntime({ dataDir: dir, workspaceRoot: workspace });
    await configureRuntime(runtime, provider.baseUrl);
    const enabled = await runtime.handle('skills.set_enabled', { id: 'workspace-research', enabled: true });
    assert.equal(enabled.ok, true);

    const first = await runtime.handle('chat.send', { text: '调查项目文件', modelCredential: { apiKey: 'test-key' } });
    assert.equal(first.ok, true);
    const firstSystem = requests[0].messages.find((message) => message.role === 'system')?.content ?? '';
    assert.match(firstSystem, /workspace_list/);
    assert.match(firstSystem, /workspace_read/);

    await runtime.handle('skills.set_enabled', { id: 'workspace-research', enabled: false });
    const second = await runtime.handle('chat.send', { text: '回答新的问题', modelCredential: { apiKey: 'test-key' } });
    assert.equal(second.ok, true);
    const secondSystem = requests[1].messages.find((message) => message.role === 'system')?.content ?? '';
    assert.doesNotMatch(secondSystem, /workspace_list|workspace_read/);
    assert.deepEqual(requests[1].messages.filter((message) => message.role === 'user').map((message) => Array.isArray(message.content) ? message.content.map((part) => part.text ?? '').join('') : message.content), ['回答新的问题']);
  } finally {
    await runtime?.close();
    await provider?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Pi Agent completes a workspace tool roundtrip and reloads its transcript after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-agent-tool-roundtrip-'));
  const workspace = join(dir, 'workspace');
  const key = 'local-test-api-key';
  const prompt = '请读取 note.txt 并总结';
  const fileContent = '授权文件内容：项目方向已确认';
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'note.txt'), fileContent);
  let provider;
  const runtimes = [];
  try {
    provider = await startSseProvider(async (body, index) => {
      assert.equal(body.stream, true);
      assert.ok(body.tools.some((tool) => tool.function?.name === 'workspace_read'));
      if (index === 1) return toolCompletion('test-model', 'note.txt');
      if (index === 2) {
        const toolMessage = body.messages.find((message) => message.role === 'tool');
        assert.match(toolMessage.content, new RegExp(fileContent));
        return textCompletion('test-model', '文件内容是：项目方向已确认', 'chatcmpl-final-1');
      }
      assert.ok(body.messages.some((message) => message.role === 'tool'), 'restart must replay the tool result');
      return textCompletion('test-model', '重启后仍可继续使用已保存的对话上下文', 'chatcmpl-final-2');
    });
    const runtime = await createRuntime({ dataDir: dir, workspaceRoot: workspace, workspaceControlToken: 'test-main-process-capability' });
    runtimes.push(runtime);
    await configureRuntime(runtime, provider.baseUrl);
    await authorizeWorkspace(runtime, workspace);
    const first = await runtime.handle('chat.send', { text: prompt, modelCredential: { apiKey: key } });
    assert.equal(first.ok, true);
    assert.equal(first.result.assistant.content, '文件内容是：项目方向已确认');
    assert.equal(first.result.toolExecutions[0].name, 'workspace_read');
    await runtime.close();

    const transcript = JSON.parse(await readFile(join(dir, 'pi-transcript.json'), 'utf8'));
    assert.ok(transcript.messages.some((message) => message.role === 'assistant' && message.content.some((part) => part.type === 'toolCall')));
    assert.ok(transcript.messages.some((message) => message.role === 'toolResult'));

    const restarted = await createRuntime({ dataDir: dir, workspaceRoot: workspace, workspaceControlToken: 'test-main-process-capability' });
    runtimes.push(restarted);
    const second = await restarted.handle('chat.send', { text: '继续刚才的对话', modelCredential: { apiKey: key } });
    assert.equal(second.ok, true);
    assert.match(second.result.assistant.content, /重启后/);
    const log = await readFile(join(dir, 'logs', 'runtime.jsonl'), 'utf8');
    assert.doesNotMatch(log, new RegExp(`${key}|${prompt}|${fileContent}`));
  } finally {
    for (const runtime of runtimes) await runtime.close();
    await provider?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Pi Agent returns a Harness denial for an escaped workspace path without reading outside content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-agent-tool-denial-'));
  const workspace = join(dir, 'workspace');
  const outside = join(dir, 'outside.txt');
  const outsideSecret = 'outside-secret-must-not-leak';
  await mkdir(workspace, { recursive: true });
  await writeFile(outside, outsideSecret);
  const key = 'denial-test-api-key';
  let provider;
  let runtime;
  try {
    provider = await startSseProvider(async (_body, index) => index === 1
      ? toolCompletion('test-model', '../outside.txt', 'chatcmpl-denial-tool')
      : textCompletion('test-model', '已拒绝读取未授权路径。', 'chatcmpl-denial-final'));
    runtime = await createRuntime({ dataDir: dir, workspaceRoot: workspace, workspaceControlToken: 'test-main-process-capability' });
    await configureRuntime(runtime, provider.baseUrl);
    await authorizeWorkspace(runtime, workspace);
    const result = await runtime.handle('chat.send', { text: '请读取工作区外的文件', modelCredential: { apiKey: key } });
    assert.equal(result.ok, true);
    assert.equal(result.result.assistant.content, '已拒绝读取未授权路径。');
    assert.equal(result.result.toolExecutions[0].status, 'failed');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(outsideSecret));
    const transcript = await readFile(join(dir, 'pi-transcript.json'), 'utf8');
    assert.doesNotMatch(transcript, new RegExp(outsideSecret));
    const log = await readFile(join(dir, 'logs', 'runtime.jsonl'), 'utf8');
    assert.doesNotMatch(log, new RegExp(`${key}|请读取工作区外的文件|${outsideSecret}`));
  } finally {
    await runtime?.close();
    await provider?.close();
    await rm(dir, { recursive: true, force: true });
  }
});


test('a mirror write failure after a successful turn preserves the committed conversation across restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-conversation-mirror-failure-'));
  let provider;
  let runtime;
  try {
    provider = await startSseProvider(async (_body, index) => textCompletion('test-model', `reply-${index}`));
    runtime = await createRuntime({ dataDir: dir });
    await configureRuntime(runtime, provider.baseUrl);
    const mirror = join(dir, 'pi-transcript.json');
    const uiMirror = join(dir, 'conversation.json');
    for (const path of [mirror, uiMirror]) {
      await rm(path, { force: true });
      await mkdir(path);
    }
    const first = await runtime.handle('chat.send', { text: 'first question', modelCredential: { apiKey: 'test-key' } });
    assert.equal(first.ok, true);
    assert.deepEqual((await runtime.handle('conversation.list')).result.messages.map((message) => message.content), ['first question', 'reply-1']);
    await runtime.close();
    await rm(mirror, { recursive: true, force: true });
    await rm(uiMirror, { recursive: true, force: true });
    runtime = await createRuntime({ dataDir: dir });
    assert.deepEqual((await runtime.handle('conversation.list')).result.messages.map((message) => message.content), ['first question', 'reply-1']);
    assert.deepEqual(JSON.parse(await readFile(uiMirror, 'utf8')).map((message) => message.content), ['first question', 'reply-1']);
    const second = await runtime.handle('chat.send', { text: 'second question', modelCredential: { apiKey: 'test-key' } });
    assert.equal(second.ok, true);
    assert.match(JSON.stringify(provider.requests[1].messages), /first question/);
    assert.match(JSON.stringify(provider.requests[1].messages), /reply-1/);
    const mirrored = JSON.parse(await readFile(mirror, 'utf8')).messages;
    assert.equal(mirrored.filter((message) => ['user', 'assistant'].includes(message.role)).length, 4);
    assert.ok(mirrored.some((message) => message.role === 'system' && message.toolsAdded?.some((tool) => tool.name === 'plugin_save_draft')));
  } finally { await runtime?.close(); await provider?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a failed atomic conversation commit leaves neither UI messages nor Pi context from the turn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-conversation-commit-failure-'));
  let provider;
  let runtime;
  try {
    provider = await startSseProvider(async (_body, index) => textCompletion('test-model', `reply-${index}`));
    runtime = await createRuntime({ dataDir: dir });
    await configureRuntime(runtime, provider.baseUrl);
    runtime.store.db.exec(`
      CREATE TABLE commit_parent(id INTEGER PRIMARY KEY);
      CREATE TABLE commit_child(parent_id INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER fail_conversation_commit AFTER INSERT ON meta WHEN NEW.key = 'conversation_state_v1'
      BEGIN INSERT INTO commit_child VALUES (1); END;
    `);
    const before = runtime.store.getMeta('conversation_state_v1');
    const failed = await runtime.handle('chat.send', { text: 'must roll back', modelCredential: { apiKey: 'test-key' } });
    assert.equal(failed.ok, false);
    assert.equal(runtime.store.getMeta('conversation_state_v1'), before);
    assert.equal(runtime.store.db.prepare('SELECT count(*) AS count FROM commit_child').get().count, 0);
    runtime.store.db.exec('DROP TRIGGER fail_conversation_commit');
    assert.deepEqual((await runtime.handle('conversation.list')).result.messages, []);
    await runtime.close();
    runtime = await createRuntime({ dataDir: dir });
    assert.deepEqual((await runtime.handle('conversation.list')).result.messages, []);
    const next = await runtime.handle('chat.send', { text: 'next question', modelCredential: { apiKey: 'test-key' } });
    assert.equal(next.ok, true);
    assert.doesNotMatch(JSON.stringify(provider.requests[1].messages), /must roll back|reply-1/);
  } finally { await runtime?.close(); await provider?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a provider failure does not contaminate later model context or persist its error body', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-conversation-failed-turn-'));
  const secret = 'provider-error-secret';
  let provider;
  let runtime;
  try {
    provider = await startSseProvider(async (_body, index) => {
      if (index === 2) throw Error(secret);
      return textCompletion('test-model', index === 1 ? 'prior reply' : 'safe reply');
    });
    runtime = await createRuntime({ dataDir: dir });
    await configureRuntime(runtime, provider.baseUrl);
    const prior = await runtime.handle('chat.send', { text: 'prior question', modelCredential: { apiKey: 'test-key' } });
    assert.equal(prior.ok, true);
    const failed = await runtime.handle('chat.send', { text: 'failed question', modelCredential: { apiKey: 'test-key' } });
    assert.equal(failed.ok, false);
    await runtime.close();
    runtime = await createRuntime({ dataDir: dir });
    const next = await runtime.handle('chat.send', { text: 'successful question', modelCredential: { apiKey: 'test-key' } });
    assert.equal(next.ok, true);
    const resumedMessages = JSON.stringify(provider.requests[2].messages);
    assert.match(resumedMessages, /prior question/);
    assert.match(resumedMessages, /prior reply/);
    assert.doesNotMatch(resumedMessages, /failed question|provider-error-secret/);
    const history = (await runtime.handle('conversation.list')).result.messages;
    assert.equal(history.filter((message) => message.content === 'failed question').length, 1);
    assert.equal(history.find((message) => message.content === 'failed question').modelConversation, false);
    const transcript = await readFile(join(dir, 'pi-transcript.json'), 'utf8');
    assert.doesNotMatch(transcript, /failed question|provider-error-secret/);
    assert.doesNotMatch(runtime.store.getMeta('conversation_state_v1'), /provider-error-secret/);
  } finally { await runtime?.close(); await provider?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('legacy array transcript migration preserves matching turns and drops an orphaned turn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-conversation-legacy-migration-'));
  let provider;
  let runtime;
  try {
    provider = await startSseProvider(async (_body, index) => textCompletion('test-model', `reply-${index}`));
    runtime = await createRuntime({ dataDir: dir });
    await configureRuntime(runtime, provider.baseUrl);
    assert.equal((await runtime.handle('chat.send', { text: 'legacy question', modelCredential: { apiKey: 'test-key' } })).ok, true);
    const legacyTranscript = JSON.parse(await readFile(join(dir, 'pi-transcript.json'), 'utf8')).messages;
    const orphan = structuredClone(legacyTranscript[0]);
    orphan.content = [{ type: 'text', text: 'orphaned prompt' }];
    runtime.store.db.prepare('DELETE FROM meta WHERE key = ?').run('conversation_state_v1');
    await runtime.close();
    await writeFile(join(dir, 'pi-transcript.json'), JSON.stringify([...legacyTranscript, orphan]));
    runtime = await createRuntime({ dataDir: dir });
    assert.deepEqual((await runtime.handle('conversation.list')).result.messages.map((message) => message.content), ['legacy question', 'reply-1']);
    const migrated = runtime.store.getMeta('conversation_state_v1');
    assert.match(migrated, /legacy question|reply-1/);
    assert.doesNotMatch(migrated, /orphaned prompt/);
    const next = await runtime.handle('chat.send', { text: 'after migration', modelCredential: { apiKey: 'test-key' } });
    assert.equal(next.ok, true);
    const sent = JSON.stringify(provider.requests[1].messages);
    assert.doesNotMatch(sent, /legacy question|reply-1/);
    assert.doesNotMatch(sent, /orphaned prompt/);
  } finally { await runtime?.close(); await provider?.close(); await rm(dir, { recursive: true, force: true }); }
});


test('legacy UI messages without a matching transcript remain visible but are not replayed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-conversation-legacy-partial-'));
  let provider;
  let runtime;
  try {
    provider = await startSseProvider(async (_body, index) => textCompletion('test-model', `reply-${index}`));
    runtime = await createRuntime({ dataDir: dir });
    await configureRuntime(runtime, provider.baseUrl);
    assert.equal((await runtime.handle('chat.send', { text: 'partial legacy question', modelCredential: { apiKey: 'test-key' } })).ok, true);
    const legacyMessages = JSON.parse(await readFile(join(dir, 'conversation.json'), 'utf8'));
    runtime.store.db.prepare('DELETE FROM meta WHERE key = ?').run('conversation_state_v1');
    await runtime.close();
    await writeFile(join(dir, 'conversation.json'), JSON.stringify([legacyMessages[0]]));
    runtime = await createRuntime({ dataDir: dir });
    const history = (await runtime.handle('conversation.list')).result.messages;
    assert.equal(history[0].content, 'partial legacy question');
    assert.equal(history[0].modelConversation, false);
    assert.equal(history[0].modelErrorCode, 'legacy_history_unverified');
    const next = await runtime.handle('chat.send', { text: 'new question', modelCredential: { apiKey: 'test-key' } });
    assert.equal(next.ok, true);
    assert.doesNotMatch(JSON.stringify(provider.requests[1].messages), /partial legacy question|reply-1/);
  } finally { await runtime?.close(); await provider?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('concurrent runtimes reject a stale model turn without losing the committed conversation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-conversation-conflict-'));
  let releaseFirst;
  let firstStarted;
  const firstRequestStarted = new Promise((resolve) => { firstStarted = resolve; });
  const firstRequestGate = new Promise((resolve) => { releaseFirst = resolve; });
  let provider;
  let firstRuntime;
  let secondRuntime;
  try {
    provider = await startSseProvider(async (body) => {
      const content = JSON.stringify(body.messages);
      if (content.includes('slow question')) {
        firstStarted();
        await firstRequestGate;
        return textCompletion('test-model', 'slow answer');
      }
      return textCompletion('test-model', 'fast answer');
    });
    firstRuntime = await createRuntime({ dataDir: dir });
    await configureRuntime(firstRuntime, provider.baseUrl);
    secondRuntime = await createRuntime({ dataDir: dir });
    const slow = firstRuntime.handle('chat.send', { text: 'slow question', modelCredential: { apiKey: 'test-key' } });
    await firstRequestStarted;
    const fast = await secondRuntime.handle('chat.send', { text: 'fast question', modelCredential: { apiKey: 'test-key' } });
    assert.equal(fast.ok, true);
    releaseFirst();
    const conflict = await slow;
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error.code, 'conversation_conflict');
    assert.deepEqual((await firstRuntime.handle('conversation.list')).result.messages.map((message) => message.content), ['fast question', 'fast answer']);
    await firstRuntime.close();
    await secondRuntime.close();
    firstRuntime = await createRuntime({ dataDir: dir });
    assert.deepEqual((await firstRuntime.handle('conversation.list')).result.messages.map((message) => message.content), ['fast question', 'fast answer']);
  } finally {
    releaseFirst();
    await firstRuntime?.close();
    await secondRuntime?.close();
    await provider?.close();
    await rm(dir, { recursive: true, force: true });
  }
});


test('legacy failed turns and provider error bodies are excluded during migration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-conversation-legacy-failure-'));
  let provider;
  let runtime;
  try {
    provider = await startSseProvider(async (_body, index) => textCompletion('test-model', `reply-${index}`));
    runtime = await createRuntime({ dataDir: dir });
    await configureRuntime(runtime, provider.baseUrl);
    assert.equal((await runtime.handle('chat.send', { text: 'valid legacy question', modelCredential: { apiKey: 'test-key' } })).ok, true);
    const transcript = JSON.parse(await readFile(join(dir, 'pi-transcript.json'), 'utf8'));
    const badUser = structuredClone(transcript.messages[0]);
    badUser.content = [{ type: 'text', text: 'legacy failed question' }];
    const badAssistant = structuredClone(transcript.messages[1]);
    badAssistant.stopReason = 'error';
    badAssistant.errorMessage = 'legacy-provider-secret';
    runtime.store.db.prepare('DELETE FROM meta WHERE key = ?').run('conversation_state_v1');
    await runtime.close();
    await writeFile(join(dir, 'pi-transcript.json'), JSON.stringify({ version: 1, messages: [badUser, badAssistant, ...transcript.messages] }));
    runtime = await createRuntime({ dataDir: dir });
    assert.doesNotMatch(runtime.store.getMeta('conversation_state_v1'), /legacy-provider-secret|legacy failed question/);
    const next = await runtime.handle('chat.send', { text: 'new question', modelCredential: { apiKey: 'test-key' } });
    assert.equal(next.ok, true);
    const sent = JSON.stringify(provider.requests[1].messages);
    assert.doesNotMatch(sent, /valid legacy question|reply-1/);
    assert.doesNotMatch(sent, /legacy-provider-secret|legacy failed question/);
  } finally { await runtime?.close(); await provider?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a corrupt legacy transcript fails migration without replacing legacy files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-conversation-corrupt-legacy-'));
  const history = JSON.stringify([{ id: 'legacy', role: 'user', content: 'keep this message' }]);
  const transcript = '{invalid json';
  try {
    await writeFile(join(dir, 'conversation.json'), history);
    await writeFile(join(dir, 'pi-transcript.json'), transcript);
    await assert.rejects(createRuntime({ dataDir: dir }), SyntaxError);
    assert.equal(await readFile(join(dir, 'conversation.json'), 'utf8'), history);
    assert.equal(await readFile(join(dir, 'pi-transcript.json'), 'utf8'), transcript);
    await writeFile(join(dir, 'pi-transcript.json'), '[]');
    const runtime = await createRuntime({ dataDir: dir });
    try { assert.equal((await runtime.handle('conversation.list')).result.messages[0].content, 'keep this message'); }
    finally { await runtime.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('model context is isolated after provider endpoint or model changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-context-isolation-'));
  let first, second, runtime;
  try {
    first = await startSseProvider(async () => textCompletion('test-model', 'first answer'));
    second = await startSseProvider(async () => textCompletion('test-model', 'second answer'));
    runtime = await createRuntime({ dataDir: dir });
    await configureRuntime(runtime, first.baseUrl);
    assert.equal((await runtime.handle('chat.send', { text: 'private first question', modelCredential: { apiKey: 'test-key' } })).ok, true);
    await configureRuntime(runtime, second.baseUrl);
    assert.equal((await runtime.handle('chat.send', { text: 'second question', modelCredential: { apiKey: 'test-key' } })).ok, true);
    assert.doesNotMatch(JSON.stringify(second.requests[0]), /private first question|first answer/);
    await runtime.handle('settings.update', { setting: { id: 'default', provider: 'openai-compatible', model: 'another-model', baseUrl: second.baseUrl } });
    assert.equal((await runtime.handle('chat.send', { text: 'third question', modelCredential: { apiKey: 'test-key' } })).ok, true);
    assert.doesNotMatch(JSON.stringify(second.requests[1]), /second question|second answer/);
    assert.equal((await runtime.handle('conversation.list')).result.messages.length, 6);
  } finally { await runtime?.close(); await first?.close(); await second?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('provider echoed API key is redacted in reply and stored tool transcript without breaking tool links', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-redact-response-'));
  const workspace = join(dir, 'workspace');
  const key = 'sensitive-provider-key-123';
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, `note-${key}.txt`), 'safe file');
  let provider, runtime;
  try {
    provider = await startSseProvider(async (_body, index) => index === 1 ? toolCompletion('test-model', `note-${key}.txt`) : textCompletion('test-model', `echo ${key} done`));
    runtime = await createRuntime({ dataDir: dir, workspaceRoot: workspace, workspaceControlToken: 'test-main-process-capability' });
    await authorizeWorkspace(runtime, workspace);
    await configureRuntime(runtime, provider.baseUrl);
    const result = await runtime.handle('chat.send', { text: 'read file', modelCredential: { apiKey: key } });
    assert.equal(result.ok, true);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(key));
    const state = JSON.parse(runtime.store.getMeta('conversation_state_v1'));
    assert.doesNotMatch(JSON.stringify(state), new RegExp(key));
    assert.doesNotMatch(await readFile(join(dir, 'conversation.json'), 'utf8'), new RegExp(key));
    assert.doesNotMatch(await readFile(join(dir, 'pi-transcript.json'), 'utf8'), new RegExp(key));
    const call = state.transcript.find((message) => message.role === 'assistant' && message.content.some((part) => part.type === 'toolCall')).content.find((part) => part.type === 'toolCall');
    const tool = state.transcript.find((message) => message.role === 'toolResult');
    assert.equal(call.id, tool.toolCallId);
    assert.equal(typeof call.arguments, 'object');
    assert.match(call.arguments.path, /\[REDACTED\]/);
    assert.equal((await runtime.handle('chat.send', { text: 'continue', modelCredential: { apiKey: key } })).ok, true);
    const replay = provider.requests[2].messages;
    assert.doesNotMatch(JSON.stringify(replay), new RegExp(key));
    const replayCall = replay.find((message) => message.tool_calls?.length).tool_calls[0];
    assert.ok(replay.some((message) => message.role === 'tool' && message.tool_call_id === replayCall.id));
    for (const name of ['agent.sqlite', 'agent.sqlite-wal']) {
      try { assert.equal((await readFile(join(dir, name))).includes(Buffer.from(key)), false); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  } finally { await runtime?.close(); await provider?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('legacy unmarked messages are flagged while task proposal pairs retain their meaning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-legacy-unverified-'));
  let runtime;
  try {
    await writeFile(join(dir, 'conversation.json'), JSON.stringify([
      { id: 'chat-u', role: 'user', content: 'old chat' },
      { id: 'chat-a', role: 'assistant', content: 'old response' },
      { id: 'task-u', role: 'user', content: 'old task' },
      { id: 'task-a', role: 'assistant', content: 'task proposal', taskId: 'task-1' }
    ]));
    runtime = await createRuntime({ dataDir: dir });
    const messages = (await runtime.handle('conversation.list')).result.messages;
    assert.equal(messages[0].modelErrorCode, 'legacy_history_unverified');
    assert.equal(messages[1].modelErrorCode, 'legacy_history_unverified');
    assert.equal(messages[2].modelErrorCode, undefined);
    assert.equal(messages[3].taskId, 'task-1');
  } finally { await runtime?.close(); await rm(dir, { recursive: true, force: true }); }
});


test('pre-existing SQLite conversation without provider identity never replays transcript', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-sqlite-legacy-context-'));
  let provider, runtime;
  try {
    provider = await startSseProvider(async (_body, index) => textCompletion('test-model', `answer-${index}`));
    runtime = await createRuntime({ dataDir: dir });
    await configureRuntime(runtime, provider.baseUrl);
    assert.equal((await runtime.handle('chat.send', { text: 'sqlite old question', modelCredential: { apiKey: 'test-key' } })).ok, true);
    const oldState = JSON.parse(runtime.store.getMeta('conversation_state_v1'));
    delete oldState.contextId;
    delete oldState.historyVerificationVersion;
    runtime.store.setMeta('conversation_state_v1', JSON.stringify(oldState));
    await runtime.close();
    runtime = await createRuntime({ dataDir: dir });
    assert.deepEqual((await runtime.handle('conversation.list')).result.messages.map((message) => message.content), ['sqlite old question', 'answer-1']);
    assert.equal((await runtime.handle('chat.send', { text: 'new sqlite question', modelCredential: { apiKey: 'test-key' } })).ok, true);
    assert.doesNotMatch(JSON.stringify(provider.requests[1]), /sqlite old question|answer-1/);
  } finally { await runtime?.close(); await provider?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a settings change during a request rejects the stale result and preserves the new context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-settings-concurrent-'));
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const requestStarted = new Promise((resolve) => { started = resolve; });
  let first, second, runtime;
  try {
    first = await startSseProvider(async () => { started(); await gate; return textCompletion('test-model', 'stale answer'); });
    second = await startSseProvider(async () => textCompletion('test-model', 'new answer'));
    runtime = await createRuntime({ dataDir: dir });
    await configureRuntime(runtime, first.baseUrl);
    const pending = runtime.handle('chat.send', { text: 'old question', modelCredential: { apiKey: 'test-key' } });
    await requestStarted;
    await configureRuntime(runtime, second.baseUrl);
    release();
    const stale = await pending;
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, 'conversation_conflict');
    const fresh = await runtime.handle('chat.send', { text: 'new question', modelCredential: { apiKey: 'test-key' } });
    assert.equal(fresh.ok, true);
    assert.doesNotMatch(JSON.stringify(second.requests[0]), /old question|stale answer/);
    assert.deepEqual((await runtime.handle('conversation.list')).result.messages.map((message) => message.content), ['new question', 'new answer']);
  } finally { release(); await runtime?.close(); await first?.close(); await second?.close(); await rm(dir, { recursive: true, force: true }); }
});


test('credential redaction also covers provider tool argument property names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-redact-argument-key-'));
  const key = 'credential-in-property-123';
  let provider, runtime;
  try {
    provider = await startSseProvider(async (_body, index) => {
      if (index !== 1) return textCompletion('test-model', 'done');
      const chunks = toolCompletion('test-model', 'missing.txt');
      chunks[0].choices[0].delta.tool_calls[0].function.arguments = JSON.stringify({ path: 'missing.txt', [key]: 'echo' });
      return chunks;
    });
    runtime = await createRuntime({ dataDir: dir, workspaceControlToken: 'test-main-process-capability' });
    await authorizeWorkspace(runtime, join(dir, 'workspace'));
    await configureRuntime(runtime, provider.baseUrl);
    const result = await runtime.handle('chat.send', { text: 'read', modelCredential: { apiKey: key } });
    assert.equal(result.ok, true);
    assert.doesNotMatch(runtime.store.getMeta('conversation_state_v1'), new RegExp(key));
  } finally { await runtime?.close(); await provider?.close(); await rm(dir, { recursive: true, force: true }); }
});


test('Pi Agent sends an approved MCP tool to the model and returns its tool result in the transcript', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'pi-mcp-agent-workspace-'));
  const mcpResults = [];
  const mcpTools = createMcpPiTools({
    serverId: 'research',
    tools: [{ name: 'lookup', description: 'Untrusted external lookup tool', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, enabled: true }],
    authorize: async () => true,
    callTool: async (_serverId, _toolName, args) => {
      mcpResults.push(args);
      return { content: [{ type: 'text', text: `external:${args.query}` }] };
    }
  });
  let provider;
  try {
    provider = await startSseProvider(async (body, index) => {
      if (index === 1) {
        assert.ok(body.tools.some((tool) => tool.function?.name === 'mcp_research_lookup'));
        return namedToolCompletion('test-model', 'mcp_research_lookup', { query: 'hello' });
      }
      assert.ok(body.messages.some((message) => message.role === 'tool' && message.content.includes('external:hello')));
      return textCompletion('test-model', 'MCP 结果已返回。', 'chatcmpl-mcp-final');
    });
    const result = await runPiAgentTurn({
      setting: { id: 'default', provider: 'openai-compatible', model: 'test-model', baseUrl: provider.baseUrl, apiFormat: 'chat-completions' },
      apiKey: 'test-key', text: '调用 MCP 查询', workspaceRoot,
      workspaceAuthorized: false, mcpTools
    });
    assert.equal(result.content, 'MCP 结果已返回。');
    assert.deepEqual(mcpResults, [{ query: 'hello' }]);
    assert.ok(result.transcript.some((message) => message.role === 'toolResult' && JSON.stringify(message).includes('external:hello')));
  } finally {
    await provider?.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});


test('Runtime Pi creates and tests a local plugin, user confirms it, Pi calls it, and revocation removes it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-plugin-conversation-'));
  const definition = { id: 'text_stats', name: '文本统计', description: '统计字符数', source: '(input) => ({ length: input.text.length })', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, tests: [{ name: 'three', input: { text: 'abc' }, expected: { length: 3 } }] };
  let provider, runtime;
  try {
    provider = await startSseProvider(async (body, index) => {
      const names = (body.tools ?? []).map((t) => t.function.name);
      assert.ok(!names.includes('plugins.set_enabled'));
      if (index === 1) {
        assert.ok(names.includes('plugin_save_draft'));
        assert.ok(!names.includes('plugin_text_stats_v1'));
        return namedToolCompletion('test-model', 'plugin_save_draft', { definition });
      }
      if (index === 2) return namedToolCompletion('test-model', 'plugin_test', { id: 'text_stats', version: 1 }, 'test-plugin');
      if (index === 3) {
        assert.ok(body.messages.some((m) => m.role === 'tool' && m.content.includes('passed')));
        return textCompletion('test-model', '草稿测试通过，请在插件面板审核确认。');
      }
      if (index === 4) {
        assert.ok(names.includes('plugin_text_stats_v1'));
        assert.equal(body.messages.filter((m) => m.role === 'user').length, 1);
        return namedToolCompletion('test-model', 'plugin_text_stats_v1', { text: 'hello' }, 'run-plugin');
      }
      if (index === 5) {
        assert.ok(body.messages.some((m) => m.role === 'tool' && m.content.includes('5')));
        return textCompletion('test-model', '字符数为 5。');
      }
      assert.ok(!names.includes('plugin_text_stats_v1'));
      return textCompletion('test-model', '插件已停用。');
    });
    runtime = await createRuntime({ dataDir: dir });
    await configureRuntime(runtime, provider.baseUrl);
    const chat = (text) => runtime.handle('chat.send', { text, modelCredential: { apiKey: 'isolated-plugin-test-key' } });
    const draftReply = await chat('创建并测试字符统计插件');
    assert.equal(draftReply.ok, true, JSON.stringify(draftReply));
    assert.equal(draftReply.result.toolExecutions.length, 2);
    const detail = await runtime.handle('plugins.get', { id: 'text_stats' });
    assert.equal(detail.result.plugin.enabled, false);
    assert.equal(detail.result.plugin.tests[0].status, 'passed');
    assert.equal((await runtime.handle('plugins.set_enabled', { id: 'text_stats', version: 1, enabled: true })).error.code, 'plugin_confirmation_required');
    const enabled = await runtime.handle('plugins.set_enabled', { id: 'text_stats', version: 1, enabled: true, confirm: true });
    assert.equal(enabled.ok, true, JSON.stringify(enabled));
    const result = await chat('调用插件处理 hello');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result.toolExecutions[0].name, 'plugin_text_stats_v1');
    await runtime.handle('plugins.set_enabled', { id: 'text_stats', version: 1, enabled: false });
    assert.equal((await runtime.handle('plugins.run', { id: 'text_stats', version: 1, arguments: { text: 'abc' } })).error.code, 'plugin_not_enabled');
    assert.equal((await chat('还能调用吗')).ok, true);
    await runtime.close();
    runtime = await createRuntime({ dataDir: dir });
    assert.equal((await runtime.handle('plugins.list')).result.plugins[0].enabled, false);
    assert.equal((await runtime.handle('plugins.get', { id: 'text_stats' })).result.plugin.tests[0].status, 'passed');
    const logs = await readFile(join(dir, 'logs/runtime.jsonl'), 'utf8');
    assert.doesNotMatch(logs, /isolated-plugin-test-key|input\.text|统计字符数/);
  } finally { await runtime?.close(); await provider?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('default model deadline allows slower providers without extending MCP deadlines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-model-deadline-'));
  let runtime;
  try {
    runtime = await createRuntime({ dataDir: dir });
    assert.equal(runtime.modelTimeoutMs, 90_000);
    assert.equal(runtime.modelClient.timeoutMs, 90_000);
    assert.equal(runtime.mcp.manager.timeoutMs, 10_000);
  } finally {
    await runtime?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
