import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../src/runtime.mjs';
import { docxSample, pdfSample } from '../fixtures/document-samples.mjs';

async function setup(t, responseFor) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-doc-workflow-'));
  const root = join(dir, 'workspace');
  await mkdir(root);
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    requests.push(body);
    try {
      const next = await responseFor(body, requests.length);
      const delta = next.name ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call-' + requests.length, type: 'function', function: { name: next.name, arguments: JSON.stringify(next.args) } }] } : { role: 'assistant', content: next.text };
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
      for (const [chunk, reason] of [[delta, null], [{}, next.name ? 'tool_calls' : 'stop']]) response.write('data: ' + JSON.stringify({ id: 'c-' + requests.length, object: 'chat.completion.chunk', model: 'test-model', choices: [{ index: 0, delta: chunk, finish_reason: reason }] }) + '\n\n');
      response.end('data: [DONE]\n\n');
    } catch (error) { response.writeHead(500); response.end(error.message); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const runtime = await createRuntime({ dataDir: dir, workspaceRoot: root, workspaceControlToken: 'main-token' });
  await runtime.handle('settings.update', { setting: { id: 'default', provider: 'openai-compatible', model: 'test-model', apiFormat: 'chat-completions', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1' } });
  assert.equal((await runtime.handle('workspace.authorize', { root, controlToken: 'main-token' })).ok, true);
  t.after(async () => { await runtime.close(); await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); });
  return { dir, root, runtime, requests, send: (text) => runtime.handle('chat.send', { text, modelCredential: { apiKey: 'offline-key' } }) };
}

test('real Pi reads DOCX, prepares sourced text, waits for confirmation and persists the created file', async (t) => {
  const { dir, root, runtime, send } = await setup(t, (body, number) => {
    assert.ok(body.tools.some((tool) => tool.function.name === 'workspace_read_document'));
    assert.ok(!body.tools.some((tool) => /artifact.*create|workspace_write/.test(tool.function.name)));
    if (number === 1) return { name: 'workspace_read_document', args: { path: 'source.docx' } };
    if (number === 2) {
      assert.ok(body.messages.some((message) => message.role === 'tool' && message.content.includes('来源证据 42')));
      return { name: 'workspace_prepare_text', args: { path: 'summary.md', content: '# 结果\n来源证据为 42。', sourcePaths: ['source.docx'] } };
    }
    return { text: '产物已准备，请查看内容并确认创建。' };
  });
  await writeFile(join(root, 'source.docx'), docxSample('来源证据 42'));
  const result = await send('阅读 DOCX 并生成总结');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.result.assistant.sources[0].path, 'source.docx');
  assert.equal(result.result.toolExecutions.length, 2);
  const item = (await runtime.handle('artifacts.list')).result.artifacts[0];
  assert.equal(item.status, 'pending');
  await assert.rejects(readFile(join(root, 'summary.md')), { code: 'ENOENT' });
  assert.equal((await runtime.handle('artifacts.create', { id: item.id, sha256: item.sha256 })).error.code, 'artifact_confirmation_required');
  assert.equal((await runtime.handle('artifacts.create', { id: item.id, sha256: item.sha256, confirm: true })).ok, true);
  assert.equal(await readFile(join(root, 'summary.md'), 'utf8'), '# 结果\n来源证据为 42。');
  const detail = (await runtime.handle('artifacts.get', { id: item.id })).result.artifact;
  assert.equal(detail.sources[0].path, 'source.docx');
  const log = await readFile(join(dir, 'logs/runtime.jsonl'), 'utf8');
  assert.match(log, /artifact.prepared|artifact.created/);
  assert.doesNotMatch(log, /来源证据|source.docx|summary.md|offline-key/);
  await runtime.close();
  const reopened = await createRuntime({ dataDir: dir, workspaceRoot: root, workspaceControlToken: 'main-token' });
  try {
    assert.equal((await reopened.handle('artifacts.list')).result.artifacts[0].status, 'created');
    assert.equal((await reopened.handle('conversation.list')).result.messages.at(-1).sources[0].path, 'source.docx');
  } finally { await reopened.close(); }
});

test('Pi cannot claim unread provenance and recovery mode blocks artifact creation', async (t) => {
  const { runtime, send } = await setup(t, (_body, number) => number === 1
    ? { name: 'workspace_prepare_text', args: { path: 'invented.md', content: 'claim', sourcePaths: ['never-read.pdf'] } }
    : { text: '该资料尚未读取。' });
  const result = await send('整理资料');
  assert.equal(result.ok, true);
  assert.equal(result.result.toolExecutions[0].status, 'failed');
  assert.equal((await runtime.handle('artifacts.list')).result.artifacts.length, 0);
  runtime.store.setMeta('recovery_mode', 'true');
  assert.equal((await runtime.handle('artifacts.create', { id: 'unused', confirm: true })).error.code, 'recovery_mode');
});

test('changing the selected workspace isolates prior model context and old pending output', async (t) => {
  const { root, runtime, send } = await setup(t, (body, number) => {
    if (number === 1) return { name: 'workspace_read_document', args: { path: 'private.txt' } };
    if (number === 2) return { text: 'first-workspace-result' };
    assert.equal(body.messages.filter((message) => message.role === 'user').length, 1);
    assert.doesNotMatch(JSON.stringify(body.messages), /private-source-token|first-workspace-result/);
    return { text: '当前新工作区。' };
  });
  await writeFile(join(root, 'private.txt'), 'private-source-token');
  assert.equal((await send('读取资料')).ok, true);
  const pending = await runtime.artifacts.prepare({ path: 'old.md', content: 'old workspace' });
  const other = join(root, 'other');
  await mkdir(other);
  assert.equal((await runtime.handle('workspace.authorize', { root: other, controlToken: 'main-token' })).ok, true);
  assert.equal((await send('新目录有什么')).ok, true);
  assert.equal((await runtime.handle('artifacts.create', { id: pending.id, sha256: pending.sha256, confirm: true })).error.code, 'artifact_workspace_changed');
});


test('Runtime shutdown waits for an already confirmed artifact write', async (t) => {
  const { runtime } = await setup(t, () => ({ text: 'ready' }));
  const item = await runtime.artifacts.prepare({ path: 'closing.md', content: 'complete before close' });
  const original = runtime.artifacts.getWorkspace;
  let release;
  let entered;
  const blocked = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  runtime.artifacts.getWorkspace = async () => { entered(); await blocked; return original(); };
  const writing = runtime.handle('artifacts.create', { id: item.id, sha256: item.sha256, confirm: true });
  await started;
  let closed = false;
  const closing = runtime.close().then(() => { closed = true; });
  try {
    await new Promise(setImmediate);
    assert.equal(closed, false, 'SQLite must remain open until the confirmed write finishes');
  } finally { release(); }
  assert.equal((await writing).ok, true);
  await closing;
});

test('Runtime startup reconciles owned writes while frozen recovery remains read-only', async (t) => {
  const { dir, root, runtime } = await setup(t, () => ({ text: 'ready' }));
  const item = await runtime.artifacts.prepare({ path: 'recovered.md', content: 'persisted' });
  await runtime.artifacts.create({ id: item.id, sha256: item.sha256, confirm: true });
  runtime.store.db.prepare("UPDATE workspace_artifacts SET status='writing' WHERE id=?").run(item.id);
  runtime.store.setMeta('recovery_mode', 'true');
  await runtime.close();
  const frozen = await createRuntime({ dataDir: dir, workspaceRoot: root });
  assert.equal(frozen.artifacts.get(item.id).status, 'writing');
  frozen.store.setMeta('recovery_mode', 'false');
  await frozen.close();
  const reopened = await createRuntime({ dataDir: dir, workspaceRoot: root });
  try { assert.equal(reopened.artifacts.get(item.id).status, 'created'); }
  finally { await reopened.close(); }
});

test('provider credential echoes are removed from artifact content and source metadata', async (t) => {
  const { root, runtime, send } = await setup(t, (_body, number) => {
    if (number === 1) return { name: 'workspace_read_document', args: { path: 'source-offline-key.txt' } };
    if (number === 2) return { name: 'workspace_prepare_text', args: { path: 'report-offline-key.md', content: 'echo offline-key', sourcePaths: ['source-offline-key.txt'] } };
    return { text: 'ready' };
  });
  await writeFile(join(root, 'source-offline-key.txt'), 'real evidence');
  const result = await send('make report');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.doesNotMatch(JSON.stringify(result), /offline-key/);
  const item = runtime.artifacts.get(runtime.artifacts.list()[0].id);
  assert.doesNotMatch(JSON.stringify(item), /offline-key/);
  assert.match(item.content, /REDACTED/);
});


test('successive PDF page reads preserve all actually used page provenance', async (t) => {
  const { root, runtime, send } = await setup(t, (_body, number) => {
    if (number <= 2) return { name: 'workspace_read_document', args: { path: 'paged.pdf', startPage: number, pageCount: 1 } };
    if (number === 3) return { name: 'workspace_prepare_text', args: { path: 'combined.md', content: 'combined', sourcePaths: ['paged.pdf'] } };
    return { text: 'combined' };
  });
  await writeFile(join(root, 'paged.pdf'), pdfSample(['page one', 'page two']));
  const result = await send('use both pages');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.result.assistant.sources[0].pages, [1, 2]);
  assert.deepEqual(runtime.artifacts.list()[0].sources[0].pages, [1, 2]);
});


test('legacy workspace text provenance hashes the exact bytes including UTF-8 BOM', async (t) => {
  const { createHash } = await import('node:crypto');
  const { root, send } = await setup(t, (_body, number) => number === 1
    ? { name: 'workspace_read', args: { path: 'bom.txt' } }
    : { text: '来源已读取。' });
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('BOM source evidence')]);
  await writeFile(join(root, 'bom.txt'), bytes);
  const result = await send('读取文本来源');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.result.assistant.sources[0].sha256, createHash('sha256').update(bytes).digest('hex'));
});


for (const refreshDuringRequest of [true, false]) {
  test('model completion rejects revoked workspace authorization, concurrent refresh=' + refreshDuringRequest, async (t) => {
    let begin;
    let release;
    const started = new Promise((resolve) => { begin = resolve; });
    const waiting = new Promise((resolve) => { release = resolve; });
    const { dir, root, runtime, send } = await setup(t, async () => {
      begin();
      await waiting;
      return { text: 'late response from revoked workspace' };
    });
    const sending = send('pending authorized request');
    await started;
    await rename(root, join(dir, 'old-workspace'));
    await mkdir(root);
    if (refreshDuringRequest) {
      assert.equal((await runtime.handle('workspace.get')).result.authorized, false);
    }
    release();
    const result = await sending;
    assert.equal(result.error?.code, 'conversation_conflict', JSON.stringify(result));
    assert.doesNotMatch(JSON.stringify(runtime.conversationState()), /late response from revoked workspace/);
  });
}

test('re-authorizing the same workspace during a request invalidates its authorization snapshot', async (t) => {
  let begin;
  let release;
  const started = new Promise((resolve) => { begin = resolve; });
  const waiting = new Promise((resolve) => { release = resolve; });
  const { root, runtime, send } = await setup(t, async () => {
    begin();
    await waiting;
    return { text: 'late response after authorization changed' };
  });
  const sending = send('pending request');
  await started;
  await runtime.revokeWorkspaceAuthorization();
  assert.equal((await runtime.handle('workspace.authorize', { root, controlToken: 'main-token' })).ok, true);
  release();
  const result = await sending;
  assert.equal(result.error?.code, 'conversation_conflict', JSON.stringify(result));
  assert.doesNotMatch(JSON.stringify(runtime.conversationState()), /late response after authorization changed/);
});
