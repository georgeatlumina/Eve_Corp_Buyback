# Doctrine Stock — Sort by Priority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Sort by priority" option to the Doctrine Stock tab's sort dropdown, showing quotas in the admin-configured order already carried implicitly by the published snapshot's array order.

**Architecture:** Two small, coupled edits — a new `<option>` in the sort `<select>` markup, and a matching early-return branch in the `visibleQuotas()` sort function that skips sorting and returns the snapshot's original (filtered) order. No backend or data-model change: the snapshot's `quotas` array already arrives in priority order via `publishDoctrineStock` (`renderer/app.js:3571-3592`), which republishes the same array the Contracts tab uses to assign `dataset.priority` as an index (`renderer/app.js:3699`).

**Tech Stack:** Vanilla JS (Electron renderer), no framework. Verification via `node --check` (no existing Jest suite covers this file) and the existing Python pytest suite as a pure regression check (no Python files change).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-25-doctrine-stock-priority-sort-design.md`
- Default sort stays `under-quota` — do not change the `<select>`'s implied default (first `<option>` remains `under-quota`).
- No backend/API/data-model changes — this is a pure client-side sort of already-available data.
- No new test file — none exists for `renderer/doctrine-stock.js` today, and the design spec explicitly does not require adding one for this change.

---

### Task 1: Add priority sort option and wire it into `visibleQuotas()`

**Files:**
- Modify: `renderer/index.html:409-412` (the `#doctrine-stock-sort` `<select>`)
- Modify: `renderer/doctrine-stock.js:30-44` (the `visibleQuotas()` function)

**Interfaces:**
- Consumes: existing `dsState.sort` string state (`renderer/doctrine-stock.js:13`), existing `#doctrine-stock-sort` change listener (`renderer/doctrine-stock.js:163`, already assigns `dsState.sort = e.target.value` and calls `render()` — no changes needed to the listener itself).
- Produces: `visibleQuotas()` returns rows in original snapshot order (unsorted, but still hide-ok-filtered) whenever `dsState.sort === 'priority'`. No other function calls `visibleQuotas()` besides `render()` (`:91`), `exportGapCsv()` (`:122`), and `copyShoppingList()` (`:137`) — all three should transparently pick up priority order when that sort mode is active, since they all call the same function.

- [ ] **Step 1: Add the dropdown option**

In `renderer/index.html`, change:

```html
        <select id="doctrine-stock-sort" class="secondary">
          <option value="under-quota">Sort by biggest gap</option>
          <option value="default">Sort by ship name</option>
        </select>
```

to:

```html
        <select id="doctrine-stock-sort" class="secondary">
          <option value="under-quota">Sort by biggest gap</option>
          <option value="default">Sort by ship name</option>
          <option value="priority">Sort by priority</option>
        </select>
```

- [ ] **Step 2: Add the early-return branch in `visibleQuotas()`**

In `renderer/doctrine-stock.js`, change:

```js
  function visibleQuotas() {
    const snap = dsState.data[dsState.alliance];
    let rows = (snap && Array.isArray(snap.quotas)) ? snap.quotas.slice() : [];
    if (dsState.hideOk) rows = rows.filter((q) => quotaState(q) !== 'ok');
    rows.sort((a, b) => {
      if (dsState.sort === 'under-quota') {
        const am = Number(a.missing) || 0;
        const bm = Number(b.missing) || 0;
        if (am !== bm) return bm - am;
        return (a.ship_name || a.name || '').localeCompare(b.ship_name || b.name || '');
      }
      return (a.ship_name || a.name || '').localeCompare(b.ship_name || b.name || '');
    });
    return rows;
  }
```

to:

```js
  function visibleQuotas() {
    const snap = dsState.data[dsState.alliance];
    let rows = (snap && Array.isArray(snap.quotas)) ? snap.quotas.slice() : [];
    if (dsState.hideOk) rows = rows.filter((q) => quotaState(q) !== 'ok');
    if (dsState.sort === 'priority') return rows;
    rows.sort((a, b) => {
      if (dsState.sort === 'under-quota') {
        const am = Number(a.missing) || 0;
        const bm = Number(b.missing) || 0;
        if (am !== bm) return bm - am;
        return (a.ship_name || a.name || '').localeCompare(b.ship_name || b.name || '');
      }
      return (a.ship_name || a.name || '').localeCompare(b.ship_name || b.name || '');
    });
    return rows;
  }
```

- [ ] **Step 3: Verify both files parse**

Run:

```bash
node --check renderer/doctrine-stock.js
```

Expected: no output, exit code 0 (a syntax check; `index.html` has no JS of its own to check — the new `<option>` is plain markup).

- [ ] **Step 4: Run the existing test suites as a regression check**

Run:

```bash
npx jest
python -m pytest python/tests/ -v
```

Expected: both pass with the same results as before this change (neither suite touches `doctrine-stock.js` or any Python file, so this only confirms nothing else broke).

- [ ] **Step 5: Commit**

```bash
git add renderer/index.html renderer/doctrine-stock.js
git commit -m "$(cat <<'EOF'
feat(doctrine-stock): add sort-by-priority option

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** Spec §Design 1 (preserve snapshot order) → Step 2. Spec §Design 2 (dropdown option) → Step 1. Both spec code blocks are reproduced verbatim in this task.
- **Placeholder scan:** none — every step has literal before/after code or an exact command.
- **Type consistency:** `dsState.sort` is a plain string compared with `===`, consistent with the existing `'under-quota'` / `'default'` checks already in the function; `'priority'` follows the same convention.
