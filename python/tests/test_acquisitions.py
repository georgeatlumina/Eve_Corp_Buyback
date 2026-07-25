"""Tests for the Acquisitions Inventory feature (new this release).

Covers the on-disk persistence module (acquisitions.py) and the streaming
/api/acquisitions/parse endpoint, which resolves an EVE paste to type IDs and
reports which lines it had to drop.
"""
import json
import os
import sys
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


# ── acquisitions.py persistence ──────────────────────────────────────────────

@pytest.fixture()
def acq_path(tmp_path):
    """Point the module at a throwaway file so tests never touch real data."""
    import acquisitions
    p = tmp_path / 'acquisitions_inventory.json'
    with patch.object(acquisitions, 'ACQUISITIONS_PATH', str(p)), \
         patch.object(acquisitions, 'AUTH_DIR', str(tmp_path)):
        yield acquisitions, str(p)


class TestLoadAcquisitions:
    def test_missing_file_returns_empty_shape(self, acq_path):
        acquisitions, _ = acq_path
        assert acquisitions.load_acquisitions() == {'hulls': [], 'items': [], 'updated_at': None}

    def test_reads_back_saved_data(self, acq_path):
        acquisitions, _ = acq_path
        acquisitions.save_acquisitions(
            [{'type_id': 671, 'name': 'Erebus', 'quantity': 1}],
            [{'type_id': 34, 'name': 'Tritanium', 'quantity': 500}],
        )
        loaded = acquisitions.load_acquisitions()
        assert loaded['hulls'][0]['name'] == 'Erebus'
        assert loaded['items'][0]['quantity'] == 500

    def test_corrupt_json_degrades_to_empty(self, acq_path):
        acquisitions, path = acq_path
        with open(path, 'w') as f:
            f.write('{ this is not json')
        assert acquisitions.load_acquisitions() == {'hulls': [], 'items': [], 'updated_at': None}

    def test_non_object_json_degrades_to_empty(self, acq_path):
        acquisitions, path = acq_path
        with open(path, 'w') as f:
            json.dump([1, 2, 3], f)
        assert acquisitions.load_acquisitions() == {'hulls': [], 'items': [], 'updated_at': None}

    def test_missing_keys_default_to_empty_lists(self, acq_path):
        acquisitions, path = acq_path
        with open(path, 'w') as f:
            json.dump({'updated_at': '2026-07-01T00:00:00+00:00'}, f)
        loaded = acquisitions.load_acquisitions()
        assert loaded['hulls'] == []
        assert loaded['items'] == []
        assert loaded['updated_at'] == '2026-07-01T00:00:00+00:00'


class TestSaveAcquisitions:
    def test_writes_file_and_stamps_updated_at(self, acq_path):
        acquisitions, path = acq_path
        data = acquisitions.save_acquisitions([], [])
        assert os.path.exists(path)
        assert data['updated_at'] is not None

    def test_none_inputs_become_empty_lists(self, acq_path):
        acquisitions, _ = acq_path
        data = acquisitions.save_acquisitions(None, None)
        assert data['hulls'] == []
        assert data['items'] == []

    def test_save_then_load_roundtrips_updated_at(self, acq_path):
        acquisitions, _ = acq_path
        saved = acquisitions.save_acquisitions([{'type_id': 1, 'name': 'x', 'quantity': 1}], [])
        assert acquisitions.load_acquisitions()['updated_at'] == saved['updated_at']


# ── /api/acquisitions/parse (streaming NDJSON) ───────────────────────────────

@pytest.fixture()
def client():
    from fastapi.testclient import TestClient
    import server
    return TestClient(server.app)


def _events(resp):
    return [json.loads(line) for line in resp.text.splitlines() if line.strip()]


class TestAcquisitionsParse:
    def test_empty_paste_is_400(self, client):
        resp = client.post('/api/acquisitions/parse', json={'paste_text': '   '})
        assert resp.status_code == 400

    def test_streams_progress_then_done(self, client):
        appraise = {'items': [{'type_id': 34, 'name': 'Tritanium', 'quantity': 500}]}
        with patch('server.appraise_items', return_value=appraise), \
             patch('server.fetch_type_info', return_value={'group_id': 18}), \
             patch('server.fetch_group_info', return_value={'category_id': 4}), \
             patch('server.load_config', return_value={'janice_api_key': 'key'}):
            resp = client.post('/api/acquisitions/parse', json={'paste_text': 'Tritanium\t500'})
        events = _events(resp)
        assert events[0]['event'] == 'progress'
        done = events[-1]
        assert done['event'] == 'done'
        assert done['items'][0]['type_id'] == 34
        assert done['items'][0]['category_id'] == 4

    def test_reports_names_janice_could_not_resolve(self, client):
        # 'Frobnicator' has no type_id, so it should surface under 'ignored'.
        appraise = {'items': [
            {'type_id': 34, 'name': 'Tritanium', 'quantity': 500},
            {'type_id': None, 'name': 'Frobnicator', 'quantity': 1},
        ]}
        with patch('server.appraise_items', return_value=appraise), \
             patch('server.fetch_type_info', return_value={'group_id': 18}), \
             patch('server.fetch_group_info', return_value={'category_id': 4}), \
             patch('server.load_config', return_value={'janice_api_key': 'key'}):
            resp = client.post('/api/acquisitions/parse',
                               json={'paste_text': 'Tritanium\t500\nFrobnicator\t1'})
        done = _events(resp)[-1]
        assert done['ignored'] == ['Frobnicator']
        assert [i['name'] for i in done['items']] == ['Tritanium']

    def test_reports_resolved_lines_with_no_quantity(self, client):
        appraise = {'items': [{'type_id': 34, 'name': 'Tritanium', 'quantity': 0}]}
        with patch('server.appraise_items', return_value=appraise), \
             patch('server.load_config', return_value={'janice_api_key': 'key'}):
            resp = client.post('/api/acquisitions/parse', json={'paste_text': 'Tritanium\t0'})
        done = _events(resp)[-1]
        assert done['zero_qty'] == ['Tritanium']
        assert done['items'] == []

    def test_category_lookup_failure_leaves_category_none(self, client):
        appraise = {'items': [{'type_id': 34, 'name': 'Tritanium', 'quantity': 500}]}
        with patch('server.appraise_items', return_value=appraise), \
             patch('server.fetch_type_info', side_effect=Exception('esi down')), \
             patch('server.load_config', return_value={'janice_api_key': 'key'}):
            resp = client.post('/api/acquisitions/parse', json={'paste_text': 'Tritanium\t500'})
        done = _events(resp)[-1]
        assert done['items'][0]['category_id'] is None

    def test_appraise_failure_emits_error_event(self, client):
        with patch('server.appraise_items', side_effect=Exception('janice down')), \
             patch('server.load_config', return_value={'janice_api_key': 'key'}):
            resp = client.post('/api/acquisitions/parse', json={'paste_text': 'Tritanium\t500'})
        events = _events(resp)
        assert events[-1]['event'] == 'error'
        assert 'janice down' in events[-1]['message']


# ── /api/acquisitions GET/POST ───────────────────────────────────────────────

class TestAcquisitionsCrud:
    def test_get_returns_saved_inventory(self, client, tmp_path):
        import acquisitions
        p = tmp_path / 'acq.json'
        with patch.object(acquisitions, 'ACQUISITIONS_PATH', str(p)), \
             patch.object(acquisitions, 'AUTH_DIR', str(tmp_path)):
            client.post('/api/acquisitions', json={
                'hulls': [{'type_id': 671, 'name': 'Erebus', 'quantity': 1}],
                'items': [],
            })
            resp = client.get('/api/acquisitions')
        assert resp.status_code == 200
        assert resp.json()['hulls'][0]['name'] == 'Erebus'
