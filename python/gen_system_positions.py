"""Maintenance script: add real 3-D positions to the bundled EVE map dataset.

The jump-range overlay needs light-year distances between systems, which the
Dotlan-derived layout coordinates can't give — those are hand-flowed 2-D region
diagrams, not positions in space. ESI's /universe/systems/{id} already carries
`position` in metres; gen_eve_map.py fetches that endpoint for security status
and throws the rest away, so this fills in what was discarded.

Deliberately separate from gen_eve_map.py: re-running that re-crawls every
Dotlan region SVG and would re-flow layouts we're happy with. This only ever
adds a `pos` key, so it's safe to run against a dataset in use.

Positions are stored in light years, rounded to 3 dp (~0.001 ly, against jump
ranges of 5-10 ly), which keeps the file a couple of hundred KB rather than a
couple of MB.

Run:  python gen_system_positions.py
Out:  data/eve_map.json  (updated in place)
"""
import concurrent.futures as cf
import json
import os
import sys
import time

import requests

ESI = 'https://esi.evetech.net/latest'
UA = 'EveCorpBuyback/1.0 (maintenance gen_system_positions)'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'eve_map.json')
METRES_PER_LY = 9.4607304725808e15

SESSION = requests.Session()
SESSION.headers.update({'User-Agent': UA, 'Accept': 'application/json'})


def fetch_position(sid):
    """(sid, [x, y, z] in light years) — None on any failure, retried a little
    since one flaky system shouldn't cost the whole crawl."""
    for attempt in range(4):
        try:
            r = SESSION.get(f'{ESI}/universe/systems/{sid}',
                            params={'datasource': 'tranquility'}, timeout=20)
            if r.status_code == 200:
                p = (r.json() or {}).get('position') or {}
                if all(k in p for k in 'xyz'):
                    return sid, [round(float(p[k]) / METRES_PER_LY, 3) for k in 'xyz']
                return sid, None
            if r.status_code in (420, 429, 502, 503, 504):
                time.sleep(2 * (attempt + 1))
                continue
            return sid, None
        except requests.RequestException:
            time.sleep(1 + attempt)
    return sid, None


def main():
    with open(OUT, encoding='utf-8') as f:
        data = json.load(f)
    systems = data['systems']
    todo = [sid for sid, rec in systems.items() if 'pos' not in rec]
    print(f'{len(systems)} systems, {len(todo)} missing a position')
    if not todo:
        print('nothing to do')
        return 0

    done = failed = 0
    started = time.time()
    with cf.ThreadPoolExecutor(max_workers=16) as ex:
        for sid, pos in ex.map(fetch_position, todo):
            done += 1
            if pos is None:
                failed += 1
            else:
                systems[sid]['pos'] = pos
            if done % 250 == 0:
                rate = done / max(0.001, time.time() - started)
                print(f'  {done}/{len(todo)}  ({rate:.0f}/s, {failed} failed)', flush=True)

    have = sum(1 for rec in systems.values() if 'pos' in rec)
    print(f'positions: {have}/{len(systems)} ({failed} failed this run)')
    if have == 0:
        print('refusing to write — nothing was resolved')
        return 1
    # Write via a temp file so an interrupted run can't destroy the dataset.
    tmp = OUT + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, separators=(',', ':'))
    os.replace(tmp, OUT)
    print(f'wrote {OUT} ({os.path.getsize(OUT) / 1024 / 1024:.1f} MB)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
