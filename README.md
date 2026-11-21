# Pi Personal Agent

Pi Personal Agent is a Windows 11 desktop Agent for an individual user. The desktop app uses Pi Agent Core and Pi AI for model-driven conversation and provides bounded, read-only tools for a user-selected workspace through the Harness. Local protocol tests and an isolated Electron smoke run verify the current integration. Compatibility with a real model provider and the Windows desktop click-through remain unverified.

The repository also contains disposable Spike probes for Runtime, persistence, delivery and worker boundaries. This is an active implementation, not a production-ready product. Current product direction and implementation order are documented under `docs/superpowers/specs/` and `docs/superpowers/plans/`.

## Contents

- `pi agent/apps/desktop/`: Electron and React local MVP.
- `pi agent/packages/`: local Pi package source snapshots used for reference and integration work; excluded from Git.
- `cowagent-master-extracted/CowAgent-master/`: canonical CowAgent reference source used by the capability matrix and design documents; excluded from Git.
- `spikes/pi-durable-validation/`: Pi Durable, SQLite, recovery, writer ownership, and provider contract probes.
- `spikes/windows-worker/`: Windows Job Object and AppContainer probes. Build the native probe locally with `build-probe.ps1`.
- `docs/superpowers/specs/` and `docs/superpowers/plans/`: approved design and implementation plans.
- `docs/superpowers/evidence/`: final Spike and product reports plus the provider capability matrix.
- `references/`: local-only duplicate source snapshots, partial clone metadata, downloaded archives, and research helper files; excluded from Git.

Downloaded archives, duplicate or incomplete upstream snapshots, dependency folders, generated bundles, local databases, and intermediate logs are intentionally excluded.

## Local checks

Run the desktop MVP checks from `pi agent/apps/desktop/`:

```powershell
npm ci
npm test
npm run typecheck
npm run build
```

Run the Node Spike checks from `spikes/pi-durable-validation/`:

```powershell
npm ci
npm test
npm run typecheck
```

The Windows probes require Windows PowerShell and the permissions described in `spikes/windows-worker/README.md`.

## Review notes

A static review found an unresolved Spike contract gap: `sendDelivery` can call its provider when no persisted delivery intent exists. The Spike uses fake providers, so this is not evidence of a real message being sent, but the intent-before-send invariant is not yet proven. The recovery-mode Spike also tests the model and notification guard directly rather than exercising real model and notification integrations. Treat these delivery and recovery claims as incomplete until the gaps are addressed and revalidated.
