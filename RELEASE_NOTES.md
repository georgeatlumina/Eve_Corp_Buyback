# v3.12.3 — SMT on Linux, and two map-readability fixes

The original SMT is Windows-only. This port now works on **Linux** too, with the platform differences
handled rather than assumed away — plus two fixes for labels covering things they shouldn't.

## Linux support

**⚙ Logs finds your Wine/Proton bottle.** EVE on Linux writes its chat logs *inside* the prefix, so
auto-detection now scans the layouts people actually use:

| Launcher | Where it looks |
|---|---|
| Steam / Proton | `~/.steam/steam`, `~/.local/share/Steam`, `~/.steam/root` → `steamapps/compatdata/*/pfx/…` |
| Flatpak Steam | `~/.var/app/com.valvesoftware.Steam/…` |
| Plain Wine | `~/.wine/drive_c/users/*/Documents` (and `My Documents` layouts) |
| Lutris | `~/Games/*/drive_c/users/*/…` |

The Steam app id isn't hardcoded, so your bottle is found whatever its number. Windows picked up the
common **OneDrive-redirected Documents** path in the same pass.

**Click-through can always be released.** The overlay's hover-to-release relies on an Electron option
that exists only on macOS and Windows, and the `Ctrl+Alt+O` hotkey needs an X11-style session — neither
is guaranteed on Linux, and under Wayland both can be unavailable. Pressing **⊞ Overlay** in the app now
releases click-through on any platform, so you can't end up with an overlay you can't click out of. The
button's tooltip names whichever escape works where you're running.

Emoji font fallbacks were added so the toolbar glyphs don't render as empty boxes on a bare install.

**Linux caveats worth knowing** (environmental — not something the app can fix):

- The transparent overlay needs a **compositing window manager**. Without one it may draw on a solid
  background.
- **Global hotkeys don't fire under Wayland.** Use the ⊞ Overlay button instead.
- Electron's "hide from taskbar" and "float above fullscreen" are macOS/Windows-only, so the overlay
  appears in your taskbar and should sit over a **windowed / borderless** EVE client rather than a true
  fullscreen one.

## Map readability

- The **character name pill** on the Intel Map now sits **above** the system dot instead of beside it,
  where it was covering the system's own name.
- **Flat SMT map labels** were sized from the region's overall span, which made them roughly as wide as
  the gap between systems. They now use the same calibrated sizing the Intel Map tab uses for those same
  layouts, and the overlay's label-size slider goes down to **0.3×** for smaller text still.

---

### Downloads

| Platform | File | Install |
|---|---|---|
| macOS (Apple Silicon) | `*.dmg` | Open the DMG, drag into Applications |
| Windows | `*.exe` | Run the installer |
| Linux — Debian/Ubuntu | `*.deb` | `sudo apt install ./<file>.deb` |
| Linux — Fedora/RHEL/openSUSE | `*.rpm` | `sudo rpm -U <file>.rpm` (or `sudo dnf install ./<file>.rpm`) |

The `.deb`/`.rpm` packages are unsigned (RPM tools may warn about a missing GPG signature — expected). The in-app updater picks the format matching your distro.

_Intel matcher & map ported from [Slazanger's SMT](https://github.com/Slazanger/SMT) (MIT); region layouts © Wollari & CCP (Dotlan); Thera/Turnur connections from [eve-scout](https://www.eve-scout.com/)._

_Full release history: see [CHANGELOG.md](CHANGELOG.md)._
