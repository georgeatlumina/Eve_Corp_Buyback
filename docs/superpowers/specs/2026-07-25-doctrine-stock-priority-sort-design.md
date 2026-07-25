# Doctrine Stock — sort by priority

**Date:** 2026-07-25
**Status:** approved, ready for implementation

## Problem

The Doctrine Stock tab (`renderer/doctrine-stock.js`) lets members sort the
published quota bars by "biggest gap" (`under-quota`, the default) or "ship
name" (`default`). There is no way to see the bars in the order an admin
actually prioritized the doctrine hulls.

That order already exists elsewhere: the Contracts tab assigns each quota a
`dataset.priority` equal to its index in the config-ordered `quotas` array
(`renderer/app.js:3699`, `:3807`, `:3815`), and `publishDoctrineStock`
(`renderer/app.js:3571-3592`) publishes that same array, in that same order,
to the snapshot the Doctrine Stock tab reads. `visibleQuotas()`
(`renderer/doctrine-stock.js:30-44`) currently discards that order by always
sorting the array (or falling through to the name-sort branch).

## Goal

Add a "Sort by priority" option that shows the published quotas in their
original admin-configured order.

## Non-goals

- Changing the current default sort (`under-quota` stays the default).
- Any backend or data-model change — the snapshot already carries priority
  order implicitly via array position; no explicit `priority` field is added
  anywhere.
- Reordering doctrine hulls from within this tab. Priority order is still
  set on the Contracts tab; this is read-only, same as the rest of the page.

## Design

### 1. Preserve snapshot order in `visibleQuotas()`

`visibleQuotas()` builds `rows` via `snap.quotas.slice()` and then
`.filter()`, neither of which reorders elements, so the snapshot's original
(priority) order survives into `rows` untouched right up until the
`.sort()` call. Adding a `dsState.sort === 'priority'` branch that returns
before that call is therefore sufficient — no index bookkeeping needed:

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

### 2. Dropdown option

Add a third `<option>` to `#doctrine-stock-sort` in `renderer/index.html`,
alongside the existing two (`tab-doctrine-stock` section, near line
409-412):

```html
<option value="priority">Sort by priority</option>
```

Dropdown order becomes: biggest gap (default) → ship name → priority.
`dsState.sort` default stays `'under-quota'`; no change to the existing
`#doctrine-stock-sort` change listener (`renderer/doctrine-stock.js:163`) —
it already just assigns `e.target.value` and re-renders.

## Tests

The only new logic is the early-return branch in `visibleQuotas()`. Since
`doctrine-stock.js` has no existing unit test file and the function is a
simple, self-contained sort/filter, verification is:

- `node --check renderer/doctrine-stock.js`
- `node --check renderer/index.html`-equivalent: no JS in that file, so just
  confirm the new `<option>` parses (covered by the app loading it at
  runtime; no automated test needed for a static markup addition).
- Existing `python -m pytest python/tests/ -v` suite as a regression check —
  no Python file changes here.

The app itself is not launched to verify this (per project convention).
