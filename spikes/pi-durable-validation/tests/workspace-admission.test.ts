import {test,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,link,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {checkWorkspace} from '../src/workspace-admission.mjs';
test('workspace_admission_rejects_hardlinks_and_reparse_points_before_acl_grant',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-link-'));const workspace=join(dir,'workspace');await mkdir(workspace);await writeFile(join(dir,'outside'),'outside');
 try {
  await link(join(dir,'outside'),join(workspace,'hard'));await expect(checkWorkspace(workspace)).rejects.toThrow('hardlink_denied');await rm(join(workspace,'hard'));
  await symlink(dir,join(workspace,'escape'),'junction');await expect(checkWorkspace(workspace)).rejects.toThrow('reparse_denied');await rm(join(workspace,'escape'));
  await writeFile(join(workspace,'normal'),'inside');await expect(checkWorkspace(workspace)).resolves.toBeUndefined();
 }finally{await rm(dir,{recursive:true,force:true});}
});
