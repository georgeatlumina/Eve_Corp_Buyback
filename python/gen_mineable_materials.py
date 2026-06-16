"""Maintenance script: regenerate the bundled reprocessing-yields CSV.

Moon-contract refining needs `type_id -> [(material_type_id, quantity), ...]`
for every reprocessable asteroid type (ore / moon ore / ice, incl. compressed).
Fuzzwork removed its per-table CSV dumps, so we build a small static subset
once from EVE Ref's reference-data API and commit it to data/ — it only changes
on EVE expansions.

Run:  python gen_mineable_materials.py
Out:  data/mineable_type_materials.csv  (typeID,materialTypeID,quantity)

This is a dev/maintenance tool — not imported by server.py.
"""
import csv
import os
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

REF = 'https://ref-data.everef.net'
ASTEROID_CATEGORY_ID = 25
UA = 'EveCorpBuyback/1.0 (maintenance gen_mineable_materials)'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'mineable_type_materials.csv')


def _get(path):
    r = requests.get(f'{REF}{path}', headers={'User-Agent': UA, 'Accept': 'application/json'}, timeout=30)
    r.raise_for_status()
    return r.json()


# EVE Ref's invTypeMaterials over-counts 8 regular-ore families vs the live
# cerlestes ore table (verified moon ore + ice match exactly; only these 8 are
# wrong — extra minerals the current game no longer yields). Correct them across
# every family type_id (base + quality variants + compressed + batch) using
# `ore_variations`. 7 families just drop the over-counted mineral (the rest
# already scale correctly per variant); Scordite's Pyerite = 0.8 × Tritanium.
_DROP = {
    1229: [35], 19: [34, 37], 1225: [36], 52316: [34],
    52315: [34], 52306: [34], 82163: [34],
}
_SCORDITE_BASE = 1228


def _family_ids(base):
    t = _get(f'/types/{base}')
    ids = {base}
    for v in (t.get('ore_variations') or {}).values():
        ids.update(int(x) for x in v)
    return ids


def _apply_cerlestes_corrections(rows):
    by_type = {}
    for tid, mid, qty in rows:
        by_type.setdefault(tid, {})[mid] = qty
    for base, drop in _DROP.items():
        for tid in _family_ids(base):
            row = by_type.get(tid)
            if row:
                for mid in drop:
                    row.pop(mid, None)
    for tid in _family_ids(_SCORDITE_BASE):
        row = by_type.get(tid)
        if row and 34 in row and 35 in row:
            row[35] = round(row[34] * 0.8)
    return [(tid, mid, qty) for tid in by_type for mid, qty in by_type[tid].items()]


def main():
    cat = _get(f'/categories/{ASTEROID_CATEGORY_ID}')
    group_ids = cat.get('group_ids') or []
    print(f'category {ASTEROID_CATEGORY_ID}: {len(group_ids)} groups')

    type_ids = []
    for gid in group_ids:
        try:
            g = _get(f'/groups/{gid}')
        except Exception as e:
            print(f'  group {gid} failed: {e}')
            continue
        type_ids.extend(g.get('type_ids') or [])
    type_ids = sorted(set(type_ids))
    print(f'{len(type_ids)} asteroid types to inspect')

    rows = []  # (type_id, material_type_id, quantity)
    types_with_materials = 0

    def fetch(tid):
        return tid, _get(f'/types/{tid}')

    with ThreadPoolExecutor(max_workers=16) as ex:
        futs = [ex.submit(fetch, tid) for tid in type_ids]
        done = 0
        for fut in as_completed(futs):
            done += 1
            try:
                tid, t = fut.result()
            except Exception:
                continue
            mats = t.get('type_materials') or {}
            if mats:
                types_with_materials += 1
                for m in mats.values():
                    rows.append((tid, int(m['material_type_id']), int(m['quantity'])))
            if done % 50 == 0:
                print(f'  {done}/{len(type_ids)}')

    rows = _apply_cerlestes_corrections(rows)
    rows.sort()
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['typeID', 'materialTypeID', 'quantity'])
        w.writerows(rows)
    print(f'wrote {len(rows)} material rows for {types_with_materials} types -> {OUT}')


if __name__ == '__main__':
    main()
