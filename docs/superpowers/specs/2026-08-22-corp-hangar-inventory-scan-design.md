# Corp hangar inventory scan — design

## Problem

Two features hold inventory that's populated by paste today:

- **Acquisitions tab** — already has a "Load corp inventory" button
  (`acqLoadCorpInventory` in `renderer/app.js`, backed by `GET /api/corp/assets`
  in `python/server.py`) that pulls corp hangar contents via ESI on a
  Director-role toon and lets the operator Add-to or Replace the Acquisitions
  inventory. It always pulls **every** hangar division combined — no way to
  scope the scan to specific divisions.
- **Stockpile tab** (`renderer/stockpile.js`, `python/stockpile.py`) — alliance
  industry-material stock. 100% manual paste today; no ESI integration exists.

The ask: give both tabs a button-triggered ESI hangar scan, with a UI to choose
which hangar divisions are included, and keep that division selection shared
and synced across the alliance (not just remembered on one machine).

## Non-goals

- No automatic/scheduled scanning — every scan is an explicit button click.
- No support for scanning hangars at more than one structure — both tabs
  already scope to the single configured `home_structure_id`; that's unchanged.
- Acquisitions' hull/module split (`category_id == 6`) and Stockpile's
  minerals/PI/other split (`stockpile.classify`) stay as they are — this only
  changes *what feeds* those splits, not the splits themselves.

## Architecture

### 1. `/api/corp/assets` gains `group_id`

`get_corp_assets()` in `python/server.py` (~line 5557) already resolves each
hangar item's `name` and `category_id` from local `type_meta.json` / ESI
enrichment (`enrich_types`, which already returns `group_id` — see
`python/market.py`'s `_resolve_one`). The endpoint's `_resolve()` helper just
never threads `group_id` through to the response. Add it — one extra field per
item, additive and harmless to the existing Acquisitions consumer.

This is needed because `stockpile.classify(meta, name)` buckets items into
`minerals` / `pi` / `other` using `group_id` (mineral group 18) and
`category_id`/`group_id` (planetary groups), not `category_id` alone.

### 2. Shared hangar-selection store

New pure module `python/hangar_selection.py`, mirroring `python/pinned.py`'s
shape:

```python
def empty_selection() -> dict: ...      # {'selected_flags': [], 'updated_at': ''}
def normalize(data) -> dict: ...        # coerce arbitrary loaded doc to canonical shape
def load_selection_local() -> dict: ...
def save_selection_local(selection: dict) -> None:  # chmod 600
```

`selected_flags` stores canonical division keys (`'CorpSAG1'`..`'CorpSAG7'` —
`HangarAll` normalizes to `'CorpSAG1'` on write/read, matching the existing
`_CORP_HANGAR_FLAGS` collapse of Division 1's two possible flags).

Server-side, `python/server.py` gets a read/write pair following the exact
`_stockpile_read_store` / `save_stockpile` pattern (same repo, same helpers):

```python
def _hangar_selection_remote_cfg(cfg):
    rc = _share_remote_cfg(cfg)          # same market-history repo as stockpile/doctrine-stock/builds
    return {**rc, 'path': 'hangar-selection.json'} if rc else None

@app.get('/api/hangar-selection')
def get_hangar_selection():
    # prefer GitHub (Read PAT), fall back to local cache on any remote failure —
    # identical shape to _stockpile_read_store

class HangarSelectionSave(BaseModel):
    flags: list[str] = []

@app.post('/api/hangar-selection')
def save_hangar_selection(req: HangarSelectionSave):
    # 403 unless cfg['hangar_selection_allow_push'] is set
    # SHA-checked push via _github_contents_get/_github_contents_put,
    # local-cache fallback when no repo/PAT configured (never a hard failure)
```

New config default in `python/config.py`: `'hangar_selection_allow_push': False`
— per-machine gate mirroring `stockpile_allow_push`, so importing someone
else's exported config doesn't silently unlock pushing the shared selection.
Not stripped from export (same treatment as `stockpile_allow_push`).

### 3. New Stockpile-from-scan endpoint

`POST /api/stockpile/import-hangars` in `server.py`:

```python
class StockpileHangarImport(BaseModel):
    items: list[dict]   # [{type_id, name, quantity, group_id, category_id}, ...]
    note: str = ''

@app.post('/api/stockpile/import-hangars')
def import_stockpile_from_hangars(req: StockpileHangarImport):
    # same 403 gate as save_stockpile (stockpile_allow_push)
    # classify each item via stockpile.classify({'group_id':.., 'category_id':..}, name)
    # build + persist + push the store via the same tail save_stockpile already
    # runs today — factor that tail into _stockpile_persist(items, note) and
    # call it from both endpoints so paste and ESI paths push identically
```

No new endpoint needed for Acquisitions — its existing `/api/acquisitions`
Add/Replace path is unchanged; the client just pre-filters the items it sends
by the checked hangar flags before calling it, exactly as it already filters
by `category_id == 6` today.

### 4. Shared hangar-picker UI

One small renderer helper (in `renderer/app.js`, since both Acquisitions and
Stockpile already load after it) renders the checkbox grid seen in the
approved mockup: one row per division (`Hangar Division 1`..`7`, with
`HangarAll`/`CorpSAG1` collapsed into Division 1 as today), item count per
row, a select-all/select-none affordance, checked state seeded from
`GET /api/hangar-selection` (default: all checked if nothing saved yet).

Both tabs' scan buttons follow the same sequence:

1. Click "Load corp inventory" (Acquisitions) / "Scan corp hangars"
   (Stockpile, new button next to the existing paste panel, same admin gate —
   officer group + `stockpile_allow_push`).
2. Fetch `GET /api/corp/assets` (full breakdown, unchanged) and
   `GET /api/hangar-selection` in parallel.
3. Render the shared picker pre-checked per the persisted selection.
4. User adjusts checkboxes, clicks the tab's action:
   - Acquisitions: existing **Add to inventory** / **Replace inventory**,
     now operating on `allItems` filtered to checked flags.
   - Stockpile: single **Replace stockpile** (per requirement — always a
     full replace, matching today's paste-save behavior), which POSTs the
     filtered, resolved items to `/api/stockpile/import-hangars`.
5. On either action, fire-and-forget `POST /api/hangar-selection` with the
   current checked-flags set, so it's remembered for next time across the
   alliance. A failed/forbidden push (no PAT, `hangar_selection_allow_push`
   off) is silent — the scan still applies locally regardless.

Nothing scans without the explicit click in step 1; there's no polling, no
auto-refresh, no scheduled sync.

## Error handling

- Missing scope / no home structure / no credentials / fetch failure: reuse
  the existing `REASON_MESSAGES` mapping in `app.js` (already covers all of
  these for the Acquisitions load path); the same messages surface for the
  new Stockpile scan button.
- No `market_history_repo_url` configured: hangar-selection silently runs
  local-only (`storage: 'local'` in the GET response, same convention as
  Stockpile/doctrine-stock today) — never a hard error.
- Hangar-selection push failing (403 from the allow-push gate, network error,
  GitHub conflict): non-fatal. The scan/import the user just ran already
  completed against their chosen checkboxes; only the *next* scan's default
  checked-state fails to update.

## Testing

- `python/tests/test_hangar_selection.py` (new, mirrors `test_acquisitions.py`
  style): `normalize`/`empty_selection`/local load-save round-trip, corrupt
  file degrades to empty, `HangarAll`→`CorpSAG1` collapse.
- New `python/tests/test_stockpile_scan.py` (no dedicated Stockpile test file
  exists today, so this is the first): endpoint tests for `GET`/`POST
  /api/hangar-selection` covering both the local-cache path and the repo-push
  path (mocked `_github_contents_get/put`, following `save_stockpile`'s
  existing shape), `POST /api/stockpile/import-hangars` classify +
  replace-store behavior, and `/api/corp/assets` now including `group_id`
  per item.
- `stockpile.classify` already has direct unit coverage potential (pure
  function) — add cases feeding it ESI-shaped metadata (`group_id`/
  `category_id` only, no name) to confirm it works without the paste-path's
  name fallback.
- No new Jest coverage planned — the hangar-picker checkbox filtering is a
  small enough renderer-only concern that it doesn't need a pure-function
  extraction the way `acquisitions-utils.js` needed one for the merge logic;
  revisit if it grows.

## Open items for the review pass

None outstanding — mockup approved as-is ("looks right", no requested
changes) during brainstorming.
