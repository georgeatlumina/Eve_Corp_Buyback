"""Maintenance script: regenerate the bundled PI *pin* dataset (colony hardware).

Phase-2 (layout builder) needs the colony building blocks — command centers,
extractor control units, industry facilities, storage, launchpads — with their
CPU/powergrid budgets and loads, capacities, taxes, and extractor mechanics.
All of it is dogma data on the pin types, pulled from EVE Ref and committed to
data/pi_pins.json (changes only on EVE expansions).

Run:  python gen_pi_pins.py
Out:  data/pi_pins.json

Companion to gen_pi_data.py (the P0->P4 commodity tree). Not imported by
server.py.
"""
import json
import os
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

REF = 'https://ref-data.everef.net'
UA = 'EveCorpBuyback/1.0 (maintenance gen_pi_pins)'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'pi_pins.json')

# PI pin groups. 1063 (Extractor Control Units) is the *current* extractor —
# a generic ECU per planet whose resource is chosen via routing. (Group 1026,
# "Extractors", is the retired pre-Rubicon per-resource extractor family and is
# not used by the modern client / templates.)
GROUPS = {
    1063: 'extractor',
    1027: 'command_center',
    1028: 'factory',
    1029: 'storage',
    1030: 'launchpad',
}

# Dogma attribute ids we care about (verified via probe).
A_POWER_OUT = 11    # command-center powergrid provision (level 0 base)
A_POWER_LOAD = 15   # pin powergrid usage
A_CAPACITY = 38     # storage/launchpad m3
A_CPU_OUT = 48      # command-center cpu provision (level 0 base)
A_CPU_LOAD = 49     # pin cpu usage
A_HARVESTER = 709   # ECU -> P0 type it extracts
A_PLANET = 1632     # planetRestriction -> planet type id
A_IMPORT_TAX = 1638
A_EXPORT_TAX = 1639
A_EXTRACT_QTY = 1642
A_EXTRACT_CYCLE = 1643
A_DEPLETION_RANGE = 1644
A_DEPLETION_RATE = 1645
A_HEAD_CPU = 1690   # ecuExtractorHeadCPU — CPU per extractor head
A_HEAD_POWER = 1691  # ecuExtractorHeadPower — powergrid per extractor head

PLANET_TYPE_BY_ID = {
    11: 'Temperate', 12: 'Ice', 13: 'Gas', 2014: 'Oceanic',
    2015: 'Lava', 2016: 'Barren', 2017: 'Storm', 2063: 'Plasma',
}

# Command Center CPU/Powergrid provided at each colony upgrade level. Level 0
# (6000 PG / 1675 CPU) is verified against the command-center type dogma; the
# rest is the fixed in-game upgrade table (EVE University: "Command center").
# Kept here (not on the type) because the per-level deltas aren't in the SDE
# type dogma — they're a colony-upgrade mechanic.
COMMAND_CENTER_LEVELS = [
    {'level': 0, 'powergrid': 6000,  'cpu': 1675},
    {'level': 1, 'powergrid': 9000,  'cpu': 7057},
    {'level': 2, 'powergrid': 12000, 'cpu': 12439},
    {'level': 3, 'powergrid': 15000, 'cpu': 17822},
    {'level': 4, 'powergrid': 17900, 'cpu': 23204},
    {'level': 5, 'powergrid': 19900, 'cpu': 28586},
]


def _get(path):
    r = requests.get(f'{REF}{path}', headers={'User-Agent': UA, 'Accept': 'application/json'}, timeout=30)
    r.raise_for_status()
    return r.json()


def _en(name_field):
    if isinstance(name_field, dict):
        return name_field.get('en') or next(iter(name_field.values()), '')
    return str(name_field or '')


def _av(dogma, aid):
    a = (dogma or {}).get(str(aid))
    return a.get('value') if a else None


def _factory_tier(name):
    n = name.lower()
    if 'basic' in n:
        return 'basic'       # P0 -> P1
    if 'advanced' in n:
        return 'advanced'    # P1 -> P2, P2 -> P3
    if 'high-tech' in n or 'high tech' in n:
        return 'hitech'      # P3 -> P4
    return 'factory'


def main():
    type_ids = []
    for gid in GROUPS:
        ids = _get(f'/groups/{gid}').get('type_ids') or []
        type_ids += [(tid, gid) for tid in ids]
    print(f'{len(type_ids)} pin types across {len(GROUPS)} groups')

    def fetch(item):
        tid, gid = item
        return tid, gid, _get(f'/types/{tid}')

    pins = {}
    command_centers = {}
    with ThreadPoolExecutor(max_workers=16) as ex:
        for fut in as_completed([ex.submit(fetch, it) for it in type_ids]):
            try:
                tid, gid, t = fut.result()
            except Exception as e:
                print(f'  fetch failed: {e}')
                continue
            dogma = t.get('dogma_attributes') or {}
            name = _en(t.get('name'))
            kind = GROUPS[gid]
            planet = PLANET_TYPE_BY_ID.get(_av(dogma, A_PLANET))
            rec = {
                'name': name,
                'kind': kind,
                'group_id': gid,
                'planet_type': planet,
                'power_load': _av(dogma, A_POWER_LOAD),
                'cpu_load': _av(dogma, A_CPU_LOAD),
                'capacity': _av(dogma, A_CAPACITY),
            }
            if kind == 'factory':
                rec['tier'] = _factory_tier(name)
            if kind == 'extractor':
                # Modern ECU (group 1063) is generic — no fixed harvester type;
                # the resource is picked via routing. Heads add CPU/power on top
                # of the ECU base load.
                rec['extract_qty'] = _av(dogma, A_EXTRACT_QTY)
                rec['extract_cycle'] = _av(dogma, A_EXTRACT_CYCLE)
                rec['depletion_range'] = _av(dogma, A_DEPLETION_RANGE)
                rec['depletion_rate'] = _av(dogma, A_DEPLETION_RATE)
                rec['head_cpu'] = _av(dogma, A_HEAD_CPU)
                rec['head_power'] = _av(dogma, A_HEAD_POWER)
            if kind == 'launchpad':
                rec['import_tax'] = _av(dogma, A_IMPORT_TAX)
                rec['export_tax'] = _av(dogma, A_EXPORT_TAX)
            if kind == 'command_center':
                rec['power_output_base'] = _av(dogma, A_POWER_OUT)
                rec['cpu_output_base'] = _av(dogma, A_CPU_OUT)
                rec['export_tax'] = _av(dogma, A_EXPORT_TAX)
                # Prefer the canonical "<Planet> Command Center" over old
                # "Limited"/"Test" variants that share group 1027.
                if planet and name == f'{planet} Command Center':
                    command_centers[planet] = tid
                elif planet:
                    command_centers.setdefault(planet, tid)
            pins[str(tid)] = rec

    out = {
        '_meta': {'source': REF, 'pin_count': len(pins)},
        'command_center_levels': COMMAND_CENTER_LEVELS,
        'command_centers': command_centers,   # planet_type -> command center type_id
        'pins': pins,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, indent=1, ensure_ascii=False)

    by_kind = {}
    for r in pins.values():
        by_kind[r['kind']] = by_kind.get(r['kind'], 0) + 1
    print(f'wrote {len(pins)} pins -> {OUT}')
    print(f'  by kind: {by_kind}')
    facs = {}
    for r in pins.values():
        if r['kind'] == 'factory':
            facs[r.get('tier')] = facs.get(r.get('tier'), 0) + 1
    print(f'  factory tiers: {facs}')


if __name__ == '__main__':
    main()
