import bz2
import csv
import io
import os
import threading
import urllib.request

import requests

from config import AUTH_DIR
from esi import fetch_type_info

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


def yields_for(type_id, quantity, user_agent):
    """Returns [(mineral_type_id, raw_yield), ...] for `quantity` units of `type_id`."""
    mats = _load_materials().get(type_id)
    if not mats:
        return []
    info = fetch_type_info(type_id, user_agent)
    portion = info.get('portion_size') or 1
    portions_count = quantity // portion
    if portions_count <= 0:
        return []
    return [(mid, qty * portions_count) for mid, qty in mats]


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
    items, hub_name, refining_efficiency, payout_fraction, user_agent,
):
    """items: list of {type_id, quantity}. Returns refined value + recommended payout breakdown."""
    hub = HUBS.get(hub_name)
    if not hub:
        raise ValueError(f'Unknown trade hub: {hub_name!r}')

    totals = {}  # mineral_type_id -> total yield (raw, before efficiency)
    skipped = []
    for it in items:
        type_id = it.get('type_id')
        qty = it.get('quantity', 0)
        if not type_id or not qty:
            continue
        ys = yields_for(type_id, qty, user_agent)
        if not ys:
            skipped.append(type_id)
            continue
        for mid, raw_yield in ys:
            totals[mid] = totals.get(mid, 0) + raw_yield

    skipped_items = _resolve_skipped(skipped, user_agent)
    if not totals:
        return {
            'refined_value': 0,
            'recommended_payout': 0,
            'breakdown': [],
            'skipped_items': skipped_items,
        }

    prices = fetch_buy_prices(hub['station_id'], totals.keys(), user_agent)
    breakdown = []
    total_value = 0.0
    for mid, raw_yield in totals.items():
        actual_yield = raw_yield * refining_efficiency
        price = prices.get(mid, 0)
        value = actual_yield * price
        breakdown.append({
            'type_id': mid,
            'quantity': round(actual_yield),
            'unit_price': price,
            'value': value,
        })
        total_value += value

    return {
        'refined_value': total_value,
        'recommended_payout': total_value * payout_fraction,
        'breakdown': sorted(breakdown, key=lambda b: -b['value']),
        'skipped_items': skipped_items,
    }


def _resolve_skipped(type_ids, user_agent):
    """Return [{type_id, name}] for any type_ids that lacked refining yields."""
    if not type_ids:
        return []
    from esi import resolve_names
    try:
        names = resolve_names(type_ids, user_agent)
    except Exception:
        names = {}
    return [{'type_id': tid, 'name': names.get(tid, '')} for tid in sorted(set(type_ids))]
