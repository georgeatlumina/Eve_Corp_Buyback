'use strict';

// ================= Station Trading =================
// Buy low at one NPC hub, sell high at another. Everything comes from
// /api/trade/*, which pages ESI's regional order book and filters it to a
// station — ESI has no per-station market endpoint, so that filter is the whole
// mechanism. A cold region is ~30s; the sidecar caches for 5 minutes to match
// ESI's own window, so a second look is instant.
//
// Two profit figures ride on every row, because station traders run both plays:
//   instant — buy the ask here, hit the bid there. No waiting, no undercut risk.
//   patient — buy the ask here, list at the far end's ask. More margin, more
//             patience, and you can be undercut.
// Ranking is on realisable ISK/day (per-unit profit times the units that
// actually trade), not raw spread, which flatters anything illiquid.

(function () {
  const $ = (s) => document.querySelector(s);
  const $id = (x) => document.getElementById(x);
  const esc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(s) : String(s == null ? '' : s));
  const isk = (n) => (typeof fmtIskShort === 'function' ? fmtIskShort(n) : Math.round(n || 0).toLocaleString('en-US'));
  const num = (n, d = 0) => (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

  const st = {
    stations: [], haulers: [], presets: [], loaded: false,
    data: null, route: null, selected: null, busy: false,
    ticker: [], chart: null, tickerTimer: null,
  };

  // Same verbose-failure contract the PI colonies tab uses: a bare
  // `.then(r => r.json())` turns four different problems into one useless
  // string, and a 500 carrying a good explanation into a parse error.
  async function api(path, opts) {
    const url = `${API}${path}`;
    let res;
    try {
      res = await fetch(url, opts);
    } catch (e) {
      throw new Error(`Can't reach the local backend at ${API} — the app's Python sidecar isn't answering. (${e.message})`);
    }
    const raw = await res.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (_) { /* reported below */ }
    if (!res.ok) {
      const detail = (data && (data.detail || data.error)) || raw.slice(0, 300) || '(empty response)';
      throw new Error(`${path} failed — HTTP ${res.status}: ${detail}`);
    }
    if (data === null) throw new Error(`${path} returned a non-JSON response`);
    return data;
  }

  const setStatus = (m) => { const e = $id('st-status'); if (e) e.textContent = m || ''; };
  function warn(m) {
    const e = $id('st-warn');
    if (!e) return;
    e.hidden = !m;
    e.textContent = m || '';
  }

  // ---- stations + presets ----
  async function loadStations() {
    const d = await api('/api/trade/stations');
    st.stations = d.stations || [];
    st.haulers = d.haulers || [];
    const opts = st.stations.map((s) => `<option value="${s.station_id}">${esc(s.system)} — ${esc(s.name)}</option>`).join('');
    for (const [id, dflt] of [['st-from', 0], ['st-to', 1]]) {
      const sel = $id(id);
      if (!sel) continue;
      sel.innerHTML = opts;
      if (st.stations[dflt]) sel.value = st.stations[dflt].station_id;
    }
    const tax = $id('st-tax'), broker = $id('st-broker');
    if (tax) tax.value = ((d.default_sales_tax || 0) * 100).toFixed(1);
    if (broker) broker.value = ((d.default_broker_fee || 0) * 100).toFixed(1);
  }

  async function loadPresets() {
    try { st.presets = (await api('/api/trade/presets')).presets || []; } catch (_) { st.presets = []; }
    renderPresets();
  }
  function renderPresets() {
    const box = $id('st-presets');
    if (!box) return;
    if (!st.presets.length) { box.innerHTML = '<span class="muted small">No saved pairs yet — pick two stations and hit <strong>+ Save pair</strong>.</span>'; return; }
    box.innerHTML = st.presets.map((p, i) => `<span class="st-preset">
      <button type="button" class="st-preset-go" data-from="${p.from.station_id}" data-to="${p.to.station_id}"
        title="${esc(p.from.name)} → ${esc(p.to.name)}">${esc(p.label)}</button>
      <button type="button" class="st-preset-del" data-i="${i}" title="Remove">✕</button></span>`).join('');
  }
  async function savePresets(list) {
    try {
      st.presets = (await api('/api/trade/presets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ presets: list }),
      })).presets || [];
      renderPresets();
    } catch (e) { warn(e.message); }
  }
  const presetPayload = () => st.presets.map((p) => ({
    label: p.label, from_station: p.from.station_id, to_station: p.to.station_id,
  }));

  // ---- the analysis ----
  const pair = () => ({ from: Number($id('st-from')?.value), to: Number($id('st-to')?.value) });
  const pct = (id, d) => { const v = Number($id(id)?.value); return Number.isFinite(v) ? v / 100 : d; };
  const int = (id, d) => { const v = Number($id(id)?.value); return Number.isFinite(v) ? v : d; };

  // Paging a region emits one event per page — ~600 for a Jita/Amarr pair — so
  // the bar is given a share of the whole run per phase rather than restarting
  // at zero four times, and the DOM is only touched when the number visibly
  // moves.
  const PHASES = {
    buy: [0.00, 0.45, 'Paging'],
    sell: [0.45, 0.90, 'Paging'],
    evaluate: [0.90, 0.94, 'Comparing'],
    enrich: [0.94, 1.00, 'Checking'],
  };
  let lastPct = -1;
  function showProgress(ev) {
    const box = $id('st-progress');
    if (!box) return;
    box.hidden = false;
    const [lo, hi, verb] = PHASES[ev.phase] || [0, 1, ''];
    const frac = ev.total > 0 ? Math.min(1, ev.done / ev.total) : 1;
    const pct = Math.round((lo + frac * (hi - lo)) * 100);
    if (pct !== lastPct) {
      lastPct = pct;
      $id('st-progress-fill').style.width = `${pct}%`;
    }
    const detail = ev.total > 0 ? ` — ${num(ev.done)}/${num(ev.total)} pages` : '';
    $id('st-progress-label').textContent = `${verb} ${ev.station || ''}${detail}`.trim();
  }
  function hideProgress() {
    const box = $id('st-progress');
    if (box) box.hidden = true;
    lastPct = -1;
    const fill = $id('st-progress-fill');
    if (fill) fill.style.width = '0%';
  }

  async function runAnalysis() {
    if (st.busy) return;
    const { from, to } = pair();
    // The station list arrives over HTTP, so an early click would otherwise read
    // two empty selects and return in silence — a dead button with no feedback.
    if (!from || !to) {
      warn(st.stations.length ? 'Pick two stations first.' : 'Still loading the station list — try again in a moment.');
      return;
    }
    if (from === to) { warn('Pick two different stations.'); return; }
    st.busy = true;
    warn('');
    const btn = $id('st-run');
    if (btn) { btn.disabled = true; btn.textContent = 'Analysing…'; }
    setStatus('Paging the order books — a cold region takes ~30s…');
    $id('st-results').innerHTML = '<p class="muted">Loading…</p>';
    const q = new URLSearchParams({
      from, to,
      limit: int('st-limit', 10),
      min_units: int('st-min-units', 1),
      min_orders: int('st-min-orders', 2),
      min_margin: pct('st-min-margin', 0.03),
      max_buy_price: int('st-max-price', 0),
      sales_tax: pct('st-tax', 0.036),
      broker_fee: pct('st-broker', 0.015),
    });
    hideProgress();
    try {
      api(`/api/trade/route?from=${from}&to=${to}`).then((r) => { st.route = r; }).catch(() => {});
      let res;
      try {
        res = await fetch(`${API}/api/trade/pairs/stream?${q}`);
      } catch (e) {
        throw new Error(`Can't reach the local backend at ${API} — the sidecar isn't answering. (${e.message})`);
      }
      if (!res.ok) throw new Error(`Analysis failed — HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let finished = false;
      // NDJSON: one JSON object per line, so a chunk can split mid-line and the
      // remainder has to be carried over.
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev;
          try { ev = JSON.parse(line); } catch (_) { continue; }
          if (ev.event === 'progress') { showProgress(ev); continue; }
          if (ev.event === 'start') { setStatus(`${ev.from.system} → ${ev.to.system} — reading the order books…`); continue; }
          if (ev.event === 'error') { warn(ev.message); setStatus(''); $id('st-results').innerHTML = ''; finished = true; continue; }
          if (ev.event === 'done') { st.data = ev; renderResults(); finished = true; }
        }
      }
      if (!finished) throw new Error('The analysis stream ended before returning a result.');
    } catch (e) {
      warn(e.message);
      setStatus('');
      $id('st-results').innerHTML = '';
    } finally {
      hideProgress();
      st.busy = false;
      if (btn) { btn.disabled = false; btn.textContent = 'Analyse'; }
    }
  }

  function renderResults() {
    const d = st.data;
    const rows = d.rows || [];
    const jumps = st.route && st.route.jumps;
    setStatus(`${esc(d.from.system)} → ${esc(d.to.system)} · ${jumps == null ? '?' : jumps} jumps · `
      + `${num(d.orders_scanned)} orders scanned · ${num(d.matched)} items passed the filters · `
      + `updated ${new Date((d.fetched_at || 0) * 1000).toLocaleTimeString()}`);
    // Region-level traded volume can't tell two stations in one region apart.
    warn(d.same_region
      ? 'Both stations are in the same region, so the vol/day column covers both of them — treat it as a regional figure, not this station’s.'
      : '');
    const cnt = $id('st-count');
    if (cnt) cnt.textContent = rows.length ? `— ranked by realisable ISK/day` : '';
    if (!rows.length) {
      $id('st-results').innerHTML = '<p class="muted">Nothing cleared the filters. Try a lower min margin, or fewer min units/orders.</p>';
      return;
    }
    $id('st-results').innerHTML = `<table class="st-table">
      <thead><tr>
        <th>Item</th>
        <th class="num" title="Best ask where you buy">Buy</th>
        <th class="num" title="Best bid where you sell — what you get instantly">Sell bid</th>
        <th class="num" title="Buy the ask, hit the bid. Sales tax only.">Instant</th>
        <th class="num" title="Buy the ask, list at the far end's ask. Broker fee + tax, and you can be undercut.">Patient</th>
        <th class="num" title="Units available at the best price on both sides">On book</th>
        <th class="num" title="Units the destination region actually traded per day, last 7 days">Vol/day</th>
        <th class="num" title="Per-unit profit times the units that genuinely move">ISK/day</th>
        <th></th>
      </tr></thead><tbody>${rows.map((r, i) => `<tr class="st-row" data-i="${i}">
        <td><span class="st-name">${esc(r.name)}</span><span class="st-group muted">${esc(r.group || '')}</span></td>
        <td class="num">${isk(r.buy_price)}</td>
        <td class="num">${isk(r.sell_bid)}</td>
        <td class="num ${r.instant_profit > 0 ? 'st-pos' : 'st-neg'}">${(r.instant_margin * 100).toFixed(1)}%</td>
        <td class="num ${r.patient_profit > 0 ? 'st-pos' : 'st-neg'}">${(r.patient_margin * 100).toFixed(1)}%</td>
        <td class="num">${num(r.tradeable)}</td>
        <td class="num ${(r.daily_volume || 0) < 10 ? 'st-thin' : ''}">${num(r.daily_volume)}</td>
        <td class="num st-strong">${isk(r.daily_profit)}</td>
        <td class="st-rowacts"><button type="button" class="st-watch" data-type="${r.type_id}" title="Watch this pair on the ticker">★</button><button type="button" class="st-chartbtn" data-type="${r.type_id}" title="Spread over time">📈</button></td>
      </tr>`).join('')}</tbody></table>`;
  }

  // ---- item search (typeahead) ----
  // Suggestions drop under the input as you type, with arrow-key navigation —
  // item names are long and near-identical ("Hobgoblin I" / "Hobgoblin II"), so
  // picking from a list beats typing one exactly.
  let searchT = null;
  const sug = { items: [], idx: -1 };

  function closeSuggestions() {
    sug.items = [];
    sug.idx = -1;
    const box = $id('st-search-results');
    if (box) { box.innerHTML = ''; box.classList.remove('open'); }
  }

  // Bold the part the user actually typed, so why a row matched is obvious.
  function markMatch(name, needle) {
    const i = name.toLowerCase().indexOf(needle.toLowerCase());
    if (i < 0 || !needle) return esc(name);
    return `${esc(name.slice(0, i))}<b>${esc(name.slice(i, i + needle.length))}</b>${esc(name.slice(i + needle.length))}`;
  }

  function renderSuggestions(needle, note) {
    const box = $id('st-search-results');
    if (!box) return;
    box.classList.add('open');
    if (!sug.items.length) {
      box.innerHTML = `<p class="st-sug-empty muted small">${esc(note || 'No match.')}</p>`;
      return;
    }
    box.innerHTML = sug.items.map((h, i) => `<button type="button" class="st-hit${i === sug.idx ? ' on' : ''}" data-i="${i}" data-type="${h.type_id}">
      <span class="st-hit-name">${markMatch(h.name, needle)}</span>
      <span class="st-hit-group muted">${esc(h.group || '')}</span></button>`).join('');
    const on = box.querySelector('.st-hit.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  }

  function onSearch(e) {
    clearTimeout(searchT);
    const q = (e.target.value || '').trim();
    if (q.length < 2) { closeSuggestions(); return; }
    searchT = setTimeout(async () => {
      try {
        const d = await api(`/api/trade/search?q=${encodeURIComponent(q)}`);
        sug.items = d.results || [];
        sug.idx = sug.items.length ? 0 : -1;
        renderSuggestions(q, sug.items.length ? '' :
          `Nothing matches "${q}". Names are cached as the app sees them (${num(d.cached_types)} known) — `
          + 'type the full item name and it will be looked up directly.');
      } catch (err) { warn(err.message); }
    }, 150);
  }

  function onSearchKey(e) {
    if (!sug.items.length && e.key !== 'Escape') return;
    const needle = (e.target.value || '').trim();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      sug.idx = (sug.idx + step + sug.items.length) % sug.items.length;
      renderSuggestions(needle);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = sug.items[sug.idx] || sug.items[0];
      if (pick) { e.target.value = pick.name; closeSuggestions(); loadItem(pick.type_id); }
    } else if (e.key === 'Escape') {
      closeSuggestions();
    }
  }

  async function loadItem(typeId) {
    const { from, to } = pair();
    setStatus('Looking that item up…');
    try {
      const d = await api(`/api/trade/item?type_id=${typeId}&from=${from}&to=${to}`
        + `&sales_tax=${pct('st-tax', 0.036)}&broker_fee=${pct('st-broker', 0.015)}`);
      // If it only pays the other way, say so rather than showing a blank.
      const dir = (d.forward && d.forward.instant_profit > 0) ? d.forward
        : (d.reverse && d.reverse.instant_profit > 0) ? d.reverse : d.forward || d.reverse;
      const reversed = dir && dir === d.reverse;
      if (!dir) { warn(`${d.name} isn't listed at both stations right now.`); setStatus(''); return; }
      st.selected = { ...dir, name: d.name, m3: d.m3 || dir.m3 || 0, reversed };
      renderCalc();
      setStatus(reversed ? `${d.name}: only pays ${esc(d.to.system)} → ${esc(d.from.system)}` : '');
    } catch (e) { warn(e.message); setStatus(''); }
  }

  // ---- ticker ----
  // A scrolling strip of the pairs you're watching, currency-pair style. The
  // quote is the *gross* spread: taxes depend on your skills, so recording them
  // into history would tie the stored series to a setting that changes. Fees are
  // applied where they belong — in the table and the calculator.
  async function loadTicker(quiet) {
    try {
      const d = await api('/api/trade/ticker');
      st.ticker = d.items || [];
      renderTicker();
    } catch (e) { if (!quiet) warn(e.message); }
  }
  // Names first so the strip appears at once, prices after — quoting from cold
  // means paging a whole region's order book, and a strip that stays invisible
  // for a minute reads as broken rather than busy.
  async function primeTicker() {
    try {
      const d = await api('/api/trade/ticker?quotes=0');
      st.ticker = d.items || [];
      renderTicker();
    } catch (_) { /* the full load below reports anything real */ }
    await loadTicker(true);
  }
  function tickerPayload() {
    return st.ticker.map((t) => ({ type_id: t.type_id, from_station: t.from_station, to_station: t.to_station }));
  }
  async function saveTicker(list) {
    try {
      await api('/api/trade/ticker', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: list }),
      });
      await loadTicker(true);
    } catch (e) { warn(e.message); }
  }

  // Serialised, each building its payload when it runs. Starring three rows in
  // quick succession would otherwise have all three read the same empty list and
  // the last POST overwrite the other two — only one star would stick.
  let tickQ = Promise.resolve();
  function queueTicker(fn) {
    tickQ = tickQ.then(() => saveTicker(fn(tickerPayload()))).catch(() => {});
    return tickQ;
  }
  function watchItem(typeId, from, to) {
    return queueTicker((list) => (
      list.some((t) => t.type_id === typeId && t.from_station === from && t.to_station === to)
        ? list
        : [...list, { type_id: typeId, from_station: from, to_station: to }]));
  }

  function renderTicker() {
    const wrap = $id('st-ticker-wrap'), track = $id('st-ticker-track');
    if (!wrap || !track) return;
    wrap.hidden = !st.ticker.length;
    if (!st.ticker.length) return;
    const cell = (t) => {
      if (t.error) {
        return `<button type="button" class="st-tick st-tick-err" data-type="${t.type_id}" data-from="${t.from_station}" data-to="${t.to_station}"
          title="${esc(t.error)}"><span class="st-tick-name">${esc(t.name)}</span><span class="st-tick-val">—</span></button>`;
      }
      if (t.pending) {
        return `<button type="button" class="st-tick st-tick-pending" data-type="${t.type_id}" data-from="${t.from_station}" data-to="${t.to_station}"
          title="Pricing — a cold region takes ~50s to page"><span class="st-tick-name">${esc(t.name)}</span><span class="st-tick-val">…</span></button>`;
      }
      const up = t.margin >= 0;
      const chg = t.change == null ? '' :
        `<span class="st-tick-chg ${t.change >= 0 ? 'up' : 'down'}">${t.change >= 0 ? '▲' : '▼'}${Math.abs(t.change * 100).toFixed(2)}</span>`;
      const route = t.from && t.to ? `${t.from.system}→${t.to.system}` : '';
      return `<button type="button" class="st-tick" data-type="${t.type_id}" data-from="${t.from_station}" data-to="${t.to_station}"
        title="${esc(t.name)} · ${esc(route)} · gross spread, before your fees · ${t.points} day(s) recorded — click for the chart">
        <span class="st-tick-name">${esc(t.name)}</span>
        <span class="st-tick-route muted">${esc(route)}</span>
        <span class="st-tick-val ${up ? 'up' : 'down'}">${(t.margin * 100).toFixed(2)}%</span>${chg}</button>`;
    };
    // The strip is rendered twice so translating it by half its width loops
    // seamlessly — one copy would snap back visibly at the end.
    const once = st.ticker.map(cell).join('');
    track.innerHTML = once + once;
    track.style.animationDuration = `${Math.max(18, st.ticker.length * 6)}s`;
  }

  // ---- spread chart ----
  async function openChart(typeId, from, to) {
    const panel = $id('st-chart-panel');
    if (!panel) return;
    panel.hidden = false;
    $id('st-chart-body').innerHTML = '<p class="muted">Loading history…</p>';
    $id('st-chart-title').textContent = '';
    try {
      const d = await api(`/api/trade/history?type_id=${typeId}&from=${from}&to=${to}`);
      st.chart = d;
      renderChart();
      panel.scrollIntoView({ block: 'nearest' });
    } catch (e) {
      $id('st-chart-body').innerHTML = '';
      warn(e.message);
    }
  }

  function renderChart() {
    const d = st.chart;
    if (!d) return;
    $id('st-chart-title').textContent = `${d.name} · ${d.from.system} → ${d.to.system}`;
    const spread = d.spread || [];
    $id('st-chart-sub').textContent = spread.length
      ? `${spread.length} day(s) of recorded station spread`
      : 'no station spread recorded yet — watch it on the ticker and it starts building';
    $id('st-chart-legend-from').textContent = d.regions.from.region || '';
    $id('st-chart-legend-to').textContent = d.regions.to.region || '';
    const w = $id('st-chart-warn');
    if (w) {
      // The honest caveat: region history can't separate two stations in one
      // region, so the proxy lines are meaningless for that case.
      w.hidden = !d.same_region;
      w.textContent = d.same_region
        ? 'Both stations are in the same region, so the two region lines are the same data — only the recorded station spread distinguishes them.'
        : '';
    }
    $id('st-chart-body').innerHTML = buildChart(d);
  }

  // Inline SVG — no chart lib in this app. Two region average-price lines on a
  // shared price axis, with the recorded station spread as a percentage on its
  // own axis underneath, because a margin and an ISK price share no scale.
  function buildChart(d) {
    const a = d.regions.from.history || [];
    const b = d.regions.to.history || [];
    const spread = d.spread || [];
    if (!a.length && !b.length && !spread.length) {
      return '<p class="muted">No history for this item in either region, and nothing recorded yet.</p>';
    }
    const W = 760, H = 300, padL = 62, padR = 14, padT = 12, padB = 26;
    const priceH = 170, spTop = padT + priceH + 26, spH = H - spTop - padB;

    // A shared date axis across both regions, so the two lines are comparable.
    const dates = [...new Set([...a, ...b].map((h) => h.date))].sort();
    const xi = new Map(dates.map((dt, i) => [dt, i]));
    const n = dates.length || 1;
    const xs = (i) => padL + (n === 1 ? 0 : (i / (n - 1)) * (W - padL - padR));

    const prices = [...a, ...b].map((h) => +h.average || 0).filter((v) => v > 0);
    let pmin = prices.length ? Math.min(...prices) : 0;
    let pmax = prices.length ? Math.max(...prices) : 1;
    if (!(pmax > pmin)) { pmin *= 0.99; pmax = pmax * 1.01 || 1; }
    const yP = (v) => padT + priceH - ((v - pmin) / (pmax - pmin)) * priceH;
    const line = (hist, cls) => {
      const pts = hist.filter((h) => +h.average > 0 && xi.has(h.date))
        .map((h) => `${xs(xi.get(h.date)).toFixed(1)},${yP(+h.average).toFixed(1)}`);
      return pts.length ? `<polyline class="${cls}" points="${pts.join(' ')}"/>` : '';
    };

    // Spread panel: percentage, with a zero line because a negative spread
    // (the pair paying the other way) is a real and important state.
    let sp = '';
    if (spread.length) {
      const ms = spread.map((p) => p.margin || 0);
      let smin = Math.min(...ms, 0), smax = Math.max(...ms, 0);
      if (!(smax > smin)) { smax = smin + 0.01; }
      const yS = (v) => spTop + spH - ((v - smin) / (smax - smin)) * spH;
      // Recorded points are sparse at first, so they're drawn as dots joined by
      // a line rather than a line alone — two points shouldn't look like a trend.
      const sxs = spread.length === 1
        ? [padL + (W - padL - padR) / 2]
        : spread.map((_, i) => padL + (i / (spread.length - 1)) * (W - padL - padR));
      const pts = spread.map((p, i) => `${sxs[i].toFixed(1)},${yS(p.margin || 0).toFixed(1)}`);
      const dots = spread.map((p, i) => `<circle class="st-k-spread-dot" cx="${sxs[i].toFixed(1)}" cy="${yS(p.margin || 0).toFixed(1)}" r="2.5"><title>${p.d}: ${(p.margin * 100).toFixed(2)}%</title></circle>`).join('');
      const zero = (smin <= 0 && smax >= 0)
        ? `<line class="st-chart-zero" x1="${padL}" x2="${W - padR}" y1="${yS(0).toFixed(1)}" y2="${yS(0).toFixed(1)}"/>` : '';
      sp = `${zero}<polyline class="st-chart-spread" points="${pts.join(' ')}"/>${dots}`
        + `<text class="st-chart-axis" x="4" y="${spTop + 8}">${(smax * 100).toFixed(1)}%</text>`
        + `<text class="st-chart-axis" x="4" y="${spTop + spH}">${(smin * 100).toFixed(1)}%</text>`
        + `<text class="st-chart-axis" x="4" y="${spTop - 6}">station spread</text>`;
    } else {
      sp = `<text class="st-chart-axis" x="${padL}" y="${spTop + spH / 2}">No station spread recorded yet — the ticker records one point a day.</text>`;
    }

    const yLabels = `<text class="st-chart-axis" x="4" y="${padT + 8}">${isk(pmax)}</text>`
      + `<text class="st-chart-axis" x="4" y="${padT + priceH}">${isk(pmin)}</text>`;
    const xLabels = dates.length
      ? `<text class="st-chart-axis" x="${padL}" y="${H - 6}">${dates[0]}</text>`
        + `<text class="st-chart-axis" text-anchor="end" x="${W - padR}" y="${H - 6}">${dates[dates.length - 1]}</text>`
      : '';
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      ${line(a, 'st-chart-from')}${line(b, 'st-chart-to')}${sp}${yLabels}${xLabels}</svg>`;
  }

  // ---- calculator ----
  function renderCalc() {
    const box = $id('st-calc');
    if (!box) return;
    const r = st.selected;
    if (!r) { box.innerHTML = '<p class="muted small">Click any row, or search an item, to load it here.</p>'; return; }
    const haulers = st.haulers.map((h) => `<option value="${h.m3}">${esc(h.label)} — ${num(h.m3)} m³</option>`).join('');
    box.innerHTML = `<div class="st-calc-head">
        <strong>${esc(r.name)}</strong>${r.reversed ? '<span class="st-rev" title="This item only pays in the opposite direction">reversed</span>' : ''}
        <span class="muted small">${num(r.m3, 2)} m³ each · ${num(r.tradeable)} on book · ${num(r.daily_volume)}/day</span>
      </div>
      <label class="st-calc-row">Units <input id="st-units" type="number" min="1" step="1" value="${Math.max(1, r.tradeable || 1)}" /></label>
      <label class="st-calc-row">Hauler <select id="st-hauler">${haulers}</select></label>
      <label class="st-calc-row">Capacity <input id="st-cap" type="number" min="1" step="100" value="${st.haulers[0] ? st.haulers[0].m3 : 5000}" /> m³</label>
      <label class="st-calc-row"><input type="checkbox" id="st-patient" /> Sell patiently (list at the far ask)</label>
      <div id="st-calc-out" class="st-calc-out"></div>
      <p class="muted small">Capacity is a typical fitted figure — overwrite it with your own hull's. Trips assume you fly back empty.</p>`;
    $id('st-hauler').addEventListener('change', (e) => { $id('st-cap').value = e.target.value; recalc(); });
    for (const id of ['st-units', 'st-cap', 'st-patient']) $id(id).addEventListener('input', recalc);
    recalc();
  }

  function recalc() {
    const r = st.selected;
    const out = $id('st-calc-out');
    if (!r || !out) return;
    const units = Math.max(0, int('st-units', 0));
    const cap = Math.max(1, int('st-cap', 1));
    const patient = $id('st-patient')?.checked;
    const perUnit = patient ? r.patient_profit : r.instant_profit;
    const m3 = (r.m3 || 0) * units;
    const trips = r.m3 > 0 ? Math.ceil(m3 / cap) : (units > 0 ? 1 : 0);
    const jumps = st.route && st.route.jumps;
    const spend = r.buy_price * units;
    const profit = perUnit * units;
    // Over-buying past what the book holds is the commonest way these numbers
    // lie, so it's called out rather than silently extrapolated.
    const overbought = units > (r.tradeable || 0);
    out.innerHTML = `<table class="st-calc-tbl">
        <tr><td>Cost to buy</td><td class="num">${isk(spend)}</td></tr>
        <tr><td>Revenue after fees</td><td class="num">${isk(spend + profit)}</td></tr>
        <tr class="st-calc-total"><td>Profit</td><td class="num ${profit > 0 ? 'st-pos' : 'st-neg'}">${isk(profit)}</td></tr>
        <tr><td>Per jump</td><td class="num">${jumps ? isk(profit / jumps) : '—'}</td></tr>
        <tr><td>Volume</td><td class="num">${num(m3, 1)} m³</td></tr>
        <tr><td>Trips</td><td class="num">${num(trips)}${jumps ? ` × ${jumps} jumps = ${num(trips * jumps)}` : ''}</td></tr>
        <tr><td>Profit per trip</td><td class="num">${trips ? isk(profit / trips) : '—'}</td></tr>
      </table>
      ${overbought ? `<p class="st-overbuy">Only ${num(r.tradeable)} are available at these prices — past that you'll walk the book and the real margin will be thinner.</p>` : ''}`;
  }

  // ---- wiring ----
  let wired = false;
  async function initTab() {
    if (wired) return;
    wired = true;
    // Held disabled until the stations are in, so the button can't be pressed
    // before it can do anything.
    const runBtn = $id('st-run');
    if (runBtn) { runBtn.disabled = true; runBtn.title = 'Loading stations…'; }
    $id('st-run')?.addEventListener('click', runAnalysis);
    $id('st-swap')?.addEventListener('click', () => {
      const f = $id('st-from'), t = $id('st-to');
      if (!f || !t) return;
      const v = f.value; f.value = t.value; t.value = v;
    });
    $id('st-save-preset')?.addEventListener('click', () => {
      const { from, to } = pair();
      if (!from || !to || from === to) return;
      const a = st.stations.find((s) => s.station_id === from);
      const b = st.stations.find((s) => s.station_id === to);
      const list = presetPayload();
      if (list.some((p) => p.from_station === from && p.to_station === to)) return;
      list.push({ label: `${a ? a.system : from} → ${b ? b.system : to}`, from_station: from, to_station: to });
      savePresets(list);
    });
    $id('st-presets')?.addEventListener('click', (e) => {
      const go = e.target.closest('.st-preset-go');
      if (go) {
        $id('st-from').value = go.dataset.from;
        $id('st-to').value = go.dataset.to;
        runAnalysis();
        return;
      }
      const del = e.target.closest('.st-preset-del');
      if (del) {
        const list = presetPayload();
        list.splice(Number(del.dataset.i), 1);
        savePresets(list);
      }
    });
    $id('st-ticker')?.addEventListener('click', (e) => {
      const t = e.target.closest('.st-tick');
      if (t) openChart(Number(t.dataset.type), Number(t.dataset.from), Number(t.dataset.to));
    });
    $id('st-ticker-pause')?.addEventListener('click', (e) => {
      const track = $id('st-ticker-track');
      if (!track) return;
      const paused = track.classList.toggle('paused');
      e.currentTarget.textContent = paused ? '▶' : '❚❚';
      e.currentTarget.title = paused ? 'Resume the scroll' : 'Pause the scroll';
    });
    $id('st-ticker-clear')?.addEventListener('click', () => queueTicker(() => []));
    $id('st-chart-close')?.addEventListener('click', () => { $id('st-chart-panel').hidden = true; });
    $id('st-results')?.addEventListener('click', (e) => {
      const { from, to } = pair();
      const watch = e.target.closest('.st-watch');
      if (watch) { watchItem(Number(watch.dataset.type), from, to); return; }
      const chart = e.target.closest('.st-chartbtn');
      if (chart) { openChart(Number(chart.dataset.type), from, to); return; }
      const row = e.target.closest('.st-row');
      if (!row || !st.data) return;
      const r = st.data.rows[Number(row.dataset.i)];
      if (!r) return;
      document.querySelectorAll('.st-row.on').forEach((x) => x.classList.remove('on'));
      row.classList.add('on');
      st.selected = { ...r, reversed: false };
      renderCalc();
    });
    $id('st-search')?.addEventListener('input', onSearch);
    $id('st-search')?.addEventListener('keydown', onSearchKey);
    // A click on a suggestion has to land before blur tears the list down.
    $id('st-search')?.addEventListener('blur', () => setTimeout(closeSuggestions, 150));
    $id('st-search')?.addEventListener('focus', (e) => { if (e.target.value.trim().length >= 2) onSearch(e); });
    $id('st-search-results')?.addEventListener('mousedown', (e) => e.preventDefault());
    $id('st-search-results')?.addEventListener('click', (e) => {
      const hit = e.target.closest('.st-hit');
      if (!hit) return;
      const pick = sug.items[Number(hit.dataset.i)];
      const input = $id('st-search');
      if (pick && input) input.value = pick.name;
      closeSuggestions();
      loadItem(Number(hit.dataset.type));
    });

    try {
      await loadStations();
      if (runBtn) { runBtn.disabled = false; runBtn.title = ''; }
      await loadPresets();
      await primeTicker();
    } catch (e) {
      warn(e.message);
      if (runBtn) { runBtn.disabled = false; runBtn.title = ''; }
    }
    // The quotes come off the same 5-minute station-book cache the table uses,
    // so refreshing faster than that would re-read identical numbers.
    clearInterval(st.tickerTimer);
    st.tickerTimer = setInterval(() => {
      const tab = $id('tab-station-trade');
      if (st.ticker.length && tab && tab.offsetParent !== null) loadTicker(true);
    }, 300000);
  }

  document.querySelector('.tab-btn[data-tab="station-trade"]')?.addEventListener('click', initTab);
})();
