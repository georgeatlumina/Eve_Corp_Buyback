# HaulX Retry Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a header button to the HaulX tab that re-runs only the volume/price lookups that errored, so a transient ESI failure costs a click instead of an app restart.

**Architecture:** Two module-level `Set`s in `renderer/app.js` record which type ids had a *failed* lookup, as opposed to one that legitimately returned null. Two new pure functions in `renderer/haulx-utils.js` decide which is which. A retry handler evicts exactly the failed entries from the price caches and re-runs the existing `haulxFetchPrices`, which then refills them.

**Tech Stack:** Vanilla JS renderer (plain `<script>` tags, no bundler), Jest for unit tests, FastAPI Python sidecar (not modified by this plan).

**Spec:** `docs/superpowers/specs/2026-07-24-haulx-retry-button-design.md`

## Global Constraints

- `renderer/haulx-utils.js` is loaded both as a plain browser script (`renderer/index.html:853`, before `app.js`) and as a CommonJS module by Jest. New functions must be plain top-level `function` declarations **and** be added to the `module.exports` block at the bottom of the file.
- Run `npm test` (Jest) and `python -m pytest python/tests/ -v` before every commit. Both must pass.
- Do **not** launch the Electron app to verify anything. Verification is `node --check`, Jest, and pytest only.
- Do not `git push` or open a PR. Commit locally only.
- No Python file is modified by this plan.
- Match the surrounding code style in `app.js`: 2-space indent, single quotes, comments that explain *why* rather than restating the code.
- Line numbers in this plan are as of commit `c867b13`. Task 2 inserts lines into `app.js`, so every `app.js` line number quoted in Task 3 will have drifted by roughly +5. Anchor on the quoted surrounding code, not the number.
- End every commit message with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

---

### Task 1: Response classification helpers

Two pure functions that turn an HTTP response into "here is the value" or "this
failed, retry it". This is the only real logic in the feature, which is why it
lives in the unit-tested utils file rather than in `app.js`.

The rules, from the spec:

| Outcome | Verdict |
| --- | --- |
| network throw, or non-2xx | **failed** |
| 200 with `min_sell: null` | settled — item genuinely has no Jita sell order |
| 200 with `packaged_volume: null` | **failed** — every EVE type has a volume, so a null one means the server's `fetch_type_info` threw and swallowed the error (`python/server.py:1838-1842`) |
| 422 on `jita-buy` | settled — no Janice API key configured (`python/server.py:1869`); retrying cannot fix it |

**Files:**
- Modify: `renderer/haulx-utils.js` (append functions before the `module.exports` block at line 85, and add both names to that block)
- Test: `tests/haulx-utils.test.js` (append new `describe` blocks at the end)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `haulxClassifySell(ok: boolean, status: number, data: object|null) -> { minSell: number|null, vol: number|null, failed: boolean }`
  - `haulxClassifyBuy(ok: boolean, status: number, data: object|null) -> { maxBuy: number|null, failed: boolean }`

  Both are called by Task 2. `status` is unused by `haulxClassifySell` but kept
  so both have the same shape at their call sites.

- [ ] **Step 1: Write the failing tests**

Append to the end of `tests/haulx-utils.test.js`:

```js
// ── haulxClassifySell / haulxClassifyBuy ─────────────────────────────────────

describe('haulxClassifySell', () => {
  test('a good response yields both numbers and is not a failure', () => {
    expect(haulxClassifySell(true, 200, { min_sell: 1000, packaged_volume: 2500 }))
      .toEqual({ minSell: 1000, vol: 2500, failed: false });
  });

  test('a null min_sell is an honest answer, not a failure', () => {
    // The item is simply not on the Jita sell book. Retrying cannot change it.
    expect(haulxClassifySell(true, 200, { min_sell: null, packaged_volume: 2500 }))
      .toEqual({ minSell: null, vol: 2500, failed: false });
  });

  test('a null packaged_volume is a failure', () => {
    // Every EVE type has a volume, so a null one means the server's type-info
    // lookup threw and swallowed the error while still returning 200.
    expect(haulxClassifySell(true, 200, { min_sell: 1000, packaged_volume: null }))
      .toEqual({ minSell: 1000, vol: null, failed: true });
  });

  test('a non-ok response is a failure', () => {
    expect(haulxClassifySell(false, 502, null))
      .toEqual({ minSell: null, vol: null, failed: true });
  });

  test('a network throw, passed as ok=false with no status, is a failure', () => {
    expect(haulxClassifySell(false, 0, null))
      .toEqual({ minSell: null, vol: null, failed: true });
  });
});

describe('haulxClassifyBuy', () => {
  test('a good response yields the buy price and is not a failure', () => {
    expect(haulxClassifyBuy(true, 200, { max_buy: 900 }))
      .toEqual({ maxBuy: 900, failed: false });
  });

  test('a missing max_buy is an honest answer, not a failure', () => {
    expect(haulxClassifyBuy(true, 200, { max_buy: null }))
      .toEqual({ maxBuy: null, failed: false });
  });

  test('422 means no Janice key is configured, so it is not retryable', () => {
    // Retrying would fail identically every time and would leave the button
    // permanently offering hundreds of doomed lookups.
    expect(haulxClassifyBuy(false, 422, null))
      .toEqual({ maxBuy: null, failed: false });
  });

  test('any other non-ok response is a failure', () => {
    expect(haulxClassifyBuy(false, 502, null))
      .toEqual({ maxBuy: null, failed: true });
  });
});
```

Also add the two names to the `require` destructuring at the top of the file
(`tests/haulx-utils.test.js:3-13`), so it reads:

```js
const {
  haulxTotals,
  haulxFillByPriority,
  haulxBlockReason,
  haulxIsAddable,
  haulxProfit,
  haulxClassifySell,
  haulxClassifyBuy,
  HAULX_MAX_VOLUME,
  HAULX_MAX_COLLATERAL,
  HAULX_SHIPPING_COST,
  HAULX_SELL_MARKUP,
} = require('../renderer/haulx-utils');
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest tests/haulx-utils.test.js -t "haulxClassify"`
Expected: FAIL — `TypeError: haulxClassifySell is not a function`

- [ ] **Step 3: Write the implementation**

In `renderer/haulx-utils.js`, insert immediately **before** the
`if (typeof module !== 'undefined' && module.exports) {` block at line 85:

```js
/**
 * Read a /api/market/jita-sell response, separating a real failure from a null
 * we should believe.
 *
 * A null `min_sell` is honest: the item has no Jita sell order. A null
 * `packaged_volume` is not — every type has a volume, so it only appears when
 * the server's type-info lookup threw and swallowed the error behind a 200.
 * Only failures are worth retrying.
 */
function haulxClassifySell(ok, status, data) {
  if (!ok) return { minSell: null, vol: null, failed: true };
  const minSell = data?.min_sell ?? null;
  const vol = data?.packaged_volume ?? null;
  return { minSell, vol, failed: vol == null };
}

/**
 * Read a /api/market/jita-buy response.
 *
 * 422 is the server saying no Janice API key is configured. That is a settled
 * answer rather than a blip: without this case every item on a keyless install
 * would count as failed and the retry button would offer hundreds of lookups
 * that can only fail again.
 */
function haulxClassifyBuy(ok, status, data) {
  if (!ok) return { maxBuy: null, failed: status !== 422 };
  return { maxBuy: data?.max_buy ?? null, failed: false };
}
```

Then add both to the exports block so Jest can see them:

```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    haulxTotals,
    haulxFillByPriority,
    haulxBlockReason,
    haulxIsAddable,
    haulxProfit,
    haulxClassifySell,
    haulxClassifyBuy,
    HAULX_MAX_VOLUME,
    HAULX_MAX_COLLATERAL,
    HAULX_SHIPPING_COST,
    HAULX_SELL_MARKUP,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest tests/haulx-utils.test.js`
Expected: PASS — the 9 new tests plus every pre-existing test in the file.

- [ ] **Step 5: Run the full suites**

Run: `npm test`
Expected: PASS

Run: `python -m pytest python/tests/ -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add renderer/haulx-utils.js tests/haulx-utils.test.js
git commit -m "haulx: tell a failed price lookup apart from an honest null"
```

---

### Task 2: Record which lookups failed

Wire the Task 1 helpers into `haulxFetchPrices` and track failures in two sets.
No visible behaviour changes yet — this task just makes the failures knowable.

**Files:**
- Modify: `renderer/app.js:4377-4382` (add the two sets beside the existing caches)
- Modify: `renderer/app.js:4487-4514` (the two `Promise.all` fetch blocks)

**Interfaces:**
- Consumes: `haulxClassifySell(ok, status, data)` and `haulxClassifyBuy(ok, status, data)` from Task 1. Both are global at runtime because `haulx-utils.js` is loaded as a plain script before `app.js`.
- Produces:
  - `haulxFailedPrice: Set<string>` — type ids whose sell/volume lookup errored
  - `haulxFailedBuy: Set<string>` — type ids whose buy lookup errored

  Task 3 reads both for its count and clears both when retrying.

- [ ] **Step 1: Declare the two failure sets**

In `renderer/app.js`, after the `haulxReadinessScanDone` declaration at line 4382, add:

```js
// Type ids whose last lookup *errored*, as opposed to settling on a legitimate
// null. Only these are worth retrying, and only these get evicted from the
// caches above when the user clicks Retry.
const haulxFailedPrice = new Set();  // sell price / packaged volume lookups
const haulxFailedBuy = new Set();    // buy price lookups
```

Sets rather than a flag on the cache entries: `haulxItemBuyCache` stays a bare
`tid -> max_buy | null`, so the fit-total arithmetic at `app.js:4534-4556` needs
no changes.

- [ ] **Step 2: Route the sell fetch through the classifier**

Replace the first `Promise.all` block (`renderer/app.js:4489-4503`) with:

```js
    // Fetch any uncached sell prices
    await Promise.all(
      uncachedIds.map((tid) =>
        fetch(`${API}/api/market/jita-sell?type_id=${tid}`)
          .then(async (r) => haulxClassifySell(r.ok, r.status, r.ok ? await r.json() : null))
          .catch(() => haulxClassifySell(false, 0, null))
          .then(({ minSell, vol, failed }) => {
            haulxItemPriceCache[tid] = { min_sell: minSell, vol };
            if (failed) haulxFailedPrice.add(tid);
            else haulxFailedPrice.delete(tid);
            // Hull entries also get volume stored in haulxPriceCache
            if (!haulxPriceCache[tid]) {
              haulxPriceCache[tid] = { min_sell: minSell, packaged_volume: vol };
            }
          })
          .finally(bumpProgress)
      )
    );
```

Two things to note. The `if (!r.ok)` short-circuit means an HTTP error no longer
falls into `r.json()` and get silently cached as a null. And clearing the set on
success is what lets a retry that works shrink the count.

- [ ] **Step 3: Route the buy fetch through the classifier**

Replace the second `Promise.all` block (`renderer/app.js:4506-4514`) with:

```js
    // Fetch any uncached buy prices
    await Promise.all(
      uncachedBuyIds.map((tid) =>
        fetch(`${API}/api/market/jita-buy?type_id=${tid}`)
          .then(async (r) => haulxClassifyBuy(r.ok, r.status, r.ok ? await r.json() : null))
          .catch(() => haulxClassifyBuy(false, 0, null))
          .then(({ maxBuy, failed }) => {
            haulxItemBuyCache[tid] = maxBuy;
            if (failed) haulxFailedBuy.add(tid);
            else haulxFailedBuy.delete(tid);
          })
          .finally(bumpProgress)
      )
    );
```

- [ ] **Step 4: Verify the file still parses**

Run: `node --check renderer/app.js`
Expected: no output (success)

- [ ] **Step 5: Run the full suites**

Run: `npm test`
Expected: PASS — nothing should regress; the fit-total maths is untouched.

Run: `python -m pytest python/tests/ -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add renderer/app.js
git commit -m "haulx: track which price and volume lookups errored"
```

---

### Task 3: The retry button

Show the count, evict the failed entries, re-run the lookups.

**Files:**
- Modify: `renderer/app.js:4642` (add the button markup to the sticky header)
- Modify: `renderer/app.js` (add `haulxUpdateRetryButton` after `haulxUpdateTotals`, which ends at line 4417)
- Modify: `renderer/app.js` (add `haulxRetryFailed` immediately after `haulxFetchPrices`, which ends at line 4608)
- Modify: `renderer/app.js:4607` (call `haulxUpdateRetryButton()` at the end of `haulxFetchPrices`)
- Modify: `renderer/app.js:4816` (wire the click handler next to the `#haulx-clear` one)

**Interfaces:**
- Consumes: `haulxFailedPrice` and `haulxFailedBuy` from Task 2; the existing `haulxFetchPrices(quotas)`, `$(selector)` helper, and the `orderedQuotas` local built in `renderHaulxTab` at `app.js:4672-4674`.
- Produces: nothing consumed by later tasks — this is the final task.

- [ ] **Step 1: Add the button markup**

In the sticky header template inside `renderHaulxTab`, immediately after the
`#haulx-fill-note` span at `renderer/app.js:4642`, add:

```html
      <button id="haulx-retry" class="link-btn" hidden>↻ Retry</button>
```

`link-btn` is the class the neighbouring Clear / Fill by priority buttons already
use, so it needs no new CSS.

- [ ] **Step 2: Add `haulxUpdateRetryButton`**

Insert after `haulxUpdateTotals` ends at `renderer/app.js:4417`:

```js
// The button is the only signal that a lookup failed: it stays hidden while
// every price and volume settles cleanly, and its count is of failed *lookups*
// rather than of ships, matching how the progress bar totals its work.
function haulxUpdateRetryButton(inFlight = false) {
  const btn = $('#haulx-retry');
  if (!btn) return;
  if (inFlight) {
    btn.hidden = false;
    btn.disabled = true;
    btn.textContent = 'Retrying…';
    btn.title = '';
    return;
  }
  const priceFails = haulxFailedPrice.size;
  const buyFails = haulxFailedBuy.size;
  const total = priceFails + buyFails;
  btn.hidden = total === 0;
  btn.disabled = false;
  btn.textContent = `↻ Retry ${total}`;
  const parts = [];
  if (priceFails) parts.push(`${priceFails} volume/price lookup${priceFails === 1 ? '' : 's'}`);
  if (buyFails) parts.push(`${buyFails} buy-price lookup${buyFails === 1 ? '' : 's'}`);
  btn.title = parts.length ? `${parts.join(' and ')} failed — click to try again` : '';
}
```

- [ ] **Step 3: Call it when the lookups settle**

At the very end of `haulxFetchPrices`, after the `#haulx-fill-note` block that
closes at `renderer/app.js:4607`, add as the function's last statement:

```js
  haulxUpdateRetryButton();
```

- [ ] **Step 4: Add `haulxRetryFailed`**

Insert immediately after the closing brace of `haulxFetchPrices` (line 4608):

```js
// Re-run only the lookups that errored. Eviction is the whole trick:
// haulxFetchPrices skips any type id already present in a cache, so deleting
// the failed entries is what makes them fetch again. The haulxPriceCache entry
// goes too — its packaged_volume is written only when the entry is first
// created, so a stale one would survive a successful refetch.
async function haulxRetryFailed(quotas) {
  haulxUpdateRetryButton(true);
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

`haulxFetchPrices` re-runs its own progress bar, per-row volume/price updates,
block/unblock pass, totals update and "Fill by priority" gating, and finishes by
calling `haulxUpdateRetryButton()` again — so a retry that fixes everything hides
the button, and one that does not updates the count.

- [ ] **Step 5: Wire the click handler**

In `renderHaulxTab`, after the `#haulx-clear` listener that ends at
`renderer/app.js:4816`, add:

```js
  $('#haulx-retry')?.addEventListener('click', () => haulxRetryFailed(orderedQuotas));
```

`orderedQuotas` is the same list handed to the initial `haulxFetchPrices` call at
line 4823, so the retry covers exactly the rows on screen.

- [ ] **Step 6: Verify the file still parses**

Run: `node --check renderer/app.js`
Expected: no output (success)

- [ ] **Step 7: Run the full suites**

Run: `npm test`
Expected: PASS

Run: `python -m pytest python/tests/ -v`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add renderer/app.js
git commit -m "haulx: add a retry button for failed volume and price lookups"
```

---

## Manual smoke test (optional, user-driven)

The plan is verified by `node --check`, Jest and pytest. If the user later wants
to see it in the app, the failure path can be provoked by stopping the Python
sidecar, opening the HaulX tab so every lookup fails, restarting the sidecar and
clicking Retry — the count should fall to zero and the button should disappear.
Do not do this unprompted.
