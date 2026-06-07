const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  base: 'http://localhost:8765',
  getMeta: () => ipcRenderer.invoke('app:meta'),
  checkForUpdate: () => ipcRenderer.invoke('app:check-update'),
  openCalculator: () => ipcRenderer.invoke('open-calculator'),
  aaOpen: () => ipcRenderer.invoke('aa:open'),
  aaLogout: () => ipcRenderer.invoke('aa:logout'),
  aaFetchHtml: (path) => ipcRenderer.invoke('aa:fetch-html', path),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
});
