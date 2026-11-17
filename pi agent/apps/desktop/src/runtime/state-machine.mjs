import { transitions } from './contracts.mjs';

export function canTransition(from, to) { return Boolean(transitions[from]?.has(to)); }
export function assertTransition(from, to) { if (!canTransition(from, to)) throw Error(`invalid_transition:${from}->${to}`); return true; }
