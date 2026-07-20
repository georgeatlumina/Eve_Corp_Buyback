'use strict';

// ============== Doctrine Stock (read-only member dashboard) ==============
// Shows the doctrine hull stock + gaps that an admin published from the
// Contracts tab (see publishDoctrineStock in app.js). Any authed user can open
// this — it just reads a GitHub-hosted JSON snapshot via the sidecar, no
// privileged contract-manager token required. Reuses app.js globals ($, API,
// escapeHtml, downloadBlob) and the .quota-* CSS from the Contracts dashboard.

(function () {
  const dsState = {
    alliance: 'main',
    sort: 'under-quota',
    hideOk: false,
    data: {},          // { main: snapshot, institute: snapshot }
    loading: false,
    initialised: false,
  };

  const ALLIANCE_LABEL = { main: 'NLDF', institute: 'NLDO' };

  function quotaState(q) {
    const required = Number(q.required) || 0;
    const available = Number(q.available) || 0;
    if (required === 0) return 'unset';
    if (available >= required) return 'ok';
    return available > 0 ? 'partial' : 'empty';
  }

  function visibleQuotas() {
    const snap = dsState.data[dsState.alliance];
    let rows = (snap && Array.isArray(snap.quotas)) ? snap.quotas.slice() : [];
    if (dsState.hideOk) rows = rows.filter((q) => quotaState(q) !== 'ok');
    rows.sort((a, b) => {
      if (dsState.sort === 'under-quota') {
        const am = Number(a.missing) || 0;
        const bm = Number(b.missing) || 0;
        if (am !== bm) return bm - am;
        return (a.ship_name || a.name || '').localeCompare(b.ship_name || b.name || '');
      }
      return (a.ship_name || a.name || '').localeCompare(b.ship_name || b.name || '');
    });
    return rows;
  }

  function renderBar(q) {
    const required = Number(q.required) || 0;
    const available = Number(q.available) || 0;
    const missing = Number(q.missing) || Math.max(0, required - available);
    const pct = required > 0 ? Math.min(100, Math.round((available / required) * 100)) : 0;
    const state = quotaState(q);
    const shipName = q.ship_name || q.name || `type ${q.ship_type_id}`;
    return `
      <div class="quota-bar quota-${state} ds-bar">
        <div class="quota-bar-head">
          <strong>${escapeHtml(shipName)}</strong>
          <span class="muted">${escapeHtml(q.name || '')}${q.title_filter ? ` · "${escapeHtml(q.title_filter)}"` : ''}</span>
          <span class="quota-counts">${available} / ${required} ${missing ? `· missing ${missing}` : ''}</span>
        </div>
        <div class="quota-bar-track"><div class="quota-bar-fill" style="width:${pct}%"></div></div>
      </div>`;
  }

  function renderStatus() {
    const status = $('#doctrine-stock-status');
    if (!status) return;
    const snap = dsState.data[dsState.alliance];
    if (dsState.loading) { status.textContent = 'Loading…'; return; }
    if (!snap || snap.storage === 'none' || !snap.quotas) {
      if (snap && snap.reason === 'not_configured') {
        status.innerHTML = 'No dashboard source configured. An admin needs to set the <strong>market-history repo</strong> in Config, then run a Contracts scan.';
      } else if (snap && snap.reason === 'not_published_yet') {
        status.textContent = 'No stock has been published for this alliance yet — an admin needs to run a Contracts scan.';
      } else {
        status.textContent = 'No doctrine stock available yet.';
      }
      return;
    }
    const when = snap.published_at ? new Date(snap.published_at).toLocaleString() : 'unknown';
    const src = snap.storage === 'github' ? 'live from GitHub'
      : snap.storage === 'local' ? (snap.stale ? 'cached (GitHub unreachable)' : 'cached locally') : snap.storage;
    const total = (snap.quotas || []).length;
    const short = (snap.quotas || []).filter((q) => quotaState(q) !== 'ok' && (Number(q.required) || 0) > 0).length;
    status.textContent = `${ALLIANCE_LABEL[dsState.alliance] || dsState.alliance} · ${total} hull(s), ${short} short · updated ${when} · ${src}`;
  }

  function render() {
    const root = $('#doctrine-stock-dashboard');
    if (!root) return;
    renderStatus();
    const rows = visibleQuotas();
    if (!rows.length) {
      const snap = dsState.data[dsState.alliance];
      const hasData = snap && Array.isArray(snap.quotas) && snap.quotas.length;
      root.innerHTML = dsState.loading
        ? '<p class="muted">Loading…</p>'
        : hasData && dsState.hideOk
          ? '<p class="muted">Every doctrine hull is fully stocked. 🎉</p>'
          : '<p class="muted">Nothing to show yet.</p>';
      return;
    }
    root.innerHTML = rows.map(renderBar).join('');
  }

  async function load(force) {
    const alliance = dsState.alliance;
    if (dsState.data[alliance] && !force) { render(); return; }
    dsState.loading = true;
    render();
    try {
      const res = await fetch(`${API}/api/doctrine-stock?alliance=${alliance}`);
      dsState.data[alliance] = res.ok ? await res.json() : { storage: 'none', quotas: [], reason: `http_${res.status}` };
    } catch (e) {
      dsState.data[alliance] = { storage: 'none', quotas: [], reason: String(e) };
    } finally {
      dsState.loading = false;
      render();
    }
  }

  function exportGapCsv() {
    const rows = visibleQuotas().filter((q) => (Number(q.missing) || 0) > 0);
    if (!rows.length) { $('#doctrine-stock-status').textContent = 'No gaps to export.'; return; }
    const header = 'ship_name,ship_type_id,required,available,missing,title_filter';
    const body = rows.map((q) => [
      `"${(q.ship_name || q.name || '').replace(/"/g, '""')}"`,
      q.ship_type_id || '',
      Number(q.required) || 0,
      Number(q.available) || 0,
      Number(q.missing) || 0,
      `"${(q.title_filter || '').replace(/"/g, '""')}"`,
    ].join(',')).join('\n');
    downloadBlob(`doctrine-gaps-${dsState.alliance}.csv`, 'text/csv', `${header}\n${body}\n`);
  }

  async function copyShoppingList() {
    const rows = visibleQuotas().filter((q) => (Number(q.missing) || 0) > 0);
    const status = $('#doctrine-stock-status');
    if (!rows.length) { if (status) status.textContent = 'No gaps — nothing to copy.'; return; }
    const text = rows.map((q) => `${q.ship_name || q.name} x${Number(q.missing) || 0}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      if (status) status.textContent = `Copied ${rows.length} short hull(s) to clipboard.`;
    } catch (_) {
      if (status) status.textContent = 'Clipboard copy failed.';
    }
  }

  function initTab() {
    if (dsState.initialised) { load(false); return; }
    dsState.initialised = true;

    document.querySelector('#tab-doctrine-stock .alliance-toggle')?.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-ds-alliance]');
      if (!btn || btn.dataset.dsAlliance === dsState.alliance) return;
      dsState.alliance = btn.dataset.dsAlliance;
      document.querySelectorAll('#tab-doctrine-stock .alliance-btn')
        .forEach((b) => b.classList.toggle('active', b === btn));
      load(false);
    });

    $('#btn-doctrine-stock-refresh')?.addEventListener('click', () => load(true));
    $('#doctrine-stock-sort')?.addEventListener('change', (e) => { dsState.sort = e.target.value; render(); });
    $('#doctrine-stock-hide-ok')?.addEventListener('change', (e) => { dsState.hideOk = e.target.checked; render(); });
    $('#btn-doctrine-stock-export-csv')?.addEventListener('click', exportGapCsv);
    $('#btn-doctrine-stock-export-text')?.addEventListener('click', copyShoppingList);

    load(false);
  }

  document.querySelector('.tab-btn[data-tab="doctrine-stock"]')?.addEventListener('click', initTab);
})();
