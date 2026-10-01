# v3.12.13 — Corp inventory reads Fortizar hangars, and counts fitted ships properly

Contributed by **Thanatos**.

## Fix — corp inventory came back empty from player structures

If your corp hangar is in a **Fortizar or other player structure**, the inventory scan found nothing. A
player structure keeps its hangar divisions inside the corp's rented **Office**, so the divisions report
the Office as their location rather than the structure — and the scan was looking for the structure
directly. It now walks past the Office to the real structure, so those hangars are read correctly.

This is the one to update for if you've moved to a structure-based home.

## Fix — complete ships were undercounted

Modules fitted to a hangared ship, and ammo or drones stowed in its cargo, report their location as *the
ship*, not the hangar. The scan skipped them, so **Analyse Hulls** undercounted how many complete ships
you actually had. Nested contents are now counted against the hangar division their ship sits in.

## Acquisitions — clearer numbers

- Quota rows show **"(x of y needed)"**, so a figure has its target beside it instead of standing alone.
- Contracts quota rows gain **"Full fits in Acquisitions"** — how many complete fits the last *Analyse
  Hulls* run found buildable from current inventory.
- **No more stale market data.** Analyse Hulls re-fetches rather than reusing a snapshot past the
  five-minute cache window, so availability it reports is availability that still exists.

---

### Downloads

| Platform | File | Install |
|---|---|---|
| macOS (Apple Silicon) | `*.dmg` | Open the DMG, drag into Applications |
| Windows | `*.exe` | Run the installer |
| Linux — Debian/Ubuntu | `*.deb` | `sudo apt install ./<file>.deb` |
| Linux — Fedora/RHEL/openSUSE | `*.rpm` | `sudo rpm -U <file>.rpm` (or `sudo dnf install ./<file>.rpm`) |

The `.deb`/`.rpm` packages are unsigned (RPM tools may warn about a missing GPG signature — expected). The in-app updater picks the format matching your distro.

_Intel matcher & map ported from [Slazanger's SMT](https://github.com/Slazanger/SMT) (MIT); region layouts © Wollari & CCP (Dotlan); Thera/Turnur connections from [eve-scout](https://www.eve-scout.com/); market data, ship names and system positions from CCP's ESI/SDE._

_Full release history: see [CHANGELOG.md](CHANGELOG.md)._
