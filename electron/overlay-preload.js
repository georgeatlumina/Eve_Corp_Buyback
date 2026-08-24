const { contextBridge, ipcRenderer } = require('electron');

// Bridge for the transparent SMT intel overlay (renderer/overlay.html). It talks
// to the same sidecar as the main window; everything else here is window chrome
// the overlay can't do for itself (opacity, always-on-top, click-through).
contextBridge.exposeInMainWorld('overlayApi', {
  base: 'http://127.0.0.1:8766',
  platform: process.platform,
  getState: () => ipcRenderer.invoke('overlay:state'),
  save: (patch) => ipcRenderer.invoke('overlay:save', patch),
  close: () => ipcRenderer.invoke('overlay:close'),
  setOpacity: (value) => ipcRenderer.invoke('overlay:opacity', value),
  setAlwaysOnTop: (on) => ipcRenderer.invoke('overlay:always-on-top', on),
  setClickThrough: (on) => ipcRenderer.invoke('overlay:click-through', on),
  // Fired as the pointer enters/leaves the toolbar so main can briefly restore
  // hit-testing while click-through is on.
  hoverUi: (over) => ipcRenderer.send('overlay:hover-ui', !!over),
  onClickThrough: (cb) => ipcRenderer.on('overlay:click-through', (_e, on) => cb(!!on)),
  onAlertsChanged: (cb) => ipcRenderer.on('smt:alerts-changed', () => cb()),
});
