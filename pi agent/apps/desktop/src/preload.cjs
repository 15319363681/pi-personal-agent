const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('piAgent', {
  request: (method, params = {}) => ipcRenderer.invoke('runtime-request', { method, params })
});
