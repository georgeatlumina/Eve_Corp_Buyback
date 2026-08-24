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
    intelSince: 0, killSince: 0, ov: { intel: true, kills: true, chars: true, sov: false },
    follow: false, loaded: false, poll: null, tick: null, charPoll: null,
    view: { s: 1, tx: 0, ty: 0 },
  };
  const $id = (x) => document.getElementById(x);
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
    if ([...sel.options].some((o) => o.value === 'Delve')) sel.value = 'Delve';
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
      fitView();
      applyLayers();
      renderCharMarkers();
      renderBridges();
      renderTheraOnMap();
      applySov();
      renderRoute();
      setStatus('');
      if (focusId) centerOn(focusId);
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
        if (d.events.length) { renderFeed(); if (st.follow) followLatest(); }
        setStatus(d.watching ? '' : (d.log_dir_ok ? 'No intel channels selected — open ⚙ Logs.' : 'Set your EVE chat-logs folder in ⚙ Logs to see intel.'));
      }
      if (st.ov.kills) {
        const d = await j(`/api/smt/kills?since=${st.killSince}`);
        st.killSince = d.ts;
        for (const k of d.kills) st.kills.set(String(k.system_id), { ts: k.ts * 1000, value: k.value });
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
    if (!st.ov.chars) { renderCharChips(); renderCharMarkers(); return; }
    try {
      const d = await j('/api/smt/characters');
      st.chars = d.characters || []; st.fleet = d.fleet; st.fleetMembers = d.fleet_members || [];
      st.charsAuthed = d.authed;
      renderCharChips(); renderCharMarkers();
    } catch (_) { /* transient */ }
  }
  function renderCharChips() {
    const box = $id('smt-chars'); if (!box) return;
    if (!st.ov.chars) { box.innerHTML = ''; return; }
    if (!st.chars.length) {
      box.innerHTML = st.charsAuthed ? '<span class="muted small">SMT characters authed but no location yet (offline, or the location scope isn’t enabled in your EVE app).</span>'
        : '<span class="muted small">No SMT characters — add them in Auth → SMT Characters to plot them here.</span>';
      return;
    }
    const chip = (c) => `<button class="smt-char-chip${c.online ? ' on' : ''}${c.region === st.region ? ' here' : ''}" data-region="${esc(c.region || '')}" data-id="${c.system_id || ''}" title="${esc([c.ship_type_name, c.docked ? 'docked' : '', c.error || ''].filter(Boolean).join(' · '))}">
      <span class="smt-char-dot"></span>${esc(c.name || c.slot)} <span class="muted">${esc(c.system_name || '—')}</span></button>`;
    box.innerHTML = st.chars.map(chip).join('') + (st.fleet ? `<span class="smt-fleet-tag" title="You're in a fleet of ${st.fleet.size}">⛴ fleet ${st.fleet.size}</span>` : '');
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
      g.innerHTML = `<circle class="smt-char-mk" r="6" /><rect class="smt-char-pill" x="9" y="-9" rx="3" ry="3" height="14" width="${9 + label.length * 5.6}" /><text class="smt-char-lbl" x="13" y="1.5">${esc(label)}</text>`;
      layer.appendChild(g);
    };
    const bySys = {};
    for (const c of st.chars) if (c.system_id && c.region === st.region) (bySys[c.system_id] = bySys[c.system_id] || []).push(c);
    for (const sid in bySys) { const l = bySys[sid]; place(sid, l.map((c) => c.name).join(', '), l.some((c) => c.online) ? 'online' : 'offline'); }
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
    if (!st.feed.length) { list.innerHTML = '<p class="muted small">No intel yet. Configure your chat-logs folder and channels in ⚙ Logs.</p>'; return; }
    list.innerHTML = st.feed.slice(0, 120).map((e) => {
      const t = new Date(e.ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const syss = (e.system_names || []).slice(0, 4).map((n, i) => `<button class="smt-feed-sys" data-id="${e.systems[i]}">${esc(n)}</button>`).join('');
      return `<div class="smt-feed-row${e.clear ? ' smt-feed-clear' : ''}">
        <span class="smt-feed-t muted">${t}</span>
        <span class="smt-feed-ch muted">${esc(e.channel)}</span>
        ${syss ? `<span class="smt-feed-syss">${syss}</span>` : ''}
        <span class="smt-feed-txt">${esc(e.text)}</span></div>`;
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
    }, { passive: false });
    let drag = null;
    cv.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, tx: st.view.tx, ty: st.view.ty, moved: false }; cv.setPointerCapture(e.pointerId); });
    cv.addEventListener('pointermove', (e) => { if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true; st.view.tx = drag.tx + dx; st.view.ty = drag.ty + dy; applyTransform(); });
    cv.addEventListener('pointerup', () => { drag = null; });
    cv.addEventListener('pointerleave', () => { drag = null; });
  }

  // ---- wiring ----
  function wire() {
    $id('smt-region')?.addEventListener('change', (e) => showRegion(e.target.value));
    document.querySelectorAll('.smt-ov').forEach((b) => b.addEventListener('click', () => {
      b.classList.toggle('on'); st.ov[b.dataset.ov] = b.classList.contains('on');
      applyLayers();
      if (b.dataset.ov === 'chars') { if (st.ov.chars) pollChars(); else { renderCharChips(); renderCharMarkers(); } }
      if (b.dataset.ov === 'sov') { if (st.ov.sov && !st.sov) loadSov(); else applySov(); }
    }));
    $id('smt-chars')?.addEventListener('click', (e) => { const c = e.target.closest('.smt-char-chip'); if (c && c.dataset.region) showRegion(c.dataset.region, c.dataset.id); });
    // route + bridges panels
    $id('smt-route-btn')?.addEventListener('click', () => { const b = $id('smt-route-bar'); if (b) b.hidden = !b.hidden; });
    $id('smt-bridges-btn')?.addEventListener('click', () => { const b = $id('smt-bridges-bar'); if (b) { b.hidden = !b.hidden; if (!b.hidden) loadBridges(); } });
    $id('smt-thera-btn')?.addEventListener('click', () => { const b = $id('smt-thera-bar'); if (b) { b.hidden = !b.hidden; if (!b.hidden) loadThera(); } });
    $id('smt-thera-list')?.addEventListener('click', (e) => { const s = e.target.closest('.smt-thera-sys'); if (s && s.dataset.region) showRegion(s.dataset.region, s.dataset.id); });
    $id('smt-sov-btn')?.addEventListener('click', () => { const b = $id('smt-sov-bar'); if (b) { b.hidden = !b.hidden; if (!b.hidden) loadSov(); } });
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
    $id('smt-follow')?.addEventListener('change', (e) => { st.follow = e.target.checked; });
    $id('smt-config-btn')?.addEventListener('click', () => { const c = $id('smt-config'); if (c) { c.hidden = !c.hidden; if (!c.hidden) loadConfig(); } });
    $id('smt-overlay-btn')?.addEventListener('click', () => {
      if (window.api && window.api.openOverlay) window.api.openOverlay();
      else setStatus('The overlay needs the desktop app.', true);
    });
    $id('smt-save')?.addEventListener('click', saveConfig);
    $id('smt-detect')?.addEventListener('click', detect);
    const search = $id('smt-search');
    search?.addEventListener('change', () => { const v = (search.value || '').trim().toLowerCase(); const sys = st.byName && st.byName.get(v); if (sys) { showRegion(sys.region, sys.id); search.value = ''; } });
    $id('smt-feed-list')?.addEventListener('click', (e) => { const b = e.target.closest('.smt-feed-sys'); if (b) { const sys = st.byId && st.byId.get(String(b.dataset.id)); if (sys && sys.region) showRegion(sys.region, sys.id); } });
    let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { const p = $id('tab-smt-intel'); if (st.layout && p && p.offsetParent !== null) fitView(); }, 150); });
  }

  function initTab() {
    wirePanZoom();
    if (!st.loaded) {
      st.loaded = true; wire();
      Promise.all([loadRegions(), loadIndex()]).then(() => showRegion($id('smt-region')?.value || 'Delve')).catch((e) => setStatus(`Failed to load map: ${e.message || e}`, true));
      loadConfig(); loadBridges(); loadThera(); loadSov();
      pollLayers(); pollChars();
      st.theraPoll = setInterval(() => { const p = $id('tab-smt-intel'); if (p && p.offsetParent !== null) loadThera(); }, 120000);
      st.sovPoll = setInterval(() => { const p = $id('tab-smt-intel'); if (p && p.offsetParent !== null) loadSov(); }, 180000);
      st.poll = setInterval(() => { const p = $id('tab-smt-intel'); if (p && p.offsetParent !== null) pollLayers(); }, 4000);
      st.charPoll = setInterval(() => { const p = $id('tab-smt-intel'); if (p && p.offsetParent !== null) pollChars(); }, 8000);
      st.tick = setInterval(() => { const p = $id('tab-smt-intel'); if (p && p.offsetParent !== null) { applyLayers(); tickSov(); } }, 1000);
    } else if (st.layout) { fitView(); }
  }

  document.querySelector('.tab-btn[data-tab="smt-intel"]')?.addEventListener('click', initTab);
})();
