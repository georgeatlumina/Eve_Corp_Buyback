# v3.12.1 — SMT intel alarms, tiered by distance

The Intel Map and the overlay can now make a noise when intel lands near you, and how near it is
decides what you hear and how it looks.

## Distance tiers
Under **🔔 Alerts** on the SMT toolbar you build a short list of tiers. The first tier that covers a
report's jump distance decides three things at once: **which sound plays**, **what colour it glows on
the overlay**, and **whether it flashes**. Anything past the last tier is out of range — no sound, and
drawn plain instead of in a tier colour.

Out of the box:

| Distance | Sound | Colour | Flash |
|---|---|---|---|
| Your system | siren | red | fast |
| ≤ 2 jumps | klaxon | orange | fast |
| ≤ 5 jumps | beep | yellow | slow |

Each tier is fully editable — jump distance, one of eight built-in sounds, a colour picker, flash speed
(none / slow / fast), and a **sound file of your own** if you'd rather hear that. Add, remove or reset
tiers as you like. Every row has a **Test** button.

Separate toggles and sounds cover **"clr" reports** and **kills in range**, plus a master volume and a
**minimum gap** between alarms so a busy intel channel can't machine-gun you.

## On the overlay
Markers take their tier's colour and pulse at its flash speed, and the `⚠ 2j` nearest-hostile badge is
tinted to match — so how bad it is reads before you've read the number. A **🔔 button** mutes the alarm
without touching your settings.

## Where it runs
The alarm works from any tab, not just the SMT one — arm it and it keeps listening in the background.
While the overlay window is open **it** sounds the alarm and the main window stays quiet, so a report
never fires twice.

Distance is measured from your first online **SMT character**, or from the overlay's pinned system.
With neither, reports fall into the furthest tier so you still hear something.

Sounds are generated in the app rather than shipped as audio files, so there's nothing to install and
nothing extra to download.

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
