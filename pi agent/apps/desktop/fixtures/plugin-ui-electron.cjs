const { app, BrowserWindow, ipcMain } = require('electron');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { writeFile } = require('node:fs/promises');
const assert = require('node:assert/strict');
const [page, dataDir, resultPath] = process.argv.slice(2);
app.setPath('userData', join(dataDir, 'electron'));
app.disableHardwareAcceleration();
let windowRef, runtime, runtimeProcess;
let runtimeStderr = "";

async function evaluate(source) { return windowRef.webContents.executeJavaScript(source); }
async function until(source) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await evaluate(source)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('UI condition timed out: ' + source);
}
async function click(label) {
  const found = await evaluate('(() => { const b = Array.from(document.querySelectorAll(".plugin-panel button")).find(b => b.textContent.trim() === ' + JSON.stringify(label) + '); if (!b || b.disabled) return false; b.click(); return true; })()');
  assert.equal(found, true, label);
}

app.whenReady().then(async () => {
  const { spawn } = require('node:child_process');
  const { RpcClient } = await import(pathToFileURL(join(__dirname, '../src/rpc.mjs')).href);
  runtimeProcess = spawn(process.execPath, [join(__dirname, '../src/runtime.mjs')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PI_AGENT_DATA_DIR: join(dataDir, 'runtime') },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  });
  runtimeProcess.stderr.on('data', (chunk) => { runtimeStderr += chunk; });
  const client = new RpcClient(runtimeProcess);
  runtime = {
    async handle(method, params) {
      let timer;
      try {
        return await Promise.race([
          client.request(method, params),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Runtime request timeout ' + method + ' ' + runtimeStderr)), 15000); })
        ]);
      } finally { clearTimeout(timer); }
    },
    async close() { await client.close(); }
  };
  const definition = { id: 'ui_stats', name: '界面统计插件', description: '统计字符数', source: '(input) => ({ length: input.text.length })', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, tests: [{ name: '基本样例', input: { text: 'abc' }, expected: { length: 3 } }] };
  assert.equal((await runtime.handle('plugins.save_draft', { definition })).ok, true);
  ipcMain.handle('runtime-request', (_event, { method, params }) => runtime.handle(method, params));
  windowRef = new BrowserWindow({ show: false, webPreferences: { preload: join(__dirname, '../src/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await windowRef.loadFile(page);
  await until('document.querySelector(".plugin-list")?.textContent.includes("界面统计插件")');
  await click('界面统计插件 · v1已停用 · 尚未测试');
  await until('document.querySelector(".plugin-detail pre")?.textContent.includes("input.text.length")');
  assert.equal(await evaluate('Array.from(document.querySelectorAll(".plugin-panel button")).find(b => b.textContent.includes("确认启用")).disabled'), true);
  assert.equal(await evaluate('document.querySelector(".plugin-approval input").disabled'), true);
  assert.match(await evaluate('document.querySelector(".plugin-detail").textContent'), /输入 JSON Schema/);
  assert.match(await evaluate('document.querySelector(".plugin-detail").textContent'), /基本样例/);
  await click('运行隔离测试');
  await until('document.querySelector(".plugin-approval input")?.disabled === false');
  await evaluate('document.querySelector(".plugin-approval input").click()');
  await until('Array.from(document.querySelectorAll(".plugin-panel button")).some(b => b.textContent === "确认启用 v1" && !b.disabled)');
  await click('确认启用 v1');
  await until('Array.from(document.querySelectorAll(".plugin-panel button")).some(b => b.textContent === "停用插件" && !b.disabled)');
  assert.equal((await runtime.handle('plugins.list')).result.plugins[0].enabled, true);
  assert.equal((await runtime.handle('plugins.run', { id: 'ui_stats', version: 1, arguments: { text: 'hello' } })).result.output.length, 5);
  assert.equal((await runtime.handle('plugins.save_draft', { definition: { ...definition, name: '界面统计新版' }, baseVersion: 1 })).ok, true);
  await until('document.querySelector(".plugin-detail h3")?.textContent.includes("v2")');
  assert.equal(await evaluate('document.querySelector(".plugin-approval input").checked'), false);
  assert.equal(await evaluate('document.querySelector(".plugin-approval input").disabled'), true);
  assert.equal((await runtime.handle('plugins.run', { id: 'ui_stats', version: 1, arguments: { text: 'hello' } })).error.code, 'plugin_version_conflict');
  await click('运行隔离测试');
  await until('document.querySelector(".plugin-approval input")?.disabled === false');
  await evaluate('document.querySelector(".plugin-approval input").click()');
  await until('Array.from(document.querySelectorAll(".plugin-panel button")).some(b => b.textContent === "确认启用 v2" && !b.disabled)');
  await click('确认启用 v2');
  await until('Array.from(document.querySelectorAll(".plugin-panel button")).some(b => b.textContent === "停用插件" && !b.disabled)');
  await click('停用插件');
  await until('document.querySelector(".plugin-approval input") && Array.from(document.querySelectorAll(".plugin-panel button")).some(b => b.textContent === "运行隔离测试" && !b.disabled)');
  assert.equal((await runtime.handle('plugins.list')).result.plugins[0].enabled, false);
  await click('删除插件');
  await until('!!document.querySelector(".plugin-panel [role=alertdialog]")');
  await click('确认删除');
  await until('document.querySelector(".plugin-list")?.children.length === 0');
  assert.deepEqual((await runtime.handle('plugins.list')).result.plugins, []);
  await writeFile(resultPath, JSON.stringify({ ok: true, checks: ['draft review', 'test gate', 'explicit version confirmation', 'real Worker execution', 'update invalidation', 'revocation', 'confirmed deletion'] }));
}).catch(async (error) => {
  await writeFile(resultPath, JSON.stringify({ ok: false, message: error.message, stack: error.stack, stderr: runtimeStderr, plugins: await runtime?.handle('plugins.get', { id: 'ui_stats' }).catch((cause) => ({ error: cause.message })), body: await windowRef?.webContents.executeJavaScript('document.querySelector(".plugin-panel")?.textContent') }));
  process.exitCode = 1;
}).finally(async () => {
  windowRef?.destroy();
  await runtime?.close();
  app.exit(process.exitCode ?? 0);
});
