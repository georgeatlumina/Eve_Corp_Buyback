// Dotlan Maps tab — an in-app wrapper around evemaps.dotlan.net.
//
// Rather than reimplement Dotlan's huge feature set (region/system maps, jump &
// route planners, sovereignty, industry indices, alliance/faction-war data), we
// embed the live site in a <webview>. It gets its own persistent session
// partition (persist:dotlan) so a user's Dotlan login — Favorites, jump beacons —
// survives between visits. Dotlan sends no X-Frame-Options and no CSP
// frame-ancestors, so embedding is permitted; the site loads its own pages + ads
// straight from evemaps.dotlan.net.
(function () {
  const ORIGIN = 'https://evemaps.dotlan.net';
  const HOME = ORIGIN + '/';

  const view = document.getElementById('dotlan-view');
  if (!view) return;

  const back = document.getElementById('dotlan-back');
  const fwd = document.getElementById('dotlan-fwd');
  const reload = document.getElementById('dotlan-reload');
  const home = document.getElementById('dotlan-home');
  const urlLabel = document.getElementById('dotlan-url');
  const external = document.getElementById('dotlan-external');
  const searchForm = document.getElementById('dotlan-search-form');
  const searchInput = document.getElementById('dotlan-search');

  let loaded = false; // the site is loaded lazily, only once the tab is opened
  let currentUrl = HOME;

  function navigate(url) {
    try { view.src = url; } catch (_) { /* webview not ready */ }
  }

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    navigate(HOME);
  }

  function isDotlan(u) {
    try { return new URL(u).hostname.endsWith('dotlan.net'); } catch (_) { return false; }
  }

  // --- Nav chrome ---
  back?.addEventListener('click', () => { try { if (view.canGoBack()) view.goBack(); } catch (_) {} });
  fwd?.addEventListener('click', () => { try { if (view.canGoForward()) view.goForward(); } catch (_) {} });
  reload?.addEventListener('click', () => { try { view.reload(); } catch (_) {} });
  home?.addEventListener('click', () => navigate(HOME));
  external?.addEventListener('click', () => {
    if (currentUrl && window.api && window.api.openExternal) window.api.openExternal(currentUrl);
  });

  // --- Quick-links to Dotlan's main tools ---
  document.querySelectorAll('.dotlan-link[data-path]').forEach((b) => {
    b.addEventListener('click', () => navigate(ORIGIN + b.dataset.path));
  });

  // --- Quick search → Dotlan's universal search results page ---
  searchForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = (searchInput && searchInput.value || '').trim();
    if (!q) return;
    navigate(ORIGIN + '/search/?query=' + encodeURIComponent(q));
  });

  // --- Keep the URL label + back/forward enablement in sync ---
  function syncState(url) {
    if (url) {
      currentUrl = url;
      if (urlLabel) { urlLabel.textContent = url; urlLabel.title = url; }
    }
    try { if (back) back.disabled = !view.canGoBack(); } catch (_) {}
    try { if (fwd) fwd.disabled = !view.canGoForward(); } catch (_) {}
  }
  view.addEventListener('did-navigate', (e) => syncState(e.url));
  view.addEventListener('did-navigate-in-page', (e) => syncState(e.url));

  // --- Popups / target=_blank: keep Dotlan links in-view (preserves the logged-in
  // session); send anything off-site out to the OS browser. ---
  view.addEventListener('new-window', (e) => {
    if (e.preventDefault) e.preventDefault();
    if (isDotlan(e.url)) navigate(e.url);
    else if (window.api && window.api.openExternal) window.api.openExternal(e.url);
  });

  // --- Lazy-load on first open; give the map full window width while active. ---
  document.querySelectorAll('.tab-btn[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const isDot = btn.dataset.tab === 'dotlan';
      document.body.classList.toggle('dotlan-active', isDot);
      if (isDot) ensureLoaded();
    });
  });
})();
