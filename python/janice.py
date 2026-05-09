import re

import requests

JANICE_API_BASE = 'https://janice.e-351.com/api/rest/v2'
JANICE_RPC_URL = 'https://janice.e-351.com/api/rpc/v1'

BUYBACK_PERCENTAGE = 0.90


def extract_code(url):
    """Extract Janice appraisal code from a URL like https://janice.e-351.com/a/oSCL9B."""
    m = re.search(r'/a/([A-Za-z0-9]+)', url or '')
    return m.group(1) if m else None


def fetch_appraisal(url, api_key=None):
    """Fetch Janice appraisal data. Uses unauthenticated RPC unless api_key is provided."""
    code = extract_code(url)
    if not code:
        raise ValueError(f'No Janice appraisal code found in URL: {url!r}')
    if api_key:
        try:
            return _fetch_via_api(code, api_key)
        except Exception:
            pass
    return _fetch_via_rpc(code)


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
