import requests

ESI_BASE = 'https://esi.evetech.net/latest'


def resolve_names(ids, user_agent):
    """Resolve EVE entity IDs (characters/corps/etc.) to names. Public endpoint."""
    unique = sorted({int(i) for i in ids if i})
    if not unique:
        return {}
    out = {}
    for i in range(0, len(unique), 1000):
        chunk = unique[i:i + 1000]
        resp = requests.post(
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


def fetch_corp_wallets(corp_id, access_token, user_agent):
    """Returns list of all 7 corp wallet division balances."""
    resp = requests.get(
        f'{ESI_BASE}/corporations/{corp_id}/wallets/',
        headers={'Accept': 'application/json', 'User-Agent': user_agent},
        params={'datasource': 'tranquility', 'token': access_token},
    )
    resp.raise_for_status()
    return resp.json()


def fetch_contract_items(corp_id, contract_id, access_token, user_agent):
    """Fetch the items in a single corporation contract."""
    url = f'{ESI_BASE}/corporations/{corp_id}/contracts/{contract_id}/items/'
    resp = requests.get(
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
    resp = requests.get(
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
    resp = requests.get(
        f'{ESI_BASE}/universe/groups/{group_id}/',
        headers={'Accept': 'application/json', 'User-Agent': user_agent},
        params={'datasource': 'tranquility'},
    )
    resp.raise_for_status()
    data = resp.json()
    _GROUP_INFO_CACHE[group_id] = data
    return data


def fetch_corp_contracts(corp_id, access_token, user_agent):
    """Fetch all pages of corporation contracts from ESI."""
    url = f'{ESI_BASE}/corporations/{corp_id}/contracts/'
    all_contracts = []
    page = 1
    while True:
        resp = requests.get(
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
