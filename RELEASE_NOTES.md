## What's new in v2.4.0 — PI production optimizer, planner merge & in-app patch notes

### PI planet optimizer (new)
On the **PI Planner & Builder** page, tell it a **target commodity** and how many
**planets** you have across your toons, and it allocates them for maximum output.
- **Which planets to set as extractors vs. factories** — and for what inputs/outputs —
  with each extractor row showing the P0 it pulls and the planet types it's on, and the
  **bottleneck stage highlighted**. Three selectable role models (default: extractors make P1).
- **Planet budget from ESI:** pulls each toon's true max planets (Interplanetary
  Consolidation level). *Requires a one-time re-auth of your PI toons* to grant the new
  read-skills scope — until then a toon shows "re-auth for skills". You can also just type a total.
- **Auto-computed, editable capacity** (CC level, factories-per-planet, extraction rate) and a
  **suggested split across your toons**.

### Value & logistics
- **ISK/day & /month** at **Jita buy**, **corp buyback %**, and **direct export to Jita
  (PushX courier)** — all live-configurable.
- **POCO export tax** charged on **every launch off a planet across the chain** (CCP adjusted
  prices, not just the final product), with a live rate.
- **Logistics:** per-tier haul **m³/day**, **Epithal/DST load** multiples, **final-product
  volume per day & month**, and **move cadence** ("fill an Epithal every ~N h"). Ship holds configurable.
- **Save/recall plans** locally (target, planets, all assumptions, valuation & holds).

### "Top PI by value" suggestion
For a given system, the **top 3 most valuable commodities per tier (P1–P4)**, ranked by
**ISK/day for your planet budget** (with per-unit profit alongside). Infeasible tiers are flagged
(e.g. P4 needs more planets). Click any suggestion to set it as the optimizer target.

### PI Planner merged in
The standalone **PI Planner** tab is gone — all planning now lives at the top of the
**PI Planner & Builder** page (system search, planet types, ranked profitable chains, recipe drill-down).

### In-app patch notes & help
- A **"What's new"** drawer (🗒 by the version) shows recent release notes live from GitHub.
- A **per-page help panel** explains the current tab.

---

## What's new in v2.3.0 — PI Builder chain calculator & big canvas upgrades

### Chain calculator (new)
- On the **PI Builder** page, pick any commodity and see the **whole production chain** laid out **left→right by tier** (P0 raw → product), with **connector lines** showing exactly what flows into what.
- **Every quantity is editable** — change any input or output and the entire chain **rescales both ways**, with per-tier **"run(s)"** counts.
- **Click a node** to highlight its complete connected sub-chain (everything upstream and downstream). P0 nodes show **which planet types** they're extractable on.
- **Pop the calculator out** into its own window.

### Builder editing improvements
- **Select & delete links:** click any connector on the planet to select it (shows the two endpoints + distance); remove it with the **Delete link** button or the **Delete / Backspace** key.
- **🔗 Link tool** and an explicit **Load** button for saved templates (with an unsaved-changes prompt), plus a **Clear** button to empty a colony.
- **Drag pins to move** them on the surface; fixed a bug where dragging to rotate dropped a stray pin.
- **Zoom fix:** pins now stay attached to the planet surface when you zoom.
- **Bigger canvas:** the planet **scales with the app / pop-out window** instead of a fixed small size.
- **Pop out** any PI tab (Planner / Builder / Colonies) into its own window.

---

## What's new in v2.2.1

- **Fix:** the PI tabs (Planner / Builder / Colonies) showed blank in the packaged app — the bundled PI datasets weren't included in the installer, so the data endpoints failed. They're now bundled correctly. (Dev builds were unaffected.)

---

## v2.2.0 — the full Planetary Interaction suite

Three new tabs in the General group.

### PI Planner (profitability analyzer)
- Search a solar system to see what its planets can extract, then rank the most profitable **P0→P4 production chains** buildable there.
- Priced at **Jita** (immediate sell) with a configurable **POCO export tax**; raw P0 is treated as free (extracted).
- **Per-run pricing by default** (one factory cycle — the smallest batch: P1 ×20, P2 ×5, P3 ×3, P4 ×1), with a **Per unit** toggle.
- **System-search autocomplete** over all 8,490 solar systems (3-character minimum).
- Click any chain for its full recipe tree + raw-P0 basket.

### PI Builder (visual colony layout builder)
- Place command centers / extractors / factories / storage / launchpads on a **rotatable, zoomable realistic planet**, link them, assign factory schematics, extractor resources and heads, and set routes.
- Live **CPU / Powergrid budget** (pin loads + extractor heads + link cost).
- Loads existing colonies from — and **saves importable templates straight to** — your EVE `PlanetaryInteractionTemplates` folder, so a colony built here imports into the game fully wired.

### PI Colonies (live colony manager)
- Live colonies across your characters via ESI, with per-extractor **countdown timers** and **status** (expired / expiring <24h / active / idle), sorted by soonest expiry.
- **Desktop notifications** when an extractor is about to run dry — even while you're on another tab.
- Per-colony **detail view** (what it's producing, stored contents, pin breakdown) and **Jita valuation** (output ≈ ISK/day + stored value, with totals).
- **Open in Builder** pulls a live colony onto the canvas to tweak and re-export.

### PI Characters auth
- A dedicated **PI Characters** section on the Auth tab authorizes up to **24 alts just for PI** — each login requests only the `manage_planets` scope, so your main characters aren't re-scoped.

---

### Downloads

| Platform | File | Install |
|---|---|---|
| macOS (Apple Silicon) | `*.dmg` | Open the DMG, drag into Applications |
| Windows | `*.exe` | Run the installer |
| Linux — Debian/Ubuntu | `*.deb` | `sudo apt install ./<file>.deb` |
| Linux — Fedora/RHEL/openSUSE | `*.rpm` | `sudo rpm -U <file>.rpm` (or `sudo dnf install ./<file>.rpm`) |

The `.deb`/`.rpm` packages are unsigned (RPM tools may warn about a missing GPG signature — expected). The in-app updater picks the format matching your distro.
