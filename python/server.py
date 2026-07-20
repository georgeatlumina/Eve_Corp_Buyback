import gzip
import json
import logging
import os
import secrets
import sys
import threading
import time
import webbrowser
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import requests
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

logger = logging.getLogger(__name__)

from auth import (
    DEFAULT_SLOT,
    VALID_SLOTS,
    build_authorize_url,
    character_id_from_access_token,
    clear_cached_tokens,
    decode_jwt_payload,
    exchange_code_for_tokens,
    get_app_credentials,
    get_user_agent,
    get_valid_access_token,
    list_authenticated_slots,
    load_cached_tokens,
    refresh_access_token,
    save_cached_tokens,
)
from config import load_config, save_config
from esi import (
    fetch_alliance_info,
    fetch_character_info,
    fetch_all_ship_types,
    fetch_character_contract_items,
    fetch_character_contracts,
    fetch_constellation_info,
    fetch_contract_items,
    fetch_corp_contracts,
    fetch_corp_structures,
    fetch_corp_wallets,
    fetch_corporation_info,
    fetch_incursions,
    fetch_region_info,
    fetch_region_market_history,
    fetch_region_market_orders,
    fetch_corp_orders,
    fetch_sovereignty_campaigns,
    fetch_sovereignty_map,
    fetch_sovereignty_structures,
    fetch_station_info,
    fetch_structure_orders,
    fetch_structure_orders_paged,
    fetch_system_info,
    fetch_system_jumps,
    fetch_system_kills,
    resolve_names,
    resolve_ids,
    resolve_type_ids,
    send_evemail,
    fetch_type_info,
    fetch_group_info,
)
from janice import (
    appraise_items,
    create_appraisal,
    create_appraisal_from_text,
    fetch_buy_prices,
    fetch_type_sell_price,
    items_from_appraisal,
)
import builds
import liquidation
import stockpile
from market import enrich as enrich_types, missing_ids as meta_missing_ids
from acquisitions import load_acquisitions, save_acquisitions
from pinned import (
    append_appraisal,
    load_pinned,
    remove_pin,
    update_pin_fields,
    upsert_pin,
)
from refining import compute_refined_payout, is_donation, is_mineable, is_prismaticite, is_refined_output
from validate import categorize, process_moon_contract, validate_all, validate_buyback_contract
from workforce_plan import load_plan, save_plan

PORT = 8765
REDIRECT_URI = f'http://localhost:{PORT}/callback'

app = FastAPI(title='Naval Defence Alliance Management Tool')

_auth_state: dict[str, Any] = {
    # state token -> slot name
    'pending': {},
    # slot -> True/False
    'completed': {},
    # slot -> error string
    'errors': {},
}
_auth_lock = threading.Lock()


def _normalize_slot(slot: Optional[str]) -> str:
    s = slot or DEFAULT_SLOT
    if s not in VALID_SLOTS:
        raise HTTPException(400, f'Invalid slot {s!r}; expected one of {VALID_SLOTS}')
    return s


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
    srp_reject_subject: Optional[str] = None
    srp_reject_body: Optional[str] = None
    link_open_mode: Optional[str] = None
    home_structure_id: Optional[int] = None
    home_region_id: Optional[int] = None
    quotas: Optional[list[dict]] = None
    quotas_institute: Optional[list[dict]] = None
    alliance_id_main: Optional[int] = None
    alliance_id_institute: Optional[int] = None
    alliance_quota_url: Optional[str] = None
    alliance_quota_auto_sync: Optional[bool] = None
    alliance_quota_pat_read: Optional[str] = None
    alliance_quota_pat_write: Optional[str] = None
    alliance_quota_allow_push: Optional[bool] = None
    market_history_repo_url: Optional[str] = None
    market_history_pat_read: Optional[str] = None
    market_history_pat_write: Optional[str] = None
    stockpile_group_name: Optional[str] = None
    stockpile_allow_push: Optional[bool] = None


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


def _slot_status(slot: str) -> dict:
    """Compute current auth state for one slot."""
    client_id, secret_key = get_app_credentials()
    cached = load_cached_tokens(slot)
    if not cached:
        return {'slot': slot, 'authenticated': False, 'character': None}
    if cached.get('expires_at', 0) < time.time() + 30 and cached.get('refresh_token'):
        try:
            tokens = refresh_access_token(
                client_id, secret_key,
                cached['refresh_token'], get_user_agent(),
            )
            save_cached_tokens(tokens, slot=slot)
            cached = load_cached_tokens(slot)
        except Exception as e:
            return {'slot': slot, 'authenticated': False, 'character': None, 'error': str(e)}
    payload = decode_jwt_payload(cached['access_token'])
    return {
        'slot': slot,
        'authenticated': True,
        'character': payload.get('name'),
        'character_id': character_id_from_access_token(cached['access_token']),
        'expires_at': cached.get('expires_at'),
    }


@app.get('/api/auth/status')
def auth_status(slot: Optional[str] = None):
    """Status for one slot (defaults to slot1 — preserves the legacy single-slot shape)."""
    return _slot_status(_normalize_slot(slot))


@app.get('/api/auth/slots')
def auth_slots():
    """Status for every slot — used by the multi-account Auth tab."""
    return {'slots': [_slot_status(s) for s in VALID_SLOTS]}


@app.post('/api/auth/login')
def auth_login(slot: Optional[str] = None):
    cfg = load_config()
    client_id, _ = get_app_credentials()
    slot_name = _normalize_slot(slot)
    state_token = secrets.token_urlsafe(32)
    with _auth_lock:
        _auth_state['pending'][state_token] = slot_name
        _auth_state['completed'][slot_name] = False
        _auth_state['errors'].pop(slot_name, None)
    url = build_authorize_url(
        client_id, REDIRECT_URI, cfg['scopes'], state_token,
    )
    webbrowser.open(url)
    return {'opened': True, 'url': url, 'slot': slot_name}


@app.post('/api/auth/logout')
def auth_logout(slot: Optional[str] = None):
    slot_name = _normalize_slot(slot)
    clear_cached_tokens(slot_name)
    return {'ok': True, 'slot': slot_name}


@app.get('/callback')
def sso_callback(
    code: Optional[str] = None,
    state: Optional[str] = None,
    error: Optional[str] = None,
):
    client_id, secret_key = get_app_credentials()
    with _auth_lock:
        slot_name = _auth_state['pending'].pop(state, None) if state else None
        if error:
            if slot_name:
                _auth_state['errors'][slot_name] = error
            return _callback_page(f'SSO error: {error}')
        if not slot_name:
            return _callback_page('State mismatch — login aborted.')
        try:
            tokens = exchange_code_for_tokens(
                client_id, secret_key, code, get_user_agent(),
            )
            save_cached_tokens(tokens, slot=slot_name)
            _auth_state['completed'][slot_name] = True
        except Exception as e:
            _auth_state['errors'][slot_name] = str(e)
            return _callback_page(f'Token exchange failed: {e}')
    return _callback_page(f'Logged in ({slot_name})! Return to the app.')


class SendMailRequest(BaseModel):
    recipient_id: int
    subject: str
    body: str


def _send_mail_core(recipient_id: int, subject: str, body: str):
    """Shared mail-send path: validate auth/scope on slot1, send to one recipient."""
    if not recipient_id:
        raise HTTPException(400, 'recipient_id is required')
    if not subject.strip() or not body.strip():
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
            character_id, int(recipient_id), subject, body,
            access_token, get_user_agent(),
        )
    except Exception as e:
        raise HTTPException(502, str(e))
    return {'ok': True, 'mail_id': result}


@app.post('/api/mail/send')
def send_mail(req: SendMailRequest):
    """Send an EVE mail from the authenticated character to recipient_id."""
    return _send_mail_core(req.recipient_id, req.subject, req.body)


class SendMailByNameRequest(BaseModel):
    recipient_name: str
    subject: str
    body: str


@app.post('/api/mail/send-by-name')
def send_mail_by_name(req: SendMailByNameRequest):
    """Resolve an EVE character name -> id, then send. Used by the SRP tab's
    auto-rejection mail where we only have the pilot's display name."""
    name = (req.recipient_name or '').strip()
    if not name:
        raise HTTPException(400, 'recipient_name is required')
    try:
        ids = resolve_ids([name], get_user_agent())
    except Exception as e:
        raise HTTPException(502, f'name resolution failed: {e}')
    cid = ids.get(name.lower())
    if not cid:
        raise HTTPException(404, f'Could not resolve character name {name!r} to an ID')
    return _send_mail_core(cid, req.subject, req.body)


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


@app.get('/api/universe/ships')
def get_ship_types(refresh: bool = False):
    """Return every published EVE ship hull (cached to disk indefinitely).

    Used by the Contracts page quota editor to populate a type-ahead dropdown.
    Pass ``?refresh=true`` to invalidate the on-disk cache (e.g. after an EVE
    expansion adds new hulls).
    """
    from config import AUTH_DIR
    path = os.path.join(AUTH_DIR, 'ship_types.json')
    if not refresh and os.path.exists(path):
        try:
            with open(path) as f:
                return {'ships': json.load(f), 'from_cache': True}
        except Exception:
            pass
    try:
        ships = fetch_all_ship_types(get_user_agent())
    except Exception as e:
        raise HTTPException(502, f'Ship types fetch failed: {e}')
    try:
        os.makedirs(AUTH_DIR, exist_ok=True)
        with open(path, 'w') as f:
            json.dump(ships, f)
    except Exception:
        pass
    return {'ships': ships, 'from_cache': False}


class SrpClassifyRequest(BaseModel):
    kill_ids: list[int]


@app.post('/api/srp/classify')
def srp_classify(req: SrpClassifyRequest):
    """Classify a batch of SRP kills by hull + fitted modules (see srp.py).

    Returns {'results': {kill_id: classification}} so the SRP tab can set each
    request's payout category from what was actually fitted (command bursts =>
    Links, remote reps => Logistics) rather than guessing from the hull name.
    """
    from srp import classify_kills
    results = classify_kills(req.kill_ids or [], get_user_agent())
    return {'results': results}


@app.post('/api/srp/classify/stream')
def srp_classify_stream(req: SrpClassifyRequest):
    """Streaming variant of /api/srp/classify. Classifies kills in parallel and
    emits one NDJSON `progress` line per completed kill (done/total/category) so
    the SRP tab can show granular progress, then a final `done` line carrying the
    full {kill_id: classification} map.
    """
    from srp import classify_kills_stream
    ua = get_user_agent()

    def gen():
        results = {}
        for done, total, kid, res in classify_kills_stream(req.kill_ids or [], ua):
            results[kid] = res
            yield _emit(
                'progress', done=done, total=total, kill_id=kid,
                category=res.get('category'), ok=res.get('ok'),
            )
        yield _emit('done', results=results)

    return StreamingResponse(gen(), media_type='application/x-ndjson')


class QuotaSyncRequest(BaseModel):
    url: Optional[str] = None  # falls back to cfg['alliance_quota_url']


def _coerce_quota_row(row):
    """Normalise one quota record. Returns None if it's not usable."""
    if not isinstance(row, dict):
        return None
    try:
        type_id = int(row.get('ship_type_id') or 0)
    except (TypeError, ValueError):
        type_id = 0
    if not type_id:
        return None
    try:
        required = int(row.get('required') or 0)
    except (TypeError, ValueError):
        required = 0
    try:
        fit_id = int(row.get('fit_id') or 0)
    except (TypeError, ValueError):
        fit_id = 0
    return {
        'name': str(row.get('name') or '').strip(),
        'ship_type_id': type_id,
        'ship_name': str(row.get('ship_name') or '').strip(),
        'required': required,
        'title_filter': str(row.get('title_filter') or '').strip(),
        'fit_id': fit_id,
    }


def _extract_quotas_from_payload(payload):
    """Accept several shapes from an alliance-shared file:

      - bare array of quota rows:        [ {...}, {...}, ... ]
      - simple wrapper:                  { "quotas": [ ... ] }
      - reused export envelope:          { "_meta": {...}, "config": {"quotas": [...]} }
      - reused export envelope (flat):   { "_meta": {...}, "quotas": [ ... ] }
    """
    if isinstance(payload, list):
        rows = payload
    elif isinstance(payload, dict):
        if isinstance(payload.get('config'), dict) and isinstance(payload['config'].get('quotas'), list):
            rows = payload['config']['quotas']
        elif isinstance(payload.get('quotas'), list):
            rows = payload['quotas']
        else:
            rows = None
    else:
        rows = None
    if rows is None:
        raise ValueError(
            'expected a JSON array of quotas, or an object with a "quotas" '
            'array (optionally wrapped in {_meta, config}).'
        )
    cleaned = [c for c in (_coerce_quota_row(r) for r in rows) if c]
    return cleaned


def _resolve_gist_page_url(url, user_agent):
    """If `url` is a gist *page* URL (gist.github.com/<user>/<id>[/...]) rather
    than a raw-file URL, hit the GitHub Gists API to discover the first file's
    raw URL and return that. Otherwise return the URL unchanged.

    The "Share" button on a gist hands you the page URL — most users will
    paste that rather than the buried Raw link, so we accept either.
    """
    import re
    m = re.match(
        r'^https?://gist\.github\.com/[^/]+/(?P<id>[0-9a-fA-F]{20,})(?:/.*)?$',
        url,
    )
    if not m:
        return url
    gist_id = m.group('id')
    api = f'https://api.github.com/gists/{gist_id}'
    r = requests.get(
        api,
        headers={'Accept': 'application/vnd.github+json', 'User-Agent': user_agent},
        timeout=15,
    )
    r.raise_for_status()
    data = r.json()
    files = data.get('files') or {}
    if not files:
        raise ValueError(f'gist {gist_id} has no files')
    # Prefer a *.json file if there is one; fall back to the first file.
    json_files = [v for k, v in files.items() if k.lower().endswith('.json')]
    chosen = (json_files or list(files.values()))[0]
    raw = chosen.get('raw_url')
    if not raw:
        raise ValueError(f'gist {gist_id} file {chosen.get("filename")!r} has no raw_url')
    return raw


def _parse_github_blob_url(url):
    """Detect a GitHub repo file URL and return (owner, repo, branch, path).

    Accepted shapes:
      - https://github.com/<owner>/<repo>/blob/<branch>/<path/to/file>
      - https://github.com/<owner>/<repo>/raw/<branch>/<path/to/file>
      - https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path/to/file>
      - https://api.github.com/repos/<owner>/<repo>/contents/<path>?ref=<branch>
      - https://github.com/<owner>/<repo>(.git)?    → defaults branch=main,
        path=quotas.json. Handles the "Clone with HTTPS" URL the user gets
        from GitHub's Code button; pasting it directly is the obvious move.

    Returns None if the URL is something else (gist, arbitrary public URL,
    etc.) — callers fall back to plain HTTPS GET in that case.
    """
    import re
    from urllib.parse import urlparse, parse_qs
    m = re.match(
        r'^https?://github\.com/(?P<owner>[^/]+)/(?P<repo>[^/]+?)/(?:blob|raw)/'
        r'(?P<branch>[^/]+)/(?P<path>.+)$',
        url,
    )
    if m:
        return m.group('owner'), m.group('repo'), m.group('branch'), m.group('path')
    m = re.match(
        r'^https?://raw\.githubusercontent\.com/(?P<owner>[^/]+)/(?P<repo>[^/]+)/'
        r'(?P<branch>[^/]+)/(?P<path>.+)$',
        url,
    )
    if m:
        return m.group('owner'), m.group('repo'), m.group('branch'), m.group('path')
    # Direct Contents API URL (e.g. someone pasted the API link).
    m = re.match(
        r'^https?://api\.github\.com/repos/(?P<owner>[^/]+)/(?P<repo>[^/]+)/contents/(?P<path>[^?#]+)',
        url,
    )
    if m:
        parsed = urlparse(url)
        branch = (parse_qs(parsed.query).get('ref') or ['main'])[0]
        return m.group('owner'), m.group('repo'), branch, m.group('path')
    # Bare repo URL: github.com/<owner>/<repo> with or without trailing .git.
    # Defaults to main/quotas.json — the alliance-quota-sync convention.
    m = re.match(
        r'^https?://github\.com/(?P<owner>[^/]+)/(?P<repo>[^/]+?)(?:\.git)?/?$',
        url,
    )
    if m:
        return m.group('owner'), m.group('repo'), 'main', 'quotas.json'
    return None


def _github_contents_get(owner, repo, branch, path, pat, user_agent):
    """Read one file via the GitHub Contents API.

    Returns ``(decoded_text, sha)`` so the caller can hand the sha back on
    a future PUT (the API requires it for updates to detect conflicts).
    Sends the PAT as a Bearer token when set; works without one for fully
    public repos.
    """
    import base64
    headers = {
        'Accept': 'application/vnd.github+json',
        'User-Agent': user_agent,
        'X-GitHub-Api-Version': '2022-11-28',
    }
    if pat:
        headers['Authorization'] = f'Bearer {pat}'
    api = f'https://api.github.com/repos/{owner}/{repo}/contents/{path}'
    resp = requests.get(api, headers=headers, params={'ref': branch}, timeout=15)
    if resp.status_code == 401 or resp.status_code == 403:
        raise PermissionError(
            f'{resp.status_code} {resp.reason} — '
            f'{"GitHub rejected the PAT — it may be expired, lack read access to this repo, or be missing the Contents: read scope" if pat else "private repo — set a read PAT in Config"}'
        )
    if resp.status_code == 404:
        raise FileNotFoundError(
            f'404 — file not found: {owner}/{repo}@{branch}:{path} '
            f'{"(does the PAT have access to this repo?)" if pat else "(or repo is private — set a read PAT)"}'
        )
    resp.raise_for_status()
    body = resp.json()
    if isinstance(body, list):
        raise ValueError(f'{path} is a directory, not a file — give the URL of the JSON file inside it')
    content_b64 = (body.get('content') or '').replace('\n', '')
    if not content_b64:
        raise ValueError(f'response had no content for {path!r}')
    try:
        text = base64.b64decode(content_b64).decode('utf-8')
    except Exception as e:
        raise ValueError(f'failed to decode file body: {e}')
    return text, body.get('sha')


def _github_contents_put(owner, repo, branch, path, text, sha, pat, user_agent, message):
    """Write/replace one file via the GitHub Contents API.

    ``sha`` is required when updating an existing file (we fetch it via
    _github_contents_get first); pass None to create a new file. Returns
    the new commit's sha + the file's new blob sha.
    """
    import base64
    headers = {
        'Accept': 'application/vnd.github+json',
        'User-Agent': user_agent,
        'X-GitHub-Api-Version': '2022-11-28',
        'Authorization': f'Bearer {pat}',
    }
    api = f'https://api.github.com/repos/{owner}/{repo}/contents/{path}'
    body = {
        'message': message,
        'content': base64.b64encode(text.encode('utf-8')).decode('ascii'),
        'branch': branch,
    }
    if sha:
        body['sha'] = sha
    resp = requests.put(api, headers=headers, json=body, timeout=20)
    if resp.status_code == 401 or resp.status_code == 403:
        raise PermissionError(
            f'{resp.status_code} {resp.reason} — GitHub rejected the write PAT. '
            'Check that alliance_quota_pat_write in Config has Contents: read+write permission on this repo. '
            '("Allow push from this machine" is a separate app toggle and does not grant GitHub access.)'
        )
    if resp.status_code == 409:
        raise RuntimeError(
            'Conflict (HTTP 409) — someone else pushed in between our read '
            'and write. Pull / sync, then push again.'
        )
    if resp.status_code >= 400:
        # Surface the GitHub error message verbatim — they're usually clear
        # ("Invalid request", "branch does not exist", etc.).
        try:
            msg = resp.json().get('message') or resp.text
        except Exception:
            msg = resp.text
        raise RuntimeError(f'{resp.status_code} {resp.reason} — {msg}')
    out = resp.json() or {}
    return {
        'commit_sha': (out.get('commit') or {}).get('sha'),
        'commit_html_url': (out.get('commit') or {}).get('html_url'),
        'blob_sha': (out.get('content') or {}).get('sha'),
    }


def _github_contents_list(owner, repo, branch, dirpath, pat, user_agent):
    """List the files in one directory via the GitHub Contents API.

    Returns ``[{name, path, sha}, …]`` for the files it contains. An empty list
    is returned when the directory doesn't exist yet (404) — callers treat that
    as "no builds published". Only regular files are returned (sub-dirs skipped).
    """
    headers = {
        'Accept': 'application/vnd.github+json',
        'User-Agent': user_agent,
        'X-GitHub-Api-Version': '2022-11-28',
    }
    if pat:
        headers['Authorization'] = f'Bearer {pat}'
    api = f'https://api.github.com/repos/{owner}/{repo}/contents/{dirpath}'
    resp = requests.get(api, headers=headers, params={'ref': branch}, timeout=15)
    if resp.status_code == 404:
        return []
    if resp.status_code in (401, 403):
        raise PermissionError(
            f'{resp.status_code} {resp.reason} — '
            f'{"GitHub rejected the PAT for this repo" if pat else "private repo — set a read PAT in Config"}'
        )
    resp.raise_for_status()
    body = resp.json()
    if not isinstance(body, list):
        return []
    return [
        {'name': e.get('name'), 'path': e.get('path'), 'sha': e.get('sha')}
        for e in body
        if e.get('type') == 'file' and str(e.get('name') or '').endswith('.json')
    ]


def _sync_quotas_from_url(url, cfg, persist=True):
    """Fetch `url`, parse, validate, optionally write to config. Returns the
    new quota list and a short status string (used for last-sync metadata).

    URL routing:
      - github.com/<owner>/<repo>/blob/<branch>/<path>     → Contents API + read PAT
      - raw.githubusercontent.com/<owner>/<repo>/...        → same path (auth works
        on raw too, but Contents API is consistent + returns sha for push)
      - api.github.com/repos/<owner>/<repo>/contents/<path> → Contents API direct
      - gist.github.com/<user>/<id> → resolved to a raw gist URL
      - gist.githubusercontent.com/.../raw/...               → unauth GET
      - any other URL → unauth GET, expects JSON body
    """
    if not url or not url.strip():
        raise ValueError('alliance_quota_url is not set')
    url = url.strip()
    if not (url.startswith('https://') or url.startswith('http://')):
        raise ValueError(f'alliance_quota_url must start with http(s):// (got {url!r})')
    ua = get_user_agent()
    blob = _parse_github_blob_url(url)
    if blob:
        owner, repo, branch, path = blob
        pat = (cfg.get('alliance_quota_pat_read') or cfg.get('alliance_quota_pat_write') or '').strip()
        try:
            text, _sha = _github_contents_get(owner, repo, branch, path, pat or None, ua)
        except PermissionError as e:
            raise ValueError(str(e))
        except FileNotFoundError as e:
            raise ValueError(str(e))
        try:
            payload = json.loads(text)
        except ValueError:
            raise ValueError('repo file body was not valid JSON')
    else:
        fetch_url = _resolve_gist_page_url(url, ua)
        resp = requests.get(
            fetch_url,
            headers={'Accept': 'application/json', 'User-Agent': ua},
            timeout=15,
        )
        resp.raise_for_status()
        try:
            payload = resp.json()
        except ValueError:
            # Some hosts serve JSON as text/plain; resp.json() already handles
            # encoding but invalid JSON content raises here.
            raise ValueError('response was not valid JSON')
    quotas = _extract_quotas_from_payload(payload)
    if persist:
        cfg['quotas'] = quotas
        cfg['alliance_quota_url'] = url
        cfg['alliance_quota_last_synced'] = datetime.now(timezone.utc).isoformat()
        cfg['alliance_quota_last_status'] = f'ok — {len(quotas)} quota row(s)'
        save_config(cfg)
    return quotas


@app.post('/api/quotas/sync')
def sync_quotas(req: QuotaSyncRequest):
    """Pull the alliance quota JSON from a public URL (typically a GitHub
    gist raw link) and replace this user's quotas with the fetched list.

    Server-side fetch avoids renderer-side CORS surprises, lets future
    versions add auth headers if needed, and gives us one validation
    pathway for both manual and auto-sync triggers.
    """
    cfg = load_config()
    url = (req.url or cfg.get('alliance_quota_url') or '').strip()
    try:
        quotas = _sync_quotas_from_url(url, cfg)
    except requests.exceptions.RequestException as e:
        # Persist the failure so the UI can surface it on next load.
        cfg = load_config()  # reload — _sync_quotas_from_url may have mutated then failed mid-write
        cfg['alliance_quota_url'] = url or cfg.get('alliance_quota_url', '')
        cfg['alliance_quota_last_status'] = f'fetch failed: {e}'
        save_config(cfg)
        raise HTTPException(502, f'Fetch failed: {e}')
    except (ValueError, KeyError) as e:
        cfg = load_config()
        cfg['alliance_quota_url'] = url or cfg.get('alliance_quota_url', '')
        cfg['alliance_quota_last_status'] = f'parse failed: {e}'
        save_config(cfg)
        raise HTTPException(400, f'Invalid quota file: {e}')
    return {'quotas': quotas, 'config': load_config()}


class QuotaPushRequest(BaseModel):
    url: Optional[str] = None              # falls back to cfg['alliance_quota_url']
    quotas: Optional[list[dict]] = None    # falls back to cfg['quotas']
    message: Optional[str] = None          # commit message; sensible default if blank


@app.post('/api/quotas/push')
def push_quotas(req: QuotaPushRequest):
    """Write the current quotas back to the configured GitHub repo via the
    Contents API, using the read+write PAT in config.

    Refuses to run unless ``alliance_quota_allow_push`` is true in config —
    the UI gates this behind a checkbox so a non-admin user who imported
    the admin's exported config (with the write PAT) doesn't accidentally
    push from their own machine. Only github.com / api.github.com URLs are
    accepted as push targets; gist URLs are not supported (push to a gist
    requires a different API).
    """
    cfg = load_config()
    if not cfg.get('alliance_quota_allow_push'):
        raise HTTPException(403, 'Push is disabled on this machine. Tick "Allow push from this machine" in Config to enable.')
    url = (req.url or cfg.get('alliance_quota_url') or '').strip()
    if not url:
        raise HTTPException(400, 'alliance_quota_url is not set')
    blob = _parse_github_blob_url(url)
    if not blob:
        raise HTTPException(400, 'Push is only supported for github.com repo file URLs. Gist push is not supported here — convert the gist to a private repo first.')
    owner, repo, branch, path = blob
    write_pat = (cfg.get('alliance_quota_pat_write') or '').strip()
    if not write_pat:
        raise HTTPException(400, 'alliance_quota_pat_write is not set — provide a PAT with Contents: read+write permission on this repo.')
    quotas = req.quotas if req.quotas is not None else (cfg.get('quotas') or [])
    if not isinstance(quotas, list):
        raise HTTPException(400, 'quotas must be a list')
    # Re-coerce so a manually-pushed list still gets the canonical shape.
    quotas = [c for c in (_coerce_quota_row(r) for r in quotas) if c]
    text = json.dumps(quotas, indent=2) + '\n'
    ua = get_user_agent()
    # We need the current blob sha to update an existing file. None means
    # "create new" — _github_contents_get raises FileNotFoundError on 404
    # so we catch that and pass sha=None to create.
    sha: Optional[str] = None
    try:
        _existing_text, sha = _github_contents_get(owner, repo, branch, path, write_pat, ua)
    except FileNotFoundError:
        sha = None  # file doesn't exist yet; let PUT create it
    except PermissionError as e:
        raise HTTPException(403, f'Push failed at read step: {e}')
    except requests.exceptions.RequestException as e:
        raise HTTPException(502, f'Push failed at read step: {e}')
    message = (req.message or '').strip() or f'Update quotas — {len(quotas)} row(s)'
    try:
        result = _github_contents_put(
            owner, repo, branch, path, text, sha, write_pat, ua, message,
        )
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except RuntimeError as e:
        raise HTTPException(409 if 'Conflict' in str(e) else 502, str(e))
    except requests.exceptions.RequestException as e:
        raise HTTPException(502, f'Push failed: {e}')

    cfg['alliance_quota_last_synced'] = datetime.now(timezone.utc).isoformat()
    cfg['alliance_quota_last_status'] = (
        f'push ok — {len(quotas)} row(s), commit {result["commit_sha"][:7] if result.get("commit_sha") else "?"}'
    )
    save_config(cfg)
    return {
        'pushed_rows': len(quotas),
        'commit_sha': result.get('commit_sha'),
        'commit_html_url': result.get('commit_html_url'),
        'config': load_config(),
    }


@app.get('/api/region/from-station')
def region_from_station(station_id: int):
    """Helper for the Config tab: derive a region_id from an NPC station id.

    Does NOT work for player structures (citadels) — those need character access
    and the user must enter the region_id manually for structure-end markets.
    """
    ua = get_user_agent()
    try:
        st = fetch_station_info(int(station_id), ua)
        sysinfo = fetch_system_info(st['system_id'], ua)
        const = fetch_constellation_info(sysinfo['constellation_id'], ua)
        return {
            'station_id': int(station_id),
            'station_name': st.get('name'),
            'system_id': sysinfo.get('system_id'),
            'system_name': sysinfo.get('name'),
            'region_id': const.get('region_id'),
        }
    except Exception as e:
        raise HTTPException(502, f'Lookup failed: {e}')


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
    moon_dropped = 0  # contracts hidden because they contain non-mining items

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
            # Accept raw ore/moon ore/ice (is_mineable) AND their refined outputs
            # (minerals, moon materials, ice products). Anything else makes the
            # contract non-conforming and the moon loop will drop it from the stream.
            ua = get_user_agent()
            bad = [
                i for i in items_named
                if not is_mineable(i['type_id'], ua)
                   and not is_refined_output(i['type_id'], ua)
            ]

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
                    janice_api_key=janice_key,
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

        # Hard filter: contracts with any non-mining items don't belong in the
        # Moon tab. The count is reported on `done` so the renderer can show
        # "N hidden" under the moon header.
        mo = (result.get('checks') or {}).get('mineable_only')
        if mo and not mo.get('pass'):
            moon_dropped += 1
            continue

        yield _emit('moon_result', current=idx, total=total_moon, result=result)

    yield _emit('done', moon_dropped=moon_dropped)


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


def _analyze_orders(structure_id: int, orders: list, fetched_at: float, type_meta: dict) -> dict:
    """Fold the full (buy + sell) order book into per-type analytics rows plus
    market-wide totals. Snapshot only — no history. Each row carries name +
    group + category from the Fuzzwork type index so the renderer can search
    and filter without per-type ESI calls."""
    by_type: dict[int, dict] = {}
    for o in orders:
        tid = o.get('type_id')
        if not tid:
            continue
        tid = int(tid)
        price = float(o.get('price') or 0)
        vol = int(o.get('volume_remain') or 0)
        e = by_type.get(tid)
        if e is None:
            e = by_type[tid] = {
                'type_id': tid,
                'best_sell': None, 'sell_orders': 0, 'sell_units': 0, 'sell_value': 0.0,
                'best_buy': None, 'buy_orders': 0, 'buy_units': 0, 'buy_value': 0.0,
            }
        if o.get('is_buy_order'):
            e['buy_orders'] += 1
            e['buy_units'] += vol
            e['buy_value'] += price * vol
            if e['best_buy'] is None or price > e['best_buy']:
                e['best_buy'] = price
        else:
            e['sell_orders'] += 1
            e['sell_units'] += vol
            e['sell_value'] += price * vol
            if e['best_sell'] is None or price < e['best_sell']:
                e['best_sell'] = price

    rows = []
    totals = {
        'types': 0, 'orders': len(orders),
        'sell_orders': 0, 'buy_orders': 0,
        'total_sell_value': 0.0, 'total_buy_value': 0.0,
    }
    for tid, e in by_type.items():
        meta = type_meta.get(tid) or {}
        spread = spread_pct = None
        if e['best_sell'] is not None and e['best_buy'] is not None:
            spread = e['best_sell'] - e['best_buy']
            if e['best_sell']:
                spread_pct = round(spread / e['best_sell'] * 100, 2)
        rows.append({
            **e,
            'name': meta.get('name', ''),
            'group_name': meta.get('group_name', ''),
            'category_name': meta.get('category_name', ''),
            'spread': spread,
            'spread_pct': spread_pct,
        })
        totals['sell_orders'] += e['sell_orders']
        totals['buy_orders'] += e['buy_orders']
        totals['total_sell_value'] += e['sell_value']
        totals['total_buy_value'] += e['buy_value']
    totals['types'] = len(rows)
    return {
        'structure_id': structure_id,
        'fetched_at': fetched_at,
        'totals': totals,
        'rows': rows,
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


def _analytics_stream(structure_id: Optional[int], refresh: bool):
    """Yield NDJSON progress events while fetching the structure order book,
    then a `done` event with the full per-type analytics payload."""
    cfg = load_config()
    try:
        sid = _resolve_market_structure_id(cfg, structure_id)
    except HTTPException as e:
        yield _emit('error', message=e.detail)
        return

    now = time.time()
    cached = _market_cache.get(sid)
    use_cache = bool(not refresh and cached and (now - cached['fetched_at']) < _MARKET_TTL_SECONDS)

    if use_cache:
        orders = cached['orders']
        fetched_at = cached['fetched_at']
    else:
        client_id, secret_key = get_app_credentials()
        try:
            token = get_valid_access_token(client_id, secret_key, get_user_agent())
        except Exception as e:
            yield _emit('error', message=f'Not authenticated: {e}')
            return
        yield _emit('progress', page=0, max_pages=None, orders_so_far=0, message='Connecting to ESI…')
        orders = []
        try:
            for page, max_pages, batch in fetch_structure_orders_paged(sid, token, get_user_agent()):
                orders.extend(batch)
                yield _emit('progress', page=page, max_pages=max_pages,
                            orders_so_far=len(orders), message=f'Page {page} of {max_pages}')
        except Exception as e:
            yield _emit('error', message=f'ESI structure market fetch failed: {e}')
            return
        _market_cache[sid] = {'fetched_at': now, 'orders': orders}
        fetched_at = now

    # Resolve names + market categories from ESI. Already-seen types come from
    # the on-disk cache instantly; only brand-new types cost ESI calls.
    type_ids = {int(o['type_id']) for o in orders if o.get('type_id')}
    n_missing = len(meta_missing_ids(type_ids))
    if n_missing:
        yield _emit('progress', page=None, max_pages=None, orders_so_far=len(orders),
                    message=f'Resolving names & categories for {n_missing} new items (first run only, please wait)…')
    try:
        type_meta = enrich_types(type_ids, get_user_agent())
    except Exception as e:
        yield _emit('error', message=f'Failed to resolve item metadata: {e}')
        return

    payload = _analyze_orders(sid, orders, fetched_at, type_meta)
    yield _emit('done', payload=payload, from_cache=use_cache)


@app.get('/api/market/analytics/stream')
def stream_market_analytics(structure_id: Optional[int] = None, refresh: bool = False):
    """NDJSON stream of the structure market analytics. Emits `progress` per
    page, then a `done` event with `{structure_id, fetched_at, totals, rows}`.
    Snapshot only (no history). Reuses the shared 5-minute structure-market
    cache that backs the AA market view."""
    return StreamingResponse(
        _analytics_stream(structure_id, refresh), media_type='application/x-ndjson',
    )


def _github_path_sha(owner, repo, branch, path, pat, user_agent):
    """Return a file's blob sha, or None if it doesn't exist (404). Used to make
    the daily archive idempotent without decoding the (binary) body."""
    headers = {
        'Accept': 'application/vnd.github+json',
        'User-Agent': user_agent,
        'X-GitHub-Api-Version': '2022-11-28',
    }
    if pat:
        headers['Authorization'] = f'Bearer {pat}'
    api = f'https://api.github.com/repos/{owner}/{repo}/contents/{path}'
    resp = requests.get(api, headers=headers, params={'ref': branch}, timeout=15)
    if resp.status_code == 404:
        return None
    if resp.status_code in (401, 403):
        raise PermissionError(f'{resp.status_code} {resp.reason} — PAT rejected for {owner}/{repo}')
    resp.raise_for_status()
    body = resp.json()
    if isinstance(body, list):
        return None
    return body.get('sha')


def _github_put_bytes(owner, repo, branch, path, raw_bytes, sha, pat, user_agent, message):
    """Write/replace a binary file via the Contents API (base64 of raw bytes).
    Sibling of _github_contents_put for arbitrary bytes (e.g. gzip)."""
    import base64
    headers = {
        'Accept': 'application/vnd.github+json',
        'User-Agent': user_agent,
        'X-GitHub-Api-Version': '2022-11-28',
        'Authorization': f'Bearer {pat}',
    }
    api = f'https://api.github.com/repos/{owner}/{repo}/contents/{path}'
    body = {'message': message, 'content': base64.b64encode(raw_bytes).decode('ascii'), 'branch': branch}
    if sha:
        body['sha'] = sha
    resp = requests.put(api, headers=headers, json=body, timeout=30)
    if resp.status_code in (401, 403):
        raise PermissionError(f'{resp.status_code} {resp.reason} — write PAT rejected (needs Contents: read+write on this repo)')
    if resp.status_code == 409:
        raise RuntimeError('409 conflict — file changed between read and write')
    if resp.status_code >= 400:
        try:
            msg = resp.json().get('message') or resp.text
        except Exception:
            msg = resp.text
        raise RuntimeError(f'{resp.status_code} {resp.reason} — {msg}')
    out = resp.json() or {}
    return {'commit_html_url': (out.get('commit') or {}).get('html_url')}


def _market_history_summary(orders: list) -> dict:
    """Compact per-type fold for the archive (no names/ESI). Keeps phase-2
    history reads cheap so they needn't re-parse the full depth."""
    per_type: dict[str, dict] = {}
    total_sell = total_buy = 0.0
    for o in orders:
        tid = o.get('type_id')
        if not tid:
            continue
        key = str(int(tid))
        price = float(o.get('price') or 0)
        vol = int(o.get('volume_remain') or 0)
        e = per_type.get(key)
        if e is None:
            e = per_type[key] = {'best_sell': None, 'best_buy': None,
                                 'sell_units': 0, 'buy_units': 0,
                                 'sell_orders': 0, 'buy_orders': 0}
        if o.get('is_buy_order'):
            e['buy_orders'] += 1
            e['buy_units'] += vol
            total_buy += price * vol
            if e['best_buy'] is None or price > e['best_buy']:
                e['best_buy'] = price
        else:
            e['sell_orders'] += 1
            e['sell_units'] += vol
            total_sell += price * vol
            if e['best_sell'] is None or price < e['best_sell']:
                e['best_sell'] = price
    return {
        'total_sell_value': total_sell,
        'total_buy_value': total_buy,
        'types': len(per_type),
        'per_type': per_type,
    }


@app.post('/api/market/history/archive')
def archive_market_history(structure_id: Optional[int] = None, force: bool = False):
    """Push today's full-depth market snapshot (gzipped) to the configured
    history repo, one file per day at market-history/<structure_id>/<date>.json.gz.

    Opportunistic + idempotent: every client may call this on tab load. It
    no-ops if (a) <24h since the last push from this machine, or (b) today's
    file already exists in the repo (incl. a 409 race with another client).
    Returns `{archived: bool, reason, ...}`; never raises on the no-op paths."""
    cfg = load_config()
    repo_url = (cfg.get('market_history_repo_url') or '').strip()
    pat = (cfg.get('market_history_pat_write') or '').strip()
    if not repo_url or not pat:
        return {'archived': False, 'reason': 'not_configured'}
    parsed = _parse_github_blob_url(repo_url)
    if not parsed:
        return {'archived': False, 'reason': 'bad_repo_url'}
    owner, repo, branch, _ = parsed

    now = datetime.now(timezone.utc)
    today = now.strftime('%Y-%m-%d')
    last = cfg.get('market_history_last_archived') or ''
    if not force and last:
        try:
            last_dt = datetime.fromisoformat(last)
            if last_dt.tzinfo is None:
                last_dt = last_dt.replace(tzinfo=timezone.utc)
            if (now - last_dt).total_seconds() < 24 * 3600:
                return {'archived': False, 'reason': 'recent', 'last_archived': last}
        except ValueError:
            pass

    try:
        sid = _resolve_market_structure_id(cfg, structure_id)
    except HTTPException as e:
        return {'archived': False, 'reason': 'no_structure', 'detail': e.detail}

    cached = _market_cache.get(sid)
    if cached:
        orders, fetched_at = cached['orders'], cached['fetched_at']
    else:
        client_id, secret_key = get_app_credentials()
        try:
            token = get_valid_access_token(client_id, secret_key, get_user_agent())
            orders = fetch_structure_orders(sid, token, get_user_agent())
        except Exception as e:
            return {'archived': False, 'reason': 'fetch_failed', 'detail': str(e)}
        fetched_at = time.time()
        _market_cache[sid] = {'fetched_at': fetched_at, 'orders': orders}

    path = f'market-history/{sid}/{today}.json.gz'
    ua = get_user_agent()
    try:
        existing = _github_path_sha(owner, repo, branch, path, pat, ua)
    except Exception as e:
        return {'archived': False, 'reason': 'check_failed', 'detail': str(e)}
    if existing and not force:
        cfg['market_history_last_archived'] = now.isoformat()
        save_config(cfg)
        return {'archived': False, 'reason': 'already_exists', 'path': path}

    snapshot = {
        'date': today,
        'structure_id': sid,
        'fetched_at': fetched_at,
        'order_count': len(orders),
        'summary': _market_history_summary(orders),
        'orders': orders,
    }
    raw = gzip.compress(json.dumps(snapshot, separators=(',', ':')).encode('utf-8'))
    try:
        result = _github_put_bytes(owner, repo, branch, path, raw, existing, pat, ua,
                                   f'Market snapshot {today} (structure {sid})')
    except RuntimeError as e:
        if '409' in str(e):  # another client wrote it first — fine, treat as done
            cfg['market_history_last_archived'] = now.isoformat()
            save_config(cfg)
            return {'archived': False, 'reason': 'race_already_exists', 'path': path}
        return {'archived': False, 'reason': 'put_failed', 'detail': str(e)}
    except Exception as e:
        return {'archived': False, 'reason': 'put_failed', 'detail': str(e)}

    cfg['market_history_last_archived'] = now.isoformat()
    save_config(cfg)
    return {'archived': True, 'path': path, 'bytes': len(raw),
            'commit': result.get('commit_html_url')}


# ----------------------- Market history: turnover (net on-book change) --------
# Reads back the daily snapshot archive (one gzipped file per day per structure)
# and reports the change in listed sell/buy value over 24h / 72h / weekly /
# monthly windows. These are ORDER-BOOK snapshots, not trades, so "turnover"
# here = net change in listed (on-book) value between the window's endpoints —
# not measured trade volume. Only the per-day `summary` totals are read (the
# archive includes them precisely so history reads stay cheap).

# (key, days-back) for the four windows surfaced on the Market tab.
DEFAULT_TURNOVER_WINDOWS = (('24h', 1), ('72h', 3), ('weekly', 7), ('monthly', 30))

# Immutable-per-date, so cache parsed summaries for the process lifetime.
_market_history_cache: dict[tuple, dict] = {}


def _github_list_dir(owner, repo, branch, path, pat, user_agent):
    """List a directory via the Contents API. Returns the raw entry list
    (each has `name`, `path`, `size`, ...), or [] if the path doesn't exist."""
    headers = {
        'Accept': 'application/vnd.github+json',
        'User-Agent': user_agent,
        'X-GitHub-Api-Version': '2022-11-28',
    }
    if pat:
        headers['Authorization'] = f'Bearer {pat}'
    api = f'https://api.github.com/repos/{owner}/{repo}/contents/{path}'
    resp = requests.get(api, headers=headers, params={'ref': branch}, timeout=20)
    if resp.status_code == 404:
        return []
    if resp.status_code in (401, 403):
        raise PermissionError(f'{resp.status_code} {resp.reason} — read PAT rejected for {owner}/{repo}')
    resp.raise_for_status()
    body = resp.json()
    return body if isinstance(body, list) else []


def _github_get_bytes(owner, repo, branch, path, pat, user_agent):
    """Fetch a file's raw bytes via the Contents API raw media type (works for
    files over the 1 MB base64 cap, unlike the default JSON response)."""
    headers = {
        'Accept': 'application/vnd.github.raw',
        'User-Agent': user_agent,
        'X-GitHub-Api-Version': '2022-11-28',
    }
    if pat:
        headers['Authorization'] = f'Bearer {pat}'
    api = f'https://api.github.com/repos/{owner}/{repo}/contents/{path}'
    resp = requests.get(api, headers=headers, params={'ref': branch}, timeout=30)
    if resp.status_code in (401, 403):
        raise PermissionError(f'{resp.status_code} {resp.reason} — read PAT rejected for {owner}/{repo}')
    resp.raise_for_status()
    return resp.content


def _load_history_summary(owner, repo, branch, sid, date_str, pat, user_agent):
    """Return the cheap `{total_sell_value, total_buy_value, types}` summary for
    one archived day, decompressing only as needed and caching per (sid, date)."""
    ck = (sid, date_str)
    if ck in _market_history_cache:
        return _market_history_cache[ck]
    raw = _github_get_bytes(owner, repo, branch, f'market-history/{sid}/{date_str}.json.gz', pat, user_agent)
    snap = json.loads(gzip.decompress(raw).decode('utf-8'))
    summ = snap.get('summary') or {}
    out = {
        'total_sell_value': float(summ.get('total_sell_value') or 0),
        'total_buy_value': float(summ.get('total_buy_value') or 0),
        'types': summ.get('types'),
    }
    _market_history_cache[ck] = out
    return out


def _select_baselines(dates_sorted, windows):
    """Pure: for each (key, days) window pick the baseline date = the most recent
    snapshot on/before (latest - days). Returns {key: (days, baseline|None, coverage)}.

    coverage: 'ok' (a snapshot old enough exists), 'partial' (none that old, so the
    oldest available is used), or 'insufficient' (<2 snapshots — no delta possible)."""
    result = {}
    if not dates_sorted:
        return result
    parsed = [(d, datetime.fromisoformat(d).date().toordinal()) for d in dates_sorted]
    latest_ord = parsed[-1][1]
    for key, days in windows:
        target = latest_ord - days
        base = None
        for d, o in parsed:
            if o <= target:
                base = d
            else:
                break
        if base is not None:
            result[key] = (days, base, 'ok')
        elif len(dates_sorted) >= 2:
            result[key] = (days, dates_sorted[0], 'partial')
        else:
            result[key] = (days, None, 'insufficient')
    return result


def _compute_turnover(dates_sorted, summaries, windows=DEFAULT_TURNOVER_WINDOWS):
    """Pure: net on-book change per window. `summaries` must contain the latest
    date plus every baseline `_select_baselines` picks. Returns a list of window
    rows with latest/baseline values and signed deltas (+ % change)."""
    if not dates_sorted:
        return []
    latest = dates_sorted[-1]
    lat = summaries[latest]
    latest_ord = datetime.fromisoformat(latest).date().toordinal()
    sel = _select_baselines(dates_sorted, windows)
    out = []
    for key, days in windows:
        _days, base, coverage = sel[key]
        row = {
            'key': key, 'days': days, 'coverage': coverage,
            'latest_sell_value': lat['total_sell_value'],
            'latest_buy_value': lat['total_buy_value'],
            'baseline_date': base,
        }
        if base is None:
            row.update({'span_days': None, 'baseline_sell_value': None, 'baseline_buy_value': None,
                        'delta_sell_value': None, 'delta_buy_value': None, 'pct_sell': None, 'pct_buy': None})
        else:
            b = summaries[base]
            ds = lat['total_sell_value'] - b['total_sell_value']
            db = lat['total_buy_value'] - b['total_buy_value']
            row.update({
                'span_days': latest_ord - datetime.fromisoformat(base).date().toordinal(),
                'baseline_sell_value': b['total_sell_value'],
                'baseline_buy_value': b['total_buy_value'],
                'delta_sell_value': ds,
                'delta_buy_value': db,
                'pct_sell': None if not b['total_sell_value'] else round(ds / b['total_sell_value'] * 100, 2),
                'pct_buy': None if not b['total_buy_value'] else round(db / b['total_buy_value'] * 100, 2),
            })
        out.append(row)
    return out


@app.get('/api/market/history/turnover')
def market_history_turnover(structure_id: Optional[int] = None):
    """Net on-book change over 24h / 72h / weekly / monthly, read from the daily
    snapshot archive. No-ops gracefully when the history repo isn't configured or
    too few snapshots have accumulated yet (the dashboard fills in over time)."""
    cfg = load_config()
    repo_url = (cfg.get('market_history_repo_url') or '').strip()
    pat = (cfg.get('market_history_pat_read') or cfg.get('market_history_pat_write') or '').strip()
    if not repo_url or not pat:
        return {'configured': False, 'reason': 'not_configured', 'windows': []}
    parsed = _parse_github_blob_url(repo_url)
    if not parsed:
        return {'configured': False, 'reason': 'bad_repo_url', 'windows': []}
    owner, repo, branch, _ = parsed
    try:
        sid = _resolve_market_structure_id(cfg, structure_id)
    except HTTPException as e:
        return {'configured': True, 'reason': 'no_structure', 'detail': e.detail, 'windows': []}

    ua = get_user_agent()
    try:
        entries = _github_list_dir(owner, repo, branch, f'market-history/{sid}', pat, ua)
    except PermissionError as e:
        return {'configured': True, 'reason': 'pat_rejected', 'detail': str(e), 'windows': []}
    except Exception as e:
        return {'configured': True, 'reason': 'list_failed', 'detail': str(e), 'windows': []}

    # File names are '<YYYY-MM-DD>.json.gz'; keep only well-formed dates.
    dates = []
    for ent in entries:
        name = ent.get('name') or ''
        if name.endswith('.json.gz'):
            stem = name[:-8]
            try:
                datetime.fromisoformat(stem)
                dates.append(stem)
            except ValueError:
                continue
    dates.sort()
    if not dates:
        return {'configured': True, 'structure_id': sid, 'snapshots': 0, 'windows': []}

    sel = _select_baselines(dates, DEFAULT_TURNOVER_WINDOWS)
    needed = {dates[-1]}
    for _days, base, _cov in sel.values():
        if base:
            needed.add(base)
    summaries = {}
    for d in needed:
        try:
            summaries[d] = _load_history_summary(owner, repo, branch, sid, d, pat, ua)
        except Exception as e:
            return {'configured': True, 'reason': 'fetch_failed', 'detail': f'{d}: {e}', 'windows': []}

    return {
        'configured': True,
        'structure_id': sid,
        'snapshots': len(dates),
        'latest_date': dates[-1],
        'available_dates': dates,
        'windows': _compute_turnover(dates, summaries, DEFAULT_TURNOVER_WINDOWS),
    }


_AMARR_SYSTEM_ID = 30002187
_AMARR_REGION_ID = 10000043
_amarr_price_cache: dict[int, dict] = {}
_AMARR_PRICE_TTL = 300  # 5 min


@app.get('/api/market/amarr-sell')
def get_amarr_sell_price(type_id: int, bust: bool = False):
    """Return the Amarr sell price for a type. Uses Janice when an API key is configured,
    otherwise falls back to ESI market orders. Cached 5 min; bust=1 forces a fresh fetch."""
    now = time.time()
    if not bust:
        cached = _amarr_price_cache.get(type_id)
        if cached and (now - cached['fetched_at']) < _AMARR_PRICE_TTL:
            return cached['result']

    cfg = load_config()
    api_key = cfg.get('janice_api_key') or None

    if api_key:
        try:
            min_sell = fetch_type_sell_price(type_id, 'Amarr', api_key=api_key)
        except Exception as e:
            raise HTTPException(502, f'Janice price lookup failed: {e}')
    else:
        try:
            orders = fetch_region_market_orders(_AMARR_REGION_ID, type_id, get_user_agent())
        except Exception as e:
            raise HTTPException(502, f'ESI market fetch failed: {e}')
        amarr_orders = [o for o in orders if not o.get('is_buy_order') and int(o.get('system_id') or 0) == _AMARR_SYSTEM_ID]
        min_sell = min((float(o['price']) for o in amarr_orders), default=None)

    result = {'type_id': type_id, 'min_sell': min_sell, 'source': 'janice' if api_key else 'esi'}
    _amarr_price_cache[type_id] = {'fetched_at': now, 'result': result}
    return result


_JITA_REGION_ID = 10000002
_JITA_SYSTEM_ID = 30000142
_jita_sell_cache: dict[int, dict] = {}
_JITA_PRICE_TTL = 300  # 5 min


@app.get('/api/market/jita-sell')
def get_jita_sell_price(type_id: int, bust: bool = False):
    """Return the Jita sell price and packaged volume for a type. Uses Janice when an API key
    is configured, otherwise falls back to ESI market orders. Cached 5 min; bust=1 forces refresh."""
    now = time.time()
    if not bust:
        cached = _jita_sell_cache.get(type_id)
        if cached and (now - cached['fetched_at']) < _JITA_PRICE_TTL:
            return cached['result']

    cfg = load_config()
    api_key = cfg.get('janice_api_key') or None

    if api_key:
        try:
            min_sell = fetch_type_sell_price(type_id, 'Jita 4-4', api_key=api_key)
        except Exception as e:
            raise HTTPException(502, f'Janice price lookup failed: {e}')
    else:
        try:
            orders = fetch_region_market_orders(_JITA_REGION_ID, type_id, get_user_agent())
        except Exception as e:
            raise HTTPException(502, f'ESI market fetch failed: {e}')
        jita_orders = [o for o in orders if not o.get('is_buy_order') and int(o.get('system_id') or 0) == _JITA_SYSTEM_ID]
        min_sell = min((float(o['price']) for o in jita_orders), default=None)

    try:
        type_info = fetch_type_info(type_id, get_user_agent())
        packaged_volume = float(type_info.get('packaged_volume') or type_info.get('volume') or 0)
    except Exception:
        packaged_volume = None

    result = {
        'type_id': type_id,
        'min_sell': min_sell,
        'packaged_volume': packaged_volume,
        'source': 'janice' if api_key else 'esi',
    }
    _jita_sell_cache[type_id] = {'fetched_at': now, 'result': result}
    return result


_jita_buy_cache: dict[int, dict] = {}

@app.get('/api/market/jita-buy')
def get_jita_buy_price(type_id: int, bust: bool = False):
    """Return the Jita immediate buy price for a type via Janice. Requires a Janice API key.
    Cached 5 min; bust=1 forces refresh."""
    now = time.time()
    if not bust:
        cached = _jita_buy_cache.get(type_id)
        if cached and (now - cached['fetched_at']) < _JITA_PRICE_TTL:
            return cached['result']

    cfg = load_config()
    api_key = cfg.get('janice_api_key') or None
    if not api_key:
        raise HTTPException(422, 'Janice API key required for buy price lookup')

    try:
        prices = fetch_buy_prices([type_id], 'Jita 4-4', api_key=api_key)
    except Exception as e:
        raise HTTPException(502, f'Janice buy price lookup failed: {e}')

    result = {'type_id': type_id, 'max_buy': prices.get(type_id)}
    _jita_buy_cache[type_id] = {'fetched_at': now, 'result': result}
    return result



# Buyback items are shipped Amarr -> Jita (PushX courier) and sold. This block
# powers the three views: an analyzer (paste a courier contract -> per-item
# margin + dump/list recommendation), courier-shipment tracking, and live
# open Jita sell orders pulled from the corp's ESI market orders.

_liq_signal_cache: dict[int, dict] = {}
_LIQ_SIGNAL_TTL = 300  # 5 min per-type ESI signal cache


def _market_signal(type_id, cfg, ua):
    """Live Jita signals for one type, straight from the ESI order book:
    best sell + on-book sell units + the sorted sell book (price, units) at the
    sell station, the best *buy* order reachable from Jita 4-4, and the trailing
    average daily *traded* volume. Cached 5 min. Never raises (best-effort)."""
    now = time.time()
    cached = _liq_signal_cache.get(type_id)
    if cached and (now - cached['fetched_at']) < _LIQ_SIGNAL_TTL:
        return cached['signal']
    region = int(cfg.get('liquidation_sell_region_id') or 10000002)
    station = int(cfg.get('liquidation_sell_station_id') or 60003760)
    system = int(cfg.get('liquidation_sell_system_id') or 30000142)
    days = int(cfg.get('liquidation_vol_window_days') or 20)
    book = []
    on_book = 0
    best_sell = None
    try:
        orders = fetch_region_market_orders(region, type_id, ua, order_type='sell')
        for o in orders:
            if int(o.get('location_id') or 0) != station:
                continue
            price = float(o.get('price') or 0)
            vol = int(o.get('volume_remain') or 0)
            on_book += vol
            book.append((price, vol))
            if best_sell is None or price < best_sell:
                best_sell = price
    except Exception:
        pass
    # Best buy order a seller standing in Jita 4-4 can immediately hit: any buy
    # order at that station, anywhere in the Jita system, or region-wide range.
    # (Full jump-range math is overkill — region + same-system covers Jita's
    # real buy wall.)
    best_buy = None
    try:
        buys = fetch_region_market_orders(region, type_id, ua, order_type='buy')
        for o in buys:
            rng = o.get('range')
            reachable = (
                int(o.get('location_id') or 0) == station
                or rng == 'region'
                or int(o.get('system_id') or 0) == system
            )
            if not reachable:
                continue
            price = float(o.get('price') or 0)
            if best_buy is None or price > best_buy:
                best_buy = price
    except Exception:
        pass
    avg_vol = 0.0
    try:
        hist = fetch_region_market_history(region, type_id, ua)
        recent = hist[-days:] if days and len(hist) > days else hist
        vols = [float(h.get('volume') or 0) for h in recent]
        avg_vol = (sum(vols) / len(vols)) if vols else 0.0
    except Exception:
        pass
    book.sort()
    signal = {'best_sell': best_sell, 'best_buy': best_buy, 'on_book': on_book,
              'avg_daily_vol': avg_vol, 'book': book}
    _liq_signal_cache[type_id] = {'fetched_at': now, 'signal': signal}
    return signal


def _depth_ahead(book, reference_price):
    """Units on the sell book priced at/below ``reference_price`` (competition
    that clears before ours if we list at ``reference_price``)."""
    if reference_price is None:
        return None
    return sum(v for p, v in book if p <= reference_price + 1e-6)


def _fetch_signals(type_ids, cfg, ua, on_progress=None):
    """Concurrently gather `_market_signal` for many types. Returns
    ``{type_id: signal}`` and calls ``on_progress(done, total)`` as it goes."""
    ids = sorted({int(t) for t in type_ids if t})
    out = {}
    done = 0
    with ThreadPoolExecutor(max_workers=12) as ex:
        futs = {ex.submit(_market_signal, t, cfg, ua): t for t in ids}
        for fut in as_completed(futs):
            t = futs[fut]
            try:
                out[t] = fut.result()
            except Exception:
                out[t] = {'best_sell': None, 'on_book': 0, 'avg_daily_vol': 0.0, 'book': []}
            done += 1
            if on_progress and (done % 3 == 0 or done == len(ids)):
                on_progress(done, len(ids))
    return out


class LiquidationAnalyzeRequest(BaseModel):
    paste_text: Optional[str] = None
    janice_url: Optional[str] = None   # analyze straight from a contract's Janice title
    contract_id: Optional[int] = None  # echoed back so the UI can link the result
    rush: bool = False
    include_courier: bool = True


@app.post('/api/liquidation/analyze')
def liquidation_analyze(req: LiquidationAnalyzeRequest):
    """Analyze a courier contract: per-item margin (list vs dump), liquidity
    (days-to-sell from real traded volume), competition depth, and a recommended
    action + listing window. Accepts pasted text or a Janice appraisal URL (the
    courier contract title). Streams NDJSON progress then a `done`."""
    cfg = load_config()
    ua = get_user_agent()
    api_key = cfg.get('janice_api_key') or None
    sell_market = cfg.get('liquidation_sell_market') or 'Jita 4-4'
    cost_market = cfg.get('liquidation_cost_market') or 'Amarr'

    def gen():
        try:
            paste_text = req.paste_text
            if not paste_text and req.janice_url:
                yield _emit('progress', message='Reading the contract’s Janice appraisal…')
                try:
                    items = items_from_appraisal(req.janice_url, api_key=api_key)
                except Exception as e:
                    yield _emit('error', message=f'Could not read Janice appraisal: {e}')
                    return
                if not items:
                    yield _emit('error', message='The linked Janice appraisal had no items.')
                    return
                paste_text = '\n'.join(f'{i["name"]}\t{i["quantity"]}' for i in items)
            if not paste_text or not paste_text.strip():
                yield _emit('error', message='Nothing to analyze — paste items or give a Janice link.')
                return
            yield _emit('progress', message='Appraising items via Janice…')
            appraisal = appraise_items(paste_text, sell_market, api_key=api_key)
            rows = appraisal['items']
            if not rows:
                yield _emit('error', message='No priceable items found in the paste.')
                return
            type_ids = [r['type_id'] for r in rows]

            yield _emit('progress', message='Fetching Amarr buy (cost basis)…')
            try:
                amarr_buy = fetch_buy_prices(type_ids, cost_market, api_key=api_key, user_agent=ua)
            except Exception as e:
                yield _emit('error', message=f'Amarr price lookup failed: {e}')
                return

            signals_holder = {}

            def on_prog(done, total):
                signals_holder['last'] = (done, total)

            # Gather live ESI order-book signals concurrently.
            yield _emit('progress', message=f'Pulling live Jita order book for {len(type_ids)} items…')
            signals = _fetch_signals(type_ids, cfg, ua, on_progress=on_prog)

            # Prices come from the live ESI order book (best sell / best buy);
            # Janice's immediate prices are only a fallback when a side has no
            # orders on the book right now.
            for r in rows:
                sig = signals.get(r['type_id'], {})
                if sig.get('best_sell') is not None:
                    r['sell_unit'] = sig['best_sell']
                if sig.get('best_buy') is not None:
                    r['buy_unit'] = sig['best_buy']

            # Courier cost from this shipment's own Jita sell value.
            total_sell_value = sum(r['sell_unit'] * r['quantity'] for r in rows)
            total_vol = sum(r['unit_volume_m3'] * r['quantity'] for r in rows)
            courier = liquidation.courier_cost(total_sell_value, total_vol, req.rush, cfg)
            courier_total = courier['cost'] if req.include_courier else 0.0

            depth = {}
            history = {}
            for r in rows:
                sig = signals.get(r['type_id'], {})
                history[r['type_id']] = sig.get('avg_daily_vol', 0.0)
                depth[r['type_id']] = {
                    'ahead': _depth_ahead(sig.get('book', []), r['sell_unit']),
                    'on_book': sig.get('on_book', 0),
                }

            result = liquidation.analyze_items(rows, amarr_buy, history, depth, courier_total, cfg)
            result['courier'] = courier
            result['rush'] = req.rush
            result['contract_id'] = req.contract_id
            result['appraisal'] = {
                'code': appraisal.get('code'),
                'market_name': appraisal.get('market_name'),
                'source': appraisal.get('source'),
            }
            yield _emit('done', payload=result)
        except Exception as e:
            yield _emit('error', message=str(e))

    return StreamingResponse(gen(), media_type='application/x-ndjson')


@app.get('/api/liquidation/item-history')
def liquidation_item_history(type_id: int, days: int = 365):
    """Daily price/volume history + the current live order book for one type —
    powers the slide-out market-detail chart. History is real ESI market
    history for The Forge; the book snapshot is the live cached signal."""
    cfg = load_config()
    ua = get_user_agent()
    region = int(cfg.get('liquidation_sell_region_id') or 10000002)
    try:
        hist = fetch_region_market_history(region, type_id, ua)
    except Exception as e:
        raise HTTPException(502, f'History fetch failed: {e}')
    if days and len(hist) > days:
        hist = hist[-days:]
    sig = _market_signal(type_id, cfg, ua)
    meta = enrich_types([type_id], user_agent=ua).get(type_id, {})
    return {
        'type_id': type_id,
        'name': meta.get('name') or f'type {type_id}',
        'group_name': meta.get('group_name') or '',
        'history': hist,
        'signal': {
            'best_sell': sig.get('best_sell'),
            'best_buy': sig.get('best_buy'),
            'on_book': sig.get('on_book'),
            'avg_daily_vol': sig.get('avg_daily_vol'),
        },
    }


# The shipment board is stored as one JSON doc on the *market-history* GitHub
# repo (shared across admins) with the local file as cache/fallback. Reads
# prefer the repo; writes push to it and cache locally, retrying once on a 409
# so a concurrent edit merges instead of clobbering.
_LIQ_STORE_PATH = 'liquidation/shipments.json'


def _liq_remote_cfg(cfg):
    """Resolve the GitHub location for the shipment store from the
    market-history repo config, or None if not configured/parseable."""
    url = (cfg.get('market_history_repo_url') or '').strip()
    if not url:
        return None
    parsed = _parse_github_blob_url(url)
    if not parsed:
        return None
    owner, repo, branch, _path = parsed
    return {
        'owner': owner, 'repo': repo, 'branch': branch, 'path': _LIQ_STORE_PATH,
        'read_pat': cfg.get('market_history_pat_read') or cfg.get('market_history_pat_write') or None,
        'write_pat': cfg.get('market_history_pat_write') or None,
    }


def _liq_read_store():
    """Return ``(store, sha, rc)``. Prefers the GitHub repo; on any remote
    failure falls back to the local cache (sha None)."""
    cfg = load_config()
    rc = _liq_remote_cfg(cfg)
    if not rc:
        return liquidation.load_store_local(), None, None
    ua = get_user_agent()
    try:
        text, sha = _github_contents_get(rc['owner'], rc['repo'], rc['branch'],
                                         rc['path'], rc['read_pat'], ua)
        store = liquidation.normalize(json.loads(text))
        liquidation.save_store_local(store)  # refresh cache
        return store, sha, rc
    except FileNotFoundError:
        return liquidation.empty_store(), None, rc  # first write creates the file
    except Exception:
        return liquidation.load_store_local(), None, rc


def _liq_mutate_store(mutate_fn):
    """Load the latest store, apply ``mutate_fn(store) -> (new_store, result)``,
    persist it, and return ``result``. Pushes to GitHub when a write PAT is set
    (retry once on 409), always writing the local cache."""
    cfg = load_config()
    rc = _liq_remote_cfg(cfg)
    if not rc or not rc.get('write_pat'):
        store = liquidation.load_store_local()
        new_store, result = mutate_fn(store)
        liquidation.save_store_local(new_store)
        return result
    ua = get_user_agent()
    result = None
    for attempt in range(2):
        try:
            text, sha = _github_contents_get(rc['owner'], rc['repo'], rc['branch'],
                                             rc['path'], rc['read_pat'], ua)
            store = liquidation.normalize(json.loads(text))
        except FileNotFoundError:
            store, sha = liquidation.empty_store(), None
        except Exception:
            # Remote unreadable — degrade to local-only for this write.
            store = liquidation.load_store_local()
            new_store, result = mutate_fn(store)
            liquidation.save_store_local(new_store)
            return result
        new_store, result = mutate_fn(store)
        try:
            _github_contents_put(rc['owner'], rc['repo'], rc['branch'], rc['path'],
                                 json.dumps(new_store, indent=2), sha, rc['write_pat'],
                                 ua, 'liquidation: update shipments')
            liquidation.save_store_local(new_store)
            return result
        except RuntimeError as e:
            if '409' in str(e) and attempt == 0:
                continue  # someone else pushed — re-read latest sha and reapply
            liquidation.save_store_local(new_store)  # cache locally at least
            raise HTTPException(502, f'GitHub push failed: {e}')
    return result


@app.get('/api/liquidation/shipments')
def liquidation_shipments():
    cfg = load_config()
    store, _sha, rc = _liq_read_store()
    return {
        'shipments': store['shipments'],
        'storage': 'github' if rc else 'local',
        'accept_days': cfg.get('courier_accept_days', 3),
        'deliver_days': cfg.get('courier_deliver_days', 3),
    }


class ShipmentCreate(BaseModel):
    label: Optional[str] = ''
    rush: bool = False
    notes: Optional[str] = ''
    items: list = []
    totals: dict = {}
    courier: dict = {}


@app.post('/api/liquidation/shipments')
def liquidation_add_shipment(req: ShipmentCreate):
    shipment = req.model_dump()
    shipment['status'] = 'in_flight'
    return _liq_mutate_store(lambda store: liquidation.apply_add(store, shipment))


class ShipmentPatch(BaseModel):
    label: Optional[str] = None
    status: Optional[str] = None       # 'in_flight' | 'delivered' | 'cancelled'
    delivered_at: Optional[float] = None
    notes: Optional[str] = None


@app.patch('/api/liquidation/shipments/{shipment_id}')
def liquidation_patch_shipment(shipment_id: str, req: ShipmentPatch):
    fields = {k: v for k, v in req.model_dump().items() if v is not None}
    updated = _liq_mutate_store(lambda store: liquidation.apply_update(store, shipment_id, fields))
    if not updated:
        raise HTTPException(404, f'No shipment {shipment_id!r}')
    return updated


@app.delete('/api/liquidation/shipments/{shipment_id}')
def liquidation_delete_shipment(shipment_id: str):
    removed = _liq_mutate_store(lambda store: liquidation.apply_remove(store, shipment_id))
    if not removed:
        raise HTTPException(404, f'No shipment {shipment_id!r}')
    return {'ok': True}


# ---- Stockpile (alliance industry-material stock levels) ----
# One JSON doc on the *market-history* GitHub repo at inventory/stock.json,
# shared across the alliance (same repo + PATs as the liquidation board). The
# admin pastes an EVE inventory list; the sidecar resolves + categorizes it and
# pushes the doc. Industry pilots read it. Local file is cache/fallback.
_STOCKPILE_STORE_PATH = 'inventory/stock.json'


def _share_remote_cfg(cfg):
    """Resolve the shared GitHub repo used by the alliance-wide stores
    (doctrine-stock, builds, stockpile): the *market-history* repo + PATs.

    Deliberately separate from the alliance-quota repo: the market-history write
    PAT is safe to distribute to all indy/manufacturing users, whereas the quota
    repo holds the master quota numbers and its write PAT must stay restricted.
    Returns ``{owner, repo, branch, read_pat, write_pat}`` or None. Callers
    append their own path within the repo."""
    url = (cfg.get('market_history_repo_url') or '').strip()
    if not url:
        return None
    parsed = _parse_github_blob_url(url)
    if not parsed:
        return None
    owner, repo, branch, _path = parsed
    return {'owner': owner, 'repo': repo, 'branch': branch,
            'read_pat': cfg.get('market_history_pat_read') or cfg.get('market_history_pat_write') or None,
            'write_pat': cfg.get('market_history_pat_write') or None}


def _stockpile_remote_cfg(cfg):
    """GitHub location for the stock store, in the shared alliance repo."""
    rc = _share_remote_cfg(cfg)
    return {**rc, 'path': _STOCKPILE_STORE_PATH} if rc else None


def _stockpile_totals(store):
    """Per-category `{lines, qty}` tallies for the dashboard header tiles."""
    totals = {c: {'lines': 0, 'qty': 0} for c in stockpile.CATEGORIES}
    for it in store.get('items', []):
        c = it.get('category') if it.get('category') in totals else 'other'
        totals[c]['lines'] += 1
        totals[c]['qty'] += int(it.get('qty') or 0)
    return totals


def _stockpile_read_store():
    """Return ``(store, sha, rc)``. Prefers the GitHub repo; on any remote
    failure falls back to the local cache (sha None)."""
    cfg = load_config()
    rc = _stockpile_remote_cfg(cfg)
    if not rc:
        return stockpile.load_store_local(), None, None
    ua = get_user_agent()
    try:
        text, sha = _github_contents_get(rc['owner'], rc['repo'], rc['branch'],
                                         rc['path'], rc['read_pat'], ua)
        store = stockpile.normalize(json.loads(text))
        stockpile.save_store_local(store)  # refresh cache
        return store, sha, rc
    except FileNotFoundError:
        return stockpile.empty_store(), None, rc  # first write creates the file
    except Exception:
        return stockpile.load_store_local(), None, rc


@app.get('/api/stockpile')
def get_stockpile():
    store, _sha, rc = _stockpile_read_store()
    return {**store, 'storage': 'github' if rc else 'local', 'totals': _stockpile_totals(store)}


class StockpileSave(BaseModel):
    text: str = ''
    note: Optional[str] = ''


@app.post('/api/stockpile')
def save_stockpile(req: StockpileSave):
    cfg = load_config()
    if not cfg.get('stockpile_allow_push'):
        raise HTTPException(403, 'Stock editing is disabled (enable "Allow stock edits" in Config).')
    parsed = stockpile.parse_paste(req.text or '')
    if not parsed:
        raise HTTPException(400, 'No items found in the pasted text.')
    ua = get_user_agent()
    # Resolve pasted names -> type ids, then type ids -> group/category metadata
    # so each line can be bucketed into minerals / PI / other.
    names = [p['name'] for p in parsed]
    try:
        name_to_id = resolve_type_ids(names, ua)
    except Exception:
        name_to_id = {}
    type_ids = [tid for tid in name_to_id.values() if tid]
    meta = {}
    if type_ids:
        try:
            meta = enrich_types(type_ids, ua)
        except Exception:
            meta = {}
    items = []
    for p in parsed:
        tid = name_to_id.get(p['name'].lower()) or 0
        m = meta.get(int(tid)) if tid else None
        items.append({
            'name': p['name'],
            'type_id': int(tid) if tid else 0,
            'qty': int(p['qty']),
            'category': stockpile.classify(m, p['name']),
        })
    store = {
        'updated_at': datetime.now(timezone.utc).isoformat(),
        'note': (req.note or '').strip(),
        'items': items,
    }
    rc = _stockpile_remote_cfg(cfg)
    commit = None
    if rc and rc.get('write_pat'):
        try:
            try:
                _text, sha = _github_contents_get(rc['owner'], rc['repo'], rc['branch'],
                                                  rc['path'], rc['read_pat'], ua)
            except FileNotFoundError:
                sha = None  # first write creates the file
            commit = _github_contents_put(rc['owner'], rc['repo'], rc['branch'], rc['path'],
                                          json.dumps(store, indent=2), sha, rc['write_pat'],
                                          ua, 'stockpile: update inventory')
            cfg['stockpile_last_synced'] = store['updated_at']
            cfg['stockpile_last_status'] = f'pushed {len(items)} item(s)'
            save_config(cfg)
        except Exception as e:
            cfg['stockpile_last_status'] = f'push failed: {e}'
            save_config(cfg)
            stockpile.save_store_local(store)
            raise HTTPException(502, f'GitHub push failed: {e}')
    else:
        cfg['stockpile_last_synced'] = store['updated_at']
        cfg['stockpile_last_status'] = f'saved locally ({len(items)} item(s))'
        save_config(cfg)
    stockpile.save_store_local(store)
    return {
        **store,
        'storage': 'github' if (rc and rc.get('write_pat')) else 'local',
        'totals': _stockpile_totals(store),
        'commit_sha': (commit or {}).get('commit_sha'),
        'commit_html_url': (commit or {}).get('commit_html_url'),
        'unresolved': [p['name'] for p in parsed if not name_to_id.get(p['name'].lower())],
    }


@app.post('/api/stockpile/janice')
def stockpile_janice():
    """Create a persisted Janice appraisal of the whole current stockpile and
    return its shareable URL. Priced at the configured Janice market. Used by the
    Stockpile tab's "Copy Janice appraisal" button."""
    store, _sha, _rc = _stockpile_read_store()
    lines = [
        f"{it['name']}\t{int(it.get('qty') or 0)}"
        for it in (store.get('items') or [])
        if it.get('name') and int(it.get('qty') or 0) > 0
    ]
    if not lines:
        raise HTTPException(400, 'Stockpile is empty — nothing to appraise.')
    cfg = load_config()
    market = cfg.get('janice_market') or 'Jita 4-4'
    api_key = cfg.get('janice_api_key') or None
    try:
        result = create_appraisal_from_text('\n'.join(lines), market, api_key=api_key, persist=True)
    except Exception as e:
        raise HTTPException(502, f'Janice appraisal failed: {e}')
    code = (result.get('raw') or {}).get('code') or result.get('code') or ''
    if not code:
        raise HTTPException(502, 'Janice did not return an appraisal code (persist may have failed).')
    return {
        'url': f'https://janice.e-351.com/a/{code}',
        'code': code,
        'market_name': result.get('market_name') or market,
        'total_buy_price': result.get('total_buy_price') or 0,
        'item_count': len(lines),
    }


# ---------------------------------------------------------------------------
# Indy build planner — per-builder build entries, shared via the market-history
# repo. Each authenticated pilot owns one file at builds/{character_id}.json
# holding all of their planned builds (doctrine, est. completion date, and one
# or more manufacturing slots with the missing materials pasted from the game).
# Members submit their own file (write PAT required); admins read every file via
# /api/builds/all and compare the aggregate missing materials against the
# alliance stockpile on the Build Fulfilment dashboard. Reuses the stockpile
# paste parser + item classifier so a "missing materials" paste resolves to
# {name, type_id, qty, category} exactly like an inventory paste.
# ---------------------------------------------------------------------------


def _builds_remote_cfg(cfg):
    """GitHub location for the shared builds directory, in the shared
    market-history repo (see `_share_remote_cfg`)."""
    return _share_remote_cfg(cfg)


def _builds_file_path(builder_id):
    return f'{builds.STORE_DIR}/{int(builder_id)}.json'


def _current_builder():
    """Identify the logged-in industry pilot from the default auth slot, or None
    when nobody is authenticated there."""
    st = _slot_status(DEFAULT_SLOT)
    if not st.get('authenticated') or not st.get('character_id'):
        return None
    return {'id': int(st['character_id']), 'name': st.get('character') or ''}


def _builds_resolve_and_classify(text, ua):
    """Parse a missing-materials paste and resolve each line to a categorized
    EVE type. Returns (items, unresolved).

    Prefers the in-game industry-job format (`builds.parse_missing_materials`),
    which strips the blueprint/category/header rows and carries the typeID
    directly; falls back to the generic multibuy/inventory paste parser. Only
    lines still lacking a typeID are name-resolved via ESI."""
    parsed = builds.parse_missing_materials(text or '')
    if parsed is None:
        parsed = [{'name': p['name'], 'qty': p['qty'], 'type_id': 0}
                  for p in stockpile.parse_paste(text or '')]
    if not parsed:
        return [], []
    need_names = [p['name'] for p in parsed if not p.get('type_id')]
    name_to_id = {}
    if need_names:
        try:
            name_to_id = resolve_type_ids(need_names, ua)
        except Exception:
            name_to_id = {}
    for p in parsed:
        if not p.get('type_id'):
            p['type_id'] = name_to_id.get(p['name'].lower()) or 0
    type_ids = [int(p['type_id']) for p in parsed if p.get('type_id')]
    meta = {}
    if type_ids:
        try:
            meta = enrich_types(type_ids, ua)
        except Exception:
            meta = {}
    items = []
    for p in parsed:
        tid = int(p.get('type_id') or 0)
        m = meta.get(tid) if tid else None
        items.append({
            'name': p['name'],
            'type_id': tid,
            'qty': int(p['qty']),
            'category': stockpile.classify(m, p['name']),
        })
    unresolved = [p['name'] for p in parsed if not p.get('type_id')]
    return items, unresolved


class BuildParseReq(BaseModel):
    text: str = ''


@app.post('/api/builds/parse')
def builds_parse(req: BuildParseReq):
    """Parse an in-game 'missing materials' paste into categorized line items
    WITHOUT saving — the planner stores the result into the target build slot."""
    items, unresolved = _builds_resolve_and_classify(req.text or '', get_user_agent())
    if not items:
        raise HTTPException(400, 'No items found in the pasted text.')
    return {'items': items, 'unresolved': unresolved}


def _builds_read_doc(builder_id):
    """Return (doc, sha, rc). Prefer the GitHub file; fall back to local cache."""
    cfg = load_config()
    rc = _builds_remote_cfg(cfg)
    if not rc:
        return builds.load_mine_local(), None, None
    ua = get_user_agent()
    path = _builds_file_path(builder_id)
    try:
        text, sha = _github_contents_get(rc['owner'], rc['repo'], rc['branch'], path,
                                         rc['read_pat'], ua)
        doc = builds.normalize(json.loads(text))
        builds.save_mine_local(doc)
        return doc, sha, rc
    except FileNotFoundError:
        return builds.empty_doc(builder_id), None, rc
    except Exception:
        return builds.load_mine_local(), None, rc


@app.get('/api/builds/mine')
def get_my_builds():
    b = _current_builder()
    if not b:
        raise HTTPException(400, 'Log in with your industry character on the Auth tab first (slot 1).')
    doc, _sha, rc = _builds_read_doc(b['id'])
    doc['builder_id'] = b['id']
    if b['name']:
        doc['builder_name'] = b['name']
    return {
        **doc,
        'storage': 'github' if rc else 'local',
        'can_publish': bool(rc and rc.get('write_pat')),
        'slot_count': builds.build_slot_count(doc),
    }


class BuildsSave(BaseModel):
    builds: list = []


@app.post('/api/builds/mine')
def save_my_builds(req: BuildsSave):
    b = _current_builder()
    if not b:
        raise HTTPException(400, 'Log in with your industry character on the Auth tab first (slot 1).')
    doc = builds.normalize({'builder_id': b['id'], 'builder_name': b['name'], 'builds': req.builds})
    doc['updated_at'] = datetime.now(timezone.utc).isoformat()
    cfg = load_config()
    rc = _builds_remote_cfg(cfg)
    commit = None
    storage = 'local'
    if rc and rc.get('write_pat'):
        ua = get_user_agent()
        path = _builds_file_path(b['id'])
        try:
            try:
                _t, sha = _github_contents_get(rc['owner'], rc['repo'], rc['branch'], path,
                                               rc['read_pat'] or rc['write_pat'], ua)
            except FileNotFoundError:
                sha = None  # first write creates the file
            commit = _github_contents_put(rc['owner'], rc['repo'], rc['branch'], path,
                                          json.dumps(doc, indent=2), sha, rc['write_pat'], ua,
                                          f'builds: update {b["name"] or b["id"]}')
            storage = 'github'
        except Exception as e:
            builds.save_mine_local(doc)
            raise HTTPException(502, f'GitHub push failed: {e}')
    builds.save_mine_local(doc)
    return {
        **doc,
        'storage': storage,
        'can_publish': bool(rc and rc.get('write_pat')),
        'slot_count': builds.build_slot_count(doc),
        'commit_html_url': (commit or {}).get('commit_html_url'),
    }


@app.get('/api/builds/all')
def get_all_builds():
    """Every builder's file, plus a pre-aggregated missing-materials list — the
    Build Fulfilment (admin) dashboard compares this against the stockpile."""
    cfg = load_config()
    rc = _builds_remote_cfg(cfg)
    if not rc:
        local = builds.load_mine_local()
        docs = [local] if local.get('builds') else []
        return {'builders': docs, 'missing': builds.aggregate_missing(docs),
                'storage': 'local', 'reason': 'not_configured'}
    ua = get_user_agent()
    try:
        entries = _github_contents_list(rc['owner'], rc['repo'], rc['branch'],
                                        builds.STORE_DIR, rc['read_pat'], ua)
    except Exception as e:
        local = builds.load_mine_local()
        docs = [local] if local.get('builds') else []
        return {'builders': docs, 'missing': builds.aggregate_missing(docs),
                'storage': 'local', 'reason': f'list_failed: {e}'}
    docs = []
    for ent in entries:
        try:
            text, _sha = _github_contents_get(rc['owner'], rc['repo'], rc['branch'],
                                              ent['path'], rc['read_pat'], ua)
            docs.append(builds.normalize(json.loads(text)))
        except Exception:
            continue
    return {'builders': docs, 'missing': builds.aggregate_missing(docs),
            'storage': 'github', 'count': len(docs)}


# ---------------------------------------------------------------------------
# Doctrine stock — a read-only, alliance-wide dashboard of the Contracts-tab
# quota results. An admin (who holds a Contract Manager / Director token) runs
# the Contracts scan; the renderer auto-publishes the resulting quota rows here,
# which writes one JSON file per alliance into the *market-history* GitHub repo
# (shared, its Read PAT already distributed to members). Regular members — who
# lack the privileged token to scan contracts themselves — read that file from
# the Doctrine Stock tab to see current stock and gaps. Only the quota summary
# (name / ship / required / available / missing) is published; the raw contract
# list (issuer names, prices) is deliberately left out.
# ---------------------------------------------------------------------------
_DOCTRINE_STOCK_ALLIANCES = ('main', 'institute')


def _doctrine_stock_remote_cfg(cfg):
    """GitHub repo for a given alliance's doctrine-stock file, in the shared
    market-history repo (see `_share_remote_cfg`)."""
    return _share_remote_cfg(cfg)


def _doctrine_stock_path(alliance):
    return f'doctrine-stock/{alliance}.json'


def _doctrine_stock_cache_path(alliance):
    from config import AUTH_DIR
    return os.path.join(AUTH_DIR, f'doctrine_stock_{alliance}.json')


def _doctrine_stock_save_cache(alliance, snapshot):
    try:
        from config import AUTH_DIR
        os.makedirs(AUTH_DIR, exist_ok=True)
        path = _doctrine_stock_cache_path(alliance)
        with open(path, 'w') as f:
            json.dump(snapshot, f, indent=2)
        os.chmod(path, 0o600)
    except Exception:
        pass


def _doctrine_stock_load_cache(alliance):
    try:
        with open(_doctrine_stock_cache_path(alliance)) as f:
            return json.load(f)
    except Exception:
        return None


def _coerce_stock_quota(row):
    """Trim a scan quota row down to the fields the dashboard needs. Drops the
    per-contract references and any pricing so nothing sensitive is published."""
    if not isinstance(row, dict):
        return None
    try:
        required = int(row.get('required') or 0)
        available = int(row.get('available') or 0)
    except (TypeError, ValueError):
        return None
    missing = row.get('missing')
    try:
        missing = int(missing) if missing is not None else max(0, required - available)
    except (TypeError, ValueError):
        missing = max(0, required - available)
    return {
        'name': str(row.get('name') or ''),
        'ship_name': str(row.get('ship_name') or ''),
        'ship_type_id': row.get('ship_type_id') or None,
        'title_filter': str(row.get('title_filter') or ''),
        'fit_id': row.get('fit_id') or None,
        'required': required,
        'available': available,
        'missing': missing,
    }


class DoctrineStockPublish(BaseModel):
    alliance: str = 'main'
    structure_id: Optional[int] = None
    quotas: list = []


@app.post('/api/doctrine-stock/publish')
def publish_doctrine_stock(req: DoctrineStockPublish):
    """Write the current Contracts-tab quota results for one alliance to the
    market-history repo. Idempotent overwrite (read sha, PUT). No-ops quietly
    (``published: False``) when the machine has no market-history write PAT, so
    the renderer can call this after every scan without gating logic of its own.
    """
    alliance = req.alliance if req.alliance in _DOCTRINE_STOCK_ALLIANCES else 'main'
    cfg = load_config()
    rc = _doctrine_stock_remote_cfg(cfg)
    quotas = [q for q in (_coerce_stock_quota(r) for r in (req.quotas or [])) if q]
    snapshot = {
        'alliance': alliance,
        'structure_id': req.structure_id,
        'published_at': datetime.now(timezone.utc).isoformat(),
        'quota_count': len(quotas),
        'quotas': quotas,
    }
    # Always refresh the local cache so this admin's own dashboard is current
    # even before/without a successful push.
    _doctrine_stock_save_cache(alliance, snapshot)
    if not rc:
        return {'published': False, 'reason': 'not_configured', 'quota_count': len(quotas)}
    if not rc.get('write_pat'):
        return {'published': False, 'reason': 'no_write_pat', 'quota_count': len(quotas)}
    ua = get_user_agent()
    path = _doctrine_stock_path(alliance)
    sha = None
    try:
        _existing, sha = _github_contents_get(rc['owner'], rc['repo'], rc['branch'], path, rc['write_pat'], ua)
    except FileNotFoundError:
        sha = None
    except Exception as e:
        return {'published': False, 'reason': f'read_failed: {e}', 'quota_count': len(quotas)}
    text = json.dumps(snapshot, indent=2) + '\n'
    try:
        result = _github_contents_put(
            rc['owner'], rc['repo'], rc['branch'], path, text, sha, rc['write_pat'], ua,
            f'Doctrine stock ({alliance}) — {len(quotas)} row(s)',
        )
    except Exception as e:
        return {'published': False, 'reason': f'put_failed: {e}', 'quota_count': len(quotas)}
    return {
        'published': True,
        'quota_count': len(quotas),
        'commit_sha': result.get('commit_sha'),
        'commit_html_url': result.get('commit_html_url'),
    }


@app.get('/api/doctrine-stock')
def get_doctrine_stock(alliance: str = 'main'):
    """Read the published doctrine-stock snapshot for one alliance. Prefers the
    market-history GitHub repo (using the Read PAT); on any remote failure falls
    back to the local cache. Returns ``storage: 'github' | 'local' | 'none'``."""
    alliance = alliance if alliance in _DOCTRINE_STOCK_ALLIANCES else 'main'
    cfg = load_config()
    rc = _doctrine_stock_remote_cfg(cfg)
    if rc:
        ua = get_user_agent()
        try:
            text, _sha = _github_contents_get(rc['owner'], rc['repo'], rc['branch'],
                                              _doctrine_stock_path(alliance), rc['read_pat'], ua)
            snapshot = json.loads(text)
            _doctrine_stock_save_cache(alliance, snapshot)
            return {'storage': 'github', **snapshot}
        except FileNotFoundError:
            return {'storage': 'none', 'alliance': alliance, 'quotas': [], 'published_at': None,
                    'reason': 'not_published_yet'}
        except Exception as e:
            cached = _doctrine_stock_load_cache(alliance)
            if cached:
                return {'storage': 'local', 'stale': True, 'error': str(e), **cached}
            return {'storage': 'none', 'alliance': alliance, 'quotas': [], 'published_at': None,
                    'reason': f'read_failed: {e}'}
    cached = _doctrine_stock_load_cache(alliance)
    if cached:
        return {'storage': 'local', **cached}
    return {'storage': 'none', 'alliance': alliance, 'quotas': [], 'published_at': None,
            'reason': 'not_configured'}


@app.get('/api/liquidation/corp-orders')
def liquidation_corp_orders():
    """Live open Jita sell orders for the corp, enriched with cost basis (live
    90% Amarr buy), current best sell (are we undercut?), days-to-sell, time
    remaining in the order window, and a STALE flag when it has sat too long."""
    cfg = load_config()
    ua = get_user_agent()
    token, corp_id, reason = _scope_token('esi-markets.read_corporation_orders.v1')
    if reason:
        return {'configured': False, 'reason': reason}
    try:
        orders = fetch_corp_orders(corp_id, token, ua)
    except Exception as e:
        return {'configured': False, 'reason': 'fetch_failed', 'detail': str(e)}

    station = int(cfg.get('liquidation_sell_station_id') or 60003760)
    sells = [o for o in orders
             if not o.get('is_buy_order') and int(o.get('location_id') or 0) == station]
    if not sells:
        return {'configured': True, 'orders': [], 'totals': {'orders': 0}}

    type_ids = [int(o['type_id']) for o in sells]
    api_key = cfg.get('janice_api_key') or None
    cost_market = cfg.get('liquidation_cost_market') or 'Amarr'
    frac = float(cfg.get('liquidation_buyback_fraction') or 0.90)
    broker = float(cfg.get('liquidation_broker_fee_pct') or 0) / 100.0
    tax = float(cfg.get('liquidation_sales_tax_pct') or 0) / 100.0
    safety = float(cfg.get('liquidation_window_safety') or 1.3)
    stale_factor = float(cfg.get('liquidation_stale_factor') or 1.5)

    try:
        amarr_buy = fetch_buy_prices(type_ids, cost_market, api_key=api_key, user_agent=ua) if api_key else {}
    except Exception:
        amarr_buy = {}
    signals = _fetch_signals(type_ids, cfg, ua)

    now = datetime.now(timezone.utc)
    enriched = []
    for o in sells:
        tid = int(o['type_id'])
        sig = signals.get(tid, {})
        meta = enrich_types([tid]).get(tid, {})
        price = float(o.get('price') or 0)
        remain = int(o.get('volume_remain') or 0)
        total = int(o.get('volume_total') or 0)
        avg_vol = sig.get('avg_daily_vol') or 0
        cost_basis = frac * float(amarr_buy.get(tid, 0) or 0)
        net_unit = price * (1 - broker - tax) - cost_basis if cost_basis else None
        days_to_sell = (remain / avg_vol) if avg_vol > 0 else None
        best_sell = sig.get('best_sell')
        undercut = bool(best_sell is not None and best_sell < price - 1e-6)
        # Time remaining from ESI issued + duration (days).
        issued = o.get('issued')
        duration = int(o.get('duration') or 0)
        days_remaining = None
        age_days = None
        if issued:
            try:
                issued_dt = datetime.fromisoformat(issued.replace('Z', '+00:00'))
                age_days = (now - issued_dt).total_seconds() / 86400.0
                days_remaining = duration - age_days
            except Exception:
                pass
        stale = bool(days_to_sell is not None and age_days is not None
                     and age_days > days_to_sell * safety * stale_factor)
        enriched.append({
            'order_id': o.get('order_id'),
            'type_id': tid,
            'name': meta.get('name') or f'type {tid}',
            'price': price,
            'volume_remain': remain,
            'volume_total': total,
            'filled': total - remain,
            'fill_pct': round((total - remain) / total * 100, 1) if total else 0,
            'cost_basis_unit': cost_basis or None,
            'net_unit': net_unit,
            'net_value_remaining': (net_unit * remain) if net_unit is not None else None,
            'best_sell': best_sell,
            'undercut': undercut,
            'avg_daily_vol': avg_vol,
            'days_to_sell': days_to_sell,
            'duration': duration,
            'age_days': age_days,
            'days_remaining': days_remaining,
            'stale': stale,
        })

    totals = {
        'orders': len(enriched),
        'listed_value': sum(o['price'] * o['volume_remain'] for o in enriched),
        'net_value_remaining': sum((o['net_value_remaining'] or 0) for o in enriched),
        'stale_count': sum(1 for o in enriched if o['stale']),
        'undercut_count': sum(1 for o in enriched if o['undercut']),
    }
    return {'configured': True, 'orders': enriched, 'totals': totals}


def _scope_token(scope):
    """Return ``(token, corp_id, reason)`` for the first authed slot carrying
    ``scope``. Shared by the corp-orders and courier-contracts views."""
    cfg = load_config()
    corp_id = cfg.get('corp_id')
    if not corp_id:
        return None, None, 'no_corp_id'
    try:
        client_id, secret_key = get_app_credentials()
    except Exception:
        return None, corp_id, 'no_credentials'
    ua = get_user_agent()
    for slot in list_authenticated_slots():
        try:
            token = get_valid_access_token(client_id, secret_key, ua, slot=slot)
            payload = decode_jwt_payload(token)
        except Exception:
            continue
        scps = payload.get('scp')
        scope_list = scps if isinstance(scps, list) else [scps] if scps else []
        if scope in scope_list:
            return token, corp_id, None
    return None, corp_id, 'missing_scope'


# Group ESI contract statuses into the three buckets the Shipments view shows.
_COURIER_ACTIVE = {'outstanding', 'in_progress'}
_COURIER_DONE = {'finished'}
_COURIER_PROBLEM = {'failed', 'rejected', 'deleted', 'reversed'}


@app.get('/api/liquidation/courier-contracts')
def liquidation_courier_contracts():
    """The corp's ESI courier contracts (the real PushX shipments): active,
    completed and recently failed, with assignee + route names resolved. The
    provider configured in `courier_provider_name` is flagged per row."""
    cfg = load_config()
    ua = get_user_agent()
    token, corp_id, reason = _scope_token('esi-contracts.read_corporation_contracts.v1')
    if reason:
        return {'configured': False, 'reason': reason}
    try:
        contracts = fetch_corp_contracts(corp_id, token, ua)
    except Exception as e:
        return {'configured': False, 'reason': 'fetch_failed', 'detail': str(e)}

    couriers = [c for c in contracts if c.get('type') == 'courier']
    if not couriers:
        return {'configured': True, 'contracts': [], 'totals': {'active': 0, 'completed': 0, 'problem': 0}}

    # Resolve names for assignees/acceptors/issuers and NPC-station endpoints.
    # Player structures (id > 1e12) don't resolve via /universe/names — label
    # the configured home structure, else show a short 'Citadel …' tag.
    id_set = set()
    for c in couriers:
        for k in ('assignee_id', 'acceptor_id', 'issuer_id', 'start_location_id', 'end_location_id'):
            v = c.get(k)
            if v and int(v) < 1_000_000_000_000:
                id_set.add(int(v))
    names = {}
    if id_set:
        try:
            names = resolve_names(sorted(id_set), ua)
        except Exception:
            names = {}
    home_id = cfg.get('home_structure_id')

    def loc_name(loc_id):
        if not loc_id:
            return None
        loc_id = int(loc_id)
        if loc_id >= 1_000_000_000_000:
            return 'Home structure' if home_id and loc_id == int(home_id) else f'Citadel {loc_id}'
        return names.get(loc_id) or str(loc_id)

    provider = (cfg.get('courier_provider_name') or '').strip().lower()
    out = []
    for c in couriers:
        assignee = names.get(int(c['assignee_id'])) if c.get('assignee_id') else None
        status = c.get('status') or ''
        if status in _COURIER_ACTIVE:
            bucket = 'active'
        elif status in _COURIER_DONE:
            bucket = 'completed'
        elif status in _COURIER_PROBLEM:
            bucket = 'problem'
        else:
            bucket = 'other'
        out.append({
            'contract_id': c.get('contract_id'),
            'status': status,
            'bucket': bucket,
            'title': c.get('title') or '',
            'assignee': assignee,
            'is_provider': bool(provider and assignee and provider in assignee.lower()),
            'acceptor': names.get(int(c['acceptor_id'])) if c.get('acceptor_id') else None,
            'start': loc_name(c.get('start_location_id')),
            'end': loc_name(c.get('end_location_id')),
            'volume': c.get('volume'),
            'collateral': c.get('collateral'),
            'reward': c.get('reward'),
            'days_to_complete': c.get('days_to_complete'),
            'date_issued': c.get('date_issued'),
            'date_expired': c.get('date_expired'),
            'date_accepted': c.get('date_accepted'),
            'date_completed': c.get('date_completed'),
        })
    # Newest first by whichever date is most relevant.
    out.sort(key=lambda x: (x.get('date_completed') or x.get('date_accepted')
                            or x.get('date_issued') or ''), reverse=True)
    totals = {
        'active': sum(1 for c in out if c['bucket'] == 'active'),
        'completed': sum(1 for c in out if c['bucket'] == 'completed'),
        'problem': sum(1 for c in out if c['bucket'] == 'problem'),
        'active_collateral': sum((c['collateral'] or 0) for c in out if c['bucket'] == 'active'),
        'active_reward': sum((c['reward'] or 0) for c in out if c['bucket'] == 'active'),
    }
    return {'configured': True, 'contracts': out, 'totals': totals,
            'provider_name': cfg.get('courier_provider_name') or ''}


# ----------------------- Contracts scan (alliance + public) -----------------------

# Module-scope cache so repeat scans don't re-download the same items.
_contract_items_cache: dict[int, list] = {}
# Sold (finished) contracts collected during the most recent scan; used by the lazy sold-30d endpoint.
_sold_contracts_cache: dict[str, dict[int, dict]] = {}  # alliance -> {contract_id -> rec}


def _matches_quota(quota: dict, items_named: list[dict], contract: dict) -> int:
    """Return how many times this contract counts toward `quota`.

    Match rules: type_id is required. Optional title_filter is a case-insensitive
    substring match on the contract title. A single contract can satisfy a quota
    multiple times if it carries multiple hulls of the same type.
    """
    ship_type_id = int(quota.get('ship_type_id') or 0)
    if not ship_type_id:
        return 0
    title_filter = (quota.get('title_filter') or '').strip().lower()
    if title_filter and title_filter not in (contract.get('title') or '').lower():
        return 0
    count = 0
    for it in items_named:
        if not it.get('is_included', True):
            continue
        if int(it.get('type_id') or 0) == ship_type_id:
            count += int(it.get('quantity') or 0)
    return count


def _filter_sold_contracts(contracts: list[dict], corp_id: int, structure_id: int, cutoff: str) -> list[dict]:
    """Return finished item-exchange contracts issued by corp_id at structure_id after cutoff.

    cutoff is an ISO-8601 string (e.g. from datetime.isoformat()); date_completed is
    compared lexicographically, which is correct for ISO timestamps at the same UTC offset.
    Deduplicates by contract_id.
    """
    seen: set[int] = set()
    result: list[dict] = []
    for c in contracts:
        if c.get('type') != 'item_exchange':
            continue
        if (c.get('status') or '').lower() != 'finished':
            continue
        if int(c.get('start_location_id') or 0) != structure_id:
            continue
        if int(c.get('issuer_corporation_id') or 0) != corp_id:
            continue
        if (c.get('date_completed') or '') < cutoff:
            continue
        cid = int(c.get('contract_id') or 0)
        if cid and cid not in seen:
            seen.add(cid)
            result.append(c)
    return result


def _scan_contracts_stream(alliance: str = 'all'):
    """Stream outstanding item-exchange contracts that ANY authed slot's corp
    has posted at the configured home structure.

    For each logged-in slot we look up the character's corporation and call
    /corporations/{corp_id}/contracts/ — needs the
    esi-contracts.read_corporation_contracts.v1 scope plus Contract Manager
    or Director role in that corp. Slots whose toons don't have the role
    return 403; we surface that as a per-slot warning and move on. Results
    are deduplicated by contract_id across corps.

    Filter per corp: type=item_exchange, status=outstanding,
    start_location_id=home, for_corporation=True, issuer_corporation_id=corp.
    The availability field is ignored — corp-posted alliance fits come back
    as availability=personal with assignee_id=alliance_id, not availability=
    alliance.

    alliance: 'all' | 'main' | 'institute' — restricts slots to those whose
    character's alliance_id matches the configured alliance_id_main or
    alliance_id_institute (if those IDs are set).
    """
    cfg = load_config()
    structure_id = int(cfg.get('home_structure_id') or 0)
    quotas_key = 'quotas_institute' if alliance == 'institute' else 'quotas'
    quotas = list(cfg.get(quotas_key) or [])
    target_alliance_id = 0
    if alliance in ('main', 'institute'):
        target_alliance_id = int(cfg.get(f'alliance_id_{alliance}') or 0)
    if not structure_id:
        yield _emit('error', message='Set home_structure_id in Config first')
        return

    slots = list_authenticated_slots()
    if not slots:
        yield _emit('error', message='Log in at least one slot on the Auth tab')
        return

    ua = get_user_agent()
    client_id, secret_key = get_app_credentials()

    # contract_id -> {'contract': record, 'char_id': int, 'corp_id': int, 'token': str, 'source_corps': set}
    found: dict[int, dict] = {}
    # Finished item-exchange contracts at home, completed within the last 30 days.
    sold_found: dict[int, dict] = {}
    cutoff_30d = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    # Tally per corp_id: how many new contracts we kept per slot's corp (for UI summary).
    per_corp_kept: dict[int, int] = {}

    for slot in slots:
        yield _emit('progress', step=f'Resolving corp for {slot}…')
        try:
            token = get_valid_access_token(client_id, secret_key, ua, slot=slot)
        except Exception as e:
            yield _emit('progress', step=f'{slot}: token unusable — {e}')
            continue
        char_id = character_id_from_access_token(token)
        if not char_id:
            yield _emit('progress', step=f'{slot}: could not extract character_id')
            continue
        try:
            cinfo = fetch_character_info(char_id, ua)
        except Exception as e:
            yield _emit('progress', step=f'{slot}: character info failed — {e}')
            continue
        corp_id = int(cinfo.get('corporation_id') or 0)
        if not corp_id:
            yield _emit('progress', step=f'{slot}: character has no corporation')
            continue

        if target_alliance_id:
            slot_alliance_id = int(cinfo.get('alliance_id') or 0)
            if slot_alliance_id != target_alliance_id:
                yield _emit('progress', step=f'{slot}: skipping — not in selected alliance')
                continue

        if corp_id in per_corp_kept:
            yield _emit(
                'progress',
                step=f'{slot}: corp {corp_id} already fetched via earlier slot — skipping',
            )
            continue

        yield _emit('progress', step=f'{slot}: fetching corp {corp_id} contracts…')
        try:
            corp_contracts = fetch_corp_contracts(corp_id, token, ua)
        except Exception as e:
            msg = str(e)
            if '403' in msg or 'Forbidden' in msg:
                yield _emit(
                    'progress',
                    step=f'{slot}: corp {corp_id} fetch forbidden (needs Contract Manager / Director role)',
                )
            else:
                yield _emit('progress', step=f'{slot}: corp {corp_id} fetch failed — {msg}')
            continue

        kept = 0
        for c in corp_contracts:
            if c.get('type') != 'item_exchange':
                continue
            if (c.get('status') or '').lower() != 'outstanding':
                continue
            if int(c.get('start_location_id') or 0) != structure_id:
                continue
            if int(c.get('issuer_corporation_id') or 0) != corp_id:
                continue
            cid = int(c.get('contract_id') or 0)
            if not cid:
                continue
            entry = found.get(cid)
            if entry is None:
                logger.warning(
                    'found contract %s | title="%s" | availability=%s | price=%s',
                    cid, c.get('title') or '', c.get('availability'), c.get('price'),
                )
                found[cid] = {
                    'contract': c,
                    'corp_id': corp_id,
                    'token': token,
                    'source_corps': {corp_id},
                }
                kept += 1
            else:
                entry['source_corps'].add(corp_id)
        per_corp_kept[corp_id] = kept

        for c in _filter_sold_contracts(corp_contracts, corp_id, structure_id, cutoff_30d):
            cid = int(c.get('contract_id') or 0)
            if cid not in sold_found:
                sold_found[cid] = {'contract': c, 'char_id': char_id, 'corp_id': corp_id, 'token': token}

        yield _emit(
            'progress',
            step=f'{slot}: corp {corp_id} — {kept} matching at home structure '
                 f'(of {len(corp_contracts)} total)',
        )

    _sold_contracts_cache[alliance] = sold_found

    if not found:
        yield _emit('done', payload={
            'structure_id': structure_id,
            'corps_scanned': sorted(per_corp_kept.keys()),
            'contracts': [],
            'quotas': [
                {**q, 'available': 0, 'missing': int(q.get('required') or 0), 'contracts': []}
                for q in quotas
            ],
        })
        return

    # ---- Fetch items per contract — cached hits are free, rest fetched in parallel ----
    items_by_id: dict[int, list] = {}
    items_errors: dict[int, str] = {}
    total = len(found)

    def _fetch_items(cid_rec):
        cid, rec = cid_rec
        last_err = None
        for attempt in range(3):
            try:
                return cid, fetch_contract_items(rec['corp_id'], cid, rec['token'], ua), None
            except Exception as e:
                last_err = e
                if attempt < 2:
                    time.sleep(1.5 ** attempt)
        return cid, [], str(last_err)

    uncached = {cid: rec for cid, rec in found.items() if _contract_items_cache.get(cid) is None}
    for cid in found:
        if cid not in uncached:
            items_by_id[cid] = _contract_items_cache[cid]

    if uncached:
        yield _emit('progress', step=f'Fetching items for {len(uncached)} contract(s)…')

        with ThreadPoolExecutor(max_workers=3) as pool:
            futures = {pool.submit(_fetch_items, (cid, rec)): cid for cid, rec in uncached.items()}
            done = len(found) - len(uncached)
            for future in as_completed(futures):
                cid, items, err = future.result()
                items_by_id[cid] = items
                if err:
                    items_errors[cid] = err
                else:
                    _contract_items_cache[cid] = items
                done += 1
                yield _emit('progress', step=f'Items: {done}/{total}', current=done, total=total, phase='items')

    # ---- Resolve type and issuer names ----
    type_ids = sorted({int(i.get('type_id') or 0) for items in items_by_id.values() for i in items})
    try:
        type_names = resolve_names(type_ids, ua) if type_ids else {}
    except Exception:
        type_names = {}
    issuer_ids = sorted({int(rec['contract'].get('issuer_id') or 0) for rec in found.values()})
    try:
        issuer_names = resolve_names(issuer_ids, ua) if issuer_ids else {}
    except Exception:
        issuer_names = {}

    contracts_out = []
    for cid, rec in found.items():
        c = rec['contract']
        items_named = [
            {
                'type_id': int(i.get('type_id') or 0),
                'quantity': int(i.get('quantity') or 0),
                'is_included': bool(i.get('is_included', True)),
                'name': type_names.get(int(i.get('type_id') or 0), ''),
            }
            for i in items_by_id.get(cid, [])
        ]
        # Build a 'targeted at' label from availability + assignee for the UI.
        avail = (c.get('availability') or '').lower()
        if avail in ('alliance', 'public', 'corporation'):
            label = avail
        elif avail == 'personal':
            label = f'assigned→{c.get("assignee_id")}'
        else:
            label = avail or '?'
        issuer_name = issuer_names.get(int(c.get('issuer_id') or 0), '')
        price = c.get('price')
        price_str = f'{price:,.0f} ISK' if price is not None else 'no price'
        included = [i for i in items_named if i.get('is_included', True)]
        items_str = ', '.join(
            f'{i["name"] or i["type_id"]} x{i["quantity"]}' for i in included
        ) or '(no items)'
        logger.warning(
            'contract %s | "%s" | issuer=%s | %s | %s',
            cid, c.get('title') or '', issuer_name, price_str, items_str,
        )
        contracts_out.append({
            'contract_id': cid,
            'title': c.get('title') or '',
            'price': price,
            'availability': c.get('availability'),
            'assignee_id': c.get('assignee_id'),
            'issuer_id': c.get('issuer_id'),
            'issuer_name': issuer_name,
            'issuer_corporation_id': c.get('issuer_corporation_id'),
            'date_issued': c.get('date_issued'),
            'date_expired': c.get('date_expired'),
            'sources': [f'corp:{rec["corp_id"]}', label],
            'items': items_named,
            'items_error': items_errors.get(cid),
        })

    # ---- Per-quota aggregation ----
    quotas_out = []
    for q in quotas:
        required = int(q.get('required') or 0)
        matched_ids = []
        available = 0
        for co in contracts_out:
            n = _matches_quota(q, co['items'], co)
            if n > 0:
                matched_ids.append({'contract_id': co['contract_id'], 'count': n})
                available += n
        missing = max(0, required - available)
        quotas_out.append({
            **q,
            'available': available,
            'missing': missing,
            'contracts': matched_ids,
        })

    yield _emit('done', payload={
        'structure_id': structure_id,
        'corps_scanned': sorted(per_corp_kept.keys()),
        'contracts': contracts_out,
        'quotas': quotas_out,
    })


# ----------------------- Appraisal tab (Janice) -----------------------


class AppraiseRequest(BaseModel):
    paste_text: str
    market_name: Optional[str] = None  # defaults to cfg['janice_market']
    persist: bool = False              # ask Janice to keep a shareable code


@app.post('/api/appraise')
def appraise(req: AppraiseRequest):
    """Run a Janice appraisal on the pasted items and return the buy/split/sell
    totals (immediate + effective) plus a shareable code when persist is set.
    """
    if not req.paste_text or not req.paste_text.strip():
        raise HTTPException(400, 'paste_text is empty')

    cfg = load_config()
    market_name = req.market_name or cfg.get('janice_market') or 'Jita 4-4'
    api_key = cfg.get('janice_api_key') or None

    try:
        janice_result = create_appraisal_from_text(
            req.paste_text, market_name, api_key=api_key, persist=req.persist,
        )
    except Exception as e:
        raise HTTPException(502, f'Janice appraisal failed: {e}')

    raw = janice_result.get('raw') or {}
    raw_items = raw.get('items') or []

    # --- Surface buy/split/sell totals from Janice ---
    # immediatePrices = "use what's on the market right now" (what most
    # appraisers want to see). effectivePrices is a slightly smoothed view
    # blending recent history; included alongside so the UI can offer both.
    def _grab_prices(block_name):
        b = raw.get(block_name) or {}
        # Top-level summary blocks use totalBuyPrice / totalSplitPrice /
        # totalSellPrice. The per-item blocks confusingly use the inverse
        # field order (buyPriceTotal). Support both — Janice's docs aren't
        # explicit about which payload shape ships when.
        return {
            'buy_total': float(b.get('totalBuyPrice') or b.get('buyPriceTotal') or 0),
            'split_total': float(b.get('totalSplitPrice') or b.get('splitPriceTotal') or 0),
            'sell_total': float(b.get('totalSellPrice') or b.get('sellPriceTotal') or 0),
        }

    immediate = _grab_prices('immediatePrices')
    effective = _grab_prices('effectivePrices')

    janice_total = float(janice_result.get('total_buy_price') or 0)

    return {
        'market_name': janice_result.get('market_name') or market_name,
        'janice': {
            'code': janice_result.get('code') or (raw.get('code') if isinstance(raw, dict) else None),
            'total_buy_price': janice_total,
            'effective_offer': janice_result.get('effective_offer'),
            'percentage': janice_result.get('percentage'),
            'source': janice_result.get('source'),
            'api_fallback_reason': janice_result.get('api_fallback_reason'),
            'item_count': len(raw_items),
            'prices_immediate': immediate,
            'prices_effective': effective,
        },
    }


# ----------------------- Working tab: pinned moon contracts -----------------------


class PinUpsert(BaseModel):
    contract_id: int
    pinned_at: Optional[str] = None
    snapshot: dict


class PinPatch(BaseModel):
    notes: Optional[str] = None
    status: Optional[str] = None  # 'pending' | 'paid' | 'disputed'


class PinAppraise(BaseModel):
    paste_text: str
    market_name: Optional[str] = None  # defaults to cfg['moon_market']
    persist: bool = True


@app.get('/api/pinned')
def get_pinned():
    """Return every pinned contract. The Working tab calls this on mount."""
    return {'pins': load_pinned()}


@app.post('/api/pinned')
def post_pinned(req: PinUpsert):
    """Add or refresh a pinned contract. Re-pinning preserves notes/status/
    appraisals while replacing the snapshot."""
    if not req.snapshot or int(req.snapshot.get('contract_id') or 0) != req.contract_id:
        raise HTTPException(400, 'snapshot.contract_id must match contract_id')
    pinned_at = req.pinned_at or datetime.now(timezone.utc).isoformat()
    try:
        pins = upsert_pin(req.snapshot, pinned_at)
    except Exception as e:
        raise HTTPException(400, str(e))
    return {'pins': pins}


@app.delete('/api/pinned/{contract_id}')
def delete_pinned(contract_id: int):
    return {'pins': remove_pin(contract_id)}


@app.patch('/api/pinned/{contract_id}')
def patch_pinned(contract_id: int, patch: PinPatch):
    payload = patch.model_dump(exclude_unset=True)
    try:
        pin = update_pin_fields(contract_id, payload)
    except KeyError:
        raise HTTPException(404, f'pin {contract_id} not found')
    return {'pin': pin}


@app.post('/api/pinned/{contract_id}/appraise')
def appraise_pinned(contract_id: int, req: PinAppraise):
    """Run a Janice appraisal against the admin's pasted refined-mineral text
    and apply the pin's saved blended payout fraction. Appends the result to
    the pin's appraisal history and returns it.
    """
    pins = load_pinned()
    pin = next((p for p in pins if int(p.get('contract_id') or 0) == contract_id), None)
    if not pin:
        raise HTTPException(404, f'pin {contract_id} not found')

    cfg = load_config()
    market_name = req.market_name or cfg.get('moon_market') or 'Jita 4-4'
    api_key = cfg.get('janice_api_key') or None

    try:
        result = create_appraisal_from_text(
            req.paste_text, market_name, api_key=api_key, persist=req.persist,
        )
    except Exception as e:
        raise HTTPException(502, f'Janice appraisal failed: {e}')

    janice_total = float(result.get('total_buy_price') or 0)
    fraction = float(pin.get('blended_fraction') or 0)
    payout = janice_total * fraction
    paste_preview = (req.paste_text or '').strip().splitlines()
    preview_str = ' / '.join(paste_preview[:3])[:120]
    # `_normalize` always sets `code=''` on create paths; the persistent code
    # actually lives on the raw response body. Try both shapes.
    raw = result.get('raw') or {}
    janice_code = (
        result.get('code')
        or raw.get('code')
        or raw.get('id')
        or None
    )

    appraisal_record = {
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'janice_total': janice_total,
        'fraction_used': fraction,
        'payout': payout,
        'market_name': result.get('market_name') or market_name,
        'janice_code': janice_code or None,
        'items_count': len(result.get('items') or []),
        'paste_preview': preview_str,
        'source': result.get('source'),
        'api_fallback_reason': result.get('api_fallback_reason'),
    }
    try:
        pin = append_appraisal(contract_id, appraisal_record)
    except KeyError:
        raise HTTPException(404, f'pin {contract_id} not found')
    return {'pin': pin, 'appraisal': appraisal_record}


# ----------------------- Acquisitions tab -----------------------

class AcquisitionsParseRequest(BaseModel):
    paste_text: str

class AcquisitionsSaveRequest(BaseModel):
    hulls: list
    items: list


@app.post('/api/acquisitions/parse')
def acquisitions_parse(req: AcquisitionsParseRequest):
    """Parse an EVE-format inventory paste (Name\\tQty per line) and resolve
    names to type IDs via Janice. Returns a list of {type_id, name, quantity, category_id}."""
    if not req.paste_text or not req.paste_text.strip():
        raise HTTPException(400, 'paste_text is empty')
    cfg = load_config()
    api_key = cfg.get('janice_api_key') or None
    market_name = cfg.get('janice_market') or 'Jita 4-4'
    try:
        rows = appraise_items(req.paste_text, market_name, api_key=api_key)
    except Exception as e:
        raise HTTPException(502, f'Parse failed: {e}')
    ua = get_user_agent()
    resolved = []
    for r in rows:
        if not r.get('type_id'):
            continue
        category_id = None
        try:
            type_info = fetch_type_info(r['type_id'], ua)
            group_info = fetch_group_info(type_info.get('group_id'), ua)
            category_id = group_info.get('category_id')
        except Exception:
            pass
        resolved.append({
            'type_id': r['type_id'],
            'name': r['name'],
            'quantity': r['quantity'],
            'category_id': category_id,
        })
    return {'items': resolved, 'unresolved': []}


@app.get('/api/acquisitions')
def get_acquisitions():
    """Return the saved hull and item inventory."""
    return load_acquisitions()


@app.post('/api/acquisitions')
def post_acquisitions(req: AcquisitionsSaveRequest):
    """Persist the hull and item inventory to disk."""
    return save_acquisitions(req.hulls, req.items)


@app.get('/api/contracts/scan')
def scan_contracts(alliance: str = 'all'):
    """NDJSON stream of outstanding item-exchange contracts posted by any
    authed slot's corporation at the configured home structure, plus
    per-quota aggregation.

    alliance: 'all' | 'main' | 'institute' — filters to slots in that alliance.
    """
    return StreamingResponse(
        _scan_contracts_stream(alliance=alliance), media_type='application/x-ndjson',
    )


def _sold_30d_scan_stream(alliance: str = 'all'):
    """Stream sold-contract item fetching for all quotas.

    Fetches corporation contracts for every authed slot, filters for finished
    item-exchange contracts issued by that corp at the home structure in the
    last 30 days, fetches their items, then emits a done event with per-quota
    sold_30d counts.

    alliance: 'all' | 'main' | 'institute' — filters to slots in that alliance.
    """
    cfg = load_config()
    structure_id = int(cfg.get('home_structure_id') or 0)
    quotas_key = 'quotas_institute' if alliance == 'institute' else 'quotas'
    quotas = list(cfg.get(quotas_key) or [])
    target_alliance_id = 0
    if alliance in ('main', 'institute'):
        target_alliance_id = int(cfg.get(f'alliance_id_{alliance}') or 0)
    if not structure_id:
        yield _emit('error', message='Set home_structure_id in Config first')
        return

    slots = list_authenticated_slots()
    if not slots:
        yield _emit('error', message='Log in at least one slot on the Auth tab')
        return

    ua = get_user_agent()
    client_id, secret_key = get_app_credentials()
    cutoff_30d = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    sold_found: dict[int, dict] = {}
    per_corp_done: set[int] = set()

    for slot in slots:
        yield _emit('progress', step=f'Resolving corp for {slot}…')
        try:
            token = get_valid_access_token(client_id, secret_key, ua, slot=slot)
        except Exception as e:
            yield _emit('progress', step=f'{slot}: token unusable — {e}')
            continue
        char_id = character_id_from_access_token(token)
        if not char_id:
            yield _emit('progress', step=f'{slot}: could not extract character_id')
            continue
        try:
            cinfo = fetch_character_info(char_id, ua)
        except Exception as e:
            yield _emit('progress', step=f'{slot}: character info failed — {e}')
            continue
        corp_id = int(cinfo.get('corporation_id') or 0)
        if not corp_id:
            yield _emit('progress', step=f'{slot}: character has no corporation')
            continue

        if target_alliance_id:
            slot_alliance_id = int(cinfo.get('alliance_id') or 0)
            if slot_alliance_id != target_alliance_id:
                yield _emit('progress', step=f'{slot}: skipping — not in selected alliance')
                continue

        if corp_id in per_corp_done:
            yield _emit('progress', step=f'{slot}: corp {corp_id} already fetched — skipping')
            continue

        yield _emit('progress', step=f'{slot}: fetching corp {corp_id} contracts…')
        try:
            corp_contracts = fetch_corp_contracts(corp_id, token, ua)
        except Exception as e:
            yield _emit('progress', step=f'{slot}: contract fetch failed — {e}')
            continue

        for c in _filter_sold_contracts(corp_contracts, corp_id, structure_id, cutoff_30d):
            cid = int(c.get('contract_id') or 0)
            if cid not in sold_found:
                sold_found[cid] = {'contract': c, 'char_id': char_id, 'corp_id': corp_id, 'token': token}
        per_corp_done.add(corp_id)
        yield _emit('progress', step=f'{slot}: {len(sold_found)} sold contract(s) so far')

    _sold_contracts_cache[alliance] = sold_found

    if not sold_found:
        yield _emit('done', payload={'quotas': [{**q, 'sold_30d': 0} for q in quotas]})
        return

    def _fetch_items(cid_rec):
        cid, rec = cid_rec
        last_err = None
        for attempt in range(3):
            try:
                return cid, fetch_contract_items(rec['corp_id'], cid, rec['token'], ua), None
            except Exception as e:
                last_err = e
                if attempt < 2:
                    time.sleep(1.5 ** attempt)
        return cid, [], str(last_err)

    sold_items_by_id: dict[int, list] = {}
    uncached = {cid: rec for cid, rec in sold_found.items() if _contract_items_cache.get(cid) is None}
    for cid in sold_found:
        if cid not in uncached:
            sold_items_by_id[cid] = _contract_items_cache[cid]

    if uncached:
        total = len(sold_found)
        done_count = total - len(uncached)
        yield _emit('progress', step=f'Fetching items for {len(uncached)} sold contract(s)…')
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = {pool.submit(_fetch_items, (cid, rec)): cid for cid, rec in uncached.items()}
            for future in as_completed(futures):
                cid, items, err = future.result()
                sold_items_by_id[cid] = items
                if not err:
                    _contract_items_cache[cid] = items
                done_count += 1
                yield _emit('progress', step=f'Items: {done_count}/{total}', current=done_count, total=total, phase='items')

    quotas_out = []
    for q in quotas:
        sold_30d = 0
        for cid, rec in sold_found.items():
            items_named = [
                {
                    'type_id': int(i.get('type_id') or 0),
                    'quantity': int(i.get('quantity') or 0),
                    'is_included': bool(i.get('is_included', True)),
                    'name': '',
                }
                for i in sold_items_by_id.get(cid, [])
            ]
            sold_30d += _matches_quota(q, items_named, rec['contract'])
        quotas_out.append({**q, 'sold_30d': sold_30d})

    yield _emit('done', payload={'quotas': quotas_out})


@app.get('/api/contracts/sold-30d/scan')
def sold_30d_scan(alliance: str = 'all'):
    """NDJSON stream: fetch all sold contracts from the last 30 days and
    compute per-quota sold counts.  Populates the sold-contracts cache so
    subsequent per-quota lookups are instant.

    alliance: 'all' | 'main' | 'institute' — filters to slots in that alliance.
    """
    return StreamingResponse(_sold_30d_scan_stream(alliance=alliance), media_type='application/x-ndjson')


@app.get('/api/contracts/sold-30d')
def contracts_sold_30d(ship_type_id: int, title_filter: str = '', alliance: str = 'all'):
    """Return the number of contracts matching a quota that were sold in the
    last 30 days.  Uses the sold-contract list captured during the most recent
    scan so no extra ESI calls are needed for the contract listing itself.
    Items are fetched on demand (and cached) the first time each contract is
    requested.

    alliance: 'all' | 'main' | 'institute' — must match the alliance used in the scan.
    """
    cache = _sold_contracts_cache.get(alliance, {})
    if not cache:
        return {'sold_30d': None}

    ua = get_user_agent()
    quota = {'ship_type_id': ship_type_id, 'title_filter': title_filter}

    def _fetch_one(cid_rec):
        cid, rec = cid_rec
        last_err = None
        for attempt in range(3):
            try:
                return cid, fetch_character_contract_items(rec['char_id'], cid, rec['token'], ua), None
            except Exception as e:
                last_err = e
                if attempt < 2:
                    time.sleep(1.5 ** attempt)
        return cid, [], str(last_err)

    sold_items_by_id: dict[int, list] = {}
    uncached = {cid: rec for cid, rec in cache.items() if _contract_items_cache.get(cid) is None}
    for cid in cache:
        if cid not in uncached:
            sold_items_by_id[cid] = _contract_items_cache[cid]

    if uncached:
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = {pool.submit(_fetch_one, (cid, rec)): cid for cid, rec in uncached.items()}
            for future in as_completed(futures):
                cid, items, err = future.result()
                sold_items_by_id[cid] = items
                if not err:
                    _contract_items_cache[cid] = items

    sold_30d = 0
    for cid, rec in cache.items():
        items_named = [
            {
                'type_id': int(i.get('type_id') or 0),
                'quantity': int(i.get('quantity') or 0),
                'is_included': bool(i.get('is_included', True)),
                'name': '',
            }
            for i in sold_items_by_id.get(cid, [])
        ]
        sold_30d += _matches_quota(quota, items_named, rec['contract'])

    return {'sold_30d': sold_30d}


# Sov-structure type IDs. ESI returns structure_type_id on each sov record.
# TCUs (32226) were removed from the game in the 2024 sov rework, so we only
# enumerate IHUBs here.
_SOV_STRUCTURE_TYPE_NAMES = {
    32458: 'IHUB',
}

_SOV_CAMPAIGN_EVENT_LABELS = {
    'tcu_defense': 'TCU defense',
    'ihub_defense': 'IHUB defense',
    'station_defense': 'Station defense',
    'station_freeport': 'Station freeport',
}


def _sov_security_band(sec):
    """Bucket a raw system security_status (float) into hs/ls/ns for UI grouping."""
    if sec is None:
        return 'unknown'
    if sec >= 0.5:
        return 'highsec'
    if sec > 0.0:
        return 'lowsec'
    return 'nullsec'


def _safe(fn):
    """Run fn() and return its result, or None if anything raises."""
    try:
        return fn()
    except Exception:
        return None


def _build_alliance_section(
    alliance_id, owners, ua,
    sov_structures, sov_map, campaigns, kills_by_sys, jumps_by_sys,
    incursions, sys_cache, const_cache, region_cache,
):
    """Compute the per-alliance dashboard payload (systems, campaigns, summary)."""
    alliance = _safe(lambda: fetch_alliance_info(alliance_id, ua))

    # Held systems for this alliance (sov record OR an active structure).
    held = set()
    for s in sov_structures:
        if s.get('alliance_id') == alliance_id and s.get('solar_system_id'):
            held.add(s['solar_system_id'])
    for m in sov_map:
        if m.get('alliance_id') == alliance_id and m.get('system_id'):
            held.add(m['system_id'])

    # Structures grouped by system, alliance-filtered.
    structures_by_sys: dict[int, list[dict]] = {}
    for s in sov_structures:
        if s.get('alliance_id') != alliance_id:
            continue
        sid = s.get('solar_system_id')
        if not sid:
            continue
        structures_by_sys.setdefault(sid, []).append({
            'structure_id': s.get('structure_id'),
            'structure_type_id': s.get('structure_type_id'),
            'structure_type_name': _SOV_STRUCTURE_TYPE_NAMES.get(
                s.get('structure_type_id'), f"type {s.get('structure_type_id')}"
            ),
            'adm': s.get('vulnerability_occupancy_level'),
            'vulnerable_start_time': s.get('vulnerable_start_time'),
            'vulnerable_end_time': s.get('vulnerable_end_time'),
        })

    systems_out: list[dict] = []
    for sid in sorted(held):
        sysinfo = sys_cache.get(sid)
        if sysinfo is None:
            sysinfo = _safe(lambda: fetch_system_info(sid, ua))
            sys_cache[sid] = sysinfo
        if not sysinfo:
            continue
        const_id = sysinfo.get('constellation_id')
        const = const_cache.get(const_id) if const_id else None
        if const is None and const_id:
            const = _safe(lambda: fetch_constellation_info(const_id, ua)) or {}
            const_cache[const_id] = const
        region_id = (const or {}).get('region_id')
        region = region_cache.get(region_id) if region_id else None
        if region is None and region_id:
            region = _safe(lambda: fetch_region_info(region_id, ua)) or {}
            region_cache[region_id] = region
        k = kills_by_sys.get(sid, {})
        j = jumps_by_sys.get(sid, {})
        sec = sysinfo.get('security_status')
        systems_out.append({
            'system_id': sid,
            'system_name': sysinfo.get('name'),
            'security_status': sec,
            'security_band': _sov_security_band(sec),
            'constellation_id': const_id,
            'constellation_name': (const or {}).get('name'),
            'region_id': region_id,
            'region_name': (region or {}).get('name'),
            'structures': structures_by_sys.get(sid, []),
            'ship_kills': k.get('ship_kills', 0),
            'pod_kills': k.get('pod_kills', 0),
            'npc_kills': k.get('npc_kills', 0),
            'ship_jumps': j.get('ship_jumps', 0),
        })

    # Campaigns involving this alliance.
    alliance_campaigns = []
    for c in campaigns:
        defender = c.get('defender_id')
        attackers = {a.get('alliance_id') for a in (c.get('attackers') or []) if isinstance(a, dict)}
        if defender == alliance_id or alliance_id in attackers:
            sid = c.get('solar_system_id')
            sys_name = None
            if sid:
                sysinfo = sys_cache.get(sid)
                if sysinfo is None:
                    sysinfo = _safe(lambda: fetch_system_info(sid, ua))
                    sys_cache[sid] = sysinfo
                sys_name = (sysinfo or {}).get('name')
            alliance_campaigns.append({
                'campaign_id': c.get('campaign_id'),
                'event_type': c.get('event_type'),
                'event_label': _SOV_CAMPAIGN_EVENT_LABELS.get(
                    c.get('event_type'), c.get('event_type') or '?'
                ),
                'solar_system_id': sid,
                'solar_system_name': sys_name,
                'constellation_id': c.get('constellation_id'),
                'defender_id': defender,
                'defender_score': c.get('defender_score'),
                'attackers_score': c.get('attackers_score'),
                'start_time': c.get('start_time'),
                'role': 'defender' if defender == alliance_id else 'attacker',
            })

    incursions_in_holdings = []
    for inc in incursions:
        affected = set(inc.get('infested_solar_systems') or [])
        overlap = affected & held
        if not overlap:
            continue
        incursions_in_holdings.append({
            'constellation_id': inc.get('constellation_id'),
            'state': inc.get('state'),
            'influence': inc.get('influence'),
            'has_boss': inc.get('has_boss'),
            'staging_solar_system_id': inc.get('staging_solar_system_id'),
            'overlapping_system_ids': sorted(overlap),
        })

    adm_vals = [
        st['adm'] for sys_ in systems_out for st in sys_['structures']
        if isinstance(st.get('adm'), (int, float))
    ]
    ihub_count = sum(
        1 for sys_ in systems_out for st in sys_['structures']
        if st['structure_type_id'] == 32458
    )

    return {
        'alliance': {
            'id': alliance_id,
            'name': (alliance or {}).get('name'),
            'ticker': (alliance or {}).get('ticker'),
            'date_founded': (alliance or {}).get('date_founded'),
            'executor_corporation_id': (alliance or {}).get('executor_corporation_id'),
        },
        'owners': owners,
        'summary': {
            'system_count': len(systems_out),
            'ihub_count': ihub_count,
            'avg_adm': (sum(adm_vals) / len(adm_vals)) if adm_vals else None,
            'min_adm': min(adm_vals) if adm_vals else None,
            'max_adm': max(adm_vals) if adm_vals else None,
            'active_campaigns': len(alliance_campaigns),
        },
        'systems': systems_out,
        'campaigns': alliance_campaigns,
        'incursions': incursions_in_holdings,
    }


@app.get('/api/sov/overview')
def sov_overview():
    """Aggregate sov data across every corp/alliance the user has access to.

    Sources of "your corps": (1) the configured corp_id, (2) the active corp
    for every authenticated slot's character (since some toons sit in
    non-wardec alt corps in different alliances). One section per unique
    alliance; corps without an alliance are reported separately.
    """
    cfg = load_config()
    ua = get_user_agent()

    # ---- Step 1: enumerate source corps (config + each slot's character) ----
    # corp_id -> {'origins': set, 'toons': [{'slot','character_id','character_name'}]}
    corp_sources: dict[int, dict] = {}

    def _add_corp_source(corp_id, origin, toon=None):
        if not corp_id:
            return
        cid = int(corp_id)
        bucket = corp_sources.setdefault(cid, {'origins': set(), 'toons': []})
        bucket['origins'].add(origin)
        if toon:
            bucket['toons'].append(toon)

    if cfg.get('corp_id'):
        _add_corp_source(cfg['corp_id'], 'config')

    auth_errors = []
    for slot in list_authenticated_slots():
        try:
            cached = load_cached_tokens(slot) or {}
            access_token = cached.get('access_token')
            if not access_token:
                continue
            character_id = character_id_from_access_token(access_token)
            if not character_id:
                continue
            char_info = _safe(lambda: fetch_character_info(character_id, ua))
            if not char_info:
                auth_errors.append({'slot': slot, 'error': 'character info lookup failed'})
                continue
            _add_corp_source(
                char_info.get('corporation_id'),
                origin=slot,
                toon={
                    'slot': slot,
                    'character_id': character_id,
                    'character_name': char_info.get('name'),
                },
            )
        except Exception as e:
            auth_errors.append({'slot': slot, 'error': str(e)})

    # ---- Step 2: resolve each corp, group by alliance ----
    corp_info_by_id: dict[int, dict] = {}
    for cid in corp_sources:
        info = _safe(lambda: fetch_corporation_info(cid, ua))
        if info:
            corp_info_by_id[cid] = info

    # alliance_id -> {'corps':[...], 'toons':[...]}
    alliance_owners: dict[int, dict] = {}
    unaffiliated_corps = []
    for cid, src in corp_sources.items():
        corp = corp_info_by_id.get(cid)
        if not corp:
            continue
        owner_corp = {
            'id': cid,
            'name': corp.get('name'),
            'ticker': corp.get('ticker'),
            'member_count': corp.get('member_count'),
            'tax_rate': corp.get('tax_rate'),
            'war_eligible': corp.get('war_eligible'),
            'origins': sorted(src['origins']),
            'toons': src['toons'],
        }
        aid = corp.get('alliance_id')
        if aid:
            bucket = alliance_owners.setdefault(int(aid), {'corps': [], 'toons': []})
            bucket['corps'].append(owner_corp)
            bucket['toons'].extend(src['toons'])
        else:
            unaffiliated_corps.append(owner_corp)

    # ---- Step 3: fetch the heavy global data once ----
    sov_structures = _safe(lambda: fetch_sovereignty_structures(ua)) or []
    sov_map = _safe(lambda: fetch_sovereignty_map(ua)) or []
    campaigns = _safe(lambda: fetch_sovereignty_campaigns(ua)) or []
    kills_raw = _safe(lambda: fetch_system_kills(ua)) or []
    jumps_raw = _safe(lambda: fetch_system_jumps(ua)) or []
    incursions = _safe(lambda: fetch_incursions(ua)) or []
    kills_by_sys = {k['system_id']: k for k in kills_raw}
    jumps_by_sys = {j['system_id']: j for j in jumps_raw}

    sys_cache: dict[int, dict] = {}
    const_cache: dict[int, dict] = {}
    region_cache: dict[int, dict] = {}

    # ---- Step 4: per-alliance section ----
    alliances_out = []
    for aid, owners in alliance_owners.items():
        alliances_out.append(_build_alliance_section(
            aid, owners, ua,
            sov_structures, sov_map, campaigns, kills_by_sys, jumps_by_sys,
            incursions, sys_cache, const_cache, region_cache,
        ))

    # Sort: most sov holdings first, then by alliance name.
    alliances_out.sort(
        key=lambda a: (-(a['summary']['system_count'] or 0), a['alliance'].get('name') or '')
    )

    # Cluster-wide totals across all sections.
    total_systems = sum(a['summary']['system_count'] for a in alliances_out)
    total_campaigns = sum(a['summary']['active_campaigns'] for a in alliances_out)
    all_adm_vals = [
        st['adm'] for a in alliances_out for sys_ in a['systems'] for st in sys_['structures']
        if isinstance(st.get('adm'), (int, float))
    ]

    return {
        'alliances': alliances_out,
        'unaffiliated_corps': unaffiliated_corps,
        'totals': {
            'alliance_count': len(alliances_out),
            'corp_count': len(corp_info_by_id),
            'unaffiliated_corp_count': len(unaffiliated_corps),
            'system_count': total_systems,
            'active_campaigns': total_campaigns,
            'avg_adm': (sum(all_adm_vals) / len(all_adm_vals)) if all_adm_vals else None,
            'min_adm': min(all_adm_vals) if all_adm_vals else None,
        },
        'auth_errors': auth_errors,
        'fetched_at': int(time.time()),
    }


# ----------------------- Hooks & Hubs: structure fuel -----------------------
# Skyhook + sov-hub fuel comes from the authenticated corp-structures endpoint.
# Slot 4 is the intended source (a Director toon carrying
# esi-corporations.read_structures.v1), but any authenticated slot whose token
# has the scope + role contributes; structures are deduped by structure_id.
#
# NOTE: ESI does NOT expose Equinox power/workforce/installed-upgrades or the
# skyhook collection reservoir — only fuel. The workforce planner below is fed
# by manual user input instead (see workforce_plan.py).


def _parse_esi_time(s):
    """Parse an ESI ISO8601 timestamp (e.g. '2025-06-20T12:00:00Z') to epoch
    seconds, or None if absent/unparseable."""
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace('Z', '+00:00')).timestamp()
    except (ValueError, AttributeError):
        return None


def _classify_structure(type_name):
    """Bucket a structure by its resolved type name. Robust to unknown type_ids:
    anything we don't recognise lands in 'other' rather than being dropped."""
    low = (type_name or '').lower()
    if 'skyhook' in low:
        return 'skyhook'
    if 'sovereignty hub' in low:
        return 'hub'
    return 'other'


@app.get('/api/structures/fuel')
def structures_fuel():
    """Fuel status for skyhooks and sovereignty hubs across every authenticated
    slot's corp. Returns per-structure time-to-empty plus per-type summaries.
    Never hard-fails on a single slot/corp — auth/role problems are surfaced in
    `auth_errors` so a partial result still renders.
    """
    ua = get_user_agent()
    client_id, secret_key = get_app_credentials()

    # corp_id -> a working slot token (first slot found sitting in that corp).
    corp_token: dict[int, str] = {}
    auth_errors = []
    for slot in list_authenticated_slots():
        try:
            token = get_valid_access_token(client_id, secret_key, ua, slot=slot)
            character_id = character_id_from_access_token(token)
            char_info = _safe(lambda: fetch_character_info(character_id, ua)) if character_id else None
            corp_id = (char_info or {}).get('corporation_id')
            if corp_id:
                corp_token.setdefault(int(corp_id), token)
        except Exception as e:
            auth_errors.append({'slot': slot, 'error': str(e)})

    if not corp_token:
        auth_errors.append({
            'slot': 'slot4',
            'error': 'No authenticated slot resolved to a corp. Log in slot 4 with a '
                     'Director character on the Auth tab.',
        })

    # Fetch + dedup structures across corps.
    by_id: dict[int, dict] = {}
    for corp_id, token in corp_token.items():
        try:
            for s in fetch_corp_structures(corp_id, token, ua):
                sid = s.get('structure_id')
                if sid:
                    by_id[int(sid)] = s
        except requests.HTTPError as e:
            status = e.response.status_code if e.response is not None else '?'
            hint = (' — needs Director role + esi-corporations.read_structures.v1; '
                    're-login slot 4 on the Auth tab') if status == 403 else ''
            auth_errors.append({'corp_id': corp_id, 'error': f'structures HTTP {status}{hint}'})
        except Exception as e:
            auth_errors.append({'corp_id': corp_id, 'error': f'structures fetch failed: {e}'})

    structures = list(by_id.values())

    # Resolve type + system names in one bulk call.
    ids = set()
    for s in structures:
        for key in ('type_id', 'system_id'):
            if s.get(key):
                ids.add(int(s[key]))
    names = _safe(lambda: resolve_names(sorted(ids), ua)) or {} if ids else {}

    now = time.time()
    LOW_FUEL_SECONDS = 3 * 86400
    buckets = {'skyhook': [], 'hub': [], 'other': []}
    for s in structures:
        type_name = names.get(int(s['type_id'])) if s.get('type_id') else None
        system_name = names.get(int(s['system_id'])) if s.get('system_id') else None
        expires_epoch = _parse_esi_time(s.get('fuel_expires'))
        services = s.get('services') or []
        buckets[_classify_structure(type_name)].append({
            'structure_id': s.get('structure_id'),
            'name': s.get('name'),
            'system_name': system_name,
            'type_name': type_name,
            'fuel_expires': s.get('fuel_expires'),
            'seconds_remaining': (expires_epoch - now) if expires_epoch is not None else None,
            'state': s.get('state'),
            'services_online': sum(1 for sv in services if sv.get('state') == 'online'),
            'services_total': len(services),
        })

    def _by_remaining(r):
        # None (no fuel data, e.g. unanchoring) sorts last; otherwise soonest first.
        return (r['seconds_remaining'] is None, r['seconds_remaining'] or 0)

    def _summarize(rows):
        rem = [r['seconds_remaining'] for r in rows if r['seconds_remaining'] is not None]
        return {
            'count': len(rows),
            'low_count': sum(1 for v in rem if v < LOW_FUEL_SECONDS),
            'soonest_seconds': min(rem) if rem else None,
        }

    return {
        'skyhooks': sorted(buckets['skyhook'], key=_by_remaining),
        'hubs': sorted(buckets['hub'], key=_by_remaining),
        'other': sorted(buckets['other'], key=_by_remaining),
        'summary': {'skyhook': _summarize(buckets['skyhook']), 'hub': _summarize(buckets['hub'])},
        'auth_errors': auth_errors,
        'fetched_at': int(now),
    }


# ----------------------- Hooks & Hubs: workforce planner -----------------------
# Pure persistence for the manual upgrade/workforce planning table. The Equinox
# power/workforce/upgrade layer isn't in ESI, so the data is user-entered. All
# scenario math lives client-side (renderer/hooks-hubs-utils.js).


class WorkforcePlan(BaseModel):
    systems: Optional[list] = None
    transfers: Optional[list] = None
    catalog: Optional[list] = None


@app.get('/api/workforce-plan')
def get_workforce_plan():
    return load_plan()


@app.put('/api/workforce-plan')
def put_workforce_plan(plan: WorkforcePlan):
    return save_plan(plan.model_dump())


if __name__ == '__main__':
    uvicorn.run(app, host='127.0.0.1', port=PORT, log_level='info')
