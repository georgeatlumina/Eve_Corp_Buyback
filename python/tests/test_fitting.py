"""Tests for the vendored Pyfa `eos` fitting engine bridge (pyfa_engine) and the
/api/fit/* endpoints. Skipped automatically when the engine can't run (deps or
eve.db absent — e.g. a CI box that hasn't built eve.db)."""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

pe = pytest.importorskip('pyfa_engine', reason='fitting engine deps not installed')
if not pe.available():
    pytest.skip('eve.db not built — skipping fitting engine tests', allow_module_level=True)


RIFTER = {
    'ship': 'Rifter', 'skills': 'all5',
    'modules': [
        {'type': '200mm AutoCannon II', 'charge': 'Republic Fleet EMP S'},
        {'type': '200mm AutoCannon II', 'charge': 'Republic Fleet EMP S'},
        {'type': '200mm AutoCannon II', 'charge': 'Republic Fleet EMP S'},
        {'type': '1MN Afterburner II'},
        {'type': 'Stasis Webifier II'},
        {'type': 'Warp Scrambler II'},
        {'type': 'Small Ancillary Armor Repairer', 'charge': 'Nanite Repair Paste'},
        {'type': 'Gyrostabilizer II'},
        {'type': 'Damage Control II'},
    ],
}


class TestComputeFit:
    def test_matches_spike_numbers(self):
        r = pe.compute_fit(RIFTER)
        assert r['ship']['name'] == 'Rifter'
        assert abs(r['dps']['total'] - 165.21) < 1.0            # matches the headless spike
        assert r['ehp'] == {'shield': 887, 'armor': 980, 'hull': 1088}
        assert r['capacitor']['stable'] is False
        assert abs(r['capacitor']['lasts_s'] - 58.5) < 1.0
        assert r['resources']['slots']['high'] == {'used': 3, 'total': 3}
        # this fit is genuinely CPU-tight at all-V
        assert 'CPU' in r['overLimit'] and r['valid'] is False

    def test_skills_change_dps(self):
        hi = pe.compute_fit(RIFTER)['dps']['total']
        lo = pe.compute_fit({**RIFTER, 'skills': 'all0'})['dps']['total']
        assert hi > lo * 2                                       # ~165 vs ~47

    def test_damage_by_type_sums_to_total(self):
        r = pe.compute_fit(RIFTER)
        bt = r['dps']['byType']
        assert abs(sum(bt.values()) - r['dps']['total']) < 1.0


class TestEft:
    def test_round_trip(self):
        doc = pe.parse_eft("""[Rifter, T]
200mm AutoCannon II, Republic Fleet EMP S
Gyrostabilizer II

Warrior II x2""")
        assert doc['ship'] == 'Rifter'
        assert len(doc['modules']) == 2
        assert doc['drones'] == [{'type': pe._type_by_name('Warrior II')[0], 'amount': 2}]
        out = pe.render_eft(doc)
        assert out.startswith('[Rifter, T]')
        assert 'Warrior II x2' in out

    def test_bad_header(self):
        assert 'error' in pe.parse_eft('not a fit')


class TestBrowse:
    def test_ships_and_skills_nonempty(self):
        assert len(pe.list_ships()) > 300
        assert len(pe.list_skills()) > 300

    def test_search(self):
        names = [i['name'] for i in pe.search_items('200mm AutoCannon')]
        assert '200mm AutoCannon II' in names


class TestEndpoints:
    @pytest.fixture()
    def client(self):
        from fastapi.testclient import TestClient
        import server
        return TestClient(server.app)

    def test_status_and_compute(self, client):
        assert client.get('/api/fit/status').json()['available'] is True
        r = client.post('/api/fit/compute', params={'price': 'false'}, json=RIFTER)
        assert r.status_code == 200
        assert abs(r.json()['dps']['total'] - 165.21) < 1.0

    def test_ships_endpoint(self, client):
        assert len(client.get('/api/fit/ships').json()['ships']) > 300
