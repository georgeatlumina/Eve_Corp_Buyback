"""Item metadata (name + group + market category) for the Market Analytics tab.

The structure-market endpoint returns only `type_id`s. To make dashboard rows
searchable and filterable we resolve each type's name, group, and market
category from ESI and cache the result on disk in `type_meta.json` — exactly
the same pattern as `ship_types.json`.

Resolving a never-seen type costs a few ESI calls (type -> group -> category),
run concurrently across the batch and deduped by group/category. Everything is
cached on disk afterwards, so subsequent loads are instant and only brand-new
types (e.g. after an EVE expansion) trigger fresh lookups.
"""
import json
import os
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

from config import AUTH_DIR
from esi import fetch_category_info, fetch_group_info, fetch_type_info

META_CACHE = os.path.join(AUTH_DIR, 'type_meta.json')
_RESOLVE_WORKERS = 16

_lock = threading.Lock()
_cache = None  # str(type_id) -> {name, group_id, group_name, category_id, category_name}


def _load_cache():
    """Return the in-memory cache dict, hydrating from disk on first call."""
    global _cache
    if _cache is not None:
        return _cache
    with _lock:
        if _cache is None:
            data = {}
            if os.path.exists(META_CACHE):
                try:
                    with open(META_CACHE, encoding='utf-8') as f:
                        loaded = json.load(f)
                    if isinstance(loaded, dict):
                        data = loaded
                except Exception:
                    data = {}
            _cache = data
    return _cache


def _save_cache_locked():
    """Persist `_cache` to disk. Caller must hold `_lock`."""
    os.makedirs(AUTH_DIR, exist_ok=True)
    tmp = META_CACHE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(_cache, f)
    os.replace(tmp, META_CACHE)
    try:
        os.chmod(META_CACHE, 0o600)
    except OSError:
        pass


def missing_ids(type_ids):
    """Return the de-duplicated subset of `type_ids` not yet cached on disk."""
    cache = _load_cache()
    seen = set()
    out = []
    for t in type_ids:
        t = int(t)
        if t in seen:
            continue
        seen.add(t)
        if str(t) not in cache:
            out.append(t)
    return out


def _resolve_one(type_id, user_agent, group_meta, glock):
    """Resolve one type to its metadata. `group_meta` memoizes group/category
    lookups across the batch so shared groups aren't fetched repeatedly."""
    entry = {'name': '', 'group_id': 0, 'group_name': '', 'category_id': 0, 'category_name': ''}
    try:
        ti = fetch_type_info(type_id, user_agent)
        entry['name'] = ti.get('name', '') or ''
        gid = ti.get('group_id') or 0
        entry['group_id'] = gid
        if gid:
            with glock:
                gm = group_meta.get(gid)
            if gm is None:
                try:
                    gi = fetch_group_info(gid, user_agent)
                    gname = gi.get('name', '') or ''
                    cid = gi.get('category_id') or 0
                except Exception:
                    gname, cid = '', 0
                cname = ''
                if cid:
                    try:
                        cname = fetch_category_info(cid, user_agent).get('name', '') or ''
                    except Exception:
                        cname = ''
                gm = (gname, cid, cname)
                with glock:
                    group_meta[gid] = gm
            entry['group_name'], entry['category_id'], entry['category_name'] = gm
    except Exception:
        pass
    return entry


def resolve(type_ids, user_agent, on_progress=None):
    """Fetch + cache metadata for any of `type_ids` not already on disk.

    Runs lookups concurrently and calls `on_progress(done, total)` periodically.
    No-op (and no ESI traffic) when everything is already cached.
    """
    missing = missing_ids(type_ids)
    if not missing:
        return
    cache = _load_cache()  # same object we mutate below, loaded outside the lock
    group_meta = {}
    glock = threading.Lock()
    results = {}
    done = 0
    with ThreadPoolExecutor(max_workers=_RESOLVE_WORKERS) as ex:
        futs = {ex.submit(_resolve_one, t, user_agent, group_meta, glock): t for t in missing}
        for fut in as_completed(futs):
            results[str(futs[fut])] = fut.result()
            done += 1
            if on_progress and (done % 25 == 0 or done == len(missing)):
                on_progress(done, len(missing))
    with _lock:
        cache.update(results)
        _save_cache_locked()


def enrich(type_ids, user_agent=None, on_progress=None):
    """Return `{type_id(int): metadata}` for `type_ids`.

    When `user_agent` is supplied, any missing types are resolved from ESI and
    cached first; otherwise only already-cached entries are returned.
    """
    if user_agent is not None:
        resolve(type_ids, user_agent, on_progress=on_progress)
    cache = _load_cache()
    out = {}
    for t in type_ids:
        t = int(t)
        m = cache.get(str(t))
        if m:
            out[t] = m
    return out
