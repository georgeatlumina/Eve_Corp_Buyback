"""Tests for the shared corp-hangar-division selection store
(hangar_selection.py) used by both the Acquisitions and Stockpile ESI scans.
"""
import os
import sys
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


@pytest.fixture()
def sel_path(tmp_path):
    """Point the module at a throwaway file so tests never touch real data."""
    import hangar_selection
    p = tmp_path / 'hangar_selection.json'
    with patch.object(hangar_selection, 'STORE_PATH', str(p)), \
         patch.object(hangar_selection, 'AUTH_DIR', str(tmp_path)):
        yield hangar_selection, str(p)


class TestNormalize:
    def test_non_dict_becomes_empty(self, sel_path):
        hangar_selection, _ = sel_path
        assert hangar_selection.normalize([1, 2, 3]) == {'selected_flags': [], 'updated_at': ''}

    def test_drops_unknown_flags(self, sel_path):
        hangar_selection, _ = sel_path
        result = hangar_selection.normalize({'selected_flags': ['CorpSAG1', 'NotAFlag']})
        assert result['selected_flags'] == ['CorpSAG1']

    def test_collapses_hangarall_into_corpsag1(self, sel_path):
        hangar_selection, _ = sel_path
        result = hangar_selection.normalize({'selected_flags': ['HangarAll', 'CorpSAG3']})
        assert result['selected_flags'] == ['CorpSAG1', 'CorpSAG3']

    def test_dedupes_and_orders_by_division_number(self, sel_path):
        hangar_selection, _ = sel_path
        result = hangar_selection.normalize({'selected_flags': ['CorpSAG3', 'CorpSAG1', 'CorpSAG1']})
        assert result['selected_flags'] == ['CorpSAG1', 'CorpSAG3']

    def test_ignores_non_string_entries(self, sel_path):
        hangar_selection, _ = sel_path
        result = hangar_selection.normalize({'selected_flags': ['CorpSAG2', 42, None]})
        assert result['selected_flags'] == ['CorpSAG2']


class TestLocalStore:
    def test_missing_file_returns_empty_selection(self, sel_path):
        hangar_selection, _ = sel_path
        assert hangar_selection.load_selection_local() == hangar_selection.empty_selection()

    def test_reads_back_saved_selection(self, sel_path):
        hangar_selection, _ = sel_path
        hangar_selection.save_selection_local(
            hangar_selection.normalize({'selected_flags': ['CorpSAG2'],
                                        'updated_at': '2026-08-22T00:00:00+00:00'})
        )
        loaded = hangar_selection.load_selection_local()
        assert loaded['selected_flags'] == ['CorpSAG2']
        assert loaded['updated_at'] == '2026-08-22T00:00:00+00:00'

    def test_corrupt_json_degrades_to_empty(self, sel_path):
        hangar_selection, path = sel_path
        with open(path, 'w') as f:
            f.write('{ not json')
        assert hangar_selection.load_selection_local() == hangar_selection.empty_selection()
