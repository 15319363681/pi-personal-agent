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
const textarea = '.composer textarea';
const submit = '.composer > button:last-child';
const taskButton = (label) => 'Array.from(document.querySelectorAll(".agent-task-actions button")).find(b => b.textContent === ' + JSON.stringify(label) + ')';
async function action(label) {
  await until(taskButton(label));
  await evaluate(taskButton(label) + '.focus()');
  windowRef.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
  windowRef.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
}
function reply(value) {
  const delta = typeof value === 'string' ? { content: value } : { tool_calls: [{ index: 0, id: 'read-ui', type: 'function', function: value }] };
  return new Response([{ ...delta, role: 'assistant' }, {}].map((part, i) => 'data: ' + JSON.stringify({ id: 'task-ui', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: part, finish_reason: i === 0 ? null : typeof value === 'string' ? 'stop' : 'tool_calls' }] }) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}
app.whenReady().then(async () => {
  const [{ createRuntime }, { CredentialVault }, { createRuntimeRequestHandler }] = await Promise.all([
    importSource('runtime.mjs'), importSource('credential-vault.mjs'), importSource('runtime-request.mjs')
  ]);
  const vault = new CredentialVault({ safeStorage, directory: join(dataDir, 'keys') });
  const options = { dataDir: join(dataDir, 'runtime'), workspaceControlToken: 'fixture-control', fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    if (!body.stream) return Response.json({ choices: [{ message: { content: 'OK' } }] });
    stage++;
    if (stage === 1) return reply(JSON.stringify({ steps: [{ title: '阅读说明', instruction: '读取 input.txt' }, { title: '综合结论', instruction: '总结资料' }] }));
    if (stage === 2) return reply({ name: 'workspace_read', arguments: JSON.stringify({ path: 'input.txt' }) });
    if (stage === 3) return reply('已经读取 input.txt');
    if (stage === 5) return reply('最终报告内容');
    return new Promise((_, reject) => init.signal.aborted ? reject(init.signal.reason) : init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  } };
  runtime = await createRuntime(options);
  await writeFile(join(options.dataDir, 'workspace/input.txt'), '桌面任务资料');
  await runtime.handle('workspace.authorize', { root: join(options.dataDir, 'workspace'), controlToken: 'fixture-control' });
  const handler = createRuntimeRequestHandler({ vault, copyText: (text) => clipboard.writeText(text), runtimeClient: { request: (method, params) => runtime.handle(method, params) } });
  ipcMain.handle('runtime-request', (_event, request) => handler(request));
  assert.equal((await handler({ method: 'settings.update', params: { setting: { id: 'default', provider: 'openai-compatible', model: 'fixture', baseUrl: 'https://model.invalid/v1', apiKey: 'fixture-task-key' } } })).ok, true);
  windowRef = new BrowserWindow({ show: false, width: 900, height: 650, webPreferences: { preload: join(__dirname, '../src/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  await windowRef.loadFile(page);
  await until("Array.from(document.querySelectorAll('.model-settings-panel button')).some(b => b.textContent.includes('测试连接') && !b.disabled)");
  await evaluate("Array.from(document.querySelectorAll('.model-settings-panel button')).find(b => b.textContent.includes('测试连接')).click()");
  await until(hasText('.conversation .panel-heading', '连接已测试'));
  await type(textarea, '独立对话草稿');
  await activate('.mode-switch button:nth-child(3)');
  await until("document.querySelector('#agent-task-scope') && document.querySelector('.composer textarea').value === ''");
  await type(textarea, '总结工作区');
  await activate(submit);
  await until(hasText('.agent-task', '1 / 2'));
  assert.equal(stage, 4);
  assert.equal(await evaluate("document.querySelector('.composer textarea').value"), '');
  await action('查看详情');
  await until(hasText('.agent-task-detail', '已经读取 input.txt'));
  await until(hasText('.agent-task-detail', 'workspace_read'));
  assert.ok(await evaluate(hasText('.agent-task-detail', 'input.txt')));
  checks.push('natural goal, checkpoint and actual read tools');
  await type(textarea, '保留失败目标');
  await activate(submit);
  await until(hasText('.status-dot', '已有 Agent 任务'));
  assert.equal(await evaluate("document.querySelector('.composer textarea').value"), '保留失败目标');
  await action('暂停');
  await until(hasText('.agent-task-title', '已暂停'));
  checks.push('nonblocking controls and failed draft');
  await runtime.close();
  runtime = await createRuntime(options);
  await windowRef.reload();
  await until(hasText('.agent-task-title', '已暂停'));
  await action('继续');
  await until(hasText('.agent-task-title', '已完成'));
  await action('查看详情');
  await until(hasText('.agent-task-detail', '最终报告内容'));
  await evaluate("Array.from(document.querySelectorAll('.agent-task-detail button')).find(b => b.textContent === '复制报告').click()");
  await until(hasText('.agent-task-content [role=status]', '已复制报告'));
  assert.equal(await clipboard.readText(), '最终报告内容');
  assert.equal(stage, 5);
  checks.push('restart, resume checkpoint and copy report');
  await evaluate("Array.from(document.querySelectorAll('.model-settings-panel button')).find(b => b.textContent.includes('测试连接')).click()");
  await until(hasText('.conversation .panel-heading', '连接已测试'));
  await activate('.mode-switch button:nth-child(3)');
  await type(textarea, '取消示例');
  await activate(submit);
  await until("document.querySelectorAll('.agent-task').length === 2");
  await action('取消任务');
  await until("Array.from(document.querySelectorAll('.agent-task-title')).some(e => e.textContent.includes('已取消'))");
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
  checks.push('cancellation and 900 pixel layout');
  await writeFile(resultPath, JSON.stringify({ ok: true, checks }));
}).catch(async (error) => {
  await writeFile(resultPath, JSON.stringify({ ok: false, checks, error: error.stack }));
  process.exitCode = 1;
}).finally(async () => {
  await runtime?.close();
  windowRef?.destroy();
  app.exit(process.exitCode ?? 0);
});
