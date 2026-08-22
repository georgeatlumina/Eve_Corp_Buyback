# v3.9.1 — PI optimiser: command-centre tally is now physically deployable

A follow-up fix to the system-aware PI planner from v3.9.0.

## Fix
- With a system chosen, the optimiser could tally **more colonies of a planet type than the system
  physically has** — e.g. "×28 Oceanic" in a system with a single Oceanic planet. The plan is now
  **constrained by the chosen system**: it models a shared pool of `planets × characters` slots (one
  colony per planet per character), extractors consume real planet slots, and each P0 is spread
  across all its compatible in-system planet types. The command-centre tally can no longer exceed
  what the system actually holds.
- Chains a system can't extract are reported plainly (*"Can't build this in UEXO-Z — no planet there
  extracts Reactive Gas, Felsic Magma…"*), and when the system caps throughput below the requested
  planet budget, the plan says so.

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
