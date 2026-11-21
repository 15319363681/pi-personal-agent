import test from 'node:test';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceAdmission } from '../src/runtime/workspace.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-workspace-files-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }));
  const root = join(dir, 'root');
  await mkdir(root);
  return { dir, root, workspace: await WorkspaceAdmission.open(root, 'workspace-write') };
}

test('new text files are flushed and never replace an existing file', async (t) => {
  const { root, workspace } = await fixture(t);
  await mkdir(join(root, 'output'));
  const result = await workspace.createText('output/summary.md', '# 总结\n内容');
  assert.equal(result.size, Buffer.byteLength('# 总结\n内容'));
  assert.equal(await readFile(join(root, 'output/summary.md'), 'utf8'), '# 总结\n内容');
  await assert.rejects(workspace.createText('output/summary.md', 'replacement'), /workspace_file_exists/);
  assert.equal(await readFile(join(root, 'output/summary.md'), 'utf8'), '# 总结\n内容');
});

test('creation validates permissions, text size, extension and existing parent', async (t) => {
  const { root, workspace } = await fixture(t);
  const readOnly = await WorkspaceAdmission.open(root);
  await assert.rejects(readOnly.createText('blocked.txt', 'text'), /read_only/);
  await assert.rejects(workspace.createText('missing/result.md', 'text'), /workspace_parent_missing/);
  await assert.rejects(workspace.createText('code.js', 'text'), /workspace_output_invalid/);
  await assert.rejects(workspace.createText('large.txt', 'x'.repeat(262145)), /workspace_output_too_large/);
  await assert.rejects(workspace.createText('content.txt', 'a\0b'), /workspace_output_invalid/);
});

test('document reads use a separate bounded limit and validate actual bytes', async (t) => {
  const { root, workspace } = await fixture(t);
  await writeFile(join(root, 'binary.pdf'), Buffer.alloc(300000, 1));
  await assert.rejects(workspace.read('binary.pdf'), /workspace_file_too_large/);
  assert.equal((await workspace.read('binary.pdf', { maxBytes: 400000 })).data.length, 300000);
  await assert.rejects(workspace.read('binary.pdf', { maxBytes: 0 }), /workspace_read_limit_invalid/);
});

test('workspace refuses device, stream, drive relative and ambiguous Windows paths', async (t) => {
  const { workspace } = await fixture(t);
  for (const name of ['../outside.md', 'C:outside.md', 'file.txt:stream', 'CON.txt', 'aux.md', 'dir./x.md', 'dir /x.md']) {
    await assert.rejects(workspace.createText(name, 'text'), /workspace_(escape|invalid_path|absolute_path)/, name);
  }
});

test('new-file creation rejects linked parents and a replaced root', async (t) => {
  const { dir, root, workspace } = await fixture(t);
  const outside = join(dir, 'outside');
  await mkdir(outside);
  await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(workspace.createText('linked/escaped.md', 'secret'), /workspace_reparse/);
  await rename(root, join(dir, 'previous'));
  await mkdir(root);
  await assert.rejects(workspace.createText('escaped.md', 'secret'), /workspace_root_changed/);
});

test('Windows pinned directory handles prevent replacement during a file operation', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows directory handles');
  const { dir, root } = await fixture(t);
  const { pinWorkspacePath } = await import('../src/runtime/windows-workspace.mjs');
  const release = pinWorkspacePath(root, join(root, 'new.md'));
  try { await assert.rejects(rename(root, join(dir, 'replaced')), (error) => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code)); }
  finally { release(); }
  await rename(root, join(dir, 'replaced'));
});


test('a file that grows during reading is rejected and directory pins are released', async (t) => {
  const { dir, root, workspace } = await fixture(t);
  const target = join(root, 'changing.txt');
  await writeFile(target, 'initial');
  const probe = await open(target, 'r');
  const prototype = Object.getPrototypeOf(probe);
  const originalRead = prototype.read;
  await probe.close();
  let changed = false;
  const mock = t.mock.method(prototype, 'read', async function (...args) {
    if (!changed) { changed = true; await writeFile(target, 'initial plus newly appended text'); }
    return originalRead.apply(this, args);
  });
  try { await assert.rejects(workspace.read('changing.txt'), /workspace_file_changed/); }
  finally { mock.mock.restore(); }
  assert.equal(changed, true);
  await rename(root, join(dir, 'released'));
});


test('directory enumeration pins its target and rejects a concurrent replacement', async (t) => {
  const { dir, root, workspace } = await fixture(t);
  const target = join(root, 'docs');
  const outside = join(dir, 'outside');
  await mkdir(target);
  await mkdir(outside);
  await writeFile(join(target, 'safe.txt'), 'safe');
  await writeFile(join(outside, 'private-name.txt'), 'private');
  const original = fsPromises.readdir;
  let blocked = false;
  const mock = t.mock.method(fsPromises, 'readdir', async (current, ...args) => {
    if (String(current) === target) {
      try {
        await rename(target, join(root, 'previous-docs'));
        await symlink(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        blocked = true;
      }
    }
    return original(current, ...args);
  });
  syncBuiltinESMExports();
  try {
    if (process.platform === 'win32') {
      const result = await workspace.list('docs');
      assert.equal(blocked, true, 'the directory itself must be pinned while enumerating');
      assert.deepEqual(result.entries.map((entry) => entry.name), ['safe.txt']);
    } else {
      await assert.rejects(workspace.list('docs'), /workspace_(reparse|root_changed)/);
    }
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  await rename(root, join(dir, 'pins-released'));
});
