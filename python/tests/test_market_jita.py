"""Unit tests for the Jita sell/buy price endpoints.

Both are new in this release: the quota bars now price at 120% of Jita sell
(previously 115% of Amarr sell), and HaulX prices whole fits from Jita sell
with Jita buy as the cost basis for its profit line.
"""
import os
import sys
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


@pytest.fixture(autouse=True)
def clear_cache():
    import server
    server._jita_sell_cache.clear()
    server._jita_buy_cache.clear()
    yield
    server._jita_sell_cache.clear()
    server._jita_buy_cache.clear()


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient
    import server
    return TestClient(server.app)


# Jita is system 30000142; anything else in the region must be ignored.
SAMPLE_ORDERS = [
    {'is_buy_order': False, 'system_id': 30000142, 'price': 180_000_000.0},
    {'is_buy_order': False, 'system_id': 30000142, 'price': 150_000_000.0},
    {'is_buy_order': False, 'system_id': 30002187, 'price': 100_000_000.0},  # Amarr — ignored
    {'is_buy_order': True,  'system_id': 30000142, 'price': 120_000_000.0},  # buy — ignored
]

TYPE_INFO = {'packaged_volume': 50000.0, 'volume': 500000.0}


# ── /api/market/jita-sell ────────────────────────────────────────────────────

class TestJitaSellJanice:
    """Janice path — an API key is configured."""

    def test_returns_min_sell_from_janice(self, client):
        with patch('server.fetch_type_sell_price', return_value=170_000_000.0), \
             patch('server.fetch_type_info', return_value=TYPE_INFO), \
             patch('server.load_config', return_value={'janice_api_key': 'key'}):
            resp = client.get('/api/market/jita-sell?type_id=11993')
        assert resp.status_code == 200
        assert resp.json()['min_sell'] == 170_000_000.0

    def test_reports_janice_as_the_source(self, client):
        with patch('server.fetch_type_sell_price', return_value=1.0), \
             patch('server.fetch_type_info', return_value=TYPE_INFO), \
             patch('server.load_config', return_value={'janice_api_key': 'key'}):
            resp = client.get('/api/market/jita-sell?type_id=11993')
        assert resp.json()['source'] == 'janice'

    def test_prices_against_jita_44(self, client):
        with patch('server.fetch_type_sell_price', return_value=1.0) as mock_fetch, \
             patch('server.fetch_type_info', return_value=TYPE_INFO), \
             patch('server.load_config', return_value={'janice_api_key': 'test-key'}):
            client.get('/api/market/jita-sell?type_id=11993')
        mock_fetch.assert_called_once_with(11993, 'Jita 4-4', api_key='test-key')

    def test_502_on_janice_failure(self, client):
        with patch('server.fetch_type_sell_price', side_effect=Exception('timeout')), \
             patch('server.fetch_type_info', return_value=TYPE_INFO), \
             patch('server.load_config', return_value={'janice_api_key': 'key'}):
            resp = client.get('/api/market/jita-sell?type_id=11993')
        assert resp.status_code == 502


class TestJitaSellESI:
    """ESI fallback path — no API key configured."""

    def test_returns_cheapest_jita_sell_order(self, client):
        with patch('server.fetch_region_market_orders', return_value=SAMPLE_ORDERS), \
             patch('server.fetch_type_info', return_value=TYPE_INFO), \
             patch('server.load_config', return_value={'janice_api_key': ''}):
            resp = client.get('/api/market/jita-sell?type_id=11993')
        assert resp.json()['min_sell'] == 150_000_000.0

    def test_ignores_buy_orders_and_other_systems(self, client):
        only_noise = [o for o in SAMPLE_ORDERS if o['system_id'] != 30000142 or o['is_buy_order']]
        with patch('server.fetch_region_market_orders', return_value=only_noise), \
             patch('server.fetch_type_info', return_value=TYPE_INFO), \
             patch('server.load_config', return_value={'janice_api_key': ''}):
            resp = client.get('/api/market/jita-sell?type_id=11993')
        assert resp.json()['min_sell'] is None

    def test_queries_the_forge(self, client):
        with patch('server.fetch_region_market_orders', return_value=[]) as mock_fetch, \
             patch('server.fetch_type_info', return_value=TYPE_INFO), \
             patch('server.load_config', return_value={'janice_api_key': ''}):
            client.get('/api/market/jita-sell?type_id=11993')
        assert mock_fetch.call_args[0][0] == 10000002  # The Forge

    def test_reports_esi_as_the_source(self, client):
        with patch('server.fetch_region_market_orders', return_value=SAMPLE_ORDERS), \
             patch('server.fetch_type_info', return_value=TYPE_INFO), \
             patch('server.load_config', return_value={'janice_api_key': ''}):
            resp = client.get('/api/market/jita-sell?type_id=11993')
        assert resp.json()['source'] == 'esi'

    def test_502_on_esi_failure(self, client):
        with patch('server.fetch_region_market_orders', side_effect=Exception('timeout')), \
             patch('server.fetch_type_info', return_value=TYPE_INFO), \
             patch('server.load_config', return_value={'janice_api_key': ''}):
            resp = client.get('/api/market/jita-sell?type_id=11993')
        assert resp.status_code == 502


class TestJitaSellPackagedVolume:
    """HaulX measures hauls with this field, so its failure modes matter."""

    def test_returns_packaged_volume(self, client):
        with patch('server.fetch_type_sell_price', return_value=1.0), \
             patch('server.fetch_type_info', return_value=TYPE_INFO), \
             patch('server.load_config', return_value={'janice_api_key': 'key'}):
            resp = client.get('/api/market/jita-sell?type_id=11993')
        assert resp.json()['packaged_volume'] == 50000.0

    def test_falls_back_to_volume_when_packaged_is_absent(self, client):
        with patch('server.fetch_type_sell_price', return_value=1.0), \
             patch('server.fetch_type_info', return_value={'volume': 2500.0}), \
             patch('server.load_config', return_value={'janice_api_key': 'key'}):
            resp = client.get('/api/market/jita-sell?type_id=11993')
        assert resp.json()['packaged_volume'] == 2500.0

    def test_null_volume_when_type_lookup_fails(self, client):
        with patch('server.fetch_type_sell_price', return_value=1.0), \
             patch('server.fetch_type_info', side_effect=Exception('esi down')), \
             patch('server.load_config', return_value={'janice_api_key': 'key'}):
            resp = client.get('/api/market/jita-sell?type_id=11993')
        assert resp.status_code == 200
        assert resp.json()['packaged_volume'] is None


class TestJitaSellCache:
    def test_caches_result_on_second_call(self, client):
        with patch('server.fetch_type_sell_price', return_value=1.0) as mock_fetch, \
             patch('server.fetch_type_info', return_value=TYPE_INFO), \
             patch('server.load_config', return_value={'janice_api_key': 'key'}):
            client.get('/api/market/jita-sell?type_id=11993')
            client.get('/api/market/jita-sell?type_id=11993')
        assert mock_fetch.call_count == 1

    def test_bust_forces_a_refresh(self, client):
        with patch('server.fetch_type_sell_price', return_value=1.0) as mock_fetch, \
             patch('server.fetch_type_info', return_value=TYPE_INFO), \
             patch('server.load_config', return_value={'janice_api_key': 'key'}):
            client.get('/api/market/jita-sell?type_id=11993')
            client.get('/api/market/jita-sell?type_id=11993&bust=true')
        assert mock_fetch.call_count == 2

    def test_cache_expires_after_ttl(self, client):
        import server
        with patch('server.fetch_type_sell_price', return_value=1.0) as mock_fetch, \
             patch('server.fetch_type_info', return_value=TYPE_INFO), \
             patch('server.load_config', return_value={'janice_api_key': 'key'}):
            client.get('/api/market/jita-sell?type_id=11993')
            server._jita_sell_cache[11993]['fetched_at'] -= server._JITA_PRICE_TTL + 1
            client.get('/api/market/jita-sell?type_id=11993')
        assert mock_fetch.call_count == 2


# ── /api/market/jita-buy ─────────────────────────────────────────────────────

class TestJitaBuy:
    def test_returns_max_buy(self, client):
        with patch('server.fetch_buy_prices', return_value={11993: 140_000_000.0}), \
             patch('server.load_config', return_value={'janice_api_key': 'key'}):
            resp = client.get('/api/market/jita-buy?type_id=11993')
        assert resp.status_code == 200
        assert resp.json()['max_buy'] == 140_000_000.0

    def test_422_without_a_janice_key(self, client):
        """Unlike jita-sell there is no ESI fallback — buy prices need Janice."""
        with patch('server.load_config', return_value={'janice_api_key': ''}):
            resp = client.get('/api/market/jita-buy?type_id=11993')
        assert resp.status_code == 422

    def test_prices_against_jita_44(self, client):
        with patch('server.fetch_buy_prices', return_value={11993: 1.0}) as mock_fetch, \
             patch('server.load_config', return_value={'janice_api_key': 'test-key'}):
            client.get('/api/market/jita-buy?type_id=11993')
        mock_fetch.assert_called_once_with([11993], 'Jita 4-4', api_key='test-key')

    def test_null_when_type_absent_from_response(self, client):
        with patch('server.fetch_buy_prices', return_value={}), \
             patch('server.load_config', return_value={'janice_api_key': 'key'}):
            resp = client.get('/api/market/jita-buy?type_id=11993')
        assert resp.json()['max_buy'] is None

    def test_502_on_janice_failure(self, client):
        with patch('server.fetch_buy_prices', side_effect=Exception('timeout')), \
             patch('server.load_config', return_value={'janice_api_key': 'key'}):
            resp = client.get('/api/market/jita-buy?type_id=11993')
        assert resp.status_code == 502

    def test_caches_result_on_second_call(self, client):
        with patch('server.fetch_buy_prices', return_value={11993: 1.0}) as mock_fetch, \
             patch('server.load_config', return_value={'janice_api_key': 'key'}):
            client.get('/api/market/jita-buy?type_id=11993')
            client.get('/api/market/jita-buy?type_id=11993')
        assert mock_fetch.call_count == 1

    def test_cache_expires_after_ttl(self, client):
        import server
        with patch('server.fetch_buy_prices', return_value={11993: 1.0}) as mock_fetch, \
             patch('server.load_config', return_value={'janice_api_key': 'key'}):
            client.get('/api/market/jita-buy?type_id=11993')
            server._jita_buy_cache[11993]['fetched_at'] -= server._JITA_PRICE_TTL + 1
            client.get('/api/market/jita-buy?type_id=11993')
        assert mock_fetch.call_count == 2
