const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PYTHON_PORT = 8765;
let pythonProcess = null;
let mainWindow = null;
let sidecarLogPath = null;

function ensureLogPath() {
  if (sidecarLogPath) return sidecarLogPath;
  const dir = app.getPath('userData');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}
  sidecarLogPath = path.join(dir, 'sidecar.log');
  return sidecarLogPath;
}

function logSidecar(line) {
  const ts = new Date().toISOString();
  const text = `${ts} ${line}\n`;
  try {
    fs.appendFileSync(ensureLogPath(), text);
  } catch (_) {}
  process.stdout.write && process.stdout.write(text);
}

function startPythonSidecar() {
  // Truncate previous log on each startup so the file always reflects this run.
  try { fs.writeFileSync(ensureLogPath(), ''); } catch (_) {}

  const userDataDir = path.join(app.getPath('userData'), 'eve_auth');
  const env = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    EVE_BUYBACK_DATA_DIR: userDataDir,
  };

  // Use piped stdio rather than 'inherit'. When Electron is launched from a
  // GUI shortcut on Windows the parent has no real stdout/stderr to inherit,
  // and the child can fail silently. Piping lets us capture the streams.
  const spawnOpts = {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    windowsHide: true,
  };

  let sidecarPath, sidecarArgs;
  if (app.isPackaged) {
    const sidecarName = process.platform === 'win32' ? 'sidecar.exe' : 'sidecar';
    sidecarPath = path.join(process.resourcesPath, 'python-sidecar', sidecarName);
    sidecarArgs = [];
  } else {
    sidecarPath = process.env.PYTHON_BIN || 'python3';
    sidecarArgs = [path.join(__dirname, '..', 'python', 'server.py')];
  }

  logSidecar(`spawning: ${sidecarPath} ${sidecarArgs.join(' ')}`);
  logSidecar(`exists: ${fs.existsSync(sidecarPath)}`);
  logSidecar(`userData: ${userDataDir}`);

  try {
    pythonProcess = spawn(sidecarPath, sidecarArgs, spawnOpts);
  } catch (err) {
    logSidecar(`spawn threw: ${err.stack || err}`);
    return;
  }

  pythonProcess.stdout.on('data', (d) => logSidecar(`stdout: ${String(d).trimEnd()}`));
  pythonProcess.stderr.on('data', (d) => logSidecar(`stderr: ${String(d).trimEnd()}`));
  pythonProcess.on('error', (err) => logSidecar(`spawn error event: ${err.stack || err}`));
  pythonProcess.on('exit', (code, signal) => {
    logSidecar(`exit code=${code} signal=${signal}`);
    pythonProcess = null;
  });
}

async function waitForSidecar() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://localhost:${PYTHON_PORT}/api/health`);
      if (res.ok) {
        logSidecar(`health OK after ~${i * 0.5}s`);
        return;
      }
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
    logSidecar(`waitForSidecar: ${e.message}`);
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
