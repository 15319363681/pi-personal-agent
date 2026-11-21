import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DocumentReader } from '../src/runtime/document-reader.mjs';
import { WorkspaceAdmission } from '../src/runtime/workspace.mjs';
import { pdfSample, docxSample } from '../fixtures/document-samples.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-doc-reader-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, workspace: await WorkspaceAdmission.open(root), reader: new DocumentReader() };
}

test('UTF-8 TXT and Markdown preserve content with bounded text and source hashes', async (t) => {
  const { root, workspace, reader } = await fixture(t);
  const data = '# 资料\n真实内容';
  await writeFile(join(root, 'readme.md'), data);
  const result = await reader.read(workspace, 'readme.md');
  assert.equal(result.text, data);
  assert.equal(result.status, 'ok');
  assert.equal(result.source.path, 'readme.md');
  assert.equal(result.source.sha256, createHash('sha256').update(data).digest('hex'));
  await writeFile(join(root, 'long.txt'), 'x'.repeat(60001));
  const long = await reader.read(workspace, 'long.txt');
  assert.equal(long.text.length, 60000);
  assert.equal(long.truncated, true);
  await writeFile(join(root, 'invalid.txt'), Buffer.from([0xff, 0x00]));
  await assert.rejects(reader.read(workspace, 'invalid.txt'), /document_not_text/);
});

test('PDF parsing returns actual page text and bounded page provenance', async (t) => {
  const { root, workspace, reader } = await fixture(t);
  await writeFile(join(root, 'source.pdf'), pdfSample(['Page one evidence', 'Page two conclusion', 'Page three']));
  const result = await reader.read(workspace, 'source.pdf', { startPage: 2, pageCount: 1 });
  assert.match(result.text, /Page two conclusion/);
  assert.doesNotMatch(result.text, /Page one/);
  assert.deepEqual(result.source.pages, [2]);
  assert.equal(result.totalPages, 3);
  assert.equal(result.truncated, true);
  await assert.rejects(reader.read(workspace, 'source.pdf', { startPage: 4 }), /document_page_range/);
  await assert.rejects(reader.read(workspace, 'source.pdf', { pageCount: 21 }), /document_request_invalid/);
});

test('DOCX parsing extracts text and records its actual source', async (t) => {
  const { root, workspace, reader } = await fixture(t);
  await writeFile(join(root, 'source.docx'), docxSample('用户授权的 DOCX 资料'));
  const result = await reader.read(workspace, 'source.docx');
  assert.match(result.text, /用户授权的 DOCX 资料/);
  assert.equal(result.source.format, 'docx');
});

test('empty PDF, corrupt formats, missing files and unsupported files have explicit states', async (t) => {
  const { root, workspace, reader } = await fixture(t);
  await writeFile(join(root, 'scan.pdf'), pdfSample(['']));
  assert.equal((await reader.read(workspace, 'scan.pdf')).status, 'no_text');
  await writeFile(join(root, 'corrupt.pdf'), '%PDF broken');
  await assert.rejects(reader.read(workspace, 'corrupt.pdf'), /document_parse_failed/);
  await writeFile(join(root, 'corrupt.docx'), 'PK broken');
  await assert.rejects(reader.read(workspace, 'corrupt.docx'), /document_archive_invalid/);
  await assert.rejects(reader.read(workspace, 'missing.txt'), /document_missing/);
  await assert.rejects(reader.read(workspace, 'source.exe'), /document_format_unsupported/);
});

test('ZIP expansion claims, oversized documents and parser timeout are bounded', async (t) => {
  const { root, workspace, reader } = await fixture(t);
  const zip = docxSample();
  const directory = zip.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
  zip.writeUInt32LE(0x7fffffff, directory + 24);
  await writeFile(join(root, 'bomb.docx'), zip);
  await assert.rejects(reader.read(workspace, 'bomb.docx'), /document_archive_too_large/);
  await writeFile(join(root, 'oversize.pdf'), Buffer.alloc(20 * 1024 * 1024 + 1));
  await assert.rejects(reader.read(workspace, 'oversize.pdf'), /workspace_file_too_large/);
  await writeFile(join(root, 'small.pdf'), pdfSample());
  await assert.rejects(new DocumentReader({ timeoutMs: 1 }).read(workspace, 'small.pdf'), /document_timeout/);
  await assert.rejects(reader.read(workspace, '../outside.txt'), /workspace_escape/);
});


test('DOCX rejects forged ZIP sizes, mismatched local names and corrupted contents', async (t) => {
  const { root, workspace, reader } = await fixture(t);
  const original = docxSample('verify ZIP integrity');
  const directory = original.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const wrongSize = Buffer.from(original);
  wrongSize.writeUInt32LE(1, directory + 24);
  await writeFile(join(root, 'size.docx'), wrongSize);
  await assert.rejects(reader.read(workspace, 'size.docx'), /document_archive_invalid/);
  const wrongName = Buffer.from(original);
  wrongName[30] = 'x'.charCodeAt(0);
  await writeFile(join(root, 'name.docx'), wrongName);
  await assert.rejects(reader.read(workspace, 'name.docx'), /document_archive_invalid/);
  const wrongContents = Buffer.from(original);
  wrongContents[30 + original.readUInt16LE(26) + 2] ^= 1;
  await writeFile(join(root, 'integrity.docx'), wrongContents);
  await assert.rejects(reader.read(workspace, 'integrity.docx'), /document_archive_invalid/);
});


test('deflated DOCX is parsed and a hidden expansion cannot bypass declared bounds', async (t) => {
  const { root, workspace, reader } = await fixture(t);
  await writeFile(join(root, 'compressed.docx'), docxSample('真实压缩正文', { compress: true }));
  assert.match((await reader.read(workspace, 'compressed.docx')).text, /真实压缩正文/);
  const bomb = docxSample('x'.repeat(11 * 1024 * 1024), { compress: true });
  let directory = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  for (let index = 0; index < 3; index++) {
    if (index === 2) {
      const local = bomb.readUInt32LE(directory + 42);
      bomb.writeUInt32LE(128, directory + 24);
      bomb.writeUInt32LE(128, local + 22);
    }
    directory += 46 + bomb.readUInt16LE(directory + 28) + bomb.readUInt16LE(directory + 30) + bomb.readUInt16LE(directory + 32);
  }
  await writeFile(join(root, 'hidden-expansion.docx'), bomb);
  await assert.rejects(reader.read(workspace, 'hidden-expansion.docx'), /document_archive_invalid/);
});
