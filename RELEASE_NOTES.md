# v3.9.0 — Native Maps + a system-aware PI colony planner

## Maps — now native (no more embedded Dotlan)
- The **Maps** tab is a fully native EVE map: pan/zoom region maps with systems coloured by
  security and stargate links, using Dotlan's familiar layout coordinates (© Wollari & CCP).
- **Live overlays** from ESI (last hour): ship **Jumps**, ship+pod **Kills**, **NPC** kills, and
  **Sovereignty** — every system coloured by its holding alliance, with names resolved.
- **Stargate route planner** between any two systems — Shortest, prefer high-sec, or prefer low/null
  — drawn on the map and listed in the panel.
- **System detail panel**: security, region, live jumps/kills, sov holder, and clickable connected
  systems. Search flies straight to any system; border systems link to their neighbouring region.
- The universe (5,485 systems / 6,989 gates) is bundled offline; jumps/kills/sovereignty are live.

## PI optimiser — command centres & system-aware planning
- New **"Command centres to deploy"** summary tells you exactly how many command centres of **each
  planet type** the plan needs (extractors consolidated onto the fewest distinct types).
- **System-aware**: choose a system in the planner and the tally uses **only that system's planet
  types**, shows how many of each the system actually has, and warns when a P0 can't be extracted
  there or when the plan needs more colonies than `planets × characters`.
- Respects EVE's **one colony per planet per character** rule in the suggested toon split (per-type,
  per-toon caps), and keeps **factory planets together** on the fewest toons instead of scattering.
- The ⚙ PI slide-out (from the Production/Reaction planners) shows the command-centre tally too.

---

### Downloads

| Platform | File | Install |
|---|---|---|
| macOS (Apple Silicon) | `*.dmg` | Open the DMG, drag into Applications |
| Windows | `*.exe` | Run the installer |
| Linux — Debian/Ubuntu | `*.deb` | `sudo apt install ./<file>.deb` |
| Linux — Fedora/RHEL/openSUSE | `*.rpm` | `sudo rpm -U <file>.rpm` (or `sudo dnf install ./<file>.rpm`) |

The `.deb`/`.rpm` packages are unsigned (RPM tools may warn about a missing GPG signature — expected). The in-app updater picks the format matching your distro.

_Map region layouts © Wollari & CCP (evemaps.dotlan.net); topology, security & live data from CCP/ESI._

_Full release history: see [CHANGELOG.md](CHANGELOG.md)._
