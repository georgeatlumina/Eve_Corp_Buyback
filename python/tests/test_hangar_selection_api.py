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
        assert resp.json()['storage'] == 'local'  # push failed silently; must not claim 'github'
