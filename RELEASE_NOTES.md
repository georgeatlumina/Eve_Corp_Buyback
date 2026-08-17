# v3.4.3 — updates always replace the sidecar

Fixes a Windows update problem where a **running `sidecar.exe` was file-locked**, so an installer
(fresh or auto-update) could keep the **old sidecar** next to the new app — a renderer↔sidecar port
mismatch that showed the "can't reach the local backend" banner. Manually closing the stale
`sidecar.exe` before reinstalling was the workaround; this release does it for you.

- The app now **fully kills the sidecar process tree** on quit and **before launching a downloaded
  update installer**, so the locked file is freed and always replaced.
- The Windows installer/uninstaller also **stops any running sidecar** during install — covering even
  a force-killed-app orphan.
- The updater already downloads and runs the **full** platform installer (no differential), so big
  version jumps (e.g. v2.x → latest) replace every file.

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
