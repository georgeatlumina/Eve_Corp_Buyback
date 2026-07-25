# HaulX — retry button for volume & price lookups

**Date:** 2026-07-24
**Status:** approved, ready for implementation

## Problem

The HaulX tab looks up a Jita sell price, a packaged volume, and a Jita buy price
for every hull and every item in its fit. When one of those lookups fails, the
failure is permanent for the session:

- `haulxFetchPrices` caches the failure — `.catch()` writes
  `{ min_sell: null, vol: null }` into `haulxItemPriceCache`, and `null` into
  `haulxItemBuyCache` (`renderer/app.js:4500`, `:4511`).
- The next run only fetches ids that are *not already in* those caches
  (`renderer/app.js:4467-4468`), so the failed id is skipped forever.

A row missing a full fit volume or price is flagged and locked to 0 by
`haulxBlockReason` / `haulxSetRowBlocked`. So a single transient ESI blip takes a
ship out of every haul plan until the app is restarted. Re-opening the tab does
not help.

There is a second, quieter case. `packaged_volume` is looked up server-side in
its own `try/except` that swallows the error and returns `None` while the request
still succeeds with HTTP 200 (`python/server.py:1838-1842`). A volume failure
therefore arrives looking exactly like a successful response, is cached as a
settled value, and blocks the row with `(no volume)` — permanently.

## Goal

One button that re-runs only the lookups that actually errored, so a blip costs a
click instead of a restart.

## Non-goals

- Refreshing prices that succeeded. The server already caches successes for five
  minutes and exposes `?bust=1`; a "prices are stale" refresh is a separate
  feature and is not built here.
- Per-row retry controls.
- Any change to how a blocked row is displayed or to the planning maths.

## Design

### 1. Track failures separately from settled nulls

Two module-level sets in `renderer/app.js`, beside the existing caches:

```js
const haulxFailedPrice = new Set();  // tids whose sell/volume lookup errored
const haulxFailedBuy = new Set();    // tids whose buy lookup errored
```

Sets rather than a `failed` flag on the cache entries: `haulxItemBuyCache` stays
a bare `tid -> max_buy | null`, so none of the fit-total arithmetic at
`renderer/app.js:4534-4556` has to change. A flag on the entry would force an
edit at every read site.

Membership is authoritative only after the lookup settles. A tid is added on
failure and removed on success, so a retry that succeeds shrinks the set.

### 2. Classify each response

Both fetches gain an explicit `if (!r.ok) throw new Error(r.status)` so HTTP
errors reach the `catch` instead of falling through `r.json()`.

| Outcome | Verdict | Why |
| --- | --- | --- |
| network throw, or non-2xx (e.g. 502) | **failed** — retryable | Transient; the server does not cache failures, so a re-request re-hits ESI/Janice |
| 200 with `min_sell: null` | settled | The item genuinely has no Jita sell order. Retrying cannot change it |
| 200 with `packaged_volume: null` | **failed** — retryable | Every EVE type has a volume, so this only happens when `fetch_type_info` threw server-side (`python/server.py:1841`) |
| 422 on `jita-buy` | settled | No Janice API key configured (`python/server.py:1869`). A config problem, not a blip — retrying cannot fix it |

Without the 422 case, an install with no Janice key would fail every buy lookup
and the button would offer to retry hundreds of doomed requests forever.

A buy-price failure does not block a row — `haulxBlockReason` only consults
`fit_price` and `fit_volume` — but it does suppress the header Profit figure, so
it is worth retrying.

### 3. Retry evicts, then re-runs

```js
async function haulxRetryFailed(quotas) {
  for (const tid of haulxFailedPrice) {
    delete haulxItemPriceCache[tid];
    delete haulxPriceCache[tid];
  }
  for (const tid of haulxFailedBuy) delete haulxItemBuyCache[tid];
  haulxFailedPrice.clear();
  haulxFailedBuy.clear();
  await haulxFetchPrices(quotas);
}
```

Eviction is what makes the retry work at all: `haulxFetchPrices` skips any tid
already present in a cache, so clearing the entry is the only way to make it
fetch again.

`haulxPriceCache[tid]` must be evicted alongside `haulxItemPriceCache[tid]`.
`packaged_volume` is written there only when the entry is first created
(`renderer/app.js:4496-4498`); leaving a stale entry in place would keep the bad
volume even after a successful refetch.

Re-running the whole of `haulxFetchPrices` (rather than a narrower path) reuses
its existing progress bar, per-row updates, block/unblock pass, totals update and
"Fill by priority" gating unchanged.

`quotas` is the `orderedQuotas` list built in `renderHaulxTab`, the same list
passed to the initial `haulxFetchPrices` call at `renderer/app.js:4823`.

### 4. The button

Markup, in the sticky header immediately after `#haulx-fill-note`
(`renderer/app.js:4642`):

```html
<button id="haulx-retry" class="link-btn" hidden>↻ Retry</button>
```

A new `haulxUpdateRetryButton()`, called at the end of `haulxFetchPrices`:

- hidden when both failure sets are empty
- otherwise visible, labelled `↻ Retry N` where N is
  `haulxFailedPrice.size + haulxFailedBuy.size` — a count of failed *lookups*,
  not of types, so a tid whose sell and buy both failed contributes 2. This
  matches how the progress bar counts its total (`renderer/app.js:4473`)
- `title` breaks N down into volume/price failures and buy-price failures

While a retry is in flight the button is disabled and reads `Retrying…`; the
existing progress area already reports lookup counts.

The click handler is wired in `renderHaulxTab` alongside the other header
buttons, calling `haulxRetryFailed(orderedQuotas)`.

Because the button is hidden whenever every lookup settled cleanly, its presence
is itself the signal that something went wrong — no extra error banner is needed.

### 5. Tests

The classification rules in §2 are the only real logic, so they move into
`renderer/haulx-utils.js` as two pure functions and are unit-tested there:

```js
haulxClassifySell(ok, status, data)  // -> { minSell, vol, failed }
haulxClassifyBuy(ok, status, data)   // -> { maxBuy, failed }
```

`renderer/app.js` calls them from inside the existing `.then()`/`.catch()`
handlers; the `catch` path calls them with `ok = false`.

`tests/haulx-utils.test.js` covers every row of the §2 table:

- sell: non-ok status → `failed`
- sell: 200 with a price and a volume → not failed
- sell: 200 with `min_sell: null` but a volume → not failed (no order book)
- sell: 200 with `packaged_volume: null` → `failed`
- buy: non-ok status other than 422 → `failed`
- buy: 422 → not failed, `maxBuy` null
- buy: 200 with a price → not failed

Verification beyond Jest: `node --check renderer/app.js` and the existing
`python -m pytest python/tests/ -v` suite. No change is made to any Python file,
so pytest is a regression check only. The app is not launched to verify this.
