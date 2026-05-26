const API = window.api.base;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const DIVISION_LABELS = {
  1: 'Master',
  2: 'Contracts',
  3: 'Buyback',
  4: 'Division 4',
  5: 'Manufacturing',
  6: 'Moon mining',
  7: 'Division 7',
};
const BUYBACK_DIVISION = 3;
const MOON_DIVISION = 6;

const lastResults = { buyback: [], moon: [] };
const filterState = { buyback: 'all', moon: 'all' };

function classifyResult(r) {
  const checks = r.checks || {};
  if (checks.appraisal_fetch?.pass === false) return 'errors';
  if (checks.payout?.pass === false) return 'errors';
  const allChecksPass = Object.values(checks).every((c) => c.pass);
  const flags = r.flags || [];
  if (allChecksPass && flags.length === 0) return 'approve';
  return 'reject';
}

function applyFilter(list, filter) {
  if (filter === 'all') return list;
  return list.filter((r) => classifyResult(r) === filter);
}

$$('.filter-bar').forEach((bar) => {
  const target = bar.dataset.target;
  bar.querySelectorAll('.filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      bar.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      filterState[target] = btn.dataset.filter;
      if (target === 'buyback') renderBuyback();
      else renderMoonTab();
    });
  });
});

// Tab switching
$$('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tab-btn').forEach((b) => b.classList.remove('active'));
    $$('.tab').forEach((t) => t.classList.remove('active'));
    btn.classList.add('active');
    $(`#tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'buyback' || btn.dataset.tab === 'moon') refreshWallets();
  });
});

async function loadConfig() {
  const [cfgRes, marketsRes] = await Promise.all([
    fetch(`${API}/api/config`),
    fetch(`${API}/api/markets`),
  ]);
  const cfg = await cfgRes.json();
  const { markets } = await marketsRes.json();

  $('[name=corp_id]').value = cfg.corp_id || '';
  $('[name=janice_api_key]').value = cfg.janice_api_key || '';
  $('[name=refining_efficiency]').value = cfg.refining_efficiency ?? 0.78;
  $('[name=ice_refining_efficiency]').value = cfg.ice_refining_efficiency ?? 0.78;
  $('[name=moon_payout_fraction]').value = cfg.moon_payout_fraction ?? 0.80;

  fillMarket('#janice-market', markets, cfg.janice_market);
  fillMarket('#moon-market', markets, cfg.moon_market);

  renderStructures(Array.isArray(cfg.structures) ? cfg.structures : []);
}

function fillMarket(selector, markets, current) {
  const sel = $(selector);
  sel.innerHTML = '';
  for (const m of markets) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    if (m === current) opt.selected = true;
    sel.appendChild(opt);
  }
}

function renderStructures(list) {
  const container = $('#structures-list');
  container.innerHTML = '';
  if (list.length === 0) list = [{ name: '', id: 0, accepts: [] }];
  list.forEach((s) => container.appendChild(structureRow(s)));
}

function structureRow(s) {
  const row = document.createElement('div');
  row.className = 'structure-row';
  const accepts = s.accepts || [];
  row.innerHTML = `
    <input class="s-name" type="text" placeholder="Name (e.g. Fort)" value="${escapeAttr(s.name || '')}" />
    <input class="s-id" type="number" placeholder="Structure ID" value="${s.id || ''}" />
    <label class="cb"><input type="checkbox" class="s-ore" ${accepts.includes('ore') ? 'checked' : ''}/> Ore</label>
    <label class="cb"><input type="checkbox" class="s-nonore" ${accepts.includes('non-ore') ? 'checked' : ''}/> Non-ore</label>
    <label class="cb"><input type="checkbox" class="s-moon" ${accepts.includes('moon') ? 'checked' : ''}/> Moon</label>
    <button type="button" class="s-remove secondary">Remove</button>
  `;
  row.querySelector('.s-remove').addEventListener('click', () => row.remove());
  return row;
}

function collectStructures() {
  return [...$$('.structure-row')]
    .map((r) => ({
      name: r.querySelector('.s-name').value.trim(),
      id: parseInt(r.querySelector('.s-id').value) || 0,
      accepts: [
        r.querySelector('.s-ore').checked ? 'ore' : null,
        r.querySelector('.s-nonore').checked ? 'non-ore' : null,
        r.querySelector('.s-moon').checked ? 'moon' : null,
      ].filter(Boolean),
    }))
    .filter((s) => s.name || s.id);
}

$('#btn-add-structure').addEventListener('click', () => {
  $('#structures-list').appendChild(structureRow({ name: '', id: 0, accepts: [] }));
});

$('#config-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = {
    corp_id: parseInt(fd.get('corp_id')) || 0,
    structures: collectStructures(),
    janice_market: $('#janice-market').value,
    janice_api_key: fd.get('janice_api_key'),
    moon_market: $('#moon-market').value,
    refining_efficiency: parseFloat(fd.get('refining_efficiency')) || 0.78,
    ice_refining_efficiency: parseFloat(fd.get('ice_refining_efficiency')) || 0.78,
    moon_payout_fraction: parseFloat(fd.get('moon_payout_fraction')) || 0.80,
  };
  const res = await fetch(`${API}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  $('#config-status').textContent = res.ok ? 'Saved.' : 'Error saving.';
  setTimeout(() => ($('#config-status').textContent = ''), 2500);
});

function renderMoonTab() {
  const list = applyFilter(lastResults.moon, filterState.moon);
  const root = $('#moon-results');
  root.innerHTML = '';
  if (!list.length) {
    root.innerHTML = `<p class="muted">No moon contracts ${filterState.moon === 'all' ? 'found' : `in "${filterState.moon}" filter`}.</p>`;
    return;
  }
  for (const r of list) root.appendChild(buildMoonRow(r));
}

function buildMoonRow(r) {
  const checks = r.checks || {};
  const flags = r.flags || [];
  const hasFlag = flags.length > 0;
  const allChecksPass = Object.values(checks).every((c) => c.pass);
  const div = document.createElement('div');
  div.className = `result ${allChecksPass && !hasFlag ? 'pass' : 'fail'}`;

  const flagBanners =
    (flags.includes('return_requested')
      ? `<div class="flag-banner">⚠ Return requested — title contains "return"</div>`
      : '') +
    (flags.includes('workforce_donation')
      ? `<div class="flag-banner">⚠ Contains workforce reagents (Magmatic Gas / Superionic Ice) — accepted as donation, no payout</div>`
      : '');

  const janice = r.payout?.janice;
  const refined = r.payout?.refined;

  let janiceBlock = '';
  if (janice) {
    if (janice.error) {
      janiceBlock = `<div class="meta">Janice appraisal: <span class="muted">error — ${escapeHtml(janice.error)}</span></div>`;
    } else {
      const fallback = janice.api_fallback_reason
        ? `<div class="flag-banner">⚠ Janice API failed — using RPC fallback: ${escapeHtml(janice.api_fallback_reason)}</div>`
        : '';
      const codeLink = janice.code
        ? ` (<a href="https://janice.e-351.com/a/${escapeHtml(janice.code)}" target="_blank" rel="noopener">view</a>)`
        : '';
      const buybackEquiv = (janice.total_buy_price || 0) * 0.9;
      const marketName = janice.market_name || '';
      janiceBlock = `<div class="meta">Janice [${janice.source}] @ ${escapeHtml(marketName)}${codeLink}: <strong>${Math.round(janice.total_buy_price).toLocaleString()} ISK</strong> compressed buy</div>
        <div class="meta">Buyback equivalent (90% ${escapeHtml(marketName)} buy): <strong>${Math.round(buybackEquiv).toLocaleString()} ISK</strong></div>${fallback}`;
    }
  }

  let refinedBlock = '';
  if (refined) {
    const orePct = ((refined.refining_efficiency ?? 0) * 100).toFixed(0);
    const icePct = ((refined.ice_refining_efficiency ?? refined.refining_efficiency ?? 0) * 100).toFixed(0);
    const payPct = ((refined.payout_fraction ?? 0) * 100).toFixed(0);
    const market = escapeHtml(refined.market_name || '');
    const effLabel = refined.has_ore && refined.has_ice
      ? `${orePct}% ore / ${icePct}% ice`
      : refined.has_ice
      ? `${icePct}% ice`
      : `${orePct}% ore`;
    const leftoverValue = refined.leftover_value || 0;
    const leftoverLine = leftoverValue > 0
      ? `<div class="meta">Priced at hub buy (non-refinable or remainder): ${Math.round(leftoverValue).toLocaleString()} ISK at ${market}</div>`
      : '';
    refinedBlock = `<div class="meta">Refined @ ${effLabel} efficiency @ ${market}: ${Math.round(refined.refined_value).toLocaleString()} ISK</div>
       ${leftoverLine}
       <div class="payout-final">→ Payout (${payPct}%): ${Math.round(refined.recommended_payout).toLocaleString()} ISK</div>`;
  }

  const items = r.payout?.items || [];
  const breakdown = r.payout?.refined?.breakdown || [];
  const leftoverBreakdown = r.payout?.refined?.leftover_breakdown || [];
  const donationBreakdown = r.payout?.refined?.donation_breakdown || [];

  const tableRow = (b) => ({
    name: b.name || `type ${b.type_id}`,
    quantity: b.quantity,
    'unit price': Number(b.unit_price?.toFixed?.(2) ?? b.unit_price ?? 0),
    value: Math.round(b.value || 0),
  });

  const leftoverBlock = leftoverBreakdown.length
    ? `<details>
         <summary>Unrefined remainder (${leftoverBreakdown.length} types)</summary>
         ${renderItemsTable(leftoverBreakdown.map(tableRow), ['name', 'quantity', 'unit price', 'value'])}
       </details>`
    : '';

  const donationBlock = donationBreakdown.length
    ? `<details open>
         <summary>Donations — accepted, no payout (${donationBreakdown.length} types)</summary>
         ${renderItemsTable(
           donationBreakdown.map((b) => ({ name: b.name || `type ${b.type_id}`, quantity: b.quantity })),
           ['name', 'quantity'],
         )}
       </details>`
    : '';

  const contentsBlock = `
    <details>
      <summary>Contract contents (${items.length} items)</summary>
      ${renderItemsTable(items.map((i) => ({ name: i.name || `type ${i.type_id}`, quantity: i.quantity })), ['name', 'quantity'])}
    </details>
    <details>
      <summary>Refined minerals (${breakdown.length} types)</summary>
      ${renderItemsTable(breakdown.map(tableRow), ['name', 'quantity', 'unit price', 'value'])}
    </details>
    ${leftoverBlock}
    ${donationBlock}`;

  div.innerHTML = `
    <h4>Contract ${r.contract_id} — ${escapeHtml(r.issuer_name || 'unknown issuer')}</h4>
    ${flagBanners}
    <div class="meta">Issuer: ${escapeHtml(r.issuer_name || '')} (${r.issuer_id ?? '?'})</div>
    <div class="meta">Title: ${escapeHtml(r.title || '(empty)')}</div>
    <div class="meta">Location: ${r.start_location_id ?? '?'}</div>
    ${janiceBlock}${refinedBlock}
    ${Object.entries(checks).map(([k, v]) =>
      `<div class="check ${v.pass ? 'pass' : 'fail'}">
         <strong>${k}:</strong>${v.pass ? 'PASS' : 'FAIL'}${v.reason ? ` — ${escapeHtml(v.reason)}` : ''}
       </div>`
    ).join('')}
    ${contentsBlock}
  `;
  return div;
}

function escapeAttr(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  })[c]);
}

async function refreshAuthStatus() {
  $('#auth-status').textContent = 'checking...';
  try {
    const res = await fetch(`${API}/api/auth/status`);
    const data = await res.json();
    if (data.authenticated) {
      const exp = data.expires_at ? new Date(data.expires_at * 1000).toLocaleTimeString() : '?';
      $('#auth-status').textContent = `authenticated as ${data.character} (expires ${exp})`;
    } else {
      $('#auth-status').textContent = data.error
        ? `not authenticated: ${data.error}`
        : 'not authenticated';
    }
  } catch (e) {
    if (String(e).includes('Failed to fetch') || String(e).includes('NetworkError')) {
      $('#auth-status').textContent =
        'Python sidecar is not reachable on localhost:8765. ' +
        'Check that sidecar.exe is running (Task Manager) and that nothing else is bound to port 8765.';
    } else {
      $('#auth-status').textContent = `error: ${e}`;
    }
  }
}

$('#btn-login').addEventListener('click', async () => {
  const res = await fetch(`${API}/api/auth/login`, { method: 'POST' });
  if (!res.ok) {
    alert(`Login failed: ${await res.text()}`);
    return;
  }
  $('#auth-status').textContent = 'waiting for browser login...';
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    await refreshAuthStatus();
    if ($('#auth-status').textContent.startsWith('authenticated')) return;
  }
});

$('#btn-refresh-status').addEventListener('click', refreshAuthStatus);

async function runValidateStream() {
  // Reset state on both tabs
  lastResults.buyback = [];
  lastResults.moon = [];
  $('#results').innerHTML = '';
  $('#moon-results').innerHTML = '';
  $('#run-status').textContent = 'starting…';
  $('#moon-status').textContent = 'starting…';
  showProgress('buyback', 0, 0);
  showProgress('moon', 0, 0);

  try {
    const res = await fetch(`${API}/api/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      const msg = `Error: ${await res.text()}`;
      $('#run-status').textContent = msg;
      $('#moon-status').textContent = msg;
      hideProgress('buyback');
      hideProgress('moon');
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) handleStreamEvent(JSON.parse(line));
      }
    }
    if (buf.trim()) handleStreamEvent(JSON.parse(buf));
  } catch (e) {
    const msg = `Stream error: ${e}`;
    $('#run-status').textContent = msg;
    $('#moon-status').textContent = msg;
    hideProgress('buyback');
    hideProgress('moon');
  }
}

function handleStreamEvent(ev) {
  switch (ev.event) {
    case 'progress': {
      const kind = ev.kind;
      if (kind === 'buyback' || kind === 'moon') {
        showProgress(kind, ev.current, ev.total);
        setStep(kind, ev.step);
      } else {
        // Pre-loop steps go to both tabs' status line so user sees them
        setStep('buyback', ev.step);
        setStep('moon', ev.step);
      }
      break;
    }
    case 'start': {
      const s = ev.summary;
      $('#run-status').textContent =
        `Courier: ${s.courier} | Moon: ${s.moon} | Buyback: ${s.buyback}`;
      $('#moon-status').textContent = `Moon contracts found: ${s.moon}`;
      break;
    }
    case 'buyback_result':
      lastResults.buyback.push(ev.result);
      showProgress('buyback', ev.current, ev.total);
      appendResultIfMatch('buyback', ev.result);
      break;
    case 'moon_result':
      lastResults.moon.push(ev.result);
      showProgress('moon', ev.current, ev.total);
      appendResultIfMatch('moon', ev.result);
      break;
    case 'done':
      setStep('buyback', 'done');
      setStep('moon', 'done');
      hideProgress('buyback');
      hideProgress('moon');
      break;
    case 'error':
      $('#run-status').textContent = `Error: ${ev.message}`;
      $('#moon-status').textContent = `Error: ${ev.message}`;
      hideProgress('buyback');
      hideProgress('moon');
      break;
  }
}

function showProgress(kind, current, total) {
  const area = $(`#${kind}-progress`);
  area.hidden = false;
  const pct = total > 0 ? Math.min(100, (current / total) * 100) : 0;
  area.querySelector('.progress-fill').style.width = `${pct}%`;
}

function hideProgress(kind) {
  $(`#${kind}-progress`).hidden = true;
}

function setStep(kind, step) {
  const el = $(`#${kind}-progress .progress-step`);
  if (el) el.textContent = step || '';
}

function appendResultIfMatch(kind, result) {
  if (filterState[kind] !== 'all' && classifyResult(result) !== filterState[kind]) return;
  const root = kind === 'buyback' ? $('#results') : $('#moon-results');
  const empty = root.querySelector('p.muted');
  if (empty) empty.remove();
  const node = kind === 'buyback' ? buildBuybackRow(result) : buildMoonRow(result);
  root.appendChild(node);
}

$('#btn-fetch').addEventListener('click', runValidateStream);
$('#btn-fetch-moon').addEventListener('click', runValidateStream);

function renderItemsTable(items, columns = ['name', 'amount']) {
  if (!items || !items.length) return '<p class="muted">no items</p>';
  const head = columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('');
  const body = items.map((it) => {
    const cells = columns.map((c) => {
      const v = it[c] ?? '';
      const cls = typeof v === 'number' ? 'num' : '';
      const display = typeof v === 'number' ? v.toLocaleString() : escapeHtml(String(v));
      return `<td class="${cls}">${display}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');
  return `<table class="items-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

$('#btn-refresh-wallets').addEventListener('click', refreshWallets);
$('#btn-refresh-moon-wallets').addEventListener('click', refreshWallets);

async function refreshWallets() {
  const targets = [
    { sel: '#wallet-summary', highlight: BUYBACK_DIVISION },
    { sel: '#moon-wallet-summary', highlight: MOON_DIVISION },
  ].filter((t) => $(t.sel));

  for (const { sel } of targets) $(sel).innerHTML = '<span class="muted">loading wallets…</span>';

  let data;
  try {
    const res = await fetch(`${API}/api/wallets`);
    if (!res.ok) {
      const msg = `wallets unavailable: ${await res.text()}`;
      for (const { sel } of targets) $(sel).innerHTML = `<span class="muted">${msg}</span>`;
      return;
    }
    data = await res.json();
  } catch (e) {
    for (const { sel } of targets) $(sel).innerHTML = `<span class="muted">wallets error: ${e}</span>`;
    return;
  }

  for (const { sel, highlight } of targets) {
    renderWalletTiles($(sel), data, highlight);
  }
}

function renderWalletTiles(root, data, highlightDivision) {
  root.innerHTML = '';
  const totalTile = document.createElement('div');
  totalTile.className = 'wallet-tile';
  totalTile.innerHTML = `<div class="label">Total (all divisions)</div><div class="amount">${Math.round(data.total).toLocaleString()} ISK</div>`;
  root.appendChild(totalTile);
  for (const w of data.wallets) {
    const tile = document.createElement('div');
    const isHighlight = w.division === highlightDivision;
    tile.className = `wallet-tile${isHighlight ? ' total' : ''}`;
    const label = DIVISION_LABELS[w.division] || `Division ${w.division}`;
    tile.innerHTML = `<div class="label">${label} (div ${w.division})</div><div class="amount">${Math.round(w.balance).toLocaleString()} ISK</div>`;
    root.appendChild(tile);
  }
}

function renderBuyback() {
  const list = applyFilter(lastResults.buyback, filterState.buyback);
  const root = $('#results');
  root.innerHTML = '';
  if (!list.length) {
    root.innerHTML = `<p class="muted">No buyback contracts ${filterState.buyback === 'all' ? '' : `in "${filterState.buyback}" filter`}.</p>`;
    return;
  }
  for (const r of list) root.appendChild(buildBuybackRow(r));
}

function buildBuybackRow(r) {
  const checks = r.checks || {};
  const allPass = Object.values(checks).every((c) => c.pass);
  const div = document.createElement('div');
  div.className = `result ${allPass ? 'pass' : 'fail'}`;
  const titleEsc = escapeHtml(r.title || '');
  const titleLink = (r.title || '').includes('janice')
    ? `<a href="${titleEsc}" target="_blank" rel="noopener">${titleEsc}</a>`
    : titleEsc;
  const issuer = r.issuer_name
    ? `${escapeHtml(r.issuer_name)} (${r.issuer_id})`
    : `${r.issuer_id ?? '?'}`;
  const fallbackNote = r.appraisal?.api_fallback_reason
    ? `<div class="flag-banner">⚠ Janice API failed — using RPC fallback: ${escapeHtml(r.appraisal.api_fallback_reason)}</div>`
    : '';
  const appraisal = r.appraisal
    ? `<div class="meta">Janice [${r.appraisal.source}]: ${r.appraisal.percentage.toFixed(1)}% ${escapeHtml(r.appraisal.market_name || '')} — effective offer ${Math.round(r.appraisal.effective_offer).toLocaleString()} ISK</div>${fallbackNote}`
    : '';
  const items = r.appraisal?.items || [];
  const contentsBlock = items.length
    ? `<details>
         <summary>Contract contents (${items.length} items from Janice)</summary>
         ${renderItemsTable(items.map((i) => ({ name: i.name, quantity: i.amount })), ['name', 'quantity'])}
       </details>`
    : '';
  div.innerHTML = `
    <h4>Contract ${r.contract_id} — ${escapeHtml(r.issuer_name || 'unknown issuer')}</h4>
    <div class="meta">Issuer: ${issuer}</div>
    <div class="meta">Title: ${titleLink || '<em>(empty)</em>'}</div>
    <div class="meta">Price: ${(r.price ?? 0).toLocaleString()} ISK — location ${r.start_location_id ?? '?'}</div>
    ${appraisal}
    ${Object.entries(checks).map(([k, v]) =>
      `<div class="check ${v.pass ? 'pass' : 'fail'}">
         <strong>${k}:</strong>${v.pass ? 'PASS' : 'FAIL'}${v.reason ? ` — ${escapeHtml(v.reason)}` : ''}
       </div>`
    ).join('')}
    ${contentsBlock}
  `;
  return div;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

loadConfig();
refreshAuthStatus();
