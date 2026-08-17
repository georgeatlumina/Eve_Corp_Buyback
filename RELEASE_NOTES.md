# v3.4.2 — clearer backend-unreachable errors

- If the app can't reach its local backend (the sidecar), it now shows a **clear banner naming the
  port** instead of failing silently — reads used to fall back to defaults quietly, so the first
  visible symptom was a cryptic **"failed to fetch"** on config import. Config import now gives an
  actionable message too.
- The sidecar logs its **bound port** (and callback URL) at startup, and the app logs the port it
  health-checks — so a renderer↔sidecar port mismatch is obvious from `sidecar.log`.

Reliability and diagnostics only — no feature changes.

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
