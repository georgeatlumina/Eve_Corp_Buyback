'use strict';

// ====================== Hooks & Hubs tab ======================
// Loaded after app.js, so it reuses app.js globals ($, $$, API, escapeHtml) and
// the pure computePlan() from hooks-hubs-utils.js. Two halves:
//   1) Fuel dashboard — live from /api/structures/fuel (slot 4 Director token).
//   2) Upgrade/workforce planner — manual data from /api/workforce-plan, with
//      live feasibility math from computePlan(). Power is local (per-system
//      balance must be >= 0); workforce can be transferred between systems.

const hooksHubsState = {
  fuel: null, fuelLoading: false, fuelError: null,
  plan: null, planLoaded: false, planLoading: false, planDirty: false,
};

function hhToNum(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; }

function hhNewId() {
  try { if (crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (_) {}
  return 'sys-' + Math.random().toString(36).slice(2, 10);
}

function hhFmtDuration(seconds) {
  if (seconds == null) return '—';
  if (seconds <= 0) return 'EXPIRED';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  if (d >= 1) return `${d}d ${h}h`;
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

// Fuel urgency bands: red < 3 days, amber < 7 days, else green.
function hhFuelClass(seconds) {
  if (seconds == null) return 'hh-fuel-none';
  if (seconds < 3 * 86400) return 'hh-fuel-crit';
  if (seconds < 7 * 86400) return 'hh-fuel-warn';
  return 'hh-fuel-ok';
}

// ---------- Fuel dashboard ----------

async function refreshFuel() {
  if (hooksHubsState.fuelLoading) return;
  hooksHubsState.fuelLoading = true;
  hooksHubsState.fuelError = null;
  const st = $('#hh-fuel-status');
  if (st) st.textContent = 'Loading structure fuel from ESI…';
  renderFuel();
  try {
    const res = await fetch(`${API}/api/structures/fuel`);
    if (!res.ok) throw new Error(`${res.status} — ${await res.text()}`);
    hooksHubsState.fuel = await res.json();
    if (st) st.textContent = `Fetched ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    hooksHubsState.fuelError = String(e.message || e);
    if (st) st.textContent = `Error: ${hooksHubsState.fuelError}`;
  } finally {
    hooksHubsState.fuelLoading = false;
    renderFuel();
  }
}

function hhFuelTile(label, summary) {
  const s = summary || {};
  const soon = s.soonest_seconds != null ? hhFmtDuration(s.soonest_seconds) : '—';
  const lowCls = s.low_count ? 'bad-text' : '';
  return `
    <div class="wallet-tile">
      <div class="label">${escapeHtml(label)}</div>
      <div class="amount">${s.count || 0}</div>
      <div class="muted small"><span class="${lowCls}">${s.low_count || 0} low</span> · soonest ${soon}</div>
    </div>`;
}

function hhFuelTable(rows, emptyMsg) {
  if (!rows || !rows.length) return `<p class="muted">${escapeHtml(emptyMsg)}</p>`;
  const body = rows.map((r) => {
    const cls = hhFuelClass(r.seconds_remaining);
    const svc = (r.services_total != null) ? `${r.services_online}/${r.services_total}` : '—';
    return `
      <tr class="${cls}">
        <td>${escapeHtml(r.system_name || '?')}</td>
        <td>${escapeHtml(r.name || '(unnamed)')}</td>
        <td class="num">${r.fuel_expires ? new Date(r.fuel_expires).toLocaleString() : '—'}</td>
        <td class="num hh-remaining">${hhFmtDuration(r.seconds_remaining)}</td>
        <td>${escapeHtml(r.state || '—')}</td>
        <td class="num">${svc}</td>
      </tr>`;
  }).join('');
  return `
    <table class="items-table hh-fuel-table">
      <thead><tr><th>System</th><th>Name</th><th class="num">Fuel expires</th><th class="num">Remaining</th><th>State</th><th class="num">Svc</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

function renderFuel() {
  const root = $('#hh-fuel-content');
  if (!root) return;
  if (hooksHubsState.fuelLoading && !hooksHubsState.fuel) { root.innerHTML = '<p class="muted">Loading…</p>'; return; }
  if (hooksHubsState.fuelError && !hooksHubsState.fuel) { root.innerHTML = `<p class="muted">Could not load: ${escapeHtml(hooksHubsState.fuelError)}</p>`; return; }
  const d = hooksHubsState.fuel;
  if (!d) { root.innerHTML = '<p class="muted">Click <strong>Refresh fuel</strong> to load skyhook &amp; sov-hub fuel.</p>'; return; }

  const errBlock = (d.auth_errors && d.auth_errors.length)
    ? `<details class="hh-auth-errors"><summary class="muted">${d.auth_errors.length} slot/corp warning(s)</summary><ul>${
        d.auth_errors.map((e) => `<li class="muted">${escapeHtml(e.slot || ('corp ' + e.corp_id) || '?')}: ${escapeHtml(e.error || '')}</li>`).join('')
      }</ul></details>`
    : '';

  root.innerHTML = `
    <div class="wallet-summary">
      ${hhFuelTile('Skyhooks', d.summary && d.summary.skyhook)}
      ${hhFuelTile('Sov hubs', d.summary && d.summary.hub)}
    </div>
    ${errBlock}
    <h4 class="hh-sub">Orbital Skyhooks</h4>
    ${hhFuelTable(d.skyhooks, 'No skyhooks found (or no slot with Director + read_structures).')}
    <p class="muted small">Skyhook "available for collection" reservoir is <em>not exposed by ESI</em> — track it manually if needed.</p>
    <h4 class="hh-sub">Sovereignty Hubs</h4>
    ${hhFuelTable(d.hubs, 'No sovereignty hubs found.')}
    ${(d.other && d.other.length) ? `<details class="hh-other"><summary class="muted">Other fueled structures (${d.other.length})</summary>${hhFuelTable(d.other, '')}</details>` : ''}
  `;
}

// ---------- Workforce / upgrade planner ----------

async function loadPlan() {
  if (hooksHubsState.planLoading) return;
  hooksHubsState.planLoading = true;
  const st = $('#hh-plan-status');
  if (st) st.textContent = 'Loading plan…';
  try {
    const res = await fetch(`${API}/api/workforce-plan`);
    if (!res.ok) throw new Error(`${res.status} — ${await res.text()}`);
    hooksHubsState.plan = await res.json();
    hooksHubsState.planLoaded = true;
    hooksHubsState.planDirty = false;
    if (st) st.textContent = '';
  } catch (e) {
    if (st) st.textContent = `Error: ${String(e.message || e)}`;
  } finally {
    hooksHubsState.planLoading = false;
    renderPlanner();
  }
}

async function savePlan() {
  const st = $('#hh-plan-status');
  if (!hooksHubsState.plan) return;
  if (st) st.textContent = 'Saving…';
  try {
    const res = await fetch(`${API}/api/workforce-plan`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(hooksHubsState.plan),
    });
    if (!res.ok) throw new Error(`${res.status} — ${await res.text()}`);
    hooksHubsState.plan = await res.json();
    hooksHubsState.planDirty = false;
    if (st) st.textContent = `Saved ${new Date().toLocaleTimeString()}`;
    renderPlanner();
  } catch (e) {
    if (st) st.textContent = `Error: ${String(e.message || e)}`;
  }
}

function hhMarkDirty() {
  hooksHubsState.planDirty = true;
  const st = $('#hh-plan-status');
  if (st && !/^Error/.test(st.textContent)) st.textContent = 'Unsaved changes';
}

// Resolve a plan for computePlan: fill each upgrade's power/workforce from the
// catalog by name so editing a catalog cost reflects everywhere immediately.
function hhResolvedPlan() {
  const plan = hooksHubsState.plan || { systems: [], transfers: [], catalog: [] };
  const cat = {};
  (plan.catalog || []).forEach((c) => { if (c && c.name != null) cat[c.name] = c; });
  return {
    systems: (plan.systems || []).map((s) => ({
      ...s,
      upgrades: (s.upgrades || []).map((u) => {
        const c = cat[u.name];
        return { name: u.name, power: hhToNum(c ? c.power : u.power), workforce: hhToNum(c ? c.workforce : u.workforce) };
      }),
    })),
    transfers: plan.transfers || [],
  };
}

function renderPlanner() {
  const root = $('#hh-planner-content');
  if (!root) return;
  const plan = hooksHubsState.plan;
  if (!plan) { root.innerHTML = '<p class="muted">Loading…</p>'; return; }
  const computed = computePlan(hhResolvedPlan());
  const byId = Object.fromEntries(computed.systems.map((s) => [s.id, s]));
  const t = computed.totals;
  const catOptions = (plan.catalog || []).map((c) =>
    `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');

  const summary = `
    <div class="wallet-summary">
      <div class="wallet-tile ${t.infeasible_count ? 'hh-tile-bad' : 'total'}">
        <div class="label">Feasibility</div>
        <div class="amount">${t.infeasible_count ? `${t.infeasible_count} over budget` : 'All OK'}</div>
        <div class="muted small">${t.system_count} systems · ${t.transfer_count} transfers${t.invalid_transfers ? ` · ${t.invalid_transfers} invalid` : ''}</div>
      </div>
      <div class="wallet-tile">
        <div class="label">Power (local)</div>
        <div class="amount">${t.total_power_used.toLocaleString()} / ${t.total_power_available.toLocaleString()}</div>
        <div class="muted small">cluster balance ${t.total_power_balance.toLocaleString()} (not transferable)</div>
      </div>
      <div class="wallet-tile">
        <div class="label">Workforce</div>
        <div class="amount">${t.total_workforce_used.toLocaleString()} / ${t.total_workforce_available.toLocaleString()}</div>
        <div class="muted small">surplus ${t.workforce_surplus.toLocaleString()}</div>
      </div>
    </div>`;

  const sysRows = (plan.systems || []).map((s) => {
    const c = byId[s.id] || {};
    const chips = (s.upgrades || []).map((u, i) =>
      `<span class="hh-chip">${escapeHtml(u.name)}<button type="button" class="hh-chip-x" data-act="rm-upg" data-sys="${escapeHtml(s.id)}" data-idx="${i}" title="Remove">×</button></span>`).join(' ');
    const pCls = c.power_balance < 0 ? 'bad-text' : 'good-text';
    const wCls = (c.workforce_balance < 0 || c.over_export) ? 'bad-text' : 'good-text';
    return `
      <tr class="${c.feasible ? '' : 'hh-row-bad'}">
        <td><input type="text" data-sys="${escapeHtml(s.id)}" data-field="system_name" value="${escapeHtml(s.system_name || '')}" placeholder="System" /></td>
        <td><input type="number" class="hh-num" data-sys="${escapeHtml(s.id)}" data-field="power_available" value="${escapeHtml(String(s.power_available != null ? s.power_available : 0))}" /></td>
        <td><input type="number" class="hh-num" data-sys="${escapeHtml(s.id)}" data-field="workforce_available" value="${escapeHtml(String(s.workforce_available != null ? s.workforce_available : 0))}" /></td>
        <td class="hh-upg-cell">${chips}
          <select class="hh-add-upg secondary" data-sys="${escapeHtml(s.id)}"><option value="">+ upgrade…</option>${catOptions}</select>
        </td>
        <td class="num hh-readout ${pCls}" data-readout="power" data-sys="${escapeHtml(s.id)}">${(c.power_balance || 0).toLocaleString()}</td>
        <td class="num hh-readout ${wCls}" data-readout="wf" data-sys="${escapeHtml(s.id)}">${(c.workforce_balance || 0).toLocaleString()}${c.over_export ? ' ⚠' : ''}<div class="muted small">net ${(c.workforce_net || 0).toLocaleString()} (in ${c.workforce_in || 0}/out ${c.workforce_out || 0})</div></td>
        <td><button type="button" class="secondary hh-sm" data-act="rm-sys" data-sys="${escapeHtml(s.id)}">✕</button></td>
      </tr>`;
  }).join('');
  const sysTable = `
    <table class="quota-table hh-plan-table">
      <thead><tr><th>System</th><th>Power avail</th><th>Workforce avail</th><th>Upgrades</th><th class="num">Power bal</th><th class="num">Workforce bal</th><th></th></tr></thead>
      <tbody>${sysRows || '<tr><td colspan="7" class="muted">No systems yet — click <strong>+ System</strong> or <strong>Import systems from my sov hubs</strong>.</td></tr>'}</tbody>
    </table>`;

  const transRows = (plan.transfers || []).map((tr, i) => `
    <tr>
      <td><select data-trans="${i}" data-field="from"><option value="">from…</option>${(plan.systems || []).map((s) => `<option value="${escapeHtml(s.id)}" ${s.id === tr.from ? 'selected' : ''}>${escapeHtml(s.system_name || s.id)}</option>`).join('')}</select></td>
      <td><select data-trans="${i}" data-field="to"><option value="">to…</option>${(plan.systems || []).map((s) => `<option value="${escapeHtml(s.id)}" ${s.id === tr.to ? 'selected' : ''}>${escapeHtml(s.system_name || s.id)}</option>`).join('')}</select></td>
      <td><input type="number" class="hh-num" data-trans="${i}" data-field="amount" value="${escapeHtml(String(tr.amount != null ? tr.amount : 0))}" /></td>
      <td><button type="button" class="secondary hh-sm" data-act="rm-trans" data-idx="${i}">✕</button></td>
    </tr>`).join('');
  const transTable = `
    <h4 class="hh-sub">Workforce transfers</h4>
    <table class="quota-table hh-trans-table">
      <thead><tr><th>From</th><th>To</th><th class="num">Amount</th><th></th></tr></thead>
      <tbody>${transRows || '<tr><td colspan="4" class="muted">No transfers. Workforce moves between systems via connected hubs (same alliance).</td></tr>'}</tbody>
    </table>`;

  const catRows = (plan.catalog || []).map((c, i) => `
    <tr>
      <td><input type="text" data-cat="${i}" data-field="name" value="${escapeHtml(c.name || '')}" placeholder="Upgrade name" /></td>
      <td><input type="number" class="hh-num" data-cat="${i}" data-field="power" value="${escapeHtml(String(c.power != null ? c.power : 0))}" /></td>
      <td><input type="number" class="hh-num" data-cat="${i}" data-field="workforce" value="${escapeHtml(String(c.workforce != null ? c.workforce : 0))}" /></td>
      <td><button type="button" class="secondary hh-sm" data-act="rm-cat" data-idx="${i}">✕</button></td>
    </tr>`).join('');
  const catBlock = `
    <details class="hh-catalog">
      <summary>Upgrade catalog (${(plan.catalog || []).length}) — set power/workforce costs from the in-game fitting screen</summary>
      <table class="quota-table hh-cat-table">
        <thead><tr><th>Upgrade</th><th class="num">Power</th><th class="num">Workforce</th><th></th></tr></thead>
        <tbody>${catRows || '<tr><td colspan="4" class="muted">Catalog is empty.</td></tr>'}</tbody>
      </table>
      <button type="button" class="secondary hh-sm" data-act="add-cat">+ Catalog entry</button>
    </details>`;

  root.innerHTML = summary + sysTable + transTable + catBlock;
}

// Update only the computed readout cells without re-rendering inputs (preserves
// focus while typing).
function hhRecompute() {
  const plan = hooksHubsState.plan;
  if (!plan) return;
  const computed = computePlan(hhResolvedPlan());
  const byId = Object.fromEntries(computed.systems.map((s) => [s.id, s]));
  $$('#hh-planner-content .hh-readout').forEach((cell) => {
    const c = byId[cell.dataset.sys];
    if (!c) return;
    if (cell.dataset.readout === 'power') {
      cell.textContent = (c.power_balance || 0).toLocaleString();
      cell.classList.toggle('bad-text', c.power_balance < 0);
      cell.classList.toggle('good-text', c.power_balance >= 0);
    } else {
      cell.innerHTML = `${(c.workforce_balance || 0).toLocaleString()}${c.over_export ? ' ⚠' : ''}<div class="muted small">net ${(c.workforce_net || 0).toLocaleString()} (in ${c.workforce_in || 0}/out ${c.workforce_out || 0})</div>`;
      const bad = c.workforce_balance < 0 || c.over_export;
      cell.classList.toggle('bad-text', bad);
      cell.classList.toggle('good-text', !bad);
    }
    const row = cell.closest('tr');
    if (row) row.classList.toggle('hh-row-bad', !c.feasible);
  });
}

function hhFindSystem(id) { return (hooksHubsState.plan.systems || []).find((s) => s.id === id); }

// Delegated input/change/click on the planner container (attached once).
function hhWirePlanner() {
  const root = $('#hh-planner-content');
  if (!root || root.dataset.wired) return;
  root.dataset.wired = '1';

  root.addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset.sys && el.dataset.field) {
      const sys = hhFindSystem(el.dataset.sys);
      if (sys) { sys[el.dataset.field] = el.type === 'number' ? hhToNum(el.value) : el.value; hhMarkDirty(); hhRecompute(); }
    } else if (el.dataset.trans != null && el.dataset.field) {
      const tr = hooksHubsState.plan.transfers[+el.dataset.trans];
      if (tr) { tr[el.dataset.field] = el.type === 'number' ? hhToNum(el.value) : el.value; hhMarkDirty(); hhRecompute(); }
    } else if (el.dataset.cat != null && el.dataset.field) {
      const c = hooksHubsState.plan.catalog[+el.dataset.cat];
      if (c) { c[el.dataset.field] = el.dataset.field === 'name' ? el.value : hhToNum(el.value); hhMarkDirty(); hhRecompute(); }
    }
  });

  root.addEventListener('change', (e) => {
    const el = e.target;
    if (el.classList.contains('hh-add-upg') && el.value) {
      const sys = hhFindSystem(el.dataset.sys);
      const cat = (hooksHubsState.plan.catalog || []).find((c) => c.name === el.value);
      if (sys) {
        sys.upgrades = sys.upgrades || [];
        sys.upgrades.push({ name: el.value, power: hhToNum(cat && cat.power), workforce: hhToNum(cat && cat.workforce) });
        hhMarkDirty(); renderPlanner();
      }
    } else if (el.dataset.trans != null && el.dataset.field) {
      const tr = hooksHubsState.plan.transfers[+el.dataset.trans];
      if (tr) { tr[el.dataset.field] = el.value; hhMarkDirty(); hhRecompute(); }
    }
  });

  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const plan = hooksHubsState.plan;
    if (act === 'rm-sys') { plan.systems = plan.systems.filter((s) => s.id !== btn.dataset.sys); }
    else if (act === 'rm-upg') { const s = hhFindSystem(btn.dataset.sys); if (s) s.upgrades.splice(+btn.dataset.idx, 1); }
    else if (act === 'rm-trans') { plan.transfers.splice(+btn.dataset.idx, 1); }
    else if (act === 'rm-cat') { plan.catalog.splice(+btn.dataset.idx, 1); }
    else if (act === 'add-cat') { plan.catalog = plan.catalog || []; plan.catalog.push({ name: '', power: 0, workforce: 0 }); }
    else return;
    hhMarkDirty(); renderPlanner();
  });
}

function hhAddSystem(name) {
  const plan = hooksHubsState.plan || (hooksHubsState.plan = { systems: [], transfers: [], catalog: [] });
  plan.systems = plan.systems || [];
  plan.systems.push({ id: hhNewId(), system_name: name || '', power_available: 0, workforce_available: 0, upgrades: [], notes: '' });
  hhMarkDirty(); renderPlanner();
}

function hhImportHubSystems() {
  const d = hooksHubsState.fuel;
  const st = $('#hh-plan-status');
  if (!d || !d.hubs) { if (st) st.textContent = 'Refresh fuel first to import hub systems.'; return; }
  const plan = hooksHubsState.plan || (hooksHubsState.plan = { systems: [], transfers: [], catalog: [] });
  plan.systems = plan.systems || [];
  const existing = new Set(plan.systems.map((s) => (s.system_name || '').toLowerCase()));
  let added = 0;
  const seen = new Set();
  d.hubs.forEach((h) => {
    const nm = h.system_name;
    if (!nm || seen.has(nm.toLowerCase()) || existing.has(nm.toLowerCase())) return;
    seen.add(nm.toLowerCase());
    plan.systems.push({ id: hhNewId(), system_name: nm, power_available: 0, workforce_available: 0, upgrades: [], notes: '' });
    added += 1;
  });
  if (st) st.textContent = added ? `Imported ${added} system(s) — fill in power/workforce.` : 'No new hub systems to import.';
  if (added) { hhMarkDirty(); renderPlanner(); }
}

// ---------- Wiring + lazy load ----------

$('#btn-hh-fuel-refresh')?.addEventListener('click', refreshFuel);
$('#btn-hh-plan-save')?.addEventListener('click', savePlan);
$('#btn-hh-plan-reload')?.addEventListener('click', loadPlan);
$('#btn-hh-plan-add-system')?.addEventListener('click', () => hhAddSystem(''));
$('#btn-hh-plan-add-transfer')?.addEventListener('click', () => {
  const plan = hooksHubsState.plan || (hooksHubsState.plan = { systems: [], transfers: [], catalog: [] });
  plan.transfers = plan.transfers || [];
  plan.transfers.push({ from: '', to: '', amount: 0 });
  hhMarkDirty(); renderPlanner();
});
$('#btn-hh-plan-import-hubs')?.addEventListener('click', hhImportHubSystems);

document.querySelector('.tab-btn[data-tab="hooks-hubs"]')?.addEventListener('click', () => {
  hhWirePlanner();
  if (!hooksHubsState.fuel && !hooksHubsState.fuelLoading) refreshFuel();
  if (!hooksHubsState.planLoaded && !hooksHubsState.planLoading) loadPlan();
});
