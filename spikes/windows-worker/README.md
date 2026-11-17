# Windows worker boundary spike

This directory contains the disposable native Windows probe used by the Pi Personal Agent Spike. It is test infrastructure, not product runtime code.

Build the probe from `D:/Atry`:

```powershell
powershell.exe -NoProfile -File .\spikes\windows-worker\build-probe.ps1
```

Run the two acceptance probes from `D:/Atry`:

```powershell
powershell.exe -NoProfile -File .\spikes\windows-worker\job-lifecycle-probe.ps1 -Scenario all
powershell.exe -NoProfile -File .\spikes\windows-worker\appcontainer-boundary-probe.ps1 -Scenario all
```

The lifecycle probe exercises the actual Electron Main to utility Runtime to native worker to child and grandchild chain. It verifies Job membership, forced Runtime/Main cleanup, and that `cleanup_complete` precedes assignment of a replacement Runtime.

The boundary probe first runs ordinary-process positive controls against the same files and loopback endpoints. It then runs the restricted worker chain with workspace admission, a read-only workspace, an AppContainer token, and a non-breakaway Job. File traversal, junction escape, direct TCP/UDP/DNS/HTTP(S)/proxy access, and out-of-scope writes must be denied. Network receipts must remain unchanged by restricted attempts.

The probe uses temporary files, loopback servers, private per-user kernel-object names and disposable AppContainer profiles. It does not contact external services. A passing process-crash probe does not establish sudden power-loss durability, and the spike does not claim a real cross-user ACL test.
