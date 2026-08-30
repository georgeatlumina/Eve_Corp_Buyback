"""Tests for the SMT activity + jump-range layers.

Both are read by two windows (the Intel Map tab and the transparent overlay)
off one sidecar-held setting, so the contract these endpoints return is what
keeps the two from disagreeing.
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


class TestActivityThresholds:
    def test_defaults_cover_every_layer(self, client):
        layers = client.get('/api/smt/activity').json()['layers']
        assert sorted(layers) == ['jumps', 'npc', 'pod', 'ship']
        assert all(l['bands'] for l in layers.values())

    def test_bands_come_back_sorted(self, client):
        """The renderer takes the last band a value clears, so out-of-order
        bands would silently mislabel a system."""
        r = client.post('/api/smt/activity', json={'layers': {
            'npc': {'on': True, 'bands': [{'min': 500, 'colour': '#111111'},
                                          {'min': 5, 'colour': '#222222'},
                                          {'min': 50, 'colour': '#333333'}]}}})
        mins = [b['min'] for b in r.json()['layers']['npc']['bands']]
        assert mins == sorted(mins) == [5, 50, 500]

    def test_a_bad_colour_falls_back_rather_than_erroring(self, client):
        r = client.post('/api/smt/activity', json={
            'layers': {'ship': {'on': True, 'bands': [{'min': 1, 'colour': 'not-a-colour'}]}}})
        assert r.status_code == 200
        assert r.json()['layers']['ship']['bands'][0]['colour'].startswith('#')

    def test_an_empty_band_list_restores_that_layer_default(self, client):
        """What the panel's Reset button relies on — defaults live server-side
        only, so the two windows can't drift apart on them."""
        client.post('/api/smt/activity', json={'layers': {'pod': {'on': True, 'bands': [{'min': 99, 'colour': '#abcdef'}]}}})
        r = client.post('/api/smt/activity', json={'layers': {'pod': {'on': True, 'bands': []}}})
        assert [b['min'] for b in r.json()['layers']['pod']['bands']] == [1, 3, 10]


class TestJumpRange:
    def test_every_hull_doubles_its_base_at_max_skill(self, client):
        ships = {s['key']: s for s in client.get('/api/smt/jump-ships').json()['ships']}
        assert ships['blops']['ranges'][5] == 8.0
        assert ships['jf']['ranges'][5] == 10.0
        assert ships['titan']['ranges'][5] == 6.0
        for s in ships.values():
            assert s['ranges'][0] == s['base']

    def test_longer_range_reaches_at_least_as_far(self, client):
        blops = client.get('/api/smt/jump-range?system=1DQ1-A&ship=blops&skill=5').json()
        titan = client.get('/api/smt/jump-range?system=1DQ1-A&ship=titan&skill=5').json()
        assert blops['ly'] > titan['ly']
        assert blops['count'] > titan['count']
        # The shorter reach must be a strict subset — same origin, same space.
        assert set(titan['systems']) <= set(blops['systems'])

    def test_high_sec_is_never_in_range(self, client):
        """A jump drive can't end in high-sec, so listing one would be a lie you
        could undock on."""
        import eve_map
        systems = eve_map.load_map()['systems']
        d = client.get('/api/smt/jump-range?system=Jita&ship=jf&skill=5').json()
        assert d['count'] > 0
        assert not [s for s in d['systems'] if (systems[s].get('sec') or 0) >= 0.5]

    def test_distances_never_exceed_the_range(self, client):
        d = client.get('/api/smt/jump-range?system=1DQ1-A&ship=blops&skill=5').json()
        assert max(d['systems'].values()) <= d['ly']
        assert d['systems'][str(d['origin']['id'])] == 0.0

    def test_an_explicit_ly_overrides_the_hull(self, client):
        d = client.get('/api/smt/jump-range?system=1DQ1-A&ship=titan&skill=0&ly=9').json()
        assert d['ly'] == 9
        assert max(d['systems'].values()) <= 9

    def test_an_unknown_system_reports_rather_than_raising(self, client):
        assert 'error' in client.get('/api/smt/jump-range?system=Nowhere').json()

    def test_every_bundled_system_has_a_position(self):
        """The overlay is only as good as the dataset behind it; a system with no
        position silently drops out of every range check."""
        import eve_map
        systems = eve_map.load_map()['systems']
        missing = [sid for sid, rec in systems.items() if not rec.get('pos')]
        assert missing == [], f'{len(missing)} systems have no position'


class TestJumpPrefs:
    def test_defaults_to_blops_at_max_skill(self, client):
        assert client.get('/api/smt/jump-prefs').json() == {'ship': 'blops', 'skill': 5, 'ly': 8.0}

    def test_round_trips_and_recomputes_range(self, client):
        r = client.post('/api/smt/jump-prefs', json={'ship': 'jf', 'skill': 4})
        assert r.json() == {'ship': 'jf', 'skill': 4, 'ly': 9.0}
        assert client.get('/api/smt/jump-prefs').json()['ship'] == 'jf'

    def test_nonsense_falls_back_instead_of_erroring(self, client):
        r = client.post('/api/smt/jump-prefs', json={'ship': 'rifter', 'skill': 99})
        assert r.json()['ship'] == 'blops'
        assert r.json()['skill'] == 5
