const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  base: 'http://localhost:8765',
  openCalculator: () => ipcRenderer.invoke('open-calculator'),
  aaOpen: () => ipcRenderer.invoke('aa:open'),
  aaLogout: () => ipcRenderer.invoke('aa:logout'),
  aaFetchHtml: (path) => ipcRenderer.invoke('aa:fetch-html', path),
});
