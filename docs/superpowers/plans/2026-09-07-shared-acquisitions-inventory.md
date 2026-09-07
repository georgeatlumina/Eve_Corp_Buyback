# Shared Acquisitions Inventory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store the acquisitions inventory in the alliance quota GitHub repo so all users auto-pull the latest inventory on startup, with an admin-gated push button to publish updates.

**Architecture:** Two new backend endpoints (`POST /api/acquisitions/sync` and `POST /api/acquisitions/push`) in `python/server.py` mirror the existing quota sync/push pattern, using the same `_github_contents_get`/`_github_contents_put` helpers and the same config fields (`alliance_quota_url`, `alliance_quota_pat_read`, `alliance_quota_pat_write`, `alliance_quota_allow_push`). The frontend extends `acquisitionsLoad()` to attempt a remote pull before falling back to the local file, and adds a "Push inventory" button gated by `alliance_quota_allow_push`.

**Tech Stack:** Python/FastAPI (server.py), Vanilla JS (renderer/app.js), GitHub Contents API, pytest + FastAPI TestClient

---

## Files

| File | Change |
|---|---|
| `python/server.py` | Add `POST /api/acquisitions/sync` and `POST /api/acquisitions/push` endpoints after existing acquisitions endpoints (~line 6604) |
| `python/tests/test_acquisitions_sync_push.py` | New test file for both endpoints |
| `renderer/app.js` | Extend `acquisitionsLoad()` (~line 4820); add `acqAllowPush` module flag; add Push Inventory button in `renderAcquisitionsTab()` (~line 5825); add push click handler |

---

## Task 1: Backend — `POST /api/acquisitions/sync`

**Files:**
- Modify: `python/server.py` (after line 6604, after the existing `post_acquisitions` endpoint)
- Create: `python/tests/test_acquisitions_sync_push.py`

- [ ] **Step 1: Write the failing test**

Create `python/tests/test_acquisitions_sync_push.py`:

```python
"""Tests for POST /api/acquisitions/sync and POST /api/acquisitions/push."""
import json
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
def acq_store(tmp_path):
    import acquisitions
    p = tmp_path / 'acquisitions_inventory.json'
    with patch.object(acquisitions, 'ACQUISITIONS_PATH', str(p)):
        yield acquisitions


SAMPLE_HULLS = [{'type_id': 1, 'name': 'Tornado', 'quantity': 2}]
SAMPLE_ITEMS = [{'type_id': 2, 'name': 'Damage Control II', 'quantity': 5}]
SAMPLE_REMOTE = json.dumps({
    'hulls': SAMPLE_HULLS,
    'items': SAMPLE_ITEMS,
    'updated_at': '2026-09-07T10:00:00+00:00',
})


class TestAcquisitionsSync:
    def test_no_quota_url_returns_error(self, client, acq_store):
        with patch('server.load_config', return_value={'alliance_quota_url': ''}):
            resp = client.post('/api/acquisitions/sync')
        assert resp.status_code == 200
        assert 'error' in resp.json()

    def test_syncs_from_github_and_writes_local(self, client, acq_store):
        cfg = {
            'alliance_quota_url': 'https://github.com/acme/alliance/blob/main/quotas.json',
            'alliance_quota_pat_read': 'read-pat',
        }
        with patch('server.load_config', return_value=cfg), \
             patch('server._github_contents_get', return_value=(SAMPLE_REMOTE, 'sha1')):
            resp = client.post('/api/acquisitions/sync')
        data = resp.json()
        assert data['hulls'] == SAMPLE_HULLS
        assert data['items'] == SAMPLE_ITEMS
        assert data['updated_at'] == '2026-09-07T10:00:00+00:00'

    def test_github_failure_returns_error_json(self, client, acq_store):
        cfg = {
            'alliance_quota_url': 'https://github.com/acme/alliance/blob/main/quotas.json',
            'alliance_quota_pat_read': 'read-pat',
        }
        with patch('server.load_config', return_value=cfg), \
             patch('server._github_contents_get', side_effect=Exception('network error')):
            resp = client.post('/api/acquisitions/sync')
        assert resp.status_code == 200
        assert 'error' in resp.json()

    def test_file_not_found_returns_error_json(self, client, acq_store):
        cfg = {
            'alliance_quota_url': 'https://github.com/acme/alliance/blob/main/quotas.json',
            'alliance_quota_pat_read': 'read-pat',
        }
        with patch('server.load_config', return_value=cfg), \
             patch('server._github_contents_get', side_effect=FileNotFoundError('not found')):
            resp = client.post('/api/acquisitions/sync')
        assert resp.status_code == 200
        assert 'error' in resp.json()
```

- [ ] **Step 2: Run test to verify it fails**

```bash
python3 -m pytest python/tests/test_acquisitions_sync_push.py::TestAcquisitionsSync -v 2>&1 | tail -15
```

Expected: 4 errors/failures — endpoint does not exist yet.

- [ ] **Step 3: Add `POST /api/acquisitions/sync` to `python/server.py`**

Insert after the `post_acquisitions` endpoint (after line 6604):

```python
_ACQ_INVENTORY_REPO_PATH = 'acquisitions-inventory.json'


@app.post('/api/acquisitions/sync')
def sync_acquisitions_inventory():
    """Pull acquisitions-inventory.json from the alliance quota repo and
    write it to the local cache. Returns the inventory on success, or
    {"error": "..."} on any failure — caller falls back to local file."""
    cfg = load_config()
    url = (cfg.get('alliance_quota_url') or '').strip()
    if not url:
        return {'error': 'alliance_quota_url is not configured'}
    blob = _parse_github_blob_url(url)
    if not blob:
        return {'error': f'Could not parse GitHub URL: {url!r}'}
    owner, repo, branch, _path = blob
    pat = (cfg.get('alliance_quota_pat_read') or cfg.get('alliance_quota_pat_write') or '').strip() or None
    ua = get_user_agent()
    try:
        text, _sha = _github_contents_get(owner, repo, branch, _ACQ_INVENTORY_REPO_PATH, pat, ua)
    except FileNotFoundError:
        return {'error': 'acquisitions-inventory.json not found in quota repo — push from the admin machine first'}
    except Exception as e:
        return {'error': str(e)}
    try:
        data = json.loads(text)
    except ValueError:
        return {'error': 'acquisitions-inventory.json in repo is not valid JSON'}
    hulls = data.get('hulls') or []
    items = data.get('items') or []
    updated_at = data.get('updated_at')
    save_acquisitions(hulls, items)
    return {'hulls': hulls, 'items': items, 'updated_at': updated_at}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python3 -m pytest python/tests/test_acquisitions_sync_push.py::TestAcquisitionsSync -v 2>&1 | tail -10
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add python/server.py python/tests/test_acquisitions_sync_push.py
git commit -m "feat(acq): POST /api/acquisitions/sync — pull inventory from quota repo"
```

---

## Task 2: Backend — `POST /api/acquisitions/push`

**Files:**
- Modify: `python/server.py` (after the sync endpoint added in Task 1)
- Modify: `python/tests/test_acquisitions_sync_push.py`

- [ ] **Step 1: Write the failing tests**

Append to `python/tests/test_acquisitions_sync_push.py`:

```python
class TestAcquisitionsPush:
    def test_403_when_push_not_allowed(self, client, acq_store):
        acq_store.save_acquisitions(SAMPLE_HULLS, SAMPLE_ITEMS)
        with patch('server.load_config', return_value={'alliance_quota_allow_push': False,
                                                        'alliance_quota_url': 'https://github.com/acme/alliance/blob/main/quotas.json',
                                                        'alliance_quota_pat_write': 'write-pat'}):
            resp = client.post('/api/acquisitions/push')
        assert resp.status_code == 403

    def test_400_when_no_url(self, client, acq_store):
        acq_store.save_acquisitions(SAMPLE_HULLS, SAMPLE_ITEMS)
        with patch('server.load_config', return_value={'alliance_quota_allow_push': True,
                                                        'alliance_quota_url': '',
                                                        'alliance_quota_pat_write': 'write-pat'}):
            resp = client.post('/api/acquisitions/push')
        assert resp.status_code == 400

    def test_400_when_no_write_pat(self, client, acq_store):
        acq_store.save_acquisitions(SAMPLE_HULLS, SAMPLE_ITEMS)
        with patch('server.load_config', return_value={'alliance_quota_allow_push': True,
                                                        'alliance_quota_url': 'https://github.com/acme/alliance/blob/main/quotas.json',
                                                        'alliance_quota_pat_write': ''}):
            resp = client.post('/api/acquisitions/push')
        assert resp.status_code == 400

    def test_pushes_to_github(self, client, acq_store):
        acq_store.save_acquisitions(SAMPLE_HULLS, SAMPLE_ITEMS)
        cfg = {
            'alliance_quota_allow_push': True,
            'alliance_quota_url': 'https://github.com/acme/alliance/blob/main/quotas.json',
            'alliance_quota_pat_write': 'write-pat',
        }
        put_result = {'commit_sha': 'abc1234', 'commit_html_url': 'https://github.com/acme/alliance/commit/abc1234'}
        with patch('server.load_config', return_value=cfg), \
             patch('server._github_contents_get', side_effect=FileNotFoundError()), \
             patch('server._github_contents_put', return_value=put_result) as mock_put:
            resp = client.post('/api/acquisitions/push')
        assert resp.status_code == 200
        data = resp.json()
        assert data['pushed_hulls'] == len(SAMPLE_HULLS)
        assert data['pushed_items'] == len(SAMPLE_ITEMS)
        assert data['commit_sha'] == 'abc1234'
        # Verify the file written to GitHub contains the inventory
        call_args = mock_put.call_args
        written = json.loads(call_args.args[4])  # positional: owner,repo,branch,path,text,...
        assert written['hulls'] == SAMPLE_HULLS
        assert written['items'] == SAMPLE_ITEMS
        assert 'updated_at' in written
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
python3 -m pytest python/tests/test_acquisitions_sync_push.py::TestAcquisitionsPush -v 2>&1 | tail -10
```

Expected: 4 failures — endpoint does not exist yet.

- [ ] **Step 3: Add `POST /api/acquisitions/push` to `python/server.py`**

Insert immediately after the `sync_acquisitions_inventory` endpoint added in Task 1:

```python
@app.post('/api/acquisitions/push')
def push_acquisitions_inventory():
    """Push the local acquisitions inventory to acquisitions-inventory.json
    in the alliance quota repo. Gated by alliance_quota_allow_push."""
    cfg = load_config()
    if not cfg.get('alliance_quota_allow_push'):
        raise HTTPException(403, 'Push is disabled on this machine. Tick "Allow push from this machine" in Config to enable.')
    url = (cfg.get('alliance_quota_url') or '').strip()
    if not url:
        raise HTTPException(400, 'alliance_quota_url is not set')
    blob = _parse_github_blob_url(url)
    if not blob:
        raise HTTPException(400, f'Could not parse GitHub URL: {url!r}')
    owner, repo, branch, _path = blob
    write_pat = (cfg.get('alliance_quota_pat_write') or '').strip()
    if not write_pat:
        raise HTTPException(400, 'alliance_quota_pat_write is not set — provide a PAT with Contents: read+write permission on this repo.')
    inventory = load_acquisitions()
    hulls = inventory.get('hulls') or []
    items = inventory.get('items') or []
    text = json.dumps({'hulls': hulls, 'items': items,
                       'updated_at': datetime.now(timezone.utc).isoformat()}, indent=2) + '\n'
    ua = get_user_agent()
    sha = None
    try:
        _existing, sha = _github_contents_get(owner, repo, branch, _ACQ_INVENTORY_REPO_PATH, write_pat, ua)
    except FileNotFoundError:
        sha = None
    except PermissionError as e:
        raise HTTPException(403, f'Push failed at read step: {e}')
    except requests.exceptions.RequestException as e:
        raise HTTPException(502, f'Push failed at read step: {e}')
    message = f'Update acquisitions inventory — {len(hulls)} hull(s), {len(items)} item(s)'
    try:
        result = _github_contents_put(owner, repo, branch, _ACQ_INVENTORY_REPO_PATH,
                                      text, sha, write_pat, ua, message)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except RuntimeError as e:
        raise HTTPException(409 if 'Conflict' in str(e) else 502, str(e))
    except requests.exceptions.RequestException as e:
        raise HTTPException(502, f'Push failed: {e}')
    return {
        'pushed_hulls': len(hulls),
        'pushed_items': len(items),
        'commit_sha': result.get('commit_sha'),
        'commit_html_url': result.get('commit_html_url'),
    }
```

- [ ] **Step 4: Run all acquisitions tests to verify they pass**

```bash
python3 -m pytest python/tests/test_acquisitions_sync_push.py -v 2>&1 | tail -15
```

Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add python/server.py python/tests/test_acquisitions_sync_push.py
git commit -m "feat(acq): POST /api/acquisitions/push — publish inventory to quota repo"
```

---

## Task 3: Frontend — auto-sync on startup + Push Inventory button

**Files:**
- Modify: `renderer/app.js`

- [ ] **Step 1: Add the `acqAllowPush` module-level flag**

Find the existing module-level `let` declarations for acquisitions (around line 4794):

```js
let acquisitionsHulls = [];  // [{type_id, name, quantity, category_id}]
let acquisitionsItems = [];  // [{type_id, name, quantity, category_id}]
let acquisitionsPasteText = '';
let acquisitionsUpdatedAt = null;
```

Add one line after `acquisitionsUpdatedAt`:

```js
let acqAllowPush = false;  // true when alliance_quota_allow_push is set in config
```

- [ ] **Step 2: Extend `acquisitionsLoad()` to attempt remote sync first**

Replace the current `acquisitionsLoad()` function (around line 4820):

```js
async function acquisitionsLoad() {
  try {
    const sync = await fetch(`${API}/api/acquisitions/sync`, { method: 'POST' }).then((r) => r.json());
    if (!sync.error) {
      acquisitionsHulls = sync.hulls || [];
      acquisitionsItems = sync.items || [];
      acquisitionsUpdatedAt = sync.updated_at || null;
      return;
    }
  } catch (_) {}
  // Fall back to local store
  try {
    const data = await fetch(`${API}/api/acquisitions`).then((r) => r.json());
    acquisitionsHulls = data.hulls || [];
    acquisitionsItems = data.items || [];
    acquisitionsUpdatedAt = data.updated_at || null;
  } catch (_) {}
}
```

- [ ] **Step 3: Load `acqAllowPush` from config at startup**

Find where `acquisitionsLoad()` is called at the bottom of the file (around line 5944):

```js
// Load acquisitions inventory on startup
acquisitionsLoad();
```

Replace with:

```js
// Load acquisitions inventory and allow-push flag on startup
(async () => {
  try {
    const cfg = await fetch(`${API}/api/config`).then((r) => r.json());
    acqAllowPush = !!cfg?.alliance_quota_allow_push;
  } catch (_) {}
  await acquisitionsLoad();
})();
```

- [ ] **Step 4: Add the Push Inventory button to `renderAcquisitionsTab()`**

Find the controls row inside `renderAcquisitionsTab()` (around line 5825):

```js
    <div style="display:flex;gap:0.5rem;margin-top:0.4rem;align-items:center;flex-wrap:wrap">
      <button id="acq-add" class="btn">Add to inventory</button>
      <button id="acq-replace" class="btn" title="Discard the current inventory and replace it with this paste">Replace inventory</button>
      <button id="acq-copy-inventory" class="btn" title="Copy full inventory as Janice-format text">Copy inventory</button>
      <button id="acq-corp-load" class="btn secondary" title="Load corp hangar contents via ESI (requires Director re-auth with corp assets scope)">Corp inventory (needs director access)</button>
      <button id="acq-clear" class="link-btn" style="color:#8899aa">Clear</button>
      <span id="acq-status" style="font-size:0.8rem;color:#8899aa;margin-left:0.5rem"></span>
    </div>
```

Replace with:

```js
    <div style="display:flex;gap:0.5rem;margin-top:0.4rem;align-items:center;flex-wrap:wrap">
      <button id="acq-add" class="btn">Add to inventory</button>
      <button id="acq-replace" class="btn" title="Discard the current inventory and replace it with this paste">Replace inventory</button>
      <button id="acq-copy-inventory" class="btn" title="Copy full inventory as Janice-format text">Copy inventory</button>
      <button id="acq-corp-load" class="btn secondary" title="Load corp hangar contents via ESI (requires Director re-auth with corp assets scope)">Corp inventory (needs director access)</button>
      ${acqAllowPush ? '<button id="acq-push-inventory" class="btn secondary" title="Publish inventory to alliance quota repo so all users see it">Push inventory</button>' : ''}
      <button id="acq-clear" class="link-btn" style="color:#8899aa">Clear</button>
      <span id="acq-status" style="font-size:0.8rem;color:#8899aa;margin-left:0.5rem"></span>
    </div>
```

- [ ] **Step 5: Wire up the push button click handler**

Find the section at the end of `renderAcquisitionsTab()` where other button listeners are attached (around line 5930). Locate the `acquisitionsLoad()` call or the last `addEventListener` line and add the push handler after the existing listeners:

```js
  root.querySelector('#acq-push-inventory')?.addEventListener('click', async () => {
    const statusEl = root.querySelector('#acq-status');
    statusEl.textContent = 'Pushing…';
    try {
      const res = await fetch(`${API}/api/acquisitions/push`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        statusEl.textContent = `Push failed: ${data.detail || res.statusText}`;
      } else {
        const sha = data.commit_sha ? data.commit_sha.slice(0, 7) : '?';
        statusEl.textContent = `Pushed — commit ${sha}`;
      }
    } catch (e) {
      statusEl.textContent = `Push failed: ${e.message}`;
    }
  });
```

- [ ] **Step 6: Commit**

```bash
git add renderer/app.js
git commit -m "feat(acq): auto-sync inventory from quota repo on startup; push button for admins"
```

---

## Task 4: Manual smoke test

- [ ] **Step 1: Restart the app and verify startup sync**

Kill any running instance and relaunch:

```bash
pkill -x Electron 2>/dev/null; sleep 1
unset ELECTRON_RUN_AS_NODE
npm start &
```

Wait ~20 seconds for the sidecar to boot, then open the **Acquisitions** tab. If the quota repo is configured with a Read PAT, the app should auto-pull `acquisitions-inventory.json` from the repo (or silently fall back to local if the file doesn't exist yet).

Check the sidecar log to confirm the sync was attempted:

```bash
tail -30 ~/Library/Application\ Support/naval-defence-management-tool/sidecar.log
```

- [ ] **Step 2: Verify Push Inventory button appears for admin**

Open **Admin → Config** and verify "Allow push from this machine" is ticked. Switch to the **Acquisitions** tab — the **Push inventory** button should be visible next to "Corp inventory".

If the checkbox is unticked, the button should be absent.

- [ ] **Step 3: Push and verify**

Paste some test inventory, click "Add to inventory", then click "Push inventory". The `#acq-status` span should show `Pushed — commit <sha>`. Check the quota repo on GitHub to confirm `acquisitions-inventory.json` was created/updated at the repo root.

- [ ] **Step 4: Pull on a second machine / fresh session**

Restart the app (or clear local inventory with "Clear"). The Acquisitions tab should load the inventory that was just pushed.
