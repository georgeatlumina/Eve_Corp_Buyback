# Function Index

Function-level map of the codebase. Grouped by file in the order you'd most
likely traverse them: sidecar (server → validate → refining → esi/janice/auth/config),
then Electron main, then renderer JS.

For higher-level context see [CONTEXT.md](CONTEXT.md). For the file layout see
[STRUCTURE.md](STRUCTURE.md).

Format: clickable file link, then a table or list of names with line numbers
and a one-line description.

---

## `python/server.py` — FastAPI sidecar entrypoint (576 LOC)

[python/server.py](python/server.py)

### Routes

| Method+Path | Handler | Line | Purpose |
|---|---|---|---|
| `GET /api/health` | `health` | [62](python/server.py#L62) | Liveness probe used by `waitForSidecar`. |
| `GET /api/config` | `get_config` | [67](python/server.py#L67) | Return merged config (defaults + saved). |
| `POST /api/config` | `update_config` | [87](python/server.py#L87) | Partial-update saved config; pydantic `ConfigUpdate` filters keys. |
| `GET /api/markets` | `list_markets` | [96](python/server.py#L96) | Return supported Janice market names. |
| `GET /api/auth/status` | `auth_status` | [102](python/server.py#L102) | Cached-token → character name; refreshes if near expiry. |
| `POST /api/auth/login` | `auth_login` | [126](python/server.py#L126) | Build SSO authorize URL + state; opens system browser. |
| `GET /callback` | `sso_callback` | [141](python/server.py#L141) | EVE SSO redirect target; exchanges code for tokens. |
| `POST /api/mail/send` | `send_mail` | [174](python/server.py#L174) | ESI evemail send (requires `esi-mail.send_mail.v1`). |
| `GET /api/wallets` | `get_wallets` | [217](python/server.py#L217) | All 7 corp wallet divisions + total. |
| `POST /api/contracts/fetch` | `fetch_contracts` | [232](python/server.py#L232) | Raw corp contracts (used to preview before validation). |
| `POST /api/validate` | `validate` | [256](python/server.py#L256) | NDJSON-streamed buyback + moon validation. |
| `GET /api/aa/market` | `get_aa_market` | [470](python/server.py#L470) | One-shot structure market snapshot (cached 5 min). |
| `GET /api/aa/market/stream` | `stream_aa_market` | [565](python/server.py#L565) | NDJSON-streamed page-by-page market fetch. |

### Helpers / internals

- `_callback_page(msg)` — [54](python/server.py#L54) — minimal dark-themed HTML for the SSO landing tab.
- `ConfigUpdate` *(pydantic)* — [71](python/server.py#L71) — accepted config keys; unknown keys dropped.
- `SendMailRequest` *(pydantic)* — [167](python/server.py#L167) — recipient/subject/body.
- `ValidateRequest` *(pydantic)* — [245](python/server.py#L245) — optional pre-supplied `contracts`.
- `_emit(event_type, **data)` — [249](python/server.py#L249) — encodes one NDJSON line for streams.
- `_validate_stream(cfg, req)` — [266](python/server.py#L266) — **core pipeline.** Fetches contracts, categorises, resolves issuer names, walks buyback then moon contracts, emits `progress`/`buyback_result`/`moon_result`/`done`/`error`. Constructs an inline `payout_lookup` closure that calls `compute_refined_payout`.
- `_summarize_orders(structure_id, orders, fetched_at)` — [447](python/server.py#L447) — fold raw structure orders → `{type_id: {min_price, total_volume, order_count}}`.
- `_resolve_market_structure_id(cfg, structure_id)` — [508](python/server.py#L508) — falls back to first configured structure when caller doesn't pass an explicit id.
- `_market_stream(structure_id, refresh)` — [521](python/server.py#L521) — generator for `stream_aa_market`; reuses the in-memory cache when fresh.

---

## `python/validate.py` — pure contract logic (170 LOC)

[python/validate.py](python/validate.py)

- `filter_contracts(contracts, **conditions)` — [6](python/validate.py#L6) — predicate-AND filter.
- `categorize(contracts, corp_id)` — [10](python/validate.py#L10) — split outstanding contracts into `courier` / `moon` / `buyback`. Moon = `item_exchange` + `price=0`.
- `_category(items)` — [26](python/validate.py#L26) — `'ore'` if any item flagged `is_ore`, else `'non-ore'`.
- `validate_buyback_contract(contract, structures, janice_market, janice_api_key)` — [30](python/validate.py#L30) — runs the four checks (`janice_url`, `appraisal_fetch`, `market`, `appraisal_percentage`, `price`, `location`) and returns a result dict with `checks` map + `appraisal` block.
- `process_moon_contract(contract, structures, payout_lookup)` — [107](python/validate.py#L107) — calls injected `payout_lookup`, surfaces flags (`return_requested`, `workforce_donation`, `prismaticite_manual`), fails `mineable_only` if non-ore/ice/reagent items present.
- `validate_all(contracts, corp_id, structures, janice_market, janice_api_key, moon_payout_lookup)` — [146](python/validate.py#L146) — non-streaming variant (used in tests / scripts). Returns `{summary, buyback_results, moon_results}`.

---

## `python/refining.py` — refining math + classification (325 LOC)

[python/refining.py](python/refining.py)

### Type classification (ESI-backed, cached)

- `is_mineable(type_id, user_agent)` — [29](python/refining.py#L29) — true for any item allowed in a moon contract (ore / moon ore / ice / reagent / Prismaticite).
- `is_prismaticite(type_id, user_agent)` — [43](python/refining.py#L43) — group `4915`; accepted but flagged for manual payout.
- `is_ice(type_id, user_agent)` — [51](python/refining.py#L51) — group `465`.
- `is_moon_ore(type_id, user_agent)` — [59](python/refining.py#L59) — groups `1884/1920/1921/1922/1923` (R4–R64).
- `is_donation(type_id, user_agent)` — [67](python/refining.py#L67) — category `2143` (Magmatic Gas, Superionic Ice). Counted but priced at 0.

### Data + pricing

- `_load_materials()` — [95](python/refining.py#L95) — lazy + thread-safe load of Fuzzwork `invTypeMaterials.csv` into a `type_id → [(material_type_id, qty), ...]` map. Downloaded once into `AUTH_DIR`.
- `is_refinable(type_id)` — [120](python/refining.py#L120) — has at least one material row in the Fuzzwork dump.
- `yields_for(type_id, quantity, user_agent)` — [125](python/refining.py#L125) — multiplies materials by `portion_size`-aligned batches; returns `(yields, leftover_qty)`.
- `fetch_buy_prices(station_id, type_ids, user_agent)` — [141](python/refining.py#L141) — Fuzzwork market aggregates → `{type_id: max_buy_price}`.

### Payout

- `compute_refined_payout(items, hub_name, moon_ore_eff, non_moon_ore_eff, ice_eff, non_moon_payout_fraction, user_agent, moon_payout_fraction=0.80)` — [165](python/refining.py#L165) — **the core payout computation.** Buckets each item (moon ore / non-moon ore / ice / leftover / donation / prismaticite), applies its bucket's refining yield, prices the result, applies the bucket's payout fraction, and returns a `{refined_value, moon_value, non_moon_value, leftover_value, recommended_payout, breakdown, leftover_breakdown, donation_breakdown, prismaticite_breakdown, ...}` block.

Module constants worth knowing: `ALLOWED_CATEGORY_IDS = {25, 2143}`, `ICE_GROUP_ID = 465`, `MOON_ORE_GROUP_IDS = {1884, 1920, 1921, 1922, 1923}`, `PRISMATICITE_GROUP_ID = 4915`, `MOON_ORE_PAYOUT_FRACTION = 0.80`, `HUBS = {'Jita 4-4': 60003760, 'Amarr': 60008494, 'Dodixie': 60011866, 'Rens': 60004588}`.

---

## `python/esi.py` — ESI wrappers (303 LOC)

[python/esi.py](python/esi.py)

| Function | Line | Purpose |
|---|---|---|
| `resolve_names(ids, user_agent)` | [6](python/esi.py#L6) | Bulk ID→name via `POST /universe/names/` (1000-id chunks). |
| `send_evemail(character_id, recipient_id, subject, body, access_token, user_agent)` | [29](python/esi.py#L29) | Single-recipient mail send; surfaces ESI error body. |
| `fetch_corp_wallets(corp_id, access_token, user_agent)` | [61](python/esi.py#L61) | Seven-division corp wallet balances. |
| `fetch_contract_items(corp_id, contract_id, access_token, user_agent)` | [72](python/esi.py#L72) | Items in one corp contract. |
| `fetch_type_info(type_id, user_agent)` | [88](python/esi.py#L88) | Type metadata, in-process cached (`_TYPE_INFO_CACHE`). |
| `fetch_group_info(group_id, user_agent)` | [104](python/esi.py#L104) | Group metadata, in-process cached (`_GROUP_INFO_CACHE`). |
| `fetch_structure_orders_paged(structure_id, access_token, user_agent)` | [120](python/esi.py#L120) | **Generator** yielding `(page, max_pages, batch)`. Used for SSE progress. |
| `fetch_structure_orders(structure_id, access_token, user_agent)` | [149](python/esi.py#L149) | Convenience wrapper that consumes the generator. |
| `fetch_corp_contracts(corp_id, access_token, user_agent)` | [157](python/esi.py#L157) | Paginated corp contracts. |
| `fetch_public_contracts_paged(region_id, user_agent)` | [182](python/esi.py#L182) | Generator over public contracts in a region. |
| `fetch_public_contract_items(contract_id, user_agent)` | [210](python/esi.py#L210) | Items for a public contract. |
| `fetch_character_contracts(character_id, access_token, user_agent)` | [235](python/esi.py#L235) | Personal contracts visible to a character. |
| `fetch_character_contract_items(character_id, contract_id, access_token, user_agent)` | [260](python/esi.py#L260) | Items for one character-visible contract. |
| `fetch_station_info(station_id, user_agent)` | [274](python/esi.py#L274) | NPC station lookup (→ derive region_id). |
| `fetch_system_info(system_id, user_agent)` | [285](python/esi.py#L285) | System metadata. |
| `fetch_constellation_info(constellation_id, user_agent)` | [295](python/esi.py#L295) | Constellation metadata. |

---

## `python/janice.py` — Janice integration (211 LOC)

[python/janice.py](python/janice.py)

| Function | Line | Purpose |
|---|---|---|
| `extract_code(url)` | [21](python/janice.py#L21) | Pull the appraisal code from `/a/<code>` URLs. |
| `fetch_appraisal(url, api_key=None)` | [27](python/janice.py#L27) | Main entrypoint. Tries `_fetch_via_api` if key set, falls back to `_fetch_via_rpc`. |
| `_fetch_via_rpc(code)` | [49](python/janice.py#L49) | Anonymous RPC fetch with sensible error mapping (RecordNotFound → user-friendly). |
| `_fetch_via_api(code, api_key)` | [76](python/janice.py#L76) | Authenticated REST API fetch. |
| `_normalize(code, data, source)` | [83](python/janice.py#L83) | Map raw Janice response → `{percentage, effective_offer, total_buy_price, market_name, items, source, raw}` consumed by `validate.py`. **Single source of truth for the appraisal shape.** |
| `create_appraisal(items, market_name, api_key=None)` | [128](python/janice.py#L128) | Build a new appraisal from a list of `{name, quantity}` items. Used for moon Janice references. |
| `_create_via_rpc(input_text, market_id)` | [162](python/janice.py#L162) | Anonymous appraisal-create. |
| `_create_via_api(input_text, market_id, api_key)` | [190](python/janice.py#L190) | Authenticated appraisal-create. |

Constants: `BUYBACK_PERCENTAGE = 0.90`, `JANICE_MARKET_IDS = {Jita 4-4: 2, Amarr: 115, Dodixie: 117, Rens: 116, Hek: 118}`.

---

## `python/auth.py` — EVE SSO (154 LOC)

[python/auth.py](python/auth.py)

| Function | Line | Purpose |
|---|---|---|
| `get_app_credentials()` | [22](python/auth.py#L22) | Return embedded `(CLIENT_ID, SECRET_KEY)`. |
| `get_user_agent()` | [26](python/auth.py#L26) | Build the `EveCorpBuyback/1.0 (...)` UA string. |
| `build_authorize_url(client_id, redirect_uri, scopes, state)` | [33](python/auth.py#L33) | Compose the SSO authorize URL. |
| `_post_token(client_id, secret_key, user_agent, data)` | [44](python/auth.py#L44) | Shared form-POST helper to `/v2/oauth/token`. |
| `exchange_code_for_tokens(client_id, secret_key, code, user_agent)` | [60](python/auth.py#L60) | `authorization_code` grant. |
| `refresh_access_token(client_id, secret_key, refresh_token, user_agent)` | [67](python/auth.py#L67) | `refresh_token` grant. |
| `_load_all_slots()` | [74](python/auth.py#L74) | Read token cache; migrates legacy single-record shape into `slot1`. |
| `_write_all_slots(slots)` | [93](python/auth.py#L93) | Persist token cache (chmod 600). |
| `load_cached_tokens(slot='slot1')` | [100](python/auth.py#L100) | Read tokens for a slot. |
| `save_cached_tokens(tokens, slot='slot1')` | [106](python/auth.py#L106) | Persist tokens, stamping `expires_at`. |
| `clear_cached_tokens(slot='slot1')` | [114](python/auth.py#L114) | Remove tokens for a slot. |
| `list_authenticated_slots()` | [121](python/auth.py#L121) | Return slot names with cached tokens. |
| `get_valid_access_token(client_id, secret_key, user_agent, slot='slot1')` | [127](python/auth.py#L127) | Return access token, refreshing automatically when within 30s of expiry. |
| `decode_jwt_payload(jwt_token)` | [141](python/auth.py#L141) | Base64-decode the JWT middle segment to dict. |
| `character_id_from_access_token(access_token)` | [147](python/auth.py#L147) | Pull integer character id out of the JWT `sub`. |

---

## `python/config.py` — settings persistence (119 LOC)

[python/config.py](python/config.py)

- `_fresh_default()` — [57](python/config.py#L57) — deep copy of the `DEFAULTS` dict (so structures/mail_presets don't share references).
- `_migrate(cfg)` — [65](python/config.py#L65) — bring older config shapes forward (old dict-shaped structures → list shape; ensure baseline scopes; split legacy single `refining_efficiency`).
- `load_config()` — [102](python/config.py#L102) — read+migrate+merge over defaults.
- `save_config(cfg)` — [114](python/config.py#L114) — filter to known keys, persist chmod 600.

Module-level: `AUTH_DIR` (from `EVE_BUYBACK_DATA_DIR` env or `.eve_auth/` next to repo), `DEFAULT_STRUCTURES`, `JANICE_MARKETS`, `DEFAULT_MAIL_PRESETS`, `DEFAULTS`.

---

## `electron/main.js` — Electron main process (353 LOC)

[electron/main.js](electron/main.js)

### Lifecycle / sidecar

- `ensureLogPath()` — [18](electron/main.js#L18) — lazy-init `<userData>/sidecar.log`.
- `logSidecar(line)` — [28](electron/main.js#L28) — timestamped append + mirror to stdout.
- `startPythonSidecar()` — [37](electron/main.js#L37) — spawn the dev `python3 server.py` or the packaged `sidecar` binary; pipe stdout/stderr into the log.
- `waitForSidecar()` — [87](electron/main.js#L87) — poll `/api/health` for 30s.

### Windowing

- `createWindow()` — [101](electron/main.js#L101) — main 1100×800 window, loads `renderer/index.html`.
- `openCalculatorWindow()` — [116](electron/main.js#L116) — 280×470 always-on-top calculator popout.
- `openAaWindow()` — [147](electron/main.js#L147) — Alliance Auth browser, partitioned `persist:aa-auth` session.

### IPC handlers (registered to `ipcMain.handle`)

| Channel | Line | Purpose |
|---|---|---|
| `open-calculator` | [143](electron/main.js#L143) | Open the calculator popout. |
| `aa:open` | [173](electron/main.js#L173) | Open AA window. |
| `aa:logout` | [177](electron/main.js#L177) | Clear AA session storage + close window. |
| `aa:fetch-html` | [183](electron/main.js#L183) | Fetch an AA path through the partitioned session; returns `{ok, status, finalUrl, html}`. |

### Auto-update (GitHub Releases)

- `checkForUpdate()` — [214](electron/main.js#L214) — query latest release, compare semver, prompt to download.
- `pickPlatformAsset(assets)` — [280](electron/main.js#L280) — pick the right `.dmg` / `.exe` for the host platform.
- `httpsGetJson(url, redirects)` — [290](electron/main.js#L290) — minimal redirect-following JSON GET.
- `downloadToFile(url, destPath, redirects)` — [312](electron/main.js#L312) — stream-to-disk with redirect handling.
- `compareSemver(a, b)` — [335](electron/main.js#L335) — numeric semver comparator.

---

## `electron/preload.js` — context-bridge surface (9 LOC)

[electron/preload.js](electron/preload.js)

Exposes one global: `window.api` with `openCalculator`, `aaOpen`, `aaLogout`,
`aaFetchHtml`. **This is the renderer's only IPC surface** — anything else
goes through `fetch()` to the sidecar.

---

## `electron/afterSign.js` — electron-builder hook (21 LOC)

[electron/afterSign.js](electron/afterSign.js)

Runs after code-signing during `npm run build:mac`; placeholder for future
notarization.

---

## `renderer/app.js` — UI logic (2143 LOC, vanilla JS)

[renderer/app.js](renderer/app.js)

State lives in module-level lets near the top: `cfg`, `walletData`,
`buybackResults`, `moonResults`, `aaState`, `readinessState`.

### Helpers + result classification

- `$ / $$` — [2-3](renderer/app.js#L2) — `document.querySelector` shortcuts.
- `classifyResult(r)` — [31](renderer/app.js#L31) — `approve | reject | error` from a result's `checks` map.
- `applyFilter(list, filter)` — [42](renderer/app.js#L42) — filter buyback/moon rows by the active tab pill.

### Config tab

- `loadConfig()` — [71](renderer/app.js#L71) — fetch `/api/config`, populate form.
- `fillMarket(selector, markets, current)` — [127](renderer/app.js#L127) — fill `<select>` options.
- `renderStructures(list)` — [139](renderer/app.js#L139) — render structure-row editors.
- `structureRow(s)` — [146](renderer/app.js#L146) — HTML for one structure row.
- `collectStructures()` — [162](renderer/app.js#L162) — read editor → JSON.

### Auth tab

- `refreshAuthStatus()` — [372](renderer/app.js#L372) — poll `/api/auth/status`, render character/expiry.
- (No standalone login fn; the login button calls `/api/auth/login` inline and then polls `refreshAuthStatus` until `completed`.)

### Validation streaming

- `runValidateStream()` — [414](renderer/app.js#L414) — POST `/api/validate`, consume NDJSON lines.
- `handleStreamEvent(ev)` — [463](renderer/app.js#L463) — switch over event type (`start | progress | buyback_result | moon_result | done | error`).
- `showProgress(kind, current, total)` — [509](renderer/app.js#L509) — update buyback/moon progress bar.
- `hideProgress(kind)` — [516](renderer/app.js#L516).
- `setStep(kind, step)` — [520](renderer/app.js#L520) — update the progress step label.
- `appendResultIfMatch(kind, result)` — [525](renderer/app.js#L525) — append a row when its result's class matches the active filter.
- `renderItemsTable(items, columns)` — [537](renderer/app.js#L537) — generic items `<table>` renderer.

### Wallets

- `refreshWallets()` — [555](renderer/app.js#L555) — `GET /api/wallets`, render tiles in both buyback & moon tabs.
- `renderWalletTiles(root, data, highlightDivision)` — [582](renderer/app.js#L582).

### Buyback tab

- `renderBuyback()` — [598](renderer/app.js#L598) — render all buyback rows respecting filter.
- `buildBuybackRow(r)` — [609](renderer/app.js#L609) — HTML for one buyback row.
- `escapeHtml(s)` — [652](renderer/app.js#L652) — *(also redefined at 906)*.

### Moon tab

- `renderMoonTab()` — [204](renderer/app.js#L204) — render all moon rows.
- `buildMoonRow(r)` — [215](renderer/app.js#L215) — moon row with Janice + refined blocks, donation/prismaticite badges, flags.
- `escapeAttr(s)` — [366](renderer/app.js#L366) — attribute-safe escape.
- `extractTypeId(src)` — [910](renderer/app.js#L910) — pull a `type_id` out of an EVE image-server URL.
- `initMoonCalculator()` — [858](renderer/app.js#L858) — bind sidebar calculator + popout button.

### Mail tab + modal

- `renderMailPresetEditors()` — [660](renderer/app.js#L660) — render the four preset editors.
- `buildMailButtonsRow(contract, kind)` — [706](renderer/app.js#L706) — HTML for per-contract preset buttons.
- `renderMailTemplate(template, contract, kind)` — [719](renderer/app.js#L719) — substitute `{vars}` for a specific contract.
- `openMailModal(contract, kind, presetIdx)` — [767](renderer/app.js#L767) — preview-and-send modal.
- `closeMailModal()` — [783](renderer/app.js#L783).

### Doctrines (Alliance Auth)

- `refreshAllMarketViews()` — [928](renderer/app.js#L928) — re-render readiness when market refreshes.
- `loadMarket(refresh=false)` — [935](renderer/app.js#L935) — consume `/api/aa/market/stream` (NDJSON).
- `renderMarketProgress()` — [991](renderer/app.js#L991) — paging progress UI.
- `formatIsk(n)` — [1005](renderer/app.js#L1005) — `1.23B` / `45.6M` formatting.
- `computeFitAvailability(fitItems, market)` — [1014](renderer/app.js#L1014) — per-item availability vs. market.
- `parseDoctrinesHtml(html)` — [1031](renderer/app.js#L1031) — scrape doctrine list.
- `parseDoctrineDetail(html)` — [1058](renderer/app.js#L1058) — scrape one doctrine's fits.
- `parseFitDetail(html)` — [1086](renderer/app.js#L1086) — scrape one fit's items.
- `renderDoctrines(list)` — [1135](renderer/app.js#L1135).
- `renderDoctrineDetail(d)` — [1154](renderer/app.js#L1154).
- `renderFitDetail(f)` — [1186](renderer/app.js#L1186).
- `renderAaView()` — [1272](renderer/app.js#L1272) — top-level AA tab renderer (list/doctrine/fit).
- `refreshDoctrines()` — [1278](renderer/app.js#L1278).
- `openDoctrine(id)` — [1303](renderer/app.js#L1303).
- `openFit(id)` — [1320](renderer/app.js#L1320).
- `aaGoBack()` — [1370](renderer/app.js#L1370) — navigation back-button.
- `fetchAaPath(path)` — [1444](renderer/app.js#L1444) — wrapper around `window.api.aaFetchHtml` that detects login redirects.

### Readiness tab

- `loadReadinessPersistent()` — [1419](renderer/app.js#L1419) — restore scan + toggles from `localStorage`.
- `saveReadinessScan()` — [1429](renderer/app.js#L1429).
- `saveReadinessToggles()` — [1432](renderer/app.js#L1432).
- `fitIsEnabled(fit)` — [1437](renderer/app.js#L1437) — toggle/capital filter.
- `scanAllFits()` — [1453](renderer/app.js#L1453) — full doctrine→fits crawl through AA.
- `aggregateMissingFiltered(scan, market, filterFn)` — [1539](renderer/app.js#L1539).
- `aggregateMissing(scan, market)` — [1582](renderer/app.js#L1582).
- `selectionContext()` — [1586](renderer/app.js#L1586) — derive context (label, scope) from current selection.
- `slugify(s)` — [1607](renderer/app.js#L1607) — `kebab-case` helper.
- `perFitCompleteness(fit, market)` — [1611](renderer/app.js#L1611) — % availability per fit.
- `perDoctrineCompleteness(doctrine, scan, market)` — [1625](renderer/app.js#L1625).
- `exportMultibuy(missing)` — [1646](renderer/app.js#L1646) — render the EVE multibuy textbox text.
- `copyCurrentMissing()` — [1650](renderer/app.js#L1650) — copy to clipboard.
- `downloadCurrentMissing()` — [1663](renderer/app.js#L1663) — save as `.txt`.
- `flashStatus(id, msg)` — [1678](renderer/app.js#L1678) — transient status text.
- `renderMissingTable(missing, limit)` — [1685](renderer/app.js#L1685).
- `renderExportActions()` — [1706](renderer/app.js#L1706).
- `renderReadinessSelection()` — [1715](renderer/app.js#L1715).
- `renderReadinessDashboard()` — [1805](renderer/app.js#L1805) — the readiness main view.
- `renderReadinessSettings()` — [2003](renderer/app.js#L2003) — settings drawer.
- `readinessGoBack()` — [2062](renderer/app.js#L2062).

---

## `renderer/calculator.js` — popout calculator (211 LOC)

[renderer/calculator.js](renderer/calculator.js)

Self-contained numpad-driven calculator. Mounted both inline (Moon tab
sidebar) and in the popout window. Exposes a single `initMoonCalculator(mountEl)`
entrypoint; the popout window calls it on DOM-ready. Click the display to
focus it, type with the numpad, and use the 70/80/90% buttons to copy the
percentaged value to the clipboard.

---

## `renderer/index.html` — UI shell (203 LOC)

[renderer/index.html](renderer/index.html)

Static markup only. Defines the seven tabs (`Config / Auth / Buyback / Moon /
Mail / Doctrines / Readiness`), the mail modal, and the calculator-sidebar
mount point. No inline scripts beyond loading `calculator.js` then `app.js`.

---

## `renderer/calculator.html` — popout window template (16 LOC)

[renderer/calculator.html](renderer/calculator.html)

Loads `calculator.js` and mounts it on `#calc-mount`. Used as the
`loadFile` target of `calculatorWindow` in [electron/main.js](electron/main.js#L116).
