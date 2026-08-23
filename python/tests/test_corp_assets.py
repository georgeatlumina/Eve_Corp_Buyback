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
