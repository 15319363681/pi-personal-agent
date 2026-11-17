import { test, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
const exec = promisify(execFile);
for (const probe of ['job-lifecycle', 'appcontainer-boundary']) {
  test(`Windows_${probe}_real_chain_and_controls`, async () => {
    const r = await exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(`../windows-worker/${probe}-probe.ps1`), '-Scenario', 'all'], { cwd: resolve('../..'), timeout: 90000, windowsHide: true });
    expect(r.stdout).toContain('PROBE_PASS');
    console.log(r.stdout);
  }, 100000);
}
