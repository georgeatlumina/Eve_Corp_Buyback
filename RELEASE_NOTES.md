# v3.9.5 — PI optimiser: per-toon command centres, multibuy & saved work

## Per-toon command-centre breakdown
- The toon split now spells out **exactly which planet-type command centres each toon deploys** —
  e.g. `SushiAndSushi — Barren ×3 3f · Oceanic ×1 1f · Temperate ×1 1f — 5 CC · 5 factory` — where
  `Nf` marks how many of that type are factory planets.
- Factory planets are now assigned **concrete planet types** (spread across each toon's available
  planets) instead of a vague "any type", so you know precisely how many of each command centre to buy
  per character. The aggregate tally folds them in and notes how many run factories.

## Copy command-centre multibuy
- A **🛒 Copy multibuy** button on the command-centre tally copies a ready-to-paste in-game Multibuy
  list of every command centre the plan needs (`Barren Command Center x16`, `Temperate Command Center
  x12`, …).

## Work-in-progress persists across restarts
- The PI optimiser now **auto-saves and restores** your work — chosen system, planet budget, target
  commodity, assumptions, valuation settings and pulled toons all come back when you reopen the app.

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
