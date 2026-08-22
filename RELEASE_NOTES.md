# v3.9.4 — PI optimiser: factory planets consolidated onto your largest toons

A follow-up to the system-aware PI planner.

## What changed
- The suggested toon split now **consolidates factory planets onto the fewest, largest toons** — it
  fills the biggest toon's factory slots first, so your reaction/factory colonies land on as few
  characters as possible (e.g. all 4 factory planets on one main; 8 factory planets on your two biggest).
- Feasibility still wins: if concentrating the factory planets would leave an extractor with nowhere to
  go, the split automatically falls back to a layout that fits every colony (one colony per planet per
  character).

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
