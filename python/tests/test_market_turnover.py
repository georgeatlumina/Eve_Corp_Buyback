"""Unit tests for the Market-tab turnover helpers (net on-book change)."""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

WINDOWS = (('24h', 1), ('72h', 3), ('weekly', 7), ('monthly', 30))


def _summ(sell, buy):
    return {'total_sell_value': float(sell), 'total_buy_value': float(buy), 'types': 1}


class TestSelectBaselines:
    def test_empty(self):
        from server import _select_baselines
        assert _select_baselines([], WINDOWS) == {}

    def test_single_snapshot_all_insufficient(self):
        from server import _select_baselines
        sel = _select_baselines(['2025-06-10'], WINDOWS)
        assert all(v[2] == 'insufficient' and v[1] is None for v in sel.values())

    def test_picks_most_recent_on_or_before_target(self):
        from server import _select_baselines
        dates = ['2025-06-01', '2025-06-07', '2025-06-09', '2025-06-10']  # latest = 06-10
        sel = _select_baselines(dates, WINDOWS)
        # 24h: target 06-09 -> baseline 06-09 (exact)
        assert sel['24h'] == (1, '2025-06-09', 'ok')
        # 72h: target 06-07 -> baseline 06-07
        assert sel['72h'] == (3, '2025-06-07', 'ok')
        # weekly: target 06-03 -> most recent <= is 06-01
        assert sel['weekly'] == (7, '2025-06-01', 'ok')

    def test_partial_when_no_snapshot_old_enough(self):
        from server import _select_baselines
        dates = ['2025-06-09', '2025-06-10']  # latest 06-10, only 1 day of history
        sel = _select_baselines(dates, WINDOWS)
        # monthly can't reach 30 days back -> partial, uses oldest
        assert sel['monthly'] == (30, '2025-06-09', 'partial')
        # 24h target 06-09 -> exact baseline ok
        assert sel['24h'] == (1, '2025-06-09', 'ok')


class TestComputeTurnover:
    def test_empty(self):
        from server import _compute_turnover
        assert _compute_turnover([], {}, WINDOWS) == []

    def test_single_snapshot_yields_null_deltas(self):
        from server import _compute_turnover
        dates = ['2025-06-10']
        rows = _compute_turnover(dates, {'2025-06-10': _summ(100, 50)}, WINDOWS)
        assert len(rows) == 4
        for r in rows:
            assert r['coverage'] == 'insufficient'
            assert r['delta_sell_value'] is None
            assert r['latest_sell_value'] == 100

    def test_deltas_and_pct(self):
        from server import _compute_turnover
        dates = ['2025-06-09', '2025-06-10']
        summaries = {'2025-06-09': _summ(1000, 400), '2025-06-10': _summ(1200, 300)}
        rows = {r['key']: r for r in _compute_turnover(dates, summaries, WINDOWS)}
        # 24h: baseline 06-09 (exact), delta sell +200, buy -100
        r24 = rows['24h']
        assert r24['coverage'] == 'ok'
        assert r24['delta_sell_value'] == 200
        assert r24['delta_buy_value'] == -100
        assert r24['pct_sell'] == 20.0
        assert r24['pct_buy'] == -25.0
        # weekly: no snapshot 7d back -> partial, baseline = oldest (06-09)
        assert rows['weekly']['coverage'] == 'partial'
        assert rows['weekly']['delta_sell_value'] == 200

    def test_pct_none_when_baseline_zero(self):
        from server import _compute_turnover
        dates = ['2025-06-09', '2025-06-10']
        summaries = {'2025-06-09': _summ(0, 0), '2025-06-10': _summ(500, 100)}
        r24 = {r['key']: r for r in _compute_turnover(dates, summaries, WINDOWS)}['24h']
        assert r24['delta_sell_value'] == 500
        assert r24['pct_sell'] is None
