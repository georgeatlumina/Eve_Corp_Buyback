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
  const buyText = buyBtn?.getAttribute('data-clipboard-text') || '';
  const items = [];
  buyText.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const m = /^(.+?)\s+x(\d+)\s*$/.exec(trimmed);
    if (!m) return;
    items.push({ name: m[1].trim(), qty: parseInt(m[2], 10), typeId: nameTypeId[m[1].trim()] || null });
  });

  const eftEl = doc.querySelector('#eft-fitting');
  const eft = (eftEl?.value ?? eftEl?.textContent ?? '').trim();

  return { name, hullName, hullTypeId, doctrines, slotModules, items, eft };
}

// ISK price formatters — 'en-US' locale for deterministic output across systems.
function fmtIsk(n) {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function fmtMillions(n) {
  return Math.round(n / 1_000_000).toLocaleString('en-US') + 'M';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { extractTypeId, parseDoctrinesHtml, parseDoctrineDetail, parseFitDetail, fmtIsk, fmtMillions };
}
