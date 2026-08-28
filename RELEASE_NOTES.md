# v3.12.6 — Updates wait for you

The app checked for updates two seconds after startup and every hour after that, and each time it found
one it opened a dialog in front of whatever you were doing. That lands mid-fleet as often as not.

**Now it doesn't interrupt.** A background check lights a pulsing **⬆ Update to vX.Y.Z** badge in the
header, next to the ⟳ button, and stops there. Click it when you're ready and you get the same
Download / Later dialog as before, followed by the usual download-and-install flow.

- **Nothing downloads until you ask.** The badge's tooltip says so, along with the version you're on and
  how large the installer is.
- **It stays put** until you act on it — no "Later" that has to be repeated every hour, because nothing
  asks again on a timer.
- **It clears itself** when a later check finds you're already current, or when a release has no
  installer for your platform.
- **⟳ still works** exactly as it did, for checking on demand.
- The badge doesn't pulse if your system asks for reduced motion.

---

### Downloads

| Platform | File | Install |
|---|---|---|
| macOS (Apple Silicon) | `*.dmg` | Open the DMG, drag into Applications |
| Windows | `*.exe` | Run the installer |
| Linux — Debian/Ubuntu | `*.deb` | `sudo apt install ./<file>.deb` |
| Linux — Fedora/RHEL/openSUSE | `*.rpm` | `sudo rpm -U <file>.rpm` (or `sudo dnf install ./<file>.rpm`) |

The `.deb`/`.rpm` packages are unsigned (RPM tools may warn about a missing GPG signature — expected). The in-app updater picks the format matching your distro.

_Intel matcher & map ported from [Slazanger's SMT](https://github.com/Slazanger/SMT) (MIT); region layouts © Wollari & CCP (Dotlan); Thera/Turnur connections from [eve-scout](https://www.eve-scout.com/); ship names from CCP's SDE._

_Full release history: see [CHANGELOG.md](CHANGELOG.md)._
