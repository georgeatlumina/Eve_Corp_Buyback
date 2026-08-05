"""Maintenance script: regenerate the bundled solar-system name list used by the
PI Planner's system-search autocomplete.

Pulls every solar-system id from ESI, then batch-resolves them to names via
/universe/names/ (1000 per call). Committed so the app ships an offline
searchable list (changes only when CCP adds systems).

Run:  python gen_eve_systems.py
Out:  data/eve_systems.json   (sorted unique system names)

Dev/maintenance tool — not imported by server.py.
"""
import json
import os

import requests

ESI = 'https://esi.evetech.net/latest'
UA = 'EveCorpBuyback/1.0 (maintenance gen_eve_systems)'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'eve_systems.json')


def main():
    ids = requests.get(f'{ESI}/universe/systems/',
                       params={'datasource': 'tranquility'},
                       headers={'User-Agent': UA, 'Accept': 'application/json'},
                       timeout=60).json()
    print(f'{len(ids)} solar-system ids')
    names = []
    for i in range(0, len(ids), 1000):
        chunk = ids[i:i + 1000]
        r = requests.post(f'{ESI}/universe/names/',
                          params={'datasource': 'tranquility'},
                          headers={'User-Agent': UA, 'Accept': 'application/json',
                                   'Content-Type': 'application/json'},
                          json=chunk, timeout=60)
        r.raise_for_status()
        for ent in r.json():
            if ent.get('category') == 'solar_system':
                names.append(ent['name'])
        print(f'  resolved {min(i + 1000, len(ids))}/{len(ids)}')
    names = sorted(set(names))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(names, f, ensure_ascii=False)
    print(f'wrote {len(names)} system names -> {OUT}')


if __name__ == '__main__':
    main()
