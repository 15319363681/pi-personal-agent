import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } from 'electron';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RpcClient } from './rpc.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let windowRef;
let tray;
let runtimeProcess;
let runtimeClient;
let quitting = false;

function startRuntime() {
  const dataDir = join(app.getPath('userData'), 'runtime');
  const runtimePath = join(here, 'runtime.mjs');
  runtimeProcess = spawn(process.execPath, [runtimePath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PI_AGENT_DATA_DIR: dataDir },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  runtimeProcess.stderr.on('data', (chunk) => console.error(`[runtime] ${chunk}`));
  runtimeClient = new RpcClient(runtimeProcess);
  runtimeProcess.on('exit', () => {
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
    webPreferences: { preload: join(here, 'preload.mjs'), contextIsolation: true, nodeIntegration: false }
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

app.whenReady().then(async () => {
  startRuntime();
  ipcMain.handle('runtime-request', async (_event, request) => {
    if (!runtimeClient) return { ok: false, error: { code: 'runtime_unavailable', message: 'Runtime unavailable' } };
    return runtimeClient.request(request.method, request.params);
  });
  await createWindow();
  // Tray creation is best effort; headless smoke launches do not have an icon.
  try { createTray(); } catch { tray = undefined; }
});

app.on('before-quit', () => {
  quitting = true;
  runtimeClient?.close();
  if (runtimeProcess && !runtimeProcess.killed) runtimeProcess.kill();
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});
