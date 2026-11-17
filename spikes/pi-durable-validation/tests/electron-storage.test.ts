import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { test, expect } from 'vitest';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function runRuntime(databasePath: string, phase: string, script = 'electron-runtime-probe.mjs', extra: string[] = []) {
  const main = resolve(root, 'src/electron-storage-main.mjs');
  return new Promise<any>((resolveResult, reject) => {
    const child = spawn(require('electron'), [main, resolve(root, 'src', script), databasePath, phase, ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      const line = stdout.split(/\r?\n/).find((row) => row.startsWith('STORAGE_RESULT='));
      if (code === 0 && line) resolveResult(JSON.parse(line.slice('STORAGE_RESULT='.length)));
      else reject(new Error(`Electron ${phase} exit=${code}; stdout=${stdout}; stderr=${stderr}`));
    });
  });
}
async function killRuntimeAtCheckpoint(databasePath: string, scenario = 'crash', script = 'electron-runtime-probe.mjs', extra: string[] = []) {
  const main = resolve(root, 'src/electron-crash-main.mjs');
  return new Promise<string>((resolveResult, reject) => {
    const child = spawn(require('electron'), [main, resolve(root, 'src', script), databasePath, scenario, ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 && stdout.includes('KILLED_EXIT=') ? resolveResult(stdout) : reject(new Error(`Electron kill exit=${code}; stdout=${stdout}; stderr=${stderr}`)));
  });
}

test('actual_Electron_utility_process_imports_Durable_commits_reopens_and_reports_SQLite_mode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-electron-storage-'));
  try {
    const path = join(dir, 'durable.sqlite');
    const write = await runRuntime(path, 'write');
    const reopen = await runRuntime(path, 'reopen');
    for (const report of [write, reopen]) {
      expect(report.type).toBe('utility');
      expect(report.electron).toBe('45.3.3');
      expect(report.pragmas.journalMode).toBe('wal');
      expect(report.pragmas.synchronous).toBe(2);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const scenario of ['precommit', 'postcommit', 'blockedModel', 'safeTool', 'unsafeTool']) {
  test(`actual_Electron_Durable_crash_boundary_${scenario}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-electron-boundary-'));
    try {
      const path = join(dir, 'db.sqlite');
      const killed = await killRuntimeAtCheckpoint(path, scenario, 'electron-durable-runtime.mjs', ['crash']);
      expect(killed).toContain('BOUNDARY=');
      const r = await runRuntime(path, scenario, 'electron-durable-runtime.mjs', ['recover']);
      expect(r.type).toBe('utility'); expect(r.integrity).toBe('ok');
      expect(r.journal).toBe('wal'); expect(r.synchronous).toBe(2);
      const business = r.entries.filter((e: any) => e.kind.startsWith('spike.business.'));
      if (scenario === 'precommit') { expect(business).toHaveLength(0); expect(r.tasks).toHaveLength(0); }
      if (scenario === 'postcommit') { expect(business).toHaveLength(6); expect(r.tasks).toHaveLength(1); }
      if (scenario === 'blockedModel') { expect(r.modelCalls).toBe(1); expect(r.entries.filter((e: any) => e.kind === 'pi.user')).toHaveLength(1); }
      if (scenario === 'safeTool') expect(r.tools).toHaveLength(1);
      if (scenario === 'unsafeTool') { expect(r.tools).toHaveLength(0); expect(JSON.stringify(r.entries)).toContain('interrupted'); }
      console.log('ELECTRON_BOUNDARY', scenario, JSON.stringify({ type: r.type, journal: r.journal, synchronous: r.synchronous, integrity: r.integrity, businessRows: business.length, tools: r.tools.length, modelCalls: r.modelCalls }));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test('actual_Electron_Runtime_process_kill_preserves_committed_checkpoint_for_reopen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-electron-crash-'));
  try {
    const path = join(dir, 'durable.sqlite');
    const output = await killRuntimeAtCheckpoint(path);
    expect(output).toContain('READY_TO_KILL');
    expect(output).toContain('KILLED_EXIT=');
    const reopened = await runRuntime(path, 'reopen');
    expect(reopened.pragmas.synchronous).toBe(2);
    expect(reopened.pragmas.journalMode).toBe('wal');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
