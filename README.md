# Pi Personal Agent

Windows-first local desktop MVP for turning conversation into approved, resumable tasks. The repository also contains the disposable Spike probes used to validate the runtime and worker boundaries.

This is an early implementation snapshot, not a production-ready agent. Real model calls and external delivery are disabled or unverified. The recorded test results and remaining security limits are documented under `docs/superpowers/evidence/`.

## Contents

- `pi agent/apps/desktop/`: Electron and React local MVP.
- `spikes/pi-durable-validation/`: Pi Durable, SQLite, recovery, writer ownership, and provider contract probes.
- `spikes/windows-worker/`: Windows Job Object and AppContainer probes. Build the native probe locally with `build-probe.ps1`.
- `docs/superpowers/specs/` and `docs/superpowers/plans/`: approved design and implementation plans.
- `docs/superpowers/evidence/`: final Spike and product reports plus the provider capability matrix.

The upstream Pi and CowAgent source snapshots, downloaded archives, dependency folders, generated bundles, local databases, and intermediate logs are intentionally excluded.

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
