# v3.12.12 — Corp inventory that sees fitted ships, and clearer Acquisitions numbers

## Fix — corp inventory now counts modules fitted to your ships

**Acquisitions' "Corp inventory" and the Stockpile's "Scan corp hangars" were blind to anything nested inside
another item.** A fitted ship in a hangar was counted as a bare hull: its modules, and any ammo or drones
stowed in it, never reached the item pool, so **Analyse Hulls undercounted how many ships were actually
complete.** They're read now, and each item is filed under the hangar division its ship sits in.

**Fix for corps whose hangar is in a player structure (a Fortizar, say).** In a player structure, ESI files
hangar contents inside the corp's rented **Office**, not directly in the structure. The nested-item handling
above has to walk past the Office to find the real structure, and it now does — without it, a corp inventory
scan in that setup would have come back empty. NPC stations are unaffected.

## Acquisitions: quota context and fresher market data

**"(x of y needed)".** *Completable from inventory* and *Completable with UEXO market* now both show how many
of each ship you can build against how many the quota wants, instead of a bare count.

**Full fits on the Contracts tab.** Each quota row gains a **Full fits in Acquisitions** line beneath
*Bare hulls in Acquisitions*, filled in from your last Analyse Hulls run.

**No more stale market orders.** Analyse Hulls could reuse an in-memory market snapshot after the server's own
5-minute cache had expired, so an item could be reported as buyable on an order that had already gone. It now
re-fetches once the snapshot is older than the cache.

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
