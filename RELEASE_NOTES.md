# v3.5.0 — My Assets tab, reactions availability & auto-detect

## My Assets tab (new) — General group
See, search and filter every character's assets from ESI. A **toon dropdown** (mains **and** PI
toons), an **All connected toons** checkbox to aggregate everyone, **item search**, **location
filter**, and **group by location**. Item locations resolve to real **station / structure names**.

## Reactions — assets-aware
- **🔍 Auto-detect stock** — fills the on-hand stock box with everything in the reaction chain you
  already own (across all connected toons), then re-analyzes.
- **Chain availability** panel: **group by Stage / Location / both / flat**, and toggle a
  **Timeline** view where each stage (raw inputs → product) shows **available vs missing** at a
  glance.
- **Per-stage "Copy missing"** shopping-list buttons, alongside the whole-chain list.

## Ore Buyback
- Structure locations now resolve using **every authenticated character** that can read structures
  (not just one), with a hint prompting a re-auth when none can — so far fewer locations fall back
  to raw IDs.

## ⚠️ Upgrade note — re-auth required
These features use two ESI scopes — **`esi-assets.read_assets.v1`** (new) and
**`esi-universe.read_structures.v1`**. Enable both in your **EVE developer application**, then
**re-authenticate your characters** on the Auth tab to grant them. Until then, assets / structure
names won't load, and the app tells you which toons still need a re-auth.

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
