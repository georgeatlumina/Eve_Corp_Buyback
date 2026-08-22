# v3.7.0 — Acquisitions Build Finder, version picker & contract polish

## Acquisitions — Build Finder
- **Analyse Hulls / Analyse Fits** split results into four buckets — **completable from inventory**,
  **completable with market buys**, **partial builds**, and **out of reach** — with live progress bars.
- The shopping list shows the **UEXO vs Jita cost delta** per missing item (+ a UEXO qty column), and
  the **120% Jita contract price** per fit in the completable sections.
- Results **persist across tab switches**, plus a **Copy inventory** button and **configurable
  shopping thresholds** (min coverage, max ISK gap). Hangar hull count added to the doctrine stock view.

## Contracts
- **T2 / T3 tech-tier badges** on contract quota bars and doctrine-stock hull bars.
- **Contract count** shown alongside total value, and **full-fit contract pricing via Janice**.
- Sold scan handles contracts with a null `date_completed` (falls back to `date_accepted`); new
  **Copy sold Discord table** button.

## Settings — app version picker
- A dropdown at the top of the Settings page lists released versions — **switch to or roll back to any
  version**. Picking one downloads that installer and runs it, so a bad update is easy to undo.

## Fixes
- Analyse Hulls no longer writes to a detached DOM after tab switches; shopping-list module names show
  correctly (were falling back to type IDs); candidates with hull qty < 1 are skipped.

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
