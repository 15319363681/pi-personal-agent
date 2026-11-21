import assert from 'node:assert/strict';
import test from 'node:test';
import { searchPublicWeb } from '../src/runtime/web-research.mjs';

const key = 'fixture-web-credential-797';
const result = (url, description = 'Published data about the topic') => ({ url, title: 'Reference', description });

function mockResponse(results) {
  return Response.json({ type: 'search', web: { results } });
}

test('web search uses a single fixed POST, minimal inputs and normalized, deduplicated citations', async () => {
  const found = await searchPublicWeb({ query: ' 中文 调研 ', apiKey: key, fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.search.brave.com/res/v1/web/search');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['X-Subscription-Token'], key);
    assert.equal(new URL(url).search, '');
    assert.equal(JSON.parse(init.body).q, '中文 调研');
    assert.equal(JSON.parse(init.body).search_lang, 'zh-hans');
    assert.deepEqual(JSON.parse(init.body).result_filter, ['web']);
    return mockResponse([
      result('https://Example.com/p#one'), result('https://example.com/p#two'), result('javascript:alert(0)'),
      result('https://alice:password@example.com'), result('https://127.0.0.1'), result('https://intranet.local'),
      result(`https://example.org/${key}`), result('https://other.example.org/', `snippet echoes ${key}`),
      result('http://example.info/p')
    ]);
  }});
  assert.deepEqual(found.map(({ id, url }) => ({ id, url })), [
    { id: 'S1', url: 'https://example.com/p' }, { id: 'S2', url: 'https://other.example.org/' }
  ]);
  assert.ok(!JSON.stringify(found).includes(key));
});

test('invalid and credential-bearing queries are rejected before network access', async () => {
  for (const query of ['', 'x'.repeat(401), Array(51).fill('word').join(' '), `private ${key}`]) {
    await assert.rejects(searchPublicWeb({ query, apiKey: key, fetchImpl: async () => assert.fail('network called') }), { code: 'research_query_invalid' });
  }
});

test('search handles no results, rate limit, invalid JSON, timeout and excessive streamed bytes', async () => {
  assert.deepEqual(await searchPublicWeb({ query: 'no results', apiKey: key, fetchImpl: async () => Response.json({ type: 'search' }) }), []);
  const cases = [
    ['research_rate_limited', async () => new Response(key, { status: 429 })],
    ['research_service_denied', async () => new Response(key, { status: 401 })],
    ['research_response_invalid', async () => new Response('invalid JSON containing ' + key)],
    ['research_response_invalid', async () => Response.json({ type: 'search', web: { results: 'invalid' } })],
    ['research_response_too_large', async () => new Response(new Uint8Array(512 * 1024 + 1))],
    ['research_timeout', async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)))],
    ['research_service_unavailable', async () => { throw new Error(key); }]
  ];
  for (const [code, fetchImpl] of cases) {
    await assert.rejects(searchPublicWeb({ query: 'query', apiKey: key, fetchImpl, timeoutMs: 30 }), (error) => error.code === code && !error.message.includes(key));
  }
});
