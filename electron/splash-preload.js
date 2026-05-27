const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('splashApi', {
  onMeta: (cb) => {
    ipcRenderer.on('splash:meta', (_event, payload) => cb(payload || {}));
  },
  onProgress: (cb) => {
    ipcRenderer.on('splash:progress', (_event, payload) => cb(payload || {}));
  },
});
