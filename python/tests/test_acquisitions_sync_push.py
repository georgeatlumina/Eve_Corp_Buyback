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
