'use strict';

// Pure inventory-merge maths for the Acquisitions tab, shared by the renderer
// (loaded as a plain script before app.js) and the Jest suite. Kept out of
// app.js so it can be unit-tested without a DOM.

const ACQ_HULL_CATEGORY_ID = 6;  // EVE inventory category for ships

/**
 * Merge a freshly-parsed list into the existing inventory.
 *
 * Everything is keyed by type_id. A parsed item that matches something already
 * held sums its quantity onto the stored entry; a new type_id is appended. The
 * merged set is then re-split into hulls (category 6) and modules, matching how
 * the tab partitions a plain parse.
 *
 * Existing hull/module entries and parsed items share the shape
 * {type_id, name, quantity, category_id}. Returns the two lists plus counts of
 * how many distinct types were newly added vs. topped up, for the status line.
 */
function mergeInventory(existingHulls, existingItems, parsedItems) {
  const byId = new Map();
  for (const it of [...(existingHulls || []), ...(existingItems || [])]) {
    if (it.type_id == null) continue;
    byId.set(String(it.type_id), { ...it, quantity: Number(it.quantity) || 0 });
  }
  const existingIds = new Set(byId.keys());

  for (const it of parsedItems || []) {
    if (it.type_id == null) continue;
    const id = String(it.type_id);
    const qty = Number(it.quantity) || 0;
    const cur = byId.get(id);
    if (cur) {
      cur.quantity += qty;
    } else {
      byId.set(id, {
        type_id: it.type_id,
        name: it.name,
        quantity: qty,
        category_id: it.category_id ?? null,
      });
    }
  }

  // Count distinct parsed types as new vs. updated (a type pasted twice counts once).
  let newTypes = 0;
  let updatedTypes = 0;
  const countedNew = new Set();
  for (const it of parsedItems || []) {
    if (it.type_id == null) continue;
    const id = String(it.type_id);
    if (existingIds.has(id)) {
      // updated — but only tally each distinct type once
      if (!countedNew.has('u:' + id)) { updatedTypes += 1; countedNew.add('u:' + id); }
    } else if (!countedNew.has('n:' + id)) {
      newTypes += 1;
      countedNew.add('n:' + id);
    }
  }

  const merged = [...byId.values()];
  return {
    hulls: merged.filter((it) => it.category_id === ACQ_HULL_CATEGORY_ID),
    items: merged.filter((it) => it.category_id !== ACQ_HULL_CATEGORY_ID),
    newTypes,
    updatedTypes,
  };
}

/** Split a flat parsed list into hulls vs. modules, the plain (replace) partition. */
function splitInventory(parsedItems) {
  const all = parsedItems || [];
  return {
    hulls: all.filter((it) => it.category_id === ACQ_HULL_CATEGORY_ID),
    items: all.filter((it) => it.category_id !== ACQ_HULL_CATEGORY_ID),
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { mergeInventory, splitInventory, ACQ_HULL_CATEGORY_ID };
}
