import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../src/runtime.mjs';

const searchKey = 'search-fixture-secret';
const modelKey = 'model-fixture-secret';
const researchQuery = '公开模型许可调研';
const modelCredential = { apiKey: modelKey };
function sse(content) {
  const base = { id: 'fixture', object: 'chat.completion.chunk', model: 'fixture-model' };
  return new Response([
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
  ].map((data) => `data: ${JSON.stringify(data)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}

async function fixture(t, searchResponse, modelResponse) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pi-web-research-'));
  const modelBodies = [];
  let searches = 0;
  const options = { dataDir, workspaceControlToken: 'test-token', fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    if (new URL(url).hostname === 'api.search.brave.com') {
      searches++;
      assert.equal(init.headers['X-Subscription-Token'], searchKey);
      assert.equal(body.q, researchQuery);
      assert.ok(!JSON.stringify(init.headers).includes(modelKey));
      return searchResponse();
    }
    assert.ok(!JSON.stringify(body).includes(searchKey));
    modelBodies.push(body);
    return sse(modelResponse(body, modelBodies.length));
  } };
  let runtime = await createRuntime(options);
  t.after(async () => { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, modelBodies, get searches() { return searches; },
    get runtime() { return runtime; }, async restart() { await runtime.close(); runtime = await createRuntime(options); },
    run: () => runtime.handle('research.run', { text: researchQuery, searchCredential: { apiKey: searchKey }, modelCredential }),
    chat: (text) => runtime.handle('chat.send', { text, modelCredential }) };
}

const setup = async ({ runtime, dataDir }) => {
  assert.equal((await runtime.handle('settings.update', { setting: { id: 'default', provider: 'openai-compatible', model: 'fixture-model', baseUrl: 'https://fixture.invalid/v1' } })).ok, true);
  assert.equal((await runtime.handle('workspace.authorize', { root: join(dataDir, 'workspace'), controlToken: 'test-token' })).ok, true);
};
const searchResult = () => Response.json({ type: 'search', web: { results: [
  { url: 'https://example.org/source', title: '来源', description: '许可条款提供了用途说明。' },
  { url: 'https://example.net/title-only', title: '仅标题' }
] } });

test('research uses isolated real Pi request, persists bound citations without the excerpts or credentials, and preserves ordinary transcript', async (t) => {
  const app = await fixture(t, searchResult, (body, index) => {
    if (index !== 2) return '普通对话完成';
    assert.ok(!body.tools?.length);
    assert.match(JSON.stringify(body.messages), /许可条款提供了用途说明/);
    assert.doesNotMatch(JSON.stringify(body.messages), /私有上下文/);
    return JSON.stringify({ claims: [
      { text: '有用途说明', sourceIds: ['S1'], status: 'cited' },
      { text: '未知费用', sourceIds: ['S1', 'S99'], status: 'cited' },
      { text: '只有标题', sourceIds: ['S2'], status: 'cited' },
      { text: `不确定 ${searchKey}`, sourceIds: ['S1'], status: 'unverified' }
    ] });
  });
  await setup(app);
  assert.ok((await app.chat('私有上下文')).ok);
  const result = await app.run();
  assert.equal(result.ok, true, JSON.stringify(result));
  const research = result.result.assistant.research;
  assert.deepEqual(research.claims.map(({ status, sourceIds }) => [status, sourceIds]), [
    ['snippet', ['S1']], ['unverified', []], ['unverified', []], ['unverified', []]
  ]);
  assert.equal(research.sources[0].url, 'https://example.org/source');
  assert.doesNotMatch(JSON.stringify(research), /提供了用途说明|fixture-secret/);
  await app.restart();
  const list = await app.runtime.handle('conversation.list');
  assert.deepEqual(list.result.messages.at(-1).research, research);
  assert.ok((await app.chat('继续普通对话')).ok);
  assert.match(JSON.stringify(app.modelBodies[2].messages), /私有上下文/);
  assert.doesNotMatch(JSON.stringify(app.modelBodies[2].messages), new RegExp(researchQuery));
  const log = await readFile(join(app.dataDir, 'logs', 'runtime.jsonl'), 'utf8');
  assert.match(log, /research.result/);
  assert.doesNotMatch(log, /fixture-secret|公开模型许可调研|example.org/);
});

test('empty search skips Pi, malformed synthesis is labeled, and denied search does not mutate history', async (t) => {
  let response = 'empty';
  const app = await fixture(t, () => response === 'empty' ? Response.json({ type: 'search' }) : response === 'error' ? new Response(searchKey, { status: 429 }) : searchResult(), () => '无结构的答案');
  await setup(app);
  assert.equal((await app.run()).result?.assistant.research.status, 'empty');
  assert.equal(app.modelBodies.length, 0);
  response = 'nonempty';
  assert.equal((await app.run()).result?.assistant.research.status, 'unverified');
  response = 'error';
  assert.deepEqual((await app.run()).error?.code, 'research_rate_limited');
  assert.equal((await app.runtime.handle('conversation.list')).result.messages.length, 4);
  assert.equal(app.searches, 3);
});
