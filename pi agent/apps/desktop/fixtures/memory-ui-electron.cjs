const { app, BrowserWindow, ipcMain, safeStorage, clipboard } = require('electron');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { readFile, writeFile } = require('node:fs/promises');
const assert = require('node:assert/strict');
const [page, dataDir, resultPath] = process.argv.slice(2);
const importSource = (path) => import(pathToFileURL(join(__dirname, '../src', path)).href);
app.setPath('userData', join(dataDir, 'electron'));
app.disableHardwareAcceleration();
let windowRef, runtime;
let stage = 0;
const checks = [];


const evaluate = (code) => windowRef.webContents.executeJavaScript(code);
async function until(code) {
  for (let n = 0; n < 150; n++) {
    if (await evaluate(`Boolean(${code})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 70));
  }
  throw new Error(`UI condition unavailable: ${code}`);
}
async function activate(selector) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  windowRef.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
  windowRef.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
}
async function type(selector, text) {
  await evaluate(`(() => {
    const e = document.querySelector(${JSON.stringify(selector)});
    e.focus();
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e), 'value').set.call(e, ${JSON.stringify(text)});
    e.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}

const hasText = (selector, text) => 'document.querySelector(' + JSON.stringify(selector) + ')?.textContent.includes(' + JSON.stringify(text) + ')';

app.whenReady().then(async () => {
  const { createRuntime } = await importSource('runtime.mjs');
  const { createRuntimeRequestHandler } = await importSource('runtime-request.mjs');
  runtime = await createRuntime({ dataDir: join(dataDir, 'runtime') });
  const handler = createRuntimeRequestHandler({ runtimeClient: { request: (method, params) => runtime.handle(method, params) }, vault: { has: async () => false } });
  ipcMain.handle('runtime-request', (_event, request) => handler(request));
  windowRef = new BrowserWindow({ show: false, width: 900, height: 650, webPreferences: { preload: join(__dirname, '../src/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  await windowRef.loadFile(page);
  await until("document.querySelector('.memory-panel summary')");
  await activate('.memory-panel summary');
  await until("document.querySelector('.memory-panel').open");
  await type('.memory-panel textarea', '喜欢中文');
  await activate('.memory-panel form button');
  await until("document.querySelector(\".memory-list\")?.textContent.includes(\"喜欢中文\")");
  assert.equal(runtime.memory.snapshot().entries.length, 0);
  checks.push('keyboard proposal remains pending');
  await activate('.memory-item .panel-actions button');
  await until("document.querySelector(\".memory-list\")?.textContent.includes(\"已批准\")");
  assert.equal(runtime.memory.snapshot().entries[0].text, '喜欢中文');
  checks.push('specific version approval');
  await activate('.memory-item .panel-actions button:first-child');
  await type('.memory-panel textarea', '喜欢简洁中文');
  await activate('.memory-panel form button');
  await until("document.querySelector(\".memory-list\")?.textContent.includes(\"喜欢简洁中文\")");
  assert.equal(runtime.memory.snapshot().entries[0].text, '喜欢中文');
  await evaluate("Array.from(document.querySelectorAll('.memory-item')).find(e => e.textContent.includes('喜欢简洁中文')).querySelector('.panel-actions button').click()");
  await until("!document.querySelector('.memory-list').textContent.includes('待审核')");
  assert.equal(runtime.memory.snapshot().entries[0].text, '喜欢简洁中文');
  checks.push('edit awaits replacement approval');
  await activate('.memory-item .danger');
  assert.equal(runtime.memory.snapshot().entries.length, 1);
  await activate('.memory-item .inline-confirm .danger');
  await until("document.querySelector(\".memory-list\")?.textContent.includes(\"还没有个人记忆\")");
  assert.equal(runtime.memory.snapshot().entries.length, 0);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
  checks.push('confirmed deletion and compact layout');
  await writeFile(resultPath, JSON.stringify({ ok: true, checks }));
}).catch(async error => {
  await writeFile(resultPath, JSON.stringify({ ok: false, checks, error: error.stack }));
  process.exitCode = 1;
}).finally(async () => { await runtime?.close(); windowRef?.destroy(); app.exit(process.exitCode ?? 0); });
