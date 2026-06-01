"""On-disk persistence for the Working tab's pinned moon contracts.

Pinned contracts are stored as a JSON array under
``<EVE_BUYBACK_DATA_DIR>/pinned_contracts.json`` so they survive renderer
refreshes, Moon-tab re-fetches, and app close+reopen. The shape of each pin:

    {
      "contract_id": int,
      "pinned_at": ISO8601 string,
      "snapshot": <full moon-result row from validate.process_moon_contract>,
      "blended_fraction": float | null,    # derived once at pin time
      "notes": "",
      "status": "pending" | "paid" | "disputed",
      "appraisals": [                      # last few admin-driven appraisals
        {
          "timestamp": ISO8601,
          "janice_total": float,
          "fraction_used": float,
          "payout": float,
          "market_name": str,
          "janice_code": str | None,
          "items_count": int,
          "paste_preview": str             # first ~120 chars of the paste
        },
        ...
      ]
    }

We deliberately keep ``snapshot`` opaque — whatever the moon pipeline emits
goes straight through, no schema policing here. The Working-tab UI knows how
to render it.
"""

import json
import os

from config import AUTH_DIR

PINNED_PATH = os.path.join(AUTH_DIR, 'pinned_contracts.json')

VALID_STATUSES = ('pending', 'paid', 'disputed')
MAX_APPRAISALS_PER_PIN = 20


def _ensure_dir():
    os.makedirs(AUTH_DIR, exist_ok=True)


def load_pinned():
    if not os.path.exists(PINNED_PATH):
        return []
    try:
        with open(PINNED_PATH) as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return []
    if not isinstance(data, list):
        return []
    # Drop entries missing the only required key so the rest of the file
    # stays usable if one record is mangled.
    return [p for p in data if isinstance(p, dict) and p.get('contract_id')]


def save_pinned(pins):
    _ensure_dir()
    with open(PINNED_PATH, 'w') as f:
        json.dump(pins, f, indent=2)
    os.chmod(PINNED_PATH, 0o600)


def _blended_fraction_from_snapshot(snapshot):
    """Derive an effective payout fraction from a moon-result snapshot.

    moon_value, non_moon_value, moon_payout, non_moon_payout come from
    refining.compute_refined_payout. The blended fraction is what was
    effectively applied to (moon_value + non_moon_value) to get
    recommended_payout, so the same fraction can be re-applied to a fresh
    Janice appraisal of the actual refined output the admin saw in-game.
    """
    refined = (snapshot or {}).get('payout', {}).get('refined') or {}
    moon_value = float(refined.get('moon_value') or 0)
    non_moon_value = float(refined.get('non_moon_value') or 0)
    total = moon_value + non_moon_value
    if total <= 0:
        # Fall back to the non-moon fraction (the more permissive default).
        return float(refined.get('non_moon_payout_fraction') or 0.90)
    moon_payout = float(refined.get('moon_payout') or 0)
    non_moon_payout = float(refined.get('non_moon_payout') or 0)
    return (moon_payout + non_moon_payout) / total


def upsert_pin(snapshot, pinned_at):
    """Add or replace a pin keyed by contract_id. Returns the updated pin list."""
    cid = int(snapshot.get('contract_id') or 0)
    if not cid:
        raise ValueError('snapshot is missing contract_id')
    pins = load_pinned()
    existing = next((p for p in pins if int(p.get('contract_id') or 0) == cid), None)
    if existing is not None:
        # Refresh the snapshot but keep notes / status / appraisals across re-pins.
        existing['snapshot'] = snapshot
        existing['blended_fraction'] = _blended_fraction_from_snapshot(snapshot)
        # Preserve original pinned_at; don't overwrite.
    else:
        pins.append({
            'contract_id': cid,
            'pinned_at': pinned_at,
            'snapshot': snapshot,
            'blended_fraction': _blended_fraction_from_snapshot(snapshot),
            'notes': '',
            'status': 'pending',
            'appraisals': [],
        })
    save_pinned(pins)
    return pins


def remove_pin(contract_id):
    cid = int(contract_id)
    pins = [p for p in load_pinned() if int(p.get('contract_id') or 0) != cid]
    save_pinned(pins)
    return pins


def update_pin_fields(contract_id, patch):
    """Apply a key→value patch to one pin. Only known mutable keys are accepted."""
    allowed = {'notes', 'status'}
    cid = int(contract_id)
    pins = load_pinned()
    for p in pins:
        if int(p.get('contract_id') or 0) != cid:
            continue
        for k, v in patch.items():
            if k not in allowed:
                continue
            if k == 'status' and v not in VALID_STATUSES:
                continue
            p[k] = v
        save_pinned(pins)
        return p
    raise KeyError(f'pin {cid} not found')


def append_appraisal(contract_id, appraisal_record):
    """Push one appraisal record onto the pin's appraisals list (newest first)."""
    cid = int(contract_id)
    pins = load_pinned()
    for p in pins:
        if int(p.get('contract_id') or 0) != cid:
            continue
        history = list(p.get('appraisals') or [])
        history.insert(0, appraisal_record)
        p['appraisals'] = history[:MAX_APPRAISALS_PER_PIN]
        save_pinned(pins)
        return p
    raise KeyError(f'pin {cid} not found')
