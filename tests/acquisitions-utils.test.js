'use strict';

const { mergeInventory, splitInventory, ACQ_HULL_CATEGORY_ID } = require('../renderer/acquisitions-utils');

const hull = (id, name, qty) => ({ type_id: id, name, quantity: qty, category_id: 6 });
const mod = (id, name, qty) => ({ type_id: id, name, quantity: qty, category_id: 7 });

// ── splitInventory (replace-mode partition) ──────────────────────────────────

describe('splitInventory', () => {
  test('partitions hulls (category 6) from everything else', () => {
    const { hulls, items } = splitInventory([hull(671, 'Erebus', 1), mod(34, 'Tritanium', 500)]);
    expect(hulls.map((h) => h.name)).toEqual(['Erebus']);
    expect(items.map((i) => i.name)).toEqual(['Tritanium']);
  });

  test('handles an empty list', () => {
    expect(splitInventory([])).toEqual({ hulls: [], items: [] });
    expect(splitInventory(null)).toEqual({ hulls: [], items: [] });
  });

  test('exposes the hull category id it partitions on', () => {
    expect(ACQ_HULL_CATEGORY_ID).toBe(6);
  });
});

// ── mergeInventory ───────────────────────────────────────────────────────────

describe('mergeInventory', () => {
  test('sums quantity when a parsed type already exists', () => {
    const { items } = mergeInventory([], [mod(34, 'Tritanium', 500)], [mod(34, 'Tritanium', 5)]);
    expect(items).toHaveLength(1);
    expect(items[0].quantity).toBe(505);
  });

  test('appends a brand-new type', () => {
    const { items } = mergeInventory([], [mod(34, 'Tritanium', 500)], [mod(35, 'Pyerite', 10)]);
    expect(items.map((i) => i.name).sort()).toEqual(['Pyerite', 'Tritanium']);
    expect(items.find((i) => i.name === 'Pyerite').quantity).toBe(10);
  });

  test('routes a merged hull into hulls, a merged module into items', () => {
    const { hulls, items } = mergeInventory(
      [hull(671, 'Erebus', 1)],
      [mod(34, 'Tritanium', 500)],
      [hull(671, 'Erebus', 2), mod(35, 'Pyerite', 10)],
    );
    expect(hulls).toHaveLength(1);
    expect(hulls[0].quantity).toBe(3);
    expect(items.map((i) => i.name).sort()).toEqual(['Pyerite', 'Tritanium']);
  });

  test('adding into an empty inventory equals a plain split', () => {
    const parsed = [hull(671, 'Erebus', 1), mod(34, 'Tritanium', 500)];
    const merged = mergeInventory([], [], parsed);
    const split = splitInventory(parsed);
    expect(merged.hulls).toEqual(split.hulls);
    expect(merged.items).toEqual(split.items);
  });

  test('adding an empty parse leaves the inventory untouched', () => {
    const { hulls, items } = mergeInventory([hull(671, 'Erebus', 1)], [mod(34, 'Tritanium', 500)], []);
    expect(hulls).toEqual([hull(671, 'Erebus', 1)]);
    expect(items).toEqual([{ type_id: 34, name: 'Tritanium', quantity: 500, category_id: 7 }]);
  });

  test('reports new vs. updated distinct-type counts', () => {
    const { newTypes, updatedTypes } = mergeInventory(
      [],
      [mod(34, 'Tritanium', 500)],
      [mod(34, 'Tritanium', 5), mod(35, 'Pyerite', 10), mod(36, 'Mexallon', 3)],
    );
    expect(updatedTypes).toBe(1); // Tritanium existed
    expect(newTypes).toBe(2);     // Pyerite, Mexallon are new
  });

  test('a type pasted twice counts once and sums both quantities', () => {
    const { items, newTypes } = mergeInventory([], [], [mod(35, 'Pyerite', 10), mod(35, 'Pyerite', 4)]);
    expect(items).toHaveLength(1);
    expect(items[0].quantity).toBe(14);
    expect(newTypes).toBe(1);
  });

  test('matches type_id across the existing hull/module split regardless of source list', () => {
    // Same module id appears in existing items and is topped up.
    const { items } = mergeInventory([], [mod(34, 'Tritanium', 500)], [mod(34, 'Tritanium', 250)]);
    expect(items).toHaveLength(1);
    expect(items[0].quantity).toBe(750);
  });

  test('treats missing/blank quantities as 0 rather than NaN', () => {
    const { items } = mergeInventory(
      [],
      [{ type_id: 34, name: 'Tritanium', quantity: null, category_id: 7 }],
      [{ type_id: 34, name: 'Tritanium', quantity: undefined, category_id: 7 }],
    );
    expect(items[0].quantity).toBe(0);
  });

  test('skips parsed rows with no type_id', () => {
    const { items } = mergeInventory([], [], [{ type_id: null, name: 'Frobnicator', quantity: 1, category_id: 7 }]);
    expect(items).toEqual([]);
  });

  test('does not mutate the caller\'s existing arrays', () => {
    const existingItems = [mod(34, 'Tritanium', 500)];
    mergeInventory([], existingItems, [mod(34, 'Tritanium', 5)]);
    expect(existingItems[0].quantity).toBe(500);
  });
});

// ── build finder: pool + fit units ───────────────────────────────────────────

const {
  ACQ_MARKET_THRESHOLD, ACQ_MODES, buildPool, fitModuleUnits,
} = require('../renderer/acquisitions-utils');

describe('buildPool', () => {
  test('sums hulls and items into one type_id -> qty map', () => {
    const pool = buildPool([hull(24698, 'Drake', 2)], [mod(2048, 'Damage Control II', 5)]);
    expect(pool.get('24698')).toBe(2);
    expect(pool.get('2048')).toBe(5);
  });

  test('merges duplicate type_ids across both lists', () => {
    const pool = buildPool([hull(24698, 'Drake', 2)], [hull(24698, 'Drake', 3)]);
    expect(pool.get('24698')).toBe(5);
  });

  test('tolerates null lists and missing quantities', () => {
    const pool = buildPool(null, [{ type_id: 34, name: 'Tritanium' }]);
    expect(pool.get('34')).toBe(0);
  });
});

describe('fitModuleUnits', () => {
  const fit = {
    hullTypeId: 24698,
    items: [
      { name: 'Drake', qty: 1, typeId: 24698 },
      { name: 'Damage Control II', qty: 1, typeId: 2048 },
      { name: 'Invulnerability Field II', qty: 2, typeId: 2281 },
    ],
  };

  test('strips the hull row so a fit does not demand a second hull', () => {
    const { units } = fitModuleUnits(fit);
    expect(units.has('24698')).toBe(false);
    expect(units.get('2048')).toBe(1);
    expect(units.get('2281')).toBe(2);
  });

  test('sums repeated rows of the same module', () => {
    const { units } = fitModuleUnits({
      hullTypeId: 1,
      items: [
        { name: 'Mag Stab', qty: 3, typeId: 9944 },
        { name: 'Mag Stab', qty: 5, typeId: 9944 },
      ],
    });
    expect(units.get('9944')).toBe(8);
  });

  test('flags a fit with an unresolved typeId as unevaluatable', () => {
    const { unevaluatable } = fitModuleUnits({
      hullTypeId: 1,
      items: [{ name: 'Mystery Module', qty: 1, typeId: null }],
    });
    expect(unevaluatable).toBe(true);
  });

  test('a clean fit is evaluatable', () => {
    expect(fitModuleUnits(fit).unevaluatable).toBe(false);
  });

  test('handles a missing items array', () => {
    const { units, unevaluatable } = fitModuleUnits({ hullTypeId: 1 });
    expect(units.size).toBe(0);
    expect(unevaluatable).toBe(false);
  });
});

describe('constants', () => {
  test('threshold is 80%', () => {
    expect(ACQ_MARKET_THRESHOLD).toBe(0.8);
  });

  test('modes are named', () => {
    expect(ACQ_MODES).toEqual({ FULL: 'full', FITS_NO_HULL: 'fitsNoHull', MARKET: 'marketCompletable' });
  });
});

// ── build finder: single-build evaluation ────────────────────────────────────

const { evaluateBuild } = require('../renderer/acquisitions-utils');

const units = (pairs) => new Map(pairs);

describe('evaluateBuild — full mode', () => {
  test('accepts when hull and every module are present', () => {
    const pool = new Map([['24698', 1], ['2048', 2]]);
    const r = evaluateBuild({
      pool, hullTypeId: 24698, units: units([['2048', 2]]), mode: ACQ_MODES.FULL,
    });
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.coverage).toBe(1);
  });

  test('rejects when the hull is absent', () => {
    const pool = new Map([['2048', 2]]);
    const r = evaluateBuild({
      pool, hullTypeId: 24698, units: units([['2048', 2]]), mode: ACQ_MODES.FULL,
    });
    expect(r.ok).toBe(false);
    expect(r.hullPresent).toBe(false);
  });

  test('rejects on a short module quantity and reports the gap', () => {
    const pool = new Map([['24698', 1], ['2048', 1]]);
    const r = evaluateBuild({
      pool, hullTypeId: 24698, units: units([['2048', 3]]), mode: ACQ_MODES.FULL,
    });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual([{ type_id: '2048', qty: 2 }]);
  });
});

describe('evaluateBuild — fitsNoHull mode', () => {
  test('accepts when modules are present and the hull is not', () => {
    const pool = new Map([['2048', 1]]);
    const r = evaluateBuild({
      pool, hullTypeId: 24698, units: units([['2048', 1]]), mode: ACQ_MODES.FITS_NO_HULL,
    });
    expect(r.ok).toBe(true);
  });

  test('rejects when the hull IS present', () => {
    const pool = new Map([['24698', 1], ['2048', 1]]);
    const r = evaluateBuild({
      pool, hullTypeId: 24698, units: units([['2048', 1]]), mode: ACQ_MODES.FITS_NO_HULL,
    });
    expect(r.ok).toBe(false);
  });
});

describe('evaluateBuild — marketCompletable mode', () => {
  const market = { by_type: { 2281: { min_price: 500, total_volume: 10, order_count: 2 } } };

  test('accepts at exactly the threshold when the gap is on the market', () => {
    const pool = new Map([['24698', 1], ['2048', 8]]);
    const r = evaluateBuild({
      pool, hullTypeId: 24698, units: units([['2048', 8], ['2281', 2]]),
      mode: ACQ_MODES.MARKET, market, threshold: ACQ_MARKET_THRESHOLD,
    });
    expect(r.coverage).toBeCloseTo(0.8);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([{ type_id: '2281', qty: 2 }]);
  });

  test('rejects just under the threshold', () => {
    const pool = new Map([['24698', 1], ['2048', 7]]);
    const r = evaluateBuild({
      pool, hullTypeId: 24698, units: units([['2048', 8], ['2281', 2]]),
      mode: ACQ_MODES.MARKET, market, threshold: ACQ_MARKET_THRESHOLD,
    });
    expect(r.coverage).toBeCloseTo(0.7);
    expect(r.ok).toBe(false);
  });

  test('rejects when the market has the type but too few units', () => {
    const thin = { by_type: { 2281: { min_price: 500, total_volume: 1, order_count: 1 } } };
    const pool = new Map([['24698', 1], ['2048', 8]]);
    const r = evaluateBuild({
      pool, hullTypeId: 24698, units: units([['2048', 8], ['2281', 2]]),
      mode: ACQ_MODES.MARKET, market: thin, threshold: ACQ_MARKET_THRESHOLD,
    });
    expect(r.ok).toBe(false);
  });

  test('rejects when the market lacks the type entirely', () => {
    const pool = new Map([['24698', 1], ['2048', 8]]);
    const r = evaluateBuild({
      pool, hullTypeId: 24698, units: units([['2048', 8], ['9999', 2]]),
      mode: ACQ_MODES.MARKET, market, threshold: ACQ_MARKET_THRESHOLD,
    });
    expect(r.ok).toBe(false);
  });

  test('rejects when the hull is absent even at full module coverage', () => {
    const pool = new Map([['2048', 8], ['2281', 2]]);
    const r = evaluateBuild({
      pool, hullTypeId: 24698, units: units([['2048', 8], ['2281', 2]]),
      mode: ACQ_MODES.MARKET, market, threshold: ACQ_MARKET_THRESHOLD,
    });
    expect(r.ok).toBe(false);
  });

  test('a fit needing nothing scores full coverage', () => {
    const pool = new Map([['24698', 1]]);
    const r = evaluateBuild({
      pool, hullTypeId: 24698, units: units([]), mode: ACQ_MODES.MARKET,
      market, threshold: ACQ_MARKET_THRESHOLD,
    });
    expect(r.coverage).toBe(1);
    expect(r.ok).toBe(true);
  });
});
