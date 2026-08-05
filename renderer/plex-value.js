'use strict';

// ============== Money → PLEX → ISK calculator (General tab) ==============
// Real money → USD (live forex) → PLEX (CCP store pack rate, or a manual
// USD/PLEX override) → ISK (live Jita PLEX sell price from Janice/ESI).
// Reuses app.js globals ($, API, fmtIskShort) and the shared .market-tile CSS;
// its own rules live under .pv-* in styles.css. Self-registers on first open.

(function () {
  const PLEX_TYPE_ID = 44992;
  const LS_KEY = 'plexValuePrefs';

  // CCP PLEX store packs — USD list prices (approximate; CCP re-prices and runs
  // regional promos, so these are a sane default, not gospel — the manual
  // "USD per PLEX" override is there for when you know your real rate). Bigger
  // packs are cheaper per PLEX. Effective $/PLEX is derived, not stored.
  const PACKS = [
    { plex: 500, usd: 19.99 },
    { plex: 1100, usd: 34.99 },
    { plex: 2050, usd: 59.99 },
    { plex: 3300, usd: 89.99 },
    { plex: 6800, usd: 169.99 },
    { plex: 14700, usd: 349.99 },
  ];

  // Currencies floated to the top of the dropdown when the provider lists them.
  const PREFERRED = ['USD', 'EUR', 'GBP', 'AUD', 'CAD', 'NZD', 'JPY', 'SEK', 'NOK', 'DKK', 'PLN', 'CHF'];

  // Module-scoped caches so recalculating on every keystroke is instant (no
  // refetch). Populated by loadRates(); Refresh re-fetches with bust=1.
  let forexRates = null;   // { CCY: units-per-USD }
  let forexMeta = null;    // { updated, source, stale }
  let plexIsk = null;      // ISK per PLEX (Jita sell)
  let plexMeta = null;     // { source }

  function usdPerPlex(pack) { return pack.usd / pack.plex; }

  function fmtUsd(n) {
    if (n == null || isNaN(n)) return '—';
    return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtNum(n, dp = 0) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toLocaleString('en-US', { maximumFractionDigits: dp });
  }

  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (_) { return {}; }
  }
  function savePrefs() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        amount: $('#pv-amount')?.value || '',
        currency: $('#pv-currency')?.value || '',
        pack: $('#pv-pack')?.value || '',
        custom: $('#pv-custom-rate')?.value || '',
      }));
    } catch (_) { /* private mode / quota — prefs just won't persist */ }
  }

  function populatePackSelect() {
    const sel = $('#pv-pack');
    if (!sel) return;
    const opts = PACKS.map((p, i) =>
      `<option value="pack:${i}">${fmtNum(p.plex)} PLEX — ${fmtUsd(p.usd)} ($${usdPerPlex(p).toFixed(4)}/PLEX)</option>`
    );
    opts.push('<option value="custom">Custom rate…</option>');
    sel.innerHTML = opts.join('');
  }

  function populateCurrencySelect() {
    const sel = $('#pv-currency');
    if (!sel || !forexRates) return;
    const all = Object.keys(forexRates).sort();
    const top = PREFERRED.filter((c) => forexRates[c] != null);
    const rest = all.filter((c) => !top.includes(c));
    const opt = (c) => `<option value="${c}">${c}</option>`;
    sel.innerHTML =
      `<optgroup label="Common">${top.map(opt).join('')}</optgroup>` +
      `<optgroup label="All">${rest.map(opt).join('')}</optgroup>`;
  }

  function currentUsdPerPlex() {
    const val = $('#pv-pack')?.value || '';
    if (val === 'custom') {
      const r = parseFloat($('#pv-custom-rate')?.value);
      return Number.isFinite(r) && r > 0 ? r : null;
    }
    const m = /^pack:(\d+)$/.exec(val);
    if (m && PACKS[+m[1]]) return usdPerPlex(PACKS[+m[1]]);
    return null;
  }

  function calc() {
    const result = $('#pv-result');
    const status = $('#pv-status');
    const custom = $('.pv-custom');
    if (custom) custom.hidden = ($('#pv-pack')?.value !== 'custom');

    const amount = parseFloat($('#pv-amount')?.value);
    const ccy = $('#pv-currency')?.value || 'USD';
    savePrefs();

    if (!Number.isFinite(amount) || amount <= 0) {
      if (result) result.hidden = true;
      if (status) status.textContent = 'Enter an amount to convert.';
      return;
    }
    if (!forexRates || forexRates[ccy] == null) {
      if (result) result.hidden = true;
      if (status) status.textContent = 'Waiting for forex rates…';
      return;
    }
    const perPlex = currentUsdPerPlex();
    if (!perPlex) {
      if (result) result.hidden = true;
      if (status) status.textContent = 'Enter a USD-per-PLEX rate (or pick a CCP pack).';
      return;
    }
    if (plexIsk == null) {
      if (result) result.hidden = true;
      if (status) status.textContent = 'Waiting for the Jita PLEX price…';
      return;
    }

    const usd = amount / forexRates[ccy];      // rates are units-per-USD
    const plex = usd / perPlex;
    const isk = plex * plexIsk;

    $('#pv-usd').textContent = fmtUsd(usd);
    $('#pv-plex').textContent = fmtNum(plex) + ' PLEX';
    $('#pv-isk').textContent = fmtIskShort(isk) + ' ISK';
    $('#pv-breakdown').innerHTML =
      `${fmtNum(amount, 2)} ${ccy} = ${fmtUsd(usd)} ` +
      `· ${fmtUsd(perPlex)}/PLEX → ${fmtNum(plex)} PLEX ` +
      `· ${fmtNum(plexIsk)} ISK/PLEX (Jita sell) → <strong>${fmtNum(isk)} ISK</strong>`;
    if (result) result.hidden = false;
    if (status) status.textContent = '';
  }

  function renderRatesLine() {
    const el = $('#pv-rates');
    if (!el) return;
    const parts = [];
    if (forexMeta) {
      parts.push(`FX ${forexMeta.stale ? '(stale) ' : ''}via ${forexMeta.source}${forexMeta.updated ? ` — ${forexMeta.updated}` : ''}`);
    }
    if (plexIsk != null) {
      parts.push(`PLEX Jita sell: ${fmtNum(plexIsk)} ISK (${plexMeta?.source || '?'})`);
    }
    el.textContent = parts.join('  ·  ');
  }

  async function loadRates(bust) {
    const status = $('#pv-status');
    if (status) status.textContent = 'Fetching forex rates and the Jita PLEX price…';
    const b = bust ? '?bust=1' : '';
    const bAmp = bust ? '&bust=1' : '';
    const [fx, plex] = await Promise.allSettled([
      fetch(`${API}/api/forex/rates${b}`).then((r) => r.json()),
      fetch(`${API}/api/market/jita-sell?type_id=${PLEX_TYPE_ID}${bAmp}`).then((r) => r.json()),
    ]);

    let ok = true;
    if (fx.status === 'fulfilled' && fx.value && fx.value.rates) {
      forexRates = fx.value.rates;
      forexMeta = { updated: fx.value.updated, source: fx.value.source, stale: !!fx.value.stale };
      populateCurrencySelect();
    } else {
      ok = false;
    }
    if (plex.status === 'fulfilled' && plex.value && plex.value.min_sell != null) {
      plexIsk = Number(plex.value.min_sell);
      plexMeta = { source: plex.value.source };
    } else {
      plexIsk = null;
      ok = false;
    }

    // Restore saved prefs once the dropdowns exist.
    const p = loadPrefs();
    if (p.currency && forexRates && forexRates[p.currency] != null) $('#pv-currency').value = p.currency;
    else if (forexRates && $('#pv-currency') && !$('#pv-currency').value) $('#pv-currency').value = 'USD';
    if (p.pack && $('#pv-pack')?.querySelector(`option[value="${p.pack}"]`)) $('#pv-pack').value = p.pack;
    if (p.custom) $('#pv-custom-rate').value = p.custom;

    renderRatesLine();
    if (status && !ok) {
      status.textContent = plexIsk == null
        ? 'Could not fetch the Jita PLEX price (Janice/ESI unreachable). Try Refresh.'
        : 'Could not fetch forex rates. Try Refresh.';
    }
    calc();
  }

  let initialised = false;
  let loaded = false;
  function initTab() {
    if (!initialised) {
      initialised = true;
      populatePackSelect();
      // Restore amount immediately (doesn't need the network).
      const p = loadPrefs();
      if (p.amount) $('#pv-amount').value = p.amount;
      if (p.pack) { /* applied after packs populate */ $('#pv-pack').value = p.pack; }

      $('#pv-amount')?.addEventListener('input', calc);
      $('#pv-currency')?.addEventListener('change', calc);
      $('#pv-pack')?.addEventListener('change', calc);
      $('#pv-custom-rate')?.addEventListener('input', calc);
      $('#pv-calc')?.addEventListener('click', calc);
      $('#pv-refresh')?.addEventListener('click', async () => {
        const btn = $('#pv-refresh');
        if (btn) btn.disabled = true;
        try { await loadRates(true); } finally { if (btn) btn.disabled = false; }
      });
    }
    // Fetch rates on first open only; subsequent opens reuse the cached values
    // (the sidecar also caches: FX 1h, PLEX price 5m). Refresh forces a re-fetch.
    if (!loaded) {
      loaded = true;
      loadRates(false).catch(() => {
        const status = $('#pv-status');
        if (status) status.textContent = 'Rate lookup failed — check your connection and hit Refresh.';
      });
    } else {
      calc();
    }
  }

  document.querySelector('.tab-btn[data-tab="plex-value"]')?.addEventListener('click', initTab);
})();
