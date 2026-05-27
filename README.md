# Naval Defence Alliance Management Tool

Electron + Python desktop app for validating EVE Online corporation buyback
contracts and computing recommended payouts for moon-mining contracts.

It pulls outstanding contracts from ESI, appraises them against Janice, checks
that they were issued to the correct structure for their item category, and —
for moon contracts — refines the compressed ore and reports a recommended ISK
payout. It also ships with EVE-mail templates so you can accept/reject in one
click, and an Alliance Auth doctrine readiness scanner.

## Install

Download the latest release for your platform:

https://github.com/georgeatlumina/Eve_Corp_Buyback/releases/latest

- macOS (Apple Silicon): `EVE-Corp-Buyback-X.Y.Z-arm64.dmg`
- Windows: `EVE-Corp-Buyback-Setup-X.Y.Z.exe`

## Quick start

1. **Configure** — open the **Config** tab and set your corp ID, structures,
   markets, and refining/payout fractions (see [Configuration](#configuration)
   below). Save.
2. **Authenticate** — open the **Auth** tab and click *Login with EVE Online*.
   A browser window opens; sign in with the character that has the corp roles
   to read contracts and wallets. Approve the scopes and return to the app.
3. **Fetch buyback contracts** — go to the **Buyback** tab and click *Fetch &
   validate*. Each outstanding contract is appraised against Janice and
   checked against your routing rules. Green = approve, red = reject, with the
   failure reason shown inline.
4. **Process moon contracts** — go to the **Moon** tab and click *Fetch &
   process*. Each moon (item-exchange, price = 0) contract is refined using
   your configured efficiencies and a recommended payout is shown. Use the
   built-in calculator sidebar to quickly multiply by 70/80/90% if you want
   to adjust on the fly.
5. **Send mail** — once mail presets are configured (Mail tab), every contract
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

## Running from source (development)

```bash
pip install -r python/requirements.txt
npm install
npm start
```

The Electron app spawns the Python sidecar (`python/server.py`) automatically.
Config and tokens are written under `.eve_auth/` next to the repo when running
from source, or under the OS userData dir in packaged builds.
