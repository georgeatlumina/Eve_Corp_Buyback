# v3.12.5 — A watchlist, a system you can click, and a map that stays put

The Intel Map could tell you about things happening near your character. It couldn't tell you about
home while you were six regions away, it couldn't tell you anything about a system you clicked on, and
it forgot where you'd left it every time you closed the app. All three are fixed.

## Watchlist — systems that alarm at any distance

The distance tiers only reach as far as their furthest range. Past that, silence — which is the wrong
answer for your staging system, your home, or the chokepoint you care about while you're ratting
somewhere else entirely.

**★ Watch** in the toolbar keeps a list of systems that alarm **whatever the distance**, checked before
the distance tiers ever run. Each one carries **its own sound**, so you can tell staging from a
chokepoint by ear without looking at anything.

- **Star a system** from the map card, or add it by name in the ★ Watch panel.
- **The watch strip** sits above the map: every watched system and what it's doing right now — quiet,
  `⚠ 2m` since a report, `clr`, or `◆` for kills. Click a chip to jump the map there.
- **Watched systems are starred on the map** and highlighted in their own colour when they light up.
- A **kill** in a watched system speaks with that system's voice, at any distance. The global Kills
  toggle still gates it, so watching a system never switches on a feed you'd turned off.
- Watch alarms have **their own throttle clock**, so a busy channel three regions away can't swallow the
  one alarm you actually care about.

The list lives in the sidecar alongside your jump bridges and alarm rules, so the Intel Map, any pop-out
and the overlay always agree on it — star something in one and the others update immediately.

## Click a system on the map

Every system on the Intel Map is now clickable, and the card opens **beside the node** rather than as a
dialog in the middle of the screen — the map exists to give you spatial context, and a modal throws that
away.

| In the card | |
|---|---|
| **Where** | name, security, region, and how many jumps from the character you're following — counting your jump bridges |
| **Intel** | the recent reports naming that system, colour-coded as usual |
| **Kills** | how many in the last hour and what they were worth |
| **Actions** | ★ Watch · Route from · Route to · Dotlan · zKill |

It closes on Esc, on a click anywhere else, or as soon as you pan or zoom. A small drag no longer counts
as a click, so nudging the map doesn't throw a card at you.

## The map remembers where you left it

Closing the app used to reset the Intel Map completely. It now remembers, per machine:

- the **region** you were looking at, and your exact **pan and zoom**
- which **layers** were on (Intel / Kills / Chars / Sov) and whether **Follow intel** was ticked
- which **panels** were open — Route, Bridges, Thera, Sov, Alerts, ★ Watch, ⚙ Logs

**Your character still wins the opening view**, as before: the saved region is the fallback for when
there's no character fix at all, and a saved pan/zoom is only re-applied if you land in the region it was
taken in. Switching away from the tab and back also keeps your view instead of refitting the map.

## In the overlay

- **Right-click any system to star it.** Left-click still re-pins the map to that pocket, so the star
  goes on the button that was free — no panel here, because a card over a transparent, usually
  click-through HUD would be the wrong object entirely.
- **The watch strip** appears under the toolbar the moment a watched system lights up, and hides again
  when everything goes quiet. The new **★** toolbar button pins it open if you'd rather have the standing
  "all clear"; the button itself glows when something is live but the strip is auto-hidden.
- **Fix — watched systems were being filtered out of the ticker.** It only ever showed reports for
  systems inside your jump range, which would have hidden the very reports the watchlist exists to
  surface. Watched systems are never "out of range".

## Fixes

- **Watchlist changes could be silently lost.** Starring two systems inside one round-trip had both build
  their new list from the same stale one, so the second write dropped the first. Writes are now
  serialised, in the map and the overlay alike.
- **View settings could be silently lost.** Toggling a layer and opening a panel in the same breath saved
  only the last of the two.

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
