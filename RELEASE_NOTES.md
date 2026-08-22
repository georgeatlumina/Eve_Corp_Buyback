# v3.8.0 — PI-aware planners: categories, self-source & a PI optimiser slide-out

## Item categories in both planners
- Every chain-calculator node and the node blow-up now show the item's **market group** — Mineral,
  Moon Materials, Ice Product, Refined / Basic / Specialized Commodities, Composite, and so on — in the
  **Production** and **Reaction** planners. Category badges also appear in the production shopping list,
  gather list and production tree.
- **Fixed:** clicking a raw-material node used to show a bare `type 1234` instead of its name. The plan
  now carries a per-type name + group map, so nodes are always named correctly.

## "Gather" — self-source as a third option (Production)
- Raw materials now have **buy / build / gather**. Marking a material **⛏ gather** (mined or made via PI)
  moves it off the buy shopping list into a separate **Gather / self-source** pane — with its own copy
  button, unit + ISK-value totals, and a **Self-source** summary tile.
- The choice **persists across restarts**, and building an item supersedes gathering it.

## PI optimiser slide-out
- PI commodities get a **⚙ PI** button (shopping list, gather list, production tree, chain-flow nodes and
  node blow-up). It slides out a side panel that reuses the **PI planner's chain calculator + optimiser**
  for that commodity: production chain (P0→P4), planets needed, extractor planets with their planet types,
  and consolidated factory planets — with an editable planet count and a **Full planner ↗** hand-off.

## Realistic minimum planets in the PI optimiser
- The auto-optimiser no longer insists on **one planet per production step**. Factory schematics **share
  planets** (multiple schematics per planet), so the floor is one extractor planet per raw material plus a
  shared factory planet — you can build P4 with far fewer planets, and the plan shows the consolidated
  factory shares.

## Fixes
- **Pull planets from ESI** now reports *why* it failed — backend unreachable vs. an ESI/auth error vs. a
  specific character's token — instead of a single generic message, and the endpoint returns a readable
  error rather than a 500.

---

### Downloads

| Platform | File | Install |
|---|---|---|
| macOS (Apple Silicon) | `*.dmg` | Open the DMG, drag into Applications |
| Windows | `*.exe` | Run the installer |
| Linux — Debian/Ubuntu | `*.deb` | `sudo apt install ./<file>.deb` |
| Linux — Fedora/RHEL/openSUSE | `*.rpm` | `sudo rpm -U <file>.rpm` (or `sudo dnf install ./<file>.rpm`) |

The `.deb`/`.rpm` packages are unsigned (RPM tools may warn about a missing GPG signature — expected). The in-app updater picks the format matching your distro.

_Full release history: see [CHANGELOG.md](CHANGELOG.md)._
