'use strict';

// ============================= Indy section =============================
// Two tabs:
//   • Build Planner   — an industry pilot plans manufacturing jobs, tags each
//     with the doctrine it's built against + an estimated completion date, and
//     pastes the in-game "missing materials" per build slot. Saved to the
//     pilot's own file on the shared repo (builds/{character_id}.json).
//   • Build Fulfilment — an admin dashboard aggregating every builder's missing
//     materials and comparing them against alliance stock (the Stockpile), so
//     directors can prioritise and fill from stock.
//
// Loaded after app.js; relies on its globals: $, $$, API, escapeHtml,
// downloadBlob. Doctrine options come from the doctrine-stock JSON published to
// the git backend (/api/doctrine-stock), the same source the Doctrine Stock tab
// reads.

(function () {
  const ALLIANCES = [
    { key: 'main', label: 'NLDF (Main)' },
    { key: 'institute', label: 'NLDO (Experimental)' },
  ];
  const CAT_LABEL = { minerals: 'Mineral', pi: 'PI', other: 'Other' };

  const nfmt = (n) => Number(n || 0).toLocaleString('en-US');
  const uid = () =>
    (crypto && crypto.randomUUID ? crypto.randomUUID() : `id-${Math.round(performance.now() * 1000)}-${$$('*').length}`);

  function fmtWhen(iso) {
    if (!iso) return 'never';
    const d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleString();
  }

  // ---- Planner state ----
  const p = {
    loaded: false,
    loading: false,
    builds: [],          // working copy the user edits
    canPublish: false,
    storage: 'local',
    doctrines: {},       // { main: [names], institute: [names] } from doctrine-stock
    doctrinesLoaded: false,
    dirty: false,
    drawerSlot: null,    // { buildId, slotId } the drawer is pasting into
  };

  // ============================ Planner: model ============================
  function findBuild(id) { return p.builds.find((b) => b.id === id); }
  function findSlot(build, id) { return build ? (build.slots || []).find((s) => s.id === id) : null; }

  function newSlot() { return { id: uid(), label: '', missing: [] }; }
  function newBuild() {
    return {
      id: uid(),
      doctrine: '',
      alliance: 'main',
      est_completion: '',
      note: '',
      created_at: new Date().toISOString(),
      slots: [newSlot()],
    };
  }

  function setStatus(msg, isErr) {
    const el = $('#indy-planner-status');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('error-text', !!isErr);
  }

  function markDirty() { p.dirty = true; setStatus('Unsaved changes — click “Save & submit”.'); }

  // ============================ Planner: load/save ============================
  async function loadDoctrines(force) {
    if (p.doctrinesLoaded && !force) return;
    await Promise.all(ALLIANCES.map(async (a) => {
      try {
        const res = await fetch(`${API}/api/doctrine-stock?alliance=${a.key}`);
        const snap = res.ok ? await res.json() : {};
        // Each quota row is a ship within a doctrine. Show "Ship — Doctrine" so
        // the same doctrine name on different hulls stays distinguishable.
        const seen = new Set();
        const opts = [];
        (snap.quotas || []).forEach((q) => {
          const ship = (q.ship_name || '').trim();
          const doc = (q.name || '').trim();
          if (!ship && !doc) return;
          const label = ship && doc ? `${ship} — ${doc}` : (ship || doc);
          if (seen.has(label)) return;
          seen.add(label);
          opts.push(label);
        });
        opts.sort((x, y) => x.localeCompare(y));
        p.doctrines[a.key] = opts;
      } catch (_) {
        p.doctrines[a.key] = [];
      }
    }));
    p.doctrinesLoaded = true;
  }

  async function loadMine(force) {
    if (p.loading) return;
    if (p.loaded && !force) { renderBuilds(); return; }
    p.loading = true;
    setStatus('Loading…');
    await loadDoctrines(force);
    try {
      const res = await fetch(`${API}/api/builds/mine`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
      p.builds = (data.builds || []).map((b) => ({
        id: b.id || uid(),
        doctrine: b.doctrine || '',
        alliance: b.alliance || 'main',
        est_completion: b.est_completion || '',
        note: b.note || '',
        created_at: b.created_at || '',
        slots: (b.slots && b.slots.length ? b.slots : [newSlot()]).map((s) => ({
          id: s.id || uid(), label: s.label || '', missing: s.missing || [],
        })),
      }));
      p.canPublish = !!data.can_publish;
      p.storage = data.storage || 'local';
      p.loaded = true;
      p.dirty = false;
      const who = data.builder_name ? ` as ${data.builder_name}` : '';
      const where = p.storage === 'github'
        ? (p.canPublish ? 'shared repo' : 'shared repo (read-only — no write PAT)')
        : 'local only';
      setStatus(`Loaded ${p.builds.length} build(s)${who} · ${where}.`);
    } catch (e) {
      setStatus(`Failed to load: ${e.message || e}`, true);
    } finally {
      p.loading = false;
      renderBuilds();
    }
  }

  async function saveMine() {
    const btn = $('#btn-indy-save');
    if (btn) btn.disabled = true;
    setStatus('Saving…');
    try {
      const res = await fetch(`${API}/api/builds/mine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ builds: p.builds }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
      p.storage = data.storage || 'local';
      p.canPublish = !!data.can_publish;
      p.dirty = false;
      if (data.storage === 'github') {
        setStatus(`Submitted ${p.builds.length} build(s) to the shared repo — visible on Build Fulfilment.`);
      } else {
        setStatus('Saved locally. To share with admins, an alliance write PAT must be set in Config (market-history repo).', true);
      }
    } catch (e) {
      setStatus(`Save failed: ${e.message || e}`, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ============================ Planner: render ============================
  function doctrineOptions(build) {
    const list = (p.doctrines[build.alliance] || []).slice();
    if (build.doctrine && !list.includes(build.doctrine)) list.unshift(build.doctrine);
    const opts = ['<option value="">— select doctrine —</option>'].concat(
      list.map((n) => `<option value="${escapeHtml(n)}"${n === build.doctrine ? ' selected' : ''}>${escapeHtml(n)}</option>`)
    );
    return opts.join('');
  }

  function renderMaterials(build, slot) {
    if (!slot.missing || !slot.missing.length) {
      return '<p class="muted indy-slot-empty">No materials yet — click the box above and paste from the game.</p>';
    }
    const rows = slot.missing.map((m, i) => `
      <tr>
        <td><span class="mat-chip mat-${m.category || 'other'}">${CAT_LABEL[m.category] || 'Other'}</span> ${escapeHtml(m.name)}</td>
        <td class="num">${nfmt(m.qty)}</td>
        <td class="indy-mat-x"><button type="button" class="linklike" data-act="rm-mat" data-build="${build.id}" data-slot="${slot.id}" data-idx="${i}" title="Remove">×</button></td>
      </tr>`).join('');
    return `
      <div class="market-table-wrap">
        <table class="market-table indy-mat-table">
          <thead><tr><th>Material</th><th class="num">Qty</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function renderSlot(build, slot) {
    const count = (slot.missing || []).length;
    const boxLabel = count
      ? `${count} material${count === 1 ? '' : 's'} — click to replace paste`
      : 'Click to paste missing materials from the game';
    return `
      <div class="indy-slot" data-slot="${slot.id}">
        <div class="indy-slot-head">
          <input type="text" class="indy-slot-label" data-field="label" data-build="${build.id}" data-slot="${slot.id}"
                 placeholder="Build slot label (e.g. “Ferox ×10”)" value="${escapeHtml(slot.label || '')}" />
          <button type="button" class="secondary indy-rm-slot" data-act="rm-slot" data-build="${build.id}" data-slot="${slot.id}">Remove slot</button>
        </div>
        <button type="button" class="indy-paste-box${count ? ' has-materials' : ''}" data-act="open-paste" data-build="${build.id}" data-slot="${slot.id}">
          <span class="indy-paste-box-icon">📋</span> ${boxLabel}
        </button>
        ${renderMaterials(build, slot)}
      </div>`;
  }

  function renderBuild(build) {
    const allianceBtns = ALLIANCES.map((a) =>
      `<button type="button" class="alliance-btn${build.alliance === a.key ? ' active' : ''}" data-act="set-alliance" data-build="${build.id}" data-alliance="${a.key}">${escapeHtml(a.label)}</button>`
    ).join('');
    const slots = (build.slots || []).map((s) => renderSlot(build, s)).join('');
    return `
      <div class="indy-build" data-build="${build.id}">
        <div class="indy-build-head">
          <label class="indy-field indy-field-doctrine">Doctrine
            <select data-field="doctrine" data-build="${build.id}">${doctrineOptions(build)}</select>
          </label>
          <div class="indy-field">Alliance
            <div class="alliance-toggle indy-alliance">${allianceBtns}</div>
          </div>
          <label class="indy-field">Est. completion
            <input type="date" data-field="est_completion" data-build="${build.id}" value="${escapeHtml(build.est_completion || '')}" />
          </label>
          <button type="button" class="secondary indy-rm-build" data-act="rm-build" data-build="${build.id}">Delete build</button>
        </div>
        <label class="indy-field indy-note">Note
          <input type="text" data-field="note" data-build="${build.id}" placeholder="Optional — e.g. staging, priority, who it's for" value="${escapeHtml(build.note || '')}" />
        </label>
        <div class="indy-slots">${slots}</div>
        <button type="button" class="secondary indy-add-slot" data-act="add-slot" data-build="${build.id}">+ Add build slot</button>
      </div>`;
  }

  function renderBuilds() {
    const root = $('#indy-builds');
    if (!root) return;
    if (!p.builds.length) {
      root.innerHTML = '<p class="muted">No builds yet. Click <strong>+ New build</strong> to start planning.</p>';
      return;
    }
    root.innerHTML = p.builds.map(renderBuild).join('');
  }

  // ============================ Planner: events ============================
  function wirePlanner() {
    $('#btn-indy-add-build')?.addEventListener('click', () => {
      p.builds.push(newBuild());
      markDirty();
      renderBuilds();
    });
    $('#btn-indy-save')?.addEventListener('click', saveMine);
    $('#btn-indy-reload')?.addEventListener('click', () => {
      if (p.dirty && !confirm('Discard unsaved changes and reload from the repo?')) return;
      loadMine(true);
    });

    const root = $('#indy-builds');
    if (!root) return;

    // Text/select/date field edits — update the in-memory model in place.
    const onFieldChange = (e) => {
      const el = e.target.closest('[data-field]');
      if (!el) return;
      const build = findBuild(el.dataset.build);
      if (!build) return;
      const field = el.dataset.field;
      if (field === 'label') {
        const slot = findSlot(build, el.dataset.slot);
        if (slot) slot.label = el.value;
      } else {
        build[field] = el.value;
      }
      markDirty();
    };
    root.addEventListener('input', onFieldChange);
    root.addEventListener('change', onFieldChange);

    // Buttons — structural actions.
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      const build = findBuild(btn.dataset.build);
      if (!build) return;
      if (act === 'set-alliance') {
        if (build.alliance === btn.dataset.alliance) return;
        build.alliance = btn.dataset.alliance;
        markDirty();
        renderBuilds();
      } else if (act === 'add-slot') {
        build.slots.push(newSlot());
        markDirty();
        renderBuilds();
      } else if (act === 'rm-slot') {
        build.slots = build.slots.filter((s) => s.id !== btn.dataset.slot);
        if (!build.slots.length) build.slots.push(newSlot());
        markDirty();
        renderBuilds();
      } else if (act === 'rm-build') {
        if (!confirm('Delete this build and its slots?')) return;
        p.builds = p.builds.filter((b) => b.id !== build.id);
        markDirty();
        renderBuilds();
      } else if (act === 'rm-mat') {
        const slot = findSlot(build, btn.dataset.slot);
        if (slot) slot.missing.splice(Number(btn.dataset.idx), 1);
        markDirty();
        renderBuilds();
      } else if (act === 'open-paste') {
        openDrawer(build.id, btn.dataset.slot);
      }
    });
  }

  // ============================ Paste drawer ============================
  function openDrawer(buildId, slotId) {
    p.drawerSlot = { buildId, slotId };
    const build = findBuild(buildId);
    const slot = findSlot(build, slotId);
    $('#indy-drawer-title').textContent = slot && slot.label ? `Paste materials — ${slot.label}` : 'Paste missing materials';
    $('#indy-drawer-paste').value = '';
    $('#indy-drawer-status').textContent = '';
    const drawer = $('#indy-paste-drawer');
    const overlay = $('#indy-paste-overlay');
    overlay.hidden = false;
    drawer.hidden = false;
    drawer.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => { drawer.classList.add('open'); overlay.classList.add('open'); });
    setTimeout(() => $('#indy-drawer-paste')?.focus(), 60);
  }

  function closeDrawer() {
    const drawer = $('#indy-paste-drawer');
    const overlay = $('#indy-paste-overlay');
    drawer.classList.remove('open');
    overlay.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    setTimeout(() => { drawer.hidden = true; overlay.hidden = true; }, 200);
    p.drawerSlot = null;
  }

  async function parseDrawer() {
    const text = ($('#indy-drawer-paste')?.value || '').trim();
    const statusEl = $('#indy-drawer-status');
    if (!text) { statusEl.textContent = 'Paste the missing materials first.'; return; }
    if (!p.drawerSlot) { closeDrawer(); return; }
    const btn = $('#indy-drawer-parse');
    if (btn) btn.disabled = true;
    statusEl.textContent = 'Resolving materials…';
    try {
      const res = await fetch(`${API}/api/builds/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
      const build = findBuild(p.drawerSlot.buildId);
      const slot = findSlot(build, p.drawerSlot.slotId);
      if (slot) {
        slot.missing = data.items || [];
        markDirty();
        renderBuilds();
      }
      const unresolved = data.unresolved || [];
      const warn = unresolved.length ? ` (${unresolved.length} name(s) unresolved: ${unresolved.slice(0, 6).join(', ')}${unresolved.length > 6 ? '…' : ''})` : '';
      statusEl.textContent = `Added ${(data.items || []).length} material(s)${warn}.`;
      setTimeout(closeDrawer, unresolved.length ? 1800 : 500);
    } catch (e) {
      statusEl.textContent = `Parse failed: ${e.message || e}`;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function wireDrawer() {
    $('#indy-drawer-close')?.addEventListener('click', closeDrawer);
    $('#indy-drawer-cancel')?.addEventListener('click', closeDrawer);
    $('#indy-paste-overlay')?.addEventListener('click', closeDrawer);
    $('#indy-drawer-parse')?.addEventListener('click', parseDrawer);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('#indy-paste-drawer')?.hidden) closeDrawer();
    });
  }

  // ============================ Fulfilment dashboard ============================
  const f = {
    loaded: false,
    loading: false,
    missing: [],       // aggregated from /api/builds/all
    builders: [],
    stock: null,       // /api/stockpile
    storage: 'local',
    view: 'materials',
    sort: 'shortfall',
    hideOk: false,
  };

  function stockMap(stock) {
    const byId = new Map();
    const byName = new Map();
    (stock?.items || []).forEach((it) => {
      if (it.type_id) byId.set(Number(it.type_id), (byId.get(Number(it.type_id)) || 0) + Number(it.qty || 0));
      byName.set((it.name || '').toLowerCase(), (byName.get((it.name || '').toLowerCase()) || 0) + Number(it.qty || 0));
    });
    return { byId, byName };
  }

  function availableFor(mat, sm) {
    if (mat.type_id && sm.byId.has(Number(mat.type_id))) return sm.byId.get(Number(mat.type_id));
    return sm.byName.get((mat.name || '').toLowerCase()) || 0;
  }

  function matState(needed, available) {
    if (needed <= 0) return 'unset';
    if (available >= needed) return 'ok';
    return available > 0 ? 'partial' : 'empty';
  }

  function earliestDeadline(mat) {
    const ds = (mat.sources || []).map((s) => s.est_completion).filter(Boolean).sort();
    return ds[0] || '';
  }

  function setFStatus(msg) {
    const el = $('#indy-fulfil-status');
    if (el) el.textContent = msg || '';
  }

  async function loadFulfil(force) {
    if (f.loading) return;
    if (f.loaded && !force) { renderFulfil(); return; }
    f.loading = true;
    setFStatus('Loading…');
    try {
      const [bRes, sRes] = await Promise.all([
        fetch(`${API}/api/builds/all`),
        fetch(`${API}/api/stockpile`),
      ]);
      const bData = await bRes.json().catch(() => ({}));
      const sData = await sRes.json().catch(() => ({}));
      f.missing = bData.missing || [];
      f.builders = bData.builders || [];
      f.storage = bData.storage || 'local';
      f.stock = sData;
      f.loaded = true;
      setFStatus('');
    } catch (e) {
      setFStatus(`Failed to load: ${e.message || e}`);
    } finally {
      f.loading = false;
      renderFulfil();
    }
  }

  function renderFulfilTiles(sm) {
    const root = $('#indy-fulfil-tiles');
    if (!root) return;
    const tile = (val, label) =>
      `<div class="market-tile"><div class="market-tile-val">${val}</div><div class="market-tile-label">${label}</div></div>`;
    const totalBuilds = f.builders.reduce((s, d) => s + (d.builds || []).length, 0);
    const totalSlots = f.builders.reduce((s, d) => s + (d.builds || []).reduce((t, b) => t + (b.slots || []).length, 0), 0);
    const shortfalls = f.missing.filter((m) => Math.max(0, m.needed - availableFor(m, sm)) > 0).length;
    const src = f.storage === 'github' ? 'Shared repo' : 'Local only';
    root.innerHTML = [
      tile(nfmt(f.builders.length), 'Builders'),
      tile(nfmt(totalBuilds), 'Builds'),
      tile(nfmt(totalSlots), 'Slots'),
      tile(nfmt(f.missing.length), 'Distinct materials'),
      tile(nfmt(shortfalls), 'Short in stock'),
      tile(escapeHtml(src), 'Source'),
    ].join('');
  }

  function sortedMaterials(sm) {
    let rows = f.missing.map((m) => {
      const available = availableFor(m, sm);
      const shortfall = Math.max(0, m.needed - available);
      return { ...m, available, shortfall, state: matState(m.needed, available), deadline: earliestDeadline(m) };
    });
    if (f.hideOk) rows = rows.filter((r) => r.shortfall > 0);
    rows.sort((a, b) => {
      if (f.sort === 'deadline') {
        const ad = a.deadline || '9999-12-31';
        const bd = b.deadline || '9999-12-31';
        if (ad !== bd) return ad < bd ? -1 : 1;
        return b.shortfall - a.shortfall;
      }
      if (f.sort === 'needed') return b.needed - a.needed;
      return b.shortfall - a.shortfall; // shortfall (default)
    });
    return rows;
  }

  function renderMaterialsView(sm) {
    const rows = sortedMaterials(sm);
    if (!rows.length) {
      return f.missing.length
        ? '<p class="muted">Every material is fully covered by alliance stock. 🎉</p>'
        : '<p class="muted">No missing materials submitted yet.</p>';
    }
    return rows.map((r) => {
      const pct = r.needed > 0 ? Math.min(100, Math.round((r.available / r.needed) * 100)) : 0;
      const who = Array.from(new Set((r.sources || []).map((s) => s.builder))).slice(0, 4).join(', ');
      const deadline = r.deadline ? ` · due ${r.deadline}` : '';
      return `
        <div class="quota-bar quota-${r.state} indy-fulfil-bar">
          <div class="quota-bar-head">
            <strong><span class="mat-chip mat-${r.category || 'other'}">${CAT_LABEL[r.category] || 'Other'}</span> ${escapeHtml(r.name)}</strong>
            <span class="muted">${escapeHtml(who)}${(r.sources || []).length > 4 ? '…' : ''}${deadline}</span>
            <span class="quota-counts">${nfmt(r.available)} / ${nfmt(r.needed)}${r.shortfall ? ` · short ${nfmt(r.shortfall)}` : ' · covered'}</span>
          </div>
          <div class="quota-bar-track"><div class="quota-bar-fill" style="width:${pct}%"></div></div>
        </div>`;
    }).join('');
  }

  function renderBuildsView(sm) {
    const cards = [];
    f.builders.forEach((doc) => {
      (doc.builds || []).forEach((b) => {
        const slots = (b.slots || []).map((sl) => {
          const mats = (sl.missing || []).map((m) => {
            const avail = availableFor(m, sm);
            const state = matState(Number(m.qty), avail);
            return `<tr class="mat-row-${state}">
              <td><span class="mat-chip mat-${m.category || 'other'}">${CAT_LABEL[m.category] || 'Other'}</span> ${escapeHtml(m.name)}</td>
              <td class="num">${nfmt(m.qty)}</td>
              <td class="num">${nfmt(avail)}</td>
              <td class="num">${nfmt(Math.max(0, Number(m.qty) - avail))}</td>
            </tr>`;
          }).join('');
          const body = mats || '<tr><td colspan="4" class="muted">No materials pasted.</td></tr>';
          return `<div class="indy-fulfil-slot"><div class="indy-fulfil-slot-label">${escapeHtml(sl.label || 'Slot')}</div>
            <div class="market-table-wrap"><table class="market-table"><thead><tr><th>Material</th><th class="num">Needed</th><th class="num">In stock</th><th class="num">Short</th></tr></thead><tbody>${body}</tbody></table></div></div>`;
        }).join('');
        cards.push(`
          <div class="indy-fulfil-build">
            <div class="indy-fulfil-build-head">
              <strong>${escapeHtml(b.doctrine || 'Untitled build')}</strong>
              <span class="muted">${escapeHtml(doc.builder_name || ('char ' + doc.builder_id))} · ${escapeHtml(b.alliance || 'main')}${b.est_completion ? ` · due ${escapeHtml(b.est_completion)}` : ''}</span>
              ${b.note ? `<span class="muted indy-fulfil-note">${escapeHtml(b.note)}</span>` : ''}
            </div>
            ${slots}
          </div>`);
      });
    });
    return cards.length ? cards.join('') : '<p class="muted">No builds submitted yet.</p>';
  }

  function renderFulfil() {
    const root = $('#indy-fulfil-dashboard');
    if (!root) return;
    if (f.loading) { root.innerHTML = '<p class="muted">Loading…</p>'; return; }
    const sm = stockMap(f.stock);
    renderFulfilTiles(sm);
    if (f.storage !== 'github') {
      setFStatus('Shared repo not configured (or unreachable) — showing local builds only. Set the market-history repo + PATs in Config to aggregate the whole alliance.');
    } else {
      const stockWhen = f.stock && f.stock.updated_at ? fmtWhen(f.stock.updated_at) : 'never';
      setFStatus(`${f.builders.length} builder file(s) · stock updated ${stockWhen}.`);
    }
    root.innerHTML = f.view === 'builds' ? renderBuildsView(sm) : renderMaterialsView(sm);
  }

  function exportShortfallCsv() {
    const sm = stockMap(f.stock);
    const rows = sortedMaterials(sm).filter((r) => r.shortfall > 0);
    if (!rows.length) { setFStatus('No shortfalls to export.'); return; }
    const header = 'material,type_id,category,needed,in_stock,shortfall,earliest_deadline';
    const body = rows.map((r) => [
      `"${(r.name || '').replace(/"/g, '""')}"`,
      r.type_id || '', r.category || 'other', r.needed, r.available, r.shortfall, r.deadline || '',
    ].join(',')).join('\n');
    downloadBlob('indy-shortfalls.csv', 'text/csv', `${header}\n${body}\n`);
  }

  async function copyShortfallList() {
    const sm = stockMap(f.stock);
    const rows = sortedMaterials(sm).filter((r) => r.shortfall > 0);
    if (!rows.length) { setFStatus('No shortfalls — nothing to copy.'); return; }
    const text = rows.map((r) => `${r.name}\t${r.shortfall}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setFStatus(`Copied ${rows.length} shortfall line(s) to clipboard (multibuy format).`);
    } catch (_) {
      setFStatus('Clipboard copy failed.');
    }
  }

  function wireFulfil() {
    $('#btn-indy-fulfil-refresh')?.addEventListener('click', () => loadFulfil(true));
    $('#indy-fulfil-view')?.addEventListener('change', (e) => { f.view = e.target.value; renderFulfil(); });
    $('#indy-fulfil-sort')?.addEventListener('change', (e) => { f.sort = e.target.value; renderFulfil(); });
    $('#indy-fulfil-hide-ok')?.addEventListener('change', (e) => { f.hideOk = e.target.checked; renderFulfil(); });
    $('#btn-indy-fulfil-export-csv')?.addEventListener('click', exportShortfallCsv);
    $('#btn-indy-fulfil-export-text')?.addEventListener('click', copyShortfallList);
  }

  // ============================ Init ============================
  wirePlanner();
  wireDrawer();
  wireFulfil();
  document.querySelector('.tab-btn[data-tab="indy-planner"]')?.addEventListener('click', () => loadMine(false));
  document.querySelector('.tab-btn[data-tab="indy-fulfil"]')?.addEventListener('click', () => loadFulfil(false));
})();
