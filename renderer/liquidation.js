// ====================== Liquidation tab ======================
// Ship buyback Amarr -> Jita (PushX courier) and sell it for more than the 90%
// Amarr buy we paid. Three sub-views:
//   1. Analyze / Plan — paste a courier contract, get per-item margin +
//      liquidity + a dump-vs-list recommendation ranked by annualized ROI.
//   2. Shipments — courier contracts in flight (auto PushX cost + ETA).
//   3. Open orders — live Jita corp sell orders from ESI, with staleness flags.
//
// Loaded after app.js; relies on its globals: $, $$, API, formatIsk,
// escapeHtml, readNdjson.

(() => {
  const liq = {
    analysis: null,
    analyzing: false,
    shipments: [],
    shipmentsMeta: { accept_days: 3, deliver_days: 3, storage: 'local' },
    shipmentsLoaded: false,
    orders: null,
    ordersLoaded: false,
    ordersLoading: false,
    sub: 'analyze',
    search: '',
    actionFilter: '',
    aSortKey: 'list_value',
    aSortDir: -1,
    staleOnly: false,
    courier: null,
    courierLoaded: false,
    courierLoading: false,
    courierFilter: 'active',
    courierAllProviders: false,
  };

  const janiceCode = (title) => { const m = /\/a\/([A-Za-z0-9]+)/.exec(title || ''); return m ? m[1] : null; };

  const mIsk = (n) => (n == null ? '—' : formatIsk(n));
  const nfmt = (n) => Number(n || 0).toLocaleString();
  const pct = (n, d = 1) => (n == null ? '—' : `${n.toFixed(d)}%`);
  const days = (n) => (n == null ? '—' : n >= 100 ? `${Math.round(n)}d` : `${n.toFixed(1)}d`);
  const nowSec = () => Date.now() / 1000;

  const ACTION_LABEL = {
    list: 'List', dump: 'Dump now', underwater: 'Underwater', no_data: 'No data',
  };
  function actionPill(r) {
    const label = r.action === 'list' && r.window_days ? `List ${r.window_days}d` : (ACTION_LABEL[r.action] || r.action);
    return `<span class="liq-pill liq-${r.action}" title="${escapeHtml(r.reason || '')}">${escapeHtml(label)}</span>`;
  }

  // ---- Analyze columns ----
  const A_COLS = [
    { key: 'name', label: 'Item', text: true, cell: (r) => `${escapeHtml(r.name)}${r.low_confidence ? ' <span class="liq-warn" title="Near-zero Amarr buy — the margin % is unreliable and the ISK is trivial">⚠</span>' : ''} <button class="liq-info-btn" data-info="${r.type_id}" data-name="${escapeHtml(r.name)}" title="Market detail">ⓘ</button>` },
    { key: 'quantity', label: 'Qty', num: true, cell: (r) => nfmt(r.quantity) },
    { key: 'cost_basis_unit', label: 'Cost basis', num: true, cell: (r) => mIsk(r.cost_basis_unit) },
    { key: 'sell_unit', label: 'Jita sell', num: true, cell: (r) => mIsk(r.sell_unit) },
    { key: 'buy_unit', label: 'Jita buy', num: true, cell: (r) => mIsk(r.buy_unit) },
    { key: 'spread_pct', label: 'Spread', num: true, cell: (r) => pct(r.spread_pct) },
    { key: 'list_margin_pct', label: 'List margin', num: true, cell: (r) => marginCell(r.list_margin_pct) },
    { key: 'dump_margin_pct', label: 'Dump margin', num: true, cell: (r) => marginCell(r.dump_margin_pct) },
    { key: 'days_to_sell', label: 'Days-to-sell', num: true, cell: (r) => days(r.days_to_sell) },
    { key: 'depth_units', label: 'Ahead', num: true, cell: (r) => (r.depth_units == null ? '—' : nfmt(r.depth_units)) },
    { key: 'annual_roi', label: 'Annual ROI', num: true, cell: (r) => roiCell(r.annual_roi) },
    { key: 'list_value', label: 'Net (list)', num: true, cell: (r) => mIsk(r.list_value) },
    { key: 'action', label: 'Recommend', text: true, cell: (r) => actionPill(r) },
  ];
  // Clamp runaway percentages (near-zero cost basis) so the table reads cleanly.
  const clampPct = (v, cap) => (v > cap ? `&gt;${cap}%` : v < -cap ? `&lt;-${cap}%` : `${v.toFixed(1)}%`);
  function marginCell(v) {
    if (v == null) return '—';
    const cls = v >= 0 ? 'liq-pos' : 'liq-neg';
    return `<span class="${cls}">${clampPct(v, 999)}</span>`;
  }
  function roiCell(v) {
    if (v == null) return '—';
    const cls = v >= 0 ? 'liq-pos' : 'liq-neg';
    return `<span class="${cls}">${v > 9999 ? '&gt;9999%' : v < -9999 ? '&lt;-9999%' : `${Math.round(v).toLocaleString()}%`}</span>`;
  }

  // =================== Sub-tab switching ===================
  function setSub(name) {
    liq.sub = name;
    $$('.liq-subtab-btn').forEach((b) => b.classList.toggle('active', b.dataset.sub === name));
    $$('#tab-liquidation .liq-sub').forEach((s) => { s.hidden = s.dataset.sub !== name; });
    if (name === 'shipments') { loadShipments(false); loadCourier(false); }
    if (name === 'orders') loadOrders(false);
  }

  // =================== Analyze ===================
  async function runAnalyze() {
    if (liq.analyzing) return;
    const paste = $('#liq-paste').value.trim();
    if (!paste) { setAnalyzeStatus('Paste a courier contract first.'); return; }
    liq.analyzing = true;
    const prog = $('#liq-progress');
    const step = prog?.querySelector('.progress-step');
    if (prog) prog.hidden = false;
    setAnalyzeStatus('');
    $('#liq-create-shipment').disabled = true;
    try {
      const res = await fetch(`${API}/api/liquidation/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paste_text: paste,
          rush: $('#liq-rush').checked,
          include_courier: $('#liq-include-courier').checked,
        }),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      let errored = null;
      await readNdjson(res, (ev) => {
        if (ev.event === 'progress') { if (step) step.textContent = ev.message || ''; }
        else if (ev.event === 'done') { liq.analysis = ev.payload; }
        else if (ev.event === 'error') { errored = ev.message || 'Unknown error'; }
      });
      if (errored) throw new Error(errored);
      renderAnalyze();
      $('#liq-create-shipment').disabled = !(liq.analysis && liq.analysis.items.length);
      setAnalyzeStatus('');
    } catch (err) {
      setAnalyzeStatus(`Error: ${err.message || err}`);
    } finally {
      liq.analyzing = false;
      setTimeout(() => { if (prog) prog.hidden = true; }, 300);
    }
  }
  function setAnalyzeStatus(msg) { const el = $('#liq-analyze-status'); if (el) el.textContent = msg; }

  function renderAnalyze() {
    const a = liq.analysis;
    const summary = $('#liq-analyze-summary');
    if (!a) { if (summary) summary.innerHTML = ''; return; }
    const t = a.totals;
    const c = a.courier || {};
    const ba = t.by_action || {};
    const overVol = c.over_volume ? ` <span class="liq-warn">⚠ over ${nfmt(Math.round((c.max_volume_m3 || 360000)))} m³ — split shipment</span>` : '';
    summary.innerHTML = `
      <div class="liq-summary-tiles">
        <div class="market-tile"><div class="market-tile-val">${nfmt(t.items)}</div><div class="market-tile-label">items · ${nfmt(t.quantity)} units</div></div>
        <div class="market-tile"><div class="market-tile-val">${mIsk(t.sell_value)}</div><div class="market-tile-label">Jita sell value</div></div>
        <div class="market-tile"><div class="market-tile-val">${mIsk(t.cost_basis)}</div><div class="market-tile-label">cost basis (90% Amarr + courier)</div></div>
        <div class="market-tile"><div class="market-tile-val ${t.list_net >= 0 ? 'liq-pos' : 'liq-neg'}">${mIsk(t.list_net)}</div><div class="market-tile-label">net if all listed</div></div>
        <div class="market-tile"><div class="market-tile-val">${mIsk(c.cost)}</div><div class="market-tile-label">courier${a.rush ? ' (rush)' : ''}${overVol}</div></div>
        <div class="market-tile"><div class="market-tile-val">${nfmt(Math.round(t.total_volume_m3))} m³</div><div class="market-tile-label">volume</div></div>
      </div>
      <div class="liq-action-breakdown">
        ${['list', 'dump', 'underwater', 'no_data'].filter((k) => ba[k]).map((k) => `<span class="liq-pill liq-${k}${liq.actionFilter === k ? ' active' : ''}" data-filter="${k}">${ba[k]} ${ACTION_LABEL[k]}</span>`).join(' ')}
      </div>`;
    summary.querySelectorAll('[data-filter]').forEach((p) => p.addEventListener('click', () => {
      liq.actionFilter = liq.actionFilter === p.dataset.filter ? '' : p.dataset.filter;
      const sel = $('#liq-action-filter'); if (sel) sel.value = liq.actionFilter;
      renderAnalyze();
    }));
    renderAnalyzeTable();
  }

  function analyzeRows() {
    if (!liq.analysis) return [];
    const q = liq.search.trim().toLowerCase();
    let rows = liq.analysis.items.filter((r) => {
      if (q && !(r.name || '').toLowerCase().includes(q)) return false;
      if (liq.actionFilter && r.action !== liq.actionFilter) return false;
      return true;
    });
    const col = A_COLS.find((c) => c.key === liq.aSortKey);
    const isText = col?.text;
    rows = rows.slice().sort((x, y) => {
      const a = x[liq.aSortKey], b = y[liq.aSortKey];
      const an = a == null, bn = b == null;
      if (an && bn) return 0; if (an) return 1; if (bn) return -1;
      if (isText) return String(a).localeCompare(String(b)) * liq.aSortDir;
      return (a - b) * liq.aSortDir;
    });
    return rows;
  }

  function renderAnalyzeTable() {
    const thead = $('#liq-analyze-thead');
    const tbody = $('#liq-analyze-tbody');
    if (!thead || !tbody) return;
    thead.innerHTML = `<tr>${A_COLS.map((c) => {
      let cls = c.num ? 'num' : '';
      if (c.key === liq.aSortKey) cls += liq.aSortDir === 1 ? ' sort-asc' : ' sort-desc';
      return `<th data-sort="${c.key}"${cls ? ` class="${cls.trim()}"` : ''}>${c.label}</th>`;
    }).join('')}</tr>`;
    thead.querySelectorAll('th[data-sort]').forEach((th) => th.addEventListener('click', () => sortAnalyze(th.dataset.sort)));
    const rows = analyzeRows();
    const count = $('#liq-analyze-count');
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="${A_COLS.length}" class="muted market-empty">No items.</td></tr>`;
      if (count) count.textContent = '';
      return;
    }
    tbody.innerHTML = rows.map((r) => `<tr class="liq-row-${r.action} liq-row-clickable" data-name="${escapeHtml(r.name)}">${A_COLS.map((c) => {
      const cls = c.num ? ' class="num"' : '';
      return `<td${cls}>${c.cell(r)}</td>`;
    }).join('')}</tr>`).join('');
    if (count) count.textContent = `${nfmt(rows.length)} shown`;
    // Row click copies the item name; the ⓘ button opens the detail panel.
    tbody.querySelectorAll('tr[data-name]').forEach((tr) => {
      tr.addEventListener('click', (e) => {
        const info = e.target.closest('.liq-info-btn');
        if (info) { openDetail(Number(info.dataset.info), info.dataset.name); return; }
        copyName(tr.dataset.name);
      });
    });
  }
  function sortAnalyze(key) {
    if (liq.aSortKey === key) liq.aSortDir = -liq.aSortDir;
    else { liq.aSortKey = key; const col = A_COLS.find((c) => c.key === key); liq.aSortDir = col?.text ? 1 : -1; }
    renderAnalyzeTable();
  }

  async function createShipment() {
    const a = liq.analysis;
    if (!a || !a.items.length) return;
    const suggested = a.contract_id ? `Contract ${a.contract_id}` : '';
    const label = prompt('Shipment label (e.g. courier contract # or date):', suggested) || suggested;
    $('#liq-create-shipment').disabled = true;
    try {
      const res = await fetch(`${API}/api/liquidation/shipments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label, rush: !!a.rush, items: a.items, totals: a.totals, courier: a.courier,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      liq.shipmentsLoaded = false;
      await loadShipments(true);
      setSub('shipments');
    } catch (err) {
      setAnalyzeStatus(`Create failed: ${err.message || err}`);
    } finally {
      $('#liq-create-shipment').disabled = false;
    }
  }

  // =================== Shipments ===================
  async function loadShipments(force) {
    if (liq.shipmentsLoaded && !force) { renderShipments(); return; }
    const status = $('#liq-shipments-status');
    if (status) status.textContent = 'Loading…';
    try {
      const res = await fetch(`${API}/api/liquidation/shipments`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      liq.shipments = data.shipments || [];
      liq.shipmentsMeta = { accept_days: data.accept_days, deliver_days: data.deliver_days, storage: data.storage };
      liq.shipmentsLoaded = true;
      renderShipments();
      renderKpis();
      if (status) status.textContent = `${liq.shipments.length} shipment(s) · stored ${data.storage === 'github' ? 'on GitHub (shared)' : 'locally'}`;
    } catch (err) {
      if (status) status.textContent = `Error: ${err.message || err}`;
    }
  }

  function renderShipments() {
    const root = $('#liq-shipments-list');
    if (!root) return;
    if (!liq.shipments.length) {
      root.innerHTML = '<p class="muted">No shipments yet. Analyze a courier contract and click “Create shipment”.</p>';
      return;
    }
    const transit = (liq.shipmentsMeta.accept_days + liq.shipmentsMeta.deliver_days) || 6;
    root.innerHTML = liq.shipments.map((s) => {
      const t = s.totals || {};
      const c = s.courier || {};
      const eta = (s.created_at || 0) + transit * 86400;
      const remain = eta - nowSec();
      let etaTxt;
      if (s.status === 'delivered') etaTxt = 'delivered';
      else if (s.status === 'cancelled') etaTxt = 'cancelled';
      else if (remain <= 0) etaTxt = `due (est. ${transit}d passed)`;
      else etaTxt = `~${(remain / 86400).toFixed(1)}d to arrive`;
      const overVol = c.over_volume ? '<span class="liq-warn">⚠ over volume</span>' : '';
      return `
        <div class="liq-ship-card liq-ship-${s.status}">
          <div class="liq-ship-head">
            <span class="liq-ship-label">${escapeHtml(s.label || '(unlabelled)')}</span>
            <span class="liq-pill liq-status-${s.status}">${s.status.replace('_', ' ')}</span>
            <span class="muted small">${etaTxt}</span>
            ${s.rush ? '<span class="liq-pill liq-dump">rush</span>' : ''}
            ${overVol}
          </div>
          <div class="liq-ship-stats">
            <span>${nfmt(t.items || 0)} items · ${nfmt(t.quantity || 0)} units</span>
            <span>Jita sell <strong>${mIsk(t.sell_value)}</strong></span>
            <span>net if listed <strong class="${(t.list_net || 0) >= 0 ? 'liq-pos' : 'liq-neg'}">${mIsk(t.list_net)}</strong></span>
            <span>courier <strong>${mIsk(c.cost)}</strong></span>
            <span>${nfmt(Math.round(t.total_volume_m3 || 0))} m³</span>
          </div>
          <div class="liq-ship-actions">
            ${s.status === 'in_flight' ? `<button data-act="deliver" data-id="${s.id}" class="secondary">Mark delivered</button>` : ''}
            ${s.status !== 'cancelled' && s.status !== 'delivered' ? `<button data-act="cancel" data-id="${s.id}" class="secondary">Cancel</button>` : ''}
            <button data-act="delete" data-id="${s.id}" class="secondary liq-danger">Delete</button>
          </div>
        </div>`;
    }).join('');
    root.querySelectorAll('button[data-act]').forEach((b) => b.addEventListener('click', () => shipmentAction(b.dataset.act, b.dataset.id)));
  }

  async function shipmentAction(act, id) {
    try {
      if (act === 'delete') {
        if (!confirm('Delete this shipment record?')) return;
        const res = await fetch(`${API}/api/liquidation/shipments/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } else {
        const fields = act === 'deliver'
          ? { status: 'delivered', delivered_at: nowSec() }
          : { status: 'cancelled' };
        const res = await fetch(`${API}/api/liquidation/shipments/${id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }
      liq.shipmentsLoaded = false;
      await loadShipments(true);
    } catch (err) {
      const status = $('#liq-shipments-status');
      if (status) status.textContent = `Action failed: ${err.message || err}`;
    }
  }

  // =================== Courier contracts (live ESI) ===================
  const fmtDate = (s) => (s ? new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—');
  const COURIER_STATUS_CLS = {
    outstanding: 'liq-dump', in_progress: 'liq-dump', finished: 'liq-list',
    failed: 'liq-underwater', rejected: 'liq-underwater', deleted: 'liq-underwater', reversed: 'liq-underwater',
  };

  async function loadCourier(force) {
    if (liq.courierLoading) return;
    if (liq.courierLoaded && !force) { renderCourier(); return; }
    liq.courierLoading = true;
    const status = $('#liq-courier-status');
    if (status) status.textContent = 'Fetching from ESI…';
    try {
      const res = await fetch(`${API}/api/liquidation/courier-contracts`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      liq.courier = await res.json();
      liq.courierLoaded = true;
      renderCourier();
      if (status) status.textContent = liq.courier.configured ? `fetched ${new Date().toLocaleTimeString()}` : '';
    } catch (err) {
      if (status) status.textContent = `Error: ${err.message || err}`;
    } finally {
      liq.courierLoading = false;
    }
  }

  function renderCourier() {
    const note = $('#liq-courier-note');
    const tiles = $('#liq-courier-tiles');
    const thead = $('#liq-courier-thead');
    const tbody = $('#liq-courier-tbody');
    const data = liq.courier;
    if (!data) return;
    if (!data.configured) {
      if (note) { note.hidden = false; note.textContent = ORDER_REASONS[data.reason] || `Courier contracts unavailable (${data.reason || 'unknown'})${data.detail ? `: ${data.detail}` : ''}`; }
      [tiles, thead, tbody].forEach((el) => { if (el) el.innerHTML = ''; });
      return;
    }
    if (note) note.hidden = true;
    const t = data.totals || {};
    if (tiles) tiles.innerHTML = [
      ['Active', nfmt(t.active)],
      ['Active collateral', mIsk(t.active_collateral)],
      ['Active reward', mIsk(t.active_reward)],
      ['Completed', nfmt(t.completed)],
      ['Failed', nfmt(t.problem)],
    ].map(([l, v]) => `<div class="market-tile"><div class="market-tile-val">${v}</div><div class="market-tile-label">${l}</div></div>`).join('');

    let rows = data.contracts || [];
    if (liq.courierFilter) rows = rows.filter((c) => c.bucket === liq.courierFilter);
    // Default to the configured provider (Push Industries) only; the rest are
    // internal hauls / other couriers and just add noise for liquidation.
    const anyProvider = rows.some((c) => c.is_provider);
    if (!liq.courierAllProviders && anyProvider) rows = rows.filter((c) => c.is_provider);
    const cols = ['Contract', 'Status', 'Provider', 'Route', 'Volume', 'Collateral', 'Reward', 'Issued', 'Done', ''];
    if (thead) thead.innerHTML = `<tr>${cols.map((c, i) => `<th${i >= 4 && i <= 6 ? ' class="num"' : ''}>${c}</th>`).join('')}</tr>`;
    if (tbody) {
      tbody.innerHTML = rows.length ? rows.map((c) => {
        const scls = COURIER_STATUS_CLS[c.status] || 'liq-no_data';
        const prov = c.assignee
          ? `${escapeHtml(c.assignee)}${c.is_provider ? ' <span class="liq-pill liq-list">✓</span>' : ''}`
          : '<span class="muted">—</span>';
        const code = janiceCode(c.title);
        const action = code
          ? `<button class="secondary" data-analyze="${c.contract_id}" data-code="${code}">Analyze →</button>`
          : '<span class="muted small">no Janice link</span>';
        return `<tr>
          <td>${c.contract_id}${code ? `<br><span class="muted small">a/${code}</span>` : ''}</td>
          <td><span class="liq-pill ${scls}">${escapeHtml((c.status || '').replace('_', ' '))}</span></td>
          <td>${prov}</td>
          <td class="small">${escapeHtml(c.start || '?')} → ${escapeHtml(c.end || '?')}</td>
          <td class="num">${c.volume ? `${nfmt(Math.round(c.volume))} m³` : '—'}</td>
          <td class="num">${mIsk(c.collateral)}</td>
          <td class="num">${mIsk(c.reward)}</td>
          <td>${fmtDate(c.date_issued)}</td>
          <td>${fmtDate(c.date_completed || c.date_accepted)}</td>
          <td>${action}</td>
        </tr>`;
      }).join('') : `<tr><td colspan="${cols.length}" class="muted market-empty">No ${liq.courierFilter || ''}${!liq.courierAllProviders ? ' Push Industries' : ''} courier contracts.</td></tr>`;
    }
    tbody?.querySelectorAll('button[data-analyze]').forEach((b) => b.addEventListener('click', () => analyzeFromContract(b.dataset.analyze, b.dataset.code)));
  }

  async function analyzeFromContract(contractId, code) {
    setSub('analyze');
    $('#liq-paste').value = '';
    setAnalyzeStatus(`Analyzing contract ${contractId} from its Janice appraisal…`);
    if (liq.analyzing) return;
    liq.analyzing = true;
    const prog = $('#liq-progress');
    const step = prog?.querySelector('.progress-step');
    if (prog) prog.hidden = false;
    $('#liq-create-shipment').disabled = true;
    try {
      const res = await fetch(`${API}/api/liquidation/analyze`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          janice_url: `https://janice.e-351.com/a/${code}`,
          contract_id: Number(contractId),
          rush: $('#liq-rush').checked,
          include_courier: $('#liq-include-courier').checked,
        }),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      let errored = null;
      await readNdjson(res, (ev) => {
        if (ev.event === 'progress') { if (step) step.textContent = ev.message || ''; }
        else if (ev.event === 'done') { liq.analysis = ev.payload; }
        else if (ev.event === 'error') { errored = ev.message || 'Unknown error'; }
      });
      if (errored) throw new Error(errored);
      renderAnalyze();
      $('#liq-create-shipment').disabled = !(liq.analysis && liq.analysis.items.length);
      setAnalyzeStatus(`Contract ${contractId} analyzed.`);
    } catch (err) {
      setAnalyzeStatus(`Error: ${err.message || err}`);
    } finally {
      liq.analyzing = false;
      setTimeout(() => { if (prog) prog.hidden = true; }, 300);
    }
  }

  // =================== Open orders (live ESI) ===================
  const O_COLS = [
    { key: 'name', label: 'Item', cell: (o) => escapeHtml(o.name) },
    { key: 'price', label: 'List price', num: true, cell: (o) => mIsk(o.price) },
    { key: 'volume_remain', label: 'Remaining', num: true, cell: (o) => `${nfmt(o.volume_remain)} / ${nfmt(o.volume_total)}` },
    { key: 'fill_pct', label: 'Filled', num: true, cell: (o) => `${o.fill_pct}%` },
    { key: 'best_sell', label: 'Best sell', num: true, cell: (o) => `${mIsk(o.best_sell)}${o.undercut ? ' <span class="liq-warn">undercut</span>' : ''}` },
    { key: 'cost_basis_unit', label: 'Cost basis', num: true, cell: (o) => mIsk(o.cost_basis_unit) },
    { key: 'net_value_remaining', label: 'Net (remaining)', num: true, cell: (o) => (o.net_value_remaining == null ? '—' : `<span class="${o.net_value_remaining >= 0 ? 'liq-pos' : 'liq-neg'}">${mIsk(o.net_value_remaining)}</span>`) },
    { key: 'days_to_sell', label: 'Days-to-sell', num: true, cell: (o) => days(o.days_to_sell) },
    { key: 'days_remaining', label: 'Time left', num: true, cell: (o) => (o.days_remaining == null ? '—' : `${o.days_remaining.toFixed(1)}d`) },
    { key: 'stale', label: 'Flag', cell: (o) => orderFlag(o) },
  ];
  function orderFlag(o) {
    if (o.stale) return '<span class="liq-pill liq-underwater" title="Sitting far longer than expected sell time — reprice or dump">STALE</span>';
    if (o.undercut) return '<span class="liq-pill liq-dump" title="Someone is listed cheaper — you are not top of book">undercut</span>';
    return '<span class="liq-pill liq-list">ok</span>';
  }

  async function loadOrders(force) {
    if (liq.ordersLoading) return;
    if (liq.ordersLoaded && !force) { renderOrders(); return; }
    liq.ordersLoading = true;
    const status = $('#liq-orders-status');
    if (status) status.textContent = 'Fetching from ESI…';
    try {
      const res = await fetch(`${API}/api/liquidation/corp-orders`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      liq.orders = await res.json();
      liq.ordersLoaded = true;
      renderOrders();
      renderKpis();
      if (status) status.textContent = liq.orders.configured ? `fetched ${new Date().toLocaleTimeString()}` : '';
    } catch (err) {
      if (status) status.textContent = `Error: ${err.message || err}`;
    } finally {
      liq.ordersLoading = false;
    }
  }

  const ORDER_REASONS = {
    no_corp_id: 'Set your corp_id in Config first.',
    no_credentials: 'EVE app credentials are not configured.',
    missing_scope: 'No authenticated character has the corp market-orders scope. Re-auth a character with an Accountant/Trader role on the Auth tab (the scope is requested automatically).',
    fetch_failed: 'ESI rejected the corp-orders request (role or scope missing).',
  };

  function renderOrders() {
    const note = $('#liq-orders-note');
    const tiles = $('#liq-orders-tiles');
    const thead = $('#liq-orders-thead');
    const tbody = $('#liq-orders-tbody');
    const data = liq.orders;
    if (!data) return;
    if (!data.configured) {
      if (note) { note.hidden = false; note.textContent = ORDER_REASONS[data.reason] || `Unavailable (${data.reason || 'unknown'})${data.detail ? `: ${data.detail}` : ''}`; }
      if (tiles) tiles.innerHTML = '';
      if (thead) thead.innerHTML = '';
      if (tbody) tbody.innerHTML = '';
      return;
    }
    if (note) note.hidden = true;
    const t = data.totals || {};
    if (tiles) tiles.innerHTML = [
      ['Open sell orders', nfmt(t.orders)],
      ['Listed value', mIsk(t.listed_value)],
      ['Net if all clears', mIsk(t.net_value_remaining)],
      ['Stale', nfmt(t.stale_count || 0)],
      ['Undercut', nfmt(t.undercut_count || 0)],
    ].map(([l, v]) => `<div class="market-tile"><div class="market-tile-val">${v}</div><div class="market-tile-label">${l}</div></div>`).join('');
    let orders = data.orders || [];
    if (liq.staleOnly) orders = orders.filter((o) => o.stale || o.undercut);
    if (thead) thead.innerHTML = `<tr>${O_COLS.map((c) => `<th${c.num ? ' class="num"' : ''}>${c.label}</th>`).join('')}</tr>`;
    if (tbody) {
      tbody.innerHTML = orders.length
        ? orders.map((o) => `<tr class="${o.stale ? 'liq-row-underwater' : ''}">${O_COLS.map((c) => `<td${c.num ? ' class="num"' : ''}>${c.cell(o)}</td>`).join('')}</tr>`).join('')
        : `<tr><td colspan="${O_COLS.length}" class="muted market-empty">No open Jita sell orders${liq.staleOnly ? ' need attention' : ''}.</td></tr>`;
    }
  }

  // =================== KPI strip ===================
  function renderKpis() {
    const root = $('#liq-kpis');
    if (!root) return;
    const inflight = liq.shipments.filter((s) => s.status === 'in_flight');
    const inflightValue = inflight.reduce((a, s) => a + ((s.totals || {}).sell_value || 0), 0);
    const inflightCourier = inflight.reduce((a, s) => a + ((s.courier || {}).cost || 0), 0);
    const tiles = [
      ['In-flight shipments', `${inflight.length}`, `${mIsk(inflightValue)} sell value`],
      ['Courier in flight', mIsk(inflightCourier), 'PushX fees committed'],
    ];
    if (liq.orders && liq.orders.configured) {
      const t = liq.orders.totals || {};
      tiles.push(['Listed in Jita', mIsk(t.listed_value), `${nfmt(t.orders)} orders`]);
      tiles.push(['Net if all clears', mIsk(t.net_value_remaining), 'after fees + cost basis']);
      const staleCls = (t.stale_count || 0) > 0 ? 'liq-neg' : '';
      tiles.push([`<span class="${staleCls}">Stale capital</span>`, `<span class="${staleCls}">${nfmt(t.stale_count || 0)}</span>`, 'orders past expected sell']);
    } else {
      tiles.push(['Listed in Jita', '—', 'open the Open-orders tab → Refresh']);
    }
    root.innerHTML = tiles.map(([l, v, sub]) => `<div class="market-tile"><div class="market-tile-val">${v}</div><div class="market-tile-label">${l}${sub ? `<br><span class="muted small">${sub}</span>` : ''}</div></div>`).join('');
  }

  // =================== copy + export ===================
  function copyName(name) {
    navigator.clipboard?.writeText(name).then(() => toast(`Copied “${name}”`)).catch(() => {});
  }
  function toast(msg) {
    const t = $('#liq-copy-toast');
    if (!t) return;
    t.textContent = msg; t.hidden = false;
    clearTimeout(t._t); t._t = setTimeout(() => { t.hidden = true; }, 1500);
  }

  const EXPORT_COLS = [
    ['Item', (r) => r.name],
    ['Qty', (r) => r.quantity],
    ['CostBasisUnit', (r) => r.cost_basis_unit],
    ['JitaSell', (r) => r.sell_unit],
    ['JitaBuy', (r) => r.buy_unit],
    ['SpreadPct', (r) => r.spread_pct],
    ['ListMarginPct', (r) => r.list_margin_pct],
    ['DumpMarginPct', (r) => r.dump_margin_pct],
    ['DaysToSell', (r) => r.days_to_sell],
    ['UnitsAhead', (r) => r.depth_units],
    ['AnnualRoiPct', (r) => r.annual_roi],
    ['NetListValue', (r) => r.list_value],
    ['NetDumpValue', (r) => r.dump_value],
    ['Action', (r) => r.action],
    ['Window', (r) => r.window_days],
    ['Reason', (r) => r.reason],
  ];
  function exportRows(fmt) {
    const rows = analyzeRows();
    if (!rows.length) { toast('Nothing to export'); return; }
    const sep = fmt === 'csv' ? ',' : '\t';
    const esc = (v) => {
      v = v == null ? '' : String(v);
      if (fmt === 'csv' && /[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
      return v;
    };
    const lines = [EXPORT_COLS.map((c) => c[0]).join(sep)];
    for (const r of rows) lines.push(EXPORT_COLS.map((c) => esc(c[1](r))).join(sep));
    const suffix = liq.analysis?.contract_id ? `-contract-${liq.analysis.contract_id}` : '';
    download(lines.join('\n'), `liquidation${suffix}.${fmt}`, fmt === 'csv' ? 'text/csv' : 'text/plain');
    toast(`Exported ${rows.length} rows`);
  }
  function download(text, filename, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  // =================== item detail panel + chart ===================
  const detail = { typeId: null, name: '', days: 90, data: null, loading: false };
  const fmtShort = (n) => (n == null ? '—' : formatIsk(n));

  async function openDetail(typeId, name) {
    detail.typeId = typeId; detail.name = name;
    const panel = $('#liq-detail-panel');
    if (panel) panel.hidden = false;
    $('#liq-detail-name').textContent = name;
    $('#liq-detail-group').textContent = '';
    $('#liq-detail-chart').innerHTML = '';
    await loadDetail();
  }
  function closeDetail() { const p = $('#liq-detail-panel'); if (p) p.hidden = true; }

  async function loadDetail() {
    if (detail.typeId == null || detail.loading) return;
    detail.loading = true;
    const status = $('#liq-detail-status');
    if (status) status.textContent = 'Loading market history…';
    try {
      const res = await fetch(`${API}/api/liquidation/item-history?type_id=${detail.typeId}&days=${detail.days}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      detail.data = await res.json();
      $('#liq-detail-group').textContent = detail.data.group_name || '';
      renderDetail();
      if (status) status.textContent = `${(detail.data.history || []).length} days · book fetched ${new Date().toLocaleTimeString()}`;
    } catch (e) {
      if (status) status.textContent = `Error: ${e.message || e}`;
    } finally {
      detail.loading = false;
    }
  }

  function renderDetail() {
    const d = detail.data; if (!d) return;
    const s = d.signal || {};
    const spread = (s.best_sell && s.best_buy) ? ((s.best_sell - s.best_buy) / s.best_sell * 100) : null;
    $('#liq-detail-stats').innerHTML = [
      ['Best sell', mIsk(s.best_sell)],
      ['Best buy', mIsk(s.best_buy)],
      ['Spread', spread == null ? '—' : `${spread.toFixed(1)}%`],
      ['Avg daily vol', nfmt(Math.round(s.avg_daily_vol || 0))],
      ['On book', nfmt(s.on_book || 0)],
    ].map(([l, v]) => `<div class="liq-detail-stat"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');
    $('#liq-detail-chart').innerHTML = buildChart(d.history || [], s);
  }

  // Price (avg line + high/low band) over a volume histogram, drawn as inline SVG
  // — no chart lib in this app. Green/amber dashed lines mark live best sell/buy.
  function buildChart(hist, sig) {
    if (!hist.length) return '<div class="muted small">No market history for this item.</div>';
    const W = 480, H = 260, padL = 54, padR = 12, padT = 10, padB = 24;
    const priceH = 150, volTop = padT + priceH + 16, volH = H - volTop - padB;
    const n = hist.length;
    const xs = (i) => padL + (n === 1 ? 0 : (i / (n - 1)) * (W - padL - padR));
    const avgs = hist.map((h) => +h.average || 0);
    const highs = hist.map((h) => +h.highest || +h.average || 0);
    const lows = hist.map((h) => +h.lowest || +h.average || 0);
    const vols = hist.map((h) => +h.volume || 0);
    let pmin = Math.min(...lows), pmax = Math.max(...highs);
    if (!(pmax > pmin)) { pmin *= 0.99; pmax = pmax * 1.01 || 1; }
    const yP = (v) => padT + priceH - ((v - pmin) / (pmax - pmin)) * priceH;
    const vmax = Math.max(...vols, 1);
    const yV = (v) => volTop + volH - (v / vmax) * volH;
    const pt = (v, i) => `${xs(i).toFixed(1)},${yP(v).toFixed(1)}`;
    const band = `<polygon class="liq-chart-band" points="${highs.map(pt).join(' ')} ${lows.map(pt).reverse().join(' ')}"/>`;
    const line = `<polyline class="liq-chart-price" points="${avgs.map(pt).join(' ')}"/>`;
    const barW = Math.max(1, ((W - padL - padR) / n) * 0.8);
    const bars = vols.map((v, i) => `<rect class="liq-chart-vol" x="${(xs(i) - barW / 2).toFixed(1)}" y="${yV(v).toFixed(1)}" width="${barW.toFixed(1)}" height="${(volTop + volH - yV(v)).toFixed(1)}"/>`).join('');
    const refs = [];
    if (sig.best_sell != null && sig.best_sell >= pmin && sig.best_sell <= pmax) refs.push(`<line class="liq-chart-ref" stroke="#4a8" x1="${padL}" x2="${W - padR}" y1="${yP(sig.best_sell).toFixed(1)}" y2="${yP(sig.best_sell).toFixed(1)}"/>`);
    if (sig.best_buy != null && sig.best_buy >= pmin && sig.best_buy <= pmax) refs.push(`<line class="liq-chart-ref" stroke="#d8a72a" x1="${padL}" x2="${W - padR}" y1="${yP(sig.best_buy).toFixed(1)}" y2="${yP(sig.best_buy).toFixed(1)}"/>`);
    const yLabels = `<text class="liq-chart-axis" x="4" y="${padT + 8}">${fmtShort(pmax)}</text><text class="liq-chart-axis" x="4" y="${padT + priceH}">${fmtShort(pmin)}</text>`;
    const volLabel = `<text class="liq-chart-axis" x="4" y="${volTop + 8}">vol ${fmtShort(vmax)}</text>`;
    const xLabels = `<text class="liq-chart-axis" x="${padL}" y="${H - 6}">${hist[0].date}</text><text class="liq-chart-axis" text-anchor="end" x="${W - padR}" y="${H - 6}">${hist[n - 1].date}</text>`;
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${band}${line}${refs.join('')}${bars}${yLabels}${volLabel}${xLabels}</svg>`;
  }

  // =================== init + wiring ===================
  function initLiquidationTab() {
    if (!liq.shipmentsLoaded) loadShipments(false);
    renderKpis();
  }

  $('#liq-analyze-btn')?.addEventListener('click', runAnalyze);
  $('#liq-create-shipment')?.addEventListener('click', createShipment);
  $('#liq-shipments-refresh')?.addEventListener('click', () => loadShipments(true));
  $('#liq-courier-refresh')?.addEventListener('click', () => loadCourier(true));
  $('#liq-courier-filter')?.addEventListener('change', (e) => { liq.courierFilter = e.target.value; renderCourier(); });
  $('#liq-courier-all-providers')?.addEventListener('change', (e) => { liq.courierAllProviders = e.target.checked; renderCourier(); });
  $('#liq-orders-refresh')?.addEventListener('click', () => loadOrders(true));
  $('#liq-orders-stale-only')?.addEventListener('change', (e) => { liq.staleOnly = e.target.checked; renderOrders(); });
  let searchTimer = null;
  $('#liq-search')?.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const v = e.target.value;
    searchTimer = setTimeout(() => { liq.search = v; renderAnalyzeTable(); }, 160);
  });
  $('#liq-action-filter')?.addEventListener('change', (e) => { liq.actionFilter = e.target.value; renderAnalyze(); });
  $('#liq-export-csv')?.addEventListener('click', () => exportRows('csv'));
  $('#liq-export-txt')?.addEventListener('click', () => exportRows('txt'));
  $$('.liq-subtab-btn').forEach((b) => b.addEventListener('click', () => setSub(b.dataset.sub)));

  // Item detail panel controls.
  $('#liq-detail-close')?.addEventListener('click', closeDetail);
  $('#liq-detail-refresh')?.addEventListener('click', () => loadDetail());
  $$('.liq-win-btn[data-days]').forEach((b) => b.addEventListener('click', () => {
    detail.days = Number(b.dataset.days);
    $$('.liq-win-btn[data-days]').forEach((x) => x.classList.toggle('active', x === b));
    loadDetail();
  }));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });

  // Full-width layout only on the Liquidation tab (the analysis table is wide).
  $$('.tab-btn').forEach((b) => b.addEventListener('click', () => {
    document.body.classList.toggle('liq-full', b.dataset.tab === 'liquidation');
  }));
  document.querySelector('.tab-btn[data-tab="liquidation"]')?.addEventListener('click', initLiquidationTab);
})();
