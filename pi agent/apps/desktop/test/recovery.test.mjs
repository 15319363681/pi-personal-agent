import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeStore } from '../src/runtime/store.mjs';

test('startup recovery classifies running tasks as interrupted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-product-recovery-'));
  try { const path=join(dir,'agent.sqlite'); let store=await RuntimeStore.open(path); const p=store.createTaskProposal({goal:'x'}); store.approveTask(p.id,{permissionMode:'read-only'}); store.transitionTask(p.id,'running'); store.close(); store=await RuntimeStore.open(path); assert.equal(store.getTask(p.id).status,'interrupted'); store.close(); } finally { await rm(dir,{recursive:true,force:true}); }
});
