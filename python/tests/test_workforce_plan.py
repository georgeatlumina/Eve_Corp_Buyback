"""Unit tests for the Hooks & Hubs workforce-plan persistence module."""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


class TestNormalize:
    def test_none_yields_empty_with_default_catalog(self):
        import workforce_plan as wp
        p = wp._normalize(None)
        assert p['systems'] == []
        assert p['transfers'] == []
        assert isinstance(p['catalog'], list) and len(p['catalog']) > 0

    def test_respects_explicitly_empty_catalog(self):
        import workforce_plan as wp
        p = wp._normalize({'systems': [], 'transfers': [], 'catalog': []})
        assert p['catalog'] == []

    def test_coerces_wrong_types(self):
        import workforce_plan as wp
        p = wp._normalize({'systems': 'nope', 'transfers': 5, 'catalog': {'x': 1}})
        assert p['systems'] == []
        assert p['transfers'] == []
        # invalid catalog falls back to the starter palette
        assert len(p['catalog']) > 0


class TestRoundTrip:
    def test_save_then_load(self, tmp_path, monkeypatch):
        import workforce_plan as wp
        monkeypatch.setattr(wp, 'AUTH_DIR', str(tmp_path))
        monkeypatch.setattr(wp, 'PLAN_PATH', str(tmp_path / 'workforce_plan.json'))
        doc = {
            'systems': [{
                'id': 'a', 'system_name': '1DQ1-A',
                'power_available': 100, 'workforce_available': 200,
                'upgrades': [{'name': 'U', 'power': 10, 'workforce': 20}], 'notes': '',
            }],
            'transfers': [{'from': 'a', 'to': 'b', 'amount': 50}],
            'catalog': [],
        }
        saved = wp.save_plan(doc)
        assert saved['systems'][0]['system_name'] == '1DQ1-A'
        loaded = wp.load_plan()
        assert loaded['systems'][0]['system_name'] == '1DQ1-A'
        assert loaded['transfers'][0]['amount'] == 50
        assert loaded['catalog'] == []

    def test_load_missing_file_returns_default(self, tmp_path, monkeypatch):
        import workforce_plan as wp
        monkeypatch.setattr(wp, 'PLAN_PATH', str(tmp_path / 'does-not-exist.json'))
        p = wp.load_plan()
        assert p['systems'] == []
        assert len(p['catalog']) > 0

    def test_load_corrupt_file_returns_default(self, tmp_path, monkeypatch):
        import workforce_plan as wp
        bad = tmp_path / 'workforce_plan.json'
        bad.write_text('{ not json', encoding='utf-8')
        monkeypatch.setattr(wp, 'PLAN_PATH', str(bad))
        p = wp.load_plan()
        assert p['systems'] == []
