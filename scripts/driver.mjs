/**
 * Electron driver — launches the app and accepts REPL commands via stdin.
 * Windows-compatible (no xvfb needed).
 */
import { _electron as electron } from 'playwright';
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(fileURLToPath(import.meta.url), '../../');
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(APP_DIR, 'scripts', 'shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

const electronBin = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');

let app = null;
let page = null;

const COMMANDS = {
  async launch() {
    if (app) return console.log('already launched');
    console.log('launching electron from', APP_DIR);
    app = await electron.launch({
      executablePath: electronBin,
      args: [APP_DIR],
      timeout: 60_000,
    });
    // Wait for the main window to be ready
    console.log('waiting for window…');
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    // Give Python backend time to start
    await new Promise(r => setTimeout(r, 5000));
    console.log('launched.', app.windows().length, 'windows:');
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
      const els = [...document.querySelectorAll('button, a, [role="button"], .quota-bar, .quota-expand-row')];
      const el = els.find(e => e.textContent?.trim() === t)
              ?? els.find(e => e.textContent?.includes(t));
      if (!el) return 'NOT_FOUND';
      el.click(); return 'OK: ' + el.tagName + ' ' + el.className;
    }, text);
    console.log('click-text', JSON.stringify(text), '→', r);
  },

  async wait(sel) {
    if (!page) return console.log('ERROR: launch first');
    try { await page.waitForSelector(sel, { timeout: 15_000 }); console.log('found:', sel); }
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

  async sleep(ms) {
    await new Promise(r => setTimeout(r, parseInt(ms) || 2000));
    console.log('slept', ms || 2000, 'ms');
  },

  async windows() {
    if (!app) return console.log('ERROR: launch first');
    for (const w of app.windows()) console.log(' ', w.url());
  },

  async quota_bars() {
    if (!page) return console.log('ERROR: launch first');
    const bars = await page.evaluate(() => {
      return [...document.querySelectorAll('.quota-bar')].map(el => ({
        text: el.textContent?.trim().slice(0, 60),
        classes: el.className,
      }));
    });
    console.log(JSON.stringify(bars, null, 2));
  },

  // Click the first quota bar whose text includes the given ship name
  async click_quota(shipName) {
    if (!page) return console.log('ERROR: launch first');
    const r = await page.evaluate(name => {
      const bars = [...document.querySelectorAll('.quota-bar')];
      const el = bars.find(b => b.textContent?.toLowerCase().includes(name.toLowerCase()));
      if (!el) return 'NOT_FOUND';
      el.click();
      return 'OK: ' + el.textContent?.trim().slice(0, 50);
    }, shipName);
    console.log('click_quota', JSON.stringify(shipName), '→', r);
  },

  // Click the expand row (price fetch trigger) of an open panel
  async click_price_row() {
    if (!page) return console.log('ERROR: launch first');
    const r = await page.evaluate(() => {
      const row = document.querySelector('.quota-expand-panel.open .quota-expand-row');
      if (!row) return 'NOT_FOUND (no open panel)';
      row.click();
      return 'OK';
    });
    console.log('click_price_row →', r);
  },

  // Read the price text from the open expand panel
  async price_text() {
    if (!page) return console.log('ERROR: launch first');
    const txt = await page.evaluate(() => {
      const el = document.querySelector('.quota-expand-panel.open .quota-amarr-price');
      return el ? el.innerText : '(not found)';
    });
    console.log('price:', txt);
  },

  async quit() { if (app) await app.close().catch(() => {}); app = null; page = null; },
  help() { console.log('commands:', Object.keys(COMMANDS).join(', ')); },
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'driver> ' });

rl.on('line', async line => {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  if (!cmd) { rl.prompt(); return; }
  const fn = COMMANDS[cmd];
  if (!fn) { console.log('unknown:', cmd, '— try: help'); rl.prompt(); return; }
  try { await fn(rest.join(' ')); } catch (e) { console.log('ERROR:', e.message); }
  if (cmd === 'quit') { rl.close(); process.exit(0); }
  rl.prompt();
});
rl.on('close', async () => { await COMMANDS.quit(); process.exit(0); });

console.log('Eve Corp Buyback driver — "help" for commands, "launch" to start');
rl.prompt();
