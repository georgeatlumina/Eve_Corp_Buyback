# Naval Defence Alliance Management Tool

Electron + Python desktop app for validating EVE Online corporation buyback
contracts and computing recommended payouts for moon-mining contracts.

It pulls outstanding contracts from ESI, appraises them against Janice, checks
that they were issued to the correct structure for their item category, and —
for moon contracts — refines the compressed ore and reports a recommended ISK
payout. Highlights:

- **Buyback + Moon** tabs with click-to-copy payout figures, EVE-mail
  templates for one-click accept/reject, an **outstanding-to-be-accepted
  total** at the top of each page (counts only the rows you'd actually pay
  out), and live progress as the streaming fetch runs.
- A **Working** tab for offline admin processing — pin any moon row, paste
  the real refined minerals from the refinery into a per-pin Janice paste
  box, get back the buy total × the contract's blended payout fraction.
  Pins persist across app restarts.
- An **Appraisal** tab for one-shot Janice work — Buy / Split / Sell
  totals with 80/90/100/110/120% chips on every headline figure for instant
  buyback math, plus a shareable Janice link.
- A **Contracts** dashboard that tallies corp-posted doctrine fits against
  user-configured quotas. **Alliance quota sync** via a private GitHub repo
  (Contents API + fine-grained PATs split read/write) so the admin edits
  once and everyone pulls.
- An **Alliance Auth doctrine readiness scanner** that cross-references
  each fit against the configured structure's market.
- A **Sov** tab built on public ESI (IHUB ADM, system jumps/kills,
  incursions) — no auth required.
- An **Indy** section (Build Planner + Build Fulfilment) for industry
  pilots — plan doctrine builds, paste in-game missing-material lists, and
  let directors aggregate every builder's shortfall against alliance stock.
- A **Stockpile** tab exposing the alliance's on-hand minerals / PI / other
  materials, with a one-click Janice appraisal of the whole pile.

> Internal docs: [CONTEXT.md](CONTEXT.md) (architecture & key flows),
> [STRUCTURE.md](STRUCTURE.md) (file layout), [FUNCTIONS.md](FUNCTIONS.md)
> (function-level index).

## Install

Download the latest release for your platform:

https://github.com/georgeatlumina/Eve_Corp_Buyback/releases/latest

- macOS (Apple Silicon): `EVE-Corp-Buyback-X.Y.Z-arm64.dmg`
- Windows: `EVE-Corp-Buyback-Setup-X.Y.Z.exe`

## Quick start

1. **Configure** — open the **Config** tab and set your corp ID, structures,
   markets, refining/payout fractions, and (optionally) the home-structure ID
   + ship quotas for the Contracts dashboard (see
   [Configuration](#configuration) below). Save.
2. **Authenticate** — open the **Auth** tab. **Slot 1** is required and is
   used for wallets, corp contracts, and mail; click *Login with EVE Online*
   on slot 1 and sign in with the character holding the corp roles. **Slots
   2 & 3** are optional alts: if they hold director / Contract Manager roles
   in *other* alliance corps, logging them in widens the Contracts-tab
   coverage to those corps.
3. **Fetch buyback contracts** — go to the **Buyback** tab and click *Fetch &
   validate*. Each outstanding contract is appraised against Janice and
   checked against your routing rules. Green = approve, red = reject, with the
   failure reason shown inline.
4. **Process moon contracts** — go to the **Moon** tab and click *Fetch &
   process*. Each moon (item-exchange, price = 0) contract is refined using
   your configured efficiencies and a recommended payout is shown. Use the
   built-in calculator sidebar to quickly multiply by 70/80/90% if you want
   to adjust on the fly.
5. **Check doctrine stocking** — go to the **Contracts** tab and click *Scan
   contracts*. The app walks every authenticated slot's corp endpoint,
   filters to outstanding item-exchange contracts at your home structure,
   and tallies each one against the configured quotas. Per-quota progress
   bars go green/amber/red; the *Export gap CSV* and *Copy shopping list*
   buttons make it easy to top up missing stock. If the alliance is on the
   private-repo workflow, ticking *Auto-sync on app start* keeps your local
   quotas in lockstep with the shared `quotas.json`.
6. **Process pinned contracts offline (Working tab).** On the Moon tab,
   click *📌 Pin to Working* on any result row to copy the full snapshot
   into the Working tab. Open the pin, paste the actual refined-mineral
   output from your refinery into the Janice paste box, hit *Appraise &
   apply N%* — the app re-runs the Janice appraisal and multiplies by the
   contract's blended payout fraction. Notes + status (`pending` / `paid`
   / `disputed`) persist on disk; pins survive app restarts and Moon-tab
   re-fetches.
7. **One-shot appraisals (Appraisal tab).** Paste any EVE-format inventory
   (Ctrl/Cmd-Enter to fire), get a Janice block with Buy / Split / Sell
   totals. Click any headline or percentage chip to copy the integer.
8. **Send mail** — once mail presets are configured (Mail tab), every contract
   row gets a button per preset. Click it to preview the rendered mail and
   send it to that contract's issuer.

## Configuration

All settings live on the **Config** tab and are persisted to
`<userData>/.eve_auth/config.json` (chmod 600). You can also override the
storage location with the `EVE_BUYBACK_DATA_DIR` env var.

### Corporation ID

Numeric EVE corp ID. Contracts are pulled for this corp; the authenticated
character must be a member with `Accountant` (wallet) and `Contract Manager`
or equivalent roles.

### Janice market

The market hub used as the price reference for buyback appraisal. Buyback
contracts are considered fairly priced when the contract price is at most
**90% of Janice's buy value** at this market. Choices: Jita 4-4, Amarr,
Dodixie, Rens.

### Structures & routing rules

Each structure has a name, an EVE `structure_id`, and one or more **accepts**
flags:

| Flag       | What gets routed there                                  |
|------------|---------------------------------------------------------|
| `ore`      | Ore/compressed-ore buyback contracts                    |
| `non-ore`  | Everything else (modules, ships, PI, etc.)              |
| `moon`     | Moon contracts (any structure with this flag is valid)  |

A buyback contract is **rejected** if it was issued at a structure whose
accepts list doesn't cover its item category. Moon contracts only need to
land at any structure with the `moon` flag.

The structure_id is the number EVE assigns to the Upwell structure. Easiest
way to grab it: right-click the structure in-game → *Set Destination* → copy
from the URL, or pull from a recent contract.

### Moon contracts

Moon contracts are paid out on **refined mineral value**, not the Janice
appraisal of the compressed ore. The app shows both: Janice is informational,
the refined-mineral figure is what you pay.

- **Trade hub** — market used to price refined minerals.
- **Moon-ore refining efficiency** (0–1) — applied to R4–R64 moon ore (raw,
  compressed, and graded variants). Default `0.78`.
- **Non-moon-ore refining efficiency** (0–1) — applied to regular ore that
  occasionally ends up in moon contracts. Default `0.78`.
- **Ice refining efficiency** (0–1) — applied to ice products. Default
  `0.78`.
- **Moon ore payout fraction** (0–1) — fraction of refined value paid to the
  contractor for moon ore. Default `0.80` (80%).
- **Non-moon ore & ice payout fraction** (0–1) — payout fraction for
  non-moon ore and ice. Default `0.90` (90%).

Refined payout = refined mineral value × payout fraction.

### Contracts dashboard — home structure & quotas

The **Contracts** tab tracks outstanding doctrine fits posted by your corp
(and any other corp that an authed slot holds Contract Manager / Director
roles in) at one structure.

- **Home structure ID** — the numeric `start_location_id` ESI uses for that
  station/citadel. Right-click the structure in-game → *Set Destination* →
  copy from the URL, or pull from one of the contracts in the Buyback tab.
  Despite the name, this field accepts both NPC station IDs and player
  structure (citadel) IDs.
- **Home region ID (optional)** — only used by the *Lookup region* button
  (which derives the region from an NPC station ID via ESI). Not required
  for the contracts scan itself. The lookup button does not work for player
  structures — enter the region manually if needed.
- **Ship/doctrine quotas** — spreadsheet-style table with five columns:
  *Fit name*, *Ship type ID*, *Ship name*, *Required*, *Title filter
  (optional)*. The Ship type ID and Ship name columns are backed by a
  type-ahead dropdown of every published EVE ship hull (fetched once,
  cached to `<userData>/eve_auth/ship_types.json`); picking one auto-fills
  the other. A contract counts toward a quota when:
  - the contract contains at least one item with the quota's `ship_type_id`
    (matched on `is_included=true` items), and
  - the optional `title_filter` substring (case-insensitive) matches the
    contract title (used for distinguishing doctrine variants, e.g.
    `shield` vs `armor`).

  Each row is independent — a contract with 2 Cerberi counts as 2 toward
  the Cerberus quota.

**Bulk-editing quotas:** paste rows directly from Excel / Google Sheets
(tab- or comma-separated) into any quota cell to expand into multiple rows.
The *Import CSV…* / *Import JSON…* buttons load a `quotas.csv` /
`quotas.json` file from disk (prompts replace-or-append). *Export CSV* /
*Export JSON* save the current quota list. CSV header:
`name,ship_type_id,ship_name,required,title_filter`.

**ESI limitation worth knowing.** The in-game "my alliance" contracts tab
uses a non-ESI backend, so contracts posted by other alliance corps that
you don't hold a director / Contract Manager token for **stay invisible**.
Add more slots on the Auth tab to widen coverage one corp at a time.

### Alliance quota sync — private GitHub repo

If you want every alliance member working off the same quota list, host
`quotas.json` in a **private GitHub repo** and let the app pull from there.
Setup:

1. **Create the repo** with a single `quotas.json` at the root (or any
   path — the app accepts the full URL).
2. **Generate two fine-grained PATs** at
   <https://github.com/settings/personal-access-tokens/new>:
   - **Read PAT** — repository access = your alliance repo only,
     *Permissions → Contents: Read-only*. Distribute this PAT to every
     alliance member via Discord / AA / wherever.
   - **Write PAT** — same repo, *Permissions → Contents: Read and write*.
     Keep on your admin machine only.
3. **Admin fills the Config tab** with the repo URL (any of these works —
   the parser handles all of them):
   ```
   https://github.com/<owner>/<repo>.git                  (Clone URL)
   https://github.com/<owner>/<repo>                       (bare repo)
   https://github.com/<owner>/<repo>/blob/main/quotas.json (file URL)
   https://raw.githubusercontent.com/<owner>/<repo>/main/quotas.json
   ```
   plus Read PAT, plus Write PAT, plus tick **Allow push from this machine**
   (un-hides the *Push to repo* button). Save.
4. **Users fill the Config tab** with the same URL + the Read PAT only.
   Optionally tick *Auto-sync on app start*. Save → *Sync now* once to
   populate.
5. **Updating quotas:** admin edits the table → *Push to repo* commits
   `quotas.json` back to the repo via the Contents API and returns a
   clickable commit link in the sync-status chip. Users' next launch
   (auto-sync) or their next *Sync now* click picks up the change.

**Distributing the kit** is the *Backup & share* fieldset. *Export config*
downloads a JSON file containing every Config-tab setting. Sensitive keys
have separate behaviour:
- *Janice API key* and *Read PAT* — opt-in via a confirm() prompt at
  export time. Include both for an alliance-distribution kit, then
  recipients import → Save → they're synced immediately.
- *Write PAT* and *Allow-push* flag — **never** included in exports, even
  in personal-backup mode. Admin write capability must be pasted into the
  field on the target machine; it never rides along in a JSON file.

If you'd rather skip the PAT plumbing entirely, you can also paste the URL
of a **secret GitHub gist** containing the quota JSON — the app's backend
still resolves gist URLs (no UI hint), syncs them anonymously, and there's
no push step.

### Janice API key (optional)

Paste your `X-ApiKey` from [janice.e-351.com](https://janice.e-351.com/) to
get higher rate limits. Without a key the app falls back to anonymous
requests, which are fine for small corps but can throttle when you have
many contracts.

### Working tab (no config needed)

The **Working** tab is an offline workspace for moon-contract triage.
Workflow:

1. On the **Moon** tab, click *📌 Pin to Working* on any row. The full
   snapshot (items, refined breakdown, recommended payout, flags) is
   POSTed to the sidecar and persisted at
   `<userData>/eve_auth/pinned_contracts.json`. Survives app close + the
   next Moon-tab re-fetch.
2. Open the pin's card on the Working tab. The header shows the original
   snapshot's recommended payout + the **blended payout fraction** the app
   derived once at pin time (`(moon_payout + non_moon_payout) /
   (moon_value + non_moon_value)` — the effective rate to re-apply on any
   future appraisal of the actual refined output).
3. Paste the actual refined minerals from your refinery into the Janice
   paste box. *Pre-fill from snapshot* drops in the original calculated
   refined breakdown if you want a starting point.
4. *Appraise & apply N%* runs the Janice appraisal (persist on, so the
   returned `code` is a shareable `janice.e-351.com/a/…` URL) and
   multiplies the buy total by the blended fraction. The final payout is
   click-to-copy.
5. *Status* dropdown (`pending` / `paid` / `disputed`) drives the left
   border colour. *Notes* auto-save on blur. Both persist on disk with
   the pin.

A calculator sidebar identical to the Moon tab's lives on the right; toggle
with *Hide calculator* or pop it out into its own window.

### Appraisal tab (no config needed)

One-shot Janice appraisal pad:

- Paste any EVE-format inventory (drag from cargo bay, hangar, contract
  window — anything Janice accepts).
- Pick a market hub (defaults to your configured Janice hub).
- Hit **Appraise** or `Ctrl/Cmd + Enter`.

You get back:
- **Three side-by-side price columns** — Buy / Split / Sell — each with
  a click-to-copy headline and a row of 80 / 90 / 100 / 110 / 120 %
  percentage-modifier chips (also click-to-copy). Buyback admins can grab
  "90 % of Jita buy" without doing the math.
- An **effective-prices** drawer (smoothed via recent history) when those
  figures differ from the immediate book.
- A **shareable Janice link** (tick "Save a shareable Janice link") that
  copies/opens the appraisal on janice.e-351.com.

### Mail templates (Mail tab)

Up to four named presets. Each preset becomes a button on every contract
row. Templates support these variables:

`{contract_id}` `{issuer_name}` `{date}` `{title}` `{price}` `{location_id}`
`{errors}` `{appraisal_percentage}` `{effective_offer}` `{payout}`
`{refined_value}`

Clicking a preset on a row renders the template, opens a preview/edit modal,
and sends via ESI (requires the mail scope, which is requested on login).

### Doctrines & Readiness (optional)

If you run Alliance Auth at `auth.navaldefence.org`, the **Doctrines** tab
will pull fittings and the **Readiness** tab will cross-reference them
against the first configured structure's market. Sign in once via the in-app
button; the session is remembered. Capital-tier fits are excluded by default
— toggle in the Readiness *Settings* drawer.

### Sov tab (no config needed)

The **Sov** tab aggregates public-ESI sovereignty data (IHUB ADM, system
ownership map, active campaigns, system jumps/kills, incursions) into a
single dashboard. No auth required — it runs entirely off public
endpoints.

### Hooks & Hubs tab (admin — needs a Director slot)

Admin dashboard for Orbital Skyhooks and Sovereignty Hubs, in two halves:

- **Structure fuel (live ESI).** Pulls `fuel_expires` from
  `/corporations/{corp_id}/structures/` and shows, per type, an overview tile
  (count · low-fuel count · soonest expiry) plus a per-structure table sorted
  by time remaining (red < 3 days, amber < 7). Requires the
  `esi-corporations.read_structures.v1` scope on a **Director** character —
  log that toon into the new **slot 4** on the Auth tab. (Any authenticated
  slot whose token carries the scope + role contributes; structures are
  deduped.) After upgrading you must re-login so the new scope is granted.

- **Upgrade & workforce planner (manual).** ESI does **not** expose Equinox
  power, workforce, installed upgrades, or the skyhook collection reservoir,
  so this half is a manual planning table persisted locally
  (`<userData>/eve_auth/workforce_plan.json`). Enter each system's power and
  workforce, assign upgrades from an editable catalog, and add workforce
  transfers between systems. The app live-checks feasibility — **power is
  local (a system's own balance must stay ≥ 0); workforce can be transferred
  between systems** — flipping rows green/red as you shuffle upgrades or move
  workforce. *Import systems from my sov hubs* seeds the table with the system
  names from the fuel half. Edit freely (the sandbox) then **Save plan**;
  **Reload** discards unsaved changes.

### Market-history repo — Doctrine Stock, Indy & Stockpile

The same private **market-history GitHub repo** (plus its read/write PATs)
that backs Doctrine Stock now also powers the **Indy** builds and the
**Stockpile** tab. It works exactly like the quota-sync repo above: a
**read PAT** (*Contents: Read-only*) goes to every member so they can pull
published Doctrine Stock, the aggregated builds, and the alliance stock; a
**write PAT** (*Contents: Read and write*) goes only to the people who
publish or submit — directors pushing stock, and builders submitting their
own build files. Set both in the market-history fields on the Config tab.
Without the write PAT, submitting a build or saving stock falls back to a
local-only save (nothing reaches the alliance).

### Indy — Build Planner & Fulfilment

The **Indy** section is for industry pilots and is **only visible to
characters in the Alliance Auth "Industry Pilot" group** (and to anyone in
Admin view). To unlock it, sign into Alliance Auth from the **Doctrines**
tab as a character who is in that group. If you don't see Indy, you're
either not signed in or not in the group — ask a director to add you.

**Build Planner** (every industry pilot):

1. Click **+ New build**.
2. Pick the doctrine you're building from the dropdown — it lists
   *Ship — Doctrine* entries pulled from the published Doctrine Stock.
3. Set an **estimated completion date** and, optionally, add a note.
4. Click the paste box to open the side drawer, then paste the in-game
   job's **missing materials**: open the industry job, right-click the
   missing-materials list, *Copy*, and paste. The app parses it into a
   categorised material list.
5. Click **Save & submit**. Your builder name is filled in automatically
   from your signed-in character.

The **Most in demand** strip along the top highlights the hulls that are
currently most short of quota, so you can pick something useful to build.

Your builds save to your own file on the shared **market-history repo**, so
submitting needs the market-history **write PAT** set in Config (see
[Market-history repo](#market-history-repo--doctrine-stock-indy--stockpile)
above). Without it, builds are saved locally only and won't be visible to
directors.

**Build Fulfilment** (directors): aggregates every builder's missing
materials into one list and compares the total against alliance stock (the
Stockpile). Rows are colour-coded by how much of each material can currently
be filled from stock, and the table sorts by biggest shortfall or by
soonest deadline. **CSV** and **shopping-list** exports make it easy to go
buy or haul what's missing.

### Stockpile tab

The **Stockpile** tab is a read-only view of the alliance's on-hand stock —
minerals, PI, and other materials — pulled from the shared market-history
repo. It's gated on Alliance Auth membership: you must be signed in as a
character in the group named in **Auth group name** on the Config tab
(default **"Industry"**).

Admins who tick **Allow stock edits** get a paste/save panel revealed on the
tab: paste an in-game inventory list (from a hangar, container, or corp
hangar) and save to publish it as the new alliance stock. Pushing the update
needs the market-history **write PAT** in Config; without it the save stays
local.

A **Copy Janice appraisal** button copies a shareable Janice link for the
*entire* stockpile to your clipboard, so you can paste a valuation into
Discord or open it in a browser.

## Troubleshooting

### macOS — "App is damaged and can't be opened"

The macOS builds are ad-hoc signed but **not** notarized by Apple, so the
first launch trips Gatekeeper. If you see *"Naval Defence Alliance Management Tool.app is damaged
and can't be opened. You should move it to the Trash."*, this is **not** a
corrupted download — it's macOS refusing to run a non-notarized binary.

Clear the quarantine flag from a Terminal:

```bash
xattr -cr "/Applications/Naval Defence Alliance Management Tool.app"
```

If the app is still in your Downloads folder, point at that path instead:

```bash
xattr -cr ~/Downloads/EVE\ Corp\ Buyback.app
```

After that the app opens normally. You may still see a standard *"unknown
developer"* prompt on the very first launch — click **Open** and macOS
remembers the choice for future launches.

### Windows — SmartScreen warning

Windows SmartScreen will show *"Windows protected your PC"* on first run
because the installer is unsigned. Click **More info → Run anyway**.

### Auth says "not authenticated" after login

Make sure the character you signed in with is actually a member of the corp
ID you configured, and has roles to read corp contracts/wallets. If the
config was saved with a different `corp_id` after authenticating, log out
and log back in.

### Contracts tab shows 0 contracts even though there are clearly some in-game

Most likely you're looking at contracts posted by *other* alliance corps —
the in-game "my alliance" tab uses CCP's non-ESI client API, so ESI only
exposes contracts your authenticated tokens are party to (issuer/acceptor/
assignee, including corps each slot is a director of). To widen visibility:
log in additional slots on the Auth tab with directors / Contract Managers
of the other alliance corps. See the *Contracts dashboard* config section
above for details.

### Quota sync says "404 — file not found"

The repo URL parsed correctly but `quotas.json` isn't there yet. The first
*Push to repo* from the admin's machine creates the file. If you're a user
who hasn't seen any quotas published yet, ask the admin to push once.

### Alliance quota sync says "401 / 403 — token rejected"

Your PAT is missing the right scope or doesn't have access to the repo.
Common gotchas:
- Fine-grained PATs default to **no** repository access. Open the PAT
  settings and add the alliance repo explicitly.
- Read PAT needs *Contents: Read-only*; Write PAT needs *Contents: Read
  and Write*. The app surfaces a hint that distinguishes the two.

### Working-tab pin disappears after re-running Moon-tab fetch

Pins are stored independently of the live Moon-tab result list, so they
survive re-fetches by design. If a pin vanished, the on-disk file at
`<userData>/eve_auth/pinned_contracts.json` was either deleted or
corrupted. Check the file — invalid JSON is treated as "no pins".

### `Pin failed: HTTP 404` on Windows after installing a new version

An older app instance (or a force-quit one) left its sidecar.exe running,
holding port 8765. The new install's sidecar can't bind, exits, and the
orphan keeps serving 404s on new routes. **Fixed in v1.1.3+** — every
launch now runs `taskkill /F /IM sidecar.exe` before spawning. If you're
on a pre-1.1.3 install, end the orphan in Task Manager (Details tab) and
relaunch.

## Running from source (development)

```bash
pip install -r python/requirements.txt
npm install
npm start
```

The Electron app spawns the Python sidecar (`python/server.py`) automatically.
Config and tokens are written under `.eve_auth/` next to the repo when running
from source, or under the OS userData dir in packaged builds.
