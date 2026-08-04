'use strict';

// ===================== PI Colonies (live, via ESI) =====================
// Colony manager: live colonies with extractor countdowns, a per-colony detail
// view (factories being run, storage/launchpad contents, pin breakdown), Jita
// valuation (output/day + stored value, with totals), and background desktop
// notifications when an extractor is about to run dry — fired even while you're
// on another tab. Backed by /api/pi/colonies. Reuses app.js globals
// (API, $, escapeHtml, fmtIsk, activateTab).

(function () {
  let colonies = [];
  let totals = { output_day: 0, contents: 0, priced: false };
  const expanded = new Set();     // planet_ids with the detail panel open
  const notified = new Set();     // dedup key per expiry we've already alerted on
  let initialised = false;
  const ALERT_LEAD_MS = 2 * 3600 * 1000;   // notify when < 2h of extraction remains

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
  const isk = (n) => (typeof fmtIsk === 'function' ? fmtIsk(n) : Math.round(n).toLocaleString('en-US'));
  const BADGE = { expired: 'EXPIRED', expiring: '< 24h', ok: 'active', idle: 'idle', unknown: 'unknown' };

  async function fetchColonies() {
    const d = await fetch(`${API}/api/pi/colonies`).then((r) => r.json());
    if (d.configured === false) { colonies = []; totals = { output_day: 0, contents: 0, priced: false }; return d; }
    colonies = d.colonies || [];
    totals = { output_day: d.total_output_value_per_day || 0, contents: d.total_contents_value || 0, priced: !!d.priced };
    return d;
  }

  async function load() {
    const status = $('#pic-status');
    status.textContent = 'Loading colonies…';
    let d;
    try { d = await fetchColonies(); } catch (e) { status.textContent = `Error: ${e.message}`; return; }
    if (!d.configured) {
      $('#pic-list').innerHTML = `<div class="pic-empty">No character is authorized for Planetary Interaction yet.<br>
        Log in a PI character under <strong>PI Characters</strong> on the <a href="#" data-tab-link="auth">Auth</a> tab
        (a minimal <code>manage_planets</code>-only login), then hit Refresh.</div>`;
      status.textContent = '';
      return;
    }
    render();
    checkAlerts();
    const errs = (d.errors || []).length ? ` · ${d.errors.length} issue(s)` : '';
    status.textContent = colonies.length ? `${colonies.length} colonies${errs}` : '';
  }

  function render() {
    if (!colonies.length) {
      $('#pic-list').innerHTML = '<div class="pic-empty">No colonies found on your authorized characters.</div>';
      return;
    }
    const alerts = colonies.filter((c) => c.status === 'expired' || c.status === 'expiring').length;
    const banner = [];
    if (alerts) banner.push(`<div class="pic-banner">${alerts} colony(ies) need attention — extractor expired or expiring within 24h.</div>`);
    if (totals.priced) banner.push(`<div class="pic-totals">Output ≈ <strong>${isk(totals.output_day)}</strong>/day · Stored <strong>${isk(totals.contents)}</strong> · ${colonies.length} colonies</div>`);
    $('#pic-list').innerHTML = banner.join('') + colonies.map(card).join('');
  }

  function card(c) {
    const ext = c.extractors.length
      ? c.extractors.map((e) => `<div class="pic-ext">
          <span class="pic-ext-name">${escapeHtml(e.product || `type ${e.product_type_id}`)}</span>
          <span class="pic-ext-meta muted">${e.heads} head(s)${e.qty_per_cycle ? ` · ${Number(e.qty_per_cycle).toLocaleString('en-US')}/cycle` : ''}${totals.priced && e.isk_per_day ? ` · ≈${isk(e.isk_per_day)}/day` : ''}</span>
          <span class="pic-cd" data-exp="${e.expiry_time || ''}">${fmtCountdown(e.expiry_time)}</span>
        </div>`).join('')
      : '<div class="muted pic-noext">No active extractors (factory-only or idle).</div>';
    const valLine = totals.priced
      ? `<div class="pic-val muted">≈ ${isk(c.output_value_per_day)}/day${c.contents_value ? ` · stored ${isk(c.contents_value)}` : ''}</div>` : '';
    const open = expanded.has(c.planet_id);
    return `<div class="pic-card pic-${c.status}">
      <div class="pic-card-h">
        <strong>${escapeHtml(c.planet_type)} — ${escapeHtml(c.system || '?')}</strong>
        <span class="pic-badge pic-b-${c.status}">${BADGE[c.status] || c.status}</span>
      </div>
      <div class="muted pic-sub">${escapeHtml(c.character || '')} · CC level ${c.upgrade_level} · ${c.num_pins} pins</div>
      <div class="pic-exts">${ext}</div>
      ${valLine}
      <div class="pic-actions">
        <button class="pic-detail-toggle secondary" data-pid="${c.planet_id}">${open ? 'Hide details' : 'Details'}</button>
        <button class="pic-edit secondary" data-cid="${c.character_id}" data-pid="${c.planet_id}">Open in Builder</button>
      </div>
      ${open ? renderDetail(c) : ''}
    </div>`;
  }

  function renderDetail(c) {
    // Factories: what's being produced (deduped with counts).
    const facCount = {};
    for (const f of (c.factories || [])) facCount[f.product || f.product_type_id] = (facCount[f.product || f.product_type_id] || 0) + 1;
    const facs = Object.keys(facCount).length
      ? `<div class="pic-d-h">Producing</div><div class="pic-d-facs">${Object.entries(facCount)
          .map(([n, k]) => `<span class="pic-chip">${escapeHtml(String(n))}${k > 1 ? ` ×${k}` : ''}</span>`).join('')}</div>`
      : '';
    const cont = (c.contents || []).length
      ? `<div class="pic-d-h">Stored${totals.priced ? ` (${isk(c.contents_value)})` : ''}</div>
         <table class="pic-cont"><tbody>${c.contents.map((x) => `<tr>
           <td>${escapeHtml(x.name)}</td><td class="num">${Number(x.amount).toLocaleString('en-US')}</td>
           ${totals.priced ? `<td class="num muted">${isk(x.isk)}</td>` : ''}</tr>`).join('')}</tbody></table>`
      : '<div class="muted pic-d-empty">Storage/launchpads empty.</div>';
    const kinds = Object.entries(c.pins_by_kind || {})
      .map(([k, n]) => `${n}× ${k.replace('_', ' ')}`).join(' · ');
    return `<div class="pic-detail">${facs}${cont}<div class="pic-d-kinds muted">${escapeHtml(kinds)}</div></div>`;
  }

  function tick() {
    document.querySelectorAll('#tab-pi-colonies .pic-cd').forEach((el) => {
      const txt = fmtCountdown(el.dataset.exp);
      el.textContent = txt;
      if (txt === 'EXPIRED') el.closest('.pic-card')?.classList.add('pic-expired');
    });
  }

  // Desktop notification when an extractor is about to (or has) run dry. Deduped
  // per unique expiry so you get one alert as it crosses the lead time.
  function checkAlerts() {
    if (typeof Notification === 'undefined') return;
    for (const c of colonies) {
      for (const e of (c.extractors || [])) {
        if (!e.expiry_time) continue;
        const ms = new Date(e.expiry_time).getTime() - Date.now();
        if (ms > ALERT_LEAD_MS) continue;
        const key = `${c.character_id}|${c.planet_id}|${e.product_type_id}|${e.expiry_time}`;
        if (notified.has(key)) continue;
        notified.add(key);
        const head = ms <= 0 ? 'PI extractor expired' : 'PI extractor expiring';
        const when = ms <= 0 ? 'has expired' : `expires in ${fmtCountdown(e.expiry_time)}`;
        try {
          // eslint-disable-next-line no-new
          new Notification(head, { body: `${e.product || 'Extractor'} — ${c.planet_type} ${c.system || ''} (${c.character || ''}) ${when}` });
        } catch (_) { /* notifications unavailable */ }
      }
    }
  }

  async function backgroundPoll() {
    try {
      await fetchColonies();
      checkAlerts();
      if ($('#tab-pi-colonies')?.classList.contains('active')) render();
    } catch (_) { /* sidecar not ready / offline — try again next interval */ }
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
    $('#pic-list').addEventListener('click', async (e) => {
      const t = e.target.closest('.pic-detail-toggle');
      if (t) { const pid = +t.dataset.pid; expanded.has(pid) ? expanded.delete(pid) : expanded.add(pid); render(); return; }
      const b = e.target.closest('.pic-edit');
      if (!b) return;
      const orig = b.textContent; b.disabled = true; b.textContent = 'Loading…';
      try {
        const d = await fetch(`${API}/api/pi/colony?character_id=${b.dataset.cid}&planet_id=${b.dataset.pid}`).then((r) => r.json());
        if (d.detail || !d.layout) { b.textContent = 'Error'; return; }
        if (typeof activateTab === 'function') activateTab('pi-builder');
        if (typeof window.piBuilderLoad === 'function') await window.piBuilderLoad(d.layout);
      } catch (err) { b.textContent = 'Error'; } finally {
        b.disabled = false; if (b.textContent === 'Loading…') b.textContent = orig;
      }
    });
    setInterval(tick, 1000);
  }

  // Background poller — runs regardless of the active tab so alerts fire even
  // when you're elsewhere in the app. Delayed start so the sidecar is up first.
  setTimeout(() => {
    backgroundPoll();
    setInterval(backgroundPoll, 20 * 60 * 1000);   // refresh colony data
    setInterval(checkAlerts, 60 * 1000);           // re-check cached expiries
  }, 30000);

  document.querySelector('.tab-btn[data-tab="pi-colonies"]')?.addEventListener('click', initTab);
})();
