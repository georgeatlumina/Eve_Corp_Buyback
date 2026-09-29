# v3.12.10 — Trade anywhere, route safely, name your own wallets

## Station Trading — any station, not just the five hubs

Each side of a pair now opens a picker with three ways in:

- **Trade hubs** — Jita, Amarr, Dodixie, Rens, Hek, as before
- **Browse a region** — pick any of the 70 regions and see every station and public citadel that
  *currently has orders*, busiest first. Metropolis has **437** such locations; Hek leads with 38,000
  orders on the book.
- **Paste a station ID** — for anything else

There's a filter box over whatever's listed, and saved pairs work with all of it.

## Player citadels are now tradeable

Public structures were always in EVE's market data — one citadel in The Forge carries over 1,300 orders —
they were just being skipped. They're in now, named where the app can see them.

**One honest limitation.** A citadel only reveals its name *and its location* to a character who can dock
there. One nobody can dock at shows as `Structure 1044960858258 · location unknown` and still trades
perfectly well — prices, spreads and volumes are all correct. What you don't get is jumps and trips,
because nothing can say where it is. Log in a character with access and it resolves itself.

## Routing now uses the safe route

Trips, jumps and ISK/jump are quoted on the **high-sec-preferring** route, because that's the one a loaded
hauler actually flies. This matters more than it sounds:

> **Jita → Amarr is 11 jumps the short way, and 34 the safe way.**

Costing that run at 11 jumps overstated it threefold. The shortest count is shown alongside — `34 jumps
safest (11 shortest)` — so you can see exactly what the detour costs and decide for yourself. If no safe
route exists at all, it falls back and says so.

## Name your own corp wallet divisions

EVE numbers corp wallets 1–7, but every corp names them itself. The labels on the Buyback and Moon wallet
tiles were fixed in the app, so a corp that arranges its divisions differently saw money under the wrong
name — in the one place people go to read balances.

**Config → Corp wallet divisions** now holds all seven labels, plus two dropdowns choosing which division
each page treats as *the* buyback and moon wallet. Defaults are exactly what they were, so nothing changes
until you edit it. Leave a label blank and the tile reads "Division 4".

Useful if you're moving buyback to a different corp — set the corp ID, re-authorise a character in the new
corp with the right roles, and relabel the wallets here.

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
