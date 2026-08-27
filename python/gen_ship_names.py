"""Maintenance script: regenerate the bundled ship-name list used to highlight
ship names inside intel reports (SMT tab + overlay ticker).

Names come from the bundled data/eve.db (invtypes joined to invgroups, category
6 = Ship), so the sidecar never touches the network — and doesn't have to open
the 100 MB DB at runtime just to know what a Loki is.

Ships whose name is a common English word are dropped: intel chat is full of
ordinary prose, and a whole-word match on "Sin" or "Ark" would light up half the
feed. The long tail of real ship names is what matters here.

Run:  python gen_ship_names.py
Out:  data/ship_names.json
"""
import json
import os
import sqlite3

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
EVE_DB = os.path.join(DATA_DIR, 'eve.db')
OUT = os.path.join(DATA_DIR, 'ship_names.json')

# Ship names that are also ordinary words people write in intel. Matching these
# as ships does more harm than leaving them plain.
AMBIGUOUS = {
    'sin', 'ark', 'imp', 'eos', 'moa', 'hel', 'lif', 'utu', 'adrestia', 'gnosis',
    'hound', 'crow', 'raven', 'wolf', 'hawk', 'eagle', 'harpy', 'condor', 'probe',
    'reaper', 'punisher', 'crusader', 'executioner', 'avenger', 'guardian',
    'prospect', 'endurance', 'venture', 'orca', 'primae', 'apotheosis',
}

# Fleet slang that means a ship class rather than a hull. Worth highlighting —
# it's exactly what intel actually says.
SLANG = [
    'ceptor', 'ceptors', 'inty', 'intys', 'dictor', 'dictors', 'hictor', 'hictors',
    'hic', 'hics', 'logi', 'bomber', 'bombers', 'recon', 'recons', 'dread',
    'dreads', 'carrier', 'carriers', 'super', 'supers', 'titan', 'titans',
    'battleship', 'battleships', 'bs', 'cruiser', 'cruisers', 'battlecruiser',
    'battlecruisers', 'bc', 'destroyer', 'destroyers', 'frigate', 'frigates',
    'interceptor', 'interceptors', 'interdictor', 'interdictors', 'marauder',
    'marauders', 'blops', 'cyno', 'pod', 'pods', 'capsule', 'freighter',
    'freighters', 'jf', 'exhumer', 'exhumers', 'barge', 'barges',
]


def main():
    if not os.path.exists(EVE_DB):
        raise SystemExit(f'missing {EVE_DB} — see build_eve_db.py')
    con = sqlite3.connect(f'file:{EVE_DB}?mode=ro', uri=True)
    rows = con.execute(
        'SELECT t.typeName FROM invtypes t '
        'JOIN invgroups g ON g.groupID = t.groupID '
        'WHERE g.categoryID = 6 AND t.published = 1'
    ).fetchall()
    con.close()

    ships, dropped = [], []
    for (name,) in rows:
        n = (name or '').strip()
        if not n or len(n) < 3:
            continue
        (dropped if n.lower() in AMBIGUOUS else ships).append(n)

    ships = sorted(set(ships), key=str.lower)
    out = {'ships': ships, 'slang': sorted(set(SLANG)), 'dropped_ambiguous': sorted(set(dropped), key=str.lower)}
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, indent=1)
    print(f'{len(ships)} ship names + {len(out["slang"])} slang terms -> {OUT}')
    print(f'dropped {len(out["dropped_ambiguous"])} ambiguous names: {", ".join(out["dropped_ambiguous"][:12])}…')


if __name__ == '__main__':
    main()
