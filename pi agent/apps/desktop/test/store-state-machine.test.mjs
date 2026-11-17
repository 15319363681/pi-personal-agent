import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeStore } from '../src/runtime/store.mjs';

test('approval atomically reserves budget and creates an outbox event', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-product-store-'));
  try {
    const store = await RuntimeStore.open(join(dir, 'agent.sqlite'));
    const proposal = store.createTaskProposal({ goal: 'Collect workspace notes', inputs: { root: dir }, deliverables: [{ kind: 'file', path: 'report.md' }], acceptanceCriteria: [{ type: 'artifact_exists', path: 'report.md' }], allowedTools: ['workspace.read', 'workspace.write'], budget: { modelCalls: 4, toolCalls: 8, costCents: 100 } });
    assert.equal(proposal.status, 'approval_pending');
    const approved = store.approveTask(proposal.id, { permissionMode: 'workspace-write', providerInstance: 'local-file', recipient: join(dir, 'outbox') });
    assert.equal(approved.status, 'queued');
    assert.equal(store.getTask(proposal.id).budgetReservedCents, 100);
    assert.equal(store.listOutbox().length, 1);
    store.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('illegal task transition is rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-product-state-'));
  try { const store = await RuntimeStore.open(join(dir, 'agent.sqlite')); const p = store.createTaskProposal({ goal: 'x' }); assert.throws(() => store.transitionTask(p.id, 'completed'), /invalid_transition/); store.close(); } finally { await rm(dir, { recursive: true, force: true }); }
});
