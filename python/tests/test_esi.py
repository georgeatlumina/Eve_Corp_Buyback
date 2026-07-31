"""Unit tests for ESI fetch helpers in python/esi.py.

fetch_corp_contracts regression: a mid-pagination 5xx (observed as ESI 504
gateway timeouts on /corporations/{id}/contracts/) used to be treated as
"reached the last page" and silently returned whatever had been accumulated
so far (empty, on a page-1 failure) instead of raising. That made a
transient ESI outage look identical to "this corp genuinely has zero
contracts" — no exception ever reached the scan, so nothing got retried and
nothing got reported to the user.
"""
import json
import os
import sys
from unittest.mock import patch

import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from esi import fetch_corp_contracts  # noqa: E402


def _response(payload, status=200, pages=1):
    resp = requests.Response()
    resp.status_code = status
    resp.headers['x-pages'] = str(pages)
    resp._content = json.dumps(payload).encode('utf-8')
    return resp


class TestFetchCorpContracts:
    def test_returns_all_contracts_single_page(self):
        contracts = [{'contract_id': 1}, {'contract_id': 2}]
        with patch('esi._session.get', return_value=_response(contracts)):
            result = fetch_corp_contracts(1000001, 'tok', 'TestAgent')
        assert result == contracts

    def test_paginates_via_x_pages_header(self):
        page1 = [{'contract_id': 1}]
        page2 = [{'contract_id': 2}]
        responses = [_response(page1, pages=2), _response(page2, pages=2)]
        with patch('esi._session.get', side_effect=responses):
            result = fetch_corp_contracts(1000001, 'tok', 'TestAgent')
        assert result == [{'contract_id': 1}, {'contract_id': 2}]

    def test_raises_on_5xx_instead_of_returning_empty(self):
        """Regression test: a 504 must not be treated as end-of-pagination."""
        with patch('esi._session.get', return_value=_response({}, status=504)):
            try:
                fetch_corp_contracts(1000001, 'tok', 'TestAgent')
                assert False, 'expected an HTTPError to be raised'
            except requests.exceptions.HTTPError as e:
                assert e.response.status_code == 504

    def test_raises_on_403(self):
        with patch('esi._session.get', return_value=_response({}, status=403)):
            try:
                fetch_corp_contracts(1000001, 'tok', 'TestAgent')
                assert False, 'expected an HTTPError to be raised'
            except requests.exceptions.HTTPError as e:
                assert e.response.status_code == 403
