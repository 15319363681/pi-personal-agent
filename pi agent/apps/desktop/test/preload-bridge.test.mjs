import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

test('preload exposes only the runtime request bridge', async () => {
  const preloadPath = fileURLToPath(new URL('../src/preload.cjs', import.meta.url));
  const mainPath = fileURLToPath(new URL('../src/main.mjs', import.meta.url));
  const [preloadSource, mainSource] = await Promise.all([
    readFile(preloadPath, 'utf8'),
    readFile(mainPath, 'utf8')
  ]);
  let exposed;
  const requests = [];
  const contextBridge = { exposeInMainWorld: (key, value) => { exposed = { key, value }; } };
  const ipcRenderer = { invoke: async (...args) => { requests.push(args); return { ok: true }; } };
  const sandboxRequire = (name) => {
    assert.equal(name, 'electron', 'sandboxed preload must not import local modules');
    return { contextBridge, ipcRenderer };
  };

  new Function('require', preloadSource)(sandboxRequire);

  assert.match(mainSource, /preload: join\(here, 'preload\.cjs'\)/);
  assert.equal(exposed.key, 'piAgent');
  assert.deepEqual(await exposed.value.request('task.list'), { ok: true });
  assert.deepEqual(requests, [['runtime-request', { method: 'task.list', params: {} }]]);
  assert.deepEqual(Object.keys(exposed.value), ['request']);
});
