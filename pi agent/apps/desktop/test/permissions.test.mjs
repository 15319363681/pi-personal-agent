import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, symlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceAdmission, withWorkspaceIdentity, workspaceIdentity } from '../src/runtime/workspace.mjs';
import { PermissionGateway } from '../src/runtime/permission-gateway.mjs';

test('workspace admission denies traversal and allows selected root', async () => {
  const dir=await mkdtemp(join(tmpdir(),'pi-product-workspace-')); const outside=join(dir,'outside.txt'); await writeFile(outside,'secret'); const root=join(dir,'root'); await mkdir(root);
  try { const ws=await WorkspaceAdmission.open(root,'workspace-write'); assert.equal((await ws.read('missing.txt')).status,'missing'); await assert.rejects(ws.read('../outside.txt'),/workspace_escape/); } finally { await rm(dir,{recursive:true,force:true}); }
});

test('permission gateway binds high risk action to approved contract', () => {
  const gateway=new PermissionGateway(); const contract={permissionSnapshot:{mode:'workspace-write',recipient:'approved'}}; assert.equal(gateway.check('workspace.read',contract,{path:'x'}).allowed,true); assert.equal(gateway.check('notify.send',contract,{recipient:'other'}).allowed,false); assert.equal(gateway.check('notify.send',contract,{recipient:'approved'}).allowed,true);
});

test('workspace admission reads bounded text and lists only direct children', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-product-workspace-tools-'));
  const root = join(dir, 'root');
  await mkdir(join(root, 'nested'), { recursive: true });
  await writeFile(join(root, 'note.md'), '# note');
  await writeFile(join(root, 'nested', 'child.txt'), 'child');
  try {
    const ws = await WorkspaceAdmission.open(root, 'read-only', { maxReadBytes: 32, maxEntries: 10 });
    assert.deepEqual((await ws.readText('note.md')).data, '# note');
    assert.deepEqual((await ws.list('.')).entries.map((entry) => [entry.name, entry.type]), [['nested', 'directory'], ['note.md', 'file']]);
    await assert.rejects(ws.write('blocked.txt', 'nope'), /read_only/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('workspace admission rejects absolute paths, oversized text and non-text content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-product-workspace-limits-'));
  const root = join(dir, 'root');
  await mkdir(root);
  await writeFile(join(root, 'large.txt'), '123456789');
  await writeFile(join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  try {
    const ws = await WorkspaceAdmission.open(root, 'read-only', { maxReadBytes: 4 });
    await assert.rejects(ws.readText('large.txt'), /workspace_file_too_large/);
    await assert.rejects(ws.readText('binary.bin'), /workspace_not_text/);
    await assert.rejects(ws.readText(root), /workspace_absolute_path/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('workspace admission rejects a parent symlink before reading through it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-product-workspace-reparse-'));
  const root = join(dir, 'root');
  const outside = join(dir, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), 'secret');
  try {
    try {
      await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip('Creating a directory link is unavailable'); return; }
      throw error;
    }
    const ws = await WorkspaceAdmission.open(root, 'read-only');
    await assert.rejects(ws.readText('linked/secret.txt'), /workspace_reparse/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('workspace listing enforces the entry limit and reports truncation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-workspace-entry-limit-'));
  try {
    await Promise.all(['c.txt', 'a.txt', 'b.txt'].map((name) => writeFile(join(dir, name), name)));
    const limited = await WorkspaceAdmission.open(dir, 'read-only', { maxEntries: 2 });
    const result = await limited.list();
    assert.deepEqual(result.entries.map((entry) => entry.name), ['a.txt', 'b.txt']);
    assert.equal(result.truncated, true);
    const exact = await WorkspaceAdmission.open(dir, 'read-only', { maxEntries: 3 });
    assert.equal((await exact.list()).truncated, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('workspace rejects a root replaced by a symlink or junction', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-workspace-root-replaced-'));
  const root = join(dir, 'root');
  const outside = join(dir, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), 'secret');
  try {
    const ws = await WorkspaceAdmission.open(root, 'workspace-write');
    await rename(root, join(dir, 'original'));
    try { await symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip('Creating a directory link is unavailable'); return; }
      throw error;
    }
    await assert.rejects(ws.readText('secret.txt'), /workspace_(reparse|root_changed)/);
    await assert.rejects(ws.list('.'), /workspace_(reparse|root_changed)/);
    await assert.rejects(ws.write('created.txt', 'blocked'), /workspace_(reparse|root_changed)/);
    await assert.rejects(WorkspaceAdmission.open(root), /workspace_(reparse|root_changed)/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('workspace rejects a root replaced by another directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-workspace-root-identity-'));
  const root = join(dir, 'root');
  await mkdir(root);
  try {
    const ws = await WorkspaceAdmission.open(root, 'workspace-write');
    await rename(root, join(dir, 'original'));
    await mkdir(root);
    await writeFile(join(root, 'secret.txt'), 'secret');
    await assert.rejects(ws.readText('secret.txt'), /workspace_root_changed/);
    await assert.rejects(ws.list('.'), /workspace_root_changed/);
    await assert.rejects(ws.write('created.txt', 'blocked'), /workspace_root_changed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('a scoped authorization prevents reopening a replacement directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-workspace-scoped-identity-'));
  const root = join(dir, 'root');
  await mkdir(root);
  try {
    const identity = await workspaceIdentity(root);
    await rename(root, join(dir, 'original'));
    await mkdir(root);
    await assert.rejects(withWorkspaceIdentity(identity, () => WorkspaceAdmission.open(root)), /workspace_root_changed/);
    assert.equal((await WorkspaceAdmission.open(root)).root, root);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('MCP invocation requires explicit approval for the matching server and tool', () => {
  const gateway = new PermissionGateway();
  const contract = { permissionSnapshot: { mode: 'full-access' } };
  assert.equal(gateway.check('mcp.invoke', contract, { serverId: 'research', toolName: 'lookup' }).allowed, false);
  assert.equal(gateway.check('mcp.invoke', contract, { serverId: 'research', toolName: 'lookup', approved: true }).allowed, true);
  assert.equal(gateway.check('mcp.invoke', contract, { serverId: 'research', toolName: 'delete', approved: false }).allowed, false);
});
