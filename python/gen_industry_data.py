"""Maintenance script: regenerate the bundled industry (manufacturing + reaction)
dataset used by the Production Planner.

Recipes come from EVE Ref's reference-data API (/blueprints) — the same source
gen_pi_data.py uses. For every blueprint we keep its **manufacturing** and
**reaction** activities: the output product, per-run material list, run time,
and max runs. Type names / groups come from the bundled data/eve.db (invtypes +
invgroups) so we don't hammer the API for thousands of type lookups.

Everything is committed to data/industry.json so the sidecar never touches the
network for static industry facts (they only change on EVE expansions). This is
a dev/maintenance tool — NOT imported by server.py; the runtime engine is
python/industry.py, which only reads the JSON.

Run:  python gen_industry_data.py
Out:  data/industry.json
"""
import json
import os
import sqlite3
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

REF = 'https://ref-data.everef.net'
UA = 'EveCorpBuyback/1.0 (maintenance gen_industry_data)'
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
OUT = os.path.join(DATA_DIR, 'industry.json')
EVE_DB = os.path.join(DATA_DIR, 'eve.db')

# EVE Ref activity keys we care about. Manufacturing gets ME; reactions don't.
ACTIVITIES = ('manufacturing', 'reaction')


def _get(path, tries=3):
    last = None
    for _ in range(tries):
        try:
            r = requests.get(f'{REF}{path}', headers={'User-Agent': UA, 'Accept': 'application/json'}, timeout=30)
            r.raise_for_status()
            return r.json()
        except Exception as e:  # noqa: BLE001 — retry any transient failure
            last = e
    raise last


def _recipes_from_blueprint(bp):
    """Yield (product_type_id, recipe) for each buildable activity on a blueprint.

    A recipe is {activity, blueprint_type_id, time, output_qty, max_runs,
    materials: [[type_id, qty_per_output_batch], ...]}. materials/products come
    back as {type_id_str: {quantity, type_id}} dicts (same shape as PI
    schematics)."""
    bp_id = bp.get('blueprint_type_id')
    max_runs = bp.get('max_production_limit') or 0
    acts = bp.get('activities') or {}
    for activity in ACTIVITIES:
        act = acts.get(activity)
        if not act:
            continue
        products = act.get('products') or {}
        materials = act.get('materials') or {}
        if not products or not materials:
            continue
        mats = sorted([[int(m['type_id']), int(m['quantity'])] for m in materials.values()])
        for p in products.values():
            yield int(p['type_id']), {
                'activity': activity,
                'blueprint_type_id': bp_id,
                'time': int(act.get('time') or 0),
                'output_qty': int(p.get('quantity') or 1),
                'max_runs': int(max_runs),
                'materials': mats,
            }


def _invention_from_blueprint(bp):
    """Yield (t2_blueprint_type_id, invention_record) for a T1 blueprint's
    invention activity. The activity lives on the *source* (T1/relic) blueprint
    and produces one or more T2/T3 blueprints; each product carries its base
    ``probability`` and ``quantity`` (runs per invented copy)."""
    inv = (bp.get('activities') or {}).get('invention')
    if not inv:
        return
    source_bp = bp.get('blueprint_type_id')
    datacores = sorted([[int(m['type_id']), int(m['quantity'])] for m in (inv.get('materials') or {}).values()])
    for p in (inv.get('products') or {}).values():
        yield int(p['type_id']), {
            'source_blueprint_id': source_bp,
            'datacores': datacores,
            'probability': float(p.get('probability') or 0.0),
            'output_runs': int(p.get('quantity') or 1),
            'time': int(inv.get('time') or 0),
        }


def _load_type_meta(type_ids):
    """Resolve {type_id: {name, group_id, group_name, category_id, meta_group_id}}
    from the bundled eve.db. Missing ids get a placeholder name."""
    con = sqlite3.connect(EVE_DB)
    con.row_factory = sqlite3.Row
    meta = {}
    ids = sorted(type_ids)
    CHUNK = 900  # stay under SQLite's variable limit
    group_cat = {}
    for row in con.execute('SELECT groupID, name, categoryID FROM invgroups'):
        group_cat[row['groupID']] = (row['name'], row['categoryID'])
    for i in range(0, len(ids), CHUNK):
        batch = ids[i:i + CHUNK]
        q = 'SELECT typeID, typeName, groupID, metaGroupID FROM invtypes WHERE typeID IN (%s)' % ','.join('?' * len(batch))
        for row in con.execute(q, batch):
            gname, cat = group_cat.get(row['groupID'], ('', None))
            meta[str(row['typeID'])] = {
                'name': row['typeName'],
                'group_id': row['groupID'],
                'group_name': gname,
                'category_id': cat,
                'meta_group_id': row['metaGroupID'],
            }
    con.close()
    for tid in ids:
        meta.setdefault(str(tid), {'name': f'type {tid}', 'group_id': None,
                                   'group_name': '', 'category_id': None, 'meta_group_id': None})
    return meta


def main():
    print('fetching blueprint index…')
    ids = _get('/blueprints')
    print(f'{len(ids)} blueprints')

    recipes = {}          # product_type_id (str) -> recipe (manufacturing preferred over reaction)
    invention = {}        # t2_blueprint_type_id (str) -> invention record
    fetched = 0
    failed = 0

    def fetch(bid):
        return bid, _get(f'/blueprints/{bid}')

    with ThreadPoolExecutor(max_workers=24) as ex:
        futures = [ex.submit(fetch, b) for b in ids]
        for fut in as_completed(futures):
            try:
                _bid, bp = fut.result()
            except Exception as e:  # noqa: BLE001
                failed += 1
                if failed <= 5:
                    print(f'  blueprint fetch failed: {e}')
                continue
            for product_id, recipe in _recipes_from_blueprint(bp):
                key = str(product_id)
                # If a product is somehow made by two activities, prefer manufacturing.
                if key in recipes and recipes[key]['activity'] == 'manufacturing':
                    continue
                recipes[key] = recipe
            for t2_bp_id, inv_rec in _invention_from_blueprint(bp):
                invention[str(t2_bp_id)] = inv_rec
            fetched += 1
            if fetched % 500 == 0:
                print(f'  …{fetched}/{len(ids)}')

    print(f'built {len(recipes)} product recipes ({failed} blueprint fetches failed)')

    # Every type that appears as a product, a material, or an invention datacore.
    type_ids = set(int(k) for k in recipes)
    for r in recipes.values():
        type_ids.update(m[0] for m in r['materials'])
    for inv in invention.values():
        type_ids.update(dc[0] for dc in inv['datacores'])
    print(f'resolving {len(type_ids)} type names from eve.db…')
    types = _load_type_meta(type_ids)

    by_activity = {}
    for r in recipes.values():
        by_activity[r['activity']] = by_activity.get(r['activity'], 0) + 1

    out = {
        '_meta': {
            'source': REF,
            'blueprint_count': len(ids),
            'recipe_count': len(recipes),
            'invention_count': len(invention),
            'type_count': len(types),
            'by_activity': by_activity,
        },
        'recipes': recipes,
        'invention': invention,
        'types': types,
    }
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    size_mb = os.path.getsize(OUT) / 1_048_576
    print(f'wrote {len(recipes)} recipes ({by_activity}), {len(invention)} invention entries, '
          f'{len(types)} types -> {OUT} ({size_mb:.1f} MB)')


if __name__ == '__main__':
    main()
