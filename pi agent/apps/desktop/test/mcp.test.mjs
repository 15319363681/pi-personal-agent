import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  McpManager,
  createMcpPiTools,
  mcpToolName,
  normalizeMcpServer,
  validateMcpServerUrl
} from '../src/runtime/mcp.mjs';
import { createRuntime } from '../src/runtime.mjs';

async function startMcpServer() {
  const httpServer = createServer(async (request, response) => {
    const server = new McpServer({ name: 'fixture', version: '1.0.0' });
    server.registerTool('lookup', {
      title: 'Fixture lookup',
      description: 'Returns a controlled value',
      inputSchema: { query: z.string() }
    }, async ({ query }) => ({ content: [{ type: 'text', text: `result:${query}` }] }));
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(request, response);
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  return { httpServer, url: `http://127.0.0.1:${httpServer.address().port}/mcp` };
}

test('MCP server URLs require HTTPS except loopback and reject credentials or redirect data', () => {
  assert.equal(validateMcpServerUrl('https://mcp.example.test/v1'), 'https://mcp.example.test/v1');
  assert.equal(validateMcpServerUrl('http://127.0.0.1:4321/mcp'), 'http://127.0.0.1:4321/mcp');
  for (const url of [
    'http://mcp.example.test/mcp',
    'https://user:secret@mcp.example.test/mcp',
    'https://mcp.example.test/mcp?token=secret',
    'https://mcp.example.test/mcp#fragment',
    'file:///tmp/mcp'
  ]) assert.throws(() => validateMcpServerUrl(url), { code: 'mcp_server_url_invalid' });
});

test('MCP server definitions reject unsupported fields and never accept a credential value', () => {
  assert.deepEqual(normalizeMcpServer({ id: 'research', name: 'Research', url: 'https://mcp.example.test/mcp', credentialRef: 'opaque-ref' }), {
    id: 'research', name: 'Research', url: 'https://mcp.example.test/mcp', credentialRef: 'opaque-ref', enabled: true
  });
  assert.throws(() => normalizeMcpServer({ id: 'research', name: 'Research', url: 'https://mcp.example.test/mcp', token: 'secret' }), { code: 'mcp_server_invalid' });
});

test('MCP tool names are stable, bounded and distinct for different server IDs', () => {
  assert.equal(mcpToolName('research', 'lookup'), 'mcp_research_lookup');
  assert.equal(mcpToolName('research', 'lookup'), mcpToolName('research', 'lookup'));
  assert.notEqual(mcpToolName('server-one', 'lookup'), mcpToolName('server-two', 'lookup'));
  assert.ok(mcpToolName('r'.repeat(120), 'x'.repeat(120)).length <= 64);
});

test('MCP tools are only exposed when enabled and re-check authorization at execution time', async () => {
  let permitted = true;
  let calls = 0;
  const tools = createMcpPiTools({
    serverId: 'research',
    tools: [{ name: 'lookup', description: 'Returns data', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, enabled: true }],
    authorize: async () => permitted,
    callTool: async (_serverId, _toolName, args) => { calls += 1; return { content: [{ type: 'text', text: `result:${args.query}` }] }; }
  });
  assert.equal(tools.length, 1);
  const success = await tools[0].execute('call-1', { query: 'hello' });
  assert.equal(success.content[0].text, 'result:hello');
  permitted = false;
  await assert.rejects(tools[0].execute('call-2', { query: 'blocked' }), { code: 'mcp_tool_not_authorized' });
  assert.equal(calls, 1);
  assert.deepEqual(createMcpPiTools({ serverId: 'research', tools: [{ name: 'private', inputSchema: {}, enabled: false }] }), []);
});

test('MCP tool results are text-only and capped before reaching Pi', async () => {
  const [tool] = createMcpPiTools({
    serverId: 'research',
    maxResultCharacters: 24,
    tools: [{ name: 'lookup', description: 'external description', inputSchema: { type: 'object' }, enabled: true }],
    authorize: async () => true,
    callTool: async () => ({ content: [{ type: 'text', text: '012345678901234567890123456789' }, { type: 'image', data: 'SECRET_IMAGE' }] })
  });
  const result = await tool.execute('call-1', {});
  assert.equal(result.content[0].text, '012345678901234567890123\n[结果已截断]');
  assert.doesNotMatch(JSON.stringify(result), /SECRET_IMAGE|external description/);
});

test('MCP manager uses the official Streamable HTTP client for a real local protocol round trip', async () => {
  const fixture = await startMcpServer();
  const manager = new McpManager({ timeoutMs: 3000 });
  try {
    const server = normalizeMcpServer({ id: 'fixture', name: 'Fixture', url: fixture.url, enabled: true });
    const tools = await manager.connect(server, null);
    assert.deepEqual(tools.map(({ name, enabled }) => ({ name, enabled })), [{ name: 'lookup', enabled: false }]);
    const result = await manager.callTool(server, 'lookup', { query: 'hello' }, null);
    assert.equal(result.content[0].text, 'result:hello');
  } finally {
    await manager.close();
    fixture.httpServer.closeAllConnections();
    await new Promise((resolve) => fixture.httpServer.close(resolve));
  }
});

test('Runtime persists MCP servers and tool approval while refusing unapproved calls and logging no inputs/results', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-runtime-mcp-'));
  const fixture = await startMcpServer();
  let runtime;
  try {
    runtime = await createRuntime({ dataDir: dir });
    const saved = await runtime.handle('mcp.server.save', { server: { id: 'fixture', name: 'Fixture', url: fixture.url, enabled: true } });
    assert.equal(saved.ok, true);
    assert.equal(Object.hasOwn(saved.result.server, 'token'), false);
    const discovered = await runtime.handle('mcp.server.connect', { id: 'fixture' });
    assert.equal(discovered.ok, true, JSON.stringify(discovered));
    assert.equal(discovered.result.tools[0].enabled, false);
    const unauthorized = await runtime.handle('mcp.tool.call', { serverId: 'fixture', name: 'lookup', arguments: { query: 'secret-input' } });
    assert.equal(unauthorized.ok, false);
    assert.equal((await runtime.handle('mcp.tool.set_enabled', { serverId: 'fixture', name: 'lookup', enabled: true })).ok, true);
    assert.equal((await runtime.handle('mcp.tool.call', { serverId: 'fixture', name: 'lookup', arguments: { query: 'hello' } })).result.content[0].text, 'result:hello');
    const logs = await readFile(join(dir, 'logs', 'runtime.jsonl'), 'utf8');
    assert.doesNotMatch(logs, /Bearer|secret-input|result:hello|Returns a controlled value/);
    await runtime.close();
    runtime = await createRuntime({ dataDir: dir });
    assert.equal((await runtime.handle('mcp.servers.list')).result.servers[0].tools[0].enabled, true);
    assert.equal((await runtime.handle('mcp.server.remove', { id: 'fixture' })).ok, true);
  } finally {
    await runtime?.close();
    fixture.httpServer.closeAllConnections();
    await new Promise((resolve) => fixture.httpServer.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
async function startAuthenticatedMcpServer() {
  const authorizationHeaders = [];
  const httpServer = createServer(async (request, response) => {
    authorizationHeaders.push(request.headers.authorization ?? null);
    const server = new McpServer({ name: 'authenticated-fixture', version: '1.0.0' });
    server.registerTool('lookup', {
      description: 'Authenticated test lookup',
      inputSchema: { query: z.string() }
    }, async ({ query }) => ({ content: [{ type: 'text', text: `private-result:${query}` }] }));
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(request, response);
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  return { httpServer, authorizationHeaders, url: `http://127.0.0.1:${httpServer.address().port}/mcp` };
}

function modelSseResponse(response, events) {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'close' });
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end('data: [DONE]\n\n');
}

test('Runtime Pi conversation uses the saved MCP bearer token and keeps it out of transcript and logs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-mcp-runtime-chat-'));
  const fixture = await startAuthenticatedMcpServer();
  const modelRequests = [];
  const provider = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    modelRequests.push(body);
    const id = `chatcmpl-mcp-${modelRequests.length}`;
    const model = body.model;
    if (modelRequests.length === 1) {
      modelSseResponse(response, [
        { id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-mcp', type: 'function', function: { name: 'mcp_fixture_lookup', arguments: JSON.stringify({ query: 'approved-query' }) } }] }, finish_reason: null }] },
        { id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
      ]);
      return;
    }
    assert.ok(body.messages.some((message) => message.role === 'tool' && message.content.includes('private-result:approved-query')));
    modelSseResponse(response, [
      { id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content: '查询已完成。' }, finish_reason: null }] },
      { id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
    ]);
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const providerUrl = `http://127.0.0.1:${provider.address().port}/v1`;
  let runtime;
  try {
    runtime = await createRuntime({ dataDir: directory });
    assert.equal((await runtime.handle('settings.update', { setting: {
      id: 'default', provider: 'openai-compatible', model: 'test-model', baseUrl: providerUrl, apiFormat: 'chat-completions'
    } })).ok, true);
    assert.equal((await runtime.handle('mcp.server.save', { server: {
      id: 'fixture', name: 'Authenticated fixture', url: fixture.url, enabled: true
    } })).ok, true);
    const discovered = await runtime.handle('mcp.server.connect', { id: 'fixture', mcpCredential: { token: 'mcp-bearer-secret' } });
    assert.equal(discovered.ok, true);
    assert.equal((await runtime.handle('mcp.tool.set_enabled', { serverId: 'fixture', name: 'lookup', enabled: true })).ok, true);

    const result = await runtime.handle('chat.send', {
      text: '查询已批准的远程工具',
      modelCredential: { apiKey: 'model-api-secret' },
      mcpCredentials: [{ serverId: 'fixture', token: 'mcp-bearer-secret' }]
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result.assistant.content, '查询已完成。');
    assert.deepEqual(fixture.authorizationHeaders.filter(Boolean).filter((value) => value.includes('mcp-bearer-secret')).length > 0, true);
    assert.ok(modelRequests[0].tools.some((tool) => tool.function?.name === 'mcp_fixture_lookup'));
    assert.ok(modelRequests[1].messages.some((message) => message.role === 'tool' && message.content.includes('private-result:approved-query')));

    const conversationState = runtime.store.getMeta('conversation_state_v1');
    const transcript = await readFile(join(directory, 'pi-transcript.json'), 'utf8');
    const logs = await readFile(join(directory, 'logs', 'runtime.jsonl'), 'utf8');
    for (const output of [JSON.stringify(result), conversationState, transcript, logs]) {
      assert.doesNotMatch(output, /mcp-bearer-secret|model-api-secret/);
    }
    assert.match(transcript, /private-result:approved-query/);

    await runtime.handle('mcp.tool.set_enabled', { serverId: 'fixture', name: 'lookup', enabled: false });
    const denied = await runtime.handle('mcp.tool.call', { serverId: 'fixture', name: 'lookup', arguments: { query: 'blocked' } });
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, 'mcp_tool_not_authorized');
  } finally {
    await runtime?.close();
    fixture.httpServer.closeAllConnections();
    await new Promise((resolve) => fixture.httpServer.close(resolve));
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
