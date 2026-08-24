# v3.12.2 — SMT intel alarms, and an overlay you can actually tune

Intel can now make a noise when it lands near you, and how near it is drives what you hear *and* what
you see. The overlay picked up a second layout, a zoom, and a lot of knobs; the Intel Map now opens
where your character actually is.

## Distance tiers
Under **🔔 Alerts** on the SMT toolbar you build a short list of tiers. The first tier covering a
report's jump distance decides everything about it at once — **the sound**, **the highlight colour**,
**how big the highlight is**, **how long it takes to fade**, and **whether it flashes**. Anything past
the last tier is out of range: no sound, and drawn plain instead of in a tier colour.

Out of the box:

| Distance | Sound | Colour | Size | Fades after | Flash |
|---|---|---|---|---|---|
| Your system | siren | red | ×1.7 | 15 min | fast + whole window |
| ≤ 2 jumps | klaxon | orange | ×1.3 | 10 min | fast |
| ≤ 5 jumps | beep | yellow | ×1.0 | 5 min | slow |

Every field is editable, each row has a **Test**, and any tier can play a **sound file of your own**.
Add, remove or reset tiers freely.

**Flash the whole overlay** is a per-tier checkbox: tick it and a report at that distance flashes the
entire window in the tier's colour — a six-second burst, so it grabs you without strobing for the ten
minutes the marker lives. Separate toggles and sounds cover **"clr" reports** and **kills in range**,
plus master volume and a **minimum gap** between alarms.

Muting silences the alarm but *keeps* the visuals — that's the point of muting.

## Overlay
- **Two layouts**, toggled from the toolbar: the **jump-ring map** (rings by distance from you) and the
  **flat SMT region map** — the same Dotlan layout the Intel Map tab draws.
- **Zoom slider** and a **label text-size slider**. Zoom centres on *your* system, so closing in follows
  you rather than the middle of the region. Both persist across restarts, along with the layout you
  picked, the window's size and position, and everything else on the bar.
- The `⚠ 2j` nearest-hostile badge is tinted to the matching tier, so how bad it is reads before the
  number does. **🔔** mutes without touching your settings.

## Intel Map
- **⤢ Pop out** opens the Intel Map in its own window, and every pop-out window now has a **📌 pin** to
  keep it above the game.
- The map **opens on the region your character is in** instead of a fixed default, and the character
  it's following is called out with their **portrait and name**, highlighted both in the character row
  and on the map. Click any character to follow them instead.

## Where the alarm runs
From any tab, not just the SMT one — arm it and it keeps listening in the background. While the overlay
is open **it** sounds the alarm and the main window stays quiet, so a report never fires twice.

Distance is measured from your first online **SMT character**, or the overlay's pinned system. With
neither, reports fall into the furthest tier so you still hear something.

Sounds are generated in the app rather than shipped as audio files — nothing extra to download.

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
