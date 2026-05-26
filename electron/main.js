const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { spawn } = require('child_process');

const PYTHON_PORT = 8765;
const UPDATE_REPO = 'georgeatlumina/Eve_Corp_Buyback';
let pythonProcess = null;
let mainWindow = null;
let calculatorWindow = null;
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
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function openCalculatorWindow() {
  if (calculatorWindow && !calculatorWindow.isDestroyed()) {
    calculatorWindow.focus();
    return;
  }
  calculatorWindow = new BrowserWindow({
    width: 280,
    height: 470,
    title: 'Calculator',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    resizable: true,
    minimizable: true,
    maximizable: false,
    alwaysOnTop: true,
    parent: mainWindow || undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  calculatorWindow.setMenuBarVisibility(false);
  calculatorWindow.loadFile(path.join(__dirname, '..', 'renderer', 'calculator.html'));
  calculatorWindow.on('closed', () => { calculatorWindow = null; });
}

ipcMain.handle('open-calculator', () => {
  openCalculatorWindow();
});

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
  // Update check runs in the background after the window is visible so we
  // don't block startup. Errors are swallowed (logged to sidecar.log only).
  setTimeout(() => checkForUpdate().catch((e) => logSidecar(`update check threw: ${e}`)), 2000);
});


// ---------- Auto-update (download-and-open flow) ----------

async function checkForUpdate() {
  if (!app.isPackaged) {
    logSidecar('update check skipped (not packaged)');
    return;
  }
  let latest;
  try {
    latest = await httpsGetJson(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`);
  } catch (e) {
    logSidecar(`update check failed: ${e.message || e}`);
    return;
  }
  const current = app.getVersion();
  const latestTag = String(latest.tag_name || '').replace(/^v/, '');
  if (!latestTag) return;
  if (compareSemver(latestTag, current) <= 0) {
    logSidecar(`up to date (current=${current}, latest=${latestTag})`);
    return;
  }
  logSidecar(`update available: ${latestTag} (current ${current})`);

  const asset = pickPlatformAsset(latest.assets || []);
  if (!asset) {
    logSidecar('no matching asset for this platform');
    return;
  }

  const confirm = await dialog.showMessageBox(mainWindow || null, {
    type: 'info',
    title: 'Update available',
    message: `EVE Corp Buyback ${latestTag} is available`,
    detail: `You are running ${current}. Download the new ${asset.name} (~${Math.round((asset.size || 0) / 1024 / 1024)} MB)?`,
    buttons: ['Download', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (confirm.response !== 0) return;

  const destPath = path.join(app.getPath('downloads'), asset.name);
  try {
    await downloadToFile(asset.browser_download_url, destPath);
  } catch (e) {
    dialog.showErrorBox('Download failed', String(e.message || e));
    return;
  }

  const after = await dialog.showMessageBox(mainWindow || null, {
    type: 'info',
    title: 'Update downloaded',
    message: `${asset.name} saved to your Downloads folder.`,
    detail:
      process.platform === 'darwin'
        ? 'Open the .dmg and drag the new app into Applications, then re-launch.'
        : 'Run the installer to complete the update. The app will close so the installer can replace it.',
    buttons: ['Open & quit', 'Show in folder', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
  });
  if (after.response === 0) {
    await shell.openPath(destPath);
    setTimeout(() => app.quit(), 500);
  } else if (after.response === 1) {
    shell.showItemInFolder(destPath);
  }
}

function pickPlatformAsset(assets) {
  if (process.platform === 'darwin') {
    return assets.find((a) => /\.dmg$/i.test(a.name) && !/\.blockmap$/i.test(a.name));
  }
  if (process.platform === 'win32') {
    return assets.find((a) => /\.exe$/i.test(a.name) && !/\.blockmap$/i.test(a.name));
  }
  return null;
}

function httpsGetJson(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'EveCorpBuyback', Accept: 'application/vnd.github+json' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          httpsGetJson(res.headers.location, redirects - 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let data = '';
        res.on('data', (d) => { data += d; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      })
      .on('error', reject);
  });
}

function downloadToFile(url, destPath, redirects = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'EveCorpBuyback', Accept: 'application/octet-stream' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          downloadToFile(res.headers.location, destPath, redirects - 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const out = fs.createWriteStream(destPath);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve(destPath)));
        out.on('error', (err) => {
          fs.unlink(destPath, () => reject(err));
        });
      })
      .on('error', reject);
  });
}

function compareSemver(a, b) {
  const pa = String(a).split('.').map((p) => parseInt(p, 10) || 0);
  const pb = String(b).split('.').map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

app.on('window-all-closed', () => {
  if (pythonProcess) pythonProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (pythonProcess) pythonProcess.kill();
});
