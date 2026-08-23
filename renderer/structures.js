'use strict';

// ============== Structures tab: corp Upwell structures + reinforcement ==========
// Lists the corp's structures from /api/structures (ESI /corporations/{id}/
// structures) with their reinforcement state and live countdown timers. A
// structure is "reinforced" when its state is armor_reinforce or hull_reinforce;
// state_timer_end is when it comes out. Self-contained IIFE; reuses app.js globals.

(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(s) : String(s == null ? '' : s));
  const state = { last: null, reinfOnly: false, loaded: false, timer: null };

  // ESI structure `state` -> [label, css class]
  const STATE_LABEL = {
    armor_reinforce: ['Armor reinforced', 'st-reinf'],
    hull_reinforce: ['Hull reinforced', 'st-reinf st-reinf-hull'],
    shield_vulnerable: ['Shield vulnerable', 'st-vuln'],
    armor_vulnerable: ['Armor vulnerable', 'st-vuln'],
    hull_vulnerable: ['Hull vulnerable', 'st-vuln'],
    anchor_vulnerable: ['Anchor vulnerable', 'st-vuln'],
    anchoring: ['Anchoring', 'st-neutral'],
    onlining_vulnerable: ['Onlining', 'st-neutral'],
    fitting_invulnerable: ['Fitting (invuln)', 'st-neutral'],
    deploy_vulnerable: ['Deploying', 'st-neutral'],
    unanchored: ['Unanchored', 'st-neutral'],
    online_deprecated: ['Online', 'st-ok'],
    unknown: ['Unknown', 'st-neutral'],
  };

  function fmtCountdown(iso) {
    if (!iso) return '';
    const ms = new Date(iso).getTime() - Date.now();
    if (!Number.isFinite(ms)) return '';
    const past = ms < 0;
    let s = Math.abs(Math.floor(ms / 1000));
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    const parts = [];
    if (d) parts.push(d + 'd');
    if (h || d) parts.push(h + 'h');
    parts.push(m + 'm');
    if (!d && !h) parts.push(s + 's');
    return past ? `exited ${parts.join(' ')} ago` : `in ${parts.join(' ')}`;
  }

  async function load() {
    const status = $('#struct-status');
    const btn = $('#struct-refresh');
    if (btn) btn.disabled = true;
    if (status) status.textContent = 'Loading structures from ESI…';
    try {
      const res = await fetch(`${API}/api/structures`);
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json()).detail || msg; } catch (_) {}
        throw new Error(msg);
      }
      state.last = await res.json();
      render();
      if (status) status.textContent = `${state.last.count} structure(s) · ${state.last.reinforced} reinforced · updated ${new Date().toLocaleTimeString()}`;
    } catch (e) {
      if (status) status.textContent = `Failed to load structures: ${e.message || e}`;
      const wrap = $('#struct-results'); if (wrap) wrap.innerHTML = '';
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function render() {
    const wrap = $('#struct-results');
    if (!wrap || !state.last) return;
    let list = state.last.structures || [];
    if (state.reinfOnly) list = list.filter((s) => s.reinforced);
    if (!list.length) {
      wrap.innerHTML = `<p class="muted">${state.reinfOnly ? 'No structures are reinforced right now. 🎉' : 'No structures found for this corp.'}</p>`;
      return;
    }
    const cd = (iso, low) => (iso
      ? `<span class="struct-cd${low && new Date(iso) - Date.now() < 3 * 86400000 ? ' struct-lowfuel' : ''}" data-end="${esc(iso)}">${esc(fmtCountdown(iso))}</span>`
      : '<span class="muted">—</span>');
    const row = (s) => {
      const [label, cls] = STATE_LABEL[s.state] || [s.state, 'st-neutral'];
      return `<tr class="${s.reinforced ? 'struct-reinf-row' : ''}">
        <td class="struct-name">${esc(s.name)}</td>
        <td class="muted">${esc(s.type_name || s.type_id || '')}</td>
        <td>${esc(s.system_name || s.system_id || '')}</td>
        <td><span class="struct-state ${cls}">${esc(label)}</span></td>
        <td class="num">${cd(s.state_timer_end, false)}</td>
        <td class="num">${cd(s.fuel_expires, true)}</td>
      </tr>`;
    };
    wrap.innerHTML = `<table class="struct-table">
      <thead><tr><th>Structure</th><th>Type</th><th>System</th><th>State</th><th class="num">Comes out</th><th class="num">Fuel left</th></tr></thead>
      <tbody>${list.map(row).join('')}</tbody></table>`;
  }

  function tickCountdowns() {
    document.querySelectorAll('#struct-results .struct-cd').forEach((el) => { el.textContent = fmtCountdown(el.dataset.end); });
  }

  let wired = false;
  function initTab() {
    if (!wired) {
      wired = true;
      $('#struct-refresh')?.addEventListener('click', load);
      $('#struct-reinf-only')?.addEventListener('change', (e) => { state.reinfOnly = e.target.checked; render(); });
      // Live-tick the countdowns while the tab is visible.
      state.timer = setInterval(() => {
        const pane = $('#tab-structures');
        if (pane && pane.offsetParent !== null) tickCountdowns();
      }, 1000);
    }
    if (!state.loaded) { state.loaded = true; load(); }
  }

  document.querySelector('.tab-btn[data-tab="structures"]')?.addEventListener('click', initTab);
})();
