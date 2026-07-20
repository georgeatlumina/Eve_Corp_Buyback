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
shopping list for in-game multi-buy. Quotas can be edited locally or pulled
from a shared source of truth — either a "secret" GitHub gist (no auth) or a
private GitHub repo via the Contents API with fine-grained PATs (read +
write, separated by role).

A **Working** tab acts as an offline workspace for moon-contract processing:
the operator pins any moon-result row to a persistent on-disk list, then on
demand pastes the actual refined minerals (post-refinery) into a per-pin
Janice paste box. The app re-runs the appraisal, multiplies by the
contract's snapshot-derived blended payout fraction, and surfaces a copy-to-
clipboard final payout. Pins survive Moon-tab re-fetches, renderer refreshes,
and app close+reopen.

An **Appraisal** tab is a one-shot Janice appraisal pad. Paste any
EVE-format inventory dump; the app prices it through Janice and reports
Buy / Split / Sell totals. Click-to-copy percentage chips (80 / 90 / 100 /
110 / 120 %) sit next to every headline so the operator can grab "90 % of
Jita buy" for a buyback contract in one click.

A secondary feature scans corp doctrines from Alliance Auth (`auth.navaldefence.org`)
and cross-references each fit against the corp market for stocking gaps. A
**Sov** tab gives an at-a-glance read on alliance sovereignty (IHUBs, system
jumps/kills, incursions) — built on top of public ESI endpoints, no auth
required.

A **Hooks & Hubs** (admin) tab tracks Orbital Skyhook + Sovereignty Hub
**fuel** live from `/corporations/{id}/structures/` (`fuel_expires` → days/hours
remaining, per-type overviews). This is the one feature needing the
`esi-corporations.read_structures.v1` scope on a **Director** character, so it
gets a dedicated **slot 4** on the Auth tab (kept separate from the slot-1
wallet/contracts toon). The Equinox **power/workforce/upgrade** layer and the
skyhook collection reservoir are **not exposed by ESI at all**, so the tab's
upgrade/workforce planner is fed by a manual, locally-persisted table
([workforce_plan.py](python/workforce_plan.py)); scenario math (power is local
& non-transferable, workforce transfers between systems) is a pure client-side
function ([hooks-hubs-utils.js](renderer/hooks-hubs-utils.js) `computePlan`).

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
Python: ESI (auth, contracts, wallets, mail, structure markets) and Janice
(appraisals **and refined-mineral pricing**). Reprocessing yields ship as a
bundled, cerlestes-verified static CSV ([python/data/mineable_type_materials.csv](python/data/mineable_type_materials.csv));
Fuzzwork is no longer used (its CSV dumps were removed upstream).

```
┌──────────────────┐    fetch()     ┌─────────────────────┐
│ renderer (HTML / │ ─────────────► │ FastAPI sidecar     │
│ vanilla JS)      │  localhost     │ (python/server.py)  │
└────────┬─────────┘     :8765      └──────────┬──────────┘
         │ IPC (preload.js)                    │ HTTPS
         ▼                                     ▼
┌──────────────────┐               ┌──────────────────────┐
│ electron/main.js │               │ ESI · Janice ·       │
│ (windowing,      │               │ GitHub Contents API  │
│ AA session,      │               │                      │
│ auto-update)     │               └──────────────────────┘
└──────────────────┘
```

**Splash screen.** Electron paints a borderless splash window
([renderer/splash.html](renderer/splash.html)) while the sidecar boots —
progress events come through a dedicated preload bridge
([electron/splash-preload.js](electron/splash-preload.js)) so the bar
animates as `/api/health` polls succeed. The splash dismisses itself once
the main window is `ready-to-show`.

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

### Doctrine Stock dashboard (`POST /api/doctrine-stock/publish`, `GET /api/doctrine-stock`)

The Contracts scan needs a Contract Manager / Director ESI token, so only admins
can run it. To let ordinary members (indy pilots especially) see current stock
and gaps, the Contracts scan **auto-publishes** its per-alliance quota results —
`publishDoctrineStock` in [renderer/app.js](renderer/app.js) fires after each
`done` event and POSTs the lean quota rows (name / ship / required / available /
missing — no contract issuer or price data) to the sidecar, which writes
`doctrine-stock/<main|institute>.json` into the **market-history GitHub repo**
(reusing `market_history_repo_url` + its PATs; publish is gated on the Write PAT
being present, so a non-admin scanning their own corp never pushes). The push is
an idempotent overwrite (read sha → PUT).

The **Doctrine Stock tab** ([renderer/doctrine-stock.js](renderer/doctrine-stock.js))
is a read-only member view in the General nav group — open to anyone who has
authed a toon, no privileged role needed. It `GET`s the published snapshot (Read
PAT), falling back to a local cache when GitHub is unreachable, and renders the
same green/amber/red quota bars as the Contracts tab, sortable by biggest gap
with a gaps-only filter and gap-CSV / shopping-list exports. This deliberately
mirrors the industry **Stockpile** dashboard pattern (`inventory/stock.json` in
the same repo).

### Alliance quota sync (`POST /api/quotas/sync` and `/api/quotas/push`)

Quotas can live on a shared source of truth so the whole alliance pulls
from one file:

- **Private GitHub repo (recommended).** Admin creates a repo containing a
  `quotas.json` file, then issues two fine-grained PATs: a *Read PAT* with
  `Contents: Read` distributed to every alliance member, and a *Write PAT*
  with `Contents: Read and Write` kept on the admin's machine only. The
  app's `_parse_github_blob_url` accepts every URL shape GitHub hands you —
  blob, raw, Contents API, and the bare clone URL `github.com/<o>/<r>.git`
  (defaults to `main`/`quotas.json`). Reads go through the Contents API via
  `_github_contents_get`; the admin's Push button (gated behind the
  per-machine `alliance_quota_allow_push` checkbox so importing the admin's
  config doesn't auto-unlock writes) PUTs the local quota list back via
  `_github_contents_put`, returning a commit SHA the renderer turns into a
  clickable link in the sync-status chip.
- **GitHub gist (legacy, still wired).** Bare gist URLs route through
  `_resolve_gist_page_url`, which hits the Gists API to discover the
  raw-file URL. The UI no longer advertises this option (only the
  private-repo path is documented), but the backend still accepts gist
  URLs — paste one and it still syncs. Use this if you don't want to set
  up PATs.

Last-sync metadata (`alliance_quota_last_synced` / `_last_status`) lives on
disk only and is excluded from the whole-config export (recipient would
inherit a misleading "synced at" string otherwise). The *Write PAT* and
*Allow push* flag are likewise hard-stripped from exports — see
`CONFIG_EXPORT_NEVER` in [renderer/app.js](renderer/app.js). A config kit is
a distribution artifact, never an admin-credentials handover.

### Working tab (pinned moon contracts, `/api/pinned*`)

Offline workspace backed by [python/pinned.py](python/pinned.py). The
operator pins a Moon-tab result row; the full result snapshot is POSTed to
`/api/pinned` and persisted under `<userData>/eve_auth/pinned_contracts.json`
(chmod 600). Each pin records:
- `snapshot` — the moon-result dict verbatim.
- `blended_fraction` — derived once at pin time from the snapshot's
  refined block: `(moon_payout + non_moon_payout) / (moon_value +
  non_moon_value)`. Encodes the effective payout fraction the operator
  would apply to a re-priced refined output.
- `status` — `pending` / `paid` / `disputed`; drives the card's left-border
  colour.
- `appraisals[]` — bounded ring (20 records) of admin-pasted Janice
  appraisals. Each entry stores `janice_total`, `fraction_used`, `payout`,
  `janice_code` (when the appraisal was persisted), and a paste preview.

When the operator clicks **Appraise & apply N%**, the paste text goes
through `create_appraisal_from_text` (janice.py) with `persist=True` so the
returned code is shareable, then the blended fraction multiplies the
Janice buy total. Result is appended to the pin's appraisal history. All
payout figures (snapshot original, latest appraisal, every history row)
are wrapped in `.payout-copy` for one-click copy-just-the-integer paste
into the in-game wallet.

### Appraisal tab (`POST /api/appraise`)

One-shot Janice appraisal. The renderer sends `{paste_text, market_name,
persist}` to `/api/appraise`. The sidecar:

1. `create_appraisal_from_text` against Janice. Returns per-item rows.
2. Surfaces the immediate and effective Buy / Split / Sell totals from the
   Janice response, plus a shareable `code` when `persist` is set.

Renderer shows three side-by-side price columns for the Janice block
(Buy / Split / Sell), a percentage chip row (80/90/100/110/120%) under each
headline with click-to-copy values, an effective-prices drawer when those
differ from the immediate book, and a copyable shareable Janice link.

### Outstanding-payout totals (Buyback + Moon tabs)

At the top of both pages, below the wallet tiles, sits a single panel:

```
Outstanding to be accepted     1,234,567,890   ISK     12 approve rows
```

Renderer-only. `_rowAcceptValue(kind, r)` returns the row's payout when its
`classifyResult` is `approve`, zero otherwise (rejects + errors ignored —
only what the corp would actually pay out). `renderPayoutTotal(kind)` sums
across `lastResults[kind]`, formats with thousand separators, and writes to
`#buyback-payout-total` / `#moon-payout-total`. Updated on every
`appendResultIfMatch` (so it ticks up live as each result lands during a
streaming fetch), every filter pill click, and the start-of-stream reset.

Buyback per-row value = `appraisal.effective_offer` (Janice value × 90% in
the standard flow), falling back to the contract's listed price when no
appraisal block is present. Moon per-row value =
`payout.refined.recommended_payout`. The headline number is wrapped in
`.payout-copy` so a single click copies just the integer for in-game
paste.

### Market analytics tab (`GET /api/market/analytics/stream`, `POST /api/market/history/archive`)

A general-tab dashboard over the **first configured structure's** live order
book. NDJSON-streamed from `_analytics_stream` (reuses the same paginated
`fetch_structure_orders_paged` + 5-minute `_market_cache` as the AA market
view); `_analyze_orders` folds the full buy+sell book into per-type rows
(best sell/buy, order counts, units, ISK depth, spread) plus market-wide
totals (incl. **total sell value** and **total buy value on book**). The
market is seeded mostly with sell orders, so the UI leads with sell-side
liquidity. Item names + market categories come from
[python/market.py](python/market.py), which resolves each `type_id` via ESI
(`fetch_type_info`→group→category) and caches the result to `type_meta.json`
— the Fuzzwork CSV dumps that previously served this were removed upstream, so
the loader is ESI-only. **Snapshot only**: ESI exposes no per-structure
history.

The renderer lives in its own [renderer/market.js](renderer/market.js) (loaded
after `app.js`, reuses its globals) — kept out of `app.js` deliberately. It
does all sort / search / category + numeric filtering client-side over the one
cached payload, with a **doctrine lens** toggle that swaps the table to
doctrine-required items only (read straight from the Readiness scan in
localStorage — `aa.scan.v1` / `aa.toggles.v1`, reusing the `fitIsEnabled`
rule) and computes **quantity-aware shortfall** (required Σ across enabled
fits vs units on market → missing / short / stocked).

**Daily history archive.** Because ESI has no structure history, the app
builds its own: `POST /api/market/history/archive` gzips the full-depth
snapshot (`{date, structure_id, fetched_at, order_count, summary, orders}`)
and PUTs it to `market-history/<structure_id>/<YYYY-MM-DD>.json.gz` in a
**dedicated** private GitHub repo via the Contents API (binary helpers
`_github_put_bytes` / `_github_path_sha`). `market.js` fires it
opportunistically after each load; the server gates it (configured? <24h
since last push from this machine? today's file already present?) and is
idempotent — a 409 race with another client counts as success. Every client
archives (no admin gate). ~18 KB/day gzipped (~6 MB/yr). The per-type `summary`
block keeps the read-back path cheap.

**Turnover read-back.** `GET /api/market/history/turnover` reads the archive
back (Read PAT) and reports **net on-book change** over 24h / 72h / weekly /
monthly. It lists `market-history/<sid>/` (`_github_list_dir`), fetches only the
latest snapshot plus each window's baseline (`_github_get_bytes` raw media type
+ gunzip, cached per date since files are immutable), and folds them with the
pure `_select_baselines` + `_compute_turnover`. **These are order-book
snapshots, not trades** — "turnover" here is the delta in *listed* sell/buy
value between a window's endpoints, not measured trade volume (the deliberate
product choice: honest and unambiguous over a noisy sold-vs-cancelled estimate).
A window degrades to `coverage: partial` (not enough days yet, baseline = oldest
snapshot) or `insufficient` (<2 snapshots), so the Market-tab cards fill in as
daily archives accumulate.

### Liquidation tab (`/api/liquidation/*`)

The buyback pipeline pays contractors **90% of the Amarr buy price** and leaves
the goods in the home structure. The Liquidation tab manages turning that
inventory back into ISK by shipping it to Jita (PushX courier) and selling it
for more than it cost. Three sub-views:

1. **Analyze / Plan.** Paste a courier contract, or one-click **Analyze →** a
   courier contract straight from its title (the title is a Janice appraisal
   URL). Items are resolved via Janice (type_ids + packaged volume), then priced
   from the **live Jita ESI order book** (best sell / best buy — range-aware for
   buy orders), with the cost basis from `90% × Janice Amarr buy` and days-to-sell
   from **real ESI traded volume**. `liquidation.analyze_row` produces, per item,
   the net margin listing vs dumping (net of Jita broker fee + sales tax +
   allocated courier), and a recommendation — `list` (with the shortest
   7/14/30/90-day window that fits the expected sell time), `dump` (hit a buy
   order now when velocity beats holding), or `underwater`. The table defaults to
   **sort by absolute net ISK** and flags near-zero-cost-basis items
   (`low_confidence`, e.g. SKINs) whose margin % is meaningless. Exportable to
   CSV/TXT; each item has a slide-out detail chart (ESI price+volume history +
   live book).

2. **Shipments.** Live ESI **courier contracts** (filtered to the configured
   provider, "Push Industries", by default) bucketed active/completed/failed,
   plus a **tracked-shipment board** — the board is one JSON doc stored on the
   **market-history GitHub repo** (`liquidation/shipments.json`, shared across
   admins, SHA-checked writes via the existing Contents-API helpers) with a local
   file as cache/fallback. PushX courier cost is computed from the rate card
   (base + collateral steps + rush).

3. **Open orders.** The corp's live Jita **sell** orders (ESI, needs
   `esi-markets.read_corporation_orders.v1` + Accountant/Trader role), enriched
   with fill %, whether we're undercut, days-to-sell, window time-remaining, and
   a **STALE** flag when an order has sat far longer than its expected sell time
   — the anti-"ISK locked in non-movers" signal.

The design bias: rank by **ISK velocity** (annualized ROI) not raw margin, so a
thin-but-fast flip beats a fat-but-stuck listing. Prices are live ESI (needed
anyway for liquidity); only the Amarr cost basis and item resolution use Janice.

## Data & persistence

Everything user-specific lives under `EVE_BUYBACK_DATA_DIR`:
- Packaged app: `<userData>/eve_auth/` (e.g. `~/Library/Application Support/Naval Defence Alliance Management Tool/eve_auth/` on macOS).
- Dev: `.eve_auth/` next to the repo root.

Files in that directory:
- `config.json` — chmod 600. Schema in [python/config.py](python/config.py)
  `DEFAULTS`. Old shapes are migrated forward by `_migrate` (note: migration
  runs **before** the `_USER_KEYS` filter in `load_config` so legacy keys
  like `home_station_id` → `home_structure_id` can be renamed without being
  silently dropped). Includes the alliance-quota-sync triplet
  (`alliance_quota_url`, `alliance_quota_pat_read`, `alliance_quota_pat_write`,
  `alliance_quota_allow_push`) and the per-machine sync metadata
  (`alliance_quota_last_synced`, `alliance_quota_last_status`). Also the
  market-history archive keys (`market_history_repo_url`,
  `market_history_pat_read`, `market_history_pat_write`, and the per-machine
  `market_history_last_archived`). Unlike the alliance-quota Write PAT (never
  exported), the market-history PATs are opt-in at export time.
- `tokens.json` — chmod 600. ESI tokens, dict keyed by slot
  (`slot1`/`slot2`/`slot3`); see Authentication flow above.
- `ship_types.json` — flat list of every published EVE ship hull
  (`type_id`, `name`, `group_id`, `group_name`). Built once via
  `fetch_all_ship_types`; manually refresh by hitting
  `/api/universe/ships?refresh=true` (e.g. after an EVE expansion).
- `pinned_contracts.json` — chmod 600. Array of pinned moon-result
  snapshots driving the Working tab. Schema in [python/pinned.py](python/pinned.py).
- `type_meta.json` — chmod 600. `type_id → {name, group_id, group_name,
  category_id, category_name}` cache backing the Market tab, filled lazily from
  ESI on first sight of a type (see [python/market.py](python/market.py)).
- `invTypeMaterials.csv` — Fuzzwork material dump, refreshed lazily. **Note:**
  Fuzzwork removed these CSV dumps upstream, so this download now 404s for any
  user without the file already cached — a latent bug in `refining.py`.
- `sidecar.log` — last sidecar run's stdout/stderr (truncated each startup).
- `liquidation.json` — chmod 600. Local cache/fallback of the Liquidation
  shipment board. The shared primary copy lives in the market-history GitHub
  repo at `liquidation/shipments.json` (SHA-checked writes); see
  [python/liquidation.py](python/liquidation.py) + the `_liq_*` helpers in
  server.py. Falls back to local-only when no repo URL / write PAT is set.

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
- **Hourly auto-update polling (v1.1.2).** Every install polls GitHub
  Releases once at startup (2 s delay) and then every hour. A
  `dismissedUpdateTag` guards against re-prompting in the same session
  after the user clicks Later, and an `updateDialogOpen` flag prevents
  stacking dialogs if the hourly tick fires while a dialog is still up. A
  manual ⟳ button next to the version chip in the header forces an
  immediate interactive check with friendly "you're up to date" feedback.
- **Orphan-sidecar sweep on launch (v1.1.3).** When the Electron main
  process is force-killed (Task Manager / crash), its spawned Python child
  can survive and keep port 8765 bound. A fresh install then fails to
  rebind, exits, and the orphan keeps serving 404s on every newly-added
  route. `killOrphanSidecars()` runs `taskkill /F /T /IM sidecar.exe` on
  Windows or `pkill -x sidecar` on macOS/Linux before every spawn — the
  common case is a no-op, the rare case is silently fixed. The dev-mode
  Python entry point uses `python3 server.py` which doesn't match the
  PyInstaller binary's image name, so dev runs are untouched.
- **Whole-config import/export reads the live form (v1.1.4).** Both
  handlers share one `collectConfigForm()` so unsaved edits (e.g. a freshly
  pasted gist URL) flow into the exported file without making the user
  Save first. The same `CONFIG_EXPORT_NEVER` set gates both directions —
  whatever's removed on export is also removed on import, keeping the
  asymmetry minimal.
- **Write PAT and Allow-push flag never ride along in exports (v1.1.6).**
  Hard-stripped via `CONFIG_EXPORT_NEVER` even though the Read PAT and
  Janice key are opt-in at export time. Distribution kits can carry read
  access (so a recipient syncs immediately after import); admin write
  capability is paste-on-target-machine only.
- **Janice gist transport kept in the backend after the UI removal
  (v1.1.6).** The private-repo path is the one documented option, but
  pasting a gist URL still routes through `_resolve_gist_page_url` and
  syncs. Backward-compat for installs that already have a gist URL saved;
  also a one-line revert path if the secret-gist option ever needs to come
  back to the UI.

## Common entry points

- Start app: `npm start` (spawns sidecar via `python3 python/server.py`)
- Build mac DMG: `npm run build:mac`
- Build Windows installer: `npm run build:win`
- Sidecar directly: `python3 python/server.py` then hit `http://localhost:8765/api/health`
- Logs: `<userData>/sidecar.log`
