const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  base: 'http://localhost:8765',
  openCalculator: () => ipcRenderer.invoke('open-calculator'),
});
