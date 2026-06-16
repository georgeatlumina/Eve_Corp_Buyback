# File Structure

Repo layout and what each directory/file is responsible for. For a
function-level index see [FUNCTIONS.md](FUNCTIONS.md). For higher-level
project context see [CONTEXT.md](CONTEXT.md).

## Top-level tree

```
Eve_Corp_Buyback/
├── electron/                   Electron main + preload (Node)
├── renderer/                   Static HTML/CSS/JS UI (no build step)
├── python/                     FastAPI sidecar (ESI, Janice, refining)
│   └── tests/                  pytest suite (Starlette TestClient)
├── tests/                      Jest test suite for renderer parse helpers
├── assets/                     Icons (PNG variants + ICO/ICNS)
├── build/                      Build artifacts (PyInstaller, electron-builder)
├── dist/                       Packaged installers (DMG / NSIS)
├── contracts.json              Sample contract payload (dev fixture)
├── package.json                npm + electron-builder config
├── package-lock.json
├── LICENSE
├── README.md                   User-facing docs (install, usage, config)
├── CONTEXT.md                  Architecture & decisions
├── STRUCTURE.md                You are here
└── FUNCTIONS.md                Function-level index
```

## `electron/` — Electron main process (Node)

Boots the desktop app, owns windows, spawns the Python sidecar, brokers the
small set of features the renderer can't do via plain `fetch()` (Alliance
Auth session, native windows, auto-update).

| File | Lines | Role |
|------|-------|------|
| [main.js](electron/main.js) | ~545 | App lifecycle, sidecar spawn (`startPythonSidecar`), **orphan-sidecar sweep** before spawn (`killOrphanSidecars` — `taskkill /F /IM sidecar.exe` on Windows, `pkill -x sidecar` on macOS/Linux), splash window with progress events (`createSplashWindow`/`emitSplash`), main window, calculator popout, Alliance Auth BrowserWindow + cookie-jar partition, GitHub-Releases **auto-update** (`checkForUpdate`) — runs at 2 s post-startup and then every hour, with `dismissedUpdateTag` dedupe + `updateDialogOpen` re-entry guard. |
| [preload.js](electron/preload.js) | ~12 | `contextBridge` exposing `window.api` with `openCalculator`, `aaOpen`, `aaLogout`, `aaFetchHtml`, `getMeta` (returns name+version for the title-bar version chip), and `checkForUpdate` (drives the manual ⟳ button — calls `checkForUpdate({interactive: true})` so up-to-date / error states each get a friendly dialog). |
| [splash-preload.js](electron/splash-preload.js) | ~10 | Bridges `splash:progress` events from main into the splash renderer's DOM. |
| [afterSign.js](electron/afterSign.js) | 21 | electron-builder hook; runs after code-signing during `npm run build:mac`. |

**Sidecar log:** `<userData>/sidecar.log` — truncated each startup, captures
stdout/stderr from the Python child.

## `renderer/` — UI (vanilla HTML/CSS/JS, no build step)

Loaded by `mainWindow.loadFile('renderer/index.html')`. No bundler, no
framework. All DOM updates are imperative.

| File | Lines | Role |
|------|-------|------|
| [index.html](renderer/index.html) | ~359 | Tab shell (Config / Auth / Buyback / Moon / **Working** / **Appraisal** / Mail / Doctrines / Readiness / Contracts / Sov), mail modal, calculator sidebar mount points (Moon + Working), Working-tab pin-card scaffold, Appraisal-tab paste box, quota editor table, multi-slot auth slots container, alliance-quota-sync fieldset (URL + Read PAT + Write PAT + Allow-push checkbox + Sync / Push buttons), backup-and-share fieldset (Export / Import config), outstanding-payout-total panels for Buyback and Moon. |
| [splash.html](renderer/splash.html) | ~139 | Borderless splash window shown while the Python sidecar boots; rendered via `splash-preload.js`. |
| [calculator.html](renderer/calculator.html) | 16 | Standalone calculator window template (popout target). |
| [app.js](renderer/app.js) | ~4216 | **Everything else.** Config form ↔ sidecar, multi-slot auth UI, SSE/NDJSON consumption for `/api/validate`, `/api/aa/market/stream`, `/api/contracts/scan`, buyback + moon row rendering with **outstanding-payout totals** (`renderPayoutTotal` / `_rowAcceptValue`), Working tab (`runPinAppraisal`, `renderPinDetail`, calculator mount), Appraisal tab (Janice routing + Buy/Split/Sell columns + percentage chip rows), mail template engine, AA HTML scraping, doctrine + fit rendering, readiness dashboard, Contracts dashboard with quota progress bars + CSV/JSON quota import-export + ship-type datalist + gap-CSV / shopping-list exports, alliance-quota-sync handlers (`runQuotaSync` / `runQuotaPush` / `updatePushButtonVisibility`) including the gist-URL fallback path that's no longer surfaced in the UI, whole-config export/import gated by `CONFIG_EXPORT_NEVER` (which now hard-strips Write PAT + Allow-push). |
| [parse-utils.js](renderer/parse-utils.js) | 124 | Pure functions for HTML scraping + formatting (`extractTypeId`, `parseDoctrinesHtml`, `parseDoctrineDetail`, `parseFitDetail`, `fmtIsk`, `fmtMillions`). Loaded by `index.html` before `app.js`. CommonJS-exported at the bottom so [tests/parse-utils.test.js](tests/parse-utils.test.js) can require it from Jest. |
| [calculator.js](renderer/calculator.js) | 211 | Self-contained numpad calculator with 70/80/90% copy-to-clipboard buttons; mounted both inline (Moon + Working tab sidebars, independent instances) and in the popout window. |
| [hooks-hubs-utils.js](renderer/hooks-hubs-utils.js) | ~130 | Pure `computePlan(plan)` for the Hooks & Hubs planner — per-system power/workforce balances + feasibility (power local/non-transferable; workforce transferable). CommonJS-exported for [tests/hooks-hubs-utils.test.js](tests/hooks-hubs-utils.test.js). Loaded before `app.js`. |
| [market.js](renderer/market.js) | ~320 | Market analytics tab, loaded **after** `app.js` (reuses its `$`/`$$`/`API`/`formatIsk`/`escapeHtml`/`readNdjson` globals — kept out of `app.js` on purpose). Consumes `/api/market/analytics/stream`, renders tiles + a column-driven sortable/searchable/filterable table, the **doctrine lens** (quantity-aware shortfall read from the Readiness scan in localStorage), the opportunistic daily archive call (`/api/market/history/archive`), and the **turnover** cards (24h/72h/weekly/monthly net on-book change from `/api/market/history/turnover`, degrading gracefully until daily snapshots accrue). Lazy-loads on first tab click. |
| [hooks-hubs.js](renderer/hooks-hubs.js) | ~430 | Hooks & Hubs tab logic, loaded **after** `app.js` (reuses its `$`/`$$`/`API`/`escapeHtml` globals). Fuel dashboard (fetch `/api/structures/fuel`, overview tiles + per-structure time-remaining tables) and the manual upgrade/workforce planner (editable systems/transfers/catalog tables, live `computePlan` feasibility, save/reload to `/api/workforce-plan`). Lazy-loads on first tab click. |
| [styles.css](renderer/styles.css) | ~589 | Dark theme, tab styles, table layouts, progress bars, modal, auth-slot cards, quota table, contracts dashboard quota bars, Working-tab pin cards, Appraisal tab three-column price tiles + percentage chips, alliance-quota-sync row + PAT-row + push button, outstanding-payout-total panel, splash. |

**State lives in `app.js` module-level lets:** `lastResults` (buyback +
moon), `walletData`, `aaState`, `readinessState`, `mailPresets`,
`lastContractsScan`, `shipTypesCache` / `shipTypesByIdMap` /
`shipTypesByNameMap`, `workingState` (pinned-contract list + expanded
ids + filter), `appraisalState` (last paste + last result), and the
auto-sync re-entry guards (`allianceQuotaAutoSyncDone`). No global store
beyond that. `readinessState` is the only chunk persisted to
`localStorage`; pins, ship types, and all other state hydrate from the
sidecar on tab open.

## `python/` — FastAPI sidecar

Bound to `localhost:8765`. Started as `python3 python/server.py` in dev or
as a PyInstaller binary in packaged builds. All external HTTP (ESI, Janice,
GitHub Contents API) goes through here.

| File | Lines | Role |
|------|-------|------|
| [server.py](python/server.py) | ~2007 | FastAPI app, all routes, NDJSON streaming for validate / AA market / contracts scan, EVE SSO callback page, sov overview aggregator, multi-slot auth handlers, ship-type cache, region-from-station lookup, **Working-tab pin CRUD + per-pin appraise** endpoint, **Appraisal-tab Janice** endpoint, **alliance-quota sync + push** endpoints (Contents API + gist fallback), **Amarr sell price** lookup, **Hooks & Hubs structure-fuel** aggregator + **workforce-plan** CRUD. |
| [auth.py](python/auth.py) | 153 | EVE SSO authorize URL, code↔token exchange, refresh. Multi-slot token cache (dict keyed `slot1`/`slot2`/`slot3`; chmod 600). JWT payload decoder + `character_id_from_access_token`. Legacy single-record shape auto-migrates into slot1. |
| [config.py](python/config.py) | 152 | Config schema + defaults (incl. `home_structure_id`, `home_region_id`, `quotas`, the alliance-quota sync triplet, the on-disk last-sync metadata). JSON load/save (chmod 600), legacy-shape migration (`_migrate`). `load_config` runs `_migrate` **before** filtering by `_USER_KEYS` so renamed keys aren't dropped. |
| [esi.py](python/esi.py) | 482 | Thin ESI wrappers: `resolve_names`, `send_evemail`, `fetch_corp_wallets`, `fetch_corp_contracts`, `fetch_contract_items`, character contracts (`fetch_character_contracts` / `_items`), public contracts (`fetch_public_contracts_paged` / `_items`), universe lookups (`fetch_type_info`, `fetch_group_info`, `fetch_category_info`, `fetch_station/system/constellation/region_info`, `fetch_character/corporation/alliance_info`), structure markets (paged + non-paged), regional market orders (`fetch_region_market_orders`), sov endpoints (`fetch_sovereignty_structures/map/campaigns`, `fetch_system_kills/jumps`, `fetch_incursions`), and the bulk `fetch_all_ship_types` (walks category 6). |
| [janice.py](python/janice.py) | 270 | Janice integration: appraisal fetch (RPC-first, API fallback), appraisal creation from items (`create_appraisal`) and from raw paste text (`create_appraisal_from_text`, used by the Working tab and Appraisal tab — `persist=True` so the returned code is shareable). New: `fetch_type_sell_price` for the Amarr-pricing endpoint added by PR #3. `_normalize` is the single source of truth for the response shape. |
| [market.py](python/market.py) | ~150 | Item metadata for the Market tab: resolves `type_id → {name, group, category}` from ESI (`fetch_type_info`→group→category, concurrent + deduped) and caches it to `type_meta.json`. Replaces the dead Fuzzwork CSV approach. `enrich` / `resolve` / `missing_ids`. |
| [pinned.py](python/pinned.py) | 156 | On-disk pin storage for the Working tab. `load_pinned` / `save_pinned` / `upsert_pin` / `remove_pin` / `update_pin_fields` (notes + status) / `append_appraisal` (bounded ring of 20 per pin). `_blended_fraction_from_snapshot` derives the payout fraction once at pin time so re-appraisals use the same effective rate regardless of the original moon/non-moon mix. |
| [refining.py](python/refining.py) | ~330 | Type classification (`is_mineable`, `is_moon_ore`, `is_ice`, `is_prismaticite`, `is_donation`, **`is_refined_output`**), the **bundled** yields loader (`data/mineable_type_materials.csv`, cerlestes-verified — no Fuzzwork), and the core `compute_refined_payout` that produces the moon-contract payout (refined minerals priced via **Janice**; **leftover/sub-portion value is excluded** from payout). |
| [validate.py](python/validate.py) | 170 | `categorize` (courier/moon/buyback split), `validate_buyback_contract`, `process_moon_contract`, `validate_all`. Pure logic, no IO except via injected `payout_lookup`. |
| [workforce_plan.py](python/workforce_plan.py) | ~110 | On-disk storage for the Hooks & Hubs planner — `load_plan` / `save_plan` (JSON at `<AUTH_DIR>/workforce_plan.json`, chmod 600, corrupt-tolerant `_normalize`). Pure persistence; all scenario math lives client-side. Data is manual (Equinox power/workforce/upgrades aren't in ESI). |
| [tests/test_market.py](python/tests/test_market.py) | 145 | pytest suite for `fetch_region_market_orders` + the `/api/market/amarr-sell` endpoint (PR #3). Uses `fastapi.testclient.TestClient`, which requires `httpx` (not currently in `requirements.txt` — install separately for local test runs). 12 tests; all pass. |
| [requirements.txt](python/requirements.txt) | — | `fastapi`, `uvicorn`, `pydantic`, `requests`. |
| [sidecar.spec](python/sidecar.spec) | — | PyInstaller spec for the bundled binary. Lists `pinned`, `janice`, `market`, `auth`, `config`, `esi`, `refining`, `validate` in `hiddenimports` belt-and-braces — they're already reachable from `server.py` but Windows PyInstaller has been observed to miss top-level imports declared mid-file. |

**Caches & state on disk** (under `EVE_BUYBACK_DATA_DIR`, typically
`<userData>/eve_auth/`):
- `config.json` — user settings (chmod 600). Includes the alliance-quota
  triplet (`alliance_quota_url` + Read PAT + Write PAT + `allow_push`) and
  the on-disk last-sync metadata.
- `tokens.json` — ESI tokens, dict keyed by slot (chmod 600).
- `pinned_contracts.json` — Working-tab pinned moon-result snapshots
  (chmod 600). Schema in [python/pinned.py](python/pinned.py).
- `ship_types.json` — every published ship hull `{type_id, name, group_id,
  group_name}`. Built on first hit to `/api/universe/ships`; refresh via
  `?refresh=true`.
- `invTypeMaterials.csv` — Fuzzwork dump, lazy-loaded once per process. (Upstream URL now 404s — see CONTEXT.md.)
- `type_meta.json` — `type_id → {name, group_id, group_name, category_id,
  category_name}` for the Market tab; filled lazily from ESI, chmod 600.
- `market-history/` lives in the **dedicated GitHub repo** (not on disk): one
  gzipped full-depth snapshot per day, pushed by `/api/market/history/archive`.

## `tests/` — Jest suite for the renderer

| File | Lines | Role |
|------|-------|------|
| [parse-utils.test.js](tests/parse-utils.test.js) | 188 | 21 tests covering `extractTypeId`, `parseDoctrinesHtml`, `parseDoctrineDetail`, `parseFitDetail`, `fmtIsk`, and `fmtMillions`. Run via `npm test` (`jest` is a devDependency). |

## `assets/`

App icon in several sizes — `icon.png` (used by electron-builder + window
icon), `icon-128.png` (favicon for renderer HTML), plus ICO/ICNS variants for
the packaged installers.

## `build/` and `dist/`

Generated artifacts — both gitignored.
- `build/python-sidecar/` is electron-builder's `extraResources` source for
  the bundled Python binary.
- `build/pyinstaller-work/` is PyInstaller's intermediate workdir.
- `dist/` holds the packaged DMG (mac) and NSIS installer (Windows).

## Tracked-but-loose files

- [contracts.json](contracts.json) — sample contract response, useful as a
  fixture when iterating on `validate.py` without hitting ESI.
- [LICENSE](LICENSE) — repo license.

## Boundaries that matter

- **Renderer → sidecar:** direct `fetch('http://localhost:8765/...')`. No
  IPC. Means the renderer can be opened in any browser (e.g. for debugging)
  if the sidecar is running.
- **Renderer → main process:** only via `window.api` (defined in
  [preload.js](electron/preload.js)). If you need a new IPC channel, add it
  to **both** `preload.js` and `main.js`.
- **Sidecar → outside world:** all HTTP via `requests`; user-agent is built
  in `auth.get_user_agent()` and reused.
- **PyInstaller bundle boundary:** any Python file added to the project must
  be reachable from `server.py`'s imports for PyInstaller to pick it up;
  alternatively add it to [sidecar.spec](python/sidecar.spec).
