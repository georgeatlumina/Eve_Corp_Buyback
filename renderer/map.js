'use strict';

// ================= Native EVE Maps tab =================
// Replaces the old Dotlan <webview> wrapper with a native renderer. Region
// layouts (familiar Dotlan coordinates) + the stargate graph + security come
// from the bundled dataset via /api/map/*; live jumps / kills / sovereignty come
// from ESI. Renders an SVG region map with pan/zoom, live overlays, a system
// detail panel, search, and a stargate route planner.
// Self-contained IIFE; reuses app.js globals ($, escapeHtml, API, window.api).

(function () {
  const SVGNS = 'http://www.w3.org/2000/svg';
  const st = {
    loaded: false, region: null, layout: null, index: null,
    live: null, liveTs: 0, overlay: 'none', selected: null,
    route: null, nodeEls: new Map(),
    view: { s: 1, tx: 0, ty: 0 },
  };

  const $id = (x) => document.getElementById(x);
  const esc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(s) : String(s == null ? '' : s));

  // ---- security colour (EVE-style gradient) ----
  function secCol(sec) {
    if (sec == null) return '#6f1a1a';
    if (sec >= 0.95) return '#2d6fd8';
    if (sec >= 0.85) return '#3d9be0';
    if (sec >= 0.75) return '#3fc7c0';
    if (sec >= 0.65) return '#48d84a';
    if (sec >= 0.55) return '#8fdc30';
    if (sec >= 0.45) return '#e5e52f';
    if (sec >= 0.35) return '#e9b62b';
    if (sec >= 0.25) return '#e88a26';
    if (sec >= 0.15) return '#e6591e';
    if (sec > 0) return '#d63a1e';
    return '#8b1a1a';
  }
  const secTxt = (sec) => (sec == null ? '?' : sec.toFixed(1));
  // deterministic colour per alliance id (sov overlay)
  function alliCol(id) {
    let h = 0; const s = String(id);
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffff;
    return `hsl(${h % 360} 60% 45%)`;
  }

  async function fetchJSON(path) {
    const res = await fetch(`${API}${path}`);
    if (!res.ok) {
      let d = `HTTP ${res.status}`;
      try { d = (await res.json()).detail || d; } catch (_) {}
      throw new Error(d);
    }
    return res.json();
  }

  function setStatus(msg, err) {
    const s = $id('map-status');
    if (s) { s.textContent = msg || ''; s.classList.toggle('map-err', !!err); }
  }

  // ---- data ----
  async function loadRegions() {
    const sel = $id('map-region');
    if (!sel || sel.options.length) return;
    const d = await fetchJSON('/api/map/regions');
    sel.innerHTML = d.regions
      .map((r) => `<option value="${esc(r.name)}">${esc(r.name)} (${r.count})</option>`).join('');
    if ([...sel.options].some((o) => o.value === 'The Forge')) sel.value = 'The Forge';
  }
  async function loadIndex() {
    if (st.index) return st.index;
    const d = await fetchJSON('/api/map/systems');
    st.index = d.systems;
    const byName = new Map();
    for (const s of d.systems) byName.set(s.name.toLowerCase(), s);
    st.indexByName = byName;
    const dl = $id('map-syslist');
    if (dl) dl.innerHTML = d.systems.map((s) => `<option value="${esc(s.name)}">`).join('');
    return d.systems;
  }

  async function ensureLive(force) {
    const fresh = st.live && (Date.now() - st.liveTs < 60000);
    if (fresh && !force) return st.live;
    setStatus('Loading live jumps / kills / sovereignty…');
    try {
      st.live = await fetchJSON('/api/map/live');
      st.liveTs = Date.now();
      const errs = ['jumps_error', 'kills_error', 'sov_error'].filter((k) => st.live[k]);
      setStatus(errs.length ? `Live loaded — ${errs.map((k) => k.replace('_error', '') + ': ' + st.live[k]).join('; ')}` : '');
    } catch (e) {
      setStatus(`Couldn't load live layers: ${e.message || e}`, true);
    }
    return st.live;
  }

  // ---- render ----
  async function showRegion(name, focusId) {
    if (!name) return;
    const sel = $id('map-region');
    if (sel && sel.value !== name) sel.value = name;
    setStatus(`Loading ${name}…`);
    try {
      st.layout = await fetchJSON(`/api/map/region/${encodeURIComponent(name)}`);
      st.region = name;
      renderMap();
      fitView();
      setStatus('');
      if (st.overlay !== 'none') applyOverlay();
      if (st.route) highlightRoute();
      if (focusId) { centerOn(focusId); selectSystem(focusId); }
    } catch (e) {
      setStatus(`Failed to load ${name}: ${e.message || e}`, true);
    }
  }

  function renderMap() {
    const root = $id('map-root');
    if (!root || !st.layout) return;
    const nodes = st.layout.layout ? st.layout.layout : st.layout;
    const sys = st.layout.systems;
    const byId = new Map(sys.map((s) => [String(s.id), s]));
    // edges first (under nodes)
    let edges = '';
    for (const [a, b] of st.layout.edges) {
      const s = byId.get(String(a)), d = byId.get(String(b));
      if (!s || !d) continue;
      edges += `<line class="me" x1="${s.x}" y1="${s.y}" x2="${d.x}" y2="${d.y}" />`;
    }
    let cells = '';
    for (const s of sys) {
      const w = 54, h = 20;
      cells += `<g class="mn${s.home ? '' : ' foreign'}" data-id="${s.id}" data-sec="${s.sec == null ? '' : s.sec}" transform="translate(${s.x},${s.y})">`
        + `<rect class="mn-box" x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="5" ry="5" style="fill:${secCol(s.sec)}" />`
        + `<text class="mn-t" x="0" y="1.5" text-anchor="middle">${esc(s.name)}</text>`
        + `</g>`;
    }
    root.innerHTML = `<g class="me-layer">${edges}</g><g class="mn-layer">${cells}</g>`;
    st.nodeEls = new Map();
    root.querySelectorAll('.mn').forEach((el) => st.nodeEls.set(el.dataset.id, el));
  }

  function bounds() {
    const sys = st.layout.systems;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of sys) { minX = Math.min(minX, s.x); minY = Math.min(minY, s.y); maxX = Math.max(maxX, s.x); maxY = Math.max(maxY, s.y); }
    return { minX: minX - 40, minY: minY - 30, maxX: maxX + 40, maxY: maxY + 30 };
  }
  function fitView() {
    const canvas = $id('map-canvas');
    if (!canvas || !st.layout) return;
    const cw = canvas.clientWidth || 800, ch = canvas.clientHeight || 600;
    const b = bounds();
    const w = Math.max(1, b.maxX - b.minX), h = Math.max(1, b.maxY - b.minY);
    const s = Math.min(cw / w, ch / h) * 0.96;
    st.view.s = s;
    st.view.tx = (cw - w * s) / 2 - b.minX * s;
    st.view.ty = (ch - h * s) / 2 - b.minY * s;
    applyTransform();
  }
  function applyTransform() {
    const root = $id('map-root');
    if (root) root.setAttribute('transform', `translate(${st.view.tx},${st.view.ty}) scale(${st.view.s})`);
  }
  function centerOn(id) {
    const s = st.layout.systems.find((x) => String(x.id) === String(id));
    const canvas = $id('map-canvas');
    if (!s || !canvas) return;
    st.view.s = Math.max(st.view.s, 1.4);
    st.view.tx = canvas.clientWidth / 2 - s.x * st.view.s;
    st.view.ty = canvas.clientHeight / 2 - s.y * st.view.s;
    applyTransform();
  }

  // ---- overlays ----
  function heat(v, max, hue) {
    const t = Math.min(1, Math.log2(1 + v) / Math.log2(1 + max));
    return `hsl(${hue} 85% ${20 + t * 45}%)`;
  }
  function applyOverlay() {
    const ov = st.overlay;
    const live = st.live || {};
    // reset
    st.nodeEls.forEach((el) => {
      const sec = el.dataset.sec === '' ? null : parseFloat(el.dataset.sec);
      const box = el.querySelector('.mn-box');
      box.style.fill = secCol(sec);
      box.style.stroke = ''; box.style.strokeWidth = '';
      el.classList.remove('mn-hot');
    });
    renderLegend(ov);
    if (ov === 'none') return;
    if (ov === 'sov') {
      st.nodeEls.forEach((el) => {
        const s = (live.sov || {})[el.dataset.id];
        const box = el.querySelector('.mn-box');
        if (s && s.alliance_id) box.style.fill = alliCol(s.alliance_id);
        else if (s && s.faction_id) box.style.fill = '#4a4a5a';
        else box.style.fill = '#2a2a2a';
      });
      return;
    }
    const pick = (id) => {
      if (ov === 'jumps') return (live.jumps || {})[id] || 0;
      const k = (live.kills || {})[id];
      if (!k) return 0;
      return ov === 'npc' ? k.npc : (k.ship + k.pod);
    };
    let max = 1;
    st.nodeEls.forEach((el) => { max = Math.max(max, pick(el.dataset.id)); });
    const hue = ov === 'jumps' ? 205 : (ov === 'npc' ? 40 : 0);
    st.nodeEls.forEach((el) => {
      const v = pick(el.dataset.id);
      const box = el.querySelector('.mn-box');
      if (v > 0) {
        box.style.fill = heat(v, max, hue);
        box.style.stroke = '#fff'; box.style.strokeWidth = '0.6';
        el.classList.add('mn-hot');
      } else {
        box.style.fill = '#232323';
      }
    });
  }
  function renderLegend(ov) {
    const el = $id('map-legend');
    if (!el) return;
    if (ov === 'none') {
      el.innerHTML = ['1.0', '0.5', '0.0', 'null'].map((v, i) => {
        const sec = [1.0, 0.5, 0.0, null][i];
        return `<span class="map-leg-i"><i style="background:${secCol(sec)}"></i>${v}</span>`;
      }).join('');
    } else if (ov === 'sov') {
      el.innerHTML = '<span class="map-leg-i">colour = sov holder · grey = NPC/none</span>';
    } else {
      const label = ov === 'jumps' ? 'ship jumps / hr' : (ov === 'npc' ? 'NPC kills / hr' : 'ship+pod kills / hr');
      el.innerHTML = `<span class="map-leg-i">${label} — brighter = more</span>`;
    }
  }

  // ---- selection / detail ----
  async function selectSystem(id) {
    st.selected = String(id);
    st.nodeEls.forEach((el, k) => el.classList.toggle('sel', k === st.selected));
    const panel = $id('map-detail');
    if (!panel) return;
    panel.hidden = false;
    panel.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const d = await fetchJSON(`/api/map/system/${id}`);
      await ensureLive(false);
      renderDetail(d);
    } catch (e) {
      panel.innerHTML = `<p class="muted">Couldn't load system: ${esc(String(e.message || e))}</p>`;
    }
  }
  function renderDetail(d) {
    const panel = $id('map-detail');
    const live = st.live || {};
    const jumps = (live.jumps || {})[d.id] || 0;
    const k = (live.kills || {})[d.id] || { ship: 0, npc: 0, pod: 0 };
    const sov = (live.sov || {})[d.id];
    const sovTxt = sov ? (sov.name || (sov.alliance_id ? `Alliance ${sov.alliance_id}` : (sov.faction_id ? `Faction ${sov.faction_id}` : '—'))) : '—';
    const adj = d.adjacent.map((n) => `<button class="map-adj" data-id="${n.id}" data-region="${esc(n.region || '')}" title="${esc(n.region || '')}">
        <i style="background:${secCol(n.sec)}"></i>${esc(n.name)} <span class="muted">${secTxt(n.sec)}</span></button>`).join('');
    panel.innerHTML = `
      <div class="map-detail-head">
        <strong>${esc(d.name)}</strong>
        <span class="map-sec" style="color:${secCol(d.sec)}">${secTxt(d.sec)}</span>
        <button class="map-detail-close" data-close title="Close">✕</button>
      </div>
      <div class="muted small">${esc(d.region || '')}</div>
      <div class="map-detail-stats">
        <div><span class="muted">Jumps/hr</span><b>${jumps.toLocaleString('en-US')}</b></div>
        <div><span class="muted">Ship kills</span><b>${(k.ship + k.pod).toLocaleString('en-US')}</b></div>
        <div><span class="muted">NPC kills</span><b>${k.npc.toLocaleString('en-US')}</b></div>
        <div><span class="muted">Sov</span><b title="${esc(sovTxt)}">${esc(sovTxt)}</b></div>
      </div>
      <div class="map-detail-adj-h muted small">Connected systems (${d.adjacent.length})</div>
      <div class="map-detail-adj">${adj || '<span class="muted">—</span>'}</div>
      <div class="map-detail-actions">
        <button class="secondary" data-route-from="${d.id}" title="Use as route start">Route from…</button>
        <button class="secondary" data-route-to="${d.id}" title="Use as route end">Route to…</button>
        <button class="linklike" data-ext-system="${esc(d.name)}">Dotlan ↗</button>
      </div>`;
  }

  // ---- route ----
  function openRoute() {
    const bar = $id('map-route-bar');
    if (bar) bar.hidden = !bar.hidden;
  }
  async function runRoute() {
    const from = ($id('map-route-from')?.value || '').trim();
    const to = ($id('map-route-to')?.value || '').trim();
    const pref = $id('map-route-pref')?.value || 'shortest';
    const info = $id('map-route-info');
    if (!from || !to) { if (info) info.textContent = 'Enter both systems.'; return; }
    if (info) info.textContent = 'Routing…';
    try {
      const r = await fetchJSON(`/api/map/route?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&prefer=${pref}`);
      if (r.error) { if (info) info.textContent = r.error; st.route = null; highlightRoute(); return; }
      st.route = r.systems.map((s) => String(s.id));
      if (info) info.textContent = `${r.jumps} jump${r.jumps === 1 ? '' : 's'}`;
      renderRouteList(r);
      // jump to the start system's region and highlight
      const start = r.systems[0];
      if (start && start.region && start.region !== st.region) await showRegion(start.region);
      else highlightRoute();
      if (start) centerOn(start.id);
    } catch (e) {
      if (info) info.textContent = `Route failed: ${e.message || e}`;
    }
  }
  function renderRouteList(r) {
    const panel = $id('map-detail');
    if (!panel) return;
    panel.hidden = false;
    const rows = r.systems.map((s, i) => `<button class="map-adj" data-id="${s.id}" data-region="${esc(s.region || '')}">
        <span class="muted">${i}.</span> <i style="background:${secCol(s.sec)}"></i>${esc(s.name)} <span class="muted">${secTxt(s.sec)} · ${esc(s.region || '')}</span></button>`).join('');
    panel.innerHTML = `
      <div class="map-detail-head"><strong>Route — ${r.jumps} jump${r.jumps === 1 ? '' : 's'}</strong>
        <button class="map-detail-close" data-close title="Close">✕</button></div>
      <div class="muted small">${esc(r.systems[0]?.name || '')} → ${esc(r.systems[r.systems.length - 1]?.name || '')} · ${esc(r.prefer || 'shortest')}</div>
      <div class="map-detail-adj map-route-list">${rows}</div>`;
  }
  function highlightRoute() {
    const set = new Set(st.route || []);
    const seq = st.route || [];
    st.nodeEls.forEach((el, id) => el.classList.toggle('on-route', set.has(id)));
    // draw route edges over the map
    const root = $id('map-root');
    root?.querySelectorAll('.route-edge').forEach((e) => e.remove());
    if (!seq.length || !st.layout) return;
    const byId = new Map(st.layout.systems.map((s) => [String(s.id), s]));
    const layer = document.createElementNS(SVGNS, 'g');
    layer.setAttribute('class', 'route-edge');
    for (let i = 0; i < seq.length - 1; i++) {
      const a = byId.get(seq[i]), b = byId.get(seq[i + 1]);
      if (!a || !b) continue;
      const ln = document.createElementNS(SVGNS, 'line');
      ln.setAttribute('x1', a.x); ln.setAttribute('y1', a.y);
      ln.setAttribute('x2', b.x); ln.setAttribute('y2', b.y);
      ln.setAttribute('class', 'mr');
      layer.appendChild(ln);
    }
    root.appendChild(layer);
  }
  function clearRoute() {
    st.route = null;
    const info = $id('map-route-info'); if (info) info.textContent = '';
    ['map-route-from', 'map-route-to'].forEach((id) => { const e = $id(id); if (e) e.value = ''; });
    st.nodeEls.forEach((el) => el.classList.remove('on-route'));
    $id('map-root')?.querySelectorAll('.route-edge').forEach((e) => e.remove());
  }

  // ---- pan / zoom ----
  function wirePanZoom() {
    const canvas = $id('map-canvas');
    const svg = $id('map-svg');
    if (!canvas || !svg || canvas.dataset.wired) return;
    canvas.dataset.wired = '1';
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const f = Math.exp(-e.deltaY * 0.0015);
      const ns = Math.max(0.15, Math.min(6, st.view.s * f));
      st.view.tx = mx - (mx - st.view.tx) * (ns / st.view.s);
      st.view.ty = my - (my - st.view.ty) * (ns / st.view.s);
      st.view.s = ns;
      applyTransform();
    }, { passive: false });
    let drag = null;
    canvas.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, tx: st.view.tx, ty: st.view.ty, moved: false };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      st.view.tx = drag.tx + dx; st.view.ty = drag.ty + dy;
      applyTransform();
    });
    canvas.addEventListener('pointerup', (e) => {
      const wasDrag = drag && drag.moved;
      drag = null;
      if (wasDrag) return;
      const g = e.target.closest && e.target.closest('.mn');
      if (g) selectSystem(g.dataset.id);
    });
    canvas.addEventListener('pointerleave', () => { drag = null; });
  }

  // ---- wiring ----
  function initTab() {
    wirePanZoom();
    if (!st.loaded) {
      st.loaded = true;
      Promise.all([loadRegions(), loadIndex()])
        .then(() => showRegion(($id('map-region')?.value) || 'The Forge'))
        .catch((e) => setStatus(`Failed to load map data: ${e.message || e}`, true));
      wireControls();
    } else if (st.layout) {
      fitView();
    }
  }

  function wireControls() {
    $id('map-region')?.addEventListener('change', (e) => showRegion(e.target.value));
    $id('map-refresh')?.addEventListener('click', () => ensureLive(true).then(() => { if (st.overlay !== 'none') applyOverlay(); if (st.selected) selectSystem(st.selected); }));
    $id('map-route-btn')?.addEventListener('click', openRoute);
    $id('map-route-go')?.addEventListener('click', runRoute);
    $id('map-route-clear')?.addEventListener('click', clearRoute);
    $id('map-route-from')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') runRoute(); });
    $id('map-route-to')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') runRoute(); });
    document.querySelectorAll('.map-ov').forEach((b) => b.addEventListener('click', async () => {
      document.querySelectorAll('.map-ov').forEach((x) => x.classList.toggle('on', x === b));
      st.overlay = b.dataset.ov;
      if (st.overlay !== 'none' && (!st.live || Date.now() - st.liveTs > 60000)) await ensureLive(false);
      applyOverlay();
    }));
    const search = $id('map-search');
    search?.addEventListener('change', () => {
      const v = (search.value || '').trim().toLowerCase();
      if (!v || !st.indexByName) return;
      const sys = st.indexByName.get(v);
      if (sys) { showRegion(sys.region, sys.id); search.value = ''; }
      else setStatus(`No system named "${search.value}".`, true);
    });
    // detail panel + adjacency (delegated)
    $id('map-detail')?.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) { const p = $id('map-detail'); if (p) { p.hidden = true; } st.selected = null; st.nodeEls.forEach((el) => el.classList.remove('sel')); return; }
      const adj = e.target.closest('.map-adj');
      if (adj) {
        const region = adj.dataset.region;
        if (region && region !== st.region) showRegion(region, adj.dataset.id);
        else { centerOn(adj.dataset.id); selectSystem(adj.dataset.id); }
        return;
      }
      const rf = e.target.closest('[data-route-from]');
      if (rf) { const bar = $id('map-route-bar'); if (bar) bar.hidden = false; const el = $id('map-route-from'); if (el) el.value = nameOf(rf.dataset.routeFrom); return; }
      const rt = e.target.closest('[data-route-to]');
      if (rt) { const bar = $id('map-route-bar'); if (bar) bar.hidden = false; const el = $id('map-route-to'); if (el) el.value = nameOf(rt.dataset.routeTo); return; }
      const ex = e.target.closest('[data-ext-system]');
      if (ex && window.api && window.api.openExternal) window.api.openExternal(`https://evemaps.dotlan.net/system/${encodeURIComponent(ex.dataset.extSystem)}`);
    });
    $id('map-open-dotlan')?.addEventListener('click', () => {
      if (window.api && window.api.openExternal) {
        const url = st.region ? `https://evemaps.dotlan.net/map/${encodeURIComponent(st.region.replace(/ /g, '_'))}` : 'https://evemaps.dotlan.net';
        window.api.openExternal(url);
      }
    });
    let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (st.layout && isVisible()) fitView(); }, 150); });
  }
  function nameOf(id) { const s = (st.index || []).find((x) => String(x.id) === String(id)); return s ? s.name : id; }
  function isVisible() { const el = $id('tab-dotlan'); return el && el.offsetParent !== null; }

  document.querySelector('.tab-btn[data-tab="dotlan"]')?.addEventListener('click', initTab);
})();
