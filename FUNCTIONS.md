# Function Index

Function-level map of the codebase. Grouped by file in the order you'd most
likely traverse them: sidecar (server → validate → refining → esi/janice/auth/config),
then Electron main, then renderer JS.

For higher-level context see [CONTEXT.md](CONTEXT.md). For the file layout see
[STRUCTURE.md](STRUCTURE.md).

Format: clickable file link, then a table or list of names with line numbers
and a one-line description.

---

## `python/server.py` — FastAPI sidecar entrypoint (~1275 LOC)

[python/server.py](python/server.py)

### Routes

| Method+Path | Handler | Line | Purpose |
|---|---|---|---|
| `GET /api/health` | `health` | [92](python/server.py#L92) | Liveness probe used by `waitForSidecar`. |
| `GET /api/config` | `get_config` | [97](python/server.py#L97) | Return merged config (defaults + saved). |
| `POST /api/config` | `update_config` | [120](python/server.py#L120) | Partial-update saved config; pydantic `ConfigUpdate` filters keys. |
| `GET /api/markets` | `list_markets` | [129](python/server.py#L129) | Return supported Janice market names. |
| `GET /api/auth/status` | `auth_status` | [161](python/server.py#L161) | Per-slot status (`slot=slot1` default); refreshes the access token if near expiry. |
| `GET /api/auth/slots` | `auth_slots` | [167](python/server.py#L167) | Array of statuses for all 3 slots — drives the Auth-tab UI. |
| `POST /api/auth/login` | `auth_login` | [173](python/server.py#L173) | Build SSO authorize URL + state for `slot=slotN`; opens system browser. |
| `POST /api/auth/logout` | `auth_logout` | [190](python/server.py#L190) | Clear cached tokens for the given slot. |
| `GET /callback` | `sso_callback` | [197](python/server.py#L197) | EVE SSO redirect target; pops state→slot mapping, exchanges code for tokens, writes them under that slot's key. |
| `POST /api/mail/send` | `send_mail` | [230](python/server.py#L230) | ESI evemail send via slot1 (requires `esi-mail.send_mail.v1`). |
| `GET /api/wallets` | `get_wallets` | [273](python/server.py#L273) | All 7 corp wallet divisions + total (slot1). |
| `GET /api/universe/ships` | `get_ship_types` | [288](python/server.py#L288) | Return every published EVE ship hull; cached to disk indefinitely. `?refresh=true` rebuilds. |
| `GET /api/region/from-station` | `region_from_station` | [317](python/server.py#L317) | NPC station ID → `{station_name, system_id, system_name, region_id}` via the universe lookup chain. |
| `POST /api/contracts/fetch` | `fetch_contracts` | [340](python/server.py#L340) | Raw corp contracts (used to preview before validation). |
| `POST /api/validate` | `validate` | [364](python/server.py#L364) | NDJSON-streamed buyback + moon validation. |
| `GET /api/aa/market` | `get_aa_market` | [578](python/server.py#L578) | One-shot structure market snapshot (cached 5 min). |
| `GET /api/aa/market/stream` | `stream_aa_market` | [673](python/server.py#L673) | NDJSON-streamed page-by-page market fetch. |
| `GET /api/contracts/scan` | `scan_contracts` | [932](python/server.py#L932) | NDJSON-streamed Contracts-dashboard scan: walks each authed slot's corp, filters to outstanding corp-posted item-exchanges at the home structure, fetches items, tallies against configured quotas. |
| `GET /api/sov/overview` | `sov_overview` | [1135](python/server.py#L1135) | Sov-tab aggregator: sovereignty structures + map + campaigns + system jumps/kills + incursions, all enriched with names. |

### Helpers / internals

- `_callback_page(msg)` — [85](python/server.py#L85) — minimal dark-themed HTML for the SSO landing tab.
- `_normalize_slot(slot)` — [78](python/server.py#L78) — coerce optional slot to one of `VALID_SLOTS`, defaulting to `slot1`. Raises `HTTPException(400)` on invalid.
- `_slot_status(slot)` — [135](python/server.py#L135) — single-slot status block used by both `/api/auth/status` and `/api/auth/slots`; auto-refreshes the access token if within 30s of expiry.
- `_auth_state` — module dict tracking `{pending: state→slot, completed: slot→bool, errors: slot→str}` for the SSO callback.
- `ConfigUpdate` *(pydantic)* — [102](python/server.py#L102) — accepted config keys (incl. `home_structure_id`, `home_region_id`, `quotas`); unknown keys dropped.
- `SendMailRequest` *(pydantic)* — [224](python/server.py#L224) — recipient/subject/body.
- `ValidateRequest` *(pydantic)* — [354](python/server.py#L354) — optional pre-supplied `contracts`.
- `_emit(event_type, **data)` — [358](python/server.py#L358) — encodes one NDJSON line for streams.
- `_validate_stream(cfg, req)` — [375](python/server.py#L375) — **buyback+moon pipeline.** Fetches contracts, categorises, resolves issuer names, walks buyback then moon contracts, emits `progress`/`buyback_result`/`moon_result`/`done`/`error`. Constructs an inline `payout_lookup` closure that calls `compute_refined_payout`.
- `_summarize_orders(structure_id, orders, fetched_at)` — [556](python/server.py#L556) — fold raw structure orders → `{type_id: {min_price, total_volume, order_count}}`.
- `_resolve_market_structure_id(cfg, structure_id)` — [616](python/server.py#L616) — falls back to first configured structure when caller doesn't pass an explicit id.
- `_market_stream(structure_id, refresh)` — [629](python/server.py#L629) — generator for `stream_aa_market`; reuses the in-memory cache when fresh.
- `_matches_quota(quota, items_named, contract)` — [762](python/server.py#L762) — returns how many times a contract counts toward a quota row (ship `type_id` required, optional `title_filter` substring).
- `_scan_contracts_stream()` — [785](python/server.py#L785) — **Contracts dashboard pipeline.** Iterates `list_authenticated_slots()`, resolves each toon's corp via `fetch_character_info`, calls `fetch_corp_contracts` with that slot's token (dedupes corps), filters per-slot, fetches items via `fetch_contract_items`, bulk-resolves type+issuer names, tallies against configured quotas, emits one `done` with `{structure_id, corps_scanned[], contracts[], quotas[]}`.
- `_contract_items_cache` — process-scope `dict[contract_id → items]` so back-to-back scans don't re-download every contract's items.
- `_SOV_STRUCTURE_TYPE_NAMES` — `{32458: 'IHUB'}` (TCUs were removed in the 2024 sov rework).

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

## `python/esi.py` — ESI wrappers (~458 LOC)

[python/esi.py](python/esi.py)

| Function | Line | Purpose |
|---|---|---|
| `resolve_names(ids, user_agent)` | [6](python/esi.py#L6) | Bulk ID→name via `POST /universe/names/` (1000-id chunks). |
| `send_evemail(character_id, recipient_id, subject, body, access_token, user_agent)` | [29](python/esi.py#L29) | Single-recipient mail send; surfaces ESI error body. |
| `fetch_corp_wallets(corp_id, access_token, user_agent)` | [61](python/esi.py#L61) | Seven-division corp wallet balances. |
| `fetch_contract_items(corp_id, contract_id, access_token, user_agent)` | [72](python/esi.py#L72) | Items in one corp contract. |
| `fetch_type_info(type_id, user_agent)` | [88](python/esi.py#L88) | Type metadata, in-process cached (`_TYPE_INFO_CACHE`). |
| `fetch_group_info(group_id, user_agent)` | [104](python/esi.py#L104) | Group metadata, in-process cached (`_GROUP_INFO_CACHE`). |
| `fetch_category_info(category_id, user_agent)` | [120](python/esi.py#L120) | Universe category metadata (e.g. category 6 = Ship → list of group ids). |
| `fetch_all_ship_types(user_agent)` | [131](python/esi.py#L131) | Walks category 6 → groups → type ids → bulk `resolve_names`. Returns `[{type_id, name, group_id, group_name}]` for every published ship hull (~560 entries). Cached to disk server-side; used by the quota-editor dropdown. |
| `fetch_structure_orders_paged(structure_id, access_token, user_agent)` | [167](python/esi.py#L167) | **Generator** yielding `(page, max_pages, batch)`. Used for SSE progress. |
| `fetch_structure_orders(structure_id, access_token, user_agent)` | [196](python/esi.py#L196) | Convenience wrapper that consumes the generator. |
| `fetch_corp_contracts(corp_id, access_token, user_agent)` | [204](python/esi.py#L204) | Paginated corp contracts. Used by Buyback validation, Moon processing, and the Contracts scan. |
| `fetch_public_contracts_paged(region_id, user_agent)` | [229](python/esi.py#L229) | Generator over public contracts in a region. (Available for future region-wide use; not currently called.) |
| `fetch_public_contract_items(contract_id, user_agent)` | [257](python/esi.py#L257) | Items for a public contract. |
| `fetch_character_contracts(character_id, access_token, user_agent)` | [282](python/esi.py#L282) | Contracts where the character is issuer/acceptor/assignee. (Available; the active Contracts scan uses the corp endpoint instead per the ESI-limitation notes in [CONTEXT.md](CONTEXT.md).) |
| `fetch_character_contract_items(character_id, contract_id, access_token, user_agent)` | [307](python/esi.py#L307) | Items for one character-visible contract. |
| `fetch_station_info(station_id, user_agent)` | [321](python/esi.py#L321) | NPC station lookup (→ derive system_id → region_id). |
| `fetch_system_info(system_id, user_agent)` | [332](python/esi.py#L332) | System metadata. |
| `fetch_constellation_info(constellation_id, user_agent)` | [342](python/esi.py#L342) | Constellation metadata. |
| `fetch_region_info(region_id, user_agent)` | [352](python/esi.py#L352) | Region metadata. |
| `fetch_character_info(character_id, user_agent)` | [362](python/esi.py#L362) | Returns `{corporation_id, alliance_id, ...}` — used by the Contracts scan to map each authed slot to its corp. |
| `fetch_corporation_info(corp_id, user_agent)` | [373](python/esi.py#L373) | Corp metadata (name, ticker, alliance_id, …). |
| `fetch_alliance_info(alliance_id, user_agent)` | [384](python/esi.py#L384) | Alliance metadata. |
| `fetch_sovereignty_structures(user_agent)` | [395](python/esi.py#L395) | All sov structures (IHUBs after the 2024 rework). |
| `fetch_sovereignty_map(user_agent)` | [406](python/esi.py#L406) | System→owner map. |
| `fetch_sovereignty_campaigns(user_agent)` | [417](python/esi.py#L417) | In-progress sov campaigns. |
| `fetch_system_kills(user_agent)` | [428](python/esi.py#L428) | Per-system kill stats (last hour). |
| `fetch_system_jumps(user_agent)` | [439](python/esi.py#L439) | Per-system jump counts. |
| `fetch_incursions(user_agent)` | [450](python/esi.py#L450) | Active incursions. |

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

## `python/auth.py` — EVE SSO multi-slot (~153 LOC)

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

## `python/config.py` — settings persistence (~135 LOC)

[python/config.py](python/config.py)

- `_fresh_default()` — [63](python/config.py#L63) — deep copy of the `DEFAULTS` dict (so structures/mail_presets don't share references).
- `_migrate(cfg)` — [71](python/config.py#L71) — bring older config shapes forward: old dict-shaped structures → list shape; ensure baseline scopes (including `esi-contracts.read_character_contracts.v1`); split legacy single `refining_efficiency`; rename `home_station_id` → `home_structure_id`.
- `load_config()` — [116](python/config.py#L116) — read raw → `_migrate` → filter by `_USER_KEYS` → merge over fresh defaults. **Migration runs before filtering** so renamed keys aren't dropped silently on upgrade.
- `save_config(cfg)` — [130](python/config.py#L130) — filter to known keys, persist chmod 600.

Module-level: `AUTH_DIR` (from `EVE_BUYBACK_DATA_DIR` env or `.eve_auth/` next to repo), `DEFAULT_STRUCTURES`, `JANICE_MARKETS`, `DEFAULT_MAIL_PRESETS`, `DEFAULTS`. New keys in `DEFAULTS`: `home_structure_id`, `home_region_id`, `quotas`.

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

## `renderer/app.js` — UI logic (~2700 LOC, vanilla JS)

[renderer/app.js](renderer/app.js)

State lives in module-level lets near the top: `cfg`, `walletData`,
`buybackResults`, `moonResults`, `aaState`, `readinessState`,
`mailPresets`, `lastContractsScan`, `shipTypesCache`, `shipTypesByIdMap`,
`shipTypesByNameMap`.

> **Note on line numbers below:** the function inventory was originally
> captured at app.js ~2143 LOC. The Contracts/Auth/quota additions
> appended ~600 lines after the Readiness block, so earlier line numbers
> are still roughly accurate for the original sections (Config / Buyback /
> Moon / Mail / Doctrines / Readiness), but the Contracts and multi-slot
> auth functions live at the bottom of the file (~line 2220+).

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

### Auth tab (multi-slot)

- `AUTH_SLOT_LABELS` / `AUTH_SLOTS` — [393–398](renderer/app.js#L393) — slot name → human label, and the canonical slot list.
- `renderAuthSlot(slot, info)` — [400](renderer/app.js#L400) — HTML for one auth-slot card (character name, expiry, login/logout buttons).
- `refreshAuthStatus()` — [425](renderer/app.js#L425) — fetch `/api/auth/slots`, render all three slots, mirror slot1 status into the legacy single-status indicator.
- `startSlotLogin(slot)` — [460](renderer/app.js#L460) — POST `/api/auth/login?slot=...`, then poll `/api/auth/status?slot=...` for up to ~3 minutes waiting for the browser-side SSO round-trip.
- `logoutSlot(slot)` — [483](renderer/app.js#L483) — confirm + POST `/api/auth/logout?slot=...`, then refresh the UI.
- Delegated click handler on `.auth-slot-login` / `.auth-slot-logout` (right below) routes button clicks to the above.

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

### Contracts tab — quota editor + scan + exports

- `quotaRow(q)` — [2239](renderer/app.js#L2239) — HTML for one quota row (`q-name`, `q-tid`, `q-sname`, `q-req`, `q-title`, remove button). `q-tid`/`q-sname` are wired to the ship-type datalists.
- `ensureShipTypes()` — [2260](renderer/app.js#L2260) — lazy GET `/api/universe/ships`, build `shipTypesCache` + lookup maps (`shipTypesByIdMap`, `shipTypesByNameMap`), populate datalists. Returns a memoized promise so concurrent callers share one fetch.
- `buildShipDatalists(ships)` — [2284](renderer/app.js#L2284) — populate the two `<datalist>`s (`#ships-datalist` keyed by `type_id`, `#ship-names-datalist` keyed by name); appended to `<body>` on first build.
- Delegated `change` listener (just below `buildShipDatalists`) — auto-fills the sibling column when the user picks/types a ship in either of the two datalist-bound inputs.
- `renderQuotas(list)` — [2339](renderer/app.js#L2339) — render the quotas `<tbody>`.
- `collectQuotas()` — [2347](renderer/app.js#L2347) — read editor → JSON, dropping rows with no `ship_type_id` and no name.
- Paste-from-spreadsheet handler on `#quotas-tbody` — multi-line paste of TSV/CSV expands into one row per line; first row fills the cell-and-rightward of the paste target, the rest are appended.
- `rowFromCells(cells)` — [2391](renderer/app.js#L2391) — map a delimited row's cells onto the quota schema.
- `fillQuotaRowFromCells(tr, cells, startInput)` — [2400](renderer/app.js#L2400) — fill a row's inputs starting from the input the user pasted into.
- `parseDelimited(text)` — [2410](renderer/app.js#L2410) — auto-detect tab vs comma delimiter; return list of cell-arrays.
- `parseCsvLine(line, sep)` — [2419](renderer/app.js#L2419) — minimal CSV parser handling double-quoted cells.
- `csvEscape(v)` / `quotasToCsv(quotas)` / `quotasFromCsvText(text)` — [2440–2461](renderer/app.js#L2440) — quota CSV round-trip with header detection.
- `setQuotaIoStatus(msg)` — [2465](renderer/app.js#L2465) — flash a transient status message in the quota-IO area.
- `downloadBlob(filename, mime, content)` — utility used by all the export buttons.
- Quota import/export button handlers — `#btn-quota-import-csv`, `#btn-quota-import-json`, `#btn-quota-export-csv`, `#btn-quota-export-json`, `#quota-import-file` change handler. Imports prompt **replace or append**.
- `#btn-lookup-region` handler — GET `/api/region/from-station?station_id=...` and fill the region input on success.
- `lastContractsScan` — module-level let cached from the last successful `runContractsScan`; powers the export buttons.
- `runContractsScan()` — [2571](renderer/app.js#L2571) — GET `/api/contracts/scan` (NDJSON), update progress, store the `done` payload, render dashboard + contract list.
- `readNdjson(response, onEvent)` — [2618](renderer/app.js#L2618) — generic NDJSON line-stream reader used by Contracts and AA market scans.
- `renderContractsDashboard(payload)` — [2640](renderer/app.js#L2640) — render per-quota progress bars + the (collapsible) list of matching contracts.
- `renderQuotaBar(q)` — [2663](renderer/app.js#L2663) — single quota row with progress bar; class derived from `required` vs `available` (`ok` / `partial` / `empty` / `unset`).
- `renderContractRow(c)` — [2682](renderer/app.js#L2682) — one contract card showing title, sources (corp + targeted-at label), issuer, items (truncated to 12).
- `exportGapCsv()` — [2707](renderer/app.js#L2707) — CSV of `{name, ship_name, ship_type_id, required, available, missing}` rows.
- `copyShoppingList()` — [2723](renderer/app.js#L2723) — clipboard copy of `N x <ship>` lines for in-game multi-buy.

### Sov tab

The Sov tab is built on top of `GET /api/sov/overview` and runs entirely
off public ESI data (no auth needed). Top-level functions live at the
bottom of `app.js`:

- `structureAdm(sys_, typeId)` — [2758](renderer/app.js#L2758) — pull ADM for a structure from a system record.
- `sortAdmCompare(a, b, getter, dir)` / `admClass(adm)` / `secClass(sec)` / `fmtAdm(adm)` / `fmtSec(sec)` / `fmtPct(x)` / `fmtDate(iso)` / `fmtAge(iso)` — [2763–2820](renderer/app.js#L2763) — formatting helpers.
- `refreshSov()` — [2820](renderer/app.js#L2820) — GET `/api/sov/overview`, render all panels.
- `renderSovTotals(d)` — [2843](renderer/app.js#L2843) — header stats.
- `renderSovOwners(owners)` — [2871](renderer/app.js#L2871) — per-alliance ownership table.
- `renderSovCampaigns(camps)` — [2889](renderer/app.js#L2889) — active sov campaigns.
- `renderSovIncursions(incs)` — [2914](renderer/app.js#L2914) — active incursions.
- `sovSystemRowHtml(s, includeRegionCol)` — [2932](renderer/app.js#L2932) — per-system row.

---

## `renderer/calculator.js` — popout calculator (211 LOC)

[renderer/calculator.js](renderer/calculator.js)

Self-contained numpad-driven calculator. Mounted both inline (Moon tab
sidebar) and in the popout window. Exposes a single `initMoonCalculator(mountEl)`
entrypoint; the popout window calls it on DOM-ready. Click the display to
focus it, type with the numpad, and use the 70/80/90% buttons to copy the
percentaged value to the clipboard.

---

## `renderer/index.html` — UI shell (~290 LOC)

[renderer/index.html](renderer/index.html)

Static markup only. Defines nine tabs (`Config / Auth / Buyback / Moon /
Mail / Doctrines / Readiness / Contracts / Sov`), the mail modal, the
calculator-sidebar mount point, the spreadsheet-style quota editor table
(`#quotas-table`), and the multi-slot auth slots container
(`#auth-slots`). No inline scripts beyond loading `calculator.js` then
`app.js`. The ship-type `<datalist>`s are not in the static markup —
they're appended to `<body>` by `buildShipDatalists` on first need.

---

## `renderer/calculator.html` — popout window template (16 LOC)

[renderer/calculator.html](renderer/calculator.html)

Loads `calculator.js` and mounts it on `#calc-mount`. Used as the
`loadFile` target of `calculatorWindow` in [electron/main.js](electron/main.js#L116).
