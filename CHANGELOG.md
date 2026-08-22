# Changelog

Full release history. The GitHub **release page** for each version shows only
that version's notes (built from `RELEASE_NOTES.md`, which is replaced each
release); this file keeps the running history.

## v3.9.6 — Installer: the desktop icon stays gone once you remove it (Windows)

- The Windows desktop shortcut is now created on the **first install only** and is **never recreated
  on an update**. Delete it once to keep your desktop tidy and it won't come back with each update.
  (The Start-menu shortcut is always kept, and uninstalling removes the desktop icon.)

## v3.9.5 — PI optimiser: per-toon command centres, multibuy & saved work

- **Per-toon breakdown**: the split now lists exactly which planet-type command centres each toon
  deploys (e.g. `SushiAndSushi — Barren ×3 3f · Oceanic ×1 1f · Temperate ×1 1f`), with `Nf` marking
  the factory planets. Factory planets are assigned concrete planet types (spread across each toon's
  available planets) instead of a vague "any type", and the aggregate tally folds them in.
- **Copy multibuy**: a button on the command-centre tally copies a ready-to-paste in-game Multibuy
  list of every command centre needed (`Barren Command Center x16`, …).
- **Work persists across restarts**: the PI optimiser's system, planet budget, target commodity,
  assumptions, valuation and pulled toons are auto-saved and restored when you reopen the app.

## v3.9.4 — PI optimiser: factory planets consolidated onto your largest toons

- The suggested toon split now **consolidates factory planets onto the fewest, largest toons** (fill the
  biggest toon's factory slots first), so your reaction/factory colonies live on as few characters as
  possible. It only spreads them if concentrating would stop the extractors fitting — then it falls back
  to a feasible layout automatically.

## v3.9.3 — PI optimiser: the plan now always fits your toons

- **Fix:** the toon split could report "N won't fit in <system>" for a plan the optimiser said was
  valid. Two causes, both fixed: (1) the optimiser assumed every character could host `planets ×
  characters` colonies, but a toon with a 1-planet budget can only host one colony in a system — it now
  uses each toon's **real** in-system capacity (`min(planet budget, system planets)`); and (2) the split
  placed the flexible factory planets before the scarce extractor types, painting itself into a corner —
  it now places the **most-constrained planet type first** and fills factory planets into what's left.
- Factory planets still group onto the fewest toons **where capacity allows** (a system packed exactly
  full has no spare room to group them).

## v3.9.2 — PI optimiser: a System field where you actually optimise

- The planet optimiser now has its **own System field** (with a live "3 Barren · 2 Temperate · 1
  Oceanic (6 planets)" hint), so the system-aware tally from v3.9.1 no longer depends on the separate
  profit-ranking search box up top being filled in. Leave it blank for all planets; the command-centre
  header spells out which mode you're in.
- **Fix:** "Jita price lookup failed" is now explicit about *why* (backend unreachable vs. an API
  error) and notes the plan itself is still valid — the pricing step is independent of the plan.

## v3.9.1 — PI optimiser: command-centre tally is now physically deployable

- **Fix:** with a system chosen, the optimiser could tally more colonies of a planet type than
  the system physically has (e.g. "×28 Oceanic" in a system with one Oceanic planet). The plan is
  now **constrained by the chosen system**, modelling a shared pool of `planets × characters` slots
  (one colony per planet per character): extractors consume real planet slots and each P0 is spread
  across all its compatible in-system planet types, so the command-centre tally can never exceed
  what the system holds.
- Chains that a system can't extract are now reported plainly (e.g. *"Can't build this in UEXO-Z —
  no planet there extracts Reactive Gas, Felsic Magma…"*), and when the system caps throughput below
  the requested planet budget the plan says so.

## v3.9.0 — Native Maps + a system-aware PI colony planner

### Maps — now native (no more embedded Dotlan)
- The **Maps** tab is a native EVE map: pan/zoom region maps with systems coloured by
  security and stargate links, using Dotlan's familiar layout coordinates (© Wollari & CCP).
- **Live overlays** from ESI (last hour): ship **Jumps**, ship+pod **Kills**, **NPC** kills, and
  **Sovereignty** (each system coloured by its holding alliance, names resolved).
- **Stargate route planner** between any two systems — Shortest, prefer high-sec, or prefer
  low/null — drawn on the map and listed in the panel.
- **System detail panel**: security, region, live jumps/kills, sov holder, and clickable connected
  systems. Search jumps straight to any system; border systems link to their neighbouring region.
- Topology (5,485 systems / 6,989 gates) is bundled offline; jumps/kills/sov are fetched live.

### PI optimiser — command centres & system-aware planning
- New **"Command centres to deploy"** summary: how many command centres of **each planet type**
  the plan needs (extractors greedily consolidated onto the fewest distinct types).
- **System-aware**: pick a system in the planner and the tally uses **only that system's planet
  types**, shows how many of each the system has, and warns when a P0 can't be extracted there or
  when demand exceeds `planets × characters`.
- **One colony per planet per character** is respected in the suggested toon split (per-type,
  per-toon caps), and **factory planets are kept together** on the fewest toons instead of scattered.
- The ⚙ PI slide-out shows the command-centre tally too.

## v3.8.0 — PI-aware planners: categories, self-source & a PI optimiser slide-out

### Production & Reaction planners — item categories
- Every chain-calculator node and the node blow-up now show the item's **market group**
  (Mineral, Moon Materials, Ice Product, Refined/Basic/Specialized Commodities, Composite, …),
  in both planners. Category badges also appear in the production shopping list, gather list and tree.
- **Fixed:** clicking a raw-material node showed a bare `type 1234` instead of its name — the plan now
  carries a per-type name+group map, so nodes are always named correctly.

### Production planner — "gather" (self-source) as a third option
- Raw materials now have **buy / build / gather**. Marking a material **⛏ gather** (mined or made via PI)
  drops it off the buy shopping list into a separate **Gather / self-source** pane — with its own
  copy button, unit + ISK-value totals and a **Self-source** summary tile. The choice **persists across
  restarts**, and building an item supersedes gathering it.

### PI optimiser slide-out
- PI commodities carry a **⚙ PI** button (in the shopping list, gather list, production tree, chain-flow
  nodes and node blow-up). It slides out a side panel that reuses the **PI planner's chain calculator +
  optimiser** for that commodity — production chain (P0→P4), planets needed, extractor planets with
  planet types, and consolidated factory planets — with an editable planet count and a **Full planner ↗**
  hand-off.

### PI planet optimiser — realistic minimum planets
- The auto-optimiser no longer demands **one planet per production step**. Factory schematics **share
  planets** (multiple schematics per planet), so the floor is one extractor planet per raw material plus a
  shared factory planet — you can build P4 with far fewer planets than before, and the plan shows the
  consolidated factory shares.

### Fixes
- **Pull planets from ESI** now reports *why* it failed — backend unreachable vs. an ESI/auth error vs. a
  specific character's token — instead of a single generic "Failed to load planets from ESI." The endpoint
  also returns a readable error rather than a 500.

## v3.7.0 — Acquisitions Build Finder, version picker & contract polish

### Acquisitions — Build Finder
- **Analyse Hulls / Analyse Fits** split results into four buckets — **completable from inventory**,
  **completable with market buys**, **partial builds**, and **out of reach** — with live progress bars.
- The shopping list shows the **UEXO vs Jita cost delta** per missing item (+ a UEXO qty column), and
  the **120% Jita contract price** per fit in the completable sections.
- Results **persist across tab switches**, plus a **Copy inventory** button and **configurable
  shopping thresholds** (min coverage, max ISK gap). Hangar hull count added to the doctrine stock view.

### Contracts
- **T2 / T3 tech-tier badges** on contract quota bars and doctrine-stock hull bars.
- **Contract count** shown alongside total value, and **full-fit contract pricing via Janice**.
- Sold scan handles contracts with a null `date_completed` (falls back to `date_accepted`); new
  **Copy sold Discord table** button.

### Settings — app version picker
- A dropdown at the top of the Settings page lists released versions — **switch to or roll back to any
  version**. Picking one downloads that installer and runs it, so a bad update is easy to undo.

### Fixes
- Analyse Hulls no longer writes to a detached DOM after tab switches; shopping-list module names show
  correctly (were falling back to type IDs); candidates with hull qty < 1 are skipped.

---

## v3.6.2 — pick which character the auto-inventory-search uses

- The **Production** and **Reaction** planners get an **Inventory** dropdown listing **all connected
  characters** (main / PI / fitting / inventory slots) plus **All connected toons**. The
  **auto-inventory-search** — *Auto-detect stock* and the node **availability** colouring — now uses
  the character you pick. The choice is **shared across both planners** and **remembered between app
  restarts**.

---

## v3.6.1 — dedicated Inventory Characters auth

- New **Inventory Characters** section on the Auth tab: authorize alts **just** for reading their
  assets (`esi-assets.read_assets.v1` only) — up to **24**, fully isolated from your main
  characters' scopes. They power the **auto inventory search** on the Production & Reaction planners
  (Auto-detect stock + node availability) and the **My Assets** tab, without re-scoping your main /
  PI / fitting characters. Use *Add inventory character* to log in the next one.

---

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
