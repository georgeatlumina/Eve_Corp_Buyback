'use strict';

// ================= Patch-notes & Help drawers =================
// Two slide-out drawers driven from the header:
//   • 🗒 (next to the version)  → left drawer, "What's new" — live GitHub
//     releases fetched via the sidecar (/api/releases), rendered from markdown.
//   • ? Help (far right)        → right drawer, per-page help that follows the
//     active tab (content registry below).
// Reuses app.js globals ($, API, escapeHtml). Self-contained IIFE.

(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(s) : String(s == null ? '' : s));

  // ---------------------------------------------------------------- drawers
  function openDrawer(drawer, overlay) {
    // close the sibling drawer first so only one is ever open.
    document.querySelectorAll('.side-drawer.open').forEach((d) => { if (d !== drawer) hideDrawer(d); });
    document.querySelectorAll('.side-drawer-overlay:not([hidden])').forEach((o) => { if (o !== overlay) o.hidden = true; });
    overlay.hidden = false;
    drawer.hidden = false;
    drawer.setAttribute('aria-hidden', 'false');
    // next frame so the transform transition runs.
    requestAnimationFrame(() => drawer.classList.add('open'));
  }
  function hideDrawer(drawer) {
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    const overlay = drawer.id === 'help-drawer' ? $('#help-overlay') : $('#notes-overlay');
    if (overlay) overlay.hidden = true;
    // keep it in the DOM but hidden after the slide-out.
    setTimeout(() => { if (!drawer.classList.contains('open')) drawer.hidden = true; }, 220);
  }
  function anyOpen() { return document.querySelector('.side-drawer.open'); }

  // ---------------------------------------------------------------- markdown-lite
  // Enough of GitHub's release-note markdown to read well: headings, bullet
  // lists, pipe tables, bold, inline code, and links (explicit + bare URLs).
  function mdLite(md) {
    const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
    const inline = (t) => esc(t)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) { const lvl = Math.min(6, h[1].length + 2); out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`); i++; continue; }
      // table: header row followed by a |---|--- separator
      if (line.includes('|') && lines[i + 1] && /-/.test(lines[i + 1]) && /^[\s|:-]+$/.test(lines[i + 1])) {
        const cells = (r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
        const th = cells(line).map((c) => `<th>${inline(c)}</th>`).join('');
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].includes('|')) { rows.push(`<tr>${cells(lines[i]).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`); i++; }
        out.push(`<table class="notes-table"><thead><tr>${th}</tr></thead><tbody>${rows.join('')}</tbody></table>`);
        continue;
      }
      if (/^\s*[-*]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(`<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`); i++; }
        out.push(`<ul>${items.join('')}</ul>`);
        continue;
      }
      const para = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !/^\s*[-*]\s+/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) && !lines[i].includes('|')) { para.push(lines[i]); i++; }
      out.push(`<p>${inline(para.join(' '))}</p>`);
    }
    return out.join('\n');
  }

  // ---------------------------------------------------------------- patch notes
  let notesLoaded = false;
  function fmtDate(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); } catch (_) { return iso.slice(0, 10); }
  }
  async function loadNotes(bust) {
    const body = $('#notes-body');
    if (!body) return;
    body.innerHTML = '<p class="muted">Loading patch notes…</p>';
    try {
      const res = await fetch(`${API}/api/releases${bust ? '?bust=1' : ''}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // Show only the latest two releases (GitHub returns them newest-first);
      // older history lives on GitHub / in CHANGELOG.md.
      const rels = (data.releases || []).slice(0, 2);
      if (!rels.length) { body.innerHTML = '<p class="muted">No releases found.</p>'; return; }
      const stale = data.stale ? '<p class="muted notes-stale">Showing last-known notes (couldn’t reach GitHub).</p>' : '';
      body.innerHTML = stale + rels.map((r) => `
        <section class="notes-release">
          <div class="notes-release-head">
            <span class="notes-tag">${esc(r.tag || r.name)}</span>
            ${r.prerelease ? '<span class="notes-pre">pre-release</span>' : ''}
            <span class="notes-date">${esc(fmtDate(r.published_at))}</span>
            ${r.html_url ? `<a class="notes-link" href="${esc(r.html_url)}" target="_blank" rel="noopener">on GitHub ↗</a>` : ''}
          </div>
          <div class="notes-md">${r.body ? mdLite(r.body) : '<p class="muted">No notes for this release.</p>'}</div>
        </section>`).join('');
    } catch (e) {
      body.innerHTML = `<p class="muted">Couldn’t load patch notes: ${esc(e.message || e)}.</p>`;
    }
  }
  function openNotes() {
    openDrawer($('#notes-drawer'), $('#notes-overlay'));
    if (!notesLoaded) { notesLoaded = true; loadNotes(false); }
  }

  // ---------------------------------------------------------------- help registry
  // Per-tab help. Each entry: { title, intro, controls:[[label, desc]…],
  // workflow:[step…]?, note?: '…' }. Add more tabs by extending this object.
  const HELP = {
    appraisal: {
      title: 'Appraisal — Janice',
      intro: 'Paste any EVE inventory selection for an instant Janice appraisal — Buy / Split / Sell totals with 80–120% modifier chips on every figure for quick buyback math.',
      controls: [
        ['Trade hub (dropdown)', 'Which market Janice prices your paste against.'],
        ['Save a shareable Janice link (checkbox)', 'When ticked, the appraisal is saved so you get a shareable Janice URL back.'],
        ['Paste box', 'Paste copied in-game items (name then quantity, one per line). Ctrl/Cmd+Enter here runs the appraisal.'],
        ['Appraise', 'Prices the pasted text and shows Buy/Split/Sell with copyable modifier chips.'],
        ['Clear', 'Empties the paste box and removes the current result.'],
      ],
      workflow: ['Pick the trade hub', 'Paste your items', 'Click Appraise (or Ctrl/Cmd+Enter)', 'Read totals / copy the Janice link'],
    },
    sov: {
      title: 'Sovereignty dashboard',
      intro: 'ADM, sov holdings, active campaigns and live system activity for the corp’s alliance — all from public ESI, no scopes required.',
      controls: [
        ['Refresh', 'Re-fetches all sov data from ESI and repaints the dashboard.'],
        ['Sort systems (dropdown)', 'Reorders the systems table by the chosen key (appears once data has loaded).'],
      ],
      workflow: ['Click Refresh to load', 'Optionally change Sort systems to reorder'],
    },
    doctrines: {
      title: 'Doctrines & Fittings',
      intro: 'Browse the alliance’s doctrines and individual ship fits pulled from Alliance Auth.',
      controls: [
        ['Refresh doctrines', 'Fetches the current doctrine and fitting list from Alliance Auth.'],
        ['Doctrine / fit list', 'Click a doctrine to see its fits, then a fit for its modules + hull. Your mouse “back” button steps back up.'],
      ],
      note: 'Requires a signed-in Alliance Auth session — log in on the Auth tab first.',
    },
    'doctrine-stock': {
      title: 'Doctrine Stock',
      intro: 'A read-only view of current doctrine hull stock and gaps at the home structure, published by alliance admins. Green = stocked, amber = partial, red = empty.',
      controls: [
        ['NLDF (Main Alliance)', 'Shows the main alliance’s stock snapshot (default).'],
        ['NLDO (Experimental)', 'Switches to the experimental alliance’s snapshot.'],
        ['Refresh', 'Force-reloads the current alliance’s published snapshot from GitHub.'],
        ['Sort (dropdown)', 'Order hulls by biggest gap (default), ship name, or priority.'],
        ['Only show gaps (checkbox)', 'Hides fully-stocked hulls so only shortfalls remain.'],
        ['Export gap CSV', 'Downloads a CSV of every hull with a missing quantity.'],
        ['Copy shopping list', 'Copies the short hulls as a “Ship xN” multibuy list.'],
      ],
      workflow: ['Pick the alliance', 'Optionally tick Only show gaps and set the sort', 'Copy shopping list or Export gap CSV'],
    },
    readiness: {
      title: 'Market Readiness',
      intro: 'Scans every doctrine fit on Alliance Auth and cross-references it against your first configured structure’s market to show how buildable/stocked each fit is and what’s missing.',
      controls: [
        ['Scan all fits', 'Runs a full scan of every doctrine fit and rebuilds the overview (cached locally).'],
        ['Refresh market', 'Re-fetches the structure’s market and re-renders against fresh prices.'],
        ['Settings ▾', 'Shows/hides options for which fits and categories count.'],
        ['Search box', 'Filters the shown doctrines/fits by name as you type.'],
        ['✕ (clear search)', 'Clears the search and restores the full list.'],
        ['Exclude hulls from readiness check (in Settings)', 'Leaves ship hulls out of the completeness/missing-items math.'],
        ['Category chips / per-fit checkboxes (in Settings)', 'Toggle whole categories or individual fits in or out of the aggregation.'],
      ],
      workflow: ['Click Scan all fits (auto-runs on first visit)', 'Optionally open Settings to exclude hulls / toggle fits', 'Search or click a fit to see missing items; copy/download the shortfall'],
      note: 'Needs an Alliance Auth sign-in for the fit list.',
    },
    'module-sorter': {
      title: 'Doctrine Module Sorter',
      intro: 'Paste a copied EVE inventory or multibuy list; it splits every line into doctrine vs non-doctrine by matching against every fit from the Market Readiness scan, giving two ready-to-copy multibuy lists.',
      controls: [
        ['Input box', 'Paste the inventory / multibuy list. Sorting re-runs live as you edit.'],
        ['Sort', 'Parses the lines, sums duplicates, and splits into the two panes.'],
        ['Clear', 'Empties the input and resets the output panes.'],
        ['Treat doctrine hulls as non-doctrine (checkbox)', 'Moves doctrine ship hulls into the non-doctrine column.'],
        ['Doctrine / Non-doctrine panes', 'Read-only multibuy output for each side, each with Copy and Download.'],
      ],
      workflow: ['Ensure a Market Readiness scan exists (auto-runs on first open)', 'Paste your inventory', 'Read the two panes (sorts live)', 'Copy or Download either side'],
    },
    'plex-value': {
      title: 'Money → PLEX → ISK',
      intro: 'Convert real money to PLEX (bought from CCP’s store) and then to ISK at the live Jita PLEX price. Forex rates are fetched live; the PLEX→ISK price comes from Janice (or ESI).',
      controls: [
        ['Amount', 'How much real money to convert.'],
        ['Currency (dropdown)', 'Your currency; converted to USD at the live forex rate.'],
        ['PLEX price basis (dropdown)', 'Pick a CCP store pack for its real $/PLEX, or “Custom rate…” to type your own.'],
        ['USD per PLEX (custom)', 'Appears when Custom is selected — your own $/PLEX rate.'],
        ['Calculate', 'Recomputes the USD, PLEX and ISK tiles (also updates live as you type).'],
        ['↻ Refresh rates', 'Re-fetches the forex rates and the live Jita PLEX price.'],
      ],
      workflow: ['Enter an amount and pick your currency', 'Choose a CCP pack or a custom USD/PLEX rate', 'Read the USD / PLEX / ISK result tiles'],
    },
    pi: {
      title: 'Planetary Interaction Planner',
      intro: 'Search a solar system to see what its planets can extract, then rank the most profitable P0→P4 chains buildable there — priced at Jita sell with a configurable POCO tax (raw P0 treated as free).',
      controls: [
        ['Solar system search', 'Type 3+ chars for an autocomplete; pick a system to restrict to its planets, or leave blank for all.'],
        ['POCO tax %', 'Customs-office export tax subtracted from each chain’s sell value; changing it re-runs the analysis.'],
        ['P1 / P2 / P3 / P4 (checkboxes)', 'Which product tiers appear in the ranked results.'],
        ['Per unit (checkbox)', 'Off = figures per production run; on = per single unit (re-renders only).'],
        ['Analyze', 'Runs the analysis and fills the planet summary and ranked chain table.'],
        ['Result rows', 'Click a chain row for its full recipe tree and raw-P0-per-unit basket.'],
      ],
      workflow: ['(Optional) pick a solar system', 'Set POCO tax and tick the tiers', 'Click Analyze', 'Click a row for its recipe; toggle Per unit as needed'],
    },
    'pi-builder': {
      title: 'PI Colony Builder',
      intro: 'Place command centres, extractors, factories, storage and launchpads on a rotatable planet, link them, and watch the CPU/Powergrid budget. Load from and save importable templates to EVE’s PlanetaryInteractionTemplates folder.',
      controls: [
        ['New / Clear', 'New starts a fresh colony; Clear removes all pins/links but keeps the planet and CC level.'],
        ['Planet / CC Lv / Diameter', 'Planet type, command-centre level (sets CPU/PG budget), and planet diameter (sets link distances).'],
        ['Saved templates + Load', 'Pick a template found in the EVE folder and load it (prompts if you have unsaved edits).'],
        ['Chain calculator (Build ×qty)', 'Pick a commodity and quantity to see the whole production flow; every node quantity is editable and rescales live.'],
        ['Palette tools', 'Select, 🔗 Link, Command Center, Extractor, Storage, Launchpad, and factory tools — pick one, then click the planet to drop a pin.'],
        ['Planet canvas', 'Drag to rotate, scroll to zoom; click a pin to select, drag to move, click a line to select a link.'],
        ['Selection panel', 'For a pin: Link, Delete, its schematic/resource, and a Routes editor. For a link: Delete link.'],
        ['Name / Comment / Save to EVE folder', 'Name and comment the template, then write it into EVE’s templates folder for in-game import.'],
      ],
      workflow: ['Pick planet type, CC level and diameter', 'Place pins with the palette tools', 'Set factory outputs / extractor resources, link pins and add routes', 'Keep the Budget bars green', 'Name it and Save to EVE folder (or Load an existing one)'],
      note: 'Routing is finalised in-game after importing the template.',
    },
    'pi-colonies': {
      title: 'PI Colonies',
      intro: 'A live view of the planetary colonies across your authenticated characters, sorted by soonest extractor expiry, with live countdowns and background notifications when an extractor is about to run dry.',
      controls: [
        ['Refresh', 'Re-fetches live colony data from ESI and re-renders.'],
        ['⤢ Pop out', 'Opens this tab in its own window.'],
        ['Details / Hide details (per colony)', 'Expands a colony to show what it’s producing, stored contents (with Jita value), and pin breakdown.'],
        ['Open in Builder (per colony)', 'Loads that live colony’s layout into the PI Builder tab.'],
      ],
      workflow: ['Log in a PI character on the Auth tab', 'Click Refresh', 'Scan cards (soonest expiry first)', 'Expand Details or Open in Builder; restart extractors in-game as countdowns near zero'],
      note: 'Cards are colour-coded (expired / expiring <24h / active / idle); data auto-refreshes in the background.',
    },
    market: {
      title: 'Market analytics',
      intro: 'A live, sell-side-led snapshot of your first configured structure’s order book, with searchable/sortable per-item liquidity. Snapshot only (cached 5 min); a turnover panel shows net on-book change over time from daily archives.',
      controls: [
        ['Refresh market', 'Re-fetches the live snapshot (bypassing cache) and reloads turnover.'],
        ['Summary tiles / Turnover cards', 'Read-only totals and 24h/72h/7d/30d net-change from archived snapshots.'],
        ['Doctrine lens (checkbox)', 'Switches the table to doctrine-required items and shows shortfall vs your latest Readiness scan.'],
        ['Search box', 'Filters the table by item name as you type.'],
        ['Category (dropdown)', 'Filters rows to one market category.'],
        ['Min sell value / Single seller / Has buy orders', 'Sell-side filters: hide low-value items, show only single-seller items, or only items with buy orders.'],
        ['Lens status (dropdown)', 'When the lens is on: All / Missing / Short / Stocked.'],
        ['Clear', 'Resets search, category, min value and the checkboxes.'],
        ['Column headers', 'Click to sort; click again to reverse.'],
      ],
      workflow: ['Tab auto-loads the snapshot (or Refresh market)', 'Read the tiles/turnover', 'Narrow with search + filters (or Clear)', 'Sort by clicking headers', 'Flip on Doctrine lens to check stock vs your Readiness scan'],
    },
    dscan: {
      title: 'D-Scan share',
      intro: 'Paste an in-game directional scan and get a shareable dscan.info link anyone can open in a browser. A quick local breakdown by object type is shown before you share.',
      controls: [
        ['Paste box', 'Paste your D-scan (in space: open the D-Scan window, Ctrl+A then Ctrl+C). A type breakdown appears live as you paste.'],
        ['Create share link', 'Submits the scan to dscan.info and returns a shareable https://dscan.info/v/… URL.'],
        ['Clear', 'Empties the paste box, the link, and the breakdown.'],
        ['Shareable link + Copy / Open', 'The generated dscan.info URL — Copy it to the clipboard or Open it in the in-app browser.'],
      ],
      workflow: ['In space, D-scan and copy (Ctrl+A, Ctrl+C)', 'Paste it here', 'Click Create share link', 'Copy or Open the dscan.info URL to share'],
      note: 'Sharing sends the scan to the third-party dscan.info service.',
    },
    dotlan: {
      title: 'Maps',
      intro: 'A native, in-app EVE map: pan/zoom region maps with systems coloured by security and stargate links, live overlays (jumps, kills, sovereignty), a stargate route planner, and a per-system detail panel. Region layouts use Dotlan\'s familiar coordinates (© Wollari & CCP); topology and the live layers come from ESI.',
      controls: [
        ['Region picker', 'Choose which region to display. Systems from neighbouring regions appear faded at the borders — click one to jump to its region.'],
        ['Jump to system', 'Type a system name to fly straight to it (switches region and centres/selects it).'],
        ['None · Jumps · Kills · NPC · Sov', 'Overlay for the last hour: colour by security (None), ship jumps, ship+pod kills, NPC kills (rat activity), or sovereignty holder. ↻ Live refreshes them.'],
        ['Route…', 'Plan a stargate route between two systems — Shortest, prefer high-sec, or prefer low/null. The path is drawn on the map and listed in the panel.'],
        ['Pan / zoom', 'Drag to pan, scroll to zoom. Click a system for its detail panel (security, region, live jumps/kills, sov holder, connected systems).'],
      ],
      workflow: ['Pick a region (or search a system)', 'Toggle a live overlay to see jumps / kills / sovereignty', 'Click systems to inspect them, or plan a route between two systems'],
      note: 'Region layouts are © Wollari & CCP (evemaps.dotlan.net); topology & security are bundled from CCP data, and jumps/kills/sovereignty are fetched live from ESI. “Open in Dotlan ↗” opens the current region on the Dotlan website.',
    },
    zkill: {
      title: 'zKillboard',
      intro: 'A live, in-app view of zkillboard.com — the full killboard embedded in a browser panel: recent kills, character/corp/alliance/ship/system stats, campaigns, wars, trophies, inferred fits and more. Log in on the site and your session persists between visits.',
      controls: [
        ['‹ › ↻ ⌂', 'Back, Forward, Reload, and Home (zkillboard.com front page) for the embedded browser.'],
        ['Quick-links', 'Jump to zKill pages: Recent, Campaigns, Sovereignty, Wars, Trophies, Inferred Fits. Use the site\'s own ≡ menu for kill filters (solo, capitals, ganked…).'],
        ['Search box', 'Look up any pilot, corporation, alliance, ship, system or region via zKill search.'],
        ['⇱ Open in browser', 'Opens the page you are viewing in your external web browser.'],
      ],
      workflow: ['Pick a quick-link or search for a pilot/corp/ship', 'Browse zKillboard as normal inside the panel', 'Use ⌂ to return home or ⇱ to pop the current page into your browser'],
      note: 'This embeds the third-party zKillboard site (by Squizz Caphinator); its pages and ads load live from zkillboard.com.',
    },
    reactions: {
      title: 'Reaction Calculator',
      intro: 'A ravworks-style planner scoped to reactions. Pick or paste reaction products and it explodes the full multi-tier reaction chain down to raw moon goo / gas / PI, then prices the buy list + job fees against Jita. Reactions ignore ME — material savings come only from a Tatara with Reactor Efficiency rigs.',
      controls: [
        ['Reaction targets', 'One "Name xN" per line, or add from Browse. Ctrl/Cmd+Enter runs Analyze.'],
        ['Browse reactions', 'Opens a searchable catalog of every reaction recipe, grouped (Composite, Hybrid Polymers, Molecular-Forged, Biochemical, Intermediate, Unrefined). Click to add at the chosen qty.'],
        ['Structure / Reactor rig / Space', 'Presets that auto-fill the material % — Tatara + Reactor Efficiency I (2.0%) or II (2.4%), scaled ×1.0 lowsec / ×1.1 null-WH. Athanor can\'t fit the rigs (0%). The % stays editable.'],
        ['System / Cost index / Tax', 'System pulls the live reaction cost index for job fees; blank uses the flat fallback index. Tax is the facility install-fee tax.'],
        ['→ buy / → react', 'Toggle any reaction to buy the product instead (or force a bought material back to reacting); the plan re-explodes.'],
        ['Copy multibuy / Download', 'Export the raw shopping list as an in-game Multibuy list.'],
      ],
      workflow: ['Browse or paste your reaction targets', 'Set the structure/rig/space (or type a material %)', 'Add a system for live cost indices (optional)', 'Analyze → read the reactions to run + shopping list + build-vs-buy', 'Copy the multibuy list into EVE'],
      note: 'Uses the same engine as the Production Planner, restricted to reactions. Pricing is best-effort via Janice (set a key in Config for best prices).',
    },
    assets: {
      title: 'My Assets',
      intro: 'See, search and filter your characters\' assets (from ESI). Pick a single toon — mains and PI toons both appear — or tick "All connected toons" to search across everyone. Item locations resolve to station / structure names using the same resolver as the buyback tabs.',
      controls: [
        ['Toon dropdown', 'Choose which authenticated character to show. Toons that still need the read-assets permission are marked "needs re-auth".'],
        ['All connected toons', 'Aggregate assets across every connected character (mains + PI + fitting slots).'],
        ['Search / Location filter', 'Filter the list by item name and by station/structure.'],
        ['Group by location', 'Collapse the list into per-station/structure groups with item and unit counts.'],
        ['Load assets', 'Fetch from ESI. Assets are aggregated by item type and location.'],
      ],
      workflow: ['Re-authenticate your toons (Auth tab) to grant read-assets', 'Pick a toon or tick All connected toons', 'Load assets', 'Search / filter / group as needed'],
      note: 'Needs the esi-assets.read_assets.v1 scope on each character (enable it in your EVE developer app, then re-auth). The reactions Auto-detect button reuses this data.',
    },
  };

  function activeTabId() {
    const s = document.querySelector('.tab.active');
    return s ? s.id.replace(/^tab-/, '') : null;
  }
  function tabLabel(id) {
    const b = document.querySelector(`.tab-btn[data-tab="${id}"]`);
    return b ? b.textContent.trim() : (id || '');
  }
  function renderHelp() {
    const titleEl = $('#help-title');
    const body = $('#help-body');
    if (!body) return;
    const id = activeTabId();
    const h = id && HELP[id];
    if (!h) {
      if (titleEl) titleEl.textContent = 'Help';
      body.innerHTML = `<p class="muted">Help for the <strong>${esc(tabLabel(id) || 'current')}</strong> page hasn’t been written yet.</p>
        <p class="muted">Documented so far: the General section (Appraisal, Sov, Doctrines, Doctrine Stock, Market Readiness, Module Sorter, PLEX Value, PI Planner/Builder/Colonies, Market). More tabs are on the way.</p>`;
      return;
    }
    if (titleEl) titleEl.textContent = h.title;
    const controls = (h.controls || []).map(([label, desc]) =>
      `<li><span class="help-ctl">${esc(label)}</span><span class="help-desc">${esc(desc)}</span></li>`).join('');
    const workflow = (h.workflow && h.workflow.length)
      ? `<h4>How to use it</h4><ol class="help-flow">${h.workflow.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : '';
    const note = h.note ? `<p class="help-note">💡 ${esc(h.note)}</p>` : '';
    body.innerHTML = `
      <p class="help-intro">${esc(h.intro)}</p>
      ${controls ? `<h4>Controls</h4><ul class="help-controls">${controls}</ul>` : ''}
      ${workflow}
      ${note}`;
  }
  function openHelp() {
    renderHelp();
    openDrawer($('#help-drawer'), $('#help-overlay'));
  }

  // ---------------------------------------------------------------- wiring
  function init() {
    $('#btn-patch-notes')?.addEventListener('click', openNotes);
    $('#btn-help')?.addEventListener('click', openHelp);
    $('#notes-close')?.addEventListener('click', () => hideDrawer($('#notes-drawer')));
    $('#help-close')?.addEventListener('click', () => hideDrawer($('#help-drawer')));
    $('#notes-overlay')?.addEventListener('click', () => hideDrawer($('#notes-drawer')));
    $('#help-overlay')?.addEventListener('click', () => hideDrawer($('#help-drawer')));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && anyOpen()) anyOpen().id === 'help-drawer' ? hideDrawer($('#help-drawer')) : hideDrawer($('#notes-drawer')); });
    // Help follows the active tab: if it's open when you switch tabs, re-render.
    document.querySelectorAll('.tab-btn').forEach((b) => b.addEventListener('click', () => {
      if ($('#help-drawer')?.classList.contains('open')) setTimeout(renderHelp, 0);
    }));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
