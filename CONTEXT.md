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

A secondary feature scans corp doctrines from Alliance Auth (`auth.navaldefence.org`)
and cross-references each fit against the corp market for stocking gaps.

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

### Authentication (EVE SSO PKCE-less, app-credential flow)

[python/auth.py](python/auth.py) implements EVE SSO with embedded app
credentials (`get_app_credentials`). `POST /api/auth/login` returns a
browser-bound authorize URL with a one-shot state token; EVE redirects to
`GET /callback` on the same sidecar port, which exchanges the code for
access/refresh tokens via `exchange_code_for_tokens` and persists them to
`<userData>/eve_auth/tokens.json` (chmod 600). `get_valid_access_token`
auto-refreshes on every protected call.

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

## Data & persistence

Everything user-specific lives under `EVE_BUYBACK_DATA_DIR`:
- Packaged app: `<userData>/eve_auth/` (e.g. `~/Library/Application Support/Naval Defence Alliance Management Tool/eve_auth/` on macOS).
- Dev: `.eve_auth/` next to the repo root.

Files in that directory:
- `config.json` — chmod 600. Schema in [python/config.py](python/config.py)
  `DEFAULTS`. Old shapes are migrated forward by `_migrate`.
- `tokens.json` — chmod 600. ESI access/refresh tokens.
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

## Common entry points

- Start app: `npm start` (spawns sidecar via `python3 python/server.py`)
- Build mac DMG: `npm run build:mac`
- Build Windows installer: `npm run build:win`
- Sidecar directly: `python3 python/server.py` then hit `http://localhost:8765/api/health`
- Logs: `<userData>/sidecar.log`
