const { app, BrowserWindow, ipcMain } = require('electron');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const [page, dataDir, resultPath] = process.argv.slice(2);
app.setPath('userData', join(dataDir, 'electron'));
app.disableHardwareAcceleration();
let windowRef, runtime, provider;
let runtimeStderr = '';
let providerError = '';
let failArtifactList = false;
const creationRequests = [];
const outputText = '# 文档汇总\nDOCX 与 PDF 来源已读取。\n<img src=x onerror=alert(1)>';
const root = join(dataDir, 'workspace');
const token = 'fixture-main-only';

async function evaluate(source) { return windowRef.webContents.executeJavaScript(source); }
async function until(source) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await evaluate(source)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('UI condition timed out ' + source);
}
async function selectFile(name) {
  assert.equal(await evaluate('(() => { const b = Array.from(document.querySelectorAll(".artifact-list button")).find(b => b.querySelector("span").textContent === ' + JSON.stringify(name) + '); if (!b || b.disabled) return false; b.click(); return true; })()'), true);
  await until('document.querySelector(".artifact-detail h3")?.textContent === ' + JSON.stringify(name));
}
async function activateSpace(selector) {
  await evaluate('document.querySelector(' + JSON.stringify(selector) + ').focus()');
  windowRef.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
  windowRef.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
}
async function startRuntime() {
  const { RpcClient } = await import(pathToFileURL(join(__dirname, '../src/rpc.mjs')).href);
  const child = spawn(process.execPath, [join(__dirname, '../src/runtime.mjs')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PI_AGENT_DATA_DIR: join(dataDir, 'runtime'), PI_AGENT_WORKSPACE: root, PI_AGENT_WORKSPACE_CONTROL_TOKEN: token },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  });
  child.stderr.on('data', (chunk) => { runtimeStderr += chunk; });
  const client = new RpcClient(child);
  runtime = { handle: (method, params) => client.request(method, params), close: () => client.close() };
}

app.whenReady().then(async () => {
  const { pdfSample, docxSample } = await import(pathToFileURL(join(__dirname, 'document-samples.mjs')).href);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'source.docx'), docxSample('Electron DOCX 正文', { compress: true }));
  await writeFile(join(root, 'source.pdf'), pdfSample(['Electron PDF evidence', 'Second source page']));
  await writeFile(join(root, 'existing.md'), 'preserve original');
  const frames = Buffer.from([...Array(4).fill([0, 0, 255]).flat(), ...Array(4).fill([255, 0, 0]).flat()]);
  await writeFile(join(root, 'chart.gif'), await sharp(frames, { raw: { width: 2, height: 4, pageHeight: 2, channels: 3 } }).gif().toBuffer());
  let turn = 0;
  provider = createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      turn++;
      let tool;
      if (turn === 1) tool = { name: 'workspace_read_document', arguments: { path: 'source.docx' } };
      if (turn === 2) {
        assert.ok(body.messages.some((message) => message.role === 'tool' && message.content.includes('Electron DOCX 正文')));
        tool = { name: 'workspace_read_document', arguments: { path: 'source.pdf', pageCount: 2 } };
      }
      if (turn === 3) {
        assert.ok(body.messages.some((message) => message.role === 'tool' && message.content.includes('Electron PDF evidence')));
        tool = { name: 'workspace_read_image', arguments: { path: 'chart.gif' } };
      }
      if (turn === 4) {
        assert.match(JSON.stringify(body.messages), /data:image\/jpeg;base64,/);
        tool = { name: 'workspace_prepare_text', arguments: { path: 'report.md', content: outputText, sourcePaths: ['source.docx', 'source.pdf', 'chart.gif'] } };
      }
      if (turn === 5) tool = { name: 'workspace_prepare_text', arguments: { path: 'existing.md', content: 'replacement', sourcePaths: ['source.docx'] } };
      const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'doc-' + turn, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : { role: 'assistant', content: '文件已准备，请查看并确认。' };
      const events = [
        { id: 'offline', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] },
        { id: 'offline', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] }
      ];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n');
    } catch (error) { providerError = error.stack; response.writeHead(500).end(); }
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  await startRuntime();
  assert.equal((await runtime.handle('workspace.authorize', { root, controlToken: token })).ok, true);
  assert.equal((await runtime.handle('settings.update', { setting: { id: 'default', provider: 'openai-compatible', model: 'fixture', supportsImages: true, baseUrl: 'http://127.0.0.1:' + provider.address().port + '/v1' } })).ok, true);
  const conversation = await runtime.handle('chat.send', { text: '读取资料，整理交付文件', modelCredential: { apiKey: 'offline-fixture-key' } });
  assert.equal(conversation.ok, true, JSON.stringify(conversation) + providerError + runtimeStderr);
  assert.equal(conversation.result.toolExecutions.every((execution) => execution.status === 'succeeded'), true, JSON.stringify(conversation));
  await assert.rejects(readFile(join(root, 'report.md')), { code: 'ENOENT' });
  const { createRuntimeRequestHandler } = await import(pathToFileURL(join(__dirname, '../src/runtime-request.mjs')).href);
  const handler = createRuntimeRequestHandler({ runtimeClient: { request: (method, params) => runtime.handle(method, params) }, vault: { has: async () => true, get: async () => 'offline-fixture-key' } });
  ipcMain.handle('runtime-request', (_event, request) => {
    if (request.method === 'artifacts.list' && failArtifactList) return { ok: false, error: { code: 'fixture_connection_failure' } };
    if (request.method === 'artifacts.create') creationRequests.push(request.params);
    return handler(request);
  });
  windowRef = new BrowserWindow({ show: false, width: 1180, height: 820, webPreferences: { preload: join(__dirname, '../src/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  await windowRef.loadFile(page);
  await until('document.querySelector(".artifact-panel summary")?.textContent.includes("2 待确认")');
  assert.equal(await evaluate('document.querySelector(".artifact-panel").open'), false);
  await activateSpace('.artifact-panel > summary');
  await until('document.querySelector(".artifact-panel").open');
  assert.equal(await evaluate('document.querySelectorAll(".message .document-sources li").length'), 3);
  await selectFile('report.md');
  assert.equal(await evaluate('document.querySelector(".artifact-approval button").disabled'), true);
  assert.equal(await evaluate('document.querySelector(".artifact-preview").textContent'), outputText);
  assert.equal(await evaluate('document.querySelectorAll(".artifact-preview img").length'), 0);
  assert.match(await evaluate('document.querySelector(".artifact-metadata").textContent'), /workspace.*report.md/);
  assert.match(await evaluate('document.querySelector(".artifact-detail .document-sources").textContent'), /第 1、2 页/);
  assert.match(await evaluate('document.querySelector(".artifact-detail .document-sources").textContent'), /原图 2 × 2 · 提交 2 × 2 · 已转换为 JPEG · 共 2 帧，本次仅首帧/);
  await activateSpace('.artifact-approval input');
  await until('!document.querySelector(".artifact-approval button").disabled');
  await selectFile('existing.md');
  assert.equal(await evaluate('document.querySelector(".artifact-approval input").checked'), false);
  await selectFile('report.md');
  assert.equal(await evaluate('document.querySelector(".artifact-approval input").checked'), false);
  await activateSpace('.artifact-approval input');
  await until('!document.querySelector(".artifact-approval button").disabled');
  await evaluate('const button = document.querySelector(".artifact-approval button"); button.click(); button.click();');
  await until('document.querySelector(".artifact-metadata").textContent.includes("已创建")');
  assert.equal(creationRequests.length, 1, 'repeated activation must issue one confirmation');
  assert.equal(await readFile(join(root, 'report.md'), 'utf8'), outputText);
  assert.equal(creationRequests[0].confirm, true);
  assert.match(creationRequests[0].sha256, /^[a-f0-9]{64}$/);
  await selectFile('existing.md');
  await activateSpace('.artifact-approval input');
  await until('!document.querySelector(".artifact-approval button").disabled');
  await evaluate('document.querySelector(".artifact-approval button").click()');
  await until('document.querySelector(".artifact-metadata").textContent.includes("创建失败")');
  assert.match(await evaluate('document.querySelector(".artifact-detail").textContent'), /目标文件已存在/);
  assert.equal(await readFile(join(root, 'existing.md'), 'utf8'), 'preserve original');
  failArtifactList = true;
  await until('document.querySelector(".artifact-error")?.textContent.includes("fixture_connection_failure")');
  failArtifactList = false;
  await evaluate('document.querySelector(".artifact-error button").click()');
  await until('!document.querySelector(".artifact-error")');
  await runtime.close();
  await startRuntime();
  await windowRef.reload();
  await until('document.querySelector(".artifact-panel summary")?.textContent.includes("0 待确认") && document.querySelector(".artifact-list")?.children.length === 2');
  await activateSpace('.artifact-panel > summary');
  await selectFile('report.md');
  assert.match(await evaluate('document.querySelector(".artifact-metadata").textContent'), /已创建/);
  assert.equal(await evaluate('document.querySelectorAll(".artifact-detail .document-sources li").length'), 3);
  windowRef.setSize(900, 640);
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, 'small desktop must not overflow horizontally');
  assert.equal(providerError, '');
  await writeFile(resultPath, JSON.stringify({ ok: true, checks: ['Electron PDF and compressed DOCX', 'actual GIF image and dimensions', 'real Pi workflow', 'source page provenance', 'exact escaped text preview', 'keyboard activation', 'selection resets approval', 'single content-bound confirmation', 'conflict preservation', 'connection retry', 'restart and narrow layout'] }));
}).catch(async (error) => {
  await writeFile(resultPath, JSON.stringify({ ok: false, message: error.message, stack: error.stack, providerError, runtimeStderr, layout: await windowRef?.webContents.executeJavaScript('({ width: innerWidth, scroll: document.documentElement.scrollWidth, overflowing: Array.from(document.querySelectorAll("main *, header *")).filter(e => e.getBoundingClientRect().right > innerWidth).slice(0, 8).map(e => ({ tag: e.tagName, class: e.className, right: e.getBoundingClientRect().right })) })').catch(() => null), body: await windowRef?.webContents.executeJavaScript('document.querySelector(".artifact-panel")?.textContent').catch(() => '') }));
  process.exitCode = 1;
}).finally(async () => {
  windowRef?.destroy();
  await runtime?.close();
  if (provider) await new Promise((resolve) => provider.close(resolve));
  app.exit(process.exitCode ?? 0);
});
