import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../src/runtime.mjs';
function reply(text) { return new Response('data: ' + JSON.stringify({ id: 'wecom-fixture', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }); }
test('Wecom inbox deduplicates across restart and separates channel history while sharing reviewed memory', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pi-wecom-runtime-'));
  const bodies = [];
  const options = { dataDir, fetchImpl: async (_url, init) => { bodies.push(JSON.stringify(JSON.parse(init.body).messages)); return reply('渠道回复'); } };
  let runtime = await createRuntime(options);
  t.after(async () => { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); });
  await runtime.handle('settings.update', { setting: { id: 'default', provider: 'openai-compatible', model: 'fixture', baseUrl: 'https://model.invalid/v1' } });
  assert.equal((await runtime.handle('wecom.config.save', { botId: 'bot1', ownerId: 'owner', credentialRef: 'secret-ref' })).ok, true);
  const memory = runtime.memory.propose('共享偏好'); runtime.memory.approve(memory.id, memory.revision);
  const params = { msgid: 'msg1', text: '渠道专用文字', modelCredential: { apiKey: 'wecom-fixture-key' } };
  assert.equal((await runtime.handle('wecom.inbox.claim', params)).result.claimed, true);
  const result = await runtime.handle('wecom.reply', params);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(bodies[0], /共享偏好/);
  assert.equal((await runtime.handle('conversation.list')).result.messages.length, 0);
  const history = (await runtime.handle('wecom.history')).result.messages;
  assert.equal(history[0].text, '渠道专用文字');
  assert.equal(history[0].reply, '渠道回复');
  await runtime.close(); runtime = await createRuntime(options);
  assert.equal((await runtime.handle('wecom.inbox.claim', params)).result.claimed, false);
  await runtime.handle('chat.send', { text: '桌面消息', modelCredential: params.modelCredential });
  assert.ok(!bodies[1].includes('渠道专用文字'));
  await runtime.handle('wecom.config.save', { botId: 'bot2', ownerId: 'owner', credentialRef: 'secret-ref' });
  assert.equal((await runtime.handle('wecom.history')).result.messages.length, 0);
});

test('channel keeps processing failures when a failure notice is delivered and rejects stale configuration', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pi-wecom-failure-'));
  const runtime = await createRuntime({ dataDir });
  t.after(async () => { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); });
  const first = (await runtime.handle('wecom.config.save', { botId: 'bot1', ownerId: 'owner', credentialRef: 'ref1' })).result.config;
  const message = { msgid: 'failure', text: 'hello', revision: first.revision };
  assert.equal((await runtime.handle('wecom.inbox.claim', message)).result.claimed, true);
  await runtime.handle('wecom.inbox.fail', message);
  await runtime.handle('wecom.inbox.delivery', { ...message, status: 'delivered' });
  assert.equal((await runtime.handle('wecom.history')).result.messages[0].status, 'failed');
  await runtime.handle('wecom.config.save', { botId: 'bot2', ownerId: 'owner', credentialRef: 'ref2' });
  assert.equal((await runtime.handle('wecom.inbox.claim', { ...message, msgid: 'stale' })).ok, false);
  assert.equal((await runtime.handle('wecom.history')).result.messages.length, 0);
});
