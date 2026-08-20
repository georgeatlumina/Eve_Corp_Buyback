'use strict';

// ======================== My Assets tab ========================
// See / search / filter a character's (or all connected toons') assets. Data
// comes from /api/assets (esi-assets.read_assets.v1); locations resolve to
// station/structure names via the same resolver the buyback tabs use.
// Reuses app.js globals ($, API, escapeHtml). Self-registers on the nav button.

(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(s) : String(s == null ? '' : s));
  const num = (n) => (Number(n) || 0).toLocaleString('en-US');

  const state = { toons: [], assets: [], loading: false, toonsLoaded: false };

  function setStatus(m) { const el = $('#assets-status'); if (el) el.textContent = m || ''; }

  async function loadToons() {
    try {
      const data = await (await fetch(`${API}/api/assets/toons`)).json();
      state.toons = data.toons || [];
    } catch { state.toons = []; }
    const sel = $('#assets-toon');
    if (sel) {
      sel.innerHTML = state.toons.length
        ? state.toons.map((t) => `<option value="${esc(t.slot)}">${esc(t.name)}${t.has_assets ? '' : ' — needs re-auth'}</option>`).join('')
        : '<option value="">No connected characters</option>';
    }
    const noneScoped = state.toons.length && state.toons.every((t) => !t.has_assets);
    const hint = $('#assets-authhint');
    if (hint) {
      hint.hidden = !noneScoped;
      if (noneScoped) hint.innerHTML = '⚠ None of your characters have granted the <code>read assets</code> permission yet — re-authenticate them on the Auth tab to load assets.';
    }
    state.toonsLoaded = true;
  }

  function currentLocations() {
    return [...new Set(state.assets.map((a) => a.location_name))].sort();
  }

  function updateLocationFilter() {
    const sel = $('#assets-location');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="all">All locations</option>'
      + currentLocations().map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join('');
    if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
  }

  function filtered() {
    const q = ($('#assets-search')?.value || '').trim().toLowerCase();
    const loc = $('#assets-location')?.value || 'all';
    return state.assets.filter((a) =>
      (!q || (a.type_name || '').toLowerCase().includes(q))
      && (loc === 'all' || a.location_name === loc));
  }

  function tableFor(rows, showToon) {
    const body = rows.map((r) => `<tr>
      <td class="assets-item"><img class="assets-icon" loading="lazy" src="https://images.evetech.net/types/${r.type_id}/icon?size=32" alt="" onerror="this.style.visibility='hidden'"><span>${esc(r.type_name)}</span></td>
      <td class="num">${num(r.quantity)}</td>
      <td>${esc(r.location_name)}</td>
      ${showToon ? `<td>${esc(r.toon)}</td>` : ''}
    </tr>`).join('');
    return `<table class="assets-table">
      <thead><tr><th>Item</th><th class="num">Qty</th><th>Location</th>${showToon ? '<th>Toon</th>' : ''}</tr></thead>
      <tbody>${body}</tbody></table>`;
  }

  function render() {
    const wrap = $('#assets-results');
    if (!wrap) return;
    const rows = filtered();
    const showToon = !!$('#assets-all')?.checked;
    if (!rows.length) { wrap.innerHTML = '<p class="muted">No matching assets.</p>'; return; }
    if ($('#assets-group')?.checked) {
      const byLoc = {};
      rows.forEach((r) => { (byLoc[r.location_name] = byLoc[r.location_name] || []).push(r); });
      wrap.innerHTML = Object.keys(byLoc).sort().map((loc) => {
        const items = byLoc[loc];
        const units = items.reduce((n, r) => n + r.quantity, 0);
        return `<details class="assets-group" open><summary><strong>${esc(loc)}</strong> <span class="muted">· ${items.length} item(s) · ${num(units)} units</span></summary>${tableFor(items, showToon)}</details>`;
      }).join('');
    } else {
      wrap.innerHTML = tableFor(rows, showToon);
    }
  }

  async function load() {
    if (state.loading) return;
    const all = !!$('#assets-all')?.checked;
    const slot = $('#assets-toon')?.value;
    if (!all && !slot) { setStatus('No character selected.'); return; }
    state.loading = true;
    setStatus('Loading assets…');
    const btn = $('#assets-refresh');
    if (btn) btn.disabled = true;
    try {
      const q = all ? 'all=1' : `slot=${encodeURIComponent(slot)}`;
      const data = await (await fetch(`${API}/api/assets?${q}`)).json();
      state.assets = data.assets || [];
      updateLocationFilter();
      render();
      const un = data.unauthorized || [];
      const parts = [`${num(state.assets.reduce((n, r) => n + r.quantity, 0))} units · ${state.assets.length} line(s) · ${data.toon_count} toon(s)`];
      if ((data.errors || []).length) parts.push(`${data.errors.length} fetch error(s)`);
      setStatus(parts.join(' · '));
      const hint = $('#assets-authhint');
      if (hint) {
        hint.hidden = !un.length;
        if (un.length) hint.innerHTML = `⚠ Not shown (no <code>read assets</code> permission): ${un.map((u) => esc(u.name)).join(', ')}. Re-authenticate them on the Auth tab.`;
      }
    } catch (e) {
      setStatus(`Failed to load assets: ${e.message || e}`);
    } finally {
      state.loading = false;
      if (btn) btn.disabled = false;
    }
  }

  // Exposed for the reactions Auto-detect: a flat {type_id: quantity} map across
  // all connected toons (best-effort; empty on failure).
  async function assetTotalsByType() {
    try {
      const data = await (await fetch(`${API}/api/assets?${window.assetsQuery()}`)).json();
      const totals = {};
      for (const r of (data.assets || [])) totals[r.type_id] = (totals[r.type_id] || 0) + r.quantity;
      return { totals, unauthorized: data.unauthorized || [] };
    } catch {
      return { totals: {}, unauthorized: [] };
    }
  }
  window.assetTotalsByType = assetTotalsByType;

  // ---- Shared "which toon's inventory to use" preference (persisted) ----
  // 'all' or a slot name (slot1 / pi3 / fit2 / asset1). Drives the planners'
  // auto-inventory-search (Auto-detect stock + node availability).
  const PREF_KEY = 'planner-assets-toon';
  window.assetsPref = () => localStorage.getItem(PREF_KEY) || 'all';
  window.assetsQuery = () => {
    const v = window.assetsPref();
    return v === 'all' ? 'all=1' : `slot=${encodeURIComponent(v)}`;
  };
  // Populate a <select> with all connected toons + "All connected toons", restore
  // the saved choice, and persist + fire onChange when the user picks one.
  window.populateAssetsToonSelect = async function (selectEl, onChange) {
    if (!selectEl) return;
    let toons = [];
    try { toons = (await (await fetch(`${API}/api/assets/toons`)).json()).toons || []; } catch (_) { /* keep [] */ }
    const cur = window.assetsPref();
    selectEl.innerHTML = '<option value="all">All connected toons</option>'
      + toons.map((t) => `<option value="${escapeHtml(t.slot)}">${escapeHtml(t.name)}${t.has_assets ? '' : ' — needs re-auth'}</option>`).join('');
    selectEl.value = [...selectEl.options].some((o) => o.value === cur) ? cur : 'all';
    if (!selectEl.dataset.wired) {
      selectEl.dataset.wired = '1';
      selectEl.addEventListener('change', () => {
        localStorage.setItem(PREF_KEY, selectEl.value);
        // Keep any other planner's selector in sync with the shared preference.
        document.querySelectorAll('.assets-toon-sel').forEach((el) => { if (el !== selectEl) el.value = selectEl.value; });
        if (onChange) onChange();
      });
    }
  };

  let wired = false;
  function initTab() {
    if (!state.toonsLoaded) loadToons();
    if (wired) return;
    wired = true;
    $('#assets-refresh')?.addEventListener('click', load);
    $('#assets-search')?.addEventListener('input', render);
    $('#assets-location')?.addEventListener('change', render);
    $('#assets-group')?.addEventListener('change', render);
    $('#assets-all')?.addEventListener('change', () => {
      const t = $('#assets-toon');
      if (t) t.disabled = !!$('#assets-all')?.checked;
    });
  }
  document.querySelector('.tab-btn[data-tab="assets"]')?.addEventListener('click', initTab);
})();
