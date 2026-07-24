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
