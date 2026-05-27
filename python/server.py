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
    fetch_corp_wallets,
    fetch_corporation_info,
    fetch_incursions,
    fetch_region_info,
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
    send_evemail,
)
from refining import compute_refined_payout, is_donation, is_mineable, is_prismaticite
from validate import categorize, process_moon_contract, validate_all, validate_buyback_contract

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
    home_station_id: Optional[int] = None
    home_region_id: Optional[int] = None
    quotas: Optional[list[dict]] = None


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


# ----------------------- Contracts scan (alliance + public) -----------------------

# Module-scope cache so repeat scans don't re-download the same items.
_contract_items_cache: dict[int, list] = {}


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


def _scan_contracts_stream():
    """Stream outstanding item-exchange contracts visible to any logged-in
    slot at the configured home station.

    Walks /characters/{char_id}/contracts/ for each authenticated slot. Keeps
    alliance- and public-availability contracts whose start_location matches
    the home station. Slots in different alliances will each contribute only
    what they can see; results are deduplicated by contract_id.
    """
    cfg = load_config()
    station_id = int(cfg.get('home_station_id') or 0)
    quotas = list(cfg.get('quotas') or [])
    if not station_id:
        yield _emit('error', message='Set home_station_id in Config first')
        return

    slots = list_authenticated_slots()
    if not slots:
        yield _emit('error', message='Log in at least one slot on the Auth tab')
        return

    ua = get_user_agent()
    client_id, secret_key = get_app_credentials()
    allowed_avail = {'alliance', 'public'}

    # contract_id -> {'contract': record, 'slots': set, 'tokens': {slot: token}, ...}
    found: dict[int, dict] = {}

    for slot in slots:
        yield _emit('progress', step=f'Fetching contracts visible to {slot}…')
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
            char_contracts = fetch_character_contracts(char_id, token, ua)
        except Exception as e:
            yield _emit('progress', step=f'{slot}: fetch failed — {e}')
            continue

        kept = 0
        for c in char_contracts:
            if c.get('type') != 'item_exchange':
                continue
            if (c.get('status') or '').lower() != 'outstanding':
                continue
            if (c.get('availability') or '').lower() not in allowed_avail:
                continue
            if int(c.get('start_location_id') or 0) != station_id:
                continue
            cid = int(c.get('contract_id') or 0)
            if not cid:
                continue
            entry = found.get(cid)
            if entry is None:
                found[cid] = {
                    'contract': c,
                    'slots': {slot},
                    'tokens': {slot: token},
                    'char_ids': {slot: char_id},
                }
            else:
                entry['slots'].add(slot)
                entry['tokens'][slot] = token
                entry['char_ids'][slot] = char_id
            kept += 1
        yield _emit('progress', step=f'{slot}: {kept} matching at home station')

    if not found:
        yield _emit('done', payload={
            'station_id': station_id,
            'contracts': [],
            'quotas': [
                {**q, 'available': 0, 'missing': int(q.get('required') or 0), 'contracts': []}
                for q in quotas
            ],
        })
        return

    # ---- Fetch items per contract via the character endpoint ----
    items_by_id: dict[int, list] = {}
    items_errors: dict[int, str] = {}
    total = len(found)
    for idx, (cid, rec) in enumerate(found.items(), 1):
        cached = _contract_items_cache.get(cid)
        if cached is not None:
            items_by_id[cid] = cached
            yield _emit('progress', step=f'Items {idx}/{total}: {cid} (cached)')
            continue
        items = None
        last_err = None
        for slot in sorted(rec['slots']):
            try:
                items = fetch_character_contract_items(
                    rec['char_ids'][slot], cid, rec['tokens'][slot], ua,
                )
                break
            except Exception as e:
                last_err = str(e)
                continue
        if items is None:
            items_by_id[cid] = []
            items_errors[cid] = last_err or 'no slot could fetch items'
        else:
            items_by_id[cid] = items
            _contract_items_cache[cid] = items
        yield _emit('progress', step=f'Items {idx}/{total}: {cid}')

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
        contracts_out.append({
            'contract_id': cid,
            'title': c.get('title') or '',
            'price': c.get('price'),
            'availability': c.get('availability'),
            'issuer_id': c.get('issuer_id'),
            'issuer_name': issuer_names.get(int(c.get('issuer_id') or 0), ''),
            'date_issued': c.get('date_issued'),
            'date_expired': c.get('date_expired'),
            # UI badge: which logged-in slot(s) saw this contract, plus its
            # availability tag — useful for debugging access mismatches.
            'sources': sorted(rec['slots']) + (
                [c.get('availability')] if c.get('availability') else []
            ),
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
        'station_id': station_id,
        'contracts': contracts_out,
        'quotas': quotas_out,
    })


@app.get('/api/contracts/scan')
def scan_contracts():
    """NDJSON stream of outstanding alliance/public item-exchange contracts
    visible to any logged-in slot at the configured home station, plus
    per-quota aggregation.

    Emits ``progress`` events while fetching, then one ``done`` event with the
    full payload. The payload's quotas list mirrors the configured quotas with
    ``available``/``missing``/``contracts`` fields appended.
    """
    return StreamingResponse(
        _scan_contracts_stream(), media_type='application/x-ndjson',
    )


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


if __name__ == '__main__':
    uvicorn.run(app, host='127.0.0.1', port=PORT, log_level='info')
