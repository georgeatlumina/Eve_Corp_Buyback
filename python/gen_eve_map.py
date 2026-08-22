"""Maintenance script: regenerate the bundled EVE map dataset that powers the
native Maps tab (region layouts + stargate graph + security).

Layout coordinates come from Dotlan's public region SVGs (evemaps.dotlan.net) —
the same familiar per-region layouts hand-tuned by Wollari — parsed into plain
{system: x,y} + jump edges. Security status + authoritative region membership
come from ESI. Live layers (jumps, kills, sovereignty) are fetched at runtime by
server.py, not bundled here.

Run:  python gen_eve_map.py
Out:  data/eve_map.json

Dev/maintenance tool — not imported by server.py. Re-run when CCP adds systems
or Dotlan re-flows a region. Layout data © Wollari & CCP (see the Maps tab
attribution); topology/security © CCP.
"""
import concurrent.futures as cf
import json
import os
import re
import time

import requests

ESI = 'https://esi.evetech.net/latest'
DOTLAN = 'https://evemaps.dotlan.net'
UA = 'EveCorpBuyback/1.0 (maintenance gen_eve_map)'
HDR = {'User-Agent': UA, 'Accept': 'application/json'}
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'eve_map.json')

SESSION = requests.Session()
SESSION.headers.update({'User-Agent': UA})

# Parse helpers over a Dotlan region SVG ---------------------------------------
RE_SYMBOL = re.compile(r'<symbol id="def(\d+)">(.*?)</symbol>', re.S)
RE_HREF = re.compile(r'xlink:href="[^"]*?/(system|map)/([^"/]+)(?:/([^"/]+))?"')
RE_NAME = re.compile(r'<text[^>]*class="ss"[^>]*>([^<]+)</text>')
RE_USE = re.compile(r'<use id="sys(\d+)" x="(-?[\d.]+)" y="(-?[\d.]+)" width="(-?[\d.]+)" height="(-?[\d.]+)"')
RE_LINE = re.compile(r'<line id="j-(\d+)-(\d+)"')


def esi_get(path, params=None, tries=4):
    for a in range(tries):
        try:
            r = SESSION.get(f'{ESI}{path}', params={**(params or {}), 'datasource': 'tranquility'},
                            headers=HDR, timeout=30)
            if r.status_code == 200:
                return r.json()
            if r.status_code in (420, 503):
                time.sleep(2 * (a + 1))
                continue
            r.raise_for_status()
        except Exception:
            if a == tries - 1:
                raise
            time.sleep(1.5 * (a + 1))
    return None


def resolve_names(ids):
    """Batch-resolve ids -> {id: name} via /universe/names (1000 per call)."""
    out = {}
    for i in range(0, len(ids), 1000):
        chunk = ids[i:i + 1000]
        r = SESSION.post(f'{ESI}/universe/names/', params={'datasource': 'tranquility'},
                         headers={**HDR, 'Content-Type': 'application/json'}, json=chunk, timeout=60)
        r.raise_for_status()
        for ent in r.json():
            out[ent['id']] = ent['name']
    return out


def region_slug(name):
    """Dotlan URL slug for a region name (spaces -> underscores)."""
    return name.replace(' ', '_')


def parse_region_svg(text):
    """Return (nodes, edges). `nodes` maps every placed system id -> {name, x, y,
    home, freg}: `home` True when it's a member of this region (symbol links to
    /system/<name>), False for a foreign adjacent shown at the border (links to
    /map/<Region>/<name>, with `freg` = that region's slug). Positions are local
    to this region's Dotlan layout. `edges` = [[a, b]] jump lines."""
    pos = {}
    for m in RE_USE.finditer(text):
        sid, x, y, w, h = m.groups()
        pos[sid] = (round(float(x) + float(w) / 2.0, 1), round(float(y) + float(h) / 2.0, 1))
    nodes = {}
    for m in RE_SYMBOL.finditer(text):
        sid, body = m.group(1), m.group(2)
        if sid not in pos:
            continue
        href = RE_HREF.search(body)
        home = bool(href and href.group(1) == 'system')
        # /system/<Name> → group(2) is the name; /map/<Region>/<Name> → group(3).
        href_name = (href.group(2) if home else (href.group(3) if href else None)) if href else None
        freg = (href.group(2) if href and href.group(1) == 'map' else None)
        nm = RE_NAME.search(body)
        name = (nm.group(1).strip() if nm else (href_name or sid))
        nodes[sid] = {'name': name, 'x': pos[sid][0], 'y': pos[sid][1], 'home': home, 'freg': freg}
    edges = [[a, b] for a, b in RE_LINE.findall(text)]
    return nodes, edges


def main():
    print('· fetching region list from ESI…')
    region_ids = [rid for rid in esi_get('/universe/regions/') if rid < 11000000]  # k-space + Pochven
    names = resolve_names(region_ids)
    print(f'  {len(region_ids)} k-space regions')

    systems = {}        # sid(str) -> {name, region, sec}   (canonical, home region)
    edges = set()       # frozenset{a,b}  (global stargate graph, for routing)
    layouts = {}        # region_name -> {pos:{sid:[x,y]}, home:[sid], foreign:{sid:region}, edges:[[a,b]]}
    regions_out = []    # [{id, name, systems:[sid]}]

    for rid in sorted(region_ids):
        rname = names.get(rid)
        if not rname:
            continue
        url = f'{DOTLAN}/svg/{region_slug(rname)}.svg'
        try:
            r = SESSION.get(url, headers={'User-Agent': UA}, timeout=30)
            if r.status_code != 200 or '<svg' not in r.text:
                print(f'  ! {rname}: no SVG ({r.status_code})', flush=True)
                continue
            nodes, red = parse_region_svg(r.text)
        except Exception as e:  # noqa: BLE001
            print(f'  ! {rname}: {e}', flush=True)
            continue
        home_ids = [sid for sid, n in nodes.items() if n['home']]
        for sid in home_ids:
            systems[sid] = {'name': nodes[sid]['name'], 'region': rname, 'sec': None}
        layouts[rname] = {
            'pos': {sid: [n['x'], n['y']] for sid, n in nodes.items()},
            'home': sorted(home_ids, key=int),
            'foreign': {sid: n['freg'] for sid, n in nodes.items() if not n['home']},
            'names': {sid: n['name'] for sid, n in nodes.items()},
            'edges': red,
        }
        for a, b in red:
            edges.add(frozenset((a, b)))
        regions_out.append({'id': rid, 'name': rname, 'systems': sorted(home_ids, key=int)})
        print(f'  {rname}: {len(home_ids)} systems (+{len(nodes) - len(home_ids)} border)', flush=True)
        time.sleep(0.15)  # be gentle on Dotlan

    print(f'· {len(systems)} systems, {len(edges)} edges. Fetching security from ESI…', flush=True)

    def sec_of(sid):
        d = esi_get(f'/universe/systems/{sid}')
        return sid, (round(float(d['security_status']), 2) if d and 'security_status' in d else None)

    sids = list(systems.keys())
    done = 0
    with cf.ThreadPoolExecutor(max_workers=20) as ex:
        for sid, sec in ex.map(sec_of, sids):
            systems[sid]['sec'] = sec
            done += 1
            if done % 500 == 0:
                print(f'  security {done}/{len(sids)}', flush=True)

    edges_out = sorted([sorted(e, key=int) for e in edges], key=lambda p: (int(p[0]), int(p[1])))
    data = {
        'generated': time.strftime('%Y-%m-%d'),
        'attribution': 'Region layouts © Wollari & CCP (evemaps.dotlan.net); topology & security © CCP',
        'regions': sorted(regions_out, key=lambda r: r['name']),
        'systems': systems,
        'layouts': layouts,
        'edges': edges_out,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
    kb = os.path.getsize(OUT) / 1024
    print(f'wrote {len(systems)} systems, {len(edges_out)} edges, {len(regions_out)} regions '
          f'-> {OUT} ({kb:.0f} KB)')


if __name__ == '__main__':
    main()
