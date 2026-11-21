import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { WorkspaceAdmission } from '../src/runtime/workspace.mjs';
import { PermissionGateway } from '../src/runtime/permission-gateway.mjs';
import { createWorkspaceTools } from '../src/runtime/pi-tools.mjs';

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-image-tools-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }));
  const bytes = await sharp({ create: { width: 20, height: 10, channels: 3, background: 'blue' } }).png().toBuffer();
  await writeFile(join(root, 'chart.png'), bytes);
  const sources = [];
  const options = { workspace: await WorkspaceAdmission.open(root), permissionGateway: new PermissionGateway(), contract: { permissionSnapshot: { mode: 'read-only' } }, supportsImages: true, recordSource: (source) => sources.push(source), ...overrides };
  const tools = createWorkspaceTools(options);
  return { tools, sources, options };
}

test('image tools require model capability and return actual JPEG and source provenance', async (t) => {
  const { tools, sources, options } = await fixture(t);
  assert.equal(createWorkspaceTools({ ...options, supportsImages: false }).some((tool) => tool.name === 'workspace_read_image'), false);
  const tool = tools.find((item) => item.name === 'workspace_read_image');
  assert.ok(tool, 'vision-capable models need a workspace image tool');
  const result = await tool.execute('read-image', { path: 'chart.png' });
  const image = result.content.find((part) => part.type === 'image');
  const actual = await sharp(Buffer.from(image.data, 'base64')).metadata();
  assert.equal(actual.format, 'jpeg');
  assert.equal(actual.width, 20);
  const metadata = JSON.parse(result.content.find((part) => part.type === 'text').text);
  assert.equal(metadata.source.path, 'chart.png');
  assert.equal(sources[0].sha256, metadata.source.sha256);
  assert.equal(result.details.operation, 'read_image');
});

test('image decoding rechecks workspace authorization and never records revoked data', async (t) => {
  let checks = 0;
  const { tools, sources } = await fixture(t, { ensureAuthorized: async () => {
    checks++;
    if (checks > 1) throw Object.assign(new Error('workspace_not_authorized'), { code: 'workspace_not_authorized' });
  } });
  const tool = tools.find((item) => item.name === 'workspace_read_image');
  assert.ok(tool);
  await assert.rejects(tool.execute('read-image', { path: 'chart.png' }), /workspace_not_authorized/);
  assert.equal(sources.length, 0);
});

test('prepared text can cite an image only after this turn has read it', async (t) => {
  const prepared = [];
  const { tools } = await fixture(t, { artifacts: { prepare: async (data, sources) => {
    prepared.push({ data, sources });
    return { id: 'prepared', path: data.path, content: data.content, status: 'pending', sha256: 'hash' };
  } } });
  const tool = tools.find((item) => item.name === 'workspace_read_image');
  assert.ok(tool);
  const prepare = tools.find((item) => item.name === 'workspace_prepare_text');
  const input = { path: 'result.md', content: '基于图像资料的总结', sourcePaths: ['chart.png'] };
  await assert.rejects(prepare.execute('prepare-before-read', input), /artifact_source_not_read/);
  await tool.execute('read-image', { path: 'chart.png' });
  await prepare.execute('prepare', input);
  assert.equal(prepared[0].sources[0].path, 'chart.png');
  assert.equal(prepared[0].sources[0].submittedWidth, 20);
});
