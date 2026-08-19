'use strict';

// ============ Planner memory bank + auto-persistence ============
// Reusable across the Production and Reaction planners. Each planner registers
// its input fields; this module then:
//   * auto-saves the live inputs to localStorage on every edit — so nothing is
//     lost when the app is closed and reopened — and restores them on init;
//   * manages 10 recall "memory" slots (record / recall / rename / clear),
//     rendered as a button bar, with a pulsing glow on the active slot and an
//     auto icon (the recipe's product) + auto label (the first target).
//
// window.PlannerMemory(cfg) -> { init, render, recall, record, captureState }.
// cfg = { key, tab, bar (element id), fields:[{id}], primary (targets id),
//         onRestore(), iconTypeId(): number|null }
// Reuses app.js globals (escapeHtml, escapeAttr). Pop-out / split come later.

(function () {
  const SLOTS = 10;
  const IMG = 'https://images.evetech.net';
  const esc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(s) : String(s == null ? '' : s));
  const escA = (s) => (typeof escapeAttr === 'function' ? escapeAttr(s) : String(s == null ? '' : s));

  // "Ferrogel x5" / "Ferrogel  5" -> "Ferrogel"; first non-empty target line.
  function firstTargetLabel(text) {
    const line = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
    return line.replace(/\s*[x*]\s*[\d,]+\s*$/i, '').replace(/\s{2,}[\d,]+$/, '').trim();
  }

  function PlannerMemory(cfg) {
    const kSlots = `${cfg.key}-mem-slots`;
    const kPending = `${cfg.key}-mem-pending`;
    const kActive = `${cfg.key}-mem-active`;
    let slots = loadSlots();
    let active = parseInt(localStorage.getItem(kActive) || '-1', 10);
    let saveTimer = null;
    // Pop-out windows share this planner's localStorage with the main window, so
    // they must NOT write the auto-saved "pending" (it would clobber the main
    // window's in-progress work). A pop-out just loads the requested slot.
    const _params = new URLSearchParams(location.search);
    const isPopout = _params.get('popout') === cfg.tab;
    const popMem = isPopout && _params.get('mem') != null ? parseInt(_params.get('mem'), 10) : null;
    let compareMode = false;
    const compareSet = new Set();

    function emitCompare() {
      if (!cfg.onCompare) return;
      const items = [...compareSet].filter((i) => slots[i]).sort((a, b) => a - b)
        .map((i) => ({ index: i, label: slots[i].label, icon: slots[i].icon, state: slots[i].state }));
      try { cfg.onCompare(items); } catch (_) {}
    }

    function loadSlots() {
      let a = [];
      try { a = JSON.parse(localStorage.getItem(kSlots) || '[]') || []; } catch (_) { a = []; }
      return Array.from({ length: SLOTS }, (_, i) => a[i] || null);
    }
    function persistSlots() { try { localStorage.setItem(kSlots, JSON.stringify(slots)); } catch (_) {} }
    function setActive(i) { active = i; if (!isPopout) { try { localStorage.setItem(kActive, String(i)); } catch (_) {} } }

    function captureState() {
      const s = {};
      for (const f of cfg.fields) {
        const el = document.getElementById(f.id);
        if (!el) continue;
        s[f.id] = el.type === 'checkbox' ? !!el.checked : el.value;
      }
      return s;
    }
    function applyState(s) {
      if (!s) return;
      for (const f of cfg.fields) {
        const el = document.getElementById(f.id);
        if (!el || !(f.id in s)) continue;
        if (el.type === 'checkbox') el.checked = !!s[f.id];
        else el.value = s[f.id];
      }
      try { cfg.onRestore && cfg.onRestore(); } catch (_) {}
    }
    function primaryEmpty(s) { return !s || !String(s[cfg.primary] || '').trim(); }
    function sameState(a, b) { try { return JSON.stringify(a) === JSON.stringify(b); } catch (_) { return false; } }

    // ---- auto-persistence (survives app restart) ----
    function schedulePersist() {
      if (isPopout) return; // never let a pop-out overwrite the main window's pending
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        try { localStorage.setItem(kPending, JSON.stringify(captureState())); } catch (_) {}
      }, 400);
    }
    function restorePending() {
      let p = null;
      try { p = JSON.parse(localStorage.getItem(kPending) || 'null'); } catch (_) {}
      if (p) applyState(p);
    }

    // ---- slot operations ----
    function newSlot(state, i, keepLabel) {
      return {
        label: keepLabel || firstTargetLabel(state[cfg.primary]) || `Slot ${i + 1}`,
        renamed: !!keepLabel,
        icon: cfg.iconTypeId ? cfg.iconTypeId() : null,
        state, savedAt: Date.now(),
      };
    }
    function record(i) {
      const prev = slots[i];
      slots[i] = newSlot(captureState(), i, prev && prev.renamed ? prev.label : null);
      persistSlots(); setActive(i); render();
    }
    function recall(i, silent) {
      const slot = slots[i];
      if (!slot) return;
      // Offer to stash unsaved current work (not already stored) before loading.
      if (!silent) {
        const cur = captureState();
        if (!primaryEmpty(cur) && !sameState(cur, slot.state) && !slots.some((s) => s && sameState(s.state, cur))) {
          if (window.confirm('Save your current work to a free memory slot before loading this one?')) {
            const free = slots.findIndex((s) => !s);
            if (free >= 0) { slots[free] = newSlot(cur, free); persistSlots(); }
            else window.alert('All 10 slots are full — clear one first (its ✕), then try again.');
          }
        }
      }
      applyState(slot.state); setActive(i); render(); schedulePersist();
    }
    function clearSlot(i) { slots[i] = null; if (active === i) setActive(-1); persistSlots(); render(); }
    function rename(i) {
      const s = slots[i]; if (!s) return;
      const nm = window.prompt('Label for this memory:', s.label);
      if (nm != null) { s.label = nm.trim() || s.label; s.renamed = true; persistSlots(); render(); }
    }
    function reset() {
      for (const f of cfg.fields) {
        const el = document.getElementById(f.id);
        if (el && el.type !== 'checkbox' && el.tagName !== 'SELECT') el.value = '';
      }
      try { localStorage.removeItem(kPending); } catch (_) {}
      setActive(-1);
      try { cfg.onRestore && cfg.onRestore(); } catch (_) {}
      render();
    }

    // ---- render the slot bar ----
    function slotHtml(s, i) {
      const activeCls = i === active ? ' pmem-active' : '';
      if (!s) {
        return `<div class="pmem-slot pmem-empty${activeCls}" data-i="${i}" title="Empty slot ${i + 1} — 💾 stores the current page here">
          <span class="pmem-num">${i + 1}</span>
          <span class="pmem-actions"><button type="button" class="pmem-act" data-act="save" data-i="${i}" title="Store current page here">💾</button></span>
        </div>`;
      }
      const icon = s.icon
        ? `<img class="pmem-icon" src="${IMG}/types/${s.icon}/icon?size=32" alt="" onerror="this.style.display='none'">`
        : `<span class="pmem-num">${i + 1}</span>`;
      const selCls = compareMode && compareSet.has(i) ? ' pmem-compare-sel' : '';
      return `<div class="pmem-slot pmem-filled${activeCls}${selCls}" data-i="${i}" title="${escA(s.label)}${compareMode ? ' — click to add/remove from compare' : ' — click to recall'}">
        ${icon}<span class="pmem-label">${esc(s.label)}</span>
        <span class="pmem-actions">
          <button type="button" class="pmem-act" data-act="save" data-i="${i}" title="Overwrite with the current page">💾</button>
          <button type="button" class="pmem-act" data-act="rename" data-i="${i}" title="Rename">✎</button>
          <button type="button" class="pmem-act" data-act="popout" data-i="${i}" title="Pop out into its own window">⤢</button>
          <button type="button" class="pmem-act" data-act="clear" data-i="${i}" title="Clear this memory">✕</button>
        </span>
      </div>`;
    }
    function render() {
      const bar = document.getElementById(cfg.bar);
      if (!bar) return;
      const cmpBtn = cfg.onCompare
        ? `<button type="button" class="pmem-compare secondary${compareMode ? ' pmem-on' : ''}" title="Compare mode — click slots to view their recipe chains side by side">⊟ Compare${compareMode ? ' ✓' : ''}</button>`
        : '';
      bar.innerHTML = `<span class="pmem-title muted" title="Store up to 10 recipes; click a slot to recall it. Everything typed is also kept when you reopen the app.">Memory</span>`
        + `<div class="pmem-slots">${slots.map(slotHtml).join('')}</div>`
        + cmpBtn
        + `<button type="button" class="pmem-reset secondary" title="Clear the page inputs (your saved memories are kept)">Reset page</button>`;
    }

    function wireBar() {
      const bar = document.getElementById(cfg.bar);
      if (!bar || bar.dataset.wired) return;
      bar.dataset.wired = '1';
      bar.addEventListener('click', (e) => {
        const act = e.target.closest('.pmem-act');
        if (act) {
          e.stopPropagation();
          const i = +act.dataset.i;
          const a = act.dataset.act;
          if (a === 'save') record(i);
          else if (a === 'rename') rename(i);
          else if (a === 'clear') clearSlot(i);
          else if (a === 'popout' && slots[i] && window.api && window.api.popOutTab) window.api.popOutTab(cfg.tab, { mem: i });
          return;
        }
        if (e.target.closest('.pmem-compare')) {
          compareMode = !compareMode;
          if (!compareMode) compareSet.clear();
          render(); emitCompare();
          return;
        }
        if (e.target.closest('.pmem-reset')) { reset(); return; }
        const slot = e.target.closest('.pmem-slot');
        if (!slot || !slots[+slot.dataset.i]) return;
        const i = +slot.dataset.i;
        if (compareMode) {
          if (compareSet.has(i)) compareSet.delete(i); else compareSet.add(i);
          render(); emitCompare();
        } else {
          recall(i);
        }
      });
    }
    function wireInputs() {
      for (const f of cfg.fields) {
        const el = document.getElementById(f.id);
        if (!el || el.dataset.pmemWired) continue;
        el.dataset.pmemWired = '1';
        el.addEventListener('input', schedulePersist);
        el.addEventListener('change', schedulePersist);
      }
    }

    let inited = false;
    function init() {
      if (inited) return; inited = true;
      wireInputs(); wireBar();
      if (isPopout && popMem != null && popMem >= 0 && popMem < SLOTS && slots[popMem]) {
        recall(popMem, true);   // load the popped-out memory (and render)
      } else {
        restorePending(); render();
      }
    }
    return { init, render, recall, record, captureState };
  }

  window.PlannerMemory = PlannerMemory;
})();
