// ====================== Stockpile tab ======================
// Read-only dashboard of alliance industry-material stock (minerals / PI /
// other), synced from inventory/stock.json in the market-history GitHub repo.
// The admin paste/save panel (shown only when "Allow stock edits" is on in
// Config) parses an EVE inventory paste server-side, auto-categorizes it, and
// pushes the whole list back to the repo.
//
// Loaded after app.js; relies on its globals: $, $$, API, escapeHtml.

(() => {
  const CATS = [
    { key: 'minerals', label: 'Minerals' },
    { key: 'pi', label: 'Planetary (PI)' },
    { key: 'other', label: 'Other' },
  ];

  const sp = {
    loaded: false,
    loading: false,
    data: null,        // { items, updated_at, note, storage, totals }
    search: '',
    category: '',
  };

  const nfmt = (n) => Number(n || 0).toLocaleString('en-US');

  function fmtWhen(iso) {
    if (!iso) return 'never';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleString();
  }

  function setStatus(msg) {
    const el = $('#stockpile-status');
    if (el) el.textContent = msg || '';
  }

  async function loadStockpile(force) {
    if (sp.loading) return;
    if (sp.loaded && !force) { render(); return; }
    sp.loading = true;
    setStatus('Loading…');
    try {
      const res = await fetch(`${API}/api/stockpile`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      sp.data = await res.json();
      sp.loaded = true;
      setStatus('');
    } catch (e) {
      setStatus(`Failed to load: ${e.message || e}`);
      sp.data = sp.data || { items: [], totals: {}, updated_at: '', storage: 'local' };
    } finally {
      sp.loading = false;
    }
    render();
  }

  function renderTiles() {
    const root = $('#stockpile-tiles');
    if (!root || !sp.data) return;
    const totals = sp.data.totals || {};
    const tile = (val, label) =>
      `<div class="market-tile"><div class="market-tile-val">${val}</div><div class="market-tile-label">${label}</div></div>`;
    const cats = CATS.map((c) => tile(nfmt((totals[c.key] || {}).lines || 0), `${c.label} lines`));
    const totalLines = (sp.data.items || []).length;
    const src = sp.data.storage === 'github' ? 'Shared repo' : 'Local only';
    root.innerHTML = [
      tile(nfmt(totalLines), 'Total lines'),
      ...cats,
      tile(escapeHtml(fmtWhen(sp.data.updated_at)), 'Last updated'),
      tile(escapeHtml(src), 'Source'),
    ].join('');
  }

  function filteredItems() {
    const q = sp.search.trim().toLowerCase();
    return (sp.data?.items || []).filter((it) => {
      if (sp.category && it.category !== sp.category) return false;
      if (q && !(it.name || '').toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function renderSections() {
    const root = $('#stockpile-sections');
    if (!root || !sp.data) return;
    const items = filteredItems();
    const count = $('#stockpile-count');
    if (count) count.textContent = items.length ? `${items.length} material${items.length === 1 ? '' : 's'}` : '';

    if (!(sp.data.items || []).length) {
      root.innerHTML = '<p class="muted">No stock recorded yet.</p>';
      return;
    }
    if (!items.length) {
      root.innerHTML = '<p class="muted">No materials match the current filter.</p>';
      return;
    }

    const byCat = { minerals: [], pi: [], other: [] };
    items.forEach((it) => { (byCat[it.category] || byCat.other).push(it); });

    const blocks = [];
    CATS.forEach((c) => {
      const rows = byCat[c.key];
      if (!rows.length) return;
      rows.sort((a, b) => (b.qty || 0) - (a.qty || 0));
      const total = rows.reduce((s, r) => s + (r.qty || 0), 0);
      const body = rows.map((r) =>
        `<tr><td>${escapeHtml(r.name)}</td><td class="num">${nfmt(r.qty)}</td></tr>`
      ).join('');
      blocks.push(`
        <div class="stockpile-cat">
          <h3 class="stockpile-cat-head">${escapeHtml(c.label)} <span class="muted stockpile-cat-meta">${rows.length} line${rows.length === 1 ? '' : 's'} · ${nfmt(total)} units</span></h3>
          <div class="market-table-wrap">
            <table class="market-table">
              <thead><tr><th>Material</th><th class="num">Quantity</th></tr></thead>
              <tbody>${body}</tbody>
            </table>
          </div>
        </div>`);
    });
    root.innerHTML = blocks.join('');
  }

  function render() {
    renderTiles();
    renderSections();
  }

  async function saveStockpile() {
    const text = ($('#stockpile-paste')?.value || '').trim();
    const note = ($('#stockpile-note')?.value || '').trim();
    const statusEl = $('#stockpile-save-status');
    const unresolvedEl = $('#stockpile-unresolved');
    if (unresolvedEl) unresolvedEl.hidden = true;
    if (!text) { if (statusEl) statusEl.textContent = 'Paste an inventory list first.'; return; }
    const btn = $('#stockpile-save');
    if (btn) btn.disabled = true;
    if (statusEl) statusEl.textContent = 'Resolving & saving…';
    try {
      const res = await fetch(`${API}/api/stockpile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, note }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
      sp.data = data;
      sp.loaded = true;
      const where = data.storage === 'github' ? 'pushed to repo' : 'saved locally';
      if (statusEl) {
        statusEl.textContent = `Saved ${nfmt((data.items || []).length)} item(s) — ${where}.`;
        if (data.commit_html_url) {
          statusEl.innerHTML = `Saved ${nfmt((data.items || []).length)} item(s) — <a href="${escapeHtml(data.commit_html_url)}" target="_blank" rel="noopener">${where}</a>.`;
        }
      }
      const unresolved = data.unresolved || [];
      if (unresolved.length && unresolvedEl) {
        unresolvedEl.hidden = false;
        unresolvedEl.textContent = `⚠ ${unresolved.length} name(s) couldn't be resolved to an EVE type and were filed under "Other": ${unresolved.slice(0, 12).join(', ')}${unresolved.length > 12 ? '…' : ''}`;
      }
      const paste = $('#stockpile-paste');
      if (paste) paste.value = '';
      render();
    } catch (e) {
      if (statusEl) statusEl.textContent = `Save failed: ${e.message || e}`;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function copyJaniceAppraisal() {
    const btn = $('#stockpile-janice');
    if (!(sp.data?.items || []).length) { setStatus('Stockpile is empty — nothing to appraise.'); return; }
    if (btn) btn.disabled = true;
    setStatus('Building Janice appraisal…');
    try {
      const res = await fetch(`${API}/api/stockpile/janice`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
      await navigator.clipboard.writeText(data.url);
      setStatus(`Janice appraisal copied to clipboard — ${nfmt(data.item_count)} item(s), ${data.market_name} buy ${nfmt(Math.round(data.total_buy_price))} ISK.`);
    } catch (e) {
      setStatus(`Janice appraisal failed: ${e.message || e}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function initStockpileTab() {
    if (!sp.loaded) loadStockpile(false);
  }

  // ---- static wiring (elements exist at load) ----
  $('#stockpile-refresh')?.addEventListener('click', () => loadStockpile(true));
  $('#stockpile-search')?.addEventListener('input', (e) => { sp.search = e.target.value; renderSections(); });
  $('#stockpile-category')?.addEventListener('change', (e) => { sp.category = e.target.value; renderSections(); });
  $('#stockpile-save')?.addEventListener('click', saveStockpile);
  $('#stockpile-janice')?.addEventListener('click', copyJaniceAppraisal);
  document.querySelector('.tab-btn[data-tab="stockpile"]')?.addEventListener('click', initStockpileTab);
})();
