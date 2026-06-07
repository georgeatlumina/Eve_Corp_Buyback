const { app, BrowserWindow, dialog, ipcMain, session, shell } = require('electron');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const pkg = require('../package.json');

const PYTHON_PORT = 8765;
const UPDATE_REPO = 'georgeatlumina/Eve_Corp_Buyback';
const APP_META = { version: pkg.version || '', author: pkg.author || '' };

ipcMain.handle('app:meta', () => APP_META);
ipcMain.handle('open-external', (_event, url) => shell.openExternal(url));
ipcMain.handle('app:check-update', () => checkForUpdate({ interactive: true }));
let pythonProcess = null;
let mainWindow = null;
let splashWindow = null;
let calculatorWindow = null;
let aaWindow = null;
let sidecarLogPath = null;

const AA_BASE_URL = 'https://auth.navaldefence.org/';
const AA_SESSION_PARTITION = 'persist:aa-auth';

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

function killOrphanSidecars() {
  // Defensive: a previous app instance that crashed (or was force-quit via Task
  // Manager) can leave its python child running and still bound to port 8765.
  // The fresh sidecar then fails with WSAEADDRINUSE / EADDRINUSE and exits,
  // while the orphan keeps serving traffic from older code (e.g. missing
  // /api/pinned, /api/contracts/scan). Sweep any leftovers before we spawn.
  // The current run's pythonProcess (if any) is killed first to avoid
  // self-targeting on hot-reload from `app.relaunch()`.
  if (pythonProcess && !pythonProcess.killed) {
    try { pythonProcess.kill(); } catch (_) {}
    pythonProcess = null;
  }
  try {
    if (process.platform === 'win32') {
      // /F = force, /T = also kill child processes, /IM matches by image name.
      // Returns 128 / "process not found" when there's nothing to kill — fine.
      const r = spawnSync('taskkill', ['/F', '/T', '/IM', 'sidecar.exe'], {
        windowsHide: true,
      });
      if (r.status === 0) logSidecar('killed orphan sidecar.exe via taskkill');
    } else {
      // pkill returns 1 when no matches; ignore. Match against the basename
      // only so dev `python3 server.py` runs aren't caught.
      const r = spawnSync('pkill', ['-x', 'sidecar'], { windowsHide: true });
      if (r.status === 0) logSidecar('killed orphan sidecar via pkill');
    }
  } catch (err) {
    logSidecar(`orphan cleanup failed (non-fatal): ${err.message || err}`);
  }
}

function startPythonSidecar() {
  // Truncate previous log on each startup so the file always reflects this run.
  try { fs.writeFileSync(ensureLogPath(), ''); } catch (_) {}

  killOrphanSidecars();

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

async function waitForSidecar(onTick) {
  const maxAttempts = 60;
  for (let i = 0; i < maxAttempts; i++) {
    if (onTick) onTick(i, maxAttempts);
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

let splashReady = false;
const splashPending = [];

function emitSplash(pct, step) {
  if (!splashWindow || splashWindow.isDestroyed()) return;
  if (!splashReady) {
    splashPending.push({ pct, step });
    return;
  }
  try {
    splashWindow.webContents.send('splash:progress', { pct, step });
  } catch (_) {}
}

function flushSplashPending() {
  if (!splashWindow || splashWindow.isDestroyed()) return;
  // Coalesce to the latest pct and latest non-null step so we don't replay stale text.
  let pct = null;
  let step = null;
  for (const ev of splashPending) {
    if (typeof ev.pct === 'number') pct = ev.pct;
    if (typeof ev.step === 'string') step = ev.step;
  }
  splashPending.length = 0;
  if (pct != null || step != null) {
    try { splashWindow.webContents.send('splash:progress', { pct, step }); } catch (_) {}
  }
}

function createSplashWindow() {
  splashReady = false;
  splashPending.length = 0;
  splashWindow = new BrowserWindow({
    width: 560,
    height: 230,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: false,
    title: 'Naval Defence Alliance Management Tool',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'splash-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  splashWindow.setMenuBarVisibility(false);
  splashWindow.loadFile(path.join(__dirname, '..', 'renderer', 'splash.html'));
  splashWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.show();
  });
  splashWindow.webContents.once('did-finish-load', () => {
    splashReady = true;
    try { splashWindow.webContents.send('splash:meta', APP_META); } catch (_) {}
    flushSplashPending();
  });
  splashWindow.on('closed', () => { splashWindow = null; splashReady = false; });
}

function closeSplashWindow() {
  if (!splashWindow || splashWindow.isDestroyed()) return;
  try { splashWindow.close(); } catch (_) {}
  splashWindow = null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    title: 'Naval Defence Alliance Management Tool',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    show: false,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    emitSplash(100, 'Ready');
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
    // Small delay so users see the bar hit 100% before the splash vanishes.
    setTimeout(closeSplashWindow, 180);
  });
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

function openAaWindow() {
  if (aaWindow && !aaWindow.isDestroyed()) {
    aaWindow.focus();
    return;
  }
  const aaSession = session.fromPartition(AA_SESSION_PARTITION);
  aaWindow = new BrowserWindow({
    width: 1200,
    height: 850,
    title: 'Alliance Auth',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    parent: mainWindow || undefined,
    autoHideMenuBar: true,
    webPreferences: {
      session: aaSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  aaWindow.setMenuBarVisibility(false);
  aaWindow.loadURL(AA_BASE_URL);
  aaWindow.webContents.openDevTools({ mode: 'right' });
  aaWindow.on('closed', () => { aaWindow = null; });
}

ipcMain.handle('aa:open', () => {
  openAaWindow();
});

ipcMain.handle('aa:logout', async () => {
  const aaSession = session.fromPartition(AA_SESSION_PARTITION);
  await aaSession.clearStorageData();
  if (aaWindow && !aaWindow.isDestroyed()) aaWindow.close();
});

ipcMain.handle('aa:fetch-html', async (_event, urlPath) => {
  const aaSession = session.fromPartition(AA_SESSION_PARTITION);
  const url = new URL(urlPath || '/', AA_BASE_URL).toString();
  try {
    const res = await aaSession.fetch(url, { redirect: 'follow' });
    const html = await res.text();
    return { ok: res.ok, status: res.status, finalUrl: res.url || url, html };
  } catch (err) {
    return { ok: false, status: 0, finalUrl: url, html: '', error: String(err && err.message || err) };
  }
});

app.whenReady().then(async () => {
  createSplashWindow();
  emitSplash(5, 'Initializing…');
  startPythonSidecar();
  emitSplash(12, 'Starting Python sidecar…');
  try {
    await waitForSidecar((i, max) => {
      // Map poll attempts 0..max onto 12..88% so the bar moves visibly during the wait.
      const pct = 12 + (i / max) * 76;
      const secs = (i * 0.5).toFixed(1);
      emitSplash(pct, `Waiting for backend (${secs}s)…`);
    });
    emitSplash(92, 'Backend ready · loading interface…');
  } catch (e) {
    logSidecar(`waitForSidecar: ${e.message}`);
    emitSplash(92, 'Backend slow to respond · loading interface…');
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  // Update check runs in the background after the window is visible so we
  // don't block startup. Errors are swallowed (logged to sidecar.log only).
  // First check fires 2s after startup, then re-checks every hour so users
  // who leave the app open for days still get release prompts. A pending
  // dialog from a previous tick suppresses re-prompting until the user
  // dismisses it (checkForUpdate is naturally re-entrant against dialog).
  const runUpdateCheck = () =>
    checkForUpdate().catch((e) => logSidecar(`update check threw: ${e}`));
  setTimeout(runUpdateCheck, 2000);
  setInterval(runUpdateCheck, 60 * 60 * 1000);
});


// ---------- Auto-update (download-and-open flow) ----------

// Per-session dedupe so the hourly poll doesn't repeatedly prompt for the
// same version after the user clicked "Later". Cleared on app restart.
let dismissedUpdateTag = null;
let updateDialogOpen = false;

async function checkForUpdate({ interactive = false } = {}) {
  if (!app.isPackaged) {
    logSidecar('update check skipped (not packaged)');
    if (interactive) {
      await dialog.showMessageBox(mainWindow || null, {
        type: 'info',
        title: 'Update check',
        message: 'Running an unpackaged build — auto-update is disabled.',
        detail: 'Update checks only work in installed releases (DMG / NSIS).',
        buttons: ['OK'],
      });
    }
    return;
  }
  if (updateDialogOpen) return;  // a previous tick is still waiting on the user
  let latest;
  try {
    latest = await httpsGetJson(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`);
  } catch (e) {
    logSidecar(`update check failed: ${e.message || e}`);
    if (interactive) {
      await dialog.showMessageBox(mainWindow || null, {
        type: 'warning',
        title: 'Update check failed',
        message: 'Could not reach GitHub to check for updates.',
        detail: String(e.message || e),
        buttons: ['OK'],
      });
    }
    return;
  }
  const current = app.getVersion();
  const latestTag = String(latest.tag_name || '').replace(/^v/, '');
  if (!latestTag) return;
  if (compareSemver(latestTag, current) <= 0) {
    logSidecar(`up to date (current=${current}, latest=${latestTag})`);
    if (interactive) {
      await dialog.showMessageBox(mainWindow || null, {
        type: 'info',
        title: 'Up to date',
        message: `You're running the latest version (${current}).`,
        buttons: ['OK'],
      });
    }
    return;
  }
  if (!interactive && dismissedUpdateTag === latestTag) {
    logSidecar(`update ${latestTag} already dismissed this session — skipping prompt`);
    return;
  }
  logSidecar(`update available: ${latestTag} (current ${current})`);

  const asset = pickPlatformAsset(latest.assets || []);
  if (!asset) {
    logSidecar('no matching asset for this platform');
    if (interactive) {
      await dialog.showMessageBox(mainWindow || null, {
        type: 'info',
        title: 'Update available',
        message: `${latestTag} is available, but no installer for your platform was attached to the release.`,
        buttons: ['OK'],
      });
    }
    return;
  }

  updateDialogOpen = true;
  let confirm;
  try {
    confirm = await dialog.showMessageBox(mainWindow || null, {
      type: 'info',
      title: 'Update available',
      message: `Naval Defence Alliance Management Tool ${latestTag} is available`,
      detail: `You are running ${current}. Download the new ${asset.name} (~${Math.round((asset.size || 0) / 1024 / 1024)} MB)?`,
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
  } finally {
    updateDialogOpen = false;
  }
  if (confirm.response !== 0) {
    dismissedUpdateTag = latestTag;
    return;
  }

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
