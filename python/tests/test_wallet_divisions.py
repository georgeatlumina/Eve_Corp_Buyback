"""Tests for configurable corp wallet divisions.

EVE numbers corp wallet divisions 1-7 but each corp names them itself, so these
were wrong the moment the alliance moved buyback to a different corp — a tile
labelled "SRP" over a division holding something else misreports money in the
one place people read balances.
"""
import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import config
    monkeypatch.setattr(config, 'CONFIG_PATH', str(tmp_path / 'config.json'))
    monkeypatch.setattr(config, 'AUTH_DIR', str(tmp_path))
    import server
    return TestClient(server.app)


class TestDefaults:
    def test_a_fresh_install_gets_all_seven(self, client):
        labels = client.get('/api/config').json()['wallet_division_labels']
        assert sorted(labels) == ['1', '2', '3', '4', '5', '6', '7']

    def test_the_defaults_are_not_shared_between_calls(self):
        """_fresh_default() shallow-copies DEFAULTS, so a nested dict handed out
        by reference would let one caller rewrite the defaults process-wide."""
        import config
        a = config._fresh_default()
        a['wallet_division_labels']['1'] = 'MUTATED'
        assert config._fresh_default()['wallet_division_labels']['1'] == 'Master'
        assert config.WALLET_DIVISION_LABELS['1'] == 'Master'

    def test_buyback_and_moon_default_to_the_old_constants(self, client):
        cfg = client.get('/api/config').json()
        assert cfg['buyback_division'] == 3
        assert cfg['moon_division'] == 6


class TestSaving:
    def test_labels_round_trip(self, client):
        r = client.post('/api/config', json={
            'wallet_division_labels': {'1': 'NLDI Master', '3': 'General Buyback', '6': 'Moon Buyback'}})
        saved = r.json()['wallet_division_labels']
        assert saved['3'] == 'General Buyback'
        assert client.get('/api/config').json()['wallet_division_labels']['6'] == 'Moon Buyback'

    def test_a_blank_label_is_dropped_not_stored(self, client):
        """So the tile renders the neutral "Division N" rather than an empty
        label over a balance."""
        r = client.post('/api/config', json={'wallet_division_labels': {'4': '   ', '5': 'Industry'}})
        saved = r.json()['wallet_division_labels']
        assert '4' not in saved
        assert saved['5'] == 'Industry'

    def test_labels_are_trimmed_and_capped(self, client):
        r = client.post('/api/config', json={'wallet_division_labels': {'1': '  Master  ', '2': 'x' * 200}})
        saved = r.json()['wallet_division_labels']
        assert saved['1'] == 'Master'
        assert len(saved['2']) == 32

    def test_divisions_outside_one_to_seven_are_ignored(self, client):
        r = client.post('/api/config', json={'wallet_division_labels': {'0': 'nope', '8': 'nope', '9': 'nope'}})
        assert r.json()['wallet_division_labels'] == {}

    @pytest.mark.parametrize('given,expect', [(0, 1), (99, 7), (3, 3), (7, 7)])
    def test_the_highlighted_division_is_clamped(self, client, given, expect):
        r = client.post('/api/config', json={'buyback_division': given})
        assert r.json()['buyback_division'] == expect

    def test_nonsense_is_ignored_rather_than_erroring(self, client):
        before = client.get('/api/config').json()['moon_division']
        r = client.post('/api/config', json={'moon_division': 'six'})
        assert r.status_code in (200, 422)
        if r.status_code == 200:
            assert r.json()['moon_division'] == before

    def test_other_config_survives_a_label_save(self, client):
        """The labels ride in the same payload as everything else on the Config
        tab, so a save must not clear neighbouring keys."""
        client.post('/api/config', json={'corp_id': 98839943})
        client.post('/api/config', json={'wallet_division_labels': {'1': 'Master'}})
        assert client.get('/api/config').json()['corp_id'] == 98839943
