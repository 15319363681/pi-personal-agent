# Pi Personal Agent Spike and Provider Capability Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Produce a disposable, reproducible validation of Pi Durable, Windows worker isolation/recovery, single-writer ownership, and a source-backed CowAgent provider capability matrix before any product application code is started.

**Architecture:** Keep all executable probes under `spikes/` and all evidence under `docs/superpowers/evidence/`; do not modify the local Pi or CowAgent reference trees. The gate is fail-closed: only a fully passing Spike and a complete provider matrix permit writing the separate product implementation plans. Any failed mandatory test returns to design review.

**Tech Stack:** Node.js `>=22.19.0`, TypeScript, Vitest, Electron `45.3.3` (Node `24.22.3` in the Electron main process), Pi Durable/Pi AI/Chord `1.5.2`, SQLite, Windows PowerShell 5.1, and small Win32 P/Invoke probes for Job Objects and AppContainer behavior.

**Spec:** `docs/superpowers/specs/2026-11-17-pi-personal-agent-design.md`

## Global Constraints

- Pi Durable is the only conversation and execution-state authority; do not have `AgentSession` manage the same conversation.
- A business state transition must commit task state, approval, budget reservation, permission/plugin snapshot, and outbox atomically.
- Durable SQLite has one writer process; a mutex is a second guard, not a replacement for worker cleanup.
- Do not modify `pi agent/`, `cowagent-master-extracted/CowAgent-master/`, or other reference-source directories.
- The workspace root has no Git repository; do not initialize one or create commits as part of this disposable Spike.
- Do not send real external messages, use production credentials, or enable production provider accounts during the Spike.
- Windows worker tests must fail closed if process-tree exit, workspace containment, or default network denial cannot be proved.
- No product UI, product runtime, or product provider implementation starts before the gate passes.
- Record exact OS, Node, package, and tool versions with every Spike result.

## Review Focus

- Runtime dies during a model request: reopening preserves one admitted input and exposes the interrupted/retry outcome without claiming the provider call ran exactly once. Test in `durable-recovery.test.ts`.
- A tool ignores cancellation or starts a child process: no new Runtime starts until every process in the Job is gone. Test in `job-lifecycle-probe.ps1`.
- An older database backup is restored after a message was sent: journal evidence is reconciled and an unknown send is never automatically repeated. Test in `delivery-recovery-contract.test.ts` using a fake provider only.
- A worker is asked to follow a link outside the workspace or upload a file directly: the escape and direct network attempts fail. Test in `appcontainer-boundary-probe.ps1`.
- Two processes attempt to drive one SQLite Durable store, or one multi-record commit fails: the second writer is rejected and partial business state is not observable. Test in `single-writer.test.ts` and `atomic-commit.test.ts`.

---

## Phase 1: Disposable Spike and Provider Matrix

This plan ends at the architecture gate. It does not implement the product application. If the gate passes, write separately reviewable plans for Runtime/storage, permissions and workers, task acceptance/budgets, delivery providers, memory/data maintenance, desktop UI, and Langfuse evaluation using the evidence collected here. If a gate item fails, stop and revise the design before writing those plans.

### Task 1: Create the Isolated Pi Durable Probe

**Files:**
- Create: `spikes/pi-durable-validation/package.json`
- Create: `spikes/pi-durable-validation/package-lock.json`
- Create: `spikes/pi-durable-validation/tsconfig.json`
- Create: `spikes/pi-durable-validation/vitest.config.ts`
- Create: `spikes/pi-durable-validation/tests/runtime-version.test.ts`
- Create: `spikes/pi-durable-validation/src/electron-runtime-version-probe.ts`

**Interfaces:**
- Consumes: the local Pi package snapshots under `pi agent/packages/` as the version reference; package manifests identify Durable `1.5.2` and Node `>=22.19.0`.
- Produces: a locked, disposable Node test project that imports published package APIs and cannot write to either reference tree.

- [x] **Step 1: Create the minimal test project and add a failing prerequisite test**

Create a minimal `package.json` with a `test` script, `tsconfig.json`, and `vitest.config.ts`. Add `runtime-version.test.ts` asserting both host Node and Electron main-process `process.versions.node` are at least `22.19.0`, and that the resolved Pi package versions are exactly `1.5.2`. The Electron probe prints its embedded Node version and exits without opening a window.

- [x] **Step 2: Run the test before adding the probe dependencies**

Run: `npm test` from `spikes/pi-durable-validation/`.
Expected: FAIL because Pi packages, Vitest, and the Electron runtime have not yet been installed.

- [x] **Step 3: Add the pinned probe project**

Add exact dependencies `@earendil-works/pi-durable@1.5.2`, `@earendil-works/pi-ai@1.5.2`, `@earendil-works/chord@1.5.2`, Electron `45.3.3`, TypeScript, `tsx`, and Vitest. Do not copy CowAgent's locked Electron `33.4.11`: it embeds Node `20.18.3`, below Pi Durable's `>=22.19.0` engine requirement. Set `engines.node` to `>=22.19.0`; add `test`, `typecheck`, and `versions` scripts. Generate and retain the npm lockfile. The probe must use a temporary data directory and must not import from the reference tree at runtime.

- [x] **Step 4: Run the prerequisite test and typecheck**

Run: `npm test` and `npm run typecheck` from `spikes/pi-durable-validation/`.
Expected: PASS; measured host Node `24.10.0`, utility Node `24.22.3`, Electron `45.3.3`, and all three Pi packages `1.5.2`.

### Task 2: Prove Durable Conversation, Tool, and Crash-Recovery Semantics

**Files:**
- Create: `spikes/pi-durable-validation/src/harness-fixture.ts`
- Create: `spikes/pi-durable-validation/src/crash-worker.ts`
- Create: `spikes/pi-durable-validation/tests/durable-recovery.test.ts`
- Create: `spikes/pi-durable-validation/tests/fixtures/fake-provider.ts`

**Interfaces:**
- Consumes: Task 1's locked Pi Durable test project.
- Produces: `createHarnessFixture(databasePath, scenario)` returning `{ harness, root, callLog, close }`; `scenario` is `normal`, `blockedModel`, or `blockedTool` and uses no network credentials. The crash child reports fake-provider calls to the parent over IPC so the parent can assert them after termination.

- [x] **Step 1: Write the normal persistence and duplicate-request tests**

Add `reopens_the_same_conversation_and_does_not_duplicate_request_id` and `persists_a_custom_task_checkpoint`. Assert the same `requestId` resolves to the original submission after reopen and the custom task checkpoint remains readable.

- [x] **Step 2: Run those tests to verify the fixture is missing**

Run: `npm test -- tests/durable-recovery.test.ts` from `spikes/pi-durable-validation/`.
Expected: FAIL because the fixture and tests have not been implemented.

- [x] **Step 3: Implement the SQLite-backed fixture and deterministic fake provider**

Use `openNodeSqliteStorage`, `Harness.open`, and `createRegistry`. The fake provider records every request and can block on a test-controlled signal. It must never make an HTTP request.

- [x] **Step 4: Add crash-boundary tests**

Add `recovers_after_process_exit_during_model_request`, `replays_only_tools_declared_safe`, and `returns_interrupted_for_non_replayable_tool`. Spawn `crash-worker.ts` with `node --import tsx`, terminate it at the controlled boundary, reopen the same SQLite file, and assert the documented Durable outcome and IPC call log. Do not assert exactly-once model execution; record model retries as a cost/recovery behavior for the next design stage.

- [x] **Step 5: Run and typecheck the recovery suite**

Run: `npm test -- tests/durable-recovery.test.ts` and `npm run typecheck`.
Expected: all named tests PASS; the SQLite file passes `PRAGMA integrity_check` after each forced exit.

### Task 3: Prove Atomic Business Commits and Single-Writer Ownership

**Files:**
- Create: `spikes/pi-durable-validation/tests/atomic-commit.test.ts`
- Create: `spikes/pi-durable-validation/tests/single-writer.test.ts`
- Create: `spikes/pi-durable-validation/src/electron-main-probe.ts`
- Create: `spikes/pi-durable-validation/src/runtime-probe.ts`
- Create: `spikes/pi-durable-validation/tests/fixtures/failing-storage.ts`

**Interfaces:**
- Consumes: Task 2's SQLite harness.
- Produces: a tested Spike transaction containing `task`, `approval`, `budgetReservation`, `permissionSnapshot`, `pluginVersion`, and `outbox` records in the same commit as the Durable checkpoint; an Electron Main probe that starts at most one Runtime for a given user data directory.

- [x] **Step 1: Write rollback and competing-writer tests**

Add `business_transition_is_all_or_nothing` and `second_process_cannot_drive_the_same_database`. The first asserts that each record is either entirely present or entirely absent after an injected commit failure. The second starts two independent processes against one database and asserts exactly one can call `resume()` or submit work.

- [x] **Step 2: Run the tests to verify they fail before the probes exist**

Run: `npm test -- tests/atomic-commit.test.ts tests/single-writer.test.ts`.
Expected: FAIL because the probes and fault-injection storage are not implemented.

- [x] **Step 3: Test Durable's native commit boundary**

Use one `conversation.commit(...)` to combine a Durable checkpoint and the six business records. Inject a storage write failure at commit time. If the public API cannot include those records in one atomic commit, test a single-connection/single-transaction adapter; do not accept a serial queue that performs separate commits.

- [x] **Step 4: Implement and test the single-writer guard**

Main uses Electron single-instance locking; Runtime additionally acquires an OS-owned exclusive per-database writer lease BEFORE writable Harness/SQLite opens, and holds it until all handles close. Sequence: cleanup barrier -> writer lease -> integrity check -> writable open -> recovery/scheduling/admission. Abandoned ownership never bypasses cleanup or integrity. Independent Runtime losers must produce zero writable-open/resume/submit/commit events. Keep a readOnly observer test proving zero recovery/scheduling writes. See mandatory executable additions below.

- [x] **Step 5: Run the commit and writer tests**

Run: `npm test -- tests/atomic-commit.test.ts tests/single-writer.test.ts`.
Expected: PASS; injected commit failure leaves no partial business state, and the competing Electron launch produces one Runtime owner and one rejected process.

### Task 4: Prove the Backup-Recovery Delivery Journal Contract

**Files:**
- Create: `spikes/pi-durable-validation/src/delivery-journal.ts`
- Create: `spikes/pi-durable-validation/tests/delivery-recovery-contract.test.ts`

**Interfaces:**
- Consumes: Task 3's transactional delivery intent and SQLite test database.
- Produces: `appendJournalRecord(journalPath, record)` that appends one JSONL record and calls `FileHandle.sync()` before returning; `reconcileDelivery(databasePath, journalPath, provider)` that never resends an unknown attempt.

- [x] **Step 1: Write backup rollback and ambiguous-send tests**

Add `restores_confirmed_delivery_from_journal_after_old_database_backup` and `does_not_resend_when_provider_accepted_before_result_was_journaled`. Use a fake provider with a send counter and deterministic receipts; assert the restored state is `delivered` in the first case and `unknown`/`needs_attention` in the second, with no second provider send.

- [x] **Step 2: Run the tests before implementing the journal**

Run: `npm test -- tests/delivery-recovery-contract.test.ts`.
Expected: FAIL because the journal and reconciliation helper are absent.

- [x] **Step 3: Implement the append-only journal and recovery helper**

Append `attempting` and terminal outcome records without rewriting earlier lines. Flush each record before the next external or database step. The journal is outside the SQLite backup set. On recovery, match by stable `deliveryId`; never infer success from an `attempting` record alone.

- [x] **Step 4: Run the delivery recovery tests**

Run: `npm test -- tests/delivery-recovery-contract.test.ts`.
Expected: PASS; old-backup recovery reconstructs a fsynced receipt, while an unconfirmed attempt remains unknown and cannot be automatically resent.

### Task 5: Validate Windows Job Cleanup and Workspace/Network Boundaries

**Files:**
- Create: `spikes/windows-worker/job-lifecycle-probe.ps1`
- Create: `spikes/windows-worker/appcontainer-boundary-probe.ps1`
- Create: `spikes/windows-worker/fixtures/worker-tree.ps1`
- Create: `spikes/windows-worker/README.md`

**Interfaces:**
- Consumes: the Windows behavior promised by the design spec and Task 3's single-writer gate.
- Produces: reproducible PowerShell probes for Job membership/termination, named Job reopen after host exit, workspace containment, direct network denial, and the startup barrier.

- [x] **Step 1: Add the worker-tree fixture and Job lifecycle assertions**

The fixture starts a child process that starts a grandchild and ignores a cooperative stop signal. The probe creates a named Job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, creates workers suspended, assigns them before resuming user code, and records all PIDs and creation times.

- [x] **Step 2: Run the lifecycle probe and record its baseline**

Run: `powershell.exe -NoProfile -File .\spikes\windows-worker\job-lifecycle-probe.ps1 -Scenario all` from the workspace root.
Expected: initial run reports the unimplemented assertions as failures.

- [x] **Step 3: Implement Job cleanup and restart-barrier probes**

Verify both graceful `TerminateJobObject` plus active-process wait and abrupt owner-process exit with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. A restarted probe may continue only after `OpenJobObject` reports active count zero or returns the documented object-not-found result; access denied, timeout, identity mismatch, or any other error must fail closed. Assert no child or grandchild remains before the simulated Runtime-start marker is written.

- [x] **Step 4: Add AppContainer boundary cases**

Test read/write access to a selected workspace, denial of a sibling/outside file, `..` traversal, symlink/junction escape, and direct DNS/TCP/HTTP(S) attempts. Verify that a brokered fake web request is accepted only for an approved host and rejected when the host changes. No public Internet request is made.

- [x] **Step 5: Run the Windows probes**

Run: `powershell.exe -NoProfile -File .\spikes\windows-worker\job-lifecycle-probe.ps1 -Scenario all` and `powershell.exe -NoProfile -File .\spikes\windows-worker\appcontainer-boundary-probe.ps1 -Scenario all`.
Expected: every required assertion passes on the target Windows account. If AppContainer cannot prove workspace/network containment, the gate fails and returns to design review; do not silently substitute an unrestricted shell.

### Task 6: Build the CowAgent Provider Capability Matrix

**Files:**
- Create: `docs/superpowers/evidence/2026-11-17-provider-capability-matrix.json`
- Create: `docs/superpowers/evidence/2026-11-17-provider-capability-matrix.md`
- Create: `spikes/pi-durable-validation/tests/provider-matrix-completeness.test.ts`

**Interfaces:**
- Consumes: read-only source inspection of `cowagent-master-extracted/CowAgent-master/channel/channel_factory.py`, `channel/channel_instances.py`, each registered channel implementation, its README/docs, and the desktop channel settings flow.
- Produces: a source-backed JSON matrix and human-readable report covering all 14 registered channel types: `terminal`, `web`, `wechatmp`, `wechatmp_service`, `wechatcom_app`, `wechat_kf`, `feishu`, `dingtalk`, `wecom_bot`, `qq`, `telegram`, `slack`, `discord`, and `weixin`. JSON is the testable source of truth; Markdown links each conclusion to source paths and line numbers.

- [x] **Step 1: Add a failing completeness test**

Add `matrix_covers_every_registered_channel_and_required_capability`. Read the JSON matrix and assert one row per listed channel type and fields for outbound text, files/attachments, auth/configuration, callback/public URL need, delivery receipt/query, idempotency, rate limits, Windows dependencies, disconnect/revoke, and source evidence. `unknown` is allowed only with a reason and source checked.

- [x] **Step 2: Run the matrix test before creating the matrix**

Run: `npm test -- tests/provider-matrix-completeness.test.ts`.
Expected: FAIL because the matrix file is absent.

- [x] **Step 3: Inspect channel registration and implementations read-only**

For every registered type, inspect send methods, credentials/setup, passive-reply or callback requirements, provider receipts/query APIs, dependency imports, and disconnect/cleanup. Cite repository-relative file paths and line numbers in the matrix. Mark `terminal` and `web` as local interfaces rather than outbound notification providers where supported by the source.

- [x] **Step 4: Classify v1 candidates conservatively**

Select a channel for v1 only if source evidence establishes active outbound sending, feasible user-approved configuration, and Windows-compatible runtime dependencies. Mark unverified idempotency/receipt behavior as unknown. Do not send messages to real accounts or contacts as part of this task.

- [x] **Step 5: Run the completeness check and review each row**

Run: `npm test -- tests/provider-matrix-completeness.test.ts`.
Expected: PASS; all 14 channel types are represented, every required capability is evidence-backed or explicitly unknown, and only qualified providers appear in the proposed v1 set.

### Task 7: Produce the Gate Report and Stop/Go Decision

**Files:**
- Create: `docs/superpowers/evidence/2026-11-17-pi-personal-agent-spike-results.md`
- Modify: `docs/superpowers/plans/2026-11-17-pi-personal-agent-spike.md`

**Interfaces:**
- Consumes: outputs from Tasks 1-6, including raw test logs, environment versions, and the provider matrix.
- Produces: one auditable `PASS` or `FAIL` result for every gate condition and a single overall decision.

- [x] **Step 1: Write the report from observed results only**

Record OS build, Node/npm versions, exact Pi/Electron package versions, commands, exit codes, logs/artifact paths, provider-matrix source paths and the SHA-256 of the available CowAgent source archive, and each assertion's result. Do not infer a pass from source inspection alone for runtime or security behavior.

- [x] **Step 2: Apply the mandatory gate**

The overall result is `PASS` only when all are true: Durable SQLite conversation and checkpoint survive reopen; crash boundaries produce documented recovery outcomes; safe and unsafe tool replay differ correctly; business state is atomic; only one process can drive the database; delivery recovery handles both confirmed and ambiguous sends without unsafe repetition; Job cleanup prevents old workers surviving Runtime restart; workspace and network escapes are denied; the provider matrix covers every registered channel; every proposed v1 provider has evidence for active text delivery, configuration, and Windows runtime compatibility; and no unresolved security-critical result remains.

- [x] **Step 3: Stop on any failed or unknown mandatory result**

If any mandatory condition fails or is unknown, mark overall `FAIL`, list the design decision that must change, and do not begin product implementation. The next action is design review and a revised Spike plan.

- [x] **Step 4: Run the complete Spike verification set**

Run: `npm test`, `npm run typecheck`, `powershell.exe -NoProfile -File .\spikes\windows-worker\job-lifecycle-probe.ps1 -Scenario all`, and `powershell.exe -NoProfile -File .\spikes\windows-worker\appcontainer-boundary-probe.ps1 -Scenario all`.
Expected: every command exits `0`; the report records an overall `PASS`. Do not create product UI/runtime files in this plan.

- [x] **Step 5: Handoff for review**

If every mandatory gate passes, write subsystem plans from measured interfaces, self-review and execute directly under the latest continuous-execution authorization. Self-review is not separate human approval.

## 2026-11-17 mandatory executable additions

These additions are part of Tasks 1-7, not optional documentation. They supersede any conflicting older step. Electron 45.3.3 and its Node version are candidates until measured. Runtime process type: Electron utilityProcess.fork(), launched by real Electron Main; host Node/ELECTRON_RUN_AS_NODE is not acceptance evidence.

### Task 2 addition — actual Electron SQLite (G2)
- [x] Create src/electron-runtime-probe.mjs and tests/electron-storage.test.ts. Inside actual utility Runtime import Durable/SQLite adapter; open temporary database, atomically commit business records, close/reopen, kill at controlled pre/post-commit and model/tool boundaries, reopen behind ownership/cleanup gate.
- [x] Query journal_mode and synchronous on SAME Durable connection; assert WAL and FULL (=2), including after reopen. If adapter overrides configuration, verify a same-connection adapter, never a second connection with cosmetic PRAGMAs. integrity_check must return ok and no partial commit survives.
- [x] Run npm test -- tests/electron-storage.test.ts tests/durable-recovery.test.ts and npm run typecheck from D:/Atry/spikes/pi-durable-validation; require exit 0 and measured versions/WAL/FULL/recovery records. Process crash tests do not establish sudden power-loss survival.

### Task 3 addition — actual Runtime ownership (G1)
- [x] Add native Windows writer lease helper and tests independent_runtime_competition_has_one_writer, main_death_with_old_runtime_alive_blocks_restart, abandoned_owner_requires_cleanup_and_integrity_check, observer_never_recovers_schedules_or_writes to tests/single-writer.test.ts.
- [x] acquireWriter(dbPath): WriterLease is called by actual writer before writable storage import/open; OS releases on death, release only after Harness close. Test TWO independent OS Runtime processes, old Runtime alive after Main death, corruption and cleanup uncertainty. Exactly one process may recover/schedule/commit; loser cannot open writable DB.
- [x] Run npm test -- tests/atomic-commit.test.ts tests/single-writer.test.ts from D:/Atry/spikes/pi-durable-validation; require exit 0, atomic all-or-none and lifetime ordering markers.

### Task 4 addition — journal faults and restore freeze (G3)
- [x] Add parameterized pre_send_journal_failure_never_calls_provider at FileHandle write/fsync boundaries: fake provider count=0.
- [x] Add post_send_journal_failure_is_unknown_and_never_retries at result write/fsync: count=1, SQLite never confirmed delivered, persists unknown and blocks resend across reopen.
- [x] Add incomplete_journal_tail_is_not_success: truncated JSON/record/checksum detected, valid prefix retained, tail quarantined; incomplete or unconfirmed record cannot prove success.
- [x] restoreBackup persists recovery_mode BEFORE admission. guardOperation(kind) denies model/send/notification. Add restore_freezes_model_send_and_notifications, reconciliation_does_not_automatically_exit_recovery, explicit_exit_rejects_unresolved_deliveries, explicit_user_exit_after_reconciliation_unfreezes. Include journal-only attempts and backup-only intents; receipt reconstruction never silently thaws execution.
- [x] Run npm test -- tests/delivery-recovery-contract.test.ts from D:/Atry/spikes/pi-durable-validation; exit 0; each I/O fault has counter/state assertions. Temporary DB/fake provider only.

### Task 5 addition — positive controls and real process chain (G4)
- [x] Create spikes/windows-worker/fixtures/Win32Probe.cs and build script plus tests/windows-process-chain.test.ts. Native helper manages sole non-inheritable Job handle, suspended spawn/assign/resume, active-count wait, exclusive writer lease, no-network-capability AppContainer and temporary fixture ACL grants. No worker executes user code before Job assignment; no breakaway. Cleanup own test resources only.
- [x] Ordinary process reads/writes SAME existing inside/outside files and connects to SAME live controlled TCP/HTTP/DNS resource before restricted denial. Record successful server receipt. Control failure => failed test, never isolation evidence. Cover read/write vs read-only, traversal, junction/reparse/descendants, direct DNS/TCP/UDP/HTTP(S)/proxy denial and exact-scope broker.
- [x] Actual chain Electron Main -> utility Runtime -> worker -> child -> grandchild, with PID/creation-time/membership/timestamps. Kill Runtime, kill Main, restart immediately; old tree exit plus cleanup-complete must precede new execution marker. Test unknown/access-denied Job state and writer abandonment; fail closed.
- [x] Run npm test -- tests/windows-process-chain.test.ts from D:/Atry/spikes/pi-durable-validation; run both original PowerShell probes from D:/Atry. Require all exit 0 plus success controls/denied escapes/ordering assertions.

### Tasks 6-7 additions — evidence and gate
- [x] Matrix distinguishes sourceEvidence, runtimeVerification and realDeliveryVerification. No real delivery is authorized; candidate does not mean production validated.
- [x] Final mandatory gates include ALL original conditions PLUS G1/G2/G3/G4 above. Each has command/cwd/exit/log/assertions; any FAIL or UNKNOWN => Stop, no product implementation.
- [x] Run full npm test and typecheck in D:/Atry/spikes/pi-durable-validation, both Windows scripts in D:/Atry, record actual results and perform a separate single-agent final self-review.

## Plan changes and self-review (current agent, 2026-11-17)
- Four user requirement groups map to named tests and final G1-G4. Commands have cwd and exit=0 plus behavior criteria; missing infrastructure is UNKNOWN.
- Interface preflight: Task1 locked deps -> Task2 Harness/utility fixture -> Task3 atomic commit/writer lease -> Task4 intent/journal; Task3+5 wrap all recovery in cleanup/ownership; Task6 matrix -> Task7 gate. No separate writable projection or serial-queue substitute for atomicity.
- Main-only lock contradiction and per-plan human waiting removed per design/latest authorization. No design/security boundary change.
- Git helpers/worktrees/commits are replaced by docs/superpowers/evidence/2026-11-17-spike-progress.md and command logs; root Git remains absent. Preserve evidence. Final review is author self-review, no fresh-context/human approval claim.

## 执行中收敛的接口与补充测试（2026-11-17）

本节取代早期示意接口/文件名，不更改设计契约。`.mjs` 是实际 Node/Electron ESM helper，测试保留 `.test.ts`。

- Task 2：`createHarnessFixture(path, scenario='normal', recovering=false, options={})`，scenario 为 normal/blockedModel/safeTool/unsafeTool；返回 harness/root/fake/context/db/storage/close/integrity/createCheckpoint/atomicTransition/entrySequences/failNextTransaction。真实 Electron 入口是 `electron-crash-main.mjs` → `electron-durable-runtime.mjs`；测试 `electron-storage.test.ts`、`durable-recovery.test.ts`。
- Task 3：`acquireWriter(path, timeoutMs): {abandoned, release}` 在真实路径/当前 SID 下创建 OS Mutex，开可写数据库前持有。`writer-contract.test.ts` 增加 Main 单实例、旧 Runtime 存活、cleanup/integrity 失败、只读 observer；`single-writer.test.ts` 保留基础竞争。`beforeCommit(tx)` 插入 delivery intent 后再注入 abort，证明 intent 与六项业务记录一起回滚。执行目录 D:/Atry/spikes/pi-durable-validation，命令 `npm test -- tests/atomic-commit.test.ts tests/single-writer.test.ts tests/writer-contract.test.ts tests/delivery-durable-integration.test.ts`，exit=0 且 loser writable-open/恢复/提交均零。
- Task 4：实际接口 `openDeliveryDb(path)`、`sendDelivery(db,journalPath,provider,io?)`、`reconcile(db,journalPath)`、`restoreBackup(db,backupPath)`（仅 offline，在 Harness 打开前）、`guardOperation(db,kind)`、`exitRecoveryMode(db,{userConfirmed})`。`resolveDelivery(db,path,id,{userConfirmed,decision,note,receipt?})` 只记录人工裁定，不发送。`acknowledgeJournalCorruption(db,path,{userConfirmed,note})` 保留隔离证据并记录审核。
- Task 4 新增 `delivery-fault-boundaries.test.ts`：结果 fsync+截断均失败后关闭重开、恢复旧备份仍 unknown；provider 已接收后杀进程，无结果回执，禁止重发；journal-only 损坏必须冻结并人工审核；backup-only intent 转 unknown。待确认 fence 与 journal 同在备份集之外，发送前落盘，成功结果落盘且数据库确认后才移除；残留 fence 保守转 unknown。命令 `npm test -- tests/delivery-recovery-contract.test.ts tests/delivery-edge-contract.test.ts tests/delivery-fault-boundaries.test.ts tests/delivery-durable-integration.test.ts`，exit=0；各故障断言 provider 次数及跨重开状态。故障隔离和 fence 只验证进程崩溃，不声明断电证明。
- Task 5：`Win32Probe.cs` 替代 worker-tree.ps1，native CreateProcess/AppContainer/Job 链路。`kernel-object-security.test.ts` 检查用户 SID 命名、非继承 handle、实际 DACL 和第二 owner 拒绝；`workspace-admission.test.ts` 检查硬链接与 junction，先 admission 再授权目录 ACL。后代与普通进程执行同一边界测试。命令 `npm test -- tests/kernel-object-security.test.ts tests/workspace-admission.test.ts tests/windows-process-chain.test.ts` 以及原两个 PowerShell 命令，exit=0，正向 control、网络 receipt、真实链路清理顺序必需通过。
- Task 6：矩阵区分 source-qualified candidates、本地协议运行验证、真实投递验证。补 `outbound-adapter-probe.mjs` 和 `outbound-adapter.test.ts`，`createTelegramProbe({origin,token,recipient})` 提供 validateConfig/connect/disconnect/capabilities/send；origin 只允许受控 loopback，fake HTTP 验证配置、主动发送、message_id、断开、认证/限流/断网未知，绝不自动重试不明发送。源为 Telegram send/_send_with_retry（原源码重试不可照搬）。这是 Windows Node 协议可行性证明，不是原 Python SDK、真实网络或上线验证；产品 adapter 单独实现与测试。命令 `npm test -- tests/outbound-adapter.test.ts tests/provider-matrix-completeness.test.ts`，exit=0，14 行源码核对/候选分类准确。
- Task 7：G1-G4 必须包括以上新增测试；单独作者自审记录与完整 suite/typecheck/两项脚本都通过后才 Go。需要真实凭证/收费/投递的项目始终列未验证，不以本地 mock 代替。

自查：以上接口均由明确文件产出，Task3/4 共用同一 connection/transaction；新补要求对应具体测试和目录明确的命令。无子智能体、无 Playwright、无根 Git。自查是作者执行，不是用户逐份审核。
