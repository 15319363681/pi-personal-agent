import { createHash, randomUUID } from 'node:crypto';

export const terminalStates = new Set(['completed', 'failed', 'timed_out', 'cancelled']);
export const transitions = {
  proposed: new Set(['approval_pending', 'cancelled']),
  approval_pending: new Set(['queued', 'cancelled']),
  queued: new Set(['running', 'paused', 'cancelled']),
  running: new Set(['waiting', 'retry_wait', 'paused', 'needs_attention', 'interrupted', 'completed', 'failed', 'timed_out', 'cancelled']),
  waiting: new Set(['queued', 'paused', 'cancelled', 'needs_attention']),
  retry_wait: new Set(['queued', 'needs_attention', 'failed', 'timed_out', 'cancelled']),
  paused: new Set(['queued', 'cancelled']),
  needs_attention: new Set(['queued', 'paused', 'failed', 'cancelled']),
  interrupted: new Set(['queued', 'paused', 'needs_attention', 'failed', 'cancelled']),
  completed: new Set(), failed: new Set(), timed_out: new Set(), cancelled: new Set()
};
export function hashContract(contract) { return createHash('sha256').update(JSON.stringify(contract)).digest('hex'); }
export function makeProposal(input = {}) {
  const now = Date.now();
  const contract = {
    goal: input.goal ?? 'Complete the requested personal task',
    inputs: input.inputs ?? { root: process.cwd() },
    deliverables: input.deliverables ?? [{ kind: 'file', path: 'report.md' }],
    acceptanceCriteria: input.acceptanceCriteria ?? [{ type: 'artifact_exists', path: 'report.md' }],
    allowedTools: input.allowedTools ?? ['workspace.read', 'workspace.write'],
    budget: { modelCalls: 0, toolCalls: 10, costCents: 0, ...(input.budget ?? {}) }
  };
  return { id: input.id ?? randomUUID(), taskVersion: 1, status: 'approval_pending', contract, contractHash: hashContract(contract), budgetReservedCents: 0, createdAt: now, updatedAt: now };
}
