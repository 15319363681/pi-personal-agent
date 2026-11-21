import { app, BrowserWindow, Tray, Menu, dialog, ipcMain, nativeImage, safeStorage, clipboard, Notification } from 'electron';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RpcClient } from './rpc.mjs';
import { CredentialVault, migrateLegacyCredentials } from './credential-vault.mjs';
import { createRuntimeRequestHandler } from './runtime-request.mjs';
import { WecomService } from './wecom-service.mjs';
import { ScheduleService } from './schedule-service.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let windowRef;
let tray;
let runtimeProcess;
let runtimeClient;
let quitting = false;
let runtimeShutdown;
let shutdownComplete = false;
let handleRuntimeRequest;
let wecom;
let scheduler;

function startRuntime(workspaceControlToken) {
  const dataDir = join(app.getPath('userData'), 'runtime');
  const runtimePath = join(here, 'runtime.mjs');
  runtimeProcess = spawn(process.execPath, [runtimePath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PI_AGENT_DATA_DIR: dataDir, PI_AGENT_WORKSPACE_CONTROL_TOKEN: workspaceControlToken },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  runtimeProcess.stderr.on('data', (chunk) => console.error(`[runtime] ${chunk}`));
  runtimeClient = new RpcClient(runtimeProcess);
  runtimeProcess.on('exit', () => {
    wecom?.disconnect();
    runtimeClient = undefined;
    if (!quitting && windowRef && !windowRef.isDestroyed()) windowRef.webContents.send('runtime-status', { status: 'exited' });
  });
}

async function createWindow() {
  windowRef = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false }
  });
  await windowRef.loadFile(join(here, '..', 'dist-ui', 'index.html'));
  windowRef.on('close', (event) => {
    if (!quitting) { event.preventDefault(); windowRef.hide(); }
  });
}

function createTray() {
  const icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=');
  tray = new Tray(icon);
  tray.setToolTip('Pi Personal Agent');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开', click: () => windowRef?.show() },
    { label: '退出', click: () => { quitting = true; app.quit(); } }
  ]));
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => windowRef?.show());
  app.whenReady().then(async () => {
  const workspaceControlToken = randomBytes(32).toString('hex');
  const vault = new CredentialVault({ safeStorage, directory: join(app.getPath('userData'), 'credentials') });
  await migrateLegacyCredentials({ path: join(app.getPath('userData'), 'runtime', 'model-settings.json'), vault });
  startRuntime(workspaceControlToken);
  const runtimeRequestClient = { request: (...args) => runtimeClient?.request(...args) ?? Promise.resolve({ ok: false, error: { code: 'runtime_unavailable', message: 'Runtime unavailable' } }) };
  wecom = new WecomService({ runtimeClient: runtimeRequestClient, modelVault: vault, vault: new CredentialVault({ safeStorage, directory: join(app.getPath('userData'), 'wecom-credentials') }) });
  handleRuntimeRequest = createRuntimeRequestHandler({
    wecom,
    runtimeClient: runtimeRequestClient,
    copyText: (text) => clipboard.writeText(text),
    vault,
    searchVault: new CredentialVault({ safeStorage, directory: join(app.getPath('userData'), 'research-credentials') }),
    selectWorkspace: async () => {
      if (!windowRef || windowRef.isDestroyed()) return { ok: false, error: { code: 'workspace_selector_unavailable', message: '桌面窗口不可用' } };
      const choice = await dialog.showOpenDialog(windowRef, { title: '选择 Pi 工作区', properties: ['openDirectory'] });
      if (choice.canceled || !choice.filePaths[0]) return { ok: true, result: { authorized: false, canceled: true } };
      return runtimeRequestClient.request('workspace.authorize', { root: choice.filePaths[0], controlToken: workspaceControlToken });
    }
  });
  ipcMain.handle('runtime-request', async (_event, request) => handleRuntimeRequest(request));
  await createWindow();
  scheduler = new ScheduleService({ runtimeClient: runtimeRequestClient, vault, notify: async text => {
    if (Notification.isSupported()) { const notification = new Notification({ title: 'Pi 提醒', body: text }); notification.on('click', () => windowRef?.show()); notification.show(); }
  } });
  scheduler.start();
  // Tray creation is best effort; headless smoke launches do not have an icon.
  try { createTray(); } catch { tray = undefined; }
  }).catch(() => {
    dialog.showErrorBox('启动失败', '无法完成启动。若模型设置迁移失败，旧设置会保留。请检查系统凭据加密功能后重试。');
    app.quit();
  });
}

app.on('before-quit', (event) => {
  quitting = true;
  if (shutdownComplete || (!runtimeClient && !runtimeShutdown)) return;
  event.preventDefault();
  const closingClient = runtimeClient;
  runtimeShutdown ??= (wecom || scheduler ? Promise.all([wecom?.close(), scheduler?.close()]).then(() => closingClient.close()) : closingClient.close()).then(() => {
    shutdownComplete = true;
    app.quit();
  });
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});
