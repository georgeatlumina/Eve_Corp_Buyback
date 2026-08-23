"""On-disk store for which corp hangar divisions are included in an ESI
inventory scan. Shared by the Acquisitions and Stockpile tabs — one
selection, not two. Pure module (no network IO); server.py owns the GitHub
read/write, mirroring pinned.py / stockpile.py.
"""
import json
import os

from config import AUTH_DIR

STORE_PATH = os.path.join(AUTH_DIR, 'hangar_selection.json')

# Canonical division flags. ESI's HangarAll (older/simple corp hangar setups)
# and CorpSAG1 (the modern flag) both mean "Division 1" and collapse to the
# same key, so a saved selection is stable regardless of which flag a given
# corp's structure actually reports.
VALID_FLAGS = ('CorpSAG1', 'CorpSAG2', 'CorpSAG3', 'CorpSAG4', 'CorpSAG5', 'CorpSAG6', 'CorpSAG7')


def _canonical(flag):
    return 'CorpSAG1' if flag == 'HangarAll' else flag


def empty_selection():
    return {'selected_flags': [], 'updated_at': ''}


def normalize(data):
    """Coerce an arbitrary loaded doc into the canonical shape. Unknown
    entries are dropped, HangarAll collapses to CorpSAG1, duplicates are
    removed, and the result is ordered by division number."""
    if not isinstance(data, dict):
        return empty_selection()
    raw = data.get('selected_flags')
    if not isinstance(raw, list):
        raw = []
    canon = {_canonical(f) for f in raw if isinstance(f, str)}
    flags = [f for f in VALID_FLAGS if f in canon]
    return {'selected_flags': flags, 'updated_at': str(data.get('updated_at') or '')}


def load_selection_local():
    try:
        with open(STORE_PATH, 'r', encoding='utf-8') as fh:
            return normalize(json.load(fh))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return empty_selection()


def save_selection_local(selection):
    os.makedirs(AUTH_DIR, exist_ok=True)
    tmp = STORE_PATH + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(selection, fh, indent=2)
    os.replace(tmp, STORE_PATH)
    try:
        os.chmod(STORE_PATH, 0o600)
    except OSError:
        pass
