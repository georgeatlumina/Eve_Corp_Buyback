"""Tests for the PI planet-capacity endpoint that feeds the builder's optimizer.

Per-toon max deployable planets = 1 + Interplanetary Consolidation (skill 2495)
level, read via ESI skills. Toons whose token predates the read_skills scope are
flagged needs_reauth instead of failing the whole call.
"""
import os
import sys
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

SKILLS_SCOPE = 'esi-skills.read_skills.v1'
IC_SKILL = 2495


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient
    import server
    return TestClient(server.app)


def _payload(scopes):
    return {'scp': list(scopes), 'name': 'ignored'}


class TestPlanetCapacity:
    def test_reads_ic_level_to_max_planets(self, client):
        slots = [('pi1', 'tokA', 101, 'Alt One')]
        skills = {'skills': [{'skill_id': IC_SKILL, 'active_skill_level': 4}]}
        with patch('server._pi_scoped_slots', return_value=iter(slots)), \
             patch('server.decode_jwt_payload', return_value=_payload(['publicData', SKILLS_SCOPE])), \
             patch('server.fetch_character_skills', return_value=skills):
            r = client.get('/api/pi/planet-capacity').json()
        assert r['total_max'] == 5
        toon = r['toons'][0]
        assert toon['ic_level'] == 4
        assert toon['max_planets'] == 5
        assert toon['needs_reauth'] is False

    def test_no_ic_skill_defaults_to_one_planet(self, client):
        slots = [('pi1', 'tokA', 101, 'Alt One')]
        with patch('server._pi_scoped_slots', return_value=iter(slots)), \
             patch('server.decode_jwt_payload', return_value=_payload(['publicData', SKILLS_SCOPE])), \
             patch('server.fetch_character_skills', return_value={'skills': []}):
            r = client.get('/api/pi/planet-capacity').json()
        toon = r['toons'][0]
        assert toon['ic_level'] == 0
        assert toon['max_planets'] == 1
        assert r['total_max'] == 1

    def test_missing_skills_scope_flags_reauth(self, client):
        slots = [('pi1', 'tokA', 101, 'Alt One')]
        with patch('server._pi_scoped_slots', return_value=iter(slots)), \
             patch('server.decode_jwt_payload', return_value=_payload(['publicData', 'esi-planets.manage_planets.v1'])), \
             patch('server.fetch_character_skills') as skills_call:
            r = client.get('/api/pi/planet-capacity').json()
        skills_call.assert_not_called()          # no wasted ESI call without the scope
        toon = r['toons'][0]
        assert toon['needs_reauth'] is True
        assert toon['max_planets'] is None
        assert r['total_max'] == 0

    def test_dedupes_same_character_across_slots(self, client):
        slots = [('slot1', 'tokA', 101, 'Alt One'), ('pi3', 'tokB', 101, 'Alt One')]
        skills = {'skills': [{'skill_id': IC_SKILL, 'active_skill_level': 5}]}
        with patch('server._pi_scoped_slots', return_value=iter(slots)), \
             patch('server.decode_jwt_payload', return_value=_payload(['publicData', SKILLS_SCOPE])), \
             patch('server.fetch_character_skills', return_value=skills):
            r = client.get('/api/pi/planet-capacity').json()
        assert len(r['toons']) == 1              # one physical character, not two slots
        assert r['total_max'] == 6


class TestPiPrice:
    def test_returns_jita_buy_and_poco_base_when_keyed(self, client):
        with patch('server.load_config', return_value={'janice_api_key': 'k', 'pi_poco_tax_rate': 0.07}), \
             patch('server._pi_poco_tax_base', return_value=1694276.63), \
             patch('server.fetch_immediate_prices', return_value={2870: {'buy': 1200.0, 'sell': 1500.0}}):
            r = client.get('/api/pi/price', params={'type_id': 2870, 'bust': 1}).json()
        assert r['priced'] is True
        assert r['buy'] == 1200.0
        assert r['sell'] == 1500.0
        assert r['poco_tax_rate'] == 0.07
        assert r['poco_tax_base'] == 1694276.63   # chain-wide taxable base per final unit

    def test_poco_base_without_api_key(self, client):
        """No Janice key → unpriced, but the (keyless) chain POCO base still returns."""
        with patch('server.load_config', return_value={'pi_poco_tax_rate': 0.05}), \
             patch('server._pi_poco_tax_base', return_value=500000.0):
            r = client.get('/api/pi/price', params={'type_id': 2870, 'bust': 1}).json()
        assert r['priced'] is False
        assert r['buy'] is None
        assert r['poco_tax_rate'] == 0.05
        assert r['poco_tax_base'] == 500000.0
