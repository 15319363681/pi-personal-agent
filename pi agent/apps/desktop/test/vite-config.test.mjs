import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadConfigFromFile } from 'vite';

test('Vite emits relative asset paths for Electron file loading', async () => {
  const configPath = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
  const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, configPath);

  assert.equal(loaded.config.base, './');
});
