# Corp Hangar Inventory Scan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Acquisitions and Stockpile populate their inventories from a button-triggered ESI scan of corp hangars (Director-role token) instead of only manual paste, with a shared checkbox picker for which hangar divisions to include.

**Architecture:** Reuse the existing `/api/corp/assets` ESI puller (add `group_id` to its output), add a small shared "which divisions" selection synced through the market-history GitHub repo (mirroring the Stockpile/doctrine-stock pattern), and a new Stockpile import endpoint that runs ESI-sourced items through the same classifier the paste path uses. The renderer gets one shared checkbox-grid component consumed by both tabs.

**Tech Stack:** FastAPI + Pydantic (sidecar), vanilla JS renderer (no build step), pytest (Starlette `TestClient`), Jest.

**Spec:** [docs/superpowers/specs/2026-08-22-corp-hangar-inventory-scan-design.md](../specs/2026-08-22-corp-hangar-inventory-scan-design.md)

## Global Constraints

- Every scan is triggered by an explicit button click — no polling, no auto-refresh, no scheduled sync.
- Stockpile's ESI import always **replaces** the whole stockpile store (never merges) — matches its existing paste-save behavior.
- Acquisitions' ESI import keeps its existing **Add to inventory** / **Replace inventory** choice.
- The hangar-division selection is **shared** between Acquisitions and Stockpile (one selection, not two).
- The hangar-division selection persists to the market-history GitHub repo (Read/Write PAT pair already used by Stockpile/doctrine-stock/builds), with a local-cache fallback when no repo is configured — never a hard failure.
- Both tabs scope to the single configured `home_structure_id`, same as today — no multi-structure support.

---

### Task 1: Shared hangar-selection store (`hangar_selection.py`)

**Files:**
- Create: `python/hangar_selection.py`
- Test: `python/tests/test_hangar_selection.py`

**Interfaces:**
- Produces: `hangar_selection.VALID_FLAGS` (tuple of 7 canonical flags `'CorpSAG1'`..`'CorpSAG7'`), `hangar_selection.empty_selection() -> dict`, `hangar_selection.normalize(data) -> dict` (shape `{'selected_flags': list[str], 'updated_at': str}`), `hangar_selection.load_selection_local() -> dict`, `hangar_selection.save_selection_local(selection: dict) -> None`.

- [ ] **Step 1: Write the failing tests**

Create `python/tests/test_hangar_selection.py`:

```python
"""Tests for the shared corp-hangar-division selection store
(hangar_selection.py) used by both the Acquisitions and Stockpile ESI scans.
"""
import os
import sys
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


@pytest.fixture()
def sel_path(tmp_path):
    """Point the module at a throwaway file so tests never touch real data."""
    import hangar_selection
    p = tmp_path / 'hangar_selection.json'
    with patch.object(hangar_selection, 'STORE_PATH', str(p)), \
         patch.object(hangar_selection, 'AUTH_DIR', str(tmp_path)):
        yield hangar_selection, str(p)


class TestNormalize:
    def test_non_dict_becomes_empty(self, sel_path):
        hangar_selection, _ = sel_path
        assert hangar_selection.normalize([1, 2, 3]) == {'selected_flags': [], 'updated_at': ''}

    def test_drops_unknown_flags(self, sel_path):
        hangar_selection, _ = sel_path
        result = hangar_selection.normalize({'selected_flags': ['CorpSAG1', 'NotAFlag']})
        assert result['selected_flags'] == ['CorpSAG1']

    def test_collapses_hangarall_into_corpsag1(self, sel_path):
        hangar_selection, _ = sel_path
        result = hangar_selection.normalize({'selected_flags': ['HangarAll', 'CorpSAG3']})
        assert result['selected_flags'] == ['CorpSAG1', 'CorpSAG3']

    def test_dedupes_and_orders_by_division_number(self, sel_path):
        hangar_selection, _ = sel_path
        result = hangar_selection.normalize({'selected_flags': ['CorpSAG3', 'CorpSAG1', 'CorpSAG1']})
        assert result['selected_flags'] == ['CorpSAG1', 'CorpSAG3']

    def test_ignores_non_string_entries(self, sel_path):
        hangar_selection, _ = sel_path
        result = hangar_selection.normalize({'selected_flags': ['CorpSAG2', 42, None]})
        assert result['selected_flags'] == ['CorpSAG2']


class TestLocalStore:
    def test_missing_file_returns_empty_selection(self, sel_path):
        hangar_selection, _ = sel_path
        assert hangar_selection.load_selection_local() == hangar_selection.empty_selection()

    def test_reads_back_saved_selection(self, sel_path):
        hangar_selection, _ = sel_path
        hangar_selection.save_selection_local(
            hangar_selection.normalize({'selected_flags': ['CorpSAG2'],
                                        'updated_at': '2026-08-22T00:00:00+00:00'})
        )
        loaded = hangar_selection.load_selection_local()
        assert loaded['selected_flags'] == ['CorpSAG2']
        assert loaded['updated_at'] == '2026-08-22T00:00:00+00:00'

    def test_corrupt_json_degrades_to_empty(self, sel_path):
        hangar_selection, path = sel_path
        with open(path, 'w') as f:
            f.write('{ not json')
        assert hangar_selection.load_selection_local() == hangar_selection.empty_selection()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd python && python -m pytest tests/test_hangar_selection.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'hangar_selection'`

- [ ] **Step 3: Implement `python/hangar_selection.py`**

```python
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd python && python -m pytest tests/test_hangar_selection.py -v`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add python/hangar_selection.py python/tests/test_hangar_selection.py
git commit -m "feat(hangars): add shared hangar-division selection store"
```

---

### Task 2: `hangar_selection_allow_push` config default

**Files:**
- Modify: `python/config.py` (in `DEFAULTS`, next to `stockpile_allow_push`)
- Test: `python/tests/test_config.py`

**Interfaces:**
- Produces: `config.DEFAULTS['hangar_selection_allow_push'] == False`, carried through `load_config()`/`save_config()` like every other `_USER_KEYS` entry.

- [ ] **Step 1: Write the failing tests**

Append to `python/tests/test_config.py` (after the existing `TestLoadSaveMerge` class, which currently ends at `assert 'not_a_real_setting' not in on_disk`):

```python


class TestHangarSelectionAllowPushDefault:
    def test_defaults_to_off(self, cfg_path):
        config, _ = cfg_path
        assert config.load_config()['hangar_selection_allow_push'] is False

    def test_a_saved_on_value_is_preserved(self, cfg_path):
        config, path = cfg_path
        with open(path, 'w') as f:
            json.dump({'hangar_selection_allow_push': True}, f)
        assert config.load_config()['hangar_selection_allow_push'] is True
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd python && python -m pytest tests/test_config.py -v -k HangarSelectionAllowPush`
Expected: FAIL with `KeyError: 'hangar_selection_allow_push'`

- [ ] **Step 3: Add the default**

In `python/config.py`, in the `DEFAULTS` dict, immediately after the `stockpile_last_status` line (part of the `# ---- Stockpile page ----` block):

```python
    'stockpile_last_synced': '',   # ISO timestamp of last successful push
    'stockpile_last_status': '',   # short human-readable last result
    # Gates the write side of the shared corp-hangar-division selection (used
    # by both the Acquisitions and Stockpile ESI scans) — mirrors
    # stockpile_allow_push so importing someone else's exported config can't
    # silently unlock pushing the shared selection.
    'hangar_selection_allow_push': False,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd python && python -m pytest tests/test_config.py -v`
Expected: PASS (all tests in the file, including the 2 new ones)

- [ ] **Step 5: Commit**

```bash
git add python/config.py python/tests/test_config.py
git commit -m "feat(hangars): add hangar_selection_allow_push config default"
```

---

### Task 3: `/api/corp/assets` returns `group_id` per item

**Files:**
- Modify: `python/server.py:5641-5662` (the `_resolve()` helper and its call site inside `get_corp_assets`)
- Test: `python/tests/test_corp_assets.py`

**Interfaces:**
- Consumes: nothing new (uses `enrich_types`, `fetch_corp_assets`, `list_authenticated_slots`, `get_valid_access_token`, `decode_jwt_payload`, `fetch_character_info` — all already imported in `server.py`).
- Produces: each item in `GET /api/corp/assets`'s `hangars[].items[]` now also carries `group_id` (int or `None`), alongside the existing `type_id`, `name`, `quantity`, `category_id`.

- [ ] **Step 1: Write the failing test**

Create `python/tests/test_corp_assets.py`:

```python
"""Tests for GET /api/corp/assets — corp hangar contents via ESI."""
import os
import sys
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient
    import server
    return TestClient(server.app)


def _jwt_payload(scopes):
    return {'sub': 'CHARACTER:EVE:123', 'scp': scopes}


class TestCorpAssets:
    def test_no_home_structure_configured(self, client):
        with patch('server.load_config', return_value={'home_structure_id': 0}):
            resp = client.get('/api/corp/assets')
        assert resp.json() == {'ok': False, 'reason': 'no_home_structure'}

    def test_no_slot_has_the_required_scope(self, client):
        with patch('server.load_config', return_value={'home_structure_id': 60003760}), \
             patch('server.list_authenticated_slots', return_value=['slot1']), \
             patch('server.get_valid_access_token', return_value='tok'), \
             patch('server.decode_jwt_payload', return_value=_jwt_payload(['publicData'])):
            resp = client.get('/api/corp/assets')
        assert resp.json() == {'ok': False, 'reason': 'missing_scope'}

    def test_groups_items_by_hangar_and_includes_group_id(self, client, tmp_path):
        assets = [
            {'type_id': 645, 'quantity': 1, 'location_id': 60003760, 'location_flag': 'CorpSAG1'},
            {'type_id': 34, 'quantity': 5000, 'location_id': 60003760, 'location_flag': 'CorpSAG2'},
            # different structure — must be excluded from the response
            {'type_id': 645, 'quantity': 1, 'location_id': 999999, 'location_flag': 'CorpSAG1'},
        ]
        with patch('server.load_config', return_value={'home_structure_id': 60003760}), \
             patch('server.list_authenticated_slots', return_value=['slot1']), \
             patch('server.get_valid_access_token', return_value='tok'), \
             patch('server.decode_jwt_payload',
                   return_value=_jwt_payload(['esi-assets.read_corporation_assets.v1'])), \
             patch('server.fetch_character_info', return_value={'corporation_id': 98000001}), \
             patch('server.fetch_corp_assets', return_value=assets), \
             patch('server.enrich_types', return_value={
                 645: {'name': 'Dominix', 'category_id': 6, 'group_id': 27},
                 34: {'name': 'Tritanium', 'category_id': 4, 'group_id': 18},
             }), \
             patch('config.AUTH_DIR', str(tmp_path)):
            resp = client.get('/api/corp/assets')
        data = resp.json()
        assert data['ok'] is True
        by_flag = {h['flag']: h for h in data['hangars']}
        assert by_flag['CorpSAG1']['items'] == [
            {'type_id': 645, 'name': 'Dominix', 'quantity': 1, 'category_id': 6, 'group_id': 27},
        ]
        assert by_flag['CorpSAG1']['item_count'] == 1  # the other-structure Dominix is excluded
        assert by_flag['CorpSAG2']['items'][0]['group_id'] == 18
```

- [ ] **Step 2: Run the test to verify the new assertion fails**

Run: `cd python && python -m pytest tests/test_corp_assets.py -v`
Expected: `test_groups_items_by_hangar_and_includes_group_id` FAILS — the response items have no `group_id` key yet. The first two tests already pass (they exercise existing behavior).

- [ ] **Step 3: Add `group_id` to `_resolve()` and its call site**

In `python/server.py`, inside `get_corp_assets()`:

```python
    def _resolve(type_id):
        tid = int(type_id)
        if tid in local_meta:
            m = local_meta[tid]
            return m.get('name', str(tid)), m.get('category_id')
        if tid in enriched:
            m = enriched[tid]
            return m.get('name', str(tid)), m.get('category_id')
        return str(tid), None
```

becomes:

```python
    def _resolve(type_id):
        tid = int(type_id)
        if tid in local_meta:
            m = local_meta[tid]
            return m.get('name', str(tid)), m.get('category_id'), m.get('group_id')
        if tid in enriched:
            m = enriched[tid]
            return m.get('name', str(tid)), m.get('category_id'), m.get('group_id')
        return str(tid), None, None
```

and:

```python
    for a in hangar_items:
        flag = a.get('location_flag', 'HangarAll')
        name, category_id = _resolve(a['type_id'])
        by_flag[flag].append({
            'type_id': int(a['type_id']),
            'name': name,
            'quantity': int(a.get('quantity') or 1),
            'category_id': category_id,
        })
```

becomes:

```python
    for a in hangar_items:
        flag = a.get('location_flag', 'HangarAll')
        name, category_id, group_id = _resolve(a['type_id'])
        by_flag[flag].append({
            'type_id': int(a['type_id']),
            'name': name,
            'quantity': int(a.get('quantity') or 1),
            'category_id': category_id,
            'group_id': group_id,
        })
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd python && python -m pytest tests/test_corp_assets.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full pytest suite to confirm no regressions**

Run: `cd python && python -m pytest tests/ -v`
Expected: PASS (all tests, including the pre-existing ones)

- [ ] **Step 6: Commit**

```bash
git add python/server.py python/tests/test_corp_assets.py
git commit -m "feat(hangars): include group_id in /api/corp/assets items"
```

---

### Task 4: Shared hangar-selection endpoints (`GET`/`POST /api/hangar-selection`)

**Files:**
- Modify: `python/server.py` (add near the existing `_share_remote_cfg`/`_stockpile_remote_cfg` block, ~line 4090)
- Test: `python/tests/test_hangar_selection_api.py`

**Interfaces:**
- Consumes: `hangar_selection.normalize/load_selection_local/save_selection_local` (Task 1), `config.DEFAULTS['hangar_selection_allow_push']` (Task 2), the existing `_share_remote_cfg`, `_github_contents_get`, `_github_contents_put`, `get_user_agent`, `load_config`.
- Produces: `GET /api/hangar-selection` → `{selected_flags: list[str], updated_at: str, storage: 'github'|'local'}`. `POST /api/hangar-selection` (body `{flags: list[str]}`) → same shape; `403` when `hangar_selection_allow_push` is off.

- [ ] **Step 1: Write the failing tests**

Create `python/tests/test_hangar_selection_api.py`:

```python
"""Tests for GET/POST /api/hangar-selection — the shared corp-hangar-division
selection used by both the Acquisitions and Stockpile ESI scans."""
import os
import sys
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient
    import server
    return TestClient(server.app)


@pytest.fixture()
def local_store(tmp_path):
    import hangar_selection
    p = tmp_path / 'hangar_selection.json'
    with patch.object(hangar_selection, 'STORE_PATH', str(p)), \
         patch.object(hangar_selection, 'AUTH_DIR', str(tmp_path)):
        yield hangar_selection


class TestGetHangarSelection:
    def test_no_repo_configured_reads_local_cache(self, client, local_store):
        local_store.save_selection_local(local_store.normalize({'selected_flags': ['CorpSAG2']}))
        with patch('server.load_config', return_value={'market_history_repo_url': ''}):
            resp = client.get('/api/hangar-selection')
        data = resp.json()
        assert data['selected_flags'] == ['CorpSAG2']
        assert data['storage'] == 'local'

    def test_repo_configured_reads_from_github(self, client, local_store):
        cfg = {
            'market_history_repo_url': 'https://github.com/acme/history',
            'market_history_pat_read': 'read-pat',
        }
        with patch('server.load_config', return_value=cfg), \
             patch('server._github_contents_get',
                   return_value=('{"selected_flags": ["CorpSAG4"], "updated_at": "t"}', 'sha1')):
            resp = client.get('/api/hangar-selection')
        data = resp.json()
        assert data['selected_flags'] == ['CorpSAG4']
        assert data['storage'] == 'github'

    def test_github_failure_falls_back_to_local_cache(self, client, local_store):
        local_store.save_selection_local(local_store.normalize({'selected_flags': ['CorpSAG5']}))
        cfg = {
            'market_history_repo_url': 'https://github.com/acme/history',
            'market_history_pat_read': 'read-pat',
        }
        with patch('server.load_config', return_value=cfg), \
             patch('server._github_contents_get', side_effect=Exception('network down')):
            resp = client.get('/api/hangar-selection')
        data = resp.json()
        assert data['selected_flags'] == ['CorpSAG5']


class TestSaveHangarSelection:
    def test_403_when_push_not_allowed(self, client):
        with patch('server.load_config', return_value={'hangar_selection_allow_push': False}):
            resp = client.post('/api/hangar-selection', json={'flags': ['CorpSAG1']})
        assert resp.status_code == 403

    def test_saves_locally_when_no_repo_configured(self, client, local_store):
        cfg = {'hangar_selection_allow_push': True, 'market_history_repo_url': ''}
        with patch('server.load_config', return_value=cfg):
            resp = client.post('/api/hangar-selection', json={'flags': ['CorpSAG1', 'CorpSAG3']})
        data = resp.json()
        assert data['selected_flags'] == ['CorpSAG1', 'CorpSAG3']
        assert data['storage'] == 'local'
        assert local_store.load_selection_local()['selected_flags'] == ['CorpSAG1', 'CorpSAG3']

    def test_pushes_to_github_when_write_pat_present(self, client, local_store):
        cfg = {
            'hangar_selection_allow_push': True,
            'market_history_repo_url': 'https://github.com/acme/history',
            'market_history_pat_read': 'read-pat',
            'market_history_pat_write': 'write-pat',
        }
        with patch('server.load_config', return_value=cfg), \
             patch('server._github_contents_get', side_effect=FileNotFoundError), \
             patch('server._github_contents_put') as mock_put:
            resp = client.post('/api/hangar-selection', json={'flags': ['CorpSAG6']})
        assert resp.json()['storage'] == 'github'
        mock_put.assert_called_once()

    def test_push_failure_is_non_fatal_and_local_still_saved(self, client, local_store):
        cfg = {
            'hangar_selection_allow_push': True,
            'market_history_repo_url': 'https://github.com/acme/history',
            'market_history_pat_read': 'read-pat',
            'market_history_pat_write': 'write-pat',
        }
        with patch('server.load_config', return_value=cfg), \
             patch('server._github_contents_get', side_effect=FileNotFoundError), \
             patch('server._github_contents_put', side_effect=Exception('conflict')):
            resp = client.post('/api/hangar-selection', json={'flags': ['CorpSAG7']})
        assert resp.status_code == 200  # non-fatal, unlike stockpile's push
        assert local_store.load_selection_local()['selected_flags'] == ['CorpSAG7']
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd python && python -m pytest tests/test_hangar_selection_api.py -v`
Expected: FAIL with 404s (routes don't exist yet)

- [ ] **Step 3: Add `import hangar_selection` to server.py**

In `python/server.py`, next to the existing `import stockpile` (line 115):

```python
import stockpile
import hangar_selection
```

- [ ] **Step 4: Add the endpoints**

In `python/server.py`, immediately after `_stockpile_remote_cfg` (which ends at `return {**rc, 'path': _STOCKPILE_STORE_PATH} if rc else None`, ~line 4088):

```python
_HANGAR_SELECTION_PATH = 'hangar-selection.json'


def _hangar_selection_remote_cfg(cfg):
    """GitHub location for the shared hangar-division selection, in the same
    alliance repo as stockpile/doctrine-stock/builds."""
    rc = _share_remote_cfg(cfg)
    return {**rc, 'path': _HANGAR_SELECTION_PATH} if rc else None


def _hangar_selection_read():
    """Return (selection, rc). Prefers GitHub, falls back to the local cache
    on any remote failure — same convention as _stockpile_read_store."""
    cfg = load_config()
    rc = _hangar_selection_remote_cfg(cfg)
    if not rc:
        return hangar_selection.load_selection_local(), None
    ua = get_user_agent()
    try:
        text, _sha = _github_contents_get(rc['owner'], rc['repo'], rc['branch'],
                                          rc['path'], rc['read_pat'], ua)
        selection = hangar_selection.normalize(json.loads(text))
        hangar_selection.save_selection_local(selection)  # refresh cache
        return selection, rc
    except FileNotFoundError:
        return hangar_selection.empty_selection(), rc  # first write creates the file
    except Exception:
        return hangar_selection.load_selection_local(), rc


@app.get('/api/hangar-selection')
def get_hangar_selection():
    selection, rc = _hangar_selection_read()
    return {**selection, 'storage': 'github' if rc else 'local'}


class HangarSelectionSave(BaseModel):
    flags: list[str] = []


@app.post('/api/hangar-selection')
def save_hangar_selection(req: HangarSelectionSave):
    cfg = load_config()
    if not cfg.get('hangar_selection_allow_push'):
        raise HTTPException(403, 'Hangar-selection sync is disabled (enable it in Config).')
    selection = hangar_selection.normalize({
        'selected_flags': req.flags,
        'updated_at': datetime.now(timezone.utc).isoformat(),
    })
    hangar_selection.save_selection_local(selection)
    rc = _hangar_selection_remote_cfg(cfg)
    if rc and rc.get('write_pat'):
        ua = get_user_agent()
        try:
            try:
                _text, sha = _github_contents_get(rc['owner'], rc['repo'], rc['branch'],
                                                  rc['path'], rc['read_pat'], ua)
            except FileNotFoundError:
                sha = None  # first write creates the file
            _github_contents_put(rc['owner'], rc['repo'], rc['branch'], rc['path'],
                                 json.dumps(selection, indent=2), sha, rc['write_pat'],
                                 ua, 'hangar-selection: update')
        except Exception:
            pass  # non-fatal — the local save above already succeeded
    return {**selection, 'storage': 'github' if (rc and rc.get('write_pat')) else 'local'}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd python && python -m pytest tests/test_hangar_selection_api.py -v`
Expected: PASS (8 tests)

- [ ] **Step 6: Run the full pytest suite to confirm no regressions**

Run: `cd python && python -m pytest tests/ -v`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add python/server.py python/tests/test_hangar_selection_api.py
git commit -m "feat(hangars): add GET/POST /api/hangar-selection endpoints"
```

---

### Task 5: `POST /api/stockpile/import-hangars`

**Files:**
- Modify: `python/server.py:4132-4202` (extract `_stockpile_persist`; add the new endpoint after `save_stockpile`)
- Test: `python/tests/test_stockpile_scan.py`

**Interfaces:**
- Consumes: `stockpile.classify(meta, name)` (existing), `_stockpile_remote_cfg`, `_stockpile_totals`, `_github_contents_get/put` (existing).
- Produces: `_stockpile_persist(items: list[dict], note: str) -> (store: dict, commit: dict|None, rc: dict|None)` — reused by both `save_stockpile` (paste path, unchanged behavior) and the new endpoint. `POST /api/stockpile/import-hangars` (body `{items: [{type_id, name, quantity, group_id, category_id}], note}`) → same response shape as `POST /api/stockpile` minus `unresolved`.

- [ ] **Step 1: Write the failing tests**

Create `python/tests/test_stockpile_scan.py`:

```python
"""Tests for the stockpile persist helper and the ESI hangar-scan import
endpoint (POST /api/stockpile/import-hangars)."""
import os
import sys
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient
    import server
    return TestClient(server.app)


@pytest.fixture()
def local_store(tmp_path):
    import stockpile
    p = tmp_path / 'stockpile.json'
    with patch.object(stockpile, 'STORE_PATH', str(p)):
        yield stockpile


class TestSaveStockpileRegression:
    """Guards that factoring out _stockpile_persist didn't change the
    existing paste-save endpoint's behavior."""

    def test_paste_still_saves_locally_when_no_repo_configured(self, client, local_store):
        cfg = {'stockpile_allow_push': True, 'market_history_repo_url': ''}
        with patch('server.load_config', return_value=cfg), \
             patch('server.resolve_type_ids', return_value={'tritanium': 34}), \
             patch('server.enrich_types', return_value={34: {'group_id': 18, 'category_id': 4}}):
            resp = client.post('/api/stockpile', json={'text': 'Tritanium\t500'})
        data = resp.json()
        assert data['items'][0] == {'name': 'Tritanium', 'type_id': 34, 'qty': 500, 'category': 'minerals'}
        assert data['storage'] == 'local'
        assert local_store.load_store_local()['items'] == data['items']

    def test_paste_403_when_push_not_allowed(self, client):
        with patch('server.load_config', return_value={'stockpile_allow_push': False}):
            resp = client.post('/api/stockpile', json={'text': 'Tritanium\t500'})
        assert resp.status_code == 403


class TestImportHangars:
    def test_403_when_push_not_allowed(self, client):
        with patch('server.load_config', return_value={'stockpile_allow_push': False}):
            resp = client.post('/api/stockpile/import-hangars', json={'items': [
                {'type_id': 34, 'name': 'Tritanium', 'quantity': 500, 'group_id': 18, 'category_id': 4},
            ]})
        assert resp.status_code == 403

    def test_400_when_no_items(self, client):
        with patch('server.load_config', return_value={'stockpile_allow_push': True}):
            resp = client.post('/api/stockpile/import-hangars', json={'items': []})
        assert resp.status_code == 400

    def test_classifies_and_replaces_the_store(self, client, local_store):
        cfg = {'stockpile_allow_push': True, 'market_history_repo_url': ''}
        local_store.save_store_local({'updated_at': 'old', 'note': '', 'items': [
            {'name': 'Old Item', 'type_id': 1, 'qty': 1, 'category': 'other'},
        ]})
        items = [
            {'type_id': 34, 'name': 'Tritanium', 'quantity': 5000, 'group_id': 18, 'category_id': 4},
            {'type_id': 2999, 'name': 'Water', 'quantity': 10, 'group_id': 1042, 'category_id': 43},
            {'type_id': 645, 'name': 'Dominix', 'quantity': 1, 'group_id': 27, 'category_id': 6},
        ]
        with patch('server.load_config', return_value=cfg):
            resp = client.post('/api/stockpile/import-hangars',
                               json={'items': items, 'note': 'ESI hangar scan'})
        data = resp.json()
        by_name = {i['name']: i for i in data['items']}
        assert by_name['Tritanium']['category'] == 'minerals'
        assert by_name['Water']['category'] == 'pi'
        assert by_name['Dominix']['category'] == 'other'
        assert 'Old Item' not in by_name  # replaced, not merged
        assert data['note'] == 'ESI hangar scan'
        assert data['storage'] == 'local'

    def test_zero_quantity_items_are_dropped(self, client):
        cfg = {'stockpile_allow_push': True, 'market_history_repo_url': ''}
        items = [
            {'type_id': 34, 'name': 'Tritanium', 'quantity': 5000, 'group_id': 18, 'category_id': 4},
            {'type_id': 99, 'name': 'Empty Wrapper', 'quantity': 0, 'group_id': 0, 'category_id': 0},
        ]
        with patch('server.load_config', return_value=cfg):
            resp = client.post('/api/stockpile/import-hangars', json={'items': items})
        names = [i['name'] for i in resp.json()['items']]
        assert names == ['Tritanium']
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd python && python -m pytest tests/test_stockpile_scan.py -v`
Expected: `TestSaveStockpileRegression` tests PASS (existing behavior). `TestImportHangars` tests FAIL with 404 (route doesn't exist).

- [ ] **Step 3: Extract `_stockpile_persist` and add the new endpoint**

In `python/server.py`, replace the body of `save_stockpile` from the `store = {...}` line through the end of the function (everything from `store = {` down to the final `return {...}` block that currently ends `'unresolved': [...] }`) — i.e. this block:

```python
    store = {
        'updated_at': datetime.now(timezone.utc).isoformat(),
        'note': (req.note or '').strip(),
        'items': items,
    }
    rc = _stockpile_remote_cfg(cfg)
    commit = None
    if rc and rc.get('write_pat'):
        try:
            try:
                _text, sha = _github_contents_get(rc['owner'], rc['repo'], rc['branch'],
                                                  rc['path'], rc['read_pat'], ua)
            except FileNotFoundError:
                sha = None  # first write creates the file
            commit = _github_contents_put(rc['owner'], rc['repo'], rc['branch'], rc['path'],
                                          json.dumps(store, indent=2), sha, rc['write_pat'],
                                          ua, 'stockpile: update inventory')
            cfg['stockpile_last_synced'] = store['updated_at']
            cfg['stockpile_last_status'] = f'pushed {len(items)} item(s)'
            save_config(cfg)
        except Exception as e:
            cfg['stockpile_last_status'] = f'push failed: {e}'
            save_config(cfg)
            stockpile.save_store_local(store)
            raise HTTPException(502, f'GitHub push failed: {e}')
    else:
        cfg['stockpile_last_synced'] = store['updated_at']
        cfg['stockpile_last_status'] = f'saved locally ({len(items)} item(s))'
        save_config(cfg)
    stockpile.save_store_local(store)
    return {
        **store,
        'storage': 'github' if (rc and rc.get('write_pat')) else 'local',
        'totals': _stockpile_totals(store),
        'commit_sha': (commit or {}).get('commit_sha'),
        'commit_html_url': (commit or {}).get('commit_html_url'),
        'unresolved': [p['name'] for p in parsed if not name_to_id.get(p['name'].lower())],
    }
```

with:

```python
    store, commit, rc = _stockpile_persist(items, req.note)
    return {
        **store,
        'storage': 'github' if (rc and rc.get('write_pat')) else 'local',
        'totals': _stockpile_totals(store),
        'commit_sha': (commit or {}).get('commit_sha'),
        'commit_html_url': (commit or {}).get('commit_html_url'),
        'unresolved': [p['name'] for p in parsed if not name_to_id.get(p['name'].lower())],
    }
```

Then add the extracted helper and the new endpoint right after `save_stockpile` (before `@app.post('/api/stockpile/janice')`):

```python
def _stockpile_persist(items, note):
    """Build, save-locally, and (if a write PAT is configured) push a
    stockpile store from already-resolved `items`. Returns
    (store, commit, rc) — commit is None when saved locally only. Raises
    HTTPException(502) if a configured push fails (matches the paste path's
    existing behavior)."""
    cfg = load_config()
    store = {
        'updated_at': datetime.now(timezone.utc).isoformat(),
        'note': (note or '').strip(),
        'items': items,
    }
    rc = _stockpile_remote_cfg(cfg)
    commit = None
    ua = get_user_agent()
    if rc and rc.get('write_pat'):
        try:
            try:
                _text, sha = _github_contents_get(rc['owner'], rc['repo'], rc['branch'],
                                                  rc['path'], rc['read_pat'], ua)
            except FileNotFoundError:
                sha = None  # first write creates the file
            commit = _github_contents_put(rc['owner'], rc['repo'], rc['branch'], rc['path'],
                                          json.dumps(store, indent=2), sha, rc['write_pat'],
                                          ua, 'stockpile: update inventory')
            cfg['stockpile_last_synced'] = store['updated_at']
            cfg['stockpile_last_status'] = f'pushed {len(items)} item(s)'
            save_config(cfg)
        except Exception as e:
            cfg['stockpile_last_status'] = f'push failed: {e}'
            save_config(cfg)
            stockpile.save_store_local(store)
            raise HTTPException(502, f'GitHub push failed: {e}')
    else:
        cfg['stockpile_last_synced'] = store['updated_at']
        cfg['stockpile_last_status'] = f'saved locally ({len(items)} item(s))'
        save_config(cfg)
    stockpile.save_store_local(store)
    return store, commit, rc


class StockpileHangarImport(BaseModel):
    items: list[dict] = []
    note: str = ''


@app.post('/api/stockpile/import-hangars')
def import_stockpile_from_hangars(req: StockpileHangarImport):
    """Replace the stockpile store from an ESI corp-hangar scan. `items` are
    already-resolved hangar contents from GET /api/corp/assets
    (type_id/name/quantity/group_id/category_id) — no name resolution needed,
    unlike the paste path. Always replaces, mirroring the paste-save's
    replace-only semantics."""
    cfg = load_config()
    if not cfg.get('stockpile_allow_push'):
        raise HTTPException(403, 'Stock editing is disabled (enable "Allow stock edits" in Config).')
    items = []
    for it in (req.items or []):
        qty = int(it.get('quantity') or 0)
        name = str(it.get('name') or '').strip()
        if qty <= 0 or not name:
            continue
        meta = {'group_id': int(it.get('group_id') or 0), 'category_id': int(it.get('category_id') or 0)}
        items.append({
            'name': name,
            'type_id': int(it.get('type_id') or 0),
            'qty': qty,
            'category': stockpile.classify(meta, name),
        })
    if not items:
        raise HTTPException(400, 'No valid items to import.')
    store, commit, rc = _stockpile_persist(items, req.note)
    return {
        **store,
        'storage': 'github' if (rc and rc.get('write_pat')) else 'local',
        'totals': _stockpile_totals(store),
        'commit_sha': (commit or {}).get('commit_sha'),
        'commit_html_url': (commit or {}).get('commit_html_url'),
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd python && python -m pytest tests/test_stockpile_scan.py -v`
Expected: PASS (6 tests)

- [ ] **Step 5: Run the full pytest suite to confirm no regressions**

Run: `cd python && python -m pytest tests/ -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add python/server.py python/tests/test_stockpile_scan.py
git commit -m "feat(hangars): add POST /api/stockpile/import-hangars"
```

---

### Task 6: Renderer — `filterItemsByHangar` pure helper

**Files:**
- Modify: `renderer/acquisitions-utils.js` (add before the final `module.exports` block)
- Test: `tests/acquisitions-utils.test.js` (append)

**Interfaces:**
- Produces: `canonicalHangarFlag(flag: string) -> string` (collapses `'HangarAll'` to `'CorpSAG1'`, passes everything else through), `filterItemsByHangar(hangars: Array<{flag, items}>, selectedFlags: string[]) -> Array<item>` (flattens the items of every hangar whose canonical flag is in `selectedFlags`).

- [ ] **Step 1: Write the failing tests**

Append to `tests/acquisitions-utils.test.js` (after the final existing test, which ends `expect(item201.qty).toBe(0);\n  });`):

```javascript

// ── canonicalHangarFlag / filterItemsByHangar ────────────────────────────────

const { canonicalHangarFlag, filterItemsByHangar } = require('../renderer/acquisitions-utils');

describe('canonicalHangarFlag', () => {
  test('collapses HangarAll into CorpSAG1', () => {
    expect(canonicalHangarFlag('HangarAll')).toBe('CorpSAG1');
  });

  test('passes other flags through unchanged', () => {
    expect(canonicalHangarFlag('CorpSAG3')).toBe('CorpSAG3');
  });
});

describe('filterItemsByHangar', () => {
  const hangars = [
    { flag: 'CorpSAG1', items: [{ type_id: 34, name: 'Tritanium', quantity: 500 }] },
    { flag: 'CorpSAG2', items: [{ type_id: 35, name: 'Pyerite', quantity: 100 }] },
    { flag: 'CorpSAG3', items: [{ type_id: 36, name: 'Mexallon', quantity: 10 }] },
  ];

  test('returns only items from selected hangars', () => {
    const items = filterItemsByHangar(hangars, ['CorpSAG1', 'CorpSAG3']);
    expect(items.map((i) => i.name).sort()).toEqual(['Mexallon', 'Tritanium']);
  });

  test('empty selection returns no items', () => {
    expect(filterItemsByHangar(hangars, [])).toEqual([]);
  });

  test('matches HangarAll-flagged hangars against a CorpSAG1 selection', () => {
    const legacyHangars = [{ flag: 'HangarAll', items: [{ type_id: 34, name: 'Tritanium', quantity: 500 }] }];
    const items = filterItemsByHangar(legacyHangars, ['CorpSAG1']);
    expect(items).toHaveLength(1);
  });

  test('handles missing/undefined inputs', () => {
    expect(filterItemsByHangar(null, ['CorpSAG1'])).toEqual([]);
    expect(filterItemsByHangar(hangars, null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest tests/acquisitions-utils.test.js`
Expected: FAIL — `canonicalHangarFlag` and `filterItemsByHangar` are not exported yet

- [ ] **Step 3: Implement the functions**

In `renderer/acquisitions-utils.js`, add before the closing `if (typeof module !== 'undefined' && module.exports) {` block:

```javascript
// ---------------------------------------------------------------------------
// Hangar-division filtering — shared by the Acquisitions and Stockpile ESI
// scans. ESI's HangarAll (older/simple corp hangar setups) and CorpSAG1 (the
// modern flag) both mean "Division 1"; canonicalHangarFlag collapses them so
// a saved selection matches regardless of which flag a given corp reports.
// ---------------------------------------------------------------------------

function canonicalHangarFlag(flag) {
  return flag === 'HangarAll' ? 'CorpSAG1' : flag;
}

/** Flatten the items of every hangar whose flag is in `selectedFlags`. */
function filterItemsByHangar(hangars, selectedFlags) {
  const selected = new Set((selectedFlags || []).map(canonicalHangarFlag));
  return (hangars || [])
    .filter((h) => selected.has(canonicalHangarFlag(h.flag)))
    .flatMap((h) => h.items || []);
}
```

And update the `module.exports` block to include the two new names:

```javascript
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    mergeInventory, splitInventory, formatJaniceExport, ACQ_HULL_CATEGORY_ID,
    ACQ_MARKET_THRESHOLD, ACQ_MODES, buildPool, fitModuleUnits, evaluateBuild,
    planAcquisitions, buildTargets, computeShoppingGap,
    canonicalHangarFlag, filterItemsByHangar,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest tests/acquisitions-utils.test.js`
Expected: PASS (all tests in the file)

- [ ] **Step 5: Run the full Jest suite to confirm no regressions**

Run: `npx jest`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add renderer/acquisitions-utils.js tests/acquisitions-utils.test.js
git commit -m "feat(hangars): add canonicalHangarFlag/filterItemsByHangar helpers"
```

---

### Task 7: Shared `buildHangarPicker` renderer component

**Files:**
- Modify: `renderer/app.js` (add the function; a good spot is right after the `REASON_MESSAGES` const, before `acqLoadCorpInventory`, ~line 5589)
- Modify: `renderer/styles.css` (append new rules)

**Interfaces:**
- Consumes: `canonicalHangarFlag` (Task 6, global via script load order — `acquisitions-utils.js` loads before `app.js`), `escapeHtml` (existing app.js global).
- Produces: `buildHangarPicker(container: HTMLElement, hangars: Array<{flag, name, item_count}>, selectedFlags: string[]) -> () => string[]` — renders the checkbox grid into `container` and returns a `getSelectedFlags()` accessor that reads *live* checkbox state (not a snapshot).

- [ ] **Step 1: Implement `buildHangarPicker` in `renderer/app.js`**

Add immediately before `async function acqLoadCorpInventory(...)`:

```javascript
// Shared checkbox grid for choosing which corp hangar divisions to include in
// an ESI scan — used by both Acquisitions' "Load corp inventory" flow and the
// Stockpile "Scan corp hangars" flow (stockpile.js loads after app.js and
// reuses this global, same convention as $/API/escapeHtml). Renders into
// `container`; the returned getSelectedFlags() reads live checkbox state on
// every call, so callers don't need to re-render to see a toggle.
function buildHangarPicker(container, hangars, selectedFlags) {
  const hasSaved = (selectedFlags || []).length > 0;
  const selectedSet = new Set(
    hasSaved
      ? selectedFlags.map(canonicalHangarFlag)
      : (hangars || []).map((h) => canonicalHangarFlag(h.flag))
  );
  const rows = (hangars || []).map((h) => {
    const checked = selectedSet.has(canonicalHangarFlag(h.flag));
    return `<label class="hangar-picker-row${checked ? '' : ' unchecked'}" data-flag="${escapeHtml(h.flag)}">
      <input type="checkbox" ${checked ? 'checked' : ''}>
      <span class="hangar-picker-name">${escapeHtml(h.name)}</span>
      <span class="hangar-picker-count">${h.item_count.toLocaleString()}</span>
    </label>`;
  }).join('');

  container.innerHTML = `
    <div class="hangar-picker-toolbar">
      <a href="#" data-action="all">Select all</a> &nbsp;|&nbsp; <a href="#" data-action="none">Select none</a>
    </div>
    <div class="hangar-picker-grid">${rows}</div>`;

  const grid = container.querySelector('.hangar-picker-grid');
  grid.querySelectorAll('input[type=checkbox]').forEach((cb) => {
    cb.addEventListener('change', () => {
      cb.closest('.hangar-picker-row').classList.toggle('unchecked', !cb.checked);
    });
  });
  container.querySelector('[data-action="all"]').addEventListener('click', (e) => {
    e.preventDefault();
    grid.querySelectorAll('input[type=checkbox]').forEach((cb) => {
      cb.checked = true;
      cb.closest('.hangar-picker-row').classList.remove('unchecked');
    });
  });
  container.querySelector('[data-action="none"]').addEventListener('click', (e) => {
    e.preventDefault();
    grid.querySelectorAll('input[type=checkbox]').forEach((cb) => {
      cb.checked = false;
      cb.closest('.hangar-picker-row').classList.add('unchecked');
    });
  });

  return () => Array.from(grid.querySelectorAll('input[type=checkbox]:checked'))
    .map((cb) => cb.closest('.hangar-picker-row').dataset.flag);
}
```

- [ ] **Step 2: Verify the file still parses**

Run: `node --check renderer/app.js`
Expected: no output (exit code 0)

- [ ] **Step 3: Add CSS for the picker**

In `renderer/styles.css`, append after the `.inline-check` rules (~line 950):

```css
/* Shared corp-hangar-division picker (Acquisitions "Load corp inventory" +
   Stockpile "Scan corp hangars") */
.hangar-picker-toolbar { font-size: 0.78em; margin-bottom: 0.5em; }
.hangar-picker-toolbar a { color: #8fb4ff; cursor: pointer; text-decoration: none; }
.hangar-picker-toolbar a:hover { text-decoration: underline; }
.hangar-picker-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 0.4em; margin-bottom: 0.6em;
}
.hangar-picker-row {
  display: flex; align-items: center; gap: 0.5em; cursor: pointer;
  background: #182230; border: 1px solid #263041; border-radius: 6px;
  padding: 0.45em 0.6em; font-size: 0.85em; color: #cfd8e3;
}
.hangar-picker-row input { width: 15px; height: 15px; accent-color: #2b5fd9; }
.hangar-picker-name { flex: 1; }
.hangar-picker-count { color: #7d8ea3; font-size: 0.85em; }
.hangar-picker-row.unchecked { opacity: 0.55; }
```

- [ ] **Step 4: Verify the app still starts**

Run: `npm start`, open the Config tab (no crash means the added JS/CSS parses and loads cleanly in the renderer), then close the app.

- [ ] **Step 5: Commit**

```bash
git add renderer/app.js renderer/styles.css
git commit -m "feat(hangars): add shared buildHangarPicker component"
```

---

### Task 8: Wire the picker into Acquisitions' "Load corp inventory"

**Files:**
- Modify: `renderer/app.js:5590-5661` (`acqLoadCorpInventory`)

**Interfaces:**
- Consumes: `buildHangarPicker` (Task 7), `filterItemsByHangar` (Task 6), `GET`/`POST /api/hangar-selection` (Task 4).
- Produces: no new exports — this is the integration point.

- [ ] **Step 1: Replace `acqLoadCorpInventory`**

In `renderer/app.js`, replace the entire existing `acqLoadCorpInventory` function (from `async function acqLoadCorpInventory(root, statusEl, hullsEl, itemsEl) {` through its closing `}` before `function renderAcquisitionsTab()`) with:

```javascript
async function acqLoadCorpInventory(root, statusEl, hullsEl, itemsEl) {
  const btn = root.querySelector('#acq-corp-load');
  const breakdownEl = root.querySelector('#acq-corp-breakdown');
  btn.disabled = true;
  statusEl.textContent = 'Loading corp inventory…';
  breakdownEl.hidden = true;
  breakdownEl.innerHTML = '';

  let data, selection;
  try {
    const [assetsRes, selectionRes] = await Promise.all([
      fetch(`${API}/api/corp/assets`),
      fetch(`${API}/api/hangar-selection`),
    ]);
    data = await assetsRes.json();
    selection = await selectionRes.json().catch(() => ({ selected_flags: [] }));
  } catch (e) {
    statusEl.textContent = 'Failed to reach sidecar.';
    btn.disabled = false;
    return;
  }

  if (!data.ok) {
    statusEl.textContent = REASON_MESSAGES[data.reason] || `Error: ${data.reason}`;
    btn.disabled = false;
    return;
  }

  statusEl.textContent = '';
  const hangars = data.hangars || [];
  const totalItems = hangars.reduce((s, h) => s + h.item_count, 0);

  breakdownEl.innerHTML = `
    <div style="color:#8899aa;margin-bottom:0.5rem">${totalItems.toLocaleString()} items across ${hangars.length} hangar division${hangars.length !== 1 ? 's' : ''} at the home structure</div>
    <div id="acq-corp-picker"></div>
    <div style="display:flex;gap:0.5rem;margin-top:0.6rem">
      <button id="acq-corp-add" class="btn">Add to inventory</button>
      <button id="acq-corp-replace" class="btn">Replace inventory</button>
      <button id="acq-corp-cancel" class="link-btn" style="color:#8899aa">Cancel</button>
    </div>`;
  breakdownEl.hidden = false;

  const getSelectedFlags = buildHangarPicker(
    breakdownEl.querySelector('#acq-corp-picker'), hangars, selection.selected_flags || []
  );

  const applyCorpItems = async (mode) => {
    const flags = getSelectedFlags();
    const allItems = filterItemsByHangar(hangars, flags);
    const hulls = allItems.filter((i) => i.category_id === 6);
    const items = allItems.filter((i) => i.category_id !== 6);
    if (mode === 'replace') {
      acquisitionsHulls = hulls;
      acquisitionsItems = items;
    } else {
      // Merge: sum quantities for existing type_ids
      for (const incoming of hulls) {
        const existing = acquisitionsHulls.find((h) => h.type_id === incoming.type_id);
        if (existing) existing.quantity += incoming.quantity;
        else acquisitionsHulls.push({ ...incoming });
      }
      for (const incoming of items) {
        const existing = acquisitionsItems.find((i) => i.type_id === incoming.type_id);
        if (existing) existing.quantity += incoming.quantity;
        else acquisitionsItems.push({ ...incoming });
      }
    }
    await acquisitionsSave();
    renderAcquisitionsResults(hullsEl, itemsEl);
    statusEl.textContent = mode === 'replace' ? 'Replaced inventory with corp inventory.' : 'Added corp inventory to existing inventory.';
    setTimeout(() => { statusEl.textContent = ''; }, 3000);
    breakdownEl.hidden = true;
    fetch(`${API}/api/hangar-selection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flags }),
    }).catch(() => {});
  };

  breakdownEl.querySelector('#acq-corp-add').addEventListener('click', () => applyCorpItems('add'));
  breakdownEl.querySelector('#acq-corp-replace').addEventListener('click', () => applyCorpItems('replace'));
  breakdownEl.querySelector('#acq-corp-cancel').addEventListener('click', () => { breakdownEl.hidden = true; });
  btn.disabled = false;
}
```

- [ ] **Step 2: Verify the file still parses**

Run: `node --check renderer/app.js`
Expected: no output (exit code 0)

- [ ] **Step 3: Run the full Jest suite to confirm no regressions**

Run: `npx jest`
Expected: PASS

- [ ] **Step 4: Manual check**

Run `npm start`, open Acquisitions, click "Corp inventory (needs director access)". Without a Director-authed slot this will show the `missing_scope` message (from `REASON_MESSAGES`) — confirm that message still renders correctly (this exercises the new fetch-two-things-in-parallel path even without valid ESI creds, since `/api/hangar-selection` still returns 200 with an empty local selection). Close the app.

- [ ] **Step 5: Commit**

```bash
git add renderer/app.js
git commit -m "feat(hangars): wire hangar picker into Acquisitions corp-inventory load"
```

---

### Task 9: Stockpile "Scan corp hangars" flow

**Files:**
- Modify: `renderer/index.html:1255-1265` (`#stockpile-editor` fieldset)
- Modify: `renderer/stockpile.js`

**Interfaces:**
- Consumes: `buildHangarPicker` (Task 7), `filterItemsByHangar` (Task 6), `GET`/`POST /api/hangar-selection` (Task 4), `POST /api/stockpile/import-hangars` (Task 5).
- Produces: no new exports — this is the integration point, gated the same way as the existing paste/save panel (`stockpile-editor` visibility already driven by `updateStockpileEditorVisibility()` in `app.js`).

- [ ] **Step 1: Add the button + breakdown container to `index.html`**

In `renderer/index.html`, inside the `#stockpile-editor` fieldset, replace:

```html
        <p id="stockpile-unresolved" class="muted small" hidden></p>
      </fieldset>
```

with:

```html
        <p id="stockpile-unresolved" class="muted small" hidden></p>

        <div class="stockpile-hangar-scan">
          <p class="muted small">Or scan corp hangars directly via ESI (needs a Director-role character authenticated on the Auth tab) instead of pasting.</p>
          <button id="stockpile-corp-load" type="button" class="secondary" title="Load corp hangar contents via ESI (requires Director re-auth with corp assets scope)">Scan corp hangars</button>
          <span id="stockpile-corp-status" class="muted"></span>
          <div id="stockpile-corp-breakdown" hidden></div>
        </div>
      </fieldset>
```

- [ ] **Step 2: Add `.stockpile-hangar-scan` spacing to `renderer/styles.css`**

Append after the `.hangar-picker-row.unchecked` rule from Task 7:

```css
.stockpile-hangar-scan { margin-top: 1.2em; padding-top: 1em; border-top: 1px solid #3a3a3a; }
.stockpile-hangar-scan > .muted { margin-bottom: 0.5em; }
```

- [ ] **Step 3: Verify HTML/CSS load without errors**

Run: `npm start`, open Config, unlock the Stockpile tab with the password already configured in the codebase, check "Allow stock edits", open Stockpile, confirm the new "Scan corp hangars" button + status span + hidden breakdown div render under the paste panel without layout breakage. Close the app.

- [ ] **Step 4: Implement `scanCorpHangars` in `renderer/stockpile.js`**

In `renderer/stockpile.js`, inside the module IIFE, add this function before the `// ---- static wiring (elements exist at load) ----` comment:

```javascript
  const HANGAR_REASON_MESSAGES = {
    missing_scope: 'Re-auth a Director character on the Auth tab — needs the esi-assets.read_corporation_assets.v1 scope.',
    no_home_structure: 'Set your home structure ID in Config first.',
    no_credentials: 'Auth credentials missing — check Config.',
    fetch_failed: 'ESI fetch failed. Check the sidecar log.',
  };

  async function scanCorpHangars() {
    const btn = $('#stockpile-corp-load');
    const statusEl = $('#stockpile-corp-status');
    const breakdownEl = $('#stockpile-corp-breakdown');
    if (!btn || !statusEl || !breakdownEl) return;
    btn.disabled = true;
    statusEl.textContent = 'Loading corp inventory…';
    breakdownEl.hidden = true;
    breakdownEl.innerHTML = '';

    let data, selection;
    try {
      const [assetsRes, selectionRes] = await Promise.all([
        fetch(`${API}/api/corp/assets`),
        fetch(`${API}/api/hangar-selection`),
      ]);
      data = await assetsRes.json();
      selection = await selectionRes.json().catch(() => ({ selected_flags: [] }));
    } catch (e) {
      statusEl.textContent = 'Failed to reach sidecar.';
      btn.disabled = false;
      return;
    }

    if (!data.ok) {
      statusEl.textContent = HANGAR_REASON_MESSAGES[data.reason] || `Error: ${data.reason}`;
      btn.disabled = false;
      return;
    }

    statusEl.textContent = '';
    const hangars = data.hangars || [];
    const totalItems = hangars.reduce((s, h) => s + h.item_count, 0);

    breakdownEl.innerHTML = `
      <div class="muted" style="margin-bottom:0.5rem">${totalItems.toLocaleString()} items across ${hangars.length} hangar division${hangars.length !== 1 ? 's' : ''} at the home structure</div>
      <div id="stockpile-corp-picker"></div>
      <div class="actions" style="margin-top:0.6rem">
        <button id="stockpile-corp-replace" type="button">Replace stockpile</button>
        <button id="stockpile-corp-cancel" type="button" class="link-btn">Cancel</button>
      </div>`;
    breakdownEl.hidden = false;

    const getSelectedFlags = buildHangarPicker(
      $('#stockpile-corp-picker'), hangars, selection.selected_flags || []
    );

    $('#stockpile-corp-replace').addEventListener('click', async () => {
      const flags = getSelectedFlags();
      const items = filterItemsByHangar(hangars, flags).map((i) => ({
        type_id: i.type_id, name: i.name, quantity: i.quantity,
        group_id: i.group_id, category_id: i.category_id,
      }));
      if (!items.length) { statusEl.textContent = 'No items in the selected hangars.'; return; }
      const replaceBtn = $('#stockpile-corp-replace');
      replaceBtn.disabled = true;
      statusEl.textContent = 'Importing…';
      try {
        const res = await fetch(`${API}/api/stockpile/import-hangars`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items, note: 'ESI hangar scan' }),
        });
        const result = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(result.detail || `HTTP ${res.status}`);
        sp.data = result;
        sp.loaded = true;
        render();
        statusEl.textContent = `Replaced stockpile with ${items.length.toLocaleString()} item(s) from corp hangars.`;
      } catch (e) {
        statusEl.textContent = `Import failed: ${e.message || e}`;
      } finally {
        replaceBtn.disabled = false;
        breakdownEl.hidden = true;
      }
      fetch(`${API}/api/hangar-selection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flags }),
      }).catch(() => {});
    });

    $('#stockpile-corp-cancel').addEventListener('click', () => { breakdownEl.hidden = true; });
    btn.disabled = false;
  }
```

Then add the static wiring line in the `// ---- static wiring (elements exist at load) ----` block, next to the other `$(...)?.addEventListener(...)` lines:

```javascript
  $('#stockpile-corp-load')?.addEventListener('click', scanCorpHangars);
```

- [ ] **Step 5: Verify the file still parses**

Run: `node --check renderer/stockpile.js`
Expected: no output (exit code 0)

- [ ] **Step 6: Run the full Jest suite to confirm no regressions**

Run: `npx jest`
Expected: PASS

- [ ] **Step 7: Manual check**

Run `npm start`, unlock + enable Stockpile edits as in Step 3, click "Scan corp hangars". Without a Director-authed slot, confirm the `missing_scope` message renders in `#stockpile-corp-status`. Close the app.

- [ ] **Step 8: Run the full pytest suite one more time (final regression check)**

Run: `cd python && python -m pytest tests/ -v`
Expected: PASS (all tests across every file touched by this plan)

- [ ] **Step 9: Commit**

```bash
git add renderer/index.html renderer/stockpile.js renderer/styles.css
git commit -m "feat(hangars): add Stockpile 'Scan corp hangars' ESI import"
```
