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

    def test_syncs_from_github_and_writes_local(self, client, acq_store, tmp_path):
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
        assert data['updated_at']  # freshly-written timestamp from save_acquisitions
        import json as _json
        saved = _json.loads((tmp_path / 'acquisitions_inventory.json').read_text())
        assert saved['hulls'] == SAMPLE_HULLS
        assert saved['items'] == SAMPLE_ITEMS

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

    def test_400_when_url_not_parseable(self, client, acq_store):
        acq_store.save_acquisitions(SAMPLE_HULLS, SAMPLE_ITEMS)
        with patch('server.load_config', return_value={'alliance_quota_allow_push': True,
                                                        'alliance_quota_url': 'https://gist.github.com/user/abc123',
                                                        'alliance_quota_pat_write': 'write-pat'}):
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

    def test_403_when_read_step_permission_error(self, client, acq_store):
        acq_store.save_acquisitions(SAMPLE_HULLS, SAMPLE_ITEMS)
        cfg = {
            'alliance_quota_allow_push': True,
            'alliance_quota_url': 'https://github.com/acme/alliance/blob/main/quotas.json',
            'alliance_quota_pat_write': 'write-pat',
        }
        with patch('server.load_config', return_value=cfg), \
             patch('server._github_contents_get', side_effect=PermissionError('bad token')):
            resp = client.post('/api/acquisitions/push')
        assert resp.status_code == 403

    def test_403_when_write_step_permission_error(self, client, acq_store):
        acq_store.save_acquisitions(SAMPLE_HULLS, SAMPLE_ITEMS)
        cfg = {
            'alliance_quota_allow_push': True,
            'alliance_quota_url': 'https://github.com/acme/alliance/blob/main/quotas.json',
            'alliance_quota_pat_write': 'write-pat',
        }
        with patch('server.load_config', return_value=cfg), \
             patch('server._github_contents_get', side_effect=FileNotFoundError()), \
             patch('server._github_contents_put', side_effect=PermissionError('bad token')):
            resp = client.post('/api/acquisitions/push')
        assert resp.status_code == 403

    def test_409_when_write_step_conflict(self, client, acq_store):
        acq_store.save_acquisitions(SAMPLE_HULLS, SAMPLE_ITEMS)
        cfg = {
            'alliance_quota_allow_push': True,
            'alliance_quota_url': 'https://github.com/acme/alliance/blob/main/quotas.json',
            'alliance_quota_pat_write': 'write-pat',
        }
        with patch('server.load_config', return_value=cfg), \
             patch('server._github_contents_get', side_effect=FileNotFoundError()), \
             patch('server._github_contents_put', side_effect=RuntimeError('Conflict: sha mismatch')):
            resp = client.post('/api/acquisitions/push')
        assert resp.status_code == 409
