'use strict';

// ============== Production Planner (industry BOM explosion) ==============
// A ravworks-style manufacturing planner. Posts a build target list + on-hand
// stock + industry config to /api/industry/plan (python/industry.py engine) and
// renders the resulting jobs, raw-material shopping list, and build-vs-buy cost.
// Self-contained IIFE; reuses app.js globals ($, escapeHtml, downloadBlob, API).

(function () {
  const state = { last: null, loading: false, buyIds: new Set() };

  const isk = (n) => (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const iskShort = (n) => {
    const v = Number(n) || 0;
    const a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return (v / 1e3).toFixed(0) + 'K';
    return String(Math.round(v));
  };

  function readConfig() {
    const num = (id, def) => {
      const v = parseFloat($(`#${id}`)?.value);
      return Number.isFinite(v) ? v : def;
    };
    const decr = $('#prod-decryptor')?.value || 'None';
    return {
      me: num('prod-me', 10),
      // UI collects a material *reduction %*; the engine wants a multiplier.
      structure_material_mult: (100 - num('prod-struct', 0)) / 100,
      reaction_material_mult: (100 - num('prod-rx', 0)) / 100,
      cost_index: num('prod-index', 5) / 100,
      system: ($('#prod-system')?.value || '').trim() || null,
      tax: num('prod-tax', 0.25) / 100,
      invention: !!$('#prod-invention')?.checked,
      decryptor: decr === 'None' ? null : decr,
      invention_skill_level: num('prod-inv-skill', 4),
      market: $('#prod-market')?.value || 'Jita 4-4',
    };
  }

  async function loadDecryptors() {
    const sel = $('#prod-decryptor');
    if (!sel || sel.options.length) return;
    try {
      const res = await fetch(`${API}/api/industry/decryptors`);
      const { decryptors } = await res.json();
      sel.innerHTML = decryptors.map((d) => {
        const mods = d.key === 'None' ? '' : ` (×${d.prob} prob, ME${d.me >= 0 ? '+' : ''}${d.me}, +${d.runs} runs)`;
        return `<option value="${d.key}">${escapeHtml(d.name)}${mods}</option>`;
      }).join('');
    } catch (_) {
      sel.innerHTML = '<option value="None">No decryptor</option>';
    }
  }

  function fmtIndices(name, indices) {
    const i = indices || {};
    return `${name}: mfg ${(100 * (i.manufacturing || 0)).toFixed(1)}% · rx ${(100 * (i.reaction || 0)).toFixed(1)}%`;
  }

  // Debounced live preview of a system's cost indices as you type.
  let systemTimer = null;
  function updateSystemHint() {
    clearTimeout(systemTimer);
    const hint = $('#prod-system-hint');
    if (!hint) return;
    const q = ($('#prod-system')?.value || '').trim();
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
    const targets = ($('#prod-targets')?.value || '').trim();
    const status = $('#prod-status');
    if (!targets) { if (status) status.textContent = 'Enter at least one build target above.'; return; }
    if (state.loading) return;
    state.loading = true;
    const btn = $('#prod-analyze');
    if (btn) btn.disabled = true;
    if (status) status.textContent = 'Exploding production tree & pricing…';
    const cfg = readConfig();
    try {
      const res = await fetch(`${API}/api/industry/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targets_text: targets,
          stock_text: ($('#prod-stock')?.value || '').trim() || undefined,
          me: cfg.me,
          structure_material_mult: cfg.structure_material_mult,
          reaction_material_mult: cfg.reaction_material_mult,
          cost_index: cfg.cost_index,
          system: cfg.system,
          tax: cfg.tax,
          invention: cfg.invention,
          decryptor: cfg.decryptor,
          invention_skill_level: cfg.invention_skill_level,
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
    const el = $('#prod-summary');
    if (!el) return;
    const t = d.totals || {};
    const priced = d.pricing && d.pricing.priced;
    if (!priced) {
      el.innerHTML = `<p class="muted">Pricing unavailable (${escapeHtml((d.pricing && d.pricing.source) || 'no market data')}). Job/material counts below are still valid.</p>`;
      return;
    }
    const delta = (t.buy_cost || 0) - (t.build_cost || 0); // >0 => building is cheaper
    const cheaper = delta >= 0;
    const inv = d.invention || {};
    const tiles = [
      tile('Build cost', isk(t.build_cost) + ' ISK', 'prod-tile-build'),
      tile('&nbsp;· materials', isk(t.materials_cost), 'prod-tile-sub'),
      tile('&nbsp;· job fees', isk(t.jobs_cost), 'prod-tile-sub'),
    ];
    if (inv.job_count) {
      tiles.push(tile(`&nbsp;· invention (${inv.total_attempts} tries)`, isk(t.invention_cost), 'prod-tile-sub'));
    }
    tiles.push(tile('Buy finished', isk(t.buy_cost) + ' ISK', 'prod-tile-buy'));
    tiles.push(tile(cheaper ? 'Build saves' : 'Build costs extra', iskShort(Math.abs(delta)) + ' ISK', cheaper ? 'prod-tile-good' : 'prod-tile-bad'));
    el.innerHTML = tiles.join('');
  }

  const ACT_LABEL = { manufacturing: 'mfg', reaction: 'reaction', invention: 'invent' };

  function renderJobs(d) {
    const wrap = $('#prod-jobs');
    const count = $('#prod-jobs-count');
    if (!wrap) return;
    const jobs = d.jobs || [];
    if (count) count.textContent = `${jobs.length} job(s)`;
    if (!jobs.length) { wrap.innerHTML = '<p class="muted">No jobs — every target is a raw item.</p>'; return; }
    const priced = d.pricing && d.pricing.priced;
    const rows = jobs.map((j) => {
      const isInv = j.activity === 'invention';
      const nameCell = isInv
        ? `${escapeHtml(j.name)} <span class="muted">· ${Math.round((j.probability || 0) * 100)}% chance${j.decryptor ? ' · ' + escapeHtml(j.decryptor) : ''}</span>`
        : escapeHtml(j.name);
      const runsLabel = isInv ? `${j.runs.toLocaleString('en-US')} tries` : j.runs.toLocaleString('en-US');
      const outLabel = isInv ? `${j.produced.toLocaleString('en-US')} BPC` : j.produced.toLocaleString('en-US');
      const action = isInv ? '' : `<button class="prod-toggle" data-buy="${j.type_id}" title="Buy this instead of building it">→ buy</button>`;
      return `
      <tr>
        <td>${nameCell}</td>
        <td class="prod-act prod-act-${j.activity}">${ACT_LABEL[j.activity] || j.activity}</td>
        <td class="num">${runsLabel}</td>
        <td class="num">${outLabel}</td>
        ${priced ? `<td class="num">${isInv ? '—' : isk(j.install_cost)}</td>` : ''}
        <td class="prod-action">${action}</td>
      </tr>`;
    }).join('');
    wrap.innerHTML = `
      <table class="prod-table">
        <thead><tr><th>Item</th><th>Type</th><th class="num">Runs</th><th class="num">Output</th>${priced ? '<th class="num">Job fee</th>' : ''}<th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function renderRaw(d) {
    const wrap = $('#prod-raw');
    const count = $('#prod-raw-count');
    if (!wrap) return;
    const raw = d.raw_materials || [];
    const units = raw.reduce((n, r) => n + (r.qty || 0), 0);
    if (count) count.textContent = `${raw.length} line(s) · ${units.toLocaleString('en-US')} units`;
    if (!raw.length) { wrap.innerHTML = '<p class="muted">Nothing to buy.</p>'; return; }
    const priced = d.pricing && d.pricing.priced;
    const rows = raw.map((r) => {
      const action = r.buildable ? `<button class="prod-toggle" data-build="${r.type_id}" title="Build this instead of buying it">→ build</button>` : '';
      return `
      <tr${r.invention ? ' class="prod-raw-inv"' : ''}>
        <td>${escapeHtml(r.name)}${r.invention ? ' <span class="prod-inv-badge">inv</span>' : ''}</td>
        <td class="num">${(r.qty || 0).toLocaleString('en-US')}</td>
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

  const TREE_ACT = { manufacturing: 'mfg', reaction: 'reaction', invention: 'invent', buy: 'buy', raw: 'raw' };

  function treeNodeHtml(node, depth) {
    const act = node.activity || 'raw';
    const qty = (node.qty || 0).toLocaleString('en-US');
    const badge = `<span class="prod-act prod-act-${act}">${TREE_ACT[act] || act}</span>`;
    const meta = [];
    if (node.runs) meta.push(`${node.runs.toLocaleString('en-US')} run${node.runs === 1 ? '' : 's'}`);
    if (node.invented) meta.push(`invent ${Math.round((node.probability || 0) * 100)}%`);
    if (node.truncated) meta.push('…truncated');
    const metaHtml = meta.length ? ` <span class="muted">· ${meta.join(' · ')}</span>` : '';
    const line = `${badge} <strong>${escapeHtml(node.name)}</strong> <span class="prod-tree-qty">×${qty}</span>${metaHtml}`;
    const kids = node.children || [];
    if (!kids.length) return `<li class="prod-tree-leaf">${line}</li>`;
    const open = depth < 2 ? ' open' : '';
    return `<li><details${open}><summary>${line}</summary><ul>${kids.map((c) => treeNodeHtml(c, depth + 1)).join('')}</ul></details></li>`;
  }

  function renderTree(d) {
    const pane = $('#prod-tree-pane');
    const wrap = $('#prod-tree');
    const count = $('#prod-tree-count');
    if (!pane || !wrap) return;
    const tree = d.tree || [];
    if (!tree.length) { pane.hidden = true; return; }
    pane.hidden = false;
    const nodes = (function tally(list) { return list.reduce((n, x) => n + 1 + tally(x.children || []), 0); })(tree);
    if (count) count.textContent = `${nodes} node(s)`;
    wrap.innerHTML = `<ul class="prod-tree-root">${tree.map((r) => treeNodeHtml(r, 0)).join('')}</ul>`;
  }

  function renderStatus(d) {
    const status = $('#prod-status');
    if (!status) return;
    const parts = [];
    const jobs = (d.jobs || []).length;
    parts.push(`${jobs} job(s), ${(d.raw_materials || []).length} raw material(s)`);
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
    if (state.buyIds.size) parts.push(`${state.buyIds.size} item(s) forced to buy — <a href="#" data-prod-reset="1">build all</a>`);
    status.innerHTML = parts.join(' · ');
  }

  function setBuild(typeId, buy) {
    const tid = Number(typeId);
    if (buy) state.buyIds.add(tid); else state.buyIds.delete(tid);
    analyze(); // re-explode with the new build/buy split
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

  // In-game Multibuy accepts one "Name xN" per line — this is that exact format,
  // so the copied/downloaded list pastes straight into the Multibuy window.
  function rawMultibuy() {
    const raw = (state.last && state.last.raw_materials) || [];
    return raw.map((r) => `${r.name} x${r.qty}`).join('\n');
  }

  async function copyRaw() {
    const text = rawMultibuy();
    const status = $('#prod-status');
    if (!text) { if (status) status.textContent = 'Nothing to copy — run Analyze first.'; return; }
    try {
      await navigator.clipboard.writeText(text);
      if (status) status.textContent = `Copied ${(state.last.raw_materials || []).length}-line Multibuy list — paste into the in-game Multibuy window.`;
    } catch (_) { if (status) status.textContent = 'Clipboard copy failed.'; }
  }

  function downloadRaw() {
    const text = rawMultibuy();
    if (!text) { const s = $('#prod-status'); if (s) s.textContent = 'Nothing to download — run Analyze first.'; return; }
    downloadBlob('production-shopping-list.txt', 'text/plain', `${text}\n`);
  }

  let wired = false;
  function initTab() {
    loadDecryptors();
    if (wired) return;
    wired = true;
    $('#prod-analyze')?.addEventListener('click', analyze);
    $('#prod-copy-raw')?.addEventListener('click', copyRaw);
    $('#prod-dl-raw')?.addEventListener('click', downloadRaw);
    // Delegated build/buy toggles (tables re-render each analyze).
    $('#prod-jobs')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-buy]');
      if (btn) setBuild(btn.dataset.buy, true);
    });
    $('#prod-raw')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-build]');
      if (btn) setBuild(btn.dataset.build, false);
    });
    $('#prod-tree-expand')?.addEventListener('click', () => {
      document.querySelectorAll('#prod-tree details').forEach((el) => { el.open = true; });
    });
    $('#prod-tree-collapse')?.addEventListener('click', () => {
      document.querySelectorAll('#prod-tree details').forEach((el) => { el.open = false; });
    });
    $('#prod-status')?.addEventListener('click', (e) => {
      if (e.target.closest('[data-prod-reset]')) {
        e.preventDefault();
        if (!state.buyIds.size) return;
        state.buyIds.clear();
        analyze();
      }
    });
    // Ctrl/Cmd+Enter in the targets box fires Analyze.
    $('#prod-targets')?.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); analyze(); }
    });
    $('#prod-system')?.addEventListener('input', updateSystemHint);
  }

  document.querySelector('.tab-btn[data-tab="production"]')?.addEventListener('click', initTab);
})();
