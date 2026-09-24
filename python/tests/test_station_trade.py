"""Tests for the station-trading analysis.

The money maths and the fold that builds a station's book from a region's order
pages — both pure, so none of this touches the network.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import station_trade as stq  # noqa: E402


def order(loc, tid, price, vol, buy=False):
    return {'location_id': loc, 'type_id': tid, 'price': price,
            'volume_remain': vol, 'is_buy_order': buy}


class TestFold:
    def test_best_prices_and_depth_in_one_pass(self):
        book = {}
        for o in [order(60003760, 34, 5.0, 100), order(60003760, 34, 4.0, 50),
                  order(60003760, 34, 4.0, 25), order(60003760, 34, 9.0, 10),
                  order(60003760, 34, 3.0, 70, buy=True), order(60003760, 34, 3.5, 20, buy=True)]:
            stq._fold(book, o)
        e = book[60003760][34]
        assert e['ask'] == 4.0            # lowest sell
        assert e['ask_vol'] == 75         # 50 + 25, both at the best price
        assert e['ask_depth'] == 185      # everything on the sell side
        assert e['bid'] == 3.5            # highest buy
        assert e['bid_vol'] == 20
        assert e['bid_depth'] == 90

    def test_player_structures_are_skipped(self):
        """Structure markets need an authorized character with docking access,
        so an order at one can't be read and must not look like a station's."""
        book = {}
        stq._fold(book, order(1_040_000_000_000, 34, 5.0, 100))
        assert book == {}

    @pytest.mark.parametrize('bad', [
        {'location_id': 0, 'type_id': 34, 'price': 5, 'volume_remain': 1},
        {'location_id': 60003760, 'type_id': 0, 'price': 5, 'volume_remain': 1},
        {'location_id': 60003760, 'type_id': 34, 'price': 0, 'volume_remain': 1},
        {'location_id': 60003760, 'type_id': 34, 'price': 5, 'volume_remain': 0},
    ])
    def test_unusable_orders_are_dropped(self, bad):
        book = {}
        stq._fold(book, bad)
        assert book == {}


class TestEvaluate:
    def _books(self, ask=100.0, ask_vol=10, bid=140.0, bid_vol=8, far_ask=200.0):
        buy = {34: {'ask': ask, 'ask_vol': ask_vol, 'ask_depth': ask_vol, 'ask_orders': 5,
                    'bid': None, 'bid_vol': 0, 'bid_depth': 0, 'bid_orders': 0}}
        sell = {34: {'ask': far_ask, 'ask_vol': 4, 'ask_depth': 4, 'ask_orders': 5,
                     'bid': bid, 'bid_vol': bid_vol, 'bid_depth': bid_vol, 'bid_orders': 5}}
        return buy, sell

    def test_instant_pays_tax_only(self):
        """Taking an existing order costs no broker fee — only the sale is taxed."""
        buy, sell = self._books()
        r = stq.evaluate(buy, sell, sales_tax=0.1, broker_fee=0.05)[0]
        assert r['instant_profit'] == pytest.approx(140 * 0.9 - 100)

    def test_patient_pays_broker_as_well(self):
        buy, sell = self._books()
        r = stq.evaluate(buy, sell, sales_tax=0.1, broker_fee=0.05)[0]
        assert r['patient_profit'] == pytest.approx(200 * (1 - 0.1 - 0.05) - 100)

    def test_tradeable_is_the_thinner_of_the_two_sides(self):
        buy, sell = self._books(ask_vol=10, bid_vol=3)
        assert stq.evaluate(buy, sell)[0]['tradeable'] == 3
        buy, sell = self._books(ask_vol=2, bid_vol=30)
        assert stq.evaluate(buy, sell)[0]['tradeable'] == 2

    def test_a_loss_on_both_plays_is_not_returned(self):
        buy, sell = self._books(ask=500.0, bid=100.0, far_ask=120.0)
        assert stq.evaluate(buy, sell) == []

    def test_an_item_absent_at_either_end_is_skipped(self):
        buy, sell = self._books()
        assert stq.evaluate(buy, {}) == []
        assert stq.evaluate({}, sell) == []

    def test_nothing_for_sale_at_the_buy_end_is_skipped(self):
        """A bid-only book at A means there's nothing there to buy."""
        buy, sell = self._books()
        buy[34]['ask'] = None
        assert stq.evaluate(buy, sell) == []

    def test_thin_books_are_filtered_by_order_count(self):
        """A hull listed once at each end scores hugely on raw spread and is not
        a market — order count is the free liquidity hint that drops it."""
        buy, sell = self._books()
        buy[34]['ask_orders'] = 1
        assert stq.evaluate(buy, sell, min_orders=2) == []
        assert stq.evaluate(buy, sell, min_orders=0) != []

    @pytest.mark.parametrize('kwargs,expect_empty', [
        ({'min_units': 99}, True),
        ({'min_units': 1}, False),
        ({'min_margin': 0.9}, True),
        ({'min_margin': 0.01}, False),
        ({'min_profit': 1e9}, True),
        ({'max_buy_price': 50}, True),
        ({'max_buy_price': 5000}, False),
    ])
    def test_filters(self, kwargs, expect_empty):
        buy, sell = self._books()
        assert (stq.evaluate(buy, sell, **kwargs) == []) is expect_empty

    def test_rows_are_ranked_by_total_not_unit_profit(self):
        """Pre-ranking is on total realisable spread; a fat margin on two units
        shouldn't outrank a thin one on thousands."""
        buy = {
            1: {'ask': 100.0, 'ask_vol': 2, 'ask_depth': 2, 'ask_orders': 9, 'bid': None, 'bid_vol': 0, 'bid_depth': 0, 'bid_orders': 0},
            2: {'ask': 10.0, 'ask_vol': 5000, 'ask_depth': 5000, 'ask_orders': 9, 'bid': None, 'bid_vol': 0, 'bid_depth': 0, 'bid_orders': 0},
        }
        sell = {
            1: {'ask': 0, 'ask_vol': 0, 'ask_depth': 0, 'ask_orders': 9, 'bid': 200.0, 'bid_vol': 2, 'bid_depth': 2, 'bid_orders': 9},
            2: {'ask': 0, 'ask_vol': 0, 'ask_depth': 0, 'ask_orders': 9, 'bid': 13.0, 'bid_vol': 5000, 'bid_depth': 5000, 'bid_orders': 9},
        }
        rows = stq.evaluate(buy, sell, sales_tax=0.0, broker_fee=0.0)
        assert [r['type_id'] for r in rows] == [2, 1]


class TestHubs:
    def test_the_bundled_hubs_all_resolve_to_a_region(self):
        """A hub whose region can't be resolved can't be fetched at all, so a
        bad id here would break the feature silently."""
        info = stq.hubs('EveCorpBuyback/1.0 (test)')
        assert len(info) == len(stq.HUB_STATION_IDS)
        for h in info:
            assert h['region_id'], f"{h['name']} has no region id"
            assert h['system'] and h['region']

    def test_known_hub_identities(self):
        by_id = {h['station_id']: h for h in stq.hubs('EveCorpBuyback/1.0 (test)')}
        assert by_id[60003760]['system'] == 'Jita'
        assert by_id[60003760]['region'] == 'The Forge'
        assert by_id[60008494]['system'] == 'Amarr'
        assert by_id[60008494]['region'] == 'Domain'
