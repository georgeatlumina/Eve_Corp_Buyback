"""Tests for stockpile material targets.

Distinct from the doctrine quotas elsewhere, which count hulls on contract —
these count units of a material the alliance wants on hand, and the join has to
survive stock arriving two different ways: a paste (names, no type ids) and an
ESI hangar scan (both).
"""
import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import stockpile as sp  # noqa: E402


ITEMS = [
    {'name': 'Tritanium', 'type_id': 34, 'qty': 60_000_000, 'category': 'minerals'},
    {'name': 'Pyerite', 'type_id': 35, 'qty': 4_000_000, 'category': 'minerals'},
    {'name': 'Morphite', 'type_id': 0, 'qty': 90_000, 'category': 'minerals'},
]


class TestNormalize:
    def test_a_zero_target_is_dropped(self):
        """"I want none of this" is the same as having no target, and keeping it
        would clutter a list meant to be acted on."""
        assert sp.normalize_quotas([{'name': 'Tritanium', 'target': 0}]) == []

    def test_nameless_and_unparseable_rows_are_dropped(self):
        assert sp.normalize_quotas([
            {'name': '', 'target': 5}, {'name': '  ', 'target': 5},
            {'name': 'X', 'target': 'lots'}, {'target': 5},
        ]) == []

    def test_duplicates_collapse(self):
        out = sp.normalize_quotas([
            {'name': 'Tritanium', 'type_id': 34, 'target': 100},
            {'name': 'Tritanium', 'type_id': 34, 'target': 200},
        ])
        assert len(out) == 1

    def test_sorted_by_name(self):
        out = sp.normalize_quotas([
            {'name': 'Zydrine', 'target': 1}, {'name': 'Isogen', 'target': 1}])
        assert [q['name'] for q in out] == ['Isogen', 'Zydrine']


class TestJoin:
    def test_matches_by_type_id(self):
        row = sp.quota_status(ITEMS, [{'name': 'anything', 'type_id': 34, 'target': 50_000_000}])[0]
        assert row['have'] == 60_000_000
        assert row['state'] == 'met'

    def test_matches_by_name_case_insensitively(self):
        """A pasted stock list carries no type ids, so names have to reconcile."""
        row = sp.quota_status(ITEMS, [{'name': 'PYERITE', 'type_id': 0, 'target': 10_000_000}])[0]
        assert row['have'] == 4_000_000

    def test_falls_back_to_name_when_the_ids_disagree(self):
        """Stock from a paste has type_id 0; the quota may have a real one."""
        row = sp.quota_status(ITEMS, [{'name': 'Morphite', 'type_id': 11399, 'target': 100_000}])[0]
        assert row['have'] == 90_000

    def test_an_item_with_no_stock_still_appears(self):
        """The single most important row this list can show: you hold none of
        something you need. Joining from the stock side would omit it."""
        rows = sp.quota_status(ITEMS, [{'name': 'Nocxium', 'target': 500_000}])
        assert len(rows) == 1
        assert rows[0]['have'] == 0
        assert rows[0]['shortfall'] == 500_000
        assert rows[0]['state'] == 'critical'

    def test_worst_first(self):
        rows = sp.quota_status(ITEMS, [
            {'name': 'Tritanium', 'type_id': 34, 'target': 50_000_000},
            {'name': 'Pyerite', 'type_id': 35, 'target': 10_000_000},
            {'name': 'Nocxium', 'target': 500_000},
        ])
        assert [r['name'] for r in rows] == ['Nocxium', 'Pyerite', 'Tritanium']

    @pytest.mark.parametrize('have,target,state', [
        (0, 100, 'critical'), (24, 100, 'critical'),
        (25, 100, 'low'), (74, 100, 'low'),
        (75, 100, 'near'), (99, 100, 'near'),
        (100, 100, 'met'), (400, 100, 'met'),
    ])
    def test_state_thresholds(self, have, target, state):
        items = [{'name': 'X', 'type_id': 1, 'qty': have}]
        assert sp.quota_status(items, [{'name': 'X', 'type_id': 1, 'target': target}])[0]['state'] == state

    def test_surplus_and_shortfall_never_go_negative(self):
        rows = sp.quota_status(ITEMS, [{'name': 'Tritanium', 'type_id': 34, 'target': 50_000_000}])
        assert rows[0]['shortfall'] == 0
        assert rows[0]['surplus'] == 10_000_000

    def test_totals(self):
        rows = sp.quota_status(ITEMS, [
            {'name': 'Tritanium', 'type_id': 34, 'target': 50_000_000},
            {'name': 'Nocxium', 'target': 500_000},
        ])
        assert sp.quota_totals(rows) == {'tracked': 2, 'met': 1, 'critical': 1, 'short': 1}

    def test_no_quotas_means_no_rows(self):
        assert sp.quota_status(ITEMS, []) == []


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import config
    monkeypatch.setattr(config, 'CONFIG_PATH', str(tmp_path / 'config.json'))
    monkeypatch.setattr(config, 'AUTH_DIR', str(tmp_path))
    import server
    return TestClient(server.app)


class TestHangarConfig:
    def test_division_one_collapses_to_one_flag(self):
        """ESI reports division 1 as HangarAll on some structures and CorpSAG1
        on others; a config holding both would double-count it."""
        import server
        r = server.update_config(server.ConfigUpdate(stockpile_hangar_flags=['HangarAll', 'CorpSAG1']))
        assert r['stockpile_hangar_flags'] == ['CorpSAG1']

    def test_flags_come_back_in_division_order(self, client):
        r = client.post('/api/config', json={'stockpile_hangar_flags': ['CorpSAG5', 'CorpSAG2', 'CorpSAG7']})
        assert r.json()['stockpile_hangar_flags'] == ['CorpSAG2', 'CorpSAG5', 'CorpSAG7']

    def test_unknown_flags_are_dropped(self, client):
        r = client.post('/api/config', json={'stockpile_hangar_flags': ['CorpSAG2', 'nonsense', 'CorpSAG99']})
        assert r.json()['stockpile_hangar_flags'] == ['CorpSAG2']

    def test_empty_means_fall_back_to_the_shared_picker(self, client):
        assert client.get('/api/config').json()['stockpile_hangar_flags'] == []


class TestEndpoint:
    def test_stockpile_returns_status_alongside_stock(self, client):
        client.post('/api/config', json={'stockpile_quotas': [{'name': 'Tritanium', 'target': 1000}]})
        d = client.get('/api/stockpile').json()
        assert 'quota_status' in d and 'quota_totals' in d
        assert d['quota_status'][0]['name'] == 'Tritanium'
        assert d['quota_totals']['tracked'] == 1


class TestSharing:
    def test_targets_are_local_until_a_repo_is_configured(self, client):
        d = client.get('/api/stockpile/quotas').json()
        assert d['storage'] == 'local'

    def test_saving_is_gated_on_the_admin_toggle(self, client):
        """Deciding what the alliance *should* hold is the same class of call as
        saying what it holds, so it rides the same gate as stock edits."""
        r = client.post('/api/stockpile/quotas', json={'quotas': [{'name': 'Tritanium', 'target': 5}]})
        assert r.status_code == 403

    def test_a_save_normalises_and_persists(self, client):
        client.post('/api/config', json={'stockpile_allow_push': True})
        r = client.post('/api/stockpile/quotas', json={'quotas': [
            {'name': 'Tritanium', 'target': 50}, {'name': '', 'target': 9}, {'name': 'X', 'target': 0}]})
        assert [q['name'] for q in r.json()['quotas']] == ['Tritanium']
        # Mirrored into config, so it survives going offline and rides along in
        # a config export.
        assert client.get('/api/config').json()['stockpile_quotas'][0]['target'] == 50

    def test_the_stockpile_view_reports_where_targets_came_from(self, client):
        assert client.get('/api/stockpile').json()['quota_storage'] in ('local', 'github')


class TestConfigContract:
    """Every key the Config form sends must be declared on the API model, or the
    save silently drops it — which is exactly what had been happening to the
    Acquisitions shopping settings."""

    def test_the_new_keys_round_trip(self, client):
        payload = {
            'wallet_division_labels': {'1': 'Master'},
            'buyback_division': 3, 'moon_division': 6,
            'stockpile_quotas': [{'name': 'Tritanium', 'target': 10}],
            'stockpile_hangar_structure_id': 123, 'stockpile_hangar_flags': ['CorpSAG2'],
            'acq_shopping_min_coverage': 0.9, 'acq_shopping_max_isk_gap': 1234.0,
        }
        client.post('/api/config', json=payload)
        cfg = client.get('/api/config').json()
        assert cfg['buyback_division'] == 3
        assert cfg['stockpile_hangar_structure_id'] == 123
        assert cfg['stockpile_hangar_flags'] == ['CorpSAG2']
        assert cfg['acq_shopping_min_coverage'] == 0.9
        assert cfg['acq_shopping_max_isk_gap'] == 1234.0

    def test_every_config_form_key_is_accepted_by_the_api(self):
        """Parses the renderer's collectConfigForm() and checks each key against
        the model, so a future field added to the form can't quietly go nowhere."""
        import re
        import server
        js = open(os.path.join(os.path.dirname(__file__), '..', '..', 'renderer', 'app.js'),
                  encoding='utf-8').read()
        start = js.index('function collectConfigForm()')
        body = js[start:js.index('\n}', start)]
        form_keys = set(re.findall(r'^\s{4}([a-z_][a-z0-9_]*):', body, re.M))
        assert form_keys, 'could not parse collectConfigForm()'
        missing = sorted(form_keys - set(server.ConfigUpdate.model_fields))
        assert missing == [], f'Config form sends keys the API drops: {missing}'
