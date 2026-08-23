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
