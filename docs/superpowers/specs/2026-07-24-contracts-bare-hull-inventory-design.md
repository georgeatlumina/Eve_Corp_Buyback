# Contracts & quotas — bare-hull inventory visibility

**Date:** 2026-07-24
**Status:** approved, ready for implementation plan

## Problem

The Contracts & quotas dashboard shows contract price and 30-day sales when a
ship row is expanded, but nothing about hulls already sitting in the
Acquisitions Inventory. A ship can look fully unmet by contracts while bare
hulls for it are already on hand — invisible without switching tabs and
cross-referencing by eye. The "Copy shopping list" export compounds this: it
prints the full quota gap with no awareness of inventory, so a shopping list
can tell you to go get hulls you already have.

## Goal

1. Expanding a quota row shows how many bare hulls of that ship are in the
   Acquisitions Inventory.
2. "Copy shopping list" subtracts that count from each line before printing,
   so it never asks you to source what you're already holding.
3. The Contracts intro paragraph and the button's tooltip say plainly that
   this is happening.

## Non-goals

- No live refresh of the expand-panel count (see Decisions).
- No interaction with the Acquisitions build-finder's allocation/consumption
  logic (`docs/superpowers/specs/2026-07-24-acquisitions-build-finder-design.md`).
  This is a raw inventory count, independent of what a build-finder run would
  allocate to a given ship.
- No per-line annotation in the copied text showing how much was subtracted.
- No change to how Acquisitions inventory is parsed, stored, or displayed.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Expand-panel count freshness | Snapshot, baked in at dashboard render | Matches every other number on the bar (`available`/`missing`) — the whole dashboard is already "as of last scan"; simpler mental model than a mixed-freshness row |
| Shopping-list subtraction freshness | Live, read at click time | The button's purpose is "what do I still need to buy right now" — reading current inventory rather than a stale render gives the truer answer, at no extra cost since the read is already synchronous |
| Match key | `type_id`, `String()`-normalized | Same key used throughout the app (build finder, acquisitions parsing) |
| Zero-covered lines | Omitted entirely from the shopping list | A ship fully covered by inventory has nothing left to buy; printing "0 x Ferox" is noise |
| Per-line detail in copied text | None — plain reduced number only | The text is pasted elsewhere (multibuy, Discord); the explanation belongs in UI chrome, not in output meant to be machine/human pasted verbatim |

## Design

### 1. Expand-panel row

`renderContractsDashboard` (`app.js:3610`) builds one
`Map<String(type_id), quantity>` from `acquisitionsHulls` — the same global
array the Acquisitions tab populates, loaded once at app startup
(`acquisitionsLoad()`, `app.js:4589`) independent of which tab is active. Built
once per dashboard render, which happens on Scan and on alliance-toggle switch
(`app.js:3369-3371`) — this is what makes it a snapshot rather than live.

`renderQuotaBar` (`app.js:3725`) gains a third row in the existing expand panel
(`app.js:3748`), alongside "Contract price" and "Sold last 30 days":

```
Bare hulls in Acquisitions        3
```

Synchronous, no loading state — unlike price/sold-30d this needs no network
call. Defaults to `0` when the ship's `type_id` has no matching entry.

### 2. Shared lookup helper

A single function, `acqHullCountFor(typeId)`, defined in `renderer/app.js`
immediately after the `acquisitionsHulls`/`acquisitionsItems` declarations
(`app.js:4163-4164`) so both its Acquisitions-tab-adjacent origin and its use
from the Contracts code are equally close to the source of truth. It reads
`acquisitionsHulls` directly and returns the matched quantity (`0` if absent).
Both the
expand-panel map-building step and the shopping-list subtraction call this, so
the type_id matching logic exists in exactly one place. It reads the *current*
`acquisitionsHulls` at call time; the expand panel achieves its snapshot
semantics not by caching a value inside the helper, but by calling it only
once, at render time, and holding the resulting map in the closed-over
dashboard render — the shopping list calls it fresh on every click.

### 3. Shopping list subtraction

`copyShoppingList` (`app.js:4129`) changes its per-line construction from:

```js
const missing = Number(q.missing) || 0;
if (missing > 0) { lines.push(`${missing} x ${name}`); }
```

to subtracting the live inventory count before the threshold check:

```js
const missing = Number(q.missing) || 0;
const have = acqHullCountFor(q.ship_type_id);
const remaining = Math.max(0, missing - have);
if (remaining > 0) { lines.push(`${remaining} x ${name}`); }
```

The empty-list fallback text changes from *"No gaps — every quota is met."* to
*"No gaps — every quota is met or covered by Acquisitions inventory."*, since
an empty list can now mean either.

### 4. Text updates

- Contracts intro paragraph (`renderer/index.html:434`) gains one sentence:
  *"Expanding a ship also shows how many bare hulls of that type are currently
  in the Acquisitions Inventory, as of your last scan."*
- The Contracts tab's "Copy shopping list" button, `#btn-contracts-export-text`
  (`renderer/index.html:451`), gains a `title` tooltip, matching the existing
  pattern used on "Replace inventory" (`renderer/app.js:4523`): *"Quantities
  are reduced by bare hulls already in your Acquisitions inventory."*

  **Disambiguation:** two other buttons share the label "Copy shopping list"
  — `#btn-doctrine-stock-export-text` (Readiness tab, wired in
  `doctrine-stock.js`) and `#btn-indy-fulfil-export-text` (Indy tab, wired in
  `indy.js`). Both are separate features with their own handlers, unrelated to
  `copyShoppingList` in `app.js`. Only `#btn-contracts-export-text` changes.

## Testing

The subtraction arithmetic (`Math.max(0, missing - have)`, zero-line omission)
is simple enough that it doesn't warrant extracting into
`acquisitions-utils.js` purely for testability — it has no shared logic with
the pure build-finder engine, and pulling one three-line calculation into a
different file for a unit test would cost more clarity than it buys. Verified
by `node --check renderer/app.js` and manual confirmation of the arithmetic in
review, consistent with how `acqRunFinder`'s own wiring (not just its engine)
was verified in the build-finder work.

No Python files change. `python -m pytest python/tests/` run as a regression
check only.
