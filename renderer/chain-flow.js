'use strict';

// ============ Interactive production/reaction chain flow ============
// A left→right node graph (like the PI chain calculator): one column per tier
// (raw → product), every item an editable quantity + run count, SVG connector
// lines from each input to what it feeds, click a node to highlight its full
// sub-chain, and edit ANY quantity to rescale the whole chain proportionally.
// Read-only viewer over a plan's `tree`. Reuses the PI flow CSS (.pib-flow etc.)
// and app.js's escapeHtml. window.ChainFlow(container, tree) -> { redraw }.
//
// The input/click handlers are DOM-driven (read data-* attrs + the rendered
// paths), so a single set of delegated listeners keeps working every time the
// chain is re-rendered by a fresh Analyze.

(function () {
  const esc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(s) : String(s == null ? '' : s));
  const IMG = 'https://images.evetech.net';

  function runLabel(activity, qty, out) {
    if (activity === 'buy') return 'buy';
    if (activity === 'raw') return 'raw';
    return `${Math.ceil(qty / (out || 1)).toLocaleString('en-US')} run(s)`;
  }

  // Flatten a plan tree into distinct nodes (tier + gross base qty + output/run)
  // and the set of input→output edges.
  function build(tree) {
    const nodes = {};
    const edges = new Set();
    function walk(node) {
      const kids = node.children || [];
      const childTiers = kids.map(walk);
      const tier = kids.length ? 1 + Math.max(0, ...childTiers) : 0;
      let n = nodes[node.type_id];
      if (!n) n = nodes[node.type_id] = { tid: String(node.type_id), name: node.name, base: 0, tier, out: node.output_qty || 1, activity: node.activity || 'raw' };
      n.base += Math.ceil(node.qty || 0);
      if (tier > n.tier) n.tier = tier;
      if (node.output_qty) n.out = node.output_qty;
      for (const c of kids) edges.add(`${c.type_id}>${node.type_id}`);
      return tier;
    }
    (tree || []).forEach(walk);
    return { nodes: Object.values(nodes), edges };
  }

  // ---- delegated (stateless) handlers: wired once per container ----
  function wire(container) {
    if (container.dataset.cfWired) return;
    container.dataset.cfWired = '1';

    // Edit any quantity -> rescale the whole chain proportionally.
    container.addEventListener('input', (e) => {
      const elm = e.target.closest('.cf-q');
      if (!elm) return;
      const base = parseFloat(elm.dataset.base) || 0;
      const v = parseFloat(elm.value);
      if (!(base > 0) || !Number.isFinite(v)) return;
      const scale = v / base;
      container.querySelectorAll('.cf-q').forEach((q) => {
        const b = parseFloat(q.dataset.base) || 0;
        const qty = b * scale;
        if (q !== elm) q.value = Math.round(qty);
        if (q.nextElementSibling) q.nextElementSibling.textContent = runLabel(q.dataset.activity, qty, parseFloat(q.dataset.out) || 1);
      });
      // Push the rescale through to the actual plan (tree/jobs/shopping list),
      // debounced so it re-plans once the user stops typing rather than per key.
      if (container._cfRescale && Math.abs(scale - 1) > 1e-6) {
        clearTimeout(container._cfRescaleTimer);
        container._cfRescaleTimer = setTimeout(() => container._cfRescale(scale), 700);
      }
    });

    // Click a node -> highlight its connected sub-chain (upstream + downstream).
    container.addEventListener('click', (e) => {
      if (e.target.closest('.cf-q')) return;
      const node = e.target.closest('.cf-node');
      const flow = container.querySelector('.pib-flow');
      if (!node || !flow) return;
      const already = node.classList.contains('cf-hi-root');
      flow.classList.remove('pib-flow-focus');
      flow.querySelectorAll('.pib-node-hi').forEach((n) => n.classList.remove('pib-node-hi'));
      flow.querySelectorAll('.cf-hi-root').forEach((n) => n.classList.remove('cf-hi-root'));
      flow.querySelectorAll('.pib-line-hi').forEach((p) => p.classList.remove('pib-line-hi'));
      if (already) { if (container._cfSelect) container._cfSelect(null); return; }
      const paths = [...flow.querySelectorAll('.pib-flow-lines path')];
      const set = new Set([node.dataset.tid]);
      const step = (x, up) => {
        for (const p of paths) {
          const from = up ? p.dataset.dst : p.dataset.src;
          const to = up ? p.dataset.src : p.dataset.dst;
          if (from === x && !set.has(to)) { set.add(to); step(to, up); }
        }
      };
      step(node.dataset.tid, true);
      step(node.dataset.tid, false);
      flow.classList.add('pib-flow-focus');
      flow.querySelectorAll('.cf-node').forEach((n) => n.classList.toggle('pib-node-hi', set.has(n.dataset.tid)));
      node.classList.add('cf-hi-root');
      flow.querySelectorAll('.pib-flow-lines path').forEach((p) => p.classList.toggle('pib-line-hi', set.has(p.dataset.src) && set.has(p.dataset.dst)));
      if (container._cfSelect) container._cfSelect(node.dataset.tid);
    });
  }

  function ChainFlow(container, tree, opts) {
    if (!container) return null;
    wire(container);
    container._cfSelect = (opts && opts.onSelect) || null;
    container._cfRescale = (opts && opts.onRescale) || null;
    const { nodes, edges } = build(tree);
    if (!nodes.length) { container.innerHTML = '<p class="muted">Run Analyze to see the chain.</p>'; return null; }
    const maxTier = nodes.reduce((m, n) => Math.max(m, n.tier), 0);

    const byTier = {};
    for (const n of nodes) (byTier[n.tier] = byTier[n.tier] || []).push(n);
    const cols = [];
    for (let t = 0; t <= maxTier; t++) {
      const col = (byTier[t] || []).sort((a, b) => a.name.localeCompare(b.name));
      if (!col.length) continue;
      const label = t === 0 ? 'RAW' : (t === maxTier ? 'PRODUCT' : 'T' + t);
      const cells = col.map((n) => `<div class="pib-node cf-node${t === maxTier ? ' pib-node-product' : ''}" data-tid="${n.tid}">
        <div class="cf-name" title="${esc(n.name)}"><img class="cf-icon" src="${IMG}/types/${n.tid}/icon?size=32" alt="" onerror="this.style.display='none'"><span>${esc(n.name)}</span></div>
        <div class="pib-node-row">
          <input class="cf-q" data-tid="${n.tid}" data-base="${n.base}" data-out="${n.out}" data-activity="${n.activity}" type="number" min="0" value="${Math.round(n.base)}" />
          <span class="pib-node-runs muted">${runLabel(n.activity, n.base, n.out)}</span>
        </div>
      </div>`).join('');
      cols.push(`<div class="pib-flow-col"><div class="pib-flow-col-h">${esc(label)}</div>${cells}</div>`);
    }
    container.innerHTML = `<div class="pib-flow"><svg class="pib-flow-lines" xmlns="http://www.w3.org/2000/svg"></svg><div class="pib-flow-cols">${cols.join('')}</div></div>`;

    function drawLines() {
      const flow = container.querySelector('.pib-flow');
      if (!flow) return;
      const svg = flow.querySelector('.pib-flow-lines');
      const grid = flow.querySelector('.pib-flow-cols');
      const W = grid.offsetWidth, H = grid.offsetHeight;
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.style.width = `${W}px`; svg.style.height = `${H}px`;
      const el = {};
      flow.querySelectorAll('.cf-node').forEach((n) => { el[n.dataset.tid] = n; });
      const paths = [];
      for (const e of edges) {
        const i = e.indexOf('>');
        const src = e.slice(0, i), dst = e.slice(i + 1);
        const s = el[src], d = el[dst];
        if (!s || !d) continue;
        const x1 = s.offsetLeft + s.offsetWidth, y1 = s.offsetTop + s.offsetHeight / 2;
        const x2 = d.offsetLeft, y2 = d.offsetTop + d.offsetHeight / 2;
        const dx = Math.max(18, (x2 - x1) * 0.4);
        paths.push(`<path data-src="${src}" data-dst="${dst}" d="M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}" />`);
      }
      svg.innerHTML = paths.join('');
    }

    drawLines();
    return { redraw: drawLines };
  }

  // ---- Node blow-up detail panel ----
  // ctx: { assetsTotals:{tid:owned}, isBuy(tid), onToggleBuy(tid), runsFor(tid),
  //        nameFor(tid) }. Renders inputs/outputs, the blueprint name (copyable),
  //        availability colouring (green full / yellow partial / red missing),
  //        and a build<->buy toggle that the planner re-plans from.
  window.renderNodeDetail = async function (container, typeId, ctx) {
    if (!container) return;
    if (typeId == null) { container.innerHTML = ''; container.hidden = true; return; }
    container.hidden = false;
    container.innerHTML = '<p class="muted">Loading recipe…</p>';
    let r;
    try {
      const res = await fetch(`${API}/api/industry/recipe/${typeId}`);
      if (res.status === 404) {
        const nm = ctx && ctx.nameFor ? ctx.nameFor(typeId) : `type ${typeId}`;
        container.innerHTML = `<div class="cfd-head"><img class="cfd-icon" src="${IMG}/types/${typeId}/icon?size=32" onerror="this.style.display='none'"><strong>${esc(nm)}</strong> <span class="muted">— raw material (bought; no recipe)</span></div>`;
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      r = await res.json();
    } catch (e) {
      container.innerHTML = `<p class="muted">Couldn't load recipe: ${esc(String(e.message || e))}</p>`;
      return;
    }
    const runs = (ctx && ctx.runsFor && ctx.runsFor(typeId)) || 1;
    const owned = (ctx && ctx.assetsTotals) || {};
    const isBuy = !!(ctx && ctx.isBuy && ctx.isBuy(typeId));
    const rows = r.materials.map((m) => {
      const total = Math.ceil(m.per_run * runs);
      const o = owned[m.type_id] || 0;
      const cls = o <= 0 ? 'cfd-miss' : (o >= total ? 'cfd-have' : 'cfd-part');
      return `<tr class="${cls}"><td><img class="cfd-icon" src="${IMG}/types/${m.type_id}/icon?size=32" onerror="this.style.display='none'">${esc(m.name)}</td>`
        + `<td class="num">${m.per_run.toLocaleString('en-US')}/run</td><td class="num">${total.toLocaleString('en-US')}</td>`
        + `<td class="num muted">${o ? 'have ' + o.toLocaleString('en-US') : '—'}</td></tr>`;
    }).join('');
    container.innerHTML = `
      <div class="cfd-head">
        <img class="cfd-icon" src="${IMG}/types/${r.type_id}/icon?size=32" onerror="this.style.display='none'">
        <strong>${esc(r.name)}</strong> <span class="cfd-act">${esc(r.activity)}</span>
        <span class="muted">· ${runs.toLocaleString('en-US')} run(s) → ${(r.output_qty * runs).toLocaleString('en-US')} produced (${r.output_qty}/run)</span>
      </div>
      <div class="cfd-bp">
        <span class="muted">Recipe:</span>
        <button type="button" class="cfd-copy" data-copy="${esc(r.blueprint_name)}" title="Copy the blueprint/formula name to paste in the in-game market/search">📋 ${esc(r.blueprint_name)}</button>
        ${ctx && ctx.onToggleBuy ? `<button type="button" class="cfd-buytoggle secondary" data-tid="${r.type_id}">${isBuy ? '↩ Build instead' : '🛒 Buy instead → shopping list'}</button>` : ''}
        ${ctx && ctx.onMultiply ? '<span class="cfd-mult muted">Scale chain: <button type="button" class="cfd-mbtn" data-f="2">×2</button> <button type="button" class="cfd-mbtn" data-f="5">×5</button> <button type="button" class="cfd-mbtn" data-f="10">×10</button></span>' : ''}
      </div>
      <table class="cfd-mats"><thead><tr><th>Input</th><th class="num">Per run</th><th class="num">Total needed</th><th class="num">On hand</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="muted small cfd-legend"><span class="cfd-have">green = enough</span> · <span class="cfd-part">yellow = partial</span> · <span class="cfd-miss">red = missing</span> — from your assets.</p>`;
    container.querySelector('.cfd-copy')?.addEventListener('click', (e) => {
      const t = e.currentTarget.getAttribute('data-copy');
      navigator.clipboard?.writeText(t).then(() => { e.currentTarget.textContent = '✓ Copied'; }).catch(() => {});
    });
    container.querySelector('.cfd-buytoggle')?.addEventListener('click', () => { if (ctx && ctx.onToggleBuy) ctx.onToggleBuy(typeId); });
    container.querySelectorAll('.cfd-mbtn').forEach((b) => b.addEventListener('click', () => { if (ctx && ctx.onMultiply) ctx.onMultiply(parseFloat(b.dataset.f)); }));
  };

  window.ChainFlow = ChainFlow;
})();
