# Acquisitions Build Finder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three buttons to the Acquisitions tab that report which quota ships the parsed inventory can build outright, which have every module but no hull, and which are ≥80% complete with the remainder buyable on the UEXO market.

**Architecture:** All matching logic is pure and lives in `renderer/acquisitions-utils.js`, unit-tested by Jest without a DOM. `renderer/app.js` only gathers inputs (inventory from the page, quota gaps from the last contracts scan, fits from the readiness scan, market from `aaState.market`) and renders results. One consuming allocator serves all three buttons via a `mode` parameter.

**Tech Stack:** Vanilla JS (no framework), plain `<script>` load order, Jest with `jsdom`, Node ≥ 18.

**Spec:** `docs/superpowers/specs/2026-07-24-acquisitions-build-finder-design.md`

## Global Constraints

- Threshold is the module constant `ACQ_MARKET_THRESHOLD = 0.8`. Not user-adjustable.
- `renderer/acquisitions-utils.js` must stay pure: no DOM, no `fetch`, no globals. It is loaded as a plain script *and* `require()`d by Jest, so it keeps the existing `if (typeof module !== 'undefined' && module.exports)` footer.
- Allocation consumes from a running pool in quota priority order. Each button starts from a full pool; consumption never crosses buttons.
- Targets whose shortfall is ≤ 0 are skipped before any pool work.
- **The hull must be stripped from a fit's item rows unconditionally.** Do NOT reuse `fitItemsForReadiness` (`app.js:1888`) — it only strips the hull when the `excludeHulls` UI toggle is on, and a display toggle must never change build math.
- A fit with any item row where `typeId == null` is reported un-evaluatable, never silently passed.
- `renderer/app.js` is being edited concurrently in another session (HaulX, ~lines 4440–4850). Keep all edits inside the acquisitions region (~4184–4370) and re-check `git log` before every commit.
- Never `git add -A`. Stage explicit paths only.

## File Structure

| File | Responsibility |
|---|---|
| `renderer/acquisitions-utils.js` (modify) | Pure engine: pool building, fit unit extraction, per-build evaluation, allocator, target assembly |
| `tests/acquisitions-utils.test.js` (modify) | Jest coverage for all of the above |
| `renderer/app.js` (modify, ~4184–4370 only) | Button row, disabled states, click handlers, results rendering, market load for mode 3 |

## Data shapes (verified against the codebase — do not guess)

```js
// Inventory rows, already on the page as acquisitionsHulls / acquisitionsItems
{ type_id: 24698, name: 'Drake', quantity: 3, category_id: 6 }   // category 6 === hull

// A fit from readinessState.scan.fits — items carry qty (parse-utils.js:131)
{ id: '12', name: 'Drake Navy Issue', hullName: 'Drake', hullTypeId: 24698,
  category: 'Line', items: [{ name: 'Damage Control II', qty: 1, typeId: 2048 }],
  doctrineIds: [3] }

// Quota row from the contracts scan payload (lastContractsScan.quotas)
{ ship_type_id: 24698, name: 'Drake Navy Issue', required: 5, available: 4, missing: 1 }

// Market snapshot: aaState.market, from GET /api/aa/market (server.py:1218)
{ structure_id: 1234, fetched_at: 1769..., order_count: 8412,
  by_type: { '2048': { min_price: 1200000, total_volume: 40, order_count: 3 } } }
```

---

### Task 1: Pool and fit-unit builders

**Files:**
- Modify: `renderer/acquisitions-utils.js`
- Test: `tests/acquisitions-utils.test.js`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `ACQ_MARKET_THRESHOLD: number`, `ACQ_MODES: {FULL,FITS_NO_HULL,MARKET}`, `buildPool(hulls, items) -> Map<string, number>`, `fitModuleUnits(fit) -> { units: Map<string, number>, unevaluatable: boolean }`

- [ ] **Step 1: Write the failing tests**

Append to `tests/acquisitions-utils.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest tests/acquisitions-utils.test.js`
Expected: FAIL — `buildPool is not a function`

- [ ] **Step 3: Implement**

Add to `renderer/acquisitions-utils.js`, above the `module.exports` footer:

```js
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
 * fitItemsForReadiness, which only strips the hull when a display toggle is on.
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
```

Update the footer:

```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    mergeInventory, splitInventory, ACQ_HULL_CATEGORY_ID,
    ACQ_MARKET_THRESHOLD, ACQ_MODES, buildPool, fitModuleUnits,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest tests/acquisitions-utils.test.js`
Expected: PASS, all tests green

- [ ] **Step 5: Commit**

```bash
git log --oneline -1
git add renderer/acquisitions-utils.js tests/acquisitions-utils.test.js
git commit -m "acquisitions: pool and fit-unit builders for the build finder"
```

---

### Task 2: Single-build evaluation

**Files:**
- Modify: `renderer/acquisitions-utils.js`
- Test: `tests/acquisitions-utils.test.js`

**Interfaces:**
- Consumes: `ACQ_MODES`, `ACQ_MARKET_THRESHOLD` from Task 1
- Produces: `evaluateBuild({ pool, hullTypeId, units, mode, market, threshold }) -> { ok, hullPresent, coverage, missing }` where `missing` is `[{ type_id: string, qty: number }]` and `coverage` is a 0–1 number

- [ ] **Step 1: Write the failing tests**

Append to `tests/acquisitions-utils.test.js`:

```js
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
    // 8 of 10 units held = 0.8 exactly
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest tests/acquisitions-utils.test.js`
Expected: FAIL — `evaluateBuild is not a function`

- [ ] **Step 3: Implement**

Add to `renderer/acquisitions-utils.js`:

```js
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
    const buyable = missing.every((m) => {
      const entry = (market?.by_type || {})[m.type_id] || (market?.by_type || {})[Number(m.type_id)];
      return !!entry && (entry.total_volume || 0) >= m.qty;
    });
    ok = hullPresent && coverage >= threshold && buyable;
  }

  return { ok, hullPresent, coverage, missing };
}
```

Add `evaluateBuild` to the `module.exports` list.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest tests/acquisitions-utils.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git log --oneline -1
git add renderer/acquisitions-utils.js tests/acquisitions-utils.test.js
git commit -m "acquisitions: per-build evaluation for the three finder modes"
```

---

### Task 3: The consuming allocator

**Files:**
- Modify: `renderer/acquisitions-utils.js`
- Test: `tests/acquisitions-utils.test.js`

**Interfaces:**
- Consumes: `evaluateBuild`, `ACQ_MODES` from Tasks 1–2
- Produces: `planAcquisitions({ pool, targets, mode, market, threshold }) -> { builds, blocked }`.
  A `target` is `{ shipTypeId, shipName, fitName, needed, units, unevaluatable }`.
  A `builds` entry is `{ shipTypeId, shipName, fitName, missing, coverage }`.
  A `blocked` entry is `{ shipTypeId, shipName, fitName, reason }` where `reason` is `'unevaluatable'` or `'no-match'`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/acquisitions-utils.test.js`:

```js
const { planAcquisitions } = require('../renderer/acquisitions-utils');

const target = (over) => ({
  shipTypeId: 24698, shipName: 'Drake', fitName: 'Drake A', needed: 1,
  units: new Map([['2048', 1]]), unevaluatable: false, ...over,
});

describe('planAcquisitions — consumption', () => {
  test('a shared module is claimed by the first target only', () => {
    const pool = new Map([['24698', 1], ['24699', 1], ['2048', 1]]);
    const { builds, blocked } = planAcquisitions({
      pool, mode: ACQ_MODES.FULL,
      targets: [
        target({ shipName: 'Drake' }),
        target({ shipTypeId: 24699, shipName: 'Moa' }),
      ],
    });
    expect(builds).toHaveLength(1);
    expect(builds[0].shipName).toBe('Drake');
    expect(blocked[0].shipName).toBe('Moa');
  });

  test('does not mutate the caller\'s pool', () => {
    const pool = new Map([['24698', 1], ['2048', 1]]);
    planAcquisitions({ pool, mode: ACQ_MODES.FULL, targets: [target()] });
    expect(pool.get('2048')).toBe(1);
  });

  test('builds up to the shortfall and no further', () => {
    const pool = new Map([['24698', 3], ['2048', 3]]);
    const { builds } = planAcquisitions({
      pool, mode: ACQ_MODES.FULL, targets: [target({ needed: 1 })],
    });
    expect(builds).toHaveLength(1);
  });

  test('builds several units when the shortfall allows', () => {
    const pool = new Map([['24698', 3], ['2048', 3]]);
    const { builds } = planAcquisitions({
      pool, mode: ACQ_MODES.FULL, targets: [target({ needed: 3 })],
    });
    expect(builds).toHaveLength(3);
  });

  test('skips a target whose shortfall is zero, leaving its parts for others', () => {
    const pool = new Map([['24698', 1], ['24699', 1], ['2048', 1]]);
    const { builds } = planAcquisitions({
      pool, mode: ACQ_MODES.FULL,
      targets: [
        target({ shipName: 'Stocked', needed: 0 }),
        target({ shipTypeId: 24699, shipName: 'Gapped' }),
      ],
    });
    expect(builds).toHaveLength(1);
    expect(builds[0].shipName).toBe('Gapped');
  });

  test('reports an unevaluatable fit without consuming anything', () => {
    const pool = new Map([['24698', 1], ['2048', 1]]);
    const { builds, blocked } = planAcquisitions({
      pool, mode: ACQ_MODES.FULL,
      targets: [target({ unevaluatable: true }), target({ shipName: 'Next' })],
    });
    expect(blocked[0].reason).toBe('unevaluatable');
    expect(builds).toHaveLength(1);
    expect(builds[0].shipName).toBe('Next');
  });
});

describe('planAcquisitions — fitsNoHull hull accounting', () => {
  test('1 hull, modules for 3, shortfall 3 yields 2 hull-less results', () => {
    const pool = new Map([['24698', 1], ['2048', 3]]);
    const { builds } = planAcquisitions({
      pool, mode: ACQ_MODES.FITS_NO_HULL, targets: [target({ needed: 3 })],
    });
    expect(builds).toHaveLength(2);
  });

  test('enough hulls for every unit yields no hull-less results', () => {
    const pool = new Map([['24698', 3], ['2048', 3]]);
    const { builds } = planAcquisitions({
      pool, mode: ACQ_MODES.FITS_NO_HULL, targets: [target({ needed: 3 })],
    });
    expect(builds).toHaveLength(0);
  });
});

describe('planAcquisitions — edges', () => {
  test('empty targets return empty results', () => {
    expect(planAcquisitions({ pool: new Map(), mode: ACQ_MODES.FULL, targets: [] }))
      .toEqual({ builds: [], blocked: [] });
  });

  test('empty inventory blocks rather than throws', () => {
    const { builds, blocked } = planAcquisitions({
      pool: new Map(), mode: ACQ_MODES.FULL, targets: [target()],
    });
    expect(builds).toEqual([]);
    expect(blocked).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest tests/acquisitions-utils.test.js`
Expected: FAIL — `planAcquisitions is not a function`

- [ ] **Step 3: Implement**

Add to `renderer/acquisitions-utils.js`:

```js
/**
 * Walk targets in priority order, building what the remaining pool allows.
 *
 * Works on a copy of the pool, so a caller can run each mode from the same
 * starting inventory. In FITS_NO_HULL a hull that IS available is consumed
 * along with its modules: that unit is a complete build, not a hull-less one,
 * and its modules must not be offered again as a spare set.
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
```

Add `planAcquisitions` to `module.exports`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest tests/acquisitions-utils.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git log --oneline -1
git add renderer/acquisitions-utils.js tests/acquisitions-utils.test.js
git commit -m "acquisitions: consuming allocator in quota priority order"
```

---

### Task 4: Target assembly from quotas and fits

**Files:**
- Modify: `renderer/acquisitions-utils.js`
- Test: `tests/acquisitions-utils.test.js`

**Interfaces:**
- Consumes: `fitModuleUnits` from Task 1
- Produces: `buildTargets(quotas, fitsById) -> target[]` in the order given, each `{ shipTypeId, shipName, fitName, needed, units, unevaluatable }`

- [ ] **Step 1: Write the failing tests**

Append to `tests/acquisitions-utils.test.js`:

```js
const { buildTargets } = require('../renderer/acquisitions-utils');

const fitA = { id: 'a', name: 'Drake A', hullName: 'Drake', hullTypeId: 24698,
  items: [{ name: 'DCII', qty: 1, typeId: 2048 }] };
const fitB = { id: 'b', name: 'Drake B', hullName: 'Drake', hullTypeId: 24698,
  items: [{ name: 'Invuln', qty: 2, typeId: 2281 }] };

describe('buildTargets', () => {
  test('prefers the fit whose name matches the quota', () => {
    const [t] = buildTargets(
      [{ ship_type_id: 24698, name: 'Drake B', missing: 2 }], { a: fitA, b: fitB },
    );
    expect(t.fitName).toBe('Drake B');
    expect(t.units.get('2281')).toBe(2);
  });

  test('falls back to the first fit for the hull when no name matches', () => {
    const [t] = buildTargets(
      [{ ship_type_id: 24698, name: 'Nonexistent', missing: 1 }], { a: fitA, b: fitB },
    );
    expect(t.fitName).toBe('Drake A');
  });

  test('carries the quota shortfall through as `needed`', () => {
    const [t] = buildTargets([{ ship_type_id: 24698, name: 'Drake A', missing: 3 }], { a: fitA });
    expect(t.needed).toBe(3);
  });

  test('treats a missing shortfall as zero', () => {
    const [t] = buildTargets([{ ship_type_id: 24698, name: 'Drake A' }], { a: fitA });
    expect(t.needed).toBe(0);
  });

  test('marks a quota with no fit at all as unevaluatable', () => {
    const [t] = buildTargets([{ ship_type_id: 99999, name: 'Ghost', missing: 1 }], { a: fitA });
    expect(t.unevaluatable).toBe(true);
  });

  test('propagates an unresolved typeId from the chosen fit', () => {
    const broken = { id: 'c', name: 'Broken', hullTypeId: 24698,
      items: [{ name: '?', qty: 1, typeId: null }] };
    const [t] = buildTargets([{ ship_type_id: 24698, name: 'Broken', missing: 1 }], { c: broken });
    expect(t.unevaluatable).toBe(true);
  });

  test('preserves quota order', () => {
    const targets = buildTargets([
      { ship_type_id: 24698, name: 'Drake B', missing: 1 },
      { ship_type_id: 24698, name: 'Drake A', missing: 1 },
    ], { a: fitA, b: fitB });
    expect(targets.map((t) => t.fitName)).toEqual(['Drake B', 'Drake A']);
  });

  test('handles empty inputs', () => {
    expect(buildTargets([], {})).toEqual([]);
    expect(buildTargets(null, null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest tests/acquisitions-utils.test.js`
Expected: FAIL — `buildTargets is not a function`

- [ ] **Step 3: Implement**

Add to `renderer/acquisitions-utils.js`:

```js
/**
 * Turn the contracts scan's quota rows into allocator targets, in quota order.
 *
 * Fit selection matches the existing convention in app.js: prefer a fit whose
 * name equals the quota's, else the first fit registered for that hull.
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
```

Add `buildTargets` to `module.exports`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest tests/acquisitions-utils.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git log --oneline -1
git add renderer/acquisitions-utils.js tests/acquisitions-utils.test.js
git commit -m "acquisitions: assemble allocator targets from quotas and fits"
```

---

### Task 5: Buttons 1 and 2 in the UI

**Files:**
- Modify: `renderer/app.js` (acquisitions region only, ~4307–4370)

**Interfaces:**
- Consumes: `buildPool`, `buildTargets`, `planAcquisitions`, `ACQ_MODES` (globals from `acquisitions-utils.js`, loaded before `app.js` by `renderer/index.html`)
- Produces: `acqRunFinder(mode, resultsEl, statusEl)`, `renderAcqFinderResults(el, result, mode)`

- [ ] **Step 1: Add the button row and results container**

In `renderAcquisitionsTab()`, immediately after the existing button row `</div>` (the one holding `#acq-add`, `#acq-replace`, `#acq-clear`), insert:

```html
    <div style="display:flex;gap:0.5rem;margin-top:0.4rem;align-items:center;flex-wrap:wrap">
      <button id="acq-find-full" class="btn" title="Quota ships this inventory can build outright">Find full hull + fits</button>
      <button id="acq-find-nohull" class="btn" title="Every module present, hull missing">Find fits without hulls</button>
      <button id="acq-find-market" class="btn" title="80%+ complete, remainder buyable at UEXO">Find market-completable</button>
      <span id="acq-find-status" style="font-size:0.8rem;color:#8899aa;margin-left:0.5rem"></span>
    </div>
    <div id="acq-find-results" style="margin-top:0.75rem"></div>
```

- [ ] **Step 2: Write the runner and renderer**

Add above `renderAcquisitionsTab()`:

```js
// Build-finder buttons. All matching maths lives in acquisitions-utils.js; this
// only gathers inputs and renders. Requires a contracts scan (for quota gaps)
// and a readiness scan (for fits) — both are reported plainly when absent.
function acqFinderInputs() {
  const quotas = lastContractsScan?.quotas || null;
  const fits = readinessState.scan?.fits || null;
  if (!quotas) return { error: 'Run a Contracts scan to get quota gaps.' };
  if (!fits) return { error: 'Run a Readiness scan to load fits.' };
  return {
    pool: buildPool(acquisitionsHulls, acquisitionsItems),
    targets: buildTargets(quotas, fits),
  };
}

function renderAcqFinderResults(el, result, mode) {
  const { builds, blocked } = result;
  if (!builds.length && !blocked.length) {
    el.innerHTML = '<p class="muted">No quota gaps to evaluate.</p>';
    return;
  }
  const counts = {};
  for (const b of builds) {
    const key = `${b.shipName}||${b.fitName || ''}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  const rows = Object.entries(counts).map(([key, n]) => {
    const [ship, fit] = key.split('||');
    return `<tr><td>${escapeHtml(ship)}</td><td class="muted">${escapeHtml(fit)}</td><td class="right">${n}</td></tr>`;
  }).join('');
  const unevaluatable = blocked.filter((b) => b.reason === 'unevaluatable');
  const note = unevaluatable.length
    ? `<p class="muted">${unevaluatable.length} fit(s) could not be evaluated — unresolved module type in Auth.</p>`
    : '';
  el.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Ship</th><th>Fit</th><th class="right">Count</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="3" class="muted">Nothing matched.</td></tr>'}</tbody>
    </table>${note}`;
}

function acqRunFinder(mode, resultsEl, statusEl) {
  const inputs = acqFinderInputs();
  if (inputs.error) {
    statusEl.textContent = inputs.error;
    resultsEl.innerHTML = '';
    return;
  }
  const result = planAcquisitions({ pool: inputs.pool, targets: inputs.targets, mode });
  statusEl.textContent = `${result.builds.length} build(s) found.`;
  renderAcqFinderResults(resultsEl, result, mode);
}
```

- [ ] **Step 3: Wire the two buttons**

In `renderAcquisitionsTab()`, beside the existing `addBtn` / `replaceBtn` wiring:

```js
  const findStatusEl = root.querySelector('#acq-find-status');
  const findResultsEl = root.querySelector('#acq-find-results');
  root.querySelector('#acq-find-full').addEventListener('click',
    () => acqRunFinder(ACQ_MODES.FULL, findResultsEl, findStatusEl));
  root.querySelector('#acq-find-nohull').addEventListener('click',
    () => acqRunFinder(ACQ_MODES.FITS_NO_HULL, findResultsEl, findStatusEl));
```

- [ ] **Step 4: Verify syntax and regressions**

Run: `node --check renderer/app.js`
Expected: no output

Run: `npx jest`
Expected: PASS, all suites

- [ ] **Step 5: Commit**

```bash
git log --oneline -1
git add renderer/app.js
git commit -m "acquisitions: wire the full-build and hull-less finder buttons"
```

---

### Task 6: Button 3 — market completion and multibuy

**Files:**
- Modify: `renderer/app.js` (acquisitions region only)

**Interfaces:**
- Consumes: `acqFinderInputs`, `renderAcqFinderResults` from Task 5; `loadMarket(refresh)` and `aaState.market` (`app.js:1476`, `:1417`)
- Produces: `acqRunMarketFinder(resultsEl, statusEl)`

- [ ] **Step 1: Write the market runner**

Add below `acqRunFinder`:

```js
// Mode 3 needs the UEXO order book. loadMarket() honours the server's 5-minute
// TTL, so repeat clicks are instant and a stale book is re-fetched.
async function acqRunMarketFinder(resultsEl, statusEl) {
  const inputs = acqFinderInputs();
  if (inputs.error) {
    statusEl.textContent = inputs.error;
    resultsEl.innerHTML = '';
    return;
  }
  statusEl.textContent = 'Loading UEXO market…';
  try {
    if (!aaState.market) await loadMarket(false);
  } catch (e) {
    statusEl.textContent = `Market fetch failed: ${e.message || e}`;
    return;
  }
  const market = aaState.market;
  if (!market?.by_type) {
    statusEl.textContent = 'Market unavailable — no order book loaded.';
    return;
  }
  const result = planAcquisitions({
    pool: inputs.pool, targets: inputs.targets, mode: ACQ_MODES.MARKET, market,
  });
  const age = Math.round((Date.now() / 1000 - (market.fetched_at || 0)) / 60);
  statusEl.textContent =
    `${result.builds.length} build(s) completable — UEXO book ${age}m old, ${market.order_count} orders.`;
  renderAcqFinderResults(resultsEl, result, ACQ_MODES.MARKET);
  renderAcqShoppingList(resultsEl, result, market);
}
```

- [ ] **Step 2: Write the shopping list and multibuy**

```js
// The shopping list is what makes mode 3 actionable: everything the builds are
// short of, summed across builds, with UEXO's cheapest asking price.
function renderAcqShoppingList(el, result, market) {
  const need = new Map();
  for (const b of result.builds) {
    for (const m of b.missing) need.set(m.type_id, (need.get(m.type_id) || 0) + m.qty);
  }
  if (!need.size) return;
  let total = 0;
  const lines = [];
  const rows = [...need.entries()].map(([tid, qty]) => {
    const entry = market.by_type[tid] || market.by_type[Number(tid)] || {};
    const price = entry.min_price || 0;
    const name = acqTypeName(tid);
    total += price * qty;
    lines.push(`${name} x${qty}`);
    return `<tr><td>${escapeHtml(name)}</td><td class="right">${qty}</td>` +
           `<td class="right">${price.toLocaleString()}</td>` +
           `<td class="right">${(price * qty).toLocaleString()}</td></tr>`;
  }).join('');
  const div = document.createElement('div');
  div.style.marginTop = '0.75rem';
  div.innerHTML = `
    <h4>Shopping list (UEXO)</h4>
    <table class="data-table">
      <thead><tr><th>Module</th><th class="right">Qty</th><th class="right">Min price</th><th class="right">Total</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td colspan="3" class="right"><strong>Total</strong></td>
        <td class="right"><strong>${total.toLocaleString()} ISK</strong></td></tr></tfoot>
    </table>
    <button id="acq-copy-buy" class="link-btn">Copy multibuy</button>`;
  el.appendChild(div);
  div.querySelector('#acq-copy-buy').addEventListener('click', () => {
    navigator.clipboard.writeText(lines.join('\n'));
    div.querySelector('#acq-copy-buy').textContent = 'Copied';
  });
}

// Names come from whatever the page already resolved; type id is the fallback.
function acqTypeName(typeId) {
  const key = String(typeId);
  const row = [...acquisitionsHulls, ...acquisitionsItems]
    .find((r) => String(r.type_id) === key);
  return row?.name || `type ${key}`;
}
```

- [ ] **Step 3: Wire the third button**

```js
  root.querySelector('#acq-find-market').addEventListener('click',
    () => acqRunMarketFinder(findResultsEl, findStatusEl));
```

- [ ] **Step 4: Verify syntax and regressions**

Run: `node --check renderer/app.js`
Expected: no output

Run: `npx jest`
Expected: PASS

Run: `python -m pytest python/tests/ -q`
Expected: PASS (regression only — no Python changed)

- [ ] **Step 5: Commit**

```bash
git log --oneline -1
git add renderer/app.js
git commit -m "acquisitions: market-completable finder with UEXO shopping list"
```

---

## Self-review

**Spec coverage:** All three buttons (Tasks 5–6), consuming allocation in priority order (Task 3), shortfall capping (Tasks 3–4), qty-weighted 80% coverage (Task 2), market volume check (Task 2), constant threshold (Task 1), fit selection convention (Task 4), unconditional hull stripping (Task 1), un-evaluatable fits (Tasks 1, 3, 4), missing-scan states (Task 5), `fetched_at` display and shopping list with multibuy (Task 6), test list (Tasks 1–4).

**Deviation from the spec, deliberate:** the spec said to strip the hull "using the same filter as `fitItemsForReadiness`". That function only strips when `readinessState.toggles.excludeHulls` is set, so reusing it would let a display toggle change build results. Task 1 strips unconditionally instead. The spec's intent is preserved; its reference was wrong.

**Naming consistency:** `ACQ_MODES.FULL / FITS_NO_HULL / MARKET`, `buildPool`, `fitModuleUnits`, `evaluateBuild`, `planAcquisitions`, `buildTargets` are used identically in every task. Pool keys are always `String(type_id)`.
