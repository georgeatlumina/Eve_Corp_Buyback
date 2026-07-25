"""On-disk persistence for the Acquisitions tab's hull and item inventory.

Stored as a JSON object under ``<EVE_BUYBACK_DATA_DIR>/acquisitions_inventory.json``
so it survives app restarts. Shape:

    {
      "hulls": [{"type_id": int, "name": str, "quantity": int}, ...],
      "items": [{"type_id": int, "name": str, "quantity": int}, ...],
      "updated_at": "ISO8601"
    }
"""

import json
import os
from datetime import datetime, timezone

from config import AUTH_DIR

ACQUISITIONS_PATH = os.path.join(AUTH_DIR, 'acquisitions_inventory.json')


def _ensure_dir():
    os.makedirs(AUTH_DIR, exist_ok=True)


def load_acquisitions():
    if not os.path.exists(ACQUISITIONS_PATH):
        return {'hulls': [], 'items': [], 'updated_at': None}
    try:
        with open(ACQUISITIONS_PATH) as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return {'hulls': [], 'items': [], 'updated_at': None}
    if not isinstance(data, dict):
        return {'hulls': [], 'items': [], 'updated_at': None}
    return {
        'hulls': data.get('hulls') or [],
        'items': data.get('items') or [],
        'updated_at': data.get('updated_at'),
    }


def save_acquisitions(hulls, items):
    _ensure_dir()
    data = {
        'hulls': hulls or [],
        'items': items or [],
        'updated_at': datetime.now(timezone.utc).isoformat(),
    }
    with open(ACQUISITIONS_PATH, 'w') as f:
        json.dump(data, f, indent=2)
    return data
