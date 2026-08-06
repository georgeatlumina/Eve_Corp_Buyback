'use strict';

// ===================== Planetary Interaction planner =====================
// General tab. Search a solar system -> see the planet types it has -> rank the
// most profitable P0->P4 production chains buildable there, priced at Jita with
// a configurable POCO export tax. Click a chain to see its full recipe tree +
// raw P0 basket. Backed by /api/pi/data (static) and /api/pi/analyze (live).
// Reuses app.js globals (API, $, escapeHtml, fmtIsk, fmtIskShort).

(function () {
  let piData = null;      // /api/pi/data — {types, schematics, planet_types, planet_p0}
  let byOutput = null;    // output_type_id -> schematic
  let lastRows = [];      // last analyze() rows, for recipe drill-down
  let initialised = false;

  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function meta(id) { return piData && piData.types[String(id)]; }
  function typeName(id) { const t = meta(id); return t ? t.name : `type ${id}`; }
  function tierLabel(id) { const t = meta(id); return t ? `P${t.tier}` : ''; }
  function fmtN(n) { return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }); }
  function fmtQty(n) { return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }); }

  async function loadData() {
    if (piData) return piData;
    const r = await fetch(`${API}/api/pi/data`);
    piData = await r.json();
    byOutput = {};
    for (const s of piData.schematics) {
      for (const [oid] of s.outputs) byOutput[oid] = s;
    }
    return piData;
  }

  function selectedTiers() {
    const t = $$('.pi-tier:checked').map((c) => c.value);
    return t.length ? t.join(',') : '1,2,3,4';
  }

  async function analyze() {
    await loadData();
    const status = $('#pi-status');
    const system = $('#pi-system').value.trim();
    const taxPct = parseFloat($('#pi-tax').value);
    status.textContent = 'Analyzing…';

    const params = new URLSearchParams();
    if (system) params.set('system', system);
    if (!Number.isNaN(taxPct)) params.set('tax_rate', String(taxPct / 100));
    params.set('tiers', selectedTiers());

    let d;
    try {
      const r = await fetch(`${API}/api/pi/analyze?${params.toString()}`);
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.detail || r.statusText);
      }
      d = await r.json();
    } catch (e) {
      status.textContent = `Error: ${e.message}`;
      return;
    }

    lastRows = d.rows || [];
    renderPlanets(d);
    renderTable();
    const base = `Ranked ${lastRows.length} chains · ${d.market} · POCO tax ${(d.tax_rate * 100).toFixed(1)}%`;
    status.textContent = d.price_note ? `${base} — ${d.price_note}` : base;
    status.classList.toggle('pi-warn', !!d.price_note);
  }

  function renderPlanets(d) {
    const el = $('#pi-planets');
    if (!el) return;
    const sys = d.system;
    const p0chips = (d.p0_available || [])
      .map((id) => `<span class="pi-chip">${escapeHtml(typeName(id))}</span>`)
      .join('');
    if (!sys) {
      el.innerHTML = `<div class="muted">No system filter — showing every chain. `
        + `Search a system above to restrict to what its planets can extract.</div>`
        + `<div class="pi-chips">${p0chips}</div>`;
      return;
    }
    const types = {};
    for (const p of sys.planets) {
      if (p.planet_type) types[p.planet_type] = (types[p.planet_type] || 0) + 1;
    }
    const typeStr = Object.entries(types)
      .map(([t, n]) => `${escapeHtml(t)}${n > 1 ? ` ×${n}` : ''}`)
      .join(', ') || 'none usable';
    el.innerHTML = `<div><strong>${escapeHtml(sys.name)}</strong> — ${sys.planets.length} planet(s): ${typeStr}</div>`
      + `<div class="muted" style="margin-top:.3em">Extractable raw resources (${(d.p0_available || []).length}):</div>`
      + `<div class="pi-chips">${p0chips}</div>`;
  }

  function renderTable() {
    const el = $('#pi-results');
    if (!el) return;
    if (!lastRows.length) { el.innerHTML = '<div class="muted">No chains for this selection.</div>'; return; }
    const perUnit = !!$('#pi-perunit')?.checked;
    const suf = perUnit ? '/unit' : '/run';
    const mult = (r) => (perUnit ? 1 : (r.run_qty || 1));
    // Re-rank by the displayed (per-run or per-unit) chain profit.
    const sorted = lastRows.slice().sort((a, b) => (b.chain_profit * mult(b)) - (a.chain_profit * mult(a)));
    const rows = sorted.map((r) => {
      const m = mult(r);
      const sell = r.unit_sell * m, cp = r.chain_profit * m, sm = r.step_margin * m;
      const batch = (!perUnit && r.run_qty > 1) ? ` <span class="muted pi-batch">×${r.run_qty}</span>` : '';
      return `<tr class="pi-row" data-pi-recipe="${r.type_id}" tabindex="0">
        <td>${escapeHtml(r.tier_label || '')}</td>
        <td>${escapeHtml(r.name)}${batch}</td>
        <td class="num">${r.unit_sell ? fmtIsk(sell) : '—'}</td>
        <td class="num ${cp >= 0 ? 'pi-pos' : 'pi-neg'}">${fmtIsk(cp)}</td>
        <td class="num ${sm >= 0 ? 'pi-pos' : 'pi-neg'}">${fmtIsk(sm)}</td>
        <td class="num">${fmtN(r.p0_units_total * m)}</td>
      </tr>`;
    }).join('');
    el.innerHTML = `<table class="pi-table">
      <thead><tr>
        <th>Tier</th><th>Commodity</th><th class="num">Jita sell ${suf}</th>
        <th class="num" title="Sell value minus POCO export tax; raw P0 assumed free (extracted)">Chain profit ${suf}</th>
        <th class="num" title="Make one from bought inputs: sell − input cost − export tax">Step margin ${suf}</th>
        <th class="num" title="Raw P0 units consumed">P0 ${suf}</th>
      </tr></thead><tbody>${rows}</tbody></table>
      <div class="muted pi-hint">${perUnit ? 'Per single unit.' : 'Per production run (one factory cycle — the smallest batch).'} Click a row for the full recipe tree and raw-P0 basket.</div>`;
  }

  function showRecipe(typeId) {
    const row = lastRows.find((r) => String(r.type_id) === String(typeId));
    const steps = [];
    const seen = new Set();
    (function walk(pid) {
      const s = byOutput[pid];
      if (!s || seen.has(pid)) return;
      seen.add(pid);
      steps.push(s);
      for (const [inId] of s.inputs) walk(inId);
    })(Number(typeId));
    steps.sort((a, b) => (meta(a.outputs[0][0]).tier - meta(b.outputs[0][0]).tier));

    const stepRows = steps.map((s) => {
      const [oid, oq] = s.outputs[0];
      const ins = s.inputs.map(([i, q]) => `${fmtN(q)}× ${escapeHtml(typeName(i))}`).join(' + ');
      return `<div class="pi-step"><span class="pi-step-tier">${escapeHtml(tierLabel(oid))}</span>
        <span class="pi-step-out">${fmtN(oq)}× ${escapeHtml(typeName(oid))}</span>
        <span class="pi-step-in">← ${ins}</span></div>`;
    }).join('');

    const p0 = row ? Object.entries(row.p0_need)
      .sort((a, b) => b[1] - a[1])
      .map(([id, q]) => `<tr><td>${escapeHtml(typeName(id))}</td><td class="num">${fmtQty(q)}</td></tr>`)
      .join('') : '';

    const pop = $('#pi-popup');
    pop.innerHTML = `<div class="pi-popup-head">
        <strong>${escapeHtml(typeName(typeId))} <span class="muted">(${escapeHtml(tierLabel(typeId))})</span></strong>
        <button class="pi-popup-close" type="button" aria-label="Close">✕</button>
      </div>
      <div class="pi-popup-body">
        <div class="pi-popup-col">
          <div class="pi-popup-h">Production steps</div>${stepRows}
        </div>
        <div class="pi-popup-col">
          <div class="pi-popup-h">Raw P0 per unit</div>
          <table class="pi-p0"><tbody>${p0 || '<tr><td class="muted">n/a</td></tr>'}</tbody></table>
        </div>
      </div>`;
    pop.hidden = false;
    pop.querySelector('.pi-popup-close').addEventListener('click', () => { pop.hidden = true; });
  }

  // ---- system-search autocomplete (bundled name list, 3-char minimum) ----
  let systems = null;
  async function loadSystems() {
    if (systems) return systems;
    try { systems = (await fetch(`${API}/api/pi/systems`).then((r) => r.json())).systems || []; }
    catch (_) { systems = []; }
    return systems;
  }
  function matchSystems(q) {
    q = q.trim().toLowerCase();
    if (q.length < 3 || !systems) return [];
    const starts = [], incl = [];
    for (const s of systems) {
      const l = s.toLowerCase();
      if (l.startsWith(q)) { if (starts.length < 10) starts.push(s); }
      else if (l.includes(q) && incl.length < 10) incl.push(s);
    }
    return starts.concat(incl).slice(0, 10);
  }
  function renderSuggest(matches) {
    const box = $('#pi-suggest');
    if (!matches.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.innerHTML = matches.map((s, i) => `<div class="pi-suggest-item${i === 0 ? ' active' : ''}" data-sys="${escapeHtml(s)}">${escapeHtml(s)}</div>`).join('');
    box.hidden = false;
  }
  function setupSystemSearch() {
    loadSystems();
    const input = $('#pi-system'); const box = $('#pi-suggest');
    const pick = (name) => { input.value = name; box.hidden = true; analyze(); };
    input.addEventListener('input', () => renderSuggest(matchSystems(input.value)));
    input.addEventListener('focus', () => { if (input.value.trim().length >= 3) renderSuggest(matchSystems(input.value)); });
    input.addEventListener('blur', () => setTimeout(() => { box.hidden = true; }, 150));
    box.addEventListener('mousedown', (e) => {   // mousedown beats the input blur
      const it = e.target.closest('.pi-suggest-item');
      if (it) { e.preventDefault(); pick(it.dataset.sys); }
    });
    input.addEventListener('keydown', (e) => {
      const items = box.hidden ? [] : [...box.querySelectorAll('.pi-suggest-item')];
      if (e.key === 'Enter') {
        const active = box.querySelector('.pi-suggest-item.active');
        if (active) { e.preventDefault(); pick(active.dataset.sys); } else { analyze(); }
        return;
      }
      if (!items.length || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
      e.preventDefault();
      let idx = items.findIndex((x) => x.classList.contains('active'));
      idx = e.key === 'ArrowDown' ? Math.min(items.length - 1, idx + 1) : Math.max(0, idx - 1);
      items.forEach((x) => x.classList.remove('active'));
      items[idx].classList.add('active');
    });
  }

  function initTab() {
    loadData().then(() => { if (!lastRows.length) analyze(); });
    if (initialised) return;
    initialised = true;

    $('#pi-analyze').addEventListener('click', analyze);
    setupSystemSearch();
    $('#pi-tax').addEventListener('change', analyze);
    $$('.pi-tier').forEach((c) => c.addEventListener('change', analyze));
    $('#pi-perunit').addEventListener('change', renderTable);   // re-render only; no re-fetch

    // Row click / Enter -> recipe drill-down.
    $('#pi-planner').addEventListener('click', (e) => {
      const tr = e.target.closest('[data-pi-recipe]');
      if (tr) showRecipe(tr.dataset.piRecipe);
    });
    $('#pi-planner').addEventListener('keydown', (e) => {
      const tr = e.target.closest('[data-pi-recipe]');
      if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); showRecipe(tr.dataset.piRecipe); }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { const p = $('#pi-popup'); if (p) p.hidden = true; }
    });
  }

  // The planner is merged into the PI Builder page, so it inits when that tab opens.
  document.querySelector('.tab-btn[data-tab="pi-builder"]')?.addEventListener('click', initTab);
})();
