# v3.2.0 — zKillboard tab & Reaction Calculator

## zKillboard tab (new) — General group
A live, in-app view of **zkillboard.com** embedded in a browser panel — the full killboard
without leaving the app: recent kills, character / corp / alliance / ship / system stats,
campaigns, wars, trophies, inferred fits.
- App-side **navigation chrome** (Back / Forward / Reload / Home + open-in-browser),
  **quick-links** (Recent, Campaigns, Sovereignty, Wars, Trophies, Inferred Fits), and a
  **search box** for any pilot / corp / alliance / ship / system.
- Your zKill **login persists** between visits; off-site links open in your external browser.

## Reaction Calculator (new) — Production group
A **RAVWorks-style** planner scoped to reactions. Pick from a browsable catalog of **all 119
reaction recipes** (or paste a target list) and get the **reactions to run** and the **raw
materials** (moon goo / gas / PI) to buy — the full multi-tier chain, priced against Jita.
- **Structure / rig / space presets** — Tatara + Reactor Efficiency I (2.0%) or II (2.4%),
  scaled ×1.0 lowsec / ×1.1 null-WH — auto-fill the material % (still editable). Reactions
  ignore ME, so an Athanor gets no material bonus.
- **Live reaction cost index** by system for job fees, **build-vs-buy** totals, per-reaction
  **→ buy** toggles, a collapsible **reaction tree**, and **Copy / Download** the shopping list
  as an in-game Multibuy.

## Fixes
- **Production / Reaction tree** font no longer shrinks with depth — the size was applied
  per-row in `em`, which compounded down the nesting; deep nodes are now fully readable.

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
