import logging
import re

import requests

ESI_BASE = 'https://esi.evetech.net/latest'

logger = logging.getLogger(__name__)


def _redact_url(url: str) -> str:
    return re.sub(r'([?&])token=[^&]*', r'\1token=***', str(url))


def _log_response(resp, *args, **kwargs):
    elapsed = resp.elapsed.total_seconds() if resp.elapsed else -1
    url = _redact_url(resp.url)
    if resp.status_code >= 400:
        logger.warning('ESI %s %s → %s (%.2fs)', resp.request.method, url, resp.status_code, elapsed)
    else:
        logger.info('ESI %s %s → %s (%.2fs)', resp.request.method, url, resp.status_code, elapsed)


_session = requests.Session()
_session.hooks['response'].append(_log_response)


def resolve_names(ids, user_agent):
    """Resolve EVE entity IDs (characters/corps/etc.) to names. Public endpoint."""
    unique = sorted({int(i) for i in ids if i})
    if not unique:
        return {}
    out = {}
    for i in range(0, len(unique), 1000):
        chunk = unique[i:i + 1000]
        resp = _session.post(
            f'{ESI_BASE}/universe/names/',
            headers={
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'User-Agent': user_agent,
            },
            json=chunk,
        )
        resp.raise_for_status()
        for entry in resp.json():
            out[entry['id']] = entry.get('name', '')
    return out


def resolve_ids(names, user_agent):
    """Resolve names -> ids via POST /universe/ids/. Returns a dict keyed by
    lowercased character name -> character_id (only the `characters` bucket)."""
    cleaned = sorted({n.strip() for n in names if n and n.strip()})
    out = {}
    if not cleaned:
        return out
    for i in range(0, len(cleaned), 500):
        chunk = cleaned[i:i + 500]
        resp = _session.post(
            f'{ESI_BASE}/universe/ids/',
            headers={
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'User-Agent': user_agent,
            },
            params={'datasource': 'tranquility'},
            json=chunk,
        )
        resp.raise_for_status()
        data = resp.json() or {}
        for ent in (data.get('characters') or []):
            out[(ent.get('name') or '').lower()] = ent.get('id')
    return out


def send_evemail(character_id, recipient_id, subject, body, access_token, user_agent):
    """Send an EVE mail from the authenticated character to a single recipient.

    Requires the `esi-mail.send_mail.v1` scope. ESI returns the new mail id on success.
    """
    url = f'{ESI_BASE}/characters/{character_id}/mail/'
    payload = {
        'approved_cost': 0,
        'body': body,
        'recipients': [{'recipient_id': int(recipient_id), 'recipient_type': 'character'}],
        'subject': subject,
    }
    resp = _session.post(
        url,
        headers={
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': user_agent,
        },
        params={'datasource': 'tranquility', 'token': access_token},
        json=payload,
    )
    if resp.status_code >= 400:
        # Surface ESI's error body so the user sees the real reason
        try:
            err = resp.json()
        except Exception:
            err = {'error': resp.text}
        raise RuntimeError(f'ESI mail send failed ({resp.status_code}): {err}')
    return resp.json()


def fetch_corp_wallets(corp_id, access_token, user_agent):
    """Returns list of all 7 corp wallet division balances."""
    resp = _session.get(
        f'{ESI_BASE}/corporations/{corp_id}/wallets/',
        headers={'Accept': 'application/json', 'User-Agent': user_agent},
        params={'datasource': 'tranquility', 'token': access_token},
    )
    resp.raise_for_status()
    return resp.json()


def fetch_contract_items(corp_id, contract_id, access_token, user_agent):
    """Fetch the items in a single corporation contract."""
    url = f'{ESI_BASE}/corporations/{corp_id}/contracts/{contract_id}/items/'
    resp = _session.get(
        url,
        headers={'Accept': 'application/json', 'User-Agent': user_agent},
        params={'datasource': 'tranquility', 'token': access_token},
    )
    resp.raise_for_status()
    return resp.json()


_TYPE_INFO_CACHE = {}
_GROUP_INFO_CACHE = {}


def fetch_type_info(type_id, user_agent):
    """Fetch ESI universe type info (cached). Returns dict with name, portion_size, group_id, etc."""
    cached = _TYPE_INFO_CACHE.get(type_id)
    if cached is not None:
        return cached
    resp = _session.get(
        f'{ESI_BASE}/universe/types/{type_id}/',
        headers={'Accept': 'application/json', 'User-Agent': user_agent},
        params={'datasource': 'tranquility'},
    )
    resp.raise_for_status()
    data = resp.json()
    _TYPE_INFO_CACHE[type_id] = data
    return data


def fetch_group_info(group_id, user_agent):
    """Fetch ESI universe group info (cached). Returns dict with name, category_id, etc."""
    cached = _GROUP_INFO_CACHE.get(group_id)
    if cached is not None:
        return cached
    resp = _session.get(
        f'{ESI_BASE}/universe/groups/{group_id}/',
        headers={'Accept': 'application/json', 'User-Agent': user_agent},
        params={'datasource': 'tranquility'},
    )
    resp.raise_for_status()
    data = resp.json()
    _GROUP_INFO_CACHE[group_id] = data
    return data


def fetch_category_info(category_id, user_agent):
    """Fetch ESI universe category info. Returns dict with name, groups, etc."""
    resp = _session.get(
        f'{ESI_BASE}/universe/categories/{int(category_id)}/',
        headers={'Accept': 'application/json', 'User-Agent': user_agent},
        params={'datasource': 'tranquility'},
    )
    resp.raise_for_status()
    return resp.json()


def fetch_all_ship_types(user_agent):
    """Return every EVE ship hull as a list of {type_id, name, group_id, group_name}.

    Walks category 6 → groups → type IDs (~50 ESI calls on a cold cache,
    fetch_group_info is then memoized) and bulk-resolves names via
    /universe/names. Unnamed entries (resolve_names returned nothing — usually
    unpublished/dev hulls) are dropped. Result is sorted by name.
    """
    cat = fetch_category_info(6, user_agent)
    group_ids = cat.get('groups') or []
    out = []
    for gid in group_ids:
        try:
            g = fetch_group_info(int(gid), user_agent)
        except Exception:
            continue
        gname = g.get('name', '')
        for tid in (g.get('types') or []):
            out.append({
                'type_id': int(tid),
                'group_id': int(gid),
                'group_name': gname,
                'name': '',
            })
    type_ids = [s['type_id'] for s in out]
    try:
        names = resolve_names(type_ids, user_agent)
    except Exception:
        names = {}
    for s in out:
        s['name'] = names.get(s['type_id'], '')
    out = [s for s in out if s['name']]
    out.sort(key=lambda s: s['name'].lower())
    return out


ZKILL_BASE = 'https://zkillboard.com/api'


def fetch_zkill_meta(kill_id, user_agent):
    """Look up a kill on zKillboard by ID. Returns the killmail hash (needed to
    pull the full killmail from ESI) plus zKill's `npc` flag. Public endpoint.

    Returns {'hash': str, 'npc': bool} or None if zKill has no record.
    """
    resp = _session.get(
        f'{ZKILL_BASE}/killID/{int(kill_id)}/',
        headers={'Accept': 'application/json', 'User-Agent': user_agent},
    )
    resp.raise_for_status()
    data = resp.json() or []
    if not data:
        return None
    zkb = (data[0] or {}).get('zkb') or {}
    h = zkb.get('hash')
    if not h:
        return None
    return {'hash': h, 'npc': bool(zkb.get('npc'))}


def fetch_killmail(kill_id, kill_hash, user_agent):
    """Fetch a full killmail from ESI (victim hull + fitted items, system, etc.).
    Public endpoint — the (id, hash) pair is the access token. Killmails are
    immutable, so callers should cache the result."""
    resp = _session.get(
        f'{ESI_BASE}/killmails/{int(kill_id)}/{kill_hash}/',
        headers={'Accept': 'application/json', 'User-Agent': user_agent},
        params={'datasource': 'tranquility'},
    )
    resp.raise_for_status()
    return resp.json()


def fetch_region_market_orders(region_id, type_id, user_agent, order_type='sell'):
    """Fetch all sell orders for a type in a region. Public endpoint, no auth needed."""
    url = f'{ESI_BASE}/markets/{int(region_id)}/orders/'
    out = []
    page = 1
    while True:
        resp = _session.get(
            url,
            headers={'Accept': 'application/json', 'User-Agent': user_agent},
            params={'datasource': 'tranquility', 'order_type': order_type,
                    'type_id': int(type_id), 'page': page},
        )
        resp.raise_for_status()
        batch = resp.json()
        if not batch:
            break
        out.extend(batch)
        max_page = int(resp.headers.get('x-pages', page))
        if page >= max_page:
            break
        page += 1
    return out


def fetch_region_market_history(region_id, type_id, user_agent):
    """Fetch daily traded-volume history for a type in a region. Public endpoint.

    Returns ESI's list of ``{date, average, highest, lowest, order_count,
    volume}`` daily records (oldest first, ~13 months). ``volume`` is the real
    number of units *traded* that day — the true liquidity signal, distinct from
    the on-book ``volume_remain`` the order endpoints expose.
    """
    resp = _session.get(
        f'{ESI_BASE}/markets/{int(region_id)}/history/',
        headers={'Accept': 'application/json', 'User-Agent': user_agent},
        params={'datasource': 'tranquility', 'type_id': int(type_id)},
    )
    resp.raise_for_status()
    return resp.json() or []


def fetch_corp_orders(corp_id, access_token, user_agent):
    """Fetch all pages of a corporation's open market orders from ESI.

    Requires the ``esi-markets.read_corporation_orders.v1`` scope and an
    Accountant or Trader role on the authed character. Each order carries
    ``type_id, location_id, region_id, price, volume_total, volume_remain,
    is_buy_order, issued, duration, order_id`` (sell orders have no
    ``is_buy_order`` key or ``is_buy_order=False``).
    """
    url = f'{ESI_BASE}/corporations/{int(corp_id)}/orders/'
    out = []
    page = 1
    while True:
        resp = _session.get(
            url,
            headers={'Accept': 'application/json', 'User-Agent': user_agent},
            params={'datasource': 'tranquility', 'token': access_token, 'page': page},
        )
        resp.raise_for_status()
        batch = resp.json()
        if not batch:
            break
        out.extend(batch)
        max_page = int(resp.headers.get('x-pages', page))
        if page >= max_page:
            break
        page += 1
    return out


def fetch_structure_orders_paged(structure_id, access_token, user_agent):
    """Generator that fetches structure market orders one page at a time.

    Yields ``(page, max_pages, batch)`` tuples after each successful page fetch.
    ``max_pages`` is taken from the ``x-pages`` response header (ESI tells us the
    total page count on the first response). Requires the
    `esi-markets.structure_markets.v1` scope and docking access at the structure.
    """
    url = f'{ESI_BASE}/markets/structures/{structure_id}/'
    page = 1
    while True:
        resp = _session.get(
            url,
            headers={'Accept': 'application/json', 'User-Agent': user_agent},
            params={'datasource': 'tranquility', 'token': access_token, 'page': page},
        )
        if resp.status_code >= 500:
            break
        resp.raise_for_status()
        batch = resp.json()
        if not batch:
            break
        max_page = int(resp.headers.get('x-pages', page))
        yield page, max_page, batch
        if page >= max_page:
            break
        page += 1


def fetch_structure_orders(structure_id, access_token, user_agent):
    """Convenience wrapper: collect all paged orders into a single list."""
    out = []
    for _page, _max, batch in fetch_structure_orders_paged(structure_id, access_token, user_agent):
        out.extend(batch)
    return out


def fetch_corp_contracts(corp_id, access_token, user_agent):
    """Fetch all pages of corporation contracts from ESI."""
    url = f'{ESI_BASE}/corporations/{corp_id}/contracts/'
    all_contracts = []
    page = 1
    while True:
        resp = _session.get(
            url,
            headers={'Accept': 'application/json', 'User-Agent': user_agent},
            params={'datasource': 'tranquility', 'token': access_token, 'page': page},
        )
        if resp.status_code >= 500:
            break
        resp.raise_for_status()
        batch = resp.json()
        if not batch:
            break
        all_contracts.extend(batch)
        max_page = int(resp.headers.get('x-pages', page))
        if page >= max_page:
            break
        page += 1
    return all_contracts


def fetch_corp_structures(corp_id, access_token, user_agent):
    """Fetch all pages of corporation-owned structures from ESI.

    Returns the raw structure records — each carries `structure_id`, `type_id`,
    `system_id`, `state`, `fuel_expires` (ISO8601, when present), and a
    `services` list. Skyhooks and sovereignty hubs appear here alongside Upwell
    citadels/engineering complexes. Requires the
    `esi-corporations.read_structures.v1` scope on a character with the Director
    role; ESI returns 403 otherwise (let the caller decide how to surface that).
    """
    url = f'{ESI_BASE}/corporations/{corp_id}/structures/'
    all_structures = []
    page = 1
    while True:
        resp = _session.get(
            url,
            headers={'Accept': 'application/json', 'User-Agent': user_agent},
            params={'datasource': 'tranquility', 'token': access_token, 'page': page},
        )
        if resp.status_code >= 500:
            break
        resp.raise_for_status()
        batch = resp.json()
        if not batch:
            break
        all_structures.extend(batch)
        max_page = int(resp.headers.get('x-pages', page))
        if page >= max_page:
            break
        page += 1
    return all_structures


def fetch_public_contracts_paged(region_id, user_agent):
    """Yield (page, max_pages, batch) tuples for public contracts in a region.

    Public endpoint — no auth needed. Each batch is a list of contract records;
    item_exchange contracts at structures only appear if the structure is
    listed publicly.
    """
    url = f'{ESI_BASE}/contracts/public/{int(region_id)}/'
    page = 1
    while True:
        resp = _session.get(
            url,
            headers={'Accept': 'application/json', 'User-Agent': user_agent},
            params={'datasource': 'tranquility', 'page': page},
        )
        if resp.status_code >= 500:
            break
        resp.raise_for_status()
        batch = resp.json()
        if not batch:
            break
        max_page = int(resp.headers.get('x-pages', page))
        yield page, max_page, batch
        if page >= max_page:
            break
        page += 1


def fetch_public_contract_items(contract_id, user_agent):
    """Fetch items in a single public contract (all pages)."""
    url = f'{ESI_BASE}/contracts/public/items/{int(contract_id)}/'
    out = []
    page = 1
    while True:
        resp = _session.get(
            url,
            headers={'Accept': 'application/json', 'User-Agent': user_agent},
            params={'datasource': 'tranquility', 'page': page},
        )
        if resp.status_code == 404:
            return []
        resp.raise_for_status()
        batch = resp.json()
        if not batch:
            break
        out.extend(batch)
        max_page = int(resp.headers.get('x-pages', page))
        if page >= max_page:
            break
        page += 1
    return out


def fetch_character_contracts(character_id, access_token, user_agent):
    """Fetch all pages of a character's contracts (personal/corp/alliance visible)."""
    url = f'{ESI_BASE}/characters/{int(character_id)}/contracts/'
    out = []
    page = 1
    while True:
        resp = _session.get(
            url,
            headers={'Accept': 'application/json', 'User-Agent': user_agent},
            params={'datasource': 'tranquility', 'token': access_token, 'page': page},
        )
        if resp.status_code >= 500:
            break
        resp.raise_for_status()
        batch = resp.json()
        if not batch:
            break
        out.extend(batch)
        max_page = int(resp.headers.get('x-pages', page))
        if page >= max_page:
            break
        page += 1
    return out


def fetch_character_contract_items(character_id, contract_id, access_token, user_agent):
    """Fetch items for one contract visible to a character."""
    url = f'{ESI_BASE}/characters/{int(character_id)}/contracts/{int(contract_id)}/items/'
    resp = _session.get(
        url,
        headers={'Accept': 'application/json', 'User-Agent': user_agent},
        params={'datasource': 'tranquility', 'token': access_token},
    )
    if resp.status_code == 404:
        return []
    resp.raise_for_status()
    return resp.json()


def fetch_station_info(station_id, user_agent):
    """Public NPC station lookup — used to derive region_id from a station id."""
    resp = _session.get(
        f'{ESI_BASE}/universe/stations/{int(station_id)}/',
        headers={'Accept': 'application/json', 'User-Agent': user_agent},
        params={'datasource': 'tranquility'},
    )
    resp.raise_for_status()
    return resp.json()


def fetch_system_info(system_id, user_agent):
    resp = _session.get(
        f'{ESI_BASE}/universe/systems/{int(system_id)}/',
        headers={'Accept': 'application/json', 'User-Agent': user_agent},
        params={'datasource': 'tranquility'},
    )
    resp.raise_for_status()
    return resp.json()


def fetch_constellation_info(constellation_id, user_agent):
    resp = _session.get(
        f'{ESI_BASE}/universe/constellations/{int(constellation_id)}/',
        headers={'Accept': 'application/json', 'User-Agent': user_agent},
        params={'datasource': 'tranquility'},
    )
    resp.raise_for_status()
    return resp.json()


def fetch_region_info(region_id, user_agent):
    resp = _session.get(
        f'{ESI_BASE}/universe/regions/{int(region_id)}/',
        headers={'Accept': 'application/json', 'User-Agent': user_agent},
        params={'datasource': 'tranquility'},
    )
    resp.raise_for_status()
    return resp.json()


def fetch_character_info(character_id, user_agent):
    """Public character info: name, corporation_id, alliance_id (if any), security_status."""
    resp = _session.get(
        f'{ESI_BASE}/characters/{int(character_id)}/',
        headers={'Accept': 'application/json', 'User-Agent': user_agent},
        params={'datasource': 'tranquility'},
    )
    resp.raise_for_status()
    return resp.json()


def fetch_corporation_info(corp_id, user_agent):
    """Public corp info: name, ticker, alliance_id, member_count, tax_rate, war_eligible."""
    resp = _session.get(
        f'{ESI_BASE}/corporations/{int(corp_id)}/',
        headers={'Accept': 'application/json', 'User-Agent': user_agent},
        params={'datasource': 'tranquility'},
    )
    resp.raise_for_status()
    return resp.json()


def fetch_alliance_info(alliance_id, user_agent):
    """Public alliance info: name, ticker, creator_corporation_id, executor_corporation_id, date_founded."""
    resp = _session.get(
        f'{ESI_BASE}/alliances/{int(alliance_id)}/',
        headers={'Accept': 'application/json', 'User-Agent': user_agent},
        params={'datasource': 'tranquility'},
    )
    resp.raise_for_status()
    return resp.json()


def fetch_sovereignty_structures(user_agent):
    """All sov structures (TCU/IHUB) in the cluster. Public, returns ~5k entries."""
    resp = _session.get(
        f'{ESI_BASE}/sovereignty/structures/',
        headers={'Accept': 'application/json', 'User-Agent': user_agent},
        params={'datasource': 'tranquility'},
    )
    resp.raise_for_status()
    return resp.json()


def fetch_sovereignty_map(user_agent):
    """System → owning alliance/corp mapping for all sov-claimable space."""
    resp = _session.get(
        f'{ESI_BASE}/sovereignty/map/',
        headers={'Accept': 'application/json', 'User-Agent': user_agent},
        params={'datasource': 'tranquility'},
    )
    resp.raise_for_status()
    return resp.json()


def fetch_sovereignty_campaigns(user_agent):
    """Active sov campaigns (TCU/IHUB/station defense or freeport events)."""
    resp = _session.get(
        f'{ESI_BASE}/sovereignty/campaigns/',
        headers={'Accept': 'application/json', 'User-Agent': user_agent},
        params={'datasource': 'tranquility'},
    )
    resp.raise_for_status()
    return resp.json()


def fetch_system_kills(user_agent):
    """Last-hour kill counts (ship_kills, npc_kills, pod_kills) for every system."""
    resp = _session.get(
        f'{ESI_BASE}/universe/system_kills/',
        headers={'Accept': 'application/json', 'User-Agent': user_agent},
        params={'datasource': 'tranquility'},
    )
    resp.raise_for_status()
    return resp.json()


def fetch_system_jumps(user_agent):
    """Last-hour jump counts for every system."""
    resp = _session.get(
        f'{ESI_BASE}/universe/system_jumps/',
        headers={'Accept': 'application/json', 'User-Agent': user_agent},
        params={'datasource': 'tranquility'},
    )
    resp.raise_for_status()
    return resp.json()


def fetch_incursions(user_agent):
    """Active Sansha incursions across the cluster."""
    resp = _session.get(
        f'{ESI_BASE}/incursions/',
        headers={'Accept': 'application/json', 'User-Agent': user_agent},
        params={'datasource': 'tranquility'},
    )
    resp.raise_for_status()
    return resp.json()
