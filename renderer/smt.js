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
    intelSince: 0, killSince: 0, ov: { intel: true, kills: true },
    follow: false, loaded: false, poll: null, tick: null,
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
    document.querySelectorAll('.smt-ov').forEach((b) => b.addEventListener('click', () => { b.classList.toggle('on'); st.ov[b.dataset.ov] = b.classList.contains('on'); applyLayers(); }));
    $id('smt-follow')?.addEventListener('change', (e) => { st.follow = e.target.checked; });
    $id('smt-config-btn')?.addEventListener('click', () => { const c = $id('smt-config'); if (c) { c.hidden = !c.hidden; if (!c.hidden) loadConfig(); } });
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
      loadConfig();
      pollLayers();
      st.poll = setInterval(() => { const p = $id('tab-smt-intel'); if (p && p.offsetParent !== null) pollLayers(); }, 4000);
      st.tick = setInterval(() => { const p = $id('tab-smt-intel'); if (p && p.offsetParent !== null) applyLayers(); }, 1000);
    } else if (st.layout) { fitView(); }
  }

  document.querySelector('.tab-btn[data-tab="smt-intel"]')?.addEventListener('click', initTab);
})();
