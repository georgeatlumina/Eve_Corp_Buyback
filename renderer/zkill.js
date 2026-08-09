'use strict';

// ==================== zKillboard (native) ====================
// A native killboard front end. Instead of embedding zkillboard.com in a
// <webview>, we search for an entity (pilot / corp / alliance / system), pull
// its kill/loss list from zKillboard's public API through the sidecar
// (POST /api/zkill/board), and render the killmails ourselves. Ship, pilot and
// corp art come from the EVE image server; clicking a row opens the full
// killmail on zkillboard.com in the browser.
// Reuses app.js globals ($, API, escapeHtml, escapeAttr, fmtIskShort,
// openExternalLink). Self-registers.

(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(s) : String(s == null ? '' : s));
  const escA = (s) => (typeof escapeAttr === 'function' ? escapeAttr(s) : String(s == null ? '' : s));
  const isk = (n) => (typeof fmtIskShort === 'function' ? fmtIskShort(n) : String(n));

  const IMG = 'https://images.evetech.net';
  const shipRender = (id) => `${IMG}/types/${id}/render?size=64`;
  const charPortrait = (id) => `${IMG}/characters/${id}/portrait?size=32`;
  const corpLogo = (id) => `${IMG}/corporations/${id}/logo?size=32`;

  const KIND_LABEL = { character: 'Pilot', corporation: 'Corporation', alliance: 'Alliance', system: 'System' };

  // --- security-status colouring (matches EVE's hisec/lowsec/nullsec bands) ---
  function secClass(sec) {
    if (sec == null) return 'sec-unknown';
    const s = Math.round(sec * 10) / 10;
    if (s >= 0.5) return 'sec-hi';
    if (s > 0.0) return 'sec-low';
    return 'sec-null';
  }
  function secText(sec) {
    if (sec == null) return '';
    return (Math.round(sec * 10) / 10).toFixed(1);
  }

  // --- relative time ("3h ago") ---
  function relTime(iso) {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    const m = s / 60;
    if (m < 60) return `${Math.floor(m)}m ago`;
    const h = m / 60;
    if (h < 24) return `${Math.floor(h)}h ago`;
    const d = h / 24;
    if (d < 30) return `${Math.floor(d)}d ago`;
    return new Date(iso).toLocaleDateString();
  }

  function fallbackImg(el) {
    // Hide broken art rather than showing the browser's broken-image glyph.
    el.style.visibility = 'hidden';
  }

  function personCell(p, portraitFn) {
    if (!p || (!p.character_name && !p.corporation_name)) {
      return '<span class="muted">—</span>';
    }
    const name = p.character_name || p.corporation_name || '(unknown)';
    const sub = p.character_name ? (p.alliance_name || p.corporation_name || '') : (p.alliance_name || '');
    const imgId = p.character_id || null;
    const img = imgId
      ? `<img class="zk-face" loading="lazy" src="${escA(portraitFn(imgId))}" alt="" onerror="this.style.visibility='hidden'">`
      : (p.corporation_id ? `<img class="zk-face" loading="lazy" src="${escA(corpLogo(p.corporation_id))}" alt="" onerror="this.style.visibility='hidden'">` : '');
    return `<div class="zk-person">${img}<div class="zk-person-txt">`
      + `<div class="zk-person-name">${esc(name)}</div>`
      + (sub ? `<div class="zk-person-sub muted">${esc(sub)}</div>` : '')
      + `</div></div>`;
  }

  function shipCell(p) {
    if (!p || !p.ship_type_id) return '<span class="muted">—</span>';
    return `<div class="zk-ship">`
      + `<img class="zk-ship-img" loading="lazy" src="${escA(shipRender(p.ship_type_id))}" alt="" onerror="this.style.visibility='hidden'">`
      + `<span class="zk-ship-name">${esc(p.ship_name || 'Ship')}</span></div>`;
  }

  function flags(row) {
    const out = [];
    if (row.solo) out.push('<span class="zk-flag zk-flag-solo" title="Solo kill">solo</span>');
    if (row.npc) out.push('<span class="zk-flag zk-flag-npc" title="NPC kill">npc</span>');
    if (row.awox) out.push('<span class="zk-flag zk-flag-awox" title="Awox (friendly fire)">awox</span>');
    return out.join('');
  }

  function rowHtml(row) {
    const v = row.victim || {};
    const fb = row.final_blow || {};
    const sec = secText(row.security);
    const secHtml = sec ? `<span class="zk-sec ${secClass(row.security)}">${sec}</span>` : '';
    const others = row.attacker_count > 1 ? ` <span class="muted">+${row.attacker_count - 1}</span>` : '';
    return `<tr class="zk-row" data-kill="${row.killmail_id}" title="Open killmail on zKillboard">
      <td class="zk-c-ship">${shipCell(v)}</td>
      <td class="zk-c-victim">${personCell(v, charPortrait)}</td>
      <td class="zk-c-sys">${secHtml}<span class="zk-sysname">${esc(row.system_name || '—')}</span></td>
      <td class="zk-c-fb">${personCell(fb, charPortrait)}${others}</td>
      <td class="zk-c-val">${row.total_value ? isk(row.total_value) : '<span class="muted">—</span>'}</td>
      <td class="zk-c-flags">${flags(row)}</td>
      <td class="zk-c-time muted" title="${escA(row.time ? new Date(row.time).toLocaleString() : '')}">${esc(relTime(row.time))}</td>
    </tr>`;
  }

  const state = { loading: false, entity: null, selected: null, sugg: [], active: -1 };

  const KIND_ICON = {
    character: (id) => `${IMG}/characters/${id}/portrait?size=32`,
    corporation: (id) => `${IMG}/corporations/${id}/logo?size=32`,
    alliance: (id) => `${IMG}/alliances/${id}/logo?size=32`,
    system: null,
  };

  function setStatus(msg, kind) {
    const el = $('#zkill-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'zkill-status' + (kind ? ` zkill-${kind}` : '');
  }

  function renderEntity(entity) {
    const el = $('#zkill-entity');
    if (!el) return;
    if (!entity) { el.innerHTML = ''; el.hidden = true; return; }
    const label = KIND_LABEL[entity.kind] || entity.kind;
    const zkPath = { character: 'character', corporation: 'corporation', alliance: 'alliance', system: 'system' }[entity.kind];
    const zkUrl = zkPath ? `https://zkillboard.com/${zkPath}/${entity.id}/` : 'https://zkillboard.com/';
    el.hidden = false;
    el.innerHTML = `<span class="zkill-entity-kind">${esc(label)}</span>`
      + `<span class="zkill-entity-name">${esc(entity.name)}</span>`
      + `<button type="button" class="zkill-entity-ext" data-url="${escA(zkUrl)}" title="Open on zkillboard.com">↗ zKillboard</button>`;
    el.querySelector('.zkill-entity-ext')?.addEventListener('click', (e) => {
      const url = e.currentTarget.getAttribute('data-url');
      if (url) (typeof openExternalLink === 'function' ? openExternalLink(url) : window.api?.openExternal?.(url));
    });
  }

  function renderRows(rows) {
    const body = $('#zkill-rows');
    if (!body) return;
    if (!rows || !rows.length) {
      body.innerHTML = `<tr><td colspan="7" class="zkill-empty muted">No killmails on this board.</td></tr>`;
      return;
    }
    body.innerHTML = rows.map(rowHtml).join('');
    body.querySelectorAll('.zk-row').forEach((tr) => {
      tr.addEventListener('click', () => {
        const id = tr.getAttribute('data-kill');
        if (!id) return;
        const url = `https://zkillboard.com/kill/${id}/`;
        (typeof openExternalLink === 'function' ? openExternalLink(url) : window.api?.openExternal?.(url));
      });
    });
  }

  async function search() {
    if (state.loading) return;
    closeSuggest();
    const query = ($('#zkill-q')?.value || '').trim();
    if (!query) { setStatus('Enter a pilot, corp, alliance or system name.', 'warn'); return; }
    const filter = $('#zkill-filter')?.value || 'all';
    // If the current text still matches a picked suggestion, search by its exact
    // id + kind (skips name resolution and handles decorated names like
    // "Jita (The Forge)"). Otherwise fall back to the kind selector + name.
    const picked = state.selected && state.selected.name === query ? state.selected : null;
    const kind = picked ? picked.kind : ($('#zkill-kind')?.value || 'auto');
    const body = picked
      ? { query, kind: picked.kind, entity_id: picked.id, filter, limit: 50 }
      : { query, kind, filter, limit: 50 };
    state.loading = true;
    $('#zkill-search-btn')?.setAttribute('disabled', 'disabled');
    setStatus('Searching zKillboard…');
    try {
      const res = await fetch(`${API}/api/zkill/board`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json()).detail || msg; } catch (_) {}
        throw new Error(msg);
      }
      const data = await res.json();
      state.entity = data.entity || null;
      renderEntity(data.entity);
      renderRows(data.rows || []);
      const n = (data.rows || []).length;
      setStatus(n ? `${n} killmail${n === 1 ? '' : 's'} shown.` : 'No killmails found.', n ? 'ok' : 'warn');
    } catch (e) {
      renderEntity(null);
      renderRows([]);
      setStatus(`Lookup failed: ${e.message || e}`, 'error');
    } finally {
      state.loading = false;
      $('#zkill-search-btn')?.removeAttribute('disabled');
    }
  }

  // ---- Type-ahead suggestions (zKillboard autocomplete) ----
  const KIND_TAG = { character: 'Pilot', corporation: 'Corp', alliance: 'Alliance', system: 'System' };
  let suggestTimer = null;
  let suggestSeq = 0;   // guards against out-of-order responses

  function closeSuggest() {
    state.sugg = []; state.active = -1;
    const el = $('#zkill-suggest');
    if (el) { el.hidden = true; el.innerHTML = ''; }
    $('#zkill-q')?.setAttribute('aria-expanded', 'false');
  }

  function renderSuggest() {
    const el = $('#zkill-suggest');
    if (!el) return;
    if (!state.sugg.length) { closeSuggest(); return; }
    el.innerHTML = state.sugg.map((s, i) => {
      const iconFn = KIND_ICON[s.kind];
      const icon = iconFn
        ? `<img class="zk-sugg-icon" loading="lazy" src="${escA(iconFn(s.id))}" alt="" onerror="this.style.visibility='hidden'">`
        : `<span class="zk-sugg-icon zk-sugg-sys">◈</span>`;
      return `<li class="zk-sugg${i === state.active ? ' active' : ''}" role="option" data-i="${i}" aria-selected="${i === state.active}">`
        + icon
        + `<span class="zk-sugg-name">${esc(s.name)}</span>`
        + `<span class="zk-sugg-kind">${esc(KIND_TAG[s.kind] || s.kind)}</span></li>`;
    }).join('');
    el.hidden = false;
    $('#zkill-q')?.setAttribute('aria-expanded', 'true');
    el.querySelectorAll('.zk-sugg').forEach((li) => {
      li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(Number(li.dataset.i)); });
      li.addEventListener('mouseenter', () => { state.active = Number(li.dataset.i); highlight(); });
    });
  }

  function highlight() {
    const el = $('#zkill-suggest');
    if (!el) return;
    el.querySelectorAll('.zk-sugg').forEach((li, i) => {
      const on = i === state.active;
      li.classList.toggle('active', on);
      li.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  function pick(i) {
    const s = state.sugg[i];
    if (!s) return;
    state.selected = { id: s.id, kind: s.kind, name: s.name };
    const input = $('#zkill-q');
    if (input) input.value = s.name;
    const kindSel = $('#zkill-kind');
    if (kindSel) kindSel.value = s.kind;   // reflect the resolved kind
    closeSuggest();
    search();
  }

  async function fetchSuggest(term) {
    const seq = ++suggestSeq;
    try {
      const res = await fetch(`${API}/api/zkill/suggest?q=${encodeURIComponent(term)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (seq !== suggestSeq) return;               // a newer keystroke superseded us
      if ((($('#zkill-q')?.value) || '').trim() !== term) return;
      state.sugg = data.suggestions || [];
      state.active = -1;
      renderSuggest();
    } catch (_) { /* type-ahead is best-effort */ }
  }

  function onInput() {
    // Typing invalidates any previously picked suggestion.
    state.selected = null;
    const term = ($('#zkill-q')?.value || '').trim();
    if (suggestTimer) clearTimeout(suggestTimer);
    if (term.length < 3) { closeSuggest(); return; }
    suggestTimer = setTimeout(() => fetchSuggest(term), 220);
  }

  function onKeyDown(e) {
    if ($('#zkill-suggest')?.hidden || !state.sugg.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      state.active = (state.active + 1) % state.sugg.length;
      highlight();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      state.active = (state.active - 1 + state.sugg.length) % state.sugg.length;
      highlight();
    } else if (e.key === 'Enter') {
      if (state.active >= 0) { e.preventDefault(); pick(state.active); }
    } else if (e.key === 'Escape') {
      closeSuggest();
    }
  }

  let initialised = false;
  function initTab() {
    if (initialised) return;
    initialised = true;
    $('#zkill-form')?.addEventListener('submit', (e) => { e.preventDefault(); search(); });
    $('#zkill-search-btn')?.addEventListener('click', (e) => { e.preventDefault(); search(); });
    const input = $('#zkill-q');
    input?.addEventListener('input', onInput);
    input?.addEventListener('keydown', onKeyDown);
    input?.addEventListener('blur', () => setTimeout(closeSuggest, 120));  // allow click-select
    // Filter change keeps the picked entity; re-run if we have a query.
    $('#zkill-filter')?.addEventListener('change', () => { if (($('#zkill-q')?.value || '').trim()) search(); });
    // Manually choosing a kind overrides any picked suggestion, then re-runs.
    $('#zkill-kind')?.addEventListener('change', () => {
      state.selected = null;
      if (($('#zkill-q')?.value || '').trim()) search();
    });
    setTimeout(() => input?.focus(), 50);
  }

  document.querySelector('.tab-btn[data-tab="zkill"]')?.addEventListener('click', initTab);
})();
