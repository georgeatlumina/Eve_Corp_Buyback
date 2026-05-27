import json
import os
import secrets
import sys
import threading
import time
import webbrowser
from typing import Any, Optional

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from auth import (
    build_authorize_url,
    decode_jwt_payload,
    exchange_code_for_tokens,
    get_app_credentials,
    get_user_agent,
    get_valid_access_token,
    load_cached_tokens,
    refresh_access_token,
    save_cached_tokens,
)
from config import load_config, save_config
from esi import (
    fetch_contract_items,
    fetch_corp_contracts,
    fetch_corp_wallets,
    fetch_structure_orders,
    fetch_structure_orders_paged,
    resolve_names,
    send_evemail,
)
from refining import compute_refined_payout, is_donation, is_mineable, is_prismaticite
from validate import categorize, process_moon_contract, validate_all, validate_buyback_contract

PORT = 8765
REDIRECT_URI = f'http://localhost:{PORT}/callback'

app = FastAPI(title='EVE Corp Buyback')

_auth_state: dict[str, Any] = {
    'expected_state': None,
    'completed': False,
    'error': None,
}
_auth_lock = threading.Lock()


def _callback_page(msg: str) -> HTMLResponse:
    return HTMLResponse(
        f'<html><body style="font-family:sans-serif;padding:2em;background:#1e1e1e;color:#eee">'
        f'<h2>{msg}</h2><p>You can close this tab.</p></body></html>'
    )


@app.get('/api/health')
def health():
    return {'ok': True}


@app.get('/api/config')
def get_config():
    return load_config()


class ConfigUpdate(BaseModel):
    corp_id: Optional[int] = None
    scopes: Optional[list[str]] = None
    structures: Optional[list[dict]] = None
    janice_market: Optional[str] = None
    janice_api_key: Optional[str] = None
    moon_market: Optional[str] = None
    moon_ore_refining_efficiency: Optional[float] = None
    non_moon_ore_refining_efficiency: Optional[float] = None
    ice_refining_efficiency: Optional[float] = None
    moon_payout_fraction: Optional[float] = None
    non_moon_payout_fraction: Optional[float] = None
    mail_presets: Optional[list[dict]] = None


@app.post('/api/config')
def update_config(update: ConfigUpdate):
    cfg = load_config()
    data = update.model_dump(exclude_unset=True)
    cfg.update(data)
    save_config(cfg)
    return cfg


@app.get('/api/markets')
def list_markets():
    from config import JANICE_MARKETS
    return {'markets': JANICE_MARKETS}


@app.get('/api/auth/status')
def auth_status():
    client_id, secret_key = get_app_credentials()
    cached = load_cached_tokens()
    if not cached:
        return {'authenticated': False, 'character': None}
    if cached.get('expires_at', 0) < time.time() + 30 and cached.get('refresh_token'):
        try:
            tokens = refresh_access_token(
                client_id, secret_key,
                cached['refresh_token'], get_user_agent(),
            )
            save_cached_tokens(tokens)
            cached = load_cached_tokens()
        except Exception as e:
            return {'authenticated': False, 'character': None, 'error': str(e)}
    payload = decode_jwt_payload(cached['access_token'])
    return {
        'authenticated': True,
        'character': payload.get('name'),
        'expires_at': cached.get('expires_at'),
    }


@app.post('/api/auth/login')
def auth_login():
    cfg = load_config()
    client_id, _ = get_app_credentials()
    with _auth_lock:
        _auth_state['expected_state'] = secrets.token_urlsafe(32)
        _auth_state['completed'] = False
        _auth_state['error'] = None
    url = build_authorize_url(
        client_id, REDIRECT_URI, cfg['scopes'], _auth_state['expected_state'],
    )
    webbrowser.open(url)
    return {'opened': True, 'url': url}


@app.get('/callback')
def sso_callback(
    code: Optional[str] = None,
    state: Optional[str] = None,
    error: Optional[str] = None,
):
    client_id, secret_key = get_app_credentials()
    with _auth_lock:
        if error:
            _auth_state['error'] = error
            return _callback_page(f'SSO error: {error}')
        if state != _auth_state['expected_state']:
            _auth_state['error'] = 'state_mismatch'
            return _callback_page('State mismatch — login aborted.')
        try:
            tokens = exchange_code_for_tokens(
                client_id, secret_key, code, get_user_agent(),
            )
            save_cached_tokens(tokens)
            _auth_state['completed'] = True
            _auth_state['expected_state'] = None
        except Exception as e:
            _auth_state['error'] = str(e)
            return _callback_page(f'Token exchange failed: {e}')
    return _callback_page('Logged in! Return to the app.')


class SendMailRequest(BaseModel):
    recipient_id: int
    subject: str
    body: str


@app.post('/api/mail/send')
def send_mail(req: SendMailRequest):
    """Send an EVE mail from the authenticated character to recipient_id."""
    if not req.recipient_id:
        raise HTTPException(400, 'recipient_id is required')
    if not req.subject.strip() or not req.body.strip():
        raise HTTPException(400, 'subject and body cannot be empty')

    cached = load_cached_tokens()
    if not cached:
        raise HTTPException(401, 'Not authenticated; log in first')

    client_id, secret_key = get_app_credentials()
    try:
        access_token = get_valid_access_token(client_id, secret_key, get_user_agent())
    except Exception as e:
        raise HTTPException(401, str(e))

    payload = decode_jwt_payload(access_token)
    sub = payload.get('sub', '')
    try:
        character_id = int(sub.rsplit(':', 1)[-1])
    except (ValueError, AttributeError):
        raise HTTPException(401, f'Could not extract character_id from JWT sub={sub!r}')

    scopes = payload.get('scp')
    scope_list = scopes if isinstance(scopes, list) else [scopes] if scopes else []
    if 'esi-mail.send_mail.v1' not in scope_list:
        raise HTTPException(
            403,
            'Token is missing the esi-mail.send_mail.v1 scope. Re-authenticate on the Auth tab.',
        )

    try:
        result = send_evemail(
            character_id, req.recipient_id, req.subject, req.body,
            access_token, get_user_agent(),
        )
    except Exception as e:
        raise HTTPException(502, str(e))
    return {'ok': True, 'mail_id': result}


@app.get('/api/wallets')
def get_wallets():
    cfg = load_config()
    if not cfg.get('corp_id'):
        raise HTTPException(400, 'Configure corp_id first')
    client_id, secret_key = get_app_credentials()
    try:
        token = get_valid_access_token(client_id, secret_key, get_user_agent())
    except Exception as e:
        raise HTTPException(401, str(e))
    wallets = fetch_corp_wallets(cfg['corp_id'], token, get_user_agent())
    total = sum(w.get('balance', 0) for w in wallets)
    return {'wallets': wallets, 'total': total}


@app.post('/api/contracts/fetch')
def fetch_contracts():
    cfg = load_config()
    if not cfg.get('corp_id'):
        raise HTTPException(400, 'Configure corp_id first')
    client_id, secret_key = get_app_credentials()
    try:
        token = get_valid_access_token(client_id, secret_key, get_user_agent())
    except Exception as e:
        raise HTTPException(401, str(e))
    contracts = fetch_corp_contracts(cfg['corp_id'], token, get_user_agent())
    return {'count': len(contracts), 'contracts': contracts}


class ValidateRequest(BaseModel):
    contracts: Optional[list[dict]] = None


def _emit(event_type, **data):
    """Encode one NDJSON line for the stream."""
    payload = {'event': event_type, **data}
    return (json.dumps(payload) + '\n').encode('utf-8')


@app.post('/api/validate')
def validate(req: ValidateRequest):
    """Stream per-contract validation results as NDJSON.

    Event types: start | progress | buyback_result | moon_result | done | error.
    Each line is a complete JSON object terminated by \\n.
    """
    cfg = load_config()
    return StreamingResponse(_validate_stream(cfg, req), media_type='application/x-ndjson')


def _validate_stream(cfg, req):
    from janice import create_appraisal

    if not cfg.get('corp_id'):
        yield _emit('error', message='Configure corp_id first')
        return

    client_id, secret_key = get_app_credentials()
    try:
        token = get_valid_access_token(client_id, secret_key, get_user_agent())
    except Exception as e:
        yield _emit('error', message=f'Not authenticated: {e}')
        return

    contracts = req.contracts
    if contracts is None:
        yield _emit('progress', step='Fetching corp contracts from ESI…')
        try:
            contracts = fetch_corp_contracts(cfg['corp_id'], token, get_user_agent())
        except Exception as e:
            yield _emit('error', message=f'ESI fetch failed: {e}')
            return

    yield _emit('progress', step='Categorizing contracts…')
    buckets = categorize(contracts, cfg['corp_id'])
    summary = {
        'courier': len(buckets['courier']),
        'moon': len(buckets['moon']),
        'buyback': len(buckets['buyback']),
    }

    yield _emit('progress', step='Resolving issuer names…')
    issuer_ids = (
        {c.get('issuer_id') for c in buckets['buyback']}
        | {c.get('issuer_id') for c in buckets['moon']}
    )
    try:
        names = resolve_names(issuer_ids, get_user_agent())
    except Exception:
        names = {}

    yield _emit('start', summary=summary)

    # ------ Buyback ------
    janice_key = cfg.get('janice_api_key') or None
    janice_market_cfg = cfg.get('janice_market') or ''
    structures = cfg['structures']
    total_buy = len(buckets['buyback'])

    for idx, c in enumerate(buckets['buyback'], 1):
        yield _emit(
            'progress', kind='buyback', current=idx, total=total_buy,
            step=f'Buyback {idx}/{total_buy}: contract {c.get("contract_id")} — '
                 f'{names.get(c.get("issuer_id"), c.get("issuer_id"))}',
        )
        result = validate_buyback_contract(c, structures, janice_market_cfg, janice_key)
        result['issuer_name'] = names.get(result.get('issuer_id'), '')
        yield _emit('buyback_result', current=idx, total=total_buy, result=result)

    # ------ Moon ------
    moon_market = cfg.get('moon_market') or 'Jita 4-4'
    moon_ore_refining_eff = float(cfg.get('moon_ore_refining_efficiency') or 0.78)
    non_moon_ore_refining_eff = float(cfg.get('non_moon_ore_refining_efficiency') or 0.78)
    ice_refining_eff = float(cfg.get('ice_refining_efficiency') or non_moon_ore_refining_eff)
    non_moon_payout_frac = float(cfg.get('non_moon_payout_fraction') or 0.90)
    moon_payout_frac = float(cfg.get('moon_payout_fraction') or 0.80)
    total_moon = len(buckets['moon'])

    for idx, c in enumerate(buckets['moon'], 1):
        cid = c.get('contract_id')
        issuer_label = names.get(c.get('issuer_id'), c.get('issuer_id'))

        def moon_step(msg):
            return _emit(
                'progress', kind='moon', current=idx, total=total_moon,
                step=f'Moon {idx}/{total_moon}: contract {cid} — {issuer_label} — {msg}',
            )

        yield moon_step('fetching items')

        def payout_lookup(_c, _cid=cid):
            items_raw = fetch_contract_items(cfg['corp_id'], _cid, token, get_user_agent())
            type_ids = [i['type_id'] for i in items_raw]
            try:
                type_names = resolve_names(type_ids, get_user_agent())
            except Exception:
                type_names = {}
            items_named = [
                {
                    'name': type_names.get(i['type_id'], ''),
                    'type_id': i['type_id'],
                    'quantity': i['quantity'],
                }
                for i in items_raw
            ]

            # Step 1: Janice appraisal (always — even rejected contracts get a value reference).
            janice_block = None
            try:
                appraisal = create_appraisal(items_named, moon_market, api_key=janice_key)
                janice_block = {
                    'source': appraisal.get('source'),
                    'market_name': appraisal.get('market_name'),
                    'total_buy_price': appraisal.get('total_buy_price'),
                    'api_fallback_reason': appraisal.get('api_fallback_reason'),
                    'code': appraisal.get('raw', {}).get('code'),
                }
            except Exception as e:
                janice_block = {'error': f'{type(e).__name__}: {e}'}

            # Detect donation items (Magmatic Gas / Superionic Ice) — kept for the flag,
            # even if the contract is rejected for other reasons.
            has_donations = any(
                is_donation(i['type_id'], get_user_agent()) for i in items_named
            )
            # Detect Prismaticite — accepted but flagged for manual payout.
            has_prismaticite = any(
                is_prismaticite(i['type_id'], get_user_agent()) for i in items_named
            )

            # Step 2: Mineable check (flag, don't bail — keeps Janice info visible).
            bad = [i for i in items_named if not is_mineable(i['type_id'], get_user_agent())]

            # Step 3: Refined payout only if all items are mineable.
            refined_block = None
            if not bad:
                refined_block = compute_refined_payout(
                    [{'type_id': i['type_id'], 'quantity': i['quantity']} for i in items_named],
                    moon_market,
                    moon_ore_refining_eff,
                    non_moon_ore_refining_eff,
                    ice_refining_eff,
                    non_moon_payout_frac,
                    get_user_agent(),
                    moon_payout_fraction=moon_payout_frac,
                )
                refined_block['moon_ore_refining_efficiency'] = moon_ore_refining_eff
                refined_block['non_moon_ore_refining_efficiency'] = non_moon_ore_refining_eff
                refined_block['ice_refining_efficiency'] = ice_refining_eff
                refined_block['market_name'] = moon_market

                mineral_ids = (
                    [b['type_id'] for b in refined_block.get('breakdown', [])]
                    + [b['type_id'] for b in refined_block.get('leftover_breakdown', [])]
                    + [b['type_id'] for b in refined_block.get('donation_breakdown', [])]
                    + [b['type_id'] for b in refined_block.get('prismaticite_breakdown', [])]
                )
                if mineral_ids:
                    try:
                        mineral_names = resolve_names(mineral_ids, get_user_agent())
                    except Exception:
                        mineral_names = {}
                    for b in refined_block.get('breakdown', []):
                        b['name'] = mineral_names.get(b['type_id'], '')
                    for b in refined_block.get('leftover_breakdown', []):
                        b['name'] = mineral_names.get(b['type_id'], '')
                    for b in refined_block.get('donation_breakdown', []):
                        b['name'] = mineral_names.get(b['type_id'], '')
                    for b in refined_block.get('prismaticite_breakdown', []):
                        b['name'] = mineral_names.get(b['type_id'], '')

            return {
                'janice': janice_block,
                'refined': refined_block,
                'items': items_named,
                'mineable_bad': bad,
                'has_donations': has_donations,
                'has_prismaticite': has_prismaticite,
            }

        result = process_moon_contract(c, structures, payout_lookup)
        result['issuer_name'] = names.get(result.get('issuer_id'), '')
        yield _emit('moon_result', current=idx, total=total_moon, result=result)

    yield _emit('done')


_market_cache: dict[int, dict[str, Any]] = {}
_MARKET_TTL_SECONDS = 300


def _summarize_orders(structure_id: int, orders: list, fetched_at: float) -> dict:
    by_type: dict[int, dict] = {}
    for o in orders:
        if o.get('is_buy_order'):
            continue
        tid = o.get('type_id')
        if not tid:
            continue
        entry = by_type.setdefault(int(tid), {'min_price': None, 'total_volume': 0, 'order_count': 0})
        price = float(o.get('price') or 0)
        if entry['min_price'] is None or price < entry['min_price']:
            entry['min_price'] = price
        entry['total_volume'] += int(o.get('volume_remain') or 0)
        entry['order_count'] += 1
    return {
        'structure_id': structure_id,
        'fetched_at': fetched_at,
        'order_count': len(orders),
        'by_type': by_type,
    }


@app.get('/api/aa/market')
def get_aa_market(structure_id: Optional[int] = None, refresh: bool = False):
    """Fetch sell orders at the given structure (default: first configured structure).

    Returns aggregated availability per type_id: min sell price, total units on
    market, number of distinct sell orders. Cached in-memory for 5 minutes.
    """
    cfg = load_config()
    sid = structure_id
    if not sid:
        structures = cfg.get('structures') or []
        if not structures:
            raise HTTPException(400, 'No configured structures; add one in Config or pass structure_id')
        first = structures[0]
        sid = first.get('id')
        if not sid:
            raise HTTPException(400, 'First configured structure has no id')
    sid = int(sid)

    now = time.time()
    cached = _market_cache.get(sid)
    if not refresh and cached and (now - cached['fetched_at']) < _MARKET_TTL_SECONDS:
        return _summarize_orders(sid, cached['orders'], cached['fetched_at'])

    client_id, secret_key = get_app_credentials()
    try:
        token = get_valid_access_token(client_id, secret_key, get_user_agent())
    except Exception as e:
        raise HTTPException(401, str(e))

    try:
        orders = fetch_structure_orders(sid, token, get_user_agent())
    except Exception as e:
        raise HTTPException(502, f'ESI structure market fetch failed: {e}')

    _market_cache[sid] = {'fetched_at': now, 'orders': orders}
    return _summarize_orders(sid, orders, now)


def _resolve_market_structure_id(cfg, structure_id: Optional[int]) -> int:
    if structure_id:
        return int(structure_id)
    structures = cfg.get('structures') or []
    if not structures:
        raise HTTPException(400, 'No configured structures; add one in Config or pass structure_id')
    first = structures[0]
    sid = first.get('id')
    if not sid:
        raise HTTPException(400, 'First configured structure has no id')
    return int(sid)


def _market_stream(structure_id: Optional[int], refresh: bool):
    """Yield NDJSON progress events while fetching the structure market."""
    cfg = load_config()
    try:
        sid = _resolve_market_structure_id(cfg, structure_id)
    except HTTPException as e:
        yield _emit('error', message=e.detail)
        return

    now = time.time()
    cached = _market_cache.get(sid)
    if not refresh and cached and (now - cached['fetched_at']) < _MARKET_TTL_SECONDS:
        summary = _summarize_orders(sid, cached['orders'], cached['fetched_at'])
        yield _emit('done', payload=summary, from_cache=True)
        return

    client_id, secret_key = get_app_credentials()
    try:
        token = get_valid_access_token(client_id, secret_key, get_user_agent())
    except Exception as e:
        yield _emit('error', message=f'Not authenticated: {e}')
        return

    yield _emit('progress', page=0, max_pages=None, orders_so_far=0, message='Connecting to ESI…')

    all_orders: list = []
    try:
        for page, max_pages, batch in fetch_structure_orders_paged(sid, token, get_user_agent()):
            all_orders.extend(batch)
            yield _emit(
                'progress', page=page, max_pages=max_pages,
                orders_so_far=len(all_orders),
                message=f'Page {page} of {max_pages}',
            )
    except Exception as e:
        yield _emit('error', message=f'ESI structure market fetch failed: {e}')
        return

    _market_cache[sid] = {'fetched_at': now, 'orders': all_orders}
    summary = _summarize_orders(sid, all_orders, now)
    yield _emit('done', payload=summary, from_cache=False)


@app.get('/api/aa/market/stream')
def stream_aa_market(structure_id: Optional[int] = None, refresh: bool = False):
    """NDJSON stream of market fetch progress. Emits ``progress`` events per
    page and a final ``done`` event with the aggregated payload (same shape as
    GET /api/aa/market). Errors emit an ``error`` event instead of HTTP 5xx.
    """
    return StreamingResponse(
        _market_stream(structure_id, refresh), media_type='application/x-ndjson',
    )


if __name__ == '__main__':
    uvicorn.run(app, host='127.0.0.1', port=PORT, log_level='info')
