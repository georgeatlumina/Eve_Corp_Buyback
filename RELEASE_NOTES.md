# v3.6.2 — pick which character the auto-inventory-search uses

- The **Production** and **Reaction** planners get an **Inventory** dropdown listing **all connected
  characters** (main / PI / fitting / inventory slots) plus **All connected toons**. The
  **auto-inventory-search** — *Auto-detect stock* and the node **availability** colouring — now uses
  the character you pick. The choice is **shared across both planners** and **remembered between app
  restarts**.

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
