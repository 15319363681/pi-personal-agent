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
let requestCount = 0;
let searchError = false;
const checks = [];
const secret = 'electron-brave-fixture-token';
const query = '公开许可说明';
const sourceUrl = 'https://example.org/terms';

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
const mode = (name) => `.mode-switch button:nth-child(${name === 'chat' ? 1 : 2})`;
const submit = '.composer > button:last-child';
const textarea = '.composer textarea';
const hasText = (selector, text) => `document.querySelector(${JSON.stringify(selector)})?.textContent.includes(${JSON.stringify(text)})`;

app.whenReady().then(async () => {
  const [{ createRuntime }, { CredentialVault }, { createRuntimeRequestHandler }] = await Promise.all([
    importSource('runtime.mjs'), importSource('credential-vault.mjs'), importSource('runtime-request.mjs')
  ]);
  const sealedDir = join(dataDir, 'sealed-search');
  const vault = new CredentialVault({ safeStorage, directory: join(dataDir, 'model-keys') });
  const searchVault = new CredentialVault({ safeStorage, directory: sealedDir });
  const options = { dataDir: join(dataDir, 'runtime'), fetchImpl: async (url, init) => {
    if (new URL(url).hostname === 'api.search.brave.com') {
      requestCount++;
      assert.equal(init.headers['X-Subscription-Token'], secret);
      assert.equal(JSON.parse(init.body).q, query);
      if (searchError) return new Response(null, { status: 429 });
      return Response.json({ type: 'search', web: { results: [{ title: '<img src=x>许可', url: sourceUrl, description: '摘要支持许可条款。' }] } });
    }
    const body = JSON.parse(init.body);
    if (!body.stream) return Response.json({ choices: [{ message: { content: 'OK' } }] });
    assert.equal(body.tools?.length ?? 0, 0);
    assert.doesNotMatch(JSON.stringify(body), /electron-brave-fixture-token|私有草稿/);
    const content = JSON.stringify({ claims: [
      { text: '有许可条款', sourceIds: ['S1'], status: 'cited' }, { text: '缺少维护者身份', sourceIds: [], status: 'unverified' }
    ] });
    const chunks = [{ role: 'assistant', content }, {}].map((delta, index) => ({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason: index === 1 ? 'stop' : null }] }));
    return new Response(chunks.map((chunk) => 'data: ' + JSON.stringify(chunk) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } };
  runtime = await createRuntime(options);
  const handler = createRuntimeRequestHandler({ vault, searchVault, copyText: (text) => clipboard.writeText(text), runtimeClient: { request: (method, params) => runtime.handle(method, params) } });
  ipcMain.handle('runtime-request', (_event, request) => handler(request));
  assert.equal((await handler({ method: 'settings.update', params: { setting: {
    id: 'default', provider: 'openai-compatible', model: 'fixture', baseUrl: 'https://model.invalid/v1', apiKey: 'fixture-model-secret'
  } } })).ok, true);
  windowRef = new BrowserWindow({ show: false, width: 900, height: 650, webPreferences: {
    preload: join(__dirname, '../src/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false
  } });
  await windowRef.loadFile(page);
  await until('document.querySelector(".model-settings-panel")');
  await until(`Array.from(document.querySelectorAll('.model-settings-panel button')).some(b => b.textContent.includes('测试连接') && !b.disabled)`);
  await evaluate(`Array.from(document.querySelectorAll('.model-settings-panel button')).find(b => b.textContent.includes('测试连接')).click()`);
  await until(hasText('.conversation .panel-heading', '连接已测试'));
  await type(textarea, '私有草稿');
  await activate(mode('research'));
  await until(`document.querySelector('#research-send-scope') && document.querySelector('${textarea}').value === ''`);
  await until(`document.querySelector('${submit}').disabled`);
  checks.push('mode, privacy and initial state');
  await activate('.research-setup');
  await until(`document.activeElement.id === 'research-api-key'`);
  await type('#research-api-key', secret);
  await activate('.research-settings button[type=submit]');
  await until(hasText('.research-settings summary', '已保存密钥'));
  assert.ok(!(await readFile(join(sealedDir, 'brave.credential'), 'utf8')).includes(secret));
  await activate('.research-settings [aria-expanded]');
  await until(`document.activeElement.textContent === '取消'`);
  windowRef.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  windowRef.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await until(`document.activeElement.textContent === '移除密钥' && !document.querySelector('.research-confirm')`);
  checks.push('protected key and keyboard confirmation');
  await type(textarea, query);
  await activate(submit);
  await until(hasText('.research-result', '有许可条款'));
  assert.ok(await evaluate(hasText('.research-result', '依据搜索摘要')));
  assert.ok(await evaluate(hasText('.research-result', '无法核实')));
  await activate('.research-source-list summary');
  await until('document.querySelector(".research-source-list").open');
  assert.ok(await evaluate(hasText('.research-source-list', sourceUrl)));
  await activate('.research-source-list button');
  await until(hasText('.research-source-list [role=status]', '已复制 S1'));
  assert.equal(await clipboard.readText(), sourceUrl);
  assert.equal(await evaluate('document.querySelectorAll(".research-source-list img").length'), 0);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
  checks.push('traceable result and narrow layout');
  searchError = true;
  await type(textarea, query);
  await activate(submit);
  await until(hasText('.status-dot', '限流'));
  assert.equal(await evaluate(`document.querySelector('${textarea}').value`), query);
  await activate(mode('chat'));
  await until(`document.querySelector('${textarea}').value === '私有草稿'`);
  assert.equal(requestCount, 2);
  checks.push('failure preserves independent drafts');
  await runtime.close();
  runtime = await createRuntime(options);
  await windowRef.reload();
  await until(hasText('.research-result', '有许可条款'));
  await until(hasText('.research-settings summary', '已保存密钥'));
  checks.push('restarted runtime and renderer preserve results and key');
  await writeFile(resultPath, JSON.stringify({ ok: true, checks }));
}).catch(async (error) => {
  await writeFile(resultPath, JSON.stringify({ ok: false, checks, error: error.stack }));
  process.exitCode = 1;
}).finally(async () => {
  await runtime?.close();
  windowRef?.destroy();
  app.exit(process.exitCode ?? 0);
});
