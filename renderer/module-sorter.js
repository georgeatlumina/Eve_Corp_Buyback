'use strict';

// ============== Doctrine Module Sorter (General tab) ==============
// Paste a copied EVE inventory (or any multibuy list); each line is split into
// doctrine vs non-doctrine items. The doctrine set is the union of every item
// across every fit captured by the Market Readiness scan (readinessState.scan,
// persisted in localStorage — see scanAllFits in app.js). Reuses app.js globals
// ($, escapeHtml, downloadBlob, activateTab) and the .ms-* CSS in styles.css.

(function () {
  // Normalise a type name for matching: EVE emits the same spelling on both
  // sides, so a trimmed / whitespace-collapsed / lowercased key is enough.
  function norm(s) {
    return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  // Pull a quantity out of a string, tolerating thousands separators in any
  // locale (comma, period, space, nbsp) — inventory quantities are integers, so
  // stripping every non-digit is safe. Returns null when there's no number.
  function parseQty(s) {
    const digits = String(s == null ? '' : s).replace(/[^\d]/g, '');
    if (!digits) return null;
    const n = parseInt(digits, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  // Build the doctrine item set from the Market Readiness scan.
  //   byName    Map(normName -> canonical display name)
  //   hullNames Set(normName) — the hulls, so they can be excluded on request
  function doctrineSet() {
    const byName = new Map();
    const hullNames = new Set();
    let fitCount = 0;
    let scannedAt = null;
    let scan = null;
    try { scan = (typeof readinessState !== 'undefined') ? readinessState.scan : null; } catch (_) { scan = null; }
    if (scan && scan.fits) {
      scannedAt = scan.scannedAt || null;
      for (const f of Object.values(scan.fits)) {
        if (!f || f.error || !Array.isArray(f.items)) continue;
        fitCount += 1;
        for (const it of f.items) {
          const key = norm(it.name);
          if (!key) continue;
          if (!byName.has(key)) byName.set(key, String(it.name).trim());
        }
        if (f.hullName) hullNames.add(norm(f.hullName));
      }
    }
    return { byName, hullNames, fitCount, itemCount: byName.size, scannedAt };
  }

  // Parse a pasted inventory / multibuy blob into [{ name, qty }].
  // Handles tab-separated inventory rows (name<TAB>qty<TAB>group<TAB>…),
  // "Name xN" multibuy lines, and bare "Name" lines (qty 1).
  function parseInventory(text) {
    const out = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.includes('\t')) {
        const fields = line.split('\t');
        const name = fields[0].trim();
        if (!name) continue;
        let qty = parseQty(fields[1]);
        if (qty == null) {
          for (let i = 2; i < fields.length; i++) {
            qty = parseQty(fields[i]);
            if (qty != null) break;
          }
        }
        out.push({ name, qty: qty == null ? 1 : qty });
        continue;
      }
      const m = /^(.*?)\s+x\s*([\d.,\s]+)$/i.exec(line);
      if (m && parseQty(m[2]) != null) {
        out.push({ name: m[1].trim(), qty: parseQty(m[2]) });
      } else {
        out.push({ name: line, qty: 1 });
      }
    }
    return out;
  }

  // Aggregate identical names (summing qty) preserving a display name. When the
  // item is in the doctrine set, prefer the doctrine spelling for consistency.
  function aggregate(items, byName) {
    const map = new Map();
    for (const it of items) {
      const key = norm(it.name);
      if (!key) continue;
      const display = byName.get(key) || it.name;
      const cur = map.get(key);
      if (cur) cur.qty += it.qty;
      else map.set(key, { name: display, qty: it.qty });
    }
    return map;
  }

  function toMultibuy(rows) {
    return rows
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((r) => `${r.name} x${r.qty}`)
      .join('\n');
  }

  function sumUnits(rows) {
    return rows.reduce((n, r) => n + (Number(r.qty) || 0), 0);
  }

  function hasUsableScan() {
    try {
      const s = (typeof readinessState !== 'undefined') ? readinessState.scan : null;
      return !!(s && s.fits && Object.keys(s.fits).length);
    } catch (_) { return false; }
  }

  function renderSource() {
    const el = $('#module-sorter-source');
    if (!el) return;
    const set = doctrineSet();
    if (!set.itemCount) {
      const scanning = (function () { try { return !!readinessState.scanning; } catch (_) { return false; } })();
      el.innerHTML = scanning
        ? 'Running the first Market Readiness scan in the background — the doctrine set will populate when it finishes…'
        : 'No Market Readiness scan yet — one starts automatically the first time you open this tab. '
          + 'You can also run <em>Scan all fits</em> on the '
          + '<a href="#" data-tab-link="readiness">Market Readiness</a> tab. '
          + 'Until then every item is treated as non-doctrine.';
      return;
    }
    const when = set.scannedAt ? new Date(set.scannedAt).toLocaleString() : 'unknown time';
    el.textContent = `Doctrine set: ${set.itemCount} unique item(s) across ${set.fitCount} fit(s) · scanned ${when}.`;
  }

  // First-run convenience: if this machine has never captured a readiness scan,
  // kick one off in the background so the sorter has a doctrine set to match
  // against. Once per session (a failed attempt — e.g. not signed in to Alliance
  // Auth — won't retry until restart); skips if a scan already exists or a manual
  // scan is already running. scanAllFits persists its result to localStorage.
  let autoScanTried = false;
  async function maybeAutoScan() {
    if (autoScanTried || hasUsableScan()) return;
    if (typeof scanAllFits !== 'function' || typeof readinessState === 'undefined') return;
    if (readinessState.scanning) return; // a manual scan is already handling it
    autoScanTried = true;
    const status = $('#module-sorter-status');
    if (status) status.textContent = 'No doctrine data yet — running a first-time Market Readiness scan in the background…';
    const scanning = scanAllFits(); // sets readinessState.scanning synchronously
    renderSource();                 // now reflects the in-progress scan
    try { await scanning; } catch (_) {}
    renderSource();
    if (hasUsableScan()) {
      sort(); // reclassify whatever's pasted against the freshly loaded set
    } else if (status) {
      let err = ''; try { err = readinessState.scanError || ''; } catch (_) {}
      status.textContent = err
        ? `Auto-scan failed: ${err} — open the Market Readiness tab to retry (are you signed in to Alliance Auth?).`
        : 'Auto-scan finished with no fits — open the Market Readiness tab to retry.';
    }
  }

  function sort() {
    const set = doctrineSet();
    const excludeHulls = !!$('#module-sorter-exclude-hulls')?.checked;
    const items = parseInventory($('#module-sorter-input')?.value || '');
    const agg = aggregate(items, set.byName);

    const doctrine = [];
    const other = [];
    for (const [key, row] of agg) {
      const isDoctrine = set.byName.has(key) && !(excludeHulls && set.hullNames.has(key));
      (isDoctrine ? doctrine : other).push(row);
    }

    $('#module-sorter-doctrine-out').value = toMultibuy(doctrine);
    $('#module-sorter-other-out').value = toMultibuy(other);
    $('#module-sorter-doctrine-count').textContent = `${doctrine.length} line(s) · ${sumUnits(doctrine).toLocaleString('en-US')} unit(s)`;
    $('#module-sorter-other-count').textContent = `${other.length} line(s) · ${sumUnits(other).toLocaleString('en-US')} unit(s)`;

    const status = $('#module-sorter-status');
    if (status) {
      if (!agg.size) {
        status.textContent = 'Nothing to sort — paste an inventory above.';
      } else if (!set.itemCount) {
        status.textContent = `Sorted ${agg.size} line(s), but no doctrine set is loaded — run a Market Readiness scan.`;
      } else {
        status.textContent = `Sorted ${agg.size} line(s): ${doctrine.length} doctrine, ${other.length} non-doctrine.`;
      }
    }
  }

  async function copyOut(id, label) {
    const text = $(id)?.value || '';
    const status = $('#module-sorter-status');
    if (!text) { if (status) status.textContent = `Nothing to copy in ${label}.`; return; }
    try {
      await navigator.clipboard.writeText(text);
      if (status) status.textContent = `Copied ${label} to clipboard.`;
    } catch (_) {
      if (status) status.textContent = 'Clipboard copy failed.';
    }
  }

  function downloadOut(id, filename, label) {
    const text = $(id)?.value || '';
    const status = $('#module-sorter-status');
    if (!text) { if (status) status.textContent = `Nothing to download in ${label}.`; return; }
    downloadBlob(filename, 'text/plain', `${text}\n`);
  }

  let initialised = false;
  function initTab() {
    renderSource();
    maybeAutoScan(); // fire-and-forget; self-guards against repeats and in-flight scans
    if (initialised) return;
    initialised = true;

    $('#btn-module-sorter-sort')?.addEventListener('click', sort);
    $('#module-sorter-input')?.addEventListener('input', sort);
    $('#module-sorter-exclude-hulls')?.addEventListener('change', sort);
    $('#btn-module-sorter-clear')?.addEventListener('click', () => {
      $('#module-sorter-input').value = '';
      sort();
    });
    $('#btn-module-sorter-copy-doctrine')?.addEventListener('click', () => copyOut('#module-sorter-doctrine-out', 'doctrine modules'));
    $('#btn-module-sorter-copy-other')?.addEventListener('click', () => copyOut('#module-sorter-other-out', 'non-doctrine modules'));
    $('#btn-module-sorter-download-doctrine')?.addEventListener('click', () => downloadOut('#module-sorter-doctrine-out', 'doctrine-modules.txt', 'doctrine modules'));
    $('#btn-module-sorter-download-other')?.addEventListener('click', () => downloadOut('#module-sorter-other-out', 'non-doctrine-modules.txt', 'non-doctrine modules'));

    // In-page "Market Readiness" links inside this tab.
    document.querySelectorAll('#tab-module-sorter [data-tab-link]').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        if (typeof activateTab === 'function') activateTab(a.dataset.tabLink);
      });
    });
  }

  document.querySelector('.tab-btn[data-tab="module-sorter"]')?.addEventListener('click', initTab);
})();
