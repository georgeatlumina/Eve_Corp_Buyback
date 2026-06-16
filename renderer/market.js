// ====================== Market analytics tab ======================
// Live snapshot of the first configured structure's order book, sell-side led
// (the market is seeded mostly with sell orders). Search / sort / category +
// numeric filters all run client-side over one cached payload fetched from
// /api/market/analytics/stream. Snapshot only; no history.
//
// Doctrine lens: a toggle that swaps the table to doctrine-required items only,
// with quantity-aware shortfall against this market. Reads the Readiness tab's
// scan + toggles straight from localStorage (same keys app.js uses) so no
// re-scrape and no coupling to app.js internals.
//
// Kept in its own file (loaded after app.js) rather than appended to app.js.
// Relies on these globals defined in app.js: $, $$, API, formatIsk,
// escapeHtml, readNdjson.

(() => {
  const LS_SCAN_KEY = 'aa.scan.v1';
  const LS_TOGGLES_KEY = 'aa.toggles.v1';

  const marketState = {
    payload: null,
    loading: false,
    loaded: false,
    lens: false,
    lensRows: null,      // array, or null when no scan is available
    sortKey: 'sell_value',
    sortDir: -1,         // 1 asc, -1 desc
    search: '',
    category: '',
    minValue: 0,
    singleSeller: false,
    hasBuy: false,
    lensStatus: '',
    turnover: null,
    turnoverLoaded: false,
    turnoverLoading: false,
  };

  const TURNOVER_LABELS = { '24h': '24 h', '72h': '72 h', weekly: '7-day', monthly: '30-day' };
  const signIsk = (n) => (n == null ? '—' : `${n >= 0 ? '+' : '−'}${formatIsk(Math.abs(n))}`);

  const mIsk = (n) => (n == null ? '—' : formatIsk(n));
  const nfmt = (n) => Number(n || 0).toLocaleString();

  // Column definitions for each mode. `text: true` sorts lexically; otherwise
  // numeric (nulls always sink). `cell(r)` returns the <td> inner HTML.
  const MARKET_COLS = [
    { key: 'name', label: 'Item', text: true, cls: 'market-name', cell: (r) => escapeHtml(r.name || `type ${r.type_id}`) },
    { key: 'category_name', label: 'Category', text: true, cls: 'muted', cell: (r) => escapeHtml(r.category_name || '') },
    { key: 'best_sell', label: 'Best sell', num: true, cell: (r) => mIsk(r.best_sell) },
    { key: 'sell_orders', label: 'Sell orders', num: true, cell: (r) => nfmt(r.sell_orders) },
    { key: 'sell_units', label: 'Units', num: true, cell: (r) => nfmt(r.sell_units) },
    { key: 'sell_value', label: 'Sell value', num: true, cell: (r) => mIsk(r.sell_value) },
    { key: 'best_buy', label: 'Best buy', num: true, cell: (r) => mIsk(r.best_buy) },
    { key: 'buy_orders', label: 'Buy orders', num: true, cell: (r) => nfmt(r.buy_orders) },
    { key: 'spread_pct', label: 'Spread %', num: true, cell: (r) => (r.spread_pct == null ? '—' : `${r.spread_pct.toFixed(1)}%`) },
  ];
  const LENS_COLS = [
    { key: 'name', label: 'Item', text: true, cls: 'market-name', cell: (r) => escapeHtml(r.name || `type ${r.type_id}`) },
    { key: 'category_name', label: 'Category', text: true, cls: 'muted', cell: (r) => escapeHtml(r.category_name || '') },
    { key: 'required', label: 'Required', num: true, cell: (r) => nfmt(r.required) },
    { key: 'sell_units', label: 'On market', num: true, cell: (r) => nfmt(r.sell_units) },
    { key: 'shortfall', label: 'Shortfall', num: true, cell: (r) => (r.shortfall > 0 ? `<span class="market-short">${nfmt(r.shortfall)}</span>` : '0') },
    { key: 'fit_count', label: '# fits', num: true, cell: (r) => nfmt(r.fit_count) },
    { key: 'best_sell', label: 'Best sell', num: true, cell: (r) => mIsk(r.best_sell) },
    { key: 'status', label: 'Status', text: true, cell: (r) => `<span class="market-status-pill ${r.status}">${r.status}</span>` },
  ];

  const activeCols = () => (marketState.lens ? LENS_COLS : MARKET_COLS);

  // ---- Readiness scan access (read-only, from localStorage) ----
  function readJson(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; }
  }
  // Mirror of app.js `fitIsEnabled`: explicit per-fit toggle wins, else the
  // fit's category toggle (default enabled unless explicitly false).
  function fitEnabled(fit, toggles) {
    const t = toggles || { category: {}, fit: {} };
    const ft = (t.fit || {})[fit.id];
    if (ft === true) return true;
    if (ft === false) return false;
    return (t.category || {})[fit.category] !== false;
  }

  function buildLensRows() {
    const scan = readJson(LS_SCAN_KEY);
    if (!scan || !scan.fits) return null; // signal: no scan available
    const toggles = readJson(LS_TOGGLES_KEY);
    const byType = {};
    if (marketState.payload) {
      for (const r of marketState.payload.rows) byType[r.type_id] = r;
    }
    const agg = new Map(); // type_id -> {type_id, name, required, fit_count}
    for (const f of Object.values(scan.fits)) {
      if (f.error || !f.items) continue;
      if (!fitEnabled(f, toggles)) continue;
      for (const it of f.items) {
        if (it.typeId == null) continue; // unresolved name — can't match the market
        let e = agg.get(it.typeId);
        if (!e) { e = { type_id: it.typeId, name: it.name, required: 0, fit_count: 0 }; agg.set(it.typeId, e); }
        e.required += (it.qty || 0);
        e.fit_count += 1;
      }
    }
    const rows = [];
    for (const e of agg.values()) {
      const m = byType[e.type_id];
      const sellUnits = m ? m.sell_units : 0;
      const shortfall = Math.max(0, e.required - sellUnits);
      let status = 'stocked';
      if (sellUnits === 0) status = 'missing';
      else if (sellUnits < e.required) status = 'short';
      rows.push({
        type_id: e.type_id,
        name: (m && m.name) || e.name || `type ${e.type_id}`,
        category_name: m ? m.category_name : '',
        required: e.required,
        fit_count: e.fit_count,
        sell_units: sellUnits,
        best_sell: m ? m.best_sell : null,
        shortfall,
        status,
      });
    }
    return rows;
  }

  function rebuildLens() {
    marketState.lensRows = marketState.lens ? buildLensRows() : null;
  }

  // ---- load ----
  function initMarketTab() {
    loadTurnover(false);   // independent of the snapshot load; has its own guard
    if (marketState.loaded || marketState.loading) return;
    loadMarketAnalytics(false);
  }

  // Opportunistic daily archive. Fire-and-forget after a successful load; the
  // server gates it (configured? <24h since last? today's file already there?)
  // and no-ops otherwise, so it's safe to call on every load.
  async function maybeArchiveMarket() {
    try {
      const res = await fetch(`${API}/api/market/history/archive`, { method: 'POST' });
      if (!res.ok) return;
      const r = await res.json();
      const note = $('#market-history-status');
      if (r.archived) {
        console.log('[market] archived', r.path);
        if (note) note.textContent = `Archived today's snapshot → ${r.path}`;
      } else if (r.reason && r.reason !== 'not_configured' && r.reason !== 'recent' && note) {
        // surface only actionable problems (bad URL, rejected PAT, etc.)
        if (['bad_repo_url', 'put_failed', 'check_failed', 'fetch_failed'].includes(r.reason)) {
          note.textContent = `Archive skipped (${r.reason}${r.detail ? `: ${r.detail}` : ''}).`;
        }
      }
    } catch (_) { /* opportunistic — never disrupt the dashboard */ }
  }

  // ---- turnover (net on-book change over time, from the daily archive) ----
  async function loadTurnover(refresh) {
    if (marketState.turnoverLoading) return;
    if (marketState.turnoverLoaded && !refresh) { renderTurnover(marketState.turnover); return; }
    marketState.turnoverLoading = true;
    const root = $('#market-turnover');
    if (root && !marketState.turnover) root.innerHTML = '<div class="muted small">Loading turnover…</div>';
    try {
      const res = await fetch(`${API}/api/market/history/turnover`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      marketState.turnover = await res.json();
      marketState.turnoverLoaded = true;
      renderTurnover(marketState.turnover);
    } catch (e) {
      if (root) root.innerHTML = `<div class="muted small">Turnover unavailable: ${escapeHtml(String(e.message || e))}</div>`;
    } finally {
      marketState.turnoverLoading = false;
    }
  }

  function renderTurnover(data) {
    const root = $('#market-turnover');
    if (!root) return;
    if (!data || data.configured === false) {
      root.innerHTML = (data && data.reason === 'bad_repo_url')
        ? '<div class="muted small">Turnover: market-history repo URL looks invalid (check Config).</div>'
        : '<div class="muted small">Turnover history off — set a market-history repo + read PAT in Config; figures fill in as daily snapshots archive.</div>';
      return;
    }
    if (data.reason === 'pat_rejected') {
      root.innerHTML = `<div class="muted small">Turnover: history read PAT rejected (${escapeHtml(data.detail || '')}).</div>`;
      return;
    }
    if (!data.snapshots) {
      root.innerHTML = '<div class="muted small">Turnover: no snapshots archived yet — appears after the first daily archive.</div>';
      return;
    }
    const windows = data.windows || [];
    const head = `<div class="market-turnover-head"><strong>Turnover</strong> <span class="muted small">net on-book change · ${data.snapshots} snapshot${data.snapshots === 1 ? '' : 's'} · latest ${escapeHtml(data.latest_date || '')}</span></div>`;
    if (!windows.some((w) => w.delta_sell_value != null)) {
      root.innerHTML = head + '<div class="muted small">Only one daily snapshot so far — need ≥2 for a delta. Accumulating…</div>';
      return;
    }
    const cards = windows.map((w) => {
      const label = TURNOVER_LABELS[w.key] || w.key;
      if (w.delta_sell_value == null) {
        return `<div class="turnover-card insufficient"><div class="turnover-win">${label}</div><div class="muted small">needs ≥2 snapshots</div></div>`;
      }
      const sCls = w.delta_sell_value >= 0 ? 'pos' : 'neg';
      const bCls = w.delta_buy_value >= 0 ? 'pos' : 'neg';
      const note = w.coverage === 'partial'
        ? `<div class="muted small">only ${w.span_days}d history</div>`
        : `<div class="muted small">vs ${escapeHtml(w.baseline_date || '')}</div>`;
      const pct = (v) => (v == null ? '' : ` <span class="muted small">${v >= 0 ? '+' : ''}${v}%</span>`);
      return `
        <div class="turnover-card">
          <div class="turnover-win">${label}</div>
          <div class="turnover-row"><span class="muted small">Sell</span> <span class="turnover-delta ${sCls}">${signIsk(w.delta_sell_value)}</span>${pct(w.pct_sell)}</div>
          <div class="turnover-row"><span class="muted small">Buy</span> <span class="turnover-delta ${bCls}">${signIsk(w.delta_buy_value)}</span>${pct(w.pct_buy)}</div>
          ${note}
        </div>`;
    }).join('');
    root.innerHTML = head + `<div class="turnover-cards">${cards}</div>`;
  }

  async function loadMarketAnalytics(refresh) {
    if (marketState.loading) return;
    marketState.loading = true;
    const status = $('#market-status');
    const prog = $('#market-progress');
    const fill = prog?.querySelector('.progress-fill');
    const step = prog?.querySelector('.progress-step');
    if (prog) prog.hidden = false;
    if (fill) fill.style.width = '8%';
    if (status) status.textContent = 'Fetching…';
    try {
      const res = await fetch(`${API}/api/market/analytics/stream${refresh ? '?refresh=true' : ''}`);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      let errored = null;
      await readNdjson(res, (ev) => {
        if (ev.event === 'progress') {
          if (step) step.textContent = ev.message || '';
          if (fill && ev.max_pages && ev.page) {
            fill.style.width = `${Math.min(90, Math.round((ev.page / ev.max_pages) * 80) + 8)}%`;
          }
        } else if (ev.event === 'done') {
          marketState.payload = ev.payload;
          marketState.loaded = true;
        } else if (ev.event === 'error') {
          errored = ev.message || 'Unknown error';
        }
      });
      if (errored) throw new Error(errored);
      if (fill) fill.style.width = '100%';
      populateMarketCategories();
      renderMarketTiles();
      rebuildLens();
      renderMarketTable();
      const t = marketState.payload?.totals;
      const when = marketState.payload?.fetched_at
        ? new Date(marketState.payload.fetched_at * 1000).toLocaleTimeString() : '';
      if (status) {
        status.textContent = t
          ? `${nfmt(t.types)} items · ${nfmt(t.orders)} orders · fetched ${when}`
          : '';
      }
      const lbl = $('#market-structure-label');
      if (lbl && marketState.payload) lbl.textContent = `structure ${marketState.payload.structure_id}`;
      maybeArchiveMarket();
    } catch (err) {
      if (status) status.textContent = `Error: ${err.message || err}`;
    } finally {
      marketState.loading = false;
      setTimeout(() => { if (prog) prog.hidden = true; }, 400);
    }
  }

  function populateMarketCategories() {
    const sel = $('#market-category');
    if (!sel || !marketState.payload) return;
    const cur = sel.value;
    const cats = Array.from(new Set(marketState.payload.rows.map((r) => r.category_name).filter(Boolean))).sort();
    sel.innerHTML = '<option value="">All categories</option>'
      + cats.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    if (cats.includes(cur)) sel.value = cur;
  }

  function renderMarketTiles() {
    const root = $('#market-tiles');
    if (!root || !marketState.payload) return;
    const t = marketState.payload.totals;
    const tiles = [
      ['Items on market', nfmt(t.types)],
      ['Total sell value', `${formatIsk(t.total_sell_value)} ISK`],
      ['Total buy value', `${formatIsk(t.total_buy_value)} ISK`],
      ['Sell orders', nfmt(t.sell_orders)],
      ['Buy orders', nfmt(t.buy_orders)],
    ];
    root.innerHTML = tiles.map(([label, val]) => `
      <div class="market-tile"><div class="market-tile-val">${val}</div><div class="market-tile-label">${label}</div></div>
    `).join('');
  }

  function sourceRows() {
    if (marketState.lens) return marketState.lensRows || [];
    return marketState.payload ? marketState.payload.rows : [];
  }

  function filteredSortedRows() {
    const { search, category, minValue, singleSeller, hasBuy, lensStatus, lens, sortKey, sortDir } = marketState;
    const q = search.trim().toLowerCase();
    const rows = sourceRows().filter((r) => {
      if (q && !(r.name || '').toLowerCase().includes(q)) return false;
      if (category && r.category_name !== category) return false;
      if (lens) {
        if (lensStatus && r.status !== lensStatus) return false;
      } else {
        if (minValue && (r.sell_value || 0) < minValue) return false;
        if (singleSeller && r.sell_orders !== 1) return false;
        if (hasBuy && r.buy_orders <= 0) return false;
      }
      return true;
    });
    const col = activeCols().find((c) => c.key === sortKey);
    const isText = col?.text;
    rows.sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      const an = av == null, bn = bv == null;
      if (an && bn) return 0;
      if (an) return 1;   // nulls always sink, regardless of direction
      if (bn) return -1;
      if (isText) return String(av).localeCompare(String(bv)) * sortDir;
      return (av - bv) * sortDir;
    });
    return rows;
  }

  function renderThead() {
    const thead = $('#market-thead');
    if (!thead) return;
    const cols = activeCols();
    thead.innerHTML = `<tr>${cols.map((c) => {
      let cls = c.num ? 'num' : '';
      if (c.key === marketState.sortKey) cls += marketState.sortDir === 1 ? ' sort-asc' : ' sort-desc';
      return `<th data-sort="${c.key}"${cls ? ` class="${cls.trim()}"` : ''}>${c.label}</th>`;
    }).join('')}</tr>`;
    thead.querySelectorAll('th[data-sort]').forEach((th) => {
      th.addEventListener('click', () => marketSortBy(th.dataset.sort));
    });
  }

  function renderMarketTable() {
    renderThead();
    const tbody = $('#market-tbody');
    if (!tbody) return;
    const cols = activeCols();
    const count = $('#market-result-count');
    const note = $('#market-lens-note');

    // Lens on but no Readiness scan -> prompt instead of an empty grid.
    if (marketState.lens && marketState.lensRows === null) {
      if (note) {
        note.hidden = false;
        note.innerHTML = 'No doctrine scan found. Run a scan on the <strong>Market Readiness</strong> tab first, then re-open the lens.';
      }
      tbody.innerHTML = `<tr><td colspan="${cols.length}" class="muted market-empty">No doctrine data.</td></tr>`;
      if (count) count.textContent = '';
      return;
    }
    if (note) note.hidden = true;

    const rows = filteredSortedRows();
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="${cols.length}" class="muted market-empty">No items match the current filters.</td></tr>`;
      if (count) count.textContent = '0 shown';
      return;
    }
    const MAX = 1500;
    const slice = rows.slice(0, MAX);
    tbody.innerHTML = slice.map((r) => `<tr>${cols.map((c) => {
      const cls = [c.num ? 'num' : '', c.cls || ''].filter(Boolean).join(' ');
      return `<td${cls ? ` class="${cls}"` : ''}>${c.cell(r)}</td>`;
    }).join('')}</tr>`).join('');

    if (count) {
      const suffix = marketState.lens ? ' doctrine items' : '';
      count.textContent = rows.length > MAX
        ? `${nfmt(MAX)} of ${nfmt(rows.length)}${suffix} shown (narrow the filter to see the rest)`
        : `${nfmt(rows.length)}${suffix} shown`;
    }
  }

  function marketSortBy(key) {
    if (marketState.sortKey === key) {
      marketState.sortDir = -marketState.sortDir;
    } else {
      marketState.sortKey = key;
      const col = activeCols().find((c) => c.key === key);
      marketState.sortDir = col?.text ? 1 : -1;
    }
    renderMarketTable();
  }

  function setLens(on) {
    marketState.lens = on;
    // Sensible default sort per mode.
    marketState.sortKey = on ? 'shortfall' : 'sell_value';
    marketState.sortDir = -1;
    rebuildLens();
    // Toggle which filters are relevant.
    $$('.market-only').forEach((el) => { el.hidden = on; });
    const statusSel = $('#market-lens-status');
    if (statusSel) statusSel.hidden = !on;
    renderMarketTable();
  }

  // ---- wiring ----
  let searchTimer = null;
  $('#market-search')?.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const v = e.target.value;
    searchTimer = setTimeout(() => { marketState.search = v; renderMarketTable(); }, 180);
  });
  $('#market-category')?.addEventListener('change', (e) => { marketState.category = e.target.value; renderMarketTable(); });
  $('#market-lens-status')?.addEventListener('change', (e) => { marketState.lensStatus = e.target.value; renderMarketTable(); });
  $('#market-min-value')?.addEventListener('input', (e) => { marketState.minValue = Number(e.target.value) || 0; renderMarketTable(); });
  $('#market-single-seller')?.addEventListener('change', (e) => { marketState.singleSeller = e.target.checked; renderMarketTable(); });
  $('#market-has-buy')?.addEventListener('change', (e) => { marketState.hasBuy = e.target.checked; renderMarketTable(); });
  $('#market-lens')?.addEventListener('change', (e) => setLens(e.target.checked));
  $('#market-clear-filters')?.addEventListener('click', () => {
    Object.assign(marketState, { search: '', category: '', minValue: 0, singleSeller: false, hasBuy: false, lensStatus: '' });
    const ids = ['#market-search', '#market-category', '#market-min-value', '#market-lens-status'];
    ids.forEach((id) => { const el = $(id); if (el) el.value = ''; });
    const ss = $('#market-single-seller'); if (ss) ss.checked = false;
    const hb = $('#market-has-buy'); if (hb) hb.checked = false;
    renderMarketTable();
  });
  $('#btn-market-refresh')?.addEventListener('click', () => { loadMarketAnalytics(true); loadTurnover(true); });
  document.querySelector('.tab-btn[data-tab="market"]')?.addEventListener('click', initMarketTab);
})();
