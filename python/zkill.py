"""Native zKillboard front end — data layer.

The zKillboard tab used to be a <webview> wrapper around zkillboard.com. This
module lets us render a killboard natively instead: it resolves a search term to
an EVE entity, pulls that entity's kill/loss list from zKillboard's public API,
then enriches each row with the full killmail from ESI (victim hull, final blow,
system) and bulk-resolved names.

Flow per board:
  resolve query -> entity (character / corporation / alliance / system)
  zKillboard /api/<scope>/<id>/[kills|losses]/page/<n>/  -> [{killmail_id, zkb}]
  ESI /killmails/<id>/<hash>/ (parallel, disk-cached — killmails are immutable)
  ESI /universe/names/ (one bulk call for every id across the page)

zKillboard asks integrations to send a descriptive User-Agent and to cache; we
reuse the app's UA and cache every fetched killmail on disk indefinitely.
"""

import json
import os
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import quote

import requests

from esi import (
    ESI_BASE,
    fetch_killmail,
    fetch_system_info,
    resolve_names,
)

ZKILL_BASE = 'https://zkillboard.com/api'

# Search term -> entity resolution. `/universe/ids/` does exact-name matching and
# returns separate buckets; we map each bucket to the zKillboard path scope.
_KIND_BUCKET = {
    'character': ('characters', 'characterID'),
    'corporation': ('corporations', 'corporationID'),
    'alliance': ('alliances', 'allianceID'),
    'system': ('systems', 'systemID'),
}
# Auto-detect priority when the caller doesn't force a kind: a name is far more
# likely to be a pilot than a same-named corp/alliance/system.
_AUTO_ORDER = ['character', 'corporation', 'alliance', 'system']


def resolve_entity(query, kind, user_agent):
    """Resolve a name to ``{'kind', 'id', 'name'}`` via ESI /universe/ids/.

    ``kind`` is one of character/corporation/alliance/system, or 'auto' to try
    them in _AUTO_ORDER. Returns None if nothing matches. Exact-name match only
    (that's all the public endpoint offers)."""
    q = (query or '').strip()
    if not q:
        return None
    resp = requests.post(
        f'{ESI_BASE}/universe/ids/',
        headers={'Accept': 'application/json', 'Content-Type': 'application/json',
                 'User-Agent': user_agent},
        params={'datasource': 'tranquility'},
        json=[q],
        timeout=20,
    )
    resp.raise_for_status()
    data = resp.json() or {}
    order = _AUTO_ORDER if kind in (None, '', 'auto') else [kind]
    for k in order:
        bucket, _scope = _KIND_BUCKET.get(k, (None, None))
        if not bucket:
            continue
        for ent in (data.get(bucket) or []):
            if (ent.get('name') or '').lower() == q.lower():
                return {'kind': k, 'id': int(ent['id']), 'name': ent.get('name') or q}
    # Fall back to the first match in any bucket if an exact-case miss slipped
    # through (ESI is case-insensitive, so this is belt-and-braces).
    for k in order:
        bucket, _scope = _KIND_BUCKET.get(k, (None, None))
        for ent in (data.get(bucket) or []):
            return {'kind': k, 'id': int(ent['id']), 'name': ent.get('name') or q}
    return None


# Autocomplete: zKillboard's own search suggestions. Returns a mix of entity
# types; we surface only the four the killboard can render.
_SUGGEST_KINDS = {'character', 'corporation', 'alliance', 'system'}


def fetch_suggestions(term, user_agent, limit=8):
    """Type-ahead suggestions from zKillboard's autocomplete endpoint.

    Returns ``[{'id', 'name', 'kind'}]`` for pilots / corps / alliances /
    systems that match ``term`` (items and other types are dropped). zKill wants
    at least a few characters; we require 3."""
    t = (term or '').strip()
    if len(t) < 3:
        return []
    resp = requests.get(
        f'https://zkillboard.com/autocomplete/{quote(t)}/',
        headers={'Accept': 'application/json', 'User-Agent': user_agent,
                 'Accept-Encoding': 'gzip'},
        timeout=15,
    )
    resp.raise_for_status()
    data = resp.json()
    out = []
    for row in (data if isinstance(data, list) else []):
        kind = row.get('type')
        if kind not in _SUGGEST_KINDS:
            continue
        try:
            out.append({'id': int(row['id']), 'name': row.get('name') or '', 'kind': kind})
        except (TypeError, ValueError, KeyError):
            continue
        if len(out) >= limit:
            break
    return out


def fetch_zkill_list(kind, entity_id, board_filter, page, user_agent):
    """Fetch one page of an entity's killmails from zKillboard.

    ``board_filter`` is 'all' | 'kills' | 'losses' (zKill's own modifiers).
    Returns zKill's raw list of ``{killmail_id, zkb:{hash, totalValue, ...}}``.
    The hash is included here, so no separate /killID/ lookup is needed."""
    _bucket, scope = _KIND_BUCKET.get(kind, (None, None))
    if not scope:
        raise ValueError(f'unknown entity kind: {kind!r}')
    parts = [ZKILL_BASE, scope, str(int(entity_id))]
    if board_filter in ('kills', 'losses'):
        parts.append(board_filter)
    parts.append('page')
    parts.append(str(int(page or 1)))
    url = '/'.join(parts) + '/'
    resp = requests.get(
        url,
        headers={'Accept': 'application/json', 'User-Agent': user_agent,
                 'Accept-Encoding': 'gzip'},
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    return data if isinstance(data, list) else []


# --- Killmail disk cache (killmails are immutable) --------------------------

_cache = None          # str(kill_id) -> raw ESI killmail
_cache_lock = threading.Lock()
_cache_path = None


def _cache_file():
    global _cache_path
    if _cache_path is None:
        from config import AUTH_DIR
        _cache_path = os.path.join(AUTH_DIR, 'zkill_killmails.json')
    return _cache_path


def _load_cache():
    global _cache
    if _cache is not None:
        return _cache
    try:
        with open(_cache_file()) as f:
            _cache = json.load(f)
    except Exception:
        _cache = {}
    return _cache


def _save_cache():
    path = _cache_file()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(_cache, f)
        os.replace(tmp, path)
    except Exception:
        pass


def _killmail_cached(kill_id, kill_hash, user_agent):
    key = str(int(kill_id))
    cache = _load_cache()
    with _cache_lock:
        hit = cache.get(key)
    if hit is not None:
        return hit
    km = fetch_killmail(kill_id, kill_hash, user_agent)
    with _cache_lock:
        cache[key] = km
        _save_cache()
    return km


# --- Board assembly ---------------------------------------------------------

def _system_lookup(system_ids, user_agent):
    """Return ``{system_id: security_status}`` for the given systems, fetched
    once each (small count per page). Failures map to None."""
    out = {}
    for sid in {int(s) for s in system_ids if s}:
        try:
            out[sid] = fetch_system_info(sid, user_agent).get('security_status')
        except Exception:
            out[sid] = None
    return out


def _person(prefix, obj, names):
    """Build a victim/attacker person dict from a killmail participant + the
    resolved-name map."""
    cid = obj.get('character_id')
    corp = obj.get('corporation_id')
    ally = obj.get('alliance_id')
    ship = obj.get('ship_type_id')
    return {
        'character_id': cid,
        'character_name': names.get(cid, '') if cid else '',
        'corporation_id': corp,
        'corporation_name': names.get(corp, '') if corp else '',
        'alliance_id': ally,
        'alliance_name': names.get(ally, '') if ally else '',
        'ship_type_id': ship,
        'ship_name': names.get(ship, '') if ship else '',
    }


def build_board(query, kind='auto', board_filter='all', limit=40, page=1,
                user_agent='', max_workers=8, entity_id=None):
    """Return an enriched killboard for an entity.

    If ``entity_id`` is given (a suggestion was picked, so we already know the
    exact id + kind), it's used directly and ``query`` is just the display name.
    Otherwise ``query`` is resolved by exact name. Returns ``{'entity': {...},
    'rows': [...], 'total_on_page': int}`` or raises ValueError('no-entity') when
    a name search matches nothing."""
    if entity_id and kind in _KIND_BUCKET:
        entity = {'kind': kind, 'id': int(entity_id), 'name': (query or '').strip()}
    else:
        entity = resolve_entity(query, kind, user_agent)
        if not entity:
            raise ValueError('no-entity')

    raw = fetch_zkill_list(entity['kind'], entity['id'], board_filter, page, user_agent)
    total_on_page = len(raw)
    limit = max(1, min(int(limit or 40), 100))
    page_slice = raw[:limit]

    # Fetch every killmail in parallel (disk-cached, so warm pages are instant).
    kms = {}
    if page_slice:
        with ThreadPoolExecutor(max_workers=min(max_workers, len(page_slice))) as ex:
            futs = {}
            for entry in page_slice:
                kid = entry.get('killmail_id')
                khash = (entry.get('zkb') or {}).get('hash')
                if not kid or not khash:
                    continue
                futs[ex.submit(_killmail_cached, kid, khash, user_agent)] = kid
            for fut in as_completed(futs):
                kid = futs[fut]
                try:
                    kms[kid] = fut.result()
                except Exception:
                    kms[kid] = None

    # Collect every id we need a name for, across the whole page, then resolve
    # in one bulk ESI call.
    id_set = set()
    system_ids = set()
    for entry in page_slice:
        km = kms.get(entry.get('killmail_id'))
        if not km:
            continue
        if km.get('solar_system_id'):
            system_ids.add(km['solar_system_id'])
            id_set.add(km['solar_system_id'])
        v = km.get('victim') or {}
        for k in ('character_id', 'corporation_id', 'alliance_id', 'ship_type_id'):
            if v.get(k):
                id_set.add(v[k])
        # Final blow only (attacker list can be huge; the board shows the killer).
        fb = _final_blow(km)
        for k in ('character_id', 'corporation_id', 'alliance_id', 'ship_type_id'):
            if fb.get(k):
                id_set.add(fb[k])
    try:
        names = resolve_names(sorted(id_set), user_agent) if id_set else {}
    except Exception:
        names = {}
    security = _system_lookup(system_ids, user_agent)

    rows = []
    for entry in page_slice:
        kid = entry.get('killmail_id')
        km = kms.get(kid)
        zkb = entry.get('zkb') or {}
        if not km:
            # Killmail fetch failed; still show the zKill summary line.
            rows.append({
                'killmail_id': kid,
                'time': None, 'system_id': None, 'system_name': '', 'security': None,
                'total_value': zkb.get('totalValue') or 0,
                'points': zkb.get('points') or 0,
                'npc': bool(zkb.get('npc')), 'solo': bool(zkb.get('solo')),
                'awox': bool(zkb.get('awox')),
                'victim': None, 'final_blow': None, 'attacker_count': 0,
                'error': 'killmail unavailable',
            })
            continue
        sid = km.get('solar_system_id')
        rows.append({
            'killmail_id': kid,
            'time': km.get('killmail_time'),
            'system_id': sid,
            'system_name': names.get(sid, '') if sid else '',
            'security': security.get(sid),
            'total_value': zkb.get('totalValue') or 0,
            'points': zkb.get('points') or 0,
            'npc': bool(zkb.get('npc')),
            'solo': bool(zkb.get('solo')),
            'awox': bool(zkb.get('awox')),
            'victim': _person('victim', km.get('victim') or {}, names),
            'final_blow': _person('fb', _final_blow(km), names),
            'attacker_count': len(km.get('attackers') or []),
        })

    return {'entity': entity, 'rows': rows, 'total_on_page': total_on_page}


def _final_blow(km):
    """Return the final-blow attacker dict from a killmail (or {})."""
    for a in (km.get('attackers') or []):
        if a.get('final_blow'):
            return a
    atk = km.get('attackers') or []
    return atk[0] if atk else {}
