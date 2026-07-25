"""Tests for contract-scan run history (python/scan_history.py).

Design: docs/superpowers/specs/2026-07-24-scan-history-design.md

Every test patches HISTORY_PATH to a tmp file — none of these may touch the
real AUTH_DIR, which holds the user's tokens and config.
"""
import json
import os
import stat
import sys
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import scan_history  # noqa: E402
from scan_history import (  # noqa: E402
    MAX_RUNS,
    ScanMetrics,
    append_run,
    empty_history,
    load_history,
    normalize,
)


@pytest.fixture
def store(tmp_path):
    """Point the store at a throwaway file for the duration of a test."""
    path = str(tmp_path / 'scan_history.json')
    with patch.object(scan_history, 'HISTORY_PATH', path):
        yield path


class FakeClock:
    """Monotonic clock we drive by hand, so phase timing needs no sleeps."""

    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t

    def advance(self, seconds):
        self.t += seconds


def _metrics(alliance='main'):
    clock = FakeClock()
    m = ScanMetrics(alliance=alliance, clock=clock, now=lambda: '2026-07-24T23:41:02Z')
    return m, clock


# ---------------------------------------------------------------------------
# ScanMetrics accumulator
# ---------------------------------------------------------------------------

class TestScanMetricsCounters:
    def test_counts_live_and_cached_fetches_separately(self):
        m, _ = _metrics()
        m.record_fetch()
        m.record_fetch()
        m.record_fetch(cached=True)
        rec = m.finish(contracts=3, corps_scanned=1, items_failed=0)
        assert rec['items_fetched'] == 2
        assert rec['items_cached'] == 1

    def test_buckets_errors_by_status(self):
        m, _ = _metrics()
        m.record_error(520)
        m.record_error(520)
        m.record_error(403)
        rec = m.finish(contracts=0, corps_scanned=1, items_failed=0)
        assert rec['esi_errors'] == {'520': 2, '403': 1}

    def test_error_with_unknown_status_buckets_under_none(self):
        m, _ = _metrics()
        m.record_error(None)
        rec = m.finish(contracts=0, corps_scanned=1, items_failed=0)
        assert rec['esi_errors'] == {'unknown': 1}

    def test_counts_retries(self):
        m, _ = _metrics()
        for _ in range(4):
            m.record_retry()
        rec = m.finish(contracts=0, corps_scanned=1, items_failed=0)
        assert rec['retries'] == 4

    def test_records_sweep_outcome(self):
        m, _ = _metrics()
        m.record_sweep(attempted=31, recovered=30)
        rec = m.finish(contracts=0, corps_scanned=1, items_failed=1)
        assert rec['sweep_attempted'] == 31
        assert rec['sweep_recovered'] == 30

    def test_sweep_defaults_to_zero_when_none_ran(self):
        m, _ = _metrics()
        rec = m.finish(contracts=5, corps_scanned=1, items_failed=0)
        assert rec['sweep_attempted'] == 0
        assert rec['sweep_recovered'] == 0

    def test_fetch_totals_reconcile_against_contracts(self):
        """The invariant the spec promises analysts."""
        m, _ = _metrics()
        for _ in range(150):
            m.record_fetch()
        for _ in range(3):
            m.record_fetch(cached=True)
        rec = m.finish(contracts=154, corps_scanned=2, items_failed=1)
        assert rec['items_fetched'] + rec['items_cached'] + rec['items_failed'] == rec['contracts']

    def test_passthrough_fields(self):
        m, _ = _metrics(alliance='institute')
        rec = m.finish(contracts=12, corps_scanned=3, items_failed=2)
        assert rec['alliance'] == 'institute'
        assert rec['contracts'] == 12
        assert rec['corps_scanned'] == 3
        assert rec['items_failed'] == 2
        assert rec['started'] == '2026-07-24T23:41:02Z'


class TestScanMetricsTiming:
    def test_phase_durations_use_injected_clock(self):
        m, clock = _metrics()
        m.start_phase('contracts')
        clock.advance(12.4)
        m.end_phase('contracts')
        m.start_phase('items')
        clock.advance(61.1)
        m.end_phase('items')
        rec = m.finish(contracts=1, corps_scanned=1, items_failed=0)
        assert rec['phases']['contracts'] == pytest.approx(12.4)
        assert rec['phases']['items'] == pytest.approx(61.1)

    def test_total_seconds_spans_whole_scan(self):
        m, clock = _metrics()
        clock.advance(78.2)
        rec = m.finish(contracts=1, corps_scanned=1, items_failed=0)
        assert rec['seconds'] == pytest.approx(78.2)

    def test_unfinished_phase_is_omitted(self):
        m, clock = _metrics()
        m.start_phase('items')
        clock.advance(5)
        rec = m.finish(contracts=1, corps_scanned=1, items_failed=0)
        assert 'items' not in rec['phases']

    def test_seconds_includes_sweep_pause(self):
        """Spec calls this out: a swept run carries the 15s pause in `seconds`."""
        m, clock = _metrics()
        m.start_phase('items')
        clock.advance(40.0)
        m.end_phase('items')
        clock.advance(15.0)  # the sweep pause
        m.record_sweep(attempted=3, recovered=3)
        rec = m.finish(contracts=3, corps_scanned=1, items_failed=0)
        assert rec['seconds'] >= 55.0


class TestScanMetricsThreadSafety:
    def test_concurrent_reporting_loses_no_counts(self):
        import threading
        m, _ = _metrics()

        def worker():
            for _ in range(200):
                m.record_fetch()
                m.record_retry()
                m.record_error(520)

        threads = [threading.Thread(target=worker) for _ in range(3)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        rec = m.finish(contracts=600, corps_scanned=1, items_failed=0)
        assert rec['items_fetched'] == 600
        assert rec['retries'] == 600
        assert rec['esi_errors']['520'] == 600


# ---------------------------------------------------------------------------
# Store
# ---------------------------------------------------------------------------

class TestStore:
    def test_missing_file_loads_empty(self, store):
        assert load_history() == empty_history()

    def test_corrupt_file_loads_empty_rather_than_raising(self, store):
        with open(store, 'w') as f:
            f.write('{not json at all')
        assert load_history() == empty_history()

    def test_non_dict_document_normalizes(self):
        assert normalize([1, 2, 3]) == empty_history()
        assert normalize({'runs': 'nope'}) == empty_history()

    def test_append_then_load_round_trips(self, store):
        append_run({'seconds': 78.2, 'contracts': 154})
        runs = load_history()['runs']
        assert len(runs) == 1
        assert runs[0]['contracts'] == 154

    def test_appends_in_order(self, store):
        for i in range(3):
            append_run({'seconds': float(i)})
        assert [r['seconds'] for r in load_history()['runs']] == [0.0, 1.0, 2.0]

    def test_ring_buffer_keeps_newest_and_trims_at_max(self, store):
        for i in range(MAX_RUNS + 25):
            append_run({'n': i})
        runs = load_history()['runs']
        assert len(runs) == MAX_RUNS
        assert runs[0]['n'] == 25, 'oldest rows dropped'
        assert runs[-1]['n'] == MAX_RUNS + 24, 'newest row kept'

    def test_write_leaves_no_temp_file(self, store):
        append_run({'n': 1})
        leftovers = [p for p in os.listdir(os.path.dirname(store)) if p.endswith('.tmp')]
        assert leftovers == []

    @pytest.mark.skipif(os.name == 'nt', reason='POSIX permission bits are not meaningful on Windows')
    def test_file_is_chmod_600(self, store):
        append_run({'n': 1})
        assert stat.S_IMODE(os.stat(store).st_mode) == 0o600

    def test_written_file_is_readable_json(self, store):
        append_run({'seconds': 1.5})
        with open(store) as f:
            assert json.load(f)['runs'][0]['seconds'] == 1.5


# ---------------------------------------------------------------------------
# Build tagging
# ---------------------------------------------------------------------------

class TestGitInfo:
    def setup_method(self):
        scan_history._git_info_cache = None

    def teardown_method(self):
        scan_history._git_info_cache = None

    def test_reads_sha_and_clean_tree(self):
        def fake_run(cmd, **kwargs):
            class R:
                returncode = 0
                stdout = 'b209556\n' if 'rev-parse' in cmd else ''
            return R()

        with patch('scan_history.subprocess.run', side_effect=fake_run):
            info = scan_history.git_info()
        assert info == {'git': 'b209556', 'dirty': False}

    def test_detects_dirty_tree(self):
        def fake_run(cmd, **kwargs):
            class R:
                returncode = 0
                stdout = 'b209556\n' if 'rev-parse' in cmd else ' M python/server.py\n'
            return R()

        with patch('scan_history.subprocess.run', side_effect=fake_run):
            info = scan_history.git_info()
        assert info == {'git': 'b209556', 'dirty': True}

    def test_falls_back_to_null_when_git_missing(self):
        with patch('scan_history.subprocess.run', side_effect=FileNotFoundError()):
            info = scan_history.git_info()
        assert info == {'git': None, 'dirty': None}

    def test_falls_back_to_null_on_timeout(self):
        import subprocess as sp
        with patch('scan_history.subprocess.run', side_effect=sp.TimeoutExpired('git', 2)):
            info = scan_history.git_info()
        assert info == {'git': None, 'dirty': None}

    def test_memoized_across_calls(self):
        calls = []

        def fake_run(cmd, **kwargs):
            calls.append(cmd)

            class R:
                returncode = 0
                stdout = 'abc1234\n' if 'rev-parse' in cmd else ''
            return R()

        with patch('scan_history.subprocess.run', side_effect=fake_run):
            scan_history.git_info()
            scan_history.git_info()
            scan_history.git_info()
        assert len(calls) == 2, 'two git commands once, not per call'


class TestRecordIncludesBuildTag:
    def test_finish_stamps_git_and_version(self):
        m, _ = _metrics()
        with patch('scan_history.git_info', return_value={'git': 'b209556', 'dirty': False}), \
             patch('scan_history.app_version', return_value='2.0.3'):
            rec = m.finish(contracts=1, corps_scanned=1, items_failed=0)
        assert rec['git'] == 'b209556'
        assert rec['dirty'] is False
        assert rec['app_version'] == '2.0.3'
