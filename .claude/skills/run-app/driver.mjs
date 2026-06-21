// Playwright REPL driver for Eve Corp Buyback (Electron) — cross-platform (macOS / Windows / Linux).
// Run: node .claude/skills/run-app/driver.mjs
// The app shows a splash while the Python sidecar starts (~15s), then
// transitions to the main window (renderer/index.html). This driver
// waits for that transition before reporting "launched".
import { _electron as electron } from 'playwright';
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(os.tmpdir(), 'eve-shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

// Electron's packaged binary lives at a different path on each platform.
const DIST = path.join(APP_DIR, 'node_modules/electron/dist');
const electronExe =
  process.platform === 'win32'  ? path.join(DIST, 'electron.exe')
  : process.platform === 'darwin' ? path.join(DIST, 'Electron.app/Contents/MacOS/Electron')
  : path.join(DIST, 'electron');

let app = null;
let page = null; // the main UI window (index.html), not the splash

async function findMainWindow() {
  // Poll until a window loading index.html appears (splash closes when sidecar is ready).
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const wins = app.windows();
    const main = wins.find(w => w.url().includes('index.html'));
    if (main) return main;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Main window (index.html) never appeared within 60s');
}

const COMMANDS = {
  async launch() {
    if (app) return console.log('already launched');
    // Windows only: fix BOM in path.txt if present — may reappear after npm install.
    if (process.platform === 'win32') {
      try {
        const pathTxt = path.join(APP_DIR, 'node_modules/electron/path.txt');
        const raw = fs.readFileSync(pathTxt);
        if (raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) {
          fs.writeFileSync(pathTxt, raw.slice(3).toString('ascii').trim(), 'ascii');
          console.log('fixed BOM in node_modules/electron/path.txt');
        }
      } catch { /* path.txt absent is fine */ }
    }
    // IDE/agent shells often export ELECTRON_RUN_AS_NODE=1, which makes the
    // Electron binary run as plain Node — the app then crashes on startup
    // (require('electron') returns a path string, so ipcMain is undefined).
    // Strip it from the child's env so the app launches as a real Electron app.
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    console.log('launching (splash shows while Python sidecar starts ~15s)…');
    app = await electron.launch({
      executablePath: electronExe,
      args: [APP_DIR],
      timeout: 30_000,
      env,
    });
    console.log('waiting for main window…');
    page = await findMainWindow();
    await page.waitForLoadState('domcontentloaded');
    console.log('launched. windows:');
    for (const w of app.windows()) console.log(' ', w.url());
  },

  async ss(name) {
    if (!page) return console.log('ERROR: launch first');
    const f = path.join(SHOT_DIR, (name || `ss-${Date.now()}`) + '.png');
    await page.screenshot({ path: f });
    console.log('screenshot:', f);
  },

  async click(sel) {
    if (!page) return console.log('ERROR: launch first');
    const r = await page.evaluate(s => {
      const el = document.querySelector(s);
      if (!el) return 'NOT_FOUND';
      el.click(); return 'OK';
    }, sel);
    console.log('click', sel, '→', r);
  },

  async 'click-text'(text) {
    if (!page) return console.log('ERROR: launch first');
    const r = await page.evaluate(t => {
      const els = [...document.querySelectorAll('button, a, [role="button"], li, .tab')];
      const el = els.find(e => e.textContent?.trim() === t)
              ?? els.find(e => e.textContent?.includes(t));
      if (!el) return 'NOT_FOUND';
      el.click(); return 'OK: ' + el.tagName;
    }, text);
    console.log('click-text', JSON.stringify(text), '→', r);
  },

  async tab(name) {
    if (!page) return console.log('ERROR: launch first');
    const r = await page.evaluate(t => {
      const tabs = [...document.querySelectorAll('nav a, .tab, [data-tab]')];
      const el = tabs.find(e => e.textContent?.trim().toLowerCase() === t.toLowerCase())
              ?? tabs.find(e => e.textContent?.toLowerCase().includes(t.toLowerCase()));
      if (!el) return 'NOT_FOUND';
      el.click(); return 'OK: ' + (el.textContent?.trim());
    }, name);
    console.log('tab', JSON.stringify(name), '→', r);
  },

  async type(text)  { if (page) await page.keyboard.type(text, { delay: 30 }); },
  async press(key)  { if (page) await page.keyboard.press(key); },

  async wait(sel) {
    if (!page) return console.log('ERROR: launch first');
    try { await page.waitForSelector(sel, { timeout: 10_000 }); console.log('found:', sel); }
    catch { console.log('TIMEOUT:', sel); }
  },

  async eval(expr) {
    if (!page) return console.log('ERROR: launch first');
    try { console.log(JSON.stringify(await page.evaluate(expr))); }
    catch (e) { console.log('ERROR:', e.message); }
  },

  async text(sel) {
    if (!page) return console.log('ERROR: launch first');
    console.log(await page.evaluate(
      s => (s ? document.querySelector(s) : document.body)?.innerText ?? '(null)',
      sel || null));
  },

  async windows() {
    if (!app) return console.log('ERROR: launch first');
    for (const w of app.windows()) console.log(' ', w.url());
  },

  async quit() { if (app) await app.close().catch(() => {}); app = null; page = null; },
  help() { console.log('commands:', Object.keys(COMMANDS).join(', ')); },
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'driver> ' });
let queue = Promise.resolve();
let rlClosed = false;
const safePrompt = () => { if (!rlClosed) rl.prompt(); };
rl.on('line', line => {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  if (!cmd) { queue = queue.then(safePrompt); return; }
  const fn = COMMANDS[cmd];
  if (!fn) { queue = queue.then(() => { console.log('unknown:', cmd, '— try: help'); safePrompt(); }); return; }
  queue = queue.then(async () => {
    try { await fn(rest.join(' ')); } catch (e) { console.log('ERROR:', e.message); }
    if (cmd === 'quit') { if (!rlClosed) rl.close(); process.exit(0); }
    safePrompt();
  });
});
rl.on('close', () => { rlClosed = true; queue = queue.then(async () => { await COMMANDS.quit(); process.exit(0); }); });

console.log('Eve Corp Buyback driver — "help" for commands, "launch" to start');
rl.prompt();
