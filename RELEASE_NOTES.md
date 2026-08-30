# v3.12.8 — Activity layers, jump range, and a scan that no longer hangs

## Fix — contract scans stuck on "Resolving issuer names…"

A moon or buyback scan could sit on that step for ever: no error, no progress, nothing to do but kill the
app. Every one of the app's calls to EVE's servers was waiting without a time limit, so a request that was
accepted but never answered blocked the scan indefinitely.

All of them now give up and move on. If name resolution is what fails, the scan **finishes anyway** and
tells you — contracts show issuer IDs instead of names, rather than the whole run stopping. The same
protection covers every other ESI call in the app, so this class of hang is gone generally.

## New — activity layers on the Intel Map and overlay

Four toggles next to Intel / Kills / Chars / Sov, from EVE's hourly public feeds:

| | |
|---|---|
| **NPC** | rats killed in the last hour — ratting activity, and a sudden stop is its own kind of intel |
| **Ship** | ships killed — actual fighting |
| **Pod** | pods killed — someone died and didn't get out |
| **Jumps** | ships that jumped in — traffic |

**Any combination can be on at once.** Each layer draws its own tagged number beside the system —
`N284 J3` is 284 rat kills and 3 jumps — so nothing is hidden by whichever layer happened to win. A
system below the lowest threshold isn't drawn at all, so the map stays readable.

**Colour thresholds are yours to set** in the new **◧ Activity…** panel: as many bands per layer as you
want, each with its own colour, so "busy" means whatever it means in your space. Defaults are scaled per
layer — 300 NPC kills an hour is an ordinary ratting system, three ship kills is a fight. Your thresholds
are shared with the overlay.

These figures always cover the **last hour**. EVE publishes no longer window, so there's no 24-hour
version to show.

## New — jump-range overlay

Pick a hull and see exactly what it reaches. Systems in range are ringed; everything else fades but stays
visible, because what you *can't* reach is half of what you're looking at.

- **Black Ops 8 ly · Jump Freighter 10 · Rorqual 10 · Carrier/Dread/FAX 7 · Titan/Super 6**, at Jump
  Drive Calibration V — with a JDC 0–V selector for partial skills. Defaults to Black Ops at max.
- Measured in **light years through space**, not stargate jumps, so it cuts clean across the map.
- **High-sec is never in range** — a jump drive can't end there, and showing it would be a lie you could
  undock on.
- Measures from your character by default; `⌖ My character` returns to it, or start from any system with
  **⤭ Jump range** on its card.

Both layers work in the transparent overlay too, behind its **◧** and **⤭** buttons — reading the hull
and thresholds you set on the map, so the two windows always agree.

## Also

- **Follow intel is on by default.** The map chasing the newest report is what most people want from it,
  and it was an opt-in nobody found.
- **⚙ Logs is now ⚙ Select Intel Channels**, which is what it actually does.
- **PI Colonies says what went wrong.** A failed load used to be one word — "fetch error" — whatever the
  cause, and a server error was reported as *"No character is authorized"*, which sent people to the
  wrong place entirely. You now get the actual reason and a retry button. Individual characters that fail
  are listed by name and reason instead of a bare "3 issue(s)".

---

### Downloads

| Platform | File | Install |
|---|---|---|
| macOS (Apple Silicon) | `*.dmg` | Open the DMG, drag into Applications |
| Windows | `*.exe` | Run the installer |
| Linux — Debian/Ubuntu | `*.deb` | `sudo apt install ./<file>.deb` |
| Linux — Fedora/RHEL/openSUSE | `*.rpm` | `sudo rpm -U <file>.rpm` (or `sudo dnf install ./<file>.rpm`) |

The `.deb`/`.rpm` packages are unsigned (RPM tools may warn about a missing GPG signature — expected). The in-app updater picks the format matching your distro.

_Intel matcher & map ported from [Slazanger's SMT](https://github.com/Slazanger/SMT) (MIT); region layouts © Wollari & CCP (Dotlan); Thera/Turnur connections from [eve-scout](https://www.eve-scout.com/); ship names and system positions from CCP's SDE/ESI._

_Full release history: see [CHANGELOG.md](CHANGELOG.md)._
