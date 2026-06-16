"""Unit tests for the Hooks & Hubs fuel helpers in server.py."""
import sys
import os
import datetime

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


class TestClassifyStructure:
    def test_skyhook(self):
        from server import _classify_structure
        assert _classify_structure('Orbital Skyhook') == 'skyhook'
        assert _classify_structure('ORBITAL SKYHOOK') == 'skyhook'

    def test_hub(self):
        from server import _classify_structure
        assert _classify_structure('Sovereignty Hub') == 'hub'

    def test_other_and_none(self):
        from server import _classify_structure
        assert _classify_structure('Astrahus') == 'other'
        assert _classify_structure('') == 'other'
        assert _classify_structure(None) == 'other'


class TestParseEsiTime:
    def test_z_suffix_round_trips(self):
        from server import _parse_esi_time
        v = _parse_esi_time('2025-06-20T12:00:00Z')
        expected = datetime.datetime(2025, 6, 20, 12, 0, 0, tzinfo=datetime.timezone.utc).timestamp()
        assert v is not None and abs(v - expected) < 1

    def test_none_and_junk(self):
        from server import _parse_esi_time
        assert _parse_esi_time(None) is None
        assert _parse_esi_time('') is None
        assert _parse_esi_time('not-a-date') is None
