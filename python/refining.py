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
MOON_ORE_GROUP_IDS = frozenset({1884, 1920, 1921, 1922, 1923})  # R4 / R8 / R16 / R32 / R64 moon asteroid groups (raw + compressed)
MOON_ORE_PAYOUT_FRACTION = 0.80  # All moon ore is paid at 80% by policy


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


def is_moon_ore(type_id, user_agent):
    """True iff the type is in one of EVE's moon-asteroid tier groups (R4–R64)."""
    try:
        return fetch_type_info(type_id, user_agent).get('group_id') in MOON_ORE_GROUP_IDS
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
    items, hub_name,
    moon_ore_efficiency, non_moon_ore_efficiency, ice_efficiency,
    non_moon_payout_fraction,
    user_agent,
    moon_payout_fraction=MOON_ORE_PAYOUT_FRACTION,
):
    """Returns refined value + per-bucket payout (moon ore at moon_payout_fraction,
    everything else at non_moon_payout_fraction). Moon ore and non-moon ore are
    refined at independent yields; ice has its own yield as well.
    """
    hub = HUBS.get(hub_name)
    if not hub:
        raise ValueError(f'Unknown trade hub: {hub_name!r}')

    moon_ore_totals = {}      # mineral_type_id -> raw yield from moon ore (pre-efficiency)
    non_moon_ore_totals = {}  # mineral_type_id -> raw yield from non-moon ore
    ice_totals = {}           # mineral_type_id -> raw yield from ice
    moon_leftover = {}        # moon-ore type_id -> leftover qty
    other_leftover = {}       # non-moon-ore / unknown type_id -> leftover qty
    donations = {}
    has_moon_ore = False
    has_non_moon_ore = False
    has_ice = False

    for it in items:
        type_id = it.get('type_id')
        qty = it.get('quantity', 0)
        if not type_id or not qty:
            continue
        if is_donation(type_id, user_agent):
            donations[type_id] = donations.get(type_id, 0) + qty
            continue
        if not is_refinable(type_id):
            other_leftover[type_id] = other_leftover.get(type_id, 0) + qty
            continue

        is_moon = is_moon_ore(type_id, user_agent)
        is_ice_type = is_ice(type_id, user_agent)
        ys, remainder = yields_for(type_id, qty, user_agent)

        if is_ice_type:
            target = ice_totals
            has_ice = True
            leftover_bucket = other_leftover
        elif is_moon:
            target = moon_ore_totals
            has_moon_ore = True
            leftover_bucket = moon_leftover
        else:
            target = non_moon_ore_totals
            has_non_moon_ore = True
            leftover_bucket = other_leftover

        for mid, raw_yield in ys:
            target[mid] = target.get(mid, 0) + raw_yield
        if remainder > 0:
            leftover_bucket[type_id] = leftover_bucket.get(type_id, 0) + remainder

    donation_breakdown = [
        {'type_id': tid, 'quantity': qty}
        for tid, qty in sorted(donations.items(), key=lambda kv: -kv[1])
    ]

    nothing_refined = not (moon_ore_totals or non_moon_ore_totals or ice_totals)
    nothing_priced = nothing_refined and not moon_leftover and not other_leftover
    if nothing_priced:
        return {
            'refined_value': 0,
            'moon_value': 0,
            'non_moon_value': 0,
            'leftover_value': 0,
            'moon_payout': 0,
            'non_moon_payout': 0,
            'recommended_payout': 0,
            'breakdown': [],
            'leftover_breakdown': [],
            'donation_breakdown': donation_breakdown,
            'has_moon_ore': has_moon_ore,
            'has_non_moon_ore': has_non_moon_ore,
            'has_ice': has_ice,
            'has_donations': bool(donations),
            'moon_payout_fraction': moon_payout_fraction,
            'non_moon_payout_fraction': non_moon_payout_fraction,
        }

    price_ids = (
        set(moon_ore_totals) | set(non_moon_ore_totals) | set(ice_totals)
        | set(moon_leftover) | set(other_leftover)
    )
    prices = fetch_buy_prices(hub['station_id'], price_ids, user_agent)

    # Per-bucket value, plus a merged breakdown for the items dropdown.
    breakdown = []
    moon_value = 0.0
    non_moon_value = 0.0
    all_mineral_ids = set(moon_ore_totals) | set(non_moon_ore_totals) | set(ice_totals)
    for mid in all_mineral_ids:
        moon_qty = moon_ore_totals.get(mid, 0) * moon_ore_efficiency
        non_moon_qty = non_moon_ore_totals.get(mid, 0) * non_moon_ore_efficiency
        ice_qty = ice_totals.get(mid, 0) * ice_efficiency
        actual_yield = moon_qty + non_moon_qty + ice_qty
        price = prices.get(mid, 0)
        moon_value += moon_qty * price
        non_moon_value += (non_moon_qty + ice_qty) * price
        breakdown.append({
            'type_id': mid,
            'quantity': round(actual_yield),
            'unit_price': price,
            'value': actual_yield * price,
        })

    leftover_breakdown = []
    moon_leftover_value = 0.0
    non_moon_leftover_value = 0.0
    for tid, qty in moon_leftover.items():
        price = prices.get(tid, 0)
        value = qty * price
        moon_leftover_value += value
        leftover_breakdown.append({'type_id': tid, 'quantity': qty, 'unit_price': price, 'value': value})
    for tid, qty in other_leftover.items():
        price = prices.get(tid, 0)
        value = qty * price
        non_moon_leftover_value += value
        leftover_breakdown.append({'type_id': tid, 'quantity': qty, 'unit_price': price, 'value': value})

    moon_total = moon_value + moon_leftover_value
    non_moon_total = non_moon_value + non_moon_leftover_value
    moon_payout = moon_total * moon_payout_fraction
    non_moon_payout = non_moon_total * non_moon_payout_fraction

    return {
        'refined_value': moon_value + non_moon_value,
        'moon_value': moon_total,
        'non_moon_value': non_moon_total,
        'leftover_value': moon_leftover_value + non_moon_leftover_value,
        'moon_payout': moon_payout,
        'non_moon_payout': non_moon_payout,
        'recommended_payout': moon_payout + non_moon_payout,
        'breakdown': sorted(breakdown, key=lambda b: -b['value']),
        'leftover_breakdown': sorted(leftover_breakdown, key=lambda b: -b['value']),
        'donation_breakdown': donation_breakdown,
        'has_moon_ore': has_moon_ore,
        'has_non_moon_ore': has_non_moon_ore,
        'has_ice': has_ice,
        'has_donations': bool(donations),
        'moon_payout_fraction': moon_payout_fraction,
        'non_moon_payout_fraction': non_moon_payout_fraction,
    }
