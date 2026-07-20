"""Alliance industry-material stockpile store + EVE-paste parsing.

Pure module (no network IO), mirroring the design of `liquidation.py`: the
GitHub read/write lives in `server.py` so it can reuse the Contents-API
helpers; this module owns paste parsing, item classification, and the local
cache/fallback file.

The admin pastes an EVE inventory/asset list (name + quantity, usually
tab-separated). `parse_paste` turns it into `[{name, qty}]`; the caller
resolves each name to an EVE type + category via ESI and calls `classify` to
bucket it into `minerals` / `pi` / `other`. The categorized doc is stored so
readers never re-resolve.
"""

import json
import os
import re

from config import AUTH_DIR

STORE_PATH = os.path.join(AUTH_DIR, 'stockpile.json')

CATEGORIES = ('minerals', 'pi', 'other')

# Fallback so the eight refined minerals (+ Morphite) always bucket correctly
# even when ESI name resolution is unavailable.
MINERAL_NAMES = {
    'tritanium', 'pyerite', 'mexallon', 'isogen',
    'nocxium', 'zydrine', 'megacyte', 'morphite',
}

# EVE group / category ids used for classification.
_GROUP_MINERAL = 18            # group "Mineral"
_GROUP_PLANETARY_RAW = 1042    # group "Planetary Materials" (P0 raw)
_CATEGORY_PLANETARY = 43       # category "Planetary Commodities" (P1–P4)


def empty_store():
    return {'updated_at': '', 'note': '', 'items': []}


def normalize(data):
    """Coerce an arbitrary loaded doc into the canonical shape."""
    if not isinstance(data, dict):
        return empty_store()
    items = []
    for it in (data.get('items') or []):
        if not isinstance(it, dict):
            continue
        name = str(it.get('name') or '').strip()
        if not name:
            continue
        try:
            qty = int(it.get('qty') or 0)
        except (TypeError, ValueError):
            qty = 0
        cat = it.get('category')
        if cat not in CATEGORIES:
            cat = 'other'
        try:
            tid = int(it.get('type_id') or 0)
        except (TypeError, ValueError):
            tid = 0
        items.append({'name': name, 'type_id': tid, 'qty': qty, 'category': cat})
    return {
        'updated_at': str(data.get('updated_at') or ''),
        'note': str(data.get('note') or ''),
        'items': items,
    }


def load_store_local():
    try:
        with open(STORE_PATH, 'r', encoding='utf-8') as fh:
            return normalize(json.load(fh))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return empty_store()


def save_store_local(store):
    os.makedirs(AUTH_DIR, exist_ok=True)
    tmp = STORE_PATH + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(store, fh, indent=2)
    os.replace(tmp, STORE_PATH)
    try:
        os.chmod(STORE_PATH, 0o600)
    except OSError:
        pass


def _to_int(s):
    """Parse an EVE quantity, tolerating thousands separators (commas/dots/
    spaces). Returns None when it isn't a plain integer."""
    if s is None:
        return None
    s = re.sub(r'[\s ,.]', '', str(s).strip())
    if not s or not s.isdigit():
        return None
    return int(s)


def _parse_line(line):
    """Return (name, qty) for one pasted line, or (None, 0) to skip it."""
    # EVE inventory copy is tab-separated: name \t qty \t group \t category \t …
    if '\t' in line:
        parts = [p.strip() for p in line.split('\t')]
        name = parts[0]
        if not name:
            return None, 0
        qty = _to_int(parts[1]) if len(parts) > 1 else 1
        return name, (qty if qty is not None else 1)
    # Multibuy / space-separated with a trailing quantity: "Item Name 12,500".
    m = re.match(r'^(.*?)[\s ]+([\d.,\s]+)$', line)
    if m:
        qty = _to_int(m.group(2))
        if qty is not None:
            return m.group(1).strip(), qty
    # Bare item name → count of 1.
    return line, 1


def parse_paste(text):
    """Parse an EVE inventory/asset paste into `[{name, qty}]`, aggregating
    duplicate lines and preserving first-seen order."""
    agg = {}
    order = []
    for raw in (text or '').splitlines():
        line = raw.strip()
        if not line:
            continue
        name, qty = _parse_line(line)
        if not name:
            continue
        key = name.lower()
        if key not in agg:
            agg[key] = {'name': name, 'qty': 0}
            order.append(key)
        agg[key]['qty'] += int(qty or 0)
    return [agg[k] for k in order]


def classify(meta, name=''):
    """Bucket an item into 'minerals' | 'pi' | 'other' from its ESI type
    metadata (`{group_id, category_id, …}`), with a name fallback for
    minerals when metadata is missing."""
    if (name or '').strip().lower() in MINERAL_NAMES:
        return 'minerals'
    gid = int((meta or {}).get('group_id') or 0)
    cid = int((meta or {}).get('category_id') or 0)
    if gid == _GROUP_MINERAL:
        return 'minerals'
    if cid == _CATEGORY_PLANETARY or gid == _GROUP_PLANETARY_RAW:
        return 'pi'
    return 'other'
