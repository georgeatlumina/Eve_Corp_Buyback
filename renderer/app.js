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
  for (const r of list) {
    const checks = r.checks || {};
    const flags = r.flags || [];
    const hasFlag = flags.length > 0;
    const allChecksPass = Object.values(checks).every((c) => c.pass);
    const div = document.createElement('div');
    div.className = `result ${allChecksPass && !hasFlag ? 'pass' : 'fail'}`;

    const flagBanners = flags.includes('return_requested')
      ? `<div class="flag-banner">⚠ Return requested — title contains "return"</div>`
      : '';

    const skipped = r.payout?.skipped_items || [];
    const skippedList = skipped.length
      ? `<div class="muted">Skipped (no refining yields known): ${skipped.map((s) => escapeHtml(s.name || `type ${s.type_id}`)).join(', ')}</div>`
      : '';

    const payout = r.payout
      ? `<div class="meta">Refined value: ${Math.round(r.payout.refined_value).toLocaleString()} ISK
         &nbsp;→ <strong>Recommended payout: ${Math.round(r.payout.recommended_payout).toLocaleString()} ISK</strong>
         ${skippedList}
         </div>`
      : '';

    div.innerHTML = `
      <h4>Contract ${r.contract_id} — ${escapeHtml(r.issuer_name || 'unknown issuer')}</h4>
      ${flagBanners}
      <div class="meta">Issuer: ${escapeHtml(r.issuer_name || '')} (${r.issuer_id ?? '?'})</div>
      <div class="meta">Title: ${escapeHtml(r.title || '(empty)')}</div>
      <div class="meta">Location: ${r.start_location_id ?? '?'}</div>
      ${payout}
      ${Object.entries(checks).map(([k, v]) =>
        `<div class="check ${v.pass ? 'pass' : 'fail'}">
           <strong>${k}:</strong>${v.pass ? 'PASS' : 'FAIL'}${v.reason ? ` — ${escapeHtml(v.reason)}` : ''}
         </div>`
      ).join('')}
    `;
    root.appendChild(div);
  }
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
    $('#auth-status').textContent = `error: ${e}`;
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

async function runValidate(statusSel) {
  $(statusSel).textContent = 'Fetching contracts and running validation...';
  try {
    const res = await fetch(`${API}/api/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      $(statusSel).textContent = `Error: ${await res.text()}`;
      return null;
    }
    return await res.json();
  } catch (e) {
    $(statusSel).textContent = `Error: ${e}`;
    return null;
  }
}

$('#btn-fetch').addEventListener('click', async () => {
  $('#results').innerHTML = '';
  const data = await runValidate('#run-status');
  if (data) onValidateResult(data);
});

$('#btn-fetch-moon').addEventListener('click', async () => {
  $('#moon-results').innerHTML = '';
  const data = await runValidate('#moon-status');
  if (data) onValidateResult(data);
});

function onValidateResult(data) {
  lastResults.buyback = data.buyback_results || [];
  lastResults.moon = data.moon_results || [];
  const s = data.summary;
  $('#run-status').textContent =
    `Courier: ${s.courier} | Moon: ${s.moon} | Buyback: ${s.buyback}`;
  $('#moon-status').textContent = `Moon contracts found: ${s.moon}`;
  renderBuyback();
  renderMoonTab();
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
  for (const r of list) {
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
    const appraisal = r.appraisal
      ? `<div class="meta">Janice [${r.appraisal.source}]: ${r.appraisal.percentage.toFixed(1)}% ${escapeHtml(r.appraisal.market_name || '')} — effective offer ${Math.round(r.appraisal.effective_offer).toLocaleString()} ISK</div>`
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
    `;
    root.appendChild(div);
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

loadConfig();
refreshAuthStatus();
