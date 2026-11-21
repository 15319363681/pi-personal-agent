import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { createRuntime } from '../src/runtime.mjs';

function completion(next, number) {
  const delta = next.name
    ? { role: 'assistant', tool_calls: [{ index: 0, id: 'image-call-' + number, type: 'function', function: { name: next.name, arguments: JSON.stringify(next.args) } }] }
    : { role: 'assistant', content: next.text };
  const chunks = [delta, {}].map((item, index) => ({ id: 'image-' + number, object: 'chat.completion.chunk', model: 'vision-test', choices: [{ index: 0, delta: item, finish_reason: index ? (next.name ? 'tool_calls' : 'stop') : null }] }));
  return new Response(chunks.map((chunk) => 'data: ' + JSON.stringify(chunk) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}

function imageUrls(body) {
  return body.messages.flatMap((message) => Array.isArray(message.content) ? message.content.flatMap((part) => part.image_url ? [part.image_url.url] : []) : []);
}

async function fixture(t, responseFor, { authorize = true, supportsImages = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-image-workflow-'));
  const root = join(dir, 'workspace');
  await mkdir(root);
  const requests = [];
  const options = { dataDir: dir, workspaceRoot: root, workspaceControlToken: 'main-token', fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    return completion(await responseFor(body, requests.length), requests.length);
  } };
  let runtime = await createRuntime(options);
  const setting = { id: 'default', provider: 'openai-compatible', model: 'vision-test', baseUrl: 'https://offline.test/v1', supportsImages };
  assert.equal((await runtime.handle('settings.update', { setting })).ok, true);
  if (authorize) assert.equal((await runtime.handle('workspace.authorize', { root, controlToken: 'main-token' })).ok, true);
  t.after(async () => { await runtime.close(); await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); });
  return { dir, root, requests, setting, get runtime() { return runtime; }, send: (text) => runtime.handle('chat.send', { text, modelCredential: { apiKey: 'offline-vision-key' } }), restart: async () => { await runtime.close(); runtime = await createRuntime(options); } };
}

test('real Pi submits image bytes, prepares sourced output and reloads without persisted binary', async (t) => {
  let submittedImage;
  const instance = await fixture(t, async (body, number) => {
    assert.ok(body.tools.some((tool) => tool.function.name === 'workspace_read_image'));
    if (number === 1) return { name: 'workspace_read_image', args: { path: 'chart.png' } };
    if (number === 2) {
      const urls = imageUrls(body);
      assert.equal(urls.length, 1);
      assert.match(urls[0], /^data:image\/jpeg;base64,/);
      submittedImage = urls[0].split(',')[1];
      const actual = await sharp(Buffer.from(submittedImage, 'base64')).metadata();
      assert.equal(actual.width, 40);
      assert.equal(actual.height, 20);
      assert.ok(body.messages.some((message) => typeof message.content === 'string' && message.content.includes('chart.png')));
      return { name: 'workspace_prepare_text', args: { path: 'image-summary.md', content: '# 图片总结\n图片已读取。', sourcePaths: ['chart.png'] } };
    }
    if (number >= 4) assert.equal(imageUrls(body).length, 0);
    return { text: '已准备图片总结，请确认创建。' };
  });
  await writeFile(join(instance.root, 'chart.png'), await sharp({ create: { width: 40, height: 20, channels: 4, background: '#ad4433' } }).png().toBuffer());
  const first = await instance.send('使用图表生成文档');
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.result.assistant.sources[0].submittedWidth, 40);
  assert.equal(first.result.toolExecutions[0].name, 'workspace_read_image');
  const item = instance.runtime.artifacts.list()[0];
  assert.equal(item.sources[0].format, 'png');
  assert.equal((await instance.runtime.handle('artifacts.create', { id: item.id, sha256: item.sha256, confirm: true })).ok, true);
  assert.match(await readFile(join(instance.root, 'image-summary.md'), 'utf8'), /图片总结/);
  const transcript = await readFile(join(instance.dir, 'pi-transcript.json'), 'utf8');
  assert.equal(transcript.includes(submittedImage), false);
  assert.equal(JSON.stringify(instance.runtime.conversationState()).includes(submittedImage), false);
  assert.match(transcript, /图片内容未持久化/);
  await instance.restart();
  const second = await instance.send('继续说明来源');
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.match(JSON.stringify(instance.requests[3].messages), /使用图表生成文档/);
});

test('image capability changes isolate prior multimodal context and disable the tool', async (t) => {
  const instance = await fixture(t, (body, number) => {
    if (number === 1) return { text: 'previous vision context' };
    assert.equal(body.tools.some((tool) => tool.function.name === 'workspace_read_image'), false);
    assert.doesNotMatch(JSON.stringify(body.messages), /first vision request|previous vision context/);
    return { text: 'text only context' };
  });
  assert.equal((await instance.send('first vision request')).ok, true);
  assert.equal((await instance.runtime.handle('settings.update', { setting: { ...instance.setting, supportsImages: false } })).ok, true);
  const result = await instance.send('text only request');
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('workspace image tools stay unavailable before directory authorization', async (t) => {
  const instance = await fixture(t, (body) => {
    assert.equal(body.tools.some((tool) => tool.function.name.startsWith('workspace_')), false);
    return { text: '请先授权资料目录。' };
  }, { authorize: false });
  assert.equal((await instance.send('读取图片')).ok, true);
});
