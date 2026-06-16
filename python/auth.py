import base64
import json
import os
import platform
import time
import urllib.parse

import requests

from config import TOKEN_CACHE_PATH

SSO_AUTHORIZE_URL = 'https://login.eveonline.com/v2/oauth/authorize/'
SSO_TOKEN_URL = 'https://login.eveonline.com/v2/oauth/token'

CLIENT_ID = '66c3890613d54d4aad99f88633e59951'
SECRET_KEY = 'dBGY7C2EZCcrVxCyW1VMXGEZ9XQOe7PdcxEvTvx5'

DEFAULT_SLOT = 'slot1'
# slot4 is dedicated to Hooks & Hubs structure-fuel reads (Director role +
# esi-corporations.read_structures.v1). Kept separate from slots 1-3 so the
# main wallet/contracts character needn't also be a Director.
VALID_SLOTS = ('slot1', 'slot2', 'slot3', 'slot4')


def get_app_credentials():
    return CLIENT_ID, SECRET_KEY


def get_user_agent():
    return (
        f'EveCorpBuyback/1.0 ({platform.system()} {platform.release()}; '
        f'Python {platform.python_version()})'
    )


def build_authorize_url(client_id, redirect_uri, scopes, state):
    params = {
        'response_type': 'code',
        'redirect_uri': redirect_uri,
        'client_id': client_id,
        'scope': ' '.join(scopes),
        'state': state,
    }
    return SSO_AUTHORIZE_URL + '?' + urllib.parse.urlencode(params)


def _post_token(client_id, secret_key, user_agent, data):
    basic = base64.b64encode(f'{client_id}:{secret_key}'.encode()).decode()
    resp = requests.post(
        SSO_TOKEN_URL,
        headers={
            'Authorization': f'Basic {basic}',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Host': 'login.eveonline.com',
            'User-Agent': user_agent,
        },
        data=data,
    )
    resp.raise_for_status()
    return resp.json()


def exchange_code_for_tokens(client_id, secret_key, code, user_agent):
    return _post_token(client_id, secret_key, user_agent, {
        'grant_type': 'authorization_code',
        'code': code,
    })


def refresh_access_token(client_id, secret_key, refresh_token, user_agent):
    return _post_token(client_id, secret_key, user_agent, {
        'grant_type': 'refresh_token',
        'refresh_token': refresh_token,
    })


def _load_all_slots():
    """Read the on-disk cache and return a dict keyed by slot name.

    Migrates the legacy single-record shape ({access_token, refresh_token, ...})
    into {'slot1': <record>} so older installs keep working.
    """
    if not os.path.exists(TOKEN_CACHE_PATH):
        return {}
    with open(TOKEN_CACHE_PATH) as f:
        data = json.load(f)
    if not isinstance(data, dict):
        return {}
    # Legacy shape detection: a flat record has access_token at the top level.
    if 'access_token' in data and not any(k in VALID_SLOTS for k in data):
        return {DEFAULT_SLOT: data}
    # Keep only known slots so config-style keys cannot leak in.
    return {k: v for k, v in data.items() if k in VALID_SLOTS and isinstance(v, dict)}


def _write_all_slots(slots):
    os.makedirs(os.path.dirname(TOKEN_CACHE_PATH), exist_ok=True)
    with open(TOKEN_CACHE_PATH, 'w') as f:
        json.dump(slots, f, indent=2)
    os.chmod(TOKEN_CACHE_PATH, 0o600)


def load_cached_tokens(slot=DEFAULT_SLOT):
    """Return the cached token record for `slot`, or None if absent."""
    slots = _load_all_slots()
    return slots.get(slot)


def save_cached_tokens(tokens, slot=DEFAULT_SLOT):
    slots = _load_all_slots()
    record = dict(tokens)
    record['expires_at'] = time.time() + tokens.get('expires_in', 0)
    slots[slot] = record
    _write_all_slots(slots)


def clear_cached_tokens(slot=DEFAULT_SLOT):
    slots = _load_all_slots()
    if slot in slots:
        del slots[slot]
        _write_all_slots(slots)


def list_authenticated_slots():
    """Return sorted list of slot names that currently hold tokens."""
    slots = _load_all_slots()
    return [s for s in VALID_SLOTS if s in slots]


def get_valid_access_token(client_id, secret_key, user_agent, slot=DEFAULT_SLOT):
    """Return a valid access_token for the given slot, refreshing if needed."""
    cached = load_cached_tokens(slot)
    if not cached:
        raise RuntimeError(f'Not authenticated ({slot}); run login flow first')
    if cached.get('expires_at', 0) > time.time() + 30:
        return cached['access_token']
    if cached.get('refresh_token'):
        tokens = refresh_access_token(client_id, secret_key, cached['refresh_token'], user_agent)
        save_cached_tokens(tokens, slot=slot)
        return tokens['access_token']
    raise RuntimeError(f'No valid token for {slot}; run login flow again')


def decode_jwt_payload(jwt_token):
    payload_b64 = jwt_token.split('.')[1]
    payload_b64 += '=' * (-len(payload_b64) % 4)
    return json.loads(base64.urlsafe_b64decode(payload_b64))


def character_id_from_access_token(access_token):
    payload = decode_jwt_payload(access_token)
    sub = payload.get('sub', '')
    try:
        return int(sub.rsplit(':', 1)[-1])
    except (ValueError, AttributeError):
        return None
