'use strict';

// ===== Build Overview (calendar + gantt of all planned builds) =====
// Read-only ops view. Pulls every builder's planned builds from /api/builds/all
// (the same source as Build Fulfilment) and lays them out two ways:
//   • Calendar — each build shown on its estimated-completion (due) date.
//   • Gantt    — a bar per build spanning created_at -> est_completion, grouped
//                by builder.
// Each build's manufacturing slots are surfaced in a shared detail panel when a
// build is clicked. Loaded after app.js; relies on its globals: $, API,
// escapeHtml, downloadBlob.

(function () {
  const ALLIANCE_LABEL = { main: 'NLDF', institute: 'NLDO' };
  const MS_DAY = 86400000;
  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  const state = {
    loaded: false,
    loading: false,
    builders: [],
    storage: 'local',
    view: 'calendar',   // 'calendar' | 'gantt'
    alliance: 'all',    // 'all' | 'main' | 'institute'
    month: null,        // { y, m } (m 0-based) for the calendar
    selected: null,     // selected build id for the detail panel
  };

  // ---- date helpers (all at local midnight) ----
  function parseDate(s) {
    if (!s) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s).trim());
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  function ymd(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function today() { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
  function daysBetween(a, b) { return Math.round((b.getTime() - a.getTime()) / MS_DAY); }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }

  // ---- flatten builder docs into build items with computed dates ----
  function buildItems() {
    const out = [];
    for (const doc of state.builders) {
      const builder = doc.builder_name || ('char ' + (doc.builder_id || '?'));
      for (const b of (doc.builds || [])) {
        const alliance = b.alliance === 'institute' ? 'institute' : 'main';
        if (state.alliance !== 'all' && alliance !== state.alliance) continue;
        const end = parseDate(b.est_completion);
        let start = parseDate(b.created_at);
        if (end && (!start || start > end)) start = end;   // clamp / default
        const slots = Array.isArray(b.slots) ? b.slots : [];
        out.push({
          id: b.id || `${doc.builder_id}:${b.doctrine}`,
          builder,
          doctrine: b.doctrine || '(untitled build)',
          alliance,
          note: b.note || '',
          slots,
          slotCount: slots.length,
          matCount: slots.reduce((s, sl) => s + ((sl.missing || []).length), 0),
          start, end,
          estText: b.est_completion || '',
        });
      }
    }
    return out;
  }

  function allBuildsById() {
    const map = new Map();
    for (const it of buildItems()) map.set(it.id, it);
    return map;
  }

  // ================= data load =================
  async function load(force) {
    if (state.loading) return;
    if (state.loaded && !force) { render(); return; }
    state.loading = true;
    setStatus('Loading…');
    try {
      const res = await fetch(`${API}/api/builds/all`);
      const data = await res.json().catch(() => ({}));
      state.builders = data.builders || [];
      state.storage = data.storage || 'local';
      state.loaded = true;
    } catch (e) {
      setStatus(`Failed to load: ${e.message || e}`);
    } finally {
      state.loading = false;
      render();
    }
  }

  function setStatus(msg) { const el = $('#builds-overview-status'); if (el) el.textContent = msg || ''; }

  // ================= render dispatch =================
  function render() {
    const root = $('#builds-overview-content');
    if (!root) return;
    if (state.loading) { root.innerHTML = '<p class="muted">Loading…</p>'; return; }

    const items = buildItems();
    const total = items.length;
    const dated = items.filter((i) => i.end).length;
    if (state.storage !== 'github') {
      setStatus('Shared repo not configured (or unreachable) — showing local builds only. Set the market-history repo + PATs in Config to see the whole alliance.');
    } else {
      setStatus(`${state.builders.length} builder file(s) · ${total} build(s) · ${total - dated} undated.`);
    }

    if (!total) { root.innerHTML = '<p class="muted">No builds planned yet. Builders add them on the Build Planner tab.</p>'; return; }
    root.innerHTML = state.view === 'gantt' ? renderGantt(items) : renderCalendar(items);
    renderDetail();
  }

  // ================= calendar =================
  function renderCalendar(items) {
    const dated = items.filter((i) => i.end);
    const undated = items.filter((i) => !i.end);

    if (!state.month) {
      const t = today();
      state.month = { y: t.getFullYear(), m: t.getMonth() };
    }
    const { y, m } = state.month;

    // Map YYYY-MM-DD -> builds due that day.
    const byDay = new Map();
    for (const it of dated) {
      const k = ymd(it.end);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(it);
    }

    const first = new Date(y, m, 1);
    const firstCol = (first.getDay() + 6) % 7; // Mon=0
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const cells = Math.ceil((firstCol + daysInMonth) / 7) * 7;
    const t = today();
    const dueThisMonth = dated.filter((i) => i.end.getFullYear() === y && i.end.getMonth() === m).length;

    let grid = '';
    for (let i = 0; i < cells; i++) {
      const dayNum = i - firstCol + 1;
      if (dayNum < 1 || dayNum > daysInMonth) { grid += '<div class="bo-cal-cell bo-cal-empty"></div>'; continue; }
      const d = new Date(y, m, dayNum);
      const key = ymd(d);
      const isToday = d.getTime() === t.getTime();
      const list = byDay.get(key) || [];
      const chips = list.map((it) => {
        const sel = it.id === state.selected ? ' bo-chip-sel' : '';
        return `<button type="button" class="bo-chip bo-a-${it.alliance}${sel}" data-build="${escapeHtml(it.id)}" title="${escapeHtml(chipTitle(it))}">
          <span class="bo-chip-doc">${escapeHtml(it.doctrine)}</span>
          <span class="bo-chip-meta">${escapeHtml(it.builder)} · ${it.slotCount} slot${it.slotCount === 1 ? '' : 's'}</span>
        </button>`;
      }).join('');
      grid += `<div class="bo-cal-cell${isToday ? ' bo-cal-today' : ''}">
        <div class="bo-cal-daynum">${dayNum}</div>
        <div class="bo-cal-chips">${chips}</div>
      </div>`;
    }

    const head = WEEKDAYS.map((w) => `<div class="bo-cal-wd">${w}</div>`).join('');
    const undatedBlock = undated.length ? `
      <div class="bo-undated">
        <div class="bo-undated-head">Undated (${undated.length}) — no estimated completion set</div>
        <div class="bo-undated-list">${undated.map((it) => `
          <button type="button" class="bo-chip bo-a-${it.alliance}${it.id === state.selected ? ' bo-chip-sel' : ''}" data-build="${escapeHtml(it.id)}" title="${escapeHtml(chipTitle(it))}">
            <span class="bo-chip-doc">${escapeHtml(it.doctrine)}</span>
            <span class="bo-chip-meta">${escapeHtml(it.builder)} · ${it.slotCount} slot${it.slotCount === 1 ? '' : 's'}</span>
          </button>`).join('')}</div>
      </div>` : '';

    return `
      <div class="bo-cal-bar">
        <button type="button" class="bo-nav" data-cal-nav="-1" title="Previous month">‹</button>
        <div class="bo-cal-title">${MONTHS[m]} ${y}<span class="muted"> · ${dueThisMonth} due</span></div>
        <button type="button" class="bo-nav" data-cal-nav="1" title="Next month">›</button>
        <button type="button" class="bo-nav bo-nav-today" data-cal-nav="today">Today</button>
      </div>
      <div class="bo-cal-weekdays">${head}</div>
      <div class="bo-cal-grid">${grid}</div>
      ${undatedBlock}
      ${legend()}`;
  }

  // ================= gantt =================
  function renderGantt(items) {
    const withEnd = items.filter((i) => i.end).map((i) => ({ ...i, start: i.start || i.end }));
    const undated = items.filter((i) => !i.end);
    if (!withEnd.length) {
      return `<p class="muted">No builds have an estimated completion date yet — nothing to chart.</p>${legend()}`;
    }

    let min = withEnd[0].start, max = withEnd[0].end;
    for (const it of withEnd) { if (it.start < min) min = it.start; if (it.end > max) max = it.end; }
    min = addDays(min, -1); max = addDays(max, 1);
    const span = Math.max(1, daysBetween(min, max)) + 1;
    const dayW = span > 300 ? 8 : span > 120 ? 14 : span > 45 ? 20 : 30;
    const timelineW = span * dayW;
    const t = today();

    // group by builder
    const groups = new Map();
    for (const it of withEnd) {
      if (!groups.has(it.builder)) groups.set(it.builder, []);
      groups.get(it.builder).push(it);
    }
    const builders = [...groups.keys()].sort((a, b) => a.localeCompare(b));

    // header ticks: weekly (Monday-aligned) gridlines + labels
    let ticks = '';
    for (let i = 0; i < span; i++) {
      const d = addDays(min, i);
      const isMon = ((d.getDay() + 6) % 7) === 0;
      if (isMon || i === 0) {
        const left = i * dayW;
        ticks += `<div class="bo-tick" style="left:${left}px"><span class="bo-tick-lbl">${d.getDate()}/${d.getMonth() + 1}</span></div>`;
      }
    }
    const todayLeft = (t >= min && t <= max) ? daysBetween(min, t) * dayW : null;
    const todayMarker = todayLeft != null ? `<div class="bo-today-line" style="left:${todayLeft}px" title="Today"></div>` : '';

    let rows = '';
    for (const builder of builders) {
      const list = groups.get(builder).sort((a, b) => a.start - b.start || a.end - b.end);
      rows += `<div class="bo-g-group">
        <div class="bo-g-label bo-g-grouplabel">${escapeHtml(builder)}<span class="muted"> · ${list.length}</span></div>
        <div class="bo-g-track" style="width:${timelineW}px">${todayMarker}</div>
      </div>`;
      for (const it of list) {
        const left = daysBetween(min, it.start) * dayW;
        const w = Math.max(dayW, (daysBetween(it.start, it.end) + 1) * dayW);
        const sel = it.id === state.selected ? ' bo-g-bar-sel' : '';
        rows += `<div class="bo-g-row">
          <div class="bo-g-label" title="${escapeHtml(it.doctrine)}">${escapeHtml(it.doctrine)}</div>
          <div class="bo-g-track" style="width:${timelineW}px">
            ${todayMarker}
            <button type="button" class="bo-g-bar bo-a-${it.alliance}${sel}" data-build="${escapeHtml(it.id)}"
              style="left:${left}px;width:${w}px" title="${escapeHtml(chipTitle(it))}">
              <span class="bo-g-bar-lbl">${it.slotCount} slot${it.slotCount === 1 ? '' : 's'} · due ${escapeHtml(it.estText)}</span>
            </button>
          </div>
        </div>`;
      }
    }

    const undatedNote = undated.length ? `<p class="muted bo-undated-note">${undated.length} undated build(s) not shown (no estimated completion).</p>` : '';
    return `
      <div class="bo-gantt-wrap">
        <div class="bo-gantt-header">
          <div class="bo-g-label bo-g-cornerlabel"></div>
          <div class="bo-g-track bo-g-headtrack" style="width:${timelineW}px">${ticks}${todayMarker}</div>
        </div>
        <div class="bo-gantt-body">${rows}</div>
      </div>
      ${undatedNote}
      ${legend()}`;
  }

  // ================= shared detail panel =================
  function chipTitle(it) {
    const parts = [
      `${it.doctrine} — ${ALLIANCE_LABEL[it.alliance]}`,
      `Builder: ${it.builder}`,
      it.estText ? `Due: ${it.estText}` : 'Due: (unset)',
      `${it.slotCount} slot(s), ${it.matCount} material line(s)`,
    ];
    if (it.note) parts.push(`Note: ${it.note}`);
    return parts.join('\n');
  }

  function renderDetail() {
    const el = $('#builds-overview-detail');
    if (!el) return;
    const it = state.selected ? allBuildsById().get(state.selected) : null;
    if (!it) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    const slots = it.slots.length ? it.slots.map((sl) => {
      const mats = (sl.missing || []);
      const matList = mats.length
        ? `<ul class="bo-mat-list">${mats.map((m) => `<li><span>${escapeHtml(m.name || '?')}</span><span class="bo-mat-qty">${Number(m.qty || 0).toLocaleString('en-US')}</span></li>`).join('')}</ul>`
        : '<div class="muted small">No missing materials pasted.</div>';
      return `<div class="bo-slot"><div class="bo-slot-head">${escapeHtml(sl.label || 'Slot')}<span class="muted"> · ${mats.length} line(s)</span></div>${matList}</div>`;
    }).join('') : '<div class="muted">No slots on this build.</div>';
    el.innerHTML = `
      <div class="bo-detail-head">
        <div>
          <strong>${escapeHtml(it.doctrine)}</strong>
          <span class="bo-tag bo-a-${it.alliance}">${ALLIANCE_LABEL[it.alliance]}</span>
        </div>
        <button type="button" class="bo-detail-close" data-bo-close="1" aria-label="Close">×</button>
      </div>
      <div class="muted bo-detail-meta">${escapeHtml(it.builder)} · due ${escapeHtml(it.estText || '(unset)')}${it.start ? ` · planned ${escapeHtml(ymd(it.start))}` : ''}</div>
      ${it.note ? `<div class="bo-detail-note">${escapeHtml(it.note)}</div>` : ''}
      <div class="bo-slots">${slots}</div>`;
  }

  function legend() {
    return `<div class="bo-legend">
      <span class="bo-legend-item"><span class="bo-swatch bo-a-main"></span> NLDF</span>
      <span class="bo-legend-item"><span class="bo-swatch bo-a-institute"></span> NLDO</span>
      <span class="bo-legend-item"><span class="bo-swatch-today"></span> Today</span>
    </div>`;
  }

  // ================= export =================
  function exportCsv() {
    const items = buildItems();
    if (!items.length) { setStatus('Nothing to export.'); return; }
    const header = 'builder,doctrine,alliance,planned,due,slots,material_lines,note';
    const body = items.map((it) => [
      `"${(it.builder || '').replace(/"/g, '""')}"`,
      `"${(it.doctrine || '').replace(/"/g, '""')}"`,
      it.alliance,
      it.start ? ymd(it.start) : '',
      it.estText || '',
      it.slotCount,
      it.matCount,
      `"${(it.note || '').replace(/"/g, '""')}"`,
    ].join(',')).join('\n');
    downloadBlob('build-overview.csv', 'text/csv', `${header}\n${body}\n`);
  }

  // ================= wiring =================
  function wire() {
    const section = $('#tab-builds-overview');
    if (!section) return;

    $('#builds-overview-view')?.addEventListener('change', (e) => { state.view = e.target.value; state.selected = null; render(); });
    $('#builds-overview-alliance')?.addEventListener('change', (e) => { state.alliance = e.target.value; state.selected = null; render(); });
    $('#btn-builds-overview-refresh')?.addEventListener('click', () => load(true));
    $('#btn-builds-overview-export')?.addEventListener('click', exportCsv);

    // Delegated clicks: month nav, chips/bars (select), detail close.
    section.addEventListener('click', (e) => {
      const nav = e.target.closest('[data-cal-nav]');
      if (nav) {
        const v = nav.dataset.calNav;
        if (v === 'today') { const t = today(); state.month = { y: t.getFullYear(), m: t.getMonth() }; }
        else {
          let { y, m } = state.month || (() => { const t = today(); return { y: t.getFullYear(), m: t.getMonth() }; })();
          m += Number(v);
          if (m < 0) { m = 11; y -= 1; } else if (m > 11) { m = 0; y += 1; }
          state.month = { y, m };
        }
        render();
        return;
      }
      if (e.target.closest('[data-bo-close]')) { state.selected = null; render(); return; }
      const chip = e.target.closest('[data-build]');
      if (chip) {
        const id = chip.dataset.build;
        state.selected = state.selected === id ? null : id;
        render();
      }
    });
  }

  wire();
  document.querySelector('.tab-btn[data-tab="builds-overview"]')?.addEventListener('click', () => load(false));
})();
