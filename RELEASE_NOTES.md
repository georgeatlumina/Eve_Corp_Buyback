# v3.4.1 — sidecar port move to 8766

- The local sidecar (the API **and** the ESI login callback) **moved from port 8765 to 8766**.

## Upgrade note
- If you run your own EVE application, set its callback URL to **`http://localhost:8766/callback`**
  in the developer portal, or logins will fail with a `redirect_uri` mismatch.

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
