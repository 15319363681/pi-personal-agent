import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../src/runtime.mjs';

function sseResponse(chunks) {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function completionChunk(model, content, finishReason = null) {
  return { id: 'chatcmpl-test', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: content === null ? {} : { role: 'assistant', content }, finish_reason: finishReason }] };
}

test('model connection test and chat use the selected provider and report real usage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-model-flow-'));
  await writeFile(join(dir, 'conversation.json'), JSON.stringify([{ id: 'legacy', role: 'user', content: 'legacy leaked key: old-chat-secret-value' }, { id: 'old-reply', role: 'assistant', content: 'static old response' }]));
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    if (options.body && JSON.parse(options.body).stream) {
      return sseResponse([
        completionChunk('example-model', '来自 Pi Agent 与 SSE Provider 的回答'),
        completionChunk('example-model', null, 'stop'),
        { id: 'chatcmpl-test', object: 'chat.completion.chunk', model: 'example-model', choices: [], usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 } }
      ]);
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: '连接成功' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200 });
  };
  const runtime = await createRuntime({ dataDir: dir, fetchImpl });
  try {
    const setting = await runtime.handle('settings.update', { setting: { id: 'default', provider: 'openai-compatible', model: 'example-model', baseUrl: 'https://model.example/v1' } });
    assert.equal(setting.ok, true);
    const testResult = await runtime.handle('settings.test', { settingId: 'default', apiKey: 'fresh-local-key' });
    assert.equal(testResult.ok, true);
    assert.equal(testResult.result.status, 'connected');
    const reply = await runtime.handle('chat.send', { text: '回答我', modelCredential: { apiKey: 'fresh-local-key' } });
    assert.equal(reply.ok, true);
    assert.equal(reply.result.assistant.content, '来自 Pi Agent 与 SSE Provider 的回答');
    assert.equal(typeof reply.result.correlationId, 'string');
    assert.deepEqual(reply.result.usage, { inputTokens: 8, outputTokens: 5, totalTokens: 13, costStatus: 'unknown' });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, 'https://model.example/v1/chat/completions');
    assert.equal(calls[1].options.headers.get('authorization'), 'Bearer fresh-local-key');
    assert.deepEqual(calls[1].body.messages.at(-1).content, [{ type: 'text', text: '回答我' }]);
    assert.equal(JSON.stringify(calls[1].body.messages).includes('old-chat-secret-value'), false);
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});

test('model timeout returns an unknown usage status and logs no credential or prompt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-model-timeout-'));
  const runtime = await createRuntime({ dataDir: dir, modelTimeoutMs: 10, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) });
  try {
    await runtime.handle('settings.update', { setting: { id: 'default', provider: 'openai-compatible', model: 'example-model', baseUrl: 'https://model.example/v1' } });
    const result = await runtime.handle('chat.send', { text: 'private prompt text', modelCredential: { apiKey: 'fresh-secret-value' } });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'model_timeout');
    assert.equal(result.error.usageStatus, 'unknown');
    const log = await (await import('node:fs/promises')).readFile(join(dir, 'logs', 'runtime.jsonl'), 'utf8');
    assert.doesNotMatch(log, /private prompt text|fresh-secret-value|authorization/i);
    assert.match(log, /model\.error/);
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});

test('Pi requests reject redirects and do not persist provider error bodies containing credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-model-provider-error-'));
  const secret = 'provider-echoed-secret';
  let requestOptions;
  const runtime = await createRuntime({ dataDir: dir, fetchImpl: async (_url, options) => {
    requestOptions = options;
    return new Response(JSON.stringify({ error: { message: `invalid credential ${secret}` } }), {
      status: 401, headers: { 'content-type': 'application/json' }
    });
  } });
  try {
    await runtime.handle('settings.update', { setting: { id: 'default', provider: 'openai-compatible', model: 'example-model', baseUrl: 'https://model.example/v1' } });
    const result = await runtime.handle('chat.send', { text: 'hello', modelCredential: { apiKey: secret } });
    assert.equal(result.ok, false);
    assert.equal(requestOptions.redirect, 'error');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
    const transcript = await (await import('node:fs/promises')).readFile(join(dir, 'pi-transcript.json'), 'utf8');
    assert.doesNotMatch(transcript, new RegExp(secret));
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});

test('model client rejects plaintext remote endpoints before sending credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-model-plaintext-endpoint-'));
  let calls = 0;
  const runtime = await createRuntime({ dataDir: dir, fetchImpl: async () => { calls++; throw new Error('must not reach network'); } });
  try {
    await runtime.handle('settings.update', { setting: { id: 'default', provider: 'openai-compatible', model: 'm', baseUrl: 'http://model.example/v1' } });
    const result = await runtime.handle('settings.test', { settingId: 'default', apiKey: 'new-secret' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'model_endpoint_must_use_https');
    assert.equal(calls, 0);
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});

test('Responses API sends only the current input, disables provider storage and maps usage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-model-responses-'));
  let request;
  const runtime = await createRuntime({ dataDir: dir, fetchImpl: async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    const message = { id: 'msg_test', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Responses API reply', annotations: [] }] };
    return sseResponse([
      { type: 'response.created', response: { id: 'resp_test', status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_test', type: 'message', role: 'assistant', status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', item_id: 'msg_test', output_index: 0, content_index: 0, delta: 'Responses API reply' },
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.completed', response: { id: 'resp_test', status: 'completed', output: [message], usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 } } }
    ]);
  } });
  try {
    await runtime.handle('settings.update', { setting: { id: 'default', provider: 'openai-responses', model: 'gpt-6.1-sol', baseUrl: 'https://provider.example/v1' } });
    const result = await runtime.handle('chat.send', { text: 'current question', modelCredential: { apiKey: 'fresh-local-key' } });
    assert.equal(result.ok, true);
    assert.equal(result.result.assistant.content, 'Responses API reply');
    assert.deepEqual(result.result.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18, costStatus: 'unknown' });
    assert.equal(request.url, 'https://provider.example/v1/responses');
    assert.equal(request.body.store, false);
    assert.deepEqual(request.body.input, [{ role: 'user', content: [{ type: 'input_text', text: 'current question' }] }]);
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});
