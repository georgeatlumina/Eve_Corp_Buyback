# v3.9.6 — Installer: the desktop icon stays gone once you remove it (Windows)

A small quality-of-life fix for a user request.

## What changed
- On Windows, the **desktop shortcut is created on the first install only** and is **never recreated
  on an update**. So if you delete the desktop icon to keep your desktop clean, an update won't bring it
  back each time.
- The **Start-menu shortcut** is always created/kept, so the app stays easy to launch, and uninstalling
  removes the desktop icon.

(No changes to the app itself in this build — macOS/Linux are unaffected.)

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
