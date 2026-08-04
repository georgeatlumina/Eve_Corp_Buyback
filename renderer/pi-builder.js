'use strict';

// ===================== PI Colony Layout Builder =====================
// General tab. A realistic rotatable planet (orthographic view of a sphere) on
// which you place command centers / extractors / factories / storage /
// launchpads at real lat/lon, link them, and watch the CPU/Powergrid budget.
// Load existing colonies from — and save importable templates straight to —
// the EVE client's PlanetaryInteractionTemplates folder.
// Backed by /api/pi/pins, /api/pi/data, /api/pi/templates*.
// Reuses app.js globals (API, $, escapeHtml).

(function () {
  const R = 230;                 // planet radius in px
  const PLANET_TYPE_ID = { Temperate: 11, Ice: 12, Gas: 13, Oceanic: 2014, Lava: 2015, Barren: 2016, Storm: 2017, Plasma: 2063 };
  const ID_PLANET_TYPE = Object.fromEntries(Object.entries(PLANET_TYPE_ID).map(([k, v]) => [v, k]));
  const PLANET_COLORS = {
    Barren: ['#b79b6e', '#5c4a2c'], Gas: ['#d9b24a', '#6b5310'], Ice: ['#bfe3f2', '#4a7d92'],
    Lava: ['#e0632c', '#6e1e0c'], Oceanic: ['#3d84c6', '#123a63'], Plasma: ['#c85ac8', '#5a1a5a'],
    Storm: ['#4bb0a6', '#134b46'], Temperate: ['#5fa85a', '#1f4d2c'],
  };
  const KIND_COLOR = {
    command_center: '#e0b060', extractor: '#4aa3df', factory: '#7fd07f',
    storage: '#c9a0e0', launchpad: '#e07f7f',
  };
  const KIND_LABEL = { command_center: 'CC', extractor: 'ECU', factory: 'FAC', storage: 'STO', launchpad: 'LP' };

  let pinsData = null;   // /api/pi/pins
  let piTypes = null;    // /api/pi/data types map (for schematic/commodity names)
  let model = null;      // current colony
  let view = { theta0: 1.4, phi0: 0.8, zoom: 1 };   // camera direction (colat, azimuth) + magnification
  let tool = 'select';   // 'select' or a pin type_id string to place
  let sel = null;        // selected pin index
  let linkFrom = null;   // pin index awaiting a link target
  let initialised = false;

  // ---------- vector helpers (unit sphere; EVE La=colatitude, Lo=azimuth) ----------
  const V = {
    fromSph: (th, ph) => [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    norm: (a) => { const m = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / m, a[1] / m, a[2] / m]; },
    add: (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s],
  };

  function camera() {
    const fwd = V.fromSph(view.theta0, view.phi0);
    let right = V.cross([0, 0, 1], fwd);
    if (Math.hypot(right[0], right[1], right[2]) < 1e-6) right = [1, 0, 0];
    right = V.norm(right);
    const up = V.norm(V.cross(fwd, right));
    return { fwd, right, up };
  }

  // sphere point -> screen; visible when facing the camera and inside the disc.
  function project(th, ph, cam) {
    const v = V.fromSph(th, ph);
    const front = V.dot(v, cam.fwd);
    const x = R * view.zoom * V.dot(v, cam.right);
    const y = -R * view.zoom * V.dot(v, cam.up);
    return { x, y, visible: front > 0 && (x * x + y * y) <= R * R };
  }
  // screen (disc-relative px) -> sphere (colat, azimuth), or null if off-disc.
  function unproject(px, py, cam) {
    const sx = px / (R * view.zoom), sy = -py / (R * view.zoom);
    const r2 = sx * sx + sy * sy;
    if (r2 > 1) return null;
    const v = V.add(V.add([0, 0, 0], cam.right, sx), cam.up, sy);
    const vv = V.add(v, cam.fwd, Math.sqrt(1 - r2));
    const th = Math.acos(Math.max(-1, Math.min(1, vv[2])));
    let ph = Math.atan2(vv[1], vv[0]); if (ph < 0) ph += 2 * Math.PI;
    return { th, ph };
  }

  function greatCircleKm(a, b) {
    const va = V.fromSph(a.lat, a.lon), vb = V.fromSph(b.lat, b.lon);
    const ang = Math.acos(Math.max(-1, Math.min(1, V.dot(va, vb))));
    return (model.diameter / 2) * ang;
  }

  // ------------------------------- data -------------------------------
  async function loadStatic() {
    if (pinsData && piTypes) return;
    const [p, d] = await Promise.all([
      fetch(`${API}/api/pi/pins`).then((r) => r.json()),
      fetch(`${API}/api/pi/data`).then((r) => r.json()),
    ]);
    pinsData = p; piTypes = d.types;
  }
  function pin(typeId) { return pinsData.pins[String(typeId)] || {}; }
  function commodityName(id) { return (piTypes[String(id)] || {}).name || (pin(id).name) || `#${id}`; }

  function emptyModel(planetType) {
    return {
      planet_type_id: PLANET_TYPE_ID[planetType], diameter: 5000.0, cmd_ctr_level: 1,
      comment: `${planetType} colony`, pins: [], links: [], routes: [],
    };
  }

  // command center / factory / etc. type id for the current planet + kind
  function pinTypeFor(kind, planetType) {
    if (kind === 'command_center') return pinsData.command_centers[planetType];
    for (const [id, r] of Object.entries(pinsData.pins)) {
      if (r.kind === kind && r.planet_type === planetType && (kind !== 'factory' || r.tier === 'basic')) return +id;
    }
    return null;
  }

  // ---------------------------- rendering ----------------------------
  function planetType() { return ID_PLANET_TYPE[model.planet_type_id]; }

  function render() {
    const svg = $('#pib-svg');
    if (!svg || !model) return;
    const cam = camera();
    const pt = planetType();
    const [c1, c2] = PLANET_COLORS[pt] || ['#888', '#333'];
    const cx = R + 20, cy = R + 20;

    const parts = [`<defs><radialGradient id="pib-globe" cx="38%" cy="34%" r="72%">
      <stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/></radialGradient></defs>`];
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${R}" fill="url(#pib-globe)" stroke="#0a0a0a" stroke-width="2"/>`);

    // graticule (a few meridians/parallels on the visible hemisphere)
    for (let lat = 30; lat < 180; lat += 30) {
      let d = '';
      for (let lon = 0; lon <= 360; lon += 6) {
        const p = project(lat * Math.PI / 180, lon * Math.PI / 180, cam);
        d += (p.visible ? (d && !d.endsWith('M') ? 'L' : 'M') : 'M') + (cx + p.x).toFixed(1) + ' ' + (cy + p.y).toFixed(1) + ' ';
      }
      parts.push(`<path d="${d}" fill="none" stroke="#ffffff14" stroke-width="1"/>`);
    }

    // links
    for (const l of model.links) {
      const a = pinAt(l.a), b = pinAt(l.b);
      if (!a || !b) continue;
      const pa = project(a.lat, a.lon, cam), pb = project(b.lat, b.lon, cam);
      if (!pa.visible && !pb.visible) continue;
      parts.push(`<line x1="${cx + pa.x}" y1="${cy + pa.y}" x2="${cx + pb.x}" y2="${cy + pb.y}" stroke="#ffd27f66" stroke-width="1.5"/>`);
    }

    // pins
    model.pins.forEach((p, i) => {
      const pr = project(p.lat, p.lon, cam);
      if (!pr.visible) return;
      const r = pin(p.type_id);
      const col = KIND_COLOR[r.kind] || '#ccc';
      const selRing = i === sel ? `<circle cx="${cx + pr.x}" cy="${cy + pr.y}" r="11" fill="none" stroke="#fff" stroke-width="2"/>` : '';
      const fromRing = i === linkFrom ? `<circle cx="${cx + pr.x}" cy="${cy + pr.y}" r="13" fill="none" stroke="#4af" stroke-width="2" stroke-dasharray="3 2"/>` : '';
      parts.push(`<g class="pib-pin" data-i="${i}" style="cursor:pointer">
        <circle cx="${cx + pr.x}" cy="${cy + pr.y}" r="8" fill="${col}" stroke="#111" stroke-width="1.5"/>
        <text x="${cx + pr.x}" y="${cy + pr.y + 3}" text-anchor="middle" font-size="7" fill="#111" font-weight="700">${KIND_LABEL[r.kind] || '?'}</text>
        ${selRing}${fromRing}</g>`);
    });

    svg.innerHTML = parts.join('');
    renderBudget();
    renderSelection();
  }

  function pinAt(idx) { return idx === 'cc' ? null : model.pins[idx]; }

  function budget() {
    const lv = pinsData.command_center_levels[model.cmd_ctr_level] || { powergrid: 0, cpu: 0 };
    let pg = 0, cpu = 0;
    for (const p of model.pins) {
      const r = pin(p.type_id);
      pg += r.power_load || 0; cpu += r.cpu_load || 0;
    }
    // Link cost (level-0 links): CPU = 15 + 0.2*km, PG = 10 + 0.15*km per link.
    let linkPg = 0, linkCpu = 0, nLinks = 0;
    for (const l of model.links) {
      const a = pinAt(l.a), b = pinAt(l.b);
      if (!a || !b) continue;
      const km = greatCircleKm(a, b);
      linkCpu += 15 + 0.2 * km; linkPg += 10 + 0.15 * km; nLinks += 1;
    }
    return {
      provPg: lv.powergrid, provCpu: lv.cpu,
      usedPg: Math.round(pg + linkPg), usedCpu: Math.round(cpu + linkCpu),
      pinPg: pg, pinCpu: cpu, linkPg: Math.round(linkPg), linkCpu: Math.round(linkCpu), links: nLinks,
    };
  }

  function bar(label, used, prov) {
    const pct = prov ? Math.min(100, (used / prov) * 100) : 0;
    const over = used > prov;
    return `<div class="pib-bar-row"><span class="pib-bar-label">${label}</span>
      <span class="pib-bar"><span class="pib-bar-fill ${over ? 'pib-over' : ''}" style="width:${pct}%"></span></span>
      <span class="pib-bar-num ${over ? 'pib-over-t' : ''}">${used.toLocaleString('en-US')} / ${prov.toLocaleString('en-US')}</span></div>`;
  }

  function renderBudget() {
    const b = budget();
    $('#pib-budget').innerHTML =
      bar('CPU', b.usedCpu, b.provCpu) + bar('Powergrid', b.usedPg, b.provPg) +
      `<div class="muted pib-budget-note">${model.pins.length} pins (${b.pinCpu.toLocaleString('en-US')} CPU / ${b.pinPg.toLocaleString('en-US')} PG) · `
      + `${b.links} links (${b.linkCpu.toLocaleString('en-US')} CPU / ${b.linkPg.toLocaleString('en-US')} PG) · CC level ${model.cmd_ctr_level}. `
      + `Extractor heads add load in-game and aren't counted here.</div>`;
  }

  function renderSelection() {
    const el = $('#pib-selinfo');
    if (sel == null || !model.pins[sel]) { el.innerHTML = '<span class="muted">No pin selected. Click a pin to select; pick a tool to place.</span>'; return; }
    const p = model.pins[sel]; const r = pin(p.type_id);
    const sch = p.schematic ? ` · makes ${escapeHtml(commodityName(p.schematic))}` : '';
    el.innerHTML = `<strong>${escapeHtml(r.name || 'pin')}</strong> <span class="muted">(${(p.lat).toFixed(3)}, ${(p.lon).toFixed(3)})${sch}</span>
      <button id="pib-link" class="secondary">Link…</button> <button id="pib-del" class="secondary">Delete</button>`;
    $('#pib-del').onclick = () => { model.pins.splice(sel, 1); remapAfterDelete(sel); sel = null; linkFrom = null; render(); };
    $('#pib-link').onclick = () => { linkFrom = sel; render(); };
  }

  // when a pin index is removed, drop its links/routes and shift higher indices
  function remapAfterDelete(idx) {
    const fix = (n) => (n === 'cc' ? 'cc' : (n > idx ? n - 1 : n));
    model.links = model.links.filter((l) => l.a !== idx && l.b !== idx).map((l) => ({ ...l, a: fix(l.a), b: fix(l.b) }));
    model.routes = model.routes.filter((r) => r.src !== idx && r.dst !== idx).map((r) => ({ ...r, src: fix(r.src), dst: fix(r.dst) }));
  }

  // ---------------------------- interaction ----------------------------
  function svgLocal(e) {
    const svg = $('#pib-svg'); const rect = svg.getBoundingClientRect();
    const scale = R * 2 + 40; // viewBox size
    const vx = (e.clientX - rect.left) / rect.width * scale - (R + 20);
    const vy = (e.clientY - rect.top) / rect.height * scale - (R + 20);
    return { x: vx, y: vy };
  }

  function onCanvasClick(e) {
    const g = e.target.closest('.pib-pin');
    if (g) {
      const i = +g.dataset.i;
      if (linkFrom != null && linkFrom !== i) {
        model.links.push({ a: linkFrom, b: i, level: 0 });
        linkFrom = null; sel = i; render(); return;
      }
      sel = i; render(); return;
    }
    if (tool === 'select') return;
    const loc = svgLocal(e);
    const sph = unproject(loc.x, loc.y, camera());
    if (!sph) return;
    model.pins.push({ type_id: +tool, schematic: null, lat: sph.th, lon: sph.ph, height: 0 });
    sel = model.pins.length - 1; render();
  }

  let drag = null;
  function onDown(e) { if (e.target.closest('.pib-pin')) return; drag = { x: e.clientX, y: e.clientY, t: view.theta0, p: view.phi0 }; }
  function onMove(e) {
    if (!drag) return;
    view.phi0 = drag.p - (e.clientX - drag.x) * 0.008;
    view.theta0 = Math.max(0.15, Math.min(Math.PI - 0.15, drag.t - (e.clientY - drag.y) * 0.008));
    render();
  }
  function onUp() { drag = null; }

  function recenter() {
    if (!model.pins.length) { view.zoom = 1; return; }
    const c = model.pins.reduce((a, p) => V.add(a, V.fromSph(p.lat, p.lon), 1), [0, 0, 0]);
    const cn = V.norm(c);
    view.theta0 = Math.acos(Math.max(-1, Math.min(1, cn[2])));
    view.phi0 = Math.atan2(cn[1], cn[0]);
    // Fit zoom: spread the widest pin (angular distance beta from centre) to ~60% of the disc.
    let maxAng = 0.05;
    for (const p of model.pins) maxAng = Math.max(maxAng, Math.acos(Math.max(-1, Math.min(1, V.dot(cn, V.fromSph(p.lat, p.lon))))));
    view.zoom = Math.max(1, Math.min(14, 0.6 / Math.sin(maxAng)));
  }

  // ------------------------------ palette ------------------------------
  function renderPalette() {
    const pt = planetType();
    const kinds = [['command_center', 'Command Center'], ['extractor', 'Extractor'], ['storage', 'Storage'], ['launchpad', 'Launchpad']];
    const facs = ['basic', 'advanced', 'hitech'].map((tier) => {
      const id = Object.entries(pinsData.pins).find(([, r]) => r.kind === 'factory' && r.planet_type === pt && r.tier === tier);
      return id ? [id[0], `${tier[0].toUpperCase()}${tier.slice(1)} Factory`] : null;
    }).filter(Boolean);
    const btns = kinds.map(([k, lbl]) => {
      const id = pinTypeFor(k, pt);
      return id ? `<button class="pib-tool ${String(tool) === String(id) ? 'active' : ''}" data-tool="${id}" style="border-color:${KIND_COLOR[k]}">${lbl}</button>` : '';
    }).concat(facs.map(([id, lbl]) => `<button class="pib-tool ${String(tool) === String(id) ? 'active' : ''}" data-tool="${id}" style="border-color:${KIND_COLOR.factory}">${lbl}</button>`));
    $('#pib-palette').innerHTML =
      `<button class="pib-tool ${tool === 'select' ? 'active' : ''}" data-tool="select">Select</button>` + btns.join('');
  }

  // ------------------------------ templates ------------------------------
  async function refreshTemplates() {
    const r = await fetch(`${API}/api/pi/templates`).then((x) => x.json());
    const sel2 = $('#pib-templates');
    sel2.innerHTML = `<option value="">— saved templates (${r.templates.length}) —</option>` +
      r.templates.filter((t) => !t.error).map((t) => `<option value="${escapeHtml(t.name)}">${escapeHtml(t.planet_type || '?')}: ${escapeHtml(t.comment || t.name)} (${t.pins}p)</option>`).join('');
    $('#pib-dir').textContent = r.dir + (r.exists ? '' : ' (not found)');
  }
  async function loadTemplate(name) {
    if (!name) return;
    const r = await fetch(`${API}/api/pi/templates/read?name=${encodeURIComponent(name)}`).then((x) => x.json());
    model = r.layout; sel = null; linkFrom = null; recenter();
    renderPalette(); render(); setMeta();
  }
  async function saveTemplate() {
    const name = ($('#pib-name').value.trim() || model.comment || 'colony').replace(/[^\w .-]/g, '_');
    model.comment = $('#pib-comment').value.trim() || model.comment;
    const res = await fetch(`${API}/api/pi/templates/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, layout: model }),
    });
    const d = await res.json();
    $('#pib-status').textContent = res.ok ? `Saved ${d.saved} to the EVE templates folder.` : `Save failed: ${d.detail || res.statusText}`;
    if (res.ok) refreshTemplates();
  }

  function setMeta() {
    $('#pib-planet').value = planetType();
    $('#pib-cc').value = model.cmd_ctr_level;
    $('#pib-diam').value = model.diameter;
    $('#pib-comment').value = model.comment || '';
  }

  function initTab() {
    loadStatic().then(() => {
      if (!model) model = emptyModel('Barren');
      renderPalette(); setMeta(); render(); refreshTemplates();
    });
    if (initialised) return;
    initialised = true;

    const svg = $('#pib-svg');
    svg.addEventListener('click', onCanvasClick);
    svg.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      view.zoom = Math.max(1, Math.min(25, view.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      render();
    }, { passive: false });

    $('#pib-palette').addEventListener('click', (e) => {
      const b = e.target.closest('.pib-tool'); if (!b) return;
      tool = b.dataset.tool === 'select' ? 'select' : b.dataset.tool;
      linkFrom = null; renderPalette();
    });
    $('#pib-planet').addEventListener('change', (e) => {
      model.planet_type_id = PLANET_TYPE_ID[e.target.value];
      // re-home pins/CC to the new planet's pin types by kind
      model.pins.forEach((p) => { const k = pin(p.type_id).kind; const nid = pinTypeFor(k, e.target.value); if (nid) p.type_id = nid; });
      renderPalette(); render();
    });
    $('#pib-cc').addEventListener('change', (e) => { model.cmd_ctr_level = +e.target.value; render(); });
    $('#pib-diam').addEventListener('change', (e) => { model.diameter = parseFloat(e.target.value) || model.diameter; render(); });
    $('#pib-new').addEventListener('click', () => { model = emptyModel($('#pib-planet').value || 'Barren'); sel = null; renderPalette(); setMeta(); render(); });
    $('#pib-templates').addEventListener('change', (e) => loadTemplate(e.target.value));
    $('#pib-save').addEventListener('click', saveTemplate);
  }

  document.querySelector('.tab-btn[data-tab="pi-builder"]')?.addEventListener('click', initTab);
})();
