# Acquisitions — build finder buttons

**Date:** 2026-07-24
**Status:** approved, ready for implementation plan

## Problem

The Acquisitions tab can parse a pile of loot into hulls and modules, but it
cannot answer the question that pile actually raises: *what does this let us
deliver against quota?* Working it out by hand means cross-referencing the
inventory against every doctrine fit and the current quota gaps.

## Goal

A second row of three buttons on the Acquisitions tab, each answering one
question about the parsed inventory:

1. **Find full hull + fits** — quota ships that can be built complete, hull and
   all modules, from inventory alone.
2. **Find fits without hulls** — every module for a quota ship is in inventory
   but the hull is missing.
3. **Find market-completable** — the hull is in inventory, at least 80% of the
   fit's required units are too, and every remaining unit can be bought on the
   UEXO market.

## Non-goals

- Adjustable threshold. 80% is a module constant (`ACQ_MARKET_THRESHOLD`).
- Buying anything, or reserving market orders.
- Changing how the inventory is parsed, stored, or displayed.
- Cross-button allocation. Each button allocates from a full pool.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Shared modules | Allocate and consume, in quota priority order | Answers "what can I actually build", never promises the same module twice |
| Quota target | Cap at the Contracts scan's shortfall | Spends the pile on gaps, not on ships already stocked |
| 80% metric | Required **units** covered (qty-weighted) | Matches the Readiness tab's slot counting; needs no prices |
| Market data | The market endpoint's own 5-min TTL | No new caching; `fetched_at` shown so staleness is visible |
| Threshold | Constant, not user-facing | YAGNI until there's evidence 80% is wrong |

## Architecture

### Engine — `renderer/acquisitions-utils.js`

All logic goes in the existing pure-utils module, which already has a Jest
suite. `app.js` only gathers inputs and renders results.

```js
planAcquisitions({ pool, targets, mode, market, threshold })
```

- `pool` — `Map<type_id, qty>` built from the page's hulls + items
- `targets` — quota rows in Contracts-page order, each with `shipTypeId`,
  `fitName`, `needed` (the shortfall), and the fit's item rows
- `market` — the `by_type` snapshot; only read in `marketCompletable`

The engine walks `targets` in priority order and, for each unit of shortfall,
tests one build against the **remaining** pool, deducting on acceptance. Only
the acceptance rule varies by mode:

| Mode | Accepts when | Consumes |
|---|---|---|
| `full` | hull in pool **and** every fit unit in pool | hull + modules |
| `fitsNoHull` | every fit unit in pool **and** hull absent from pool | modules |
| `marketCompletable` | hull in pool, coverage ≥ threshold, **and** every missing unit has `by_type[tid].total_volume >= qty` | hull + covered modules |

Coverage is `units_in_pool / units_required`, counting quantities: a fit needing
8x of a module counts 8.

Two rules that the mode table alone leaves ambiguous:

- **Hulls are counted and consumed in `fitsNoHull` too.** With 1 hull in
  inventory, modules for 3, and a shortfall of 3, the first unit finds a hull
  and is therefore not a hull-less case; the remaining 2 are. The mode reports
  2 results, not 0 (hull present) and not 3 (hull ignored). Without this the
  answer flips entirely on whether a single hull happens to be in the pile.
- **Targets with a shortfall of 0 or less are skipped** before any pool work,
  so a fully-stocked ship never consumes modules a gapped ship needs.

Consumption is scoped to a single button's run. Each click starts from a full
pool, so results from different buttons overlap by design — they are three
independent questions, not one plan.

### Two rules taken from existing code, not invented

- **Fit selection** for a quota row is
  `candidates.find(f => f.name === q.name) || candidates[0]`, matching
  `renderer/app.js:4814`.
- **The hull is stripped from a fit's item rows** using the same
  `typeId !== fit.hullTypeId` filter as `fitItemsForReadiness`
  (`renderer/app.js:1889-1890`). Without it every fit would demand a second
  hull and no build would ever match.

### Inputs and their owners

| Input | Source |
|---|---|
| Inventory | `acquisitionsHulls` + `acquisitionsItems` on the page |
| Quota shortfall | The Contracts scan payload's per-quota `missing` |
| Fits | `readinessState.scan.fits` (scraped from Alliance Auth) |
| UEXO market | The structure-market endpoint's `by_type` |

The inventory, quotas and market all exist server-side, but fits do not — they
are scraped in the renderer. That asymmetry is why the engine lives client-side
rather than behind a Python endpoint: a server implementation would have to
receive the entire fit set on every click.

## Dependencies and failure states

The buttons depend on two scans that live outside this tab, so they state that
plainly instead of guessing:

- **No recent Contracts scan** → no shortfall figures → buttons disabled with
  "Run a Contracts scan to get quota gaps."
- **No Readiness scan** → no fits → disabled with "Run a Readiness scan to load
  fits."
- **Fit rows with `typeId == null`** — Auth rows that never resolved to a type.
  The fit is reported as un-evaluatable rather than passing a check that
  silently ignored an unknown module.
- **Market fetch failure** — affects button 3 only; an error line is shown and
  the other two buttons keep working.

## Output

A results panel below the existing hull/module tables: one row per build, with
ship name, fit name, and status. `marketCompletable` rows also carry the
shopping list — module, qty, UEXO `min_price`, line total — a total ISK figure,
and the snapshot's `fetched_at`.

Mode 3 results get a copy-to-clipboard multibuy for the shopping list, matching
the HaulX "Shopping cart" control, since a buy list that cannot be pasted into
EVE is half a feature.

## Coordination risk

`renderer/app.js` is being edited concurrently in another session for the HaulX
retry button. Keeping the logic in `acquisitions-utils.js` confines this
feature's `app.js` changes to the acquisitions render function near line 4300,
well clear of the HaulX code at 4440–4850. Implementation should re-check
`git log` before committing.

## Testing

`tests/acquisitions-utils.test.js`, against the pure engine — no DOM, no app
launch, per the project's established practice:

- contention: two ships needing one shared module — the first takes it, the
  second reports it missing
- shortfall capping: inventory could build 3, shortfall is 1, only 1 is built
- threshold boundary: exactly 80% passes, just under fails
- market volume present but insufficient (`total_volume` < needed) → rejected
- `full` rejects when the hull is absent; `fitsNoHull` rejects when it is present
- `fitsNoHull` hull accounting: 1 hull, modules for 3, shortfall 3 → 2 results
- a target whose shortfall is 0 is skipped and consumes nothing
- unresolved `typeId` marks the fit un-evaluatable
- empty inventory and empty quota list return empty results, not errors

Verification beyond Jest: `node --check renderer/app.js`, and
`python -m pytest python/tests/` as a regression check — no Python file changes.
The app is not launched to verify this.
