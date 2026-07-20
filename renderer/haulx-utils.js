'use strict';

const HAULX_MAX_VOLUME = 360000;     // m³ (360 km³)
const HAULX_MAX_COLLATERAL = 5_000_000_000;  // ISK

function haulxTotals(qty, priceCache) {
  let vol = 0, isk = 0;
  for (const [tid, q] of Object.entries(qty)) {
    if (!q) continue;
    const p = priceCache[tid];
    if (p) {
      vol += q * (p.packaged_volume || 0);
      isk += q * (p.min_sell || 0);
    }
  }
  return { vol, isk };
}

function haulxFillByPriority(quotas, priceCache, overQuota, maxVol = HAULX_MAX_VOLUME, maxIsk = HAULX_MAX_COLLATERAL) {
  const qty = {};
  let vol = 0, isk = 0;
  for (const q of quotas) {
    const missing = Number(q.missing) || 0;
    if (!overQuota && missing <= 0) continue;
    const tid = String(q.ship_type_id);
    const p = priceCache[tid];
    const unitVol = p?.packaged_volume || 0;
    const unitIsk = p?.min_sell || 0;
    let canFit = overQuota ? 999 : missing;
    if (unitVol > 0) canFit = Math.min(canFit, Math.floor((maxVol - vol) / unitVol));
    if (unitIsk > 0) canFit = Math.min(canFit, Math.floor((maxIsk - isk) / unitIsk));
    if (canFit <= 0) continue;
    qty[tid] = canFit;
    vol += canFit * unitVol;
    isk += canFit * unitIsk;
  }
  return qty;
}

module.exports = { haulxTotals, haulxFillByPriority, HAULX_MAX_VOLUME, HAULX_MAX_COLLATERAL };
