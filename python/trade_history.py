"""Recorded station-pair spreads, one point per day.

ESI publishes market history **per region**, never per station. For a pair like
Jita -> Amarr the two regions are a fair proxy, because each hub dominates its
region's trade — but it can't tell two stations in one region apart, and it
isn't the spread, it's two separate price series.

The actual thing a station trader wants to see over time — what the gap between
*these two stations* did — exists nowhere and can only be accrued. So each time
the app looks at a watched pair it writes down what it saw, once per day, and
the chart draws region history immediately while the real series fills in behind
it.

A ring buffer per pair under ``AUTH_DIR``, written through the same atomic,
corrupt-tolerant helpers as the token cache — this file is appended to from
request threads and must not be destroyed by an interrupted write.
"""
import os
import threading
from datetime import datetime, timezone

from config import AUTH_DIR, _atomic_write_json, _read_json_resilient

STORE_PATH = os.path.join(AUTH_DIR, 'trade_history.json')

# A year and a half of daily points is more than any station-trading decision
# needs, and keeps the file small enough to rewrite atomically without thought.
MAX_POINTS = 540
# Watching more pairs than this stops being a ticker and starts being a crawl.
MAX_SERIES = 240

_LOCK = threading.RLock()


def key(type_id, from_station, to_station):
    return f'{int(type_id)}|{int(from_station)}|{int(to_station)}'


def _load():
    data = _read_json_resilient(STORE_PATH, _LOCK)
    return data if isinstance(data, dict) else {}


def load_series(type_id, from_station, to_station):
    """Recorded points for one pair, oldest first."""
    got = _load().get(key(type_id, from_station, to_station))
    return got if isinstance(got, list) else []


def record(type_id, from_station, to_station, ask, bid, far_ask=None,
           ask_vol=0, bid_vol=0, when=None):
    """Write down today's spread for one pair, replacing today's if it exists.

    One point per UTC day: a trader checking the tab six times an afternoon
    should not get six points, and the last look of the day is as good a
    representative as the first.
    """
    if not ask or not bid:
        return None
    day = (when or datetime.now(timezone.utc)).strftime('%Y-%m-%d')
    point = {'d': day, 'ask': round(float(ask), 2), 'bid': round(float(bid), 2),
             'far_ask': round(float(far_ask), 2) if far_ask else None,
             'ask_vol': int(ask_vol or 0), 'bid_vol': int(bid_vol or 0),
             'margin': round((float(bid) - float(ask)) / float(ask), 4) if ask else 0.0}
    k = key(type_id, from_station, to_station)
    with _LOCK:
        data = _load()
        series = data.get(k)
        if not isinstance(series, list):
            series = []
        if series and series[-1].get('d') == day:
            series[-1] = point
        else:
            series.append(point)
        if len(series) > MAX_POINTS:
            del series[:len(series) - MAX_POINTS]
        data[k] = series
        if len(data) > MAX_SERIES:
            # Drop whichever series were touched longest ago, not arbitrary ones.
            ordered = sorted(data.items(), key=lambda kv: (kv[1][-1]['d'] if kv[1] else ''))
            for dead, _ in ordered[:len(data) - MAX_SERIES]:
                data.pop(dead, None)
        _atomic_write_json(STORE_PATH, data, _LOCK)
    return point


def stats():
    data = _load()
    return {'series': len(data), 'points': sum(len(v) for v in data.values() if isinstance(v, list))}
