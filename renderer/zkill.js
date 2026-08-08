// zKillboard tab — an in-app wrapper around zkillboard.com.
//
// Same approach as the Dotlan tab: embed the live site in a <webview> rather
// than reimplement its killboard. It gets its own persistent session partition
// (persist:zkill) so a user's zKill login survives between visits.
//
// Note: zKillboard sends `X-Frame-Options: DENY` and CSP `frame-ancestors 'self'`,
// which block <iframe> embedding — but an Electron <webview> hosts the page as its
// own *top-level* browsing context (a separate tab/process), not a cross-origin
// subframe, so those headers don't apply. Verified loading in-app.
(function () {
  const ORIGIN = 'https://zkillboard.com';
  const HOME = ORIGIN + '/';

  const view = document.getElementById('zkill-view');
  if (!view) return;

  const back = document.getElementById('zkill-back');
  const fwd = document.getElementById('zkill-fwd');
  const reload = document.getElementById('zkill-reload');
  const home = document.getElementById('zkill-home');
  const urlLabel = document.getElementById('zkill-url');
  const external = document.getElementById('zkill-external');
  const searchForm = document.getElementById('zkill-search-form');
  const searchInput = document.getElementById('zkill-search');

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

  function isZkill(u) {
    try { return new URL(u).hostname.endsWith('zkillboard.com'); } catch (_) { return false; }
  }

  // --- Nav chrome ---
  back?.addEventListener('click', () => { try { if (view.canGoBack()) view.goBack(); } catch (_) {} });
  fwd?.addEventListener('click', () => { try { if (view.canGoForward()) view.goForward(); } catch (_) {} });
  reload?.addEventListener('click', () => { try { view.reload(); } catch (_) {} });
  home?.addEventListener('click', () => navigate(HOME));
  external?.addEventListener('click', () => {
    if (currentUrl && window.api && window.api.openExternal) window.api.openExternal(currentUrl);
  });

  // --- Quick-links to zKillboard's main pages ---
  document.querySelectorAll('#tab-zkill .webtab-link[data-path]').forEach((b) => {
    b.addEventListener('click', () => navigate(ORIGIN + b.dataset.path));
  });

  // --- Quick search → zKill's search results page (trailing slash is required). ---
  searchForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = (searchInput && searchInput.value || '').trim();
    if (!q) return;
    navigate(ORIGIN + '/search/' + encodeURIComponent(q) + '/');
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

  // --- Popups / target=_blank: keep zKill links in-view (preserves the logged-in
  // session); send anything off-site out to the OS browser. ---
  view.addEventListener('new-window', (e) => {
    if (e.preventDefault) e.preventDefault();
    if (isZkill(e.url)) navigate(e.url);
    else if (window.api && window.api.openExternal) window.api.openExternal(e.url);
  });

  // --- Lazy-load the site on first open of the tab. (Full-window width while a
  // webtab is active is handled generically in app.js activateTab.) ---
  document.querySelectorAll('.tab-btn[data-tab="zkill"]').forEach((btn) => {
    btn.addEventListener('click', ensureLoaded);
  });
})();
