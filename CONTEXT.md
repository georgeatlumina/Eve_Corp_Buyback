# Project Context

High-level orientation for the Naval Defence Alliance Management Tool. Read this first if you're
new to the repo. For the file/directory layout see [STRUCTURE.md](STRUCTURE.md).
For a function-level map see [FUNCTIONS.md](FUNCTIONS.md). For user-facing
usage and configuration see [README.md](README.md).

## What this app does

A desktop tool for corp leadership in *EVE Online* to triage two streams of
member-submitted contracts:

1. **Buyback contracts** — members sell items to the corp at a Janice
   appraisal. The app verifies the contract title carries a valid Janice URL,
   re-fetches the appraisal, checks the contract price is within 1 ISK of the
   appraisal's effective offer, that it sits below the 90% threshold, and that
   the contract was issued at a structure that accepts that item category
   (ore vs non-ore).
2. **Moon contracts** — `item_exchange` contracts priced at 0 ISK containing
   compressed/raw moon ore (and adjacent items like ice and sovereignty
   workforce reagents). The app refines the contents using configurable yields
   and computes a recommended ISK payout = refined-mineral value × payout
   fraction (80% moon ore / 90% non-moon ore & ice, by default).

Once triaged, each row gets one-click EVE-mail buttons rendered from
user-defined templates, so accept/reject responses can be sent in seconds.

A third stream tracks **doctrine stocking**: the Contracts tab scans every
authenticated character's corp contracts endpoint for outstanding
item-exchange contracts at the home structure and tallies them against a
user-configured quota list (ship hull + required count). Each quota row gets
a green/amber/red progress bar; the dashboard exports a gap CSV or a plain
shopping list for in-game multi-buy.

A secondary feature scans corp doctrines from Alliance Auth (`auth.navaldefence.org`)
and cross-references each fit against the corp market for stocking gaps. A
**Sov** tab gives an at-a-glance read on alliance sovereignty (IHUBs, system
jumps/kills, incursions) — built on top of public ESI endpoints, no auth
required.

## Stakeholders & users

- **Primary user:** Naval Defence Alliance leadership running buyback intake. Single-user
  desktop app; multi-user state lives in EVE/ESI and Janice, not locally.
- **Author:** SushiandSushi (`georgeatlumina` on GitHub).
- **Distribution:** signed-but-not-notarized macOS DMG and unsigned Windows
  NSIS installer via GitHub Releases. Auto-update polls the latest release on
  startup and offers to download/open the matching asset.

## Architecture in one paragraph

Electron shell hosts a single `BrowserWindow` loading static HTML/CSS/JS in
[renderer/](renderer/). On startup [electron/main.js](electron/main.js) spawns
a Python sidecar — in dev, `python3 python/server.py`; in production, a
PyInstaller-built `sidecar` binary bundled under `Resources/python-sidecar/`.
The sidecar is a FastAPI app on `localhost:8765`. The renderer talks to it
directly with `fetch()`; Electron only mediates a few side-channels (calculator
popout, Alliance Auth session). All EVE network IO happens server-side in
Python: ESI (auth, contracts, wallets, mail, structure markets), Janice
(appraisals), and Fuzzwork (refining material yields + market aggregates for
mineral pricing).

```
┌──────────────────┐    fetch()     ┌─────────────────────┐
│ renderer (HTML / │ ─────────────► │ FastAPI sidecar     │
│ vanilla JS)      │  localhost     │ (python/server.py)  │
└────────┬─────────┘     :8765      └──────────┬──────────┘
         │ IPC (preload.js)                    │ HTTPS
         ▼                                     ▼
┌──────────────────┐               ┌──────────────────────┐
│ electron/main.js │               │ ESI · Janice ·       │
│ (windowing,      │               │ Fuzzwork             │
│ AA session,      │               └──────────────────────┘
│ auto-update)     │
└──────────────────┘
```

## Key flows

### Authentication (EVE SSO PKCE-less, app-credential flow, multi-slot)

[python/auth.py](python/auth.py) implements EVE SSO with embedded app
credentials (`get_app_credentials`). The on-disk token cache is a dict keyed
by **slot name** (`slot1` / `slot2` / `slot3`) so up to three EVE characters
can be authenticated at once — slot1 is the primary (wallets, corp
contracts, mail), slots 2 & 3 are optional alts that widen Contracts-tab
visibility into other corps. Legacy single-record `tokens.json` shape
auto-migrates into `slot1` on first load (`_load_all_slots`).

`POST /api/auth/login?slot=slotN` returns a browser-bound authorize URL with
a one-shot state token; the state is keyed back to the slot in the
in-process `_auth_state['pending']` dict. EVE redirects to `GET /callback`
on the same sidecar port, which pops the slot out of the pending map,
exchanges the code for access/refresh tokens via `exchange_code_for_tokens`
and persists them under that slot key in `<userData>/eve_auth/tokens.json`
(chmod 600). `get_valid_access_token(slot=...)` auto-refreshes on every
protected call. `POST /api/auth/logout?slot=...` clears a single slot;
`GET /api/auth/slots` returns the per-slot status array used by the
Auth-tab UI.

### Buyback validation pipeline (`POST /api/validate` with `kind=buyback`)

Streamed as Server-Sent-Events from `_validate_stream` in
[python/server.py](python/server.py):

1. `fetch_corp_contracts` → all outstanding corp contracts.
2. `categorize` (validate.py) splits into courier / moon / buyback buckets.
3. Per buyback row: `validate_buyback_contract`
   - Title must contain a Janice URL.
   - `fetch_appraisal` re-runs the Janice link (RPC first, then API fallback).
   - Checks: market match, appraisal ≤ 90%, contract price within 1 ISK of
     `effective_offer`, and that the start_location_id sits in a configured
     structure whose `accepts` list contains the item category.
4. Results stream back per-contract; the renderer renders rows as they arrive
   and updates a progress bar.

### Moon contract processing (`POST /api/validate` with `kind=moon`)

1. `fetch_contract_items` for each moon contract.
2. `compute_refined_payout` (refining.py) buckets each item:
   - **Moon ore** (groups 1884/1920/1921/1922/1923) → refined at
     `moon_ore_refining_efficiency`, paid at `moon_payout_fraction` (default 80%).
   - **Non-moon ore** → refined at `non_moon_ore_refining_efficiency`, paid at
     `non_moon_payout_fraction` (default 90%).
   - **Ice** (group 465) → refined at `ice_refining_efficiency`, paid at the
     non-moon fraction.
   - **Prismaticite** (group 4915) → accepted but **flagged for manual payout**;
     the refining model doesn't fit it, so the app deliberately won't auto-price.
   - **Workforce reagents** (Magmatic Gas, Superionic Ice — category 2143) →
     accepted as **donation**, counted but priced at 0.
   - **Unrefinable leftovers** are priced at hub buy and rolled into their
     bucket's payout.
3. `process_moon_contract` (validate.py) wraps that, plus flags like
   `return_requested` (title contains the word "return"), `workforce_donation`,
   `prismaticite_manual`, and a `mineable_only` fail if any item falls outside
   the allowed categories.

### Doctrines & Market Readiness

[electron/main.js](electron/main.js) opens a separate `BrowserWindow` against
`auth.navaldefence.org` with a persistent session partition so login cookies
survive restarts. `ipcMain.handle('aa:fetch-html', ...)` lets the renderer
fetch arbitrary AA paths through that session; HTML parsing happens entirely
in [renderer/app.js](renderer/app.js) (`parseDoctrinesHtml`, `parseDoctrineDetail`,
`parseFitDetail`). `GET /api/aa/market/stream` (sidecar) returns a structure
market snapshot via `fetch_structure_orders_paged` — streamed because the EVE
structure-markets endpoint is paginated and slow. Readiness state persists in
localStorage so a fresh app launch can resume the previous scan.

### Contracts dashboard (`GET /api/contracts/scan`)

Streamed from `_scan_contracts_stream` in [python/server.py](python/server.py):

1. For each authenticated slot, resolve the toon's corp via
   `fetch_character_info` and call `fetch_corp_contracts` with that slot's
   token. Corps already covered by an earlier slot are skipped to avoid
   duplicate fetches. A 403 from one corp surfaces as a per-slot warning;
   the stream continues with the next slot.
2. Filter each corp's contracts: `type=item_exchange`, `status=outstanding`,
   `start_location_id == home_structure_id`, `for_corporation=True`,
   `issuer_corporation_id == that corp`. The `availability` field is
   **ignored** because corp-posted alliance fits in this dataset typically
   come back as `availability=personal` with `assignee_id=alliance_id`, not
   `availability=alliance`.
3. Dedupe by `contract_id`; remember which corp+token surfaced each one so
   item fetches don't mis-route.
4. `fetch_contract_items` per contract (cached by contract_id in
   `_contract_items_cache`); `resolve_names` bulk-resolves type and issuer
   names.
5. `_matches_quota` tallies each contract against each configured quota
   (match by ship `type_id` plus optional case-insensitive `title_filter`).
6. Emit one `done` event with `{structure_id, corps_scanned, contracts[],
   quotas[]}`. The UI renders per-quota progress bars (green/amber/red),
   and offers a gap-CSV download plus a clipboard shopping-list copy.

**The quota editor** in the Config tab is a spreadsheet-style table with
type-ahead dropdowns powered by `GET /api/universe/ships` —
`fetch_all_ship_types` walks ESI category 6 (Ship) once on first call
(~20s, ~50 ESI requests) and caches the resulting ~560-entry list to
`<userData>/eve_auth/ship_types.json`. Subsequent loads return from disk in
~70ms. The renderer mounts two `<datalist>`s (one keyed by `type_id`, one
keyed by name); picking from either column auto-fills the other.

**ESI limitation worth knowing.** ESI does NOT expose contracts that other
alliance corps post to "my alliance" availability — the in-game alliance
contracts tab uses CCP's non-ESI client API. So this scan sees only what
corps you hold a director / Contract Manager token for. Adding more slots
widens visibility one corp at a time.

## Data & persistence

Everything user-specific lives under `EVE_BUYBACK_DATA_DIR`:
- Packaged app: `<userData>/eve_auth/` (e.g. `~/Library/Application Support/Naval Defence Alliance Management Tool/eve_auth/` on macOS).
- Dev: `.eve_auth/` next to the repo root.

Files in that directory:
- `config.json` — chmod 600. Schema in [python/config.py](python/config.py)
  `DEFAULTS`. Old shapes are migrated forward by `_migrate` (note: migration
  runs **before** the `_USER_KEYS` filter in `load_config` so legacy keys
  like `home_station_id` → `home_structure_id` can be renamed without being
  silently dropped).
- `tokens.json` — chmod 600. ESI tokens, dict keyed by slot
  (`slot1`/`slot2`/`slot3`); see Authentication flow above.
- `ship_types.json` — flat list of every published EVE ship hull
  (`type_id`, `name`, `group_id`, `group_name`). Built once via
  `fetch_all_ship_types`; manually refresh by hitting
  `/api/universe/ships?refresh=true` (e.g. after an EVE expansion).
- `invTypeMaterials.csv` — Fuzzwork material dump, refreshed lazily.
- `sidecar.log` — last sidecar run's stdout/stderr (truncated each startup).

Readiness scan + selection toggles also persist, but in **renderer
localStorage** (`readinessState`), not on disk.

## Versioning & releases

- Single source of version truth: `package.json` `version`.
- Release tags are `vX.Y.Z`; release notes live on GitHub.
- Auto-update (`checkForUpdate` in main.js) hits
  `api.github.com/repos/{UPDATE_REPO}/releases/latest`, compares semvers, and
  downloads the platform-matched asset to a temp file then opens it.

## Notable design decisions

- **Vanilla JS in renderer.** No build step, no framework. ~2k LOC in one
  `app.js`; refactor only if it gets noticeably worse.
- **FastAPI over Flask.** Picked for `StreamingResponse` (SSE) and Pydantic
  request models — both load-bearing.
- **Python sidecar over native Node.** ESI/Janice integrations are easier in
  Python; refining math benefits from pandas-adjacent flows; CSV/bz2 ops are
  ergonomic. PyInstaller bundles it so end users never see Python.
- **Janice RPC first, API fallback.** RPC is anonymous and rate-limited;
  `_fetch_via_rpc` is tried first, falling back to `_fetch_via_api` if the
  user has provided an API key.
- **80% moon / 90% non-moon as defaults.** Corp policy. The split is
  user-tunable on the Config tab but the defaults match the alliance's posted
  buyback rules. See `MOON_ORE_PAYOUT_FRACTION` in
  [python/refining.py](python/refining.py).
- **Prismaticite accepted-but-flagged.** It can't be cleanly auto-priced.
  Accepting it and showing a banded "manual payout" border is intentional —
  see commits `ff5d245` / `22ab77b`.
- **`home_station_id` → `home_structure_id` (v1.0.0).** The Contracts-page
  location key was renamed because the filter has always been on ESI's
  generic `start_location_id`, which equally accepts NPC station IDs and
  player-structure (citadel) IDs. `_migrate` carries old values forward and
  `load_config` was reordered to migrate **before** filtering, so legacy
  keys aren't dropped on upgrade. Region ID stays in config for the NPC
  station lookup convenience but isn't required by the scan.
- **Contracts scan iterates per slot's corp, not slot1 only (v1.0.0).** ESI
  has no endpoint for "contracts visible in my alliance tab", so each
  director / Contract Manager token unlocks exactly one corp's postings.
  Multi-slot auth makes it possible to aggregate across several alliance
  corps if you can get tokens from each.

## Common entry points

- Start app: `npm start` (spawns sidecar via `python3 python/server.py`)
- Build mac DMG: `npm run build:mac`
- Build Windows installer: `npm run build:win`
- Sidecar directly: `python3 python/server.py` then hit `http://localhost:8765/api/health`
- Logs: `<userData>/sidecar.log`
