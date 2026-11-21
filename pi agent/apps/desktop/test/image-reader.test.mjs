import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { ImageReader } from '../src/runtime/image-reader.mjs';
import { WorkspaceAdmission } from '../src/runtime/workspace.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-image-reader-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }));
  return { root, workspace: await WorkspaceAdmission.open(root), reader: new ImageReader() };
}

async function sample(format, width = 24, height = 12) {
  return sharp({ create: { width, height, channels: 4, background: '#286d9a' } }).toFormat(format).toBuffer();
}

test('JPEG PNG and WebP decode to bounded actual JPEG with exact source hashes', async (t) => {
  const { root, workspace, reader } = await fixture(t);
  for (const [extension, format] of [['jpg', 'jpeg'], ['JPEG', 'jpeg'], ['png', 'png'], ['webp', 'webp']]) {
    const bytes = await sample(format);
    const name = 'source.' + extension;
    await writeFile(join(root, name), bytes);
    const result = await reader.read(workspace, name);
    assert.equal(result.status, 'ok');
    assert.equal(result.image.type, 'image');
    assert.equal(result.image.mimeType, 'image/jpeg');
    const actual = await sharp(Buffer.from(result.image.data, 'base64')).metadata();
    assert.equal(actual.format, 'jpeg');
    assert.equal(actual.width, 24);
    assert.equal(actual.height, 12);
    assert.equal(result.source.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(result.source.size, bytes.length);
    assert.equal(result.source.format, format);
    assert.equal(result.source.width, 24);
    assert.equal(result.source.height, 12);
    assert.equal(result.source.submittedWidth, 24);
    assert.equal(result.source.submittedHeight, 12);
    assert.equal(result.source.firstFrameOnly, false);
  }
});

test('orientation is applied, oversized dimensions are resized, metadata is removed', async (t) => {
  const { root, workspace, reader } = await fixture(t);
  const bytes = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: 'red' } })
    .withMetadata({ orientation: 6 }).jpeg().toBuffer();
  await writeFile(join(root, 'rotated.jpg'), bytes);
  const result = await reader.read(workspace, 'rotated.jpg');
  assert.equal(result.source.width, 2400);
  assert.equal(result.source.height, 1200);
  assert.equal(result.source.submittedWidth, 800);
  assert.equal(result.source.submittedHeight, 1600);
  const metadata = await sharp(Buffer.from(result.image.data, 'base64')).metadata();
  assert.equal(metadata.width, 800);
  assert.equal(metadata.height, 1600);
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.icc, undefined);
});

test('animated GIF submits only its first frame with explicit source provenance', async (t) => {
  const { root, workspace, reader } = await fixture(t);
  const pixels = Buffer.from([...Array(4).fill([0, 0, 255]).flat(), ...Array(4).fill([255, 0, 0]).flat()]);
  const bytes = await sharp(pixels, { raw: { width: 2, height: 4, pageHeight: 2, channels: 3 } }).gif().toBuffer();
  assert.equal((await sharp(bytes, { animated: true }).metadata()).pages, 2);
  await writeFile(join(root, 'animated.gif'), bytes);
  const result = await reader.read(workspace, 'animated.gif');
  assert.equal(result.source.firstFrameOnly, true);
  assert.equal(result.source.frames, 2);
  assert.equal(result.source.height, 2);
  assert.equal((await sharp(Buffer.from(result.image.data, 'base64')).metadata()).height, 2);
});

test('unsupported, disguised, damaged and missing images fail explicitly', async (t) => {
  const { root, workspace, reader } = await fixture(t);
  await writeFile(join(root, 'fake.jpg'), await sample('png'));
  await assert.rejects(reader.read(workspace, 'fake.jpg'), /image_format_mismatch/);
  await writeFile(join(root, 'broken.png'), 'not an image');
  await assert.rejects(reader.read(workspace, 'broken.png'), /image_decode_failed/);
  await writeFile(join(root, 'vector.svg'), '<svg/>');
  await assert.rejects(reader.read(workspace, 'vector.svg'), /image_format_unsupported/);
  await assert.rejects(reader.read(workspace, 'missing.png'), /image_missing/);
  await assert.rejects(reader.read(workspace, '../outside.png'), /workspace_escape/);
  await assert.rejects(reader.read(workspace, ''), /image_request_invalid/);
});

test('input byte and decoded pixel limits reject images before submission', async (t) => {
  const { root, workspace, reader } = await fixture(t);
  await writeFile(join(root, 'large.jpg'), Buffer.alloc(10 * 1024 * 1024 + 1));
  await assert.rejects(reader.read(workspace, 'large.jpg'), /workspace_file_too_large/);
  await writeFile(join(root, 'pixels.png'), await sample('png', 4100, 4100));
  await assert.rejects(reader.read(workspace, 'pixels.png'), /image_pixel_limit/);
});

test('worker timeout terminates image parsing and validates reader limits', async (t) => {
  const { root, workspace } = await fixture(t);
  await writeFile(join(root, 'source.png'), await sample('png'));
  await assert.rejects(new ImageReader({ timeoutMs: 1 }).read(workspace, 'source.png'), /image_timeout/);
  assert.throws(() => new ImageReader({ timeoutMs: 0 }), /image_request_invalid/);
});
