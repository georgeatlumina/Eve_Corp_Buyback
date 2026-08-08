'use strict';

// ============== Profit Favourites (Production group) ==============
// A saved watch-list of buildable items with at-a-glance build profitability.
// Each favourite is built at a batch quantity (so reaction/invention minimums
// amortize) and costed per unit via POST /api/industry/profit — one Janice call
// for the whole list. Persists to localStorage. Reuses app.js globals
// ($, escapeHtml, activateTab) and the .prod-* / .fav-* CSS.

(function () {
  const LS_FAVS = 'prod.favourites.v1';   // [type_id, …]
  const LS_CFG = 'prod.fav.config.v1';    // {batch, me, fee, invention, decryptor, market}
  const state = { favs: [], last: null, loading: false, sort: 'profit' };

  const isk = (n) => (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });

  function loadFavs() {
    try { state.favs = JSON.parse(localStorage.getItem(LS_FAVS) || '[]').filter((x) => Number.isFinite(x)); } catch (_) { state.favs = []; }
  }
  function saveFavs() { try { localStorage.setItem(LS_FAVS, JSON.stringify(state.favs)); } catch (_) {} }

  function loadCfg() {
    let c = {};
    try { c = JSON.parse(localStorage.getItem(LS_CFG) || '{}') || {}; } catch (_) {}
    const set = (id, v) => { const el = $(`#${id}`); if (el != null && v != null) { if (el.type === 'checkbox') el.checked = !!v; else el.value = v; } };
    set('fav-batch', c.batch); set('fav-me', c.me); set('fav-fee', c.fee);
    if (c.invention != null) set('fav-invention', c.invention);
    set('fav-market', c.market); set('fav-system', c.system);
    if (c.decryptor) { const s = $('#fav-decryptor'); if (s) s._pending = c.decryptor; }
  }
  function readCfg() {
    const num = (id, d) => { const v = parseFloat($(`#${id}`)?.value); return Number.isFinite(v) ? v : d; };
    const decr = $('#fav-decryptor')?.value || 'None';
    const cfg = {
      batch: Math.max(1, Math.round(num('fav-batch', 100))),
      me: num('fav-me', 10),
      fee: num('fav-fee', 3.6),
      invention: !!$('#fav-invention')?.checked,
      decryptor: decr,
      market: $('#fav-market')?.value || 'Jita 4-4',
      system: ($('#fav-system')?.value || '').trim(),
    };
    try { localStorage.setItem(LS_CFG, JSON.stringify(cfg)); } catch (_) {}
    return cfg;
  }

  async function loadDecryptors() {
    const sel = $('#fav-decryptor');
    if (!sel || sel.options.length) return;
    try {
      const { decryptors } = await (await fetch(`${API}/api/industry/decryptors`)).json();
      sel.innerHTML = decryptors.map((d) => `<option value="${d.key}">${escapeHtml(d.name)}</option>`).join('');
      if (sel._pending) { sel.value = sel._pending; sel._pending = null; }
    } catch (_) { sel.innerHTML = '<option value="None">No decryptor</option>'; }
  }

  // Debounced type-ahead for the add box.
  let searchTimer = null;
  function onAddInput() {
    clearTimeout(searchTimer);
    const q = $('#fav-add-input')?.value.trim();
    if (!q || q.length < 2) return;
    searchTimer = setTimeout(async () => {
      try {
        const { results } = await (await fetch(`${API}/api/industry/search?q=${encodeURIComponent(q)}&limit=20`)).json();
        const dl = $('#fav-datalist');
        if (dl) dl.innerHTML = (results || []).map((r) => `<option value="${escapeHtml(r.name)}"></option>`).join('');
      } catch (_) {}
    }, 180);
  }

  async function addItem() {
    const input = $('#fav-add-input');
    const status = $('#fav-status');
    const q = (input?.value || '').trim();
    if (!q) return;
    try {
      const { results } = await (await fetch(`${API}/api/industry/search?q=${encodeURIComponent(q)}&limit=20`)).json();
      if (!results || !results.length) { if (status) status.textContent = `No buildable item matches "${q}".`; return; }
      const exact = results.find((r) => r.name.toLowerCase() === q.toLowerCase()) || results[0];
      if (state.favs.includes(exact.type_id)) { if (status) status.textContent = `${exact.name} is already a favourite.`; }
      else { state.favs.push(exact.type_id); saveFavs(); }
      if (input) input.value = '';
      refresh();
    } catch (e) { if (status) status.textContent = `Add failed: ${e.message || e}`; }
  }

  function removeItem(tid) {
    state.favs = state.favs.filter((x) => x !== tid);
    saveFavs();
    refresh();
  }

  function openInPlanner(tid, name) {
    const batch = readCfg().batch;
    activateTab('production');
    const ta = $('#prod-targets');
    if (ta) { ta.value = `${name} x${batch}`; }
    const btn = $('#prod-analyze');
    if (btn) btn.click();
  }

  async function refresh() {
    if (!state.favs.length) { state.last = null; render(); return; }
    if (state.loading) { state.pending = true; return; } // coalesce concurrent adds
    state.loading = true;
    const status = $('#fav-status');
    if (status) status.textContent = 'Pricing favourites…';
    const cfg = readCfg();
    try {
      const res = await fetch(`${API}/api/industry/profit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: state.favs,
          batch: cfg.batch,
          me: cfg.me,
          sales_fee: cfg.fee / 100,
          invention: cfg.invention,
          decryptor: cfg.decryptor === 'None' ? null : cfg.decryptor,
          market: cfg.market,
          system: cfg.system || null,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.last = await res.json();
      render();
    } catch (e) {
      if (status) status.textContent = `Failed: ${e.message || e}`;
    } finally {
      state.loading = false;
      if (state.pending) { state.pending = false; refresh(); } // re-run for adds that arrived mid-flight
    }
  }

  function sortedRows() {
    const rows = (state.last && state.last.rows) ? state.last.rows.slice() : [];
    const key = state.sort;
    rows.sort((a, b) => {
      if (key === 'name') return a.name.localeCompare(b.name);
      const av = a[key], bv = b[key];
      if (av == null) return 1; if (bv == null) return -1;
      return bv - av; // numeric: high to low
    });
    return rows;
  }

  function render() {
    const wrap = $('#fav-table');
    const status = $('#fav-status');
    if (!wrap) return;
    if (!state.favs.length) {
      wrap.innerHTML = '<p class="muted">No favourites yet — add a buildable item above to compare build profitability.</p>';
      if (status) status.textContent = '';
      return;
    }
    const d = state.last;
    if (!d) { wrap.innerHTML = '<p class="muted">Loading…</p>'; return; }
    const rows = sortedRows();
    const th = (key, label, extra) => `<th class="${extra || ''} ${state.sort === key ? 'fav-sorted' : ''}" data-sort="${key}">${label}${state.sort === key ? ' ▾' : ''}</th>`;
    const body = rows.map((r) => {
      const pcls = r.profit > 0 ? 'good-text' : r.profit < 0 ? 'bad-text' : '';
      const margin = r.margin == null ? '—' : `${(r.margin * 100).toFixed(1)}%`;
      return `
      <tr>
        <td><a href="#" class="fav-open" data-tid="${r.type_id}" data-name="${escapeHtml(r.name)}">${escapeHtml(r.name)}</a></td>
        <td class="num">${isk(r.build_cost)}</td>
        <td class="num">${isk(r.sell_value)}</td>
        <td class="num ${pcls}">${isk(r.profit)}</td>
        <td class="num ${pcls}">${margin}</td>
        <td class="prod-action"><button class="prod-toggle" data-remove="${r.type_id}" title="Remove from favourites">✕</button></td>
      </tr>`;
    }).join('');
    wrap.innerHTML = `
      <table class="prod-table fav-table">
        <thead><tr>
          ${th('name', 'Item')}
          ${th('build_cost', 'Build / unit', 'num')}
          ${th('sell_value', 'Sell / unit', 'num')}
          ${th('profit', 'Profit / unit', 'num')}
          ${th('margin', 'Margin', 'num')}
          <th></th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>`;
    if (status) {
      const src = d.pricing ? `priced via ${escapeHtml(d.pricing.source || '—')}${d.pricing.api_key ? '' : ' (no Janice key — set one in Config)'}` : '';
      let sys = '';
      if (d.cost_system) {
        sys = d.cost_system.error ? ` · ⚠ ${escapeHtml(d.cost_system.error)}`
          : ` · cost @ ${escapeHtml(d.cost_system.name)}`;
      }
      status.textContent = `${rows.length} favourite(s) · batch ${d.batch}/item · ${src}${sys}`;
    }
  }

  let wired = false;
  function initTab() {
    loadDecryptors();
    if (!wired) {
      wired = true;
      loadFavs();
      loadCfg();
      $('#fav-add-btn')?.addEventListener('click', addItem);
      $('#fav-add-input')?.addEventListener('input', onAddInput);
      $('#fav-add-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addItem(); } });
      $('#fav-refresh')?.addEventListener('click', refresh);
      ['fav-batch', 'fav-me', 'fav-fee', 'fav-invention', 'fav-decryptor', 'fav-market', 'fav-system'].forEach((id) => {
        $(`#${id}`)?.addEventListener('change', refresh);
      });
      $('#fav-table')?.addEventListener('click', (e) => {
        const rm = e.target.closest('[data-remove]');
        if (rm) { removeItem(Number(rm.dataset.remove)); return; }
        const open = e.target.closest('.fav-open');
        if (open) { e.preventDefault(); openInPlanner(Number(open.dataset.tid), open.dataset.name); return; }
        const th = e.target.closest('th[data-sort]');
        if (th) { state.sort = th.dataset.sort; render(); }
      });
      document.querySelectorAll('#tab-production-favourites [data-tab-link]').forEach((a) => {
        a.addEventListener('click', (e) => { e.preventDefault(); activateTab(a.dataset.tabLink); });
      });
    }
    refresh();
  }

  document.querySelector('.tab-btn[data-tab="production-favourites"]')?.addEventListener('click', initTab);
})();
