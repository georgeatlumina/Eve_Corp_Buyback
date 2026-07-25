'use strict';

// Pure HaulX planning maths, shared by the HaulX tab (loaded as a plain script
// before app.js) and the Jest suite. Keep this the single source of truth —
// app.js used to carry its own copy of the fill loop, which drifted.

const HAULX_MAX_VOLUME = 360000;             // m³ (360 km³) — PushX per-haul cap
const HAULX_MAX_COLLATERAL = 5_000_000_000;  // ISK — PushX per-haul cap
const HAULX_SHIPPING_COST = 400_000_000;     // ISK, flat per haul
const HAULX_SELL_MARKUP = 1.20;              // what the alliance sells fits at

/**
 * Why a ship can't be added to a haul, or '' when it can.
 *
 * A haul is only planned against numbers we can stand behind: both the full
 * fit volume and the full fit price must be known. A hull-only fallback would
 * understate the real cost, so it is deliberately not used here.
 */
function haulxBlockReason(priceEntry, hasFit) {
  if (!hasFit) return 'no fit in Auth';
  if (priceEntry?.fit_price == null) return 'no price';
  if (priceEntry?.fit_volume == null) return 'no volume';
  return '';
}

/** True when a ship has both a full fit volume and a full fit price. */
function haulxIsAddable(priceEntry) {
  return priceEntry?.fit_volume != null && priceEntry?.fit_price != null;
}

/**
 * Running totals for the sticky header.
 *
 * `vol`/`isk` fall back to the bare hull figures so the caps still count
 * something for any row that predates a price lookup; `sellValue`/`buyValue`
 * only count fully-priced fits, since the profit line must not mix the two.
 */
function haulxTotals(qty, priceCache) {
  let vol = 0, isk = 0, sellValue = 0, buyValue = 0;
  for (const [tid, q] of Object.entries(qty || {})) {
    if (!q) continue;
    const p = priceCache[tid];
    if (!p) continue;
    vol += q * (p.fit_volume != null ? p.fit_volume : (p.packaged_volume || 0));
    isk += q * (p.fit_price != null ? p.fit_price : (p.min_sell || 0));
    if (p.fit_price != null) sellValue += q * p.fit_price;
    if (p.fit_buy_price != null) buyValue += q * p.fit_buy_price;
  }
  return { vol, isk, sellValue, buyValue };
}

/** Estimated profit on a haul: what it sells for, less what it cost and shipping. */
function haulxProfit(sellValue, buyValue, shipping = HAULX_SHIPPING_COST, markup = HAULX_SELL_MARKUP) {
  return (sellValue * markup) - buyValue - shipping;
}

/**
 * Greedily fill a haul in quota (priority) order until a cap is hit.
 *
 * Ships without a full fit volume and price are skipped entirely — they are
 * the same rows the table locks to 0.
 */
function haulxFillByPriority(quotas, priceCache, overQuota, maxVol = HAULX_MAX_VOLUME, maxIsk = HAULX_MAX_COLLATERAL) {
  const qty = {};
  let vol = 0, isk = 0;
  for (const q of quotas || []) {
    const missing = Number(q.missing) || 0;
    if (!overQuota && missing <= 0) continue;
    const tid = String(q.ship_type_id);
    const p = priceCache[tid];
    if (!haulxIsAddable(p)) continue;
    const unitVol = p.fit_volume;
    const unitIsk = p.fit_price;
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    haulxTotals,
    haulxFillByPriority,
    haulxBlockReason,
    haulxIsAddable,
    haulxProfit,
    HAULX_MAX_VOLUME,
    HAULX_MAX_COLLATERAL,
    HAULX_SHIPPING_COST,
    HAULX_SELL_MARKUP,
  };
}
