"""SRP killmail classification.

Given a zKillboard kill ID (parsed from the SRP request's kill link), pull the
real hull and *fitted modules* off the killmail and derive an SRP payout
category from the fit — not from the hull name alone. This is what lets us tell
a links T3D / Nighthawk (command-burst modules fitted) apart from the same hull
flown as DPS, and a logi-platform flown with remote reps apart from a gank-fit
one. Remote reps only count as logistics on an actual logi platform (T2 logi,
T1 logi cruiser, or logi-fit T3D) — see _is_logi_platform. The renderer
cross-references the hull against the Auth doctrine list separately.

Flow per kill: zKillboard /killID/ -> killmail hash, then ESI killmail ->
victim hull + fitted items, then resolve each fitted module's group. Killmails
are immutable, so results are cached on disk indefinitely.
"""

import json
import os
import re
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

from esi import (
    fetch_group_info,
    fetch_killmail,
    fetch_system_info,
    fetch_type_info,
    fetch_zkill_meta,
)

# ESI killmail item `flag` ranges for fitted slots: LoSlot0-7 = 11-18,
# MedSlot0-7 = 19-26, HiSlot0-7 = 27-34. Cargo / drone bay / fleet hangar use
# other flags and are ignored so a spare module in the hold doesn't misclassify.
_FITTED_FLAGS = set(range(11, 35))

# Module group names (ESI universe group) that mark a role. Command Burst is the
# modern links module; the older Warfare Link modules sit in "Gang Coordinator".
_LINKS_GROUPS = {'command burst', 'gang coordinator'}
_LINKS_NAME_RE = re.compile(r'warfare link|command burst', re.I)
_LOGI_GROUPS = {
    'remote armor repairer', 'remote shield booster', 'remote hull repairer',
}
_LOGI_NAME_RE = re.compile(r'remote (armor repairer|shield booster|hull repairer)', re.I)

# Hull-group fallbacks, used only when the fit doesn't reveal a role (e.g. the
# killmail couldn't be fetched). These groups are role-dedicated — a Guardian is
# always logi, an interdictor is always a dictor — so the hull alone is safe.
# We deliberately do NOT fall back on T1 logi cruisers (Osprey/Scythe/etc.) by
# name: those hulls are flown as DPS just as often, so a missing-reps killmail
# should stay Standard rather than over-pay. A real T1 logi is still caught by
# its remote reps above.
_DICTOR_HULL_GROUPS = {'interdictor', 'heavy interdiction cruiser'}
_LOGI_HULL_GROUPS = {'logistics', 'logistics frigate'}
# Remote reps only make a kill "logistics" when they're on a hull that's actually
# a logi platform. The eligible platforms are: T2 logi (the _LOGI_HULL_GROUPS
# above), a T1 logi cruiser, or a T3 destroyer flown in a logi config. Remote
# reps bolted onto anything else (a DPS hull, a battleship) do not make it a logi
# and must not be paid as one.
# T1 logi cruisers + T1 support frigates (the remote-rep-bonused T1 hulls). T2
# logi frigates are already covered by the 'logistics frigate' group above.
_T1_LOGI_HULLS = {
    'osprey', 'scythe', 'exequror', 'augoror',      # T1 logi cruisers
    'bantam', 'navitas', 'burst', 'inquisitor',     # T1 support (logi) frigates
}
_T3D_HULL_GROUP = 'tactical destroyer'
# Hulls treated as links boats by hull alone, regardless of doctrine membership
# or whether command bursts were captured on the killmail. The Nighthawk is the
# canonical case; add other links command hulls here as the corp confirms them.
_LINKS_HULLS = {'nighthawk'}


def _is_logi_platform(hull_name, hull_group):
    """True if `hull` can legitimately be flown as logistics: a T2 logi
    (Logistics / Logistics Frigate group), a T1 logi cruiser or support frigate
    (Osprey/Scythe/Exequror/Augoror, Bantam/Navitas/Burst/Inquisitor), or a T3
    destroyer (logi-fit). Used to gate remote-rep detection so incidental reps on
    a non-logi hull don't get the logistics payout."""
    return (
        hull_group in _LOGI_HULL_GROUPS
        or hull_group == _T3D_HULL_GROUP
        or hull_name in _T1_LOGI_HULLS
    )

_cache = None          # str(kill_id) -> classification dict
_cache_lock = threading.Lock()
_cache_path = None


def _cache_file():
    global _cache_path
    if _cache_path is None:
        from config import AUTH_DIR
        _cache_path = os.path.join(AUTH_DIR, 'srp_killmails.json')
    return _cache_path


def _load_cache():
    global _cache
    if _cache is not None:
        return _cache
    path = _cache_file()
    try:
        with open(path) as f:
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


def _group_name(type_id, user_agent):
    """Resolve a type_id to its (name, group_name), both lowercased. Cached by
    the underlying ESI helpers, so repeated modules across kills are cheap."""
    try:
        ti = fetch_type_info(type_id, user_agent)
        gname = ''
        gid = ti.get('group_id')
        if gid:
            gname = (fetch_group_info(gid, user_agent).get('name') or '')
        return (ti.get('name') or '', gname)
    except Exception:
        return ('', '')


def _classify_one(kill_id, user_agent):
    """Build a classification for a single kill. Network-heavy; callers cache."""
    out = {
        'kill_id': int(kill_id), 'hull': '', 'hull_group': '', 'ship_type_id': 0,
        'category': 'standard', 'links': False, 'logi': False, 'npc': False,
        'hisec': False, 'security': None, 'modules': [], 'ok': False, 'error': '',
    }
    meta = fetch_zkill_meta(kill_id, user_agent)
    if not meta:
        out['error'] = 'zKillboard has no record of this kill'
        return out
    out['npc'] = meta['npc']
    km = fetch_killmail(kill_id, meta['hash'], user_agent)
    victim = km.get('victim') or {}
    ship_type_id = victim.get('ship_type_id') or 0
    out['ship_type_id'] = ship_type_id
    if ship_type_id:
        out['hull'], out['hull_group'] = _group_name(ship_type_id, user_agent)

    # System security -> hisec flag (used with zKill's npc flag for Hisec-NPC).
    sys_id = km.get('solar_system_id')
    if sys_id:
        try:
            out['security'] = fetch_system_info(sys_id, user_agent).get('security_status')
        except Exception:
            pass
    if out['security'] is not None:
        out['hisec'] = out['security'] >= 0.45

    # Inspect fitted modules for role-defining modules.
    has_links = has_logi = False
    seen = set()
    for it in (victim.get('items') or []):
        if it.get('flag') not in _FITTED_FLAGS:
            continue
        tid = it.get('item_type_id')
        if not tid or tid in seen:
            continue
        seen.add(tid)
        name, group = _group_name(tid, user_agent)
        if group in _LINKS_GROUPS or _LINKS_NAME_RE.search(name):
            has_links = True
            out['modules'].append(name)
        elif group in _LOGI_GROUPS or _LOGI_NAME_RE.search(name):
            has_logi = True
            out['modules'].append(name)

    # Category precedence: fitted role wins; fall back to the hull group, then
    # to a hisec-NPC loss. Fight Club stays manual (not derivable from a kill).
    hg = (out['hull_group'] or '').lower()
    hn = (out['hull'] or '').lower()
    # Remote reps only count as logistics on a hull that's actually a logi
    # platform — otherwise an incidental rep on a DPS hull would over-pay.
    logi_fit = has_logi and _is_logi_platform(hn, hg)
    out['links'], out['logi'] = has_links, logi_fit
    if has_links:
        out['category'] = 'links'
    elif logi_fit:
        out['category'] = 'logistics'
    elif hg in _DICTOR_HULL_GROUPS:
        out['category'] = 'interdictor'
    elif hg in _LOGI_HULL_GROUPS:
        out['category'] = 'logistics'
    elif hn in _LINKS_HULLS:
        out['category'] = 'links'
    elif out['npc'] and out['hisec']:
        out['category'] = 'hisecnpc'
    else:
        out['category'] = 'standard'
    out['ok'] = True
    return out


def classify_kill(kill_id, user_agent):
    """Classify one kill, using the on-disk cache. Only successful results are
    cached (a transient zKill/ESI failure shouldn't poison the cache)."""
    key = str(int(kill_id))
    cache = _load_cache()
    with _cache_lock:
        if key in cache:
            return cache[key]
    try:
        res = _classify_one(kill_id, user_agent)
    except Exception as e:
        return {'kill_id': int(kill_id), 'ok': False, 'error': str(e),
                'category': 'standard', 'links': False, 'logi': False}
    if res.get('ok'):
        with _cache_lock:
            cache[key] = res
            _save_cache()
    return res


def classify_kills(kill_ids, user_agent, max_workers=8):
    """Classify many kills concurrently. Returns {str(kill_id): classification}."""
    ids = []
    for k in kill_ids:
        try:
            ids.append(int(k))
        except (TypeError, ValueError):
            continue
    ids = sorted(set(ids))
    results = {}
    if not ids:
        return results
    with ThreadPoolExecutor(max_workers=min(max_workers, len(ids))) as ex:
        futs = {ex.submit(classify_kill, kid, user_agent): kid for kid in ids}
        for fut in as_completed(futs):
            kid = futs[fut]
            try:
                results[str(kid)] = fut.result()
            except Exception as e:
                results[str(kid)] = {'kill_id': kid, 'ok': False, 'error': str(e),
                                     'category': 'standard', 'links': False, 'logi': False}
    return results


def classify_kills_stream(kill_ids, user_agent, max_workers=8):
    """Like classify_kills, but a generator: classifies in parallel and yields
    ``(done, total, str(kill_id), classification)`` as each kill finishes, so
    callers can stream per-kill progress instead of blocking on the whole batch."""
    ids = []
    for k in kill_ids:
        try:
            ids.append(int(k))
        except (TypeError, ValueError):
            continue
    ids = sorted(set(ids))
    total = len(ids)
    if not ids:
        return
    done = 0
    with ThreadPoolExecutor(max_workers=min(max_workers, len(ids))) as ex:
        futs = {ex.submit(classify_kill, kid, user_agent): kid for kid in ids}
        for fut in as_completed(futs):
            kid = futs[fut]
            try:
                res = fut.result()
            except Exception as e:
                res = {'kill_id': kid, 'ok': False, 'error': str(e),
                       'category': 'standard', 'links': False, 'logi': False}
            done += 1
            yield done, total, str(kid), res
