# v3.12.9 — Station Trading, and a shared acquisitions inventory

## New — Station Trading

A new tab under **General**. Pick two NPC hubs, hit Analyse, and see what's worth buying at one and
selling at the other. Jita, Amarr, Dodixie, Rens and Hek are built in.

**Every row shows both ways of playing it**, because the gap between them is the decision:

| | What it means |
|---|---|
| **Instant** | Buy the sell order here, hit the buy order there. No waiting, nobody can undercut you. |
| **Patient** | Buy here, then list your own sell order there. More margin — if your order fills and nobody undercuts you first. |

**Ranked by what you'd actually make in a day, not by the biggest spread.** A 34% margin on something
that trades twice a day is not a trade; a 10% margin on something that moves 100,000 units is. The list
sorts on per-unit profit times the units that genuinely change hands.

**Two volume columns, on purpose.** *On book* is what's sitting at the best price right now at that
station. *Vol/day* is what the destination region actually traded, per day, over the last week. Thousands
resting on the book that move three a day is a trap, and only the second column tells you.

**Profit calculator.** Pick an item, enter how many units, choose a hauler — Blockade Runner through
Freighter, with editable capacity — and get cost, revenue after your fees, profit, total m³, how many
**trips** it takes, the **jumps** each way, and profit per trip. It warns you when you're buying more than
the book holds, since past that point the real margin is thinner than the headline.

**Saved pairs** for the routes you run, and an **item search** that predicts as you type.

**A ticker**, currency-pair style, for the pairs you're watching — live spread, day-on-day change, and it
pauses when you hover so you can actually read it. Click any item for its **chart over time**.

### About the chart, honestly

EVE publishes price history **per region**, never per station. So the chart shows each station's region as
an explicitly-labelled *proxy* — fine for Jita↔Amarr, where each hub dominates its region — and starts
recording the **real spread between your two stations** from the day you add the pair to the ticker. That
line fills in over the following days. Where both stations share a region, the app says so, because the
proxy can't tell them apart.

### Fees are yours to set

Sales tax and broker fee default to a well-trained trader, and you can change both. Recorded history is
kept *before* fees, so it stays true when your skills change.

## New — shared acquisitions inventory

Contributed by **Thanatos**. Directors can now publish the acquisitions hangar inventory to the alliance
quota repo, and every client pulls it on startup — so the whole alliance sees the same stock without
anyone pasting exports around. Gated by the same admin checkbox as quota push, and falls back silently to
the local file when the repo isn't configured.

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
