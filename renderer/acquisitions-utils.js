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

// ---------------------------------------------------------------------------
// Build finder — which quota ships this inventory can actually deliver.
// Design: docs/superpowers/specs/2026-07-24-acquisitions-build-finder-design.md
// ---------------------------------------------------------------------------

// Fraction of a fit's required units that must already be in inventory before
// the remainder is worth buying on the UEXO market. Constant by design.
const ACQ_MARKET_THRESHOLD = 0.8;

const ACQ_MODES = {
  FULL: 'full',
  FITS_NO_HULL: 'fitsNoHull',
  MARKET: 'marketCompletable',
};

/** Flatten the page's hulls + modules into one type_id -> quantity map. */
function buildPool(hulls, items) {
  const pool = new Map();
  for (const row of [...(hulls || []), ...(items || [])]) {
    if (row?.type_id == null) continue;
    const key = String(row.type_id);
    pool.set(key, (pool.get(key) || 0) + (Number(row.quantity) || 0));
  }
  return pool;
}

/**
 * A fit's module requirements as type_id -> units.
 *
 * The hull row is always dropped: fits list their own hull, and leaving it in
 * would make every build demand a second one. This deliberately does NOT use
 * app.js's fitItemsForReadiness, which only strips the hull when the
 * excludeHulls display toggle is on — a UI preference must not change which
 * ships come out buildable.
 */
function fitModuleUnits(fit) {
  const units = new Map();
  let unevaluatable = false;
  const hullKey = fit?.hullTypeId != null ? String(fit.hullTypeId) : null;
  for (const item of fit?.items || []) {
    if (item?.typeId == null) { unevaluatable = true; continue; }
    const key = String(item.typeId);
    if (key === hullKey) continue;
    units.set(key, (units.get(key) || 0) + (Number(item.qty) || 0));
  }
  return { units, unevaluatable };
}

/**
 * Test one build of one ship against the pool as it currently stands.
 *
 * Pure: never mutates `pool`. The caller deducts on acceptance, which is what
 * stops two ships being promised the same module.
 */
function evaluateBuild({ pool, hullTypeId, units, mode, market, threshold = ACQ_MARKET_THRESHOLD }) {
  const hullKey = hullTypeId != null ? String(hullTypeId) : null;
  const hullPresent = hullKey != null && (pool.get(hullKey) || 0) >= 1;

  let required = 0;
  let held = 0;
  const missing = [];
  for (const [tid, need] of units) {
    const have = Math.min(pool.get(tid) || 0, need);
    required += need;
    held += have;
    if (have < need) missing.push({ type_id: tid, qty: need - have });
  }
  const coverage = required === 0 ? 1 : held / required;

  let ok;
  if (mode === ACQ_MODES.FULL) {
    ok = hullPresent && missing.length === 0;
  } else if (mode === ACQ_MODES.FITS_NO_HULL) {
    ok = !hullPresent && missing.length === 0;
  } else {
    // Every shortfall must be buyable in the quantity needed — a type that is
    // listed but nearly sold out does not make the build completable.
    const buyable = missing.every((m) => {
      const byType = market?.by_type || {};
      const entry = byType[m.type_id] || byType[Number(m.type_id)];
      return !!entry && (entry.total_volume || 0) >= m.qty;
    });
    ok = hullPresent && coverage >= threshold && buyable;
  }

  return { ok, hullPresent, coverage, missing };
}

/**
 * Walk targets in priority order, building what the remaining pool allows.
 *
 * Works on a copy of the pool, so each mode can be run from the same starting
 * inventory. In FITS_NO_HULL a hull that IS available is consumed along with
 * its modules: that unit is a complete build, not a hull-less one, and its
 * modules must not be offered again as a spare set.
 */
function planAcquisitions({ pool, targets, mode, market, threshold = ACQ_MARKET_THRESHOLD }) {
  const remaining = new Map(pool);
  const builds = [];
  const blocked = [];

  const take = (tid, qty) => remaining.set(tid, (remaining.get(tid) || 0) - qty);

  for (const t of targets || []) {
    if ((t.needed || 0) <= 0) continue;
    if (t.unevaluatable) {
      blocked.push({
        shipTypeId: t.shipTypeId, shipName: t.shipName, fitName: t.fitName,
        reason: 'unevaluatable',
      });
      continue;
    }

    let made = 0;
    for (let i = 0; i < t.needed; i += 1) {
      const r = evaluateBuild({
        pool: remaining, hullTypeId: t.shipTypeId, units: t.units, mode, market, threshold,
      });

      // A hull-backed unit in FITS_NO_HULL mode is a full build: consume it and
      // move on, so its modules are not re-reported as a spare fit.
      if (mode === ACQ_MODES.FITS_NO_HULL && r.hullPresent && r.missing.length === 0) {
        take(String(t.shipTypeId), 1);
        for (const [tid, need] of t.units) take(tid, need);
        continue;
      }
      if (!r.ok) break;

      if (mode !== ACQ_MODES.FITS_NO_HULL) take(String(t.shipTypeId), 1);
      for (const [tid, need] of t.units) {
        take(tid, Math.min(remaining.get(tid) || 0, need));
      }
      builds.push({
        shipTypeId: t.shipTypeId, shipName: t.shipName, fitName: t.fitName,
        missing: r.missing, coverage: r.coverage,
      });
      made += 1;
    }

    if (made === 0) {
      blocked.push({
        shipTypeId: t.shipTypeId, shipName: t.shipName, fitName: t.fitName,
        reason: 'no-match',
      });
    }
  }

  return { builds, blocked };
}

/**
 * Turn the contracts scan's quota rows into allocator targets, in quota order.
 *
 * Fit selection follows the convention already used in app.js: prefer a fit
 * whose name equals the quota's, else the first fit registered for that hull.
 * A quota with no fit at all is unevaluatable — we cannot know what it needs.
 */
function buildTargets(quotas, fitsById) {
  const byHull = new Map();
  for (const fit of Object.values(fitsById || {})) {
    if (fit?.hullTypeId == null) continue;
    const key = String(fit.hullTypeId);
    if (!byHull.has(key)) byHull.set(key, []);
    byHull.get(key).push(fit);
  }

  return (quotas || []).map((q) => {
    const key = String(q.ship_type_id);
    const candidates = byHull.get(key) || [];
    const fit = candidates.find((f) => f.name === q.name) || candidates[0] || null;
    const { units, unevaluatable } = fit
      ? fitModuleUnits(fit)
      : { units: new Map(), unevaluatable: true };
    return {
      shipTypeId: q.ship_type_id,
      shipName: fit?.hullName || q.name || String(q.ship_type_id),
      fitName: fit?.name || null,
      needed: Number(q.missing) || 0,
      units,
      unevaluatable,
    };
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    mergeInventory, splitInventory, ACQ_HULL_CATEGORY_ID,
    ACQ_MARKET_THRESHOLD, ACQ_MODES, buildPool, fitModuleUnits, evaluateBuild,
    planAcquisitions, buildTargets,
  };
}
