import { test, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

test.runIf(process.platform === 'win32')('independent_processes_have_one_writer_and_abandoned_lease_is_detected', async () => {
  const script = resolve(dirname(fileURLToPath(import.meta.url)), '../src/writer-lock-child.mjs');
  const key = 'pi-spike-test-exclusive';
  const owner = spawn(process.execPath, [script, 'hold', key], { stdio: ['pipe', 'pipe', 'pipe'] });
  const output = await new Promise<string>((resolveText, reject) => {
    let text = '';
    owner.stdout.setEncoding('utf8').on('data', (chunk) => { text += chunk; if (text.includes('LOCKED')) resolveText(text); });
    owner.once('error', reject);
  });
  expect(output).toContain('abandoned=false');
  const contender = spawn(process.execPath, [script, 'try', key], { stdio: ['ignore', 'pipe', 'pipe'] });
  const err = await new Promise<string>((resolveText) => { let text = ''; contender.stderr.setEncoding('utf8').on('data', (chunk) => { text += chunk; }); contender.once('close', () => resolveText(text)); });
  expect(err).toContain('writer_busy');
  const ownerClosed = new Promise((resolveText) => owner.once('close', resolveText));
  owner.kill();
  await ownerClosed;
  const recovery = spawn(process.execPath, [script, 'try', key], { stdio: ['ignore', 'pipe', 'pipe'] });
  const recovered = await new Promise<string>((resolveText, reject) => {
    let text = '';
    recovery.stdout.setEncoding('utf8').on('data', (chunk) => { text += chunk; });
    recovery.once('error', reject);
    recovery.once('close', () => resolveText(text));
  });
  expect(recovered).toContain('LOCKED');
  expect(recovered).toContain('abandoned=');
});

test.runIf(process.platform === 'win32')('actual_Electron_Main_utility_Runtime_has_one_writer_and_live_owner_blocks_competitor', async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const runtime = resolve(root, 'src/electron-lock-runtime.mjs');
  const main = resolve(root, 'src/electron-lock-main.mjs');
  const require = createRequire(import.meta.url);
  const electron = require('electron');
  const dir = await mkdtemp(join(tmpdir(), 'pi-writer-owner-'));
  const key = join(dir, 'state.sqlite');
  const launch = (mode: string) => spawn(electron, [main, runtime, key, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
  const readUntil = (child: ReturnType<typeof spawn>, token: string) => new Promise<string>((resolveText, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${token}: ${output}`)), 10000);
    if (!child.stdout || !child.stderr) { clearTimeout(timer); reject(new Error('child_stdio_unavailable')); return; }
    child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; if (output.includes(token)) { clearTimeout(timer); resolveText(output); } });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
  try {
    const owner = launch('hold');
    expect(await readUntil(owner, 'RUNTIME_LOCKED')).toContain('abandoned=false');
    const second = launch('try');
    const secondOutput = await new Promise<string>((resolveText, reject) => { let output = ''; if (!second.stdout) { reject(new Error('second_stdout_unavailable')); return; } second.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; }); second.once('error', reject); second.once('close', () => resolveText(output)); });
    expect(secondOutput).toContain('RUNTIME_REJECTED writer_busy');
    expect(secondOutput).not.toContain('RUNTIME_LOCKED');
    const ownerClosed = new Promise<void>((resolveText) => owner.once('close', () => resolveText()));
    owner.kill();
    await ownerClosed;
  } finally { await rm(dir, { recursive: true, force: true }); }
});
