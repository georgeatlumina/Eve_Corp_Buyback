const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  base: 'http://127.0.0.1:8766',
  getMeta: () => ipcRenderer.invoke('app:meta'),
  checkForUpdate: () => ipcRenderer.invoke('app:check-update'),
  openCalculator: () => ipcRenderer.invoke('open-calculator'),
  aaOpen: () => ipcRenderer.invoke('aa:open'),
  aaLogout: () => ipcRenderer.invoke('aa:logout'),
  aaFetchHtml: (path) => ipcRenderer.invoke('aa:fetch-html', path),
  aaPostForm: (path, fields, referer) => ipcRenderer.invoke('aa:post-form', { path, fields, referer }),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openLinkWindow: (url) => ipcRenderer.invoke('open-link-window', url),
  popOutTab: (tab) => ipcRenderer.invoke('pop-out-tab', tab),
});
