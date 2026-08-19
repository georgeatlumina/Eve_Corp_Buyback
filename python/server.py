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
    PI_SLOTS,
    PI_SCOPES,
    FIT_SLOTS,
    FIT_SCOPES,
    FIT_READ_SCOPE,
    FIT_WRITE_SCOPE,
    build_authorize_url,
    character_id_from_access_token,
    clear_cached_tokens,
    decode_jwt_payload,
    exchange_code_for_tokens,
    get_app_credentials,
    get_user_agent,
    get_valid_access_token,
    list_authenticated_slots,
    list_authenticated_pi_slots,
    list_authenticated_fit_slots,
    load_cached_tokens,
    refresh_access_token,
    save_cached_tokens,
)
from config import load_config, save_config
from esi import (
    redact_secrets,
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
    fetch_character_assets,
    fetch_character_planets,
    fetch_character_planet_detail,
    fetch_character_skills,
    fetch_character_fittings,
    create_character_fitting,
    delete_character_fitting,
    fetch_incursions,
    fetch_industry_systems,
    fetch_market_prices,
    fetch_planet_info,
    fetch_region_info,
    fetch_region_market_history,
    fetch_region_market_orders,
    fetch_corp_orders,
    fetch_sovereignty_campaigns,
    fetch_sovereignty_map,
    fetch_sovereignty_structures,
    fetch_station_info,
    fetch_structure_info,
    fetch_structure_orders,
    fetch_structure_orders_paged,
    fetch_system_info,
    fetch_system_jumps,
    fetch_system_kills,
    resolve_names,
    resolve_ids,
    resolve_system_id,
    resolve_type_ids,
    send_evemail,
    fetch_type_info,
    fetch_group_info,
)
from esi_retry import call_with_retry, status_of
from scan_history import ScanMetrics, append_run, git_info
from janice import (
    appraise_items,
    create_appraisal,
    create_appraisal_from_text,
    fetch_buy_prices,
    fetch_immediate_prices,
    fetch_type_sell_price,
    items_from_appraisal,
)
import builds
import industry
import liquidation
import pi as pi_planner
import pi_layout
import stockpile
try:
    import pyfa_engine  # vendored Pyfa eos fitting engine (optional; needs deps + eve.db)
except Exception as _e:  # pragma: no cover - keeps the sidecar up if eos/deps missing
    pyfa_engine = None
    _PYFA_IMPORT_ERROR = str(_e)
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

PORT = 8766
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
    if s not in VALID_SLOTS and s not in PI_SLOTS and s not in FIT_SLOTS:
        raise HTTPException(400, f'Invalid slot {s!r}; expected one of {VALID_SLOTS + PI_SLOTS + FIT_SLOTS}')
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
    pi_poco_tax_rate: Optional[float] = None
    pi_templates_dir: Optional[str] = None


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


# --------------------------- Planetary Interaction ---------------------------
# The 8 standard PI planet types by ESI type_id. Shattered/special planets
# (other ids in universe group 7) can't host colonies, so they map to no P0.
_PI_PLANET_TYPE_BY_ID = {
    11: 'Temperate', 12: 'Ice', 13: 'Gas', 2014: 'Oceanic',
    2015: 'Lava', 2016: 'Barren', 2017: 'Storm', 2063: 'Plasma',
}


@app.get('/api/pi/data')
def pi_data():
    """Static PI dataset for the planner UI: type metadata (name/tier/volume),
    the full P0->P4 schematic tree, and the planet-type -> P0 map."""
    d = pi_planner.load_pi_data()
    return {
        'types': {str(k): v for k, v in d['types'].items()},
        'schematics': d['schematics'],
        'planet_types': list(d['planet_types']),
        'planet_p0': d['planet_p0'],
    }


@app.get('/api/pi/pins')
def pi_pins():
    """Static PI *pin* dataset (colony hardware) for the layout builder:
    command centers, extractors, factories, storage, launchpads with their
    CPU/power loads, capacities, and the command-center CPU/PG-per-level table."""
    pins_path = os.path.join(os.path.dirname(pi_planner.DATA_PATH), 'pi_pins.json')
    with open(pins_path, encoding='utf-8') as f:
        return json.load(f)


_eve_systems_cache: list = []


@app.get('/api/pi/systems')
def pi_systems():
    """Bundled list of every solar-system name — powers the PI Planner search
    autocomplete (no ESI round-trip per keystroke)."""
    global _eve_systems_cache
    if not _eve_systems_cache:
        path = os.path.join(os.path.dirname(pi_planner.DATA_PATH), 'eve_systems.json')
        with open(path, encoding='utf-8') as f:
            _eve_systems_cache = json.load(f)
    return {'systems': _eve_systems_cache}


def _pi_resolve_system(system_name, ua, data):
    """system name -> {system_id, name, planets:[{planet_id,type_id,planet_type}],
    p0_available:[type_id]} or None if the system name doesn't resolve."""
    system_id, canon = resolve_system_id(system_name, ua)
    if not system_id:
        return None
    sysinfo = fetch_system_info(system_id, ua)
    planets, p0 = [], set()
    for pl in (sysinfo.get('planets') or []):
        pid = pl.get('planet_id')
        try:
            info = fetch_planet_info(pid, ua)
        except Exception:
            continue
        ptype = _PI_PLANET_TYPE_BY_ID.get(info.get('type_id'))
        planets.append({'planet_id': pid, 'type_id': info.get('type_id'), 'planet_type': ptype})
        if ptype:
            p0.update(data['planet_p0'].get(ptype, []))
    return {'system_id': system_id, 'name': canon or system_name,
            'planets': planets, 'p0_available': sorted(p0)}


@app.get('/api/pi/analyze')
def pi_analyze(system: Optional[str] = None, tax_rate: Optional[float] = None,
               tiers: Optional[str] = None):
    """Rank PI production chains by full-chain profit per unit, priced at Jita.

    ``system`` (optional) restricts results to chains buildable from the planets
    in that solar system; omit it to score every chain. ``tax_rate`` overrides
    the saved ``pi_poco_tax_rate`` for this call. ``tiers`` is a comma list of
    output tiers to include (default ``1,2,3,4``).
    """
    cfg = load_config()
    ua = get_user_agent()
    data = pi_planner.load_pi_data()

    rate = tax_rate if tax_rate is not None else float(cfg.get('pi_poco_tax_rate') or 0.05)
    rate = max(0.0, min(1.0, float(rate)))
    try:
        tier_filter = tuple(int(x) for x in (tiers.split(',') if tiers else ['1', '2', '3', '4']) if x)
    except ValueError:
        raise HTTPException(400, 'tiers must be a comma list of integers, e.g. 1,2,3,4')

    system_out = None
    if system and system.strip():
        system_out = _pi_resolve_system(system.strip(), ua, data)
        if not system_out:
            raise HTTPException(404, f'System not found: {system!r}')
        p0_available = system_out['p0_available']
    else:
        p0_available = sorted(data['p0_ids'])

    api_key = cfg.get('janice_api_key') or None
    all_ids = [int(t) for t in data['types']]
    sell, price_note = {}, None
    if api_key:
        try:
            priced = fetch_immediate_prices(all_ids, 'Jita 4-4', api_key=api_key, user_agent=ua)
            sell = {tid: (v.get('sell') or 0) for tid, v in priced.items()}
        except Exception as e:
            price_note = f'Jita pricing failed: {e}'
    else:
        price_note = 'No Janice API key set — profits show tax only. Add a key in Config.'

    try:
        base = fetch_market_prices(ua)  # ESI adjusted prices for POCO tax
    except Exception:
        base = {}

    rows = pi_planner.rank_chains(p0_available, sell, base, tax_rate=rate,
                                  data=data, tiers=tier_filter)
    return {
        'system': system_out,
        'p0_available': p0_available,
        'tax_rate': rate,
        'market': 'Jita 4-4',
        'priced': bool(api_key and not price_note),
        'price_note': price_note,
        'rows': rows,
    }


# ---- PI colony templates: read/write the EVE client's template folder --------

def _pi_templates_dir(cfg):
    d = (cfg.get('pi_templates_dir') or '').strip()
    if not d:
        d = os.path.join(os.path.expanduser('~'), 'Documents', 'EVE',
                         'PlanetaryInteractionTemplates')
    return d


def _safe_template_name(name):
    base = os.path.basename((name or '').strip())
    if not base:
        raise HTTPException(400, 'template name is required')
    if not base.lower().endswith('.json'):
        base += '.json'
    return base


@app.get('/api/pi/templates')
def pi_templates_list():
    """List PI colony templates in the EVE templates folder (parsed summaries),
    so the builder can show what's already saved without a manual import."""
    cfg = load_config()
    d = _pi_templates_dir(cfg)
    out = []
    if os.path.isdir(d):
        for fn in sorted(os.listdir(d)):
            if not fn.lower().endswith('.json'):
                continue
            path = os.path.join(d, fn)
            try:
                m = pi_layout.parse_template(pi_layout.load_template_file(path))
                out.append({
                    'name': fn,
                    'comment': m.get('comment', ''),
                    'planet_type_id': m['planet_type_id'],
                    'planet_type': _PI_PLANET_TYPE_BY_ID.get(m['planet_type_id']),
                    'cmd_ctr_level': m['cmd_ctr_level'],
                    'diameter': m['diameter'],
                    'pins': len(m['pins']),
                    'links': len(m['links']),
                    'routes': len(m['routes']),
                    'mtime': os.path.getmtime(path),
                })
            except Exception as e:
                out.append({'name': fn, 'error': str(e)})
    return {'dir': d, 'exists': os.path.isdir(d), 'templates': out}


@app.get('/api/pi/templates/read')
def pi_template_read(name: str):
    """Read one template and return its parsed colony model (+ raw doc)."""
    cfg = load_config()
    path = os.path.join(_pi_templates_dir(cfg), _safe_template_name(name))
    if not os.path.isfile(path):
        raise HTTPException(404, f'template not found: {name}')
    try:
        doc = pi_layout.load_template_file(path)
        return {'name': os.path.basename(path), 'layout': pi_layout.parse_template(doc)}
    except Exception as e:
        raise HTTPException(400, f'failed to read template: {e}')


class PiTemplateSaveRequest(BaseModel):
    name: str
    layout: dict


@app.post('/api/pi/templates/save')
def pi_template_save(req: PiTemplateSaveRequest):
    """Save a colony model to the EVE templates folder as importable JSON, so it
    shows up directly in the in-game template list."""
    cfg = load_config()
    d = _pi_templates_dir(cfg)
    path = os.path.join(d, _safe_template_name(req.name))
    try:
        pi_layout.save_template_file(req.layout, path)
    except (KeyError, TypeError) as e:
        raise HTTPException(400, f'invalid colony model: {e}')
    except OSError as e:
        raise HTTPException(500, f'could not write template: {e}')
    return {'saved': os.path.basename(path), 'dir': d, 'path': path}


# ---- PI live colonies via ESI (extractor timers + restart alerts) -----------

PI_COLONY_SCOPE = 'esi-planets.manage_planets.v1'


def _pi_scoped_slots():
    """Yield (slot, token, character_id, character_name) for every authed slot
    that carries the manage_planets scope — the dedicated PI slots plus any main
    slot that happens to have it."""
    try:
        client_id, secret_key = get_app_credentials()
    except Exception:
        return
    ua = get_user_agent()
    for slot in list_authenticated_slots() + list_authenticated_pi_slots():
        try:
            token = get_valid_access_token(client_id, secret_key, ua, slot=slot)
            payload = decode_jwt_payload(token)
        except Exception:
            continue
        scps = payload.get('scp')
        scope_list = scps if isinstance(scps, list) else [scps] if scps else []
        if PI_COLONY_SCOPE in scope_list:
            yield slot, token, character_id_from_access_token(token), payload.get('name')


def _load_pi_pins_meta():
    pins_path = os.path.join(os.path.dirname(pi_planner.DATA_PATH), 'pi_pins.json')
    with open(pins_path, encoding='utf-8') as f:
        return json.load(f)['pins']


@app.get('/api/pi/colonies')
def pi_colonies():
    """Live PI colonies for every authed character carrying the manage_planets
    scope. Each colony carries its extractors (product + expiry), factory
    outputs, storage/launchpad contents, a pin breakdown, and Jita valuation
    (contents value + estimated output value/day), plus a per-colony status
    (expired / expiring <24h / ok / idle). Drives the colony-manager view."""
    ua = get_user_agent()
    now = datetime.now(timezone.utc)
    cfg = load_config()
    data = pi_planner.load_pi_data()
    pins_meta = _load_pi_pins_meta()
    sch_to_out = {s['schematic_id']: s['outputs'][0][0] for s in data['schematics']}

    def tname(tid):
        return (data['types'].get(str(tid), {}).get('name')
                or (pins_meta.get(str(tid)) or {}).get('name') or f'type {tid}')

    def kind_of(tid):
        return (pins_meta.get(str(tid)) or {}).get('kind')

    colonies, any_slot, errors = [], False, []
    sys_names = {}

    def sysname(sid):
        if sid not in sys_names:
            try:
                sys_names[sid] = fetch_system_info(sid, ua).get('name')
            except Exception:
                sys_names[sid] = None
        return sys_names[sid]

    for slot, token, cid, cname in _pi_scoped_slots():
        any_slot = True
        try:
            planets = fetch_character_planets(cid, token, ua)
        except Exception as e:
            errors.append(f'{cname or slot}: {e}')
            continue
        for pl in planets:
            try:
                detail = fetch_character_planet_detail(cid, pl['planet_id'], token, ua)
            except Exception:
                detail = {'pins': []}
            extractors, factories, by_kind, contents = [], [], {}, {}
            soonest = None
            for p in detail.get('pins', []):
                by_kind[kind_of(p.get('type_id')) or 'other'] = by_kind.get(kind_of(p.get('type_id')) or 'other', 0) + 1
                for c in (p.get('contents') or []):
                    contents[c['type_id']] = contents.get(c['type_id'], 0) + c['amount']
                ed = p.get('extractor_details')
                if ed:
                    exp = p.get('expiry_time')
                    exp_dt = None
                    if exp:
                        try:
                            exp_dt = datetime.fromisoformat(exp.replace('Z', '+00:00'))
                        except ValueError:
                            pass
                    prod = ed.get('product_type_id')
                    extractors.append({
                        'product_type_id': prod, 'product': tname(prod) if prod else None,
                        'expiry_time': exp, 'qty_per_cycle': ed.get('qty_per_cycle'),
                        'cycle_time': ed.get('cycle_time'), 'heads': len(ed.get('heads') or []),
                    })
                    if exp_dt and (soonest is None or exp_dt < soonest):
                        soonest = exp_dt
                elif p.get('schematic_id') is not None:
                    out = sch_to_out.get(p['schematic_id'])
                    factories.append({'product_type_id': out, 'product': tname(out) if out else None})
            if not extractors:
                status = 'idle'
            elif soonest is None:
                status = 'unknown'
            elif soonest <= now:
                status = 'expired'
            elif (soonest - now).total_seconds() < 24 * 3600:
                status = 'expiring'
            else:
                status = 'ok'
            colonies.append({
                'slot': slot, 'character': cname, 'character_id': cid,
                'planet_id': pl['planet_id'],
                'planet_type': (pl.get('planet_type') or '').title(),
                'system': sysname(pl.get('solar_system_id')),
                'system_id': pl.get('solar_system_id'),
                'upgrade_level': pl.get('upgrade_level'), 'num_pins': pl.get('num_pins'),
                'last_update': pl.get('last_update'),
                'extractors': extractors, 'factories': factories,
                'pins_by_kind': by_kind, '_contents': contents,
                'soonest_expiry': soonest.isoformat() if soonest else None, 'status': status,
            })

    # Price everything (extractor products + stored contents) at Jita in one pass.
    type_ids = set()
    for c in colonies:
        type_ids.update(e['product_type_id'] for e in c['extractors'] if e['product_type_id'])
        type_ids.update(c['_contents'].keys())
    prices, api_key = {}, cfg.get('janice_api_key') or None
    if api_key and type_ids:
        try:
            imm = fetch_immediate_prices(sorted(type_ids), 'Jita 4-4', api_key=api_key, user_agent=ua)
            prices = {tid: (v.get('sell') or 0) for tid, v in imm.items()}
        except Exception as e:
            errors.append(f'pricing: {e}')

    def price(tid):
        return float(prices.get(int(tid)) or 0) if tid else 0.0

    total_contents_value, total_output_day = 0.0, 0.0
    for c in colonies:
        out_day = 0.0
        for e in c['extractors']:
            pr = price(e['product_type_id'])
            qpc, ct = e.get('qty_per_cycle') or 0, e.get('cycle_time') or 0
            e['isk_per_day'] = qpc * (86400.0 / ct) * pr if ct else 0.0
            out_day += e['isk_per_day']
        contents = [{'type_id': tid, 'name': tname(tid), 'amount': amt, 'isk': amt * price(tid)}
                    for tid, amt in sorted(c['_contents'].items(), key=lambda x: -x[1])]
        c['contents'] = contents
        c['contents_value'] = sum(x['isk'] for x in contents)
        c['output_value_per_day'] = out_day
        del c['_contents']
        total_contents_value += c['contents_value']
        total_output_day += out_day

    colonies.sort(key=lambda c: (c['soonest_expiry'] or '9999'))
    return {'configured': any_slot, 'scope': PI_COLONY_SCOPE, 'now': now.isoformat(),
            'priced': bool(api_key), 'colonies': colonies, 'errors': errors,
            'total_contents_value': total_contents_value,
            'total_output_value_per_day': total_output_day}


@app.get('/api/pi/colony')
def pi_colony_detail(character_id: int, planet_id: int):
    """Fetch one live colony and convert it to the builder's colony model, so it
    can be opened on the canvas, tweaked, and re-exported. Planet diameter isn't
    exposed by ESI, so it defaults (adjustable in the builder)."""
    ua = get_user_agent()
    token = None
    for _slot, tok, cid, _name in _pi_scoped_slots():
        if cid == character_id:
            token = tok
            break
    if not token:
        raise HTTPException(404, 'no authorized character matches that character_id')

    # planet type + upgrade level come from the summary list
    ptype_id, level = None, 1
    try:
        for pl in fetch_character_planets(character_id, token, ua):
            if pl['planet_id'] == planet_id:
                name = (pl.get('planet_type') or '').title()
                ptype_id = next((tid for tid, n in _PI_PLANET_TYPE_BY_ID.items() if n == name), None)
                level = pl.get('upgrade_level', 1)
                break
    except Exception as e:
        raise HTTPException(502, f'planet lookup failed: {e}')
    if ptype_id is None:
        raise HTTPException(404, 'planet not found on this character')

    try:
        detail = fetch_character_planet_detail(character_id, planet_id, token, ua)
    except Exception as e:
        raise HTTPException(502, f'colony fetch failed: {e}')

    data = pi_planner.load_pi_data()
    sch_to_out = {s['schematic_id']: s['outputs'][0][0] for s in data['schematics']}
    ptname = _PI_PLANET_TYPE_BY_ID.get(ptype_id, '')
    layout = pi_layout.from_esi_detail(
        detail, ptype_id, 5000.0, level, f'{ptname} (from live colony)', sch_to_out)
    return {'layout': layout, 'diameter_default': True}


# Interplanetary Consolidation adds +1 deployable planet per level (base 1, so V => 6).
PI_SKILLS_SCOPE = 'esi-skills.read_skills.v1'
INTERPLANETARY_CONSOLIDATION_SKILL_ID = 2495


@app.get('/api/pi/planet-capacity')
def pi_planet_capacity():
    """Per-toon maximum deployable PI planets = 1 + Interplanetary Consolidation
    level, read from ESI skills. Powers the optimizer's planet budget. Toons
    authed before the read_skills scope was added are flagged ``needs_reauth`` —
    re-auth them in the PI Characters section to include them."""
    ua = get_user_agent()
    toons, total, seen = [], 0, set()
    for _slot, token, cid, cname in _pi_scoped_slots():
        if cid in seen:
            continue
        seen.add(cid)
        payload = decode_jwt_payload(token)
        scps = payload.get('scp')
        scope_list = scps if isinstance(scps, list) else [scps] if scps else []
        if PI_SKILLS_SCOPE not in scope_list:
            toons.append({'character_id': cid, 'name': cname, 'ic_level': None,
                          'max_planets': None, 'needs_reauth': True})
            continue
        try:
            skills = fetch_character_skills(cid, token, ua)
        except Exception as e:  # network / 403 after a revoked token
            toons.append({'character_id': cid, 'name': cname, 'ic_level': None,
                          'max_planets': None, 'needs_reauth': False, 'error': str(e)})
            continue
        level = 0
        for s in skills.get('skills') or []:
            if s.get('skill_id') == INTERPLANETARY_CONSOLIDATION_SKILL_ID:
                level = int(s.get('active_skill_level') or 0)
                break
        mx = 1 + level
        total += mx
        toons.append({'character_id': cid, 'name': cname, 'ic_level': level,
                      'max_planets': mx, 'needs_reauth': False})
    toons.sort(key=lambda t: (t.get('name') or '').lower())
    return {'toons': toons, 'total_max': total,
            'skill_id': INTERPLANETARY_CONSOLIDATION_SKILL_ID}


_pi_price_cache: dict[int, dict] = {}
_PI_PRICE_TTL = 300  # 5 min — plenty fresh for a per-day/month value estimate


def _pi_poco_tax_base(type_id: int, ua: str):
    """The per-1-final-unit taxable base for a commodity's whole production chain:
    sum over every produced tier of (CCP adjusted price * units produced per final
    unit). POCO export tax = tax_rate * this — i.e. tax is charged on every launch
    off a planet across the chain, exactly as pi.evaluate() models it. Returns None
    if the item isn't producible or adjusted prices are unavailable."""
    try:
        base_values = fetch_market_prices(ua)  # ESI adjusted prices (keyless) — what POCO taxes on
        ev = pi_planner.evaluate(type_id, {}, base_values, tax_rate=1.0)
        return ev['chain_export_tax']
    except Exception:
        return None


@app.get('/api/pi/price')
def pi_price(type_id: int, bust: bool = False):
    """Immediate Jita per-unit buy/sell for one commodity, plus the chain-wide POCO
    tax base, for the optimizer's ISK/day valuation. ``poco_tax_base`` is the
    taxable value of every export across the chain per 1 final unit (charge =
    tax_rate * poco_tax_base). Buy/sell need a Janice API key; the tax base and the
    saved POCO rate do not."""
    now = time.time()
    if not bust:
        cached = _pi_price_cache.get(type_id)
        if cached and (now - cached['fetched_at']) < _PI_PRICE_TTL:
            return cached['result']
    cfg = load_config()
    ua = get_user_agent()
    api_key = cfg.get('janice_api_key') or None
    poco = float(cfg.get('pi_poco_tax_rate') or 0.05)
    poco_base = _pi_poco_tax_base(type_id, ua)
    row = {}
    if api_key:
        try:
            priced = fetch_immediate_prices([type_id], 'Jita 4-4', api_key=api_key, user_agent=ua)
        except Exception as e:
            raise HTTPException(502, f'Jita price lookup failed: {e}')
        row = priced.get(int(type_id)) or {}
    result = {'type_id': type_id, 'buy': row.get('buy'), 'sell': row.get('sell'),
              'priced': row.get('buy') is not None, 'poco_tax_rate': poco,
              'poco_tax_base': poco_base, 'market': 'Jita 4-4'}
    if not api_key:
        result['note'] = 'Set a Janice API key in Config to price PI output.'
    _pi_price_cache[type_id] = {'fetched_at': now, 'result': result}
    return result


# ============================ Production Planner (industry) ============================
# Multi-tier manufacturing + reaction BOM explosion (python/industry.py, backed by
# the bundled data/industry.json). Given a target build list + on-hand stock and an
# industry config (ME, structure/reaction bonuses, buy-vs-build overrides), returns
# the jobs to run and the raw materials to buy, then prices both against Jita via
# Janice (immediate sell = acquisition cost) and estimates job install cost from
# ESI adjusted prices (EIV × system cost index × (1 + tax)). Pure-engine + pricing
# split mirrors the PI and refining flows.

class IndustryPlanRequest(BaseModel):
    targets_text: Optional[str] = None          # pasted "Name xN" list
    targets: Optional[list] = None              # [{type_id|name, qty}]
    stock_text: Optional[str] = None            # pasted EVE inventory
    stock: Optional[dict] = None                # {type_id: qty}
    me: float = 10                              # global manufacturing ME %
    structure_material_mult: float = 1.0        # manufacturing facility/rig material multiplier
    reaction_material_mult: float = 1.0         # reaction facility/rig material multiplier
    buy_ids: Optional[list] = None              # type_ids to buy instead of build
    cost_index: float = 0.05                    # fallback flat cost index (when no system set)
    system: Optional[str] = None                # solar system for live per-activity cost indices
    tax: float = 0.0                            # facility tax fraction on install cost
    invention: bool = True                      # account for T2 invention (datacores/decryptors/ME)
    decryptor: Optional[str] = None             # decryptor name (industry.DECRYPTORS key) or None
    invention_skill_level: int = 4              # assumed level of the 3 invention skills
    include_tree: bool = True                   # build the hierarchical production tree
    market: str = 'Jita 4-4'
    price: bool = True


@app.get('/api/industry/decryptors')
def industry_decryptors():
    """The invention decryptors (name + probability/ME/TE/run modifiers) for the
    planner's decryptor picker."""
    return {'decryptors': [
        {'key': k, 'name': v['name'] or 'No decryptor', 'prob': v['prob'],
         'me': v['me'], 'te': v['te'], 'runs': v['runs']}
        for k, v in industry.DECRYPTORS.items()
    ]}


@app.get('/api/industry/cost-indices')
def industry_cost_indices(system: str = ''):
    """Live per-activity cost indices for a solar system (manufacturing /
    reaction / invention / …), for the planner's system picker. Returns
    ``{name, system_id, indices}`` or ``{name, error}`` when it can't resolve."""
    _ci, info = _industry_cost_indices(system, 0.0, get_user_agent())
    return info or {'name': '', 'indices': {}}


@app.get('/api/industry/search')
def industry_search(q: str = '', limit: int = 25):
    """Type-ahead over buildable products (manufacturing + reaction outputs).
    Returns ``[{type_id, name, activity}]`` matching ``q`` (case-insensitive
    substring), prefix matches first."""
    data = industry.load_industry_data()
    ql = (q or '').strip().lower()
    if not ql:
        return {'results': []}
    hits = []
    for tid, recipe in data['recipes'].items():
        name = industry.type_name(tid, data)
        pos = name.lower().find(ql)
        if pos >= 0:
            hits.append((pos, name, tid, recipe['activity']))
    hits.sort(key=lambda h: (h[0], h[1]))
    return {'results': [{'type_id': t, 'name': n, 'activity': a}
                        for _pos, n, t, a in hits[:max(1, min(200, limit))]]}


# Preferred display order for the reaction catalog (product groups), roughly the
# reaction chain order: composites/polymers/molecular first, then the simple
# intermediates they consume.
_REACTION_GROUP_ORDER = [
    'Composite', 'Hybrid Polymers', 'Molecular-Forged Materials',
    'Biochemical Material', 'Intermediate Materials', 'Unrefined Mineral',
]


@app.get('/api/reactions/recipes')
def reaction_recipes():
    """Catalog of every reaction recipe (product) for the Reaction Calculator's
    browse panel, grouped by product group. Returns ``{groups: [{group, items:
    [{type_id, name, output_qty, inputs}]}], total}`` where ``inputs`` is the
    number of distinct input materials per run."""
    data = industry.load_industry_data()
    types = data['types']
    by_group: dict = {}
    for tid, recipe in data['recipes'].items():
        if recipe.get('activity') != industry.REACTION:
            continue
        meta = types.get(tid) or {}
        group = meta.get('group_name') or 'Other'
        by_group.setdefault(group, []).append({
            'type_id': tid,
            'name': industry.type_name(tid, data),
            'output_qty': recipe.get('output_qty') or 1,
            'inputs': len(recipe.get('materials') or []),
        })
    order = {g: i for i, g in enumerate(_REACTION_GROUP_ORDER)}
    groups = []
    for group in sorted(by_group, key=lambda g: (order.get(g, 999), g)):
        groups.append({'group': group, 'items': sorted(by_group[group], key=lambda x: x['name'])})
    return {'groups': groups, 'total': sum(len(g['items']) for g in groups)}


def _industry_resolve_stock(stock_field, stock_text, data):
    stock = {}
    for k, v in (stock_field or {}).items():
        try:
            stock[int(k)] = stock.get(int(k), 0) + float(v)
        except (TypeError, ValueError):
            continue
    if stock_text:
        for row in stockpile.parse_paste(stock_text):
            tid = industry.resolve_type(row['name'], data)
            if tid:
                stock[tid] = stock.get(tid, 0) + row['qty']
    return stock


def _industry_fetch_prices(type_ids, market, api_key, data):
    """One Janice appraisal for a set of type_ids -> {type_id: {sell, buy}} + the
    price source. Best-effort: returns ({}, 'error: …') on failure."""
    prices = {}
    if not type_ids:
        return prices, None
    paste = '\n'.join(industry.type_name(tid, data) for tid in sorted(type_ids))
    try:
        appr = appraise_items(paste, market, api_key=api_key)
        for row in appr['items']:
            prices[row['type_id']] = {'sell': row['sell_unit'], 'buy': row['buy_unit']}
        return prices, appr.get('source')
    except Exception as e:  # noqa: BLE001 — pricing is best-effort
        return prices, f'error: {e}'


def _industry_cost_indices(system_name, flat_index, ua):
    """Resolve a system's live per-activity cost indices (manufacturing /
    reaction / invention) from ESI, falling back to ``flat_index`` for anything
    missing. Returns (cost_indices_dict, system_info | None). ``system_info``
    carries an ``error`` key when the name doesn't resolve."""
    cost_indices = {'default': flat_index}
    if not (system_name or '').strip():
        return cost_indices, None
    try:
        sid, canonical = resolve_system_id(system_name, ua)
        if not sid:
            return cost_indices, {'name': system_name, 'error': 'system not found'}
        idx = fetch_industry_systems(ua).get(int(sid), {})
        cost_indices = {
            'manufacturing': idx.get('manufacturing', flat_index),
            'reaction': idx.get('reaction', flat_index),
            'invention': idx.get('invention', flat_index),
            'default': flat_index,
        }
        return cost_indices, {'system_id': int(sid), 'name': canonical, 'indices': idx}
    except Exception as e:  # noqa: BLE001 — index lookup is best-effort
        return cost_indices, {'name': system_name, 'error': str(e)}


def _industry_apply_prices(result, targets, prices, adjusted, cost_indices, tax, data):
    """Cost a plan result against the shared price maps: annotates raw rows +
    jobs with per-line cost and returns a totals dict. Raw acquisition = Jita
    sell; job install = EIV (base materials × ESI adjusted price) × the activity's
    cost index × (1+tax). ``cost_indices`` maps activity -> index (with a
    'default' fallback), so manufacturing and reaction jobs bill at their own
    system index."""
    recipes = data['recipes']
    default_idx = cost_indices.get('default', 0.0)
    totals = {'materials_cost': 0.0, 'jobs_cost': 0.0, 'build_cost': 0.0,
              'buy_cost': 0.0, 'product_sell_value': 0.0, 'invention_cost': 0.0}
    for r in result['raw_materials']:
        unit = (prices.get(r['type_id']) or {}).get('sell') or 0.0
        r['unit_price'] = unit
        r['line_cost'] = unit * r['qty']
        totals['materials_cost'] += r['line_cost']
        if r.get('invention'):
            totals['invention_cost'] += r['line_cost']
    for j in result['jobs']:
        recipe = recipes.get(j['type_id'], {})
        eiv = sum((adjusted.get(m[0], 0.0) * m[1]) for m in recipe.get('materials', [])) * j['runs']
        install = eiv * cost_indices.get(j['activity'], default_idx) * (1.0 + tax)
        j['eiv'] = eiv
        j['install_cost'] = install
        totals['jobs_cost'] += install
    for t in targets:
        p = prices.get(t['type_id']) or {}
        totals['buy_cost'] += (p.get('sell') or 0.0) * t['qty']
        totals['product_sell_value'] += (p.get('buy') or 0.0) * t['qty']
    totals['build_cost'] = totals['materials_cost'] + totals['jobs_cost']
    return totals


@app.post('/api/industry/plan')
def industry_plan(req: IndustryPlanRequest):
    """Explode a build request into jobs + a raw shopping list, then price it."""
    data = industry.load_industry_data()

    targets = []
    unresolved = []
    for t in (req.targets or []):
        tid = t.get('type_id') or industry.resolve_type(t.get('name', ''), data)
        if tid:
            targets.append({'type_id': int(tid), 'qty': int(t.get('qty') or 1)})
        else:
            unresolved.append(t.get('name'))
    if req.targets_text:
        for p in industry.parse_targets(req.targets_text, data):
            if p['unresolved']:
                unresolved.append(p['name'])
            else:
                targets.append({'type_id': p['type_id'], 'qty': p['qty']})
    if not targets:
        raise HTTPException(400, 'No resolvable build targets. Use exact EVE item names or type IDs.')

    stock = _industry_resolve_stock(req.stock, req.stock_text, data)
    engine_cfg = {
        'me': req.me,
        'structure_material_mult': req.structure_material_mult,
        'reaction_material_mult': req.reaction_material_mult,
        'buy_ids': req.buy_ids or [],
        'invention': req.invention,
        'decryptor': req.decryptor,
        'invention_skill_level': req.invention_skill_level,
        'include_tree': req.include_tree,
    }
    result = industry.plan(targets, stock=stock, config=engine_cfg, data=data)
    result['unresolved_targets'] = unresolved

    totals = {'materials_cost': 0.0, 'jobs_cost': 0.0, 'build_cost': 0.0,
              'buy_cost': 0.0, 'product_sell_value': 0.0, 'invention_cost': 0.0}
    pricing = {'market': req.market, 'priced': False, 'source': None,
               'api_key': bool((load_config().get('janice_api_key') or '').strip())}

    if req.price:
        ua = get_user_agent()
        api_key = load_config().get('janice_api_key') or None
        price_ids = {r['type_id'] for r in result['raw_materials']} | {t['type_id'] for t in targets}
        prices, pricing['source'] = _industry_fetch_prices(price_ids, req.market, api_key, data)
        pricing['priced'] = bool(prices)
        try:
            adjusted = fetch_market_prices(ua)
        except Exception:
            adjusted = {}
        cost_indices, cost_system = _industry_cost_indices(req.system, req.cost_index, ua)
        totals = _industry_apply_prices(result, targets, prices, adjusted, cost_indices, req.tax, data)
        result['cost_system'] = cost_system

    result['totals'] = totals
    result['pricing'] = pricing
    result['config'] = {'me': req.me, 'structure_material_mult': req.structure_material_mult,
                        'reaction_material_mult': req.reaction_material_mult,
                        'cost_index': req.cost_index, 'tax': req.tax}
    return result


class IndustryProfitRequest(BaseModel):
    items: list = []                            # [type_id] or [{type_id}] product ids
    batch: int = 100                            # units built per item (amortizes reaction/invention minimums)
    me: float = 10
    structure_material_mult: float = 1.0
    reaction_material_mult: float = 1.0
    cost_index: float = 0.05
    system: Optional[str] = None                # solar system for live per-activity cost indices
    tax: float = 0.0
    sales_fee: float = 0.036                    # broker + sales tax on the sell revenue
    invention: bool = True
    decryptor: Optional[str] = None
    invention_skill_level: int = 4
    market: str = 'Jita 4-4'


@app.post('/api/industry/profit')
def industry_profit(req: IndustryProfitRequest):
    """Compare the build profitability of a list of favourite products.

    Each item is built at a **batch** quantity (default 100) so reaction- and
    invention-run minimums amortize the way they do in practice, then every
    number is reported **per unit**. All materials + products are priced in ONE
    Janice call, so N favourites cost a single round-trip. Sorted by unit profit."""
    data = industry.load_industry_data()
    batch = max(1, int(req.batch or 1))
    ids = []
    seen = set()
    for it in (req.items or []):
        tid = (it.get('type_id') or industry.resolve_type(it.get('name', ''), data)) if isinstance(it, dict) \
            else industry.resolve_type(it, data)
        if tid and int(tid) in data['recipes'] and int(tid) not in seen:
            seen.add(int(tid))
            ids.append(int(tid))
    if not ids:
        return {'rows': [], 'batch': batch, 'pricing': {'market': req.market, 'priced': False}}

    engine_cfg = {'me': req.me, 'structure_material_mult': req.structure_material_mult,
                  'reaction_material_mult': req.reaction_material_mult, 'invention': req.invention,
                  'decryptor': req.decryptor, 'invention_skill_level': req.invention_skill_level,
                  'include_tree': False}

    plans = []
    price_ids = set()
    for tid in ids:
        res = industry.plan([{'type_id': tid, 'qty': batch}], config=engine_cfg, data=data)
        plans.append((tid, res))
        price_ids |= {r['type_id'] for r in res['raw_materials']} | {tid}

    ua = get_user_agent()
    api_key = load_config().get('janice_api_key') or None
    prices, source = _industry_fetch_prices(price_ids, req.market, api_key, data)
    try:
        adjusted = fetch_market_prices(ua)
    except Exception:
        adjusted = {}
    cost_indices, cost_system = _industry_cost_indices(req.system, req.cost_index, ua)

    rows = []
    for tid, res in plans:
        totals = _industry_apply_prices(res, [{'type_id': tid, 'qty': batch}], prices, adjusted,
                                        cost_indices, req.tax, data)
        sell_unit = (prices.get(tid) or {}).get('sell') or 0.0
        revenue_unit = sell_unit * (1.0 - req.sales_fee)
        build_unit = totals['build_cost'] / batch
        profit_unit = revenue_unit - build_unit
        rows.append({
            'type_id': tid,
            'name': industry.type_name(tid, data),
            'build_cost': build_unit,
            'materials_cost': totals['materials_cost'] / batch,
            'jobs_cost': totals['jobs_cost'] / batch,
            'invention_cost': totals['invention_cost'] / batch,
            'sell_value': revenue_unit,
            'profit': profit_unit,
            'margin': (profit_unit / build_unit) if build_unit > 0 else None,
            'priced': sell_unit > 0 and build_unit > 0,
        })
    rows.sort(key=lambda r: (r['profit'] is None, -(r['profit'] or 0)))
    return {'rows': rows, 'batch': batch, 'cost_system': cost_system,
            'pricing': {'market': req.market, 'source': source, 'priced': bool(prices),
                        'api_key': bool((load_config().get('janice_api_key') or '').strip())}}


# ============================ Ship fitting (Pyfa eos) ============================
# Vendored Pyfa `eos` engine (python/pyfa) computes fit stats headless; the
# renderer owns the fit document and posts it here for a stateless recompute.

def _require_pyfa():
    if pyfa_engine is None:
        raise HTTPException(503, f'Fitting engine unavailable: {globals().get("_PYFA_IMPORT_ERROR", "not loaded")}')
    if not pyfa_engine.available():
        raise HTTPException(503, 'Fitting engine unavailable: eve.db missing (build with build_eve_db.py).')


def _fit_price(doc):
    """Best-effort Jita sell valuation of everything in a fit (needs a Janice key)."""
    cfg = load_config()
    api_key = cfg.get('janice_api_key') or None
    if not api_key:
        return None
    ids = set()
    if doc.get('ship'):
        d = pyfa_engine.item_detail(doc['ship']) if str(doc['ship']).isdigit() else None
        if d:
            ids.add(d['typeID'])
    for coll in ('modules', 'drones', 'cargo'):
        for row in doc.get(coll, []) or []:
            for k in ('type', 'charge'):
                v = row.get(k)
                if v and str(v).isdigit():
                    ids.add(int(v))
    if not ids:
        return None
    try:
        priced = fetch_immediate_prices(sorted(ids), 'Jita 4-4', api_key=api_key, user_agent=get_user_agent())
    except Exception:
        return None
    total = 0.0
    for row in doc.get('modules', []) or []:
        for k in ('type', 'charge'):
            v = row.get(k)
            if v and str(v).isdigit():
                total += (priced.get(int(v), {}) or {}).get('sell') or 0
    for coll in ('drones', 'cargo'):
        for row in doc.get(coll, []) or []:
            v = row.get('type')
            if v and str(v).isdigit():
                total += ((priced.get(int(v), {}) or {}).get('sell') or 0) * int(row.get('amount', 1))
    if doc.get('ship') and str(doc['ship']).isdigit():
        total += (priced.get(int(doc['ship']), {}) or {}).get('sell') or 0
    return round(total, 2)


@app.get('/api/fit/status')
def fit_status():
    """Whether the fitting engine is ready (deps + eve.db present)."""
    ok = pyfa_engine is not None and pyfa_engine.available()
    return {'available': ok, 'error': None if ok else globals().get('_PYFA_IMPORT_ERROR', 'eve.db missing')}


@app.get('/api/fit/ships')
def fit_ships():
    _require_pyfa()
    return {'ships': pyfa_engine.list_ships()}


@app.get('/api/fit/skills')
def fit_skills():
    _require_pyfa()
    return {'skills': pyfa_engine.list_skills()}


@app.get('/api/fit/items')
def fit_items(q: str, categories: Optional[str] = None, limit: int = 60, slot: Optional[str] = None,
              max_pg: Optional[float] = None, max_cpu: Optional[float] = None):
    _require_pyfa()
    cats = [c.strip() for c in categories.split(',')] if categories else None
    return {'items': pyfa_engine.search_items(q, categories=cats, limit=min(200, max(1, limit)),
                                              slot=slot, max_pg=max_pg, max_cpu=max_cpu)}


@app.get('/api/fit/item/{type_id}')
def fit_item(type_id: int):
    _require_pyfa()
    d = pyfa_engine.item_detail(type_id)
    if not d:
        raise HTTPException(404, 'item not found')
    return d


@app.get('/api/fit/charges')
def fit_charges(module_type_id: int):
    """Charges/scripts a module accepts (its chargeGroups + size) — for a
    compatible, browsable ammo picker."""
    _require_pyfa()
    return {'charges': pyfa_engine.compatible_charges(module_type_id)}


@app.post('/api/fit/compute')
def fit_compute(doc: dict, price: bool = True):
    """Compute stats for a fit document. Optionally include a Jita sell valuation."""
    _require_pyfa()
    if not doc.get('ship'):
        raise HTTPException(400, 'fit doc requires a ship')
    stats = pyfa_engine.compute_fit(doc)
    if stats.get('error'):
        raise HTTPException(400, stats['error'])
    if price:
        stats['price'] = _fit_price(doc)
    return stats


@app.post('/api/fit/parse')
def fit_parse(body: dict):
    """Parse an EFT block into a fit document."""
    _require_pyfa()
    doc = pyfa_engine.parse_eft(body.get('eft', ''))
    if doc.get('error'):
        raise HTTPException(400, doc['error'])
    return doc


@app.post('/api/fit/export')
def fit_export(doc: dict):
    """Render a fit document back to EFT text."""
    _require_pyfa()
    if not doc.get('ship'):
        raise HTTPException(400, 'fit doc requires a ship')
    return {'eft': pyfa_engine.render_eft(doc)}


# ---- ESI in-game fitting sync (open/save/delete character fittings) ----
_SLOT_FLAG = {3: 'HiSlot', 2: 'MedSlot', 1: 'LoSlot', 4: 'RigSlot', 5: 'SubSystemSlot'}
_FLAG_SLOT = {'HiSlot': 3, 'MedSlot': 2, 'LoSlot': 1, 'RigSlot': 4, 'SubSystemSlot': 5}


def _fit_scoped_slots():
    """Yield (slot, token, character_id, name) for every authed slot carrying the
    read_fittings scope — dedicated fitting slots plus any main slot (they have it)."""
    try:
        client_id, secret_key = get_app_credentials()
    except Exception:
        return
    ua = get_user_agent()
    for slot in list_authenticated_slots() + list_authenticated_fit_slots():
        try:
            token = get_valid_access_token(client_id, secret_key, ua, slot=slot)
            payload = decode_jwt_payload(token)
        except Exception:
            continue
        scps = payload.get('scp')
        scope_list = scps if isinstance(scps, list) else [scps] if scps else []
        if FIT_READ_SCOPE in scope_list:
            yield slot, token, character_id_from_access_token(token), payload.get('name')


def _fit_token_for(character_id, need_write=False):
    """Return an access token for a character that can read (or write) fittings."""
    want = FIT_WRITE_SCOPE if need_write else FIT_READ_SCOPE
    client_id, secret_key = get_app_credentials()
    ua = get_user_agent()
    for slot in list_authenticated_slots() + list_authenticated_fit_slots():
        try:
            token = get_valid_access_token(client_id, secret_key, ua, slot=slot)
            payload = decode_jwt_payload(token)
        except Exception:
            continue
        if character_id_from_access_token(token) != int(character_id):
            continue
        scps = payload.get('scp')
        scope_list = scps if isinstance(scps, list) else [scps] if scps else []
        if want in scope_list:
            return token
    return None


def _esi_fit_to_doc(esi_fit):
    """Convert an ESI fitting to our fit document (modules + charges grouped by
    slot flag, drones from DroneBay, cargo from Cargo)."""
    by_flag = {}
    drones, cargo = [], []
    for it in esi_fit.get('items', []):
        flag = it.get('flag', '')
        tid, qty = it.get('type_id'), int(it.get('quantity', 1))
        if flag == 'DroneBay':
            drones.append({'type': tid, 'amount': qty})
        elif flag == 'Cargo':
            cargo.append({'type': tid, 'amount': qty})
        else:
            by_flag.setdefault(flag, []).append((tid, qty))
    modules = []
    for flag in sorted(by_flag, key=lambda f: (f.rstrip('0123456789'), int(''.join(filter(str.isdigit, f)) or 0))):
        module_tid, charge_tid = None, None
        for tid, _q in by_flag[flag]:
            d = pyfa_engine.item_detail(tid)
            if d and d.get('category') == 'Charge':
                charge_tid = tid
            else:
                module_tid = tid
        if module_tid is not None:
            m = {'type': module_tid}
            if charge_tid is not None:
                m['charge'] = charge_tid
            modules.append(m)
    return {'ship': esi_fit.get('ship_type_id'), 'name': esi_fit.get('name', 'Imported'),
            'description': esi_fit.get('description', ''), 'modules': modules, 'drones': drones,
            'cargo': cargo, 'implants': [], 'boosters': [], 'skills': 'all5'}


def _doc_to_esi_fit(doc):
    """Convert our fit document to an ESI fitting body. Uses a compute pass to get
    each module's slot + per-slot index for the flags (charges share the flag)."""
    stats = pyfa_engine.compute_fit(doc)
    if stats.get('error'):
        raise HTTPException(400, stats['error'])
    items = []
    slot_counters = {}
    for m in stats.get('modules', []):
        base = _SLOT_FLAG.get(m.get('slot'))
        if not base:
            continue
        idx = slot_counters.get(base, 0)
        slot_counters[base] = idx + 1
        flag = f'{base}{idx}'
        items.append({'flag': flag, 'quantity': 1, 'type_id': m['typeID']})
        if m.get('charge'):
            items.append({'flag': flag, 'quantity': 1, 'type_id': m['charge']['typeID']})
    for d in doc.get('drones', []) or []:
        items.append({'flag': 'DroneBay', 'quantity': int(d.get('amount', 1)), 'type_id': int(d['type'])})
    for c in doc.get('cargo', []) or []:
        items.append({'flag': 'Cargo', 'quantity': int(c.get('amount', 1)), 'type_id': int(c['type'])})
    name = (doc.get('name') or 'Fit')[:50]
    desc = (doc.get('description') or 'Made with NDA Management Tool')[:500]
    return {'name': name, 'description': desc, 'ship_type_id': stats['ship']['typeID'], 'items': items}


@app.get('/api/fit/esi/characters')
def fit_esi_characters():
    """Characters (deduped) whose token can read/write in-game fittings."""
    seen, out = set(), []
    for _slot, token, cid, cname in _fit_scoped_slots():
        if cid in seen:
            continue
        seen.add(cid)
        payload = decode_jwt_payload(token)
        scps = payload.get('scp')
        scope_list = scps if isinstance(scps, list) else [scps] if scps else []
        out.append({'character_id': cid, 'name': cname, 'can_write': FIT_WRITE_SCOPE in scope_list})
    out.sort(key=lambda c: (c.get('name') or '').lower())
    return {'characters': out}


@app.get('/api/fit/esi/fittings')
def fit_esi_fittings(character_id: int):
    """List a character's in-game saved fittings, converted to fit documents."""
    _require_pyfa()
    token = _fit_token_for(character_id)
    if not token:
        raise HTTPException(403, 'no authorized character with read_fittings for that id')
    try:
        raw = fetch_character_fittings(character_id, token, get_user_agent())
    except Exception as e:
        raise HTTPException(502, f'ESI fittings fetch failed: {e}')
    out = []
    for f in raw:
        try:
            doc = _esi_fit_to_doc(f)
            out.append({'fitting_id': f.get('fitting_id'), 'name': f.get('name'),
                        'ship_type_id': f.get('ship_type_id'), 'items': len(f.get('items', [])), 'doc': doc})
        except Exception:
            pass
    out.sort(key=lambda x: (x.get('name') or '').lower())
    return {'fittings': out}


@app.post('/api/fit/esi/save')
def fit_esi_save(body: dict):
    """Save the given fit document to a character's in-game fittings (ESI write)."""
    _require_pyfa()
    character_id = body.get('character_id')
    doc = body.get('doc')
    if not character_id or not doc or not doc.get('ship'):
        raise HTTPException(400, 'character_id and a fit doc with a ship are required')
    token = _fit_token_for(character_id, need_write=True)
    if not token:
        raise HTTPException(403, 'no authorized character with write_fittings for that id')
    esi_fit = _doc_to_esi_fit(doc)
    try:
        res = create_character_fitting(character_id, esi_fit, token, get_user_agent())
    except Exception as e:
        raise HTTPException(502, f'ESI fitting save failed: {e}')
    return {'saved': True, 'fitting_id': res.get('fitting_id'), 'name': esi_fit['name']}


@app.delete('/api/fit/esi/fittings')
def fit_esi_delete(character_id: int, fitting_id: int):
    """Delete an in-game saved fitting (ESI write)."""
    token = _fit_token_for(character_id, need_write=True)
    if not token:
        raise HTTPException(403, 'no authorized character with write_fittings for that id')
    try:
        delete_character_fitting(character_id, fitting_id, token, get_user_agent())
    except Exception as e:
        raise HTTPException(502, f'ESI fitting delete failed: {e}')
    return {'deleted': True, 'fitting_id': fitting_id}


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
    # PI/fitting slots authorize alts with only their minimal scope set; main
    # slots get the full configured scope set (which includes fittings too).
    if slot_name in PI_SLOTS:
        scopes = list(PI_SCOPES)
    elif slot_name in FIT_SLOTS:
        scopes = list(FIT_SCOPES)
    else:
        scopes = cfg['scopes']
    state_token = secrets.token_urlsafe(32)
    with _auth_lock:
        _auth_state['pending'][state_token] = slot_name
        _auth_state['completed'][slot_name] = False
        _auth_state['errors'].pop(slot_name, None)
    url = build_authorize_url(client_id, REDIRECT_URI, scopes, state_token)
    # The renderer opens `url` itself via shell.openExternal — reliable in the
    # packaged app, where this frozen sidecar's webbrowser.open is a no-op (which
    # is why "Login" appeared to do nothing). Returned for the renderer to open.
    return {'opened': False, 'url': url, 'slot': slot_name}


@app.get('/api/auth/fit-slots')
def auth_fit_slots():
    """Status for every dedicated fitting slot — Auth tab's Fitting Characters section."""
    return {'slots': [_slot_status(s) for s in FIT_SLOTS]}


@app.get('/api/auth/pi-slots')
def auth_pi_slots():
    """Status for every PI slot — used by the Auth tab's PI Characters section."""
    return {'slots': [_slot_status(s) for s in PI_SLOTS]}


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
    try:
        wallets = fetch_corp_wallets(cfg['corp_id'], token, get_user_agent())
    except requests.HTTPError as e:
        status = e.response.status_code if e.response is not None else 502
        if status == 403:
            # Corp wallet reads need the Accountant / Junior Accountant role AND
            # the wallet scope — most members have neither, so surface a clear
            # reason instead of a bare 500.
            raise HTTPException(403, 'This character can’t read the corp wallet. It needs the '
                                     'Accountant or Junior Accountant corp role, plus the '
                                     'esi-wallet.read_corporation_wallets.v1 scope (re-auth after '
                                     'enabling it in the EVE developer portal).')
        body = ''
        try:
            body = (e.response.text or '')[:200] if e.response is not None else ''
        except Exception:
            body = ''
        raise HTTPException(502, f'ESI wallet fetch failed ({status}). {body}'.strip())
    except Exception as e:
        raise HTTPException(502, f'ESI wallet fetch failed: {e}')
    total = sum(w.get('balance', 0) for w in wallets)
    return {'wallets': wallets, 'total': total}


def _friendly_contracts_error(e) -> str:
    """Safe, user-facing message for a failed corp-contracts ESI fetch. Redacts
    the access token that ``requests`` embeds in the URL of its exception text,
    and gives an actionable reason for the common 403."""
    status = getattr(getattr(e, 'response', None), 'status_code', None)
    if status == 403:
        return ('Corp contracts access denied (403). The signed-in character needs the '
                'esi-contracts.read_corporation_contracts.v1 scope and a corp role permitting '
                'contract reads — re-auth after enabling the scope in the EVE developer portal.')
    return f'ESI fetch failed: {redact_secrets(e)}'


# Contract location ids >= this are player structures (citadels/refineries),
# resolvable only via the authed structure endpoint; below it are NPC stations.
_STRUCTURE_ID_FLOOR = 1_000_000_000_000
_STRUCTURE_SCOPE = 'esi-universe.read_structures.v1'
_location_name_cache: dict[int, str] = {}


class LocationNamesRequest(BaseModel):
    ids: list[int] = []


def _structure_capable_tokens(ua):
    """Access tokens for every authenticated main-slot character whose token
    carries the read-structures scope. A player structure's name is only
    readable by a character with docking access to it, and different alts can
    dock at different structures — so we try them all rather than just the
    default slot. Tokens lacking the scope are skipped (they'd only 403)."""
    tokens = []
    try:
        client_id, secret_key = get_app_credentials()
    except Exception:
        return tokens
    for slot in list_authenticated_slots():
        try:
            tok = get_valid_access_token(client_id, secret_key, ua, slot=slot)
            scp = decode_jwt_payload(tok).get('scp') or []
        except Exception:
            continue
        if isinstance(scp, str):
            scp = [scp]
        if _STRUCTURE_SCOPE in scp:
            tokens.append(tok)
    return tokens


@app.post('/api/location-names')
def resolve_location_names(req: LocationNamesRequest):
    """Resolve contract location ids -> names for the ore/moon buyback UI.

    NPC stations (< 1e12) use the public station endpoint. Player structures
    (>= 1e12) use the authed structure endpoint (needs esi-universe.read_
    structures.v1 + docking access); we try every authenticated character that
    holds the scope, since a given structure may only be dockable by one of
    them. Best-effort: an id we can't resolve comes back as null so the UI
    falls back to the raw id. Successful resolutions are cached for the process
    lifetime. Also returns ``structures_unauthorized`` = true when a structure
    id was requested but no authenticated character has the read-structures
    scope, so the UI can prompt for a re-auth instead of silently showing ids."""
    ua = get_user_agent()
    ids = []
    for raw in (req.ids or []):
        try:
            ids.append(int(raw))
        except (TypeError, ValueError):
            continue
    ids = list(dict.fromkeys(ids))  # de-dup, preserve order

    need_structures = any(i >= _STRUCTURE_ID_FLOOR and i not in _location_name_cache for i in ids)
    struct_tokens = _structure_capable_tokens(ua) if need_structures else []

    out = {}
    for loc in ids:
        if loc in _location_name_cache:
            out[str(loc)] = _location_name_cache[loc]
            continue
        name = None
        try:
            if loc >= _STRUCTURE_ID_FLOOR:
                for tok in struct_tokens:
                    try:
                        name = (fetch_structure_info(loc, tok, ua) or {}).get('name')
                    except Exception:
                        name = None  # this char lacks access/scope — try the next
                    if name:
                        break
            else:
                name = (fetch_station_info(loc, ua) or {}).get('name')
        except Exception:
            name = None
        if name:
            _location_name_cache[loc] = name
        out[str(loc)] = name
    return {'names': out, 'structures_unauthorized': bool(need_structures and not struct_tokens)}


# ============================== Character assets ==============================
# My Assets tab + the reactions auto-detect. Reads every connected toon's assets
# (esi-assets.read_assets.v1), aggregates by (character, type, root location),
# and resolves type + location names (stations public, structures via a scoped
# token — same path as the buyback location resolver above, systems via
# /universe/names).
_ASSETS_SCOPE = 'esi-assets.read_assets.v1'
_type_name_cache: dict[int, str] = {}


def _resolve_type_names(type_ids, ua):
    """type_id -> name via /universe/names (batched), memoised for the process."""
    want = {int(x) for x in type_ids}
    need = [t for t in want if t not in _type_name_cache]
    if need:
        try:
            for tid, nm in resolve_names(need, ua).items():
                _type_name_cache[int(tid)] = nm
        except Exception:  # noqa: BLE001 — names are best-effort
            pass
    return {t: _type_name_cache.get(t) for t in want}


def _connected_asset_slots():
    """[(kind, slot)] for every authenticated main / PI / fitting slot."""
    return ([('main', s) for s in list_authenticated_slots()]
            + [('pi', s) for s in list_authenticated_pi_slots()]
            + [('fit', s) for s in list_authenticated_fit_slots()])


def _slot_identity(slot, ua):
    """{token, character_id, name, scopes} for a slot, or None if unusable."""
    try:
        client_id, secret_key = get_app_credentials()
        tok = get_valid_access_token(client_id, secret_key, ua, slot=slot)
        payload = decode_jwt_payload(tok)
    except Exception:
        return None
    scp = payload.get('scp') or []
    if isinstance(scp, str):
        scp = [scp]
    try:
        cid = int(str(payload.get('sub', '')).rsplit(':', 1)[-1])
    except Exception:
        cid = None
    return {'token': tok, 'character_id': cid, 'name': payload.get('name') or slot, 'scopes': scp}


def _root_location(asset, by_item):
    """Walk an asset up its container/ship chain to the station / structure /
    system it ultimately sits in. Returns (location_id, location_type)."""
    cur = asset
    seen = set()
    while (cur.get('location_type') == 'item' and cur.get('location_id') in by_item
           and cur.get('item_id') not in seen and len(seen) < 32):
        seen.add(cur['item_id'])
        cur = by_item[cur['location_id']]
    return cur.get('location_id'), cur.get('location_type')


def _resolve_asset_locations(pairs, ua):
    """{(location_id, location_type)} -> {location_id: name}. Stations via the
    public endpoint, player structures via any scoped token, systems via
    /universe/names. Shares the buyback location-name cache."""
    names = {}
    struct_tokens = None
    system_ids = []
    for loc_id, loc_type in pairs:
        if loc_id is None:
            continue
        if loc_id in _location_name_cache:
            names[loc_id] = _location_name_cache[loc_id]
            continue
        nm = None
        try:
            if loc_id >= _STRUCTURE_ID_FLOOR:
                if struct_tokens is None:
                    struct_tokens = _structure_capable_tokens(ua)
                for tok in struct_tokens:
                    try:
                        nm = (fetch_structure_info(loc_id, tok, ua) or {}).get('name')
                    except Exception:
                        nm = None
                    if nm:
                        break
            elif loc_type == 'solar_system' or 30000000 <= loc_id < 32000000:
                system_ids.append(loc_id)
            elif loc_type == 'station' or 60000000 <= loc_id < 64000000:
                nm = (fetch_station_info(loc_id, ua) or {}).get('name')
        except Exception:
            nm = None
        if nm:
            _location_name_cache[loc_id] = nm
            names[loc_id] = nm
    if system_ids:
        try:
            for sid, snm in resolve_names(system_ids, ua).items():
                _location_name_cache[int(sid)] = snm
                names[int(sid)] = snm
        except Exception:
            pass
    return names


@app.get('/api/assets/toons')
def assets_toons():
    """Connected characters (main + PI + fitting slots) for the My Assets toon
    picker, each flagged with whether its token holds the assets scope."""
    ua = get_user_agent()
    out = []
    for kind, slot in _connected_asset_slots():
        ident = _slot_identity(slot, ua)
        if not ident or ident['character_id'] is None:
            continue
        out.append({'slot': slot, 'kind': kind, 'character_id': ident['character_id'],
                    'name': ident['name'], 'has_assets': _ASSETS_SCOPE in ident['scopes']})
    return {'toons': out}


@app.get('/api/assets')
def get_assets(slot: Optional[str] = None, all: bool = False):
    """Character assets for the My Assets tab + the reactions auto-detect.

    Pass a single ``slot`` or ``all=1`` to aggregate every connected toon that
    holds the assets scope. Rows are aggregated by (character, type, root
    location) with type + location names resolved. ``unauthorized`` lists
    connected toons lacking the assets scope (re-auth to include them)."""
    ua = get_user_agent()
    if all:
        targets = [s for _k, s in _connected_asset_slots()]
    elif slot:
        targets = [slot]
    else:
        raise HTTPException(400, 'Specify ?slot=<slot> or ?all=1')

    per_char = []       # (character_id, name, slot, assets)
    unauthorized = []
    errors = []
    for s in targets:
        ident = _slot_identity(s, ua)
        if not ident or ident['character_id'] is None:
            continue
        if _ASSETS_SCOPE not in ident['scopes']:
            unauthorized.append({'slot': s, 'name': ident['name']})
            continue
        try:
            assets = fetch_character_assets(ident['character_id'], ident['token'], ua)
        except Exception as e:  # noqa: BLE001 — best-effort per toon
            errors.append({'slot': s, 'name': ident['name'], 'error': str(e)})
            continue
        per_char.append((ident['character_id'], ident['name'], s, assets))

    agg = {}            # (cid, type_id, loc_id) -> row
    type_ids = set()
    loc_pairs = set()
    for cid, cname, s, assets in per_char:
        by_item = {a['item_id']: a for a in assets}
        for a in assets:
            tid = a.get('type_id')
            if tid is None:
                continue
            type_ids.add(tid)
            loc_id, loc_type = _root_location(a, by_item)
            loc_pairs.add((loc_id, loc_type))
            key = (cid, tid, loc_id)
            row = agg.get(key)
            if not row:
                row = {'character_id': cid, 'toon': cname, 'type_id': tid, 'quantity': 0,
                       'location_id': loc_id, 'location_type': loc_type}
                agg[key] = row
            row['quantity'] += int(a.get('quantity') or 1)

    type_names = _resolve_type_names(type_ids, ua)
    loc_names = _resolve_asset_locations(loc_pairs, ua)
    rows = []
    for row in agg.values():
        row['type_name'] = type_names.get(row['type_id']) or f"type {row['type_id']}"
        row['location_name'] = loc_names.get(row['location_id']) or (
            'In container' if row['location_type'] == 'item' else str(row['location_id']))
        rows.append(row)
    rows.sort(key=lambda r: (r['location_name'], r['type_name']))
    return {'assets': rows, 'unauthorized': unauthorized, 'errors': errors,
            'toon_count': len(per_char)}


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


@app.get('/api/zkill/suggest')
def zkill_suggest(q: str = ''):
    """Type-ahead search suggestions from zKillboard's autocomplete endpoint
    (pilots / corps / alliances / systems only)."""
    from zkill import fetch_suggestions
    term = (q or '').strip()
    if len(term) < 3:
        return {'suggestions': []}
    try:
        suggestions = fetch_suggestions(term, get_user_agent())
    except Exception:
        # Type-ahead is best-effort; never surface an error into the search box.
        suggestions = []
    return {'suggestions': suggestions}


class ZkillBoardRequest(BaseModel):
    query: str = ''
    kind: str = 'auto'          # auto | character | corporation | alliance | system
    filter: str = 'all'         # all | kills | losses
    limit: int = 40
    page: int = 1
    entity_id: Optional[int] = None  # set when a suggestion was picked (skips name resolution)


@app.post('/api/zkill/board')
def zkill_board(req: ZkillBoardRequest):
    """Native zKillboard: resolve a search term to an EVE entity and return its
    enriched kill/loss list (see zkill.build_board)."""
    from zkill import build_board
    q = (req.query or '').strip()
    if not q and not req.entity_id:
        raise HTTPException(400, 'Enter a pilot, corporation, alliance or system name to search.')
    try:
        board = build_board(
            q, kind=req.kind or 'auto', board_filter=req.filter or 'all',
            limit=req.limit, page=req.page, user_agent=get_user_agent(),
            entity_id=req.entity_id,
        )
    except ValueError as e:
        if str(e) == 'no-entity':
            raise HTTPException(404, f'No pilot, corporation, alliance or system found matching {q!r}.')
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(502, f'zKillboard lookup failed: {e}')
    return board


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
            yield _emit('error', message=_friendly_contracts_error(e))
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
    # Pay out the oldest contracts first: process (and therefore stream/display)
    # moon/ore contracts oldest -> newest by issue date. ESI's date_issued is
    # ISO-8601, so a lexicographic sort is chronological; any contract missing
    # the field sorts first.
    buckets['moon'].sort(key=lambda c: c.get('date_issued') or '')
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


def _github_pat_capability(owner, repo, pat, user_agent):
    """Probe a single PAT against `GET /repos/{owner}/{repo}`, returning the
    token's effective capabilities. GitHub reports the authenticated token's
    grant in `permissions: {admin, push, pull}`, so one call tells us whether a
    PAT can read (`pull`) and/or write (`push`) this exact repo — the precise
    thing the Config check needs. Returns a plain dict (never raises)."""
    headers = {
        'Accept': 'application/vnd.github+json',
        'User-Agent': user_agent,
        'X-GitHub-Api-Version': '2022-11-28',
        'Authorization': f'Bearer {pat}',
    }
    api = f'https://api.github.com/repos/{owner}/{repo}'
    try:
        resp = requests.get(api, headers=headers, timeout=15)
    except Exception as e:
        return {'ok': False, 'reason': 'network', 'detail': str(e)}
    if resp.status_code in (401, 403):
        return {'ok': False, 'reason': 'rejected', 'status': resp.status_code}
    if resp.status_code == 404:
        # Fine-grained PATs not granted the repo see it as non-existent.
        return {'ok': False, 'reason': 'not_found', 'status': resp.status_code}
    if resp.status_code >= 400:
        return {'ok': False, 'reason': 'error', 'status': resp.status_code}
    perms = (resp.json() or {}).get('permissions') or {}
    return {'ok': True, 'pull': bool(perms.get('pull')),
            'push': bool(perms.get('push')), 'admin': bool(perms.get('admin'))}


@app.post('/api/market/history/check')
def check_market_history():
    """Verify the market-history repo URL and both PATs from the *saved* config.

    Probes each configured PAT against the repo and reports whether the Read PAT
    can pull and the Write PAT can push — the two capabilities the archive/read
    paths actually rely on. PATs come from the saved config (they aren't sent by
    the browser), so save the form first. Returns a structured result and never
    raises, so the UI can render a per-PAT verdict."""
    cfg = load_config()
    repo_url = (cfg.get('market_history_repo_url') or '').strip()
    read_pat = (cfg.get('market_history_pat_read') or '').strip()
    write_pat = (cfg.get('market_history_pat_write') or '').strip()
    if not repo_url:
        return {'ok': False, 'reason': 'no_repo_url'}
    parsed = _parse_github_blob_url(repo_url)
    if not parsed:
        return {'ok': False, 'reason': 'bad_repo_url'}
    owner, repo, branch, _ = parsed
    ua = get_user_agent()

    out = {'ok': True, 'owner': owner, 'repo': repo, 'branch': branch,
           'read': None, 'write': None}
    if read_pat:
        cap = _github_pat_capability(owner, repo, read_pat, ua)
        out['read'] = cap
        # A read PAT that can't pull is effectively broken for our reads.
        if not (cap.get('ok') and cap.get('pull')):
            out['ok'] = False
    if write_pat:
        cap = _github_pat_capability(owner, repo, write_pat, ua)
        out['write'] = cap
        # The write PAT is what the daily archive push needs — require push.
        if not (cap.get('ok') and cap.get('push')):
            out['ok'] = False
    if not read_pat and not write_pat:
        return {'ok': False, 'reason': 'no_pats', 'owner': owner,
                'repo': repo, 'branch': branch}
    return out


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


_forex_cache: dict = {}
_FOREX_TTL = 3600  # 1h — FX rates don't move fast enough to matter for PLEX math


@app.get('/api/forex/rates')
def get_forex_rates(bust: bool = False):
    """Latest USD-based FX rates for the Money -> PLEX -> ISK calculator. Free,
    keyless (open.er-api.com). `rates[ccy]` is units of that currency per 1 USD,
    so USD = amount_ccy / rates[ccy]. Cached 1h; a stale cache is served if the
    provider is unreachable so the calculator keeps working offline-ish."""
    now = time.time()
    if not bust and _forex_cache and (now - _forex_cache['fetched_at']) < _FOREX_TTL:
        return _forex_cache['result']
    try:
        resp = requests.get('https://open.er-api.com/v6/latest/USD',
                            headers={'User-Agent': get_user_agent()}, timeout=15)
        resp.raise_for_status()
        body = resp.json()
    except Exception as e:
        if _forex_cache:
            return {**_forex_cache['result'], 'stale': True}
        raise HTTPException(502, f'Forex rate lookup failed: {e}')
    if body.get('result') != 'success' or not isinstance(body.get('rates'), dict):
        if _forex_cache:
            return {**_forex_cache['result'], 'stale': True}
        raise HTTPException(502, 'Forex provider returned an unexpected response')
    result = {
        'base': body.get('base_code') or 'USD',
        'rates': body['rates'],
        'updated': body.get('time_last_update_utc') or '',
        'source': 'open.er-api.com',
        'stale': False,
    }
    _forex_cache.clear()
    _forex_cache.update({'fetched_at': now, 'result': result})
    return result


_RELEASES_REPO = 'georgeatlumina/Eve_Corp_Buyback'
_releases_cache: dict = {}
_RELEASES_TTL = 1800  # 30m — release notes rarely change; keep well under GitHub's
                      # 60/hr unauthenticated rate limit


@app.get('/api/releases')
def get_releases(bust: bool = False):
    """Recent GitHub releases (tag, name, notes, date, url) for the in-app patch
    notes panel. Cached 30m; serves the stale cache if GitHub is unreachable so
    the panel still shows the last-known notes offline."""
    now = time.time()
    if not bust and _releases_cache and (now - _releases_cache['fetched_at']) < _RELEASES_TTL:
        return _releases_cache['result']
    try:
        resp = requests.get(
            f'https://api.github.com/repos/{_RELEASES_REPO}/releases',
            headers={'User-Agent': get_user_agent(), 'Accept': 'application/vnd.github+json',
                     'X-GitHub-Api-Version': '2022-11-28'},
            params={'per_page': 15}, timeout=15)
        resp.raise_for_status()
        body = resp.json()
    except Exception as e:
        if _releases_cache:
            return {**_releases_cache['result'], 'stale': True}
        raise HTTPException(502, f'Release lookup failed: {e}')
    if not isinstance(body, list):
        if _releases_cache:
            return {**_releases_cache['result'], 'stale': True}
        raise HTTPException(502, 'GitHub returned an unexpected releases response')
    releases = [{
        'tag': r.get('tag_name') or '',
        'name': r.get('name') or r.get('tag_name') or '',
        'body': r.get('body') or '',
        'published_at': r.get('published_at') or r.get('created_at') or '',
        'html_url': r.get('html_url') or '',
        'prerelease': bool(r.get('prerelease')),
    } for r in body if not r.get('draft')]
    result = {'releases': releases, 'stale': False}
    _releases_cache.clear()
    _releases_cache.update({'fetched_at': now, 'result': result})
    return result


class DscanShareRequest(BaseModel):
    paste: str = ''


@app.post('/api/dscan/share')
def dscan_share(req: DscanShareRequest):
    """Submit a pasted directional scan to dscan.info and return a shareable
    link. dscan.info has no documented API; this posts the same form the site's
    own page uses (POST / with `paste=…`), which replies ``OK;<id>`` — the share
    URL is then https://dscan.info/v/<id>. Routed through the sidecar (not the
    renderer) to avoid CORS. Best-effort: depends on that undocumented form, so
    a change on their side would surface here as a 502."""
    paste = (req.paste or '').strip()
    if not paste:
        raise HTTPException(400, 'Nothing to share — paste a D-scan first.')
    try:
        resp = requests.post(
            'https://dscan.info/',
            data={'paste': paste},
            headers={'User-Agent': get_user_agent(), 'X-Requested-With': 'XMLHttpRequest'},
            timeout=20)
        resp.raise_for_status()
    except Exception as e:
        raise HTTPException(502, f'dscan.info submission failed: {e}')
    text = (resp.text or '').strip()
    # Success looks like "OK;<12-hex-id>". Anything else is an error/format change.
    if not text.startswith('OK;'):
        raise HTTPException(502, f'dscan.info returned an unexpected response: {text[:120]}')
    scan_id = text[3:].strip()
    if not scan_id:
        raise HTTPException(502, 'dscan.info accepted the scan but returned no id')
    return {'id': scan_id, 'url': f'https://dscan.info/v/{scan_id}'}


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
    # Cost basis = the corp buyback price, so it tracks the configured market hub.
    cost_market = cfg.get('janice_market') or 'Jita 4-4'

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

            yield _emit('progress', message=f'Fetching {cost_market} buy (cost basis)…')
            try:
                cost_buy = fetch_buy_prices(type_ids, cost_market, api_key=api_key, user_agent=ua)
            except Exception as e:
                yield _emit('error', message=f'{cost_market} price lookup failed: {e}')
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

            result = liquidation.analyze_items(rows, cost_buy, history, depth, courier_total, cfg)
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
            # Repo reachable but nothing published for this alliance yet (404).
            # Fall back to the local cache like any other read failure — a
            # configured repo must never leave the machine with *fewer* quotas
            # than no repo at all. Only report 'none' when there's genuinely no
            # cache, and say why so an empty dropdown explains itself.
            cached = _doctrine_stock_load_cache(alliance)
            if cached:
                return {'storage': 'local', 'stale': True, 'reason': 'not_published_yet', **cached}
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
    90% buy on the configured cost market — Jita by default), current best sell
    (are we undercut?), days-to-sell, time remaining in the order window, and a
    STALE flag when it has sat too long."""
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
    cost_market = cfg.get('janice_market') or 'Jita 4-4'  # cost basis tracks the config hub
    frac = float(cfg.get('liquidation_buyback_fraction') or 0.90)
    broker = float(cfg.get('liquidation_broker_fee_pct') or 0) / 100.0
    tax = float(cfg.get('liquidation_sales_tax_pct') or 0) / 100.0
    safety = float(cfg.get('liquidation_window_safety') or 1.3)
    stale_factor = float(cfg.get('liquidation_stale_factor') or 1.5)

    try:
        cost_buy = fetch_buy_prices(type_ids, cost_market, api_key=api_key, user_agent=ua) if api_key else {}
    except Exception:
        cost_buy = {}
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
        cost_basis = frac * float(cost_buy.get(tid, 0) or 0)
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
# Pause before re-trying contracts ESI refused on the first pass. Long enough to
# outlast the 520 bursts we measured, short enough not to stall the scan.
ITEMS_SWEEP_DELAY_SECONDS = 15


def _record_scan_run(metrics, contracts, corps_scanned, items_failed):
    """Append one run to the scan history, swallowing any failure.

    History is diagnostic data — losing a row is a warning, never a broken scan.
    """
    try:
        append_run(metrics.finish(
            contracts=contracts,
            corps_scanned=corps_scanned,
            items_failed=items_failed,
        ))
    except Exception as e:  # noqa: BLE001 - deliberately non-fatal
        logger.warning('scan history not recorded: %s', e)
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
    # corp_id -> error message, for corps whose contract-list fetch never succeeded.
    corp_fetch_errors: dict[int, str] = {}

    metrics = ScanMetrics(alliance=alliance)
    metrics.start_phase('contracts')

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

        def _on_retry(_attempt, _delay, exc):
            metrics.record_retry()
            metrics.record_error(status_of(exc))

        try:
            corp_contracts = call_with_retry(
                lambda: fetch_corp_contracts(corp_id, token, ua),
                on_retry=_on_retry,
            )
        except Exception as e:
            msg = str(e)
            corp_fetch_errors[corp_id] = msg
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

    metrics.end_phase('contracts')
    _sold_contracts_cache[alliance] = sold_found

    if not found:
        if not per_corp_kept and corp_fetch_errors:
            # Every corp we tried to fetch failed outright — this is a real
            # failure (e.g. ESI down), not "zero contracts", and must not be
            # reported as a clean empty scan.
            _record_scan_run(metrics, contracts=0, corps_scanned=0, items_failed=0)
            summary = '; '.join(f'corp {cid}: {msg}' for cid, msg in corp_fetch_errors.items())
            yield _emit('error', message=f'Could not fetch contracts from any corp — {summary}')
            return
        _record_scan_run(metrics, contracts=0, corps_scanned=len(per_corp_kept), items_failed=0)
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

        def _on_retry(_attempt, _delay, exc):
            metrics.record_retry()
            metrics.record_error(status_of(exc))

        try:
            items = call_with_retry(
                lambda: fetch_contract_items(rec['corp_id'], cid, rec['token'], ua),
                on_retry=_on_retry,
            )
            metrics.record_fetch()
            return cid, items, None
        except Exception as e:
            # on_retry logged the attempts that were followed by a retry; this
            # is the final one that exhausted them (or was never retryable).
            metrics.record_error(status_of(e))
            return cid, [], str(e)

    def _items_pass(targets, done_start, pass_total, label):
        """One parallel fetch pass over `targets`, yielding progress as it goes.

        Successes populate the cache and clear any earlier error for that
        contract, so a sweep pass can heal what the first pass failed on.
        """
        done = done_start
        with ThreadPoolExecutor(max_workers=3) as pool:
            futures = {pool.submit(_fetch_items, (cid, rec)): cid for cid, rec in targets.items()}
            for future in as_completed(futures):
                cid, items, err = future.result()
                if err:
                    items_by_id.setdefault(cid, [])
                    items_errors[cid] = err
                else:
                    items_by_id[cid] = items
                    items_errors.pop(cid, None)
                    _contract_items_cache[cid] = items
                done += 1
                yield _emit('progress', step=f'{label}: {done}/{pass_total}',
                            current=done, total=pass_total, phase='items')

    uncached = {cid: rec for cid, rec in found.items() if _contract_items_cache.get(cid) is None}
    for cid in found:
        if cid not in uncached:
            items_by_id[cid] = _contract_items_cache[cid]
            metrics.record_fetch(cached=True)

    metrics.start_phase('items')
    if uncached:
        yield _emit('progress', step=f'Fetching items for {len(uncached)} contract(s)…')
        yield from _items_pass(uncached, len(found) - len(uncached), total, 'Items')

        # ESI's contract-items endpoint serves bursts of 520s that can outlast
        # even the widened per-request backoff. Rather than report those as
        # missing stock, pause and sweep the stragglers once — by then the
        # burst has almost always passed. Non-transient failures (4xx) cost a
        # single request here, since call_with_retry won't retry them.
        if items_errors:
            stragglers = {cid: uncached[cid] for cid in list(items_errors) if cid in uncached}
            if stragglers:
                yield _emit('progress', step=f'ESI rejected {len(stragglers)} contract(s) — '
                                             f'retrying in {ITEMS_SWEEP_DELAY_SECONDS}s…')
                time.sleep(ITEMS_SWEEP_DELAY_SECONDS)
                yield from _items_pass(stragglers, 0, len(stragglers), 'Retrying')
                recovered = len(stragglers) - len(items_errors)
                metrics.record_sweep(attempted=len(stragglers), recovered=recovered)
                yield _emit('progress', step=f'Sweep recovered {recovered} of {len(stragglers)} '
                                             f'contract(s)')

    metrics.end_phase('items')
    metrics.start_phase('names')

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

    metrics.end_phase('names')

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

    _record_scan_run(
        metrics,
        contracts=len(found),
        corps_scanned=len(per_corp_kept),
        items_failed=len(items_errors),
    )

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
    names to type IDs via Janice. Streams NDJSON progress events then a final
    'done' event with all resolved items."""
    if not req.paste_text or not req.paste_text.strip():
        raise HTTPException(400, 'paste_text is empty')

    def _stream():
        import json as _json
        import re as _re
        cfg = load_config()
        api_key = cfg.get('janice_api_key') or None
        market_name = cfg.get('janice_market') or 'Jita 4-4'
        try:
            result = appraise_items(req.paste_text, market_name, api_key=api_key)
            rows = result.get('items') or []
        except Exception as e:
            yield _json.dumps({'event': 'error', 'message': f'Parse failed: {e}'}) + '\n'
            return

        # Collect input line names to detect lines Janice dropped entirely.
        input_names = []
        for line in req.paste_text.splitlines():
            line = line.strip()
            if not line:
                continue
            parts = _re.split(r'\t+|\s{2,}', line)
            input_names.append(parts[0].strip())
        resolved_names = {r['name'] for r in rows if r.get('type_id')}
        unresolved = [n for n in input_names if n not in resolved_names]

        ua = get_user_agent()
        total = len(rows)
        resolved = []
        zero_qty = []
        for i, r in enumerate(rows):
            if not r.get('type_id'):
                continue
            if not r.get('quantity'):
                zero_qty.append(r['name'])
                yield _json.dumps({'event': 'progress', 'done': i + 1, 'total': total, 'name': r['name']}) + '\n'
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
            yield _json.dumps({'event': 'progress', 'done': i + 1, 'total': total, 'name': r['name']}) + '\n'
        yield _json.dumps({'event': 'done', 'items': resolved,
                           'ignored': unresolved, 'zero_qty': zero_qty}) + '\n'

    return StreamingResponse(_stream(), media_type='application/x-ndjson')


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


@app.get('/api/contracts/processed/search')
def contracts_processed_search(q: str = ''):
    """Stream finished inbound buyback contract search as NDJSON.

    Events: progress | done | error.
    Filters to assignee_id == corp_id, status == finished, type == item_exchange,
    at least one item name contains q (case-insensitive).
    """
    cfg = load_config()
    if not cfg.get('corp_id'):
        raise HTTPException(400, 'Configure corp_id first')
    if not q.strip():
        raise HTTPException(400, 'q must not be empty')
    return StreamingResponse(_processed_search_stream(cfg, q), media_type='application/x-ndjson')


def _processed_search_stream(cfg, q):
    client_id, secret_key = get_app_credentials()
    try:
        token = get_valid_access_token(client_id, secret_key, get_user_agent())
    except Exception as e:
        yield _emit('error', message=f'Not authenticated: {e}')
        return

    ua = get_user_agent()
    corp_id = int(cfg['corp_id'])

    yield _emit('progress', step='Fetching corp contracts from ESI…', current=0, total=0)

    try:
        all_contracts = fetch_corp_contracts(corp_id, token, ua)
    except Exception as e:
        yield _emit('error', message=_friendly_contracts_error(e))
        return

    finished = [
        c for c in all_contracts
        if c.get('type') == 'item_exchange'
        and c.get('status') == 'finished'
        and int(c.get('assignee_id') or 0) == corp_id
    ]

    yield _emit('progress', step=f'Found {len(finished)} finished inbound contracts — fetching items…',
                current=0, total=len(finished))

    def _fetch_one(cid_tok):
        cid, tok = cid_tok
        last_err = None
        for attempt in range(3):
            try:
                return cid, fetch_contract_items(corp_id, cid, tok, ua), None
            except Exception as e:
                last_err = e
                if attempt < 2:
                    time.sleep(1.5 ** attempt)
        return cid, [], str(last_err)

    items_by_id: dict[int, list] = {}
    uncached = {
        int(c['contract_id']): token
        for c in finished
        if _contract_items_cache.get(int(c['contract_id'])) is None
    }
    for c in finished:
        cid = int(c['contract_id'])
        if cid not in uncached:
            items_by_id[cid] = _contract_items_cache[cid]

    done_count = len(finished) - len(uncached)
    total = len(finished)

    if uncached:
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = {pool.submit(_fetch_one, (cid, tok)): cid for cid, tok in uncached.items()}
            for future in as_completed(futures):
                cid, items, err = future.result()
                items_by_id[cid] = items
                if not err:
                    _contract_items_cache[cid] = items
                done_count += 1
                yield _emit('progress', step=f'Fetching items… {done_count}/{total}',
                            current=done_count, total=total)

    yield _emit('progress', step='Resolving item names…', current=total, total=total)

    all_type_ids = {
        int(i.get('type_id') or 0)
        for items in items_by_id.values()
        for i in items
        if i.get('type_id')
    }
    try:
        names = resolve_names(all_type_ids, ua)
    except Exception:
        names = {}

    issuer_ids = {int(c.get('issuer_id') or 0) for c in finished if c.get('issuer_id')}
    try:
        issuer_names = resolve_names(issuer_ids, ua)
    except Exception:
        issuer_names = {}

    q_lower = q.strip().lower()
    matched = []
    for c in finished:
        cid = int(c['contract_id'])
        raw_items = items_by_id.get(cid, [])
        items_named = [
            {
                'type_id': int(i.get('type_id') or 0),
                'quantity': int(i.get('quantity') or 0),
                'name': names.get(int(i.get('type_id') or 0), ''),
            }
            for i in raw_items
            if i.get('is_included', True)
        ]
        if not any(q_lower in it['name'].lower() for it in items_named):
            continue
        matched.append({
            'contract_id': cid,
            'title': c.get('title') or '',
            'issuer_id': int(c.get('issuer_id') or 0),
            'issuer_name': issuer_names.get(int(c.get('issuer_id') or 0), ''),
            'date_accepted': c.get('date_accepted') or '',
            'date_completed': c.get('date_completed') or '',
            'price': float(c.get('price') or 0),
            'items': items_named,
        })

    matched.sort(key=lambda x: x['date_completed'], reverse=True)
    yield _emit('done', contracts=matched, total_fetched=len(finished), total_matched=len(matched))


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
    # Resolve the build tag now so the first scan doesn't pay for the git
    # subprocesses, and so the sha recorded is the one whose code this process
    # actually loaded. Never fatal — git may not exist in a packaged app.
    try:
        git_info()
    except Exception as e:  # noqa: BLE001
        logger.warning('build tag unavailable: %s', e)
    # Log the bound port explicitly (in addition to uvicorn's own line) so a
    # renderer<->sidecar port mismatch is obvious from sidecar.log alone.
    logger.info('sidecar binding http://127.0.0.1:%s (callback %s)', PORT, REDIRECT_URI)
    uvicorn.run(app, host='127.0.0.1', port=PORT, log_level='info')
