const { app, BrowserWindow } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

const PYTHON_PORT = 8765;
let pythonProcess = null;
let mainWindow = null;

function startPythonSidecar() {
  const userDataDir = path.join(app.getPath('userData'), 'eve_auth');
  const env = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    EVE_BUYBACK_DATA_DIR: userDataDir,
  };

  const spawnOpts = {
    stdio: ['ignore', 'inherit', 'inherit'],
    env,
    windowsHide: true,
  };

  if (app.isPackaged) {
    const sidecarName = process.platform === 'win32' ? 'sidecar.exe' : 'sidecar';
    const sidecarPath = path.join(process.resourcesPath, 'python-sidecar', sidecarName);
    pythonProcess = spawn(sidecarPath, [], spawnOpts);
  } else {
    const scriptPath = path.join(__dirname, '..', 'python', 'server.py');
    const pythonBin = process.env.PYTHON_BIN || 'python3';
    pythonProcess = spawn(pythonBin, [scriptPath], spawnOpts);
  }

  pythonProcess.on('error', (err) => {
    console.error(`[sidecar] spawn error:`, err);
  });

  pythonProcess.on('exit', (code) => {
    console.log(`Python sidecar exited with code ${code}`);
    pythonProcess = null;
  });
}

async function waitForSidecar() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://localhost:${PYTHON_PORT}/api/health`);
      if (res.ok) return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Python sidecar did not respond on /api/health within 30s');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    title: 'EVE Corp Buyback',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  startPythonSidecar();
  try {
    await waitForSidecar();
  } catch (e) {
    console.error(e);
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (pythonProcess) pythonProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (pythonProcess) pythonProcess.kill();
});
