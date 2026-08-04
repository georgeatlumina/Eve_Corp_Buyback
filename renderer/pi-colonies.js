'use strict';

// ===================== PI Colonies (live, via ESI) =====================
// General tab. Reads the authenticated characters' actual planetary colonies
// (esi-planets.manage_planets) and shows each extractor's product with a live
// countdown to expiry, plus a per-colony status so you know what to restart.
// Backed by /api/pi/colonies. Reuses app.js globals (API, $, escapeHtml, activateTab).

(function () {
  let colonies = [];
  let ticker = null;
  let initialised = false;

  function fmtCountdown(iso) {
    if (!iso) return '—';
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return 'EXPIRED';
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m ${s % 60}s`;
  }

  const BADGE = { expired: 'EXPIRED', expiring: '< 24h', ok: 'active', idle: 'idle', unknown: 'unknown' };

  async function load() {
    const status = $('#pic-status');
    status.textContent = 'Loading colonies…';
    let d;
    try {
      d = await fetch(`${API}/api/pi/colonies`).then((r) => r.json());
    } catch (e) {
      status.textContent = `Error: ${e.message}`;
      return;
    }
    if (!d.configured) {
      $('#pic-list').innerHTML = `<div class="pic-empty">No character is authorized for Planetary Interaction yet.<br>
        Re-authenticate on the <a href="#" data-tab-link="auth">Auth</a> tab (it now requests the
        <code>manage_planets</code> scope), then hit Refresh.</div>`;
      status.textContent = '';
      return;
    }
    colonies = d.colonies || [];
    render();
    const errs = (d.errors || []).length ? ` · ${d.errors.length} error(s)` : '';
    status.textContent = colonies.length ? `${colonies.length} colonies${errs}` : '';
  }

  function render() {
    if (!colonies.length) {
      $('#pic-list').innerHTML = '<div class="pic-empty">No colonies found on your authorized characters.</div>';
      return;
    }
    const alerts = colonies.filter((c) => c.status === 'expired' || c.status === 'expiring').length;
    const banner = alerts
      ? `<div class="pic-banner">${alerts} colony(ies) need attention — extractor expired or expiring within 24h.</div>` : '';
    $('#pic-list').innerHTML = banner + colonies.map(card).join('');
  }

  function card(c) {
    const ext = c.extractors.length
      ? c.extractors.map((e) => `<div class="pic-ext">
          <span class="pic-ext-name">${escapeHtml(e.product || `type ${e.product_type_id}`)}</span>
          <span class="pic-ext-meta muted">${e.heads} head(s)${e.qty_per_cycle ? ` · ${Number(e.qty_per_cycle).toLocaleString('en-US')}/cycle` : ''}</span>
          <span class="pic-cd" data-exp="${e.expiry_time || ''}">${fmtCountdown(e.expiry_time)}</span>
        </div>`).join('')
      : '<div class="muted pic-noext">No active extractors (factory-only or idle).</div>';
    return `<div class="pic-card pic-${c.status}">
      <div class="pic-card-h">
        <strong>${escapeHtml(c.planet_type)} — ${escapeHtml(c.system || '?')}</strong>
        <span class="pic-badge pic-b-${c.status}">${BADGE[c.status] || c.status}</span>
      </div>
      <div class="muted pic-sub">${escapeHtml(c.character || '')} · CC level ${c.upgrade_level} · ${c.num_pins} pins</div>
      <div class="pic-exts">${ext}</div>
      <div class="pic-actions"><button class="pic-edit secondary" data-cid="${c.character_id}" data-pid="${c.planet_id}">Open in Builder</button></div>
    </div>`;
  }

  // Live tick: update countdown text + flip a colony to expired styling when it hits 0.
  function tick() {
    document.querySelectorAll('#tab-pi-colonies .pic-cd').forEach((el) => {
      const txt = fmtCountdown(el.dataset.exp);
      el.textContent = txt;
      if (txt === 'EXPIRED') el.closest('.pic-card')?.classList.add('pic-expired');
    });
  }

  function initTab() {
    load();
    if (initialised) return;
    initialised = true;
    $('#pic-refresh').addEventListener('click', load);
    $('#tab-pi-colonies').addEventListener('click', (e) => {
      const a = e.target.closest('[data-tab-link]');
      if (a) { e.preventDefault(); if (typeof activateTab === 'function') activateTab(a.dataset.tabLink); }
    });
    // "Open in Builder": pull the live colony into the layout builder.
    $('#pic-list').addEventListener('click', async (e) => {
      const b = e.target.closest('.pic-edit');
      if (!b) return;
      const orig = b.textContent; b.disabled = true; b.textContent = 'Loading…';
      try {
        const d = await fetch(`${API}/api/pi/colony?character_id=${b.dataset.cid}&planet_id=${b.dataset.pid}`).then((r) => r.json());
        if (d.detail || !d.layout) { b.textContent = 'Error'; return; }
        if (typeof activateTab === 'function') activateTab('pi-builder');
        if (typeof window.piBuilderLoad === 'function') await window.piBuilderLoad(d.layout);
      } catch (err) {
        b.textContent = 'Error';
      } finally {
        b.disabled = false; if (b.textContent === 'Loading…') b.textContent = orig;
      }
    });
    ticker = setInterval(tick, 1000);
  }

  document.querySelector('.tab-btn[data-tab="pi-colonies"]')?.addEventListener('click', initTab);
})();
