import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('piAgent', {
  request: (method, params = {}) => ipcRenderer.invoke('runtime-request', { method, params })
});
