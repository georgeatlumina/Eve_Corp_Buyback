# Contracts Bare-Hull Inventory Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show bare-hull Acquisitions inventory counts on the Contracts & quotas dashboard, and stop "Copy shopping list" from asking the user to source hulls they already have.

**Architecture:** One shared lookup helper (`acqHullCountFor`) reads the existing `acquisitionsHulls` global. The Contracts dashboard renderer calls it once per full render to bake a snapshot count into each expanded row; `copyShoppingList` calls it fresh on every click to subtract live inventory from each line before printing.

**Tech Stack:** Vanilla JS, no framework, plain `<script>` load order, Jest with `jsdom` for regression only (this feature adds no unit tests — see Global Constraints).

**Spec:** `docs/superpowers/specs/2026-07-24-contracts-bare-hull-inventory-design.md`

## Global Constraints

- Expand-panel hull count is a **snapshot**: computed once per `renderContractsDashboard` call (on Scan, or on alliance-toggle switch), not recomputed live.
- Shopping-list subtraction is **live**: reads `acquisitionsHulls` fresh at the moment "Copy shopping list" is clicked.
- Match key is `type_id`, `String()`-normalized on both sides.
- A shopping-list line whose `missing - have` reaches 0 is **omitted entirely**, not printed as `0 x Ship`.
- No per-line annotation in the copied text — plain reduced number only.
- **Only `#btn-contracts-export-text` / `copyShoppingList` in `renderer/app.js` changes.** Two other buttons share the label "Copy shopping list" — `#btn-doctrine-stock-export-text` (`renderer/doctrine-stock.js`) and `#btn-indy-fulfil-export-text` (`renderer/indy.js`) — and are out of scope.
- No unit tests for the subtraction arithmetic or the lookup helper — the spec judged a 3-line calculation not worth extracting into `acquisitions-utils.js` purely for testability, and this is UI-wiring code consistent with how `acqRunFinder`/`acqTypeName` in the build-finder work were verified (`node --check` + full Jest regression, no DOM tests, no app launch).
- Never `git add -A`. Stage explicit paths only. Re-check `git log --oneline -1` before every commit.

## File Structure

| File | Responsibility |
|---|---|
| `renderer/app.js` (modify) | `acqHullCountFor` helper; `renderContractsDashboard` + `renderQuotaBar` gain the expand-panel row; `copyShoppingList` gains subtraction |
| `renderer/index.html` (modify) | Intro paragraph sentence; button tooltip |

## Verified current state (do not re-derive — these line numbers were confirmed immediately before writing this plan)

```
renderer/app.js:4163   let acquisitionsHulls = [];  // [{type_id, name, quantity, category_id}]
renderer/app.js:4164   let acquisitionsItems = [];  // [{type_id, name, quantity, category_id}]
renderer/app.js:3610   function renderContractsDashboard(payload) {
renderer/app.js:3725   function renderQuotaBar(q, priority = 0) {
renderer/app.js:4129   async function copyShoppingList() {
renderer/index.html:433   <h2>Contracts &amp; quotas</h2>
renderer/index.html:434   <p class="muted">Scans every outstanding item-exchange contract...
renderer/index.html:451   <button id="btn-contracts-export-text" type="button" class="secondary">Copy shopping list</button>
```

---

### Task 1: `acqHullCountFor` lookup helper

**Files:**
- Modify: `renderer/app.js:4164` (insert immediately after)

**Interfaces:**
- Consumes: the existing global `acquisitionsHulls` (`app.js:4163`)
- Produces: `acqHullCountFor(typeId) -> number`, used by Tasks 2 and 3

- [ ] **Step 1: Insert the helper**

In `renderer/app.js`, find:

```js
let acquisitionsHulls = [];  // [{type_id, name, quantity, category_id}]
let acquisitionsItems = [];  // [{type_id, name, quantity, category_id}]
```

Replace with:

```js
let acquisitionsHulls = [];  // [{type_id, name, quantity, category_id}]
let acquisitionsItems = [];  // [{type_id, name, quantity, category_id}]

// How many bare hulls of a given type are in the Acquisitions inventory right
// now. Shared by the Contracts dashboard's expand-panel row (called once per
// render, giving it snapshot semantics) and by copyShoppingList (called fresh
// on every click, giving it live semantics) — the freshness difference is a
// property of when each caller calls this, not of the helper itself.
function acqHullCountFor(typeId) {
  const key = String(typeId);
  const row = acquisitionsHulls.find((h) => String(h.type_id) === key);
  return row ? Number(row.quantity) || 0 : 0;
}
```

- [ ] **Step 2: Verify syntax**

Run: `node --check renderer/app.js`
Expected: no output

- [ ] **Step 3: Commit**

```bash
git log --oneline -1
git add renderer/app.js
git commit -m "contracts: add acqHullCountFor inventory lookup helper"
```

---

### Task 2: Expand-panel row on the Contracts dashboard

**Files:**
- Modify: `renderer/app.js:3610` (`renderContractsDashboard`)
- Modify: `renderer/app.js:3725` (`renderQuotaBar`)

**Interfaces:**
- Consumes: `acqHullCountFor` from Task 1
- Produces: `renderQuotaBar(q, priority, hullCount)` — third parameter added; existing two-argument call sites elsewhere in the file (there are none besides the one this task updates) are unaffected since the parameter is additive

- [ ] **Step 1: Build the count once per dashboard render and pass it through**

In `renderer/app.js`, inside `renderContractsDashboard`, find:

```js
    quotas.forEach((q, i) => root.appendChild(renderQuotaBar(q, i)));
```

Replace with:

```js
    // Snapshot, not live: computed once per dashboard render (Scan, or
    // alliance-toggle switch), matching every other number on the bar.
    quotas.forEach((q, i) => root.appendChild(renderQuotaBar(q, i, acqHullCountFor(q.ship_type_id))));
```

- [ ] **Step 2: Accept the count and render the row**

In `renderer/app.js`, find the `renderQuotaBar` signature:

```js
function renderQuotaBar(q, priority = 0) {
```

Replace with:

```js
function renderQuotaBar(q, priority = 0, hullCount = 0) {
```

Then find the expand panel's second row and the closing of that panel:

```js
      <div class="quota-expand-row">
        <span class="quota-expand-label">Sold last 30 days</span>
        <span class="quota-sold-count muted">—</span>
      </div>
    </div>
  `;
```

Replace with:

```js
      <div class="quota-expand-row">
        <span class="quota-expand-label">Sold last 30 days</span>
        <span class="quota-sold-count muted">—</span>
      </div>
      <div class="quota-expand-row">
        <span class="quota-expand-label">Bare hulls in Acquisitions</span>
        <span class="quota-hull-count muted">${hullCount}</span>
      </div>
    </div>
  `;
```

- [ ] **Step 3: Verify syntax and run the regression suite**

Run: `node --check renderer/app.js`
Expected: no output

Run: `npx jest`
Expected: PASS, all suites (this feature adds no new Jest tests — see Global Constraints)

- [ ] **Step 4: Manual trace check (no app launch — reasoning only)**

Confirm by reading, not by running the app: `q.ship_type_id` in `_scan_contracts_stream`'s quota payload (`python/server.py`) is a plain int from config, and `acquisitionsHulls[].type_id` comes from the acquisitions parser — `acqHullCountFor`'s `String()` normalization on both sides means the comparison is safe regardless of which side ships a number vs. a numeric string. This mirrors the exact normalization already used in `buildPool`/`fitModuleUnits` (`renderer/acquisitions-utils.js`, Task 1 of the 2026-07-24 build-finder plan).

- [ ] **Step 5: Commit**

```bash
git log --oneline -1
git add renderer/app.js
git commit -m "contracts: show bare-hull inventory count in the quota expand panel"
```

---

### Task 3: Subtract inventory in "Copy shopping list"

**Files:**
- Modify: `renderer/app.js:4129` (`copyShoppingList`)

**Interfaces:**
- Consumes: `acqHullCountFor` from Task 1
- Produces: no new interface — `copyShoppingList` remains a zero-argument function wired to `#btn-contracts-export-text` at `app.js:3379` (unchanged)

- [ ] **Step 1: Subtract live inventory before the threshold check**

In `renderer/app.js`, inside `copyShoppingList`, find:

```js
  for (const q of orderedQuotas) {
    const missing = Number(q.missing) || 0;
    if (missing > 0) {
      const name = q.ship_name || q.name || `type ${q.ship_type_id}`;
      lines.push(`${missing} x ${name}`);
    }
  }
  const text = lines.length ? lines.join('\n') : 'No gaps — every quota is met.';
```

Replace with:

```js
  for (const q of orderedQuotas) {
    const missing = Number(q.missing) || 0;
    // Live read, not the dashboard's snapshot: this button answers "what do I
    // still need to buy right now", so it should reflect inventory as of the
    // click, even if it has changed since the last Scan.
    const remaining = Math.max(0, missing - acqHullCountFor(q.ship_type_id));
    if (remaining > 0) {
      const name = q.ship_name || q.name || `type ${q.ship_type_id}`;
      lines.push(`${remaining} x ${name}`);
    }
  }
  const text = lines.length ? lines.join('\n') : 'No gaps — every quota is met or covered by Acquisitions inventory.';
```

- [ ] **Step 2: Verify syntax and run the regression suite**

Run: `node --check renderer/app.js`
Expected: no output

Run: `npx jest`
Expected: PASS, all suites

- [ ] **Step 3: Manual trace check — a ship fully covered by inventory is omitted, not zero-printed**

Confirm by reading: if `missing = 3` and `acqHullCountFor(q.ship_type_id) = 5`, then `remaining = Math.max(0, 3 - 5) = 0`, and `remaining > 0` is `false`, so no line is pushed for that ship — matching the spec's "zero-covered lines omitted entirely" decision, not a `0 x Ship` line.

- [ ] **Step 4: Commit**

```bash
git log --oneline -1
git add renderer/app.js
git commit -m "contracts: subtract Acquisitions inventory from the shopping list"
```

---

### Task 4: Intro paragraph and button tooltip

**Files:**
- Modify: `renderer/index.html:434`
- Modify: `renderer/index.html:451`

**Interfaces:**
- Consumes: nothing (text-only)
- Produces: nothing consumed by later tasks (this is the last task)

- [ ] **Step 1: Extend the Contracts tab intro paragraph**

In `renderer/index.html`, find:

```html
      <p class="muted">Scans every outstanding item-exchange contract posted at the configured home structure by <strong>any corp that a logged-in slot is a Contract Manager / Director of</strong>. Add more slots on the Auth tab to cover more corps — each one widens the visible set. <strong>ESI limitation:</strong> corps you don't have a director token for stay invisible, even if their contracts show in the in-game alliance tab.</p>
```

Replace with:

```html
      <p class="muted">Scans every outstanding item-exchange contract posted at the configured home structure by <strong>any corp that a logged-in slot is a Contract Manager / Director of</strong>. Add more slots on the Auth tab to cover more corps — each one widens the visible set. <strong>ESI limitation:</strong> corps you don't have a director token for stay invisible, even if their contracts show in the in-game alliance tab. Expanding a ship also shows how many bare hulls of that type are currently in the Acquisitions Inventory, as of your last scan.</p>
```

- [ ] **Step 2: Add the tooltip to the Contracts tab's "Copy shopping list" button**

In `renderer/index.html`, find (this exact line appears only once — the other two "Copy shopping list" buttons, `#btn-doctrine-stock-export-text` at line 410 and `#btn-indy-fulfil-export-text` at line 762, have different `id` attributes and must not be touched):

```html
        <button id="btn-contracts-export-text" type="button" class="secondary">Copy shopping list</button>
```

Replace with:

```html
        <button id="btn-contracts-export-text" type="button" class="secondary" title="Quantities are reduced by bare hulls already in your Acquisitions inventory.">Copy shopping list</button>
```

- [ ] **Step 3: Verify the other two buttons are untouched**

Run: `grep -n "Copy shopping list" renderer/index.html`
Expected output (three lines, only the second carrying the new `title`):

```
410:        <button id="btn-doctrine-stock-export-text" type="button" class="secondary">Copy shopping list</button>
451:        <button id="btn-contracts-export-text" type="button" class="secondary" title="Quantities are reduced by bare hulls already in your Acquisitions inventory.">Copy shopping list</button>
762:        <button id="btn-indy-fulfil-export-text" type="button" class="secondary">Copy shopping list</button>
```

- [ ] **Step 4: Full regression pass**

Run: `npx jest`
Expected: PASS, all suites

Run: `python -m pytest python/tests/ -q`
Expected: PASS (regression only — no Python file changed by this plan)

- [ ] **Step 5: Commit**

```bash
git log --oneline -1
git add renderer/index.html
git commit -m "contracts: document the inventory-aware shopping list in the UI"
```

---

## Self-review

**Spec coverage:**
- Expand-panel bare-hull row, snapshot freshness → Task 2
- Shared lookup helper, single source of match logic → Task 1
- Shopping-list subtraction, live freshness, floor-at-0-and-omit → Task 3
- Fallback message fix → Task 3, Step 1
- Intro paragraph sentence → Task 4, Step 1
- Button tooltip, with the two-other-buttons disambiguation → Task 4, Step 2–3
- "No unit tests for this arithmetic" decision → Global Constraints, honored by every task's verification step (`node --check` + `npx jest` regression, no new test files)

**Placeholder scan:** none found — every step carries the literal before/after code or an exact command with expected output.

**Type/name consistency:** `acqHullCountFor(typeId)` is defined once in Task 1 and called identically (`acqHullCountFor(q.ship_type_id)`) in Tasks 2 and 3. `renderQuotaBar(q, priority, hullCount)`'s three-argument form is introduced and called consistently within Task 2 — no other call site exists in the file to update (confirmed only one call site during context-gathering for this plan).
