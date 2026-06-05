"""Mutamarket API client for abyssal-module pricing on the Appraisal tab.

Mutamarket (https://mutamarket.com) is the de-facto marketplace for EVE
Online abyssal-mutaplasmid items. Their public read API has four endpoints
documented at https://mutamarket.com/docs?api-docs.json — we only use the
listings-by-type one:

    GET /api/modules/type/{type_id}            -> list of every public
                                                  listing of that abyssal
                                                  type, each with
                                                  contract.price (asking)
                                                  and estimated_value (their
                                                  AI fair-value estimate).

No auth required. Rate-limit-friendly — we cache in-process for 5 minutes
per type_id so repeat appraisals against the same paste don't re-pull.

Abyssal detection: every "real" abyssal module has a name that starts with
``Abyssal `` (e.g. ``Abyssal Stasis Webifier``, ``Abyssal Damage Control``).
That single rule covers the entire category; the cross-check we do in
server._appraise_combined() is "did Janice price it at 0 with zero buy/sell
volume" which catches the same items from the opposite direction.
"""

import statistics
import time
from typing import Any, Optional

import requests

MUTAMARKET_BASE = 'https://mutamarket.com/api'

# In-process cache: type_id -> (fetched_at_unix, listings_list).
# Mutamarket can return MB-sized payloads (one Damage Control type had
# 7500+ listings = 14MB) so keep this in memory and don't hold it longer
# than the TTL — a sidecar restart clears it.
_TTL_SECONDS = 300
_listings_cache: dict[int, tuple[float, list]] = {}


def is_abyssal_item_name(name: str) -> bool:
    """Cheap, reliable check: any abyssal module starts with ``Abyssal `` in
    its CCP-canonical name (verified against ESI). Whitespace and case
    normalised so paste-quirks don't trip us up.
    """
    if not name:
        return False
    return name.strip().lower().startswith('abyssal ')


def fetch_type_listings(type_id: int, user_agent: str, refresh: bool = False) -> list:
    """Return every public Mutamarket listing for the given abyssal type.

    Cached in-process for 5 minutes. Pass ``refresh=True`` to bypass.
    """
    tid = int(type_id)
    now = time.time()
    cached = _listings_cache.get(tid)
    if not refresh and cached and (now - cached[0]) < _TTL_SECONDS:
        return cached[1]
    resp = requests.get(
        f'{MUTAMARKET_BASE}/modules/type/{tid}',
        headers={'Accept': 'application/json', 'User-Agent': user_agent},
        timeout=30,
    )
    if resp.status_code == 404:
        # Mutamarket returns 404 if the type_id isn't a known abyssal type or
        # has zero listings. Treat as "empty market" and cache so we don't
        # keep hammering for the same type_id.
        _listings_cache[tid] = (now, [])
        return []
    resp.raise_for_status()
    data = resp.json()
    if not isinstance(data, list):
        return []
    _listings_cache[tid] = (now, data)
    return data


def summarize_listings(listings: list) -> dict[str, Any]:
    """Boil a Mutamarket listings array into a single summary block.

    Returns two parallel price tracks:

    * **Marketplace** — derived from ``contract.price`` (the seller's asking
      price). Filtered to listings actually for sale (price > 0). Median is
      the right "headline" number for a thin market with outliers.
    * **Estimator** — derived from ``estimated_value`` (Mutamarket's AI
      fair-value estimate based on each item's mutated stats). Available
      even for items whose contract is private or finalised.

    Each track returns count, min, max, median, mean.
    """
    market_prices: list[float] = []
    estimator_values: list[float] = []
    for m in listings or []:
        if not isinstance(m, dict):
            continue
        contract = m.get('contract') or {}
        price = contract.get('price')
        if isinstance(price, (int, float)) and price > 0:
            market_prices.append(float(price))
        ev = m.get('estimated_value')
        if isinstance(ev, (int, float)) and ev > 0:
            estimator_values.append(float(ev))

    def stats(xs: list[float]) -> Optional[dict[str, float]]:
        if not xs:
            return None
        return {
            'count': len(xs),
            'min': min(xs),
            'max': max(xs),
            'median': statistics.median(xs),
            'mean': statistics.fmean(xs),
        }

    return {
        'total_listings': len(listings or []),
        'marketplace': stats(market_prices),
        'estimator': stats(estimator_values),
    }


def appraise_abyssal_type(
    type_id: int,
    quantity: int,
    user_agent: str,
) -> dict[str, Any]:
    """Convenience wrapper for /api/appraise. Returns a per-line block:

        {
          'type_id': int,
          'quantity': int,
          'marketplace': {count, min, max, median, mean} or None,
          'estimator':   {count, min, max, median, mean} or None,
          'marketplace_total_median': float or None,   # median × quantity
          'estimator_total_median':   float or None,
          'total_listings': int,
          'error': str (only if the fetch failed),
        }
    """
    try:
        listings = fetch_type_listings(type_id, user_agent)
    except Exception as e:
        return {
            'type_id': int(type_id),
            'quantity': int(quantity),
            'marketplace': None,
            'estimator': None,
            'marketplace_total_median': None,
            'estimator_total_median': None,
            'total_listings': 0,
            'error': f'{type(e).__name__}: {e}',
        }
    summary = summarize_listings(listings)
    q = int(quantity) or 1
    mkt_med = (summary['marketplace'] or {}).get('median')
    est_med = (summary['estimator'] or {}).get('median')
    return {
        'type_id': int(type_id),
        'quantity': q,
        'marketplace': summary['marketplace'],
        'estimator': summary['estimator'],
        'marketplace_total_median': (mkt_med * q) if mkt_med is not None else None,
        'estimator_total_median': (est_med * q) if est_med is not None else None,
        'total_listings': summary['total_listings'],
    }
