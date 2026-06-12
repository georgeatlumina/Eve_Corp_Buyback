const API = window.api.base;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

(async () => {
  if (!window.api?.getMeta) return;
  try {
    const meta = await window.api.getMeta();
    const vEl = document.getElementById('app-version');
    const aEl = document.getElementById('app-author');
    if (vEl && meta?.version) vEl.textContent = `v${meta.version}`;
    if (aEl && meta?.author) aEl.innerHTML = `by <strong></strong>`;
    if (aEl && meta?.author) aEl.querySelector('strong').textContent = meta.author;
  } catch (_) {}
})();

document.getElementById('btn-check-update')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (btn.disabled || !window.api?.checkForUpdate) return;
  btn.disabled = true;
  btn.classList.add('spinning');
  try {
    await window.api.checkForUpdate();
  } finally {
    btn.classList.remove('spinning');
    btn.disabled = false;
  }
});

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
  if ($('#appraise-market')) fillMarket('#appraise-market', markets, cfg?.janice_market);

  if (!cfg) {
    console.warn('[loadConfig] no config — populating dropdowns only');
    return;
  }

  $('[name=corp_id]').value = cfg.corp_id || '';
  $('[name=janice_api_key]').value = cfg.janice_api_key || '';
  if ($('[name=home_structure_id]')) $('[name=home_structure_id]').value = cfg.home_structure_id || '';
  if ($('[name=home_region_id]')) $('[name=home_region_id]').value = cfg.home_region_id || '';
  renderQuotas(Array.isArray(cfg.quotas) ? cfg.quotas : []);
  if ($('[name=alliance_quota_url]')) {
    $('[name=alliance_quota_url]').value = cfg.alliance_quota_url || '';
  }
  if ($('[name=alliance_quota_auto_sync]')) {
    $('[name=alliance_quota_auto_sync]').checked = !!cfg.alliance_quota_auto_sync;
  }
  if ($('[name=alliance_quota_pat_read]')) {
    $('[name=alliance_quota_pat_read]').value = cfg.alliance_quota_pat_read || '';
  }
  if ($('[name=alliance_quota_pat_write]')) {
    $('[name=alliance_quota_pat_write]').value = cfg.alliance_quota_pat_write || '';
  }
  if ($('[name=alliance_quota_allow_push]')) {
    $('[name=alliance_quota_allow_push]').checked = !!cfg.alliance_quota_allow_push;
  }
  updatePushButtonVisibility();
  renderQuotaSyncStatus(cfg);
  // Kick off the ship-types fetch in the background; the datalist becomes
  // available as soon as it resolves (cached to disk after the first call).
  ensureShipTypes();
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

// Read the live Config form into the payload shape /api/config expects.
// Used by both the Save handler and the whole-config export so an unsaved
// edit (e.g. a freshly-pasted alliance quota URL) still flows into the
// exported file without making the user Save first.
function collectConfigForm() {
  const form = $('#config-form');
  const fd = new FormData(form);
  return {
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
    home_structure_id: parseInt(fd.get('home_structure_id')) || 0,
    home_region_id: parseInt(fd.get('home_region_id')) || 0,
    quotas: collectQuotas(),
    alliance_quota_url: (fd.get('alliance_quota_url') || '').toString().trim(),
    alliance_quota_auto_sync: $('[name=alliance_quota_auto_sync]')?.checked || false,
    alliance_quota_pat_read: (fd.get('alliance_quota_pat_read') || '').toString().trim(),
    alliance_quota_pat_write: (fd.get('alliance_quota_pat_write') || '').toString().trim(),
    alliance_quota_allow_push: $('[name=alliance_quota_allow_push]')?.checked || false,
  };
}

$('#config-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await fetch(`${API}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(collectConfigForm()),
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
    <div class="moon-pin-row">
      <button type="button" class="btn-pin-moon secondary" data-contract-id="${r.contract_id}">📌 Pin to Working</button>
    </div>
    ${buildMailButtonsRow(r, 'moon')}
  `;
  return div;
}

function escapeAttr(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  })[c]);
}

const AUTH_SLOT_LABELS = {
  slot1: 'Slot 1 (primary — wallets, corp contracts, mail)',
  slot2: 'Slot 2 (optional — extra contract visibility)',
  slot3: 'Slot 3 (optional — extra contract visibility)',
};
const AUTH_SLOTS = ['slot1', 'slot2', 'slot3'];

function renderAuthSlot(slot, info) {
  const wrapper = document.createElement('div');
  wrapper.className = 'auth-slot';
  wrapper.dataset.slot = slot;
  const character = info?.character || '(not logged in)';
  const exp = info?.expires_at
    ? `expires ${new Date(info.expires_at * 1000).toLocaleTimeString()}`
    : '';
  const err = info?.error ? `<div class="auth-slot-err">⚠ ${escapeHtml(info.error)}</div>` : '';
  const isAuth = !!info?.authenticated;
  wrapper.innerHTML = `
    <div class="auth-slot-head">
      <strong>${escapeHtml(AUTH_SLOT_LABELS[slot] || slot)}</strong>
      <span class="auth-slot-state ${isAuth ? 'ok' : 'off'}">${isAuth ? 'logged in' : 'logged out'}</span>
    </div>
    <div class="auth-slot-meta">${escapeHtml(character)}${exp ? ` · ${exp}` : ''}</div>
    ${err}
    <div class="actions">
      <button type="button" class="auth-slot-login" data-slot="${slot}">${isAuth ? 'Re-login' : 'Login with EVE Online'}</button>
      ${isAuth ? `<button type="button" class="secondary auth-slot-logout" data-slot="${slot}">Logout</button>` : ''}
    </div>
  `;
  return wrapper;
}

async function refreshAuthStatus() {
  const container = $('#auth-slots');
  if (container) container.innerHTML = '<p class="muted">Checking slots…</p>';
  let slotsInfo = null;
  try {
    const res = await fetch(`${API}/api/auth/slots`);
    if (res.ok) slotsInfo = (await res.json()).slots || [];
  } catch (e) {
    if (container) {
      container.innerHTML = `<p class="muted">Python sidecar not reachable on localhost:8765 (${escapeHtml(String(e))}). See sidecar.log.</p>`;
    }
    if ($('#auth-status')) $('#auth-status').textContent = 'sidecar unreachable';
    return;
  }
  if (container) {
    container.innerHTML = '';
    const bySlot = Object.fromEntries((slotsInfo || []).map((s) => [s.slot, s]));
    for (const slot of AUTH_SLOTS) {
      container.appendChild(renderAuthSlot(slot, bySlot[slot]));
    }
  }
  // Legacy single-status indicator — mirror slot 1 so the rest of the app sees a status.
  const slot1 = (slotsInfo || []).find((s) => s.slot === 'slot1');
  if ($('#auth-status')) {
    if (!slot1 || !slot1.authenticated) {
      $('#auth-status').textContent = slot1?.error
        ? `slot1 error: ${slot1.error}`
        : 'slot1 not authenticated';
    } else {
      const exp = slot1.expires_at ? new Date(slot1.expires_at * 1000).toLocaleTimeString() : '?';
      $('#auth-status').textContent = `slot1 = ${slot1.character} (expires ${exp})`;
    }
  }
}

async function startSlotLogin(slot) {
  const res = await fetch(`${API}/api/auth/login?slot=${encodeURIComponent(slot)}`, { method: 'POST' });
  if (!res.ok) {
    alert(`Login failed: ${await res.text()}`);
    return;
  }
  // Poll for ~3 min — long enough for the SSO round-trip.
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const s = await fetch(`${API}/api/auth/status?slot=${encodeURIComponent(slot)}`);
      if (s.ok) {
        const data = await s.json();
        if (data.authenticated) {
          await refreshAuthStatus();
          return;
        }
      }
    } catch (_) {}
  }
  await refreshAuthStatus();
}

async function logoutSlot(slot) {
  if (!confirm(`Log out ${slot}?`)) return;
  await fetch(`${API}/api/auth/logout?slot=${encodeURIComponent(slot)}`, { method: 'POST' });
  await refreshAuthStatus();
}

document.addEventListener('click', (e) => {
  const loginBtn = e.target.closest('.auth-slot-login');
  if (loginBtn) {
    startSlotLogin(loginBtn.dataset.slot);
    return;
  }
  const logoutBtn = e.target.closest('.auth-slot-logout');
  if (logoutBtn) {
    logoutSlot(logoutBtn.dataset.slot);
  }
});

const refreshStatusBtn = $('#btn-refresh-status');
if (refreshStatusBtn) refreshStatusBtn.addEventListener('click', refreshAuthStatus);

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

loadConfig().then(maybeAutoSyncQuotas);
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

// extractTypeId, parseDoctrinesHtml, parseDoctrineDetail, parseFitDetail,
// fmtIsk, fmtMillions — defined in parse-utils.js loaded before this script.

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

// Primary index: lowercased fit name → Map(shipTypeName → fitId)
// Secondary index: lowercased ship type name → [{fitId, fitName}] for fallback matching
const _fitIndex = new Map();
const _fitIndexByType = new Map();
const _fitDetailCache = new Map();
let _fitIndexBuilding = null;

async function buildFitIndex() {
  if (!window.api?.aaFetchHtml) return;
  const res = await window.api.aaFetchHtml('/fittings/');
  if (!res.ok || /\/account\/login\//.test(res.finalUrl)) return;
  const doctrines = parseDoctrinesHtml(res.html);
  await Promise.all(doctrines.map(async (d) => {
    if (!d.id) return;
    const dr = await window.api.aaFetchHtml(`/fittings/doctrine/${d.id}/`);
    if (!dr.ok) return;
    const detail = parseDoctrineDetail(dr.html);
    for (const fit of detail.fits) {
      if (!fit.id || !fit.name) continue;
      const nameLower = fit.name.toLowerCase();
      const typeLower = (fit.shipType || '').toLowerCase();
      // Primary: fit name → ship type → fit ID
      if (!_fitIndex.has(nameLower)) _fitIndex.set(nameLower, new Map());
      _fitIndex.get(nameLower).set(typeLower, fit.id);
      // Secondary: ship type → [{fitId, fitName}]
      if (!_fitIndexByType.has(typeLower)) _fitIndexByType.set(typeLower, []);
      const bucket = _fitIndexByType.get(typeLower);
      if (!bucket.some((e) => e.fitId === fit.id)) bucket.push({ fitId: fit.id, fitName: nameLower });
    }
  }));
}

async function getFitDetail(fitId) {
  if (_fitDetailCache.has(fitId)) return _fitDetailCache.get(fitId);
  const res = await window.api.aaFetchHtml(`/fittings/fit/${fitId}/`);
  if (!res.ok) return null;
  const detail = parseFitDetail(res.html);
  _fitDetailCache.set(fitId, detail);
  return detail;
}

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

// ====================== Contracts page ======================
// Quota editor (spreadsheet-style), region lookup, contracts scan stream,
// quota import/export (CSV + JSON), gap CSV export and shopping list copy.

function quotaRow(q) {
  const tr = document.createElement('tr');
  tr.className = 'quota-row';
  tr.innerHTML = `
    <td><input type="text" class="q-name" value="${escapeAttr(q.name || '')}" placeholder="e.g. Cerberus Shield" /></td>
    <td><input type="text" inputmode="numeric" list="ships-datalist" class="q-tid" value="${q.ship_type_id || ''}" placeholder="type or pick…" /></td>
    <td><input type="text" list="ship-names-datalist" class="q-sname" value="${escapeAttr(q.ship_name || '')}" placeholder="e.g. Cerberus" /></td>
    <td><input type="number" class="q-req" min="0" value="${q.required ?? 0}" /></td>
    <td><input type="text" class="q-title" value="${escapeAttr(q.title_filter || '')}" placeholder="optional" /></td>
    <td><input type="text" inputmode="numeric" class="q-fitid" value="${q.fit_id || ''}" placeholder="e.g. 94" title="Auth fit ID — overrides name lookup; use when the fit isn't in a doctrine" style="width:5em" /></td>
    <td><button type="button" class="q-remove secondary" title="Remove row">✕</button></td>
  `;
  tr.querySelector('.q-remove').addEventListener('click', () => tr.remove());
  return tr;
}

// --- Ship-type dropdown data source ---
let shipTypesCache = null;        // [{type_id, name, group_id, group_name}]
let shipTypesByIdMap = null;      // type_id -> ship
let shipTypesByNameMap = null;    // lowercased name -> ship
let shipTypesLoading = null;

async function ensureShipTypes() {
  if (shipTypesCache) return shipTypesCache;
  if (shipTypesLoading) return shipTypesLoading;
  shipTypesLoading = (async () => {
    try {
      const res = await fetch(`${API}/api/universe/ships`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      shipTypesCache = data.ships || [];
      shipTypesByIdMap = new Map(shipTypesCache.map((s) => [s.type_id, s]));
      shipTypesByNameMap = new Map(shipTypesCache.map((s) => [s.name.toLowerCase(), s]));
      buildShipDatalists(shipTypesCache);
      return shipTypesCache;
    } catch (e) {
      console.warn('[shipTypes] load failed:', e);
      shipTypesCache = [];
      return shipTypesCache;
    } finally {
      shipTypesLoading = null;
    }
  })();
  return shipTypesLoading;
}

function buildShipDatalists(ships) {
  // Two datalists so users can search either by typing in the type_id column
  // (values are type_ids, labelled with ship name) or in the ship-name column
  // (values are ship names). Picking one auto-fills the other column via the
  // delegated change handler below.
  function ensureDl(id) {
    let dl = document.getElementById(id);
    if (!dl) {
      dl = document.createElement('datalist');
      dl.id = id;
      document.body.appendChild(dl);
    }
    dl.innerHTML = '';
    return dl;
  }
  const dlId = ensureDl('ships-datalist');
  const dlName = ensureDl('ship-names-datalist');
  for (const s of ships) {
    const oid = document.createElement('option');
    oid.value = String(s.type_id);
    oid.label = `${s.name} — ${s.group_name}`;
    oid.textContent = s.name;
    dlId.appendChild(oid);

    const oname = document.createElement('option');
    oname.value = s.name;
    oname.label = `${s.type_id} — ${s.group_name}`;
    dlName.appendChild(oname);
  }
}

// Auto-fill the sibling column when a ship is picked (or typed) in either input.
document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (!t || !t.classList) return;
  const row = t.closest && t.closest('tr.quota-row');
  if (!row) return;
  if (t.classList.contains('q-tid')) {
    const tid = parseInt(t.value) || 0;
    if (!tid || !shipTypesByIdMap) return;
    const ship = shipTypesByIdMap.get(tid);
    if (ship) {
      const nameInput = row.querySelector('.q-sname');
      if (nameInput && !nameInput.value.trim()) nameInput.value = ship.name;
    }
  } else if (t.classList.contains('q-sname')) {
    if (!shipTypesByNameMap) return;
    const ship = shipTypesByNameMap.get(t.value.trim().toLowerCase());
    if (ship) {
      const tidInput = row.querySelector('.q-tid');
      if (tidInput && !tidInput.value.trim()) tidInput.value = String(ship.type_id);
    }
  }
});

function renderQuotas(list) {
  const tbody = $('#quotas-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  const rows = (list && list.length) ? list : [{}];
  rows.forEach((q) => tbody.appendChild(quotaRow(q || {})));
}

function collectQuotas() {
  const tbody = $('#quotas-tbody');
  if (!tbody) return [];
  return [...tbody.querySelectorAll('.quota-row')]
    .map((r) => ({
      name: r.querySelector('.q-name').value.trim(),
      ship_type_id: parseInt(r.querySelector('.q-tid').value) || 0,
      ship_name: r.querySelector('.q-sname').value.trim(),
      required: parseInt(r.querySelector('.q-req').value) || 0,
      title_filter: r.querySelector('.q-title').value.trim(),
      fit_id: parseInt(r.querySelector('.q-fitid').value) || 0,
    }))
    .filter((q) => q.ship_type_id || q.name);
}

const addQuotaBtn = $('#btn-add-quota');
if (addQuotaBtn) {
  addQuotaBtn.addEventListener('click', () => {
    $('#quotas-tbody').appendChild(quotaRow({}));
  });
}

// Paste-from-spreadsheet support: if the user pastes multi-line tab-separated
// data into ANY quota input, expand into one row per line, mapping columns
// left-to-right (name, type_id, ship_name, required, title_filter).
$('#quotas-tbody')?.addEventListener('paste', (ev) => {
  const text = ev.clipboardData?.getData('text') || '';
  if (!text.includes('\n') && !text.includes('\t')) return; // single-cell paste — let the browser handle it
  ev.preventDefault();
  const rows = parseDelimited(text);
  if (!rows.length) return;
  const tbody = $('#quotas-tbody');
  const targetRow = ev.target.closest('tr.quota-row');
  // First parsed row replaces the cell-and-rightward of the target row, the rest are appended.
  rows.forEach((cells, i) => {
    if (i === 0 && targetRow) {
      fillQuotaRowFromCells(targetRow, cells, ev.target);
    } else {
      const tr = quotaRow(rowFromCells(cells));
      tbody.appendChild(tr);
    }
  });
});

function rowFromCells(cells) {
  return {
    name: cells[0] || '',
    ship_type_id: parseInt(cells[1]) || 0,
    ship_name: cells[2] || '',
    required: parseInt(cells[3]) || 0,
    title_filter: cells[4] || '',
    fit_id: parseInt(cells[5]) || 0,
  };
}

function fillQuotaRowFromCells(tr, cells, startInput) {
  const fields = ['.q-name', '.q-tid', '.q-sname', '.q-req', '.q-title', '.q-fitid'];
  // Find the index of the input the user pasted into.
  const startIdx = Math.max(0, fields.findIndex((sel) => tr.querySelector(sel) === startInput));
  for (let i = 0; i < cells.length; i++) {
    const inp = tr.querySelector(fields[startIdx + i]);
    if (!inp) break;
    inp.value = cells[i];
  }
}

function parseDelimited(text) {
  // Auto-detect tab vs comma. Each line -> array of cells. Ignores blank lines.
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.length);
  if (!lines.length) return [];
  const sep = lines[0].includes('\t') ? '\t' : ',';
  return lines.map((line) => parseCsvLine(line, sep));
}

function parseCsvLine(line, sep) {
  // Minimal CSV parser: handles double-quoted cells with embedded separators.
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { cur += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === sep) { out.push(cur); cur = ''; }
      else { cur += ch; }
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

function csvEscape(v) {
  const s = String(v ?? '');
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function quotasToCsv(quotas) {
  const header = ['name', 'ship_type_id', 'ship_name', 'required', 'title_filter', 'fit_id'];
  const lines = [header.join(',')];
  for (const q of quotas) {
    lines.push([q.name, q.ship_type_id, q.ship_name, q.required, q.title_filter, q.fit_id || ''].map(csvEscape).join(','));
  }
  return lines.join('\n') + '\n';
}

function quotasFromCsvText(text) {
  const rows = parseDelimited(text);
  if (!rows.length) return [];
  // Detect header row (any non-numeric ship_type_id in column 2).
  const first = rows[0];
  const hasHeader = first.some((c) => /^[a-zA-Z_]/.test(c)) && isNaN(parseInt(first[1]));
  const dataRows = hasHeader ? rows.slice(1) : rows;
  return dataRows.map(rowFromCells).filter((q) => q.ship_type_id || q.name);
}

function setQuotaIoStatus(msg) {
  const el = $('#quota-io-status');
  if (el) {
    el.textContent = msg;
    setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 3000);
  }
}

function downloadBlob(filename, mime, content) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('#btn-quota-export-csv')?.addEventListener('click', () => {
  const data = collectQuotas();
  downloadBlob('quotas.csv', 'text/csv', quotasToCsv(data));
  setQuotaIoStatus(`Exported ${data.length} rows as CSV.`);
});

$('#btn-quota-export-json')?.addEventListener('click', () => {
  const data = collectQuotas();
  downloadBlob('quotas.json', 'application/json', JSON.stringify(data, null, 2));
  setQuotaIoStatus(`Exported ${data.length} rows as JSON.`);
});

let _quotaImportMode = 'csv';
$('#btn-quota-import-csv')?.addEventListener('click', () => {
  _quotaImportMode = 'csv';
  $('#quota-import-file').click();
});
$('#btn-quota-import-json')?.addEventListener('click', () => {
  _quotaImportMode = 'json';
  $('#quota-import-file').click();
});

$('#quota-import-file')?.addEventListener('change', async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  ev.target.value = '';
  try {
    const text = await file.text();
    const mode = (_quotaImportMode === 'json' || file.name.toLowerCase().endsWith('.json'))
      ? 'json' : 'csv';
    let imported;
    if (mode === 'json') {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error('JSON root must be an array');
      imported = parsed.map((q) => ({
        name: String(q.name || ''),
        ship_type_id: parseInt(q.ship_type_id) || 0,
        ship_name: String(q.ship_name || ''),
        required: parseInt(q.required) || 0,
        title_filter: String(q.title_filter || ''),
      }));
    } else {
      imported = quotasFromCsvText(text);
    }
    if (!imported.length) {
      setQuotaIoStatus('No rows parsed from file.');
      return;
    }
    const replace = confirm(
      `Imported ${imported.length} quota rows. OK = replace current list. Cancel = append.`
    );
    const current = replace ? [] : collectQuotas();
    renderQuotas([...current, ...imported]);
    setQuotaIoStatus(`${replace ? 'Replaced with' : 'Appended'} ${imported.length} rows. Click "Save" to persist.`);
  } catch (e) {
    alert(`Import failed: ${e.message || e}`);
  }
});

// --- Whole-config export / import ---
// Exports every saved key on the Config tab (corp ID, structures, refining
// settings, mail presets, home structure, quotas, market hubs). ESI tokens
// are not in config.json so they don't get exported. The Janice API key is
// optional — the user picks at export time. Import does a full REPLACE of
// the keys present in the file (anything missing falls back to defaults via
// the existing _migrate + DEFAULTS merge in python/config.py).

// Keys that should never leave the user's machine in an export. Auth/ESI
// tokens already live elsewhere; sync-state side data (last_synced/_status)
// is per-machine and would be misleading if shared. The admin Write PAT and
// the per-machine allow-push gate are also unconditionally stripped — an
// exported config is a distribution kit, never an admin-credentials
// handover. If you actually need to share write access with another
// admin, do it out-of-band (1Password, GitHub PAT settings) rather than
// stuffing the token into a downloadable JSON file.
const CONFIG_EXPORT_NEVER = new Set([
  'scopes',
  'alliance_quota_last_synced',
  'alliance_quota_last_status',
  'alliance_quota_pat_write',
  'alliance_quota_allow_push',
]);

function setConfigIoStatus(msg) {
  const el = $('#config-io-status');
  if (el) {
    el.textContent = msg;
    setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 4000);
  }
}

$('#btn-export-config')?.addEventListener('click', async () => {
  // Read directly from the live form so unsaved edits (a freshly-pasted
  // alliance quota URL, a toggled auto-sync checkbox, an edited quota row)
  // are captured. No need to Save first.
  const cfg = collectConfigForm();
  // Two sensitive keys are still opt-in at export time — the Janice key and
  // the alliance Read PAT. Both are reasonable to bundle in a distribution
  // kit; both are also reasonable to keep private. The Write PAT and
  // allow-push flag are NEVER exported (see CONFIG_EXPORT_NEVER above) so
  // admin write capability can't leak via a stray exported config file.
  const includeKey = cfg.janice_api_key
    ? confirm('Include the Janice API key in the export?\n\nOK = include (file will contain your private key — fine for personal backup, NOT safe to share).\nCancel = leave it out (recipient will need to enter their own key after import).')
    : false;
  const includeReadPat = cfg.alliance_quota_pat_read
    ? confirm('Include the alliance Read PAT in the export?\n\nOK = include (recipient will be able to sync quotas immediately after import — typical for an alliance-distribution kit).\nCancel = leave it out.')
    : false;

  const out = { ...cfg };
  for (const k of CONFIG_EXPORT_NEVER) delete out[k];
  if (!includeKey) delete out.janice_api_key;
  if (!includeReadPat) delete out.alliance_quota_pat_read;

  // Stamp the export so future imports can recognise / migrate as needed.
  let appVersion = '';
  try { appVersion = (await window.api?.getMeta?.())?.version || ''; } catch (_) {}
  const payload = {
    _meta: {
      exported_at: new Date().toISOString(),
      app_version: appVersion,
      schema: 'eve-corp-buyback-config/1',
    },
    config: out,
  };
  const stamp = new Date().toISOString().slice(0, 10);
  downloadBlob(`eve-corp-buyback-config-${stamp}.json`, 'application/json',
    JSON.stringify(payload, null, 2));
  const inclTags = [];
  if (includeKey) inclTags.push('Janice key');
  if (includeReadPat) inclTags.push('Read PAT');
  setConfigIoStatus(`Exported ${Object.keys(out).length} settings${inclTags.length ? ` (incl. ${inclTags.join(', ')})` : ''}.`);
});

$('#btn-import-config')?.addEventListener('click', () => {
  $('#config-import-file').click();
});

$('#config-import-file')?.addEventListener('change', async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  ev.target.value = '';
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (e) {
    alert(`Import failed: not valid JSON — ${e.message || e}`);
    return;
  }
  // Accept both the wrapped {_meta, config} envelope from our own export and
  // a bare config object (in case a user hand-edits or trims the file).
  const incoming = (parsed && parsed.config && typeof parsed.config === 'object')
    ? parsed.config
    : parsed;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    alert('Import failed: expected a JSON object with config keys.');
    return;
  }
  for (const k of CONFIG_EXPORT_NEVER) delete incoming[k];

  const keyCount = Object.keys(incoming).length;
  if (!keyCount) {
    alert('Import failed: the file contains no recognisable config keys.');
    return;
  }
  const summary = Object.keys(incoming).sort().slice(0, 10).join(', ')
    + (keyCount > 10 ? `, … (+${keyCount - 10} more)` : '');
  if (!confirm(`Import will REPLACE these settings on this machine:\n\n${summary}\n\nContinue?`)) return;

  try {
    const res = await fetch(`${API}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(incoming),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  } catch (e) {
    alert(`Import failed: ${e}`);
    return;
  }
  // Re-pull from the sidecar so the form repopulates with the saved values
  // (defaults filled in for any missing keys via _migrate).
  await loadConfig();
  setConfigIoStatus(`Imported ${keyCount} settings.`);
});

// --- Alliance quota sync ---
// Pull the quota list from a public URL (typically a GitHub gist raw link)
// shared by the alliance admin. Sync runs server-side via /api/quotas/sync
// to dodge renderer CORS surprises. Auto-sync hits the URL once after
// loadConfig() resolves if the flag is set; manual sync is the button.

let allianceQuotaAutoSyncDone = false;

function renderQuotaSyncStatus(cfg) {
  const el = $('#quota-sync-status');
  if (!el) return;
  const last = (cfg.alliance_quota_last_synced || '').trim();
  const status = (cfg.alliance_quota_last_status || '').trim();
  if (!last && !status) {
    el.textContent = '';
    return;
  }
  const lastTxt = last ? new Date(last).toLocaleString() : '?';
  el.textContent = status ? `last sync: ${lastTxt} — ${status}` : `last sync: ${lastTxt}`;
}

async function runQuotaSync({ silent = false } = {}) {
  const btn = $('#btn-quota-sync');
  const status = $('#quota-sync-status');
  // Use the current field value first; saving the form isn't a prerequisite.
  const url = ($('[name=alliance_quota_url]')?.value || '').trim();
  if (!url) {
    if (!silent) {
      if (status) status.textContent = 'enter a URL first';
    }
    return null;
  }
  if (btn) btn.disabled = true;
  if (status && !silent) status.textContent = 'syncing…';
  try {
    const res = await fetch(`${API}/api/quotas/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) {
      const text = await res.text();
      let msg = text;
      try { msg = JSON.parse(text).detail || text; } catch (_) {}
      throw new Error(`HTTP ${res.status}: ${msg}`);
    }
    const data = await res.json();
    const cfg = data.config || {};
    renderQuotas(Array.isArray(data.quotas) ? data.quotas : []);
    renderQuotaSyncStatus(cfg);
    if (status && !silent) {
      status.textContent = `synced — ${(data.quotas || []).length} quota row(s) replaced`;
      setTimeout(() => renderQuotaSyncStatus(cfg), 4000);
    }
    return data.quotas || [];
  } catch (e) {
    if (status) status.textContent = `sync failed: ${e.message || e}`;
    if (!silent) console.error('[quota-sync]', e);
    return null;
  } finally {
    if (btn) btn.disabled = false;
  }
}

$('#btn-quota-sync')?.addEventListener('click', () => runQuotaSync({ silent: false }));

// Push button visibility tracks the "Allow push from this machine" checkbox
// — separate from the existence of a write PAT, so a regular user pasting
// the admin's config (which may contain the write PAT) doesn't get a Push
// button by accident.
function updatePushButtonVisibility() {
  const btn = $('#btn-quota-push');
  if (!btn) return;
  const allow = !!$('[name=alliance_quota_allow_push]')?.checked;
  if (allow) btn.removeAttribute('hidden');
  else btn.setAttribute('hidden', '');
}

$('[name=alliance_quota_allow_push]')?.addEventListener('change', updatePushButtonVisibility);

async function runQuotaPush() {
  const btn = $('#btn-quota-push');
  const status = $('#quota-sync-status');
  // Push uses the current form's URL + the saved write PAT. We collect the
  // form first to send any unsaved URL edit, but the PAT lives only in the
  // saved config — saving the form first is the user's responsibility (the
  // Sync flow has the same contract).
  const url = ($('[name=alliance_quota_url]')?.value || '').trim();
  if (!url) {
    if (status) status.textContent = 'enter a repo URL first';
    return;
  }
  if (!confirm(`Push the current local quotas list to:\n\n${url}\n\nThis overwrites the file in the repo.`)) return;
  if (btn) btn.disabled = true;
  if (status) status.textContent = 'pushing…';
  try {
    const res = await fetch(`${API}/api/quotas/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        quotas: collectQuotas(),
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      let msg = text;
      try { msg = JSON.parse(text).detail || text; } catch (_) {}
      throw new Error(`HTTP ${res.status}: ${msg}`);
    }
    const data = await res.json();
    const cfg = data.config || {};
    renderQuotaSyncStatus(cfg);
    if (status) {
      const short = (data.commit_sha || '').slice(0, 7);
      status.textContent = `pushed ${data.pushed_rows} row(s) — commit ${short || '?'}`;
      if (data.commit_html_url) {
        status.innerHTML = `pushed ${data.pushed_rows} row(s) — <a href="${data.commit_html_url}" target="_blank" rel="noopener">commit ${short || '?'}</a>`;
      }
      setTimeout(() => renderQuotaSyncStatus(cfg), 8000);
    }
  } catch (e) {
    if (status) status.textContent = `push failed: ${e.message || e}`;
    console.error('[quota-push]', e);
  } finally {
    if (btn) btn.disabled = false;
  }
}

$('#btn-quota-push')?.addEventListener('click', runQuotaPush);

async function maybeAutoSyncQuotas() {
  if (allianceQuotaAutoSyncDone) return;
  const auto = $('[name=alliance_quota_auto_sync]')?.checked;
  const url = ($('[name=alliance_quota_url]')?.value || '').trim();
  if (!auto || !url) return;
  allianceQuotaAutoSyncDone = true;
  // Silent so a transient network blip on launch doesn't yank the user's
  // attention; failures still show in the last-sync chip.
  await runQuotaSync({ silent: true });
}

// --- Region lookup helper ---
$('#btn-lookup-region')?.addEventListener('click', async () => {
  const stationId = parseInt($('[name=home_structure_id]').value) || 0;
  const status = $('#region-lookup-status');
  if (!stationId) {
    status.textContent = 'Enter a structure/station ID first.';
    return;
  }
  status.textContent = 'looking up…';
  try {
    const res = await fetch(`${API}/api/region/from-station?station_id=${stationId}`);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    $('[name=home_region_id]').value = data.region_id || '';
    status.textContent = `${data.station_name} · ${data.system_name} · region ${data.region_id}`;
  } catch (e) {
    status.textContent = `lookup failed (NPC stations only) — enter region ID manually`;
  }
});

// --- Contracts scan ---
let lastContractsScan = null;

$('#btn-contracts-scan')?.addEventListener('click', runContractsScan);
$('#btn-contracts-export-csv')?.addEventListener('click', exportGapCsv);
$('#btn-contracts-export-text')?.addEventListener('click', copyShoppingList);

async function runContractsScan() {
  const status = $('#contracts-status');
  const progress = $('#contracts-progress');
  const step = progress.querySelector('.progress-step');
  const fill = progress.querySelector('.progress-fill');
  status.textContent = '';
  progress.hidden = false;
  step.textContent = 'starting…';
  fill.style.width = '5%';
  $('#contracts-quota-dashboard').innerHTML = '';
  $('#contracts-list').innerHTML = '';
  $('#contracts-count').textContent = '0';

  let res;
  try {
    res = await fetch(`${API}/api/contracts/scan`);
  } catch (e) {
    status.textContent = `Network error: ${e}`;
    progress.hidden = true;
    return;
  }
  if (!res.ok) {
    status.textContent = `HTTP ${res.status}: ${await res.text()}`;
    progress.hidden = true;
    return;
  }

  let progressTicks = 0;
  await readNdjson(res, (evt) => {
    if (evt.event === 'progress') {
      progressTicks += 1;
      step.textContent = evt.step || '';
      // Indeterminate-ish: ramp 5%→95% with diminishing returns.
      const pct = Math.min(95, 5 + progressTicks * 3);
      fill.style.width = pct + '%';
    } else if (evt.event === 'error') {
      status.textContent = `Error: ${evt.message}`;
    } else if (evt.event === 'done') {
      lastContractsScan = evt.payload;
      renderContractsDashboard(evt.payload);
      step.textContent = 'done';
      fill.style.width = '100%';
      setTimeout(() => { progress.hidden = true; }, 600);
    }
  });
}

async function readNdjson(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try { onEvent(JSON.parse(line)); } catch (_) {}
    }
  }
  const tail = buf.trim();
  if (tail) {
    try { onEvent(JSON.parse(tail)); } catch (_) {}
  }
}

function renderContractsDashboard(payload) {
  const root = $('#contracts-quota-dashboard');
  root.innerHTML = '';
  const quotas = payload.quotas || [];
  if (!quotas.length) {
    root.innerHTML = '<p class="muted">No quotas configured. Add some in Config.</p>';
  } else {
    for (const q of quotas) {
      root.appendChild(renderQuotaBar(q));
    }
  }

  const list = payload.contracts || [];
  $('#contracts-count').textContent = list.length;
  const listRoot = $('#contracts-list');
  listRoot.innerHTML = '';
  if (!list.length) {
    listRoot.innerHTML = '<p class="muted">No outstanding item-exchange contracts at this station.</p>';
    return;
  }
  for (const c of list) listRoot.appendChild(renderContractRow(c));
}

function renderUnpricedToggle(priceEl, unpriced) {
  const count = unpriced.length;
  const label = document.createElement('span');
  label.className = 'quota-unpriced-toggle';
  label.textContent = `· ${count} item${count !== 1 ? 's' : ''} unpriced`;
  priceEl.appendChild(label);

  const listDiv = document.createElement('div');
  listDiv.className = 'quota-unpriced-list';
  listDiv.hidden = true;

  const copyText = unpriced.map((i) => `${i.name} x${i.qty}`).join('\n');
  const janiceUrl = `https://janice.e-351.com/a/new?market=2&q=${encodeURIComponent(copyText)}`;

  listDiv.innerHTML = unpriced.map((i) =>
    `<div class="quota-unpriced-item">${escapeHtml(i.name)} × ${i.qty}</div>`
  ).join('') + `
    <div class="quota-unpriced-actions">
      <button class="link-btn quota-unpriced-copy">Copy list</button>
      <button class="link-btn quota-unpriced-janice">Open in Janice</button>
    </div>`;

  priceEl.closest('.quota-expand-panel').appendChild(listDiv);

  label.addEventListener('click', (e) => {
    e.stopPropagation();
    listDiv.hidden = !listDiv.hidden;
  });

  listDiv.querySelector('.quota-unpriced-copy').addEventListener('click', (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(copyText);
  });

  listDiv.querySelector('.quota-unpriced-janice').addEventListener('click', (e) => {
    e.stopPropagation();
    if (window.api?.openExternal) window.api.openExternal(janiceUrl);
  });
}

function renderQuotaBar(q) {
  const required = Number(q.required) || 0;
  const available = Number(q.available) || 0;
  const missing = Number(q.missing) || 0;
  const pct = required > 0 ? Math.min(100, Math.round((available / required) * 100)) : 0;
  const state = required === 0 ? 'unset' : available >= required ? 'ok' : available > 0 ? 'partial' : 'empty';
  const div = document.createElement('div');
  div.className = `quota-bar quota-${state}`;
  div.innerHTML = `
    <div class="quota-bar-head">
      <strong>${escapeHtml(q.ship_name || q.name || `type ${q.ship_type_id}`)}</strong>
      <span class="muted">${escapeHtml(q.name || '')}${q.title_filter ? ` · "${escapeHtml(q.title_filter)}"` : ''}</span>
      <span class="quota-counts">${available} / ${required} ${missing ? `· missing ${missing}` : ''}</span>
      <span class="quota-expand-caret">▸</span>
    </div>
    <div class="quota-bar-track"><div class="quota-bar-fill" style="width:${pct}%"></div></div>
    <div class="quota-expand-panel">
      <div class="quota-expand-row">
        <span class="quota-expand-label">Contract price (115% Amarr sell)</span>
        <span class="quota-amarr-price muted">—</span>
      </div>
    </div>
  `;
  // First click: toggle expand panel. Second click on the price row: fetch price.
  div.addEventListener('click', (e) => {
    if (e.target.closest('.quota-expand-panel')) return; // handled separately
    const panel = div.querySelector('.quota-expand-panel');
    const caret = div.querySelector('.quota-expand-caret');
    panel.classList.toggle('open');
    caret.textContent = panel.classList.contains('open') ? '▾' : '▸';
  });

  const expandRow = div.querySelector('.quota-expand-row');
  let priceLoaded = false;
  expandRow.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (priceLoaded) return;
    priceLoaded = true;
    const priceEl = div.querySelector('.quota-amarr-price');
    const labelEl = div.querySelector('.quota-expand-label');
    expandRow.style.cursor = 'default';
    const fmt = fmtIsk;
    const fmtM = fmtMillions;
    try {
      let fitDetail = null;
      if (window.api?.aaFetchHtml && (q.fit_id || q.ship_name || q.name)) {
        priceEl.textContent = 'searching fits…';
        let resolvedFitId = q.fit_id || 0;
        if (!resolvedFitId) {
          if (!_fitIndexBuilding) _fitIndexBuilding = buildFitIndex();
          await _fitIndexBuilding;
          // 1. Try exact fit-name match (q.name = the Auth fit name).
          const shipMap = _fitIndex.get((q.name || '').toLowerCase());
          resolvedFitId = shipMap?.get((q.ship_name || '').toLowerCase())
            ?? (shipMap ? [...shipMap.values()][0] : undefined);
          // 2. Fall back: match by ship type, disambiguating with title_filter.
          //    Handles the common case where q.name is a display label ("Navy Logi Mk2")
          //    rather than the Auth fit name ("Exequror Mk2").
          if (!resolvedFitId && q.ship_name) {
            const bucket = _fitIndexByType.get(q.ship_name.toLowerCase()) || [];
            if (bucket.length === 1) {
              resolvedFitId = bucket[0].fitId;
            } else if (bucket.length > 1 && q.title_filter) {
              const filterLower = q.title_filter.toLowerCase();
              const match = bucket.find((e) => e.fitName.includes(filterLower));
              if (match) resolvedFitId = match.fitId;
            }
          }
        }
        if (resolvedFitId) {
          priceEl.textContent = 'pricing fit…';
          const candidate = await getFitDetail(resolvedFitId);
          // Only use the fit if we can confirm the hull matches the quota's ship.
          // When both type IDs are known and differ, the wrong fit was found (e.g. a
          // Guardian fit returned for an Exequror quota slot).
          const hullMismatch = q.ship_type_id && candidate?.hullTypeId
            && candidate.hullTypeId !== q.ship_type_id;
          if (candidate && !hullMismatch) fitDetail = candidate;
        }
      }

      if (fitDetail?.items?.length) {
        // Price everything in the buy-all list: hull, modules, ammo, scripts, nanite paste
        const pricingItems = fitDetail.items.map((i) => ({ typeId: i.typeId || null, name: i.name, qty: i.qty }));

        const uniqueIds = [...new Set(pricingItems.filter((i) => i.typeId).map((i) => i.typeId))];
        const priceResults = await Promise.all(
          uniqueIds.map((tid) =>
            fetch(`${API}/api/market/amarr-sell?type_id=${tid}`).then((r) => r.json()).catch(() => null)
          )
        );
        const priceMap = new Map();
        priceResults.forEach((p, i) => { if (p?.min_sell != null) priceMap.set(uniqueIds[i], p.min_sell); });

        let total = 0;
        const unpriced = [];
        for (const item of pricingItems) {
          const p = item.typeId ? priceMap.get(item.typeId) : null;
          if (p != null) total += p * item.qty;
          else unpriced.push({ name: item.name, qty: item.qty });
        }

        if (labelEl) labelEl.textContent = 'Contract price (115% Amarr sell · full fit)';
        if (total > 0) {
          priceEl.textContent = `${fmtM(total * 1.15)}  (base: ${fmt(total)})`;
          priceEl.classList.remove('muted');
          if (unpriced.length) renderUnpricedToggle(priceEl, unpriced);
        } else {
          priceEl.textContent = 'no Amarr prices found for fit items';
        }
      } else {
        const notInAuth = _fitIndexByType.size > 0; // index built but this ship isn't in any doctrine
        priceEl.textContent = 'loading…';
        const res = await fetch(`${API}/api/market/amarr-sell?type_id=${q.ship_type_id}`);
        const data = await res.json();
        if (notInAuth) {
          if (labelEl) {
            labelEl.textContent = '⚠ Not in alliance fits — hull price only';
            labelEl.classList.add('quota-not-in-auth');
          }
          expandRow.classList.add('quota-row-warning');
        } else {
          if (labelEl) labelEl.textContent = 'Contract price (115% Amarr sell · hull only)';
        }
        if (data.min_sell != null) {
          priceEl.textContent = `${fmtM(data.min_sell * 1.15)}  (base: ${fmt(data.min_sell)})`;
          priceEl.classList.remove('muted');
        } else {
          priceEl.textContent = 'no sell orders in Amarr';
        }
      }
    } catch {
      priceEl.textContent = 'error fetching price';
    }
  });
  return div;
}

function renderContractRow(c) {
  const div = document.createElement('div');
  div.className = 'contract-row';
  const sources = (c.sources || []).join(', ');
  const items = (c.items || []).filter((i) => i.is_included).slice(0, 12);
  const itemList = items.map((i) =>
    `<li>${escapeHtml(i.name || `type ${i.type_id}`)} × ${i.quantity}</li>`
  ).join('');
  const moreItems = (c.items || []).length > items.length
    ? `<li class="muted">+ ${(c.items || []).length - items.length} more…</li>` : '';
  const itemsErr = c.items_error ? `<div class="muted">items error: ${escapeHtml(c.items_error)}</div>` : '';
  const price = (c.price != null) ? `${Number(c.price).toLocaleString()} ISK` : '—';
  div.innerHTML = `
    <div class="contract-row-head">
      <strong>#${c.contract_id}</strong>
      <span class="muted">${escapeHtml(c.title || '(no title)')}</span>
      <span class="contract-sources">${escapeHtml(sources)}</span>
    </div>
    <div class="muted">Issuer: ${escapeHtml(c.issuer_name || '')} (${c.issuer_id ?? '?'}) · Price: ${price}</div>
    ${itemsErr}
    <ul class="contract-items">${itemList}${moreItems}</ul>
    <div class="contract-value-row">
      <button class="link-btn btn-contract-value">Look up Janice value</button>
      <span class="contract-value-result muted"></span>
    </div>
  `;

  const includedItems = (c.items || []).filter((i) => i.is_included);
  const btn = div.querySelector('.btn-contract-value');
  const resultEl = div.querySelector('.contract-value-result');
  let loaded = false;

  btn.addEventListener('click', async () => {
    if (loaded) return;
    loaded = true;
    btn.disabled = true;
    resultEl.textContent = 'looking up…';
    try {
      const uniqueIds = [...new Set(includedItems.filter((i) => i.type_id).map((i) => i.type_id))];
      const priceResults = await Promise.all(
        uniqueIds.map((tid) =>
          fetch(`${API}/api/market/amarr-sell?type_id=${tid}`).then((r) => r.json()).catch(() => null)
        )
      );
      const priceMap = new Map();
      priceResults.forEach((p, i) => { if (p?.min_sell != null) priceMap.set(uniqueIds[i], p.min_sell); });

      let total = 0;
      const unpriced = [];
      for (const item of includedItems) {
        const p = item.type_id ? priceMap.get(item.type_id) : null;
        if (p != null) total += p * item.quantity;
        else unpriced.push(item);
      }

      if (total === 0) {
        resultEl.textContent = 'no Amarr prices found';
      } else {
        const unpricedText = unpriced.length ? ` · ${unpriced.length} unpriced` : '';
        resultEl.textContent = `Janice: ${fmtMillions(total)}${unpricedText}`;
        resultEl.classList.remove('muted');
      }
    } catch {
      loaded = false;
      btn.disabled = false;
      resultEl.textContent = 'error fetching prices';
    }
  });

  return div;
}

function exportGapCsv() {
  if (!lastContractsScan) {
    alert('Run a scan first.');
    return;
  }
  const rows = [['name', 'ship_name', 'ship_type_id', 'required', 'available', 'missing']];
  for (const q of lastContractsScan.quotas || []) {
    rows.push([
      q.name || '', q.ship_name || '', q.ship_type_id || 0,
      q.required || 0, q.available || 0, q.missing || 0,
    ]);
  }
  const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n') + '\n';
  downloadBlob('quota-gap.csv', 'text/csv', csv);
}

async function copyShoppingList() {
  if (!lastContractsScan) {
    alert('Run a scan first.');
    return;
  }
  const lines = [];
  for (const q of lastContractsScan.quotas || []) {
    const missing = Number(q.missing) || 0;
    if (missing > 0) {
      const name = q.ship_name || q.name || `type ${q.ship_type_id}`;
      lines.push(`${missing} x ${name}`);
    }
  }
  const text = lines.length ? lines.join('\n') : 'No gaps — every quota is met.';
  try {
    await navigator.clipboard.writeText(text);
    $('#contracts-status').textContent = `Copied ${lines.length} lines to clipboard.`;
  } catch (e) {
    alert(text);
  }
}

// ============================================================
// Sov dashboard
// ============================================================

let sovState = { data: null, loading: false, error: null, sort: 'region' };

// sort modes for the sov systems tables
const SOV_SORT_MODES = [
  { id: 'region',         label: 'By region (A→Z)' },
  { id: 'ihub_adm_asc',   label: 'IHUB ADM ↑ (lowest first)' },
  { id: 'ihub_adm_desc',  label: 'IHUB ADM ↓ (highest first)' },
];

function structureAdm(sys_, typeId) {
  const st = (sys_.structures || []).find((x) => x.structure_type_id === typeId);
  return st && typeof st.adm === 'number' ? st.adm : null;
}

function sortAdmCompare(a, b, getter, dir) {
  const av = getter(a);
  const bv = getter(b);
  // Push null/missing to the end regardless of direction.
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  return dir === 'asc' ? av - bv : bv - av;
}

function admClass(adm) {
  if (adm == null) return 'adm-unknown';
  if (adm >= 5) return 'adm-good';
  if (adm >= 3) return 'adm-warn';
  return 'adm-bad';
}

function secClass(sec) {
  if (sec == null) return 'sec-unknown';
  if (sec >= 0.5) return 'sec-hi';
  if (sec > 0.0) return 'sec-lo';
  return 'sec-null';
}

function fmtAdm(adm) {
  return adm == null ? '—' : Number(adm).toFixed(1);
}

function fmtSec(sec) {
  return sec == null ? '—' : Number(sec).toFixed(1);
}

function fmtPct(x) {
  return x == null ? '—' : `${(Number(x) * 100).toFixed(1)}%`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
  } catch (_) { return '—'; }
}

function fmtAge(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diffMs = d.getTime() - Date.now();
  const absMin = Math.abs(diffMs) / 60000;
  if (absMin < 60) return `${Math.round(absMin)} min ${diffMs > 0 ? 'from now' : 'ago'}`;
  const h = absMin / 60;
  if (h < 48) return `${h.toFixed(1)} h ${diffMs > 0 ? 'from now' : 'ago'}`;
  return `${(h / 24).toFixed(1)} d ${diffMs > 0 ? 'from now' : 'ago'}`;
}

async function refreshSov() {
  if (sovState.loading) return;
  sovState.loading = true;
  sovState.error = null;
  $('#sov-status').textContent = 'Loading sov data from ESI…';
  renderSov();
  try {
    const res = await fetch(`${API}/api/sov/overview`);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status} — ${text}`);
    }
    sovState.data = await res.json();
    $('#sov-status').textContent = `Fetched ${fmtDate(new Date(sovState.data.fetched_at * 1000).toISOString())}`;
  } catch (e) {
    sovState.error = String(e.message || e);
    $('#sov-status').textContent = `Error: ${sovState.error}`;
  } finally {
    sovState.loading = false;
    renderSov();
  }
}

function renderSovTotals(d) {
  const t = d.totals || {};
  const corpSummary = [
    `${t.corp_count ?? 0} corp(s)`,
    `${t.alliance_count ?? 0} alliance(s)`,
    t.unaffiliated_corp_count ? `${t.unaffiliated_corp_count} non-alliance` : null,
  ].filter(Boolean).join(' · ');
  const sortOpts = SOV_SORT_MODES.map((m) =>
    `<option value="${m.id}"${m.id === sovState.sort ? ' selected' : ''}>${escapeHtml(m.label)}</option>`
  ).join('');
  return `
    <div class="sov-totals">
      <div class="sov-totals-head">
        <div class="sov-totals-label">Across all your toons — ${corpSummary}</div>
        <label class="sov-sort-label">Sort systems
          <select id="sov-sort-select">${sortOpts}</select>
        </label>
      </div>
      <div class="sov-tiles">
        <div class="sov-tile"><div class="label">Sov systems</div><div class="value">${t.system_count ?? 0}</div></div>
        <div class="sov-tile ${admClass(t.avg_adm)}"><div class="label">Avg ADM</div><div class="value">${fmtAdm(t.avg_adm)}</div></div>
        <div class="sov-tile ${admClass(t.min_adm)}"><div class="label">Min ADM</div><div class="value">${fmtAdm(t.min_adm)}</div></div>
        <div class="sov-tile ${t.active_campaigns ? 'sov-tile-alert' : ''}"><div class="label">Active campaigns</div><div class="value">${t.active_campaigns ?? 0}</div></div>
      </div>
    </div>
  `;
}

function renderSovOwners(owners) {
  const corps = (owners?.corps || []).map((c) => {
    const tagBits = [
      `<strong>${escapeHtml(c.name || '?')}</strong>`,
      `<span class="muted">[${escapeHtml(c.ticker || '?')}]</span>`,
      `<span class="muted">${c.member_count ?? '?'} members · tax ${fmtPct(c.tax_rate)}</span>`,
      c.war_eligible ? '<span class="sov-war-eligible">war-eligible</span>' : '<span class="muted">war-immune</span>',
    ];
    const toonBits = (c.toons || []).map((t) => `<span class="sov-toon-chip">${escapeHtml(t.character_name || t.slot)}</span>`).join('');
    const originBits = (c.origins || []).map((o) => `<span class="sov-origin-chip">${escapeHtml(o)}</span>`).join('');
    return `<div class="sov-owner-corp">
      <div class="sov-owner-line">${tagBits.join(' ')}</div>
      <div class="sov-owner-line">${toonBits}${originBits}</div>
    </div>`;
  }).join('');
  return `<div class="sov-owners">${corps}</div>`;
}

function renderSovCampaigns(camps) {
  if (!camps?.length) return '';
  const rows = camps.map((c) => {
    const sysName = c.solar_system_name ? escapeHtml(c.solar_system_name) : `system ${c.solar_system_id}`;
    const score = (c.defender_score != null && c.attackers_score != null)
      ? `${(c.defender_score * 100).toFixed(0)}% def / ${(c.attackers_score * 100).toFixed(0)}% atk`
      : '—';
    const roleClass = c.role === 'defender' ? 'role-def' : 'role-atk';
    return `<tr>
      <td><span class="sov-role ${roleClass}">${escapeHtml(c.role || '?')}</span></td>
      <td>${escapeHtml(c.event_label || c.event_type || '?')}</td>
      <td>${sysName}</td>
      <td>${score}</td>
      <td>${fmtDate(c.start_time)} <span class="muted">(${escapeHtml(fmtAge(c.start_time))})</span></td>
    </tr>`;
  }).join('');
  return `
    <h4 class="sov-subsection">Active campaigns</h4>
    <table class="sov-table">
      <thead><tr><th>Role</th><th>Event</th><th>System</th><th>Score</th><th>Started</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderSovIncursions(incs) {
  if (!incs?.length) return '';
  const rows = incs.map((i) => `<tr>
    <td>${escapeHtml(i.state || '?')}</td>
    <td>${fmtPct(i.influence)}</td>
    <td>${i.has_boss ? 'yes' : 'no'}</td>
    <td>${(i.overlapping_system_ids || []).length} system(s)</td>
    <td>${i.staging_solar_system_id ?? '—'}</td>
  </tr>`).join('');
  return `
    <h4 class="sov-subsection">Incursions in holdings</h4>
    <table class="sov-table">
      <thead><tr><th>State</th><th>Influence</th><th>Boss</th><th>Overlap</th><th>Staging</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function sovSystemRowHtml(s, includeRegionCol) {
  const ihub = s.structures.find((x) => x.structure_type_id === 32458);
  const ihubCell = ihub
    ? `<span class="adm-pill ${admClass(ihub.adm)}" title="vuln ${fmtDate(ihub.vulnerable_start_time)} → ${fmtDate(ihub.vulnerable_end_time)}">${fmtAdm(ihub.adm)}</span>`
    : '<span class="muted">—</span>';
  const activityHot = (s.ship_kills + s.pod_kills) > 0 ? 'activity-hot' : '';
  const regionCell = includeRegionCol
    ? `<td class="muted">${escapeHtml(s.region_name || '—')}</td>`
    : '';
  return `<tr>
    <td><a href="https://evemaps.dotlan.net/system/${encodeURIComponent(s.system_name || '')}" target="_blank" rel="noopener">${escapeHtml(s.system_name || '?')}</a></td>
    <td><span class="sec-pill ${secClass(s.security_status)}">${fmtSec(s.security_status)}</span></td>
    ${regionCell}
    <td class="muted">${escapeHtml(s.constellation_name || '—')}</td>
    <td>${ihubCell}</td>
    <td class="num ${activityHot}">${s.ship_kills}</td>
    <td class="num">${s.pod_kills}</td>
    <td class="num muted">${s.npc_kills}</td>
    <td class="num muted">${s.ship_jumps}</td>
  </tr>`;
}

function sovSystemsTableHtml(systems, includeRegionCol) {
  const regionTh = includeRegionCol ? '<th>Region</th>' : '';
  const rows = systems.map((s) => sovSystemRowHtml(s, includeRegionCol)).join('');
  return `
    <table class="sov-table sov-systems-table">
      <thead><tr>
        <th>System</th><th>Sec</th>${regionTh}<th>Constellation</th>
        <th title="Infrastructure Hub ADM">IHUB ADM</th>
        <th title="Ship kills last hour" class="num">Ships</th>
        <th title="Pod kills last hour" class="num">Pods</th>
        <th title="NPC kills last hour" class="num">NPC</th>
        <th title="Ship jumps last hour" class="num">Jumps</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderSovSystems(sys) {
  if (!sys?.length) {
    return '<p class="muted">No sov systems for this alliance.</p>';
  }
  const mode = sovState.sort || 'region';

  if (mode === 'region') {
    const byRegion = new Map();
    for (const s of sys) {
      const key = s.region_name || `region ${s.region_id ?? '?'}`;
      if (!byRegion.has(key)) byRegion.set(key, []);
      byRegion.get(key).push(s);
    }
    const regions = [...byRegion.keys()].sort();
    return regions.map((region) => {
      const inRegion = byRegion.get(region)
        .sort((a, b) => (a.system_name || '').localeCompare(b.system_name || ''));
      return `
        <details class="sov-region" open>
          <summary><strong>${escapeHtml(region)}</strong> <span class="muted">(${inRegion.length})</span></summary>
          ${sovSystemsTableHtml(inRegion, false)}
        </details>
      `;
    }).join('');
  }

  // Flat, ADM-sorted view.
  const sortMap = {
    ihub_adm_asc:  { get: (s) => structureAdm(s, 32458), dir: 'asc'  },
    ihub_adm_desc: { get: (s) => structureAdm(s, 32458), dir: 'desc' },
  };
  const spec = sortMap[mode] || sortMap.ihub_adm_asc;
  const sorted = [...sys].sort((a, b) => sortAdmCompare(a, b, spec.get, spec.dir));
  return sovSystemsTableHtml(sorted, true);
}

function renderSovAlliance(a) {
  const al = a.alliance || {};
  const s = a.summary || {};
  const headline = `<strong>${escapeHtml(al.name || '?')}</strong> <span class="muted">[${escapeHtml(al.ticker || '?')}]</span>`;
  const tiles = `
    <div class="sov-tiles">
      <div class="sov-tile"><div class="label">Sov systems</div><div class="value">${s.system_count ?? 0}</div></div>
      <div class="sov-tile"><div class="label">IHUBs</div><div class="value">${s.ihub_count ?? 0}</div></div>
      <div class="sov-tile ${admClass(s.avg_adm)}"><div class="label">Avg ADM</div><div class="value">${fmtAdm(s.avg_adm)}</div></div>
      <div class="sov-tile ${admClass(s.min_adm)}"><div class="label">Min ADM</div><div class="value">${fmtAdm(s.min_adm)}</div></div>
      <div class="sov-tile ${s.active_campaigns ? 'sov-tile-alert' : ''}"><div class="label">Active campaigns</div><div class="value">${s.active_campaigns ?? 0}</div></div>
    </div>
  `;
  return `
    <section class="sov-alliance-block">
      <header class="sov-alliance-head">
        <h3>${headline}</h3>
        ${renderSovOwners(a.owners)}
      </header>
      ${tiles}
      ${renderSovCampaigns(a.campaigns)}
      ${renderSovIncursions(a.incursions)}
      ${renderSovSystems(a.systems)}
    </section>
  `;
}

function renderSovUnaffiliated(corps) {
  if (!corps?.length) return '';
  const rows = corps.map((c) => {
    const toons = (c.toons || []).map((t) => escapeHtml(t.character_name || t.slot)).join(', ');
    return `<tr>
      <td><strong>${escapeHtml(c.name || '?')}</strong> <span class="muted">[${escapeHtml(c.ticker || '?')}]</span></td>
      <td class="num">${c.member_count ?? '?'}</td>
      <td>${fmtPct(c.tax_rate)}</td>
      <td>${c.war_eligible ? '<span class="sov-war-eligible">yes</span>' : 'no'}</td>
      <td class="muted">${toons || '—'}</td>
    </tr>`;
  }).join('');
  return `
    <section class="sov-alliance-block">
      <header class="sov-alliance-head"><h3>Non-alliance corps</h3></header>
      <p class="muted">These corps aren't in an alliance, so they hold no sov. Listed here because at least one toon is in them.</p>
      <table class="sov-table">
        <thead><tr><th>Corp</th><th class="num">Members</th><th>Tax</th><th>War-eligible</th><th>Toons</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
  `;
}

function renderSov() {
  const container = $('#sov-content');
  if (!container) return;
  if (sovState.loading && !sovState.data) {
    container.innerHTML = '<p class="muted">Loading…</p>';
    return;
  }
  if (sovState.error && !sovState.data) {
    container.innerHTML = `<p class="muted">Failed to load: ${escapeHtml(sovState.error)}</p>`;
    return;
  }
  const d = sovState.data;
  if (!d) {
    container.innerHTML = '<p class="muted">Click <em>Refresh</em> to load the sov overview.</p>';
    return;
  }
  const parts = [renderSovTotals(d)];
  if (d.auth_errors?.length) {
    const items = d.auth_errors.map((e) => `<li>${escapeHtml(e.slot)}: ${escapeHtml(e.error)}</li>`).join('');
    parts.push(`<details class="sov-auth-errors"><summary class="muted">Some auth slots couldn't be resolved (${d.auth_errors.length})</summary><ul>${items}</ul></details>`);
  }
  if (!d.alliances?.length && !d.unaffiliated_corps?.length) {
    parts.push('<p class="muted">No corps detected. Configure a corp_id or log in on the Auth tab.</p>');
  }
  for (const a of d.alliances || []) parts.push(renderSovAlliance(a));
  parts.push(renderSovUnaffiliated(d.unaffiliated_corps));
  container.innerHTML = parts.join('');

  const sortSel = $('#sov-sort-select');
  if (sortSel) {
    sortSel.addEventListener('change', (e) => {
      sovState.sort = e.target.value;
      renderSov();
    });
  }
}

$('#btn-sov-refresh')?.addEventListener('click', refreshSov);

// Lazy-load the first time the user opens the tab.
document.querySelector('.tab-btn[data-tab="sov"]')?.addEventListener('click', () => {
  if (!sovState.data && !sovState.loading) refreshSov();
});

// ====================== Working tab ======================
// Pinned moon contracts persisted server-side at
// <userData>/eve_auth/pinned_contracts.json. Survives Moon-tab re-fetches,
// renderer refreshes, and app close+reopen. Per-pin Janice paste box runs a
// fresh appraisal against actual refined minerals and applies the snapshot's
// blended payout fraction.

const PIN_STATUSES = ['pending', 'paid', 'disputed'];
const workingState = {
  pins: [],
  filter: 'all',
  expanded: new Set(),
  loading: false,
  calcMounted: false,
};

async function loadPinnedContracts() {
  if (workingState.loading) return;
  workingState.loading = true;
  const status = $('#working-status');
  if (status) status.textContent = 'loading pins…';
  try {
    const res = await fetch(`${API}/api/pinned`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    workingState.pins = Array.isArray(data.pins) ? data.pins : [];
    if (status) status.textContent = `${workingState.pins.length} pin${workingState.pins.length === 1 ? '' : 's'}`;
    renderWorkingTab();
  } catch (e) {
    if (status) status.textContent = `error loading pins: ${e}`;
  } finally {
    workingState.loading = false;
  }
}

async function pinMoonContract(contractId) {
  const snapshot = lastResults.moon.find((r) => r.contract_id === contractId);
  if (!snapshot) {
    alert('No moon result for that contract in memory. Re-run "Fetch & process" on the Moon tab first.');
    return;
  }
  const btns = document.querySelectorAll(`.btn-pin-moon[data-contract-id="${contractId}"]`);
  btns.forEach((b) => { b.disabled = true; b.textContent = '📌 pinning…'; });
  try {
    const res = await fetch(`${API}/api/pinned`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contract_id: contractId, snapshot }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    workingState.pins = data.pins || [];
    btns.forEach((b) => { b.textContent = '📌 Pinned ✓'; });
    setTimeout(() => {
      btns.forEach((b) => { b.disabled = false; b.textContent = '📌 Pin to Working'; });
    }, 1500);
    renderWorkingTab();
  } catch (e) {
    alert(`Pin failed: ${e}`);
    btns.forEach((b) => { b.disabled = false; b.textContent = '📌 Pin to Working'; });
  }
}

async function unpinContract(contractId) {
  if (!confirm(`Remove pin for contract ${contractId}?`)) return;
  try {
    const res = await fetch(`${API}/api/pinned/${contractId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    workingState.pins = data.pins || [];
    workingState.expanded.delete(contractId);
    renderWorkingTab();
  } catch (e) {
    alert(`Unpin failed: ${e}`);
  }
}

async function patchPin(contractId, patch) {
  try {
    const res = await fetch(`${API}/api/pinned/${contractId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // Splice the returned pin back into our list.
    const idx = workingState.pins.findIndex((p) => p.contract_id === contractId);
    if (idx >= 0) workingState.pins[idx] = data.pin;
    renderWorkingTab();
  } catch (e) {
    alert(`Update failed: ${e}`);
  }
}

async function runPinAppraisal(contractId, pasteText) {
  const detail = document.querySelector(`.pin-card[data-contract-id="${contractId}"] .pin-detail`);
  const statusEl = detail?.querySelector('.pin-appraise-status');
  const btn = detail?.querySelector('.btn-pin-appraise');
  if (!pasteText.trim()) {
    if (statusEl) statusEl.textContent = 'paste box is empty';
    return;
  }
  if (statusEl) statusEl.textContent = 'appraising with Janice…';
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(`${API}/api/pinned/${contractId}/appraise`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paste_text: pasteText, persist: true }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const idx = workingState.pins.findIndex((p) => p.contract_id === contractId);
    if (idx >= 0) workingState.pins[idx] = data.pin;
    renderWorkingTab();
  } catch (e) {
    if (statusEl) statusEl.textContent = `appraisal failed: ${e}`;
    if (btn) btn.disabled = false;
  }
}

function renderWorkingTab() {
  const root = $('#working-list');
  if (!root) return;
  const filtered = workingState.filter === 'all'
    ? workingState.pins
    : workingState.pins.filter((p) => (p.status || 'pending') === workingState.filter);
  if (!filtered.length) {
    root.innerHTML = `<p class="muted">No ${workingState.filter === 'all' ? '' : workingState.filter + ' '}pins. Pin a moon contract from the Moon tab to start.</p>`;
    return;
  }
  root.innerHTML = '';
  for (const p of filtered) root.appendChild(buildPinCard(p));
}

function buildPinCard(pin) {
  const snap = pin.snapshot || {};
  const refined = snap.payout?.refined;
  const recPayout = refined?.recommended_payout;
  const fraction = pin.blended_fraction;
  const status = pin.status || 'pending';
  const isExpanded = workingState.expanded.has(pin.contract_id);
  const pinnedDate = pin.pinned_at ? new Date(pin.pinned_at).toLocaleDateString() : '?';

  const div = document.createElement('div');
  div.className = `pin-card pin-${status} ${isExpanded ? 'expanded' : ''}`;
  div.dataset.contractId = pin.contract_id;

  const summary = `
    <div class="pin-summary" data-pin-toggle="1">
      <div class="pin-summary-head">
        <strong>#${pin.contract_id}</strong>
        <span class="pin-issuer">${escapeHtml(snap.issuer_name || 'unknown')}</span>
        <span class="pin-status pin-status-${status}">${status}</span>
        <span class="pin-summary-spacer"></span>
        <span class="pin-summary-payout">${recPayout != null ? Math.round(recPayout).toLocaleString() + ' ISK' : '—'}</span>
        <span class="muted">${(fraction != null ? (fraction * 100).toFixed(1) + '%' : '?')} blended</span>
        <span class="pin-summary-caret">${isExpanded ? '▾' : '▸'}</span>
      </div>
      <div class="muted pin-summary-meta">
        ${escapeHtml(snap.title || '(no title)')} · pinned ${pinnedDate}
      </div>
    </div>
  `;
  div.innerHTML = summary + (isExpanded ? renderPinDetail(pin) : '');
  return div;
}

function renderPinDetail(pin) {
  const cid = pin.contract_id;
  const snap = pin.snapshot || {};
  const refined = snap.payout?.refined;
  const items = snap.payout?.items || [];
  const fraction = pin.blended_fraction;
  const fracPct = fraction != null ? (fraction * 100).toFixed(2) : '?';

  // Quick-paste hint for the textarea (refined-mineral list from the snapshot).
  const refinedBreakdown = refined?.breakdown || [];
  const hintLines = refinedBreakdown.map((b) =>
    `${(b.name || `type ${b.type_id}`)}\t${b.quantity}`,
  ).join('\n');

  const appraisals = pin.appraisals || [];
  const lastAppraisal = appraisals[0];

  const recPayoutHtml = refined?.recommended_payout != null
    ? `<span class="payout-copy" role="button" tabindex="0" title="Click to copy" data-copy="${Math.round(refined.recommended_payout)}">${Math.round(refined.recommended_payout).toLocaleString()}</span> ISK`
    : '—';
  const snapBlock = `
    <div class="pin-snap">
      <div class="pin-snap-line"><span class="muted">Original recommended payout:</span> <strong>${recPayoutHtml}</strong></div>
      <div class="pin-snap-line"><span class="muted">Moon refined value:</span> ${refined?.moon_value != null ? Math.round(refined.moon_value).toLocaleString() : '—'} × ${refined?.moon_payout_fraction != null ? (refined.moon_payout_fraction * 100).toFixed(0) + '%' : '?'} = ${refined?.moon_payout != null ? Math.round(refined.moon_payout).toLocaleString() : '—'}</div>
      <div class="pin-snap-line"><span class="muted">Non-moon refined value:</span> ${refined?.non_moon_value != null ? Math.round(refined.non_moon_value).toLocaleString() : '—'} × ${refined?.non_moon_payout_fraction != null ? (refined.non_moon_payout_fraction * 100).toFixed(0) + '%' : '?'} = ${refined?.non_moon_payout != null ? Math.round(refined.non_moon_payout).toLocaleString() : '—'}</div>
      <div class="pin-snap-line pin-snap-blend">
        <span class="muted">Blended fraction used for fresh appraisals:</span> <strong>${fracPct}%</strong>
      </div>
    </div>
  `;

  const lastBlock = lastAppraisal ? `
    <div class="pin-last-appraisal">
      <h4>Last appraisal — ${new Date(lastAppraisal.timestamp).toLocaleString()}</h4>
      <div>Janice [${escapeHtml(lastAppraisal.source || '?')}] @ ${escapeHtml(lastAppraisal.market_name || '?')}: <strong>${Math.round(lastAppraisal.janice_total).toLocaleString()} ISK</strong>${lastAppraisal.janice_code ? ` (<a href="https://janice.e-351.com/a/${escapeHtml(lastAppraisal.janice_code)}" target="_blank" rel="noopener">view</a>)` : ''}</div>
      <div>× <strong>${(lastAppraisal.fraction_used * 100).toFixed(2)}%</strong> blended fraction</div>
      <div class="pin-payout-final">→ Payout: <span class="payout-copy" role="button" tabindex="0" title="Click to copy" data-copy="${Math.round(lastAppraisal.payout)}">${Math.round(lastAppraisal.payout).toLocaleString()}</span> ISK</div>
      ${lastAppraisal.api_fallback_reason ? `<div class="muted">Janice API fallback: ${escapeHtml(lastAppraisal.api_fallback_reason)}</div>` : ''}
    </div>
  ` : '';

  const historyBlock = appraisals.length > 1 ? `
    <details class="pin-history">
      <summary>Appraisal history (${appraisals.length})</summary>
      ${appraisals.slice(1).map((a) => `
        <div class="pin-history-row">
          <span class="muted">${new Date(a.timestamp).toLocaleString()}</span> —
          Janice <strong>${Math.round(a.janice_total).toLocaleString()}</strong> ×
          ${(a.fraction_used * 100).toFixed(2)}% =
          <strong><span class="payout-copy" role="button" tabindex="0" title="Click to copy" data-copy="${Math.round(a.payout)}">${Math.round(a.payout).toLocaleString()}</span></strong>
          ${a.janice_code ? `<a href="https://janice.e-351.com/a/${escapeHtml(a.janice_code)}" target="_blank" rel="noopener">[view]</a>` : ''}
        </div>
      `).join('')}
    </details>
  ` : '';

  const contentsBlock = items.length ? `
    <details>
      <summary>Original contract contents (${items.length} items)</summary>
      ${renderItemsTable(items.map((i) => ({ name: i.name || `type ${i.type_id}`, quantity: i.quantity })), ['name', 'quantity'])}
    </details>
  ` : '';

  return `
    <div class="pin-detail">
      ${snapBlock}
      <div class="pin-paste-row">
        <label class="pin-paste-label">Paste actual refined minerals here (one per line, EVE format):</label>
        <textarea class="pin-paste" rows="6" placeholder="${hintLines ? escapeAttr(hintLines.split('\n').slice(0, 3).join('\n') + (hintLines.split('\n').length > 3 ? '\n…' : '')) : 'Tritanium\\t100000\\nPyerite\\t50000\\n…'}"></textarea>
        <div class="pin-paste-actions">
          <button type="button" class="btn-pin-appraise" data-contract-id="${cid}">Appraise & apply ${fracPct}%</button>
          <button type="button" class="btn-pin-prefill secondary" data-contract-id="${cid}" title="Fill with the original calculated refined breakdown">Pre-fill from snapshot</button>
          <span class="muted pin-appraise-status"></span>
        </div>
      </div>
      ${lastBlock}
      ${historyBlock}
      ${contentsBlock}
      <div class="pin-meta-row">
        <label class="pin-status-label">
          Status
          <select class="pin-status-select" data-contract-id="${cid}">
            ${PIN_STATUSES.map((s) => `<option value="${s}" ${(pin.status || 'pending') === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </label>
        <label class="pin-notes-label">
          Notes
          <textarea class="pin-notes" data-contract-id="${cid}" rows="2" placeholder="admin notes (auto-saved on blur)">${escapeHtml(pin.notes || '')}</textarea>
        </label>
      </div>
      <div class="pin-actions">
        <button type="button" class="btn-pin-unpin secondary" data-contract-id="${cid}">Remove pin</button>
        <span class="muted" data-pin-prefill-payload="${escapeAttr(hintLines)}"></span>
      </div>
    </div>
  `;
}

function togglePinExpanded(contractId) {
  if (workingState.expanded.has(contractId)) workingState.expanded.delete(contractId);
  else workingState.expanded.add(contractId);
  renderWorkingTab();
}

// ---- Event wiring ----

// Pin button on moon rows (delegated).
document.addEventListener('click', (e) => {
  const pinBtn = e.target.closest('.btn-pin-moon');
  if (pinBtn) {
    const cid = parseInt(pinBtn.dataset.contractId, 10);
    if (cid) pinMoonContract(cid);
    return;
  }
});

// Working-tab click delegation: expand/collapse, appraise, prefill, unpin.
$('#working-list')?.addEventListener('click', (e) => {
  const card = e.target.closest('.pin-card');
  if (!card) return;
  const cid = parseInt(card.dataset.contractId, 10);
  if (!cid) return;

  if (e.target.closest('.btn-pin-appraise')) {
    const paste = card.querySelector('.pin-paste')?.value || '';
    runPinAppraisal(cid, paste);
    return;
  }
  if (e.target.closest('.btn-pin-prefill')) {
    const payload = card.querySelector('[data-pin-prefill-payload]')?.getAttribute('data-pin-prefill-payload');
    const ta = card.querySelector('.pin-paste');
    if (ta && payload) {
      // Replace escaped chars from attribute encoding.
      const txt = payload.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
      ta.value = txt;
    }
    return;
  }
  if (e.target.closest('.btn-pin-unpin')) {
    unpinContract(cid);
    return;
  }
  // Toggle expanded if the click was on the summary header.
  if (e.target.closest('[data-pin-toggle]')) {
    togglePinExpanded(cid);
  }
});

// Status / notes change handlers.
$('#working-list')?.addEventListener('change', (e) => {
  const sel = e.target.closest('.pin-status-select');
  if (sel) {
    const cid = parseInt(sel.dataset.contractId, 10);
    if (cid) patchPin(cid, { status: sel.value });
  }
});
$('#working-list')?.addEventListener('blur', (e) => {
  const ta = e.target.closest('.pin-notes');
  if (ta) {
    const cid = parseInt(ta.dataset.contractId, 10);
    if (cid) patchPin(cid, { notes: ta.value });
  }
}, true);

// Filter pills.
document.querySelectorAll('.working-filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.working-filter-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    workingState.filter = btn.dataset.filter;
    renderWorkingTab();
  });
});

// Refresh button + lazy-mount calculator on first tab visit.
$('#btn-working-refresh')?.addEventListener('click', loadPinnedContracts);

function initWorkingTab() {
  if (!workingState.calcMounted) {
    const mount = $('#working-calc-mount');
    if (mount && typeof window.mountCalculator === 'function') {
      window.mountCalculator(mount);
      workingState.calcMounted = true;
    }
    const sidebar = $('#working-calc-sidebar');
    const toggleBtn = $('#btn-working-toggle-calc');
    if (sidebar && toggleBtn && !toggleBtn.dataset.bound) {
      toggleBtn.dataset.bound = '1';
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
    }
    const popoutBtn = $('#btn-working-calc-popout');
    if (popoutBtn && !popoutBtn.dataset.bound) {
      popoutBtn.dataset.bound = '1';
      popoutBtn.addEventListener('click', () => {
        if (window.api && typeof window.api.openCalculator === 'function') window.api.openCalculator();
      });
    }
  }
  loadPinnedContracts();
}

document.querySelector('.tab-btn[data-tab="working"]')?.addEventListener('click', initWorkingTab);

// Boot: load pins eagerly so the badge count is correct without a tab visit.
loadPinnedContracts();

// ====================== Appraisal tab ======================
// Paste box -> POST /api/appraise -> renders the Janice block (full
// Janice-style detail) followed by a Mutamarket addendum that lists each
// abyssal type in the paste with its marketplace-median and AI-estimator
// median prices.

function fmtIsk(n) {
  if (n == null || isNaN(n)) return '—';
  return Math.round(n).toLocaleString() + ' ISK';
}

function renderAppraiseResult(data) {
  const root = $('#appraise-result');
  if (!root) return;
  if (!data) { root.innerHTML = ''; return; }

  const j = data.janice || {};
  const mkt = data.market_name || '?';
  const codeLink = j.code
    ? ` (<a href="https://janice.e-351.com/a/${escapeHtml(j.code)}" target="_blank" rel="noopener">view on Janice</a>)`
    : '';
  const fallback = j.api_fallback_reason
    ? `<div class="appraise-warn">⚠ Janice REST API failed — used RPC fallback: ${escapeHtml(j.api_fallback_reason)}</div>`
    : '';

  // Helper: render one price column (Buy / Split / Sell) with a copy-on-click
  // headline value and a row of percentage-modifier chips that each copy the
  // (price × pct/100) figure when clicked.
  const PRICE_PCTS = [80, 90, 100, 110, 120];
  function priceColumn(label, value) {
    const v = Math.round(value || 0);
    const chips = PRICE_PCTS.map((p) => {
      const modded = Math.round(v * p / 100);
      const cls = p === 100 ? 'appraise-pct appraise-pct-100' : 'appraise-pct';
      return `<button type="button" class="${cls} copyable" data-copy="${modded}" title="Copy ${modded.toLocaleString()} ISK">${p}% <span class="muted">${modded.toLocaleString()}</span></button>`;
    }).join('');
    return `
      <div class="appraise-price-col">
        <div class="muted appraise-price-label">${label}</div>
        <strong class="appraise-price-headline copyable" role="button" tabindex="0" title="Click to copy" data-copy="${v}">${fmtIsk(value)}</strong>
        <div class="appraise-pct-row">${chips}</div>
      </div>
    `;
  }

  const imm = j.prices_immediate || {};
  const eff = j.prices_effective || {};
  const showEffectiveBlock = (eff.buy_total !== imm.buy_total) || (eff.split_total !== imm.split_total) || (eff.sell_total !== imm.sell_total);

  const janiceBlock = `
    <div class="appraise-block appraise-janice">
      <h3>Janice — non-abyssal items</h3>
      ${fallback}
      <div class="appraise-line">
        <span class="muted">Items priced:</span>
        <strong>${j.item_count || 0}</strong>
        <span class="muted"> · Market:</span>
        <strong>${escapeHtml(mkt)}</strong>
        <span class="muted"> · Source:</span>
        <strong>${escapeHtml(j.source || '?')}</strong>
        ${codeLink ? `<span class="muted">${codeLink}</span>` : ''}
      </div>
      <h4 class="appraise-price-section-h">Immediate prices <span class="muted">(current orders on the book)</span></h4>
      <div class="appraise-prices">
        ${priceColumn('Buy', imm.buy_total)}
        ${priceColumn('Split', imm.split_total)}
        ${priceColumn('Sell', imm.sell_total)}
      </div>
      ${showEffectiveBlock ? `
        <details class="appraise-effective">
          <summary>Effective prices <span class="muted">(smoothed via recent history)</span></summary>
          <div class="appraise-prices">
            ${priceColumn('Buy', eff.buy_total)}
            ${priceColumn('Split', eff.split_total)}
            ${priceColumn('Sell', eff.sell_total)}
          </div>
        </details>
      ` : ''}
    </div>
  `;

  const ab = data.abyssals || [];
  let abyssalBlock;
  if (!ab.length) {
    abyssalBlock = `
      <div class="appraise-block appraise-abyssal-empty">
        <h3>Mutamarket — abyssal addendum</h3>
        <p class="muted">No abyssal items detected in this paste. (Names beginning with <code>Abyssal …</code> are auto-routed through Mutamarket.)</p>
      </div>
    `;
  } else {
    const rows = ab.map((r) => {
      const m = r.marketplace, e = r.estimator;
      const mMed = m?.median;
      const eMed = e?.median;
      const mkTot = r.marketplace_total_median;
      const eTot = r.estimator_total_median;
      const err = r.error ? `<div class="muted">error: ${escapeHtml(r.error)}</div>` : '';
      return `
        <tr>
          <td><strong>${escapeHtml(r.name || `type ${r.type_id}`)}</strong>
            <div class="muted">type ${r.type_id} · ${r.total_listings} listing${r.total_listings === 1 ? '' : 's'}${err}</div>
          </td>
          <td class="num">${r.quantity}</td>
          <td class="num">
            ${mMed != null
              ? `${fmtIsk(mMed)}<div class="muted">${m.count} active sale${m.count === 1 ? '' : 's'} · min ${fmtIsk(m.min)} · max ${fmtIsk(m.max)}</div>`
              : '<span class="muted">no active listings</span>'}
          </td>
          <td class="num">
            ${eMed != null
              ? `${fmtIsk(eMed)}<div class="muted">${e.count} sample${e.count === 1 ? '' : 's'} · μ ${fmtIsk(e.mean)}</div>`
              : '<span class="muted">no estimator data</span>'}
          </td>
          <td class="num">${mkTot != null ? `<strong class="copyable" role="button" tabindex="0" title="Click to copy" data-copy="${Math.round(mkTot)}">${fmtIsk(mkTot)}</strong>` : '—'}</td>
          <td class="num">${eTot != null ? `<strong class="copyable" role="button" tabindex="0" title="Click to copy" data-copy="${Math.round(eTot)}">${fmtIsk(eTot)}</strong>` : '—'}</td>
        </tr>
      `;
    }).join('');
    abyssalBlock = `
      <div class="appraise-block appraise-abyssal">
        <h3>Mutamarket — abyssal addendum</h3>
        <table class="appraise-table">
          <thead>
            <tr>
              <th>Type</th>
              <th class="num">Qty</th>
              <th class="num">Marketplace median<br><span class="muted">live seller asks</span></th>
              <th class="num">Estimator median<br><span class="muted">Mutamarket AI</span></th>
              <th class="num">× qty (market)</th>
              <th class="num">× qty (estimator)</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  const t = data.totals || {};
  const grandBlock = `
    <div class="appraise-block appraise-grand">
      <h3>Combined totals</h3>
      <div class="appraise-grand-grid">
        <div>
          <div class="muted">Janice (non-abyssal)</div>
          <strong class="copyable" role="button" tabindex="0" title="Click to copy" data-copy="${Math.round(t.janice_total_buy || 0)}">${fmtIsk(t.janice_total_buy)}</strong>
        </div>
        <div>
          <div class="muted">Mutamarket — marketplace</div>
          <strong class="copyable" role="button" tabindex="0" title="Click to copy" data-copy="${Math.round(t.abyssal_marketplace_median_total || 0)}">${fmtIsk(t.abyssal_marketplace_median_total)}</strong>
        </div>
        <div>
          <div class="muted">Mutamarket — estimator</div>
          <strong class="copyable" role="button" tabindex="0" title="Click to copy" data-copy="${Math.round(t.abyssal_estimator_median_total || 0)}">${fmtIsk(t.abyssal_estimator_median_total)}</strong>
        </div>
        <div class="appraise-grand-sum">
          <div class="muted">Grand (Janice + market)</div>
          <strong class="copyable" role="button" tabindex="0" title="Click to copy" data-copy="${Math.round(t.grand_marketplace_median || 0)}">${fmtIsk(t.grand_marketplace_median)}</strong>
        </div>
        <div class="appraise-grand-sum">
          <div class="muted">Grand (Janice + estimator)</div>
          <strong class="copyable" role="button" tabindex="0" title="Click to copy" data-copy="${Math.round(t.grand_estimator_median || 0)}">${fmtIsk(t.grand_estimator_median)}</strong>
        </div>
      </div>
    </div>
  `;

  root.innerHTML = janiceBlock + abyssalBlock + grandBlock;
}

// Delegated click-to-copy for any .copyable span in the appraisal result.
// Mirrors the .payout-copy pattern used elsewhere; one shared handler so
// new copyable elements pick it up automatically.
document.addEventListener('click', async (e) => {
  const el = e.target.closest('#appraise-result .copyable');
  if (!el) return;
  const v = el.dataset.copy || '';
  try {
    await navigator.clipboard.writeText(v);
    const prev = el.dataset.prevText ?? el.textContent;
    el.dataset.prevText = prev;
    el.textContent = 'copied!';
    el.classList.add('payout-copied');
    setTimeout(() => {
      el.textContent = prev;
      el.classList.remove('payout-copied');
    }, 900);
  } catch (_) {}
});

async function runAppraise() {
  const paste = $('#appraise-paste')?.value || '';
  const market = $('#appraise-market')?.value || '';
  const persist = $('#appraise-persist')?.checked || false;
  const status = $('#appraise-status');
  const btn = $('#btn-appraise');
  if (!paste.trim()) {
    if (status) status.textContent = 'paste something first';
    return;
  }
  if (btn) btn.disabled = true;
  if (status) status.textContent = 'appraising…';
  try {
    const res = await fetch(`${API}/api/appraise`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paste_text: paste, market_name: market || undefined, persist }),
    });
    if (!res.ok) {
      const text = await res.text();
      let msg = text;
      try { msg = JSON.parse(text).detail || text; } catch (_) {}
      throw new Error(`HTTP ${res.status}: ${msg}`);
    }
    const data = await res.json();
    renderAppraiseResult(data);
    if (status) {
      const ab = (data.abyssals || []).length;
      status.textContent = ab
        ? `done · ${data.janice?.item_count || 0} items via Janice · ${ab} abyssal type${ab === 1 ? '' : 's'} via Mutamarket`
        : `done · ${data.janice?.item_count || 0} items via Janice (no abyssals detected)`;
    }
  } catch (e) {
    if (status) status.textContent = `failed: ${e.message || e}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

$('#btn-appraise')?.addEventListener('click', runAppraise);
$('#btn-appraise-clear')?.addEventListener('click', () => {
  if ($('#appraise-paste')) $('#appraise-paste').value = '';
  if ($('#appraise-status')) $('#appraise-status').textContent = '';
  renderAppraiseResult(null);
});
// Ctrl/Cmd-Enter inside the textarea = run appraisal.
$('#appraise-paste')?.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    runAppraise();
  }
});
