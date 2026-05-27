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
let mailPresets = [
  { label: '', subject: '', body: '' },
  { label: '', subject: '', body: '' },
  { label: '', subject: '', body: '' },
  { label: '', subject: '', body: '' },
];

// Flags that mark a contract for attention but DON'T flip it out of the
// Approve bucket — these are accepted, just with a visual banded marker
// so the operator notices them.
const ACCEPT_WITH_ATTENTION_FLAGS = new Set(['workforce_donation', 'prismaticite_manual']);

function classifyResult(r) {
  const checks = r.checks || {};
  if (checks.appraisal_fetch?.pass === false) return 'errors';
  if (checks.payout?.pass === false) return 'errors';
  const allChecksPass = Object.values(checks).every((c) => c.pass);
  const flags = r.flags || [];
  const rejectingFlags = flags.filter((f) => !ACCEPT_WITH_ATTENTION_FLAGS.has(f));
  if (allChecksPass && rejectingFlags.length === 0) return 'approve';
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
  // Fetch config and markets independently — one shouldn't take down the other.
  let cfg = null;
  try {
    const res = await fetch(`${API}/api/config`);
    if (res.ok) cfg = await res.json();
    else console.error('[loadConfig] /api/config failed:', res.status, await res.text());
  } catch (e) {
    console.error('[loadConfig] /api/config error:', e);
  }

  let markets = [];
  try {
    const res = await fetch(`${API}/api/markets`);
    if (res.ok) {
      const data = await res.json();
      markets = Array.isArray(data?.markets) ? data.markets : [];
    } else {
      console.error('[loadConfig] /api/markets failed:', res.status, await res.text());
    }
  } catch (e) {
    console.error('[loadConfig] /api/markets error:', e);
  }

  // Populate the dropdowns even if /api/config failed — so the user can still see
  // and choose a hub. Saving Config will recreate the config file from defaults.
  fillMarket('#janice-market', markets, cfg?.janice_market);
  fillMarket('#moon-market', markets, cfg?.moon_market);

  if (!cfg) {
    console.warn('[loadConfig] no config — populating dropdowns only');
    return;
  }

  $('[name=corp_id]').value = cfg.corp_id || '';
  $('[name=janice_api_key]').value = cfg.janice_api_key || '';
  $('[name=moon_ore_refining_efficiency]').value =
    cfg.moon_ore_refining_efficiency ?? cfg.refining_efficiency ?? 0.78;
  $('[name=non_moon_ore_refining_efficiency]').value =
    cfg.non_moon_ore_refining_efficiency ?? cfg.refining_efficiency ?? 0.78;
  $('[name=ice_refining_efficiency]').value = cfg.ice_refining_efficiency ?? 0.78;
  $('[name=moon_payout_fraction]').value = cfg.moon_payout_fraction ?? 0.80;
  $('[name=non_moon_payout_fraction]').value = cfg.non_moon_payout_fraction ?? 0.90;

  renderStructures(Array.isArray(cfg.structures) ? cfg.structures : []);

  if (Array.isArray(cfg.mail_presets)) {
    mailPresets = cfg.mail_presets.slice(0, 4);
    while (mailPresets.length < 4) mailPresets.push({ label: '', subject: '', body: '' });
  }
  renderMailPresetEditors();
  // Re-render any visible results so button labels reflect the latest presets
  renderBuyback();
  renderMoonTab();
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
    moon_ore_refining_efficiency: parseFloat(fd.get('moon_ore_refining_efficiency')) || 0.78,
    non_moon_ore_refining_efficiency: parseFloat(fd.get('non_moon_ore_refining_efficiency')) || 0.78,
    ice_refining_efficiency: parseFloat(fd.get('ice_refining_efficiency')) || 0.78,
    moon_payout_fraction: parseFloat(fd.get('moon_payout_fraction')) || 0.80,
    non_moon_payout_fraction: parseFloat(fd.get('non_moon_payout_fraction')) || 0.90,
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
  const allChecksPass = Object.values(checks).every((c) => c.pass);
  const rejectingFlags = flags.filter((f) => !ACCEPT_WITH_ATTENTION_FLAGS.has(f));
  const baseClass = allChecksPass && rejectingFlags.length === 0 ? 'pass' : 'fail';
  const modifiers = [];
  if (flags.includes('prismaticite_manual')) modifiers.push('flag-prismaticite');
  if (flags.includes('workforce_donation')) modifiers.push('flag-donation');
  const div = document.createElement('div');
  div.className = ['result', baseClass, ...modifiers].join(' ');
  div.dataset.contractId = r.contract_id;

  const flagBanners =
    (flags.includes('return_requested')
      ? `<div class="flag-banner">⚠ Return requested — title contains "return"</div>`
      : '') +
    (flags.includes('workforce_donation')
      ? `<div class="flag-banner">⚠ Contains workforce reagents (Magmatic Gas / Superionic Ice) — accepted as donation, no payout</div>`
      : '') +
    (flags.includes('prismaticite_manual')
      ? `<div class="flag-banner prismaticite">⚠ Contains Prismaticite — payout MUST be calculated manually (not included in the recommended payout above)</div>`
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
    const moonOrePct = ((refined.moon_ore_refining_efficiency
      ?? refined.refining_efficiency ?? 0) * 100).toFixed(0);
    const nonMoonOrePct = ((refined.non_moon_ore_refining_efficiency
      ?? refined.refining_efficiency ?? 0) * 100).toFixed(0);
    const icePct = ((refined.ice_refining_efficiency
      ?? refined.non_moon_ore_refining_efficiency
      ?? refined.refining_efficiency ?? 0) * 100).toFixed(0);
    const moonPct = ((refined.moon_payout_fraction ?? 0.80) * 100).toFixed(0);
    const nonMoonPct = ((refined.non_moon_payout_fraction ?? 0.90) * 100).toFixed(0);
    const market = escapeHtml(refined.market_name || '');
    const effParts = [];
    if (refined.has_moon_ore) effParts.push(`${moonOrePct}% moon ore`);
    if (refined.has_non_moon_ore) effParts.push(`${nonMoonOrePct}% non-moon ore`);
    if (refined.has_ice) effParts.push(`${icePct}% ice`);
    const effLabel = effParts.join(' / ') || `${nonMoonOrePct}% ore`;

    const buckets = [];
    if ((refined.moon_value || 0) > 0) {
      buckets.push(
        `<div class="meta">&nbsp;&nbsp;Moon ore: ${Math.round(refined.moon_value).toLocaleString()} ISK × ${moonPct}% = ${Math.round(refined.moon_payout).toLocaleString()} ISK</div>`
      );
    }
    if ((refined.non_moon_value || 0) > 0) {
      buckets.push(
        `<div class="meta">&nbsp;&nbsp;Non-moon ore + ice: ${Math.round(refined.non_moon_value).toLocaleString()} ISK × ${nonMoonPct}% = ${Math.round(refined.non_moon_payout).toLocaleString()} ISK</div>`
      );
    }

    refinedBlock = `<div class="meta">Refined @ ${effLabel} efficiency @ ${market}: ${Math.round(refined.refined_value + (refined.leftover_value || 0)).toLocaleString()} ISK</div>
       ${buckets.join('\n')}
       <div class="payout-final">→ Payout: <span class="payout-copy" role="button" tabindex="0" title="Click to copy" data-copy="${Math.round(refined.recommended_payout)}">${Math.round(refined.recommended_payout).toLocaleString()}</span> ISK</div>`;
  }

  const items = r.payout?.items || [];
  const breakdown = r.payout?.refined?.breakdown || [];
  const leftoverBreakdown = r.payout?.refined?.leftover_breakdown || [];
  const donationBreakdown = r.payout?.refined?.donation_breakdown || [];
  const prismaticiteBreakdown = r.payout?.refined?.prismaticite_breakdown || [];

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

  const prismaticiteBlock = prismaticiteBreakdown.length
    ? `<details open>
         <summary>Prismaticite — calculate payout manually (${prismaticiteBreakdown.length} types)</summary>
         ${renderItemsTable(
           prismaticiteBreakdown.map((b) => ({ name: b.name || `type ${b.type_id}`, quantity: b.quantity })),
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
    ${donationBlock}
    ${prismaticiteBlock}`;

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
    ${buildMailButtonsRow(r, 'moon')}
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
        'See sidecar.log in the app data folder for diagnostics ' +
        '(Windows: %APPDATA%\\EVE Corp Buyback\\sidecar.log, ' +
        'macOS: ~/Library/Application Support/EVE Corp Buyback/sidecar.log).';
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
  div.dataset.contractId = r.contract_id;
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
    ${buildMailButtonsRow(r, 'buyback')}
  `;
  return div;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// ---------- Mail preset editor (Mail tab) ----------

function renderMailPresetEditors() {
  const root = $('#mail-presets-list');
  if (!root) return;
  root.innerHTML = '';
  mailPresets.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'mail-preset';
    card.innerHTML = `
      <h4>Preset ${i + 1}</h4>
      <label>Button label <input type="text" data-mp="label" data-idx="${i}" value="${escapeAttr(p.label || '')}" placeholder="e.g. Accepted" /></label>
      <label>Subject <input type="text" data-mp="subject" data-idx="${i}" value="${escapeAttr(p.subject || '')}" placeholder="Mail subject" /></label>
      <label>Body <textarea data-mp="body" data-idx="${i}" rows="6" placeholder="Mail body; use {variable} placeholders">${escapeHtml(p.body || '')}</textarea></label>
    `;
    root.appendChild(card);
  });
}

const presetsForm = $('#mail-presets-form');
if (presetsForm) {
  presetsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const collected = [0, 1, 2, 3].map((i) => ({
      label: $(`[data-mp="label"][data-idx="${i}"]`).value.trim(),
      subject: $(`[data-mp="subject"][data-idx="${i}"]`).value,
      body: $(`[data-mp="body"][data-idx="${i}"]`).value,
    }));
    const res = await fetch(`${API}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mail_presets: collected }),
    });
    if (res.ok) {
      mailPresets = collected;
      $('#mail-presets-status').textContent = 'Saved.';
      // Re-render the contract rows to update button labels
      renderBuyback();
      renderMoonTab();
    } else {
      $('#mail-presets-status').textContent = `Error: ${await res.text()}`;
    }
    setTimeout(() => ($('#mail-presets-status').textContent = ''), 2500);
  });
}

// ---------- Per-row buttons + template rendering ----------

function buildMailButtonsRow(contract, kind) {
  const buttons = mailPresets
    .map((p, i) => {
      const label = (p.label || '').trim();
      const disabled = !label || !contract.issuer_id;
      const text = label || `(preset ${i + 1})`;
      return `<button type="button" class="mail-btn" data-preset-idx="${i}"${disabled ? ' disabled' : ''} title="${disabled && !label ? 'No preset configured — set a label in the Mail tab' : ''}">${escapeHtml(text)}</button>`;
    })
    .join('');
  // Stash kind on the wrapper so the click handler can render the right variables.
  return `<div class="contract-actions" data-kind="${kind}">${buttons}</div>`;
}

function renderMailTemplate(template, contract, kind) {
  const today = new Date().toISOString().slice(0, 10);
  const checks = contract.checks || {};
  const failedReasons = Object.entries(checks)
    .filter(([_, v]) => !v.pass)
    .map(([k, v]) => `${k}: ${v.reason || 'FAIL'}`)
    .join('; ');

  const vars = {
    contract_id: contract.contract_id ?? '',
    title: contract.title || '',
    price: ((contract.price ?? 0) | 0).toLocaleString() + ' ISK',
    date: today,
    issuer_name: contract.issuer_name || '',
    location_id: contract.start_location_id ?? '',
    errors: failedReasons || 'none',
  };

  if (kind === 'buyback' && contract.appraisal) {
    vars.appraisal_percentage =
      contract.appraisal.percentage != null
        ? contract.appraisal.percentage.toFixed(1) + '%'
        : 'N/A';
    vars.effective_offer = contract.appraisal.effective_offer
      ? Math.round(contract.appraisal.effective_offer).toLocaleString() + ' ISK'
      : 'N/A';
  } else {
    vars.appraisal_percentage = 'N/A';
    vars.effective_offer = 'N/A';
  }

  if (kind === 'moon' && contract.payout?.refined) {
    vars.payout = Math.round(contract.payout.refined.recommended_payout || 0).toLocaleString() + ' ISK';
    vars.refined_value = Math.round(contract.payout.refined.refined_value || 0).toLocaleString() + ' ISK';
  } else {
    vars.payout = 'N/A';
    vars.refined_value = 'N/A';
  }

  return String(template || '').replace(/\{(\w+)\}/g, (_, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : `{${name}}`,
  );
}

// ---------- Preview / send dialog ----------

let mailModalContext = null; // { recipient_id, recipient_name }

function openMailModal(contract, kind, presetIdx) {
  const preset = mailPresets[presetIdx];
  if (!preset || !contract.issuer_id) return;
  const subject = renderMailTemplate(preset.subject, contract, kind);
  const body = renderMailTemplate(preset.body, contract, kind);
  mailModalContext = {
    recipient_id: contract.issuer_id,
    recipient_name: contract.issuer_name || `id ${contract.issuer_id}`,
  };
  $('#mail-modal-recipient').textContent = `${mailModalContext.recipient_name} (${contract.issuer_id})`;
  $('#mail-modal-subject').value = subject;
  $('#mail-modal-body').value = body;
  $('#mail-modal-status').textContent = '';
  $('#mail-modal').hidden = false;
}

function closeMailModal() {
  $('#mail-modal').hidden = true;
  mailModalContext = null;
}

$('#mail-modal-cancel').addEventListener('click', closeMailModal);
$('#mail-modal .modal-backdrop').addEventListener('click', closeMailModal);

$('#mail-modal-send').addEventListener('click', async () => {
  if (!mailModalContext) return;
  const subject = $('#mail-modal-subject').value;
  const body = $('#mail-modal-body').value;
  $('#mail-modal-status').textContent = 'sending…';
  $('#mail-modal-send').disabled = true;
  try {
    const res = await fetch(`${API}/api/mail/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient_id: mailModalContext.recipient_id,
        subject,
        body,
      }),
    });
    if (res.ok) {
      $('#mail-modal-status').textContent = 'Sent.';
      setTimeout(closeMailModal, 800);
    } else {
      const text = await res.text();
      $('#mail-modal-status').textContent = `Failed: ${text}`;
    }
  } catch (e) {
    $('#mail-modal-status').textContent = `Failed: ${e}`;
  } finally {
    $('#mail-modal-send').disabled = false;
  }
});

// Click delegation for the per-row mail buttons (handles incremental + filtered renders)
document.addEventListener('click', async (e) => {
  const copyEl = e.target.closest('.payout-copy');
  if (copyEl) {
    const value = copyEl.dataset.copy || '';
    try {
      await navigator.clipboard.writeText(value);
      const prev = copyEl.dataset.prevText ?? copyEl.textContent;
      copyEl.dataset.prevText = prev;
      copyEl.textContent = 'copied!';
      copyEl.classList.add('payout-copied');
      setTimeout(() => {
        copyEl.textContent = prev;
        copyEl.classList.remove('payout-copied');
      }, 900);
    } catch {}
    return;
  }
  const btn = e.target.closest('.mail-btn');
  if (!btn) return;
  const row = btn.closest('.result');
  const actions = btn.closest('.contract-actions');
  if (!row || !actions) return;
  const contractId = parseInt(row.dataset.contractId || '', 10);
  if (!contractId) return;
  const kind = actions.dataset.kind;
  const list = kind === 'moon' ? lastResults.moon : lastResults.buyback;
  const contract = list.find((c) => c.contract_id === contractId);
  if (!contract) return;
  const idx = parseInt(btn.dataset.presetIdx, 10);
  openMailModal(contract, kind, idx);
});

loadConfig();
refreshAuthStatus();
initMoonCalculator();

function initMoonCalculator() {
  const mount = $('#calc-mount');
  const sidebar = $('#moon-calc-sidebar');
  const toggleBtn = $('#btn-toggle-calc');
  const popoutBtn = $('#btn-calc-popout');
  if (!mount || !sidebar || !toggleBtn) return;

  window.mountCalculator(mount);

  toggleBtn.addEventListener('click', () => {
    const hidden = sidebar.hasAttribute('hidden');
    if (hidden) {
      sidebar.removeAttribute('hidden');
      toggleBtn.textContent = 'Hide calculator';
    } else {
      sidebar.setAttribute('hidden', '');
      toggleBtn.textContent = 'Show calculator';
    }
  });

  if (popoutBtn) {
    popoutBtn.addEventListener('click', () => {
      if (window.api && typeof window.api.openCalculator === 'function') {
        window.api.openCalculator();
      }
    });
  }
}

const btnAaOpen = $('#btn-aa-open');
if (btnAaOpen) {
  btnAaOpen.addEventListener('click', () => {
    if (window.api && typeof window.api.aaOpen === 'function') window.api.aaOpen();
  });
}
const btnAaLogout = $('#btn-aa-logout');
if (btnAaLogout) {
  btnAaLogout.addEventListener('click', async () => {
    if (window.api && typeof window.api.aaLogout === 'function') {
      await window.api.aaLogout();
      const status = $('#aa-status');
      if (status) status.textContent = 'Signed out.';
      const list = $('#doctrines-list');
      if (list) list.innerHTML = '';
    }
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function extractTypeId(src) {
  if (!src) return null;
  const m = /\/types\/(\d+)\//.exec(src);
  return m ? parseInt(m[1], 10) : null;
}

const aaState = {
  view: 'list',
  doctrineId: null,
  fitId: null,
  doctrines: [],
  doctrineDetail: null,
  fitDetail: null,
  market: null,        // { structure_id, fetched_at, order_count, by_type: {type_id: {min_price, total_volume, order_count}} }
  marketLoading: false,
  marketError: null,
};

function refreshAllMarketViews() {
  if (aaState.view === 'fit') renderAaView();
  if (typeof renderReadinessDashboard === 'function' && $('#tab-readiness')?.classList.contains('active')) {
    renderReadinessDashboard();
  }
}

async function loadMarket(refresh = false) {
  if (aaState.marketLoading) return aaState.market;
  aaState.marketLoading = true;
  aaState.marketError = null;
  aaState.marketProgress = { page: 0, maxPages: null, ordersSoFar: 0, message: 'Connecting…' };
  refreshAllMarketViews();

  try {
    const url = `${API}/api/aa/market/stream${refresh ? '?refresh=true' : ''}`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      aaState.marketError = `HTTP ${res.status}: ${body.slice(0, 200)}`;
      aaState.market = null;
      return aaState.market;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        if (evt.event === 'progress') {
          aaState.marketProgress = {
            page: evt.page || 0,
            maxPages: evt.max_pages ?? null,
            ordersSoFar: evt.orders_so_far || 0,
            message: evt.message || '',
          };
          refreshAllMarketViews();
        } else if (evt.event === 'done') {
          aaState.market = evt.payload;
        } else if (evt.event === 'error') {
          aaState.marketError = evt.message || 'unknown error';
        }
      }
    }
  } catch (e) {
    aaState.marketError = String(e.message || e);
    aaState.market = null;
  } finally {
    aaState.marketLoading = false;
    aaState.marketProgress = null;
    refreshAllMarketViews();
  }
  return aaState.market;
}

function renderMarketProgress() {
  const p = aaState.marketProgress;
  if (!p) return '';
  const known = p.maxPages != null && p.maxPages > 0;
  const pct = known ? Math.min(100, Math.round((p.page / p.maxPages) * 100)) : null;
  const bar = known
    ? `<div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>`
    : `<div class="progress-bar indeterminate"><div class="progress-fill"></div></div>`;
  const label = known
    ? `Fetching market: page ${p.page}/${p.maxPages} · ${p.ordersSoFar.toLocaleString()} orders so far`
    : `Fetching market: ${escapeHtml(p.message || 'connecting…')}`;
  return `<div class="market-progress">${bar}<div class="muted small">${label}</div></div>`;
}

function formatIsk(n) {
  if (n == null) return '';
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return n.toFixed(0);
}

function computeFitAvailability(fitItems, market) {
  if (!market || !market.by_type) return null;
  const byType = market.by_type;
  const itemsWithAvailability = fitItems.map((it) => {
    if (it.typeId == null) return { ...it, availability: 'unknown' };
    const entry = byType[String(it.typeId)] || byType[it.typeId];
    if (!entry) return { ...it, availability: 'missing', marketEntry: null };
    return { ...it, availability: 'available', marketEntry: entry };
  });
  const known = itemsWithAvailability.filter((it) => it.availability !== 'unknown');
  const available = known.filter((it) => it.availability === 'available').length;
  const missing = known.filter((it) => it.availability === 'missing').length;
  const unknown = itemsWithAvailability.length - known.length;
  const pct = known.length ? Math.round((available / known.length) * 100) : 0;
  return { items: itemsWithAvailability, available, missing, unknown, total: known.length, pct };
}

function parseDoctrinesHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const rows = doc.querySelectorAll('#docTable tbody tr');
  const out = [];
  rows.forEach((tr) => {
    const tds = tr.querySelectorAll(':scope > td');
    if (tds.length < 4) return;
    const nameLink = tds[0].querySelector('a[href*="/fittings/doctrine/"]');
    const icon = tds[0].querySelector('img');
    const m = nameLink ? /\/fittings\/doctrine\/(\d+)\//.exec(nameLink.getAttribute('href') || '') : null;
    const id = m ? parseInt(m[1], 10) : null;
    const name = (nameLink ? nameLink.textContent : '').trim().replace(/\s+/g, ' ');
    const iconUrl = icon ? icon.getAttribute('src') : null;
    const catEl = tds[1].querySelector('a[href*="/fittings/cat/"]');
    const category = catEl ? catEl.textContent.trim() : '';
    const description = (tds[2].textContent || '').trim();
    const seen = new Set();
    const ships = [];
    tds[3].querySelectorAll('img[alt]').forEach((img) => {
      const alt = (img.getAttribute('alt') || '').trim();
      if (alt && !seen.has(alt)) { seen.add(alt); ships.push(alt); }
    });
    out.push({ id, name, iconUrl, category, description, ships });
  });
  return out;
}

function parseDoctrineDetail(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const headerCard = doc.querySelector('.col-md-3 .card-body') || doc.querySelector('.card-body');
  const headerImg = headerCard?.querySelector('img');
  const iconUrl = headerImg?.getAttribute('src') || null;
  const name = (headerImg?.getAttribute('alt') || '').trim();
  const catEl = headerCard?.querySelector('a[href*="/fittings/cat/"]');
  const category = catEl ? catEl.textContent.trim() : '';
  const fits = [];
  doc.querySelectorAll('#fitTable tbody tr').forEach((tr) => {
    const tds = tr.querySelectorAll(':scope > td');
    if (tds.length < 4) return;
    const link = tds[0].querySelector('a[href*="/fittings/fit/"]');
    const m = link ? /\/fittings\/fit\/(\d+)\//.exec(link.getAttribute('href') || '') : null;
    const id = m ? parseInt(m[1], 10) : null;
    const icon = tds[0].querySelector('img');
    const lastSpan = link?.querySelectorAll('span') ? link.querySelectorAll('span')[link.querySelectorAll('span').length - 1] : null;
    const fitName = (lastSpan?.textContent || link?.textContent || '').trim().replace(/\s+/g, ' ');
    const fitIconUrl = icon?.getAttribute('src') || null;
    const shipType = (tds[1].textContent || '').trim();
    const fitCatEl = tds[2].querySelector('a[href*="/fittings/cat/"]');
    const fitCategory = fitCatEl ? fitCatEl.textContent.trim() : '';
    const description = (tds[3].textContent || '').trim();
    fits.push({ id, name: fitName, iconUrl: fitIconUrl, shipType, category: fitCategory, description });
  });
  return { name, iconUrl, category, fits };
}

function parseFitDetail(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const nameEl = doc.querySelector('h3');
  const name = (nameEl?.textContent || '').trim().replace(/\s+/g, ' ');

  const hullImg = doc.querySelector('#bigship img');
  const hullName = (hullImg?.getAttribute('alt') || '').trim();
  const hullTypeId = extractTypeId(hullImg?.getAttribute('src'));

  const doctrines = [];
  doc.querySelectorAll('dl dd a[href*="/fittings/doctrine/"]').forEach((a) => {
    const m = /\/fittings\/doctrine\/(\d+)\//.exec(a.getAttribute('href') || '');
    if (m) doctrines.push({ id: parseInt(m[1], 10), name: a.textContent.trim() });
  });

  const slotModules = [];
  doc.querySelectorAll('.fitting-item img').forEach((img) => {
    const moduleName = (img.getAttribute('alt') || '').trim();
    const typeId = extractTypeId(img.getAttribute('src'));
    const slotId = img.closest('.fitting-item')?.id || '';
    slotModules.push({ name: moduleName, typeId, slotId });
  });

  const nameTypeId = {};
  if (hullName && hullTypeId) nameTypeId[hullName] = hullTypeId;
  doc.querySelectorAll('img[alt]').forEach((img) => {
    const src = img.getAttribute('src') || '';
    const alt = (img.getAttribute('alt') || '').trim();
    const tid = extractTypeId(src);
    if (alt && tid && !nameTypeId[alt]) nameTypeId[alt] = tid;
  });

  const buyBtn = doc.querySelector('#buyAllButton');
  const buyText = buyBtn?.getAttribute('data-clipboard-text') || '';
  const items = [];
  buyText.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const m = /^(.+?)\s+x(\d+)\s*$/.exec(trimmed);
    if (!m) return;
    items.push({ name: m[1].trim(), qty: parseInt(m[2], 10), typeId: nameTypeId[m[1].trim()] || null });
  });

  const eftEl = doc.querySelector('#eft-fitting');
  const eft = (eftEl?.value ?? eftEl?.textContent ?? '').trim();

  return { name, hullName, hullTypeId, doctrines, slotModules, items, eft };
}

function renderDoctrines(list) {
  const container = $('#doctrines-list');
  if (!container) return;
  if (!list.length) { container.innerHTML = '<p class="muted">No doctrines parsed from response.</p>'; return; }
  container.innerHTML = list.map((d) => `
    <div class="doctrine-card" data-doctrine-id="${d.id}" role="button" tabindex="0">
      <div class="doctrine-header">
        ${d.iconUrl ? `<img class="doctrine-icon" src="${escapeHtml(d.iconUrl)}" alt="">` : ''}
        <div class="doctrine-title">
          <h3>${escapeHtml(d.name)}</h3>
          ${d.category ? `<span class="doctrine-cat">${escapeHtml(d.category)}</span>` : ''}
        </div>
      </div>
      ${d.description ? `<p class="muted doctrine-desc">${escapeHtml(d.description)}</p>` : ''}
      ${d.ships.length ? `<div class="doctrine-ships">${d.ships.map((s) => `<span class="doctrine-ship">${escapeHtml(s)}</span>`).join('')}</div>` : ''}
    </div>
  `).join('');
}

function renderDoctrineDetail(d) {
  const container = $('#doctrines-list');
  if (!container || !d) return;
  container.innerHTML = `
    <div class="aa-breadcrumb">
      <button class="link-btn" data-back="list">← All doctrines</button>
    </div>
    <div class="doctrine-detail">
      <div class="doctrine-detail-header">
        ${d.iconUrl ? `<img class="doctrine-icon-lg" src="${escapeHtml(d.iconUrl)}" alt="">` : ''}
        <div>
          <h3>${escapeHtml(d.name)}</h3>
          ${d.category ? `<span class="doctrine-cat">${escapeHtml(d.category)}</span>` : ''}
        </div>
      </div>
      <h4>Fits (${d.fits.length})</h4>
      <div class="fits-list">
        ${d.fits.map((f) => `
          <div class="fit-card" data-fit-id="${f.id}" role="button" tabindex="0">
            ${f.iconUrl ? `<img src="${escapeHtml(f.iconUrl)}" alt="">` : ''}
            <div class="fit-card-body">
              <div class="fit-name">${escapeHtml(f.name) || '(unnamed)'}</div>
              <div class="muted small">${escapeHtml(f.shipType || '')}${f.category ? ` · ${escapeHtml(f.category)}` : ''}</div>
              ${f.description ? `<div class="muted small fit-desc">${escapeHtml(f.description)}</div>` : ''}
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderFitDetail(f) {
  const container = $('#doctrines-list');
  if (!container || !f) return;
  const backTarget = aaState.doctrineDetail ? 'doctrine' : 'list';
  const backLabel = aaState.doctrineDetail ? `← Back to ${aaState.doctrineDetail.name}` : '← All doctrines';
  const unknownCount = f.items.filter((it) => !it.typeId).length;

  const avail = computeFitAvailability(f.items, aaState.market);
  const itemsForRender = avail ? avail.items : f.items.map((it) => ({ ...it, availability: 'pending' }));

  let marketBlock = '';
  if (aaState.marketLoading) {
    marketBlock = `<div class="market-status">${renderMarketProgress()}</div>`;
  } else if (aaState.marketError) {
    marketBlock = `<div class="market-status error">Market fetch failed: ${escapeHtml(aaState.marketError)} <button class="link-btn" data-market-refresh="1">retry</button></div>`;
  } else if (avail) {
    const barClass = avail.pct >= 90 ? 'good' : avail.pct >= 60 ? 'warn' : 'bad';
    const ts = aaState.market?.fetched_at ? new Date(aaState.market.fetched_at * 1000).toLocaleTimeString() : '';
    marketBlock = `
      <div class="market-status">
        <div class="completeness">
          <div class="completeness-bar ${barClass}"><div class="completeness-fill" style="width:${avail.pct}%"></div></div>
          <div class="completeness-label">${avail.available} / ${avail.total} available (${avail.pct}%)${avail.missing ? ` · <span class="bad-text">${avail.missing} missing</span>` : ''}${avail.unknown ? ` · ${avail.unknown} unknown type` : ''}</div>
        </div>
        <div class="muted small">Market: structure ${aaState.market.structure_id} · ${aaState.market.order_count} orders · cached ${ts} <button class="link-btn" data-market-refresh="1">refresh</button></div>
      </div>
    `;
  }

  const missingItems = avail ? avail.items.filter((it) => it.availability === 'missing') : [];
  let missingBlock = '';
  if (missingItems.length) {
    missingBlock = `
      <details class="missing-block" open>
        <summary><strong>Missing from market (${missingItems.length})</strong></summary>
        <ul class="missing-list">
          ${missingItems.map((it) => `<li>${escapeHtml(it.name)} ${it.qty > 1 ? `<span class="muted">×${it.qty}</span>` : ''}</li>`).join('')}
        </ul>
      </details>
    `;
  }

  container.innerHTML = `
    <div class="aa-breadcrumb">
      <button class="link-btn" data-back="${backTarget}">${escapeHtml(backLabel)}</button>
    </div>
    <div class="fit-detail">
      <div class="fit-detail-header">
        <h3>${escapeHtml(f.name)}</h3>
        <div class="muted">Hull: <strong>${escapeHtml(f.hullName)}</strong>${f.hullTypeId ? ` <span class="type-id">type ${f.hullTypeId}</span>` : ''}</div>
        ${f.doctrines.length ? `<div class="muted small">In doctrines: ${f.doctrines.map((dd) => `<a href="#" class="link-btn" data-open-doctrine="${dd.id}">${escapeHtml(dd.name)}</a>`).join(', ')}</div>` : ''}
      </div>
      ${marketBlock}
      ${missingBlock}
      <div class="fit-items-section">
        <h4>Items (${f.items.length})${unknownCount ? ` <span class="muted small">— ${unknownCount} without type_id</span>` : ''}</h4>
        <table class="fit-items">
          <thead><tr><th>Item</th><th class="right">Qty</th><th class="right">Type ID</th><th>Market</th><th class="right">Min sell</th><th class="right">Units</th></tr></thead>
          <tbody>
            ${itemsForRender.map((it) => {
              const cls = it.availability === 'missing' ? 'avail-missing' : it.availability === 'available' ? 'avail-ok' : it.availability === 'unknown' ? 'avail-unknown' : '';
              const badge = it.availability === 'available' ? '<span class="avail-badge ok">✓</span>'
                : it.availability === 'missing' ? '<span class="avail-badge bad">✗ missing</span>'
                : it.availability === 'unknown' ? '<span class="avail-badge unk">? no type_id</span>'
                : '<span class="muted">—</span>';
              const minPrice = it.marketEntry?.min_price != null ? formatIsk(it.marketEntry.min_price) : '';
              const units = it.marketEntry?.total_volume != null ? it.marketEntry.total_volume.toLocaleString() : '';
              return `
                <tr class="${cls}">
                  <td>${escapeHtml(it.name)}</td>
                  <td class="right">${it.qty}</td>
                  <td class="right">${it.typeId != null ? it.typeId : '<span class="muted">?</span>'}</td>
                  <td>${badge}</td>
                  <td class="right">${minPrice}</td>
                  <td class="right">${units}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
      ${f.eft ? `<details class="eft-block"><summary>EFT</summary><pre>${escapeHtml(f.eft)}</pre></details>` : ''}
    </div>
  `;
}

function renderAaView() {
  if (aaState.view === 'list') renderDoctrines(aaState.doctrines);
  else if (aaState.view === 'doctrine') renderDoctrineDetail(aaState.doctrineDetail);
  else if (aaState.view === 'fit') renderFitDetail(aaState.fitDetail);
}

async function refreshDoctrines() {
  const status = $('#aa-status');
  if (!window.api || typeof window.api.aaFetchHtml !== 'function') {
    if (status) status.textContent = 'aaFetchHtml not available.';
    return;
  }
  if (status) status.textContent = 'Fetching…';
  const res = await window.api.aaFetchHtml('/fittings/');
  if (!res.ok) {
    if (status) status.textContent = `Fetch failed (status ${res.status || 'network error'}${res.error ? `: ${res.error}` : ''}).`;
    return;
  }
  if (/\/account\/login\//.test(res.finalUrl) || /Login with Eve SSO/i.test(res.html)) {
    if (status) status.textContent = 'Not signed in. Click "Sign in to Alliance Auth".';
    return;
  }
  const list = parseDoctrinesHtml(res.html);
  aaState.doctrines = list;
  aaState.view = 'list';
  aaState.doctrineDetail = null;
  aaState.fitDetail = null;
  if (status) status.textContent = `${list.length} doctrines — refreshed ${new Date().toLocaleTimeString()}`;
  renderAaView();
}

async function openDoctrine(id) {
  const status = $('#aa-status');
  if (status) status.textContent = `Loading doctrine ${id}…`;
  const res = await window.api.aaFetchHtml(`/fittings/doctrine/${id}/`);
  if (!res.ok || /\/account\/login\//.test(res.finalUrl)) {
    if (status) status.textContent = `Doctrine fetch failed (status ${res.status || 'network error'}).`;
    return;
  }
  const detail = parseDoctrineDetail(res.html);
  aaState.view = 'doctrine';
  aaState.doctrineId = id;
  aaState.doctrineDetail = detail;
  aaState.fitDetail = null;
  if (status) status.textContent = `${detail.name} — ${detail.fits.length} fits`;
  renderAaView();
}

async function openFit(id) {
  const status = $('#aa-status');
  if (status) status.textContent = `Loading fit ${id}…`;
  const res = await window.api.aaFetchHtml(`/fittings/fit/${id}/`);
  if (!res.ok || /\/account\/login\//.test(res.finalUrl)) {
    if (status) status.textContent = `Fit fetch failed (status ${res.status || 'network error'}).`;
    return;
  }
  const detail = parseFitDetail(res.html);
  aaState.view = 'fit';
  aaState.fitId = id;
  aaState.fitDetail = detail;
  if (status) status.textContent = `Fit: ${detail.name} — ${detail.items.length} items`;
  renderAaView();
  if (!aaState.market && !aaState.marketLoading) loadMarket(false);
}

$('#doctrines-list')?.addEventListener('click', (e) => {
  const back = e.target.closest('[data-back]');
  if (back) {
    const target = back.getAttribute('data-back');
    if (target === 'list') { aaState.view = 'list'; renderAaView(); }
    else if (target === 'doctrine') { aaState.view = 'doctrine'; renderAaView(); }
    return;
  }
  const fitBtn = e.target.closest('[data-fit-id]');
  if (fitBtn) {
    openFit(parseInt(fitBtn.getAttribute('data-fit-id'), 10));
    return;
  }
  const docLink = e.target.closest('[data-open-doctrine]');
  if (docLink) {
    e.preventDefault();
    openDoctrine(parseInt(docLink.getAttribute('data-open-doctrine'), 10));
    return;
  }
  const card = e.target.closest('.doctrine-card[data-doctrine-id]');
  if (card) {
    openDoctrine(parseInt(card.getAttribute('data-doctrine-id'), 10));
    return;
  }
  const marketRefresh = e.target.closest('[data-market-refresh]');
  if (marketRefresh) {
    loadMarket(true);
  }
});

const btnAaRefresh = $('#btn-aa-refresh');
if (btnAaRefresh) btnAaRefresh.addEventListener('click', refreshDoctrines);

function aaGoBack() {
  if (aaState.view === 'fit') {
    aaState.view = aaState.doctrineDetail ? 'doctrine' : 'list';
    renderAaView();
    return true;
  }
  if (aaState.view === 'doctrine') {
    aaState.view = 'list';
    renderAaView();
    return true;
  }
  return false;
}

window.addEventListener('mouseup', (e) => {
  if (e.button !== 3) return;
  if ($('#tab-doctrines')?.classList.contains('active')) {
    if (aaGoBack()) e.preventDefault();
    return;
  }
  if ($('#tab-readiness')?.classList.contains('active')) {
    if (typeof readinessGoBack === 'function' && readinessGoBack()) e.preventDefault();
    return;
  }
});
window.addEventListener('mousedown', (e) => {
  if (e.button !== 3) return;
  if ($('#tab-doctrines')?.classList.contains('active') || $('#tab-readiness')?.classList.contains('active')) {
    e.preventDefault();
  }
});

// ============== Readiness dashboard ==============

const LS_SCAN_KEY = 'aa.scan.v1';
const LS_TOGGLES_KEY = 'aa.toggles.v1';
const READINESS_CONCURRENCY = 4;

const readinessState = {
  scan: null,           // { scannedAt, doctrines: [{id,name,iconUrl,category,fitIds}], fits: {fitId: {id,name,hullName,hullTypeId,category,items,doctrineIds}} }
  scanning: false,
  scanProgress: null,   // { phase, current, total, message }
  scanError: null,
  toggles: { category: { 'Capital Fits': false }, fit: {} },
  settingsOpen: false,
  selection: null,      // null | { type: 'doctrine'|'category', id }
  search: '',
};

function loadReadinessPersistent() {
  try {
    const scan = JSON.parse(localStorage.getItem(LS_SCAN_KEY) || 'null');
    if (scan && scan.fits && scan.doctrines) readinessState.scan = scan;
  } catch (_) {}
  try {
    const t = JSON.parse(localStorage.getItem(LS_TOGGLES_KEY) || 'null');
    if (t && t.category && t.fit) readinessState.toggles = t;
  } catch (_) {}
}
function saveReadinessScan() {
  try { localStorage.setItem(LS_SCAN_KEY, JSON.stringify(readinessState.scan)); } catch (_) {}
}
function saveReadinessToggles() {
  try { localStorage.setItem(LS_TOGGLES_KEY, JSON.stringify(readinessState.toggles)); } catch (_) {}
}
loadReadinessPersistent();

function fitIsEnabled(fit) {
  const ft = readinessState.toggles.fit[fit.id];
  if (ft === true) return true;
  if (ft === false) return false;
  return readinessState.toggles.category[fit.category] !== false;
}

async function fetchAaPath(path) {
  const res = await window.api.aaFetchHtml(path);
  if (!res.ok) throw new Error(`fetch ${path} failed: ${res.status} ${res.error || ''}`);
  if (/\/account\/login\//.test(res.finalUrl) || /Login with Eve SSO/i.test(res.html)) {
    throw new Error('Not signed in to Alliance Auth');
  }
  return res.html;
}

async function scanAllFits() {
  if (readinessState.scanning) return;
  readinessState.scanning = true;
  readinessState.scanError = null;
  readinessState.scanProgress = { phase: 'doctrines-list', current: 0, total: 1, message: 'Fetching doctrines list…' };
  renderReadinessDashboard();

  try {
    const listHtml = await fetchAaPath('/fittings/');
    const doctrines = parseDoctrinesHtml(listHtml);
    readinessState.scanProgress = { phase: 'doctrines', current: 0, total: doctrines.length, message: 'Loading doctrine pages…' };
    renderReadinessDashboard();

    const doctrineRecords = [];
    const fitIdToCategory = new Map();
    const allFitIds = new Set();

    for (let i = 0; i < doctrines.length; i += READINESS_CONCURRENCY) {
      const batch = doctrines.slice(i, i + READINESS_CONCURRENCY);
      await Promise.all(batch.map(async (d) => {
        try {
          const html = await fetchAaPath(`/fittings/doctrine/${d.id}/`);
          const detail = parseDoctrineDetail(html);
          const fitIds = detail.fits.map((f) => f.id).filter((x) => x != null);
          doctrineRecords.push({ id: d.id, name: d.name, iconUrl: d.iconUrl, category: d.category, fitIds });
          for (const fit of detail.fits) {
            if (fit.id != null) {
              allFitIds.add(fit.id);
              if (!fitIdToCategory.has(fit.id)) fitIdToCategory.set(fit.id, fit.category || d.category || '');
            }
          }
        } catch (e) {
          doctrineRecords.push({ id: d.id, name: d.name, iconUrl: d.iconUrl, category: d.category, fitIds: [], error: String(e.message || e) });
        }
        readinessState.scanProgress.current += 1;
        renderReadinessDashboard();
      }));
    }

    const fitIdArray = Array.from(allFitIds);
    readinessState.scanProgress = { phase: 'fits', current: 0, total: fitIdArray.length, message: 'Loading fit pages…' };
    renderReadinessDashboard();

    const fits = {};
    for (let i = 0; i < fitIdArray.length; i += READINESS_CONCURRENCY) {
      const batch = fitIdArray.slice(i, i + READINESS_CONCURRENCY);
      await Promise.all(batch.map(async (fitId) => {
        try {
          const html = await fetchAaPath(`/fittings/fit/${fitId}/`);
          const detail = parseFitDetail(html);
          fits[fitId] = {
            id: fitId,
            name: detail.name,
            hullName: detail.hullName,
            hullTypeId: detail.hullTypeId,
            category: fitIdToCategory.get(fitId) || '',
            items: detail.items,
            doctrineIds: detail.doctrines.map((d) => d.id),
          };
        } catch (e) {
          fits[fitId] = { id: fitId, error: String(e.message || e), items: [], category: fitIdToCategory.get(fitId) || '' };
        }
        readinessState.scanProgress.current += 1;
        if (readinessState.scanProgress.current % 3 === 0 || readinessState.scanProgress.current === fitIdArray.length) {
          renderReadinessDashboard();
        }
      }));
    }

    readinessState.scan = {
      scannedAt: Date.now(),
      doctrines: doctrineRecords,
      fits,
    };
    saveReadinessScan();
    readinessState.scanProgress = null;
    if (!aaState.market && !aaState.marketLoading) loadMarket(false);
  } catch (e) {
    readinessState.scanError = String(e.message || e);
    readinessState.scanProgress = null;
  } finally {
    readinessState.scanning = false;
    renderReadinessDashboard();
  }
}

function aggregateMissingFiltered(scan, market, filterFn) {
  if (!scan || !market || !market.by_type) return null;
  const byType = market.by_type;
  const result = new Map();
  let totalItemSlots = 0;
  let availableSlots = 0;
  let unknownSlots = 0;
  let fitsConsidered = 0;

  for (const f of Object.values(scan.fits)) {
    if (f.error || !f.items) continue;
    if (!filterFn(f)) continue;
    fitsConsidered += 1;
    for (const it of f.items) {
      totalItemSlots += 1;
      if (it.typeId == null) {
        unknownSlots += 1;
        const key = `?${it.name}`;
        if (!result.has(key)) result.set(key, { key, typeId: null, name: it.name, totalQty: 0, fitCount: 0, fitIds: [], unknown: true });
        const e = result.get(key);
        e.totalQty += it.qty; e.fitCount += 1; e.fitIds.push(f.id);
        continue;
      }
      const entry = byType[String(it.typeId)] || byType[it.typeId];
      if (entry) { availableSlots += 1; continue; }
      const key = it.typeId;
      if (!result.has(key)) result.set(key, { key, typeId: it.typeId, name: it.name, totalQty: 0, fitCount: 0, fitIds: [], unknown: false });
      const e = result.get(key);
      e.totalQty += it.qty; e.fitCount += 1; e.fitIds.push(f.id);
    }
  }
  const missing = Array.from(result.values()).sort((a, b) => b.totalQty - a.totalQty || a.name.localeCompare(b.name));
  return {
    missing,
    totalItemSlots,
    availableSlots,
    missingSlots: totalItemSlots - availableSlots - unknownSlots,
    unknownSlots,
    fitsConsidered,
    pct: totalItemSlots ? Math.round((availableSlots / (totalItemSlots - unknownSlots || 1)) * 100) : 0,
  };
}

function aggregateMissing(scan, market) {
  return aggregateMissingFiltered(scan, market, fitIsEnabled);
}

function selectionContext() {
  if (!readinessState.scan || !aaState.market) return null;
  const sel = readinessState.selection;
  if (!sel) {
    const agg = aggregateMissing(readinessState.scan, aaState.market);
    return { agg, label: 'All enabled fits', filename: 'all-fits' };
  }
  if (sel.type === 'doctrine') {
    const d = readinessState.scan.doctrines.find((x) => x.id === sel.id);
    if (!d) return null;
    const set = new Set(d.fitIds);
    const agg = aggregateMissingFiltered(readinessState.scan, aaState.market, (f) => fitIsEnabled(f) && set.has(f.id));
    return { agg, label: `Doctrine: ${d.name}`, filename: `doctrine-${slugify(d.name)}`, doctrine: d };
  }
  if (sel.type === 'category') {
    const agg = aggregateMissingFiltered(readinessState.scan, aaState.market, (f) => fitIsEnabled(f) && (f.category || '(uncategorized)') === sel.id);
    return { agg, label: `Category: ${sel.id}`, filename: `category-${slugify(sel.id)}` };
  }
  return null;
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function perFitCompleteness(fit, market) {
  if (fit.error || !fit.items?.length) return null;
  const byType = market?.by_type || {};
  let known = 0, available = 0, unknown = 0;
  for (const it of fit.items) {
    if (it.typeId == null) { unknown += 1; continue; }
    known += 1;
    const entry = byType[String(it.typeId)] || byType[it.typeId];
    if (entry) available += 1;
  }
  const pct = known ? Math.round((available / known) * 100) : 0;
  return { known, available, missing: known - available, unknown, pct };
}

function perDoctrineCompleteness(doctrine, scan, market) {
  let totalSlots = 0, availableSlots = 0, unknownSlots = 0;
  let countedFits = 0, enabledCount = 0;
  for (const fitId of doctrine.fitIds) {
    const f = scan.fits[fitId];
    if (!f || f.error || !f.items?.length) continue;
    if (!fitIsEnabled(f)) continue;
    enabledCount += 1;
    countedFits += 1;
    for (const it of f.items) {
      totalSlots += 1;
      if (it.typeId == null) { unknownSlots += 1; continue; }
      const entry = market.by_type[String(it.typeId)] || market.by_type[it.typeId];
      if (entry) availableSlots += 1;
    }
  }
  const knownSlots = totalSlots - unknownSlots;
  const pct = knownSlots ? Math.round((availableSlots / knownSlots) * 100) : 0;
  return { pct, totalSlots, availableSlots, unknownSlots, enabledCount, countedFits };
}

function exportMultibuy(missing) {
  return missing.filter((m) => !m.unknown).map((m) => `${m.name} x${m.totalQty}`).join('\n');
}

async function copyCurrentMissing() {
  const ctx = selectionContext();
  if (!ctx) return;
  const text = exportMultibuy(ctx.agg.missing);
  if (!text) { flashStatus('readiness-status', `Nothing to copy — no missing items in ${ctx.label}`); return; }
  try {
    await navigator.clipboard.writeText(text);
    flashStatus('readiness-status', `Copied ${ctx.agg.missing.filter((m) => !m.unknown).length} items from ${ctx.label}`);
  } catch (e) {
    flashStatus('readiness-status', `Copy failed: ${e.message || e}`);
  }
}

function downloadCurrentMissing() {
  const ctx = selectionContext();
  if (!ctx) return;
  const text = exportMultibuy(ctx.agg.missing);
  if (!text) { flashStatus('readiness-status', `Nothing to download — no missing items in ${ctx.label}`); return; }
  const header = `# Missing items — ${ctx.label} — ${new Date().toISOString()}\n`;
  const blob = new Blob([header + text + '\n'], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url; a.download = `missing-${ctx.filename}-${ts}.txt`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function flashStatus(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 4000);
}

function renderMissingTable(missing, limit = 100) {
  if (!missing.length) return '<p class="muted">Nothing missing — market fully covers this scope.</p>';
  const preview = missing.slice(0, limit);
  return `
    <table class="readiness-table missing-table">
      <thead><tr><th>Item</th><th class="right">Total qty</th><th class="right">Fits needing</th><th class="right">Type ID</th></tr></thead>
      <tbody>
        ${preview.map((m) => `
          <tr class="${m.unknown ? 'avail-unknown' : 'avail-missing'}">
            <td>${escapeHtml(m.name)}${m.unknown ? ' <span class="muted small">(no type_id)</span>' : ''}</td>
            <td class="right">${m.totalQty.toLocaleString()}</td>
            <td class="right">${m.fitCount}</td>
            <td class="right">${m.typeId ?? '<span class="muted">?</span>'}</td>
          </tr>
        `).join('')}
        ${missing.length > preview.length ? `<tr><td colspan="4" class="muted small center">… and ${missing.length - preview.length} more (full list is in the export)</td></tr>` : ''}
      </tbody>
    </table>
  `;
}

function renderExportActions() {
  return `
    <div class="actions">
      <button data-export="copy">Copy missing</button>
      <button data-export="txt" class="secondary">Download .txt</button>
    </div>
  `;
}

function renderReadinessSelection() {
  const ctx = selectionContext();
  if (!ctx) return null;
  const sel = readinessState.selection;
  const { agg, label } = ctx;
  const barClass = agg.pct >= 90 ? 'good' : agg.pct >= 60 ? 'warn' : 'bad';

  let extraBlock = '';
  if (sel.type === 'doctrine' && ctx.doctrine) {
    const fits = ctx.doctrine.fitIds
      .map((id) => readinessState.scan.fits[id])
      .filter((f) => f && !f.error);
    const fitRows = fits.map((f) => {
      const enabled = fitIsEnabled(f);
      const comp = enabled ? perFitCompleteness(f, aaState.market) : null;
      const pct = comp?.pct ?? 0;
      const cls = comp ? (pct >= 90 ? 'good' : pct >= 60 ? 'warn' : 'bad') : 'bad';
      return `
        <tr class="${enabled ? '' : 'disabled-row'}">
          <td>${escapeHtml(f.name || ('fit ' + f.id))} <span class="muted small">${escapeHtml(f.hullName || '')}</span></td>
          <td class="right">${enabled ? comp?.available + '/' + comp?.known : '<span class="muted">disabled</span>'}</td>
          <td>${enabled ? `<div class="mini-bar ${cls}"><div class="mini-bar-fill" style="width:${pct}%"></div></div>` : ''}</td>
          <td class="right"><strong>${enabled ? pct + '%' : '—'}</strong></td>
        </tr>`;
    }).join('');
    extraBlock = `
      <section class="readiness-fits-list">
        <h3>Fits in this doctrine</h3>
        <table class="readiness-table">
          <thead><tr><th>Fit</th><th class="right">Items</th><th>Completeness</th><th class="right">%</th></tr></thead>
          <tbody>${fitRows}</tbody>
        </table>
      </section>
    `;
  }

  if (sel.type === 'category') {
    const fits = Object.values(readinessState.scan.fits)
      .filter((f) => !f.error && (f.category || '(uncategorized)') === sel.id);
    const fitRows = fits.map((f) => {
      const enabled = fitIsEnabled(f);
      const comp = enabled ? perFitCompleteness(f, aaState.market) : null;
      const pct = comp?.pct ?? 0;
      const cls = comp ? (pct >= 90 ? 'good' : pct >= 60 ? 'warn' : 'bad') : 'bad';
      return `
        <tr class="${enabled ? '' : 'disabled-row'}">
          <td>${escapeHtml(f.name || ('fit ' + f.id))} <span class="muted small">${escapeHtml(f.hullName || '')}</span></td>
          <td class="right">${enabled ? comp?.available + '/' + comp?.known : '<span class="muted">disabled</span>'}</td>
          <td>${enabled ? `<div class="mini-bar ${cls}"><div class="mini-bar-fill" style="width:${pct}%"></div></div>` : ''}</td>
          <td class="right"><strong>${enabled ? pct + '%' : '—'}</strong></td>
        </tr>`;
    }).join('');
    extraBlock = `
      <section class="readiness-fits-list">
        <h3>Fits in this category</h3>
        <table class="readiness-table">
          <thead><tr><th>Fit</th><th class="right">Items</th><th>Completeness</th><th class="right">%</th></tr></thead>
          <tbody>${fitRows}</tbody>
        </table>
      </section>
    `;
  }

  return `
    <div class="aa-breadcrumb">
      <button class="link-btn" data-readiness-back="1">← Back to overview</button>
    </div>
    <section class="readiness-overall">
      <h3>${escapeHtml(label)}</h3>
      <div class="completeness">
        <div class="completeness-bar ${barClass}"><div class="completeness-fill" style="width:${agg.pct}%"></div></div>
        <div class="completeness-label">
          <strong>${agg.pct}% available</strong> across ${agg.fitsConsidered} fits ·
          ${agg.availableSlots} / ${agg.totalItemSlots - agg.unknownSlots} items ·
          ${agg.missingSlots ? `<span class="bad-text">${agg.missingSlots} missing slots</span>` : '0 missing'} ·
          ${agg.unknownSlots ? `${agg.unknownSlots} unknown type` : ''}
        </div>
      </div>
    </section>
    ${extraBlock}
    <section class="readiness-missing">
      <div class="readiness-missing-header">
        <h3>Missing from market <span class="muted small">(${agg.missing.length} unique · ${agg.missing.reduce((a, m) => a + m.totalQty, 0).toLocaleString()} units total)</span></h3>
        ${renderExportActions()}
      </div>
      ${renderMissingTable(agg.missing)}
    </section>
  `;
}

function renderReadinessDashboard() {
  const container = $('#readiness-content');
  const statusEl = $('#readiness-status');
  if (!container) return;

  if (readinessState.scanning && readinessState.scanProgress) {
    const p = readinessState.scanProgress;
    const pct = p.total ? Math.round((p.current / p.total) * 100) : 0;
    container.innerHTML = `
      <div class="market-status">
        <div class="completeness">
          <div class="completeness-bar good"><div class="completeness-fill" style="width:${pct}%"></div></div>
          <div class="completeness-label">${escapeHtml(p.message)} — ${p.current}/${p.total}</div>
        </div>
      </div>`;
    if (statusEl) statusEl.textContent = `Scanning…`;
    return;
  }

  if (readinessState.scanError) {
    container.innerHTML = `<div class="market-status error">Scan failed: ${escapeHtml(readinessState.scanError)}</div>`;
    return;
  }

  if (!readinessState.scan) {
    container.innerHTML = `<p class="muted">No scan yet. Click <strong>Scan all fits</strong>. (Make sure you're signed in to Alliance Auth on the Doctrines tab first.)</p>`;
    if (statusEl) statusEl.textContent = '';
    return;
  }

  const scan = readinessState.scan;
  const fitCount = Object.keys(scan.fits).length;
  const enabledCount = Object.values(scan.fits).filter((f) => !f.error && fitIsEnabled(f)).length;
  const errCount = Object.values(scan.fits).filter((f) => f.error).length;
  const scannedAtStr = new Date(scan.scannedAt).toLocaleString();

  if (statusEl) statusEl.textContent = `${scan.doctrines.length} doctrines · ${fitCount} fits (${enabledCount} enabled${errCount ? `, ${errCount} errored` : ''}) · scanned ${scannedAtStr}`;

  if (!aaState.market) {
    if (aaState.marketLoading) {
      container.innerHTML = `<div class="market-status">${renderMarketProgress()}</div>`;
    } else if (aaState.marketError) {
      container.innerHTML = `<div class="market-status error">Market fetch failed: ${escapeHtml(aaState.marketError)} <button class="link-btn" data-market-refresh="1">retry</button></div>`;
    } else {
      container.innerHTML = `<div class="market-status muted">Market not loaded. <button class="link-btn" data-readiness-load-market="1">Load now</button></div>`;
    }
    if (readinessState.settingsOpen) container.insertAdjacentHTML('beforeend', renderReadinessSettings());
    return;
  }

  // If a selection is set, drill into it (instead of showing overview)
  if (readinessState.selection) {
    container.innerHTML = `${renderReadinessSettings()}${renderReadinessSelection() || ''}`;
    return;
  }

  const agg = aggregateMissing(scan, aaState.market);
  const overallClass = agg.pct >= 90 ? 'good' : agg.pct >= 60 ? 'warn' : 'bad';

  // Per-category breakdown
  const byCategory = {};
  for (const f of Object.values(scan.fits)) {
    if (f.error) continue;
    if (!fitIsEnabled(f)) continue;
    const cat = f.category || '(uncategorized)';
    if (!byCategory[cat]) byCategory[cat] = { fits: 0, available: 0, total: 0 };
    byCategory[cat].fits += 1;
    for (const it of f.items) {
      if (it.typeId == null) continue;
      byCategory[cat].total += 1;
      const e = aaState.market.by_type[String(it.typeId)] || aaState.market.by_type[it.typeId];
      if (e) byCategory[cat].available += 1;
    }
  }
  const categoryRows = Object.entries(byCategory)
    .map(([cat, d]) => ({ cat, pct: d.total ? Math.round((d.available / d.total) * 100) : 0, ...d }))
    .sort((a, b) => a.pct - b.pct);

  // Per-doctrine breakdown
  const allDoctrineRows = scan.doctrines.map((d) => ({
    doctrine: d,
    comp: perDoctrineCompleteness(d, scan, aaState.market),
  })).filter((r) => r.comp.enabledCount > 0);

  // Search filter
  const q = readinessState.search.trim().toLowerCase();
  let doctrineRows = allDoctrineRows;
  let matchingFits = [];
  if (q) {
    doctrineRows = allDoctrineRows.filter((r) => {
      if (r.doctrine.name.toLowerCase().includes(q)) return true;
      return r.doctrine.fitIds.some((id) => {
        const f = scan.fits[id];
        return f && (f.name || '').toLowerCase().includes(q);
      });
    });
    const seenFit = new Set();
    for (const r of allDoctrineRows) {
      for (const id of r.doctrine.fitIds) {
        if (seenFit.has(id)) continue;
        const f = scan.fits[id];
        if (!f || f.error) continue;
        if (!(f.name || '').toLowerCase().includes(q) && !(f.hullName || '').toLowerCase().includes(q)) continue;
        const comp = fitIsEnabled(f) ? perFitCompleteness(f, aaState.market) : null;
        matchingFits.push({ fit: f, doctrine: r.doctrine, comp });
        seenFit.add(id);
      }
    }
  }
  doctrineRows = doctrineRows.slice().sort((a, b) => a.comp.pct - b.comp.pct);

  const missingPreview = agg.missing.slice(0, 100);

  container.innerHTML = `
    ${renderReadinessSettings()}

    <section class="readiness-overall">
      <h3>Overall</h3>
      <div class="completeness">
        <div class="completeness-bar ${overallClass}"><div class="completeness-fill" style="width:${agg.pct}%"></div></div>
        <div class="completeness-label">
          <strong>${agg.pct}% available</strong> across ${enabledCount} enabled fits ·
          ${agg.availableSlots} / ${agg.totalItemSlots - agg.unknownSlots} items ·
          ${agg.missingSlots ? `<span class="bad-text">${agg.missingSlots} missing slots</span>` : '0 missing'} ·
          ${agg.unknownSlots ? `${agg.unknownSlots} unknown type` : ''}
        </div>
      </div>
      ${aaState.marketLoading ? renderMarketProgress() : `<div class="muted small">Market: ${aaState.market.order_count} orders at structure ${aaState.market.structure_id} · cached ${new Date(aaState.market.fetched_at * 1000).toLocaleTimeString()} <button class="link-btn" data-market-refresh="1">refresh</button></div>`}
    </section>

    <div class="readiness-grid">
      <section class="readiness-categories">
        <h3>By category <span class="muted small">— click to drill in</span></h3>
        <table class="readiness-table">
          <thead><tr><th>Category</th><th class="right">Fits</th><th>Completeness</th><th class="right">%</th></tr></thead>
          <tbody>
            ${categoryRows.map((r) => `
              <tr data-open-category="${escapeHtml(r.cat)}" role="button">
                <td>${escapeHtml(r.cat)}</td>
                <td class="right">${r.fits}</td>
                <td><div class="mini-bar ${r.pct >= 90 ? 'good' : r.pct >= 60 ? 'warn' : 'bad'}"><div class="mini-bar-fill" style="width:${r.pct}%"></div></div></td>
                <td class="right"><strong>${r.pct}%</strong></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </section>

      <section class="readiness-doctrines">
        <h3>By doctrine <span class="muted small">— click to drill in${q ? ` · filtered by "${escapeHtml(q)}"` : ''}</span></h3>
        <table class="readiness-table">
          <thead><tr><th>Doctrine</th><th class="right">Fits</th><th>Completeness</th><th class="right">%</th></tr></thead>
          <tbody>
            ${doctrineRows.length === 0 ? `<tr><td colspan="4" class="muted center">No doctrine matches "${escapeHtml(q)}"</td></tr>` : doctrineRows.map((r) => `
              <tr data-open-doctrine="${r.doctrine.id}" role="button">
                <td>${escapeHtml(r.doctrine.name)} <span class="muted small">${escapeHtml(r.doctrine.category || '')}</span></td>
                <td class="right">${r.comp.enabledCount}</td>
                <td><div class="mini-bar ${r.comp.pct >= 90 ? 'good' : r.comp.pct >= 60 ? 'warn' : 'bad'}"><div class="mini-bar-fill" style="width:${r.comp.pct}%"></div></div></td>
                <td class="right"><strong>${r.comp.pct}%</strong></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </section>
    </div>

    ${q && matchingFits.length ? `
      <section class="readiness-matching-fits">
        <h3>Matching fits <span class="muted small">(${matchingFits.length})</span></h3>
        <table class="readiness-table">
          <thead><tr><th>Fit</th><th>Doctrine</th><th>Completeness</th><th class="right">%</th></tr></thead>
          <tbody>
            ${matchingFits.map((m) => {
              const pct = m.comp?.pct ?? 0;
              const cls = m.comp ? (pct >= 90 ? 'good' : pct >= 60 ? 'warn' : 'bad') : 'bad';
              return `
                <tr data-open-doctrine="${m.doctrine.id}" role="button">
                  <td>${escapeHtml(m.fit.name || ('fit ' + m.fit.id))} <span class="muted small">${escapeHtml(m.fit.hullName || '')}</span></td>
                  <td>${escapeHtml(m.doctrine.name)}</td>
                  <td>${m.comp ? `<div class="mini-bar ${cls}"><div class="mini-bar-fill" style="width:${pct}%"></div></div>` : '<span class="muted">disabled</span>'}</td>
                  <td class="right"><strong>${m.comp ? pct + '%' : '—'}</strong></td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </section>
    ` : ''}

    <section class="readiness-missing">
      <div class="readiness-missing-header">
        <h3>Aggregate missing items <span class="muted small">(${agg.missing.length} unique · ${agg.missing.reduce((a, m) => a + m.totalQty, 0).toLocaleString()} units total)</span></h3>
        ${renderExportActions()}
      </div>
      ${renderMissingTable(agg.missing)}
    </section>
  `;
}

function renderReadinessSettings() {
  if (!readinessState.settingsOpen) return '';
  if (!readinessState.scan) return '<section class="readiness-settings"><p class="muted">Scan first to populate categories.</p></section>';
  const scan = readinessState.scan;
  // Collect categories
  const catCounts = {};
  for (const f of Object.values(scan.fits)) {
    if (f.error) continue;
    const c = f.category || '(uncategorized)';
    catCounts[c] = (catCounts[c] || 0) + 1;
  }
  const cats = Object.entries(catCounts).sort((a, b) => a[0].localeCompare(b[0]));
  const fitsByCategory = {};
  for (const f of Object.values(scan.fits)) {
    if (f.error) continue;
    const c = f.category || '(uncategorized)';
    (fitsByCategory[c] = fitsByCategory[c] || []).push(f);
  }

  return `
    <section class="readiness-settings">
      <h3>Settings — which fits to include</h3>
      <p class="muted small">Toggle whole categories or individual fits. Disabled fits are skipped in completeness and missing-items aggregation.</p>
      <div class="category-chips">
        ${cats.map(([cat, n]) => {
          const enabled = readinessState.toggles.category[cat] !== false;
          return `<label class="chip ${enabled ? 'on' : 'off'}"><input type="checkbox" data-cat="${escapeHtml(cat)}" ${enabled ? 'checked' : ''}> ${escapeHtml(cat)} <span class="muted">(${n})</span></label>`;
        }).join('')}
      </div>
      <details class="fit-overrides">
        <summary>Per-fit overrides</summary>
        ${cats.map(([cat]) => {
          const fits = (fitsByCategory[cat] || []).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
          return `
            <div class="fit-override-group">
              <strong>${escapeHtml(cat)}</strong>
              <ul>
                ${fits.map((f) => {
                  const enabled = fitIsEnabled(f);
                  const explicit = readinessState.toggles.fit[f.id];
                  return `<li><label><input type="checkbox" data-fit="${f.id}" ${enabled ? 'checked' : ''}> ${escapeHtml(f.name || f.hullName || ('fit ' + f.id))} ${explicit != null ? '<span class="muted small">(override)</span>' : ''}</label></li>`;
                }).join('')}
              </ul>
            </div>
          `;
        }).join('')}
      </details>
    </section>
  `;
}

// Wiring
$('#btn-readiness-scan')?.addEventListener('click', () => { scanAllFits(); });
$('#btn-readiness-refresh-market')?.addEventListener('click', () => { loadMarket(true).then(renderReadinessDashboard); });
$('#btn-readiness-toggle-settings')?.addEventListener('click', () => {
  readinessState.settingsOpen = !readinessState.settingsOpen;
  renderReadinessDashboard();
});

function readinessGoBack() {
  if (readinessState.selection) {
    readinessState.selection = null;
    renderReadinessDashboard();
    return true;
  }
  return false;
}

$('#readiness-content')?.addEventListener('click', (e) => {
  const copyBtn = e.target.closest('[data-export="copy"]');
  if (copyBtn) { copyCurrentMissing(); return; }
  const txtBtn = e.target.closest('[data-export="txt"]');
  if (txtBtn) { downloadCurrentMissing(); return; }
  const backBtn = e.target.closest('[data-readiness-back]');
  if (backBtn) { readinessGoBack(); return; }
  const docRow = e.target.closest('[data-open-doctrine]');
  if (docRow) {
    const id = parseInt(docRow.getAttribute('data-open-doctrine'), 10);
    readinessState.selection = { type: 'doctrine', id };
    renderReadinessDashboard();
    return;
  }
  const catRow = e.target.closest('[data-open-category]');
  if (catRow) {
    const cat = catRow.getAttribute('data-open-category');
    readinessState.selection = { type: 'category', id: cat };
    renderReadinessDashboard();
    return;
  }
  const loadMarketBtn = e.target.closest('[data-readiness-load-market]');
  if (loadMarketBtn) { loadMarket(false).then(renderReadinessDashboard); return; }
  const refreshBtn = e.target.closest('[data-market-refresh]');
  if (refreshBtn) { loadMarket(true).then(renderReadinessDashboard); return; }
});

$('#readiness-search')?.addEventListener('input', (e) => {
  readinessState.search = e.target.value;
  if (e.target.value && readinessState.selection) readinessState.selection = null;
  renderReadinessDashboard();
});
$('#btn-readiness-search-clear')?.addEventListener('click', () => {
  const inp = $('#readiness-search');
  if (inp) inp.value = '';
  readinessState.search = '';
  renderReadinessDashboard();
});

$('#readiness-content')?.addEventListener('change', (e) => {
  const catInput = e.target.closest('input[data-cat]');
  if (catInput) {
    const cat = catInput.getAttribute('data-cat');
    readinessState.toggles.category[cat] = catInput.checked;
    saveReadinessToggles();
    renderReadinessDashboard();
    return;
  }
  const fitInput = e.target.closest('input[data-fit]');
  if (fitInput) {
    const id = parseInt(fitInput.getAttribute('data-fit'), 10);
    const fit = readinessState.scan?.fits?.[id];
    if (!fit) return;
    const catDefault = readinessState.toggles.category[fit.category] !== false;
    if (fitInput.checked === catDefault) delete readinessState.toggles.fit[id];
    else readinessState.toggles.fit[id] = fitInput.checked;
    saveReadinessToggles();
    renderReadinessDashboard();
  }
});

// Hook into tab switching to auto-render dashboard
const _origTabHandlers = document.querySelectorAll('.tab-btn');
_origTabHandlers.forEach((btn) => {
  if (btn.dataset.tab !== 'readiness') return;
  btn.addEventListener('click', () => {
    if (!aaState.market && !aaState.marketLoading) loadMarket(false).then(renderReadinessDashboard);
    renderReadinessDashboard();
  });
});

// Initial render in case the user opens the tab via the default state
renderReadinessDashboard();
