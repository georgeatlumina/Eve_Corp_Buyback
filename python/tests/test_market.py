"""Unit tests for the Amarr sell-price endpoint and ESI market fetch."""
import sys
import os
import time
from unittest.mock import patch, MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


# ── fetch_region_market_orders ────────────────────────────────────────────────

class TestFetchRegionMarketOrders:
    def _make_response(self, orders, pages=1):
        resp = MagicMock()
        resp.raise_for_status = MagicMock()
        resp.json.return_value = orders
        resp.headers = {'x-pages': str(pages)}
        return resp

    def test_returns_all_orders_single_page(self):
        from esi import fetch_region_market_orders
        orders = [{'type_id': 11993, 'price': 170e6, 'is_buy_order': False, 'location_id': 60008494}]
        with patch('esi.requests.get', return_value=self._make_response(orders)):
            result = fetch_region_market_orders(10000043, 11993, 'TestAgent')
        assert result == orders

    def test_paginates_until_empty(self):
        from esi import fetch_region_market_orders
        page1 = [{'type_id': 11993, 'price': 170e6}]
        page2 = [{'type_id': 11993, 'price': 180e6}]

        responses = [
            self._make_response(page1, pages=2),
            self._make_response(page2, pages=2),
        ]
        with patch('esi.requests.get', side_effect=responses):
            result = fetch_region_market_orders(10000043, 11993, 'TestAgent')
        assert len(result) == 2

    def test_passes_correct_params(self):
        from esi import fetch_region_market_orders
        with patch('esi.requests.get', return_value=self._make_response([])) as mock_get:
            fetch_region_market_orders(10000043, 11993, 'TestAgent', order_type='sell')
        call_params = mock_get.call_args[1]['params']
        assert call_params['type_id'] == 11993
        assert call_params['order_type'] == 'sell'
        assert call_params['datasource'] == 'tranquility'


# ── /api/market/amarr-sell endpoint ──────────────────────────────────────────

SAMPLE_ORDERS = [
    # Two sell orders at Amarr station — cheapest is 170M
    {'is_buy_order': False, 'location_id': 60008494, 'price': 200_000_000.0},
    {'is_buy_order': False, 'location_id': 60008494, 'price': 170_000_000.0},
    # Sell order at a different station (Jita) — must be ignored
    {'is_buy_order': False, 'location_id': 60003760, 'price': 150_000_000.0},
    # Buy order at Amarr — must be ignored
    {'is_buy_order': True,  'location_id': 60008494, 'price': 100_000_000.0},
]


@pytest.fixture(autouse=True)
def clear_cache():
    """Reset the Amarr price cache between tests."""
    import server
    server._amarr_price_cache.clear()
    yield
    server._amarr_price_cache.clear()


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient
    import server
    return TestClient(server.app)


class TestAmarrSellEndpoint:
    def test_returns_min_sell_at_amarr_station(self, client):
        with patch('server.fetch_region_market_orders', return_value=SAMPLE_ORDERS):
            resp = client.get('/api/market/amarr-sell?type_id=11993')
        assert resp.status_code == 200
        assert resp.json()['min_sell'] == 170_000_000.0

    def test_ignores_buy_orders(self, client):
        orders = [{'is_buy_order': True, 'location_id': 60008494, 'price': 50_000_000.0}]
        with patch('server.fetch_region_market_orders', return_value=orders):
            resp = client.get('/api/market/amarr-sell?type_id=11993')
        assert resp.json()['min_sell'] is None

    def test_ignores_orders_at_other_stations(self, client):
        orders = [{'is_buy_order': False, 'location_id': 60003760, 'price': 100_000_000.0}]
        with patch('server.fetch_region_market_orders', return_value=orders):
            resp = client.get('/api/market/amarr-sell?type_id=11993')
        assert resp.json()['min_sell'] is None

    def test_returns_null_min_sell_when_no_orders(self, client):
        with patch('server.fetch_region_market_orders', return_value=[]):
            resp = client.get('/api/market/amarr-sell?type_id=11993')
        data = resp.json()
        assert data['min_sell'] is None
        assert data['order_count'] == 0

    def test_returns_correct_order_count(self, client):
        with patch('server.fetch_region_market_orders', return_value=SAMPLE_ORDERS):
            resp = client.get('/api/market/amarr-sell?type_id=11993')
        assert resp.json()['order_count'] == 2  # only Amarr sell orders

    def test_caches_result_on_second_call(self, client):
        with patch('server.fetch_region_market_orders', return_value=SAMPLE_ORDERS) as mock_fetch:
            client.get('/api/market/amarr-sell?type_id=11993')
            client.get('/api/market/amarr-sell?type_id=11993')
        assert mock_fetch.call_count == 1

    def test_cache_expires_after_ttl(self, client):
        import server
        with patch('server.fetch_region_market_orders', return_value=SAMPLE_ORDERS) as mock_fetch:
            client.get('/api/market/amarr-sell?type_id=11993')
            # Manually expire the cache entry
            server._amarr_price_cache[11993]['fetched_at'] -= server._AMARR_PRICE_TTL + 1
            client.get('/api/market/amarr-sell?type_id=11993')
        assert mock_fetch.call_count == 2

    def test_502_on_esi_failure(self, client):
        with patch('server.fetch_region_market_orders', side_effect=Exception('timeout')):
            resp = client.get('/api/market/amarr-sell?type_id=11993')
        assert resp.status_code == 502
