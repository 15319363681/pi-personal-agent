import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeStore } from '../src/runtime/store.mjs';
import { TaskRunner } from '../src/runtime/task-runner.mjs';

test('runner creates and accepts a workspace report', async () => {
 const dir=await mkdtemp(join(tmpdir(),'pi-product-runner-')); try { const store=await RuntimeStore.open(join(dir,'agent.sqlite')); const p=store.createTaskProposal({goal:'Collect workspace notes',inputs:{root:dir},deliverables:[{kind:'file',path:'report.md'}],acceptanceCriteria:[{type:'artifact_exists',path:'report.md'}],allowedTools:['workspace.read','workspace.write'],budget:{toolCalls:5}}); store.approveTask(p.id,{permissionMode:'workspace-write'}); const result=await new TaskRunner(store).run(p.id); assert.equal(result.status,'completed'); assert.match(await readFile(result.artifactPath,'utf8'),/Pi Personal Agent report/); store.close(); } finally {await rm(dir,{recursive:true,force:true});}
});

test('runner preserves a paused task instead of completing it', async () => {
 const dir=await mkdtemp(join(tmpdir(),'pi-product-runner-paused-')); try { const store=await RuntimeStore.open(join(dir,'agent.sqlite')); const p=store.createTaskProposal({goal:'pause me',inputs:{root:dir}}); store.approveTask(p.id,{permissionMode:'workspace-write'}); store.transitionTask(p.id,'paused'); const result=await new TaskRunner(store).run(p.id); assert.equal(result.status,'paused'); assert.equal(store.getTask(p.id).status,'paused'); store.close(); } finally {await rm(dir,{recursive:true,force:true});}
});
