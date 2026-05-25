import bz2
import csv
import io
import os
import threading
import urllib.request

import requests

from config import AUTH_DIR
from esi import fetch_group_info, fetch_type_info

# EVE categories whose items are accepted in moon-payout contracts:
#   25   — Asteroid: regular ore, moon ore, ice (raw + compressed)
#   2143 — Colony Reagents: Superionic Ice, Magmatic Gas (sovereignty workforce)
ALLOWED_CATEGORY_IDS = frozenset({25, 2143})
ICE_GROUP_ID = 465  # EVE's "Ice" group (raw + compressed ice live here)
DONATION_CATEGORY_ID = 2143  # Colony Reagents: Magmatic Gas, Superionic Ice — accepted as donation, no payout


def is_mineable(type_id, user_agent):
    """True iff the type is one of: ore / moon ore / ice / sovereignty colony reagent."""
    try:
        type_info = fetch_type_info(type_id, user_agent)
        group_info = fetch_group_info(type_info['group_id'], user_agent)
        return group_info.get('category_id') in ALLOWED_CATEGORY_IDS
    except Exception:
        return False


def is_ice(type_id, user_agent):
    """True iff the type is in EVE's Ice group (raw or compressed)."""
    try:
        return fetch_type_info(type_id, user_agent).get('group_id') == ICE_GROUP_ID
    except Exception:
        return False


def is_donation(type_id, user_agent):
    """True iff the type is a sovereignty workforce reagent (Magmatic Gas, Superionic Ice).
    These are accepted as donations — counted in the contract but priced at 0 ISK.
    """
    try:
        type_info = fetch_type_info(type_id, user_agent)
        group_info = fetch_group_info(type_info['group_id'], user_agent)
        return group_info.get('category_id') == DONATION_CATEGORY_ID
    except Exception:
        return False

FUZZWORK_MATERIALS_URL = 'https://www.fuzzwork.co.uk/dump/latest/invTypeMaterials.csv.bz2'
FUZZWORK_AGGREGATES_URL = 'https://market.fuzzwork.co.uk/aggregates/'

CACHE_DIR = AUTH_DIR
MATERIALS_CACHE = os.path.join(CACHE_DIR, 'invTypeMaterials.csv')

HUBS = {
    'Jita 4-4': {'station_id': 60003760},
    'Amarr':    {'station_id': 60008494},
    'Dodixie':  {'station_id': 60011866},
    'Rens':     {'station_id': 60004588},
}

_lock = threading.Lock()
_materials = None  # type_id -> [(material_type_id, quantity), ...]


def _load_materials():
    global _materials
    if _materials is not None:
        return _materials
    with _lock:
        if _materials is not None:
            return _materials
        if not os.path.exists(MATERIALS_CACHE):
            os.makedirs(CACHE_DIR, exist_ok=True)
            with urllib.request.urlopen(FUZZWORK_MATERIALS_URL) as r:
                raw = bz2.decompress(r.read())
            with open(MATERIALS_CACHE, 'wb') as f:
                f.write(raw)
        materials = {}
        with open(MATERIALS_CACHE, encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                tid = int(row['typeID'])
                mid = int(row['materialTypeID'])
                qty = int(row['quantity'])
                materials.setdefault(tid, []).append((mid, qty))
        _materials = materials
        return _materials


def is_refinable(type_id):
    """True if we have reprocessing yields for this type."""
    return type_id in _load_materials()


def yields_for(type_id, quantity, user_agent):
    """Returns ([(mineral_type_id, raw_yield), ...], leftover_qty) for `quantity` units of `type_id`.

    Caller must check is_refinable(type_id) first. Reprocessing needs `portion_size`
    units per batch; the remainder is returned so the caller can price it at the
    ore's own market value.
    """
    mats = _load_materials().get(type_id, [])
    info = fetch_type_info(type_id, user_agent)
    portion = info.get('portion_size') or 1
    portions_count = quantity // portion
    remainder = quantity % portion
    yields = [(mid, qty * portions_count) for mid, qty in mats] if portions_count > 0 else []
    return yields, remainder


def fetch_buy_prices(station_id, type_ids, user_agent):
    """Get max buy price at a station for each type_id, via fuzzwork aggregates."""
    if not type_ids:
        return {}
    out = {}
    ids = list(type_ids)
    for i in range(0, len(ids), 100):
        chunk = ids[i:i + 100]
        resp = requests.get(
            FUZZWORK_AGGREGATES_URL,
            params={'station': station_id, 'types': ','.join(str(t) for t in chunk)},
            headers={'User-Agent': user_agent},
            timeout=15,
        )
        resp.raise_for_status()
        for tid_str, info in resp.json().items():
            buy = info.get('buy') or {}
            try:
                out[int(tid_str)] = float(buy.get('max') or 0)
            except (ValueError, TypeError):
                pass
    return out


def compute_refined_payout(
    items, hub_name, ore_efficiency, ice_efficiency, payout_fraction, user_agent,
):
    """items: list of {type_id, quantity}. Ore and ice get their own efficiency multipliers.

    Returns refined value + recommended payout breakdown.
    """
    hub = HUBS.get(hub_name)
    if not hub:
        raise ValueError(f'Unknown trade hub: {hub_name!r}')

    ore_totals = {}  # mineral_type_id -> raw yield from ore inputs (pre-efficiency)
    ice_totals = {}  # mineral_type_id -> raw yield from ice inputs (pre-efficiency)
    leftover = {}    # type_id -> quantity priced as-is (remainder or non-refinable)
    donations = {}   # type_id -> quantity (Magmatic Gas / Superionic Ice — 0 ISK donation)
    has_ore = False
    has_ice = False
    for it in items:
        type_id = it.get('type_id')
        qty = it.get('quantity', 0)
        if not type_id or not qty:
            continue
        if is_donation(type_id, user_agent):
            # Workforce reagents — accept as donation, do not include in payout.
            donations[type_id] = donations.get(type_id, 0) + qty
            continue
        if not is_refinable(type_id):
            leftover[type_id] = leftover.get(type_id, 0) + qty
            continue
        ys, remainder = yields_for(type_id, qty, user_agent)
        target = ice_totals if is_ice(type_id, user_agent) else ore_totals
        if target is ice_totals:
            has_ice = True
        else:
            has_ore = True
        for mid, raw_yield in ys:
            target[mid] = target.get(mid, 0) + raw_yield
        if remainder > 0:
            leftover[type_id] = leftover.get(type_id, 0) + remainder

    donation_breakdown = [
        {'type_id': tid, 'quantity': qty}
        for tid, qty in sorted(donations.items(), key=lambda kv: -kv[1])
    ]

    if not ore_totals and not ice_totals and not leftover:
        return {
            'refined_value': 0,
            'leftover_value': 0,
            'recommended_payout': 0,
            'breakdown': [],
            'leftover_breakdown': [],
            'donation_breakdown': donation_breakdown,
            'has_ore': has_ore,
            'has_ice': has_ice,
            'has_donations': bool(donations),
        }

    price_ids = set(ore_totals.keys()) | set(ice_totals.keys()) | set(leftover.keys())
    prices = fetch_buy_prices(hub['station_id'], price_ids, user_agent)

    breakdown = []
    refined_value = 0.0
    all_mineral_ids = set(ore_totals.keys()) | set(ice_totals.keys())
    for mid in all_mineral_ids:
        ore_qty = ore_totals.get(mid, 0) * ore_efficiency
        ice_qty = ice_totals.get(mid, 0) * ice_efficiency
        actual_yield = ore_qty + ice_qty
        price = prices.get(mid, 0)
        value = actual_yield * price
        breakdown.append({
            'type_id': mid,
            'quantity': round(actual_yield),
            'unit_price': price,
            'value': value,
        })
        refined_value += value

    leftover_breakdown = []
    leftover_value = 0.0
    for ore_id, qty in leftover.items():
        price = prices.get(ore_id, 0)
        value = qty * price
        leftover_breakdown.append({
            'type_id': ore_id,
            'quantity': qty,
            'unit_price': price,
            'value': value,
        })
        leftover_value += value

    total_value = refined_value + leftover_value
    return {
        'refined_value': refined_value,
        'leftover_value': leftover_value,
        'recommended_payout': total_value * payout_fraction,
        'breakdown': sorted(breakdown, key=lambda b: -b['value']),
        'leftover_breakdown': sorted(leftover_breakdown, key=lambda b: -b['value']),
        'donation_breakdown': donation_breakdown,
        'has_ore': has_ore,
        'has_ice': has_ice,
        'has_donations': bool(donations),
    }
