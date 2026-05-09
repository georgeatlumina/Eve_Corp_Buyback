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


def load_cached_tokens():
    if not os.path.exists(TOKEN_CACHE_PATH):
        return None
    with open(TOKEN_CACHE_PATH) as f:
        return json.load(f)


def save_cached_tokens(tokens):
    os.makedirs(os.path.dirname(TOKEN_CACHE_PATH), exist_ok=True)
    record = dict(tokens)
    record['expires_at'] = time.time() + tokens.get('expires_in', 0)
    with open(TOKEN_CACHE_PATH, 'w') as f:
        json.dump(record, f, indent=2)
    os.chmod(TOKEN_CACHE_PATH, 0o600)


def get_valid_access_token(client_id, secret_key, user_agent):
    """Return a valid access_token, refreshing if needed. Raises if not authenticated."""
    cached = load_cached_tokens()
    if not cached:
        raise RuntimeError('Not authenticated; run login flow first')
    if cached.get('expires_at', 0) > time.time() + 30:
        return cached['access_token']
    if cached.get('refresh_token'):
        tokens = refresh_access_token(client_id, secret_key, cached['refresh_token'], user_agent)
        save_cached_tokens(tokens)
        return tokens['access_token']
    raise RuntimeError('No valid token; run login flow again')


def decode_jwt_payload(jwt_token):
    payload_b64 = jwt_token.split('.')[1]
    payload_b64 += '=' * (-len(payload_b64) % 4)
    return json.loads(base64.urlsafe_b64decode(payload_b64))
