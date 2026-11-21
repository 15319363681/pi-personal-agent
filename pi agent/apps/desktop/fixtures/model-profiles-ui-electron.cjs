const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { readFile, writeFile, readdir } = require('node:fs/promises');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const [page, dataDir, resultPath] = process.argv.slice(2);
app.setPath('userData', join(dataDir, 'electron'));
app.disableHardwareAcceleration();
let windowRef, runtime, provider, vault;
let runtimeStderr = '';
let failConnection = false;
let mutateDuringTest = false;
const requests = [];
const updates = [];
const removals = [];
const checks = [];

async function evaluate(source) { return windowRef.webContents.executeJavaScript(source); }
async function until(source) {
  const deadline = Date.now() + 18000;
  while (Date.now() < deadline) {
    if (await evaluate(source)) return;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw Error('UI condition timed out ' + source);
}
async function click(label) {
  assert.equal(await evaluate('(() => { const b = Array.from(document.querySelectorAll("button")).find(b => b.textContent === ' + JSON.stringify(label) + '); if (!b || b.disabled) return false; b.click(); return true; })()'), true, label);
}
async function field(label, value, tag = 'input') {
  await evaluate('(() => { const l = Array.from(document.querySelectorAll(".model-settings-panel label")).find(l => l.firstChild.textContent.trim() === ' + JSON.stringify(label) + '); const e = l.querySelector(' + JSON.stringify(tag) + '); const descriptor = Object.getOwnPropertyDescriptor(' + (tag === 'select' ? 'HTMLSelectElement' : 'HTMLInputElement') + '.prototype, "value"); descriptor.set.call(e, ' + JSON.stringify(value) + '); e.dispatchEvent(new Event(' + JSON.stringify(tag === 'select' ? 'change' : 'input') + ', { bubbles: true })); })()');
}
async function fill(name, model, key) {
  await field('配置名称', name);
  await field('Provider', 'openai-compatible', 'select');
  await field('Model', model);
  await field('端点 Base URL', 'http://127.0.0.1:' + provider.address().port + '/v1');
  await field('API Key', key);
}
async function save() {
  await until('Array.from(document.querySelectorAll(".model-settings-panel button")).some(b => b.textContent === "保存配置" && !b.disabled)');
  assert.equal(await evaluate('(() => { const b = Array.from(document.querySelectorAll(".model-settings-panel button")).find(b => b.textContent === "保存配置"); if (!b || b.disabled) return false; b.click(); return true; })()'), true);
  await until('document.querySelector(".model-notice")?.textContent.includes("配置已安全保存")');
}
async function verify() {
  await click('测试连接');
  await until('document.querySelector(".model-notice")?.textContent.includes("连接成功") && document.querySelector(".model-settings-panel").getAttribute("aria-busy") === "false"');
}
async function send(text) {
  await evaluate('(() => { const e = document.querySelector(".composer textarea"); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(e, ' + JSON.stringify(text) + '); e.dispatchEvent(new Event("input", { bubbles: true })); })()');
  await until('Array.from(document.querySelectorAll(".composer button")).some(b => b.textContent === "发送消息" && !b.disabled)');
  await click('发送消息');
  await until('document.querySelector(".composer textarea").value === ""');
}
async function startRuntime() {
  const { RpcClient } = await import(pathToFileURL(join(__dirname, '../src/rpc.mjs')).href);
  const child = spawn(process.execPath, [join(__dirname, '../src/runtime.mjs')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PI_AGENT_DATA_DIR: join(dataDir, 'runtime') }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stderr.on('data', (chunk) => { runtimeStderr += chunk; });
  const client = new RpcClient(child);
  runtime = { handle: (method, params) => client.request(method, params), close: () => client.close() };
}

app.whenReady().then(async () => {
  provider = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ model: body.model, authorization: request.headers.authorization, stream: body.stream });
    if (!body.stream) {
      response.writeHead(failConnection ? 401 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }], usage: { total_tokens: 2 } }));
      return;
    }
    const events = [
      { id: 'profiles', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '来自 ' + body.model }, finish_reason: null }] },
      { id: 'profiles', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
    ];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n');
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  await startRuntime();
  const { CredentialVault } = await import(pathToFileURL(join(__dirname, '../src/credential-vault.mjs')).href);
  const { createRuntimeRequestHandler } = await import(pathToFileURL(join(__dirname, '../src/runtime-request.mjs')).href);
  vault = new CredentialVault({ safeStorage, directory: join(dataDir, 'credentials') });
  const handler = createRuntimeRequestHandler({ runtimeClient: { request: (method, params) => runtime.handle(method, params) }, vault });
  ipcMain.handle('runtime-request', async (_event, request) => {
    if (request.method === 'settings.update') updates.push(request.params.setting.id);
    if (request.method === 'settings.remove') removals.push(request.params.id);
    const result = await handler(request);
    if (request.method === 'settings.test' && mutateDuringTest) {
      mutateDuringTest = false;
      const all = await runtime.handle('settings.get');
      const current = all.result.settings.find((item) => item.id === request.params.settingId);
      await runtime.handle('settings.update', { setting: { ...current, name: current.name + ' 已修改' } });
    }
    return result;
  });
  windowRef = new BrowserWindow({ show: false, width: 1180, height: 820, webPreferences: { preload: join(__dirname, '../src/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  await windowRef.loadFile(page);
  await until('document.querySelector(".model-settings-panel")?.getAttribute("aria-busy") === "false"');
  assert.equal((await runtime.handle('settings.get')).result.activeSettingId, null);
  checks.push('initial empty state');
  await fill('日常对话', 'first-model', 'first-fixture-secret');
  await evaluate('(() => { const b = Array.from(document.querySelectorAll(".model-settings-panel button")).find(b => b.textContent === "保存配置"); b.click(); b.click(); })()');
  await until('document.querySelector(".model-notice")?.textContent.includes("配置已安全保存")');
  assert.equal(updates.length, 1);
  checks.push('single-flight profile save');
  await verify();
  await send('first profile question');
  assert.equal(requests.find((item) => item.stream).model, 'first-model');
  assert.equal(requests.find((item) => item.stream).authorization, 'Bearer first-fixture-secret');
  checks.push('real Pi uses first encrypted profile');
  await field('Model', 'unsaved-model');
  await new Promise((resolve) => setTimeout(resolve, 1700));
  assert.equal(await evaluate('Array.from(document.querySelectorAll(".model-settings-panel label")).find(l => l.firstChild.textContent === "Model").querySelector("input").value'), 'unsaved-model');
  await click('新增配置');
  await until('!!document.querySelector(".model-confirmation")');
  assert.equal(await evaluate('document.activeElement.textContent'), '保留并返回');
  windowRef.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  windowRef.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await until('!document.querySelector(".model-confirmation")');
  checks.push('dirty draft survives polling and keyboard cancellation');
  await click('新增配置');
  await click('放弃并切换');
  await until('!document.querySelector(".model-confirmation") && Array.from(document.querySelectorAll(".model-settings-panel label")).find(l => l.firstChild.textContent === "Model").querySelector("input").value === ""');
  await fill('资料处理', 'second-model', 'second-fixture-secret');
  await save();
  await verify();
  await click('设为当前模型');
  await until('document.querySelector(".model-notice")?.textContent === "已设为当前对话模型"');
  await send('second profile question');
  const second = requests.filter((item) => item.stream).at(-1);
  assert.equal(second.model, 'second-model');
  assert.equal(second.authorization, 'Bearer second-fixture-secret');
  const configuration = (await runtime.handle('settings.get')).result;
  const secondId = configuration.activeSettingId;
  const secondRef = configuration.settings.find((item) => item.id === secondId).credentialRef;
  checks.push('profile selection controls model and credentials');
  const settingsText = await readFile(join(dataDir, 'runtime/model-settings.json'), 'utf8');
  assert.doesNotMatch(settingsText, /first-fixture-secret|second-fixture-secret|apiKey/);
  for (const file of await readdir(join(dataDir, 'credentials'))) assert.doesNotMatch(await readFile(join(dataDir, 'credentials', file), 'utf8'), /fixture-secret/);
  checks.push('real safeStorage encrypted persistence');
  await runtime.close();
  await startRuntime();
  await windowRef.reload();
  await until('document.querySelector("#model-profile-select")?.selectedOptions[0]?.textContent.includes("资料处理 · 当前")');
  assert.equal((await runtime.handle('settings.get')).result.activeSettingId, secondId);
  checks.push('runtime restart preserves active profile');
  failConnection = true;
  await click('测试连接');
  await until('!!document.querySelector(".model-error")');
  assert.equal(await evaluate('Array.from(document.querySelectorAll(".composer button")).find(b => b.textContent === "发送消息").disabled'), true);
  failConnection = false;
  await verify();
  checks.push('failed test keeps composer locked and retry succeeds');
  mutateDuringTest = true;
  await click('测试连接');
  await until('document.querySelector(".model-error")?.textContent.includes("测试期间配置发生变化")');
  assert.equal(await evaluate('document.querySelector(".conversation .panel-heading span").textContent.includes("连接未验证")'), true);
  await verify();
  checks.push('stale connection result cannot validate changed profile');
  await click('删除配置');
  await new Promise((resolve) => setTimeout(resolve, 1800));
  assert.equal(await evaluate('!!document.querySelector(".model-confirmation")'), true, 'polling must preserve an open confirmation');
  await click('保留并返回');
  assert.equal((await runtime.handle('settings.get')).result.settings.length, 2);
  await click('删除配置');
  await evaluate('(() => { const b = Array.from(document.querySelectorAll(".model-confirmation button")).find(b => b.textContent === "确认删除"); b.click(); b.click(); })()');
  await until('document.querySelector(".model-notice")?.textContent.includes("模型配置及对应本机凭据已删除")');
  assert.equal(removals.length, 1);
  assert.equal(await vault.has(secondRef), false);
  assert.equal((await runtime.handle('settings.get')).result.settings.length, 1);
  checks.push('confirmed deletion and encrypted credential cleanup');
  windowRef.setSize(900, 820);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
  const log = await readFile(join(dataDir, 'runtime/logs/runtime.jsonl'), 'utf8');
  assert.doesNotMatch(log, /fixture-secret|first profile question|second profile question/);
  checks.push('small window and log redaction');
  await writeFile(resultPath, JSON.stringify({ ok: true, checks }));
}).catch(async (error) => {
  await writeFile(resultPath, JSON.stringify({ ok: false, message: error.message, stack: error.stack, checks, stderr: runtimeStderr, body: await windowRef?.webContents.executeJavaScript('document.querySelector(".model-settings-panel")?.textContent') }));
  process.exitCode = 1;
}).finally(async () => {
  windowRef?.destroy();
  await runtime?.close();
  provider?.closeAllConnections();
  if (provider) await new Promise((resolve) => provider.close(resolve));
  app.exit(process.exitCode ?? 0);
});
