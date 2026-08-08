# Hull Completion Analysis — Design Spec

**Date:** 2026-08-08  
**Status:** Approved

---

## Context

The Acquisitions tab currently has three buttons for analysing how the acquisitions inventory can be turned into fitted ships:

- **Find full hulls + fits** — inventory-completable builds only
- **Find market-completable** — inventory + UEXO market builds
- **Find fits without hulls** — modules present but no hull

This feature replaces the first two with a single **Analyse Hulls** button that delivers progressive results across all tiers, and renames the third to **Analyse Fits** (same logic, better name, designed to be expanded later).

Future iterations will add per-ship market comparison (UEXO vs Jita) and selective shopping cart building. This spec covers the first iteration only.

---

## Behaviour

### Trigger

A single **Analyse Hulls** button. On click:

1. **Immediately** runs the inventory-only pass and renders Section 1.
2. **Concurrently** fetches UEXO market data (respecting the 5-minute server-side cache). When it arrives, renders Section 2 and Section 3 (shopping list candidates).
3. **Throughout**, a progress indicator is shown while market data is loading.

The **Analyse Fits** button replaces "Find fits without hulls" with identical logic. No functional change in this iteration — label only, structured for future expansion.

---

## Results Layout (four sections, progressive)

### Section 1 — Completable from inventory (green)
Appears immediately. Shows builds where the hull is in the pool AND all modules are covered by acquisitions stock alone. Rendered as a ship / fit / qty table. Pool is mutated as builds are committed (no double-counting).

### Section 2 — Completable with UEXO market (blue)
Appears after market data loads. Shows builds where inventory covers ≥ `ACQ_MARKET_THRESHOLD` (existing 80% constant) of modules AND the remaining gap is fully available on the UEXO sell-side market. Includes market age indicator ("market Xm old").

### Section 3 — Shopping list candidates (amber)
Appears alongside Section 2. Shows hulls that:
- Pass **both** configured thresholds (coverage % AND max ISK gap — see Config below)
- Are not already completable from inventory or inventory + market

For each candidate:
- Hull name, fit name, coverage %, estimated gap ISK
- Table of missing items: item name, need, have, short, UEXO min price
- Two copy buttons:
  - **Copy gap (inventory only)** — all missing modules in Janice multibuy format (`Name xQty`)
  - **Copy gap (inventory + market)** — only items not available on UEXO

### Section 4 — Out of reach (collapsed, gray)
A `<details>` element, collapsed by default. Lists hulls that failed either threshold, with a one-line reason per hull (e.g. "34% covered — below coverage threshold", "gap 1.2b ISK — exceeds ISK limit").

---

## Configuration (Settings/Config tab)

Two new fields added to the existing config form, under a new **"Acquisitions analysis"** fieldset:

| Field | Key | Type | Default | Description |
|---|---|---|---|---|
| Min inventory coverage (0–1) | `acq_shopping_min_coverage` | float | 0.5 | Hull must have at least this fraction of modules in acquisitions stock to generate a shopping list |
| Max ISK gap | `acq_shopping_max_isk_gap` | float | 500000000 | Hull's missing modules (priced at UEXO min) must total less than this to generate a shopping list |

Both fields validated as numbers. Defaults chosen conservatively (50% coverage, 500m ISK cap).

**Backend:** `python/config.py` — add to `DEFAULTS` and `SCHEMA`. Existing `load_config` / `save_config` handles persistence automatically.

**Frontend:** Read from config at analysis time (already loaded into `appConfig` on startup).

---

## Data Flow

```
acquisitionsHulls + acquisitionsItems
  → buildPool()
  → pool: Map<type_id, qty>

lastContractsScan.quotas + readinessState.scan.fits
  → buildTargets()
  → targets: [{shipTypeId, shipName, fitName, needed, units: Map<typeId,qty>}]

planAcquisitions({pool, targets, mode:'full'})
  → Section 1 results (immediate)

loadMarket() [concurrent, cached 5min]
  → aaState.market.by_type: {type_id: {min_price, total_volume}}
  → planAcquisitions({pool, targets, mode:'marketCompletable', market})
  → Section 2 results

For remaining hulls:
  coverage = held_units / total_units
  gap_isk = sum(short_qty × market.by_type[id].min_price) for missing items
  if coverage >= config.acq_shopping_min_coverage AND gap_isk <= config.acq_shopping_max_isk_gap:
    → Section 3 (shopping list candidate)
  else:
    → Section 4 (out of reach, with reason)
```

**Reused functions:** `buildPool`, `buildTargets`, `planAcquisitions`, `evaluateBuild`, `renderAcqShoppingList`, `loadMarket`, `acqFinderInputs` — all in `renderer/acquisitions-utils.js` and `renderer/app.js`.

---

## Shopping List Format

Janice multibuy format — one line per item:
```
Magnetometric Sensor Cluster x3
Covert Reconfiguration x1
```

Gap A (inventory only) — all items where `short > 0` regardless of market availability.  
Gap B (inventory + market) — only items where `short > 0` AND `market.by_type[id].total_volume < short` (not fully available on UEXO).

---

## Files Changed

| File | Change |
|---|---|
| `python/config.py` | Add `acq_shopping_min_coverage` and `acq_shopping_max_isk_gap` to `DEFAULTS` + `SCHEMA` |
| `renderer/index.html` | Replace the three old buttons with `Analyse Hulls` + `Analyse Fits`; add the new results sections structure |
| `renderer/app.js` | New `acqRunHullAnalysis()` function (progressive, replaces `acqRunFinder(FULL)` + `acqRunMarketFinder`); rename `acqRunFinder(FITS_NO_HULL)` trigger to "Analyse Fits" |
| `renderer/acquisitions-utils.js` | Add `computeShoppingGap(targets, pool, market, config)` helper; minor refactor to `evaluateBuild` to expose per-item coverage data needed for Section 3 |
| `renderer/styles.css` | Section colour tokens for the four result bands (green/blue/amber/gray) if not already present |

---

## Out of Scope (this iteration)

- Per-ship market comparison (UEXO vs Jita)
- Selective shopping cart (choose which hulls to include)
- Expanding "Analyse Fits" beyond its current single-mode logic
- Quantity > 1 per hull (currently `needed` drives count; no change)
