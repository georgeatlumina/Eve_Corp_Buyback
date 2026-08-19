# v3.6.1 — dedicated Inventory Characters auth

- New **Inventory Characters** section on the Auth tab: authorize alts **just** for reading their
  assets (`esi-assets.read_assets.v1` only) — up to **24**, fully isolated from your main
  characters' scopes. They power the **auto inventory search** on the Production & Reaction planners
  (Auto-detect stock + node availability) and the **My Assets** tab, without re-scoping your main /
  PI / fitting characters. Use *Add inventory character* to log in the next one.

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
