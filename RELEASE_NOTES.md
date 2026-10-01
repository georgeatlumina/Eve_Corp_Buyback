# v3.12.12 — Fixes the wallet division dropdowns

A follow-up to v3.12.11.

**Renaming a corp wallet division didn't update the two dropdowns beneath it.** The *Buyback wallet* and
*Moon wallet* pickers kept offering the old names until you saved and reopened the app — so right after
renaming, the very lists you'd use to pick them were out of date.

They now follow what you type, as you type it, and keep whatever you had selected.

The same fix covers a quieter version of it: **clearing** a name now shows "Division 4" in the dropdowns
straight away, rather than the name that used to be saved.

---

### Downloads

| Platform | File | Install |
|---|---|---|
| macOS (Apple Silicon) | `*.dmg` | Open the DMG, drag into Applications |
| Windows | `*.exe` | Run the installer |
| Linux — Debian/Ubuntu | `*.deb` | `sudo apt install ./<file>.deb` |
| Linux — Fedora/RHEL/openSUSE | `*.rpm` | `sudo rpm -U <file>.rpm` (or `sudo dnf install ./<file>.rpm`) |

The `.deb`/`.rpm` packages are unsigned (RPM tools may warn about a missing GPG signature — expected). The in-app updater picks the format matching your distro.

_Intel matcher & map ported from [Slazanger's SMT](https://github.com/Slazanger/SMT) (MIT); region layouts © Wollari & CCP (Dotlan); Thera/Turnur connections from [eve-scout](https://www.eve-scout.com/); market data, ship names and system positions from CCP's ESI/SDE._

_Full release history: see [CHANGELOG.md](CHANGELOG.md)._
