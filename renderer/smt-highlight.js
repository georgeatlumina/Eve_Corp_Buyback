'use strict';

// ================= intel line highlighting =================
// Shared by the Intel Map feed and the overlay ticker. The sidecar hands each
// intel event a `spans` list — where in the line it found a system name or a
// ship — and this rebuilds the line with those runs wrapped so you can pick out
// "what, where" at a glance instead of reading the sentence.
//
// Everything outside a span is escaped and left plain: the text is other
// players' chat, so it never reaches innerHTML unescaped.

window.SmtHighlight = (function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const CLS = { sys: 'ih-sys', ship: 'ih-ship', pilot: 'ih-pilot' };

  return {
    esc,

    /** The line with each span wrapped. System spans carry their id so callers
     *  can make the word itself clickable. */
    line(text, spans) {
      const t = String(text == null ? '' : text);
      const list = (spans || [])
        .filter((x) => x && Number.isFinite(x.s) && Number.isFinite(x.e) && x.e > x.s)
        .sort((a, b) => a.s - b.s);
      let out = '', at = 0;
      for (const sp of list) {
        if (sp.s < at) continue;                 // overlapping span — first wins
        out += esc(t.slice(at, sp.s));
        const cls = CLS[sp.k] || CLS.sys;
        const id = sp.k === 'sys' && sp.id ? ` data-id="${esc(sp.id)}"` : '';
        out += `<span class="${cls}"${id}>${esc(t.slice(sp.s, sp.e))}</span>`;
        at = sp.e;
      }
      return out + esc(t.slice(at));
    },

    /** The reporting pilot, as its own element. Blank when the line had none. */
    speaker(name) {
      const n = String(name == null ? '' : name).trim();
      return n ? `<span class="ih-pilot">${esc(n)}</span>` : '';
    },
  };
})();
