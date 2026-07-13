"""Liquidation page: shipment store + the margin/decision engine.

Two concerns live here, both IO-light:

* **Store** (`load_store`/`save_store` + CRUD) — on-disk record of courier
  shipments (one per pasted PushX contract), mirroring the `pinned.py` pattern:
  JSON under ``AUTH_DIR``, chmod 600, corrupt-tolerant, keyed upsert.
* **Decision engine** (`courier_cost`, `analyze_items`) — pure functions that
  turn per-item Jita/Amarr prices + ESI liquidity into a recommended action
  (dump now vs list for 7/14/30/90 days) ranked by annualized ROI, so ISK isn't
  locked into orders that aren't moving. No network IO — the caller (server.py)
  fetches prices/history and passes them in, exactly like `validate.py`.
"""
import json
import os
import time
import uuid

from config import AUTH_DIR

STORE_PATH = os.path.join(AUTH_DIR, 'liquidation.json')

WINDOWS = (7, 14, 30, 90)


# ----------------------------- store -----------------------------
# The store is a single JSON document: {'shipments': [...]}. It can live on a
# GitHub repo (shared across admins) with a local file as cache/fallback. To
# keep GitHub IO out of this module (server.py owns it, to reuse the Contents
# API helpers there), the mutation helpers below are *pure* — they take a store
# dict and return a new one. server.py loads the latest store (remote preferred),
# applies a mutation, and persists it (retrying on a 409 conflict).

def empty_store():
    return {'shipments': []}


def normalize(data):
    if not isinstance(data, dict):
        return empty_store()
    ships = data.get('shipments')
    if not isinstance(ships, list):
        ships = []
    return {'shipments': [s for s in ships if isinstance(s, dict) and s.get('id')]}


def load_store_local():
    """Read the local cache copy (used as fallback when GitHub is unset/down)."""
    if not os.path.exists(STORE_PATH):
        return empty_store()
    try:
        with open(STORE_PATH) as f:
            return normalize(json.load(f))
    except (json.JSONDecodeError, OSError):
        return empty_store()


def save_store_local(store):
    """Write the local cache copy (chmod 600)."""
    store = normalize(store)
    os.makedirs(AUTH_DIR, exist_ok=True)
    tmp = STORE_PATH + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(store, f, indent=2)
    os.replace(tmp, STORE_PATH)
    try:
        os.chmod(STORE_PATH, 0o600)
    except OSError:
        pass
    return store


_SHIPMENT_EDITABLE = {'label', 'status', 'delivered_at', 'notes', 'rush'}


def apply_add(store, shipment):
    """Return ``(new_store, shipment)`` with a shipment prepended. Pure."""
    store = normalize(store)
    shipment = dict(shipment)
    shipment.setdefault('id', uuid.uuid4().hex[:12])
    shipment.setdefault('created_at', time.time())
    store['shipments'].insert(0, shipment)
    return store, shipment


def apply_update(store, shipment_id, fields):
    """Return ``(new_store, updated_or_None)`` patching an allowlisted subset."""
    store = normalize(store)
    updated = None
    for s in store['shipments']:
        if s.get('id') == shipment_id:
            for k, v in fields.items():
                if k in _SHIPMENT_EDITABLE:
                    s[k] = v
            updated = s
            break
    return store, updated


def apply_remove(store, shipment_id):
    """Return ``(new_store, removed_bool)``."""
    store = normalize(store)
    before = len(store['shipments'])
    store['shipments'] = [s for s in store['shipments'] if s.get('id') != shipment_id]
    return store, len(store['shipments']) < before


# ----------------------------- courier cost -----------------------------

def courier_cost(collateral, volume_m3, rush, cfg):
    """PushX courier price for a shipment. See the in-app rate-card blurb.

    base + one step fee per (whole) collateral step above the free ceiling
    + rush fee. Returns ``{cost, base, collateral_fee, rush_fee, over_volume}``.
    """
    base = float(cfg.get('courier_base_isk') or 0)
    free = float(cfg.get('courier_collateral_free_isk') or 0)
    step = float(cfg.get('courier_collateral_step_isk') or 0) or 1
    step_fee = float(cfg.get('courier_collateral_step_fee_isk') or 0)
    rush_fee = float(cfg.get('courier_rush_fee_isk') or 0) if rush else 0.0
    max_vol = float(cfg.get('courier_max_volume_m3') or 0)

    over = max(0.0, float(collateral or 0) - free)
    import math
    steps = math.ceil(over / step) if over > 0 else 0
    collateral_fee = steps * step_fee
    return {
        'cost': base + collateral_fee + rush_fee,
        'base': base,
        'collateral_fee': collateral_fee,
        'rush_fee': rush_fee,
        'over_volume': bool(max_vol and float(volume_m3 or 0) > max_vol),
    }


# ----------------------------- decision engine -----------------------------

def _pick_window(days_to_sell, safety):
    """Smallest listing window that comfortably fits the expected sell time."""
    if days_to_sell is None:
        return None
    for w in WINDOWS:
        if days_to_sell * safety <= w:
            return w
    return None


def analyze_row(row, amarr_buy_unit, avg_daily_vol, depth_units, on_book_units,
                courier_alloc_unit, cfg):
    """Compute margins + a recommendation for one item. Pure.

    ``row`` carries ``type_id, name, quantity, unit_volume_m3, sell_unit,
    buy_unit`` (Jita immediate prices). ``amarr_buy_unit`` is the live Janice
    Amarr buy; cost basis = ``buyback_fraction * amarr_buy_unit + courier``.
    """
    frac = float(cfg.get('liquidation_buyback_fraction') or 0.90)
    broker = float(cfg.get('liquidation_broker_fee_pct') or 0) / 100.0
    tax = float(cfg.get('liquidation_sales_tax_pct') or 0) / 100.0
    min_margin = float(cfg.get('liquidation_min_margin_pct') or 0)
    min_roi = float(cfg.get('liquidation_min_annual_roi_pct') or 0)
    safety = float(cfg.get('liquidation_window_safety') or 1.3)

    qty = int(row.get('quantity') or 0)
    sell = float(row.get('sell_unit') or 0)
    buy = float(row.get('buy_unit') or 0)
    amarr_buy_unit = float(amarr_buy_unit or 0)

    cost_basis = frac * amarr_buy_unit + float(courier_alloc_unit or 0)
    list_net = sell * (1 - broker - tax) - cost_basis
    dump_net = buy * (1 - tax) - cost_basis
    list_margin_pct = (list_net / cost_basis * 100) if cost_basis > 0 else None
    dump_margin_pct = (dump_net / cost_basis * 100) if cost_basis > 0 else None
    spread_pct = ((sell - buy) / sell * 100) if sell > 0 else None
    days_to_sell = (qty / avg_daily_vol) if (avg_daily_vol and avg_daily_vol > 0) else None
    window = _pick_window(days_to_sell, safety)
    annual_roi = None
    if list_margin_pct is not None and days_to_sell is not None:
        annual_roi = list_margin_pct * 365 / max(days_to_sell, 1)

    # Recommendation cascade. Velocity (turning ISK over) is weighted heavily:
    # a thin margin that clears today beats a fat margin that never moves.
    action, reason = 'list', ''
    if amarr_buy_unit <= 0 or sell <= 0:
        action, reason = 'no_data', 'missing Amarr or Jita price'
    elif list_net <= 0 and dump_net <= 0:
        action, reason = 'underwater', 'loss on both list and dump — buyback rate too high here'
    elif window is None:
        # Even a 90-day order can't clear this stack at current volume.
        action = 'dump' if dump_net > 0 else 'underwater'
        reason = 'illiquid: won’t clear within 90d' if dump_net > 0 else 'illiquid and dumping loses ISK'
    elif dump_net >= list_net:
        action, reason = 'dump', 'buy-order dump nets as much as listing — take the instant ISK'
    elif list_margin_pct is not None and list_margin_pct < min_margin and dump_net > 0:
        action, reason = 'dump', f'list margin below {min_margin:.0f}% threshold'
    elif annual_roi is not None and annual_roi < min_roi and dump_net > 0:
        action, reason = 'dump', f'annualized ROI below {min_roi:.0f}% — ISK better recycled'
    else:
        action, reason = 'list', f'list {window}d'

    # Near-zero Amarr buy => cost basis is dominated by courier/rounding and the
    # margin % explodes (SKINs, skill items, etc.). Flag so the UI can down-rank
    # and tag them: their ISK is trivial and their % is not trustworthy.
    low_confidence = (amarr_buy_unit <= 0) or (list_margin_pct is not None and list_margin_pct > 300)

    return {
        'type_id': row.get('type_id'),
        'name': row.get('name'),
        'quantity': qty,
        'low_confidence': low_confidence,
        'unit_volume_m3': float(row.get('unit_volume_m3') or 0),
        'total_volume_m3': float(row.get('unit_volume_m3') or 0) * qty,
        'amarr_buy_unit': amarr_buy_unit,
        'cost_basis_unit': cost_basis,
        'sell_unit': sell,
        'buy_unit': buy,
        'spread_pct': spread_pct,
        'list_net_unit': list_net,
        'dump_net_unit': dump_net,
        'list_margin_pct': list_margin_pct,
        'dump_margin_pct': dump_margin_pct,
        'list_value': list_net * qty,
        'dump_value': dump_net * qty,
        'sell_value': sell * qty,
        'avg_daily_vol': avg_daily_vol,
        'days_to_sell': days_to_sell,
        'depth_units': depth_units,
        'on_book_units': on_book_units,
        'annual_roi': annual_roi,
        'window_days': window,
        'action': action,
        'reason': reason,
    }


def analyze_items(rows, amarr_buy, history, depth, courier_total, cfg):
    """Analyze a batch of items. Pure — caller supplies the market data maps.

    ``amarr_buy``: ``{type_id: amarr_buy_unit}``. ``history``: ``{type_id:
    avg_daily_volume}``. ``depth``: ``{type_id: {'ahead': units_cheaper,
    'on_book': total_sell_units}}``. ``courier_total`` is allocated across rows
    by Jita sell value. Returns ``{items: [...], totals: {...}}``.
    """
    total_sell_value = sum((float(r.get('sell_unit') or 0) * int(r.get('quantity') or 0))
                           for r in rows) or 0.0
    out = []
    for r in rows:
        tid = r.get('type_id')
        row_sell_value = float(r.get('sell_unit') or 0) * int(r.get('quantity') or 0)
        qty = int(r.get('quantity') or 0)
        if courier_total and total_sell_value > 0 and qty > 0:
            courier_alloc_unit = courier_total * (row_sell_value / total_sell_value) / qty
        else:
            courier_alloc_unit = 0.0
        d = depth.get(tid) or {}
        out.append(analyze_row(
            r,
            amarr_buy.get(tid, 0),
            history.get(tid, 0),
            d.get('ahead'),
            d.get('on_book'),
            courier_alloc_unit,
            cfg,
        ))

    def _s(key):
        return sum(float(i.get(key) or 0) for i in out)

    by_action = {}
    for i in out:
        by_action[i['action']] = by_action.get(i['action'], 0) + 1
    totals = {
        'items': len(out),
        'quantity': sum(int(i.get('quantity') or 0) for i in out),
        'total_volume_m3': _s('total_volume_m3'),
        'cost_basis': sum(float(i.get('cost_basis_unit') or 0) * int(i.get('quantity') or 0) for i in out),
        'sell_value': _s('sell_value'),
        'list_net': _s('list_value'),
        'dump_net': _s('dump_value'),
        'by_action': by_action,
    }
    return {'items': out, 'totals': totals}
