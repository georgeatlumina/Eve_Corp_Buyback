# v3.9.2 — PI optimiser: a System field where you actually optimise

A usability follow-up to v3.9.1's system-aware PI planner.

## What changed
- The planet optimiser now has its **own System field**, right next to "Available planets", with a
  live hint that resolves the system's planets as you type
  (e.g. *"UEXO-Z: 3 Barren · 2 Temperate · 1 Oceanic (6 planets)"*). Previously the system-aware tally
  only kicked in if you'd filled the separate profit-ranking search box at the top — easy to miss,
  which made the command-centre tally look like it was ignoring your system.
- The command-centre header now states which mode you're in — *"in UEXO-Z (6 planets)"* or
  *"all planets; set a System above…"* — so it's obvious whether the plan is constrained to a system.
- **Fix:** the "Jita price lookup failed" message is now explicit about the cause (backend unreachable
  vs. an API error) and notes the plan above is still valid — pricing is a separate step you can retry.

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
