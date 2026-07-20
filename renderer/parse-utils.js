'use strict';

function extractTypeId(src) {
  if (!src) return null;
  const m = /\/types\/(\d+)\//.exec(src);
  return m ? parseInt(m[1], 10) : null;
}

function parseDoctrinesHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const rows = doc.querySelectorAll('#docTable tbody tr');
  const out = [];
  rows.forEach((tr) => {
    const tds = tr.querySelectorAll(':scope > td');
    if (tds.length < 4) return;
    const nameLink = tds[0].querySelector('a[href*="/fittings/doctrine/"]');
    const icon = tds[0].querySelector('img');
    const m = nameLink ? /\/fittings\/doctrine\/(\d+)\//.exec(nameLink.getAttribute('href') || '') : null;
    const id = m ? parseInt(m[1], 10) : null;
    const name = (nameLink ? nameLink.textContent : '').trim().replace(/\s+/g, ' ');
    const iconUrl = icon ? icon.getAttribute('src') : null;
    const catEl = tds[1].querySelector('a[href*="/fittings/cat/"]');
    const category = catEl ? catEl.textContent.trim() : '';
    const description = (tds[2].textContent || '').trim();
    const seen = new Set();
    const ships = [];
    tds[3].querySelectorAll('img[alt]').forEach((img) => {
      const alt = (img.getAttribute('alt') || '').trim();
      if (alt && !seen.has(alt)) { seen.add(alt); ships.push(alt); }
    });
    out.push({ id, name, iconUrl, category, description, ships });
  });
  return out;
}

function parseDoctrineDetail(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const headerCard = doc.querySelector('.col-md-3 .card-body') || doc.querySelector('.card-body');
  const headerImg = headerCard?.querySelector('img');
  const iconUrl = headerImg?.getAttribute('src') || null;
  const name = (headerImg?.getAttribute('alt') || '').trim();
  const catEl = headerCard?.querySelector('a[href*="/fittings/cat/"]');
  const category = catEl ? catEl.textContent.trim() : '';
  const fits = [];
  doc.querySelectorAll('#fitTable tbody tr').forEach((tr) => {
    const tds = tr.querySelectorAll(':scope > td');
    if (tds.length < 4) return;
    const link = tds[0].querySelector('a[href*="/fittings/fit/"]');
    const m = link ? /\/fittings\/fit\/(\d+)\//.exec(link.getAttribute('href') || '') : null;
    const id = m ? parseInt(m[1], 10) : null;
    const icon = tds[0].querySelector('img');
    const lastSpan = link?.querySelectorAll('span') ? link.querySelectorAll('span')[link.querySelectorAll('span').length - 1] : null;
    const fitName = (lastSpan?.textContent || link?.textContent || '').trim().replace(/\s+/g, ' ');
    const fitIconUrl = icon?.getAttribute('src') || null;
    const shipType = (tds[1].textContent || '').trim();
    const fitCatEl = tds[2].querySelector('a[href*="/fittings/cat/"]');
    const fitCategory = fitCatEl ? fitCatEl.textContent.trim() : '';
    const description = (tds[3].textContent || '').trim();
    fits.push({ id, name: fitName, iconUrl: fitIconUrl, shipType, category: fitCategory, description });
  });
  return { name, iconUrl, category, fits };
}

function parseFitDetail(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const nameEl = doc.querySelector('h3');
  const name = (nameEl?.textContent || '').trim().replace(/\s+/g, ' ');

  const hullImg = doc.querySelector('#bigship img');
  const hullName = (hullImg?.getAttribute('alt') || '').trim();
  const hullTypeId = extractTypeId(hullImg?.getAttribute('src'));

  const doctrines = [];
  doc.querySelectorAll('dl dd a[href*="/fittings/doctrine/"]').forEach((a) => {
    const m = /\/fittings\/doctrine\/(\d+)\//.exec(a.getAttribute('href') || '');
    if (m) doctrines.push({ id: parseInt(m[1], 10), name: a.textContent.trim() });
  });

  const slotModules = [];
  doc.querySelectorAll('.fitting-item img').forEach((img) => {
    const moduleName = (img.getAttribute('alt') || '').trim();
    const typeId = extractTypeId(img.getAttribute('src'));
    const slotId = img.closest('.fitting-item')?.id || '';
    slotModules.push({ name: moduleName, typeId, slotId });
  });

  const nameTypeId = {};
  if (hullName && hullTypeId) nameTypeId[hullName] = hullTypeId;
  doc.querySelectorAll('img[alt]').forEach((img) => {
    const src = img.getAttribute('src') || '';
    const alt = (img.getAttribute('alt') || '').trim();
    const tid = extractTypeId(src);
    if (alt && tid && !nameTypeId[alt]) nameTypeId[alt] = tid;
  });

  const buyBtn = doc.querySelector('#buyAllButton');
  let buyText = buyBtn?.getAttribute('data-clipboard-text') || '';

  const eftEl = doc.querySelector('#eft-fitting');
  const eft = (eftEl?.value ?? eftEl?.textContent ?? '').trim();

  // Fallback: if the buy-all button text is empty (JS-populated in browser, missed by
  // static fetch), derive the equivalent buy list from the EFT textarea instead.
  if (!buyText && eft) {
    const eftLines = eft.split(/\r?\n/);
    const hullMatch = /^\[([^\],]+)/.exec(eftLines[0] || '');
    if (hullMatch) {
      const counts = {};
      for (let i = 1; i < eftLines.length; i++) {
        const ln = eftLines[i].trim();
        if (!ln) continue;
        const withQty = /^(.+?)\s+x(\d+)\s*$/.exec(ln);
        if (withQty) {
          const n = withQty[1].trim();
          counts[n] = (counts[n] || 0) + parseInt(withQty[2], 10);
        } else {
          counts[ln] = (counts[ln] || 0) + 1;
        }
      }
      const hull = hullMatch[1].trim();
      buyText = [`${hull} x1`, ...Object.entries(counts).map(([n, q]) => `${n} x${q}`)].join('\n');
    }
  }

  const items = [];
  buyText.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const m = /^(.+?)\s+x(\d+)\s*$/.exec(trimmed);
    if (!m) return;
    items.push({ name: m[1].trim(), qty: parseInt(m[2], 10), typeId: nameTypeId[m[1].trim()] || null });
  });

  return { name, hullName, hullTypeId, doctrines, slotModules, items, eft };
}

// --- SRP (Ship Replacement) scrapers ---
// Both target Alliance Auth's server-rendered SRP templates (no JS run): the
// management list (/srp/) and a fleet's request list (/srp/<id>/view/).

function parseSrpFleets(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const table = doc.querySelector('table.table') || doc.querySelector('table');
  const out = [];
  if (!table) return out;
  table.querySelectorAll('tr').forEach((tr) => {
    const tds = tr.querySelectorAll(':scope > td');
    if (tds.length < 10) return; // skip the header row (uses <th>)
    const codeA = tds[5].querySelector('a');
    const viewA = tds[9].querySelector('a[href*="/view/"]');
    const viewHref = viewA ? (viewA.getAttribute('href') || '') : '';
    const m = /\/srp\/(\d+)\/view\//.exec(viewHref);
    out.push({
      id: m ? parseInt(m[1], 10) : null,
      name: (tds[0].textContent || '').trim().replace(/\s+/g, ' '),
      time: (tds[1].textContent || '').trim(),
      doctrine: (tds[2].textContent || '').trim().replace(/\s+/g, ' '),
      fc: (tds[3].textContent || '').trim().replace(/\s+/g, ' '),
      code: codeA ? codeA.textContent.trim() : '',
      iskCost: (tds[6].textContent || '').trim(),
      status: (tds[7].textContent || '').trim().replace(/\s+/g, ' '),
      pending: parseInt((tds[8].textContent || '').replace(/[^\d]/g, ''), 10) || 0,
      viewHref,
    });
  });
  return out;
}

function parseSrpRequests(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const table = doc.querySelector('table.srplist') || doc.querySelector('table');
  const out = [];
  if (!table) return out;
  table.querySelectorAll('tr').forEach((tr) => {
    const tds = tr.querySelectorAll(':scope > td');
    if (tds.length < 8) return; // skip header rows
    const copyEl = tds[0].querySelector('[data-clipboard-text]');
    const pilot = copyEl
      ? (copyEl.getAttribute('data-clipboard-text') || '').trim()
      : (tds[0].textContent || '').trim().replace(/\s+/g, ' ');
    const zkillA = tds[1].querySelector('a[href*="zkillboard.com/kill/"]');
    const zkillUrl = zkillA ? (zkillA.getAttribute('href') || '') : '';
    const km = /\/kill\/(\d+)\//.exec(zkillUrl);
    const srpTd = tds[5];
    // Alliance Auth moved the request pk + update-url onto the editable payout
    // element inside this cell; older markup had them as <td> attributes. Try
    // the inner element first, fall back to the <td>.
    const payoutEl = srpTd.querySelector('[data-pk]') || srpTd.querySelector('.srp-payout-amount');
    const pk = (payoutEl && payoutEl.getAttribute('data-pk')) || srpTd.getAttribute('data-pk') || null;
    const lossSort = tds[4].getAttribute('data-sort');
    const lossAmt = (lossSort != null && lossSort !== '')
      ? Number(lossSort)
      : Number((tds[4].textContent || '').replace(/[^\d]/g, '')) || 0;
    out.push({
      pk,
      pilot,
      pilotFull: (tds[0].textContent || '').trim().replace(/\s+/g, ' '),
      zkillUrl,
      killId: km ? km[1] : '',
      info: (tds[2].textContent || '').trim().replace(/\s+/g, ' '),
      ship: (tds[3].textContent || '').trim(),
      lossAmt,
      srpCost: (srpTd.textContent || '').trim(),
      srpCostNum: Number((srpTd.textContent || '').replace(/[^\d]/g, '')) || 0,
      updateUrl: (payoutEl && payoutEl.getAttribute('data-url')) || srpTd.getAttribute('data-url') || (pk ? `/srp/request/${pk}/update/` : ''),
      postTime: (tds[6].textContent || '').trim(),
      status: (tds[7].textContent || '').trim().replace(/\s+/g, ' '),
    });
  });
  return out;
}

// ISK price formatters — 'en-US' locale for deterministic output across systems.
// Alliance Auth group membership. Scrapes the stock groupmanagement `/groups/`
// page: it lists every open group as a table row, and the logged-in user is a
// MEMBER of a group when that row offers a "leave" control (a request_leave URL
// or a "Leave" button). A second pass reads a dashboard-style "Group
// Memberships" panel (list of joined groups). Returns the array of joined group
// names. Selectors target stock AA markup and may need tuning against a
// customized install.
function parseUserGroups(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const groups = new Set();

  // Pass 1 — /groups/ table rows carrying a leave control => the user is in it.
  doc.querySelectorAll('table tr').forEach((tr) => {
    const cells = tr.querySelectorAll('td');
    if (!cells.length) return;
    const name = (cells[0].textContent || '').trim();
    if (!name) return;
    let member = !!tr.querySelector(
      'a[href*="request_leave"], form[action*="request_leave"], a[href*="/leave/"], form[action*="/leave/"]'
    );
    if (!member) {
      tr.querySelectorAll('button, a, input[type=submit]').forEach((b) => {
        const t = (b.textContent || b.value || '').trim().toLowerCase();
        if (t === 'leave' || t === 'leave group') member = true;
      });
    }
    if (member) groups.add(name);
  });

  // Pass 2 — a "Group Memberships" panel/card lists only the user's groups.
  doc.querySelectorAll('.panel, .card').forEach((panel) => {
    const head = panel.querySelector('.panel-heading, .panel-title, .card-header, h3, h4');
    if (!head || !/group/i.test(head.textContent || '')) return;
    panel.querySelectorAll('li, .label, .badge').forEach((el) => {
      const t = (el.textContent || '').trim();
      if (t && t.length < 80 && !/membership/i.test(t)) groups.add(t);
    });
  });

  return Array.from(groups);
}

// True when the user belongs to a group whose name matches `wanted`
// (case-insensitive, substring — so "Industry" matches "Industry Pilots").
function hasGroupMembership(groups, wanted) {
  const w = (wanted || '').trim().toLowerCase();
  if (!w) return false;
  return (groups || []).some((g) => (g || '').toLowerCase().includes(w));
}

function fmtIsk(n) {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function fmtMillions(n) {
  return Math.round(n / 1_000_000).toLocaleString('en-US') + 'M';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { extractTypeId, parseDoctrinesHtml, parseDoctrineDetail, parseFitDetail, parseSrpFleets, parseSrpRequests, parseUserGroups, hasGroupMembership, fmtIsk, fmtMillions };
}
