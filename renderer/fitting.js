'use strict';

// ============================ Ship Fitting =============================
// General tab. A web fitting screen on top of Pyfa's vendored `eos` engine
// (backend /api/fit/*). The renderer owns the fit document; every edit posts
// the whole doc to /api/fit/compute for a stateless recompute, then we render
// the slot grid + a live stats panel. Reuses app.js globals (API, $, escapeHtml).

(function () {
  const SLOT = { LOW: 1, MED: 2, HIGH: 3, RIG: 4, SUBSYSTEM: 5 };
  const RACKS = [
    { key: 'subsystem', slot: SLOT.SUBSYSTEM, label: 'Subsystem' },
    { key: 'high', slot: SLOT.HIGH, label: 'High' },
    { key: 'med', slot: SLOT.MED, label: 'Mid' },
    { key: 'low', slot: SLOT.LOW, label: 'Low' },
    { key: 'rig', slot: SLOT.RIG, label: 'Rig' },
  ];
  const SLOT_KEY = { '1': 'low', '2': 'med', '3': 'high', '4': 'rig', '5': 'subsystem' };
  const STATE_ORDER = ['offline', 'online', 'active', 'overheat'];
  const STATE_OF = { '-1': 'offline', '0': 'online', '1': 'active', '2': 'overheat' };
  const DMG = { em: '#6db3f2', thermal: '#e0603a', kinetic: '#9aa7b2', explosive: '#e0a34a' };

  let fit = null;          // { ship, name, modules:[{type,state,charge}], drones:[], cargo:[] }
  let lastStats = null;
  let shipsCache = null;
  let initialised = false;
  let available = null;

  const fmt = (n) => Math.round(n || 0).toLocaleString('en-US');
  function iskShort(n) {
    if (n == null) return '—';
    n = +n;
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return Math.round(n);
  }
  const setStatus = (t) => { const e = $('#fit-status'); if (e) e.textContent = t || ''; };

  // ------------------------------ compute ------------------------------
  async function recompute() {
    if (!fit || !fit.ship) return;
    setStatus('Computing…');
    try {
      const res = await fetch(`${API}/api/fit/compute?price=true`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fit),
      });
      const s = await res.json();
      if (!res.ok) { setStatus('Error: ' + (s.detail || res.statusText)); return; }
      lastStats = s;
      renderRacks(s);
      renderStats(s);
      setStatus((s.warnings || []).length ? s.warnings.join(' · ') : '');
    } catch (e) { setStatus('Compute failed.'); }
  }

  // ------------------------------ racks ------------------------------
  function renderRacks(s) {
    $('#fit-empty').hidden = true;
    const slots = s.resources.slots || {};
    const mods = (s.modules || []).map((m, i) => ({ m, i }));   // index i == fit.modules index
    const header = `<div class="fit-ship-head"><strong>${escapeHtml(s.ship.name)}</strong></div>`;
    const racks = RACKS.map((rack) => {
      const total = (slots[rack.key] || {}).total || 0;
      if (!total) return '';
      const inRack = mods.filter((x) => x.m.slot === rack.slot);
      let cells = '';
      for (let i = 0; i < total; i++) {
        if (i < inRack.length) cells += moduleCell(inRack[i].m, inRack[i].i);
        else cells += `<div class="fit-slot fit-empty-slot" data-add="${rack.slot}"><span>+ add ${rack.label.toLowerCase()}</span></div>`;
      }
      return `<div class="fit-rack"><div class="fit-rack-h">${rack.label} <span class="muted">${inRack.length}/${total}</span></div>${cells}</div>`;
    }).join('');
    $('#fit-racks').innerHTML = header + racks + droneSection(s) + extrasSection(s);
  }

  function extrasSection(s) {
    const modeLine = s.mode ? `<div class="fit-slot fit-mode"><span class="fit-mod-name">Mode: ${escapeHtml(s.mode.name)}</span></div>` : '';
    const listRack = (label, items, addAttr, delAttr, withAmt) => {
      const rows = (items || []).map((it, i) => `
        <div class="fit-slot fit-extra">
          <span class="fit-mod-name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</span>
          ${withAmt ? `<span class="fit-amt"><button data-camt="${i}" data-delta="-1" type="button">−</button><b>${it.amount}</b><button data-camt="${i}" data-delta="1" type="button">+</button></span>` : ''}
          <button class="fit-del" ${delAttr}="${i}" title="Remove" type="button">✕</button>
        </div>`).join('');
      return `<div class="fit-rack"><div class="fit-rack-h">${label} <span class="muted">${(items || []).length}</span></div>${rows}
        <div class="fit-slot fit-empty-slot" ${addAttr}="1"><span>+ add ${label.toLowerCase()}</span></div></div>`;
    };
    return modeLine +
      listRack('Implants', s.implants, 'data-addimplant', 'data-impdel', false) +
      listRack('Boosters', s.boosters, 'data-addbooster', 'data-boostdel', false) +
      listRack('Cargo', s.cargo, 'data-addcargo', 'data-cargodel', true);
  }

  function droneSection(s) {
    const drones = s.drones || [];
    const bw = s.resources.droneBandwidth || { used: 0, total: 0 };
    const ctrl = s.droneControl || { used: 0, total: 0 };
    if (!bw.total && !ctrl.total && !drones.length) return '';
    const rows = drones.map((d, i) => `
      <div class="fit-slot fit-drone" data-didx="${i}">
        <span class="fit-state ${d.active ? 'fit-state-active' : 'fit-state-offline'}" data-dtoggle="${i}" title="${d.active ? 'active' : 'inactive'} — click to toggle"></span>
        <span class="fit-mod-name" title="${escapeHtml(d.name)}">${escapeHtml(d.name)}</span>
        <span class="fit-drone-dps muted">${fmt(d.dps)} dps</span>
        <span class="fit-amt"><button data-damt="${i}" data-delta="-1" type="button">−</button><b>${d.amount}</b><button data-damt="${i}" data-delta="1" type="button">+</button></span>
        <button class="fit-del" data-ddel="${i}" title="Remove" type="button">✕</button>
      </div>`).join('');
    return `<div class="fit-rack"><div class="fit-rack-h">Drones
        <span class="muted">bandwidth ${fmt(bw.used)}/${fmt(bw.total)} Mbit · in space ${ctrl.used}/${ctrl.total}</span></div>
      ${rows}
      <div class="fit-slot fit-empty-slot" data-adddrone="1"><span>+ add drone</span></div></div>`;
  }

  function moduleCell(m, idx) {
    const st = STATE_OF[String(m.state)] || 'active';
    let charge = '';
    if (m.charge) charge = `<span class="fit-charge" data-charge="${idx}" title="Change ammo/script">${escapeHtml(m.charge.name)}</span>`;
    else if (m.chargeable) charge = `<span class="fit-charge fit-charge-empty" data-charge="${idx}" title="Load ammo/script">+ ammo</span>`;
    return `<div class="fit-slot fit-mod" data-idx="${idx}">
      <span class="fit-state fit-state-${st}" data-state="${idx}" title="State: ${st} — click to cycle"></span>
      <span class="fit-mod-name" data-state="${idx}" title="${escapeHtml(m.name)}">${escapeHtml(m.name)}</span>
      ${charge}
      <button class="fit-del" data-del="${idx}" title="Remove" type="button">✕</button>
    </div>`;
  }

  // ------------------------------ stats ------------------------------
  function bar(label, used, total) {
    const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
    const over = used > total + 0.01;
    return `<div class="fit-bar-row"><span class="fit-bar-label">${label}</span>
      <span class="fit-bar"><span class="fit-bar-fill ${over ? 'over' : ''}" style="width:${pct}%"></span></span>
      <span class="fit-bar-num ${over ? 'over' : ''}">${fmt(used)} / ${fmt(total)}</span></div>`;
  }

  function renderStats(s) {
    const bt = s.dps.byType || {};
    const dmgSegs = ['em', 'thermal', 'kinetic', 'explosive'].map((k) => {
      const pct = s.dps.total > 0 ? (bt[k] || 0) / s.dps.total * 100 : 0;
      return `<span style="width:${pct}%;background:${DMG[k]}" title="${k}: ${fmt(bt[k])}"></span>`;
    }).join('');
    const resistRow = (layer, label) => {
      const r = s.resists[layer] || {};
      return `<div class="fit-resist-row"><span class="fit-resist-lbl">${label}</span>` +
        ['em', 'thermal', 'kinetic', 'explosive'].map((k) =>
          `<span class="fit-resist-cell" title="${k}: ${Math.round(r[k] || 0)}%"><span class="fit-resist-bar" style="width:${Math.round(r[k] || 0)}%;background:${DMG[k]}"></span><span class="fit-resist-n">${Math.round(r[k] || 0)}</span></span>`).join('') +
        `</div>`;
    };
    const cap = s.capacitor;
    const capTxt = cap.stable ? `stable ${cap.stableFraction}%` : `depletes in ${cap.lasts_s}s`;
    const ehpTotal = (s.ehp.shield || 0) + (s.ehp.armor || 0) + (s.ehp.hull || 0);
    $('#fit-stats').innerHTML = `
      <div class="fit-stat-block">
        <div class="fit-big"><span class="fit-big-v">${fmt(s.dps.total)}</span> <span class="fit-big-u">DPS</span></div>
        <div class="fit-dmgbar">${dmgSegs}</div>
        <div class="muted fit-sub">weapon ${fmt(s.dps.weapon)} · drone ${fmt(s.dps.drone)} · volley ${fmt(s.volley)}</div>
      </div>
      <div class="fit-stat-block">
        <div class="fit-row"><span>EHP</span><b>${fmt(ehpTotal)}</b></div>
        <div class="fit-resist-head"><span></span><span>EM</span><span>Th</span><span>Kin</span><span>Exp</span></div>
        ${resistRow('shield', 'Shield')}${resistRow('armor', 'Armor')}${resistRow('hull', 'Hull')}
        <div class="muted fit-sub">S ${fmt(s.hp.shield)} · A ${fmt(s.hp.armor)} · H ${fmt(s.hp.hull)}</div>
      </div>
      <div class="fit-stat-block">
        <div class="fit-row"><span>Capacitor</span><b class="${cap.stable ? 'fit-ok' : 'fit-warnt'}">${capTxt}</b></div>
        <div class="fit-row"><span>Max speed</span><b>${fmt(s.speed.max)} m/s</b></div>
        <div class="fit-row"><span>Align</span><b>${s.speed.alignTime}s</b></div>
        <div class="fit-row"><span>Targeting</span><b>${fmt(s.targeting.maxTargetRange / 1000)} km · ${fmt(s.targeting.maxLockedTargets)}×</b></div>
        <div class="fit-row"><span>Sensor str</span><b>${s.targeting.sensorStrength}</b></div>
      </div>
      <div class="fit-stat-block">
        ${bar('CPU', s.resources.cpu.used, s.resources.cpu.total)}
        ${bar('Powergrid', s.resources.pg.used, s.resources.pg.total)}
        ${s.resources.calibration.total ? bar('Calibration', s.resources.calibration.used, s.resources.calibration.total) : ''}
        ${s.resources.droneBandwidth.total ? bar('Drone bandwidth', s.resources.droneBandwidth.used, s.resources.droneBandwidth.total) : ''}
      </div>
      <div class="fit-stat-block">
        <div class="fit-row"><span>Est. value (Jita)</span><b>${iskShort(s.price)} ISK</b></div>
        ${s.valid ? '<div class="fit-ok fit-sub">✓ Fits within CPU/PG/calibration</div>'
                  : `<div class="fit-invalid">⚠ Over limit: ${(s.overLimit || []).join(', ')}</div>`}
      </div>`;
  }

  // ------------------------------ editing ------------------------------
  function newFit(shipType, shipName) {
    fit = { ship: shipType, name: shipName ? `${shipName} fit` : 'New fit', modules: [], drones: [], cargo: [], implants: [], boosters: [], skills: 'all5' };
    $('#fit-name').value = fit.name;
    updateSkillsLabel();
    closeModal();
    recompute();
  }
  function addModule(typeId) { fit.modules.push({ type: typeId }); recompute(); }
  function removeModule(idx) { fit.modules.splice(idx, 1); recompute(); }
  function addDrone(typeId) {
    fit.drones = fit.drones || [];
    const ex = fit.drones.find((d) => d.type === typeId);
    if (ex) ex.amount = (ex.amount || 1) + 1;
    else fit.drones.push({ type: typeId, amount: 1, active: true });
    recompute();
  }
  function droneAmount(i, delta) {
    const d = fit.drones[i]; if (!d) return;
    d.amount = Math.max(0, (d.amount || 0) + delta);
    if (d.amount === 0) fit.drones.splice(i, 1);
    recompute();
  }
  function toggleDrone(i) { const d = fit.drones[i]; if (d) { d.active = !d.active; recompute(); } }
  function removeDrone(i) { fit.drones.splice(i, 1); recompute(); }
  function addImplant(id) { fit.implants = fit.implants || []; fit.implants.push(id); recompute(); }
  function addBooster(id) { fit.boosters = fit.boosters || []; fit.boosters.push(id); recompute(); }
  function addCargo(id) {
    fit.cargo = fit.cargo || [];
    const ex = fit.cargo.find((c) => c.type === id);
    if (ex) ex.amount = (ex.amount || 1) + 1; else fit.cargo.push({ type: id, amount: 1 });
    recompute();
  }
  function cargoAmount(i, delta) {
    const c = fit.cargo[i]; if (!c) return;
    c.amount = Math.max(0, (c.amount || 0) + delta);
    if (c.amount === 0) fit.cargo.splice(i, 1);
    recompute();
  }
  function cycleState(idx) {
    const m = fit.modules[idx]; if (!m) return;
    const cur = m.state || 'active';
    m.state = STATE_ORDER[(STATE_ORDER.indexOf(cur) + 1) % STATE_ORDER.length];
    recompute();
  }
  function setCharge(idx, chargeId) { if (fit.modules[idx]) { fit.modules[idx].charge = chargeId; recompute(); } }

  // ------------------------------ modal / browsers ------------------------------
  function openModal(title, bodyHtml) {
    $('#fit-modal-title').textContent = title;
    $('#fit-modal-body').innerHTML = bodyHtml;
    $('#fit-modal').hidden = false;
  }
  function closeModal() { $('#fit-modal').hidden = true; $('#fit-modal-body').innerHTML = ''; }

  async function openShipBrowser() {
    openModal('Choose ship', `<input class="fit-search" id="fit-search" placeholder="Search ships…" autocomplete="off" />
      <div class="fit-results" id="fit-results"><span class="muted">Loading…</span></div>`);
    if (!shipsCache) {
      try { shipsCache = (await fetch(`${API}/api/fit/ships`).then((r) => r.json())).ships || []; }
      catch (e) { $('#fit-results').innerHTML = '<span class="fit-invalid">Failed to load ships.</span>'; return; }
    }
    const render = (q) => {
      q = (q || '').trim().toLowerCase();
      const list = (q ? shipsCache.filter((s) => s.name.toLowerCase().includes(q)) : shipsCache).slice(0, 300);
      $('#fit-results').innerHTML = list.map((s) =>
        `<div class="fit-result" data-ship="${s.typeID}" data-name="${escapeHtml(s.name)}">
          <span class="fit-result-name">${escapeHtml(s.name)}</span><span class="fit-result-grp muted">${escapeHtml(s.group)}</span></div>`).join('')
        || '<span class="muted">No ships match.</span>';
    };
    render('');
    const inp = $('#fit-search'); inp.focus();
    inp.addEventListener('input', () => render(inp.value));
  }

  function resultRow(it) {
    return `<div class="fit-result" data-pick="${it.typeID}"><span class="fit-result-name">${escapeHtml(it.name)}</span><span class="fit-result-grp muted">${escapeHtml(it.group || '')}</span></div>`;
  }
  function openItemBrowser(title, categories, onPick, slotKey) {
    openModal(title, `<input class="fit-search" id="fit-search" placeholder="Filter… (scroll to browse)" autocomplete="off" />
      <div class="fit-results" id="fit-results"><span class="muted">Loading…</span></div>`);
    const inp = $('#fit-search'); inp.focus();
    let t;
    const search = async () => {
      const q = inp.value.trim();
      let url = `${API}/api/fit/items?q=${encodeURIComponent(q)}&categories=${encodeURIComponent(categories.join(','))}`;
      if (slotKey) url += `&slot=${slotKey}`;
      try {
        const items = (await fetch(url).then((r) => r.json())).items || [];
        $('#fit-results').innerHTML = items.map(resultRow).join('') || '<span class="muted">No items match.</span>';
      } catch (e) { $('#fit-results').innerHTML = '<span class="fit-invalid">Search failed.</span>'; }
    };
    search();   // browse immediately — no search required
    inp.addEventListener('input', () => { clearTimeout(t); t = setTimeout(search, 200); });
    $('#fit-results')._onPick = onPick;
  }

  // Ammo/script picker restricted to a module's compatible charges, browsable.
  async function openChargeBrowser(moduleTypeId, onPick) {
    openModal('Load ammo / script', `<input class="fit-search" id="fit-search" placeholder="Filter compatible charges…" autocomplete="off" />
      <div class="fit-results" id="fit-results"><span class="muted">Loading…</span></div>`);
    const inp = $('#fit-search'); inp.focus();
    let charges = [];
    try { charges = (await fetch(`${API}/api/fit/charges?module_type_id=${moduleTypeId}`).then((r) => r.json())).charges || []; }
    catch (e) { $('#fit-results').innerHTML = '<span class="fit-invalid">Failed to load charges.</span>'; return; }
    const render = (q) => {
      q = (q || '').trim().toLowerCase();
      const list = q ? charges.filter((c) => c.name.toLowerCase().includes(q)) : charges;
      $('#fit-results').innerHTML = list.length ? list.map(resultRow).join('') : '<span class="muted">No compatible charges.</span>';
    };
    render('');
    inp.addEventListener('input', () => render(inp.value));
    $('#fit-results')._onPick = onPick;
  }

  function openEftImport() {
    openModal('Import EFT', `<textarea class="fit-eft" id="fit-eft-in" placeholder="Paste an EFT block…\n[Rifter, My Fit]\n200mm AutoCannon II, Republic Fleet EMP S\n..."></textarea>
      <div class="fit-modal-actions"><button id="fit-eft-load" type="button">Load fit</button></div>`);
    $('#fit-eft-load').addEventListener('click', async () => {
      const eft = $('#fit-eft-in').value;
      try {
        const res = await fetch(`${API}/api/fit/parse`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eft }) });
        const doc = await res.json();
        if (!res.ok) { setStatus('Import error: ' + (doc.detail || res.statusText)); return; }
        fit = { ship: doc.ship, name: doc.name || 'Imported', modules: doc.modules || [], drones: doc.drones || [], cargo: doc.cargo || [] };
        closeModal(); recompute();
        if ((doc.warnings || []).length) setStatus('Imported with warnings: ' + doc.warnings.join('; '));
      } catch (e) { setStatus('Import failed.'); }
    });
  }

  async function openEftExport() {
    if (!fit) return;
    try {
      const res = await fetch(`${API}/api/fit/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fit) });
      const d = await res.json();
      openModal('Export EFT', `<textarea class="fit-eft" id="fit-eft-out" readonly>${escapeHtml(d.eft || '')}</textarea>
        <div class="fit-modal-actions"><button id="fit-eft-copy" type="button">Copy</button></div>`);
      $('#fit-eft-copy').addEventListener('click', () => { $('#fit-eft-out').select(); document.execCommand('copy'); setStatus('Copied EFT.'); });
    } catch (e) { setStatus('Export failed.'); }
  }

  // ------------------------------ ESI in-game fittings ------------------------------
  async function fitCharacters(needWrite) {
    let chars;
    try { chars = (await fetch(`${API}/api/fit/esi/characters`).then((r) => r.json())).characters || []; }
    catch (e) { setStatus('Could not reach ESI.'); return null; }
    return needWrite ? chars.filter((c) => c.can_write) : chars;
  }
  function pickCharacter(chars, title, cb) {
    if (chars.length === 1) { cb(chars[0]); return; }
    openModal(title, chars.map((c) => `<div class="fit-result" data-char="${c.character_id}"><span class="fit-result-name">${escapeHtml(c.name)}</span></div>`).join(''));
    $('#fit-modal-body').querySelectorAll('[data-char]').forEach((el) =>
      el.addEventListener('click', () => cb(chars.find((c) => String(c.character_id) === el.dataset.char))));
  }
  async function openEveFittings() {
    const chars = await fitCharacters(false);
    if (chars == null) return;
    if (!chars.length) { setStatus('No fitting-authorized character — re-login a main, or add a Fitting character, on the Auth tab.'); return; }
    pickCharacter(chars, 'Open from which character?', async (c) => {
      openModal(`${c.name} — in-game fits`, '<div class="fit-results" id="fit-eve-list"><span class="muted">Loading…</span></div>');
      let fits;
      try { fits = (await fetch(`${API}/api/fit/esi/fittings?character_id=${c.character_id}`).then((r) => r.json())).fittings || []; }
      catch (e) { $('#fit-eve-list').innerHTML = '<span class="fit-invalid">Failed to load fittings.</span>'; return; }
      const list = $('#fit-eve-list');
      list.innerHTML = fits.length ? fits.map((f) => `<div class="fit-result" data-fit="${f.fitting_id}">
        <span class="fit-result-name">${escapeHtml(f.name)}</span><span class="fit-result-grp muted">${f.items} items</span>
        <button class="fit-del" data-delfit="${f.fitting_id}" title="Delete in-game" type="button">✕</button></div>`).join('')
        : '<span class="muted">No saved fittings in-game.</span>';
      list.addEventListener('click', (e) => {
        const del = e.target.closest('[data-delfit]');
        if (del) { e.stopPropagation(); deleteEveFit(c.character_id, del.dataset.delfit, del); return; }
        const row = e.target.closest('[data-fit]');
        if (row) { const f = fits.find((x) => String(x.fitting_id) === row.dataset.fit); if (f) loadEveFit(f); }
      });
    });
  }
  function loadEveFit(f) {
    fit = f.doc; fit.skills = fit.skills || 'all5';
    $('#fit-name').value = fit.name || '';
    updateSkillsLabel(); closeModal(); recompute();
  }
  async function deleteEveFit(charId, fitId, btn) {
    if (!confirm('Delete this fitting from the game?')) return;
    try {
      const r = await fetch(`${API}/api/fit/esi/fittings?character_id=${charId}&fitting_id=${fitId}`, { method: 'DELETE' });
      if (r.ok) { const row = btn.closest('[data-fit]'); if (row) row.remove(); setStatus('Deleted in-game fit.'); }
      else setStatus('Delete failed.');
    } catch (e) { setStatus('Delete failed.'); }
  }
  async function saveToEve() {
    if (!fit || !fit.ship) { setStatus('Nothing to save.'); return; }
    const chars = await fitCharacters(true);
    if (chars == null) return;
    if (!chars.length) { setStatus('No write-authorized character — re-login a main on the Auth tab.'); return; }
    const doSave = async (c) => {
      fit.name = ($('#fit-name').value || '').trim() || fit.name || 'Fit';
      closeModal(); setStatus(`Saving to ${c.name}…`);
      try {
        const r = await fetch(`${API}/api/fit/esi/save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ character_id: c.character_id, doc: fit }) });
        const d = await r.json();
        setStatus(r.ok ? `Saved "${d.name}" to ${c.name}'s in-game fittings.` : `Save failed: ${d.detail || r.statusText}`);
      } catch (e) { setStatus('Save failed.'); }
    };
    pickCharacter(chars, 'Save to which character?', doSave);
  }

  // ------------------------------ saved fits (localStorage) ------------------------------
  const SAVED_KEY = 'fitting-saved-fits';
  const loadSaved = () => { try { return JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); } catch (e) { return []; } };
  const storeSaved = (a) => localStorage.setItem(SAVED_KEY, JSON.stringify(a));
  function refreshSavedList() {
    const sel = $('#fit-saved'); if (!sel) return;
    const all = loadSaved();
    sel.innerHTML = `<option value="">— saved fits (${all.length}) —</option>` +
      all.map((f, i) => `<option value="${i}">${escapeHtml(f.name || 'fit')}</option>`).join('');
  }
  function saveFit() {
    if (!fit || !fit.ship) { setStatus('Nothing to save.'); return; }
    fit.name = ($('#fit-name').value || '').trim() || fit.name || 'fit';
    const all = loadSaved();
    const clean = JSON.parse(JSON.stringify(fit));
    const idx = all.findIndex((f) => (f.name || '').toLowerCase() === fit.name.toLowerCase());
    if (idx >= 0) all[idx] = clean; else all.push(clean);
    storeSaved(all); refreshSavedList();
    setStatus(`Saved "${fit.name}".`);
  }
  function loadSavedFit(i) {
    const f = loadSaved()[+i]; if (!f) return;
    fit = JSON.parse(JSON.stringify(f));
    fit.skills = fit.skills || 'all5';
    $('#fit-name').value = fit.name || '';
    updateSkillsLabel(); recompute();
  }
  function deleteSavedFit() {
    const sel = $('#fit-saved'); if (sel.value === '') { setStatus('Pick a saved fit to delete.'); return; }
    const all = loadSaved(); const [rm] = all.splice(+sel.value, 1);
    storeSaved(all); refreshSavedList();
    setStatus(rm ? `Deleted "${rm.name}".` : '');
  }

  // ------------------------------ skills editor ------------------------------
  const skillsMode = () => { const s = fit && fit.skills; if (!s || s === 'all5') return 'all5'; if (s === 'all0') return 'all0'; return 'custom'; };
  function updateSkillsLabel() {
    const b = $('#fit-skills-btn'); if (!b) return;
    const m = skillsMode();
    b.textContent = 'Skills: ' + (m === 'all5' ? 'All V' : m === 'all0' ? 'All 0' : ('Custom L' + ((fit.skills && fit.skills.default) ?? 5)));
  }
  let skillNames = {};   // typeID -> name cache for override display
  function openSkillsEditor() {
    if (!fit) { setStatus('Choose a ship first.'); return; }
    const cur = fit.skills || 'all5';
    const mode = skillsMode();
    const working = (typeof cur === 'object')
      ? { default: cur.default ?? 5, overrides: { ...(cur.overrides || {}) } }
      : { default: 5, overrides: {} };
    let preset = mode;
    const lvlSel = (val, cb) => `<select ${cb}>${[0, 1, 2, 3, 4, 5].map((l) => `<option value="${l}" ${l === val ? 'selected' : ''}>${l}</option>`).join('')}</select>`;

    function renderOverrides() {
      const box = $('#fit-skills-list'); if (!box) return;
      const ids = Object.keys(working.overrides);
      box.innerHTML = ids.length ? ids.map((id) =>
        `<div class="fit-skill-ov"><span>${escapeHtml(skillNames[id] || ('skill ' + id))}</span>
          ${lvlSel(working.overrides[id], `data-ovlvl="${id}"`)}
          <button data-ovdel="${id}" type="button" class="fit-del">✕</button></div>`).join('')
        : '<div class="muted" style="font-size:.85em">No per-skill overrides. All other skills use the default level.</div>';
    }
    function renderBody() {
      openModal('Pilot skills', `
        <div class="fit-skills-presets">
          ${['all5:All V', 'all0:All 0', 'custom:Custom'].map((o) => { const [v, l] = o.split(':'); return `<button type="button" data-smode="${v}" class="secondary ${preset === v ? 'active' : ''}">${l}</button>`; }).join('')}
        </div>
        <div id="fit-skills-custom" ${preset === 'custom' ? '' : 'hidden'}>
          <label class="fit-skills-def">Default level for all skills ${lvlSel(working.default, 'id="fit-skills-deflvl"')}</label>
          <div class="fit-skills-add"><input id="fit-skill-search" class="fit-search" placeholder="Search a skill to override…" autocomplete="off" />
            <div id="fit-skill-results" class="fit-results fit-skill-results"></div></div>
          <div id="fit-skills-list"></div>
        </div>
        <div class="fit-modal-actions"><button id="fit-skills-apply" type="button">Apply</button></div>`);
      renderOverrides();
      bindBody();
    }
    function bindBody() {
      $('#fit-modal-body').querySelectorAll('[data-smode]').forEach((b) => b.addEventListener('click', () => { preset = b.dataset.smode; renderBody(); }));
      const dl = $('#fit-skills-deflvl'); if (dl) dl.addEventListener('change', (e) => { working.default = +e.target.value; });
      const search = $('#fit-skill-search');
      if (search) {
        let t;
        search.addEventListener('input', () => {
          clearTimeout(t);
          t = setTimeout(async () => {
            const q = search.value.trim(); if (q.length < 2) { $('#fit-skill-results').innerHTML = ''; return; }
            const items = (await fetch(`${API}/api/fit/items?q=${encodeURIComponent(q)}&categories=Skill&limit=25`).then((r) => r.json())).items || [];
            $('#fit-skill-results').innerHTML = items.map((it) => { skillNames[it.typeID] = it.name; return `<div class="fit-result" data-skadd="${it.typeID}"><span class="fit-result-name">${escapeHtml(it.name)}</span></div>`; }).join('');
          }, 200);
        });
      }
      const res = $('#fit-skill-results');
      if (res) res.addEventListener('click', (e) => { const a = e.target.closest('[data-skadd]'); if (a) { working.overrides[a.dataset.skadd] = working.overrides[a.dataset.skadd] ?? 5; renderOverrides(); } });
      const list = $('#fit-skills-list');
      if (list) list.addEventListener('change', (e) => { const s = e.target.closest('[data-ovlvl]'); if (s) working.overrides[s.dataset.ovlvl] = +s.value; });
      if (list) list.addEventListener('click', (e) => { const d = e.target.closest('[data-ovdel]'); if (d) { delete working.overrides[d.dataset.ovdel]; renderOverrides(); } });
      const apply = $('#fit-skills-apply');
      if (apply) apply.addEventListener('click', () => {
        if (preset === 'all5') fit.skills = 'all5';
        else if (preset === 'all0') fit.skills = 'all0';
        else fit.skills = { default: working.default, overrides: Object.fromEntries(Object.entries(working.overrides).map(([k, v]) => [k, +v])) };
        updateSkillsLabel(); closeModal(); recompute();
      });
    }
    renderBody();
  }

  // ------------------------------ init ------------------------------
  function initTab() {
    if (initialised) return;
    initialised = true;

    // Attach listeners synchronously so the first clicks always work; the engine
    // availability check runs async and only toggles the "unavailable" banner.
    fetch(`${API}/api/fit/status`).then((r) => r.json()).then((st) => {
      available = !!st.available;
      if (!available) {
        $('#fit-unavailable').hidden = false;
        $('#fit-unavailable').textContent = 'Fitting engine unavailable: ' + (st.error || 'eve.db missing') + '.';
      }
    }).catch(() => { available = false; });

    $('#fit-ship-btn').addEventListener('click', openShipBrowser);
    $('#fit-import-btn').addEventListener('click', openEftImport);
    $('#fit-export-btn').addEventListener('click', () => { if (fit) openEftExport(); else setStatus('Nothing to export.'); });
    $('#fit-eve-open-btn').addEventListener('click', openEveFittings);
    $('#fit-eve-save-btn').addEventListener('click', saveToEve);
    $('#fit-clear-btn').addEventListener('click', () => { if (fit) { fit.modules = []; fit.drones = []; fit.cargo = []; recompute(); } });
    $('#fit-name').addEventListener('change', (e) => { if (fit) fit.name = e.target.value; });
    $('#fit-skills-btn').addEventListener('click', openSkillsEditor);
    $('#fit-save-btn').addEventListener('click', saveFit);
    $('#fit-del-saved').addEventListener('click', deleteSavedFit);
    $('#fit-saved').addEventListener('change', (e) => { if (e.target.value !== '') loadSavedFit(e.target.value); });
    refreshSavedList();
    $('#fit-modal-close').addEventListener('click', closeModal);
    $('#fit-modal').addEventListener('click', (e) => { if (e.target === $('#fit-modal')) closeModal(); });

    // slot-grid interactions (delegated)
    $('#fit-racks').addEventListener('click', (e) => {
      const add = e.target.closest('[data-add]');
      if (add) { const sk = SLOT_KEY[add.dataset.add]; openItemBrowser(`Add ${sk} module`, ['Module', 'Subsystem'], (id) => { addModule(id); closeModal(); }, sk); return; }
      const del = e.target.closest('[data-del]');
      if (del) { removeModule(+del.dataset.del); return; }
      const chg = e.target.closest('[data-charge]');
      if (chg) {
        const idx = +chg.dataset.charge;
        const mtid = (lastStats && lastStats.modules[idx]) ? lastStats.modules[idx].typeID : null;
        if (mtid) openChargeBrowser(mtid, (id) => { setCharge(idx, id); closeModal(); });
        return;
      }
      const stt = e.target.closest('[data-state]');
      if (stt) { cycleState(+stt.dataset.state); return; }
      const adrone = e.target.closest('[data-adddrone]');
      if (adrone) { openItemBrowser('Add drone', ['Drone'], (id) => { addDrone(id); closeModal(); }); return; }
      const ddel = e.target.closest('[data-ddel]');
      if (ddel) { removeDrone(+ddel.dataset.ddel); return; }
      const dtog = e.target.closest('[data-dtoggle]');
      if (dtog) { toggleDrone(+dtog.dataset.dtoggle); return; }
      const damt = e.target.closest('[data-damt]');
      if (damt) { droneAmount(+damt.dataset.damt, +damt.dataset.delta); return; }
      const aimp = e.target.closest('[data-addimplant]');
      if (aimp) { openItemBrowser('Add implant', ['Implant'], (id) => { addImplant(id); closeModal(); }); return; }
      const abst = e.target.closest('[data-addbooster]');
      if (abst) { openItemBrowser('Add booster', ['Booster'], (id) => { addBooster(id); closeModal(); }); return; }
      const acgo = e.target.closest('[data-addcargo]');
      if (acgo) { openItemBrowser('Add to cargo', ['Charge', 'Drone', 'Module'], (id) => { addCargo(id); closeModal(); }); return; }
      const idel = e.target.closest('[data-impdel]');
      if (idel) { fit.implants.splice(+idel.dataset.impdel, 1); recompute(); return; }
      const bdel = e.target.closest('[data-boostdel]');
      if (bdel) { fit.boosters.splice(+bdel.dataset.boostdel, 1); recompute(); return; }
      const cdel = e.target.closest('[data-cargodel]');
      if (cdel) { fit.cargo.splice(+cdel.dataset.cargodel, 1); recompute(); return; }
      const camt = e.target.closest('[data-camt]');
      if (camt) { cargoAmount(+camt.dataset.camt, +camt.dataset.delta); return; }
    });

    // result pick (ships + items share this container)
    $('#fit-modal-body').addEventListener('click', (e) => {
      const ship = e.target.closest('[data-ship]');
      if (ship) { newFit(+ship.dataset.ship, ship.dataset.name); return; }
      const pick = e.target.closest('[data-pick]');
      if (pick) { const cb = $('#fit-results')._onPick; if (cb) cb(+pick.dataset.pick); return; }
    });

    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#fit-modal').hidden) closeModal(); });
  }

  document.querySelector('.tab-btn[data-tab="fitting"]')?.addEventListener('click', initTab);
})();
