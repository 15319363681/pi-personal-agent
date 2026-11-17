# Pi Personal Agent Product Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver a Windows-first local desktop MVP that turns continuous conversation into approved, resumable background tasks with safe workspace execution, artifact acceptance, outbox delivery, memory, model settings and observable task state.

**Architecture:** Electron Main owns the window, tray and Runtime child lifecycle. A single Runtime process owns SQLite and the task state machine; all UI and Main requests cross a narrow JSON RPC boundary. Runtime delegates file work to a disposable worker boundary, applies PermissionGateway checks, records task/outbox/memory state transactionally, and emits local Langfuse-compatible trace events without requiring Langfuse availability.

**Tech Stack:** Electron 45.3.3, Node 24 `node:sqlite`, TypeScript/React/Vite renderer, Vitest/Node test runner, Pi Durable-compatible task records, local fake providers for deterministic tests.

**Spec:** `docs/superpowers/specs/2026-11-17-pi-personal-agent-design.md`

## Global Constraints

- Windows-first; local-only UI/API in v1; no LAN/public listener.
- Runtime is the only SQLite writer; Main and renderer never open the database.
- Workspace access is limited to explicitly selected directories and rechecked on every operation.
- High-risk send/delete/modify operations require approval scoped to task contract and target.
- Unknown external delivery results remain `unknown` and block automatic resend.
- Real model credentials, real channels and deployment remain opt-in integrations; tests use fake providers.

## Review Focus

- Restart while a task is running: recovery must classify it as `interrupted` and resume only checkpoint-safe work.
- Approval contract mutation: changing recipient, tools, budget or acceptance criteria invalidates the approval.
- Workspace traversal and symlink/junction escape: admission must fail closed.
- Delivery result unknown: outbox must not resend automatically.
- Langfuse unavailable: task execution continues and local telemetry remains bounded.

### Task 1: Create the desktop app shell and runtime RPC boundary

**Files:**
- Create: `pi agent/apps/desktop/package.json`, `tsconfig.json`, `vite.config.ts`
- Create: `pi agent/apps/desktop/src/main.mjs`, `src/runtime.mjs`, `src/rpc.mjs`
- Create: `pi agent/apps/desktop/src/ui/index.html`, `src/ui/main.tsx`, `src/ui/styles.css`
- Test: `pi agent/apps/desktop/test/rpc.test.mjs`

**Interfaces:**
- `RuntimeRpc.request(method, params) -> Promise<{ok:boolean,result?:unknown,error?:{code,message}}>`
- Runtime methods: `chat.send`, `task.list`, `task.approve`, `task.pause`, `task.resume`, `task.cancel`, `settings.get`, `settings.update`.

- [x] Write RPC framing and malformed-message tests.
- [x] Implement Main spawning one Runtime child and forwarding renderer requests.
- [x] Implement the React shell with conversation, task list, settings and status panels.
- [x] Run `npm test -- --run test/rpc.test.mjs` and `npm run typecheck` from the desktop app directory.

### Task 2: Implement the Runtime store, contracts and recovery state machine

**Files:**
- Create: `src/runtime/store.mjs`, `src/runtime/contracts.mjs`, `src/runtime/state-machine.mjs`, `src/runtime/recovery.mjs`
- Test: `test/store-state-machine.test.mjs`, `test/recovery.test.mjs`

**Interfaces:**
- `RuntimeStore.open(path)`, `transaction(fn)`, `recoverInterruptedTasks()`, `listTasks()`.
- `createTaskProposal(input)`, `approveTask(taskId, approval)`, `transitionTask(taskId, next, reason)`.
- Task contract fields: goal, inputs, deliverables, acceptanceCriteria, allowedTools, budget, permissionSnapshot, contractHash, taskVersion.

- [x] Add schema and atomic transaction tests for proposal, approval, budget reservation and outbox intent.
- [x] Implement legal transitions and immutable contract hash validation.
- [x] Implement startup recovery from `running`/`waiting` to `interrupted` with checkpoint metadata.
- [x] Run store/recovery tests and typecheck.

### Task 3: Add PermissionGateway and worker execution with artifact acceptance

**Files:**
- Create: `src/runtime/permission-gateway.mjs`, `src/runtime/workspace.mjs`, `src/runtime/worker.mjs`, `src/runtime/task-runner.mjs`, `src/runtime/acceptance.mjs`
- Test: `test/permissions.test.mjs`, `test/task-runner.test.mjs`

**Interfaces:**
- `PermissionGateway.check(action, taskContract, context) -> {allowed, reason}`.
- `WorkspaceAdmission.open(root, mode)`, `readFile(taskId, path)`, `writeArtifact(taskId, path, bytes)`.
- `TaskRunner.run(taskId) -> {artifactId, evidence, status}`.

- [x] Test read-only/workspace-write/full-access policy and contract-bound target checks.
- [x] Test traversal, junction and outside-root denial using temporary fixtures.
- [x] Implement deterministic `collect_workspace` worker that creates a Markdown artifact with source paths and hashes.
- [x] Implement acceptance checks for artifact existence, source evidence and size; failed checks enter `needs_attention`.
- [x] Run permission and runner tests.

### Task 4: Implement outbox, delivery journal and local notification providers

**Files:**
- Create: `src/runtime/outbox.mjs`, `src/runtime/delivery-journal.mjs`, `src/runtime/providers/local-file.mjs`, `src/runtime/providers/telegram-contract.mjs`
- Test: `test/outbox.test.mjs`, `test/delivery-unknown.test.mjs`

**Interfaces:**
- `Outbox.enqueue(tx, event)`, `dispatch(eventId, provider)`, `resolveUnknown(eventId, decision)`.
- Provider contract: `validateConfig`, `connect`, `disconnect`, `capabilities`, `send`, optional `lookupDelivery`.

- [x] Test transactionally coupled outbox creation and completion notifications.
- [x] Test fake provider accepted-before-crash becomes `unknown` and is never auto-resubmitted.
- [x] Implement local-file provider for safe demo delivery and preserve the Telegram loopback contract as an adapter reference.
- [x] Implement completion/failure/attention notification coalescing.
- [x] Run outbox tests.

### Task 5: Add memory, model settings, backup and Langfuse-compatible observability

**Files:**
- Create: `src/runtime/memory.mjs`, `src/runtime/model-settings.mjs`, `src/runtime/backup.mjs`, `src/runtime/telemetry.mjs`
- Test: `test/memory-settings.test.mjs`, `test/backup-telemetry.test.mjs`

**Interfaces:**
- `MemoryStore.put/get/search/tombstone` with source and expiry metadata.
- `ModelSettings.list/upsert/delete` storing secrets only through an injected credential adapter.
- `BackupManager.create/restore` with recovery freeze.
- `Telemetry.emit` bounded local queue and optional Langfuse exporter.

- [x] Test memory conflict/tombstone behavior and model setting redaction.
- [x] Test backup integrity checks and recovery-mode freeze.
- [x] Test telemetry failure never blocks task completion and queue bounds are enforced.
- [x] Run memory/settings/backup tests.

### Task 6: Wire the end-to-end desktop scenario and product verification

**Files:**
- Modify: `src/runtime.mjs`, `src/main.mjs`, `src/ui/main.tsx`, `src/ui/styles.css`
- Create: `test/e2e-local-scenario.test.mjs`, `docs/superpowers/evidence/2026-11-17-pi-personal-agent-product-results.md`

- [x] Wire chat → proposal → approval → budget reservation → worker → acceptance → outbox → notification → UI refresh.
- [x] Add pause/resume/cancel controls and startup recovery display.
- [x] Add model/provider settings form, workspace selector and memory inspection panel.
- [x] Run the complete desktop test suite, typecheck and a packaged Electron smoke launch using only local fixtures.
- [x] Record actual commands, exits, artifacts, residual unverified integrations and final MVP status.

## Self-review

- Coverage maps every approved design subsystem to Tasks 1–6; real integrations are adapters with fake/local verification.
- Runtime, store, worker, outbox and UI interfaces are explicit and consumed in dependency order.
- Each task has an independent test cycle and no task requires a real account or external send.
- The review focus inputs have dedicated tests in Tasks 2–5.
- This plan deliberately implements a usable local MVP before adding remote Web/mobile transport.
