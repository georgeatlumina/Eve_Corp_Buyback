# Naval Defence Alliance Management Tool

Electron + Python desktop app for validating EVE Online corporation buyback
contracts and computing recommended payouts for moon-mining contracts.

It pulls outstanding contracts from ESI, appraises them against Janice, checks
that they were issued to the correct structure for their item category, and —
for moon contracts — refines the compressed ore and reports a recommended ISK
payout. It also ships with EVE-mail templates so you can accept/reject in one
click, an Alliance Auth doctrine readiness scanner, a multi-account Contracts
dashboard that tallies corp-posted doctrine fits against user-configured
quotas, and a sovereignty overview built on public ESI data.

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
   buttons make it easy to top up missing stock.
6. **Send mail** — once mail presets are configured (Mail tab), every contract
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

### Janice API key (optional)

Paste your `X-ApiKey` from [janice.e-351.com](https://janice.e-351.com/) to
get higher rate limits. Without a key the app falls back to anonymous
requests, which are fine for small corps but can throttle when you have
many contracts.

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

## Running from source (development)

```bash
pip install -r python/requirements.txt
npm install
npm start
```

The Electron app spawns the Python sidecar (`python/server.py`) automatically.
Config and tokens are written under `.eve_auth/` next to the repo when running
from source, or under the OS userData dir in packaged builds.
