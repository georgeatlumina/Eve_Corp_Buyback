import os
import secrets
import sys
import threading
import time
import webbrowser
from typing import Any, Optional

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
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
from esi import fetch_contract_items, fetch_corp_contracts, fetch_corp_wallets, resolve_names
from refining import compute_refined_payout
from validate import validate_all

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
    refining_efficiency: Optional[float] = None


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


@app.post('/api/validate')
def validate(req: ValidateRequest):
    cfg = load_config()
    contracts = req.contracts
    if contracts is None:
        if not cfg.get('corp_id'):
            raise HTTPException(400, 'Configure corp_id first')
        client_id, secret_key = get_app_credentials()
        try:
            token = get_valid_access_token(client_id, secret_key, get_user_agent())
        except Exception as e:
            raise HTTPException(401, str(e))
        contracts = fetch_corp_contracts(cfg['corp_id'], token, get_user_agent())
    from config import MOON_PAYOUT_FRACTION

    client_id, secret_key = get_app_credentials()
    try:
        moon_token = get_valid_access_token(client_id, secret_key, get_user_agent())
    except Exception:
        moon_token = None

    def moon_payout_lookup(c):
        if moon_token is None:
            raise RuntimeError('Not authenticated; cannot fetch contract items')
        items = fetch_contract_items(
            cfg['corp_id'], c['contract_id'], moon_token, get_user_agent(),
        )
        return compute_refined_payout(
            [{'type_id': i['type_id'], 'quantity': i['quantity']} for i in items],
            cfg.get('moon_market') or 'Jita 4-4',
            float(cfg.get('refining_efficiency') or 0.78),
            MOON_PAYOUT_FRACTION,
            get_user_agent(),
        )

    report = validate_all(
        contracts,
        cfg['corp_id'],
        cfg['structures'],
        janice_market=cfg.get('janice_market') or '',
        janice_api_key=cfg.get('janice_api_key') or None,
        moon_payout_lookup=moon_payout_lookup,
    )

    issuer_ids = (
        {r.get('issuer_id') for r in report['buyback_results']}
        | {r.get('issuer_id') for r in report.get('moon_results', [])}
    )
    try:
        names = resolve_names(issuer_ids, get_user_agent())
    except Exception:
        names = {}
    for r in report['buyback_results']:
        r['issuer_name'] = names.get(r.get('issuer_id'), '')
    for r in report.get('moon_results', []):
        r['issuer_name'] = names.get(r.get('issuer_id'), '')
    return report


if __name__ == '__main__':
    uvicorn.run(app, host='127.0.0.1', port=PORT, log_level='info')
