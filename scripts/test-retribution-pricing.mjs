/**
 * Show a per-module price breakdown for the Retribution Mk2 and Mk3 fits.
 */
import { _electron as electron } from 'playwright';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(fileURLToPath(import.meta.url), '../../');
const electronBin = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const SHOT_DIR = path.join(APP_DIR, 'scripts', 'shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

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
  console.log('connecting to running app...');
  const app = await electron.launch({
    executablePath: electronBin,
    args: [APP_DIR],
    timeout: 60_000,
  });
  const splash = await app.firstWindow();
  await splash.waitForLoadState('domcontentloaded');
  process.stdout.write('waiting for main window');
  const page = await waitForMainWindow(app, 60_000);
  console.log('\nready');

  // Find Retribution fits in AA doctrines
  const retFits = await page.evaluate(async () => {
    const r = await window.api.aaFetchHtml('/fittings/');
    if (!r.ok) return { error: 'not logged in' };
    const doctrines = parseDoctrinesHtml(r.html);
    const fits = [];
    for (const d of doctrines) {
      if (!d.id) continue;
      const dr = await window.api.aaFetchHtml(`/fittings/doctrine/${d.id}/`);
      if (!dr.ok) continue;
      const detail = parseDoctrineDetail(dr.html);
      for (const fit of detail.fits) {
        if (fit.shipType?.toLowerCase() === 'retribution') {
          fits.push({ id: fit.id, name: fit.name, shipType: fit.shipType });
        }
      }
    }
    return { fits: [...new Map(fits.map(f => [f.id, f])).values()] };
  });

  if (retFits.error) { console.log('error:', retFits.error); await app.close(); return; }
  console.log(`\nRetribution fits in AA: ${retFits.fits.length}`);
  retFits.fits.forEach(f => console.log(`  id=${f.id} "${f.name}"`));

  const API = 'http://localhost:8765';

  for (const fit of retFits.fits) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Fit: "${fit.name}" (id=${fit.id})`);
    console.log('='.repeat(60));

    const detail = await page.evaluate(async (fitId) => {
      const res = await window.api.aaFetchHtml(`/fittings/fit/${fitId}/`);
      if (!res.ok) return null;
      const d = parseFitDetail(res.html);
      return { hullName: d.hullName, hullTypeId: d.hullTypeId, slotModules: d.slotModules, eft: d.eft };
    }, fit.id);

    if (!detail) { console.log('failed to fetch'); continue; }

    // Build pricing items: hull + slot modules
    const pricingItems = [];
    if (detail.hullTypeId) pricingItems.push({ typeId: detail.hullTypeId, name: detail.hullName, qty: 1 });
    for (const m of detail.slotModules) pricingItems.push({ typeId: m.typeId || null, name: m.name, qty: 1 });

    // Fetch prices
    const uniqueIds = [...new Set(pricingItems.filter(i => i.typeId).map(i => i.typeId))];
    const prices = await Promise.all(
      uniqueIds.map(tid =>
        fetch(`${API}/api/market/amarr-sell?type_id=${tid}`)
          .then(r => r.json())
          .catch(() => null)
      )
    );
    const priceMap = new Map();
    prices.forEach((p, i) => { if (p?.min_sell != null) priceMap.set(uniqueIds[i], p.min_sell); });

    let total = 0;
    const unpriced = [];
    console.log('\nModule breakdown:');
    for (const item of pricingItems) {
      const p = item.typeId ? priceMap.get(item.typeId) : null;
      if (p != null) {
        total += p;
        console.log(`  ✓  ${item.name.padEnd(45)} ${(p).toLocaleString('en-US', {maximumFractionDigits:0}).padStart(15)} ISK`);
      } else {
        unpriced.push(item);
        console.log(`  ✗  ${item.name.padEnd(45)} ${'(unpriced)'.padStart(15)}`);
      }
    }
    console.log(`\n  Total (hull + modules):  ${total.toLocaleString('en-US', {maximumFractionDigits:0}).padStart(20)} ISK`);
    console.log(`  115% contract price:     ${(total * 1.15).toLocaleString('en-US', {maximumFractionDigits:0}).padStart(20)} ISK`);
    if (unpriced.length) {
      console.log(`\n  Unpriced (${unpriced.length}): ${unpriced.map(u => u.name).join(', ')}`);
    }
    if (detail.eft) {
      console.log('\nEFT:\n' + detail.eft.slice(0, 600));
    }
  }

  await app.close();
  console.log('\ndone');
}

run().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
