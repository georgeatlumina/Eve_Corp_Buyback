# Function Index

Function-level map of the codebase. Grouped by file in the order you'd most
likely traverse them: sidecar (server → validate → refining → esi/janice/auth/config),
then Electron main, then renderer JS.

For higher-level context see [CONTEXT.md](CONTEXT.md). For the file layout see
[STRUCTURE.md](STRUCTURE.md).

Format: clickable file link, then a table or list of names with line numbers
and a one-line description.

---

## `python/server.py` — FastAPI sidecar entrypoint (~2007 LOC)

[python/server.py](python/server.py)

### Routes

| Method+Path | Handler | Line | Purpose |
|---|---|---|---|
| `GET /api/health` | `health` | [104](python/server.py#L104) | Liveness probe used by `waitForSidecar`. |
| `GET /api/config` | `get_config` | [109](python/server.py#L109) | Return merged config (defaults + saved). |
| `POST /api/config` | `update_config` | [137](python/server.py#L137) | Partial-update saved config; pydantic `ConfigUpdate` filters keys. |
| `GET /api/markets` | `list_markets` | [146](python/server.py#L146) | Return supported Janice market names. |
| `GET /api/auth/status` | `auth_status` | [178](python/server.py#L178) | Per-slot status (`slot=slot1` default); refreshes the access token if near expiry. |
| `GET /api/auth/slots` | `auth_slots` | [184](python/server.py#L184) | Array of statuses for all 3 slots — drives the Auth-tab UI. |
| `POST /api/auth/login` | `auth_login` | [190](python/server.py#L190) | Build SSO authorize URL + state for `slot=slotN`; opens system browser. |
| `POST /api/auth/logout` | `auth_logout` | [207](python/server.py#L207) | Clear cached tokens for the given slot. |
| `GET /callback` | `sso_callback` | [214](python/server.py#L214) | EVE SSO redirect target; pops state→slot mapping, exchanges code for tokens, writes them under that slot's key. |
| `POST /api/mail/send` | `send_mail` | [247](python/server.py#L247) | ESI evemail send via slot1 (requires `esi-mail.send_mail.v1`). |
| `GET /api/wallets` | `get_wallets` | [290](python/server.py#L290) | All 7 corp wallet divisions + total (slot1). |
| `GET /api/universe/ships` | `get_ship_types` | [305](python/server.py#L305) | Return every published EVE ship hull; cached to disk indefinitely. `?refresh=true` rebuilds. |
| `POST /api/quotas/sync` | `sync_quotas` | [624](python/server.py#L624) | Pull `quotas.json` from the alliance source of truth — private GitHub repo via Contents API (auth via Read PAT) or gist (no auth, kept as fallback). |
| `POST /api/quotas/push` | `push_quotas` | [659](python/server.py#L659) | Commit local quotas back to the configured GitHub repo file via Contents API (auth via Write PAT). Refuses unless `alliance_quota_allow_push` is true in config. |
| `GET /api/region/from-station` | `region_from_station` | [728](python/server.py#L728) | NPC station ID → `{station_name, system_id, system_name, region_id}` via the universe lookup chain. |
| `POST /api/contracts/fetch` | `fetch_contracts` | [751](python/server.py#L751) | Raw corp contracts (used to preview before validation). |
| `POST /api/validate` | `validate` | [775](python/server.py#L775) | NDJSON-streamed buyback + moon validation. |
| `GET /api/aa/market` | `get_aa_market` | [1005](python/server.py#L1005) | One-shot structure market snapshot (cached 5 min). |
| `GET /api/aa/market/stream` | `stream_aa_market` | [1100](python/server.py#L1100) | NDJSON-streamed page-by-page market fetch. |
| `GET /api/market/amarr-sell` | `amarr_sell_price` | [1117](python/server.py#L1117) | Min Amarr sell price for a single `type_id`. Prefers Janice's pricer endpoint when an API key is configured, falls back to a paged ESI regional-market scan filtered to the Amarr system. 5-minute in-process cache. Added by PR #3 for per-fit Amarr pricing on the Contracts dashboard. |
| `GET /api/market/analytics/stream` | `stream_market_analytics` | — | NDJSON market-analytics stream for the Market tab. `progress` per page, then `done` with `{structure_id, fetched_at, totals, rows}` from `_analyze_orders`. Reuses the AA market cache; enriches names+categories via `market.enrich`. Snapshot only. |
| `POST /api/market/history/archive` | `archive_market_history` | — | Opportunistic + idempotent daily archive: gzips the full-depth snapshot and PUTs `market-history/<sid>/<date>.json.gz` to the configured history repo. No-ops when unconfigured / <24h since last / today's file already present / 409 race. Never raises on the no-op paths. |
| `GET /api/market/history/turnover` | `market_history_turnover` | — | **Net on-book change** over 24h/72h/weekly/monthly. Reads back the daily archive (Read PAT), lists `market-history/<sid>/`, fetches only the latest + per-window baseline summaries (cached per date), and returns signed Δ sell/buy value + % per window via pure `_select_baselines` + `_compute_turnover`. Order-book snapshots, not trades — degrades to `coverage: insufficient/partial` until enough days accrue. Returns `{configured, snapshots, windows[]}`. |
| `POST /api/appraise` | `appraise_paste` | [1427](python/server.py#L1427) | Run a Janice appraisal against pasted EVE-format text. Returns the Janice block with buy/split/sell totals (immediate + effective) and a shareable code when `persist` is set. |
| `GET /api/pinned` | `get_pinned` | [1573](python/server.py#L1573) | Working-tab: return the persisted pin list. |
| `POST /api/pinned` | `post_pinned` | [1579](python/server.py#L1579) | Working-tab: upsert a pinned moon-result snapshot. Derives `blended_fraction` once at pin time. |
| `DELETE /api/pinned/{contract_id}` | `delete_pinned` | [1593](python/server.py#L1593) | Working-tab: remove a pin. |
| `PATCH /api/pinned/{contract_id}` | `patch_pinned` | [1598](python/server.py#L1598) | Working-tab: update `notes` or `status` (`pending`/`paid`/`disputed`) only. Whitelist enforced. |
| `POST /api/pinned/{contract_id}/appraise` | `appraise_pinned` | [1608](python/server.py#L1608) | Working-tab: run a Janice appraisal against the admin's pasted refined-minerals text, apply the pin's saved blended fraction, append to the pin's appraisal-history ring. Returns the new pin + the appraisal record. |
| `GET /api/contracts/scan` | `scan_contracts` | [1664](python/server.py#L1664) | NDJSON-streamed Contracts-dashboard scan: walks each authed slot's corp, filters to outstanding corp-posted item-exchanges at the home structure, fetches items, tallies against configured quotas. |
| `GET /api/sov/overview` | `sov_overview` | [1867](python/server.py#L1867) | Sov-tab aggregator: sovereignty structures + map + campaigns + system jumps/kills + incursions, all enriched with names. |
| `GET /api/structures/fuel` | `structures_fuel` | [server.py](python/server.py) | Hooks & Hubs fuel: enumerates authenticated slots' corps (slot 4 = Director), fetches `/corporations/{id}/structures/`, dedupes, classifies skyhook/hub/other by resolved type name, returns per-structure `seconds_remaining` + per-type summaries. Per-slot/corp failures (missing scope/role) surface in `auth_errors`. |
| `GET /api/workforce-plan` | `get_workforce_plan` | [server.py](python/server.py) | Return the manual Hooks & Hubs planner document (`workforce_plan.load_plan`). |
| `PUT /api/workforce-plan` | `put_workforce_plan` | [server.py](python/server.py) | Replace the whole planner document (`workforce_plan.save_plan`). |
| `POST /api/liquidation/analyze` | `liquidation_analyze` | [server.py](python/server.py) | NDJSON stream. Analyze a courier contract from `paste_text` **or** a `janice_url` (the contract title). Appraises items at Jita via Janice (type_ids + volumes), overrides sell/buy with the **live ESI order book**, pulls Amarr buy (Janice) for cost basis, gathers ESI signals concurrently, computes courier cost, then `liquidation.analyze_items`. Echoes `contract_id`. |
| `GET /api/liquidation/item-history` | `liquidation_item_history` | [server.py](python/server.py) | ESI daily price/volume history (The Forge) + live book signal for one `type_id` — powers the slide-out detail chart. |
| `GET /api/liquidation/shipments` | `liquidation_shipments` | [server.py](python/server.py) | The shipment board (GitHub-repo-backed, local fallback) + courier accept/deliver days. |
| `POST /api/liquidation/shipments` | `liquidation_add_shipment` | [server.py](python/server.py) | Add a tracked shipment (via `_liq_mutate_store` → `liquidation.apply_add`). |
| `PATCH /api/liquidation/shipments/{id}` | `liquidation_patch_shipment` | [server.py](python/server.py) | Patch status/label/notes/delivered_at (`apply_update`). |
| `DELETE /api/liquidation/shipments/{id}` | `liquidation_delete_shipment` | [server.py](python/server.py) | Remove a shipment (`apply_remove`). |
| `GET /api/liquidation/corp-orders` | `liquidation_corp_orders` | [server.py](python/server.py) | Live corp Jita **sell** orders enriched with cost basis, best-sell/undercut, days-to-sell, window time-left, STALE flag. Needs `esi-markets.read_corporation_orders.v1` (returns `{configured:false, reason}` otherwise). |
| `GET /api/liquidation/courier-contracts` | `liquidation_courier_contracts` | [server.py](python/server.py) | Corp ESI **courier** contracts bucketed active/completed/problem, assignee + route names resolved, configured provider flagged. Needs `esi-contracts.read_corporation_contracts.v1`. |

### Helpers / internals

- `_callback_page(msg)` — minimal dark-themed HTML for the SSO landing tab.
- `_normalize_slot(slot)` — [90](python/server.py#L90) — coerce optional slot to one of `VALID_SLOTS`, defaulting to `slot1`. Raises `HTTPException(400)` on invalid.
- `_slot_status(slot)` — [152](python/server.py#L152) — single-slot status block used by both `/api/auth/status` and `/api/auth/slots`; auto-refreshes the access token if within 30s of expiry.
- `_auth_state` — module dict tracking `{pending: state→slot, completed: slot→bool, errors: slot→str}` for the SSO callback.
- `ConfigUpdate` *(pydantic)* — accepted config keys (incl. `home_structure_id`, `home_region_id`, `quotas`, the alliance-quota triplet `alliance_quota_url`/`alliance_quota_pat_read`/`alliance_quota_pat_write`/`alliance_quota_allow_push`); unknown keys dropped.
- `SendMailRequest` *(pydantic)* — recipient/subject/body.
- `ValidateRequest` *(pydantic)* — optional pre-supplied `contracts`.
- `_emit(event_type, **data)` — encodes one NDJSON line for streams.
- `_coerce_quota_row(row)` — [338](python/server.py#L338) — normalise one quota record to the canonical shape; drops rows missing `ship_type_id` so a partially-bad alliance file doesn't wipe the user's quotas.
- `_extract_quotas_from_payload(payload)` — [361](python/server.py#L361) — accept several JSON shapes from the alliance source of truth: bare array, `{quotas: [...]}`, the full export envelope `{_meta, config: {quotas: [...]}}`, and the simpler `{_meta, quotas: [...]}`.
- `_resolve_gist_page_url(url, user_agent)` — [389](python/server.py#L389) — if the URL is a gist *page* URL, hit the Gists API to discover the first file's `raw_url` (preferring `.json`) and return that. Page URL from the gist's Share button works directly.
- `_parse_github_blob_url(url)` — [425](python/server.py#L425) — detect every GitHub URL shape that points at a single file in a repo (`/blob/`, `/raw/`, `raw.githubusercontent.com`, `api.github.com/.../contents`, and the bare clone URL `github.com/<o>/<r>(.git)?` — the last defaults to `main/quotas.json`). Returns `(owner, repo, branch, path)` or `None`.
- `_github_contents_get(owner, repo, branch, path, pat, user_agent)` — [476](python/server.py#L476) — wrap the Contents API GET. Returns `(decoded_text, sha)`; the sha is required for any future PUT. Surfaces 401/403/404 with hints that distinguish "private repo, no PAT" from "PAT lacks scope".
- `_github_contents_put(owner, repo, branch, path, text, sha, pat, user_agent, message)` — [518](python/server.py#L518) — wrap the Contents API PUT. `sha=None` creates a new file. Surfaces 409 as a polite "someone pushed in between — sync, then push again" message.
- `_sync_quotas_from_url(url, cfg, persist=True)` — [567](python/server.py#L567) — quota sync pipeline. Detects GitHub blob URLs and routes via Contents API with the Read PAT (Write PAT as fallback). Anything else falls back to an unauthenticated HTTPS GET via `_resolve_gist_page_url`. Validates, persists, and stamps the on-disk last-sync metadata.
- `_validate_stream(cfg, req)` — [786](python/server.py#L786) — **buyback+moon pipeline.** Fetches contracts, categorises, resolves issuer names, walks buyback then moon contracts, emits `progress`/`buyback_result`/`moon_result`/`done`/`error`. Constructs an inline `payout_lookup` closure that calls `compute_refined_payout`. Moon items accepted iff `is_mineable` OR `is_refined_output` — contracts with anything else are silently dropped from the stream and counted on the `done` event as `moon_dropped`.
- `_summarize_orders(structure_id, orders, fetched_at)` — fold raw structure orders → `{type_id: {min_price, total_volume, order_count}}`.
- `_resolve_market_structure_id(cfg, structure_id)` — falls back to first configured structure when caller doesn't pass an explicit id.
- `_market_stream(structure_id, refresh)` — generator for `stream_aa_market`; reuses the in-memory cache when fresh.
- `_analyze_orders(structure_id, orders, fetched_at, type_meta)` — fold the full buy+sell book into per-type analytics rows (best sell/buy, order counts, units, ISK depth, spread) + market-wide totals incl. total sell/buy value. Sibling of `_summarize_orders` (left untouched — Readiness depends on its shape).
- `_analytics_stream(structure_id, refresh)` — generator behind `/api/market/analytics/stream`; pages the order book (shared `_market_cache`), resolves names/categories via `market.enrich`, emits `done` with the analyzed payload.
- `_market_history_summary(orders)` — compact per-type fold (no names/ESI) stored in each daily archive so phase-2 history reads needn't re-parse the full depth.
- `_github_path_sha(...)` / `_github_put_bytes(...)` — Contents-API helpers for the binary (gzip) archive: existence check (sha or None on 404) and base64-of-raw-bytes PUT. Siblings of the text-oriented `_github_contents_get/put`.
- `_amarr_price_cache` — process-scope `{type_id: {price, fetched_at}}` with 5-minute TTL, backs the `/api/market/amarr-sell` endpoint.
- `_matches_quota(quota, items_named, contract)` — [1153](python/server.py#L1153) — returns how many times a contract counts toward a quota row (ship `type_id` required, optional `title_filter` substring).
- `_scan_contracts_stream()` — [1175](python/server.py#L1175) — **Contracts dashboard pipeline.** Iterates `list_authenticated_slots()`, resolves each toon's corp via `fetch_character_info`, calls `fetch_corp_contracts` with that slot's token (dedupes corps), filters per-slot, fetches items via `fetch_contract_items`, bulk-resolves type+issuer names, tallies against configured quotas, emits one `done` with `{structure_id, corps_scanned[], contracts[], quotas[]}`.
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

## `python/refining.py` — refining math + classification (~379 LOC)

[python/refining.py](python/refining.py)

### Type classification (ESI-backed, cached)

- `is_mineable(type_id, user_agent)` — [29](python/refining.py#L29) — true for any item allowed in a moon contract (ore / moon ore / ice / reagent / Prismaticite).
- `is_prismaticite(type_id, user_agent)` — [43](python/refining.py#L43) — group `4915`; accepted but flagged for manual payout.
- `is_ice(type_id, user_agent)` — [51](python/refining.py#L51) — group `465`.
- `is_moon_ore(type_id, user_agent)` — [59](python/refining.py#L59) — groups `1884/1920/1921/1922/1923` (R4–R64).
- `is_donation(type_id, user_agent)` — [67](python/refining.py#L67) — category `2143` (Magmatic Gas, Superionic Ice). Counted but priced at 0.
- `is_refined_output(type_id, user_agent)` — refined output of ore/moon ore/ice — mineral (group 18), R4–R64 moon material (lazy-built from `MOON_ORE_GROUP_IDS` × the Fuzzwork dump), or ice product (group 423). Used to broaden moon-contract acceptance so a partial-refine paste is still accepted; in the payout math these still fall into the leftover bucket and get hub-buy × non-moon-payout-fraction.
- `_moon_material_type_ids(user_agent)` — lazy + thread-safe build of the set of type IDs produced by refining R4–R64 moon ore. Cached for the process lifetime.

### Data + pricing

- `_load_materials()` — lazy + thread-safe load of the **bundled** `data/mineable_type_materials.csv` (cerlestes-verified ore/moon/ice yields) into a `type_id → [(material_type_id, qty), ...]` map. No network — replaces the dead Fuzzwork dump download. Regenerate via `gen_mineable_materials.py`.
- `is_refinable(type_id)` — [120](python/refining.py#L120) — has at least one material row in the bundled yields CSV.
- `yields_for(type_id, quantity, user_agent)` — [125](python/refining.py#L125) — multiplies materials by `portion_size`-aligned batches; returns `(yields, leftover_qty)`.
- Refined minerals are priced via **Janice** (`janice.fetch_buy_prices(type_ids, market_name, api_key, user_agent)` → `{type_id: immediate buy price}`, concurrent pricer calls; requires a Janice API key). The old Fuzzwork-aggregates `fetch_buy_prices` was removed.

### Payout

- `compute_refined_payout(items, hub_name, moon_ore_eff, non_moon_ore_eff, ice_eff, non_moon_payout_fraction, user_agent, moon_payout_fraction=0.80)` — [165](python/refining.py#L165) — **the core payout computation.** Buckets each item (moon ore / non-moon ore / ice / leftover / donation / prismaticite), applies its bucket's refining yield, prices the result, applies the bucket's payout fraction, and returns a `{refined_value, moon_value, non_moon_value, leftover_value, recommended_payout, breakdown, leftover_breakdown, donation_breakdown, prismaticite_breakdown, ...}` block.

Module constants worth knowing: `ALLOWED_CATEGORY_IDS = {25, 2143}`, `ICE_GROUP_ID = 465`, `MOON_ORE_GROUP_IDS = {1884, 1920, 1921, 1922, 1923}`, `PRISMATICITE_GROUP_ID = 4915`, `MOON_ORE_PAYOUT_FRACTION = 0.80`, `HUBS = {'Jita 4-4': 60003760, 'Amarr': 60008494, 'Dodixie': 60011866, 'Rens': 60004588}`.

---

## `python/liquidation.py` — Liquidation store + decision engine (~300 LOC)

[python/liquidation.py](python/liquidation.py). Pure (no network IO) — like `validate.py`. The store is one JSON doc `{shipments: [...]}`; mutations are pure functions so `server.py` can persist to the GitHub repo or the local cache.

| Function | Purpose |
|---|---|
| `empty_store()` / `normalize(data)` | Default doc + shape coercion (drops shipments without an id). |
| `load_store_local()` / `save_store_local(store)` | Local cache copy at `<AUTH_DIR>/liquidation.json` (chmod 600, atomic replace). |
| `apply_add(store, shipment)` | Prepend a shipment (assigns id + created_at). Returns `(new_store, shipment)`. |
| `apply_update(store, id, fields)` | Patch an allowlisted subset (`label/status/delivered_at/notes/rush`). Returns `(new_store, updated_or_None)`. |
| `apply_remove(store, id)` | Returns `(new_store, removed_bool)`. |
| `courier_cost(collateral, volume_m3, rush, cfg)` | PushX rate card: base + one step-fee per collateral step over the free ceiling + rush fee; flags `over_volume`. |
| `analyze_row(row, amarr_buy_unit, avg_daily_vol, depth_units, on_book_units, courier_alloc_unit, cfg)` | Per-item margins (list vs dump, net of broker+tax), days-to-sell, annualized ROI, `low_confidence` (near-zero cost basis), and a recommended `action` (`list`/`dump`/`underwater`/`no_data`) + `window_days`. |
| `analyze_items(rows, amarr_buy, history, depth, courier_total, cfg)` | Allocates courier across rows by Jita sell value, runs `analyze_row` for each, returns `{items, totals}` (totals include `by_action` counts). |

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
| `fetch_region_market_history(region_id, type_id, user_agent)` | [esi.py](python/esi.py) | Daily traded price/volume history (`{date, average, highest, lowest, order_count, volume}`, ~13 months). Real *traded* liquidity — the Liquidation days-to-sell + detail chart. Public. |
| `fetch_corp_orders(corp_id, access_token, user_agent)` | [esi.py](python/esi.py) | All pages of a corp's open market orders. Needs `esi-markets.read_corporation_orders.v1` + Accountant/Trader role. Powers the Liquidation open-orders view. |
| `fetch_corp_contracts(corp_id, access_token, user_agent)` | [204](python/esi.py#L204) | Paginated corp contracts. Used by Buyback validation, Moon processing, and the Contracts scan. |
| `fetch_corp_structures(corp_id, access_token, user_agent)` | [esi.py](python/esi.py) | Paginated corp-owned structures (skyhooks, sov hubs, citadels) with `fuel_expires` / `services` / `state`. Needs `esi-corporations.read_structures.v1` + Director. Drives the Hooks & Hubs fuel dashboard. |
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

## `python/janice.py` — Janice integration (~270 LOC)

[python/janice.py](python/janice.py)

| Function | Purpose |
|---|---|
| `extract_code(url)` | Pull the appraisal code from `/a/<code>` URLs. |
| `fetch_appraisal(url, api_key=None)` | Main entrypoint. Tries `_fetch_via_api` if key set, falls back to `_fetch_via_rpc`. |
| `_fetch_via_rpc(code)` | Anonymous RPC fetch with sensible error mapping (RecordNotFound → user-friendly). |
| `_fetch_via_api(code, api_key)` | Authenticated REST API fetch. |
| `_normalize(code, data, source)` | Map raw Janice response → `{percentage, effective_offer, total_buy_price, market_name, items, source, raw}` consumed by `validate.py`. **Single source of truth for the appraisal shape.** |
| `create_appraisal(items, market_name, api_key=None)` | Build a new appraisal from a list of `{name, quantity}` items. Used for moon Janice references. |
| `create_appraisal_from_text(input_text, market_name, api_key=None, persist=False)` | Used by the Working tab and Appraisal tab. Takes raw EVE-format paste text (skipping the items→text serialization). Set `persist=True` to ask Janice to save the appraisal so the returned `code` can be turned into a shareable `janice.e-351.com/a/<code>` URL. |
| `fetch_buy_prices(type_ids, market_name='Jita 4-4', api_key=None, user_agent=None)` | Bulk per-unit immediate **buy** prices via the pricer (concurrent). Requires an API key. Used for Liquidation's Amarr cost basis and moon refining. |
| `appraise_items(paste_text, market_name='Jita 4-4', api_key=None)` | Liquidation helper: create an appraisal and return normalized rows `{type_id, name, quantity, unit_volume_m3, sell_unit, buy_unit}` (immediate prices at `market_name`), dropping unresolved types. |
| `items_from_appraisal(url, api_key=None)` | Liquidation helper: pull `[{name, quantity}]` from an existing appraisal URL/code — lets a courier contract analyze straight from its Janice-link title. |
| `fetch_type_sell_price(type_id, market_name='Amarr', api_key=None)` | Janice's pricer endpoint for one type at one market — used by `/api/market/amarr-sell`. Returns `None` if no API key is set (since pricer requires auth). |
| `_create_via_rpc(input_text, market_id, persist=False)` | Anonymous appraisal-create. |
| `_create_via_api(input_text, market_id, api_key, persist=False)` | Authenticated appraisal-create. |
| `_fetch_pricer_via_api(type_id, market_id, api_key)` | Internal Janice pricer call used by `fetch_type_sell_price`. |

Constants: `BUYBACK_PERCENTAGE = 0.90`, `JANICE_MARKET_IDS = {Jita 4-4: 2, Amarr: 115, Dodixie: 117, Rens: 116, Hek: 118}`.

---

## `python/market.py` — Market-tab item metadata (~150 LOC)

[python/market.py](python/market.py)

Resolves `type_id → {name, group_id, group_name, category_id, category_name}`
from ESI and caches it on disk (`type_meta.json`), the way `ship_types.json`
works. Replaces the dead Fuzzwork CSV path.

| Function | Purpose |
|---|---|
| `enrich(type_ids, user_agent=None, on_progress=None)` | Return `{type_id: meta}` for the ids; resolves+caches any missing ones first when a `user_agent` is given (else returns only what's cached). |
| `resolve(type_ids, user_agent, on_progress=None)` | Fetch + cache metadata for any uncached ids, concurrently (`ThreadPoolExecutor`), deduping group/category lookups across the batch. No-op when all cached. |
| `missing_ids(type_ids)` | De-duplicated subset of ids not yet on disk. |
| `_resolve_one`, `_load_cache`, `_save_cache_locked` | Per-type lookup + cache load/persist (chmod 600) internals. |

---

## `python/pinned.py` — Working-tab pin storage (~156 LOC)

[python/pinned.py](python/pinned.py)

On-disk persistence for the Working tab's pinned moon contracts. Pins
survive renderer refreshes, Moon-tab re-fetches, and app close+reopen.

| Function | Purpose |
|---|---|
| `load_pinned()` | Read `<EVE_BUYBACK_DATA_DIR>/pinned_contracts.json`. Returns `[]` on missing or unparseable file. Drops entries missing `contract_id` so one mangled record doesn't poison the rest. |
| `save_pinned(pins)` | Write the full list, chmod 600. |
| `_blended_fraction_from_snapshot(snapshot)` | Derive the effective payout fraction from a moon-result snapshot's refined block: `(moon_payout + non_moon_payout) / (moon_value + non_moon_value)`. The fraction the operator originally applied to refined value to get the recommended payout — re-used on every future appraisal of the actual refined output. |
| `upsert_pin(snapshot, pinned_at)` | Add or replace a pin keyed by `contract_id`. Re-pins refresh the snapshot but **preserve notes / status / appraisals** so the operator doesn't lose history when a contract gets re-fetched. |
| `remove_pin(contract_id)` | Drop a pin. |
| `update_pin_fields(contract_id, patch)` | Apply a `{notes, status}` patch. `status` whitelist: `pending` / `paid` / `disputed`. |
| `append_appraisal(contract_id, appraisal_record)` | Push one appraisal record onto the pin's appraisals ring (newest first, bounded to 20). |

Module constants: `PINNED_PATH`, `VALID_STATUSES = ('pending', 'paid', 'disputed')`, `MAX_APPRAISALS_PER_PIN = 20`.

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

## `electron/main.js` — Electron main process (~545 LOC)

[electron/main.js](electron/main.js)

### Lifecycle / sidecar

- `ensureLogPath()` — lazy-init `<userData>/sidecar.log`.
- `logSidecar(line)` — timestamped append + mirror to stdout.
- `killOrphanSidecars()` — runs `taskkill /F /T /IM sidecar.exe` on Windows or `pkill -x sidecar` on macOS/Linux **before** every spawn. Defends against a previous app instance leaving its child sidecar holding port 8765 — a fresh launch would otherwise fail with `WSAEADDRINUSE` and the orphan would keep serving stale routes.
- `startPythonSidecar()` — spawn the dev `python3 server.py` or the packaged `sidecar` binary after orphan sweep. Pipes stdout/stderr into the log.
- `waitForSidecar(onTick)` — poll `/api/health` for 30 s; calls `onTick(i, max)` per poll for the splash progress bar.

### Splash window

- `createSplashWindow()` — borderless transparent 460×220 window with the boot progress bar; loads `renderer/splash.html` via `splash-preload.js`.
- `emitSplash(pct, step)` — push a progress update to the splash renderer; coalesces pending events while the splash window is loading.
- `flushSplashPending()` — replay the latest coalesced event once the splash is ready.
- `closeSplashWindow()` — dismiss the splash once the main window is `ready-to-show`.

### Windowing

- `createWindow()` — main 1100×800 window, loads `renderer/index.html` with `show: false`; revealed only after `ready-to-show` to avoid a flash of unstyled content.
- `openCalculatorWindow()` — 280×470 always-on-top calculator popout.
- `openAaWindow()` — Alliance Auth browser, partitioned `persist:aa-auth` session.

### IPC handlers (registered to `ipcMain.handle`)

| Channel | Purpose |
|---|---|
| `app:meta` | Returns `{name, version}` from `package.json` — drives the title-bar version chip. |
| `app:check-update` | Calls `checkForUpdate({interactive: true})` — drives the ⟳ button next to the version chip. |
| `open-calculator` | Open the calculator popout. |
| `aa:open` | Open AA window. |
| `aa:logout` | Clear AA session storage + close window. |
| `aa:fetch-html` | Fetch an AA path through the partitioned session; returns `{ok, status, finalUrl, html}`. |

### Auto-update (GitHub Releases)

- `checkForUpdate({interactive=false})` — query the latest release, compare semver, prompt to download. **Interactive mode** (driven from the ⟳ button) pops follow-up dialogs for every outcome: up-to-date / network failure / no platform asset / not packaged. Background mode (the hourly tick + the 2 s startup tick) is silent on every outcome except "update available and not already dismissed this session".
- `dismissedUpdateTag` / `updateDialogOpen` — per-session state. The former suppresses re-prompting after the user clicks Later (interactive checks bypass this); the latter prevents stacking dialogs when an hourly tick fires while one is on screen.
- `pickPlatformAsset(assets)` — pick the right `.dmg` / `.exe` for the host platform.
- `httpsGetJson(url, redirects)` — minimal redirect-following JSON GET.
- `downloadToFile(url, destPath, redirects)` — stream-to-disk with redirect handling.
- `compareSemver(a, b)` — numeric semver comparator.

Polling cadence: `setTimeout(runUpdateCheck, 2000)` at startup, then `setInterval(runUpdateCheck, 60 * 60 * 1000)` for the rest of the session.

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

## `renderer/parse-utils.js` — pure DOM scraping + formatting (124 LOC)

[renderer/parse-utils.js](renderer/parse-utils.js)

Loaded by `index.html` before `app.js`. Pure functions — no side effects,
no DOM mutation — so they're directly require-able from Jest tests in
[tests/parse-utils.test.js](tests/parse-utils.test.js).

| Function | Purpose |
|---|---|
| `extractTypeId(src)` | Pull `type_id` from an EVE image-server URL. |
| `parseDoctrinesHtml(html)` | Scrape the doctrine list page from Alliance Auth. |
| `parseDoctrineDetail(html)` | Scrape one doctrine's fits. |
| `parseFitDetail(html)` | Scrape one fit's items. |
| `fmtIsk(n)` | Compact ISK formatting — `1.23B`, `45.6M`, `7.8K`, etc. |
| `fmtMillions(n)` | Round to nearest 1 M, emit `<N>M` with no decimal. Used on Contracts-tab quota bar headlines where space is tight. |

Exports via `module.exports` when run under Node so Jest can require it
without a bundler.

---

## `renderer/app.js` — UI logic (~4216 LOC, vanilla JS)

[renderer/app.js](renderer/app.js)

State lives in module-level lets near the top: `lastResults` (buyback +
moon), `walletData`, `aaState`, `readinessState`, `mailPresets`,
`lastContractsScan`, `shipTypesCache` / `shipTypesByIdMap` /
`shipTypesByNameMap`, `workingState`, `appraisalState`,
`allianceQuotaAutoSyncDone`.

> **Note on line numbers below:** the function inventory was originally
> captured at app.js ~2143 LOC and has since grown to ~4216. Original
> sections (Config / Auth / Buyback / Moon / Mail / Doctrines /
> Readiness / Contracts) still anchor in roughly the same place at the
> top of the file; the sections below this note (Working / Appraisal /
> Alliance-quota push / Outstanding-payout totals) live in appended
> blocks toward the bottom. Treat the numbers as approximate — use
> `grep -n "^function "` to pin a current line.

### v1.1.x additions (appended blocks)

The renderer grew several new feature blocks across v1.1.0–v1.1.6:

- **Outstanding-payout totals** (Buyback + Moon header). `_rowAcceptValue(kind, r)` returns the row's payout when `classifyResult(r) === 'approve'`, zero otherwise. `renderPayoutTotal(kind)` sums across `lastResults[kind]` and writes to `#buyback-payout-total` / `#moon-payout-total`. Hooked into `renderBuyback()`, `renderMoonTab()`, `appendResultIfMatch()`, and the `runValidateStream()` reset path so the panel updates live during a streaming fetch and on every filter pill click.
- **Working tab** (pinned moon contracts). `loadPinnedContracts()`, `pinMoonContract(id)`, `unpinContract(id)`, `patchPin(id, patch)`, `runPinAppraisal(id, pasteText)`, `renderWorkingTab()`, `buildPinCard(pin)`, `renderPinDetail(pin)`, `togglePinExpanded(id)`, `initWorkingTab()`. Mounts a second calculator instance into `#working-calc-mount`. Delegated click handler on `#working-list` routes appraise / prefill / unpin / expand / status-change / notes-blur all from one listener.
- **Appraisal tab.** `runAppraise()` posts the paste + market + persist flag to `/api/appraise`, renders the result block (three price columns for Janice Buy / Split / Sell with percentage chip rows, plus an optional effective-prices drawer). Ctrl/Cmd-Enter in the textarea fires the appraise.
- **Alliance quota sync + push.** `runQuotaSync({silent})`, `runQuotaPush()`, `updatePushButtonVisibility()`, `renderQuotaSyncStatus(cfg)`, `maybeAutoSyncQuotas()`. The auto-sync chain runs once per app launch after `loadConfig()` resolves when both `alliance_quota_url` and `alliance_quota_auto_sync` are set; failures stay in the last-sync chip rather than yanking the user with a dialog. Push is gated behind the `alliance_quota_allow_push` checkbox so importing the admin's config doesn't auto-unlock writes.
- **Whole-config export / import.** `collectConfigForm()` (shared by Save + Export so unsaved edits flow into the file). `setConfigIoStatus(msg)`, `downloadBlob(name, mime, content)`. `CONFIG_EXPORT_NEVER` set: `scopes` / `alliance_quota_last_synced` / `alliance_quota_last_status` / `alliance_quota_pat_write` / `alliance_quota_allow_push`. Read PAT + Janice key are opt-in via a confirm() prompt.
- **Update-check button.** Module-bottom IIFE wires the ⟳ header button to `window.api.checkForUpdate()`, with a `.spinning` class applied while in-flight.
- **Sov tab.** `refreshSov()`, `renderSovTotals(d)`, `renderSovOwners(o)`, `renderSovCampaigns(c)`, `renderSovIncursions(i)`, `sovSystemRowHtml(s, includeRegionCol)`. Pulls everything in one `/api/sov/overview` call.

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

## `renderer/market.js` — Market analytics tab (~320 LOC)

[renderer/market.js](renderer/market.js)

Self-contained IIFE loaded after `app.js` (reuses its `$`/`$$`/`API`/
`formatIsk`/`escapeHtml`/`readNdjson` globals). All sort/search/filter is
client-side over one cached payload.

| Function | Purpose |
|---|---|
| `initMarketTab()` | Lazy first load on tab open. |
| `loadMarketAnalytics(refresh)` | Consume `/api/market/analytics/stream`, store payload, render tiles + table, then fire `maybeArchiveMarket`. |
| `maybeArchiveMarket()` | Fire-and-forget `POST /api/market/history/archive`; surfaces only the archived result or actionable errors to `#market-history-status`. |
| `buildLensRows()` / `rebuildLens()` | Build doctrine-lens rows from the Readiness scan + toggles in localStorage (`aa.scan.v1`/`aa.toggles.v1`), with quantity-aware shortfall vs the market. `null` when no scan. |
| `fitEnabled(fit, toggles)` | Mirror of app.js `fitIsEnabled`. |
| `filteredSortedRows()` / `renderThead()` / `renderMarketTable()` | Column-driven render for the active mode (`MARKET_COLS` vs `LENS_COLS`); filters by search/category + mode-specific (numeric vs status); nulls always sort last. |
| `marketSortBy(key)` / `setLens(on)` | Header-click sort toggle; lens on/off (swaps columns, default sort, and which filters show). |
| `populateMarketCategories()` / `renderMarketTiles()` | Category dropdown + totals tiles. |

---

## `renderer/liquidation.js` — Liquidation tab (~640 LOC)

[renderer/liquidation.js](renderer/liquidation.js). Self-contained IIFE loaded after `app.js` (reuses `$`/`$$`/`API`/`formatIsk`/`escapeHtml`/`readNdjson`). Three sub-views + a slide-out item-detail chart.

| Function | Purpose |
|---|---|
| `initLiquidationTab()` | Lazy first load (shipments + KPIs) on tab open. |
| `setSub(name)` | Switch Analyze / Shipments / Open-orders sub-view. |
| `runAnalyze()` / `analyzeFromContract(contractId, code)` | POST `/api/liquidation/analyze` from paste text or a courier contract's Janice code; consume the NDJSON stream. |
| `renderAnalyze()` / `renderAnalyzeTable()` / `analyzeRows()` | Summary tiles + clickable action pills, sortable table (default sort = net ISK), search + action filter, row-click copy, ⓘ detail button. |
| `exportRows(fmt)` / `download(...)` | Export the filtered+sorted rows to CSV/TXT (Blob download). |
| `createShipment()` | POST a tracked shipment from the current analysis. |
| `loadShipments()` / `renderShipments()` / `shipmentAction(act, id)` | Local tracked-shipment board + deliver/cancel/delete. |
| `loadCourier()` / `renderCourier()` | Live ESI courier contracts, provider-only by default (`liq-courier-all-providers` toggle), per-row Analyze. |
| `loadOrders()` / `renderOrders()` | Live corp Jita sell orders with fill %, undercut/STALE flags. |
| `openDetail(typeId, name)` / `loadDetail()` / `renderDetail()` / `buildChart(hist, sig)` | Slide-out market-detail panel: inline-SVG price+volume chart (30/90/365d) + live book stats. |
| `renderKpis()` | Capital-at-risk KPI strip (in-flight value/courier, listed value, stale capital). |
| `copyName(name)` / `toast(msg)` | Clipboard copy + transient confirmation. |

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
