'use strict';

// ================= SMT Intel Map =================
// An SMT-styled region map (separate from the Maps tab) with two live layers:
//  · Intel — read from your local EVE chat-logs by the sidecar and matched to
//    systems (matcher ported from Slazanger's SMT); systems glow red and decay.
//  · Kills — a live zKillboard (RedisQ) feed marking systems with recent kills.
// Reuses the bundled /api/map/* topology for the map; /api/smt/* for the layers.

(function () {
  const SVGNS = 'http://www.w3.org/2000/svg';
  const DECAY = 10 * 60 * 1000;   // intel/kill markers fully fade after 10 min
  const st = {
    region: null, layout: null, index: null, byName: null, nodeEls: new Map(),
    intel: new Map(), kills: new Map(), feed: [],
    chars: [], fleet: null, fleetMembers: [], bridges: [], thera: [], sov: null, route: null,
    intelSince: 0, killSince: 0, ov: { intel: true, kills: true, chars: true, sov: false, jumprange: false },
    follow: true, loaded: false, poll: null, tick: null, charPoll: null,
    alertJumps: new Map(), alertKey: null, alertsOwned: false, loopsOn: false,
    focusId: null, centred: false,
    watch: [], killLog: [], popId: null, needFit: false,
    jump: { ship: 'blops', skill: 5, data: null }, jumpShips: null,
    view: { s: 1, tx: 0, ty: 0 },
  };
  const $id = (x) => document.getElementById(x);

  // ---- remembered view ----
  // Where you left the map, per machine — same localStorage habit the rest of
  // the renderer uses for view preferences. Deliberately *not* in the sidecar:
  // it's cosmetic and per-screen, unlike the watchlist and the alarm rules,
  // which every window has to agree on.
  //
  // The character still wins the opening view (see maybeCentre): the saved
  // region is only the fallback for "no character fix at all", and a saved
  // pan/zoom is only re-applied when we land in the region it was taken in.
  const VIEW_KEY = 'smt.view';
  const PANEL_IDS = ['smt-route-bar', 'smt-bridges-bar', 'smt-thera-bar', 'smt-sov-bar', 'smt-alerts-bar', 'smt-watch-bar', 'smt-config'];
  function loadView() {
    try { return JSON.parse(localStorage.getItem(VIEW_KEY) || 'null') || {}; } catch (_) { return {}; }
  }
  // Patches accumulate into one pending object. Merging against the *stored*
  // value on every call instead would lose everything but the last patch of a
  // burst — toggling a layer and opening a panel in the same breath is a burst.
  let viewSaveT = null, viewPending = null;
  function saveView(patch) {
    viewPending = { ...(viewPending || loadView()), ...(patch || {}) };
    clearTimeout(viewSaveT);
    viewSaveT = setTimeout(() => {
      const next = viewPending;
      viewPending = null;
      try { localStorage.setItem(VIEW_KEY, JSON.stringify(next)); } catch (_) { /* private mode, quota — not worth surfacing */ }
    }, 250);
  }
  const saveTransform = () => saveView({ region: st.region, view: { ...st.view } });
  const savePanels = () => saveView({ panels: PANEL_IDS.filter((id) => { const el = $id(id); return el && !el.hidden; }) });
  const esc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(s) : String(s == null ? '' : s));

  function secCol(sec) {
    if (sec == null) return '#6f1a1a';
    if (sec >= 0.85) return '#3d9be0'; if (sec >= 0.65) return '#48d84a';
    if (sec >= 0.45) return '#e5e52f'; if (sec >= 0.25) return '#e88a26';
    if (sec > 0) return '#d63a1e'; return '#8b1a1a';
  }
  async function j(path, opts) {
    const r = await fetch(`${API}${path}`, opts);
    if (!r.ok) { let d = `HTTP ${r.status}`; try { d = (await r.json()).detail || d; } catch (_) {} throw new Error(d); }
    return r.json();
  }
  function setStatus(m, err) { const s = $id('smt-status'); if (s) { s.textContent = m || ''; s.classList.toggle('smt-err', !!err); } }

  // ---- map data ----
  async function loadRegions() {
    const sel = $id('smt-region'); if (!sel || sel.options.length) return;
    const d = await j('/api/map/regions');
    sel.innerHTML = d.regions.map((r) => `<option value="${esc(r.name)}">${esc(r.name)} (${r.count})</option>`).join('');
    // Only a starting value for the picker — never override a region we've
    // already navigated to (e.g. the one our character is in).
    const want = loadView().region;
    if (!st.region && want && [...sel.options].some((o) => o.value === want)) sel.value = want;
    else if (!st.region && [...sel.options].some((o) => o.value === 'Delve')) sel.value = 'Delve';
  }
  async function loadIndex() {
    if (st.index) return;
    const d = await j('/api/map/systems');
    st.index = d.systems;
    st.byName = new Map(d.systems.map((s) => [s.name.toLowerCase(), s]));
    st.byId = new Map(d.systems.map((s) => [String(s.id), s]));
    const dl = $id('smt-syslist'); if (dl) dl.innerHTML = d.systems.map((s) => `<option value="${esc(s.name)}">`).join('');
  }
  async function showRegion(name, focusId) {
    if (!name) return;
    const sel = $id('smt-region'); if (sel && sel.value !== name) sel.value = name;
    setStatus(`Loading ${name}…`);
    try {
      st.layout = await j(`/api/map/region/${encodeURIComponent(name)}`);
      st.region = name;
      renderMap();
      restoreView(name, focusId);
      applyLayers();
      renderCharMarkers();
      renderBridges();
      renderTheraOnMap();
      applySov();
      applyActivity();
      applyJumpRange();
      renderRoute();
      setStatus('');
      if (focusId) centerOn(focusId);
      saveView({ region: name });
    } catch (e) { setStatus(`Failed to load ${name}: ${e.message || e}`, true); }
  }

  function renderMap() {
    const root = $id('smt-root'); if (!root || !st.layout) return;
    const sys = st.layout.systems;
    const byId = new Map(sys.map((s) => [String(s.id), s]));
    let edges = '';
    for (const [a, b] of st.layout.edges) {
      const s = byId.get(String(a)), d = byId.get(String(b));
      if (s && d) edges += `<line class="sm-e" x1="${s.x}" y1="${s.y}" x2="${d.x}" y2="${d.y}" />`;
    }
    let cells = '';
    for (const s of sys) {
      cells += `<g class="sm-n${s.home ? '' : ' sm-foreign'}" data-id="${s.id}" transform="translate(${s.x},${s.y})">`
        + `<circle class="sm-halo" r="0" />`
        + `<circle class="sm-dot" r="4.5" style="fill:${secCol(s.sec)}" />`
        + `<text class="sm-t" x="8" y="3">${esc(s.name)}</text>`
        + `</g>`;
    }
    root.innerHTML = `<g class="sm-elayer">${edges}</g><g class="sm-nlayer">${cells}</g>`;
    st.nodeEls = new Map();
    root.querySelectorAll('.sm-n').forEach((el) => st.nodeEls.set(el.dataset.id, el));
    markWatched();
  }

  function bounds() {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const s of st.layout.systems) { a = Math.min(a, s.x); b = Math.min(b, s.y); c = Math.max(c, s.x); d = Math.max(d, s.y); }
    return { minX: a - 60, minY: b - 40, maxX: c + 60, maxY: d + 40 };
  }
  function fitView() {
    const cv = $id('smt-canvas'); if (!cv || !st.layout) return;
    const cw = cv.clientWidth || 800, ch = cv.clientHeight || 600, bb = bounds();
    const w = Math.max(1, bb.maxX - bb.minX), h = Math.max(1, bb.maxY - bb.minY);
    st.view.s = Math.min(cw / w, ch / h) * 0.95;
    st.view.tx = (cw - w * st.view.s) / 2 - bb.minX * st.view.s;
    st.view.ty = (ch - h * st.view.s) / 2 - bb.minY * st.view.s;
    applyTransform();
  }
  function restoreView(name, focusId) {
    const v = loadView();
    if (!focusId && v.region === name && v.view && Number.isFinite(v.view.s) && v.view.s > 0) {
      st.view = { s: v.view.s, tx: Number(v.view.tx) || 0, ty: Number(v.view.ty) || 0 };
      applyTransform();
      return;
    }
    fitView();
  }
  function applyTransform() { const r = $id('smt-root'); if (r) r.setAttribute('transform', `translate(${st.view.tx},${st.view.ty}) scale(${st.view.s})`); }
  function centerOn(id) {
    const s = (st.layout.systems || []).find((x) => String(x.id) === String(id)); const cv = $id('smt-canvas');
    if (!s || !cv) return;
    st.view.s = Math.max(st.view.s, 1.2);
    st.view.tx = cv.clientWidth / 2 - s.x * st.view.s; st.view.ty = cv.clientHeight / 2 - s.y * st.view.s;
    applyTransform();
  }

  // ---- live layers ----
  async function pollLayers() {
    try {
      if (st.ov.intel) {
        const d = await j(`/api/smt/intel?since=${st.intelSince}`);
        st.intelSince = d.ts;
        for (const e of d.events) {
          for (const sid of e.systems) {
            const cur = st.intel.get(String(sid)) || { ts: 0, clear: false };
            st.intel.set(String(sid), { ts: e.ts * 1000, clear: e.clear });
          }
          st.feed.unshift(e);
        }
        if (st.feed.length > 200) st.feed.length = 200;
        if (!st.alertsOwned) SmtAlerts.intel(d.events, st.alertJumps);
        if (d.events.length) { renderFeed(); if (st.follow) followLatest(); }
        setStatus(d.watching ? '' : (d.log_dir_ok ? 'No intel channels selected — open ⚙ Select Intel Channels.' : 'Set your EVE chat-logs folder in ⚙ Select Intel Channels to see intel.'));
      }
      if (st.ov.kills) {
        const d = await j(`/api/smt/kills?since=${st.killSince}`);
        st.killSince = d.ts;
        for (const k of d.kills) st.kills.set(String(k.system_id), { ts: k.ts * 1000, value: k.value });
        if (d.kills.length) {
          st.killLog.unshift(...d.kills);
          if (st.killLog.length > 600) st.killLog.length = 600;
        }
        if (!st.alertsOwned) SmtAlerts.kills(d.kills, st.alertJumps);
      }
    } catch (_) { /* transient */ }
    applyLayers();
  }

  function applyLayers() {
    const now = Date.now();
    st.nodeEls.forEach((el, id) => {
      const halo = el.querySelector('.sm-halo');
      const iv = st.ov.intel ? st.intel.get(id) : null;
      const kv = st.ov.kills ? st.kills.get(id) : null;
      let r = 0, fill = 'transparent', op = 0, cls = '';
      if (iv) {
        const age = now - iv.ts; const t = Math.max(0, 1 - age / DECAY);
        if (t > 0) { r = 8 + t * 12; op = 0.15 + t * 0.55; fill = iv.clear ? '#3ad07a' : '#ff3b3b'; cls = iv.clear ? 'sm-clear' : 'sm-intel'; }
      }
      if (!iv && kv) {
        const age = now - kv.ts; const t = Math.max(0, 1 - age / DECAY);
        if (t > 0) { r = 7 + t * 8; op = 0.12 + t * 0.4; fill = '#f0a020'; cls = 'sm-kill'; }
      }
      halo.setAttribute('r', r.toFixed(1));
      halo.style.fill = fill; halo.style.fillOpacity = op;
      el.classList.toggle('sm-hot', r > 0);
    });
  }

  // ---- characters + fleet ----
  async function pollChars() {
    if (!st.ov.chars && !alarmArmed()) { renderCharChips(); renderCharMarkers(); return; }
    try {
      const d = await j('/api/smt/characters');
      st.chars = d.characters || []; st.fleet = d.fleet; st.fleetMembers = d.fleet_members || [];
      st.charsAuthed = d.authed;
      // Follow the first online character unless the user has picked someone.
      if (!st.chars.some((c) => String(c.character_id) === String(st.focusId))) {
        const pick = st.chars.find((c) => c.online && c.system_id) || st.chars.find((c) => c.system_id);
        st.focusId = pick ? pick.character_id : null;
      }
      maybeCentre();
      renderCharChips(); renderCharMarkers();
      refreshAlertRange();
    } catch (_) { /* transient */ }
  }
  // First fix on a character wins the opening view — far more useful than
  // dumping everyone in a fixed default region. Only once the map index exists,
  // and only until the user (or a fallback) has settled the view.
  function maybeCentre() {
    if (st.centred || !st.index || !st.focusId) return;
    const c = st.chars.find((x) => String(x.character_id) === String(st.focusId));
    if (!c || !c.region || !c.system_id) return;
    st.centred = true;
    showRegion(c.region, c.system_id);
  }
  function renderCharChips() {
    const box = $id('smt-chars'); if (!box) return;
    if (!st.ov.chars) { box.innerHTML = ''; return; }
    if (!st.chars.length) {
      box.innerHTML = st.charsAuthed ? '<span class="muted small">SMT characters authed but no location yet (offline, or the location scope isn’t enabled in your EVE app).</span>'
        : '<span class="muted small">No SMT characters — add them in Auth → SMT Characters to plot them here.</span>';
      return;
    }
    const portrait = (c, size) => (c.character_id
      ? `<img class="smt-char-pic" loading="lazy" src="https://images.evetech.net/characters/${c.character_id}/portrait?size=${size}" alt="" onerror="this.style.visibility='hidden'">`
      : '');
    const chip = (c) => `<button class="smt-char-chip${c.online ? ' on' : ''}${c.region === st.region ? ' here' : ''}${String(c.character_id) === String(st.focusId) ? ' focused' : ''}" data-region="${esc(c.region || '')}" data-id="${c.system_id || ''}" data-char="${esc(c.character_id || '')}" title="${esc([c.ship_type_name, c.docked ? 'docked' : '', c.error || ''].filter(Boolean).join(' · '))}">
      <span class="smt-char-dot"></span>${portrait(c, 32)}${esc(c.name || c.slot)} <span class="muted">${esc(c.system_name || '—')}</span></button>`;
    box.innerHTML = st.chars.map(chip).join('') + (st.fleet ? `<span class="smt-fleet-tag" title="You're in a fleet of ${st.fleet.size}">⛴ fleet ${st.fleet.size}</span>` : '');
    // Whoever the map is following, called out plainly with their portrait.
    const f = $id('smt-focus');
    if (f) {
      const c = st.chars.find((x) => String(x.character_id) === String(st.focusId));
      f.classList.toggle('on', !!c);
      f.innerHTML = c ? `${portrait(c, 64)}<strong>${esc(c.name || c.slot)}</strong>
        <span class="sys">${esc(c.system_name || '—')}</span>${c.region ? `<span class="muted">${esc(c.region)}</span>` : ''}` : '';
      f.title = c ? 'The character the Intel Map is following — click a chip to follow another' : '';
    }
  }
  function renderCharMarkers() {
    const root = $id('smt-root'); if (!root) return;
    root.querySelectorAll('.smt-clayer').forEach((e) => e.remove());
    if (!st.ov.chars || !st.layout) return;
    const byId = new Map(st.layout.systems.map((s) => [String(s.id), s]));
    const layer = document.createElementNS(SVGNS, 'g'); layer.setAttribute('class', 'smt-clayer');
    const place = (sid, label, cls) => {
      const s = byId.get(String(sid)); if (!s) return;
      const g = document.createElementNS(SVGNS, 'g'); g.setAttribute('class', 'smt-char ' + cls);
      g.setAttribute('transform', `translate(${s.x},${s.y})`);
      // Sit the name pill above the dot rather than beside it: the system's own
      // label runs to the right of the dot, and a pill there hides it.
      const w = 9 + label.length * 5.6;
      g.innerHTML = `<circle class="smt-char-mk" r="6" />`
        + `<rect class="smt-char-pill" x="${(-w / 2).toFixed(1)}" y="-21" rx="3" ry="3" height="13" width="${w.toFixed(1)}" />`
        + `<text class="smt-char-lbl" x="0" y="-11.5">${esc(label)}</text>`;
      layer.appendChild(g);
    };
    const bySys = {};
    for (const c of st.chars) if (c.system_id && c.region === st.region) (bySys[c.system_id] = bySys[c.system_id] || []).push(c);
    for (const sid in bySys) {
      const l = bySys[sid];
      const cls = (l.some((c) => c.online) ? 'online' : 'offline')
        + (l.some((c) => String(c.character_id) === String(st.focusId)) ? ' focused' : '');
      place(sid, l.map((c) => c.name).join(', '), cls);
    }
    const fleetBySys = {};
    for (const m of st.fleetMembers) if (m.system_id && m.region === st.region) (fleetBySys[m.system_id] = fleetBySys[m.system_id] || []).push(m);
    for (const sid in fleetBySys) { const l = fleetBySys[sid]; place(sid, l.length > 2 ? `${l.length} fleet` : l.map((m) => m.name || 'fleet').join(', '), 'fleet'); }
    root.appendChild(layer);
  }

  function followLatest() {
    const latest = st.feed.find((e) => e.systems && e.systems.length);
    if (!latest) return;
    const sid = latest.systems[0];
    const sys = st.byId && st.byId.get(String(sid));
    if (sys && sys.region && sys.region !== st.region) showRegion(sys.region, sid);
    else centerOn(sid);
  }

  function renderFeed() {
    const list = $id('smt-feed-list'); const cnt = $id('smt-feed-count');
    if (!list) return;
    if (cnt) cnt.textContent = st.feed.length ? `(${st.feed.length})` : '';
    if (!st.feed.length) { list.innerHTML = '<p class="muted small">No intel yet. Configure your chat-logs folder and channels in ⚙ Select Intel Channels.</p>'; return; }
    list.innerHTML = st.feed.slice(0, 120).map((e) => {
      const t = new Date(e.ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      // System names and ship names are picked out inside the line itself, so
      // the chip row is only worth keeping when a report names more than one
      // system (its job then is the summary, not the detail).
      const names = e.system_names || [];
      const syss = names.length > 1
        ? names.slice(0, 4).map((n, i) => `<button class="smt-feed-sys" data-id="${e.systems[i]}">${esc(n)}</button>`).join('')
        : '';
      return `<div class="smt-feed-row${e.clear ? ' smt-feed-clear' : ''}">
        <span class="smt-feed-t muted">${t}</span>
        <span class="smt-feed-ch muted">${esc(e.channel)}</span>
        ${SmtHighlight.speaker(e.speaker)}
        ${syss ? `<span class="smt-feed-syss">${syss}</span>` : ''}
        <span class="smt-feed-txt">${SmtHighlight.line(e.text, e.spans)}</span></div>`;
    }).join('');
  }

  // ---- jump bridges ----
  const resolveSys = (name) => st.byName && st.byName.get((name || '').trim().toLowerCase());
  async function loadBridges() {
    try { const d = await j('/api/smt/bridges'); st.bridges = d.bridges || []; renderBridgeList(); renderBridges(); } catch (_) {}
  }
  async function saveBridges() {
    const d = await j('/api/smt/bridges', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pairs: st.bridges.map((b) => [b.from.id, b.to.id]) }) });
    st.bridges = d.bridges || []; renderBridgeList(); renderBridges();
  }
  async function addBridge() {
    const f = resolveSys($id('smt-bridge-from')?.value), t = resolveSys($id('smt-bridge-to')?.value), s = $id('smt-bridge-status');
    if (!f || !t) { if (s) s.textContent = 'Enter two valid systems.'; return; }
    st.bridges.push({ from: { id: f.id, name: f.name, region: f.region }, to: { id: t.id, name: t.name, region: t.region } });
    if ($id('smt-bridge-from')) $id('smt-bridge-from').value = ''; if ($id('smt-bridge-to')) $id('smt-bridge-to').value = '';
    try { await saveBridges(); if (s) s.textContent = `${st.bridges.length} bridge(s)`; } catch (e) { if (s) s.textContent = 'Save failed'; }
  }
  async function pasteBridges() {
    const box = $id('smt-bridge-pastebox'), s = $id('smt-bridge-status'); let added = 0;
    for (const line of (box?.value || '').split('\n')) {
      const found = [];
      for (const tok of line.split(/[^0-9A-Za-z-]+/)) { const sys = resolveSys(tok); if (sys && !found.some((x) => x.id === sys.id)) { found.push(sys); if (found.length === 2) break; } }
      if (found.length === 2) { st.bridges.push({ from: { id: found[0].id, name: found[0].name, region: found[0].region }, to: { id: found[1].id, name: found[1].name, region: found[1].region } }); added++; }
    }
    if (added) { try { await saveBridges(); if (box) { box.value = ''; box.hidden = true; } } catch (_) {} }
    if (s) s.textContent = `Added ${added} · ${st.bridges.length} total`;
  }
  function renderBridgeList() {
    const box = $id('smt-bridge-list'); if (!box) return;
    if (!st.bridges.length) { box.innerHTML = '<span class="muted small">No jump bridges yet. Add a pair above, or paste a list.</span>'; return; }
    box.innerHTML = st.bridges.map((b, i) => `<div class="smt-bridge-row"><button class="smt-bridge-jump" data-region="${esc(b.from.region || '')}" data-id="${b.from.id}">${esc(b.from.name)}</button> ⇄ <button class="smt-bridge-jump" data-region="${esc(b.to.region || '')}" data-id="${b.to.id}">${esc(b.to.name)}</button> <button class="smt-bridge-del linklike" data-i="${i}" title="Remove">✕</button></div>`).join('');
  }
  function renderBridges() {
    const root = $id('smt-root'); if (!root) return;
    root.querySelectorAll('.smt-blayer').forEach((e) => e.remove());
    if (!st.layout) return;
    const byId = new Map(st.layout.systems.map((s) => [String(s.id), s]));
    const layer = document.createElementNS(SVGNS, 'g'); layer.setAttribute('class', 'smt-blayer');
    for (const b of st.bridges) {
      const s = byId.get(String(b.from.id)), d = byId.get(String(b.to.id));
      if (s && d) { const ln = document.createElementNS(SVGNS, 'line'); ln.setAttribute('class', 'sm-bridge'); ln.setAttribute('x1', s.x); ln.setAttribute('y1', s.y); ln.setAttribute('x2', d.x); ln.setAttribute('y2', d.y); layer.appendChild(ln); }
      else if (s || d) { const n = s || d, other = s ? b.to : b.from; const g = document.createElementNS(SVGNS, 'g'); g.setAttribute('class', 'sm-bridge-stub'); g.setAttribute('transform', `translate(${n.x},${n.y})`); g.innerHTML = `<circle r="9" class="sm-bridge-ring" /><text class="sm-bridge-lbl" x="11" y="13">⇄ ${esc(other.name || '')}</text>`; layer.appendChild(g); }
    }
    root.appendChild(layer);
  }

  // ---- routing (bridge-aware) ----
  async function runRoute() {
    const from = ($id('smt-route-from')?.value || '').trim(), to = ($id('smt-route-to')?.value || '').trim();
    const pref = $id('smt-route-pref')?.value || 'shortest', info = $id('smt-route-info');
    const wh = $id('smt-route-wh')?.checked ? 1 : 0;
    if (!from || !to) { if (info) info.textContent = 'Enter both systems.'; return; }
    if (info) info.textContent = 'Routing…';
    try {
      const r = await j(`/api/smt/route?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&prefer=${pref}&wh=${wh}`);
      if (r.error) { if (info) info.textContent = r.error; st.route = null; renderRoute(); return; }
      st.route = r.systems;
      const bridgeHops = (r.systems || []).filter((s) => s.via === 'bridge').length;
      const extra = [bridgeHops ? `${bridgeHops} bridge` : '', r.wh_hops ? `${r.wh_hops} WH` : ''].filter(Boolean).join(' · ');
      if (info) info.textContent = `${r.jumps} jump${r.jumps === 1 ? '' : 's'}${extra ? ` · ${extra}` : ''}`;
      const start = r.systems[0];
      if (start && start.region && start.region !== st.region) await showRegion(start.region, start.id);
      else renderRoute();
      if (start) centerOn(start.id);
    } catch (e) { if (info) info.textContent = `Route failed: ${e.message || e}`; }
  }
  function clearRoute() { st.route = null; renderRoute(); const i = $id('smt-route-info'); if (i) i.textContent = ''; ['smt-route-from', 'smt-route-to'].forEach((id) => { const e = $id(id); if (e) e.value = ''; }); }
  function renderRoute() {
    const root = $id('smt-root'); if (!root) return;
    root.querySelectorAll('.smt-rlayer').forEach((e) => e.remove());
    st.nodeEls.forEach((el) => el.classList.remove('sm-on-route'));
    if (!st.route || !st.layout) return;
    const byId = new Map(st.layout.systems.map((s) => [String(s.id), s]));
    const layer = document.createElementNS(SVGNS, 'g'); layer.setAttribute('class', 'smt-rlayer');
    for (let i = 0; i < st.route.length - 1; i++) {
      const a = byId.get(String(st.route[i].id)), b = byId.get(String(st.route[i + 1].id));
      if (a && b) { const via = st.route[i + 1].via; const cls = via === 'thera' || via === 'turnur' ? ' sm-route-wh' : (via === 'bridge' ? ' sm-route-bridge' : ''); const ln = document.createElementNS(SVGNS, 'line'); ln.setAttribute('class', 'sm-route' + cls); ln.setAttribute('x1', a.x); ln.setAttribute('y1', a.y); ln.setAttribute('x2', b.x); ln.setAttribute('y2', b.y); layer.appendChild(ln); }
    }
    root.appendChild(layer);
    const set = new Set(st.route.map((s) => String(s.id)));
    st.nodeEls.forEach((el, id) => el.classList.toggle('sm-on-route', set.has(id)));
  }

  // ---- Thera / Turnur connections (eve-scout) ----
  async function loadThera() {
    try {
      const d = await j('/api/smt/thera');
      st.thera = d.connections || [];
      renderTheraList(d.error, d.ts);
      renderTheraOnMap();
    } catch (_) { /* transient */ }
  }
  function renderTheraList(err, ts) {
    const box = $id('smt-thera-list'), stt = $id('smt-thera-status');
    if (stt) stt.textContent = err ? `— ${err}` : (st.thera.length ? `· ${st.thera.length} connection(s)${ts ? ' · ' + new Date(ts * 1000).toLocaleTimeString() : ''}` : '');
    if (!box) return;
    if (!st.thera.length) { box.innerHTML = '<span class="muted small">No connections right now (or eve-scout unreachable).</span>'; return; }
    box.innerHTML = st.thera.map((c) => `<div class="smt-thera-row">
      <span class="smt-thera-hub ${c.hub === 'Thera' ? 'is-thera' : 'is-turnur'}">${esc(c.hub)}</span> →
      <button class="smt-thera-sys" data-region="${esc(c.region || '')}" data-id="${c.system_id}">${esc(c.system)}</button>
      <span class="muted">${esc(c.region || '')} · ${esc(c.wh_type || '')} · ${esc(c.max_ship_size || '')} · ${c.remaining_hours != null ? c.remaining_hours + 'h' : '?'}</span></div>`).join('');
  }
  function renderTheraOnMap() {
    const root = $id('smt-root'); if (!root) return;
    root.querySelectorAll('.smt-tlayer').forEach((e) => e.remove());
    if (!st.layout || !st.thera.length) return;
    const byId = new Map(st.layout.systems.map((s) => [String(s.id), s]));
    const layer = document.createElementNS(SVGNS, 'g'); layer.setAttribute('class', 'smt-tlayer');
    for (const c of st.thera) {
      const n = byId.get(String(c.system_id)); if (!n) continue;
      const g = document.createElementNS(SVGNS, 'g'); g.setAttribute('class', 'sm-thera ' + (c.hub === 'Thera' ? 'is-thera' : 'is-turnur'));
      g.setAttribute('transform', `translate(${n.x},${n.y})`);
      g.innerHTML = `<circle r="8" class="sm-thera-ring" /><text class="sm-thera-lbl" x="10" y="-6">⨀ ${esc(c.hub)}</text>`;
      layer.appendChild(g);
    }
    root.appendChild(layer);
  }

  // ---- sovereignty (holders + ADM + campaigns + FW) ----
  function alliCol(id) { let h = 0; const s = String(id); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffff; return `hsl(${h % 360} 55% 45%)`; }
  function fmtDur(ms) { let s = Math.floor(ms / 1000); const d = Math.floor(s / 86400); s -= d * 86400; const h = Math.floor(s / 3600); s -= h * 3600; const m = Math.floor(s / 60); const p = []; if (d) p.push(d + 'd'); if (h || d) p.push(h + 'h'); p.push(m + 'm'); return p.join(' '); }
  async function loadSov() { try { st.sov = await j('/api/smt/sov'); renderSovPanel(); applySov(); } catch (_) { /* transient */ } }
  function applySov() {
    const root = $id('smt-root'); if (!root) return;
    root.querySelectorAll('.smt-sovlayer').forEach((e) => e.remove());
    const sov = st.sov || {};
    st.nodeEls.forEach((el, id) => {
      const dot = el.querySelector('.sm-dot'); if (!dot) return;
      const sec = el.dataset.sec === '' ? null : parseFloat(el.dataset.sec);
      if (!st.ov.sov) { dot.style.fill = secCol(sec); return; }
      const h = (sov.holders || {})[id], fw = (sov.fw || {})[id];
      if (h && h.alliance_id) dot.style.fill = alliCol(h.alliance_id);
      else if (fw) dot.style.fill = '#c05a2f';
      else dot.style.fill = secCol(sec);
    });
    if (!st.ov.sov || !st.layout) return;
    const byId = new Map(st.layout.systems.map((s) => [String(s.id), s]));
    const layer = document.createElementNS(SVGNS, 'g'); layer.setAttribute('class', 'smt-sovlayer');
    for (const [sid, adm] of Object.entries(sov.adm || {})) {
      const s = byId.get(sid); if (!s) continue;
      const t = document.createElementNS(SVGNS, 'text'); t.setAttribute('class', `sm-adm${adm < 3 ? ' low' : adm >= 5 ? ' high' : ''}`); t.setAttribute('x', s.x); t.setAttribute('y', s.y + 14); t.setAttribute('text-anchor', 'middle'); t.textContent = Math.round(adm); layer.appendChild(t);
    }
    for (const c of (sov.campaigns || [])) {
      const s = byId.get(String(c.system_id)); if (!s) continue;
      const ring = document.createElementNS(SVGNS, 'circle'); ring.setAttribute('class', 'sm-camp'); ring.setAttribute('cx', s.x); ring.setAttribute('cy', s.y); ring.setAttribute('r', '10'); layer.appendChild(ring);
    }
    root.appendChild(layer);
  }
  function renderSovPanel() {
    const box = $id('smt-sov-list'), stt = $id('smt-sov-status'); const sov = st.sov || {};
    const cams = sov.campaigns || [], fwn = Object.keys(sov.fw || {}).length;
    if (stt) stt.textContent = `· ${cams.length} campaign(s) · ${fwn} FW contested`;
    if (!box) return;
    if (!cams.length) { box.innerHTML = '<span class="muted small">No active sov campaigns right now.</span>'; return; }
    const EV = { ihub_defense: 'IHUB', tcu_defense: 'TCU', station_defense: 'Station', station_freeport: 'Freeport' };
    box.innerHTML = cams.map((c) => `<div class="smt-sov-row">
      <span class="smt-camp-ev">${esc(EV[c.event_type] || c.event_type || '')}</span>
      <button class="smt-thera-sys" data-region="${esc(c.region || '')}" data-id="${c.system_id}">${esc(c.system || c.system_id)}</button>
      <span class="muted">${esc(c.region || '')} · def ${esc(c.defender || '?')} ${Math.round((c.defender_score || 0) * 100)}%</span>
      <span class="smt-camp-t" data-start="${esc(c.start_time || '')}"></span></div>`).join('');
    tickSov();
  }
  function tickSov() {
    document.querySelectorAll('#smt-sov-list .smt-camp-t').forEach((el) => {
      const iso = el.dataset.start; if (!iso) { el.textContent = ''; return; }
      const ms = new Date(iso).getTime() - Date.now();
      el.textContent = ms > 0 ? `starts in ${fmtDur(ms)}` : `live ${fmtDur(-ms)}`;
      el.classList.toggle('live', ms <= 0);
    });
  }

  // ---- intel alarm ----
  // Settings live in the sidecar so this tab and the overlay window agree. The
  // overlay takes ownership while it's open, so a report never alarms twice.
  async function loadAlerts() {
    try { SmtAlerts.setConfig(await j('/api/smt/alerts')); } catch (_) { /* defaults stand */ }
    renderAlerts();
  }
  const soundOpts = (sel) => SmtAlerts.sounds.map((n) => `<option value="${n}"${n === sel ? ' selected' : ''}>${n}</option>`).join('');
  function renderAlerts() {
    const a = SmtAlerts.config();
    for (const [id, val] of [['smt-al-clear-sound', a.clear_sound], ['smt-al-kill-sound', a.kill_sound]]) {
      const el = $id(id); if (!el) continue;
      el.innerHTML = soundOpts(val);
    }
    const set = (id, prop, v) => { const el = $id(id); if (el) el[prop] = v; };
    set('smt-al-enabled', 'checked', !!a.enabled);
    set('smt-al-hostile', 'checked', !!a.hostile);
    set('smt-al-clear', 'checked', !!a.clear);
    set('smt-al-kills', 'checked', !!a.kills);
    set('smt-al-gap', 'value', a.gap);
    set('smt-al-vol', 'value', a.volume);
    renderTiers();
    const el = $id('smt-al-status');
    if (el) {
      const reach = SmtAlerts.reach();
      el.textContent = !a.enabled ? 'Alarm off'
        : st.alertsOwned ? 'Overlay is sounding the alarm'
        : (reach < 0 ? 'Alarming on every report' : `Alarming out to ${reach} jump(s)`);
    }
  }
  function renderTiers() {
    const box = $id('smt-al-tiers'); if (!box) return;
    const flashOpt = (sel) => SmtAlerts.flashes.map((f) => `<option value="${f}"${f === sel ? ' selected' : ''}>${f === 'none' ? 'no flash' : f + ' flash'}</option>`).join('');
    box.innerHTML = SmtAlerts.tiers().map((t, i) => `<div class="smt-al-tier" data-i="${i}">
      <span class="smt-al-lead">${t.max < 0 ? 'any distance' : t.max === 0 ? 'your system' : `\u2264 ${t.max} jump${t.max === 1 ? '' : 's'}`}</span>
      <input type="number" class="smt-al-max" min="-1" max="10" step="1" value="${t.max}" title="Furthest jump distance this tier covers (-1 = any)" />
      <select class="smt-al-sound" title="Sound for this distance">${soundOpts(t.sound)}</select>
      <button class="secondary smt-al-test" type="button" data-test="${i}">Test</button>
      <input type="color" class="smt-al-col" value="${esc(t.colour)}" title="Overlay highlight colour at this distance" />
      <select class="smt-al-flash" title="Flash the overlay marker at this distance">${flashOpt(t.flash)}</select>
      <label class="smt-al-t" title="Flash the whole overlay window when a report lands at this distance"><input type="checkbox" class="smt-al-wflash"${t.flash_window ? ' checked' : ''} /> flash overlay</label>
      <label class="smt-al-t" title="Highlight size on the overlay — 1 is standard, higher is bigger">size <input type="number" class="smt-al-size" min="0.3" max="3" step="0.1" value="${t.size == null ? 1 : t.size}" />\u00d7</label>
      <label class="smt-al-t" title="Seconds before the highlight has faded away">fade <input type="number" class="smt-al-fade" min="5" max="3600" step="5" value="${t.fade == null ? 600 : t.fade}" />s</label>
      <input type="text" class="smt-al-custom" value="${esc(t.custom || '')}" placeholder="Optional sound file for this tier\u2026" spellcheck="false" autocomplete="off" />
      <button class="secondary smt-al-browse" type="button" data-i="${i}">\u2026</button>
      <button class="smt-al-del" type="button" data-i="${i}" title="Remove this tier">\u2715</button>
    </div>`).join('');
  }
  function readTiers() {
    return [...document.querySelectorAll('#smt-al-tiers .smt-al-tier')].map((row) => ({
      max: Number(row.querySelector('.smt-al-max').value),
      sound: row.querySelector('.smt-al-sound').value,
      colour: row.querySelector('.smt-al-col').value,
      flash: row.querySelector('.smt-al-flash').value,
      custom: row.querySelector('.smt-al-custom').value.trim(),
      flash_window: row.querySelector('.smt-al-wflash').checked,
      size: Number(row.querySelector('.smt-al-size').value),
      fade: Number(row.querySelector('.smt-al-fade').value),
    }));
  }
  async function saveAlerts(tiers) {
    const num = (id, d) => { const v = Number(($id(id) || {}).value); return Number.isFinite(v) ? v : d; };
    const body = {
      enabled: !!($id('smt-al-enabled') || {}).checked,
      hostile: !!($id('smt-al-hostile') || {}).checked,
      clear: !!($id('smt-al-clear') || {}).checked,
      kills: !!($id('smt-al-kills') || {}).checked,
      gap: num('smt-al-gap', 3), volume: num('smt-al-vol', 0.6),
      clear_sound: ($id('smt-al-clear-sound') || {}).value || 'chime',
      kill_sound: ($id('smt-al-kill-sound') || {}).value || 'thud',
      tiers: tiers || readTiers(),
    };
    try {
      SmtAlerts.setConfig(await j('/api/smt/alerts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
      st.alertKey = null;            // tiers changed → refetch the in-range set
      await refreshAlertRange();
      startLoops();                  // enabling the alarm starts the loops if the tab was never opened
      if (window.api && window.api.alertsChanged) window.api.alertsChanged();
    } catch (e) { const el = $id('smt-al-status'); if (el) el.textContent = `Failed: ${e.message || e}`; return; }
    renderAlerts();
  }
  // How far each system is from your character, so reports can be tiered by
  // distance. Covers the furthest tier; "any distance" needs no map at all.
  async function refreshAlertRange() {
    const a = SmtAlerts.config();
    const reach = SmtAlerts.reach();
    if (!a.enabled || reach < 0) { st.alertJumps = new Map(); st.alertKey = null; return; }
    const c = st.chars.find((x) => x.online && x.system_id) || st.chars.find((x) => x.system_id);
    const sys = c && c.system_id ? String(c.system_id) : null;
    if (!sys) { st.alertJumps = new Map(); st.alertKey = null; return; }
    const key = `${sys}|${reach}`;
    if (key === st.alertKey) return;
    st.alertKey = key;
    try {
      const d = await j(`/api/smt/overlay?system=${sys}&jumps=${Math.max(1, reach)}`);
      st.alertJumps = d.error ? new Map() : new Map((d.systems || []).map((x) => [String(x.id), x.jumps]));
    } catch (_) { st.alertKey = null; }
  }
  // The alarm has to keep working when the SMT tab isn't the one on screen —
  // otherwise it only ever fires when you're already looking at the map.
  function alarmArmed() { return !st.alertsOwned && SmtAlerts.config().enabled; }
  function pollActive() { const p = $id('tab-smt-intel'); return (p && p.offsetParent !== null) || alarmArmed(); }

  // ---- config (chat-logs folder + channels) ----
  async function loadConfig() {
    try {
      const c = await j('/api/smt/config');
      const dir = $id('smt-logdir'); if (dir && !dir.value) dir.value = c.log_dir || (c.defaults && c.defaults[0]) || '';
      renderChannels(c.available || [], c.channels || []);
      const s = $id('smt-config-status'); if (s) s.textContent = c.log_dir_ok ? `${(c.available || []).length} channel(s) found` : (c.log_dir ? 'Folder not found' : 'Set your chat-logs folder');
    } catch (e) { const s = $id('smt-config-status'); if (s) s.textContent = `Failed: ${e.message || e}`; }
  }
  function renderChannels(available, selected) {
    const box = $id('smt-channels'); if (!box) return;
    const sel = new Set(selected);
    if (!available.length) { box.innerHTML = '<span class="muted small">No channels found — check the folder, then Detect.</span>'; return; }
    box.innerHTML = available.map((ch) => `<label class="smt-chan"><input type="checkbox" value="${esc(ch)}" ${sel.has(ch) ? 'checked' : ''}/> ${esc(ch)}</label>`).join('');
  }
  async function saveConfig() {
    const dir = ($id('smt-logdir')?.value || '').trim();
    const channels = [...document.querySelectorAll('#smt-channels input:checked')].map((c) => c.value);
    const s = $id('smt-config-status'); if (s) s.textContent = 'Saving…';
    try {
      const c = await j('/api/smt/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ log_dir: dir, channels }) });
      renderChannels(c.available || [], c.channels || []);
      if (s) s.textContent = `Watching ${c.channels.length} channel(s)${c.log_dir_ok ? '' : ' · ⚠ folder not found'}`;
    } catch (e) { if (s) s.textContent = `Failed: ${e.message || e}`; }
  }
  async function detect() {
    const dir = ($id('smt-logdir')?.value || '').trim();
    const s = $id('smt-config-status'); if (s) s.textContent = 'Scanning…';
    try {
      await j('/api/smt/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ log_dir: dir, channels: [...document.querySelectorAll('#smt-channels input:checked')].map((c) => c.value) }) });
      await loadConfig();
    } catch (e) { if (s) s.textContent = `Failed: ${e.message || e}`; }
  }

  // ---- pan / zoom ----
  function wirePanZoom() {
    const cv = $id('smt-canvas'), svg = $id('smt-svg');
    if (!cv || !svg || cv.dataset.wired) return; cv.dataset.wired = '1';
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top;
      const ns = Math.max(0.15, Math.min(6, st.view.s * Math.exp(-e.deltaY * 0.0015)));
      st.view.tx = mx - (mx - st.view.tx) * (ns / st.view.s); st.view.ty = my - (my - st.view.ty) * (ns / st.view.s);
      st.view.s = ns; applyTransform();
      hidePop();                       // the card is anchored in pixels; the map just moved under it
      saveTransform();
    }, { passive: false });
    let drag = null;
    cv.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, tx: st.view.tx, ty: st.view.ty, moved: false }; cv.setPointerCapture(e.pointerId); });
    cv.addEventListener('pointermove', (e) => { if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; hidePop(); } st.view.tx = drag.tx + dx; st.view.ty = drag.ty + dy; applyTransform(); });
    // A press that never really moved is a click on whatever is under it. The
    // 3px slack above is what stops a twitchy mouse eating every card; this
    // flag is how the click that follows the drag knows to keep quiet.
    let dragged = false;
    cv.addEventListener('pointerup', () => {
      if (drag && drag.moved) { dragged = true; saveTransform(); }
      drag = null;
    });
    cv.addEventListener('pointerleave', () => { if (drag && drag.moved) { dragged = true; saveTransform(); } drag = null; });
    cv.addEventListener('click', (e) => {
      if (dragged) { dragged = false; return; }
      const n = e.target.closest && e.target.closest('.sm-n');
      if (n) showPop(n.dataset.id, e.clientX, e.clientY);
      else hidePop();
    });
  }

  // ---- jump range ----
  // Which systems a jump drive can actually reach from one origin. Distance is
  // real 3-D separation in light years, not stargate jumps, so this cuts across
  // the gate graph the rest of the map is drawn from — a system two constellations
  // away by gate can be next door to a jump drive.
  async function loadJumpShips() {
    if (st.jumpShips) return;
    try {
      const d = await j('/api/smt/jump-ships');
      st.jumpShips = d.ships || [];
      const prefs = await j('/api/smt/jump-prefs');
      st.jump.ship = prefs.ship; st.jump.skill = prefs.skill;
    } catch (_) { return; }
    const ship = $id('smt-jump-ship'), skill = $id('smt-jump-skill');
    if (ship) ship.innerHTML = st.jumpShips.map((s) => `<option value="${esc(s.key)}"${s.key === st.jump.ship ? ' selected' : ''}>${esc(s.label)}</option>`).join('');
    if (skill) skill.innerHTML = [0, 1, 2, 3, 4, 5].map((n) => `<option value="${n}"${n === st.jump.skill ? ' selected' : ''}>${n === 5 ? 'V (max)' : ['0', 'I', 'II', 'III', 'IV'][n]}</option>`).join('');
  }
  const jumpOriginName = () => {
    const typed = ($id('smt-jump-origin')?.value || '').trim();
    if (typed) return typed;
    const c = st.chars.find((x) => String(x.character_id) === String(st.focusId)) || st.chars.find((x) => x.system_id);
    return (c && c.system_name) || '';
  };
  async function refreshJumpRange() {
    const info = $id('smt-jump-info');
    if (!st.ov.jumprange) { st.jump.data = null; applyJumpRange(); return; }
    const from = jumpOriginName();
    if (!from) {
      st.jump.data = null; applyJumpRange();
      if (info) info.textContent = 'Pick a system to measure from.';
      return;
    }
    if (info) info.textContent = 'Measuring…';
    try {
      const d = await j(`/api/smt/jump-range?system=${encodeURIComponent(from)}&ship=${encodeURIComponent(st.jump.ship)}&skill=${st.jump.skill}`);
      if (d.error) { st.jump.data = null; if (info) info.textContent = d.error; applyJumpRange(); return; }
      st.jump.data = d;
      if (info) info.textContent = `${d.ly} ly from ${d.origin.name} — ${d.count} system${d.count === 1 ? '' : 's'} in range`;
    } catch (e) {
      st.jump.data = null;
      if (info) info.textContent = `Failed: ${e.message || e}`;
    }
    applyJumpRange();
  }
  // Fade rather than hide: an out-of-range system still has to be readable as
  // context, otherwise you can't see what you're *not* reaching.
  function applyJumpRange() {
    const on = !!(st.ov.jumprange && st.jump.data);
    const inRange = on ? st.jump.data.systems : null;
    st.nodeEls.forEach((el, id) => {
      el.classList.toggle('sm-jr-out', on && !(id in inRange));
      el.classList.toggle('sm-jr-in', on && (id in inRange));
      el.classList.toggle('sm-jr-origin', on && String(st.jump.data.origin.id) === id);
    });
    const root = $id('smt-root');
    if (root) root.classList.toggle('sm-jr-on', on);
  }
  async function saveJumpPrefs() {
    try {
      await j('/api/smt/jump-prefs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ship: st.jump.ship, skill: st.jump.skill }),
      });
      if (window.api && window.api.jumpPrefsChanged) window.api.jumpPrefsChanged();
    } catch (_) { /* the overlay will pick it up on its next poll */ }
  }

  // ---- ESI activity layers ----
  // NPC / ship / pod kills and ship jumps, last hour, from /api/map/live. Any
  // combination can be on at once, so each draws its own tagged number beside
  // the system rather than competing for the dot colour the way Sov does.
  async function loadActivityCfg() {
    try { SmtActivity.setConfig(await j('/api/smt/activity')); } catch (_) { /* defaults stand */ }
    syncActivityToggles();
    renderActivityPanel();
  }
  async function pollLive(force) {
    if (!force && !SmtActivity.wanted()) return;
    try {
      SmtActivity.setLive(await j('/api/map/live'));
      applyActivity();
    } catch (_) { /* transient — keep the numbers we have */ }
  }
  // The toolbar buttons and the panel checkboxes are two views of one setting.
  function syncActivityToggles() {
    document.querySelectorAll('.smt-ov-act').forEach((b) => {
      b.classList.toggle('on', !!SmtActivity.layer(b.dataset.ov).on);
    });
  }
  // Saves are serialised and each builds its payload when it runs. Toggling
  // two layers quickly would otherwise have the first POST's response — which
  // predates the second toggle — land last and switch it back off.
  let actQ = Promise.resolve();
  function queueActivity(fn) {
    actQ = actQ.then(() => saveActivity(fn())).catch(() => {});
    return actQ;
  }
  function setActivityLayer(name, on) {
    const snapshot = () => Object.fromEntries(SmtActivity.ORDER.map((k) => {
      const l = SmtActivity.layer(k);
      return [k, { on: k === name ? !!on : !!l.on, bands: (l.bands || []).map((b) => ({ ...b })) }];
    }));
    SmtActivity.setConfig({ layers: snapshot() });   // optimistic: the map reacts now
    syncActivityToggles();
    applyActivity();
    if (SmtActivity.wanted() && !SmtActivity.live()) pollLive(true);
    return queueActivity(snapshot);
  }
  async function saveActivity(layers) {
    const el = $id('smt-activity-status');
    try {
      SmtActivity.setConfig(await j('/api/smt/activity', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ layers }),
      }));
      if (el) el.textContent = '';
      if (window.api && window.api.activityChanged) window.api.activityChanged();
    } catch (e) { if (el) el.textContent = `Failed: ${e.message || e}`; }
    syncActivityToggles();
    renderActivityPanel();
    applyActivity();
  }

  // One <text> per system holding a coloured tspan per enabled layer. Rebuilt
  // wholesale rather than diffed — it only changes when a poll lands or a
  // toggle flips, and the node count is a region's worth, not the cluster's.
  function applyActivity() {
    const root = $id('smt-root'); if (!root) return;
    root.querySelectorAll('.sm-actlayer').forEach((e) => e.remove());
    if (!SmtActivity.wanted() || !st.layout || !SmtActivity.live()) return;
    const layer = document.createElementNS(SVGNS, 'g');
    layer.setAttribute('class', 'sm-actlayer');
    for (const sys of st.layout.systems) {
      const cells = SmtActivity.cellsFor(sys.id);
      if (!cells.length) continue;
      const t = document.createElementNS(SVGNS, 'text');
      t.setAttribute('class', 'sm-act');
      t.setAttribute('x', sys.x + 8);
      t.setAttribute('y', sys.y + 12);
      for (const c of cells) {
        const sp = document.createElementNS(SVGNS, 'tspan');
        sp.setAttribute('fill', c.colour);
        sp.textContent = `${c.tag}${c.value} `;
        t.appendChild(sp);
      }
      layer.appendChild(t);
    }
    root.appendChild(layer);
  }

  function renderActivityPanel() {
    const box = $id('smt-activity-layers'); if (!box) return;
    box.innerHTML = SmtActivity.ORDER.map((name) => {
      const l = SmtActivity.layer(name);
      const bands = (l.bands || []).map((b, i) => `<span class="smt-act-band" data-layer="${name}" data-i="${i}">
        <input type="number" class="smt-act-min" min="0" step="1" value="${b.min}" title="Show this colour from this many and up" />
        <input type="color" class="smt-act-col" value="${esc(b.colour)}" />
        <button class="smt-al-del smt-act-del" type="button" title="Remove this band">✕</button></span>`).join('');
      return `<div class="smt-act-row" data-layer="${name}">
        <label class="smt-al-t smt-act-name" title="${esc(SmtActivity.HINT[name])}">
          <input type="checkbox" class="smt-act-on"${l.on ? ' checked' : ''} />
          <span class="sm-act-eg">${SmtActivity.TAG[name]}</span> ${esc(SmtActivity.LABEL[name])}</label>
        <span class="smt-act-bands">${bands}</span>
        <button class="secondary smt-act-add" type="button" data-layer="${name}" title="Add a threshold">+ band</button>
      </div>`;
    }).join('');
  }
  function readActivity() {
    const layers = {};
    for (const name of SmtActivity.ORDER) {
      const row = document.querySelector(`.smt-act-row[data-layer="${name}"]`);
      if (!row) { const l = SmtActivity.layer(name); layers[name] = { on: !!l.on, bands: (l.bands || []).map((b) => ({ ...b })) }; continue; }
      layers[name] = {
        on: row.querySelector('.smt-act-on').checked,
        bands: [...row.querySelectorAll('.smt-act-band')].map((b) => ({
          min: Number(b.querySelector('.smt-act-min').value) || 0,
          colour: b.querySelector('.smt-act-col').value,
        })),
      };
    }
    return layers;
  }

  // ---- watchlist ----
  // Systems you always want to hear about, whatever the distance. The distance
  // tiers only reach as far as their furthest `max`; a watch is checked before
  // them and ignores distance entirely, which is what lets you keep an ear on
  // home while you're ratting six regions out. Stored in the sidecar — like the
  // bridges and the alarm rules — so this tab, the pop-out and the overlay
  // window can never disagree about what's being watched.
  const WATCH_DEFAULT = { sound: 'siren', colour: '#ff2d2d', flash: 'fast', custom: '', flash_window: true };
  const isWatched = (id) => st.watch.some((w) => String(w.system_id) === String(id));
  const iskShort = (n) => (typeof fmtIskShort === 'function' ? fmtIskShort(n) : `${Math.round((n || 0) / 1e6)}M`);

  async function loadWatch() {
    try { const d = await j('/api/smt/watchlist'); st.watch = d.systems || []; } catch (_) { /* keep what we have */ }
    afterWatch();
  }
  // Every write goes through one queue, and each one builds its list from
  // st.watch *at the time it runs*. Star two systems inside a round-trip and
  // the naive version has both compute from the same stale list, so the second
  // POST silently drops the first.
  let watchQ = Promise.resolve();
  function queueWatch(fn) {
    watchQ = watchQ.then(() => saveWatch(fn(st.watch))).catch(() => {});
    return watchQ;
  }

  async function saveWatch(list) {
    const body = {
      systems: (list || []).map((w) => ({
        system_id: Number(w.system_id), sound: w.sound || WATCH_DEFAULT.sound,
        colour: w.colour || WATCH_DEFAULT.colour, flash: w.flash || WATCH_DEFAULT.flash,
        custom: w.custom || '', flash_window: w.flash_window !== false,
      })),
    };
    const el = $id('smt-watch-status');
    try {
      const d = await j('/api/smt/watchlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      st.watch = d.systems || [];
      if (el) el.textContent = '';
      // Same hand-off the alarm rules use, so the overlay picks it up live.
      if (window.api && window.api.watchlistChanged) window.api.watchlistChanged();
    } catch (e) { if (el) el.textContent = `Failed: ${e.message || e}`; }
    afterWatch();
  }
  function afterWatch() {
    SmtAlerts.setWatchlist(st.watch);
    renderWatchList(); renderWatchStrip(); markWatched(); renderPop();
  }
  function toggleWatch(id) {
    const sid = Number(id);
    if (!sid) return Promise.resolve();
    return queueWatch((cur) => (cur.some((w) => Number(w.system_id) === sid)
      ? cur.filter((w) => Number(w.system_id) !== sid)
      : [...cur, { ...WATCH_DEFAULT, system_id: sid }]));
  }

  // What a watched system is doing right now, read off the layers already in
  // memory — no extra polling for the strip.
  function watchState(sid) {
    const now = Date.now();
    const iv = st.intel.get(String(sid)), kv = st.kills.get(String(sid));
    if (iv && now - iv.ts < DECAY) return { kind: iv.clear ? 'clear' : 'hot', age: now - iv.ts };
    if (kv && now - kv.ts < DECAY) return { kind: 'kill', age: now - kv.ts };
    return { kind: 'quiet' };
  }
  const ageLabel = (ms) => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60000)}m`);

  // The one row worth glancing at mid-fight: every watched system and its state,
  // whether or not it's anywhere near the region on screen.
  function renderWatchStrip() {
    const box = $id('smt-watch-strip'); if (!box) return;
    box.innerHTML = st.watch.map((w) => {
      const s = watchState(w.system_id);
      const label = s.kind === 'hot' ? `⚠ ${ageLabel(s.age)}`
        : s.kind === 'clear' ? `clr ${ageLabel(s.age)}`
        : s.kind === 'kill' ? `◆ ${ageLabel(s.age)}` : 'quiet';
      return `<button class="smt-watch-chip${s.kind === 'quiet' ? '' : ` ${s.kind}`}" data-id="${w.system_id}" style="--wc:${esc(w.colour)}"
        title="${esc(w.name || '')} · ${esc(w.region || '')} — click to jump the map here">
        <span class="star">★</span>${esc(w.name || w.system_id)} <span class="st">${label}</span></button>`;
    }).join('');
  }

  function renderWatchList() {
    const box = $id('smt-watch-list'); if (!box) return;
    if (!st.watch.length) {
      box.innerHTML = '<span class="muted small">Nothing watched yet — add a system above, or ★ one from the map.</span>';
      return;
    }
    const flashOpt = (sel) => SmtAlerts.flashes.map((f) => `<option value="${f}"${f === sel ? ' selected' : ''}>${f === 'none' ? 'no flash' : `${f} flash`}</option>`).join('');
    box.innerHTML = st.watch.map((w, i) => `<div class="smt-watch-row" data-i="${i}" data-id="${w.system_id}">
      <button class="smt-watch-name" type="button" data-jump="${w.system_id}" title="Jump the map here">★ ${esc(w.name || w.system_id)}</button>
      <span class="smt-watch-reg">${esc(w.region || '')}</span>
      <select class="smt-w-sound" title="Sound when this system is reported">${soundOpts(w.sound)}</select>
      <button class="secondary smt-al-test smt-w-test" type="button" data-i="${i}">Test</button>
      <input type="color" class="smt-w-col" value="${esc(w.colour)}" title="Overlay highlight colour for this system" />
      <select class="smt-w-flash" title="Flash the overlay marker for this system">${flashOpt(w.flash)}</select>
      <label class="smt-al-t" title="Flash the whole overlay window when this system is reported"><input type="checkbox" class="smt-w-wflash"${w.flash_window ? ' checked' : ''} /> flash overlay</label>
      <input type="text" class="smt-w-custom" value="${esc(w.custom || '')}" placeholder="Optional sound file…" spellcheck="false" autocomplete="off" />
      <button class="secondary smt-w-browse" type="button" data-i="${i}">…</button>
      <button class="smt-al-del smt-w-del" type="button" data-i="${i}" title="Stop watching">✕</button>
    </div>`).join('');
  }
  function readWatch() {
    return [...document.querySelectorAll('#smt-watch-list .smt-watch-row')].map((row) => ({
      system_id: Number(row.dataset.id),
      sound: row.querySelector('.smt-w-sound').value,
      colour: row.querySelector('.smt-w-col').value,
      flash: row.querySelector('.smt-w-flash').value,
      custom: row.querySelector('.smt-w-custom').value.trim(),
      flash_window: row.querySelector('.smt-w-wflash').checked,
    }));
  }
  async function addWatch() {
    const inp = $id('smt-watch-sys'), el = $id('smt-watch-status');
    const sys = resolveSys(inp && inp.value);
    if (!sys) { if (el) el.textContent = 'Unknown system'; return; }
    if (isWatched(sys.id)) { if (el) el.textContent = `${sys.name} is already watched`; return; }
    if (inp) inp.value = '';
    await queueWatch((cur) => (cur.some((w) => Number(w.system_id) === sys.id)
      ? cur
      : [...cur, { ...WATCH_DEFAULT, system_id: sys.id }]));
  }
  async function pickWatchSound(i) {
    if (!window.api || !window.api.pickSound) return;
    const f = await window.api.pickSound();
    if (!f) return;
    const list = readWatch();
    if (!list[i]) return;
    list[i].custom = f;
    queueWatch(() => list);
  }

  // Star the watched systems on the map. Kept out of renderMap so starring
  // something costs a class toggle rather than a full region redraw.
  function markWatched() {
    st.nodeEls.forEach((el, id) => {
      const on = isWatched(id);
      el.classList.toggle('sm-watched', on);
      const star = el.querySelector('.sm-watch-star');
      if (on && !star) {
        const t = document.createElementNS(SVGNS, 'text');
        t.setAttribute('class', 'sm-watch-star');
        t.setAttribute('x', '-11');
        t.setAttribute('y', '3.5');
        t.textContent = '★';
        el.appendChild(t);
      } else if (!on && star) { star.remove(); }
    });
  }

  // ---- system card ----
  // Anchored beside the node rather than opened as a modal: the map exists to
  // give you spatial context, and a dialog in the middle of the screen throws
  // that away. Everything in it is already in memory bar the jump distance.
  function showPop(id, cx, cy) {
    const pop = $id('smt-sys-pop'), cv = $id('smt-canvas');
    if (!pop || !cv) return;
    st.popId = String(id);
    pop.hidden = false;
    renderPop();
    const r = cv.getBoundingClientRect();
    const w = pop.offsetWidth || 320, h = pop.offsetHeight || 220;
    let x = cx - r.left + 14, y = cy - r.top + 14;
    // The canvas clips, so near an edge the card flips to the other side of the
    // cursor instead of disappearing off it.
    if (x + w > r.width - 6) x = Math.max(6, cx - r.left - w - 14);
    if (y + h > r.height - 6) y = Math.max(6, r.height - h - 6);
    pop.style.left = `${x}px`;
    pop.style.top = `${y}px`;
    popDistance(st.popId, popSys(st.popId).name || '');
  }
  function hidePop() {
    const p = $id('smt-sys-pop');
    if (p) p.hidden = true;
    st.popId = null;
  }
  function popSys(id) {
    return (st.byId && st.byId.get(String(id)))
      || (st.layout ? (st.layout.systems || []).find((x) => String(x.id) === String(id)) : null)
      || {};
  }
  function renderPop() {
    const pop = $id('smt-sys-pop');
    if (!pop || pop.hidden || !st.popId) return;
    const id = st.popId, sys = popSys(id);
    const lines = st.feed.filter((e) => (e.systems || []).some((x) => String(x) === id)).slice(0, 6);
    const hour = (Date.now() - 3600000) / 1000;
    const ks = st.killLog.filter((k) => String(k.system_id) === id && k.ts >= hour);
    const isk = ks.reduce((a, k) => a + (Number(k.value) || 0), 0);
    const watched = isWatched(id);
    const time = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    pop.innerHTML = `<button class="sp-x" type="button" data-pop="close" title="Close">✕</button>
      <h4>${esc(sys.name || id)} <span class="sec" style="color:${secCol(sys.sec)}">${sys.sec == null ? '' : sys.sec.toFixed(1)}</span></h4>
      <div class="sp-sub">${esc(sys.region || '')}</div>
      <div class="sp-sub" id="smt-pop-dist"></div>
      <div class="sp-h">Intel</div>
      ${lines.length
        ? lines.map((e) => `<div class="sp-row${e.clear ? ' clear' : ''}"><span class="t">${time(e.ts)}</span>${SmtHighlight.line(e.text, e.spans)}</div>`).join('')
        : '<div class="sp-row muted">Nothing reported since the app started.</div>'}
      <div class="sp-h">Kills</div>
      <div class="sp-row">${ks.length ? `${ks.length} in the last hour · ${esc(iskShort(isk))}` : 'None in the last hour.'}</div>
      <div class="sp-acts">
        <button type="button" data-pop="watch"${watched ? ' class="on"' : ''}>${watched ? '★ Watching' : '★ Watch'}</button>
        <button type="button" data-pop="jump">⤭ Jump range</button>
        <button type="button" data-pop="route-from">Route from</button>
        <button type="button" data-pop="route-to">Route to</button>
        <button type="button" data-pop="dotlan">Dotlan</button>
        <button type="button" data-pop="zkill">zKill</button>
      </div>`;
  }
  // Distance is the one thing not already in memory: alertJumps only reaches as
  // far as the alarm does, so anything beyond it gets a real route lookup —
  // which also counts your bridges, making it the honest number.
  async function popDistance(id, name) {
    const el = $id('smt-pop-dist');
    if (!el) return;
    const c = st.chars.find((x) => String(x.character_id) === String(st.focusId)) || st.chars.find((x) => x.system_id);
    if (!c || !c.system_name) { el.textContent = ''; return; }
    if (String(c.system_id) === String(id)) { el.textContent = `${c.name} is here`; return; }
    const known = st.alertJumps.get(String(id));
    if (known != null) { el.textContent = `${known} jump${known === 1 ? '' : 's'} from ${c.name}`; return; }
    if (!name) { el.textContent = ''; return; }
    el.textContent = `measuring from ${c.name}…`;
    try {
      const r = await j(`/api/smt/route?from=${encodeURIComponent(c.system_name)}&to=${encodeURIComponent(name)}&prefer=shortest&wh=0`);
      if (st.popId !== String(id)) return;                     // the card moved on while we waited
      el.textContent = r.error ? '' : `${r.jumps} jump${r.jumps === 1 ? '' : 's'} from ${c.name}`;
    } catch (_) { el.textContent = ''; }
  }

  // ---- wiring ----
  function wire() {
    $id('smt-region')?.addEventListener('change', (e) => { st.centred = true; showRegion(e.target.value); });
    document.querySelectorAll('.smt-ov-act').forEach((b) => b.addEventListener('click', () => {
      setActivityLayer(b.dataset.ov, !b.classList.contains('on'));
    }));
    document.querySelectorAll('.smt-ov:not(.smt-ov-act)').forEach((b) => b.addEventListener('click', () => {
      b.classList.toggle('on'); st.ov[b.dataset.ov] = b.classList.contains('on');
      applyLayers();
      if (b.dataset.ov === 'chars') { if (st.ov.chars) pollChars(); else { renderCharChips(); renderCharMarkers(); } }
      if (b.dataset.ov === 'sov') { if (st.ov.sov && !st.sov) loadSov(); else applySov(); }
      if (b.dataset.ov === 'jumprange') { loadJumpShips().then(refreshJumpRange); }
      saveView({ ov: { ...st.ov } });
    }));
    $id('smt-chars')?.addEventListener('click', (e) => {
      const c = e.target.closest('.smt-char-chip'); if (!c) return;
      if (c.dataset.char) st.focusId = c.dataset.char;
      st.centred = true;
      renderCharChips(); renderCharMarkers();
      if (c.dataset.region) showRegion(c.dataset.region, c.dataset.id);
    });
    // route + bridges panels. Which ones were open is part of the remembered
    // view, so a layout you set up for a fight survives a restart.
    const panel = (btn, id, onOpen) => $id(btn)?.addEventListener('click', () => {
      const b = $id(id); if (!b) return;
      b.hidden = !b.hidden;
      if (!b.hidden && onOpen) onOpen();
      savePanels();
    });
    panel('smt-route-btn', 'smt-route-bar');
    panel('smt-bridges-btn', 'smt-bridges-bar', loadBridges);
    panel('smt-thera-btn', 'smt-thera-bar', loadThera);
    $id('smt-thera-list')?.addEventListener('click', (e) => { const s = e.target.closest('.smt-thera-sys'); if (s && s.dataset.region) showRegion(s.dataset.region, s.dataset.id); });
    panel('smt-sov-btn', 'smt-sov-bar', loadSov);
    $id('smt-sov-list')?.addEventListener('click', (e) => { const s = e.target.closest('.smt-thera-sys'); if (s && s.dataset.region) showRegion(s.dataset.region, s.dataset.id); });
    $id('smt-route-go')?.addEventListener('click', runRoute);
    $id('smt-route-clear')?.addEventListener('click', clearRoute);
    $id('smt-route-from')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') runRoute(); });
    $id('smt-route-to')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') runRoute(); });
    $id('smt-bridge-add')?.addEventListener('click', addBridge);
    $id('smt-bridge-paste')?.addEventListener('click', () => { const b = $id('smt-bridge-pastebox'); if (b) { b.hidden = !b.hidden; if (!b.hidden) b.focus(); else pasteBridges(); } });
    $id('smt-bridge-list')?.addEventListener('click', (e) => {
      const del = e.target.closest('.smt-bridge-del'); if (del) { st.bridges.splice(+del.dataset.i, 1); saveBridges(); return; }
      const jmp = e.target.closest('.smt-bridge-jump'); if (jmp && jmp.dataset.region) showRegion(jmp.dataset.region, jmp.dataset.id);
    });
    $id('smt-follow')?.addEventListener('change', (e) => { st.follow = e.target.checked; saveView({ follow: st.follow }); });
    panel('smt-config-btn', 'smt-config', loadConfig);
    $id('smt-overlay-btn')?.addEventListener('click', () => {
      if (window.api && window.api.openOverlay) window.api.openOverlay();
      else setStatus('The overlay needs the desktop app.', true);
    });
    panel('smt-alerts-btn', 'smt-alerts-bar', loadAlerts);
    panel('smt-watch-btn', 'smt-watch-bar', loadWatch);
    panel('smt-jump-btn', 'smt-jump-bar', () => loadJumpShips().then(refreshJumpRange));
    $id('smt-jump-ship')?.addEventListener('change', (e) => { st.jump.ship = e.target.value; saveJumpPrefs(); refreshJumpRange(); });
    $id('smt-jump-skill')?.addEventListener('change', (e) => { st.jump.skill = Number(e.target.value); saveJumpPrefs(); refreshJumpRange(); });
    $id('smt-jump-origin')?.addEventListener('change', refreshJumpRange);
    $id('smt-jump-origin')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') refreshJumpRange(); });
    $id('smt-jump-here')?.addEventListener('click', () => { const o = $id('smt-jump-origin'); if (o) o.value = ''; refreshJumpRange(); });
    panel('smt-activity-btn', 'smt-activity-bar', loadActivityCfg);
    $id('smt-activity-bar')?.addEventListener('change', (e) => { if (e.target.closest('input')) queueActivity(readActivity); });
    $id('smt-activity-bar')?.addEventListener('click', (e) => {
      const add = e.target.closest('.smt-act-add');
      if (add) {
        const layers = readActivity();
        const bands = layers[add.dataset.layer].bands;
        const last = bands[bands.length - 1];
        bands.push({ min: last ? last.min * 2 || 1 : 1, colour: last ? last.colour : '#c8b93a' });
        queueActivity(() => layers);
        return;
      }
      const del = e.target.closest('.smt-act-del');
      if (del) {
        const band = del.closest('.smt-act-band');
        const layers = readActivity();
        layers[band.dataset.layer].bands.splice(Number(band.dataset.i), 1);
        queueActivity(() => layers);
      }
    });
    $id('smt-act-reset')?.addEventListener('click', async () => {
      const el = $id('smt-activity-status'); if (el) el.textContent = 'Resetting…';
      // An empty layer set makes the sidecar fall back to its own defaults,
      // so the defaults live in one place rather than being mirrored here.
      await queueActivity(() => Object.fromEntries(
        SmtActivity.ORDER.map((k) => [k, { on: SmtActivity.layer(k).on, bands: [] }])));
      if (el) el.textContent = '';
    });
    $id('smt-alerts-bar')?.addEventListener('change', (e) => { if (e.target.closest('input, select')) saveAlerts(); });
    $id('smt-alerts-bar')?.addEventListener('click', (e) => {
      const t = e.target.closest('.smt-al-test'); if (t) { SmtAlerts.test(t.dataset.test); return; }
      const b = e.target.closest('.smt-al-browse'); if (b) { pickSound(+b.dataset.i); return; }
      const d = e.target.closest('.smt-al-del'); if (d) { const ts = readTiers(); ts.splice(+d.dataset.i, 1); saveAlerts(ts); return; }
      if (e.target.id === 'smt-al-add') {
        const ts = readTiers();
        const far = ts.reduce((m, x) => Math.max(m, x.max), 0);
        ts.push({ max: Math.min(10, far + 2), sound: 'blip', colour: '#8fb4d8', flash: 'none', custom: '', flash_window: false, size: 1, fade: 300 });
        saveAlerts(ts);
        return;
      }
      if (e.target.id === 'smt-al-reset') saveAlerts(SmtAlerts.defaults().tiers);
    });
    // ---- watchlist wiring ----
    $id('smt-watch-add')?.addEventListener('click', addWatch);
    $id('smt-watch-sys')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') addWatch(); });
    $id('smt-watch-bar')?.addEventListener('change', (e) => { if (e.target.closest('input, select')) queueWatch(() => readWatch()); });
    $id('smt-watch-bar')?.addEventListener('click', (e) => {
      const jump = e.target.closest('[data-jump]');
      if (jump) { const sys = st.byId && st.byId.get(String(jump.dataset.jump)); if (sys && sys.region) { st.centred = true; showRegion(sys.region, sys.id); } return; }
      const del = e.target.closest('.smt-w-del');
      if (del) { queueWatch(() => { const l = readWatch(); l.splice(Number(del.dataset.i), 1); return l; }); return; }
      const browse = e.target.closest('.smt-w-browse');
      if (browse) { pickWatchSound(Number(browse.dataset.i)); return; }
      const test = e.target.closest('.smt-w-test');
      if (test) { const w = readWatch()[Number(test.dataset.i)]; if (w) SmtAlerts.testSound(w.sound, w.custom); }
    });
    // The strip is a navigation aid as much as a status line.
    $id('smt-watch-strip')?.addEventListener('click', (e) => {
      const c = e.target.closest('.smt-watch-chip'); if (!c) return;
      const sys = st.byId && st.byId.get(String(c.dataset.id));
      if (sys && sys.region) { st.centred = true; showRegion(sys.region, sys.id); }
    });

    // ---- system card ----
    $id('smt-sys-pop')?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pop]');
      if (!b || !st.popId) return;
      const id = st.popId, sys = popSys(id), act = b.dataset.pop;
      if (act === 'close') { hidePop(); return; }
      if (act === 'watch') { toggleWatch(id); return; }
      if (act === 'jump') {
        const bar = $id('smt-jump-bar');
        if (bar && bar.hidden) { bar.hidden = false; savePanels(); }
        const o = $id('smt-jump-origin'); if (o) o.value = sys.name || '';
        const btn = document.querySelector('.smt-ov[data-ov="jumprange"]');
        if (btn && !btn.classList.contains('on')) { btn.classList.add('on'); st.ov.jumprange = true; saveView({ ov: { ...st.ov } }); }
        hidePop();
        loadJumpShips().then(refreshJumpRange);
        return;
      }
      if (act === 'route-from' || act === 'route-to') {
        const bar = $id('smt-route-bar');
        if (bar && bar.hidden) { bar.hidden = false; savePanels(); }
        const field = $id(act === 'route-from' ? 'smt-route-from' : 'smt-route-to');
        if (field) field.value = sys.name || '';
        const from = $id('smt-route-from'), to = $id('smt-route-to');
        hidePop();
        // Only route once both ends are filled — the first click just arms it.
        if (from && to && from.value.trim() && to.value.trim()) runRoute();
        return;
      }
      const url = act === 'dotlan'
        ? `https://evemaps.dotlan.net/system/${encodeURIComponent(String(sys.name || '').replace(/ /g, '_'))}`
        : `https://zkillboard.com/system/${encodeURIComponent(id)}/`;
      if (window.api && window.api.openExternal) window.api.openExternal(url);
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && st.popId) hidePop(); });
    $id('smt-save')?.addEventListener('click', saveConfig);
    $id('smt-detect')?.addEventListener('click', detect);
    const search = $id('smt-search');
    search?.addEventListener('change', () => { const v = (search.value || '').trim().toLowerCase(); const sys = st.byName && st.byName.get(v); if (sys) { showRegion(sys.region, sys.id); search.value = ''; } });
    $id('smt-feed-list')?.addEventListener('click', (e) => {
      const b = e.target.closest('.smt-feed-sys, .ih-sys[data-id]');
      if (!b) return;
      const sys = st.byId && st.byId.get(String(b.dataset.id));
      if (sys && sys.region) { st.centred = true; showRegion(sys.region, sys.id); }
    });
    let rz; window.addEventListener('resize', () => {
      clearTimeout(rz);
      rz = setTimeout(() => {
        const p = $id('tab-smt-intel');
        if (!st.layout) return;
        if (p && p.offsetParent !== null) { fitView(); saveTransform(); } else { st.needFit = true; }
      }, 150);
    });
  }

  async function pickSound(i) {
    if (!window.api || !window.api.pickSound) return;
    const f = await window.api.pickSound();
    if (!f) return;
    const ts = readTiers();
    if (!ts[i]) return;
    ts[i].custom = f;
    saveAlerts(ts);
  }

  // The live loops. Started when the tab is first opened, or straight away at
  // app start when the alarm is armed, so intel can alarm from any tab.
  function startLoops() {
    if (st.loopsOn) return;
    st.loopsOn = true;
    pollLayers(); pollChars();
    st.poll = setInterval(() => { if (pollActive()) pollLayers(); }, 4000);
    st.charPoll = setInterval(() => { if (pollActive()) pollChars(); }, 8000);
    st.theraPoll = setInterval(() => { const p = $id('tab-smt-intel'); if (p && p.offsetParent !== null) loadThera(); }, 120000);
    st.sovPoll = setInterval(() => { const p = $id('tab-smt-intel'); if (p && p.offsetParent !== null) loadSov(); }, 180000);
    st.livePoll = setInterval(() => { const p = $id('tab-smt-intel'); if (p && p.offsetParent !== null) pollLive(); }, 60000);
    st.tick = setInterval(() => { const p = $id('tab-smt-intel'); if (p && p.offsetParent !== null) { applyLayers(); tickSov(); renderWatchStrip(); } }, 1000);
  }

  // Put back the bits of the view that don't fight the character fix: the
  // layer toggles, follow-intel and whichever panels were open. The region and
  // the transform are restored by loadRegions/restoreView further down.
  function restorePrefs() {
    const v = loadView();
    if (v.ov) {
      for (const k of Object.keys(st.ov)) if (typeof v.ov[k] === 'boolean') st.ov[k] = v.ov[k];
      document.querySelectorAll('.smt-ov').forEach((b) => b.classList.toggle('on', !!st.ov[b.dataset.ov]));
    }
    if (typeof v.follow === 'boolean') {
      st.follow = v.follow;
      const f = $id('smt-follow'); if (f) f.checked = v.follow;
    }
    for (const id of (v.panels || [])) {
      const el = $id(id);
      if (el) el.hidden = false;
    }
  }

  function initTab() {
    wirePanZoom();
    if (!st.loaded) {
      st.loaded = true; wire(); restorePrefs();
      // Open on whichever character we're following. pollChars centres the map
      // the moment it has a fix; these two fallbacks only cover "there is no
      // character" (quick) and "a character exists but never resolved a system"
      // (slow), so a fix arriving a beat late still wins the opening view.
      const fallback = () => { if (!st.centred) { st.centred = true; showRegion($id('smt-region')?.value || loadView().region || 'Delve'); } };
      Promise.all([loadRegions(), loadIndex()])
        .then(() => {
          maybeCentre();                                        // a character fix may already be in
          setTimeout(() => { if (!st.focusId) fallback(); }, 1500);
          setTimeout(fallback, 6000);
        })
        .catch((e) => setStatus(`Failed to load map: ${e.message || e}`, true));
      loadConfig(); loadBridges(); loadThera(); loadSov(); loadAlerts(); loadWatch();
      loadActivityCfg().then(() => pollLive());
      startLoops();
    } else if (st.layout) {
      // Coming back to the tab keeps where you were, unless a resize while it
      // was hidden left the saved transform pointing off-screen.
      if (st.needFit) { st.needFit = false; fitView(); saveTransform(); } else { applyTransform(); }
    }
  }

  document.querySelector('.tab-btn[data-tab="smt-intel"]')?.addEventListener('click', initTab);

  // The overlay window owns the alarm while it's open, so the same report can't
  // sound in both places.
  if (window.api && window.api.onOverlayState) {
    window.api.onOverlayState((open) => { st.alertsOwned = !!open; renderAlerts(); });
  }
  // Starred from the overlay (or another pop-out) — pick it up without a reload.
  if (window.api && window.api.onWatchlistChanged) window.api.onWatchlistChanged(() => loadWatch());
  // Arm the alarm at app start (without loading the map) so intel can alarm
  // before anyone visits the SMT tab. The watchlist comes with it — a watched
  // system has to be able to shout from a cold start, not only once someone
  // has opened the map.
  Promise.all([loadAlerts(), loadWatch()]).then(() => { if (SmtAlerts.config().enabled) startLoops(); });
})();
