# v3.0.0 — Ship Fitting (Pyfa engine), Production Planner, D-Scan & more

## Ship Fitting tab (new) — Combat group
A full ship fitter built on **Pyfa's `eos` calculation engine**, run headless in the app:
- **Browse ships & modules** (filtered to what your ship can actually fit), load **compatible
  ammo/scripts**, add **drones / implants / cargo**, and **T3 subsystems + tactical mode**.
- **Configurable pilot skills** (All V / All 0 / custom default + per-skill overrides).
- **Module grouping** — collapse identical modules into one ×N row; ammo + state changes
  propagate to the whole group.
- Ship render + module/ammo **icons** and a per-slot **detail line** (CPU/PG, cap, cycle,
  optimal+falloff, tracking).
- A **Pyfa-style stats panel** — DPS (+ damage-type breakdown), **EHP with resists** (EHP/HP
  toggle), **stable vs max reps**, capacitor, navigation/targeting, and CPU/PG/calibration
  bars — plus a **Graphs** tab with **Effective DPS vs distance**.
- **Open & save fits to the in-game fitting window via ESI** (a dedicated *Fitting Characters*
  auth section, or your main slots), plus **EFT import/export** and local save/load.

> Because eos's calc core is GPLv3, the app is now distributed under the **GPL v3**.

## Production Planner (new) — RAVWorks-style industry
Plan multi-tier **manufacturing + reactions**: paste a build list and your on-hand stock, and
get the **jobs to run** and the **raw materials to buy**, priced at Jita — with ME + structure/
rig bonuses, **buy-vs-build** overrides, **T2 invention** (datacores/decryptors/ME), and **job
install-cost** estimates.

## D-Scan share tab (new)
Paste an in-game **D-Scan** and get a shareable **dscan.info** link.

## Processed Orders (new) — Operations → Buybacks
Search finished inbound buyback contracts by item name (e.g. "robotics") — contracts alliance
pilots sent privately and an NLDO member accepted.
- Results show **matching items first**, with the rest collapsed under "+ N more items"; each card
  lists **contract ID, issuer, accepted date, title, and price**.
- A **live progress bar** as ESI pages and contract items stream in, and **item data is cached**
  after the first search so repeats are much faster. Covers roughly the last 1,000 contracts.

## Quality-of-life
- **SRP**: fleet requests now sort by pilot name.
- **Ore Buyback**: contracts ordered **oldest-first** with an "issued N days ago" label.
- **Navigation**: a new **Combat** group (Fitting + D-Scan) and the **Planetary** group
  (PI Planner & Builder + PI Colonies).

---

### Downloads

| Platform | File | Install |
|---|---|---|
| macOS (Apple Silicon) | `*.dmg` | Open the DMG, drag into Applications |
| Windows | `*.exe` | Run the installer |
| Linux — Debian/Ubuntu | `*.deb` | `sudo apt install ./<file>.deb` |
| Linux — Fedora/RHEL/openSUSE | `*.rpm` | `sudo rpm -U <file>.rpm` (or `sudo dnf install ./<file>.rpm`) |

The `.deb`/`.rpm` packages are unsigned (RPM tools may warn about a missing GPG signature — expected). The in-app updater picks the format matching your distro.

_Full release history: see [CHANGELOG.md](CHANGELOG.md)._
