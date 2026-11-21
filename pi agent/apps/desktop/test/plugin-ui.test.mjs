import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'vite';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);

test('Electron plugin panel reviews, tests, confirms, updates, revokes and deletes a real local plugin', { timeout: 120000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-plugin-ui-'));
  try {
    await build({ configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), logLevel: 'silent', build: { outDir: join(dir, 'ui'), emptyOutDir: true } });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const resultPath = join(dir, 'result.json');
    let failed;
    try {
      await exec(require('electron'), [fileURLToPath(new URL('../fixtures/plugin-ui-electron.cjs', import.meta.url)), join(dir, 'ui/index.html'), dir, resultPath], { env, windowsHide: true, timeout: 100000 });
    } catch (error) { failed = error; }
    const resultText = await readFile(resultPath, 'utf8').catch(() => { throw new Error(failed?.stderr ?? failed?.message ?? 'Electron produced no result'); });
    const result = JSON.parse(resultText);
    assert.equal(result.ok, true, JSON.stringify(result) + (failed?.stderr ?? ''));
    assert.equal(failed, undefined, failed?.message);
    assert.equal(result.checks.length, 7);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
