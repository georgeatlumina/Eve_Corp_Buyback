'use strict';

// ==================== Reaction Calculator ====================
// A ravworks-style planner scoped to reactions. Posts reaction targets + stock +
// a reaction-tuned industry config to /api/industry/plan (the same engine the
// Production Planner uses) and renders the reactions to run, the raw-material
// shopping list, and build-vs-buy cost. Adds a browsable catalog of every
// reaction recipe (/api/reactions/recipes).
//
// Reactions ignore ME; the only material saving comes from a Tatara fitted with
// Standup L-Set Reactor Efficiency rigs (I = 2.0%, II = 2.4% material), scaled by
// space (lowsec ×1.0, null/WH ×1.1). Athanor can run reactions but can't fit the
// rigs, so it gets no material bonus.
//
// Self-contained IIFE; reuses app.js globals ($, escapeHtml, downloadBlob, API)
// and the Production Planner's .prod-* CSS for tables/tiles/tree.

(function () {
  const state = { last: null, loading: false, buyIds: new Set(), catalog: null, matEdited: false };

  const isk = (n) => (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const iskShort = (n) => {
    const v = Number(n) || 0;
    const a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return (v / 1e3).toFixed(0) + 'K';
    return String(Math.round(v));
  };

  // Reactor Efficiency rig material reduction (%) and the security multiplier.
  const RIG_MAT = { none: 0, re1: 2.0, re2: 2.4 };
  const SEC_MULT = { lowsec: 1.0, nullwh: 1.1 };

  // Recompute the material-reduction % from the structure/rig/space presets.
  // Only a Tatara can fit the rigs; an Athanor gets nothing. Skipped once the
  // user hand-edits the % field (so their override sticks until presets change).
  function applyPreset() {
    const structure = $('#rx-structure')?.value || 'tatara';
    const rig = $('#rx-rig')?.value || 'none';
    const space = $('#rx-space')?.value || 'nullwh';
    const rigSel = $('#rx-rig');
    const spaceSel = $('#rx-space');
    const isTatara = structure === 'tatara';
    if (rigSel) rigSel.disabled = !isTatara;
    if (spaceSel) spaceSel.disabled = !isTatara;
    const pct = isTatara ? (RIG_MAT[rig] || 0) * (SEC_MULT[space] || 1) : 0;
    const field = $('#rx-matbonus');
    if (field) field.value = (Math.round(pct * 100) / 100).toString();
    state.matEdited = false;
  }

  function readConfig() {
    const num = (id, def) => {
      const v = parseFloat($(`#${id}`)?.value);
      return Number.isFinite(v) ? v : def;
    };
    return {
      // Reactions ignore ME and manufacturing structure bonuses.
      me: 0,
      structure_material_mult: 1.0,
      reaction_material_mult: (100 - num('rx-matbonus', 0)) / 100,
      cost_index: num('rx-index', 5) / 100,
      system: ($('#rx-system')?.value || '').trim() || null,
      tax: num('rx-tax', 0.25) / 100,
      invention: false,
      market: $('#rx-market')?.value || 'Jita 4-4',
    };
  }

  function fmtIndices(name, indices) {
    const i = indices || {};
    return `${name}: rx ${(100 * (i.reaction || 0)).toFixed(1)}% · mfg ${(100 * (i.manufacturing || 0)).toFixed(1)}%`;
  }

  // Debounced live preview of a system's cost indices as you type.
  let systemTimer = null;
  function updateSystemHint() {
    clearTimeout(systemTimer);
    const hint = $('#rx-system-hint');
    if (!hint) return;
    const q = ($('#rx-system')?.value || '').trim();
    if (!q) { hint.textContent = 'flat index'; return; }
    hint.textContent = '…';
    systemTimer = setTimeout(async () => {
      try {
        const info = await (await fetch(`${API}/api/industry/cost-indices?system=${encodeURIComponent(q)}`)).json();
        if (info.error || !info.indices || !Object.keys(info.indices).length) {
          hint.textContent = `⚠ ${info.error || 'not found'}`;
        } else {
          hint.textContent = fmtIndices(info.name, info.indices);
        }
      } catch (_) { hint.textContent = ''; }
    }, 300);
  }

  async function analyze() {
    const targets = ($('#rx-targets')?.value || '').trim();
    const status = $('#rx-status');
    if (!targets) { if (status) status.textContent = 'Enter or Browse at least one reaction target above.'; return; }
    if (state.loading) return;
    state.loading = true;
    const btn = $('#rx-analyze');
    if (btn) btn.disabled = true;
    if (status) status.textContent = 'Exploding reaction chain & pricing…';
    const cfg = readConfig();
    try {
      const res = await fetch(`${API}/api/industry/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targets_text: targets,
          stock_text: ($('#rx-stock')?.value || '').trim() || undefined,
          me: cfg.me,
          structure_material_mult: cfg.structure_material_mult,
          reaction_material_mult: cfg.reaction_material_mult,
          cost_index: cfg.cost_index,
          system: cfg.system,
          tax: cfg.tax,
          invention: cfg.invention,
          buy_ids: [...state.buyIds],
          market: cfg.market,
          price: true,
        }),
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json()).detail || msg; } catch (_) {}
        throw new Error(msg);
      }
      state.last = await res.json();
      render();
    } catch (e) {
      if (status) status.textContent = `Failed: ${e.message || e}`;
    } finally {
      state.loading = false;
      if (btn) btn.disabled = false;
    }
  }

  function tile(label, value, cls) {
    return `<div class="prod-tile ${cls || ''}"><span class="prod-tile-label">${label}</span><span class="prod-tile-value">${value}</span></div>`;
  }

  function renderSummary(d) {
    const el = $('#rx-summary');
    if (!el) return;
    const t = d.totals || {};
    const priced = d.pricing && d.pricing.priced;
    if (!priced) {
      el.innerHTML = `<p class="muted">Pricing unavailable (${escapeHtml((d.pricing && d.pricing.source) || 'no market data')}). Reaction/material counts below are still valid.</p>`;
      return;
    }
    const delta = (t.buy_cost || 0) - (t.build_cost || 0); // >0 => reacting is cheaper
    const cheaper = delta >= 0;
    const tiles = [
      tile('React cost', isk(t.build_cost) + ' ISK', 'prod-tile-build'),
      tile('&nbsp;· materials', isk(t.materials_cost), 'prod-tile-sub'),
      tile('&nbsp;· job fees', isk(t.jobs_cost), 'prod-tile-sub'),
      tile('Buy finished', isk(t.buy_cost) + ' ISK', 'prod-tile-buy'),
      tile(cheaper ? 'React saves' : 'React costs extra', iskShort(Math.abs(delta)) + ' ISK', cheaper ? 'prod-tile-good' : 'prod-tile-bad'),
    ];
    el.innerHTML = tiles.join('');
  }

  function renderJobs(d) {
    const wrap = $('#rx-jobs');
    const count = $('#rx-jobs-count');
    if (!wrap) return;
    const jobs = d.jobs || [];
    if (count) count.textContent = `${jobs.length} reaction(s)`;
    if (!jobs.length) { wrap.innerHTML = '<p class="muted">No reactions — every target is a raw item.</p>'; return; }
    const priced = d.pricing && d.pricing.priced;
    const rows = jobs.map((j) => {
      const action = `<button class="prod-toggle" data-buy="${j.type_id}" title="Buy this instead of reacting it">→ buy</button>`;
      return `
      <tr>
        <td>${escapeHtml(j.name)}</td>
        <td class="prod-act prod-act-${j.activity}">${j.activity === 'reaction' ? 'reaction' : escapeHtml(j.activity)}</td>
        <td class="num">${j.runs.toLocaleString('en-US')}</td>
        <td class="num">${j.produced.toLocaleString('en-US')}</td>
        ${priced ? `<td class="num">${isk(j.install_cost)}</td>` : ''}
        <td class="prod-action">${action}</td>
      </tr>`;
    }).join('');
    wrap.innerHTML = `
      <table class="prod-table">
        <thead><tr><th>Product</th><th>Type</th><th class="num">Runs</th><th class="num">Output</th>${priced ? '<th class="num">Job fee</th>' : ''}<th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function renderRaw(d) {
    const wrap = $('#rx-raw');
    const count = $('#rx-raw-count');
    if (!wrap) return;
    const raw = d.raw_materials || [];
    const units = raw.reduce((n, r) => n + (r.qty || 0), 0);
    if (count) count.textContent = `${raw.length} line(s) · ${units.toLocaleString('en-US')} units`;
    if (!raw.length) { wrap.innerHTML = '<p class="muted">Nothing to buy.</p>'; return; }
    const priced = d.pricing && d.pricing.priced;
    const rows = raw.map((r) => {
      const action = r.buildable ? `<button class="prod-toggle" data-build="${r.type_id}" title="React this instead of buying it">→ react</button>` : '';
      return `
      <tr>
        <td>${escapeHtml(r.name)}</td>
        <td class="num" title="${(r.qty || 0).toLocaleString('en-US')}">${r.qty || 0}</td>
        ${priced ? `<td class="num">${isk(r.line_cost)}</td>` : ''}
        <td class="prod-action">${action}</td>
      </tr>`;
    }).join('');
    wrap.innerHTML = `
      <table class="prod-table">
        <thead><tr><th>Material</th><th class="num">Qty</th>${priced ? '<th class="num">Cost</th>' : ''}<th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  const TREE_ACT = { manufacturing: 'mfg', reaction: 'reaction', buy: 'buy', raw: 'raw' };

  function treeNodeHtml(node, depth) {
    const act = node.activity || 'raw';
    const qty = (node.qty || 0).toLocaleString('en-US');
    const badge = `<span class="prod-act prod-act-${act}">${TREE_ACT[act] || act}</span>`;
    const meta = [];
    if (node.runs) meta.push(`${node.runs.toLocaleString('en-US')} run${node.runs === 1 ? '' : 's'}`);
    if (node.truncated) meta.push('…truncated');
    const metaHtml = meta.length ? ` <span class="muted">· ${meta.join(' · ')}</span>` : '';
    const line = `${badge} <strong>${escapeHtml(node.name)}</strong> <span class="prod-tree-qty">×${qty}</span>${metaHtml}`;
    const kids = node.children || [];
    if (!kids.length) return `<li class="prod-tree-leaf">${line}</li>`;
    const open = depth < 3 ? ' open' : '';
    return `<li><details${open}><summary>${line}</summary><ul>${kids.map((c) => treeNodeHtml(c, depth + 1)).join('')}</ul></details></li>`;
  }

  function renderTree(d) {
    const pane = $('#rx-tree-pane');
    const wrap = $('#rx-tree');
    const count = $('#rx-tree-count');
    if (!pane || !wrap) return;
    const tree = d.tree || [];
    if (!tree.length) { pane.hidden = true; return; }
    pane.hidden = false;
    const nodes = (function tally(list) { return list.reduce((n, x) => n + 1 + tally(x.children || []), 0); })(tree);
    if (count) count.textContent = `${nodes} node(s)`;
    wrap.innerHTML = `<ul class="prod-tree-root">${tree.map((r) => treeNodeHtml(r, 0)).join('')}</ul>`;
  }

  function renderStatus(d) {
    const status = $('#rx-status');
    if (!status) return;
    const parts = [];
    parts.push(`${(d.jobs || []).length} reaction(s), ${(d.raw_materials || []).length} raw material(s)`);
    if (d.pricing) parts.push(`priced via ${escapeHtml(d.pricing.source || '—')}${d.pricing.api_key ? '' : ' (no Janice key — set one in Config for best prices)'}`);
    if (d.cost_system) {
      parts.push(d.cost_system.error
        ? `⚠ system: ${escapeHtml(d.cost_system.error)}`
        : `cost @ ${escapeHtml(fmtIndices(d.cost_system.name, d.cost_system.indices))}`);
    }
    if (d.unresolved_targets && d.unresolved_targets.length) {
      parts.push(`⚠ unresolved: ${d.unresolved_targets.map(escapeHtml).join(', ')}`);
    }
    if (d.warnings && d.warnings.length) parts.push('⚠ ' + d.warnings.map(escapeHtml).join('; '));
    if (state.buyIds.size) parts.push(`${state.buyIds.size} item(s) forced to buy — <a href="#" data-rx-reset="1">react all</a>`);
    status.innerHTML = parts.join(' · ');
  }

  function setBuild(typeId, buy) {
    const tid = Number(typeId);
    if (buy) state.buyIds.add(tid); else state.buyIds.delete(tid);
    analyze(); // re-explode with the new react/buy split
  }

  function render() {
    const d = state.last;
    if (!d) return;
    renderSummary(d);
    renderJobs(d);
    renderRaw(d);
    renderTree(d);
    renderStatus(d);
  }

  // ---- Catalog browser (all reaction recipes, grouped) ----
  async function loadCatalog() {
    if (state.catalog) return state.catalog;
    const res = await fetch(`${API}/api/reactions/recipes`);
    state.catalog = await res.json();
    return state.catalog;
  }

  function renderCatalog(filter) {
    const list = $('#rx-catalog-list');
    const count = $('#rx-catalog-count');
    if (!list || !state.catalog) return;
    const f = (filter || '').trim().toLowerCase();
    let shown = 0;
    const html = (state.catalog.groups || []).map((g) => {
      const items = g.items.filter((it) => !f || it.name.toLowerCase().includes(f));
      if (!items.length) return '';
      shown += items.length;
      const rows = items.map((it) =>
        `<button type="button" class="rx-cat-item" data-name="${escapeHtml(it.name)}" title="${it.inputs} input(s), ${it.output_qty}/run — click to add">${escapeHtml(it.name)}</button>`,
      ).join('');
      return `<div class="rx-cat-group"><div class="rx-cat-group-h">${escapeHtml(g.group)} <span class="muted">(${items.length})</span></div><div class="rx-cat-items">${rows}</div></div>`;
    }).join('');
    list.innerHTML = html || '<p class="muted">No matching reactions.</p>';
    if (count) count.textContent = `${shown} of ${state.catalog.total} reactions`;
  }

  async function toggleCatalog() {
    const panel = $('#rx-catalog');
    if (!panel) return;
    const opening = panel.hidden;
    panel.hidden = !opening;
    if (opening) {
      try {
        await loadCatalog();
        renderCatalog($('#rx-catalog-search')?.value || '');
        $('#rx-catalog-search')?.focus();
      } catch (_) {
        const list = $('#rx-catalog-list');
        if (list) list.innerHTML = '<p class="muted">Couldn’t load the reaction catalog.</p>';
      }
    }
  }

  // Append "Name xQty" to the targets box (bumping the qty if it's already there).
  function addTarget(name) {
    const box = $('#rx-targets');
    if (!box) return;
    const qty = Math.max(1, parseInt($('#rx-catalog-qty')?.value, 10) || 1);
    const lines = box.value.split('\n');
    const idx = lines.findIndex((l) => {
      const m = l.trim().toLowerCase().replace(/\s+x\d+$/, '');
      return m === name.toLowerCase();
    });
    if (idx >= 0) {
      const cur = (lines[idx].match(/x(\d+)\s*$/) || [])[1];
      lines[idx] = `${name} x${(parseInt(cur, 10) || 1) + qty}`;
    } else {
      lines.push(`${name} x${qty}`);
    }
    box.value = lines.filter((l) => l.trim()).join('\n') + '\n';
  }

  // In-game Multibuy accepts one "Name xN" per line.
  function rawMultibuy() {
    const raw = (state.last && state.last.raw_materials) || [];
    return raw.map((r) => `${r.name} x${r.qty}`).join('\n');
  }

  async function copyRaw() {
    const text = rawMultibuy();
    const status = $('#rx-status');
    if (!text) { if (status) status.textContent = 'Nothing to copy — run Analyze first.'; return; }
    try {
      await navigator.clipboard.writeText(text);
      if (status) status.textContent = `Copied ${(state.last.raw_materials || []).length}-line Multibuy list — paste into the in-game Multibuy window.`;
    } catch (_) { if (status) status.textContent = 'Clipboard copy failed.'; }
  }

  function downloadRaw() {
    const text = rawMultibuy();
    if (!text) { const s = $('#rx-status'); if (s) s.textContent = 'Nothing to download — run Analyze first.'; return; }
    downloadBlob('reaction-shopping-list.txt', 'text/plain', `${text}\n`);
  }

  let wired = false;
  function initTab() {
    if (wired) return;
    wired = true;
    applyPreset();
    $('#rx-analyze')?.addEventListener('click', analyze);
    $('#rx-browse')?.addEventListener('click', toggleCatalog);
    $('#rx-copy-raw')?.addEventListener('click', copyRaw);
    $('#rx-dl-raw')?.addEventListener('click', downloadRaw);
    ['#rx-structure', '#rx-rig', '#rx-space'].forEach((s) => $(s)?.addEventListener('change', applyPreset));
    $('#rx-matbonus')?.addEventListener('input', () => { state.matEdited = true; });
    $('#rx-catalog-search')?.addEventListener('input', (e) => renderCatalog(e.target.value));
    $('#rx-catalog-list')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-name]');
      if (btn) addTarget(btn.dataset.name);
    });
    // Delegated react/buy toggles (tables re-render each analyze).
    $('#rx-jobs')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-buy]');
      if (btn) setBuild(btn.dataset.buy, true);
    });
    $('#rx-raw')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-build]');
      if (btn) setBuild(btn.dataset.build, false);
    });
    $('#rx-tree-expand')?.addEventListener('click', () => {
      document.querySelectorAll('#rx-tree details').forEach((el) => { el.open = true; });
    });
    $('#rx-tree-collapse')?.addEventListener('click', () => {
      document.querySelectorAll('#rx-tree details').forEach((el) => { el.open = false; });
    });
    $('#rx-status')?.addEventListener('click', (e) => {
      if (e.target.closest('[data-rx-reset]')) {
        e.preventDefault();
        if (!state.buyIds.size) return;
        state.buyIds.clear();
        analyze();
      }
    });
    $('#rx-targets')?.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); analyze(); }
    });
    $('#rx-system')?.addEventListener('input', updateSystemHint);
  }

  document.querySelector('.tab-btn[data-tab="reactions"]')?.addEventListener('click', initTab);
})();
