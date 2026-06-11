"""Unit tests for the Amarr sell-price endpoint (Janice/ESI) and ESI market fetch."""
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

@pytest.fixture(autouse=True)
def clear_cache():
    import server
    server._amarr_price_cache.clear()
    yield
    server._amarr_price_cache.clear()


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient
    import server
    return TestClient(server.app)


SAMPLE_ORDERS = [
    {'is_buy_order': False, 'system_id': 30002187, 'price': 200_000_000.0},
    {'is_buy_order': False, 'system_id': 30002187, 'price': 170_000_000.0},
    {'is_buy_order': False, 'system_id': 30000142, 'price': 150_000_000.0},  # Jita — ignored
    {'is_buy_order': True,  'system_id': 30002187, 'price': 100_000_000.0},  # buy — ignored
]


class TestAmarrSellEndpointJanice:
    """Tests for the Janice path (API key configured)."""

    def test_returns_min_sell_from_janice(self, client):
        with patch('server.fetch_type_sell_price', return_value=170_000_000.0), \
             patch('server.load_config', return_value={'janice_api_key': 'key'}):
            resp = client.get('/api/market/amarr-sell?type_id=11993')
        assert resp.status_code == 200
        assert resp.json()['min_sell'] == 170_000_000.0

    def test_returns_null_when_janice_returns_none(self, client):
        with patch('server.fetch_type_sell_price', return_value=None), \
             patch('server.load_config', return_value={'janice_api_key': 'key'}):
            resp = client.get('/api/market/amarr-sell?type_id=11993')
        assert resp.status_code == 200
        assert resp.json()['min_sell'] is None

    def test_502_on_janice_failure(self, client):
        with patch('server.fetch_type_sell_price', side_effect=Exception('timeout')), \
             patch('server.load_config', return_value={'janice_api_key': 'key'}):
            resp = client.get('/api/market/amarr-sell?type_id=11993')
        assert resp.status_code == 502

    def test_passes_amarr_market_and_api_key(self, client):
        with patch('server.fetch_type_sell_price', return_value=100.0) as mock_fetch, \
             patch('server.load_config', return_value={'janice_api_key': 'test-key'}):
            client.get('/api/market/amarr-sell?type_id=11993')
        mock_fetch.assert_called_once_with(11993, 'Amarr', api_key='test-key')


class TestAmarrSellEndpointESI:
    """Tests for the ESI fallback path (no API key)."""

    def test_returns_min_sell_order_in_amarr(self, client):
        with patch('server.fetch_region_market_orders', return_value=SAMPLE_ORDERS), \
             patch('server.load_config', return_value={'janice_api_key': ''}):
            resp = client.get('/api/market/amarr-sell?type_id=11993')
        assert resp.status_code == 200
        assert resp.json()['min_sell'] == 170_000_000.0

    def test_returns_null_when_no_orders(self, client):
        with patch('server.fetch_region_market_orders', return_value=[]), \
             patch('server.load_config', return_value={'janice_api_key': ''}):
            resp = client.get('/api/market/amarr-sell?type_id=11993')
        assert resp.json()['min_sell'] is None

    def test_502_on_esi_failure(self, client):
        with patch('server.fetch_region_market_orders', side_effect=Exception('timeout')), \
             patch('server.load_config', return_value={'janice_api_key': ''}):
            resp = client.get('/api/market/amarr-sell?type_id=11993')
        assert resp.status_code == 502


class TestAmarrSellCache:
    def test_caches_result_on_second_call(self, client):
        with patch('server.fetch_type_sell_price', return_value=170_000_000.0) as mock_fetch, \
             patch('server.load_config', return_value={'janice_api_key': 'key'}):
            client.get('/api/market/amarr-sell?type_id=11993')
            client.get('/api/market/amarr-sell?type_id=11993')
        assert mock_fetch.call_count == 1

    def test_cache_expires_after_ttl(self, client):
        import server
        with patch('server.fetch_type_sell_price', return_value=170_000_000.0) as mock_fetch, \
             patch('server.load_config', return_value={'janice_api_key': 'key'}):
            client.get('/api/market/amarr-sell?type_id=11993')
            server._amarr_price_cache[11993]['fetched_at'] -= server._AMARR_PRICE_TTL + 1
            client.get('/api/market/amarr-sell?type_id=11993')
        assert mock_fetch.call_count == 2
