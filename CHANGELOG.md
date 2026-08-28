# Changelog

Full release history. The GitHub **release page** for each version shows only
that version's notes (built from `RELEASE_NOTES.md`, which is replaced each
release); this file keeps the running history.

## v3.12.6 — Updates wait for you

**Update checks no longer interrupt.** The app checked two seconds after startup and hourly after that,
and opened a dialog in front of whatever you were doing each time it found something. A background check
now lights a pulsing **⬆ Update to vX.Y.Z** badge in the header, next to ⟳, and stops there. Clicking it
opens the same Download / Later dialog and download-and-install flow as before, at a moment you choose.

- Nothing downloads until you ask — the badge's tooltip says so, with your current version and the
  installer size.
- The badge stays until you act on it; there's no hourly "Later" to repeat, because nothing prompts on a
  timer any more.
- It clears itself when a later check finds you're current, or when a release has no installer for your
  platform.
- ⟳ still checks on demand, unchanged. The badge doesn't pulse under `prefers-reduced-motion`.

## v3.12.5 — A watchlist, a system you can click, and a map that stays put

**Watchlist — systems that alarm at any distance.** The distance tiers only reach as far as their
furthest range; past that, silence — the wrong answer for your staging system or home while you're
ratting six regions away. **★ Watch** keeps a list of systems that alarm whatever the distance, checked
before the distance tiers run, each with **its own sound** so you can tell staging from a chokepoint by
ear.

- Star a system from the map card, or add it by name in the ★ Watch panel.
- **The watch strip** above the map shows every watched system and its current state — quiet, `⚠ 2m`
  since a report, `clr`, or `◆` for kills. Click a chip to jump the map there.
- Watched systems are **starred on the map** and highlighted in their own colour when they light up.
- A **kill** in a watched system speaks with that system's voice at any distance; the global Kills toggle
  still gates it, so watching a system never switches on a feed you'd turned off.
- Watch alarms have **their own throttle clock**, so a busy channel three regions away can't swallow the
  alarm you care about.
- The list lives in the sidecar with the jump bridges and alarm rules, so the Intel Map, any pop-out and
  the overlay always agree — star something in one and the others update immediately.

**Click a system on the map.** Every node opens a card beside it (not a dialog in the middle of the
screen) with the system's security and region, how many jumps from the character you're following —
counting your jump bridges — the recent intel naming it, kills in the last hour and what they were worth,
and buttons for ★ Watch, Route from / to, Dotlan and zKill. Closes on Esc, an outside click, or any
pan/zoom; a small drag no longer counts as a click.

**The map remembers where you left it.** Per machine: the region and your exact pan/zoom, which layers
were on, whether Follow intel was ticked, and which panels were open. Your character still wins the
opening view — the saved region is the fallback for when there's no character fix, and a saved pan/zoom
only re-applies if you land in the region it was taken in. Switching tabs and back keeps your view
instead of refitting.

**Overlay**

- **Right-click any system to star it.** Left-click still re-pins the map to that pocket.
- The **watch strip** appears under the toolbar when a watched system lights up and hides when everything
  goes quiet; the new **★** button pins it open, and glows when something is live but the strip is hidden.
- **Fix — watched systems were filtered out of the ticker.** It only showed reports for systems inside
  your jump range, hiding the very reports the watchlist exists to surface.

**Fixes**

- **Watchlist changes could be silently lost** — starring two systems inside one round-trip had the
  second write drop the first. Writes are now serialised in the map and the overlay alike.
- **View settings could be silently lost** — toggling a layer and opening a panel in the same breath
  saved only the last of the two.

## v3.12.4 — Intel lines you can read at a glance

- **Intel reports are now colour-coded** in both the Intel Map feed and the overlay ticker: the
  **system** (red, green on a "clr"), the **ship** (amber) and the **reporting pilot** (blue) each stand
  out from the surrounding chat. Click a highlighted system to jump the map there — or, in the overlay,
  to watch that pocket.
- Ship names come from a bundled list generated from the SDE (393 hulls, including multi-word names like
  *Armageddon Navy Issue*) plus the fleet slang intel actually uses — *dictor*, *ceptor*, *logi*, *hictor*.
- The reporting pilot's name was being parsed out of each chat line and thrown away; it's now kept and
  shown.
- **Fix — false system matches.** SMT's matcher accepts a word that prefixes a system name, which is what
  lets "uexo" find UEXO-Z, but it also meant **"and" matched Andabiar / Andole / Andrub** and "gate"
  matched Gateway: systems nobody reported were glowing on the map, and since the alarm runs off the
  same match, they could sound it. Common English and intel filler words no longer match by prefix (an
  exact full-name match still does).

**Flat SMT map on the overlay**

- **Distance falloff is far more obvious** — near systems are full strength, the furthest in range drop
  to ~0.2, and systems outside the range fade almost away. It applies to the dots now, not just labels.
- It **opens framed on your jump range** (default 6) centred on your character, instead of fitting the
  whole region into a small window where nothing was legible. The rest of the region is a zoom-out away.
- **Zoom range widened to 0.2×–8×** so you can push in on a pocket or pull back to the whole region.

## v3.12.3 — SMT on Linux, and two map-readability fixes

**Linux support for the SMT tab.** The original SMT is Windows-only; this port now works on Linux, with
the platform differences handled rather than assumed away:

- **Chat-log auto-detection finds your Wine/Proton bottle.** EVE on Linux writes its logs inside a
  prefix, so ⚙ Logs now scans **Steam Proton** (`~/.steam/steam`, `~/.local/share/Steam`, `~/.steam/root`),
  **Flatpak Steam**, **plain Wine** (`~/.wine`, incl. `My Documents` layouts) and **Lutris**. The Steam
  app id isn't hardcoded, so any bottle is found. Windows also gained the common **OneDrive-redirected
  Documents** path.
- **Click-through can always be released.** The overlay's hover-to-release needs
  `setIgnoreMouseEvents({forward})`, which Electron supports on macOS/Windows only, and the `Ctrl+Alt+O`
  hotkey needs a global-shortcut-capable session (X11, not Wayland). Pressing **⊞ Overlay** in the app
  now releases click-through on any platform, so a Linux user can't get stuck with an unclickable
  overlay. The button's tooltip names the escape that works on your platform.
- Emoji font fallbacks added, so toolbar glyphs don't render as tofu on a bare Linux install.

Known Linux caveats (environmental, not fixable in the app): the transparent overlay needs a
**compositing window manager**; global hotkeys don't fire under **Wayland**; and Electron's
`skipTaskbar` / "float above fullscreen" are macOS/Windows-only, so the overlay shows in the taskbar and
should sit over a **windowed/borderless** client rather than true fullscreen.

**Map readability**

- The character name pill on the Intel Map now sits **above** the dot instead of beside it, where it was
  covering the system's own name.
- Flat SMT map labels were scaled from the region's overall span, which made them about as wide as the
  gap between systems (~55 units against a ~70-unit median jump). They now use the same calibrated
  9px/r4.5 sizing the Intel Map tab uses for the same layouts, and the overlay's font slider goes down
  to 0.3× for even smaller text.

## v3.12.2 — SMT intel alarms, and an overlay you can actually tune

- **🔔 Alerts** on the SMT toolbar — intel now sounds an alarm, configured as **distance tiers**. The
  first tier covering a report's jump distance decides its **sound**, **highlight colour**, **highlight
  size**, **fade time** and **flash** (marker, whole window, or both). Past the last tier is out of
  range: silent, drawn plain. Defaults run siren/red/×1.7/15min/window-flash in your own system down to
  beep/yellow/×1.0/5min at 5 jumps.
- Tiers are fully editable with a per-tier **Test**, and any tier can play a **sound file of your own**.
  Separate toggles + sounds for **"clr" reports** and **kills**, master **volume**, and a **minimum
  gap** between alarms. Muting silences the sound but keeps the visuals.
- **Overlay layouts** — toggle between the **jump-ring map** and the **flat SMT region map** (the same
  Dotlan layout the Intel Map tab draws).
- **Overlay zoom + label size sliders**, both persisted across restarts along with the chosen layout.
  Zoom centres on your own system, so closing in follows you rather than the region's middle.
- The overlay's `⚠ 2j` badge is tinted to the matching tier; **🔔** mutes without changing settings.
- **⤢ Pop out** for the Intel Map, and a **📌 pin** on every pop-out window to keep it above the game.
- The Intel Map **opens on your character's region** instead of a fixed default, and the character it
  follows is shown with their **portrait and name**, highlighted in the character row and on the map.
  Click any character to follow them instead.
- The alarm runs **from any tab**. While the overlay is open it owns the alarm and the main window stays
  quiet, so nothing sounds twice.
- Sounds are synthesised in-app (WebAudio) rather than shipped as audio files.
- Fix: `save_config` filters to an allowlist, so the new alarm settings were silently dropped and every
  save came back as defaults until `smt_alerts` was added to it.

## v3.12.1 — SMT intel alarms, tiered by distance

- **🔔 Alerts** on the SMT toolbar — the Intel Map and the overlay can now sound an alarm when intel
  lands near you, configured as **distance tiers**. The first tier covering a report's jump distance
  decides its **sound**, its **highlight colour on the overlay** and whether it **flashes** (none /
  slow / fast). Past the last tier is out of range: silent, drawn plain. Defaults: siren + red + fast
  in your own system, klaxon + orange + fast to 2 jumps, beep + yellow + slow to 5.
- Tiers are fully editable (distance, sound, colour picker, flash speed) with a per-tier **Test**, and
  any tier can play a **sound file of your own** instead of a built-in one. Add / remove / reset tiers.
- Separate toggles + sounds for **"clr" reports** and **kills in range**, a master **volume**, and a
  **minimum gap** between alarms so a busy channel can't machine-gun you.
- The overlay tints its `⚠ 2j` nearest-hostile badge to the matching tier and pulses markers at the
  tier's flash speed; a **🔔 button** mutes the alarm without changing the settings.
- The alarm runs **from any tab**, not only the SMT one. While the overlay is open it owns the alarm
  and the main window stays quiet, so nothing sounds twice.
- Sounds are synthesised in-app (WebAudio) rather than shipped as audio files — nothing extra to
  download, and the same sounds in both windows.

## v3.12.0 — SMT: characters, bridges, Thera, sovereignty, and the intel overlay

The rest of the SMT port, on top of v3.11.0's Intel Map.

- **Characters & fleet on the map** — authorize characters under **Auth → SMT Characters** (location /
  ship / online + fleet) and they plot live on the Intel Map, as a chip row and as markers; fleet
  members are plotted too. Click a chip to jump the map to that character.
- **Jump-bridge network** — manage your alliance's bridges under **Bridges…** (add pairs, or paste a
  whole network, one `A - B` per line). They draw on the map and are used for routing.
- **Routing** — **Route…** plans between two systems with **Shortest** / **Prefer high-sec** /
  **Prefer low-null**, over gates, your jump bridges and (with **via WH**) live wormhole connections;
  every hop is tagged with how it's taken.
- **Thera / Turnur** — **Thera…** lists live connections to k-space from **eve-scout** with wormhole
  type, max ship size and remaining life.
- **Sovereignty layer** — the **Sov** layer colours the map by alliance holder, prints per-system
  **ADM**, and rings systems under an active campaign; **Sov…** lists active sov campaigns with live
  timer countdowns plus contested faction-warfare systems.
- **Transparent intel overlay** — **⊞ Overlay** pops out a frameless always-on-top window for over the
  EVE client: the systems within N jumps of you as rings around your position, lighting up as intel
  and kills land (same ~10 min decay), a **nearest-hostile `⚠ 2j` badge**, and an intel ticker
  filtered to systems in range with per-report jump distances. Follows your character or a system you
  pin; range/labels/ticker/opacity on the toolbar; size, position and prefs persist.
  **Click-through** lets clicks pass to EVE — `Ctrl+Alt+O` toggles it back off, `Ctrl+Alt+M` hides/shows.

## v3.11.0 — SMT tab: Intel Map (live intel + kills)

First slice of an SMT (Slazanger's Eve Map Tool) port, in a new **SMT** tab group.

- **Intel Map** — an SMT-styled region map (separate from the Maps tab) with two live layers:
  - **Intel** read from your local **EVE chat-logs**: point the app at your Chatlogs folder, tick the
    intel channels, and reported systems glow red on the map (green for "clr") and **decay over ~10 min**,
    with a live **intel feed** panel. The system-name matcher is ported from SMT.
  - **Kills** — a live **zKillboard (RedisQ)** feed marking systems with recent kills.
- Region picker, system search, layer toggles, and **Follow intel** (jump the map to the newest report).
- Backend `/api/smt/*` collectors run in the background (chat-log tailing + RedisQ); nothing leaves your
  machine except the public zKill stream. More SMT features (characters/fleet, jump bridges, Thera/Turnur,
  sov campaigns, overlay) will follow in later releases.

## v3.10.0 — Structures tab: corp reinforcement timers

- New **Structures** tab (under Combat) listing your corp's Upwell structures with their
  **reinforcement state** live from ESI — reinforced structures (armor/hull timer) are highlighted with
  a live **"comes out" countdown**, plus **fuel-remaining** timers (low fuel flagged) and per-structure
  state badges (shield/armor/hull vulnerable, anchoring, etc.).
- Needs a **Station Manager / Director** character (the main auth used for corp reads) with the
  `esi-corporations.read_structures.v1` scope (+ `esi-universe.read_structures.v1` for names) and a
  configured `corp_id`. Only your own corp's structures are visible — ESI exposes no one else's timers.

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
