# v3.12.11 — Stockpile targets, and a config fix worth knowing about

## New — material targets on the Stockpile

Set how much of each material the alliance wants on hand, and the Stockpile tab opens with a
**Target status** panel showing where you stand — worst first, because the list is there to be acted on.

```
1 of 5 met · 2 critical · 4 short

Isogen     0.0%   0 / 2,000,000            short 2,000,000
Nocxium    0.0%   0 / 500,000              short 500,000
Pyerite     40%   4,000,000 / 10,000,000   short 6,000,000
Morphite    90%   90,000 / 100,000         short 10,000
Tritanium  120%   60,000,000 / 50,000,000  met
```

**A material you hold none of still gets a row.** That's the most useful thing this view can tell you, and
it's precisely what a plain stock list can never show — Isogen and Nocxium above are exactly that case.

Targets work whether stock came from a paste or an ESI hangar scan; they match on item name or type ID,
whichever is available.

**Set them in Config → Stockpile → Material targets.** The name box suggests materials already in stock,
so you don't have to remember exact EVE spellings.

## Targets are shared with the alliance

Saving targets publishes them to the same repo the stockpile itself uses, and every client picks them up —
so the alliance works to one set of numbers rather than each admin keeping their own. They're stored
separately from the stock figures, so a routine stock update can never overwrite somebody's targets.

Gated by the same **Allow stock edits** toggle as stock changes. Worth having one person set the initial
targets; everyone else sees them from then on.

## Choose which hangar the stockpile reads

**Config → Stockpile → Which hangar the stockpile reads**: pick the structure and tick the divisions that
hold stockpile material. Those become the default for every scan, so nobody has to remember which boxes to
tick — and the Stockpile can read a different hangar from the Acquisitions tab instead of the two sharing
one setting. Leave it unset and nothing changes.

## Fix — two settings that never saved

**Acquisitions shopping-list settings were silently discarded.** *Minimum coverage* and *maximum ISK gap*
were on the Config page and looked like they saved, but the app dropped them every time — the shopping
list has always run on the built-in 50% / 500M whatever you set. Both work now.

If you'd set these before and wondered why the shopping list ignored you: it did. Set them again after
updating.

Exports also now carry everything added to the Config page recently — wallet division names, stockpile
targets and hangar settings included.

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
