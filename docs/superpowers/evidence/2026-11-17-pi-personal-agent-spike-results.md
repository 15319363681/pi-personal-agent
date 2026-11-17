# Pi Personal Agent Spike Results

Date: 2026-11-17

This report records the disposable Spike only. It does not claim production readiness, sudden power-loss durability, cross-user ACL coverage, real provider delivery, or deployment validation.

## Environment

- OS: Windows x64.
- Host Node: 24.10.0.
- Electron Runtime: Electron 45.3.3, utility Runtime Node 24.22.3.
- Pi packages: `@earendil-works/chord`, `@earendil-works/pi-ai`, and `@earendil-works/pi-durable`, all 1.5.2.
- CowAgent source snapshot: `cowagent.zip`, SHA-256 `7ED49EC842B3F322B72FA4A809D1BCF77B378D0E459460E204E65BB3A0B08726`; inspected read-only.
- All data stores, providers, servers and credentials were disposable or fake. No paid model call and no real account send occurred.

## Mandatory gates

| Gate | Result | Evidence and command | Observed assertion |
|---|---|---|---|
| G1 Runtime single-writer ownership | PASS | `npm test -- tests/writer-contract.test.ts tests/single-writer.test.ts` from `D:/Atry/spikes/pi-durable-validation`; `task3-contract-final-attempt.log`; `spike-full-npm-test-final.log` | Two independent Runtime processes compete for one OS lease; loser performs zero writable-open/recovery/commit; suspended old Runtime blocks restart after Main death; cleanup and integrity precede recovery; read-only observer performs no recovery, scheduling, model call or write. |
| G2 Electron Durable/SQLite compatibility | PASS | `task2-electron-boundaries.log`; full suite `spike-full-npm-test-final.log`; `npm run typecheck` from `D:/Atry/spikes/pi-durable-validation` | Real Electron Main → utility Runtime imports Durable/SQLite, commits, closes and reopens; same connection reports WAL and `synchronous=FULL` (=2); controlled pre/post commit and model/tool crashes recover as designed; integrity check passes. This is process-crash evidence only. |
| G3 Delivery journal fault and recovery freeze | PASS | `npm test -- tests/delivery-fault-boundaries.test.ts tests/delivery-recovery-contract.test.ts tests/delivery-edge-contract.test.ts tests/delivery-durable-integration.test.ts tests/atomic-commit.test.ts`; `task4-fault-boundaries-green-attempt1.log`; `spike-full-npm-test-final.log` | Pre-send journal/fsync failure makes provider calls zero; post-send result failure persists `unknown` and blocks resend across reopen; incomplete tails are quarantined; pending fences prevent unsafe replay; backup restore freezes model/send/notification until reconciliation and explicit user exit. |
| G4 Windows isolation and process cleanup | PASS | `task5-job-direct-final.log`, `task5-boundary-direct-final.log`, `spike-job-lifecycle-final.log`, `spike-appcontainer-boundary-final-rerun.log`; both PowerShell probes from `D:/Atry` | Actual Electron Main → utility Runtime → native worker → child → grandchild chain is cleaned on Runtime/Main termination; old handles are signaled before replacement assignment; ordinary-process controls succeed on the same files/endpoints; restricted descendants deny outside/traversal/junction writes and direct TCP/UDP/DNS/HTTP(S)/proxy access. |
| Provider source matrix and local protocol probe | PASS | `npm test -- tests/outbound-adapter.test.ts tests/provider-matrix-completeness.test.ts`; `task6-matrix-final.log`; matrix JSON/Markdown | All 14 CowAgent registrations are represented with source evidence and explicit unknown reasons. Telegram is source-qualified and its controlled loopback Node protocol probe passes; real delivery remains `not_run`; `v1OutboundCandidates` remains empty. |
| Full regression and typecheck | PASS | `spike-full-npm-test-final.log`; `spike-full-typecheck-final.log` | Vitest: 15 test files, 40 tests passed. TypeScript no-emit passed. |

## Stop/Go decision

**GO for the next phase: writing and executing product subsystem plans.** All mandatory Spike gates above passed, and no unresolved security-critical failure remains in the tested single-user process-crash boundary.

The following are explicit limitations rather than hidden passes:

- Sudden power-loss durability was not tested; SQLite process-crash behavior must not be presented as a power-loss guarantee.
- Cross-user ACL denial was not directly exercised. The probe verified the current-user private DACL, non-inherited handles, Job membership and AppContainer restrictions.
- Host-user TOCTOU attacks, file symlink coverage and every possible Windows reparse form were not exhaustively tested; workspace admission rejects the tested hard-link and junction cases and the product boundary must remain fail-closed.
- No real Telegram, email, enterprise chat, paid model or external account was contacted. The matrix intentionally keeps `v1OutboundCandidates` empty until a separately authorized adapter and account test exist.
- Langfuse connectivity, retention and production redaction are not part of this disposable Spike.

## Author self-review

I performed one separate author self-review after the final test runs by reading the approved design, the revised Spike plan, the ledger, each G1–G4 implementation/test entry point, the provider matrix, and the final logs. I checked that every user-added requirement maps to a concrete test and command, that the actual interfaces in the plan match the files, and that the report does not turn source inspection or fake-provider results into real-delivery claims. This was not an independent reviewer pass and is not a claim of user review.

## Artifacts

- Revised plan: `docs/superpowers/plans/2026-11-17-pi-personal-agent-spike.md`
- Progress ledger: `docs/superpowers/evidence/2026-11-17-spike-progress.md`
- Provider matrix: `docs/superpowers/evidence/2026-11-17-provider-capability-matrix.json` and `.md`
- Windows probe notes: `spikes/windows-worker/README.md`
