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

  const HANGAR_REASON_MESSAGES = {
    missing_scope: 'Re-auth a Director character on the Auth tab — needs the esi-assets.read_corporation_assets.v1 scope.',
    no_home_structure: 'Set your home structure ID in Config first.',
    no_credentials: 'Auth credentials missing — check Config.',
    fetch_failed: 'ESI fetch failed. Check the sidecar log.',
  };

  async function scanCorpHangars() {
    const btn = $('#stockpile-corp-load');
    const statusEl = $('#stockpile-corp-status');
    const breakdownEl = $('#stockpile-corp-breakdown');
    if (!btn || !statusEl || !breakdownEl) return;
    btn.disabled = true;
    statusEl.textContent = 'Loading corp inventory…';
    breakdownEl.hidden = true;
    breakdownEl.innerHTML = '';

    let data, selection;
    try {
      const [assetsRes, selectionRes] = await Promise.all([
        fetch(`${API}/api/corp/assets`),
        fetch(`${API}/api/hangar-selection`),
      ]);
      data = await assetsRes.json();
      selection = await selectionRes.json().catch(() => ({ selected_flags: [] }));
    } catch (e) {
      statusEl.textContent = 'Failed to reach sidecar.';
      btn.disabled = false;
      return;
    }

    if (!data.ok) {
      statusEl.textContent = HANGAR_REASON_MESSAGES[data.reason] || `Error: ${data.reason}`;
      btn.disabled = false;
      return;
    }

    statusEl.textContent = '';
    const hangars = data.hangars || [];
    const totalItems = hangars.reduce((s, h) => s + h.item_count, 0);

    breakdownEl.innerHTML = `
      <div class="muted" style="margin-bottom:0.5rem">${totalItems.toLocaleString()} items across ${hangars.length} hangar division${hangars.length !== 1 ? 's' : ''} at the home structure</div>
      <div id="stockpile-corp-picker"></div>
      <div class="actions" style="margin-top:0.6rem">
        <button id="stockpile-corp-replace" type="button">Replace stockpile</button>
        <button id="stockpile-corp-cancel" type="button" class="link-btn">Cancel</button>
      </div>`;
    breakdownEl.hidden = false;

    const getSelectedFlags = buildHangarPicker(
      $('#stockpile-corp-picker'), hangars, selection.selected_flags || []
    );

    $('#stockpile-corp-replace').addEventListener('click', async () => {
      const flags = getSelectedFlags();
      const items = filterItemsByHangar(hangars, flags).map((i) => ({
        type_id: i.type_id, name: i.name, quantity: i.quantity,
        group_id: i.group_id, category_id: i.category_id,
      }));
      if (!items.length) { statusEl.textContent = 'No items in the selected hangars.'; return; }
      const replaceBtn = $('#stockpile-corp-replace');
      replaceBtn.disabled = true;
      statusEl.textContent = 'Importing…';
      try {
        const res = await fetch(`${API}/api/stockpile/import-hangars`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items, note: 'ESI hangar scan' }),
        });
        const result = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(result.detail || `HTTP ${res.status}`);
        sp.data = result;
        sp.loaded = true;
        render();
        statusEl.textContent = `Replaced stockpile with ${items.length.toLocaleString()} item(s) from corp hangars.`;
        fetch(`${API}/api/hangar-selection`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ flags }),
        }).catch(() => {});
      } catch (e) {
        statusEl.textContent = `Import failed: ${e.message || e}`;
      } finally {
        replaceBtn.disabled = false;
        breakdownEl.hidden = true;
      }
    });

    $('#stockpile-corp-cancel').addEventListener('click', () => { breakdownEl.hidden = true; });
    btn.disabled = false;
  }

  // ---- static wiring (elements exist at load) ----
  $('#stockpile-refresh')?.addEventListener('click', () => loadStockpile(true));
  $('#stockpile-search')?.addEventListener('input', (e) => { sp.search = e.target.value; renderSections(); });
  $('#stockpile-category')?.addEventListener('change', (e) => { sp.category = e.target.value; renderSections(); });
  $('#stockpile-save')?.addEventListener('click', saveStockpile);
  $('#stockpile-janice')?.addEventListener('click', copyJaniceAppraisal);
  $('#stockpile-corp-load')?.addEventListener('click', scanCorpHangars);
  document.querySelector('.tab-btn[data-tab="stockpile"]')?.addEventListener('click', initStockpileTab);
})();
