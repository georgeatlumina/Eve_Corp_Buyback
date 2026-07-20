const API = window.api.base;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function updateAppHeaderHeight() {
  const h = document.querySelector('header')?.getBoundingClientRect().height || 0;
  document.documentElement.style.setProperty('--app-header-h', `${h}px`);
}
updateAppHeaderHeight();
window.addEventListener('resize', updateAppHeaderHeight);

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
  4: 'SRP',
  5: 'Manufacturing',
  6: 'Moon mining',
  7: 'Command',
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
// SRP rejection mail template (Mail tab); hydrated from config in loadConfig().
let srpRejectTemplate = { subject: '', body: '' };
// How external links open: 'panel' (side panel) or 'window' (own window).
let linkOpenMode = 'panel';

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

// ── Outstanding-payout totals (top of Buyback + Moon pages) ──
// Sums what the corp wallet will actually owe once we hit Accept on every
// row currently classified as 'approve'. Ignores 'reject'/'errors' since
// those won't be paid. We render the count too so the operator can sanity-
// check it against the visible result list.
//
// Buyback payout per row = appraisal.effective_offer (Janice value × 90%
//   in the standard flow). If the row doesn't have an appraisal we fall
//   back to the contract's listed price, which is what the corp would
//   actually pay if the appraisal block is missing for some reason.
// Moon payout per row    = payout.refined.recommended_payout (the headline
//   number on each Moon contract row).
function _rowAcceptValue(kind, r) {
  if (classifyResult(r) !== 'approve') return 0;
  if (kind === 'buyback') {
    const eff = r.appraisal?.effective_offer;
    if (typeof eff === 'number' && eff > 0) return eff;
    if (typeof r.price === 'number' && r.price > 0) return r.price;
    return 0;
  }
  // moon
  return r.payout?.refined?.recommended_payout || 0;
}

// Compact ISK for at-a-glance reading: 17.1B, 12M, 950K (trailing .0 stripped).
function fmtIskShort(n) {
  if (n == null || isNaN(n)) return '';
  const abs = Math.abs(n);
  const strip = (x) => x.toFixed(1).replace(/\.0$/, '');
  if (abs >= 1e9) return strip(n / 1e9) + 'B';
  if (abs >= 1e6) return strip(n / 1e6) + 'M';
  if (abs >= 1e3) return strip(n / 1e3) + 'K';
  return String(Math.round(n));
}

function renderPayoutTotal(kind) {
  const el = $(kind === 'buyback' ? '#buyback-payout-total' : '#moon-payout-total');
  if (!el) return;
  const list = lastResults[kind] || [];
  if (!list.length) { el.hidden = true; el.innerHTML = ''; return; }
  let total = 0;
  let count = 0;
  for (const r of list) {
    const v = _rowAcceptValue(kind, r);
    if (v > 0) { total += v; count += 1; }
  }
  el.hidden = false;
  el.innerHTML = `
    <div class="payout-total-label">Outstanding to be accepted</div>
    <div class="payout-total-amount">
      <span class="payout-copy" role="button" tabindex="0" title="Click to copy" data-copy="${Math.round(total)}">${Math.round(total).toLocaleString()}</span>
      <span class="payout-total-isk">ISK</span>
      <span class="payout-total-short">(${fmtIskShort(total)})</span>
    </div>
    <div class="payout-total-meta muted">${count} approve row${count === 1 ? '' : 's'}</div>
  `;
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
function activateTab(name) {
  const btn = $(`.tab-btn[data-tab="${name}"]`);
  const section = $(`#tab-${name}`);
  if (!btn || !section) return;
  $$('.tab-btn').forEach((b) => b.classList.remove('active'));
  $$('.tab').forEach((t) => t.classList.remove('active'));
  btn.classList.add('active');
  section.classList.add('active');
  if (name === 'buybacks') refreshWallets();
  closeAllNavMenus();
  updateNavTriggers();
  if (name === 'haulx') renderHaulxTab();
  if (name === 'acquisitions') renderAcquisitionsTab();
}

$$('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => activateTab(btn.dataset.tab));
});

// ===== Collapsed grouped nav: each group's trigger toggles its dropdown. =====
function closeAllNavMenus(except) {
  $$('.nav-group.open').forEach((g) => {
    if (g === except) return;
    g.classList.remove('open');
    g.querySelector('.nav-trigger')?.setAttribute('aria-expanded', 'false');
  });
}

// Reflect the active tab on its group's trigger (dot + label) so you keep
// context while the menus are collapsed.
function updateNavTriggers() {
  const active = $('.tab-btn.active');
  const activeGroup = active ? active.closest('.nav-group') : null;
  $$('.nav-group').forEach((g) => {
    const trigger = g.querySelector('.nav-trigger');
    const labelEl = trigger?.querySelector('.nav-trigger-label');
    if (!trigger || !labelEl) return;
    if (!trigger.dataset.base) trigger.dataset.base = labelEl.textContent;
    const isActive = g === activeGroup;
    g.classList.toggle('has-active', isActive);
    labelEl.textContent = isActive
      ? `${trigger.dataset.base} · ${active.textContent.trim()}`
      : trigger.dataset.base;
  });
}

$$('.nav-trigger').forEach((trigger) => {
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const group = trigger.closest('.nav-group');
    const willOpen = !group.classList.contains('open');
    closeAllNavMenus(group);
    group.classList.toggle('open', willOpen);
    trigger.setAttribute('aria-expanded', String(willOpen));
  });
});
// Close on outside click or Escape.
document.addEventListener('click', (e) => { if (!e.target.closest('.nav-group')) closeAllNavMenus(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAllNavMenus(); });
updateNavTriggers();

// View mode (Member / Admin). This is a clutter filter for non-admin users,
// NOT a security boundary — it's a single-user desktop app and all data still
// lives in EVE/ESI. Member view shows only the General tab group; Admin shows
// everything. The choice persists in localStorage.
const VIEW_MODE_KEY = 'viewMode';
// Tabs hidden in Member view (the Operations group). The General group and the
// Settings cluster (top bar) stay visible in both modes.
const ADMIN_ONLY_TABS = ['buybacks', 'working', 'contracts', 'srp', 'liquidation', 'hooks-hubs', 'builds-overview', 'stockpile'];

function getViewMode() {
  return localStorage.getItem(VIEW_MODE_KEY) === 'admin' ? 'admin' : 'member';
}

function applyViewMode(mode) {
  const isMember = mode === 'member';
  document.body.classList.toggle('view-member', isMember);
  localStorage.setItem(VIEW_MODE_KEY, mode);
  $$('.view-mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  // If the currently-active tab is hidden in this mode, fall back to a visible one.
  const active = $('.tab-btn.active');
  if (isMember && active && ADMIN_ONLY_TABS.includes(active.dataset.tab)) {
    activateTab('appraisal');
  }
  if (typeof updateStockpileTabVisibility === 'function') updateStockpileTabVisibility();
  if (typeof updateIndyVisibility === 'function') updateIndyVisibility();
}

$$('.view-mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => applyViewMode(btn.dataset.mode));
});

// ===== Stockpile access =====
// The Stockpile tab lives in the Admin (Operations) nav group AND is
// password-gated: it only appears once the correct password is entered on the
// Config tab (remembered per-machine in localStorage). The password is hardcoded
// in the client — a soft access filter, NOT real security, and deliberately kept
// out of the config so it never saves or exports. Within the tab, the admin
// paste/save panel is separately gated on BOTH the machine's "Allow stock edits"
// toggle and Alliance Auth membership in an officer group (Industry Officer /
// Acquisitions Officer, matched by exact name off the dashboard "Membership"
// card, so stockpileAdminOk is set in refreshIndyAccess).
const STOCKPILE_PASSWORD = 'sushisithebestest69420';
const STOCKPILE_UNLOCK_KEY = 'stockpileUnlocked';
let stockpileUnlocked = localStorage.getItem(STOCKPILE_UNLOCK_KEY) === '1';
let stockpileAllowPush = false; // machine "Allow stock edits" toggle (from config)
let stockpileAdminOk = false;   // AA officer-group membership (Industry / Acquisitions Officer)
const STOCKPILE_ADMIN_GROUPS = ['industry officer', 'acquisitions officer'];

function updateStockpileTabVisibility() {
  const btn = document.querySelector('.tab-btn[data-tab="stockpile"]');
  if (!btn) return;
  btn.hidden = !stockpileUnlocked;
  if (!stockpileUnlocked && btn.classList.contains('active')) activateTab('appraisal');
}

function setStockpileUnlocked(on) {
  stockpileUnlocked = !!on;
  if (on) localStorage.setItem(STOCKPILE_UNLOCK_KEY, '1');
  else localStorage.removeItem(STOCKPILE_UNLOCK_KEY);
  updateStockpileTabVisibility();
}

function updateStockpileEditorVisibility() {
  const editor = $('#stockpile-editor');
  if (editor) editor.hidden = !(stockpileAllowPush && stockpileAdminOk);
}

// Config-tab password controls that unlock/lock the Stockpile tab. The input has
// no `name`, so it's never serialized into the config save/export.
(function wireStockpileUnlock() {
  const input = $('#stockpile-unlock-input');
  const status = $('#stockpile-unlock-status');
  const showStatus = (msg) => { if (status) status.textContent = msg; };
  const tryUnlock = () => {
    if (!input) return;
    if (input.value === STOCKPILE_PASSWORD) {
      setStockpileUnlocked(true);
      input.value = '';
      showStatus('Unlocked ✓ — Stockpile shows under Operations (Admin view).');
    } else {
      showStatus('Incorrect password.');
    }
  };
  $('#stockpile-unlock-btn')?.addEventListener('click', tryUnlock);
  $('#stockpile-lock-btn')?.addEventListener('click', () => {
    setStockpileUnlocked(false);
    if (input) input.value = '';
    showStatus('Locked.');
  });
  input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); tryUnlock(); } });
  showStatus(stockpileUnlocked ? 'Unlocked on this machine.' : 'Locked — enter the password to unlock.');
  updateStockpileTabVisibility();
})();

// Reads the "Allow stock edits" toggle from config and refreshes the admin
// paste/save panel visibility. (Officer-group membership is refreshed separately
// in refreshIndyAccess.)
async function refreshStockpileAccess() {
  let cfg = null;
  try {
    const res = await fetch(`${API}/api/config`);
    if (res.ok) cfg = await res.json();
  } catch (e) { /* config unreachable — treat as no access */ }
  stockpileAllowPush = !!cfg?.stockpile_allow_push;
  updateStockpileEditorVisibility();
}

// ===== Indy section access gate =====
// The Indy nav-group (Build Planner / Fulfilment) is gated on Alliance Auth
// membership in the "Industry Pilot" group — a client-side convenience filter,
// not a security boundary (the market-history write PAT is the real boundary).
// Always shown in Admin view so directors can reach the fulfilment dashboard.
// Membership is scraped from the authenticated AA dashboard's "Membership" card.
// Declared before the applyViewMode() call below, which calls updateIndyVisibility().
const INDY_GROUP_NAME = 'Industry Pilot';
let indyGroupOk = false;

function updateIndyVisibility() {
  const grp = document.querySelector('.nav-group[data-group="indy"]');
  if (!grp) return;
  const show = indyGroupOk || getViewMode() === 'admin';
  grp.hidden = !show;
  if (!show) {
    const active = $('.tab-btn.active');
    if (active && (active.dataset.tab === 'indy-planner' || active.dataset.tab === 'indy-fulfil')) {
      activateTab('appraisal');
    }
  }
}

// Scrapes the AA dashboard "Membership" card once and derives both the Indy
// section gate (Industry Pilot) and the Stockpile admin-panel gate (officer
// groups). Both are client-side convenience filters, not security boundaries.
async function refreshIndyAccess() {
  indyGroupOk = false;
  stockpileAdminOk = false;
  if (window.api?.aaFetchHtml && typeof parseDashboardGroups === 'function') {
    try {
      const res = await window.api.aaFetchHtml('/dashboard/');
      const loggedIn = res?.ok
        && !/\/account\/login\//.test(res.finalUrl || '')
        && !/Login with Eve SSO/i.test(res.html || '');
      if (loggedIn) {
        const groups = parseDashboardGroups(res.html || '').map((g) => (g || '').trim().toLowerCase());
        indyGroupOk = groups.includes(INDY_GROUP_NAME.toLowerCase());
        stockpileAdminOk = groups.some((g) => STOCKPILE_ADMIN_GROUPS.includes(g));
      }
    } catch (e) { /* scrape failed — Indy + stock-admin stay hidden */ }
  }
  updateIndyVisibility();
  updateStockpileEditorVisibility();
}

applyViewMode(getViewMode());

// Buybacks sub-toggle: switch the single Buybacks tab between the General
// buyback pane and the Ore (moon) buyback pane. Choice persists.
const BB_PANE_KEY = 'buybacksPane';
function setBuybacksPane(pane) {
  const p = pane === 'ore' ? 'ore' : 'general';
  const gen = $('#bb-pane-general');
  const ore = $('#bb-pane-ore');
  if (gen) gen.hidden = p !== 'general';
  if (ore) ore.hidden = p !== 'ore';
  $$('.bb-sub-btn').forEach((b) => b.classList.toggle('active', b.dataset.pane === p));
  localStorage.setItem(BB_PANE_KEY, p);
}
$$('.bb-sub-btn').forEach((b) => b.addEventListener('click', () => setBuybacksPane(b.dataset.pane)));
setBuybacksPane(localStorage.getItem(BB_PANE_KEY) || 'general');

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
  renderQuotas(Array.isArray(cfg.quotas_institute) ? cfg.quotas_institute : [], $('#quotas-institute-tbody'));
  if ($('[name=alliance_id_main]')) $('[name=alliance_id_main]').value = cfg.alliance_id_main || '';
  if ($('[name=alliance_id_institute]')) $('[name=alliance_id_institute]').value = cfg.alliance_id_institute || '';
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
  if ($('[name=market_history_repo_url]')) {
    $('[name=market_history_repo_url]').value = cfg.market_history_repo_url || '';
  }
  if ($('[name=market_history_pat_read]')) {
    $('[name=market_history_pat_read]').value = cfg.market_history_pat_read || '';
  }
  if ($('[name=market_history_pat_write]')) {
    $('[name=market_history_pat_write]').value = cfg.market_history_pat_write || '';
  }
  if ($('[name=stockpile_group_name]')) {
    $('[name=stockpile_group_name]').value = cfg.stockpile_group_name || '';
  }
  if ($('[name=stockpile_allow_push]')) {
    $('[name=stockpile_allow_push]').checked = !!cfg.stockpile_allow_push;
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
  // SRP rejection template (Mail tab).
  srpRejectTemplate = {
    subject: cfg.srp_reject_subject || '',
    body: cfg.srp_reject_body || '',
  };
  if ($('#srp-reject-subject')) $('#srp-reject-subject').value = srpRejectTemplate.subject;
  if ($('#srp-reject-body')) $('#srp-reject-body').value = srpRejectTemplate.body;
  // Link-open mode (Config tab).
  linkOpenMode = cfg.link_open_mode === 'window' ? 'window' : 'panel';
  if ($('#link-open-mode')) $('#link-open-mode').value = linkOpenMode;
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
    link_open_mode: $('#link-open-mode')?.value || 'panel',
    moon_market: $('#moon-market').value,
    moon_ore_refining_efficiency: parseFloat(fd.get('moon_ore_refining_efficiency')) || 0.78,
    non_moon_ore_refining_efficiency: parseFloat(fd.get('non_moon_ore_refining_efficiency')) || 0.78,
    ice_refining_efficiency: parseFloat(fd.get('ice_refining_efficiency')) || 0.78,
    moon_payout_fraction: parseFloat(fd.get('moon_payout_fraction')) || 0.80,
    non_moon_payout_fraction: parseFloat(fd.get('non_moon_payout_fraction')) || 0.90,
    home_structure_id: parseInt(fd.get('home_structure_id')) || 0,
    home_region_id: parseInt(fd.get('home_region_id')) || 0,
    quotas: collectQuotas(),
    quotas_institute: collectQuotas($('#quotas-institute-tbody')),
    alliance_id_main: parseInt(fd.get('alliance_id_main')) || 0,
    alliance_id_institute: parseInt(fd.get('alliance_id_institute')) || 0,
    alliance_quota_url: (fd.get('alliance_quota_url') || '').toString().trim(),
    alliance_quota_auto_sync: $('[name=alliance_quota_auto_sync]')?.checked || false,
    alliance_quota_pat_read: (fd.get('alliance_quota_pat_read') || '').toString().trim(),
    alliance_quota_pat_write: (fd.get('alliance_quota_pat_write') || '').toString().trim(),
    alliance_quota_allow_push: $('[name=alliance_quota_allow_push]')?.checked || false,
    market_history_repo_url: (fd.get('market_history_repo_url') || '').toString().trim(),
    market_history_pat_read: (fd.get('market_history_pat_read') || '').toString().trim(),
    market_history_pat_write: (fd.get('market_history_pat_write') || '').toString().trim(),
    stockpile_group_name: (fd.get('stockpile_group_name') || '').toString().trim(),
    stockpile_allow_push: $('[name=stockpile_allow_push]')?.checked || false,
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
  if (res.ok) { refreshStockpileAccess(); refreshIndyAccess(); }  // re-evaluate the group gates
});

function renderMoonTab() {
  renderPayoutTotal('moon');
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
    if ((refined.mineral_value || 0) > 0) {
      buckets.push(
        `<div class="meta">&nbsp;&nbsp;Minerals: ${Math.round(refined.mineral_value).toLocaleString()} ISK × ${nonMoonPct}% = ${Math.round(refined.mineral_payout).toLocaleString()} ISK</div>`
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
  slot4: 'Slot 4 (Hooks & Hubs — structure fuel; needs Director role)',
};
const AUTH_SLOTS = ['slot1', 'slot2', 'slot3', 'slot4'];

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
  renderPayoutTotal('buyback');
  renderPayoutTotal('moon');
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
    case 'done': {
      setStep('buyback', 'done');
      setStep('moon', 'done');
      hideProgress('buyback');
      hideProgress('moon');
      const shown = lastResults.moon.length;
      const dropped = ev.moon_dropped || 0;
      const suffix = dropped ? ` (${dropped} hidden — non-mining items)` : '';
      $('#moon-status').textContent = `Moon contracts: ${shown}${suffix}`;
      break;
    }
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
  // Always refresh the per-page total — the row may not be appended due to
  // the active filter, but it has still landed in lastResults so the total
  // needs to reflect it.
  renderPayoutTotal(kind);
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
  renderPayoutTotal('buyback');
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
refreshStockpileAccess();
refreshIndyAccess();
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
    if (window.api && typeof window.api.aaOpen === 'function') {
      window.api.aaOpen();
      const status = $('#aa-auth-status');
      if (status) status.textContent = 'Opened the Alliance Auth sign-in window — once signed in, use the Doctrines tab to refresh.';
    }
  });
}
// Re-check Indy access (and the stockpile officer gate it derives) when
// returning to the app — e.g. after signing in via the separate AA window.
window.addEventListener('focus', () => {
  if (!indyGroupOk) refreshIndyAccess();
});
const btnAaLogout = $('#btn-aa-logout');
if (btnAaLogout) {
  btnAaLogout.addEventListener('click', async () => {
    if (window.api && typeof window.api.aaLogout === 'function') {
      await window.api.aaLogout();
      const status = $('#aa-auth-status');
      if (status) status.textContent = 'Signed out.';
      const list = $('#doctrines-list');
      if (list) list.innerHTML = '';
      refreshStockpileAccess();  // drop stockpile access on sign-out
      refreshIndyAccess();       // and Indy access
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

  const _indexFits = (fits) => {
    for (const fit of fits) {
      if (!fit.id || !fit.name) continue;
      const nameLower = fit.name.toLowerCase();
      const typeLower = (fit.shipType || '').toLowerCase();
      if (!_fitIndex.has(nameLower)) _fitIndex.set(nameLower, new Map());
      _fitIndex.get(nameLower).set(typeLower, fit.id);
      if (!_fitIndexByType.has(typeLower)) _fitIndexByType.set(typeLower, []);
      const bucket = _fitIndexByType.get(typeLower);
      if (!bucket.some((e) => e.fitId === fit.id)) bucket.push({ fitId: fit.id, fitName: nameLower });
    }
  };

  // Index all fits from the main fittings list (catches fits not assigned to any doctrine)
  _indexFits(parseDoctrineDetail(res.html).fits);

  // Also index fits per doctrine (same data, but ensures doctrine-only fits are covered)
  const doctrines = parseDoctrinesHtml(res.html);
  await Promise.all(doctrines.map(async (d) => {
    if (!d.id) return;
    const dr = await window.api.aaFetchHtml(`/fittings/doctrine/${d.id}/`);
    if (!dr.ok) return;
    _indexFits(parseDoctrineDetail(dr.html).fits);
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
  // Background Janice appraisal of the current selection's missing items.
  // Keyed on the multibuy text so it only re-runs when the missing set changes.
  appraisal: { key: null, loading: false, url: null, error: null, itemCount: 0 },
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
    haulxReadinessScanDone = true;
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

// Kick off (or reuse) a background Janice appraisal for the current selection's
// missing items. Idempotent: keyed on the multibuy text, so calling it on every
// render only fires a network request when the missing set actually changes.
// On completion it re-renders the dashboard so the link surfaces next to the
// Copy missing button.
async function ensureMissingAppraisal(ctx) {
  const text = exportMultibuy(ctx.agg.missing);
  const a = readinessState.appraisal;
  if (!text) {
    if (a.key !== null || a.loading || a.url || a.error) {
      readinessState.appraisal = { key: null, loading: false, url: null, error: null, itemCount: 0 };
    }
    return;
  }
  const key = `${ctx.label} ${text}`;
  if (a.key === key) return; // already built or in flight for this exact set
  readinessState.appraisal = { key, loading: true, url: null, error: null, itemCount: 0 };
  try {
    const res = await fetch(`${API}/api/appraise`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paste_text: text, persist: true }),
    });
    if (!res.ok) {
      const t = await res.text();
      let msg = t; try { msg = JSON.parse(t).detail || t; } catch (_) {}
      throw new Error(`HTTP ${res.status}: ${msg}`);
    }
    const data = await res.json();
    if (readinessState.appraisal.key !== key) return; // selection moved on
    const code = data.janice?.code;
    readinessState.appraisal = {
      key,
      loading: false,
      url: code ? `https://janice.e-351.com/a/${code}` : null,
      error: code ? null : 'Janice returned no shareable link',
      itemCount: data.janice?.item_count || 0,
    };
  } catch (e) {
    if (readinessState.appraisal.key !== key) return; // selection moved on
    readinessState.appraisal = { key, loading: false, url: null, error: String(e.message || e), itemCount: 0 };
  }
  renderReadinessDashboard();
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
  const a = readinessState.appraisal;
  let janiceBlock = '';
  if (a.loading) {
    janiceBlock = `<span class="readiness-janice muted">Building Janice appraisal…</span>`;
  } else if (a.url) {
    janiceBlock = `
      <span class="readiness-janice">
        <span class="muted">Janice:</span>
        <code class="readiness-janice-url copyable" role="button" tabindex="0" title="Click to copy" data-copy="${a.url}">${a.url}</code>
        <button type="button" class="copyable secondary" data-copy="${a.url}">Copy link</button>
        <a href="${a.url}" target="_blank" rel="noopener">Open ↗</a>
      </span>`;
  } else if (a.error) {
    janiceBlock = `<span class="readiness-janice bad-text" title="${escapeHtml(a.error)}">Janice appraisal failed — <button class="link-btn" data-janice-retry="1">retry</button></span>`;
  }
  return `
    <div class="actions">
      <button data-export="copy">Copy missing</button>
      <button data-export="txt" class="secondary">Download .txt</button>
      ${janiceBlock}
    </div>
  `;
}

function renderReadinessSelection() {
  const ctx = selectionContext();
  if (!ctx) return null;
  ensureMissingAppraisal(ctx); // fire-and-forget; re-renders when the link is ready
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
  // Build the Janice appraisal for the aggregate missing set so the link shows on
  // the overview too (mirrors the no-selection branch of selectionContext()).
  ensureMissingAppraisal({ label: 'All enabled fits', agg });
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
  const janiceRetry = e.target.closest('[data-janice-retry]');
  if (janiceRetry) {
    readinessState.appraisal = { key: null, loading: false, url: null, error: null, itemCount: 0 };
    const ctx = selectionContext();
    if (ctx) ensureMissingAppraisal(ctx);
    renderReadinessDashboard();
    return;
  }
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
    <td class="q-drag" title="Drag to reorder">⠿</td>
    <td><input type="text" class="q-name" value="${escapeAttr(q.name || '')}" placeholder="e.g. Cerberus Shield" /></td>
    <td><input type="text" inputmode="numeric" list="ships-datalist" class="q-tid" value="${q.ship_type_id || ''}" placeholder="type or pick…" /></td>
    <td><input type="text" list="ship-names-datalist" class="q-sname" value="${escapeAttr(q.ship_name || '')}" placeholder="e.g. Cerberus" /></td>
    <td><input type="number" class="q-req" min="0" value="${q.required ?? 0}" /></td>
    <td><input type="text" class="q-title" value="${escapeAttr(q.title_filter || '')}" placeholder="optional" /></td>
    <td><input type="text" inputmode="numeric" class="q-fitid" value="${q.fit_id || ''}" placeholder="e.g. 94" title="Auth fit ID — overrides name lookup; use when the fit isn't in a doctrine" style="width:5em" /></td>
    <td><button type="button" class="q-remove secondary" title="Remove row">✕</button></td>
  `;
  tr.querySelector('.q-remove').addEventListener('click', () => tr.remove());
  // Only allow drag to begin from the handle cell, so clicking inputs works normally.
  tr.addEventListener('mousedown', (e) => {
    tr.draggable = !!e.target.closest('.q-drag');
  });
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

function renderQuotas(list, tbody = $('#quotas-tbody')) {
  if (!tbody) return;
  tbody.innerHTML = '';
  const rows = (list && list.length) ? list : [{}];
  rows.forEach((q) => tbody.appendChild(quotaRow(q || {})));
}

function collectQuotas(tbody = $('#quotas-tbody')) {
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

// Bind all interactive controls for one quota table section.
function bindQuotaSection(tbodyId, { addBtnId, importCsvBtnId, importJsonBtnId, exportCsvBtnId, exportJsonBtnId, importFileId, ioStatusId, exportFilename = 'quotas' }) {
  const getTbody = () => document.getElementById(tbodyId);
  let importMode = 'csv';

  function setStatus(msg) {
    const el = document.getElementById(ioStatusId);
    if (!el) return;
    el.textContent = msg;
    setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 3000);
  }

  document.getElementById(addBtnId)?.addEventListener('click', () => {
    getTbody()?.appendChild(quotaRow({}));
  });

  document.getElementById(exportCsvBtnId)?.addEventListener('click', () => {
    const data = collectQuotas(getTbody());
    downloadBlob(`${exportFilename}.csv`, 'text/csv', quotasToCsv(data));
    setStatus(`Exported ${data.length} rows as CSV.`);
  });

  document.getElementById(exportJsonBtnId)?.addEventListener('click', () => {
    const data = collectQuotas(getTbody());
    downloadBlob(`${exportFilename}.json`, 'application/json', JSON.stringify(data, null, 2));
    setStatus(`Exported ${data.length} rows as JSON.`);
  });

  document.getElementById(importCsvBtnId)?.addEventListener('click', () => {
    importMode = 'csv';
    document.getElementById(importFileId)?.click();
  });

  document.getElementById(importJsonBtnId)?.addEventListener('click', () => {
    importMode = 'json';
    document.getElementById(importFileId)?.click();
  });

  document.getElementById(importFileId)?.addEventListener('change', async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    ev.target.value = '';
    try {
      const text = await file.text();
      let imported;
      if (importMode === 'json') {
        const parsed = JSON.parse(text);
        imported = Array.isArray(parsed) ? parsed : (parsed.quotas || []);
      } else {
        imported = quotasFromCsvText(text);
      }
      if (!imported.length) { setStatus('No rows parsed from file.'); return; }
      const replace = confirm(`Imported ${imported.length} quota rows. OK = replace current list. Cancel = append.`);
      const current = replace ? [] : collectQuotas(getTbody());
      renderQuotas([...current, ...imported], getTbody());
      setStatus(`${replace ? 'Replaced with' : 'Appended'} ${imported.length} rows. Click "Save" to persist.`);
    } catch (e) {
      alert(`Import failed: ${e.message || e}`);
    }
  });

  getTbody()?.addEventListener('paste', (ev) => {
    const text = ev.clipboardData?.getData('text') || '';
    if (!text.includes('\n') && !text.includes('\t')) return;
    ev.preventDefault();
    const rows = parseDelimited(text);
    if (!rows.length) return;
    const tbody = getTbody();
    const targetRow = ev.target.closest('tr.quota-row');
    rows.forEach((cells, i) => {
      if (i === 0 && targetRow) {
        fillQuotaRowFromCells(targetRow, cells, ev.target);
      } else {
        tbody.appendChild(quotaRow(rowFromCells(cells)));
      }
    });
  });

  // Drag-and-drop row reordering
  let _dragSrc = null;
  const _tbody = getTbody();
  _tbody?.addEventListener('dragstart', (e) => {
    _dragSrc = e.target.closest('.quota-row');
    if (_dragSrc) {
      e.dataTransfer.effectAllowed = 'move';
      _dragSrc.classList.add('dragging');
    }
  });
  _tbody?.addEventListener('dragend', () => {
    if (_dragSrc) {
      _dragSrc.classList.remove('dragging');
      _dragSrc.draggable = false;
    }
    _tbody.querySelectorAll('.quota-row').forEach((r) => r.classList.remove('drag-over-top', 'drag-over-bottom'));
    _dragSrc = null;
  });
  _tbody?.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.target.closest('.quota-row');
    _tbody.querySelectorAll('.quota-row').forEach((r) => r.classList.remove('drag-over-top', 'drag-over-bottom'));
    if (!target || target === _dragSrc) return;
    const { top, height } = target.getBoundingClientRect();
    target.classList.add(e.clientY < top + height / 2 ? 'drag-over-top' : 'drag-over-bottom');
  });
  _tbody?.addEventListener('dragleave', (e) => {
    if (!_tbody.contains(e.relatedTarget)) {
      _tbody.querySelectorAll('.quota-row').forEach((r) => r.classList.remove('drag-over-top', 'drag-over-bottom'));
    }
  });
  _tbody?.addEventListener('drop', (e) => {
    e.preventDefault();
    const target = e.target.closest('.quota-row');
    _tbody.querySelectorAll('.quota-row').forEach((r) => r.classList.remove('drag-over-top', 'drag-over-bottom'));
    if (!target || target === _dragSrc || !_dragSrc) return;
    const { top, height } = target.getBoundingClientRect();
    if (e.clientY < top + height / 2) {
      _tbody.insertBefore(_dragSrc, target);
    } else {
      target.after(_dragSrc);
    }
  });
}

bindQuotaSection('quotas-tbody', {
  addBtnId: 'btn-add-quota',
  importCsvBtnId: 'btn-quota-import-csv',
  importJsonBtnId: 'btn-quota-import-json',
  exportCsvBtnId: 'btn-quota-export-csv',
  exportJsonBtnId: 'btn-quota-export-json',
  importFileId: 'quota-import-file',
  ioStatusId: 'quota-io-status',
  exportFilename: 'quotas-nldo',
});

bindQuotaSection('quotas-institute-tbody', {
  addBtnId: 'btn-add-quota-institute',
  importCsvBtnId: 'btn-quota-institute-import-csv',
  importJsonBtnId: 'btn-quota-institute-import-json',
  exportCsvBtnId: 'btn-quota-institute-export-csv',
  exportJsonBtnId: 'btn-quota-institute-export-json',
  importFileId: 'quota-institute-import-file',
  ioStatusId: 'quota-institute-io-status',
  exportFilename: 'quotas-nldf',
});

// Paste-from-spreadsheet support: if the user pastes multi-line tab-separated
// data into ANY quota input, expand into one row per line, mapping columns
// left-to-right (name, type_id, ship_name, required, title_filter).
// (handled per-section by bindQuotaSection above)

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
  // Per-machine archive timestamp — sharing it would mislead the recipient.
  // (The market-history PATs are NOT here: they're opt-in at export time below,
  // per the choice to let a kit carry archive access.)
  'market_history_last_archived',
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
  // Market-history PATs ride along only if you say so. Unlike the alliance
  // quota Write PAT (never exported), the history Write PAT is exportable by
  // design so a kit can let recipients archive — but it also grants overwrite,
  // so it's a deliberate opt-in.
  const includeMktReadPat = cfg.market_history_pat_read
    ? confirm('Include the market-history Read PAT in the export?\n\nOK = include (recipient can read the history repo after import).\nCancel = leave it out.')
    : false;
  const includeMktWritePat = cfg.market_history_pat_write
    ? confirm('Include the market-history WRITE PAT in the export?\n\nOK = include — anyone you give this kit can archive AND overwrite/delete snapshots in the history repo.\nCancel = leave it out (recommended unless this kit is for a co-admin).')
    : false;

  const out = { ...cfg };
  for (const k of CONFIG_EXPORT_NEVER) delete out[k];
  if (!includeKey) delete out.janice_api_key;
  if (!includeReadPat) delete out.alliance_quota_pat_read;
  if (!includeMktReadPat) delete out.market_history_pat_read;
  if (!includeMktWritePat) delete out.market_history_pat_write;

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
  if (includeMktReadPat) inclTags.push('Mkt Read PAT');
  if (includeMktWritePat) inclTags.push('Mkt Write PAT');
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
const contractsScanCache = {};
let activeContractsAlliance = 'main';

document.querySelector('.alliance-toggle')?.addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-alliance]');
  if (!btn) return;
  if (btn.dataset.alliance === activeContractsAlliance) return;
  activeContractsAlliance = btn.dataset.alliance;
  document.querySelectorAll('.alliance-btn').forEach((b) => b.classList.toggle('active', b === btn));
  const _btnSold = $('#btn-contracts-sold-scan');
  if (_btnSold && !_contractsScanRunning) _btnSold.disabled = !contractsScanCache[activeContractsAlliance];
  if (contractsScanCache[activeContractsAlliance]) {
    lastContractsScan = contractsScanCache[activeContractsAlliance];
    renderContractsDashboard(lastContractsScan);
  }
});

$('#btn-contracts-scan')?.addEventListener('click', runContractsScan);
$('#btn-contracts-sold-scan')?.addEventListener('click', runSold30dScan);
$('#btn-contracts-export-discord')?.addEventListener('click', exportForDiscord);
$('#btn-contracts-export-csv')?.addEventListener('click', exportGapCsv);
$('#btn-contracts-export-text')?.addEventListener('click', copyShoppingList);

// Show a status message when the user clicks/hovers a disabled scan button.
const _SCAN_BUSY_MSG = 'A scan is already running — please wait for it to finish.';
const _SCAN_FIRST_MSG = 'Run "Scan contracts" first before fetching sold counts.';
let _contractsScanRunning = false;

// Sold button is disabled until the first contracts scan completes for the active alliance.
$('#btn-contracts-sold-scan').disabled = true;

function _soldBtnDisabledMsg() {
  return _contractsScanRunning ? _SCAN_BUSY_MSG : _SCAN_FIRST_MSG;
}

$('#btn-contracts-scan')?.closest('.contract-btn-wrap')?.addEventListener('click', () => {
  if ($('#btn-contracts-scan')?.disabled) $('#contracts-status').textContent = _SCAN_BUSY_MSG;
});
$('#btn-contracts-sold-scan')?.closest('.contract-btn-wrap')?.addEventListener('click', () => {
  if ($('#btn-contracts-sold-scan')?.disabled) $('#contracts-status').textContent = _soldBtnDisabledMsg();
});
$('#btn-contracts-scan')?.closest('.contract-btn-wrap')?.addEventListener('mouseenter', () => {
  if ($('#btn-contracts-scan')?.disabled) $('#contracts-status').textContent = _SCAN_BUSY_MSG;
});
$('#btn-contracts-sold-scan')?.closest('.contract-btn-wrap')?.addEventListener('mouseenter', () => {
  if ($('#btn-contracts-sold-scan')?.disabled) $('#contracts-status').textContent = _soldBtnDisabledMsg();
});

async function runContractsScan() {
  const btnScan = $('#btn-contracts-scan');
  const btnSold = $('#btn-contracts-sold-scan');
  const status = $('#contracts-status');
  const progress = $('#contracts-progress');
  const step = progress.querySelector('.progress-step');
  const fill = progress.querySelector('.progress-fill');
  $('#contracts-hint').hidden = true;
  status.textContent = '';
  status.style.color = '';
  status.style.fontWeight = '';
  progress.hidden = false;
  step.textContent = 'starting…';
  fill.style.width = '5%';
  $('#contracts-quota-dashboard').innerHTML = '';
  $('#contracts-list').innerHTML = '';
  $('#contracts-count').textContent = '0';
  if (btnScan) btnScan.disabled = true;
  if (btnSold) btnSold.disabled = true;
  _contractsScanRunning = true;

  try {
    let res;
    try {
      res = await fetch(`${API}/api/contracts/scan?alliance=${activeContractsAlliance}`);
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

    let setupTicks = 0;
    await readNdjson(res, (evt) => {
      if (evt.event === 'progress') {
        step.textContent = evt.step || '';
        let pct;
        if (evt.phase === 'items' && evt.total > 0) {
          pct = 25 + (evt.current / evt.total) * 70; // 25%→95%
        } else {
          setupTicks += 1;
          pct = Math.min(23, 5 + setupTicks * 4); // 5%→23% for setup
        }
        fill.style.width = pct + '%';
      } else if (evt.event === 'error') {
        status.textContent = `Error: ${evt.message}`;
      } else if (evt.event === 'done') {
        lastContractsScan = evt.payload;
        contractsScanCache[activeContractsAlliance] = evt.payload;
        renderContractsDashboard(evt.payload);
        haulxQty = {};
        step.textContent = 'done';
        fill.style.width = '100%';
        setTimeout(() => { progress.hidden = true; }, 600);
        prefetchHullPrices(evt.payload.quotas || []);
        publishDoctrineStock(activeContractsAlliance, evt.payload);
        const failedItems = (evt.payload.contracts || []).filter(c => c.items_error).length;
        if (failedItems > 0) {
          status.textContent = `⚠ ESI errors: items could not be fetched for ${failedItems} contract(s) — ship counts may be lower than actual. Try re-scanning.`;
          status.style.color = '#e8a838';
          status.style.fontWeight = 'bold';
        } else {
          status.style.color = '';
          status.style.fontWeight = '';
        }
      }
    });
  } finally {
    _contractsScanRunning = false;
    if (btnScan) btnScan.disabled = false;
    // Enable sold button only if a scan result exists for this alliance.
    if (btnSold) btnSold.disabled = !contractsScanCache[activeContractsAlliance];
    const _st = $('#contracts-status');
    if (_st && (_st.textContent === _SCAN_BUSY_MSG || _st.textContent === _SCAN_FIRST_MSG)) _st.textContent = '';
  }
}

// Auto-publish the quota results so members can see current doctrine stock on
// the read-only Doctrine Stock tab. Fire-and-forget: the sidecar quietly no-ops
// when this machine has no market-history write PAT, so non-admins scanning
// their own corp never push. A tiny status note surfaces success/failure.
async function publishDoctrineStock(alliance, payload) {
  const status = $('#contracts-status');
  try {
    const res = await fetch(`${API}/api/doctrine-stock/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        alliance,
        structure_id: payload?.structure_id ?? null,
        quotas: payload?.quotas || [],
      }),
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.published && status && !status.textContent) {
      const link = data.commit_html_url
        ? ` (<a href="${escapeHtml(data.commit_html_url)}" target="_blank" rel="noopener">commit</a>)`
        : '';
      status.innerHTML = `Published ${data.quota_count} row(s) to the member Doctrine Stock dashboard${link}.`;
    }
  } catch (_) { /* offline / not configured — dashboard just stays at its last snapshot */ }
}

async function runSold30dScan() {
  const btnScan = $('#btn-contracts-scan');
  const btnSold = $('#btn-contracts-sold-scan');
  const status = $('#contracts-status');
  const progress = $('#contracts-sold-progress');
  const step = progress.querySelector('.progress-step');
  const fill = progress.querySelector('.progress-fill');
  $('#contracts-hint').hidden = true;
  status.textContent = '';
  progress.hidden = false;
  step.textContent = 'starting…';
  fill.style.width = '5%';
  if (btnScan) btnScan.disabled = true;
  if (btnSold) btnSold.disabled = true;

  try {
    let res;
    try {
      res = await fetch(`${API}/api/contracts/sold-30d/scan?alliance=${activeContractsAlliance}`);
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

    let setupTicks = 0;
    await readNdjson(res, (evt) => {
      if (evt.event === 'progress') {
        step.textContent = evt.step || '';
        let pct;
        if (evt.phase === 'items' && evt.total > 0) {
          pct = 25 + (evt.current / evt.total) * 70; // 25%→95%
        } else {
          setupTicks += 1;
          pct = Math.min(23, 5 + setupTicks * 4);
        }
        fill.style.width = pct + '%';
      } else if (evt.event === 'error') {
        status.textContent = `Error: ${evt.message}`;
      } else if (evt.event === 'done') {
        const quotas = evt.payload?.quotas || [];
        for (const q of quotas) {
          const bars = document.querySelectorAll(
            `.quota-bar[data-ship-type-id="${q.ship_type_id}"]`
          );
          for (const bar of bars) {
            const tf = (q.title_filter || '').toLowerCase();
            if (bar.dataset.titleFilter !== tf) continue;
            const soldEl = bar.querySelector('.quota-sold-count');
            if (soldEl) {
              soldEl.textContent = q.sold_30d ?? '—';
              if ((q.sold_30d ?? 0) > 0) soldEl.classList.remove('muted');
              else soldEl.classList.add('muted');
            }
          }
        }
        step.textContent = 'done';
        fill.style.width = '100%';
        setTimeout(() => { progress.hidden = true; }, 600);
      }
    });
  } finally {
    if (btnScan) btnScan.disabled = false;
    if (btnSold) btnSold.disabled = !contractsScanCache[activeContractsAlliance];
    const _st = $('#contracts-status');
    if (_st && (_st.textContent === _SCAN_BUSY_MSG || _st.textContent === _SCAN_FIRST_MSG)) _st.textContent = '';
  }
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
    quotas.forEach((q, i) => root.appendChild(renderQuotaBar(q, i)));
    sortQuotaDashboard();
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

async function prefetchHullPrices(quotas) {
  const root = $('#contracts-quota-dashboard');
  if (!root) return;
  const bars = [...root.querySelectorAll('.quota-bar')];
  // Map ship_type_id → bar element (take first match per type)
  const typeToBar = new Map();
  quotas.forEach((q, i) => {
    if (q.ship_type_id && bars[i]) typeToBar.set(q.ship_type_id, { bar: bars[i], q });
  });
  await Promise.all([...typeToBar.entries()].map(async ([typeId, { bar, q }]) => {
    if (bar.dataset.price !== '') return; // already priced from an expanded bar
    try {
      const res = await fetch(`${API}/api/market/amarr-sell?type_id=${typeId}`);
      const data = await res.json();
      if (data.min_sell != null && bar.dataset.price === '') {
        bar.dataset.price = data.min_sell * 1.15;
        if ($('#contracts-sort')?.value === 'value') sortQuotaDashboard();
      }
    } catch (_) {}
  }));
}

function sortQuotaDashboard() {
  const root = $('#contracts-quota-dashboard');
  if (!root) return;
  const order = ($('#contracts-sort')?.value) || 'priority';
  const bars = [...root.querySelectorAll('.quota-bar')];
  bars.sort((a, b) => {
    if (order === 'priority') {
      return Number(a.dataset.priority) - Number(b.dataset.priority);
    }
    if (order === 'under-quota') {
      const aEmpty = a.classList.contains('quota-empty') ? 0 : 1;
      const bEmpty = b.classList.contains('quota-empty') ? 0 : 1;
      if (aEmpty !== bEmpty) return aEmpty - bEmpty;
      return Number(b.dataset.missing) - Number(a.dataset.missing);
    }
    if (order === 'under-quota-pct') {
      return Number(a.dataset.missingPct) - Number(b.dataset.missingPct);
    }
    if (order === 'value') {
      const av = a.dataset.price !== '' ? Number(a.dataset.price) : -1;
      const bv = b.dataset.price !== '' ? Number(b.dataset.price) : -1;
      return bv - av;
    }
    // default: ship name
    return (a.dataset.shipName || '').localeCompare(b.dataset.shipName || '');
  });
  bars.forEach((el) => root.appendChild(el));
}

$('#contracts-sort')?.addEventListener('change', sortQuotaDashboard);

function renderQuotaBar(q, priority = 0) {
  const required = Number(q.required) || 0;
  const available = Number(q.available) || 0;
  const missing = Number(q.missing) || 0;
  const pct = required > 0 ? Math.min(100, Math.round((available / required) * 100)) : 0;
  const state = required === 0 ? 'unset' : available >= required ? 'ok' : available > 0 ? 'partial' : 'empty';
  const div = document.createElement('div');
  div.className = `quota-bar quota-${state}`;
  div.dataset.priority = priority;
  div.dataset.shipName = (q.ship_name || q.name || '').toLowerCase();
  div.dataset.shipTypeId = q.ship_type_id || '';
  div.dataset.titleFilter = (q.title_filter || '').toLowerCase();
  div.dataset.missing = missing;
  div.dataset.missingPct = required > 0 ? (available / required) * 100 : 0;
  div.dataset.price = '';
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
        <button type="button" class="quota-price-refresh" title="Refresh price" hidden>↻</button>
      </div>
      <div class="quota-expand-row">
        <span class="quota-expand-label">Sold last 30 days</span>
        <span class="quota-sold-count muted">—</span>
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
  const refreshBtn = div.querySelector('.quota-price-refresh');
  let priceLoaded = false;

  async function loadQuotaPrice(bust = false) {
    const priceEl = div.querySelector('.quota-amarr-price');
    const labelEl = div.querySelector('.quota-expand-label');
    const bustParam = bust ? '&bust=1' : '';
    expandRow.style.cursor = 'default';
    refreshBtn.hidden = true;
    const fmt = fmtIsk;
    const fmtM = fmtMillions;
    const panel = div.querySelector('.quota-expand-panel');
    function markEsi() {
      priceEl.classList.add('esi-fallback');
      panel.querySelector('.quota-esi-notice')?.remove();
      const notice = document.createElement('div');
      notice.className = 'quota-esi-notice';
      notice.textContent = '⚠ ESI prices — add a Janice API key in Config for accuracy';
      panel.appendChild(notice);
    }
    panel.querySelector('.quota-esi-notice')?.remove();
    priceEl.classList.remove('esi-fallback');
    try {
      // Fast path: price from a matching contract already in memory (skips Auth lookup).
      const matchedContractId = q.contracts?.[0]?.contract_id;
      const scanContract = matchedContractId != null
        ? lastContractsScan?.contracts?.find((c) => c.contract_id === matchedContractId)
        : null;
      const contractPricingItems = scanContract?.items
        ?.filter((i) => i.is_included !== false && i.type_id)
        .map((i) => ({ typeId: i.type_id, name: i.name || String(i.type_id), qty: i.quantity }))
        ?? null;

      if (contractPricingItems?.length) {
        priceEl.textContent = 'pricing…';
        const uniqueIds = [...new Set(contractPricingItems.map((i) => i.typeId))];
        const priceResults = await Promise.all(
          uniqueIds.map((tid) =>
            fetch(`${API}/api/market/amarr-sell?type_id=${tid}${bustParam}`).then((r) => r.json()).catch(() => null)
          )
        );
        const priceMap = new Map();
        priceResults.forEach((p, i) => { if (p?.min_sell != null) priceMap.set(uniqueIds[i], p.min_sell); });
        if (priceResults.find((p) => p?.source)?.source === 'esi') markEsi();
        let total = 0;
        const unpriced = [];
        for (const item of contractPricingItems) {
          const p = priceMap.get(item.typeId);
          if (p != null) total += p * item.qty;
          else unpriced.push({ name: item.name, qty: item.qty });
        }
        if (labelEl) labelEl.textContent = 'Contract price (115% Amarr sell · from contracts)';
        if (total > 0) {
          div.dataset.price = total * 1.15;
          priceEl.textContent = `${fmtM(total * 1.15)}  (base: ${fmt(total)})`;
          priceEl.classList.remove('muted');
          if (unpriced.length) renderUnpricedToggle(priceEl, unpriced);
        } else {
          priceEl.textContent = 'no Amarr prices found for contract items';
        }
        return;
      }

      // Fallback: Auth fit lookup.
      let fitDetail = null;
      let fitFoundOnAuth = false;
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
          if (candidate && !hullMismatch) { fitDetail = candidate; fitFoundOnAuth = true; }
        }
      }

      if (fitDetail?.items?.length) {
        // Price everything in the buy-all list: hull, modules, ammo, scripts, nanite paste
        const pricingItems = fitDetail.items.map((i) => ({ typeId: i.typeId || null, name: i.name, qty: i.qty }));

        const uniqueIds = [...new Set(pricingItems.filter((i) => i.typeId).map((i) => i.typeId))];
        const priceResults = await Promise.all(
          uniqueIds.map((tid) =>
            fetch(`${API}/api/market/amarr-sell?type_id=${tid}${bustParam}`).then((r) => r.json()).catch(() => null)
          )
        );
        const priceMap = new Map();
        priceResults.forEach((p, i) => { if (p?.min_sell != null) priceMap.set(uniqueIds[i], p.min_sell); });
        if (priceResults.find((p) => p?.source)?.source === 'esi') markEsi();

        let total = 0;
        const unpriced = [];
        for (const item of pricingItems) {
          const p = item.typeId ? priceMap.get(item.typeId) : null;
          if (p != null) total += p * item.qty;
          else unpriced.push({ name: item.name, qty: item.qty });
        }

        if (labelEl) labelEl.textContent = 'Contract price (115% Amarr sell · full fit)';
        if (total > 0) {
          div.dataset.price = total * 1.15;
          priceEl.textContent = `${fmtM(total * 1.15)}  (base: ${fmt(total)})`;
          priceEl.classList.remove('muted');
          if (unpriced.length) renderUnpricedToggle(priceEl, unpriced);
        } else {
          priceEl.textContent = 'no Amarr prices found for fit items';
        }
      } else {
        const notInAuth = _fitIndexByType.size > 0 && !fitFoundOnAuth;
        priceEl.textContent = 'loading…';
        const res = await fetch(`${API}/api/market/amarr-sell?type_id=${q.ship_type_id}${bustParam}`);
        const data = await res.json();
        if (notInAuth) {
          if (labelEl) {
            labelEl.textContent = '⚠ Not in alliance fits — hull price only';
            labelEl.classList.add('quota-not-in-auth');
          }
          expandRow.classList.add('quota-row-warning');
        } else if (fitFoundOnAuth) {
          if (labelEl) labelEl.textContent = 'Alliance fit found — hull price only (no buy list on Auth)';
        } else {
          if (labelEl) labelEl.textContent = 'Contract price (115% Amarr sell · hull only)';
        }
        if (data.min_sell != null) {
          if (data.source === 'esi') markEsi();
          div.dataset.price = data.min_sell * 1.15;
          priceEl.textContent = `${fmtM(data.min_sell * 1.15)}  (base: ${fmt(data.min_sell)})`;
          priceEl.classList.remove('muted');
        } else {
          priceEl.textContent = 'no sell orders in Amarr';
        }
      }
    } catch {
      priceEl.textContent = 'error fetching price';
    } finally {
      refreshBtn.hidden = false;
      if ($('#contracts-sort')?.value === 'value') sortQuotaDashboard();
    }
  }

  async function loadSold30d() {
    const soldEl = div.querySelector('.quota-sold-count');
    if (!soldEl || !q.ship_type_id) return;
    soldEl.textContent = '…';
    try {
      const params = new URLSearchParams({ ship_type_id: q.ship_type_id, alliance: activeContractsAlliance });
      if (q.title_filter) params.set('title_filter', q.title_filter);
      const res = await fetch(`${API}/api/contracts/sold-30d?${params}`);
      const data = await res.json();
      if (data.sold_30d != null) {
        soldEl.textContent = data.sold_30d;
        if (data.sold_30d > 0) soldEl.classList.remove('muted');
      } else {
        soldEl.textContent = '—';
      }
    } catch {
      soldEl.textContent = '—';
    }
  }

  expandRow.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (e.target === refreshBtn) return; // handled by its own listener
    if (priceLoaded) return;
    priceLoaded = true;
    await loadQuotaPrice(false);
  });

  refreshBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await loadQuotaPrice(true);
  });

  const soldRow = div.querySelectorAll('.quota-expand-row')[1];
  let soldLoaded = false;
  soldRow.style.cursor = 'pointer';
  soldRow.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (soldLoaded) return;
    soldLoaded = true;
    soldRow.style.cursor = 'default';
    await loadSold30d();
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

async function exportForDiscord() {
  if (!lastContractsScan) {
    alert('Run a scan first.');
    return;
  }
  const quotas = lastContractsScan.quotas || [];
  const header = ['Ship / Fit name', 'Quota', 'On hand'];
  const rows = quotas.map((q) => {
    const ship = q.ship_name || '';
    const fit = q.name || '';
    const label = ship && fit ? `${ship} ${fit}` : ship || fit || `type ${q.ship_type_id}`;
    return [label, String(q.required || 0), String(q.available || 0)];
  });
  const w0 = Math.max(header[0].length, ...rows.map((r) => r[0].length));
  const w1 = Math.max(header[1].length, ...rows.map((r) => r[1].length));
  const w2 = Math.max(header[2].length, ...rows.map((r) => r[2].length));
  const fmt = ([name, quota, onhand]) =>
    `${name.padEnd(w0)} | ${quota.padStart(w1)} | ${onhand.padStart(w2)}`;
  const divider = `${'-'.repeat(w0)}-+-${'-'.repeat(w1)}-+-${'-'.repeat(w2)}`;
  const lines = ['```', fmt(header), divider, ...rows.map(fmt), '```'];
  const text = lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    $('#contracts-status').textContent = `Copied Discord table (${rows.length} rows) to clipboard.`;
  } catch (e) {
    alert(text);
  }
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
  const root = $('#contracts-quota-dashboard');
  const bars = root ? [...root.querySelectorAll('.quota-bar')] : [];
  const quotasByTypeId = Object.fromEntries(
    (lastContractsScan.quotas || []).map((q) => [String(q.ship_type_id), q])
  );
  const orderedQuotas = bars.length
    ? bars.map((el) => quotasByTypeId[el.dataset.shipTypeId]).filter(Boolean)
    : (lastContractsScan.quotas || []);
  for (const q of orderedQuotas) {
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
// Acquisitions tab
// ============================================================

let acquisitionsHulls = [];  // [{type_id, name, quantity}]
let acquisitionsItems = [];  // [{type_id, name, quantity}]

async function acquisitionsLoad() {
  try {
    const data = await fetch(`${API}/api/acquisitions`).then((r) => r.json());
    acquisitionsHulls = data.hulls || [];
    acquisitionsItems = data.items || [];
  } catch (_) {}
}

async function acquisitionsSave() {
  try {
    await fetch(`${API}/api/acquisitions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hulls: acquisitionsHulls, items: acquisitionsItems }),
    });
  } catch (_) {}
}

function renderAcquisitionsTable(items) {
  if (!items.length) return '<p class="muted" style="font-size:0.875rem;padding:0.5rem 0">Nothing yet — paste inventory above and click Parse.</p>';
  return `<table style="width:100%;border-collapse:collapse;font-size:0.875rem;margin-top:0.5rem">
    <thead>
      <tr style="text-align:left;color:#8899aa;border-bottom:1px solid #2e3a4e">
        <th style="padding:0.35rem 0.5rem">Name</th>
        <th style="padding:0.35rem 0.5rem;text-align:right">Qty</th>
        <th style="padding:0.35rem 0.75rem;text-align:right">Type ID</th>
      </tr>
    </thead>
    <tbody>
      ${items.map((it) => `
      <tr style="border-bottom:1px solid #1e2533">
        <td style="padding:0.35rem 0.5rem">${escapeHtml(it.name)}</td>
        <td style="padding:0.35rem 0.5rem;text-align:right">${it.quantity.toLocaleString()}</td>
        <td style="padding:0.35rem 0.75rem;text-align:right;color:#8899aa">${it.type_id}</td>
      </tr>`).join('')}
    </tbody>
  </table>`;
}

function renderAcquisitionsSection(root, id, title, items, onParse, onClear) {
  const section = document.createElement('div');
  section.id = id;
  section.style.cssText = 'margin-bottom:2rem';
  section.innerHTML = `
    <h3 style="margin:0 0 0.5rem">${escapeHtml(title)}</h3>
    <textarea id="${id}-paste" rows="6" style="width:100%;background:#151c28;border:1px solid #2e3a4e;color:#e0e8f0;border-radius:4px;padding:0.5rem;font-size:0.8rem;resize:vertical;box-sizing:border-box"
      placeholder="Paste EVE inventory here — Name [tab] Qty, one per line"></textarea>
    <div style="display:flex;gap:0.5rem;margin-top:0.4rem;align-items:center">
      <button id="${id}-parse" class="btn">Parse</button>
      <button id="${id}-clear" class="link-btn" style="color:#8899aa">Clear</button>
      <span id="${id}-status" style="font-size:0.8rem;color:#8899aa;margin-left:0.5rem"></span>
    </div>
    <div id="${id}-table"></div>`;
  root.appendChild(section);

  const textarea = section.querySelector(`#${id}-paste`);
  const parseBtn = section.querySelector(`#${id}-parse`);
  const clearBtn = section.querySelector(`#${id}-clear`);
  const statusEl = section.querySelector(`#${id}-status`);
  const tableEl = section.querySelector(`#${id}-table`);

  tableEl.innerHTML = renderAcquisitionsTable(items);

  parseBtn.addEventListener('click', () => onParse(textarea, tableEl, statusEl));
  clearBtn.addEventListener('click', () => onClear(textarea, tableEl, statusEl));
  textarea.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      onParse(textarea, tableEl, statusEl);
    }
  });
}

async function acquisitionsParse(textarea, tableEl, statusEl, isHulls) {
  const text = textarea.value.trim();
  if (!text) { statusEl.textContent = 'Nothing to parse.'; return; }
  statusEl.textContent = 'Parsing…';
  try {
    const data = await fetch(`${API}/api/acquisitions/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paste_text: text }),
    }).then((r) => r.json());
    if (data.detail) throw new Error(data.detail);
    const items = data.items || [];
    if (isHulls) acquisitionsHulls = items; else acquisitionsItems = items;
    tableEl.innerHTML = renderAcquisitionsTable(items);
    statusEl.textContent = `${items.length} item${items.length !== 1 ? 's' : ''} resolved.`;
    await acquisitionsSave();
  } catch (e) {
    statusEl.textContent = `Error: ${e.message}`;
  }
}

function acquisitionsClear(textarea, tableEl, statusEl, isHulls) {
  textarea.value = '';
  if (isHulls) acquisitionsHulls = []; else acquisitionsItems = [];
  tableEl.innerHTML = renderAcquisitionsTable([]);
  statusEl.textContent = '';
  acquisitionsSave();
}

function renderAcquisitionsTab() {
  const root = $('#acquisitions-root');
  if (!root) return;
  root.innerHTML = '';

  const header = document.createElement('div');
  header.innerHTML = `
    <h2>Acquisitions</h2>
    <p class="muted">Track what's already on hand so Plan HaulX can show accurate shortfalls.
    Paste your hull inventory and item inventory (modules, ammo, etc.) using the standard
    EVE clipboard format — Name, then a tab, then quantity, one line per item.
    Changes are saved automatically and survive app restarts.</p>`;
  root.appendChild(header);

  renderAcquisitionsSection(
    root, 'acq-hulls', 'Hull Inventory', acquisitionsHulls,
    (ta, tbl, st) => acquisitionsParse(ta, tbl, st, true),
    (ta, tbl, st) => acquisitionsClear(ta, tbl, st, true),
  );
  renderAcquisitionsSection(
    root, 'acq-items', 'Item Inventory', acquisitionsItems,
    (ta, tbl, st) => acquisitionsParse(ta, tbl, st, false),
    (ta, tbl, st) => acquisitionsClear(ta, tbl, st, false),
  );
}

// Load acquisitions inventory on startup
acquisitionsLoad();

// ============================================================
// Plan HaulX tab
// ============================================================

const HAULX_MAX_VOLUME = 360000;  // m³ (360 km³)
const HAULX_MAX_COLLATERAL = 5_000_000_000;  // ISK

const haulxPriceCache = {};     // type_id -> { min_sell, packaged_volume }
const haulxItemPriceCache = {}; // type_id -> jita min_sell (for fit items)
let haulxQty = {};  // type_id (string) -> qty (number)
let haulxOverQuota = false;
let haulxReadinessScanDone = false;  // true only after a readiness scan in this session

function haulxTotals() {
  let vol = 0, isk = 0;
  for (const [tid, qty] of Object.entries(haulxQty)) {
    if (!qty) continue;
    const p = haulxPriceCache[tid];
    if (p) {
      vol += qty * (p.packaged_volume || 0);
      isk += qty * (p.fit_price != null ? p.fit_price : (p.min_sell || 0));
    }
  }
  return { vol, isk };
}

function haulxUpdateTotals() {
  const { vol, isk } = haulxTotals();
  const volEl = $('#haulx-vol');
  const iskEl = $('#haulx-isk');
  const copyBtn = $('#haulx-copy');
  if (!volEl) return;

  const volKm3 = vol / 1000;
  volEl.textContent = `${volKm3.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} / 360.0 km³`;
  volEl.classList.toggle('haulx-over', vol > HAULX_MAX_VOLUME);

  const iskB = isk / 1_000_000_000;
  iskEl.textContent = `${iskB.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}B / 5.00B ISK`;
  iskEl.classList.toggle('haulx-over', isk > HAULX_MAX_COLLATERAL);

  const anySelected = Object.values(haulxQty).some((q) => q > 0);
  if (copyBtn) copyBtn.disabled = !anySelected;
}

async function haulxFetchPrices(quotas) {
  const fits = readinessState.scan?.fits || {};
  const fitsByHull = {};
  for (const fit of Object.values(fits)) {
    const key = String(fit.hullTypeId);
    if (!fitsByHull[key]) fitsByHull[key] = [];
    fitsByHull[key].push(fit);
  }

  // Collect all type IDs we need prices for: hulls + all fit items
  const allTypeIds = new Set();
  for (const q of quotas || []) {
    allTypeIds.add(String(q.ship_type_id));
    const candidates = fitsByHull[String(q.ship_type_id)] || [];
    const fit = candidates.find((f) => f.name === q.name) || candidates[0];
    for (const item of fit?.items || []) allTypeIds.add(String(item.typeId));
  }

  // Fetch any uncached prices
  const uncachedIds = [...allTypeIds].filter((tid) => !(tid in haulxItemPriceCache));
  await Promise.all(
    uncachedIds.map((tid) =>
      fetch(`${API}/api/market/jita-sell?type_id=${tid}`)
        .then((r) => r.json())
        .then((data) => {
          haulxItemPriceCache[tid] = data.min_sell ?? null;
          // Hull entries also get volume stored in haulxPriceCache
          if (!haulxPriceCache[tid]) {
            haulxPriceCache[tid] = { min_sell: data.min_sell, packaged_volume: data.packaged_volume };
          }
        })
        .catch(() => { haulxItemPriceCache[tid] = null; })
    )
  );

  // Now compute fit_price per quota and update rows
  for (const q of quotas || []) {
    const tid = String(q.ship_type_id);
    const candidates = fitsByHull[tid] || [];
    const fit = candidates.find((f) => f.name === q.name) || candidates[0];

    // Ensure hull cache entry exists
    if (!haulxPriceCache[tid]) {
      haulxPriceCache[tid] = { min_sell: haulxItemPriceCache[tid] ?? null, packaged_volume: null };
    }

    let fitTotal = null;
    if (fit?.items?.length) {
      let sum = 0;
      let allPriced = true;
      for (const item of fit.items) {
        const p = haulxItemPriceCache[String(item.typeId)];
        if (p == null) { allPriced = false; break; }
        sum += p * item.qty;
      }
      if (allPriced) fitTotal = sum * 1.15;
    }
    haulxPriceCache[tid].fit_price = fitTotal;

    // Update rendered row if visible
    const row = $(`#haulx-row-${tid}`);
    if (row) {
      const volEl = row.querySelector('.haulx-row-vol');
      const priceEl = row.querySelector('.haulx-row-price');
      const vol = haulxPriceCache[tid].packaged_volume;
      if (volEl) volEl.textContent = vol != null ? `${(vol / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} km³` : '—';
      if (priceEl) priceEl.textContent = fitTotal != null
        ? `${(fitTotal / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}M`
        : (fit ? '…' : '—');
      row.querySelector('.haulx-loading')?.remove();
    }
  }
  haulxUpdateTotals();
}

function renderHaulxTab() {
  const root = $('#haulx-root');
  if (!root) return;

  const hasContracts = !!lastContractsScan;
  const hasReadiness = haulxReadinessScanDone;

  if (!hasContracts || !hasReadiness) {
    const items = [
      !hasContracts && '<li>Run a <strong>Contracts</strong> scan (Contracts tab → Scan)</li>',
      !hasReadiness && '<li>Run a <strong>Market Readiness</strong> scan (Market Readiness tab → Scan doctrines &amp; fits)</li>',
    ].filter(Boolean).join('');
    root.innerHTML = `
      <h2>HaulX</h2>
      <p class="muted">Before you can plan a haul, complete the following:</p>
      <ul style="color:#e0e8f0;line-height:2">${items}</ul>`;
    return;
  }

  const quotas = lastContractsScan.quotas || [];

  root.innerHTML = `
    <h2>HaulX</h2>
    <p class="muted">Select how many of each under-quota ship to include in a PushX haul from Amarr to Jita. The volume and collateral totals update as you add ships — keep volume under <strong>360 km³</strong> and collateral (Jita sell) under <strong>5B ISK</strong>. Ships already at quota are shown greyed-out but can still be included. Hit <strong>Copy Haul List</strong> when you're ready to paste into your courier contract.</p>
    <div id="haulx-header" style="display:flex;align-items:center;gap:1.5rem;padding:0.75rem 1rem;background:#1e2533;border-bottom:1px solid #2e3a4e;position:sticky;top:var(--app-header-h,0px);z-index:10">
      <span style="font-weight:600">HaulX</span>
      <span style="font-size:0.85rem">Volume: <strong id="haulx-vol" class="haulx-metric">— / 360.0 km³</strong></span>
      <span style="font-size:0.85rem">Collateral: <strong id="haulx-isk" class="haulx-metric">—B / 5.00B ISK</strong></span>
      <button id="haulx-copy" class="link-btn" disabled style="margin-left:auto">Shopping cart</button>
      <button id="haulx-fill-priority" class="link-btn">Fill by priority</button>
      <label style="display:flex;align-items:center;gap:0.4rem;font-size:0.85rem;cursor:pointer">
        <input type="checkbox" id="haulx-over-quota" ${haulxOverQuota ? 'checked' : ''}> Allow over quota
      </label>
    </div>
    <table id="haulx-table" style="width:100%;border-collapse:collapse;font-size:0.875rem">
      <thead style="position:sticky;top:calc(var(--app-header-h,0px) + 48px);z-index:9;background:#1e1e1e">
        <tr style="text-align:left;color:#8899aa;border-bottom:1px solid #2e3a4e">
          <th style="padding:0.5rem 1rem">Ship</th>
          <th style="padding:0.5rem 0.5rem">Missing</th>
          <th style="padding:0.5rem 0.5rem">On hand</th>
          <th style="padding:0.5rem 0.5rem">Qty</th>
          <th style="padding:0.5rem 0.5rem">Vol/ship</th>
          <th style="padding:0.5rem 1rem">Price (Jita)</th>
        </tr>
      </thead>
      <tbody id="haulx-tbody"></tbody>
    </table>`;

  const tbody = $('#haulx-tbody');

  // Respect current contracts sort order if bars are rendered
  const contractsRoot = $('#contracts-quota-dashboard');
  const bars = contractsRoot ? [...contractsRoot.querySelectorAll('.quota-bar')] : [];
  const quotasByTypeId = Object.fromEntries(quotas.map((q) => [String(q.ship_type_id), q]));
  const orderedQuotas = bars.length
    ? bars.map((el) => quotasByTypeId[el.dataset.shipTypeId]).filter(Boolean)
    : quotas;

  const onHandByTypeId = Object.fromEntries(acquisitionsHulls.map((h) => [String(h.type_id), h.quantity]));

  const fitsByHull = {};
  for (const fit of Object.values(readinessState.scan?.fits || {})) {
    const key = String(fit.hullTypeId);
    if (!fitsByHull[key]) fitsByHull[key] = [];
    fitsByHull[key].push(fit);
  }

  for (const q of orderedQuotas) {
    const tid = String(q.ship_type_id);
    const missing = Number(q.missing) || 0;
    const atQuota = missing <= 0;
    const price = haulxPriceCache[tid];
    const qty = haulxQty[tid] || 0;
    const rowMax = haulxOverQuota ? 999 : (atQuota ? 10 : missing);
    const onHand = onHandByTypeId[tid] || 0;
    const hasFit = (fitsByHull[tid]?.length || 0) > 0;

    const volText = price?.packaged_volume != null
      ? `${(price.packaged_volume / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} km³`
      : '<span class="haulx-loading muted">…</span>';
    const priceText = price?.fit_price != null
      ? `${(price.fit_price / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}M`
      : '<span class="haulx-loading muted">…</span>';

    const tr = document.createElement('tr');
    tr.id = `haulx-row-${tid}`;
    tr.style.cssText = atQuota ? 'opacity:0.45;border-bottom:1px solid #1e2533' : 'border-bottom:1px solid #1e2533';
    tr.innerHTML = `
      <td style="padding:0.5rem 1rem${hasFit ? '' : ';color:#ef4444'}">
        <strong>${escapeHtml(q.ship_name || q.name || `type ${tid}`)}</strong>
        ${q.name && q.ship_name && q.name !== q.ship_name ? `<span style="font-size:0.8rem;margin-left:0.4rem;opacity:0.7">${escapeHtml(q.name)}</span>` : ''}
        ${hasFit ? '' : '<span style="font-size:0.75rem;margin-left:0.4rem;opacity:0.8">(no fit)</span>'}
      </td>
      <td style="padding:0.5rem 0.5rem;color:${missing > 0 ? '#e8a838' : '#4a8'}">${missing > 0 ? missing : '✓'}</td>
      <td style="padding:0.5rem 0.5rem;color:${onHand > 0 ? '#4a8' : '#8899aa'}">${onHand > 0 ? onHand : '—'}</td>
      <td style="padding:0.5rem 0.5rem">
        <input type="number" class="haulx-qty" data-tid="${tid}" value="${qty}" min="0" max="${rowMax}" style="width:4rem;background:#151c28;border:1px solid #2e3a4e;color:#e0e8f0;border-radius:3px;padding:2px 6px;text-align:center">
        <button class="haulx-max link-btn" data-tid="${tid}" data-max="${rowMax}" style="margin-left:0.3rem;font-size:0.75rem">max</button>
      </td>
      <td class="haulx-row-vol" style="padding:0.5rem 0.5rem;color:#8899aa">${volText}</td>
      <td class="haulx-row-price" style="padding:0.5rem 1rem;color:#8899aa">${priceText}</td>`;
    tbody.appendChild(tr);
  }

  tbody.addEventListener('input', (e) => {
    const input = e.target.closest('.haulx-qty');
    if (!input) return;
    haulxQty[input.dataset.tid] = Math.max(0, parseInt(input.value) || 0);
    haulxUpdateTotals();
  });

  tbody.addEventListener('click', (e) => {
    const btn = e.target.closest('.haulx-max');
    if (!btn) return;
    const tid = btn.dataset.tid;
    const max = parseInt(btn.dataset.max) || 0;
    const input = tbody.querySelector(`.haulx-qty[data-tid="${tid}"]`);
    if (input) input.value = max;
    haulxQty[tid] = max;
    haulxUpdateTotals();
  });

  $('#haulx-copy')?.addEventListener('click', async () => {
    // Build selected list: [{q, qty}]
    const selected = [];
    for (const tr of tbody.querySelectorAll('tr')) {
      const input = tr.querySelector('.haulx-qty');
      if (!input) continue;
      const qty = parseInt(input.value) || 0;
      if (!qty) continue;
      const tid = input.dataset.tid;
      const q = (lastContractsScan.quotas || []).find((x) => String(x.ship_type_id) === tid);
      if (q) selected.push({ q, qty });
    }

    // Try to find fit items from readinessState.scan for each selected ship.
    // Match by hullTypeId + fit name (q.name). Fall back to hull-only if no fit found.
    const fits = readinessState.scan?.fits || {};
    const fitsByHull = {};
    for (const fit of Object.values(fits)) {
      const key = String(fit.hullTypeId);
      if (!fitsByHull[key]) fitsByHull[key] = [];
      fitsByHull[key].push(fit);
    }

    const hullLines = [];
    const moduleAgg = {};  // name -> qty

    for (const { q, qty } of selected) {
      const tid = String(q.ship_type_id);
      const hullName = q.ship_name || q.name || `type ${tid}`;
      hullLines.push(`${qty} x ${hullName}`);

      // Find the matching fit by hullTypeId, preferring one whose name matches q.name
      const candidates = fitsByHull[tid] || [];
      let fit = candidates.find((f) => f.name === q.name) || candidates[0];
      if (!fit) continue;

      // Aggregate non-hull items (hull is index 0, typeId === ship_type_id)
      for (const item of fit.items || []) {
        if (item.typeId === q.ship_type_id) continue;  // skip hull itself
        const key = item.name;
        moduleAgg[key] = (moduleAgg[key] || 0) + item.qty * qty;
      }
    }

    const moduleLines = Object.entries(moduleAgg).map(([name, q]) => `${q} x ${name}`);
    const sections = [];
    if (hullLines.length) sections.push(hullLines.join('\n'));
    if (moduleLines.length) sections.push(moduleLines.join('\n'));
    const text = sections.join('\n\n') || 'Nothing selected.';

    try {
      await navigator.clipboard.writeText(text);
    } catch {
      alert(text);
    }
  });

  $('#haulx-fill-priority')?.addEventListener('click', () => {
    // Reset all qtys, then fill by priority order (config order) until a limit is hit.
    // Uses lastContractsScan.quotas which is always in priority order.
    haulxQty = {};
    let vol = 0, isk = 0;
    for (const q of lastContractsScan.quotas || []) {
      const missing = Number(q.missing) || 0;
      if (!haulxOverQuota && missing <= 0) continue;
      const tid = String(q.ship_type_id);
      const p = haulxPriceCache[tid];
      const unitVol = p?.packaged_volume || 0;
      const unitIsk = p?.fit_price != null ? p.fit_price : (p?.min_sell || 0);
      let canFit = haulxOverQuota ? 999 : missing;
      if (unitVol > 0) canFit = Math.min(canFit, Math.floor((HAULX_MAX_VOLUME - vol) / unitVol));
      if (unitIsk > 0) canFit = Math.min(canFit, Math.floor((HAULX_MAX_COLLATERAL - isk) / unitIsk));
      if (canFit <= 0) continue;
      haulxQty[tid] = canFit;
      vol += canFit * unitVol;
      isk += canFit * unitIsk;
    }
    // Sync inputs
    for (const input of tbody.querySelectorAll('.haulx-qty')) {
      input.value = haulxQty[input.dataset.tid] || 0;
    }
    haulxUpdateTotals();
  });

  $('#haulx-over-quota')?.addEventListener('change', (e) => {
    haulxOverQuota = e.target.checked;
    renderHaulxTab();
  });

  haulxFetchPrices(orderedQuotas);
  haulxUpdateTotals();
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
// Janice-style detail: Buy / Split / Sell totals with percentage-modifier
// chips on every figure).

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
  const janiceUrl = j.code ? `https://janice.e-351.com/a/${escapeHtml(j.code)}` : '';
  const linkBlock = janiceUrl
    ? `<div class="appraise-linkrow">
        <span class="muted">Janice link:</span>
        <code class="appraise-url copyable" role="button" tabindex="0" title="Click to copy" data-copy="${janiceUrl}">${janiceUrl}</code>
        <button type="button" class="appraise-url-copy copyable secondary" data-copy="${janiceUrl}">Copy</button>
        <a href="${janiceUrl}" target="_blank" rel="noopener" class="appraise-url-open">Open ↗</a>
      </div>`
    : `<div class="appraise-linkrow muted">No shareable link generated — tick "Save a shareable Janice link" above and re-run to get a copyable URL.</div>`;
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
      <h3>Janice appraisal</h3>
      ${fallback}
      ${linkBlock}
      <div class="appraise-line">
        <span class="muted">Items priced:</span>
        <strong>${j.item_count || 0}</strong>
        <span class="muted"> · Market:</span>
        <strong>${escapeHtml(mkt)}</strong>
        <span class="muted"> · Source:</span>
        <strong>${escapeHtml(j.source || '?')}</strong>
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

  root.innerHTML = janiceBlock;
}

// Delegated click-to-copy for any .copyable span in the appraisal result.
// Mirrors the .payout-copy pattern used elsewhere; one shared handler so
// new copyable elements pick it up automatically.
document.addEventListener('click', async (e) => {
  const el = e.target.closest('#appraise-result .copyable, #readiness-content .copyable');
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
      status.textContent = `done · ${data.janice?.item_count || 0} items via Janice`;
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

// ===================== SRP (Ship Replacement Program) =====================
// Scrapes outstanding SRP requests from Alliance Auth (/srp/ -> each fleet's
// /srp/<id>/view/) via the same authed session the Doctrines tab uses, then
// computes a recommended payout per the navy wiki scheme:
//   payout = rate x killboard-loss-value, with an optional per-category cap.
// Read + compute only for now; write actions (set value / approve / delete)
// land once srp_management permissions are granted.

const SRP_CATS = {
  standard:    { label: 'Standard 75%',             rate: 0.75, cap: 0 },
  logistics:   { label: 'Logistics 100%',           rate: 1.00, cap: 0 },
  links:       { label: 'Links 100%',               rate: 1.00, cap: 0 },
  interdictor: { label: 'Interdictor 100%',         rate: 1.00, cap: 0 },
  fightclub:   { label: 'Fight Club 100% (cap 10M)', rate: 1.00, cap: 10_000_000 },
  hisecnpc:    { label: 'Hisec NPC 100% (cap 5M)',   rate: 1.00, cap: 5_000_000 },
};
const SRP_CAT_ORDER = ['standard', 'logistics', 'links', 'interdictor', 'fightclub', 'hisecnpc'];
// Hulls we can classify unambiguously by EVE group. Links/Fight Club/Hisec-NPC
// are context-dependent (a hull alone can't tell), so they stay manual.
const SRP_LOGI_GROUPS = new Set(['logistics', 'logistics frigate']);
const SRP_DICTOR_GROUPS = new Set(['interdictor']);

let srpState = { fleets: [], rows: [], view: 'list', fleetId: null, csrf: null, wallet: null, scanned: false };

function srpAutoCategory(shipName) {
  const g = (shipTypesByNameMap?.get((shipName || '').toLowerCase())?.group_name || '').toLowerCase();
  if (SRP_LOGI_GROUPS.has(g)) return 'logistics';
  if (SRP_DICTOR_GROUPS.has(g)) return 'interdictor';
  return 'standard';
}

function srpPayout(category, lossAmt) {
  const c = SRP_CATS[category] || SRP_CATS.standard;
  let p = Math.round((lossAmt || 0) * c.rate);
  if (c.cap > 0) p = Math.min(p, c.cap);
  return p;
}

// Classify a batch of requests off their killmails: the server pulls the real
// hull and the *fitted modules* (via the zKill link we already parsed) and
// derives a category from the fit — command bursts -> Links, remote reps ->
// Logi — so a links T3D / Nighthawk or a T1 cruiser logi is recognised from
// what it actually fitted, not the hull name. Each row is also cross-checked
// against the Auth doctrine list (eligibility stays the reviewer's call).
async function srpClassifyRows(rows, onProgress) {
  // Build the doctrine fit index (same one the readiness/quota views use) in
  // parallel with the killmail classification request.
  const fitIndexReady = (async () => {
    try {
      if (!_fitIndexBuilding) _fitIndexBuilding = buildFitIndex();
      await _fitIndexBuilding;
    } catch (_) {}
  })();

  const ids = [...new Set(rows.map((r) => parseInt(r.killId, 10)).filter(Boolean))];
  let results = {};
  if (ids.length) {
    // Stream the classification: kills are characterised in parallel server-side
    // and each completion arrives as an NDJSON line, so we can show per-kill
    // progress instead of blocking on the whole batch.
    try {
      const res = await fetch(`${API}/api/srp/classify/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kill_ids: ids }),
      });
      if (res.ok && res.body) {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
            if (ev.event === 'progress') {
              if (onProgress) onProgress(ev.done || 0, ev.total || ids.length);
            } else if (ev.event === 'done') {
              results = ev.results || results;
            }
          }
        }
      } else if (res.ok) {
        results = (await res.json()).results || {}; // non-streaming fallback
      }
    } catch (_) { /* leave rows on their hull-name guess */ }
  }
  await fitIndexReady;

  for (const r of rows) {
    const c = results[String(r.killId)];
    if (c && c.ok) {
      if (c.hull) r.hull = c.hull;       // authoritative hull from the killmail
      r.detect = { links: !!c.links, logi: !!c.logi, npc: !!c.npc, hisec: !!c.hisec, modules: c.modules || [] };
      r.category = c.category || r.category;
    } else {
      r.detect = c ? { error: c.error || 'classify failed', modules: [] } : null;
    }
    // Doctrine membership: does this hull appear in any Auth doctrine fit?
    // null = unknown (index unavailable, e.g. not signed in to Auth).
    const hullName = (r.hull || r.ship || '').toLowerCase();
    const bucket = _fitIndexByType.get(hullName) || [];
    r.inDoctrine = _fitIndexByType.size > 0 ? bucket.length > 0 : null;
    r.doctrineFits = bucket.map((b) => b.fitName);
  }
}

// Small inline notes under the ship name: detected fit-role + a doctrine flag.
const SRP_ROLE_LABEL = { links: 'Links', logistics: 'Logi', interdictor: 'Dictor' };
function srpDetectBadge(r) {
  const bits = [];
  const d = r.detect;
  if (d && (d.links || d.logi) && (d.modules || []).length) {
    // Role proven by what was actually fitted on the killmail.
    const role = d.links ? 'Links' : 'Logi';
    bits.push(`<span class="srp-detect" title="From killmail fit: ${escapeAttr((d.modules || []).join(', '))}">⚙ ${role} fit</span>`);
  } else if (SRP_ROLE_LABEL[r.category]) {
    // Role from the hull itself (e.g. a Nighthawk is a links ship, an
    // interdictor is a dictor) — no role module captured on the killmail.
    bits.push(`<span class="srp-detect" title="Classified by hull">⚙ ${SRP_ROLE_LABEL[r.category]} (hull)</span>`);
  }
  if (d && d.npc && d.hisec) bits.push('<span class="srp-detect">hisec NPC</span>');
  if (r.inDoctrine === false) {
    bits.push('<span class="srp-flag-warn" title="Hull not found in any Auth doctrine fit — verify eligibility">⚠ not in doctrine</span>');
  }
  return bits.length ? `<div class="srp-info">${bits.join(' ')}</div>` : '';
}

function srpSetProgress(pct, step) {
  const area = $('#srp-progress'), fill = $('#srp-progress-fill'), st = $('#srp-progress-step');
  if (area) area.style.display = (pct == null) ? 'none' : '';
  if (fill && pct != null) fill.style.width = `${Math.round(pct)}%`;
  if (st) st.textContent = step || '';
}

function srpCsrfFromHtml(html) {
  const m = /name="csrfmiddlewaretoken"\s+value="([^"]+)"/.exec(html || '');
  return m ? m[1] : null;
}

function srpIsPending(r) {
  return /pending/i.test(r.status || '');
}

async function srpLoadWallet() {
  try {
    const res = await fetch(`${API}/api/wallets`);
    srpState.wallet = res.ok ? await res.json() : null;
  } catch (_) {
    srpState.wallet = null;
  }
}

function srpRecomputeFleetMeta(f) {
  const fr = (srpState.rows || []).filter((r) => r.fleetId === f.id);
  f.reqCount = fr.length;
  f.pendingCount = fr.filter(srpIsPending).length;
  f.recommendedTotal = fr.filter(srpIsPending).reduce((s, r) => s + srpPayout(r.category, r.lossAmt), 0);
}

async function runSrpScan() {
  const status = $('#srp-status');
  const btn = $('#btn-srp-scan');
  if (!window.api || typeof window.api.aaFetchHtml !== 'function') {
    if (status) status.textContent = 'Alliance Auth bridge unavailable.';
    return;
  }
  if (btn) btn.disabled = true;
  try {
    if (status) status.textContent = 'Fetching SRP fleet list…';
    srpSetProgress(5, 'Loading /srp/ …');
    const listRes = await window.api.aaFetchHtml('/srp/');
    if (!listRes.ok) {
      if (status) status.textContent = `Fetch failed (status ${listRes.status || 'network error'}${listRes.error ? `: ${listRes.error}` : ''}).`;
      srpSetProgress(null);
      return;
    }
    if (/\/account\/login\//.test(listRes.finalUrl) || /Login with Eve SSO/i.test(listRes.html)) {
      if (status) status.textContent = 'Not signed in to Alliance Auth — sign in on the Auth/Doctrines tab first.';
      srpSetProgress(null);
      return;
    }
    const fleets = parseSrpFleets(listRes.html).filter((f) => f.id != null);
    srpState.csrf = srpCsrfFromHtml(listRes.html);
    await ensureShipTypes(); // hull -> group classification

    const rows = [];
    for (let i = 0; i < fleets.length; i++) {
      const f = fleets[i];
      srpSetProgress(10 + (i / Math.max(1, fleets.length)) * 80, `Fleet ${i + 1}/${fleets.length}: ${f.name}`);
      if (status) status.textContent = `Loading fleet ${i + 1}/${fleets.length}: ${f.name}…`;
      const vr = await window.api.aaFetchHtml(`/srp/${f.id}/view/`);
      if (!vr.ok) continue;
      if (!srpState.csrf) srpState.csrf = srpCsrfFromHtml(vr.html);
      parseSrpRequests(vr.html).forEach((r) => {
        r.fleetId = f.id;
        r.category = srpAutoCategory(r.ship);
        r.decision = null; // 'accept' | 'reject' | null
        r.reason = '';
        rows.push(r);
      });
    }
    srpSetProgress(90, 'Classifying kills (hull + fitted modules)…');
    if (status) status.textContent = 'Classifying kills…';
    await srpClassifyRows(rows, (done, total) => {
      // Map per-kill completions onto the tail of the bar (90 → 98%).
      const pct = 90 + (total ? (done / total) * 8 : 0);
      srpSetProgress(pct, `Classifying kills (parallel) — ${done}/${total}…`);
      if (status) status.textContent = `Classifying kills — ${done}/${total}…`;
    });
    srpState.fleets = fleets;
    srpState.rows = rows;
    fleets.forEach(srpRecomputeFleetMeta);
    srpState.scanned = true;

    srpSetProgress(92, 'Loading wallets…');
    await srpLoadWallet();

    srpSetProgress(100, 'Done');
    setTimeout(() => srpSetProgress(null), 500);
    const pending = rows.filter(srpIsPending).length;
    if (status) status.textContent = `${rows.length} requests · ${fleets.length} fleets · ${pending} pending — ${new Date().toLocaleTimeString()}`;
    renderSrp();
  } catch (e) {
    if (status) status.textContent = `Scan error: ${e.message || e}`;
    srpSetProgress(null);
  } finally {
    if (btn) btn.disabled = false;
  }
}

const srpCatOptions = (sel) => SRP_CAT_ORDER
  .map((k) => `<option value="${k}"${k === sel ? ' selected' : ''}>${SRP_CATS[k].label}</option>`)
  .join('');

// Dispatch between the fleet-list view and a single-fleet detail view.
function renderSrp() {
  const root = $('#srp-content');
  if (!root) return;
  if (!srpState.scanned) {
    root.innerHTML = '<p class="muted">Click <strong>Scan SRP</strong> to load outstanding requests.</p>';
    return;
  }
  if (srpState.view === 'fleet' && srpState.fleetId != null) renderSrpFleet(root);
  else renderSrpList(root);
}

function renderSrpList(root) {
  const fleets = srpState.fleets || [];
  const rows = srpState.rows || [];
  const pending = rows.filter(srpIsPending);
  const outstanding = pending.reduce((s, r) => s + srpPayout(r.category, r.lossAmt), 0);

  let walletHtml = '';
  if (srpState.wallet) {
    const w = srpState.wallet;
    const tiles = [`<div class="wallet-tile total"><div class="label">Corp wallet (all divisions)</div><div class="amount">${Math.round(w.total).toLocaleString()} ISK</div></div>`]
      .concat((w.wallets || []).map((d) => `<div class="wallet-tile"><div class="label">${escapeHtml(DIVISION_LABELS[d.division] || ('Division ' + d.division))}</div><div class="amount">${Math.round(d.balance).toLocaleString()} ISK</div></div>`));
    walletHtml = `<div class="wallet-summary">${tiles.join('')}</div>`;
  }

  const fleetRows = fleets.map((f) => `
    <tr>
      <td><a href="#" class="srp-open-fleet" data-fleet="${f.id}">${escapeHtml(f.name || ('Fleet ' + f.id))}</a></td>
      <td>${escapeHtml(f.doctrine || '')}</td>
      <td>${escapeHtml(f.fc || '')}</td>
      <td class="text-end">${f.pendingCount || 0}${(f.reqCount && f.reqCount !== f.pendingCount) ? ` / ${f.reqCount}` : ''}</td>
      <td class="text-end">${fmtIsk(f.recommendedTotal || 0)}</td>
      <td>
        <button type="button" class="secondary srp-open-fleet" data-fleet="${f.id}">Open</button>
        ${(f.pendingCount || 0) === 0 ? `<button type="button" class="srp-danger srp-del-fleet" data-fleet="${f.id}" title="All requests processed — delete this fleet">Delete</button>` : ''}
      </td>
    </tr>`).join('');

  root.innerHTML = `
    ${walletHtml}
    <div id="srp-total">Total SRP outstanding (pending, recommended): <strong class="copyable" data-copy="${outstanding}" title="Click to copy">${fmtIsk(outstanding)}</strong> <span class="muted">· ${pending.length} pending across ${fleets.length} fleets</span></div>
    <table class="items-table srp-table">
      <thead><tr><th>Fleet</th><th>Doctrine</th><th>FC</th><th class="text-end">Pending</th><th class="text-end">Recommended</th><th></th></tr></thead>
      <tbody>${fleetRows || '<tr><td colspan="6" class="muted">No fleets.</td></tr>'}</tbody>
    </table>`;
}

function renderSrpFleet(root) {
  const fid = srpState.fleetId;
  const f = (srpState.fleets || []).find((x) => x.id === fid) || {};
  const freqs = (srpState.rows || []).filter((r) => r.fleetId === fid);

  let acceptTotal = 0, pendingTotal = 0, nAccept = 0, nReject = 0;
  const body = freqs.map((r) => {
    const payout = srpPayout(r.category, r.lossAmt);
    const pending = srpIsPending(r);
    if (pending) pendingTotal += payout;
    if (r.decision === 'accept') { acceptTotal += payout; nAccept++; }
    if (r.decision === 'reject') nReject++;
    const disabled = pending ? '' : ' disabled';
    return `
      <tr class="srp-req${r.decision ? ` srp-dec-${r.decision}` : ''}" data-pk="${escapeHtml(r.pk || '')}">
        <td><span class="copyable" data-copy="${escapeAttr(r.pilot || '')}" title="Click to copy name">${escapeHtml(r.pilot)}</span></td>
        <td>${escapeHtml(r.hull || r.ship)}${srpDetectBadge(r)}${r.info ? `<div class="muted srp-info">${escapeHtml(r.info)}</div>` : ''}</td>
        <td class="text-end">${fmtIsk(r.lossAmt)}</td>
        <td><select class="srp-cat" data-pk="${escapeHtml(r.pk || '')}"${disabled}>${srpCatOptions(r.category)}</select></td>
        <td class="text-end"><strong class="srp-payout copyable" data-copy="${payout}" title="Click to copy">${fmtIsk(payout)}</strong></td>
        <td>
          <div class="srp-toggle">
            <button type="button" class="srp-tog srp-tog-accept${r.decision === 'accept' ? ' active' : ''}" data-pk="${escapeHtml(r.pk || '')}" data-dec="accept"${disabled}>Accept</button>
            <button type="button" class="srp-tog srp-tog-reject${r.decision === 'reject' ? ' active' : ''}" data-pk="${escapeHtml(r.pk || '')}" data-dec="reject"${disabled}>Reject</button>
          </div>
          ${r.decision === 'reject' ? `<input type="text" class="srp-reason" data-pk="${escapeHtml(r.pk || '')}" placeholder="Reason (optional)" value="${escapeAttr(r.reason || '')}" />` : ''}
        </td>
        <td>${r.zkillUrl ? `<a href="${escapeHtml(r.zkillUrl)}" target="_blank" rel="noopener">zKill ↗</a>` : ''}</td>
        <td>${escapeHtml(r.status)}</td>
      </tr>`;
  }).join('');

  const nPending = freqs.filter(srpIsPending).length;
  const nDecided = nAccept + nReject;
  root.innerHTML = `
    <div class="srp-fleet-head">
      <button type="button" class="secondary" id="srp-back">← All fleets</button>
      <h3>${escapeHtml(f.name || ('Fleet ' + fid))} <span class="muted">· ${escapeHtml(f.doctrine || '')} · FC ${escapeHtml(f.fc || '?')}</span></h3>
    </div>
    <div id="srp-total">
      Pending recommended total: <strong class="copyable" data-copy="${pendingTotal}" title="Click to copy">${fmtIsk(pendingTotal)}</strong>
      <span class="muted"> · selected to pay: </span><strong class="copyable" data-copy="${acceptTotal}" title="Click to copy">${fmtIsk(acceptTotal)}</strong>
      <span class="muted"> · ${nAccept} accept / ${nReject} reject of ${nPending} pending</span>
    </div>
    <div class="actions">
      <button type="button" id="srp-accept-all" class="secondary">Accept all pending</button>
      <button type="button" id="srp-process"${nDecided ? '' : ' disabled'}>Process ${nDecided || ''} request${nDecided === 1 ? '' : 's'}</button>
      ${nPending === 0 ? `<button type="button" id="srp-delete-fleet" class="srp-danger" title="All requests processed — delete this fleet from Alliance Auth">Delete fleet</button>` : ''}
      <span id="srp-process-status" class="muted"></span>
    </div>
    <table class="items-table srp-table">
      <thead><tr>
        <th>Pilot</th><th>Ship</th><th class="text-end">KB Loss</th><th>Category</th>
        <th class="text-end">Recommended</th><th>Decision</th><th>Kill</th><th>Status</th>
      </tr></thead>
      <tbody>${body || '<tr><td colspan="8" class="muted">No requests.</td></tr>'}</tbody>
    </table>`;
}

function openSrpFleet(fid) { srpState.view = 'fleet'; srpState.fleetId = fid; renderSrp(); }
function srpBackToList() { srpState.view = 'list'; srpState.fleetId = null; renderSrp(); }

// Delete an entire fleet from Alliance Auth (GET /srp/<id>/remove/). Only
// offered once a fleet has no pending requests left — guarded again here.
async function deleteSrpFleet(fid) {
  const f = (srpState.fleets || []).find((x) => x.id === fid) || {};
  const reqs = (srpState.rows || []).filter((r) => r.fleetId === fid);
  const pendingLeft = reqs.filter(srpIsPending).length;
  if (pendingLeft) { alert(`Fleet "${f.name}" still has ${pendingLeft} pending request(s). Process them before deleting.`); return; }
  if (!confirm(`Delete fleet "${f.name}" and its ${reqs.length} processed request(s) from Alliance Auth?\n\nThis cannot be undone.`)) return;
  const status = $('#srp-status');
  if (status) status.textContent = `Deleting fleet "${f.name}"…`;
  try {
    const res = await window.api.aaFetchHtml(`/srp/${fid}/remove/`);
    if (!res.ok) { if (status) status.textContent = `Delete failed (HTTP ${res.status || 'network error'}).`; return; }
    srpState.fleets = (srpState.fleets || []).filter((x) => x.id !== fid);
    srpState.rows = (srpState.rows || []).filter((r) => r.fleetId !== fid);
    if (srpState.fleetId === fid) srpBackToList(); else renderSrp();
    if (status) status.textContent = `Deleted fleet "${f.name}".`;
  } catch (e) {
    if (status) status.textContent = `Delete error: ${e.message || e}`;
  }
}

// Fill the SRP rejection template's {variables} for one request.
function srpRenderTemplate(text, r, f) {
  const map = {
    pilot: r.pilot || '',
    ship: r.ship || '',
    fleet: (f && f.name) || '',
    fc: (f && f.fc) || '',
    kill_link: r.zkillUrl || '',
    loss_value: fmtIsk(r.lossAmt),
    reason: (r.reason && r.reason.trim()) || 'Does not meet SRP policy',
    date: new Date().toISOString().slice(0, 10),
  };
  return (text || '').replace(/\{(\w+)\}/g, (m, k) => (k in map ? map[k] : m));
}

async function sendSrpRejectMail(r, f) {
  const subject = srpRenderTemplate(srpRejectTemplate.subject || 'SRP request rejected', r, f);
  const body = srpRenderTemplate(srpRejectTemplate.body || 'Your SRP request was rejected.', r, f);
  const res = await fetch(`${API}/api/mail/send-by-name`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient_name: r.pilot, subject, body }),
  });
  return res.ok ? { ok: true } : { ok: false, error: await res.text() };
}

async function srpRefreshFleet(fid) {
  const vr = await window.api.aaFetchHtml(`/srp/${fid}/view/`);
  if (!vr.ok) return;
  srpState.csrf = srpCsrfFromHtml(vr.html) || srpState.csrf;
  const fresh = parseSrpRequests(vr.html).map((r) => {
    r.fleetId = fid;
    r.category = srpAutoCategory(r.ship);
    r.decision = null;
    r.reason = '';
    return r;
  });
  await srpClassifyRows(fresh);
  srpState.rows = (srpState.rows || []).filter((r) => r.fleetId !== fid).concat(fresh);
  const f = (srpState.fleets || []).find((x) => x.id === fid);
  if (f) srpRecomputeFleetMeta(f);
}

async function processSrpFleet() {
  const fid = srpState.fleetId;
  const f = (srpState.fleets || []).find((x) => x.id === fid) || {};
  const freqs = (srpState.rows || []).filter((r) => r.fleetId === fid && srpIsPending(r));
  const accepts = freqs.filter((r) => r.decision === 'accept' && r.pk);
  const rejects = freqs.filter((r) => r.decision === 'reject' && r.pk);
  const statusEl = $('#srp-process-status');
  const btn = $('#srp-process');
  if (!accepts.length && !rejects.length) return;
  if (!srpState.csrf) { if (statusEl) statusEl.textContent = 'Missing CSRF token — rescan first.'; return; }
  if (!confirm(`Process fleet "${f.name}":\n  Accept (set payout + approve): ${accepts.length}\n  Reject: ${rejects.length}${rejects.length ? ' (rejection mails sent)' : ''}\n\nThis writes to Alliance Auth. Continue?`)) return;

  if (btn) btn.disabled = true;
  const referer = `/srp/${fid}/view/`;
  const errors = [];
  try {
    // 1) accepted: set the recommended ISK on each, then bulk-approve.
    for (let i = 0; i < accepts.length; i++) {
      const r = accepts[i];
      if (statusEl) statusEl.textContent = `Setting payout ${i + 1}/${accepts.length}…`;
      const amount = srpPayout(r.category, r.lossAmt);
      const up = await window.api.aaPostForm(
        r.updateUrl || `/srp/request/${r.pk}/update/`,
        { csrfmiddlewaretoken: srpState.csrf, pk: r.pk, name: 'srp_total_amount', value: String(amount) },
        referer,
      );
      if (!up.ok) errors.push(`set value ${r.pilot}: HTTP ${up.status}`);
    }
    if (accepts.length) {
      if (statusEl) statusEl.textContent = `Approving ${accepts.length}…`;
      const fields = { csrfmiddlewaretoken: srpState.csrf };
      accepts.forEach((r) => { fields[r.pk] = 'on'; });
      const ap = await window.api.aaPostForm('/srp/request/approve/', fields, referer);
      if (!ap.ok) errors.push(`approve batch: HTTP ${ap.status}`);
    }
    // 2) rejected: bulk-reject, then auto-send rejection mails.
    if (rejects.length) {
      if (statusEl) statusEl.textContent = `Rejecting ${rejects.length}…`;
      const fields = { csrfmiddlewaretoken: srpState.csrf };
      rejects.forEach((r) => { fields[r.pk] = 'on'; });
      const rj = await window.api.aaPostForm('/srp/request/reject/', fields, referer);
      if (!rj.ok) errors.push(`reject batch: HTTP ${rj.status}`);
      for (let i = 0; i < rejects.length; i++) {
        const r = rejects[i];
        if (statusEl) statusEl.textContent = `Sending reject mail ${i + 1}/${rejects.length}…`;
        const mr = await sendSrpRejectMail(r, f);
        if (!mr.ok) errors.push(`mail ${r.pilot}: ${mr.error}`);
      }
    }
    if (statusEl) statusEl.textContent = 'Refreshing…';
    await srpRefreshFleet(fid);
    if (statusEl) statusEl.textContent = errors.length ? `Done with ${errors.length} issue(s): ${errors.slice(0, 3).join('; ')}` : 'Processed.';
  } catch (e) {
    if (statusEl) statusEl.textContent = `Process error: ${e.message || e}`;
  } finally {
    if (btn) btn.disabled = false;
    renderSrp();
  }
}

async function clearProcessedAll() {
  if (!srpState.scanned) { alert('Scan SRP first.'); return; }
  if (!srpState.csrf) { alert('Missing CSRF token — rescan first.'); return; }
  const processed = (srpState.rows || []).filter((r) => r.pk && !srpIsPending(r));
  if (!processed.length) { alert('No processed (approved/rejected) requests to clear.'); return; }
  if (!confirm(`Delete ${processed.length} processed (approved + rejected) request(s) across all fleets from Alliance Auth?\n\nThis cannot be undone.`)) return;
  const status = $('#srp-status');
  const btn = $('#btn-srp-clear-processed');
  if (btn) btn.disabled = true;
  try {
    const byFleet = new Map();
    processed.forEach((r) => {
      if (!byFleet.has(r.fleetId)) byFleet.set(r.fleetId, []);
      byFleet.get(r.fleetId).push(r);
    });
    let removed = 0;
    const errors = [];
    for (const [fid, list] of byFleet) {
      if (status) status.textContent = `Clearing ${list.length} from fleet ${fid}…`;
      const fields = { csrfmiddlewaretoken: srpState.csrf };
      list.forEach((r) => { fields[r.pk] = 'on'; });
      const res = await window.api.aaPostForm('/srp/request/remove/', fields, `/srp/${fid}/view/`);
      if (res.ok) removed += list.length; else errors.push(`fleet ${fid}: HTTP ${res.status}`);
    }
    if (status) status.textContent = `Removed ${removed} processed request(s)${errors.length ? `; issues: ${errors.join('; ')}` : ''}.`;
    await runSrpScan();
  } catch (e) {
    if (status) status.textContent = `Clear error: ${e.message || e}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Delegated change events within the SRP content area.
document.addEventListener('change', (e) => {
  const cat = e.target.closest('#srp-content .srp-cat');
  if (cat) {
    const row = (srpState.rows || []).find((r) => String(r.pk) === String(cat.dataset.pk));
    if (row) { row.category = cat.value; renderSrp(); }
    return;
  }
  const reason = e.target.closest('#srp-content .srp-reason');
  if (reason) {
    const row = (srpState.rows || []).find((r) => String(r.pk) === String(reason.dataset.pk));
    if (row) row.reason = reason.value; // no re-render — keep focus while typing
  }
});

// Delegated clicks within the SRP content area (copy / open / back / toggle / process).
document.addEventListener('click', async (e) => {
  const cp = e.target.closest('#srp-content .copyable');
  if (cp) {
    try {
      await navigator.clipboard.writeText(cp.dataset.copy || '');
      const prev = cp.dataset.prevText ?? cp.textContent;
      cp.dataset.prevText = prev;
      cp.textContent = 'copied!';
      cp.classList.add('payout-copied');
      setTimeout(() => { cp.textContent = prev; cp.classList.remove('payout-copied'); }, 900);
    } catch (_) {}
    return;
  }
  const open = e.target.closest('#srp-content .srp-open-fleet');
  if (open) { e.preventDefault(); openSrpFleet(parseInt(open.dataset.fleet, 10)); return; }
  const delRow = e.target.closest('#srp-content .srp-del-fleet');
  if (delRow) { deleteSrpFleet(parseInt(delRow.dataset.fleet, 10)); return; }
  if (e.target.closest('#srp-delete-fleet')) { deleteSrpFleet(srpState.fleetId); return; }
  if (e.target.closest('#srp-back')) { srpBackToList(); return; }
  const tog = e.target.closest('#srp-content .srp-tog');
  if (tog && !tog.disabled) {
    const row = (srpState.rows || []).find((r) => String(r.pk) === String(tog.dataset.pk));
    if (row) { row.decision = (row.decision === tog.dataset.dec) ? null : tog.dataset.dec; renderSrp(); }
    return;
  }
  if (e.target.closest('#srp-accept-all')) {
    (srpState.rows || []).filter((r) => r.fleetId === srpState.fleetId && srpIsPending(r)).forEach((r) => { r.decision = 'accept'; });
    renderSrp();
    return;
  }
  if (e.target.closest('#srp-process')) { processSrpFleet(); return; }
});

$('#btn-srp-scan')?.addEventListener('click', runSrpScan);
$('#btn-srp-clear-processed')?.addEventListener('click', clearProcessedAll);

// SRP rejection template save (Mail tab).
$('#srp-reject-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const subject = $('#srp-reject-subject')?.value || '';
  const body = $('#srp-reject-body')?.value || '';
  const st = $('#srp-reject-status');
  try {
    const res = await fetch(`${API}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ srp_reject_subject: subject, srp_reject_body: body }),
    });
    if (res.ok) { srpRejectTemplate = { subject, body }; if (st) st.textContent = 'Saved.'; }
    else if (st) st.textContent = `Error: ${await res.text()}`;
  } catch (err) { if (st) st.textContent = `Error: ${err.message || err}`; }
  if (st) setTimeout(() => { st.textContent = ''; }, 2500);
});

renderSrp();

// ===================== In-app link viewer (side panel + pop-out) =====================
// External links (zKillboard, Janice, Mutamarket, wiki…) clicked anywhere in the
// app are intercepted and opened either in a docked side panel (default) or in
// their own window, per the Config "Link handling" setting.

function openLinkPanel(url) {
  const panel = $('#link-panel');
  const view = $('#link-panel-view');
  if (!panel || !view) { window.api?.openLinkWindow(url); return; }
  panel.hidden = false;
  document.body.classList.add('link-panel-open');
  panel.dataset.url = url;
  const label = $('#link-panel-url');
  if (label) label.textContent = url;
  try { view.src = url; } catch (_) { window.api?.openLinkWindow(url); }
}

function closeLinkPanel() {
  const panel = $('#link-panel');
  const view = $('#link-panel-view');
  if (panel) { panel.hidden = true; delete panel.dataset.url; }
  document.body.classList.remove('link-panel-open');
  if (view) { try { view.src = 'about:blank'; } catch (_) {} }
}

function openExternalLink(url) {
  if (!/^https?:\/\//i.test(url || '')) return;
  if (linkOpenMode === 'window') window.api?.openLinkWindow(url);
  else openLinkPanel(url);
}

// Capture-phase so we intercept before navigation. Only plain external http(s)
// anchors are routed; in-app (#) links and JS handlers are left alone.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a) return;
  if (a.closest('#link-panel')) return; // ignore the panel's own chrome
  const href = a.getAttribute('href') || '';
  if (!/^https?:\/\//i.test(href)) return;
  e.preventDefault();
  openExternalLink(a.href);
}, true);

$('#link-panel-close')?.addEventListener('click', closeLinkPanel);
$('#link-panel-popout')?.addEventListener('click', () => {
  const url = $('#link-panel')?.dataset.url;
  if (url) window.api?.openLinkWindow(url);
  closeLinkPanel();
});
// Keep the panel's URL label in sync as the user navigates inside the webview.
(() => {
  const view = $('#link-panel-view');
  if (!view || !view.addEventListener) return;
  view.addEventListener('did-navigate', (e) => {
    const panel = $('#link-panel');
    const label = $('#link-panel-url');
    if (panel && e.url) panel.dataset.url = e.url;
    if (label && e.url) label.textContent = e.url;
  });
})();
