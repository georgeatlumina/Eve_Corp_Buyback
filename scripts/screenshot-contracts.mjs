import { _electron as electron } from 'playwright';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(fileURLToPath(import.meta.url), '../../');
const electronBin = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const SHOT = path.join(APP_DIR, 'scripts', 'shots', 'contracts.png');
fs.mkdirSync(path.dirname(SHOT), { recursive: true });

async function waitForMainWindow(app, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      if (w.url().includes('splash')) continue;
      try { if (await w.evaluate(() => !!document.querySelector('[data-tab="contracts"]'))) return w; } catch {}
    }
    await new Promise(r => setTimeout(r, 1000));
    process.stdout.write('.');
  }
  throw new Error('main window never appeared');
}

async function run() {
  const app = await electron.launch({ executablePath: electronBin, args: [APP_DIR], timeout: 60_000 });
  const splash = await app.firstWindow();
  await splash.waitForLoadState('domcontentloaded');
  process.stdout.write('waiting for main window');
  const page = await waitForMainWindow(app, 60_000);
  console.log('\nready');

  // Click Contracts tab
  await page.click('[data-tab="contracts"]');
  await new Promise(r => setTimeout(r, 1000));

  // Click Scan contracts button if present
  const scanBtn = page.locator('button', { hasText: /scan contracts/i });
  if (await scanBtn.count()) {
    console.log('clicking scan...');
    await scanBtn.click();
    await page.waitForTimeout(8000);
  }

  await page.screenshot({ path: SHOT, fullPage: false });
  console.log('screenshot saved to', SHOT);
  await app.close();
}

run().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
