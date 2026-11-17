import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceAdmission } from '../src/runtime/workspace.mjs';
import { PermissionGateway } from '../src/runtime/permission-gateway.mjs';

test('workspace admission denies traversal and allows selected root', async () => {
  const dir=await mkdtemp(join(tmpdir(),'pi-product-workspace-')); const outside=join(dir,'outside.txt'); await writeFile(outside,'secret'); const root=join(dir,'root'); await mkdir(root);
  try { const ws=await WorkspaceAdmission.open(root,'workspace-write'); assert.equal((await ws.read('missing.txt')).status,'missing'); await assert.rejects(ws.read('../outside.txt'),/workspace_escape/); } finally { await rm(dir,{recursive:true,force:true}); }
});

test('permission gateway binds high risk action to approved contract', () => {
  const gateway=new PermissionGateway(); const contract={permissionSnapshot:{mode:'workspace-write',recipient:'approved'}}; assert.equal(gateway.check('workspace.read',contract,{path:'x'}).allowed,true); assert.equal(gateway.check('notify.send',contract,{recipient:'other'}).allowed,false); assert.equal(gateway.check('notify.send',contract,{recipient:'approved'}).allowed,true);
});
