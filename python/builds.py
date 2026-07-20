"""Indy build-planner store — per-builder build entries + missing-materials.

Pure module (no network IO), mirroring `stockpile.py`: GitHub read/write lives
in `server.py` so it can reuse the Contents-API helpers; this module owns the
canonical document shape, normalization, and the local cache file.

Each *builder* (an authenticated EVE character) owns one file on the shared
market-history repo at ``builds/{character_id}.json``. That file holds all of
that pilot's planned builds. A build records which doctrine it's being made
against, an estimated completion date, and one or more *slots* — each slot is a
single manufacturing job whose missing materials the builder pastes straight
from the in-game "missing materials" window. Admins read every builder's file
(via `server.py`'s ``/api/builds/all``) and compare the aggregate missing
materials against the alliance stockpile.
"""

import json
import os
import re

from config import AUTH_DIR

# Local cache of the current pilot's own builds file (GitHub is source of truth
# when the shared repo is configured; this is the offline fallback).
MINE_CACHE_PATH = os.path.join(AUTH_DIR, 'builds_mine.json')

# The directory of per-builder files inside the shared repo.
STORE_DIR = 'builds'

VALID_ALLIANCES = ('main', 'institute')


def _to_int(v, default=0):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def empty_doc(builder_id=0, builder_name=''):
    return {
        'builder_id': _to_int(builder_id),
        'builder_name': str(builder_name or ''),
        'updated_at': '',
        'builds': [],
    }


def _normalize_material(it):
    if not isinstance(it, dict):
        return None
    name = str(it.get('name') or '').strip()
    if not name:
        return None
    cat = it.get('category')
    if cat not in ('minerals', 'pi', 'other'):
        cat = 'other'
    return {
        'name': name,
        'type_id': _to_int(it.get('type_id')),
        'qty': _to_int(it.get('qty')),
        'category': cat,
    }


def _normalize_slot(sl):
    if not isinstance(sl, dict):
        return None
    missing = []
    for m in (sl.get('missing') or []):
        nm = _normalize_material(m)
        if nm:
            missing.append(nm)
    return {
        'id': str(sl.get('id') or '').strip(),
        'label': str(sl.get('label') or '').strip(),
        'missing': missing,
    }


def _normalize_build(b):
    if not isinstance(b, dict):
        return None
    slots = []
    for sl in (b.get('slots') or []):
        ns = _normalize_slot(sl)
        if ns is not None:
            slots.append(ns)
    alliance = b.get('alliance')
    if alliance not in VALID_ALLIANCES:
        alliance = 'main'
    return {
        'id': str(b.get('id') or '').strip(),
        'doctrine': str(b.get('doctrine') or '').strip(),
        'alliance': alliance,
        'est_completion': str(b.get('est_completion') or '').strip(),  # 'YYYY-MM-DD'
        'note': str(b.get('note') or '').strip(),
        'created_at': str(b.get('created_at') or '').strip(),
        'slots': slots,
    }


def normalize(data):
    """Coerce an arbitrary loaded doc into the canonical builder-file shape."""
    if not isinstance(data, dict):
        return empty_doc()
    builds = []
    for b in (data.get('builds') or []):
        nb = _normalize_build(b)
        if nb is not None:
            builds.append(nb)
    return {
        'builder_id': _to_int(data.get('builder_id')),
        'builder_name': str(data.get('builder_name') or ''),
        'updated_at': str(data.get('updated_at') or ''),
        'builds': builds,
    }


def _strict_int(s):
    """Parse an integer count, tolerating thousands separators. Returns None for
    anything that isn't a whole number (e.g. the decimal price column)."""
    if s is None:
        return None
    s = re.sub(r'[\s,]', '', str(s).strip())
    return int(s) if s.isdigit() else None


def parse_missing_materials(text):
    """Parse the in-game industry-job 'missing materials' clipboard copy.

    The format looks like::

        Mjolnir Heavy Assault Missile Blueprint\\t26760\\t\\t\\t
        <blank>
        Minerals\\t\\t\\t\\t
        Item\\tRequired\\tAvailable\\tEst. Unit price\\ttypeID
        Tritanium\\t442\\t0\\t3.64\\t34
        Pyerite\\t197\\t0\\t18.89\\t35

    We keep only the actual material rows — dropping the blueprint header line,
    the category labels ("Minerals"), and the column-header row — reading the
    ``Required`` quantity and the ``typeID`` by their header positions. Rows are
    only collected after an ``Item … Required`` header, so the blueprint line
    (which precedes it) is naturally excluded. Returns ``[{name, qty, type_id}]``
    aggregated by name, or ``None`` when no such table header is present so the
    caller can fall back to the generic paste parser.
    """
    items = {}
    order = []
    in_table = False
    saw_header = False
    req_idx, tid_idx = 1, -1
    for raw in (text or '').splitlines():
        line = raw.strip()
        if not line:
            in_table = False  # a blank line ends the current section
            continue
        parts = [p.strip() for p in line.split('\t')]
        low = [p.lower() for p in parts]
        if parts[0].lower() == 'item' and 'required' in low:
            in_table = True
            saw_header = True
            req_idx = low.index('required')
            tid_idx = low.index('typeid') if 'typeid' in low else -1
            continue
        if not in_table:
            continue  # preamble (blueprint line) or a category label before the header
        name = parts[0]
        qty = _strict_int(parts[req_idx]) if req_idx < len(parts) else None
        if not name or qty is None:
            continue  # category label / non-data row inside the section
        type_id = 0
        if 0 <= tid_idx < len(parts):
            type_id = _strict_int(parts[tid_idx]) or 0
        key = name.lower()
        if key not in items:
            items[key] = {'name': name, 'qty': 0, 'type_id': type_id}
            order.append(key)
        items[key]['qty'] += qty
        if type_id and not items[key]['type_id']:
            items[key]['type_id'] = type_id
    if not saw_header:
        return None
    return [items[k] for k in order]


def load_mine_local():
    try:
        with open(MINE_CACHE_PATH, 'r', encoding='utf-8') as fh:
            return normalize(json.load(fh))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return empty_doc()


def save_mine_local(doc):
    os.makedirs(AUTH_DIR, exist_ok=True)
    tmp = MINE_CACHE_PATH + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(doc, fh, indent=2)
    os.replace(tmp, MINE_CACHE_PATH)
    try:
        os.chmod(MINE_CACHE_PATH, 0o600)
    except OSError:
        pass


def build_slot_count(doc):
    return sum(len(b.get('slots') or []) for b in (doc.get('builds') or []))


def aggregate_missing(docs):
    """Sum missing materials across many builder docs.

    Returns a list of ``{name, type_id, category, needed, sources[]}`` sorted by
    biggest shortfall-eligible need first. ``sources`` records which build/slot
    each contribution came from so the dashboard can show who needs what and by
    when. Materials are keyed by type_id when known, else by lowercased name so
    unresolved pastes still aggregate sensibly.
    """
    agg = {}
    order = []
    for doc in docs or []:
        builder = str(doc.get('builder_name') or '') or f"char {doc.get('builder_id')}"
        for b in (doc.get('builds') or []):
            for sl in (b.get('slots') or []):
                for m in (sl.get('missing') or []):
                    tid = _to_int(m.get('type_id'))
                    name = str(m.get('name') or '').strip()
                    key = f'id:{tid}' if tid else f'nm:{name.lower()}'
                    if not key or key == 'nm:':
                        continue
                    if key not in agg:
                        agg[key] = {
                            'name': name,
                            'type_id': tid,
                            'category': m.get('category') or 'other',
                            'needed': 0,
                            'sources': [],
                        }
                        order.append(key)
                    entry = agg[key]
                    entry['needed'] += _to_int(m.get('qty'))
                    entry['sources'].append({
                        'builder': builder,
                        'doctrine': b.get('doctrine') or '',
                        'est_completion': b.get('est_completion') or '',
                        'slot': sl.get('label') or '',
                        'qty': _to_int(m.get('qty')),
                    })
    rows = [agg[k] for k in order]
    rows.sort(key=lambda r: r['needed'], reverse=True)
    return rows
