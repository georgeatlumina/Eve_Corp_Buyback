# v3.11.0 — SMT tab: Intel Map (live intel + kills)

The first slice of an **SMT** (Slazanger's Eve Map Tool) port, in a new **SMT** tab group.

## Intel Map
An SMT-styled region map (separate from the Maps tab) with two live layers:

- **Intel** — read from your **local EVE chat-logs**. Open **⚙ Logs**, point the app at your Chatlogs
  folder (it auto-detects the usual location and lists your channels), tick the intel channels, and Save.
  Reported systems then **glow red on the map** (green for a "clr"/clear), **fade out over ~10 minutes**,
  and stream into a live **intel feed** panel. The system-name matcher is ported from SMT (a word matches
  a system when it's a prefix of the name or vice-versa; "clr"/"clear" flags a clear).
- **Kills** — a live **zKillboard (RedisQ)** feed marking systems with recent kills.

Plus a region picker, system search, layer toggles, and **Follow intel** (auto-jump the map to wherever
the newest report is).

Your intel never leaves your machine — it's read locally; only the public zKillboard stream is fetched.

## Coming next (SMT port)
Characters & fleet tracking on the map, jump-bridge network + routing, Thera/Turnur connections,
sovereignty campaigns/ADM/upgrades, and the transparent overlay window will follow in later releases.

---

### Downloads

| Platform | File | Install |
|---|---|---|
| macOS (Apple Silicon) | `*.dmg` | Open the DMG, drag into Applications |
| Windows | `*.exe` | Run the installer |
| Linux — Debian/Ubuntu | `*.deb` | `sudo apt install ./<file>.deb` |
| Linux — Fedora/RHEL/openSUSE | `*.rpm` | `sudo rpm -U <file>.rpm` (or `sudo dnf install ./<file>.rpm`) |

The `.deb`/`.rpm` packages are unsigned (RPM tools may warn about a missing GPG signature — expected). The in-app updater picks the format matching your distro.

_Intel matcher & map ported from [Slazanger's SMT](https://github.com/Slazanger/SMT) (MIT); region layouts © Wollari & CCP (Dotlan)._

_Full release history: see [CHANGELOG.md](CHANGELOG.md)._
