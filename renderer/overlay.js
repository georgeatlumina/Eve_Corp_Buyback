'use strict';

// ================= SMT intel overlay =================
// The transparent always-on-top companion to the SMT Intel Map: it draws the
// systems within N jumps of wherever you are as rings around you, and lights
// them up as intel reports and kills land — so you can keep it over the EVE
// client and see how far out the hostiles are without alt-tabbing.
//
// Origin = your first online SMT-authed character (Follow), or a system you
// pin by hand. Topology comes from /api/smt/overlay; the live layers are the
// same /api/smt/intel + /api/smt/kills feeds the Intel Map polls, read here
// with this window's own cursors.

(function () {
  const ovApi = window.overlayApi || {};
  const API = ovApi.base || 'http://127.0.0.1:8766';
  const SVGNS = 'http://www.w3.org/2000/svg';
  const DECAY = 10 * 60 * 1000;   // intel/kill markers fully fade after 10 min
  const RING = 100;               // user units between jump rings

  const st = {
    prefs: null,
    origin: null, systems: [], edges: [], pos: new Map(), jumpsOf: new Map(),
    intel: new Map(), kills: new Map(), feed: [],
    intelSince: 0, killSince: 0,
    chars: [], charSys: null, watching: null,
    clickThrough: false, hoverUi: false, loadKey: null, err: '',
    alertJumps: new Map(), alertKey: null,
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function secCol(sec) {
    if (sec == null) return '#6f1a1a';
    if (sec >= 0.85) return '#3d9be0'; if (sec >= 0.65) return '#48d84a';
    if (sec >= 0.45) return '#e5e52f'; if (sec >= 0.25) return '#e88a26';
    if (sec > 0) return '#d63a1e'; return '#8b1a1a';
  }
  async function j(path) {
    const r = await fetch(`${API}${path}`);
    if (!r.ok) { let d = `HTTP ${r.status}`; try { d = (await r.json()).detail || d; } catch (_) {} throw new Error(d); }
    return r.json();
  }
  const savePrefs = (patch) => { Object.assign(st.prefs, patch); if (ovApi.save) ovApi.save(patch); };

  // ---- topology ----------------------------------------------------------
  // Refetch only when the origin or the jump range actually changes; the layers
  // poll far more often than either of those move.
  async function loadMap(force) {
    const target = st.prefs.follow ? st.charSys : st.prefs.system;
    if (!target) { st.origin = null; st.systems = []; st.edges = []; render(); return; }
    const key = `${target}|${st.prefs.jumps}`;
    if (!force && key === st.loadKey) return;
    st.loadKey = key;
    try {
      const d = await j(`/api/smt/overlay?system=${encodeURIComponent(target)}&jumps=${st.prefs.jumps}`);
      if (d.error) { st.err = d.error; st.origin = null; st.systems = []; st.edges = []; render(); return; }
      st.err = '';
      st.origin = d.origin; st.systems = d.systems || []; st.edges = d.edges || [];
      st.jumpsOf = new Map(st.systems.map((s) => [String(s.id), s.jumps]));
      layout();
      render();
      refreshAlertRange();
    } catch (e) {
      st.err = `Sidecar unreachable: ${e.message || e}`;
      st.loadKey = null;   // retry on the next tick
      render();
    }
  }

  // Radial layout: the origin at the centre, one ring per jump of distance.
  // Within a ring, systems are ordered by the angle of the neighbours that
  // reached them (so branches stay together) and then spread evenly, which
  // keeps the web readable without any collision resolution.
  function layout() {
    st.pos = new Map();
    if (!st.origin) return;
    const nb = new Map();
    for (const [a, b] of st.edges) {
      nb.set(String(a), (nb.get(String(a)) || new Set()).add(String(b)));
      nb.set(String(b), (nb.get(String(b)) || new Set()).add(String(a)));
    }
    const byDepth = new Map();
    for (const s of st.systems) {
      if (!byDepth.has(s.jumps)) byDepth.set(s.jumps, []);
      byDepth.get(s.jumps).push(s);
    }
    st.pos.set(String(st.origin.id), { x: 0, y: 0, a: 0 });
    const maxD = st.systems.reduce((m, s) => Math.max(m, s.jumps), 0);
    for (let d = 1; d <= maxD; d++) {
      const ring = byDepth.get(d) || [];
      for (const s of ring) {
        // Only shallower systems are placed at this point, so every hit here is
        // a system that reached this one — its parents.
        let sx = 0, sy = 0;
        for (const id of (nb.get(String(s.id)) || [])) {
          const p = st.pos.get(id);
          if (p) { sx += Math.cos(p.a); sy += Math.sin(p.a); }
        }
        s._a = (sx || sy) ? Math.atan2(sy, sx) : 0;
      }
      ring.sort((x, y) => x._a - y._a || String(x.name).localeCompare(String(y.name)));
      const n = ring.length || 1;
      const base = ring.length ? ring[0]._a : 0;
      ring.forEach((s, i) => {
        const a = base + (2 * Math.PI * i) / n;
        st.pos.set(String(s.id), { x: Math.cos(a) * d * RING, y: Math.sin(a) * d * RING, a });
      });
    }
  }

  function render() {
    const svg = $('ov-svg'), root = $('ov-root'), empty = $('ov-empty');
    if (!svg || !root) return;
    if (!st.origin) {
      root.innerHTML = '';
      empty.textContent = st.err || (st.prefs.follow
        ? 'Nothing to follow — auth a character under Auth → SMT Characters, or type a system above to pin one.'
        : 'Type a system above to pin it, or hit ⌖ to follow your character.');
      updateBar();
      return;
    }
    empty.textContent = '';
    const maxD = st.systems.reduce((m, s) => Math.max(m, s.jumps), 0) || 1;
    const R = (maxD + 0.65) * RING;
    const U = R / 20;        // label size, so text keeps its on-screen size
    const NR = R / 85;       // node radius
    svg.setAttribute('viewBox', `${-R} ${-R} ${2 * R} ${2 * R}`);

    let rings = '';
    for (let d = 1; d <= maxD; d++) {
      rings += `<circle class="ov-ring" cx="0" cy="0" r="${d * RING}" stroke-width="${U / 14}" />`
        + `<text class="ov-ring-lbl" x="0" y="${-d * RING + U * 0.5}" font-size="${U * 0.75}">${d}</text>`;
    }
    let edges = '';
    for (const [a, b, kind] of st.edges) {
      const p = st.pos.get(String(a)), q = st.pos.get(String(b));
      if (p && q) {
        edges += `<line class="ov-edge${kind === 'bridge' ? ' bridge' : ''}" x1="${p.x.toFixed(1)}" y1="${p.y.toFixed(1)}"`
          + ` x2="${q.x.toFixed(1)}" y2="${q.y.toFixed(1)}" stroke-width="${U / 12}" />`;
      }
    }
    const chars = new Set(st.chars.filter((c) => c.online && c.system_id).map((c) => String(c.system_id)));
    let nodes = '';
    for (const s of st.systems) {
      const p = st.pos.get(String(s.id));
      if (!p) continue;
      const home = String(s.id) === String(st.origin.id);
      nodes += `<g class="ov-node${home ? ' home' : ''}" data-id="${s.id}" data-name="${esc(s.name)}"`
        + ` transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})">`
        + `<title>${esc(s.name)} · ${s.jumps}j · ${s.sec == null ? '?' : s.sec.toFixed(1)} · ${esc(s.region || '')}</title>`
        + `<circle class="ov-halo" r="0" />`
        + `<circle class="ov-pulse" r="${(NR * 2.6).toFixed(1)}" stroke-width="${(U / 9).toFixed(1)}" />`
        + (home ? `<circle class="ov-ringmk" r="${NR * 2.1}" stroke-width="${U / 11}" />` : '')
        + `<circle class="ov-dot" r="${NR}" style="fill:${secCol(s.sec)}" stroke-width="${U / 22}" />`
        + (chars.has(String(s.id)) && !home ? `<circle class="ov-chr" cx="${NR * 1.6}" cy="${-NR * 1.6}" r="${NR * 0.7}" />` : '')
        + (st.prefs.labels ? `<text class="ov-lbl" y="${-NR * 1.9}" font-size="${U * 0.8}"`
          + ` fill-opacity="${(1 - 0.5 * (s.jumps / maxD)).toFixed(2)}">${esc(s.name)}</text>` : '')
        + `</g>`;
    }
    root.innerHTML = `<g>${rings}</g><g>${edges}</g><g>${nodes}</g>`;
    applyLayers();
    updateBar();
  }

  // ---- live layers -------------------------------------------------------
  async function pollLayers() {
    try {
      const d = await j(`/api/smt/intel?since=${st.intelSince}`);
      st.intelSince = d.ts;
      st.watching = d.watching;
      for (const e of d.events) {
        for (const sid of e.systems) st.intel.set(String(sid), { ts: e.ts * 1000, clear: e.clear });
        st.feed.unshift(e);
      }
      if (st.feed.length > 60) st.feed.length = 60;
      SmtAlerts.intel(d.events, st.alertJumps);
      if (d.events.length) renderFeed();
    } catch (_) { /* transient — the tick keeps decaying what we have */ }
    try {
      const d = await j(`/api/smt/kills?since=${st.killSince}`);
      st.killSince = d.ts;
      for (const k of d.kills) st.kills.set(String(k.system_id), { ts: k.ts * 1000, value: k.value });
      SmtAlerts.kills(d.kills, st.alertJumps);
    } catch (_) { /* transient */ }
    applyLayers();
  }

  // Fade every marker by age, and surface the closest live hostile report as
  // the toolbar's warning badge — the one number worth glancing at mid-fight.
  function applyLayers() {
    const now = Date.now();
    let nearest = null;
    document.querySelectorAll('#ov-root .ov-node').forEach((el) => {
      const id = el.dataset.id;
      const halo = el.querySelector('.ov-halo');
      const iv = st.intel.get(id), kv = st.kills.get(id);
      const R = Number(el.closest('svg').viewBox.baseVal.width) / 2 || 560;
      let r = 0, fill = 'transparent', op = 0, flash = 'none';
      if (iv) {
        const t = Math.max(0, 1 - (now - iv.ts) / DECAY);
        if (t > 0) {
          r = R / 42 + t * (R / 28); op = 0.15 + t * 0.55;
          // Hostile reports take the colour (and flash) of the distance tier
          // they fall into; a "clr" is always the same calm green.
          const tier = iv.clear ? null : SmtAlerts.tierFor(st.jumpsOf.get(id));
          fill = iv.clear ? '#3ad07a' : ((tier && tier.colour) || '#ff3b3b');
          if (tier && tier.flash) flash = tier.flash;
          if (!iv.clear) {
            const jm = st.jumpsOf.get(id);
            if (jm != null && (nearest == null || jm < nearest)) nearest = jm;
          }
        }
      }
      if (!r && kv) {
        const t = Math.max(0, 1 - (now - kv.ts) / DECAY);
        if (t > 0) { r = R / 48 + t * (R / 42); op = 0.12 + t * 0.4; fill = '#f0a020'; }
      }
      halo.setAttribute('r', r.toFixed(1));
      halo.style.fill = fill;
      halo.style.fillOpacity = op;
      el.classList.toggle('hot', r > 0);
      el.classList.toggle('flash-slow', flash === 'slow');
      el.classList.toggle('flash-fast', flash === 'fast');
      if (flash !== 'none') el.style.setProperty('--pulse', fill);
    });
    const warn = $('ov-warn');
    if (warn) {
      warn.hidden = nearest == null;
      warn.textContent = nearest == null ? '' : (nearest === 0 ? '⚠ HERE' : `⚠ ${nearest}j`);
      const tier = nearest == null ? null : SmtAlerts.tierFor(nearest);
      warn.style.color = (tier && tier.colour) || '';
      warn.style.borderColor = (tier && tier.colour) || '';
    }
  }

  // The ticker only shows reports for systems inside the current range —
  // everything else is noise when you're watching one pocket.
  function renderFeed() {
    const box = $('ov-feed');
    if (!box) return;
    box.hidden = !st.prefs.feed;
    if (!st.prefs.feed) return;
    const rows = [];
    for (const e of st.feed) {
      const idx = (e.systems || []).findIndex((sid) => st.jumpsOf.has(String(sid)));
      if (idx < 0) continue;
      const sid = String(e.systems[idx]);
      rows.push({ e, name: (e.system_names || [])[idx] || sid, jumps: st.jumpsOf.get(sid) });
      if (rows.length >= 8) break;
    }
    if (!rows.length) {
      box.innerHTML = st.watching === false
        ? '<span class="muted">No intel channels watched — set them up in the SMT tab (⚙ Logs).</span>'
        : '<span class="muted">No intel in range.</span>';
      return;
    }
    box.innerHTML = rows.map(({ e, name, jumps }) => {
      const t = new Date(e.ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `<div class="ov-row${e.clear ? ' clear' : ''}"><span class="t">${t}</span>`
        + `<span class="sys">${esc(name)}</span><span class="d">${jumps}j</span>`
        + `<span class="txt">${esc(e.text)}</span></div>`;
    }).join('');
  }

  // ---- intel alarm -------------------------------------------------------
  // Settings come from the sidecar, shared with the Intel Map tab. While this
  // window is open it owns the alarm, so nothing sounds twice.
  async function loadAlerts() {
    try { SmtAlerts.setConfig(await j('/api/smt/alerts')); } catch (_) { /* defaults stand */ }
    SmtAlerts.setMuted(!!st.prefs.muted);
    st.alertKey = null;
    refreshAlertRange();
    updateBar();
  }
  // The alarm's range is set independently of how far the map is drawn, so it
  // needs its own distance map rather than reusing the drawn one.
  async function refreshAlertRange() {
    const a = SmtAlerts.config();
    const reach = SmtAlerts.reach();
    if (!a.enabled || reach < 0 || !st.origin) { st.alertJumps = new Map(); st.alertKey = null; return; }
    const key = `${st.origin.id}|${reach}`;
    if (key === st.alertKey) return;
    st.alertKey = key;
    try {
      const d = await j(`/api/smt/overlay?system=${st.origin.id}&jumps=${Math.max(1, reach)}`);
      st.alertJumps = d.error ? new Map() : new Map((d.systems || []).map((x) => [String(x.id), x.jumps]));
    } catch (_) { st.alertKey = null; }
  }

  // ---- characters --------------------------------------------------------
  async function pollChars() {
    try {
      const d = await j('/api/smt/characters');
      st.chars = d.characters || [];
      const live = st.chars.find((c) => c.online && c.system_id) || st.chars.find((c) => c.system_id);
      const sys = live && live.system_id ? String(live.system_id) : null;
      if (sys !== st.charSys) {
        st.charSys = sys;
        if (st.prefs.follow) { loadMap(); return; }
      }
      if (st.prefs.follow && !st.origin) loadMap();
      render();
    } catch (_) { /* transient */ }
  }

  function updateBar() {
    const home = $('ov-home');
    if (home) {
      home.textContent = st.origin ? st.origin.name : (st.prefs.follow ? 'No character' : 'No system');
      home.title = st.origin ? `${st.origin.name} · ${st.origin.region || ''} — click to re-centre` : 'Pick a system to watch';
    }
    document.querySelectorAll('.ov-j').forEach((b) => b.classList.toggle('on', Number(b.dataset.j) === st.prefs.jumps));
    $('ov-follow').classList.toggle('on', !!st.prefs.follow);
    $('ov-labels').classList.toggle('on', !!st.prefs.labels);
    $('ov-feed-t').classList.toggle('on', !!st.prefs.feed);
    $('ov-pin').classList.toggle('on', !!st.prefs.alwaysOnTop);
    $('ov-click').classList.toggle('on', !!st.clickThrough);
    const mute = $('ov-mute');
    const alarm = SmtAlerts.config();
    mute.classList.toggle('muted', !!st.prefs.muted || !alarm.enabled);
    mute.textContent = (st.prefs.muted || !alarm.enabled) ? '🔕' : '🔔';
    mute.title = !alarm.enabled ? 'Intel alarm is switched off in the SMT tab'
      : st.prefs.muted ? 'Intel alarm muted — click to unmute' : 'Intel alarm on — click to mute';
    // Following with nothing to follow would otherwise hide the only way out.
    $('ov-pin-row').hidden = !!st.prefs.follow && !!st.origin;
  }

  async function pinSystem(name) {
    const errEl = $('ov-sys-err');
    const v = (name || '').trim();
    if (!v) return;
    try {
      const d = await j(`/api/smt/overlay?system=${encodeURIComponent(v)}&jumps=${st.prefs.jumps}`);
      if (d.error) { errEl.textContent = 'Unknown system'; return; }
      errEl.textContent = '';
      savePrefs({ system: String(d.origin.id), follow: false });
      st.loadKey = null;
      loadMap();
    } catch (e) { errEl.textContent = e.message || String(e); }
  }

  function wire() {
    document.querySelectorAll('.ov-j').forEach((b) => b.addEventListener('click', () => {
      savePrefs({ jumps: Number(b.dataset.j) });
      loadMap();
      updateBar();
    }));
    $('ov-follow').addEventListener('click', () => {
      savePrefs({ follow: !st.prefs.follow });
      loadMap();
      updateBar();
    });
    $('ov-labels').addEventListener('click', () => { savePrefs({ labels: !st.prefs.labels }); render(); });
    $('ov-feed-t').addEventListener('click', () => { savePrefs({ feed: !st.prefs.feed }); renderFeed(); updateBar(); });
    $('ov-pin').addEventListener('click', () => {
      savePrefs({ alwaysOnTop: !st.prefs.alwaysOnTop });
      if (ovApi.setAlwaysOnTop) ovApi.setAlwaysOnTop(st.prefs.alwaysOnTop);
      updateBar();
    });
    $('ov-click').addEventListener('click', () => {
      st.clickThrough = !st.clickThrough;
      if (ovApi.setClickThrough) ovApi.setClickThrough(st.clickThrough);
      updateBar();
    });
    $('ov-op').addEventListener('input', (e) => {
      const v = Number(e.target.value);
      st.prefs.opacity = v;
      if (ovApi.setOpacity) ovApi.setOpacity(v);
    });
    $('ov-mute').addEventListener('click', () => {
      savePrefs({ muted: !st.prefs.muted });
      SmtAlerts.setMuted(!!st.prefs.muted);
      if (!st.prefs.muted) SmtAlerts.test(0);   // confirm it's audible
      updateBar();
    });
    $('ov-close').addEventListener('click', () => { if (ovApi.close) ovApi.close(); });
    $('ov-home').addEventListener('click', () => { st.loadKey = null; loadMap(true); });
    $('ov-sys').addEventListener('change', (e) => pinSystem(e.target.value));
    $('ov-sys').addEventListener('keydown', (e) => { if (e.key === 'Enter') pinSystem(e.target.value); });
    // Click a system to watch that pocket instead (drops out of follow).
    $('ov-svg').addEventListener('click', (e) => {
      const n = e.target.closest && e.target.closest('.ov-node');
      if (!n) return;
      savePrefs({ system: n.dataset.id, follow: false });
      st.loadKey = null;
      loadMap();
    });
    // While click-through is on the window ignores the mouse, which would also
    // swallow these controls — so hand hit-testing back as the pointer crosses
    // any interactive strip, and drop it again on the way out.
    document.addEventListener('mousemove', (e) => {
      if (!st.clickThrough || !ovApi.hoverUi) return;
      const over = !!(e.target.closest && e.target.closest('.ov-hit'));
      if (over !== st.hoverUi) { st.hoverUi = over; ovApi.hoverUi(over); }
    });
    if (ovApi.onClickThrough) ovApi.onClickThrough((on) => { st.clickThrough = on; updateBar(); });
    if (ovApi.onAlertsChanged) ovApi.onAlertsChanged(() => loadAlerts().then(applyLayers));
    let rz;
    window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(render, 150); });
  }

  async function init() {
    st.prefs = (ovApi.getState ? await ovApi.getState() : null)
      || { jumps: 5, opacity: 0.9, labels: true, feed: true, follow: true, system: '', alwaysOnTop: true, clickThrough: false };
    st.clickThrough = !!st.prefs.clickThrough;
    $('ov-op').value = st.prefs.opacity;
    wire();
    updateBar();
    await loadAlerts();
    await pollChars();
    await loadMap();
    pollLayers();
    renderFeed();
    setInterval(pollLayers, 4000);
    setInterval(pollChars, 10000);
    setInterval(loadAlerts, 30000);
    setInterval(() => { applyLayers(); renderFeed(); }, 2000);
    // Cheap self-heal: if the sidecar was down (or the origin never resolved),
    // keep trying rather than sitting on an error until the window is reopened.
    setInterval(() => { if (!st.origin) loadMap(true); }, 15000);
  }

  init();
})();
