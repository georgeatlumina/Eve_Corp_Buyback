# v3.12.0 — SMT: characters, bridges, Thera, sovereignty, and the intel overlay

The rest of the **SMT** (Slazanger's Eve Map Tool) port, on top of v3.11.0's Intel Map — everything
from the "coming next" list, plus the transparent overlay window.

## Characters & fleet on the map
Authorize characters under **Auth → SMT Characters** (location / ship / online, plus fleet) and they
appear live on the Intel Map: a chip row with each character's system and online state, and a marker
on the map itself. If you're in a fleet, its members are plotted too. Click a chip to jump the map to
that character. These scopes are separate from the rest of the app's auth, so an intel alt only ever
grants location.

## Jump-bridge network + bridge-aware routing
**Bridges…** manages your alliance's jump-bridge network — add pairs by name, or **Paste list…** a
whole network in one go (one `A - B` per line). Bridges draw on the map and are used for routing.

**Route…** plans between any two systems with a preference of **Shortest**, **Prefer high-sec** or
**Prefer low / null**; each hop is tagged with how you take it (gate, bridge, wormhole).

## Thera / Turnur connections
**Thera…** lists the live Thera and Turnur wormhole connections to k-space from **eve-scout**, each
with its wormhole type, max ship size and remaining life. Routing can use them — tick **via WH** in
the route bar and the planner will drop you through Thera when that's genuinely shorter.

## Sovereignty layer
The **Sov** layer colours the map by alliance holder, prints each system's **ADM** under its dot, and
rings systems with an active campaign. **Sov…** lists **active sovereignty campaigns** with live
countdowns to (and through) their timers, and contested **faction-warfare** systems are flagged too.

## Transparent intel overlay
**⊞ Overlay** pops out a frameless, transparent, always-on-top window built to sit over your EVE
client. It draws the systems **within N jumps of you** as rings around your position and lights them
up as intel and kills land — red for a report, green for a "clr", orange for kills, all fading over
~10 minutes like the main map. The toolbar carries the **nearest live hostile report as a `⚠ 2j`
badge**, and an intel ticker below it shows only the reports for systems in range, each tagged with
its jump distance.

The origin follows your first online SMT character, or you can pin a system by hand (type it, or
click a node). Range (2–6 jumps), labels, ticker and opacity are all on the toolbar, and the window
remembers its size, position and settings.

**Click-through** (👆) lets clicks pass straight through to EVE. Because a click-through window can't
be clicked, two global hotkeys are the way back:

| Hotkey | Does |
|---|---|
| `Ctrl+Alt+O` | Toggle click-through |
| `Ctrl+Alt+M` | Hide / show the overlay |

It sits above a windowed-fullscreen client, and closes with the app.

---

### Downloads

| Platform | File | Install |
|---|---|---|
| macOS (Apple Silicon) | `*.dmg` | Open the DMG, drag into Applications |
| Windows | `*.exe` | Run the installer |
| Linux — Debian/Ubuntu | `*.deb` | `sudo apt install ./<file>.deb` |
| Linux — Fedora/RHEL/openSUSE | `*.rpm` | `sudo rpm -U <file>.rpm` (or `sudo dnf install ./<file>.rpm`) |

The `.deb`/`.rpm` packages are unsigned (RPM tools may warn about a missing GPG signature — expected). The in-app updater picks the format matching your distro.

_Intel matcher & map ported from [Slazanger's SMT](https://github.com/Slazanger/SMT) (MIT); region layouts © Wollari & CCP (Dotlan); Thera/Turnur connections from [eve-scout](https://www.eve-scout.com/)._

_Full release history: see [CHANGELOG.md](CHANGELOG.md)._
