# v3.9.3 — PI optimiser: the plan now always fits your toons

A follow-up fix to the system-aware PI planner.

## Fix
- The toon split could say **"N won't fit in <system>"** for a plan the optimiser had just declared
  valid. Two causes, both fixed:
  1. The optimiser assumed every character could host `planets × characters` colonies — but a toon with
     a **1-planet budget** can only host one colony in a system. It now uses each toon's **real**
     in-system capacity, `min(planet budget, system planets)`.
  2. The split placed the flexible factory planets before the scarce extractor types, which could paint
     it into a corner. It now places the **most-constrained planet type first** and drops factory
     planets into whatever slots remain.
- Factory planets still group onto the fewest toons **where capacity allows** — a system packed exactly
  full simply has no spare room to keep them together.

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
