## What's new in v2.2.0

The big one: a full **Planetary Interaction** suite — three new tabs in the General group.

### PI Planner (profitability analyzer)
- Search a solar system to see what its planets can extract, then rank the most profitable **P0→P4 production chains** buildable there.
- Priced at **Jita** (immediate sell) with a configurable **POCO export tax**; raw P0 is treated as free (extracted).
- **Per-run pricing by default** (one factory cycle — the smallest batch: P1 ×20, P2 ×5, P3 ×3, P4 ×1), with a **Per unit** toggle.
- **System-search autocomplete** over all 8,490 solar systems (3-character minimum).
- Click any chain for its full recipe tree + raw-P0 basket.

### PI Builder (visual colony layout builder)
- Place command centers / extractors / factories / storage / launchpads on a **rotatable, zoomable realistic planet**, link them, assign factory schematics, extractor resources and heads, and set routes.
- Live **CPU / Powergrid budget** (pin loads + extractor heads + link cost).
- Loads existing colonies from — and **saves importable templates straight to** — your EVE `PlanetaryInteractionTemplates` folder, so a colony built here imports into the game fully wired.

### PI Colonies (live colony manager)
- Live colonies across your characters via ESI, with per-extractor **countdown timers** and **status** (expired / expiring <24h / active / idle), sorted by soonest expiry.
- **Desktop notifications** when an extractor is about to run dry — even while you're on another tab.
- Per-colony **detail view** (what it's producing, stored contents, pin breakdown) and **Jita valuation** (output ≈ ISK/day + stored value, with totals).
- **Open in Builder** pulls a live colony onto the canvas to tweak and re-export.

### PI Characters auth
- A dedicated **PI Characters** section on the Auth tab authorizes up to **24 alts just for PI** — each login requests only the `manage_planets` scope, so your main characters aren't re-scoped.

---

### Downloads

| Platform | File | Install |
|---|---|---|
| macOS (Apple Silicon) | `*.dmg` | Open the DMG, drag into Applications |
| Windows | `*.exe` | Run the installer |
| Linux — Debian/Ubuntu | `*.deb` | `sudo apt install ./<file>.deb` |
| Linux — Fedora/RHEL/openSUSE | `*.rpm` | `sudo rpm -U <file>.rpm` (or `sudo dnf install ./<file>.rpm`) |

The `.deb`/`.rpm` packages are unsigned (RPM tools may warn about a missing GPG signature — expected). The in-app updater picks the format matching your distro.
