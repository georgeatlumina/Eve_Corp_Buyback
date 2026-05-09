const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('api', {
  base: 'http://localhost:8765',
});
