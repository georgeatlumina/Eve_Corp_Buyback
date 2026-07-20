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
