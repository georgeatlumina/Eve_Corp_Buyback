import re
import sys

import requests

JANICE_API_BASE = 'https://janice.e-351.com/api/rest/v2'
JANICE_RPC_URL = 'https://janice.e-351.com/api/rpc/v1'

BUYBACK_PERCENTAGE = 0.90

# Janice's internal market IDs (from Info.listPricerMarkets).
JANICE_MARKET_IDS = {
    'Jita 4-4': 2,
    'Amarr': 115,
    'Dodixie': 117,
    'Rens': 116,
    'Hek': 118,
}


def extract_code(url):
    """Extract Janice appraisal code from a URL like https://janice.e-351.com/a/oSCL9B."""
    m = re.search(r'/a/([A-Za-z0-9]+)', url or '')
    return m.group(1) if m else None


def fetch_appraisal(url, api_key=None):
    """Fetch Janice appraisal data. Prefers the authenticated REST API when a key
    is provided; falls back to the unauthenticated RPC endpoint on any API error."""
    code = extract_code(url)
    if not code:
        raise ValueError(f'No Janice appraisal code found in URL: {url!r}')

    api_error = None
    if api_key:
        try:
            return _fetch_via_api(code, api_key)
        except Exception as e:
            api_error = f'{type(e).__name__}: {e}'
            print(f'[janice] REST API failed for {code} ({api_error}); falling back to RPC',
                  file=sys.stderr, flush=True)

    result = _fetch_via_rpc(code)
    if api_error:
        result['api_fallback_reason'] = api_error
    return result


def _fetch_via_rpc(code):
    resp = requests.post(
        JANICE_RPC_URL,
        json={
            'jsonrpc': '2.0',
            'method': 'Appraisal.get',
            'params': {'code': code},
            'id': 1,
        },
        headers={'Content-Type': 'application/json', 'User-Agent': 'EveCorpBuyback/1.0'},
        timeout=15,
    )
    body = resp.json()
    if 'error' in body:
        err = body['error']
        data = err.get('data') or ''
        if 'RecordNotFoundException' in data:
            raise RuntimeError(
                f'Janice appraisal {code!r} no longer exists (expired or deleted). '
                'Ask the contractor to re-appraise.'
            )
        raise RuntimeError(f'Janice RPC error: {err.get("message", err)}')
    if resp.status_code >= 400:
        resp.raise_for_status()
    return _normalize(code, body['result'], source='rpc')


def _fetch_via_api(code, api_key):
    headers = {'Accept': 'application/json', 'X-ApiKey': api_key}
    resp = requests.get(f'{JANICE_API_BASE}/appraisal/{code}', headers=headers)
    resp.raise_for_status()
    return _normalize(code, resp.json(), source='api')


def _normalize(code, data, source):
    """Map Janice appraisal response to the shape validate.py expects."""
    pct_raw = data.get('pricePercentage')
    if pct_raw is None:
        displayed_pct = 100.0
    elif pct_raw <= 1.0:
        displayed_pct = pct_raw * 100.0
    else:
        displayed_pct = pct_raw

    immediate = data.get('immediatePrices') or {}
    full_buy = immediate.get('totalBuyPrice') or 0

    market = data.get('market') or data.get('pricerMarket') or {}

    items = []
    for line in re.split(r'\n+', data.get('input', '') or ''):
        line = line.strip()
        if not line:
            continue
        parts = re.split(r'\t+|\s{2,}', line)
        name = parts[0].strip()
        try:
            amount = int(parts[1].replace(',', '').replace(' ', '').strip()) if len(parts) > 1 else 0
        except ValueError:
            amount = 0
        items.append({
            'name': name,
            'amount': amount,
            'is_ore': bool(re.search(r'\bore\b|compressed', name, re.IGNORECASE)),
        })

    return {
        'code': code,
        'percentage': displayed_pct,
        'total_buy_price': full_buy,
        'effective_offer': full_buy * BUYBACK_PERCENTAGE,
        'market_name': market.get('name', ''),
        'market_id': market.get('id'),
        'items': items,
        'source': source,
        'raw': data,
    }


def create_appraisal(items, market_name, api_key=None):
    """Create a Janice appraisal from a list of {name, quantity} items.

    Prefers the authenticated REST API when api_key is set; falls back to the
    unauthenticated RPC endpoint on any API error.
    """
    market_id = JANICE_MARKET_IDS.get(market_name)
    if market_id is None:
        raise ValueError(f'Unknown Janice market: {market_name!r}')

    lines = [
        f'{i["name"]}\t{int(i["quantity"])}'
        for i in items
        if i.get('name') and i.get('quantity')
    ]
    if not lines:
        raise ValueError('No items with name+quantity to appraise')
    input_text = '\n'.join(lines)

    api_error = None
    if api_key:
        try:
            return _create_via_api(input_text, market_id, api_key)
        except Exception as e:
            api_error = f'{type(e).__name__}: {e}'
            print(f'[janice] REST API create failed ({api_error}); falling back to RPC',
                  file=sys.stderr, flush=True)

    result = _create_via_rpc(input_text, market_id)
    if api_error:
        result['api_fallback_reason'] = api_error
    return result


def create_appraisal_from_text(input_text, market_name, api_key=None, persist=False):
    """Create a Janice appraisal from a raw paste (one EVE-format line per item).

    Janice's RPC and REST endpoints both accept the input as plain text — the
    same shape an admin pastes from the in-game inventory window. This is the
    Working-tab entrypoint where the admin pastes the actual refined minerals
    rather than a list constructed from contract items. Set ``persist=True``
    to ask Janice to save the appraisal so the returned ``code`` can be turned
    into a shareable ``https://janice.e-351.com/a/<code>`` URL.
    """
    if not input_text or not input_text.strip():
        raise ValueError('paste text is empty')
    market_id = JANICE_MARKET_IDS.get(market_name)
    if market_id is None:
        raise ValueError(f'Unknown Janice market: {market_name!r}')

    api_error = None
    if api_key:
        try:
            return _create_via_api(input_text, market_id, api_key, persist=persist)
        except Exception as e:
            api_error = f'{type(e).__name__}: {e}'
            print(f'[janice] REST API create-from-text failed ({api_error}); '
                  'falling back to RPC', file=sys.stderr, flush=True)

    result = _create_via_rpc(input_text, market_id, persist=persist)
    if api_error:
        result['api_fallback_reason'] = api_error
    return result


def _create_via_rpc(input_text, market_id, persist=False):
    resp = requests.post(
        JANICE_RPC_URL,
        json={
            'jsonrpc': '2.0',
            'method': 'Appraisal.create',
            'params': {
                'input': input_text,
                'designation': 'appraisal',
                'pricing': 'buy',
                'pricingVariant': 'immediate',
                'marketId': market_id,
                'persist': bool(persist),
                'compactize': True,
                'pricePercentage': 1.0,
            },
            'id': 1,
        },
        headers={'Content-Type': 'application/json', 'User-Agent': 'EveCorpBuyback/1.0'},
        timeout=30,
    )
    body = resp.json()
    if 'error' in body:
        err = body['error']
        raise RuntimeError(f'Janice RPC create error: {err.get("message", err)}')
    return _normalize('', body['result'], source='rpc')


def _create_via_api(input_text, market_id, api_key, persist=False):
    resp = requests.post(
        f'{JANICE_API_BASE}/appraisal',
        params={
            'market': market_id,
            'designation': 'appraisal',
            'pricing': 'buy',
            'pricingVariant': 'immediate',
            'persist': 'true' if persist else 'false',
            'compactize': 'true',
            'pricePercentage': '1.0',
        },
        data=input_text,
        headers={
            'X-ApiKey': api_key,
            'Content-Type': 'text/plain',
            'Accept': 'application/json',
        },
        timeout=30,
    )
    resp.raise_for_status()
    return _normalize('', resp.json(), source='api')
