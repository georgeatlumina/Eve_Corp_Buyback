"""Station-trading analysis: buy low at one NPC station, sell high at another.

ESI has no per-station market endpoint. What it has is per-*region* orders, and
every order carries a ``location_id``, so a station's book is the region's book
filtered down. That filter is the whole trick here, and it isn't cheap: The
Forge alone is ~409 pages of 1000 orders. Two things follow.

**Aggregate while paging, never accumulate.** Holding 409k order dicts to filter
afterwards costs hundreds of MB for data we reduce to a few numbers per type. So
each page is folded straight into a per-(station, type) summary and dropped.

**Cache per region, keyed to ESI's own window.** ESI caches market orders for
300s, so re-fetching faster than that returns identical bytes. One region fetch
serves every station in it, which is what makes a second pair in the same region
free.

Pure module — no FastAPI here; server.py owns the HTTP surface, the same split
smt.py and stockpile.py use.
"""
import concurrent.futures as cf
import threading
import time

import esi

# Player structures use ids above ~1e12; NPC stations are the small ids. Both
# trade, and a public citadel's orders are already in the region feed — one in
# The Forge carried 1306 of them — so both are kept. The difference is naming:
# /universe/names/ rejects structure ids outright (400), so a structure's name
# has to come from /universe/structures/{id}, which needs an authed character
# with docking access. Without one the structure is still perfectly tradeable,
# it just shows as its id and system.
STRUCTURE_ID_FLOOR = 1_000_000_000_000

# Injected by server.py, which owns the tokens: fn(structure_id) -> {'name',
# 'solar_system_id'} or None. Kept as a hook so this module stays pure.
_structure_resolver = None


def set_structure_resolver(fn):
    global _structure_resolver
    _structure_resolver = fn

# The NPC hubs worth pairing. Only the ids are hardcoded — names, systems and
# regions are resolved from ESI and the bundled map at runtime, so a station
# rename can't leave a stale string on screen.
HUB_STATION_IDS = (
    60003760,   # Jita IV - Moon 4 - Caldari Navy Assembly Plant
    60008494,   # Amarr VIII (Oris) - Emperor Family Academy
    60011866,   # Dodixie IX - Moon 20 - Federation Navy Assembly Plant
    60004588,   # Rens VI - Moon 8 - Brutor Tribe Treasury
    60005686,   # Hek VIII - Moon 12 - Boundless Creation Factory
)

# Default EVE market fees. Both depend on skills and standings, so they're
# overridable per request — these are roughly a well-trained trader.
DEFAULT_SALES_TAX = 0.036      # Accounting V
DEFAULT_BROKER_FEE = 0.015     # Broker Relations V at decent standing

_REGION_TTL = 300.0            # matches ESI's own cache window
_PAGE_WORKERS = 12

_lock = threading.Lock()
_region_cache = {}             # region_id -> {'ts', 'books', 'orders', 'stations'}
_station_meta = {}             # station_id -> {name, system_id, ...}
_meta_lock = threading.Lock()


# ---- station metadata -------------------------------------------------------
def station_info(station_id, user_agent, systems=None, region_hint=None):
    """{station_id, name, system_id, system, region, region_id, sec} — cached.

    Region comes from the bundled map rather than a second ESI call; the map
    already knows every system's region and is what the rest of the app trusts.
    """
    sid = int(station_id)
    with _meta_lock:
        hit = _station_meta.get(sid)
    if hit and (hit.get('named') or not _structure_resolver):
        return hit
    if sid >= STRUCTURE_ID_FLOOR:
        return _structure_info(sid, systems, region_hint=region_hint, prior=hit)
    info = esi.fetch_station_info(sid, user_agent)
    sys_id = info.get('system_id')
    rec = (systems or _systems()).get(str(sys_id)) or {}
    out = {'station_id': sid, 'name': info.get('name') or f'station {sid}',
           'system_id': sys_id, 'system': rec.get('name'),
           'region': rec.get('region'), 'region_id': _region_id_for(rec.get('region')),
           'sec': rec.get('sec'), 'structure': False, 'named': True}
    with _meta_lock:
        _station_meta[sid] = out
    return out


def _structure_info(sid, systems=None, region_hint=None, prior=None):
    """A player structure's record.

    Unnamed is a normal outcome, not a failure — it means nobody authenticated
    can dock there. Such a structure is still tradeable, because its orders are
    in the region feed regardless, so it comes back selectable and labelled by
    id. What it lacks is a *system*, and therefore a route: /universe/structures
    is the only thing that knows where a citadel is. The region is stamped from
    wherever it was discovered so the order book can still be read.
    """
    got = None
    if _structure_resolver:
        try:
            got = _structure_resolver(sid)
        except Exception:  # noqa: BLE001 — no docking access is the common case
            got = None
    sys_id = (got or {}).get('solar_system_id')
    rec = ((systems or _systems()).get(str(sys_id)) or {}) if sys_id else {}
    region_id = _region_id_for(rec.get('region')) or region_hint or (prior or {}).get('region_id')
    out = {'station_id': sid, 'name': (got or {}).get('name') or f'Structure {sid}',
           'system_id': sys_id, 'system': rec.get('name'),
           'region': rec.get('region') or (prior or {}).get('region'),
           'region_id': region_id,
           'sec': rec.get('sec'), 'structure': True, 'named': bool((got or {}).get('name'))}
    # Cached either way so the region survives, but an unnamed one is retried
    # (see station_info) once a character who can dock there authenticates.
    with _meta_lock:
        _station_meta[sid] = out
    return out


def _systems():
    import eve_map
    return eve_map.load_map()['systems']


_REGION_IDS = None


def _region_id_for(region_name):
    """Region name -> ESI region id, from the bundled map. It already carries
    both, so this costs no network call and can't disagree with the map the rest
    of the app draws."""
    global _REGION_IDS
    if not region_name:
        return None
    if _REGION_IDS is None:
        import eve_map
        _REGION_IDS = {r['name']: r['id'] for r in eve_map.load_map()['regions']}
    return _REGION_IDS.get(region_name)


def hubs(user_agent):
    """The bundled hub list, resolved. Anything that fails to resolve is dropped
    rather than shown as a broken row."""
    systems = _systems()
    out = []
    for sid in HUB_STATION_IDS:
        try:
            out.append(station_info(sid, user_agent, systems))
        except Exception:  # noqa: BLE001 — one unreachable station mustn't hide the rest
            continue
    return out


# ---- region order books -----------------------------------------------------
def _fold(book, order):
    """Fold one order into the running per-(station, type) summary.

    Tracking "volume at the best price" needs no second pass: a strictly better
    price resets the counter, an equal one adds to it.
    """
    loc = int(order.get('location_id') or 0)
    if not loc:
        return
    tid = int(order.get('type_id') or 0)
    if not tid:
        return
    price = float(order.get('price') or 0.0)
    vol = int(order.get('volume_remain') or 0)
    if price <= 0 or vol <= 0:
        return
    per_station = book.setdefault(loc, {})
    e = per_station.get(tid)
    if e is None:
        e = per_station[tid] = {'ask': None, 'ask_vol': 0, 'ask_depth': 0, 'ask_orders': 0,
                                'bid': None, 'bid_vol': 0, 'bid_depth': 0, 'bid_orders': 0}
    if order.get('is_buy_order'):
        e['bid_depth'] += vol
        e['bid_orders'] += 1
        if e['bid'] is None or price > e['bid']:
            e['bid'], e['bid_vol'] = price, vol
        elif price == e['bid']:
            e['bid_vol'] += vol
    else:
        e['ask_depth'] += vol
        e['ask_orders'] += 1
        if e['ask'] is None or price < e['ask']:
            e['ask'], e['ask_vol'] = price, vol
        elif price == e['ask']:
            e['ask_vol'] += vol


def region_book(region_id, user_agent, force=False, progress=None):
    """Every NPC station's book in a region, as {location_id: {type_id: summary}}.

    One fetch serves every station in the region, so pairing two stations in the
    same region costs nothing extra.
    """
    rid = int(region_id)
    now = time.time()
    with _lock:
        hit = _region_cache.get(rid)
        if hit and not force and now - hit['ts'] < _REGION_TTL:
            return hit
    url = f'{esi.ESI_BASE}/markets/{rid}/orders/'
    headers = {'Accept': 'application/json', 'User-Agent': user_agent}

    def page(n):
        """Just the parsed rows — returning the Response too would pin the whole
        response body for as long as the caller holds the result."""
        r = esi._session.get(url, headers=headers,
                             params={'datasource': 'tranquility', 'order_type': 'all', 'page': n})
        r.raise_for_status()
        return r.json() or []

    first = esi._session.get(url, headers=headers,
                             params={'datasource': 'tranquility', 'order_type': 'all', 'page': 1})
    first.raise_for_status()
    pages = int(first.headers.get('x-pages', 1) or 1)
    book, count = {}, 0
    for o in (first.json() or []):
        _fold(book, o)
        count += 1
    del first
    if progress:
        progress(1, pages)

    # Submitted in windows rather than all at once. Handing the executor all 408
    # pages up front means every completed-but-unconsumed future keeps its page
    # of JSON alive — measured at a 414 MB peak on The Forge, for data we reduce
    # to a few numbers per type. A window bounds that to the pages in flight.
    done = 1
    if pages > 1:
        window = _PAGE_WORKERS * 2
        with cf.ThreadPoolExecutor(max_workers=_PAGE_WORKERS) as ex:
            for start in range(2, pages + 1, window):
                chunk = range(start, min(start + window, pages + 1))
                futures = [ex.submit(page, n) for n in chunk]
                for fut in cf.as_completed(futures):
                    try:
                        rows = fut.result()
                    except Exception:  # noqa: BLE001 — a dropped page thins the book, it doesn't break it
                        rows = []
                    for o in rows:
                        _fold(book, o)
                        count += 1
                    rows = None
                    done += 1
                    if progress:
                        progress(done, pages)
                futures = None

    entry = {'ts': time.time(), 'books': book, 'orders': count,
             'stations': sorted(book.keys()), 'pages': pages}
    with _lock:
        _region_cache[rid] = entry
    return entry


def station_book(station_id, user_agent, force=False, progress=None):
    """One station's {type_id: summary}, plus the region fetch's stats."""
    info = station_info(station_id, user_agent)
    if not info.get('region_id'):
        raise ValueError(f"Can't find the region for station {station_id}")
    entry = region_book(info['region_id'], user_agent, force=force, progress=progress)
    return info, entry['books'].get(int(station_id), {}), entry


# ---- the analysis -----------------------------------------------------------
def evaluate(buy_book, sell_book, sales_tax=DEFAULT_SALES_TAX, broker_fee=DEFAULT_BROKER_FEE,
             min_profit=0.0, min_margin=0.0, min_units=1, min_orders=0, max_buy_price=0.0):
    """Rank every type tradeable from ``buy_book`` into ``sell_book``.

    Two figures per row, because station traders run both plays and the gap
    between them is the whole decision:

    * **instant** — buy the ask at A, hit the bid at B. No waiting, no undercut
      risk, sales tax only (taking an order costs no broker fee).
    * **patient** — buy the ask at A, then *list* at B's current ask. Bigger
      margin, but you pay broker fee as well as tax, and you're betting nobody
      undercuts you.

    Ranking is on the instant figure; the patient one rides along so the upside
    is visible without letting the list flatter itself.
    """
    rows = []
    for tid, a in buy_book.items():
        ask = a.get('ask')
        if not ask:
            continue                       # nothing for sale at A: nothing to buy
        b = sell_book.get(tid)
        if not b:
            continue
        bid, b_ask = b.get('bid'), b.get('ask')
        instant_net = (bid or 0) * (1 - sales_tax)
        # Listing at B's ask means matching it, not undercutting — an undercut
        # is a choice the trader makes, not something to bake into the estimate.
        patient_net = (b_ask or 0) * (1 - sales_tax - broker_fee)
        instant_profit = instant_net - ask
        patient_profit = patient_net - ask
        if instant_profit <= 0 and patient_profit <= 0:
            continue
        if max_buy_price and ask > max_buy_price:
            continue
        # What you could actually move: limited by what's for sale at A's best
        # ask and what the bids at B will absorb.
        tradeable = min(a.get('ask_vol') or 0, b.get('bid_vol') or 0)
        if tradeable < min_units:
            continue
        # Order count is a free liquidity hint — real traded volume costs one
        # ESI call per type, so it can only be afforded after ranking. A hull
        # listed once at each end scores enormously on raw spread and is not a
        # trade; requiring a few orders on both sides drops that whole class.
        if min_orders and (min(a.get('ask_orders') or 0, b.get('bid_orders') or 0) < min_orders):
            continue
        if instant_profit < min_profit:
            continue
        if ask and (instant_profit / ask) < min_margin:
            continue
        rows.append({
            'type_id': tid,
            'buy_price': ask, 'buy_vol_at_best': a.get('ask_vol') or 0,
            'buy_depth': a.get('ask_depth') or 0, 'buy_orders': a.get('ask_orders') or 0,
            'sell_bid': bid, 'sell_bid_vol': b.get('bid_vol') or 0,
            'sell_ask': b_ask, 'sell_ask_vol': b.get('ask_vol') or 0,
            'sell_depth': b.get('bid_depth') or 0,
            'instant_profit': round(instant_profit, 2),
            'instant_margin': round(instant_profit / ask, 4) if ask else 0,
            'patient_profit': round(patient_profit, 2),
            'patient_margin': round(patient_profit / ask, 4) if ask else 0,
            'tradeable': tradeable,
            'instant_total': round(instant_profit * tradeable, 2),
        })
    rows.sort(key=lambda r: r['instant_total'], reverse=True)
    return rows


# ---- enrichment -------------------------------------------------------------
def enrich_rows(rows, sell_region_id, user_agent, limit=40, history_days=7):
    """Attach names, packaged volume and real traded volume to the top rows.

    On-book depth and traded volume are different numbers and only one of them
    is liquidity: 50k units resting on the book that move 200 a day is not a
    trade you can exit. ESI only publishes traded volume per *region* per type
    (one call each), so it's fetched for the top ``limit`` candidates after
    ranking rather than for all ~8000 — the tail isn't worth 8000 requests.
    """
    import market
    head = rows[:limit]
    if not head:
        return rows
    meta = market.enrich([r['type_id'] for r in head], user_agent)

    def history(tid):
        try:
            recs = esi.fetch_region_market_history(sell_region_id, tid, user_agent)
        except Exception:  # noqa: BLE001 — no history is a fact about the item, not an error
            return tid, None
        return tid, recs[-history_days:] if recs else []

    vols = {}
    with cf.ThreadPoolExecutor(max_workers=_PAGE_WORKERS) as ex:
        for tid, recs in ex.map(history, [r['type_id'] for r in head]):
            vols[tid] = recs

    for r in head:
        m = meta.get(r['type_id']) or {}
        r['name'] = m.get('name') or f"type {r['type_id']}"
        r['group'] = m.get('group_name') or ''
        r['category'] = m.get('category_name') or ''
        r['m3'] = m.get('volume') or 0.0
        recs = vols.get(r['type_id'])
        if recs:
            daily = sum(x.get('volume', 0) for x in recs) / len(recs)
            r['daily_volume'] = round(daily, 1)
            r['days_traded'] = sum(1 for x in recs if x.get('volume'))
            # How long it would take to offload what you bought, at the rate the
            # region actually absorbs it. The number that decides whether a fat
            # margin is a trade or a trap.
            r['days_to_clear'] = round(r['tradeable'] / daily, 2) if daily else None
        else:
            r['daily_volume'] = 0.0
            r['days_traded'] = 0
            r['days_to_clear'] = None
        r['m3_total'] = round((r['m3'] or 0) * r['tradeable'], 2)
        # The number a trader actually wants: per-unit profit times the units
        # that genuinely move, not the units merely resting on the book. An item
        # with 5000 on offer that trades 3 a day earns three units of profit.
        realisable = min(r['tradeable'], r['daily_volume'] or 0)
        r['daily_profit'] = round(r['instant_profit'] * realisable, 2)
    # Re-rank now that real liquidity is known — the pre-rank could only see the
    # order book, which flatters anything with a wide spread and no volume.
    head.sort(key=lambda r: r['daily_profit'], reverse=True)
    return head


# ---- station discovery ------------------------------------------------------
def stations_in_region(region_id, user_agent, limit=60, force=False, progress=None):
    """Every station and public structure in a region that currently has orders.

    There is no ESI endpoint that lists stations, so the market itself is the
    index: a location with orders on it is, by definition, one worth trading at.
    Ranked by order count, which puts the hub first and the one abandoned office
    with a single order last.

    Naming costs a lookup each, so only the head of the list is resolved — the
    tail is almost always noise you would never pick.
    """
    entry = region_book(region_id, user_agent, force=force, progress=progress)
    counts = []
    for loc, book in entry['books'].items():
        orders = sum((e.get('ask_orders') or 0) + (e.get('bid_orders') or 0) for e in book.values())
        counts.append((orders, len(book), loc))
    counts.sort(reverse=True)
    systems = _systems()
    out = []
    for orders, types, loc in counts[:limit]:
        try:
            info = station_info(loc, user_agent, systems, region_hint=int(region_id))
        except Exception:  # noqa: BLE001 — an unresolvable location is still tradeable
            info = {'station_id': loc, 'name': f'Location {loc}', 'system': None,
                    'region': None, 'region_id': int(region_id), 'sec': None,
                    'structure': loc >= STRUCTURE_ID_FLOOR, 'named': False}
        out.append({**info, 'orders': orders, 'types': types})
    return {'stations': out, 'total_locations': len(counts), 'region_id': int(region_id)}


def regions(user_agent=None):
    """Every k-space region, for the station picker's region dropdown."""
    import eve_map
    return sorted(({'id': r['id'], 'name': r['name']} for r in eve_map.load_map()['regions']),
                  key=lambda r: r['name'])
