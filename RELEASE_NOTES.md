# v3.2.1 — fixes

- **Shopping list → Janice:** the Reaction Calculator and Production Planner shopping-list
  quantities no longer render with thousands-separator commas (e.g. `170,000`), which caused
  errors when the list was pasted into Janice. Quantities now copy as plain digits; the
  comma-formatted value is kept as a hover tooltip for readability.

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
