# v3.12.4 — Intel lines you can read at a glance

Intel reports are chat messages, and reading a wall of them mid-fight is slow. Now the parts that
matter are picked out for you — and a matcher bug that was lighting up systems nobody reported is gone.

## Colour-coded reports

In both the Intel Map feed and the overlay ticker, each report now separates:

| Part | Colour |
|---|---|
| **System** | red — green when it's a `clr` |
| **Ship** | amber |
| **Reporting pilot** | blue |

Everything else stays plain, so `UEXO-Z 3 reds, Loki and a Sabre on gate` reads as *where*, *what* and
*who* without parsing the sentence. **Click a highlighted system** to jump the map there — or, in the
overlay, to start watching that pocket.

Ship names come from a list generated from the SDE: 393 hulls, multi-word names like *Armageddon Navy
Issue* included, plus the fleet slang intel actually uses — *dictor*, *ceptor*, *logi*, *hictor*,
*bomber*. The reporting pilot's name was already being parsed out of every chat line and thrown away;
it's kept now.

## Fix: systems nobody reported

SMT's matcher accepts a word that prefixes a system name — that's what lets "uexo" find UEXO-Z. But it
also meant **"and" matched Andabiar, Andole and Andrub**, and "gate" matched Gateway. Those systems lit
up on the map, and because the alarm runs off the same match, they could set it off.

Common English and intel filler words no longer match by prefix. An exact full-name match still counts,
so a system genuinely called Gateway is unaffected.

## Flat SMT map on the overlay

- **Distance is far easier to see.** Near systems are full strength, the furthest in range drop to about
  a fifth, and systems outside your range fade almost away. The dots dim now, not just the labels.
- **It opens framed on your jump range** (default 6) centred on your character, rather than squeezing an
  entire region into a small window where nothing was legible. The rest of the region is a zoom-out away.
- **Zoom now runs 0.2× – 8×**, so you can push right in on a pocket or pull back to the whole region.

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
