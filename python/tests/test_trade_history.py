"""Tests for the recorded station-pair spread series.

ESI publishes market history per region only, so the spread between two specific
stations exists nowhere and can only be accrued — one point per day, written
from request threads. These pin the daily semantics and the ring-buffer bounds.
"""
import os
import sys
from datetime import datetime, timedelta, timezone

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


@pytest.fixture()
def store(tmp_path, monkeypatch):
    import trade_history as th
    monkeypatch.setattr(th, 'STORE_PATH', str(tmp_path / 'trade_history.json'))
    return th


DAY = datetime(2026, 9, 24, 12, 0, tzinfo=timezone.utc)


class TestRecord:
    def test_a_point_round_trips(self, store):
        store.record(34, 1, 2, ask=100.0, bid=140.0, when=DAY)
        series = store.load_series(34, 1, 2)
        assert len(series) == 1
        assert series[0]['d'] == '2026-09-24'
        assert series[0]['margin'] == pytest.approx(0.4)

    def test_repeat_looks_the_same_day_replace_rather_than_pile_up(self, store):
        """Checking the tab six times in an afternoon must not make six points."""
        for bid in (140.0, 150.0, 160.0):
            store.record(34, 1, 2, ask=100.0, bid=bid, when=DAY)
        series = store.load_series(34, 1, 2)
        assert len(series) == 1
        assert series[0]['bid'] == 160.0      # the last look of the day wins

    def test_a_new_day_appends(self, store):
        store.record(34, 1, 2, ask=100.0, bid=140.0, when=DAY)
        store.record(34, 1, 2, ask=100.0, bid=150.0, when=DAY + timedelta(days=1))
        assert [p['d'] for p in store.load_series(34, 1, 2)] == ['2026-09-24', '2026-09-25']

    def test_a_negative_spread_is_recorded_not_dropped(self, store):
        """The pair paying the other way is a real and useful state."""
        store.record(34, 1, 2, ask=140.0, bid=100.0, when=DAY)
        assert store.load_series(34, 1, 2)[0]['margin'] < 0

    @pytest.mark.parametrize('ask,bid', [(0, 140.0), (100.0, 0), (None, None)])
    def test_a_missing_side_records_nothing(self, store, ask, bid):
        assert store.record(34, 1, 2, ask=ask, bid=bid, when=DAY) is None
        assert store.load_series(34, 1, 2) == []

    def test_pairs_are_kept_apart(self, store):
        store.record(34, 1, 2, ask=100.0, bid=140.0, when=DAY)
        store.record(34, 2, 1, ask=100.0, bid=110.0, when=DAY)
        store.record(35, 1, 2, ask=100.0, bid=120.0, when=DAY)
        assert store.load_series(34, 1, 2)[0]['bid'] == 140.0
        assert store.load_series(34, 2, 1)[0]['bid'] == 110.0
        assert store.load_series(35, 1, 2)[0]['bid'] == 120.0

    def test_an_unknown_pair_is_empty_not_an_error(self, store):
        assert store.load_series(999, 1, 2) == []


class TestBounds:
    def test_a_series_is_capped(self, store):
        for i in range(store.MAX_POINTS + 25):
            store.record(34, 1, 2, ask=100.0, bid=140.0, when=DAY + timedelta(days=i))
        series = store.load_series(34, 1, 2)
        assert len(series) == store.MAX_POINTS
        # The oldest go, not the newest.
        assert series[-1]['d'] == (DAY + timedelta(days=store.MAX_POINTS + 24)).strftime('%Y-%m-%d')

    def test_series_count_is_capped_dropping_the_stalest(self, store):
        """Eviction has to be by age — dropping an arbitrary series would lose
        the one someone is actively watching."""
        store.record(1, 1, 2, ask=100.0, bid=140.0, when=DAY)          # stale
        for i in range(store.MAX_SERIES + 5):
            store.record(100 + i, 1, 2, ask=100.0, bid=140.0, when=DAY + timedelta(days=30))
        assert store.load_series(1, 1, 2) == []                         # evicted
        assert store.stats()['series'] <= store.MAX_SERIES


class TestResilience:
    def test_a_corrupt_store_starts_over_rather_than_raising(self, store):
        """It shares the crash-safe helpers with the token cache; a bad file must
        degrade to an empty chart, never break the tab."""
        with open(store.STORE_PATH, 'w', encoding='utf-8') as f:
            f.write('{"broken": ')
        assert store.load_series(34, 1, 2) == []
        store.record(34, 1, 2, ask=100.0, bid=140.0, when=DAY)
        assert len(store.load_series(34, 1, 2)) == 1
