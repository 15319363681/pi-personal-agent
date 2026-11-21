'use strict';
const { writeFile } = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');
const browser = process.type === 'browser';
const app = browser ? require('electron').app : null;
const [directory, resultPath] = process.argv.slice(2);
if (app) {
  app.disableHardwareAcceleration();
  app.setPath('userData', join(directory, 'electron-profile'));
}
async function main() {
  let worker;
  let result;
  try {
    const { PluginWorker } = await import(pathToFileURL(join(__dirname, '../src/runtime/plugin-worker.mjs')).href);
    worker = new PluginWorker({ dataDir: directory, timeoutMs: 5000 });
    const output = await worker.run({ source: '(input) => ({ answer: input.n + 1 })', input: { n: 8 } });
    let invalid;
    try { await worker.run({ source: '() => ({ missing: undefined })', input: {} }); }
    catch (cause) { invalid = cause.code; }
    result = { ok: true, output, invalid, host: browser ? 'electron-main' : 'electron-node', electron: process.versions.electron };
  } catch (cause) {
    result = { ok: false, code: cause.code, message: cause.message, stack: cause.stack, cause: cause.cause?.stack, exitCode: cause.cause?.exitCode };
  } finally { await worker?.close(); }
  await writeFile(resultPath, JSON.stringify(result));
  if (app) app.exit(0);
  else process.exit(0);
}
(app ? app.whenReady() : Promise.resolve()).then(main).catch(() => { if (app) app.exit(1); else process.exit(1); });