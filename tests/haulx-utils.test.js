'use strict';

const {
  haulxTotals,
  haulxFillByPriority,
  haulxBlockReason,
  haulxIsAddable,
  haulxProfit,
  haulxClassifySell,
  haulxClassifyBuy,
  HAULX_MAX_VOLUME,
  HAULX_MAX_COLLATERAL,
  HAULX_SHIPPING_COST,
  HAULX_SELL_MARKUP,
} = require('../renderer/haulx-utils');

// A fully-priced ship: both fit volume and fit price known, so it is addable.
const fitted = (vol, price, buyPrice = null) => ({
  fit_volume: vol,
  fit_price: price,
  fit_buy_price: buyPrice,
  packaged_volume: vol,
  min_sell: price,
});

// ── constants ─────────────────────────────────────────────────────────────────

describe('haul caps', () => {
  test('match the PushX limits the UI advertises', () => {
    expect(HAULX_MAX_VOLUME).toBe(360000);          // 360 km³
    expect(HAULX_MAX_COLLATERAL).toBe(5_000_000_000);
    expect(HAULX_SHIPPING_COST).toBe(400_000_000);
    expect(HAULX_SELL_MARKUP).toBe(1.20);
  });
});

// ── haulxBlockReason / haulxIsAddable ────────────────────────────────────────

describe('haulxBlockReason', () => {
  test('a fully-priced ship with a fit is not blocked', () => {
    expect(haulxBlockReason(fitted(50000, 100_000_000), true)).toBe('');
  });

  test('no fit in Auth blocks the ship even when hull prices are known', () => {
    const hullOnly = { fit_volume: null, fit_price: null, packaged_volume: 50000, min_sell: 100_000_000 };
    expect(haulxBlockReason(hullOnly, false)).toBe('no fit in Auth');
  });

  test('a fit whose items are not all priced blocks with "no price"', () => {
    const unpriced = { fit_volume: 50000, fit_price: null, packaged_volume: 50000, min_sell: 100_000_000 };
    expect(haulxBlockReason(unpriced, true)).toBe('no price');
  });

  test('a fit with an unmeasured item blocks with "no volume"', () => {
    const unmeasured = { fit_volume: null, fit_price: 100_000_000, packaged_volume: 50000 };
    expect(haulxBlockReason(unmeasured, true)).toBe('no volume');
  });

  test('missing price is reported before missing volume', () => {
    const neither = { fit_volume: null, fit_price: null };
    expect(haulxBlockReason(neither, true)).toBe('no price');
  });

  test('a ship with no cache entry at all is blocked, not crashed on', () => {
    expect(haulxBlockReason(undefined, true)).toBe('no price');
  });
});

describe('haulxIsAddable', () => {
  test('requires both fit volume and fit price', () => {
    expect(haulxIsAddable(fitted(50000, 100_000_000))).toBe(true);
    expect(haulxIsAddable({ fit_volume: 50000, fit_price: null })).toBe(false);
    expect(haulxIsAddable({ fit_volume: null, fit_price: 100_000_000 })).toBe(false);
    expect(haulxIsAddable(undefined)).toBe(false);
  });

  test('hull-only figures do not make a ship addable', () => {
    expect(haulxIsAddable({ packaged_volume: 50000, min_sell: 100_000_000 })).toBe(false);
  });
});

// ── haulxTotals ───────────────────────────────────────────────────────────────

describe('haulxTotals', () => {
  test('returns zeroes for an empty qty map', () => {
    expect(haulxTotals({}, {})).toEqual({ vol: 0, isk: 0, sellValue: 0, buyValue: 0 });
  });

  test('returns zeroes when every qty is 0', () => {
    const cache = { '123': fitted(50000, 100_000_000) };
    expect(haulxTotals({ '123': 0 }, cache)).toEqual({ vol: 0, isk: 0, sellValue: 0, buyValue: 0 });
  });

  test('multiplies fit volume and fit price by quantity', () => {
    const cache = { '123': fitted(50000, 100_000_000) };
    const { vol, isk } = haulxTotals({ '123': 3 }, cache);
    expect(vol).toBe(150000);
    expect(isk).toBe(300_000_000);
  });

  test('sums across multiple ships', () => {
    const cache = { '1': fitted(50000, 200_000_000), '2': fitted(10000, 50_000_000) };
    const { vol, isk } = haulxTotals({ '1': 2, '2': 4 }, cache);
    expect(vol).toBe(2 * 50000 + 4 * 10000);
    expect(isk).toBe(2 * 200_000_000 + 4 * 50_000_000);
  });

  test('prefers fit figures over the bare hull figures', () => {
    const cache = { '1': { fit_volume: 80000, fit_price: 300_000_000, packaged_volume: 50000, min_sell: 100_000_000 } };
    const { vol, isk } = haulxTotals({ '1': 1 }, cache);
    expect(vol).toBe(80000);
    expect(isk).toBe(300_000_000);
  });

  test('falls back to hull figures when the fit total is unknown', () => {
    const cache = { '1': { fit_volume: null, fit_price: null, packaged_volume: 50000, min_sell: 100_000_000 } };
    const { vol, isk } = haulxTotals({ '1': 2 }, cache);
    expect(vol).toBe(100000);
    expect(isk).toBe(200_000_000);
  });

  test('sell value counts only fully-priced fits, so the profit line never mixes bases', () => {
    const cache = {
      '1': fitted(50000, 200_000_000),
      '2': { fit_volume: null, fit_price: null, packaged_volume: 10000, min_sell: 50_000_000 },
    };
    const { isk, sellValue } = haulxTotals({ '1': 1, '2': 1 }, cache);
    expect(isk).toBe(250_000_000);      // collateral still counts the hull fallback
    expect(sellValue).toBe(200_000_000); // but sell value does not
  });

  test('buy value accumulates fit_buy_price only when present', () => {
    const cache = { '1': fitted(50000, 200_000_000, 150_000_000), '2': fitted(10000, 50_000_000) };
    const { buyValue } = haulxTotals({ '1': 2, '2': 3 }, cache);
    expect(buyValue).toBe(300_000_000);
  });

  test('skips ships with no price cache entry', () => {
    const cache = { '1': fitted(50000, 100_000_000) };
    const { vol, isk } = haulxTotals({ '1': 1, '2': 5 }, cache);
    expect(vol).toBe(50000);
    expect(isk).toBe(100_000_000);
  });

  test('treats null hull volume and price as 0', () => {
    const cache = { '1': { fit_volume: null, fit_price: null, packaged_volume: null, min_sell: null } };
    expect(haulxTotals({ '1': 3 }, cache)).toEqual({ vol: 0, isk: 0, sellValue: 0, buyValue: 0 });
  });
});

// ── haulxProfit ───────────────────────────────────────────────────────────────

describe('haulxProfit', () => {
  test('applies the sell markup, then subtracts cost and shipping', () => {
    // 5B sell × 1.20 = 6B, less 4B bought, less 400M shipping
    expect(haulxProfit(5_000_000_000, 4_000_000_000)).toBe(1_600_000_000);
  });

  test('goes negative when the margin does not cover shipping', () => {
    expect(haulxProfit(1_000_000_000, 1_150_000_000)).toBe(-350_000_000);
  });

  test('an empty haul still costs the flat shipping fee', () => {
    expect(haulxProfit(0, 0)).toBe(-HAULX_SHIPPING_COST);
  });
});

// ── haulxFillByPriority ───────────────────────────────────────────────────────

const ship = (id, missing, vol, isk) => ({
  ship_type_id: id,
  missing,
  _cache: fitted(vol, isk),
});

function makeCache(ships) {
  return Object.fromEntries(ships.map((s) => [String(s.ship_type_id), s._cache]));
}

describe('haulxFillByPriority', () => {
  test('returns empty object when there are no quotas', () => {
    expect(haulxFillByPriority([], {}, false)).toEqual({});
  });

  test('tolerates a null quota list', () => {
    expect(haulxFillByPriority(null, {}, false)).toEqual({});
  });

  test('skips ships with no gap when overQuota is false', () => {
    const ships = [ship(1, 0, 50000, 100_000_000)];
    expect(haulxFillByPriority(ships, makeCache(ships), false)).toEqual({});
  });

  test('fills the missing count for a single ship', () => {
    const ships = [ship(1, 3, 50000, 100_000_000)];
    expect(haulxFillByPriority(ships, makeCache(ships), false)).toEqual({ '1': 3 });
  });

  test('stops filling when the volume cap is reached', () => {
    const ships = [ship(1, 5, 150000, 100_000_000)];
    const qty = haulxFillByPriority(ships, makeCache(ships), false, 360000, Infinity);
    expect(qty['1']).toBe(2);
  });

  test('stops filling when the ISK cap is reached', () => {
    const ships = [ship(1, 5, 1000, 3_000_000_000)];
    const qty = haulxFillByPriority(ships, makeCache(ships), false, Infinity, 5_000_000_000);
    expect(qty['1']).toBe(1);
  });

  test('fills in priority order, stopping mid-list when full', () => {
    const ships = [ship(1, 2, 150000, 100_000_000), ship(2, 3, 150000, 100_000_000)];
    const qty = haulxFillByPriority(ships, makeCache(ships), false, 360000, Infinity);
    expect(qty['1']).toBe(2);
    expect(qty['2']).toBeUndefined();
  });

  test('partially fills the ship that straddles the limit', () => {
    const ships = [ship(1, 1, 200000, 100_000_000), ship(2, 5, 100000, 100_000_000)];
    const qty = haulxFillByPriority(ships, makeCache(ships), false, 360000, Infinity);
    expect(qty['1']).toBe(1);
    expect(qty['2']).toBe(1);
  });

  test('overQuota=true includes at-quota ships', () => {
    const ships = [ship(1, 0, 50000, 100_000_000)];
    const qty = haulxFillByPriority(ships, makeCache(ships), true, Infinity, Infinity);
    expect(qty['1']).toBe(999);
  });

  test('overQuota=true still respects the volume cap', () => {
    const ships = [ship(1, 0, 150000, 100_000_000)];
    const qty = haulxFillByPriority(ships, makeCache(ships), true, 360000, Infinity);
    expect(qty['1']).toBe(2);
  });

  test('does not exceed the ISK cap across multiple ships', () => {
    const ships = [ship(1, 2, 1000, 2_000_000_000), ship(2, 2, 1000, 2_000_000_000)];
    const qty = haulxFillByPriority(ships, makeCache(ships), false, Infinity, 5_000_000_000);
    expect(qty['1']).toBe(2);
    expect(qty['2']).toBeUndefined();
  });

  // ── blocked ships ───────────────────────────────────────────────────────────
  // A haul must never be planned against costs we can't stand behind.

  test('skips a ship with no price cache entry rather than filling it uncapped', () => {
    const ships = [ship(1, 3, 50000, 100_000_000)];
    expect(haulxFillByPriority(ships, {}, false)).toEqual({});
  });

  test('skips a ship whose fit has an unpriced item', () => {
    const cache = { '1': { fit_volume: 50000, fit_price: null, packaged_volume: 50000, min_sell: 100_000_000 } };
    expect(haulxFillByPriority([ship(1, 3, 50000, 100_000_000)], cache, false)).toEqual({});
  });

  test('skips a ship whose fit volume is unknown', () => {
    const cache = { '1': { fit_volume: null, fit_price: 100_000_000, packaged_volume: 50000 } };
    expect(haulxFillByPriority([ship(1, 3, 50000, 100_000_000)], cache, false)).toEqual({});
  });

  test('does not fall back to the bare hull volume and price', () => {
    // Hull figures are present and would fit comfortably, but the fit is unpriced.
    const cache = { '1': { fit_volume: null, fit_price: null, packaged_volume: 1000, min_sell: 1_000_000 } };
    expect(haulxFillByPriority([ship(1, 5, 1000, 1_000_000)], cache, false)).toEqual({});
  });

  test('a blocked ship does not consume capacity from the ships after it', () => {
    const ships = [ship(1, 2, 150000, 100_000_000), ship(2, 2, 150000, 100_000_000)];
    const cache = makeCache(ships);
    cache['1'] = { fit_volume: null, fit_price: null, packaged_volume: 150000, min_sell: 100_000_000 };
    const qty = haulxFillByPriority(ships, cache, false, 360000, Infinity);
    expect(qty['1']).toBeUndefined();
    expect(qty['2']).toBe(2);
  });

  test('blocked ships are skipped under overQuota too', () => {
    const cache = { '1': { fit_volume: null, fit_price: null, packaged_volume: 50000, min_sell: 100_000_000 } };
    expect(haulxFillByPriority([ship(1, 0, 50000, 100_000_000)], cache, true, Infinity, Infinity)).toEqual({});
  });

  test('defaults to the real caps when none are passed', () => {
    // 3 km³ per ship, 200 asked for — the 360 km³ cap should bind at 120.
    const ships = [ship(1, 200, 3000, 1_000_000)];
    const qty = haulxFillByPriority(ships, makeCache(ships), false);
    expect(qty['1']).toBe(HAULX_MAX_VOLUME / 3000);
  });
});

// ── haulxClassifySell / haulxClassifyBuy ─────────────────────────────────────

describe('haulxClassifySell', () => {
  test('a good response yields both numbers and is not a failure', () => {
    expect(haulxClassifySell(true, 200, { min_sell: 1000, packaged_volume: 2500 }))
      .toEqual({ minSell: 1000, vol: 2500, failed: false });
  });

  test('a null min_sell is an honest answer, not a failure', () => {
    // The item is simply not on the Jita sell book. Retrying cannot change it.
    expect(haulxClassifySell(true, 200, { min_sell: null, packaged_volume: 2500 }))
      .toEqual({ minSell: null, vol: 2500, failed: false });
  });

  test('a null packaged_volume is a failure', () => {
    // Every EVE type has a volume, so a null one means the server's type-info
    // lookup threw and swallowed the error while still returning 200.
    expect(haulxClassifySell(true, 200, { min_sell: 1000, packaged_volume: null }))
      .toEqual({ minSell: 1000, vol: null, failed: true });
  });

  test('a non-ok response is a failure', () => {
    expect(haulxClassifySell(false, 502, null))
      .toEqual({ minSell: null, vol: null, failed: true });
  });

  test('a network throw, passed as ok=false with no status, is a failure', () => {
    expect(haulxClassifySell(false, 0, null))
      .toEqual({ minSell: null, vol: null, failed: true });
  });
});

describe('haulxClassifyBuy', () => {
  test('a good response yields the buy price and is not a failure', () => {
    expect(haulxClassifyBuy(true, 200, { max_buy: 900 }))
      .toEqual({ maxBuy: 900, failed: false });
  });

  test('a missing max_buy is an honest answer, not a failure', () => {
    expect(haulxClassifyBuy(true, 200, { max_buy: null }))
      .toEqual({ maxBuy: null, failed: false });
  });

  test('422 means no Janice key is configured, so it is not retryable', () => {
    // Retrying would fail identically every time and would leave the button
    // permanently offering hundreds of doomed lookups.
    expect(haulxClassifyBuy(false, 422, null))
      .toEqual({ maxBuy: null, failed: false });
  });

  test('any other non-ok response is a failure', () => {
    expect(haulxClassifyBuy(false, 502, null))
      .toEqual({ maxBuy: null, failed: true });
  });
});
