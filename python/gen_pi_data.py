"""Maintenance script: regenerate the bundled Planetary Interaction (PI) dataset.

The PI profitability analyzer needs the full production tree (P0 raw -> P1 -> P2
-> P3 -> P4) plus per-type metadata (name, tier, volume). All of it comes from
EVE Ref's reference-data API and is committed to data/ so the sidecar never
hits the network for static PI facts (they only change on EVE expansions).

The planet-type -> P0 mapping is NOT cleanly exposed by the API (it lives in the
SDE/dogma), so it is sourced separately and merged in under the `planet_p0` key
by `gen_pi_planets` (see that step); this script fills schematics + types +
tiers and preserves any existing `planet_p0` block on rewrite.

Run:  python gen_pi_data.py
Out:  data/pi_data.json

This is a dev/maintenance tool — not imported by server.py.
"""
import json
import os
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

REF = 'https://ref-data.everef.net'
UA = 'EveCorpBuyback/1.0 (maintenance gen_pi_data)'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'pi_data.json')


def _get(path):
    r = requests.get(f'{REF}{path}', headers={'User-Agent': UA, 'Accept': 'application/json'}, timeout=30)
    r.raise_for_status()
    return r.json()


def _en(name_field):
    """EVE Ref returns names as a {lang: str} dict; take English."""
    if isinstance(name_field, dict):
        return name_field.get('en') or next(iter(name_field.values()), '')
    return str(name_field or '')


def _derive_tiers(schematics, all_type_ids):
    """Assign a PI tier (0=P0 raw ... 4=P4 advanced) to every involved type.

    P0 = a type that is consumed as an input but is never the product of any
    schematic (i.e. it can only be harvested). Every other type's tier is
    max(input tiers) + 1. Depth is <= 4, so a handful of relaxation passes
    converge.
    """
    product_ids = set()
    input_ids = set()
    for s in schematics.values():
        product_ids.update(int(t) for t in s['products'])
        input_ids.update(int(t) for t in s['materials'])

    tier = {}
    for tid in input_ids - product_ids:
        tier[tid] = 0  # raw P0

    # Map product_id -> the schematic that makes it (PI products are 1:1).
    made_by = {}
    for s in schematics.values():
        for tid in s['products']:
            made_by[int(tid)] = s

    changed = True
    passes = 0
    while changed and passes < 10:
        changed = False
        passes += 1
        for pid, s in made_by.items():
            in_tiers = [tier.get(int(t)) for t in s['materials']]
            if any(v is None for v in in_tiers):
                continue
            new = max(in_tiers) + 1
            if tier.get(pid) != new:
                tier[pid] = new
                changed = True
    return tier


def main():
    print('fetching schematic index…')
    sch_ids = _get('/schematics')
    print(f'{len(sch_ids)} schematics')

    schematics = {}

    def fetch_sch(sid):
        return sid, _get(f'/schematics/{sid}')

    with ThreadPoolExecutor(max_workers=16) as ex:
        for fut in as_completed([ex.submit(fetch_sch, s) for s in sch_ids]):
            try:
                sid, s = fut.result()
            except Exception as e:
                print(f'  schematic fetch failed: {e}')
                continue
            schematics[sid] = s

    # Every type_id that appears anywhere in the tree.
    type_ids = set()
    for s in schematics.values():
        type_ids.update(int(t) for t in s['materials'])
        type_ids.update(int(t) for t in s['products'])
    print(f'{len(type_ids)} distinct types in the tree')

    types_raw = {}

    def fetch_type(tid):
        return tid, _get(f'/types/{tid}')

    with ThreadPoolExecutor(max_workers=16) as ex:
        for fut in as_completed([ex.submit(fetch_type, t) for t in type_ids]):
            try:
                tid, t = fut.result()
            except Exception as e:
                print(f'  type fetch failed: {e}')
                continue
            types_raw[tid] = t

    tier = _derive_tiers(schematics, type_ids)

    types_out = {}
    for tid, t in types_raw.items():
        types_out[str(tid)] = {
            'name': _en(t.get('name')),
            'group_id': t.get('group_id'),
            'tier': tier.get(tid),
            'volume': t.get('volume') or t.get('packaged_volume') or 0,
        }

    schematics_out = []
    for sid in sorted(schematics):
        s = schematics[sid]
        schematics_out.append({
            'schematic_id': sid,
            'name': _en(s.get('name')),
            'cycle_time': s.get('cycle_time'),
            'inputs': sorted([[int(t), int(m['quantity'])] for t, m in s['materials'].items()]),
            'outputs': sorted([[int(t), int(m['quantity'])] for t, m in s['products'].items()]),
        })

    # Preserve a hand/wiki-sourced planet_p0 block if a previous run wrote one.
    planet_p0 = {}
    if os.path.exists(OUT):
        try:
            with open(OUT, encoding='utf-8') as f:
                planet_p0 = (json.load(f) or {}).get('planet_p0', {}) or {}
        except (json.JSONDecodeError, OSError):
            pass

    out = {
        '_meta': {'source': REF, 'schematic_count': len(schematics_out),
                  'type_count': len(types_out)},
        'planet_p0': planet_p0,
        'types': types_out,
        'schematics': schematics_out,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, indent=1, ensure_ascii=False)

    by_tier = {}
    for v in types_out.values():
        by_tier[v['tier']] = by_tier.get(v['tier'], 0) + 1
    print(f'wrote {len(schematics_out)} schematics, {len(types_out)} types -> {OUT}')
    print(f'  types per tier: {dict(sorted(by_tier.items(), key=lambda x: (x[0] is None, x[0])))}')
    if not planet_p0:
        print('  NOTE: planet_p0 is empty — run the planet-mapping step to fill it.')


if __name__ == '__main__':
    main()
