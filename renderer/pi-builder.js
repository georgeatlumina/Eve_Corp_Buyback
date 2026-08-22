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
  let piSchem = null;    // /api/pi/data schematics (for factory output assignment)
  let byOutput = null;   // output_type_id -> schematic (for the chain calculator)
  let planetP0 = null;   // planet_type -> [P0 type_id] (for ECU resource assignment)
  let model = null;      // current colony
  let view = { theta0: 1.4, phi0: 0.8, zoom: 1 };   // camera direction (colat, azimuth) + magnification
  let tool = 'select';   // 'select', 'link', or a pin type_id string to place
  let sel = null;        // selected pin index
  let selLink = null;    // selected link index (for inspecting / deleting a connection)
  let linkFrom = null;   // pin index awaiting a link target
  let dirty = false;     // unsaved edits in the current colony
  let initialised = false;
  const markDirty = () => { dirty = true; };

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
    return { x, y, visible: front > 0 };   // on the near hemisphere; SVG viewport clips off-canvas
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
    pinsData = p; piTypes = d.types; piSchem = d.schematics; planetP0 = d.planet_p0;
    byOutput = {};
    for (const s of piSchem) for (const [oid] of s.outputs) byOutput[oid] = s;
  }

  function tierOf(id) { return (piTypes[String(id)] || {}).tier; }

  // Schematics a factory of the given tier can run (basic->P1, advanced->P2/P3, hitech->P4).
  function schematicsForTier(tier) {
    const want = { basic: [1], advanced: [2, 3], hitech: [4] }[tier] || [1, 2, 3, 4];
    return piSchem.filter((s) => want.includes(tierOf(s.outputs[0][0])))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // Pin indices directly linked to idx (skip the command-center node).
  function neighbors(idx) {
    const out = [];
    for (const l of model.links) {
      if (l.a === idx && l.b !== 'cc') out.push(l.b);
      else if (l.b === idx && l.a !== 'cc') out.push(l.a);
    }
    return [...new Set(out)];
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
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${R * view.zoom}" fill="url(#pib-globe)" stroke="#0a0a0a" stroke-width="2"/>`);

    // graticule (a few meridians/parallels on the visible hemisphere)
    for (let lat = 30; lat < 180; lat += 30) {
      let d = '';
      for (let lon = 0; lon <= 360; lon += 6) {
        const p = project(lat * Math.PI / 180, lon * Math.PI / 180, cam);
        d += (p.visible ? (d && !d.endsWith('M') ? 'L' : 'M') : 'M') + (cx + p.x).toFixed(1) + ' ' + (cy + p.y).toFixed(1) + ' ';
      }
      parts.push(`<path d="${d}" fill="none" stroke="#ffffff14" stroke-width="1"/>`);
    }

    // links — each wrapped in a group with a fat transparent hit line so it's
    // easy to click, plus a visible line that brightens when the link is selected.
    model.links.forEach((l, li) => {
      const a = pinAt(l.a), b = pinAt(l.b);
      if (!a || !b) return;
      const pa = project(a.lat, a.lon, cam), pb = project(b.lat, b.lon, cam);
      if (!pa.visible && !pb.visible) return;
      const x1 = cx + pa.x, y1 = cy + pa.y, x2 = cx + pb.x, y2 = cy + pb.y;
      const on = li === selLink;
      parts.push(`<g class="pib-link" data-li="${li}" style="cursor:pointer">
        <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="transparent" stroke-width="10"/>
        <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${on ? '#4af' : '#ffd27f66'}" stroke-width="${on ? 3 : 1.5}"/>
      </g>`);
    });

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
      // Extractor heads add load on top of the ECU base.
      if (r.kind === 'extractor' && p.heads) {
        pg += p.heads * (r.head_power || 0); cpu += p.heads * (r.head_cpu || 0);
      }
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
      + `Extractor-head load is included when you set heads on an ECU.</div>`;
  }

  function pinLabel(idx) {
    return idx === 'cc' ? 'Command Center' : (pin(model.pins[idx].type_id).name || `pin ${idx}`);
  }

  function renderSelection() {
    const el = $('#pib-selinfo');
    if (selLink != null && model.links[selLink]) {
      const l = model.links[selLink];
      const a = pinAt(l.a), b = pinAt(l.b);
      const km = (a && b) ? greatCircleKm(a, b) : 0;
      el.innerHTML = `<div class="pib-selhead"><strong>Link</strong>
        <span class="muted">${escapeHtml(pinLabel(l.a))} ↔ ${escapeHtml(pinLabel(l.b))}${km ? ` · ${km.toFixed(0)} km` : ''}</span>
        <button id="pib-ldel" class="secondary">Delete link</button></div>
        <div class="muted" style="font-size:.82em;margin-top:.4em">Tip: click any connector line to select it, then Delete removes it.</div>`;
      $('#pib-ldel').onclick = () => { model.links.splice(selLink, 1); selLink = null; markDirty(); render(); };
      return;
    }
    if (sel == null || !model.pins[sel]) {
      el.innerHTML = '<span class="muted">No pin selected. Click a pin to select; pick a tool to place.</span>';
      return;
    }
    const p = model.pins[sel]; const r = pin(p.type_id);

    // schematic (factory) / resource (ECU) assignment
    let assign = '';
    if (r.kind === 'factory') {
      const opts = schematicsForTier(r.tier).map((s) =>
        `<option value="${s.outputs[0][0]}" ${String(p.schematic) === String(s.outputs[0][0]) ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('');
      assign = `<label class="pib-inline">Makes <select id="pib-sch"><option value="">— pick output —</option>${opts}</select></label>`;
    } else if (r.kind === 'extractor') {
      const ids = (planetP0[planetType()] || []);
      const opts = ids.map((id) => `<option value="${id}" ${String(p.schematic) === String(id) ? 'selected' : ''}>${escapeHtml(commodityName(id))}</option>`).join('');
      assign = `<label class="pib-inline">Extracts <select id="pib-sch"><option value="">— pick resource —</option>${opts}</select></label>`
        + `<label class="pib-inline">Heads <input id="pib-heads" type="number" min="0" max="10" value="${p.heads || 0}" style="width:3.5em" title="${r.head_cpu}/${r.head_power} CPU/PG each"/></label>`;
    }

    // routes touching this pin
    const nbrs = neighbors(sel);
    const rows = model.routes.map((rt, i) => ({ rt, i })).filter(({ rt }) => rt.src === sel || rt.dst === sel);
    const routeList = rows.map(({ rt, i }) => {
      const other = rt.src === sel ? rt.dst : rt.src;
      const dir = rt.src === sel ? '→' : '←';
      const oname = other === 'cc' ? 'CC' : (pin(model.pins[other].type_id).name || `pin ${other}`);
      return `<div class="pib-route">${dir} ${escapeHtml(oname)}: ${Number(rt.qty).toLocaleString('en-US')}× ${escapeHtml(commodityName(rt.type_id))}
        <button class="pib-rdel" data-i="${i}">✕</button></div>`;
    }).join('') || '<div class="muted" style="font-size:.85em">No routes yet.</div>';

    const commodityOpts = Object.keys(piTypes).map(Number).sort((a, b) => (tierOf(a) - tierOf(b)) || commodityName(a).localeCompare(commodityName(b)))
      .map((id) => `<option value="${id}">P${tierOf(id)} ${escapeHtml(commodityName(id))}</option>`).join('');
    const nbrOpts = nbrs.map((n) => `<option value="${n}">${escapeHtml(pin(model.pins[n].type_id).name || `pin ${n}`)}</option>`).join('');
    const addRoute = nbrs.length
      ? `<div class="pib-addroute">
          <select id="pib-rdest" title="destination (a linked pin)">${nbrOpts}</select>
          <select id="pib-rtype">${commodityOpts}</select>
          <input id="pib-rqty" type="number" value="3000" title="quantity" />
          <button id="pib-radd" class="secondary">+ route</button>
        </div>`
      : '<div class="muted" style="font-size:.82em">Link this pin to another to add routes.</div>';

    el.innerHTML = `<div class="pib-selhead"><strong>${escapeHtml(r.name || 'pin')}</strong>
        <span class="muted">(${p.lat.toFixed(3)}, ${p.lon.toFixed(3)})</span>
        <button id="pib-link" class="secondary">Link…</button>
        <button id="pib-del" class="secondary">Delete</button></div>
      ${assign}
      <div class="pib-routes"><div class="pib-routes-h">Routes</div>${routeList}${addRoute}</div>`;

    $('#pib-del').onclick = () => { model.pins.splice(sel, 1); remapAfterDelete(sel); markDirty(); sel = null; selLink = null; linkFrom = null; render(); };
    $('#pib-link').onclick = () => { linkFrom = sel; render(); };
    const schEl = $('#pib-sch');
    if (schEl) schEl.onchange = (e) => { p.schematic = e.target.value ? +e.target.value : null; markDirty(); render(); };
    const headsEl = $('#pib-heads');
    if (headsEl) headsEl.onchange = (e) => { p.heads = Math.max(0, Math.min(10, parseInt(e.target.value, 10) || 0)); markDirty(); render(); };
    el.querySelectorAll('.pib-rdel').forEach((b) => { b.onclick = () => { model.routes.splice(+b.dataset.i, 1); markDirty(); render(); }; });
    const addBtn = $('#pib-radd');
    if (addBtn) addBtn.onclick = () => {
      model.routes.push({ src: sel, dst: +$('#pib-rdest').value, type_id: +$('#pib-rtype').value, qty: parseInt($('#pib-rqty').value, 10) || 0 });
      markDirty(); render();
    };
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
    // A rotate-drag ends with a click event; don't treat that as a placement/select.
    if (dragged) { dragged = false; return; }
    const g = e.target.closest('.pib-pin');
    if (g) {
      const i = +g.dataset.i;
      if (linkFrom != null && linkFrom !== i) {
        model.links.push({ a: linkFrom, b: i, level: 0 }); markDirty();
        linkFrom = null; sel = i; selLink = null; render(); return;
      }
      if (tool === 'link') { linkFrom = i; sel = i; selLink = null; render(); return; }   // start a link
      sel = i; selLink = null; render(); return;
    }
    if (tool === 'select') {
      // Click a connector line to select it (Delete or the panel button removes it);
      // clicking empty space clears the selection.
      const lg = e.target.closest('.pib-link');
      if (lg) { selLink = +lg.dataset.li; sel = null; linkFrom = null; render(); return; }
      sel = null; selLink = null; linkFrom = null; render(); return;
    }
    if (tool === 'link') { linkFrom = null; render(); return; }
    const loc = svgLocal(e);
    const sph = unproject(loc.x, loc.y, camera());
    if (!sph) return;
    model.pins.push({ type_id: +tool, schematic: null, lat: sph.th, lon: sph.ph, height: 0 });
    markDirty();
    sel = model.pins.length - 1; selLink = null; render();
  }

  let drag = null, pinDrag = null, dragged = false;
  function onDown(e) {
    dragged = false;
    const g = e.target.closest('.pib-pin');
    if (g) {
      // In select mode, grabbing a pin starts a move; in place/link mode the
      // click is handled by onCanvasClick, so don't start a drag here.
      if (tool === 'select') pinDrag = { i: +g.dataset.i, x: e.clientX, y: e.clientY };
      return;
    }
    drag = { x: e.clientX, y: e.clientY, t: view.theta0, p: view.phi0 };
  }
  function onMove(e) {
    if (pinDrag) {
      if (Math.abs(e.clientX - pinDrag.x) + Math.abs(e.clientY - pinDrag.y) > 3) {
        dragged = true;
        const sph = unproject(svgLocal(e).x, svgLocal(e).y, camera());
        const p = model.pins[pinDrag.i];
        if (sph && p) { p.lat = sph.th; p.lon = sph.ph; sel = pinDrag.i; markDirty(); render(); }
      }
      return;
    }
    if (!drag) return;
    if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3) dragged = true;
    view.phi0 = drag.p - (e.clientX - drag.x) * 0.008;
    view.theta0 = Math.max(0.15, Math.min(Math.PI - 0.15, drag.t - (e.clientY - drag.y) * 0.008));
    render();
  }
  function onUp() { drag = null; pinDrag = null; }

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
      `<button class="pib-tool ${tool === 'select' ? 'active' : ''}" data-tool="select">Select</button>`
      + `<button class="pib-tool pib-tool-link ${tool === 'link' ? 'active' : ''}" data-tool="link" title="Click two pins to connect them">🔗 Link</button>`
      + btns.join('');
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
    if (!r.layout) { $('#pib-status').textContent = `Load failed: ${r.detail || 'bad template'}`; return; }
    model = r.layout; sel = null; selLink = null; linkFrom = null; dirty = false; recenter();
    renderPalette(); render(); setMeta();
    $('#pib-status').textContent = `Loaded ${name}.`;
  }
  // Load the selected template, warning first if the current colony has unsaved edits.
  function requestLoadTemplate() {
    const name = $('#pib-templates').value;
    if (!name) { $('#pib-status').textContent = 'Pick a template from the list first.'; return; }
    if (!dirty || !(model.pins || []).length) { loadTemplate(name); return; }
    confirmUnsaved(
      async () => { await saveTemplate(); loadTemplate(name); },
      () => loadTemplate(name),
    );
  }
  function confirmUnsaved(onSave, onDiscard) {
    const m = document.createElement('div');
    m.className = 'pib-modal';
    m.innerHTML = `<div class="pib-modal-box">
      <div class="pib-modal-h">Unsaved changes</div>
      <p>The colony in the builder has unsaved edits. Save them to the EVE folder before loading the selected template, or discard them?</p>
      <div class="pib-modal-btns">
        <button data-a="save">Save &amp; load</button>
        <button data-a="discard" class="secondary">Discard &amp; load</button>
        <button data-a="cancel" class="secondary">Cancel</button>
      </div></div>`;
    m.addEventListener('click', (e) => {
      if (e.target === m) { m.remove(); return; }
      const b = e.target.closest('[data-a]'); if (!b) return;
      const a = b.dataset.a; m.remove();
      if (a === 'save') onSave(); else if (a === 'discard') onDiscard();
    });
    document.body.appendChild(m);
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
    if (res.ok) { dirty = false; refreshTemplates(); }
  }

  function setMeta() {
    $('#pib-planet').value = planetType();
    $('#pib-cc').value = model.cmd_ctr_level;
    $('#pib-diam').value = model.diameter;
    $('#pib-comment').value = model.comment || '';
  }

  // ---------------------------- chain calculator ----------------------------
  let calcItem = null, calcScale = 1, calcHi = null;

  // which planet types a P0 can be extracted on
  function p0PlanetTypes(p0id) {
    const out = [];
    for (const [planet, ids] of Object.entries(planetP0 || {})) if (ids.includes(p0id)) out.push(planet);
    return out;
  }

  // units of every type needed per 1 unit of the product (aggregated over the tree)
  function chainNeeds(pid) {
    const need = new Map([[pid, 1]]);
    (function expand(tid, mult) {
      const s = byOutput[tid];
      if (!s) return;
      const oq = s.outputs[0][1] || 1;
      for (const [inId, inQty] of s.inputs) {
        const per = (inQty / oq) * mult;
        need.set(inId, (need.get(inId) || 0) + per);
        expand(inId, per);
      }
    })(pid, 1);
    return need;
  }

  function populateCalc() {
    const sel2 = $('#pib-calc-item');
    if (!sel2 || sel2.options.length > 1) return;   // already populated
    const groups = { 1: [], 2: [], 3: [], 4: [] };
    for (const id of Object.keys(byOutput)) { const t = tierOf(+id); if (groups[t]) groups[t].push(+id); }
    let html = '<option value="">— pick a commodity —</option>';
    for (const t of [4, 3, 2, 1]) {
      const items = groups[t].sort((a, b) => commodityName(a).localeCompare(commodityName(b)));
      html += `<optgroup label="P${t}">${items.map((id) => `<option value="${id}">${escapeHtml(commodityName(id))}</option>`).join('')}</optgroup>`;
    }
    sel2.innerHTML = html;
  }

  function calcRunsText(tid, qty) {
    const s = byOutput[tid];
    return s ? `${Math.ceil(qty / (s.outputs[0][1] || 1)).toLocaleString('en-US')} run(s)` : 'extract';
  }

  function setCalcItem(id) {
    calcItem = id || null;
    updateOptTarget();
    if (!calcItem) { $('#pib-calc-out').innerHTML = ''; $('#pib-calc-runs').textContent = ''; return; }
    calcScale = byOutput[calcItem] ? (byOutput[calcItem].outputs[0][1] || 1) : 1;   // one production run
    $('#pib-calc-qty').value = calcScale;
    renderCalcRows();
  }

  // Left→right flow: one column per tier (P0 raw … product), with connector
  // lines drawn from each input to the intermediate/product it feeds.
  function renderCalcRows() {
    const out = $('#pib-calc-out');
    calcHi = null;
    if (!calcItem) { out.innerHTML = ''; return; }
    const needs = chainNeeds(calcItem);   // includes the product itself
    const byTier = { 0: [], 1: [], 2: [], 3: [], 4: [] };
    for (const [tid, per] of needs) { const t = tierOf(tid); if (byTier[t] !== undefined) byTier[t].push({ tid, per }); }
    const cols = [0, 1, 2, 3, 4].filter((t) => byTier[t].length).map((t) => {
      const nodes = byTier[t].sort((a, b) => commodityName(a.tid).localeCompare(commodityName(b.tid))).map(({ tid, per }) => {
        const qty = per * calcScale;
        const planets = t === 0
          ? `<div class="pib-node-planets" title="Extractable on these planet types">${escapeHtml(p0PlanetTypes(tid).join(' · ') || '—')}</div>` : '';
        return `<div class="pib-node${tid === calcItem ? ' pib-node-product' : ''}" data-tid="${tid}">
          <div class="pib-node-name" title="${escapeHtml(commodityName(tid))}">${escapeHtml(commodityName(tid))}</div>
          <div class="pib-node-row">
            <input class="pib-calc-q" data-tid="${tid}" data-per="${per}" type="number" min="0" value="${Math.round(qty)}" />
            <span class="pib-node-runs muted">${calcRunsText(tid, qty)}</span>
          </div>
          ${planets}
        </div>`;
      }).join('');
      return `<div class="pib-flow-col"><div class="pib-flow-col-h">${t === 0 ? 'P0 raw' : 'P' + t}</div>${nodes}</div>`;
    }).join('');
    out.innerHTML = `<div class="pib-flow"><svg class="pib-flow-lines" xmlns="http://www.w3.org/2000/svg"></svg><div class="pib-flow-cols">${cols}</div></div>`;
    $('#pib-calc-runs').textContent = calcRunsText(calcItem, calcScale);
    drawFlowLines();
  }

  // Draw the input→output connector lines over the flow columns.
  function drawFlowLines() {
    const flow = document.querySelector('#pib-calc-out .pib-flow');
    if (!flow) return;
    const svg = flow.querySelector('.pib-flow-lines');
    const cols = flow.querySelector('.pib-flow-cols');
    const W = cols.offsetWidth, H = cols.offsetHeight;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.style.width = `${W}px`; svg.style.height = `${H}px`;
    const node = {};
    flow.querySelectorAll('.pib-node').forEach((n) => { node[n.dataset.tid] = n; });
    const paths = [];
    for (const tid of Object.keys(node)) {
      const s = byOutput[tid]; if (!s) continue;         // produced node — draw from its inputs
      const dst = node[tid];
      for (const [inId] of s.inputs) {
        const src = node[inId]; if (!src) continue;
        const x1 = src.offsetLeft + src.offsetWidth, y1 = src.offsetTop + src.offsetHeight / 2;
        const x2 = dst.offsetLeft, y2 = dst.offsetTop + dst.offsetHeight / 2;
        const dx = Math.max(18, (x2 - x1) * 0.4);
        paths.push(`<path data-src="${inId}" data-dst="${tid}" d="M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}" />`);
      }
    }
    svg.innerHTML = paths.join('');
    if (calcHi != null) applyHighlight();   // preserve highlight across a resize redraw
  }

  // The full sub-chain related to a node: itself + everything upstream (its
  // inputs down to P0) + everything downstream (what consumes it up to the product).
  function connectedSet(tid) {
    const set = new Set([tid]);
    (function up(x) { const s = byOutput[x]; if (!s) return; for (const [i] of s.inputs) if (!set.has(i)) { set.add(i); up(i); } })(tid);
    const chain = [...chainNeeds(calcItem).keys()];
    (function down(x) {
      for (const y of chain) { const s = byOutput[y]; if (s && s.inputs.some(([i]) => i === x) && !set.has(y)) { set.add(y); down(y); } }
    })(tid);
    return set;
  }

  function applyHighlight() {
    const flow = document.querySelector('#pib-calc-out .pib-flow');
    if (!flow) return;
    if (calcHi == null) {
      flow.classList.remove('pib-flow-focus');
      flow.querySelectorAll('.pib-node-hi').forEach((n) => n.classList.remove('pib-node-hi'));
      flow.querySelectorAll('.pib-line-hi').forEach((p) => p.classList.remove('pib-line-hi'));
      return;
    }
    const set = connectedSet(calcHi);
    flow.classList.add('pib-flow-focus');
    flow.querySelectorAll('.pib-node').forEach((n) => n.classList.toggle('pib-node-hi', set.has(+n.dataset.tid)));
    flow.querySelectorAll('.pib-flow-lines path').forEach((p) => p.classList.toggle('pib-line-hi', set.has(+p.dataset.src) && set.has(+p.dataset.dst)));
  }

  function toggleHighlight(tid) {
    calcHi = (calcHi === tid) ? null : tid;
    applyHighlight();
  }

  // Live-rescale every field from calcScale without re-rendering (keeps focus on the edited input).
  function updateCalcValues(exceptEl) {
    const qEl = $('#pib-calc-qty');
    if (qEl !== exceptEl) qEl.value = Math.round(calcScale);
    $('#pib-calc-runs').textContent = calcRunsText(calcItem, calcScale);
    $('#pib-calc-out').querySelectorAll('.pib-calc-q').forEach((el) => {
      const qty = (parseFloat(el.dataset.per) || 0) * calcScale;
      if (el !== exceptEl) el.value = Math.round(qty);
      if (el.nextElementSibling) el.nextElementSibling.textContent = calcRunsText(+el.dataset.tid, qty);
    });
  }

  // ---------------------------- planet optimizer ----------------------------
  // Given a target commodity and a budget of planets across the authed toons,
  // allocate planets to production steps (extractors + factories) to maximise
  // the sustained output rate of the target. Bottleneck-balancing greedy.
  const OPT_HEADS = 10;               // assumed ECU heads on an extractor planet
  let optToons = [];                  // /api/pi/planet-capacity toons (+ editable `use`)
  let optParams = null;               // {model, cc, facBasic, facAdv, facHi, extP1, extP0}
  let optResult = null;
  let optSystemPlanets = { system: null, counts: {}, total: 0 };   // chosen system's planet make-up

  // The planet make-up of the system chosen in the planner (#pi-system), so the
  // command-centre tally + toon split reflect what that system can actually host
  // (only its planet types, and one colony per planet per character). Blank = all.
  async function loadSystemPlanets() {
    const sysName = (($('#pi-system')?.value) || '').trim();
    if (!sysName) { optSystemPlanets = { system: null, counts: {}, total: 0 }; return optSystemPlanets; }
    if (optSystemPlanets.system && optSystemPlanets.system.toLowerCase() === sysName.toLowerCase()) return optSystemPlanets;
    try {
      const r = await fetch(`${API}/api/pi/system-planets?system=${encodeURIComponent(sysName)}`);
      if (r.ok) { const d = await r.json(); optSystemPlanets = { system: d.system || sysName, counts: d.counts || {}, total: d.total || 0 }; }
      else { optSystemPlanets = { system: null, counts: {}, total: 0, error: `“${sysName}” not found` }; }
    } catch (_) { optSystemPlanets = { system: null, counts: {}, total: 0 }; }
    return optSystemPlanets;
  }

  // per-factory hourly output for a tier, straight from the schematic data
  function tierUnitPerHour(tier) {
    const s = piSchem.find((sc) => tierOf(sc.outputs[0][0]) === tier);
    return s ? s.outputs[0][1] * 3600 / s.cycle_time : 0;
  }
  function ccBudget(lvl) {
    const c = (pinsData.command_center_levels || []).find((x) => x.level === +lvl) || {};
    return { cpu: c.cpu || 0, pg: c.powergrid || 0 };
  }
  function pinCost(kind, tier) {
    for (const r of Object.values(pinsData.pins)) {
      if (r.kind === kind && (tier == null || r.tier === tier)) {
        return { cpu: r.cpu_load || 0, pg: r.power_load || 0, head_cpu: r.head_cpu || 0, head_pg: r.head_power || 0 };
      }
    }
    return { cpu: 0, pg: 0, head_cpu: 0, head_pg: 0 };
  }
  const factoryTierName = (tier) => (tier === 1 ? 'basic' : tier === 4 ? 'hitech' : 'advanced');

  // Max factories of a tier that fit on a planet (CC budget − launchpad − storage
  // − optional ECU+heads), with a 15% link/overhead haircut. Editable default.
  function autoFactories(tier, ccLevel, extractor, heads) {
    const b = ccBudget(ccLevel), lp = pinCost('launchpad'), st = pinCost('storage');
    let cpu = b.cpu - lp.cpu - st.cpu, pg = b.pg - lp.pg - st.pg;
    if (extractor) { const e = pinCost('extractor'); cpu -= e.cpu + heads * e.head_cpu; pg -= e.pg + heads * e.head_pg; }
    const f = pinCost('factory', factoryTierName(tier));
    if (!f.cpu || !f.pg) return 0;
    return Math.max(0, Math.floor(Math.min(cpu / f.cpu, pg / f.pg) * 0.85));
  }

  function defaultOptParams(model, cc) {
    const facBasicExt = autoFactories(1, cc, true, OPT_HEADS);   // basic factories on an extractor planet
    const facBasicFac = autoFactories(1, cc, false, 0);          // basic factories on a dedicated P1 planet
    return {
      model, cc,
      facBasic: facBasicFac,
      facAdv: autoFactories(2, cc, false, 0),
      facHi: autoFactories(4, cc, false, 0),
      extP1: facBasicExt * tierUnitPerHour(1),   // P1/hr from an extractor+basic-factory planet
      extP0: 6000,                                // P0/hr per extractor planet (tunable assumption)
    };
  }

  // Role of a node's tier under the chosen model: 'extractor', 'factory', or null
  // (folded into another planet, so not separately counted).
  function nodeRole(tier, model) {
    if (model === 'ext-p1') return tier === 0 ? null : (tier === 1 ? 'extractor' : 'factory');
    if (model === 'pure-ext') return tier === 0 ? 'extractor' : 'factory';
    return tier === 0 ? 'extractor' : (tier === 1 ? null : 'factory');   // p1-on-fac: P1 folded
  }
  function perPlanetOutput(tier, model, p) {
    const role = nodeRole(tier, model);
    if (!role) return 0;
    if (role === 'extractor') return model === 'ext-p1' ? p.extP1 : p.extP0;
    if (tier === 1) return p.facBasic * tierUnitPerHour(1);
    if (tier === 4) return p.facHi * tierUnitPerHour(4);
    return p.facAdv * tierUnitPerHour(tier);
  }

  // `sysPool` (optional) constrains the plan to a chosen system: {byType:{planet
  // type: count}, total, chars, system}. Extractors of a P0 are then capped by how
  // many of its compatible planets that system has × the character count (one
  // colony per planet per character), so the plan is physically deployable there.
  function runOptimize(targetId, N, p, sysPool) {
    const needs = chainNeeds(targetId);
    const ext = [], fac = [];
    for (const [tid, per] of needs) {
      const role = nodeRole(tierOf(tid), p.model);
      if (!role) continue;
      const out = perPlanetOutput(tierOf(tid), p.model, p);
      if (out <= 0) return { error: `Capacity for a P${tierOf(tid)} step is zero — check the assumptions (CC level / factories).` };
      const node = { tid, per, role, out, alloc: 1, cost: per / out };  // cost = planet-equiv per unit/hr
      (role === 'extractor' ? ext : fac).push(node);
    }
    if (!ext.length && !fac.length) return { error: 'Nothing to build for this target.' };

    // System planet caps (one colony per planet per character). A shared pool of
    // planet-slots per type (count × chars) is consumed as colonies are placed, so
    // the plan is physically deployable and each extractor records which planet
    // types it lands on (`byType`).
    const chars = sysPool ? Math.max(1, sysPool.chars || 1) : 1;
    const pool = {};
    if (sysPool) {
      const missing = [];
      for (const t in sysPool.byType) pool[t] = (sysPool.byType[t] || 0) * chars;
      for (const e of ext) {
        const p0 = extractorP0(e, p.model);
        e.compat = p0PlanetTypes(p0).filter((t) => (sysPool.byType[t] || 0) > 0);
        e.byType = {};
        if (!e.compat.length) missing.push(commodityName(p0));
      }
      if (missing.length) {
        return { systemInfeasible: true, error: `Can't build this in ${sysPool.system} — no planet there extracts ${[...new Set(missing)].join(', ')}.` };
      }
    }
    const totalPool = sysPool ? sysPool.total * chars : Infinity;
    // Consume one free planet slot from `types` (the most-abundant first, so scarce
    // planet types are left for the P0s that can only use them) → its type, or null.
    const consume = (types) => {
      let best = null, br = 0;
      for (const t of types) { if ((pool[t] || 0) > br) { br = pool[t]; best = t; } }
      if (!best) return null;
      pool[best]--; return best;
    };
    const growExt = (e) => { if (!sysPool) { e.alloc++; return true; } const t = consume(e.compat); if (!t) return false; e.byType[t] = (e.byType[t] || 0) + 1; e.alloc++; return true; };

    // Each distinct raw material needs its OWN extractor planet, but factory
    // schematics can share a planet, so the floor is one planet per extractor plus
    // (at least) one shared factory planet — NOT one planet per production step.
    const minPlanets = ext.length + (fac.length ? 1 : 0);
    if (N < minPlanets) {
      return {
        minPlanets,
        error: `Need at least ${minPlanets} planet${minPlanets === 1 ? '' : 's'} — ${ext.length} to extract the raw material${ext.length === 1 ? '' : 's'}`
          + (fac.length ? ' plus at least one shared factory planet (factory schematics can be consolidated onto the same planet)' : '')
          + ` — but only ${N} available.`,
      };
    }
    if (sysPool && minPlanets > totalPool) {
      return { systemInfeasible: true, error: `${sysPool.system} has only ${sysPool.total} planet(s) × ${chars} char(s) = ${totalPool}; this chain needs at least ${minPlanets}.` };
    }

    const facCost = fac.reduce((a, n) => a + n.cost, 0);
    const extThroughput = (n) => n.alloc / n.cost;
    let fp = 0;
    const facThroughput = () => (fac.length ? fp / facCost : Infinity);
    const growFac = () => { if (!sysPool) { fp++; return true; } if (!consume(Object.keys(pool))) return false; fp++; return true; };

    // Place the mandatory floor: one planet per extractor + one shared factory
    // planet. With a system, each consumes a real planet slot from the pool.
    let placed = 0;
    if (sysPool) {
      for (const e of ext) e.alloc = 0;   // rebuild from the pool so byType is recorded
      const shortInit = [];
      for (const e of ext) { if (growExt(e)) placed++; else shortInit.push(commodityName(extractorP0(e, p.model))); }
      if (shortInit.length) {
        return { systemInfeasible: true, error: `${sysPool.system} hasn't enough distinct planets to extract ${[...new Set(shortInit)].join(', ')} at once — add characters or another system.` };
      }
      if (fac.length && growFac()) placed++;
    } else {
      placed = ext.length;
      if (fac.length) { fp = 1; placed++; }
    }

    // Give each remaining planet to the current throughput bottleneck until the
    // planet budget or the system pool is exhausted, or the bottleneck can't grow.
    const budget = Math.min(N, totalPool);
    let systemLimited = false;
    while (placed < budget) {
      let R = facThroughput(); let bnExt = null;
      for (const e of ext) { const t = extThroughput(e); if (t < R) { R = t; bnExt = e; } }
      const ok = bnExt ? growExt(bnExt) : growFac();
      if (!ok) { systemLimited = true; break; }
      placed++;
    }
    let R = facThroughput();
    let bottleneck = fac[0] || null;   // factory-bound → point at a factory schematic
    for (const e of ext) { const t = extThroughput(e); if (t < R) { R = t; bottleneck = e; } }
    // Factory "alloc" = the planet-share each schematic uses to sustain R.
    for (const f of fac) f.alloc = R * f.cost;
    const nodes = ext.concat(fac);
    return { nodes, R, bottleneck, used: placed, facPlanets: fp, N, model: p.model, systemLimited, system: sysPool ? sysPool.system : null };
  }

  // Split planets across toons, keeping the shared factory planets together on as
  // few toons as possible (fill the largest toons with factory planets first),
  // then spread the extractor planets round-robin over the remaining capacity.
  function splitAcrossToons(facPlanets, extPlanets, toons) {
    const caps = toons.filter((t) => (t.use || 0) > 0)
      .map((t) => ({ name: t.name, max: t.use || 0, fac: 0, ext: 0 }))
      .sort((a, b) => b.max - a.max);   // biggest toons first → factories concentrate
    let fLeft = facPlanets;
    for (const c of caps) { if (fLeft <= 0) break; const take = Math.min(c.max, fLeft); c.fac = take; fLeft -= take; }
    let eLeft = extPlanets, progress = true;
    while (eLeft > 0 && progress) {
      progress = false;
      for (const c of caps) { if (eLeft <= 0) break; if (c.fac + c.ext < c.max) { c.ext++; eLeft--; progress = true; } }
    }
    caps.forEach((c) => { c.n = c.fac + c.ext; });
    return { split: caps.filter((c) => c.n > 0), unassigned: fLeft + eLeft };
  }

  // Which planet types the extractors need a command centre on, and how many of
  // each. When a system is chosen (`sys.counts` non-empty) only its planet types
  // are eligible — a P0 with no matching planet in that system is a shortfall —
  // and assignment spreads toward the types the system has most of. With no
  // system, it greedily reuses an already-chosen type to minimise CC variety.
  function commandCentreTally(res, sys, chars) {
    const have = (sys && sys.counts && Object.keys(sys.counts).length) ? sys.counts : null;
    const C = Math.max(1, chars || 1);
    const exts = res.nodes.filter((n) => n.role === 'extractor');
    const tally = {};
    if (have) {
      // System plan: the optimizer already assigned each extractor to real planet
      // types (`byType`) from the shared pool, so just sum them — always feasible.
      for (const n of exts) for (const [t, c] of Object.entries(n.byType || {})) tally[t] = (tally[t] || 0) + c;
    } else {
      // No system: consolidate each P0 onto the most-used compatible type, to keep
      // the number of distinct command centres down.
      const demands = exts.map((n) => ({ alloc: Math.round(n.alloc), types: p0PlanetTypes(extractorP0(n, res.model)) }))
        .sort((a, b) => a.types.length - b.types.length);
      for (const d of demands) {
        if (!d.types.length) { tally['(any)'] = (tally['(any)'] || 0) + d.alloc; continue; }
        let best = d.types[0], bestC = -1;
        for (const t of d.types) { const c = tally[t] || 0; if (c > bestC) { bestC = c; best = t; } }
        tally[best] = (tally[best] || 0) + d.alloc;
      }
    }
    return { tally, factory: res.facPlanets || 0, have, chars: C, total: (sys && sys.total) || 0 };
  }

  // System-aware toon split: each character may hold at most one colony per planet
  // — so per toon, extractor colonies of a type are capped at the system's count of
  // that type, and total colonies at min(the toon's planet budget, the system's
  // planet count). Factory planets (any type) are still concentrated on the fewest
  // toons. `tally` = per-type extractor counts from commandCentreTally.
  function splitAcrossToonsSystem(tally, factory, sys, toons) {
    const have = sys.counts, total = sys.total || 0;
    const caps = toons.filter((t) => (t.use || 0) > 0)
      .map((t) => ({ name: t.name, cap: Math.min(t.use || 0, total || (t.use || 0)), fac: 0, ext: 0, byType: {}, used: 0 }))
      .sort((a, b) => b.cap - a.cap);
    let fLeft = factory;
    for (const c of caps) { if (fLeft <= 0) break; const take = Math.min(c.cap - c.used, fLeft); c.fac += take; c.used += take; fLeft -= take; }
    let extUnplaced = 0;
    for (const [T, needRaw] of Object.entries(tally)) {
      if (T.startsWith('(')) { extUnplaced += needRaw; continue; }   // "(any)" / "(no planet…)" — not placeable by type
      let need = needRaw; const cap = have[T] || 0; let progress = true;
      while (need > 0 && progress) {
        progress = false;
        for (const c of caps) { if (need <= 0) break; if (c.used < c.cap && (c.byType[T] || 0) < cap) { c.byType[T] = (c.byType[T] || 0) + 1; c.ext++; c.used++; need--; progress = true; } }
      }
      extUnplaced += need;
    }
    caps.forEach((c) => { c.n = c.used; });
    return { split: caps.filter((c) => c.used > 0), unassigned: fLeft + extUnplaced };
  }

  // The P0 an extractor planet pulls (ext-p1: the P1's raw input; else the node itself).
  function extractorP0(node, model) {
    if (model !== 'ext-p1') return node.tid;
    const s = byOutput[node.tid];
    return s && s.inputs.length ? s.inputs[0][0] : node.tid;
  }

  function renderOptParams() {
    const el = $('#pib-opt-params'); if (!el || !optParams) return;
    const p = optParams;
    const num = (id, label, val) => `<label class="pib-opt-field">${label}<input id="${id}" type="number" min="0" step="1" value="${Math.round(val)}" /></label>`;
    const models = [['ext-p1', 'Extractors make P1'], ['pure-ext', 'Pure extractors (P0)'], ['p1-on-fac', 'P1 on factory planets']];
    let html = `<label class="pib-opt-field">Model<select id="pib-opt-model">${models.map(([v, l]) => `<option value="${v}" ${v === p.model ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`
      + `<label class="pib-opt-field">CC level<select id="pib-opt-cc">${[0, 1, 2, 3, 4, 5].map((l) => `<option value="${l}" ${l === p.cc ? 'selected' : ''}>CC ${l}</option>`).join('')}</select></label>`;
    if (p.model === 'ext-p1') html += num('pib-opt-extp1', 'P1 / extractor planet (u/hr)', p.extP1);
    else {
      html += num('pib-opt-extp0', 'P0 / extractor planet (u/hr)', p.extP0);
      if (p.model === 'pure-ext') html += num('pib-opt-facbasic', 'Basic factories / P1 planet', p.facBasic);
    }
    html += num('pib-opt-facadv', 'Advanced factories / planet', p.facAdv)
      + num('pib-opt-fachi', 'Hi-tech factories / planet', p.facHi);
    el.innerHTML = html;
  }
  function readOptParams() {
    const g = (id, d) => { const e = $('#' + id); return e ? (parseFloat(e.value) || d) : d; };
    optParams.model = $('#pib-opt-model').value;
    optParams.cc = +$('#pib-opt-cc').value;
    if (optParams.model === 'ext-p1') optParams.extP1 = g('pib-opt-extp1', optParams.extP1);
    else { optParams.extP0 = g('pib-opt-extp0', optParams.extP0); if (optParams.model === 'pure-ext') optParams.facBasic = g('pib-opt-facbasic', optParams.facBasic); }
    optParams.facAdv = g('pib-opt-facadv', optParams.facAdv);
    optParams.facHi = g('pib-opt-fachi', optParams.facHi);
  }

  function renderOptToons() {
    const el = $('#pib-opt-toons'); if (!el) return;
    if (!optToons.length) { el.innerHTML = ''; return; }
    el.innerHTML = optToons.map((t, i) => `<div class="pib-opt-toon">
      <span class="pib-opt-toon-n">${escapeHtml(t.name || ('char ' + t.character_id))}</span>
      ${t.needs_reauth
        ? '<span class="pib-opt-reauth" title="Re-auth this toon in the PI Characters section to read its skill">re-auth for skills</span>'
        : `<input class="pib-opt-toon-q" data-i="${i}" type="number" min="0" step="1" value="${t.use}" title="Interplanetary Consolidation ${t.ic_level} → max ${t.max_planets}" />`}
    </div>`).join('');
  }
  function optTotalFromToons() {
    const total = optToons.reduce((a, t) => a + (t.use || 0), 0);
    if (total > 0) $('#pib-opt-total').value = total;
  }

  async function pullPlanets() {
    const st = $('#pib-opt-toon-status'); if (st) st.textContent = 'Loading planets from ESI…';
    try {
      const res = await fetch(`${API}/api/pi/planet-capacity`);
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { const j = await res.json(); detail = j.detail || j.error || detail; } catch (_) {}
        throw new Error(detail);
      }
      const r = await res.json();
      if (r.error) throw new Error(r.error);
      optToons = (r.toons || []).map((t) => ({ ...t, use: t.max_planets || 0 }));
      renderOptToons(); optTotalFromToons();
      if (!st) return;
      if (!optToons.length) {
        st.textContent = 'No authorised PI characters found — add them under PI Characters (the manage_planets login), then Pull again.';
        return;
      }
      const reauth = optToons.filter((t) => t.needs_reauth).length;
      const failed = optToons.filter((t) => t.error);
      const parts = [`${optToons.length} toon(s), ${r.total_max} planets`];
      if (reauth) parts.push(`${reauth} need re-auth for skills`);
      if (failed.length) parts.push(`${failed.length} failed to read from ESI: ${failed.map((t) => `${t.name || t.character_id}: ${t.error}`).join('; ')}`);
      st.textContent = parts.join(' · ');
    } catch (e) {
      // Be explicit about *why*. A network TypeError ("failed to fetch") means
      // the local sidecar didn't answer — very different from an ESI/auth error.
      console.error('[pi] pullPlanets failed:', e);
      if (!st) return;
      if (typeof isNetworkError === 'function' && isNetworkError(e)) {
        if (typeof showBackendBanner === 'function') showBackendBanner(true);
        st.textContent = `Couldn't reach the local backend (${API}) to read PI planets — the sidecar isn't responding. `
          + `Restart the app; if it persists, another program may be using that port (see sidecar.log).`;
      } else {
        st.textContent = `Failed to load planets from ESI: ${e.message || e}. `
          + `Check your PI characters are authorised (PI Characters section) and try Pull again.`;
      }
    }
  }

  function updateOptTarget() {
    const el = $('#pib-opt-target'); if (!el) return;
    el.textContent = calcItem ? `Target: ${commodityName(calcItem)}` : 'Target: pick a commodity in the calculator above';
  }

  // Build the system constraint for runOptimize from the chosen system + toon count.
  function currentSysPool() {
    const sys = optSystemPlanets;
    if (!sys || !sys.total || !Object.keys(sys.counts || {}).length) return null;
    const chars = Math.max(1, optToons.filter((t) => (t.use || 0) > 0).length);
    return { byType: sys.counts, total: sys.total, chars, system: sys.system };
  }

  async function optimizeNow() {
    const out = $('#pib-opt-out'); if (!out) return;
    if (!calcItem) { out.innerHTML = '<div class="pib-opt-err">Pick a commodity in the calculator above first.</div>'; return; }
    readOptParams();
    const N = Math.max(1, parseInt($('#pib-opt-total').value, 10) || 1);
    await loadSystemPlanets();   // so the plan + CC tally + split reflect the chosen system
    optResult = runOptimize(calcItem, N, optParams, currentSysPool());
    renderOptResult(optResult);
    if (!optResult.error) fillValue(optResult);
  }

  function renderOptResult(res) {
    const out = $('#pib-opt-out'); if (!out) return;
    if (res.error) { out.innerHTML = `<div class="pib-opt-err">${escapeHtml(res.error)}</div>`; return; }
    const fmt = (n) => Math.round(n).toLocaleString('en-US');
    const rate = (n) => (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10).toLocaleString('en-US');
    const ext = res.nodes.filter((n) => n.role === 'extractor').sort((a, b) => tierOf(a.tid) - tierOf(b.tid) || commodityName(a.tid).localeCompare(commodityName(b.tid)));
    const fac = res.nodes.filter((n) => n.role === 'factory').sort((a, b) => tierOf(a.tid) - tierOf(b.tid) || commodityName(a.tid).localeCompare(commodityName(b.tid)));
    const share = (a) => (a >= 1 ? Math.round(a * 10) / 10 : Math.round(a * 100) / 100);
    const row = (n) => {
      const hi = n === res.bottleneck ? ' pib-opt-bottleneck' : '';
      const stageOut = n.alloc * n.out;
      let sub, count;
      if (n.role === 'extractor') {
        const p0 = extractorP0(n, res.model);
        const planets = p0PlanetTypes(p0).join(' · ') || '—';
        sub = res.model === 'ext-p1'
          ? `extracts ${escapeHtml(commodityName(p0))} · ${escapeHtml(planets)}`
          : `${escapeHtml(planets)}`;
        count = `${n.alloc}×`;
      } else {
        // Factory schematics share planets — n.alloc is a fractional planet-share.
        sub = `P${tierOf(n.tid)} schematic${n.alloc < 0.995 ? ' · shares a factory planet' : ''}`;
        count = `${share(n.alloc)}×`;
      }
      return `<div class="pib-opt-row${hi}">
        <span class="pib-opt-row-n">${count}</span>
        <span class="pib-opt-row-name">${escapeHtml(commodityName(n.tid))}</span>
        <span class="pib-opt-row-sub muted">${sub}</span>
        <span class="pib-opt-row-out muted">${fmt(stageOut)}/hr</span>
      </div>`;
    };
    const group = (title, rows, planets) => {
      if (!rows.length) return '';
      const pc = planets != null ? planets : rows.reduce((a, n) => a + n.alloc, 0);
      return `<div class="pib-opt-group"><div class="pib-opt-group-h">${title} (${pc} planet${pc === 1 ? '' : 's'})</div>${rows.map(row).join('')}</div>`;
    };

    // Command centres needed, tallied by planet type (+ any-type factory planets),
    // relevant to the chosen system's planets and the one-colony-per-planet rule.
    const withPlanets = optToons.filter((t) => (t.use || 0) > 0);
    const charCount = withPlanets.length || 1;
    const sys = optSystemPlanets;
    const cc = commandCentreTally(res, sys, charCount);
    const have = cc.have;
    const ccChip = (t, c) => {
      if (t.startsWith('(')) return `<span class="pib-opt-chip pib-opt-chip-warn">${escapeHtml(t === '(any)' ? `×${c} (any type)` : `${c} extractor(s) — ${t}`)}</span>`;
      const inSys = have ? (have[t] || 0) : null;
      const note = have ? ` <span class="muted">· ${c > inSys ? `across ${cc.chars} chars — ` : ''}${inSys} in system</span>` : '';
      return `<span class="pib-opt-chip pib-opt-chip-cc">${escapeHtml(t)} CC ×${c}${note}</span>`;
    };
    const ccParts = Object.entries(cc.tally).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t, c]) => ccChip(t, c));
    if (cc.factory) {
      const facNote = have ? ` <span class="muted">· any of ${sys.total} planet types</span>` : ` <span class="muted">· any type</span>`;
      ccParts.push(`<span class="pib-opt-chip pib-opt-chip-fac">Factory planet ×${cc.factory}${facNote}</span>`);
    }
    const ccTotal = Object.values(cc.tally).reduce((a, b) => a + b, 0) + cc.factory;
    // The plan is capped to the system's planets, so the only note is when that cap
    // stopped it short of the requested planet budget.
    const warns = [];
    if (have && res.systemLimited) {
      warns.push(`Limited by ${sys.system}'s planets: this system + ${cc.chars} character${cc.chars === 1 ? '' : 's'} support ${res.used} colon${res.used === 1 ? 'y' : 'ies'} of this chain (you asked for ${res.N}). Add characters or a richer system for more throughput.`);
    }
    if (sys && sys.error) warns.push(`System ${sys.error} — showing all planet types.`);
    const sysLabel = have ? ` <span class="muted">in ${escapeHtml(sys.system)} (${sys.total} planets)</span>` : '';
    const ccHtml = ccParts.length
      ? `<div class="pib-opt-cc"><div class="pib-opt-group-h">Command centres to deploy (${ccTotal})${sysLabel}</div>${ccParts.join('')}`
        + warns.map((w) => `<div class="pib-opt-warn">⚠ ${escapeHtml(w)}</div>`).join('') + `</div>` : '';

    let splitHtml = '';
    if (withPlanets.length) {
      let split, unassigned;
      if (have) ({ split, unassigned } = splitAcrossToonsSystem(cc.tally, cc.factory, sys, optToons));
      else ({ split, unassigned } = splitAcrossToons(res.facPlanets || 0, Math.max(0, res.used - (res.facPlanets || 0)), optToons));
      const note = have ? '— one colony per planet per character; factory planets kept together' : '— factory planets kept together';
      splitHtml = `<div class="pib-opt-split"><div class="pib-opt-group-h">Suggested split across toons <span class="muted">${note}</span></div>`
        + split.map((s) => `<span class="pib-opt-chip">${escapeHtml(s.name || 'toon')}: ${s.n}${s.fac ? ` <span class="pib-opt-chip-fmark">· ${s.fac} factory</span>` : ''}</span>`).join('')
        + (unassigned > 0 ? `<span class="pib-opt-chip pib-opt-chip-warn">${unassigned} won't fit${have ? ` in ${escapeHtml(sys.system)}` : ''} (add characters${have ? ' or another system' : ''})</span>` : '')
        + `</div>`;
    }

    out.innerHTML = `<div class="pib-opt-summary">
        <b>${escapeHtml(commodityName(calcItem))}</b>: <b>${rate(res.R)}/hr</b> (${fmt(res.R * 24)}/day)
        · ${res.used}/${res.N} planets used
        · bottleneck: <b>${escapeHtml(commodityName(res.bottleneck.tid))}</b></div>
      <div class="pib-opt-groups">${group('Extractor planets', ext)}${group(fac.length > 1 ? 'Factory planets (schematics consolidated)' : 'Factory planets', fac, res.facPlanets)}</div>
      ${ccHtml}
      ${splitHtml}
      <div id="pib-opt-logi" class="pib-opt-logi"></div>
      <div id="pib-opt-value" class="pib-opt-value"></div>`;
    renderLogistics(res);
  }

  // ---- logistics: haul volume per tier + Epithal/DST loads + move cadence ----
  // PI commodity volumes are uniform per tier (ESI): P0 0.005, P1 0.19, P2 0.75,
  // P3 3, P4 50 m³. Only goods that leave a planet under the chosen model are hauled.
  const TIER_VOL = { 0: 0.005, 1: 0.19, 2: 0.75, 3: 3, 4: 50 };
  function readLogisticsParams() {
    const g = (id, d) => { const e = $('#' + id); return e ? (parseFloat(e.value) || d) : d; };
    return { epithal: g('pib-opt-epithal', 45000), dst: g('pib-opt-dst', 62500) };
  }
  function fmtVol(m3) { return `${Math.round(m3).toLocaleString('en-US')} m³`; }
  function fmtEvery(hours) {
    if (!isFinite(hours) || hours <= 0) return '—';
    if (hours >= 48) return `every ${(hours / 24).toFixed(1)} days`;
    if (hours >= 1) return `every ${hours.toFixed(1)} h`;
    return `every ${Math.round(hours * 60)} min`;
  }

  function renderLogistics(res) {
    const box = $('#pib-opt-logi'); if (!box) return;
    const s = readLogisticsParams();
    const needs = chainNeeds(calcItem);
    // daily hauled volume per tier — only commodities that leave a planet get moved
    const volByTier = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const [tid, per] of needs) {
      const t = tierOf(tid);
      if (!nodeRole(t, res.model)) continue;              // consumed on-site (e.g. P0 in ext-p1) — not hauled
      volByTier[t] += per * res.R * 24 * (TIER_VOL[t] || 0);
    }
    const finalTier = tierOf(calcItem);
    const finalUnitsDay = res.R * 24;
    const finalVolDay = finalUnitsDay * (TIER_VOL[finalTier] || 0);
    const loads = (v, cap) => (v > 0 ? (v / cap).toFixed(1) : '0');
    let totalVol = 0;
    const rows = [1, 2, 3, 4].filter((t) => volByTier[t] > 0).map((t) => {
      totalVol += volByTier[t];
      const label = t === finalTier ? `P${t} (final → market)` : `P${t} → factories`;
      return `<tr><td>${label}</td><td>${fmtVol(volByTier[t])}</td><td>${loads(volByTier[t], s.epithal)}×</td><td>${loads(volByTier[t], s.dst)}×</td></tr>`;
    }).join('');
    const totalRow = `<tr class="pib-logi-total"><td>Total / day</td><td>${fmtVol(totalVol)}</td><td>${loads(totalVol, s.epithal)}×</td><td>${loads(totalVol, s.dst)}×</td></tr>`;
    // cadence: how often the total chain haul fills one hold
    const epiEvery = totalVol > 0 ? 24 * s.epithal / totalVol : Infinity;
    const dstEvery = totalVol > 0 ? 24 * s.dst / totalVol : Infinity;
    box.innerHTML = `<div class="pib-opt-value-h">Logistics
        <span class="muted">— Epithal ${s.epithal.toLocaleString('en-US')} · DST ${s.dst.toLocaleString('en-US')} m³ (edit in Valuation &amp; logistics)</span></div>
      <table class="pib-opt-vtable pib-logi-table">
        <thead><tr><th>Move</th><th>m³ / day</th><th>Epithal</th><th>DST</th></tr></thead>
        <tbody>${rows}${totalRow}</tbody>
      </table>
      <div class="muted pib-opt-vnote">Final product: ${Math.round(finalUnitsDay).toLocaleString('en-US')}/day · ${fmtVol(finalVolDay)}/day · ${fmtVol(finalVolDay * 30)}/month.
        Move cadence (total chain): fill an Epithal ${fmtEvery(epiEvery)} · a DST ${fmtEvery(dstEvery)}.</div>`;
  }

  // ---- valuation: ISK/day & /month at Jita buy, buyback, and direct export ----
  let optLastBuy = null;      // last Jita buy price for the current target (avoids re-fetching on tweaks)
  let optLastPocoBase = null; // per-final-unit chain POCO taxable base (adjusted prices) from the server
  let optPocoTouched = false; // once the user edits POCO, stop auto-filling it from config

  function readValuationParams() {
    const g = (id, d) => { const e = $('#' + id); return e ? (parseFloat(e.value) || d) : d; };
    return { poco: g('pib-opt-poco', 5) / 100, bb: g('pib-opt-bb', 90) / 100, courierMonth: g('pib-opt-courier', 450) * 1e6 };
  }
  function iskFmt(n) {
    const s = n < 0 ? '-' : ''; n = Math.abs(n);
    if (n >= 1e9) return `${s}${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${s}${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${s}${(n / 1e3).toFixed(1)}k`;
    return s + Math.round(n);
  }

  async function fillValue(res) {
    const box = $('#pib-opt-value'); if (!box) return;
    box.innerHTML = '<span class="muted">Pricing at Jita…</span>';
    let price;
    try { price = await fetch(`${API}/api/pi/price?type_id=${calcItem}`).then((r) => r.json()); }
    catch (e) { box.innerHTML = '<span class="pib-opt-err">Jita price lookup failed.</span>'; return; }
    if (!optPocoTouched && typeof price.poco_tax_rate === 'number') $('#pib-opt-poco').value = +(price.poco_tax_rate * 100).toFixed(2);
    optLastPocoBase = (typeof price.poco_tax_base === 'number') ? price.poco_tax_base : null;
    if (!price.priced || !price.buy) { box.innerHTML = `<span class="muted">${escapeHtml(price.note || 'No Jita buy price available for this item.')}</span>`; return; }
    optLastBuy = price.buy;
    renderValue(res, price.buy);
  }

  function renderValue(res, buy) {
    const box = $('#pib-opt-value'); if (!box) return;
    const v = readValuationParams();
    const outDay = res.R * 24;
    const baseDay = outDay * buy;
    // POCO export tax is charged on every launch off a planet across the chain, on
    // CCP adjusted prices — server gives the taxable base per final unit; the rate
    // stays a live UI input. Fall back to a flat % of final value if the base is absent.
    const pocoDay = optLastPocoBase != null ? outDay * optLastPocoBase * v.poco : baseDay * v.poco;
    const courierDay = v.courierMonth / 30;
    const rows = [
      ['Jita buy (gross)', baseDay],
      [`Corp buyback (${Math.round(v.bb * 100)}%)`, baseDay * v.bb - pocoDay],
      ['Direct export to Jita (PushX)', baseDay - pocoDay - courierDay],
    ];
    const tr = ([label, perDay]) => `<tr><td>${escapeHtml(label)}</td><td>${iskFmt(perDay)}</td><td>${iskFmt(perDay * 30)}</td></tr>`;
    const pocoNote = optLastPocoBase != null
      ? `POCO export tax ${(v.poco * 100).toFixed(1)}% on every chain export (CCP adjusted prices) ≈ ${iskFmt(pocoDay)}/day`
      : `POCO export tax ${(v.poco * 100).toFixed(1)}% (approx, on final value)`;
    box.innerHTML = `<div class="pib-opt-value-h">Estimated value
        <span class="muted">— ${Math.round(outDay).toLocaleString('en-US')} ${escapeHtml(commodityName(calcItem))}/day @ Jita buy ${iskFmt(buy)} ISK</span></div>
      <table class="pib-opt-vtable">
        <thead><tr><th></th><th>ISK / day</th><th>ISK / month</th></tr></thead>
        <tbody>${rows.map(tr).join('')}</tbody>
      </table>
      <div class="muted pib-opt-vnote">${pocoNote}, applied to buyback &amp; export; PushX courier ${iskFmt(v.courierMonth)}/mo on direct export only. Month = 30 days.</div>`;
  }

  // ---- save / recall optimizer plans in local app storage (localStorage) ----
  const OPT_PLANS_KEY = 'pi-opt-plans';
  function loadPlans() { try { return JSON.parse(localStorage.getItem(OPT_PLANS_KEY) || '[]'); } catch (e) { return []; } }
  function storePlans(a) { localStorage.setItem(OPT_PLANS_KEY, JSON.stringify(a)); }
  function refreshPlansList() {
    const sel = $('#pib-opt-plans-list'); if (!sel) return;
    const plans = loadPlans();
    sel.innerHTML = `<option value="">— saved plans (${plans.length}) —</option>`
      + plans.map((p, i) => `<option value="${i}">${escapeHtml(p.name)}</option>`).join('');
  }
  function savePlan() {
    const status = $('#pib-opt-plan-status');
    const name = ($('#pib-opt-plan-name').value || '').trim();
    if (!name) { status.textContent = 'Name the plan first.'; return; }
    if (!calcItem) { status.textContent = 'Pick a target commodity first.'; return; }
    readOptParams();
    const v = readValuationParams();
    const plan = {
      name, targetId: calcItem, targetName: commodityName(calcItem),
      total: Math.max(1, parseInt($('#pib-opt-total').value, 10) || 1),
      params: { ...optParams }, valuation: v, logistics: readLogisticsParams(),
    };
    const plans = loadPlans();
    const idx = plans.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
    if (idx >= 0) plans[idx] = plan; else plans.push(plan);
    storePlans(plans); refreshPlansList();
    status.textContent = `Saved "${name}".`;
  }
  function loadPlan() {
    const sel = $('#pib-opt-plans-list'); const status = $('#pib-opt-plan-status');
    if (sel.value === '') { status.textContent = 'Pick a saved plan.'; return; }
    const plan = loadPlans()[+sel.value]; if (!plan) return;
    const cs = $('#pib-calc-item'); if (cs) cs.value = String(plan.targetId);
    setCalcItem(plan.targetId);
    optParams = { ...plan.params }; renderOptParams();
    $('#pib-opt-total').value = plan.total;
    if (plan.valuation) {
      $('#pib-opt-poco').value = +(plan.valuation.poco * 100).toFixed(2);
      $('#pib-opt-bb').value = Math.round(plan.valuation.bb * 100);
      $('#pib-opt-courier').value = plan.valuation.courierMonth / 1e6;
      optPocoTouched = true;
    }
    if (plan.logistics) {
      $('#pib-opt-epithal').value = plan.logistics.epithal;
      $('#pib-opt-dst').value = plan.logistics.dst;
    }
    $('#pib-opt-plan-name').value = plan.name;
    status.textContent = `Loaded "${plan.name}".`;
    optimizeNow();
  }
  function deletePlan() {
    const sel = $('#pib-opt-plans-list'); const status = $('#pib-opt-plan-status');
    if (sel.value === '') { status.textContent = 'Pick a saved plan to delete.'; return; }
    const plans = loadPlans(); const [rm] = plans.splice(+sel.value, 1);
    storePlans(plans); refreshPlansList();
    status.textContent = rm ? `Deleted "${rm.name}".` : '';
  }

  // ---- suggestion: top 3 most valuable commodities per tier for your planets ----
  // Uses the merged PI Planner's system + POCO rate (/api/pi/analyze), then for
  // each buildable commodity runs the optimizer with your planet budget so the
  // ranking reflects what you can actually make with N planets (ISK/day), with
  // per-unit profit alongside.
  function optSuggestSystem() { const el = $('#pi-system'); return (el && el.value || '').trim(); }

  async function computeSuggestions() {
    const out = $('#pib-opt-suggest-out'); if (!out) return;
    const sys = optSuggestSystem();
    const taxEl = $('#pi-tax'); const taxPct = taxEl ? parseFloat(taxEl.value) : 5;
    $('#pib-opt-suggest-sys').textContent = sys ? `System: ${sys}` : 'All planets (no system)';
    out.innerHTML = '<span class="muted">Ranking…</span>';
    const params = new URLSearchParams();
    if (sys) params.set('system', sys);
    if (!Number.isNaN(taxPct)) params.set('tax_rate', String(taxPct / 100));
    params.set('tiers', '1,2,3,4');
    let d;
    try {
      const r = await fetch(`${API}/api/pi/analyze?${params.toString()}`);
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.detail || r.statusText); }
      d = await r.json();
    } catch (e) { out.innerHTML = `<span class="pib-opt-err">${escapeHtml(e.message || 'Analyze failed — check the system name.')}</span>`; return; }
    readOptParams();
    await loadSystemPlanets();
    const pool = currentSysPool();
    const N = Math.max(1, parseInt($('#pib-opt-total').value, 10) || 1);
    const byTier = { 1: [], 2: [], 3: [], 4: [] };
    for (const row of (d.rows || [])) {
      const t = row.tier; if (!byTier[t]) continue;
      const res = runOptimize(row.type_id, N, optParams, pool);
      if (res.error) continue;                       // infeasible with N planets / this system — skip
      const perDay = res.R * 24;
      byTier[t].push({ tid: row.type_id, name: row.name, perUnit: row.chain_profit, iskDay: perDay * row.chain_profit, unitsDay: perDay, planets: res.used });
    }
    renderSuggestions(byTier, sys, N);
  }

  function renderSuggestions(byTier, sys, N) {
    const out = $('#pib-opt-suggest-out'); if (!out) return;
    const blocks = [1, 2, 3, 4].map((t) => {
      const top = byTier[t].sort((a, b) => b.iskDay - a.iskDay).slice(0, 3);
      const body = top.length
        ? top.map((s, i) => `<div class="pib-sugg-item" data-tid="${s.tid}" tabindex="0" role="button" title="Set as optimizer target">
            <span class="pib-sugg-rank">${i + 1}</span>
            <span class="pib-sugg-name">${escapeHtml(s.name)}</span>
            <span class="pib-sugg-isk">${iskFmt(s.iskDay)}/day</span>
            <span class="pib-sugg-sub muted">${iskFmt(s.perUnit)}/u · ${Math.round(s.unitsDay).toLocaleString('en-US')}/day · ${s.planets}p</span>
          </div>`).join('')
        : `<div class="muted pib-sugg-none">none feasible with ${N} planets</div>`;
      return `<div class="pib-sugg-tier"><div class="pib-sugg-tier-h">P${t}</div>${body}</div>`;
    }).join('');
    out.innerHTML = `<div class="muted pib-sugg-note">${escapeHtml(sys || 'All planets')} · ${N} planets · ISK/day if all planets make that one item · click to target.</div>${blocks}`;
  }

  function suggestTarget(tid) {
    const cs = $('#pib-calc-item'); if (cs) cs.value = String(tid);
    setCalcItem(tid); optimizeNow();
    const el = $('#pib-opt-out'); if (el) el.scrollIntoView({ block: 'nearest' });
  }

  function initOptimizer() {
    if (!optParams) optParams = defaultOptParams('ext-p1', 5);
    renderOptParams(); renderOptToons(); updateOptTarget(); refreshPlansList();
    const sysEl = $('#pib-opt-suggest-sys');
    if (sysEl) { const s = optSuggestSystem(); sysEl.textContent = s ? `System: ${s}` : 'Set a system in the planner above'; }
  }

  function initTab() {
    bindOnce();
    loadStatic().then(() => {
      if (!model) model = emptyModel('Barren');
      renderPalette(); setMeta(); render(); refreshTemplates();
      populateCalc(); initOptimizer();
    });
  }

  // Load a colony model pushed from another tab (e.g. "Open in Builder" on the
  // live PI Colonies view). Ensures listeners + static data are ready first.
  async function loadModel(m) {
    bindOnce();
    await loadStatic();
    model = m; sel = null; selLink = null; linkFrom = null; dirty = false; recenter();
    renderPalette(); setMeta(); render(); refreshTemplates();
    populateCalc(); initOptimizer();
  }
  window.piBuilderLoad = loadModel;

  function bindOnce() {
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
      markDirty(); renderPalette(); render();
    });
    $('#pib-cc').addEventListener('change', (e) => { model.cmd_ctr_level = +e.target.value; markDirty(); render(); });
    $('#pib-diam').addEventListener('change', (e) => { model.diameter = parseFloat(e.target.value) || model.diameter; markDirty(); render(); });
    $('#pib-new').addEventListener('click', () => { model = emptyModel($('#pib-planet').value || 'Barren'); sel = null; selLink = null; dirty = false; renderPalette(); setMeta(); render(); });
    // Clear: empty the colony (pins/links/routes) but keep the planet + CC settings.
    $('#pib-clear').addEventListener('click', () => {
      if (!(model.pins || []).length && !(model.links || []).length) return;
      model.pins = []; model.links = []; model.routes = [];
      sel = null; selLink = null; linkFrom = null; markDirty(); render();
    });
    $('#pib-load').addEventListener('click', requestLoadTemplate);
    $('#pib-save').addEventListener('click', saveTemplate);

    // chain calculator
    $('#pib-calc-item').addEventListener('change', (e) => setCalcItem(e.target.value ? +e.target.value : null));
    $('#pib-calc-qty').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (calcItem && !isNaN(v)) { calcScale = v; updateCalcValues(e.target); }
    });
    $('#pib-calc-out').addEventListener('input', (e) => {
      const inp = e.target.closest('.pib-calc-q'); if (!inp) return;
      const per = parseFloat(inp.dataset.per) || 0, v = parseFloat(inp.value);
      if (per > 0 && !isNaN(v)) { calcScale = v / per; updateCalcValues(inp); }
    });
    // Click a node (not its qty box) to highlight its whole connected sub-chain.
    $('#pib-calc-out').addEventListener('click', (e) => {
      if (e.target.closest('.pib-calc-q')) return;
      const node = e.target.closest('.pib-node');
      if (node) toggleHighlight(+node.dataset.tid);
      else { calcHi = null; applyHighlight(); }
    });
    // planet optimizer
    $('#pib-opt-pull').addEventListener('click', pullPlanets);
    $('#pib-opt-run').addEventListener('click', optimizeNow);
    $('#pib-opt-total').addEventListener('input', () => { /* manual override; used as-is on Optimize */ });
    // model / CC change rebuilds the (recomputed) assumption defaults
    $('#pib-opt-params').addEventListener('change', (e) => {
      if (e.target.id === 'pib-opt-model' || e.target.id === 'pib-opt-cc') {
        optParams = defaultOptParams($('#pib-opt-model').value, +$('#pib-opt-cc').value);
        renderOptParams();
      }
    });
    $('#pib-opt-toons').addEventListener('input', (e) => {
      const inp = e.target.closest('.pib-opt-toon-q'); if (!inp) return;
      optToons[+inp.dataset.i].use = Math.max(0, parseInt(inp.value, 10) || 0);
      optTotalFromToons();
    });
    // valuation tweaks re-render the value table from the cached price (no re-fetch)
    ['pib-opt-poco', 'pib-opt-bb', 'pib-opt-courier'].forEach((id) => {
      $('#' + id).addEventListener('input', () => {
        if (id === 'pib-opt-poco') optPocoTouched = true;
        if (optResult && !optResult.error && optLastBuy != null) renderValue(optResult, optLastBuy);
      });
    });
    // ship-hold tweaks re-render the logistics table (no price needed)
    ['pib-opt-epithal', 'pib-opt-dst'].forEach((id) => {
      $('#' + id).addEventListener('input', () => { if (optResult && !optResult.error) renderLogistics(optResult); });
    });
    // saved plans (local app storage)
    $('#pib-opt-save').addEventListener('click', savePlan);
    $('#pib-opt-load').addEventListener('click', loadPlan);
    $('#pib-opt-del').addEventListener('click', deletePlan);
    // top-PI-by-value suggestion (reuses the merged planner's system)
    $('#pib-opt-suggest-run').addEventListener('click', computeSuggestions);
    $('#pib-opt-suggest-out').addEventListener('click', (e) => {
      const it = e.target.closest('.pib-sugg-item'); if (it) suggestTarget(+it.dataset.tid);
    });
    $('#pib-opt-suggest-out').addEventListener('keydown', (e) => {
      const it = e.target.closest('.pib-sugg-item');
      if (it && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); suggestTarget(+it.dataset.tid); }
    });

    let calcResize;
    window.addEventListener('resize', () => { clearTimeout(calcResize); calcResize = setTimeout(drawFlowLines, 120); render(); });

    // Delete / Backspace removes the selected link (or pin) — but only when the
    // builder canvas is on screen and you're not typing in a field.
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (!$('#pib-svg') || !$('#pib-svg').offsetParent) return;   // builder not visible
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (selLink != null && model.links[selLink]) {
        model.links.splice(selLink, 1); selLink = null; markDirty(); render(); e.preventDefault();
      } else if (sel != null && model.pins[sel]) {
        model.pins.splice(sel, 1); remapAfterDelete(sel); sel = null; linkFrom = null; markDirty(); render(); e.preventDefault();
      }
    });
  }

  document.querySelector('.tab-btn[data-tab="pi-builder"]')?.addEventListener('click', initTab);

  // ================= PI optimiser slide-out =================
  // A side panel (opened by the ⚙ PI buttons in the Production/Reaction planners)
  // that shows this PI commodity's chain + the same optimizer as the full PI
  // planner, so users can size the colony without leaving the planner.
  let slideTid = null, slideName = '', slideWired = false;

  function slideEl() { return document.getElementById('pi-slideout'); }
  function openSlideout() { const s = slideEl(); if (s) { s.hidden = false; requestAnimationFrame(() => s.classList.add('open')); } }
  function closeSlideout() { const s = slideEl(); if (s) { s.classList.remove('open'); setTimeout(() => { s.hidden = true; }, 220); } }

  function wireSlideout() {
    if (slideWired) return; slideWired = true;
    const s = slideEl(); if (!s) return;
    s.querySelectorAll('[data-pi-close]').forEach((b) => b.addEventListener('click', closeSlideout));
    const nInput = document.getElementById('pi-slideout-n');
    let t;
    nInput?.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => { const N = Math.max(1, parseInt(nInput.value, 10) || 1); renderSlideout(slideTid, slideName, N); }, 300);
    });
    document.getElementById('pi-slideout-open')?.addEventListener('click', openFullPlanner);
    document.addEventListener('keydown', (e) => { const el = slideEl(); if (e.key === 'Escape' && el && !el.hidden) closeSlideout(); });
  }

  function openFullPlanner() {
    const N = Math.max(1, parseInt(document.getElementById('pi-slideout-n')?.value, 10) || 12);
    const tid = slideTid;
    document.querySelector('.tab-btn[data-tab="pi-builder"]')?.click();
    // Let initTab load static data + build the optimizer UI, then target it.
    setTimeout(() => {
      populateCalc();
      const sel = $('#pib-calc-item'); if (sel) sel.value = String(tid);
      setCalcItem(tid);
      const tot = $('#pib-opt-total'); if (tot) tot.value = String(N);
      try { optimizeNow(); } catch (_) {}
      closeSlideout();
    }, 420);
  }

  function renderSlideout(typeId, name, N) {
    const body = document.getElementById('pi-slideout-body');
    if (!body) return;
    const tid = Number(typeId);
    const title = document.getElementById('pi-slideout-title');
    if (title) title.textContent = name || commodityName(tid);
    if (!piTypes || !byOutput) { body.innerHTML = '<p class="muted">Loading PI data…</p>'; return; }
    if (!(tierOf(tid) >= 1) || !byOutput[tid]) {
      body.innerHTML = `<div class="pis-empty muted">${escapeHtml(name || commodityName(tid))} isn't a Planetary Interaction commodity, so there's nothing to optimise here.</div>`;
      return;
    }
    if (!optParams) optParams = defaultOptParams('ext-p1', 5);
    let res = runOptimize(tid, N, optParams);
    // First open below the floor → bump the planet count to the real minimum.
    if (res.error && res.minPlanets && res.minPlanets > N) {
      const nInput = document.getElementById('pi-slideout-n');
      if (nInput) nInput.value = String(res.minPlanets);
      res = runOptimize(tid, res.minPlanets, optParams);
      N = res.error ? N : res.minPlanets;
    }

    // Compact chain: one column per tier (P0 raw → product).
    const needs = chainNeeds(tid);
    const byTier = { 0: [], 1: [], 2: [], 3: [], 4: [] };
    for (const [t2] of needs) { const tr = tierOf(t2); if (byTier[tr]) byTier[tr].push(t2); }
    const chainCols = [0, 1, 2, 3, 4].filter((t2) => byTier[t2].length).map((t2) => {
      const items = byTier[t2].sort((a, b) => commodityName(a).localeCompare(commodityName(b)))
        .map((id) => `<div class="pis-chip${id === tid ? ' pis-chip-product' : ''}">${escapeHtml(commodityName(id))}</div>`).join('');
      return `<div class="pis-col"><div class="pis-col-h">${t2 === 0 ? 'P0 raw' : 'P' + t2}</div>${items}</div>`;
    }).join('');

    let optHtml;
    if (res.error) {
      optHtml = `<div class="pib-opt-err">${escapeHtml(res.error)}</div>`;
    } else {
      const fmt = (n) => Math.round(n).toLocaleString('en-US');
      const rate = (n) => (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10).toLocaleString('en-US');
      const share = (a) => (a >= 1 ? Math.round(a * 10) / 10 : Math.round(a * 100) / 100);
      const ext = res.nodes.filter((n) => n.role === 'extractor').sort((a, b) => tierOf(a.tid) - tierOf(b.tid) || commodityName(a.tid).localeCompare(commodityName(b.tid)));
      const fac = res.nodes.filter((n) => n.role === 'factory').sort((a, b) => tierOf(a.tid) - tierOf(b.tid) || commodityName(a.tid).localeCompare(commodityName(b.tid)));
      const extRow = (n) => {
        const p0 = extractorP0(n, res.model);
        const planets = p0PlanetTypes(p0).join(' · ') || '—';
        return `<div class="pis-row${n === res.bottleneck ? ' pis-bottleneck' : ''}"><span class="pis-n">${n.alloc}×</span> <b>${escapeHtml(commodityName(n.tid))}</b> <span class="muted">${res.model === 'ext-p1' ? `extracts ${escapeHtml(commodityName(p0))} · ` : ''}${escapeHtml(planets)}</span> <span class="pis-out muted">${fmt(n.alloc * n.out)}/hr</span></div>`;
      };
      const facRow = (n) => `<div class="pis-row${n === res.bottleneck ? ' pis-bottleneck' : ''}"><span class="pis-n">${share(n.alloc)}×</span> <b>${escapeHtml(commodityName(n.tid))}</b> <span class="muted">P${tierOf(n.tid)} schematic${n.alloc < 0.995 ? ' · shares a planet' : ''}</span> <span class="pis-out muted">${fmt(n.alloc * n.out)}/hr</span></div>`;
      const { tally, factory } = commandCentreTally(res);
      const ccParts = Object.entries(tally).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([t, c]) => `<span class="pis-cc">${escapeHtml(t)} CC ×${c}</span>`);
      if (factory) ccParts.push(`<span class="pis-cc pis-cc-fac">Factory ×${factory} · any type</span>`);
      optHtml = `
        <div class="pis-summary"><b>${rate(res.R)}/hr</b> (${fmt(res.R * 24)}/day) · <b>${res.used}</b> planets · bottleneck: <b>${escapeHtml(commodityName(res.bottleneck.tid))}</b></div>
        <div class="pis-group-h">Command centres to deploy</div><div class="pis-ccs">${ccParts.join('')}</div>
        <div class="pis-group-h">Extractor planets (${ext.length})</div>${ext.map(extRow).join('')}
        ${fac.length ? `<div class="pis-group-h">Factory planets (${res.facPlanets} · schematics consolidated)</div>${fac.map(facRow).join('')}` : ''}`;
    }

    body.innerHTML = `
      <div class="pis-chain"><div class="pis-chain-h muted">Production chain</div><div class="pis-cols">${chainCols}</div></div>
      <div class="pis-opt">${optHtml}</div>
      <p class="muted small">Assumptions from the full PI planner (model ${escapeHtml(optParams.model)}, CC ${optParams.cc}). Open the full planner to tune skills, factories & valuation.</p>`;
  }

  window.openPIOptimizer = async function (typeId, name) {
    slideTid = Number(typeId); slideName = name || '';
    wireSlideout();
    openSlideout();
    const body = document.getElementById('pi-slideout-body');
    const title = document.getElementById('pi-slideout-title');
    if (title) title.textContent = name || `type ${typeId}`;
    if (body) body.innerHTML = '<p class="muted">Loading PI data…</p>';
    try { await loadStatic(); } catch (_) { if (body) body.innerHTML = '<p class="muted">Failed to load PI data.</p>'; return; }
    if (!optParams) optParams = defaultOptParams('ext-p1', 5);
    const nInput = document.getElementById('pi-slideout-n');
    const N = Math.max(1, parseInt(nInput && nInput.value, 10) || 12);
    renderSlideout(slideTid, slideName, N);
  };
})();
