"""Tests for alliance-filtered contract scanning introduced in multi-alliance-contracts.

Covers:
- _scan_contracts_stream: alliance filter, quota-key selection, per-corp dedup
- _sold_30d_scan_stream: uses corp contracts (not character), alliance filter,
  quota-key selection, cache population, sold_30d counts
- contracts_sold_30d endpoint: cache-miss returns None, cache-hit returns count
"""
import json
import sys
import os
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

CORP_ID = 1000001
OTHER_CORP_ID = 1000002
CHAR_ID = 9000001
STRUCTURE_ID = 99000001
ALLIANCE_ID_MAIN = 99011281
ALLIANCE_ID_INSTITUTE = 99005443
OTHER_ALLIANCE_ID = 99000999

_BASE_CONFIG = {
    'home_structure_id': STRUCTURE_ID,
    'quotas': [{'ship_type_id': 123, 'required': 2, 'title_filter': ''}],
    'quotas_institute': [{'ship_type_id': 456, 'required': 1, 'title_filter': ''}],
    'alliance_id_main': ALLIANCE_ID_MAIN,
    'alliance_id_institute': ALLIANCE_ID_INSTITUTE,
}


def _char_info(alliance_id=ALLIANCE_ID_MAIN, corp_id=CORP_ID):
    return {'corporation_id': corp_id, 'alliance_id': alliance_id}


def _sold_contract(contract_id=1, date_completed=None, corp_id=CORP_ID):
    # Default to a completion date safely inside the scan's 30-day window,
    # computed relative to now so the fixture doesn't age out over real time.
    if date_completed is None:
        date_completed = (datetime.now(timezone.utc) - timedelta(days=5)).isoformat()
    return {
        'contract_id': contract_id,
        'status': 'finished',
        'type': 'item_exchange',
        'start_location_id': STRUCTURE_ID,
        'issuer_corporation_id': corp_id,
        'date_completed': date_completed,
        'title': '',
    }


def _collect(gen):
    """Collect NDJSON bytes from a generator into a list of dicts."""
    return [json.loads(line.decode('utf-8')) for line in gen]


def _steps(events):
    return [e.get('step', '') for e in events if e.get('event') == 'progress']


def _done(events):
    return next(e for e in events if e.get('event') == 'done')


_COMMON_PATCHES = {
    'server.load_config': _BASE_CONFIG,
    'server.list_authenticated_slots': ['slot1'],
    'server.get_app_credentials': ('client_id', 'secret'),
    'server.get_user_agent': 'TestAgent/1.0',
    'server.get_valid_access_token': 'tok',
    'server.character_id_from_access_token': CHAR_ID,
}


@contextmanager
def _patch_scan(char_alliance=ALLIANCE_ID_MAIN, corp_contracts=None, items=None):
    """Context manager that patches all ESI/auth calls for _scan_contracts_stream tests."""
    mocks = {}
    patches = [patch(t, return_value=v) for t, v in _COMMON_PATCHES.items()]
    patches += [
        patch('server.fetch_character_info', return_value=_char_info(char_alliance)),
        patch('server.fetch_corp_contracts', return_value=corp_contracts or []),
        patch('server.fetch_contract_items', return_value=items or []),
    ]
    started = [p.start() for p in patches]
    mocks['fetch_corp'] = started[-2]
    mocks['fetch_items'] = started[-1]
    try:
        yield mocks
    finally:
        for p in patches:
            p.stop()


# ---------------------------------------------------------------------------
# _scan_contracts_stream
# ---------------------------------------------------------------------------

class TestScanContractsAllianceFilter:
    def test_all_processes_slot_regardless_of_alliance(self):
        from server import _scan_contracts_stream
        with _patch_scan(char_alliance=OTHER_ALLIANCE_ID) as mocks:
            _collect(_scan_contracts_stream(alliance='all'))
        mocks['fetch_corp'].assert_called_once()

    def test_main_processes_slot_in_main_alliance(self):
        from server import _scan_contracts_stream
        with _patch_scan(char_alliance=ALLIANCE_ID_MAIN) as mocks:
            _collect(_scan_contracts_stream(alliance='main'))
        mocks['fetch_corp'].assert_called_once()

    def test_main_skips_slot_in_other_alliance(self):
        from server import _scan_contracts_stream
        with _patch_scan(char_alliance=OTHER_ALLIANCE_ID) as mocks:
            events = _collect(_scan_contracts_stream(alliance='main'))
        mocks['fetch_corp'].assert_not_called()
        assert any('skipping' in s for s in _steps(events))

    def test_institute_processes_slot_in_institute_alliance(self):
        from server import _scan_contracts_stream
        with _patch_scan(char_alliance=ALLIANCE_ID_INSTITUTE) as mocks:
            _collect(_scan_contracts_stream(alliance='institute'))
        mocks['fetch_corp'].assert_called_once()

    def test_institute_skips_slot_in_main_alliance(self):
        from server import _scan_contracts_stream
        with _patch_scan(char_alliance=ALLIANCE_ID_MAIN) as mocks:
            events = _collect(_scan_contracts_stream(alliance='institute'))
        mocks['fetch_corp'].assert_not_called()
        assert any('skipping' in s for s in _steps(events))

    def test_skipped_slot_still_emits_done(self):
        from server import _scan_contracts_stream
        with _patch_scan(char_alliance=OTHER_ALLIANCE_ID) as mocks:
            events = _collect(_scan_contracts_stream(alliance='main'))
        assert any(e.get('event') == 'done' for e in events)

    def test_per_corp_dedup_skips_second_slot_for_same_corp(self):
        from server import _scan_contracts_stream
        with \
            patch('server.load_config', return_value=_BASE_CONFIG), \
            patch('server.get_app_credentials', return_value=('c', 's')), \
            patch('server.get_user_agent', return_value='ua'), \
            patch('server.list_authenticated_slots', return_value=['slot1', 'slot2']), \
            patch('server.get_valid_access_token', return_value='tok'), \
            patch('server.character_id_from_access_token', return_value=CHAR_ID), \
            patch('server.fetch_character_info', return_value=_char_info(ALLIANCE_ID_MAIN)), \
            patch('server.fetch_corp_contracts', return_value=[]) as mock_corp, \
            patch('server.fetch_contract_items', return_value=[]):
            events = _collect(_scan_contracts_stream(alliance='main'))
        # Both slots belong to the same corp — only one fetch should happen.
        mock_corp.assert_called_once()


class TestScanContractsQuotaKeys:
    def test_main_uses_quotas_not_quotas_institute(self):
        from server import _scan_contracts_stream
        with _patch_scan(char_alliance=ALLIANCE_ID_MAIN) as mocks:
            events = _collect(_scan_contracts_stream(alliance='main'))
        quotas = _done(events)['payload']['quotas']
        type_ids = {q['ship_type_id'] for q in quotas}
        assert 123 in type_ids
        assert 456 not in type_ids

    def test_institute_uses_quotas_institute(self):
        from server import _scan_contracts_stream
        with _patch_scan(char_alliance=ALLIANCE_ID_INSTITUTE) as mocks:
            events = _collect(_scan_contracts_stream(alliance='institute'))
        quotas = _done(events)['payload']['quotas']
        type_ids = {q['ship_type_id'] for q in quotas}
        assert 456 in type_ids
        assert 123 not in type_ids

    def test_all_defaults_to_quotas(self):
        from server import _scan_contracts_stream
        with _patch_scan(char_alliance=ALLIANCE_ID_MAIN) as mocks:
            events = _collect(_scan_contracts_stream(alliance='all'))
        quotas = _done(events)['payload']['quotas']
        type_ids = {q['ship_type_id'] for q in quotas}
        assert 123 in type_ids


# ---------------------------------------------------------------------------
# _sold_30d_scan_stream
# ---------------------------------------------------------------------------

class TestSold30dScanStream:
    def setup_method(self):
        import server
        server._contract_items_cache.clear()
        server._sold_contracts_cache.clear()

    def _run(self, alliance='main', char_alliance=ALLIANCE_ID_MAIN, corp_contracts=None, items=None):
        from server import _sold_30d_scan_stream
        with \
            patch('server.load_config', return_value=_BASE_CONFIG), \
            patch('server.get_app_credentials', return_value=('c', 's')), \
            patch('server.get_user_agent', return_value='ua'), \
            patch('server.list_authenticated_slots', return_value=['slot1']), \
            patch('server.get_valid_access_token', return_value='tok'), \
            patch('server.character_id_from_access_token', return_value=CHAR_ID), \
            patch('server.fetch_character_info', return_value=_char_info(char_alliance)), \
            patch('server.fetch_corp_contracts', return_value=corp_contracts or []) as mock_corp, \
            patch('server.fetch_character_contracts', return_value=[]) as mock_char, \
            patch('server.fetch_contract_items', return_value=items or []):
            events = _collect(_sold_30d_scan_stream(alliance=alliance))
            return events, mock_corp, mock_char

    def test_uses_corp_contracts_not_character_contracts(self):
        _, mock_corp, mock_char = self._run()
        mock_corp.assert_called_once()
        mock_char.assert_not_called()

    def test_main_processes_slot_in_main_alliance(self):
        _, mock_corp, _ = self._run(alliance='main', char_alliance=ALLIANCE_ID_MAIN)
        mock_corp.assert_called_once()

    def test_main_skips_slot_in_other_alliance(self):
        events, mock_corp, _ = self._run(alliance='main', char_alliance=OTHER_ALLIANCE_ID)
        mock_corp.assert_not_called()
        assert any('skipping' in s for s in _steps(events))

    def test_institute_processes_slot_in_institute_alliance(self):
        _, mock_corp, _ = self._run(alliance='institute', char_alliance=ALLIANCE_ID_INSTITUTE)
        mock_corp.assert_called_once()

    def test_all_processes_regardless_of_alliance(self):
        _, mock_corp, _ = self._run(alliance='all', char_alliance=OTHER_ALLIANCE_ID)
        mock_corp.assert_called_once()

    def test_cache_populated_for_alliance_after_scan(self):
        import server
        server._sold_contracts_cache.pop('main', None)
        self._run(alliance='main')
        assert 'main' in server._sold_contracts_cache

    def test_cache_populated_for_institute_after_scan(self):
        import server
        server._sold_contracts_cache.pop('institute', None)
        self._run(alliance='institute', char_alliance=ALLIANCE_ID_INSTITUTE)
        assert 'institute' in server._sold_contracts_cache

    def test_done_event_has_sold_30d_per_quota(self):
        events, _, _ = self._run()
        quotas = _done(events)['payload']['quotas']
        assert all('sold_30d' in q for q in quotas)

    def test_sold_count_increments_for_matching_contract(self):
        items = [{'type_id': 123, 'quantity': 1, 'is_included': True}]
        events, _, _ = self._run(
            corp_contracts=[_sold_contract()],
            items=items,
        )
        quotas = _done(events)['payload']['quotas']
        q123 = next(q for q in quotas if q['ship_type_id'] == 123)
        assert q123['sold_30d'] == 1

    def test_sold_count_zero_for_non_matching_items(self):
        items = [{'type_id': 999, 'quantity': 1, 'is_included': True}]
        events, _, _ = self._run(
            corp_contracts=[_sold_contract()],
            items=items,
        )
        quotas = _done(events)['payload']['quotas']
        q123 = next(q for q in quotas if q['ship_type_id'] == 123)
        assert q123['sold_30d'] == 0

    def test_sold_count_respects_quantity(self):
        items = [{'type_id': 123, 'quantity': 3, 'is_included': True}]
        events, _, _ = self._run(
            corp_contracts=[_sold_contract()],
            items=items,
        )
        quotas = _done(events)['payload']['quotas']
        q123 = next(q for q in quotas if q['ship_type_id'] == 123)
        assert q123['sold_30d'] == 3

    def test_institute_uses_quotas_institute_key(self):
        items = [{'type_id': 456, 'quantity': 1, 'is_included': True}]
        events, _, _ = self._run(
            alliance='institute',
            char_alliance=ALLIANCE_ID_INSTITUTE,
            corp_contracts=[_sold_contract()],
            items=items,
        )
        quotas = _done(events)['payload']['quotas']
        type_ids = {q['ship_type_id'] for q in quotas}
        assert 456 in type_ids
        assert 123 not in type_ids

    def test_no_sold_contracts_emits_done_with_zero_counts(self):
        events, _, _ = self._run(corp_contracts=[])
        quotas = _done(events)['payload']['quotas']
        assert all(q['sold_30d'] == 0 for q in quotas)


# ---------------------------------------------------------------------------
# contracts_sold_30d endpoint
# ---------------------------------------------------------------------------

class TestContractsSold30dEndpoint:
    def setup_method(self):
        import server
        server._sold_contracts_cache.clear()

    def _cache_rec(self, cid, items):
        import server
        server._sold_contracts_cache['main'] = {
            cid: {'contract': {'contract_id': cid, 'title': ''}, 'char_id': CHAR_ID, 'corp_id': CORP_ID, 'token': 'tok'}
        }
        server._contract_items_cache[cid] = items

    def teardown_method(self):
        import server
        server._sold_contracts_cache.clear()
        # Remove any test contract_items_cache entries we added
        for k in list(server._contract_items_cache):
            if k >= 9000:
                del server._contract_items_cache[k]

    def test_returns_none_when_cache_empty(self):
        from server import contracts_sold_30d
        result = contracts_sold_30d(ship_type_id=123, alliance='main')
        assert result == {'sold_30d': None}

    def test_returns_zero_when_contract_has_no_items(self):
        self._cache_rec(cid=9001, items=[])
        with patch('server.get_user_agent', return_value='ua'):
            from server import contracts_sold_30d
            result = contracts_sold_30d(ship_type_id=123, alliance='main')
        assert result == {'sold_30d': 0}

    def test_returns_count_for_matching_items(self):
        self._cache_rec(cid=9002, items=[{'type_id': 123, 'quantity': 2, 'is_included': True}])
        with patch('server.get_user_agent', return_value='ua'):
            from server import contracts_sold_30d
            result = contracts_sold_30d(ship_type_id=123, alliance='main')
        assert result == {'sold_30d': 2}

    def test_returns_zero_for_non_matching_type(self):
        self._cache_rec(cid=9003, items=[{'type_id': 999, 'quantity': 1, 'is_included': True}])
        with patch('server.get_user_agent', return_value='ua'):
            from server import contracts_sold_30d
            result = contracts_sold_30d(ship_type_id=123, alliance='main')
        assert result == {'sold_30d': 0}

    def test_title_filter_applied(self):
        import server
        server._sold_contracts_cache['main'] = {
            9004: {'contract': {'contract_id': 9004, 'title': 'Naga Mk1'}, 'char_id': CHAR_ID, 'corp_id': CORP_ID, 'token': 'tok'},
            9005: {'contract': {'contract_id': 9005, 'title': 'Naga Mk2'}, 'char_id': CHAR_ID, 'corp_id': CORP_ID, 'token': 'tok'},
        }
        server._contract_items_cache[9004] = [{'type_id': 123, 'quantity': 1, 'is_included': True}]
        server._contract_items_cache[9005] = [{'type_id': 123, 'quantity': 1, 'is_included': True}]
        with patch('server.get_user_agent', return_value='ua'):
            from server import contracts_sold_30d
            result = contracts_sold_30d(ship_type_id=123, title_filter='Mk1', alliance='main')
        assert result == {'sold_30d': 1}
        server._contract_items_cache.pop(9004, None)
        server._contract_items_cache.pop(9005, None)

    def test_alliance_cache_isolation(self):
        """Cache for 'main' does not affect lookup for 'institute'."""
        self._cache_rec(cid=9006, items=[{'type_id': 123, 'quantity': 1, 'is_included': True}])
        with patch('server.get_user_agent', return_value='ua'):
            from server import contracts_sold_30d
            result = contracts_sold_30d(ship_type_id=123, alliance='institute')
        assert result == {'sold_30d': None}


# ---------------------------------------------------------------------------
# Deferred sweep for ESI's transient 520 bursts
# ---------------------------------------------------------------------------

def _http_error(status):
    """The HTTPError requests raises out of resp.raise_for_status()."""
    resp = requests.Response()
    resp.status_code = status
    return requests.exceptions.HTTPError(f'{status} Server Error', response=resp)


def _outstanding(contract_id, corp_id=CORP_ID):
    return {
        'contract_id': contract_id,
        'type': 'item_exchange',
        'status': 'outstanding',
        'start_location_id': STRUCTURE_ID,
        'issuer_corporation_id': corp_id,
        'title': '',
        'price': 1.0,
    }


class TestScanContractsItemsSweep:
    """ESI serves bursts of 520s on the contract-items endpoint; a contract that
    fails the first pass usually succeeds moments later. The scan retries the
    stragglers once rather than reporting them as missing stock."""

    CID = 9101

    def setup_method(self):
        import server
        server._contract_items_cache.clear()

    def teardown_method(self):
        import server
        server._contract_items_cache.clear()

    @contextmanager
    def _patched(self, side_effect):
        from esi_retry import DEFAULT_ATTEMPTS  # noqa: F401 - documents the budget
        patches = [patch(t, return_value=v) for t, v in _COMMON_PATCHES.items()]
        patches += [
            patch('server.fetch_character_info', return_value=_char_info()),
            patch('server.fetch_corp_contracts', return_value=[_outstanding(self.CID)]),
            patch('server.fetch_contract_items', side_effect=side_effect),
            patch('server.resolve_names', return_value={}),
            patch('server.ITEMS_SWEEP_DELAY_SECONDS', 0),
            patch('esi_retry.time.sleep'),
        ]
        started = [p.start() for p in patches]
        try:
            yield started[-4]  # the fetch_contract_items mock
        finally:
            for p in patches:
                p.stop()

    def test_sweep_recovers_a_contract_that_failed_the_first_pass(self):
        from server import _scan_contracts_stream
        from esi_retry import DEFAULT_ATTEMPTS
        calls = []

        def flaky(*_args, **_kwargs):
            calls.append(1)
            if len(calls) <= DEFAULT_ATTEMPTS:      # burn the whole first pass
                raise _http_error(520)
            return [{'type_id': 123, 'quantity': 2, 'is_included': True}]

        with self._patched(flaky):
            events = _collect(_scan_contracts_stream(alliance='main'))

        contracts = _done(events)['payload']['contracts']
        assert len(contracts) == 1
        assert contracts[0]['items_error'] is None, 'sweep should have cleared the error'
        assert contracts[0]['items'][0]['quantity'] == 2

    def test_sweep_reports_progress(self):
        from server import _scan_contracts_stream
        from esi_retry import DEFAULT_ATTEMPTS
        calls = []

        def flaky(*_args, **_kwargs):
            calls.append(1)
            if len(calls) <= DEFAULT_ATTEMPTS:
                raise _http_error(520)
            return []

        with self._patched(flaky):
            events = _collect(_scan_contracts_stream(alliance='main'))

        steps = ' | '.join(_steps(events))
        assert 'retrying in' in steps
        assert 'Sweep recovered 1 of 1' in steps

    def test_persistent_failure_still_reported(self):
        from server import _scan_contracts_stream

        def always_520(*_args, **_kwargs):
            raise _http_error(520)

        with self._patched(always_520):
            events = _collect(_scan_contracts_stream(alliance='main'))

        contracts = _done(events)['payload']['contracts']
        assert contracts[0]['items_error'] is not None
        assert '520' in contracts[0]['items_error']

    def test_4xx_is_not_retried(self):
        """A 403 can't be fixed by retrying, and each attempt eats ESI's error
        budget — one try per pass, not one per attempt."""
        from server import _scan_contracts_stream

        def forbidden(*_args, **_kwargs):
            raise _http_error(403)

        with self._patched(forbidden) as mock_items:
            _collect(_scan_contracts_stream(alliance='main'))

        assert mock_items.call_count == 2, 'one first-pass try + one sweep try'


# ---------------------------------------------------------------------------
# Scan run history
# ---------------------------------------------------------------------------

class TestScanRunHistory:
    """One record per scan, and a broken store never breaks the scan.

    Design: docs/superpowers/specs/2026-07-24-scan-history-design.md
    """

    CID = 9201

    def setup_method(self):
        import server
        server._contract_items_cache.clear()

    def teardown_method(self):
        import server
        server._contract_items_cache.clear()

    @contextmanager
    def _patched(self, appended, items_side_effect=None, append_impl=None):
        kwargs = ({'side_effect': items_side_effect} if items_side_effect
                  else {'return_value': [{'type_id': 123, 'quantity': 1, 'is_included': True}]})
        patches = [patch(t, return_value=v) for t, v in _COMMON_PATCHES.items()]
        patches += [
            patch('server.fetch_character_info', return_value=_char_info()),
            patch('server.fetch_corp_contracts', return_value=[_outstanding(self.CID)]),
            patch('server.fetch_contract_items', **kwargs),
            patch('server.resolve_names', return_value={}),
            patch('server.ITEMS_SWEEP_DELAY_SECONDS', 0),
            patch('esi_retry.time.sleep'),
            patch('server.append_run', side_effect=append_impl or appended.append),
        ]
        started = [p.start() for p in patches]
        try:
            yield started[-1]
        finally:
            for p in patches:
                p.stop()

    def test_scan_appends_exactly_one_record(self):
        from server import _scan_contracts_stream
        appended = []
        with self._patched(appended):
            _collect(_scan_contracts_stream(alliance='main'))
        assert len(appended) == 1

    def test_record_has_the_documented_shape(self):
        from server import _scan_contracts_stream
        appended = []
        with self._patched(appended):
            _collect(_scan_contracts_stream(alliance='main'))
        rec = appended[0]
        for field in ('started', 'seconds', 'alliance', 'contracts', 'corps_scanned',
                      'items_fetched', 'items_cached', 'items_failed', 'esi_errors',
                      'retries', 'sweep_attempted', 'sweep_recovered', 'phases',
                      'git', 'dirty', 'app_version'):
            assert field in rec, f'missing {field}'
        assert rec['alliance'] == 'main'
        assert rec['contracts'] == 1
        assert rec['items_fetched'] == 1
        assert rec['items_failed'] == 0
        assert set(rec['phases']) == {'contracts', 'items', 'names'}

    def test_fetch_totals_reconcile(self):
        from server import _scan_contracts_stream
        appended = []
        with self._patched(appended):
            _collect(_scan_contracts_stream(alliance='main'))
        rec = appended[0]
        assert rec['items_fetched'] + rec['items_cached'] + rec['items_failed'] == rec['contracts']

    def test_records_esi_errors_and_retries(self):
        from server import _scan_contracts_stream
        from esi_retry import DEFAULT_ATTEMPTS
        appended = []
        calls = []

        def flaky(*_a, **_k):
            calls.append(1)
            if len(calls) <= DEFAULT_ATTEMPTS:
                raise _http_error(520)
            return []

        with self._patched(appended, items_side_effect=flaky):
            _collect(_scan_contracts_stream(alliance='main'))
        rec = appended[0]
        assert rec['esi_errors']['520'] == DEFAULT_ATTEMPTS
        assert rec['retries'] == DEFAULT_ATTEMPTS - 1
        assert rec['sweep_attempted'] == 1
        assert rec['sweep_recovered'] == 1
        assert rec['items_failed'] == 0

    def test_cached_items_counted_as_cached_not_fetched(self):
        from server import _scan_contracts_stream
        import server
        server._contract_items_cache[self.CID] = [{'type_id': 123, 'quantity': 1, 'is_included': True}]
        appended = []
        with self._patched(appended):
            _collect(_scan_contracts_stream(alliance='main'))
        rec = appended[0]
        assert rec['items_cached'] == 1
        assert rec['items_fetched'] == 0

    def test_store_failure_does_not_break_the_scan(self):
        from server import _scan_contracts_stream

        def boom(_record):
            raise OSError('disk full')

        with self._patched([], append_impl=boom):
            events = _collect(_scan_contracts_stream(alliance='main'))
        done = _done(events)
        assert done['payload']['contracts'][0]['contract_id'] == self.CID
