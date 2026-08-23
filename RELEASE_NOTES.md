# v3.10.0 — Structures tab: corp reinforcement timers

## New: Structures tab (Combat)
- Lists your corp's **Upwell structures** with their **reinforcement state**, live from ESI.
- **Reinforced** structures (in their armor or hull timer) are highlighted, with a live **"comes out"
  countdown**; other states show as badges (shield / armor / hull vulnerable, anchoring, onlining, …).
- **Fuel-remaining** countdown per structure, with low fuel (< 3 days) flagged.
- A **Reinforced only** filter and a refresh button; countdowns tick live while the tab is open.

### What it needs
- The **main / slot-1 authed character** (the same one used for corp wallets & contracts), who must be a
  **Director or Station Manager** in the corp.
- Scopes `esi-corporations.read_structures.v1` (state + timers) and `esi-universe.read_structures.v1`
  (structure names) — both already in the app's default scope set, so re-auth the main character to grant
  them. `corp_id` must be set on the Config tab.
- Only your own corp's structures are visible — ESI exposes no one else's reinforcement state.

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
