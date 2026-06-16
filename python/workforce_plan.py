"""On-disk persistence for the Hooks & Hubs upgrade/workforce planner.

The Equinox sovereignty power/workforce/upgrade layer is NOT exposed by ESI,
so this planner is fed entirely by manual user input and stored as a single
JSON document at ``<EVE_BUYBACK_DATA_DIR>/workforce_plan.json``. It survives
app restarts the same way the Working-tab pins do (see pinned.py).

Document shape::

    {
      "systems": [
        {
          "id": str,                  # stable client-generated id
          "system_name": str,
          "power_available": number,        # local, non-transferable
          "workforce_available": number,    # generated locally by skyhooks
          "upgrades": [ {"name": str, "power": number, "workforce": number} ],
          "notes": str
        }
      ],
      "transfers": [ {"from": system_id, "to": system_id, "amount": number} ],
      "catalog":   [ {"name": str, "power": number, "workforce": number} ]
    }

All power/workforce numbers are user-entered and freely editable — the module
asserts no game-derived constants of its own, so a CCP balance patch can never
make stored data "wrong". Scenario math lives client-side (renderer/
hooks-hubs-utils.js); this module is pure storage.
"""

import json
import os

from config import AUTH_DIR

PLAN_PATH = os.path.join(AUTH_DIR, 'workforce_plan.json')

# A small starter palette of well-known sov-hub upgrade names. Power/workforce
# costs are left at 0 deliberately — the admin fills them in from the in-game
# fitting screen so we never ship numbers that drift with balance patches.
DEFAULT_CATALOG = [
    {'name': 'Cynosural Suppression', 'power': 0, 'workforce': 0},
    {'name': 'Cynosural Navigation', 'power': 0, 'workforce': 0},
    {'name': 'Advanced Logistics Network', 'power': 0, 'workforce': 0},
    {'name': 'Supercapital Construction Facilities', 'power': 0, 'workforce': 0},
    {'name': 'Capital Shipyard', 'power': 0, 'workforce': 0},
    {'name': 'Metenox Moon Drill (support)', 'power': 0, 'workforce': 0},
]


def _ensure_dir():
    os.makedirs(AUTH_DIR, exist_ok=True)


def _empty_plan():
    return {'systems': [], 'transfers': [], 'catalog': list(DEFAULT_CATALOG)}


def _normalize(plan):
    """Coerce an arbitrary dict into the expected shape without trusting it.

    Missing keys are filled; wrong types fall back to empty/default so a
    hand-edited or partially-written file still loads cleanly.
    """
    if not isinstance(plan, dict):
        return _empty_plan()
    systems = plan.get('systems')
    transfers = plan.get('transfers')
    catalog = plan.get('catalog')
    return {
        'systems': systems if isinstance(systems, list) else [],
        'transfers': transfers if isinstance(transfers, list) else [],
        # An empty catalog is respected (user cleared it); only a missing/invalid
        # catalog falls back to the starter palette.
        'catalog': catalog if isinstance(catalog, list) else list(DEFAULT_CATALOG),
    }


def load_plan():
    if not os.path.exists(PLAN_PATH):
        return _empty_plan()
    try:
        with open(PLAN_PATH) as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return _empty_plan()
    return _normalize(data)


def save_plan(plan):
    """Persist the whole document (replace semantics). Returns the stored shape."""
    normalized = _normalize(plan)
    _ensure_dir()
    with open(PLAN_PATH, 'w') as f:
        json.dump(normalized, f, indent=2)
    os.chmod(PLAN_PATH, 0o600)
    return normalized
