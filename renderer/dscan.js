'use strict';

// ==================== D-Scan share (General tab) ====================
// Paste an in-game directional scan, get a shareable dscan.info link. The
// submission is routed through the sidecar (POST /api/dscan/share → dscan.info)
// to dodge CORS; a quick local breakdown by object type is shown as you paste.
// Reuses app.js globals ($, API, escapeHtml, openExternalLink). Self-registers.

(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(s) : String(s == null ? '' : s));

  // A D-scan clipboard row is tab-separated: id \t name \t type \t distance.
  // We only need the type column (index 2) for a no-lookup breakdown.
  function parse(text) {
    const byType = new Map();
    let objects = 0;
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) continue;
      const cols = line.split('\t');
      if (cols.length < 3) continue; // not a d-scan row
      objects += 1;
      const type = (cols[2] || '').trim() || '(unknown)';
      byType.set(type, (byType.get(type) || 0) + 1);
    }
    const types = [...byType.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return { objects, types };
  }

  function renderSummary() {
    const el = $('#dscan-summary');
    if (!el) return;
    const { objects, types } = parse($('#dscan-paste')?.value || '');
    if (!objects) { el.innerHTML = ''; return; }
    const rows = types.map(([name, n]) =>
      `<tr><td class="dscan-n">${n}</td><td>${esc(name)}</td></tr>`).join('');
    el.innerHTML = `
      <div class="dscan-summary-head">${objects.toLocaleString('en-US')} object(s) · ${types.length} type(s)</div>
      <table class="dscan-table"><tbody>${rows}</tbody></table>`;
  }

  async function share() {
    const btn = $('#dscan-share');
    const status = $('#dscan-status');
    const result = $('#dscan-result');
    const paste = ($('#dscan-paste')?.value || '').trim();
    if (!paste) { if (status) status.textContent = 'Paste a D-scan first.'; return; }
    if (btn) btn.disabled = true;
    if (status) status.textContent = 'Creating share link on dscan.info…';
    try {
      const res = await fetch(`${API}/api/dscan/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paste }),
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json()).detail || msg; } catch (_) {}
        throw new Error(msg);
      }
      const data = await res.json();
      if (!data.url) throw new Error('no URL returned');
      $('#dscan-url').value = data.url;
      if (result) result.hidden = false;
      if (status) status.textContent = 'Share link ready.';
    } catch (e) {
      if (result) result.hidden = true;
      if (status) status.textContent = `Couldn’t create link: ${e.message || e}`;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function copyUrl() {
    const url = $('#dscan-url')?.value || '';
    const status = $('#dscan-status');
    if (!url) return;
    try { await navigator.clipboard.writeText(url); if (status) status.textContent = 'Copied to clipboard.'; }
    catch (_) { if (status) status.textContent = 'Clipboard copy failed — select and copy manually.'; }
  }

  function openUrl() {
    const url = $('#dscan-url')?.value || '';
    if (!url) return;
    if (typeof openExternalLink === 'function') openExternalLink(url);
    else window.api?.openExternal?.(url);
  }

  let initialised = false;
  function initTab() {
    if (initialised) return;
    initialised = true;
    $('#dscan-paste')?.addEventListener('input', renderSummary);
    $('#dscan-share')?.addEventListener('click', share);
    $('#dscan-copy')?.addEventListener('click', copyUrl);
    $('#dscan-open')?.addEventListener('click', openUrl);
    $('#dscan-clear')?.addEventListener('click', () => {
      $('#dscan-paste').value = '';
      $('#dscan-result').hidden = true;
      $('#dscan-summary').innerHTML = '';
      const st = $('#dscan-status'); if (st) st.textContent = '';
    });
  }

  document.querySelector('.tab-btn[data-tab="dscan"]')?.addEventListener('click', initTab);
})();
