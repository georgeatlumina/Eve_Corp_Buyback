# Changelog

Full release history. The GitHub **release page** for each version shows only
that version's notes (built from `RELEASE_NOTES.md`, which is replaced each
release); this file keeps the running history.

## v3.6.0 — Planner memory bank & interactive chain calculator

### Memory bank — Production & Reaction planners
- **10 memory slots** per planner: record / recall / rename / clear, an auto label + product icon,
  and a **pulsing glow** on the active slot. Recalling over unsaved work offers to stash it first.
- **Auto-persistence**: everything you type is saved and **restored when you reopen the app** — no
  more losing a recipe on close. **Reset** clears the page (your saved memories are kept).
- **Pop out** any memory into its own window (several at once), and an in-tab **Compare** mode shows
  recipe chains read-only, side by side.

### Interactive Chain calculator — Production & Reaction
A node graph next to each tree: columns by tier (raw → product) with connector lines, and **every
quantity is editable — change any node and the whole page re-plans** (tree, jobs, shopping list).
- **Click a node** to trace its sub-chain and open a **blow-up detail**: the **blueprint /
  reaction-formula name to copy in-game**, the **inputs** (per-run + total) with **availability
  colouring** — green = enough, yellow = partial, red = missing (from your assets **and** on-hand
  stock) — the output, a **Build ↔ Buy** toggle, and **×2 / ×5 / ×10** multiply.

### Quality-of-life & fixes
- **Login / Re-login** now reliably opens the EVE SSO page (the packaged app's login previously
  appeared to do nothing).
- **Analyze** errors are explicit — a network failure names the backend / port instead of a bare
  "failed to fetch".
- The jobs **"buy"** action reads **"→ Shopping list"** and is visible by default.
- **Larger default window** (1280×860, clamped to your screen, centered) for a comfortable
  at-least-13-inch default.

---

## v3.5.0 — My Assets tab, reactions availability & auto-detect

### My Assets tab (new) — General group
See, search and filter every character's assets from ESI. A **toon dropdown** (mains **and** PI
toons), an **All connected toons** checkbox to aggregate everyone, **item search**, **location
filter**, and **group by location**. Item locations resolve to real **station / structure names**.

### Reactions — assets-aware
- **🔍 Auto-detect stock** — fills the on-hand stock box with everything in the reaction chain you
  already own (across all connected toons), then re-analyzes.
- **Chain availability** panel: **group by Stage / Location / both / flat**, and toggle a
  **Timeline** view where each stage (raw inputs → product) shows **available vs missing** at a
  glance.
- **Per-stage "Copy missing"** shopping-list buttons, alongside the whole-chain list.

### Ore Buyback
- Structure locations now resolve using **every authenticated character** that can read structures
  (not just one), with a hint prompting a re-auth when none can — so far fewer locations fall back
  to raw IDs.

**Upgrade note (important):** these features use two ESI scopes — **`esi-assets.read_assets.v1`**
(new) and **`esi-universe.read_structures.v1`**. Enable both in your **EVE developer application**,
then **re-authenticate your characters** (Auth tab) to grant them. Until then, assets / structure
names won't load and the app tells you which toons need a re-auth.

---

## v3.4.3 — updates always replace the sidecar

Fixes a Windows update problem where a **running `sidecar.exe` was file-locked**, so an installer
(fresh or auto-update) could keep the **old sidecar** next to the new app — a renderer↔sidecar port
mismatch that showed the "can't reach the local backend" banner. (Confirmed: manually closing the
stale `sidecar.exe` before reinstalling fixed it — this release automates that.)

- The app now **fully kills the sidecar process tree** on quit and **before launching a downloaded
  update installer**, so the locked file is freed and always replaced.
- The Windows installer/uninstaller also **stops any running sidecar** during install — covering even
  a force-killed-app orphan.
- The updater already downloads and runs the **full** platform installer (no differential), so big
  version jumps (e.g. v2.x → latest) replace every file.

---

## v3.4.2 — clearer backend-unreachable errors

- If the app can't reach its local backend (the sidecar), it now shows a **clear banner naming the
  port** instead of failing silently — reads used to fall back to defaults quietly, so the first
  visible symptom was a cryptic **"failed to fetch"** on config import. Config import now gives an
  actionable message too.
- The sidecar logs its **bound port** (and callback URL) at startup, and the app logs the port it
  health-checks — so a renderer↔sidecar port mismatch is obvious from `sidecar.log`.

_(No functional change to features — this is reliability/diagnostics only.)_

---

## v3.4.1 — sidecar port move to 8766

- The local sidecar (the API **and** the ESI login callback) **moved from port 8765 to 8766**.

**Upgrade note:** if you run your own EVE application, set its callback URL to
**`http://localhost:8766/callback`** in the developer portal, or logins will fail with a
`redirect_uri` mismatch.

---

## v3.4.0 — Buyback locations, reliability & security

### Ore buyback — location names & controls
- Contract **locations are now resolved to names** (stations via public ESI; player structures via
  the authenticated structure endpoint) instead of raw location IDs.
- New controls on the Ore Buyback tab: **Sort** (oldest [default] / newest / location), **filter by
  location**, and **group by location** (oldest-first within each group).

### Reliability
- Wallet and corp-contract loads no longer fail with a raw 500 on ESI errors — a **403 now gives a
  clear "needs Accountant role + wallet scope" message**, and other failures a safe reason.

### Security
- The access token that ESI embeds in error URLs is now **redacted** from the UI and logs (a
  corp-contracts scan could previously surface the full token).

**Upgrade note:** **re-authenticate your characters** to grant the new structure-names permission
(`esi-universe.read_structures.v1`), or structure names fall back to IDs. Self-hosters must also
enable that scope in the developer portal.

---

## v3.3.0 — native zKillboard

The zKillboard tab is now a **native killboard** instead of an embedded web view of
zkillboard.com. Search a pilot / corporation / alliance / system and see its recent kills and
losses rendered in-app — pulled live from zKillboard's public API and enriched with public ESI
killmails.

- **Type-ahead search:** zKillboard autocomplete suggestions (pilots / corps / alliances /
  systems) appear as you type (3+ letters), navigable by keyboard or mouse. Picking a
  suggestion loads its board by exact id — no ambiguity from same-named entities, and decorated
  names like `Jita (The Forge)` resolve cleanly.
- **Native killmail list:** ship renders, victim & final-blow portraits, security-coloured
  systems, ISK values, solo / NPC / awox flags, attacker counts and relative timestamps. Click
  a row to open the full killmail on zkillboard.com.
- **Kills / losses / both** filter.
- Killmails are cached on disk (they're immutable), so revisited boards load instantly; a page
  of killmails is fetched from ESI in parallel with a single bulk name-resolve call.

The old embedded web-view chrome (Back/Forward/Home, quick-links) is gone — those were whole
zKillboard pages rather than killmail lists.

---

## v3.2.1 — fixes

- **Shopping list → Janice:** the Reaction Calculator and Production Planner shopping-list
  quantities no longer render with thousands-separator commas (e.g. `170,000`), which caused
  errors when the list was pasted into Janice. Quantities now copy as plain digits; the
  comma-formatted value is kept as a hover tooltip for readability.

---

## What's new in v3.2.0 — zKillboard tab & Reaction Calculator

### zKillboard tab (new) — General group
A live, in-app view of **zkillboard.com** embedded in a browser panel — the full killboard
without leaving the app: recent kills, character / corp / alliance / ship / system stats,
campaigns, wars, trophies, inferred fits.
- App-side **navigation chrome** (Back / Forward / Reload / Home + open-in-browser),
  **quick-links** (Recent, Campaigns, Sovereignty, Wars, Trophies, Inferred Fits), and a
  **search box** for any pilot / corp / alliance / ship / system.
- Your zKill **login persists** between visits; off-site links open in your external browser.

### Reaction Calculator (new) — Production group
A **RAVWorks-style** planner scoped to reactions. Pick from a browsable catalog of **all 119
reaction recipes** (or paste a target list) and get the **reactions to run** and the **raw
materials** (moon goo / gas / PI) to buy — the full multi-tier chain, priced against Jita.
- **Structure / rig / space presets** — Tatara + Reactor Efficiency I (2.0%) or II (2.4%),
  scaled ×1.0 lowsec / ×1.1 null-WH — auto-fill the material % (still editable). Reactions
  ignore ME, so an Athanor gets no material bonus.
- **Live reaction cost index** by system for job fees, **build-vs-buy** totals, per-reaction
  **→ buy** toggles, a collapsible **reaction tree**, and **Copy / Download** the shopping list
  as an in-game Multibuy.

### Fixes
- **Production / Reaction tree** font no longer shrinks with depth — the size was applied
  per-row in `em`, which compounded down the nesting; deep nodes are now fully readable.

---

## What's new in v3.1.0 — Dotlan Maps

### Dotlan Maps tab (new) — General group
A live, in-app view of **evemaps.dotlan.net** — the complete Dotlan site embedded in a browser
panel, so all of its tools are available without leaving the app:
- **Region & system maps** with Dotlan's full layer set (sovereignty, jumps, ship/pod/NPC kills,
  industry indices, structures, minerals…), plus the **Jump Planner**, **Route Planner**, **Range**,
  **Sovereignty**, **Alliances** and **Faction Warfare** pages.
- App-side **navigation chrome** (Back / Forward / Reload / Home + open-in-external-browser),
  **quick-links** to Dotlan's main tools, and a **search box** for any system / region / alliance.
- Your Dotlan **login persists** between visits (Favorites, jump beacons), and off-site links open
  in your external browser.

### Quality-of-life
- The **"What's new"** drawer now shows just the **latest two** releases (older history stays on
  GitHub and in `CHANGELOG.md`).

---

## What's new in v3.0.0 — Ship Fitting (Pyfa engine), Production Planner, D-Scan & more

### Ship Fitting tab (new) — Combat group
A full ship fitter built on **Pyfa's `eos` calculation engine**, run headless in the app:
- **Browse ships & modules** (filtered to what your ship can actually fit), load **compatible
  ammo/scripts**, add **drones / implants / cargo**, and **T3 subsystems + tactical mode**.
- **Configurable pilot skills** (All V / All 0 / custom default + per-skill overrides).
- **Module grouping** — collapse identical modules into one ×N row; ammo + state changes
  propagate to the whole group.
- Ship render + module/ammo **icons** and a per-slot **detail line** (CPU/PG, cap, cycle,
  optimal+falloff, tracking).
- A **Pyfa-style stats panel** — DPS (+ damage-type breakdown), **EHP with resists** (EHP/HP
  toggle), **stable vs max reps**, capacitor, navigation/targeting, and CPU/PG/calibration
  bars — plus a **Graphs** tab with **Effective DPS vs distance**.
- **Open & save fits to the in-game fitting window via ESI** (a dedicated *Fitting Characters*
  auth section, or your main slots), plus **EFT import/export** and local save/load.

> Because eos's calc core is GPLv3, the app is now distributed under the **GPL v3**.

### Production Planner (new) — RAVWorks-style industry
Plan multi-tier **manufacturing + reactions**: paste a build list and your on-hand stock, and
get the **jobs to run** and the **raw materials to buy**, priced at Jita — with ME + structure/
rig bonuses, **buy-vs-build** overrides, **T2 invention** (datacores/decryptors/ME), and **job
install-cost** estimates.

### D-Scan share tab (new)
Paste an in-game **D-Scan** and get a shareable **dscan.info** link.

### Processed Orders (new) — Operations → Buybacks
Search finished inbound buyback contracts by item name (e.g. "robotics") — contracts alliance
pilots sent privately and an NLDO member accepted.
- Results show **matching items first**, with the rest collapsed under "+ N more items"; each card
  lists **contract ID, issuer, accepted date, title, and price**.
- A **live progress bar** as ESI pages and contract items stream in, and **item data is cached**
  after the first search so repeats are much faster. Covers roughly the last 1,000 contracts.

### Quality-of-life
- **SRP**: fleet requests now sort by pilot name.
- **Ore Buyback**: contracts ordered **oldest-first** with an "issued N days ago" label.
- **Navigation**: a new **Combat** group (Fitting + D-Scan) and the **Planetary** group
  (PI Planner & Builder + PI Colonies).

---

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
