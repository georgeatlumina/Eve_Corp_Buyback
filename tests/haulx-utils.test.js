'use strict';

const {
  haulxTotals,
  haulxFillByPriority,
  HAULX_MAX_VOLUME,
  HAULX_MAX_COLLATERAL,
} = require('../renderer/haulx-utils');

// ── haulxTotals ───────────────────────────────────────────────────────────────

describe('haulxTotals', () => {
  test('returns zero vol and isk for empty qty map', () => {
    expect(haulxTotals({}, {})).toEqual({ vol: 0, isk: 0 });
  });

  test('returns zero when qty is 0 for all ships', () => {
    const cache = { '123': { packaged_volume: 50000, min_sell: 100_000_000 } };
    expect(haulxTotals({ '123': 0 }, cache)).toEqual({ vol: 0, isk: 0 });
  });

  test('computes correct vol and isk for a single ship', () => {
    const cache = { '123': { packaged_volume: 50000, min_sell: 100_000_000 } };
    const { vol, isk } = haulxTotals({ '123': 3 }, cache);
    expect(vol).toBe(150000);
    expect(isk).toBe(300_000_000);
  });

  test('sums across multiple ships', () => {
    const cache = {
      '1': { packaged_volume: 50000, min_sell: 200_000_000 },
      '2': { packaged_volume: 10000, min_sell:  50_000_000 },
    };
    const { vol, isk } = haulxTotals({ '1': 2, '2': 4 }, cache);
    expect(vol).toBe(2 * 50000 + 4 * 10000);   // 140000
    expect(isk).toBe(2 * 200_000_000 + 4 * 50_000_000);  // 600M
  });

  test('skips ships with no price cache entry', () => {
    const cache = { '1': { packaged_volume: 50000, min_sell: 100_000_000 } };
    const { vol, isk } = haulxTotals({ '1': 1, '2': 5 }, cache);
    expect(vol).toBe(50000);
    expect(isk).toBe(100_000_000);
  });

  test('treats null packaged_volume as 0', () => {
    const cache = { '1': { packaged_volume: null, min_sell: 100_000_000 } };
    const { vol, isk } = haulxTotals({ '1': 3 }, cache);
    expect(vol).toBe(0);
    expect(isk).toBe(300_000_000);
  });

  test('treats null min_sell as 0', () => {
    const cache = { '1': { packaged_volume: 50000, min_sell: null } };
    const { vol, isk } = haulxTotals({ '1': 2 }, cache);
    expect(vol).toBe(100000);
    expect(isk).toBe(0);
  });
});

// ── haulxFillByPriority ───────────────────────────────────────────────────────

const ship = (id, missing, vol, isk) => ({
  ship_type_id: id,
  missing,
  _cache: { packaged_volume: vol, min_sell: isk },
});

function makeCache(ships) {
  return Object.fromEntries(ships.map((s) => [String(s.ship_type_id), s._cache]));
}

describe('haulxFillByPriority', () => {
  test('returns empty object when no quotas', () => {
    expect(haulxFillByPriority([], {}, false)).toEqual({});
  });

  test('skips ships with no gap when overQuota is false', () => {
    const ships = [ship(1, 0, 50000, 100_000_000)];
    expect(haulxFillByPriority(ships, makeCache(ships), false)).toEqual({});
  });

  test('fills missing count for a single ship', () => {
    const ships = [ship(1, 3, 50000, 100_000_000)];
    expect(haulxFillByPriority(ships, makeCache(ships), false)).toEqual({ '1': 3 });
  });

  test('stops filling when volume limit is reached', () => {
    // 3 ships × 150000 m³ = 450000, over the 360000 cap — should fit only 2
    const ships = [ship(1, 5, 150000, 100_000_000)];
    const qty = haulxFillByPriority(ships, makeCache(ships), false, 360000, Infinity);
    expect(qty['1']).toBe(2);
  });

  test('stops filling when ISK limit is reached', () => {
    // 3B each, cap 5B → fits 1
    const ships = [ship(1, 5, 1000, 3_000_000_000)];
    const qty = haulxFillByPriority(ships, makeCache(ships), false, Infinity, 5_000_000_000);
    expect(qty['1']).toBe(1);
  });

  test('fills in priority order, stopping mid-list when full', () => {
    const ships = [
      ship(1, 2, 150000, 100_000_000),
      ship(2, 3, 150000, 100_000_000),
    ];
    // 2 × 150000 = 300000 used; 360000 - 300000 = 60000 left → 0 of ship 2
    const qty = haulxFillByPriority(ships, makeCache(ships), false, 360000, Infinity);
    expect(qty['1']).toBe(2);
    expect(qty['2']).toBeUndefined();
  });

  test('partially fills the last ship that straddles the limit', () => {
    const ships = [
      ship(1, 1, 200000, 100_000_000),
      ship(2, 5, 100000, 100_000_000),
    ];
    // After ship 1: 200000 used, 160000 left → fits 1 of ship 2
    const qty = haulxFillByPriority(ships, makeCache(ships), false, 360000, Infinity);
    expect(qty['1']).toBe(1);
    expect(qty['2']).toBe(1);
  });

  test('overQuota=true includes at-quota ships', () => {
    const ships = [ship(1, 0, 50000, 100_000_000)];
    const qty = haulxFillByPriority(ships, makeCache(ships), true, Infinity, Infinity);
    expect(qty['1']).toBe(999);
  });

  test('overQuota=true still respects volume cap', () => {
    const ships = [ship(1, 0, 150000, 100_000_000)];
    const qty = haulxFillByPriority(ships, makeCache(ships), true, 360000, Infinity);
    expect(qty['1']).toBe(2);
  });

  test('ships with no price cache entry are skipped', () => {
    const ships = [ship(1, 3, 50000, 100_000_000)];
    // Pass empty cache — no price data for ship 1
    const qty = haulxFillByPriority(ships, {}, false);
    // No vol/isk constraint applies, so canFit = missing = 3
    expect(qty['1']).toBe(3);
  });

  test('does not exceed ISK cap across multiple ships', () => {
    const ships = [
      ship(1, 2, 1000, 2_000_000_000),
      ship(2, 2, 1000, 2_000_000_000),
    ];
    // After ship 1 (2 × 2B = 4B), only 1B left → fits 0 of ship 2
    const qty = haulxFillByPriority(ships, makeCache(ships), false, Infinity, 5_000_000_000);
    expect(qty['1']).toBe(2);
    expect(qty['2']).toBeUndefined();
  });
});
