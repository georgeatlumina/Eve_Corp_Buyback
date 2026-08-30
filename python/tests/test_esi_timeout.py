"""Every ESI request must carry a timeout.

Guards the fix for a moon/buyback scan hanging forever on "Resolving issuer
names…". `requests` defaults to *no* timeout, so a connection ESI accepts but
never answers blocks the calling thread indefinitely — no error, no progress,
and nothing to do but kill the app. All 55 `_session` calls in esi.py were like
this, and it also made esi_retry's `Timeout` branch unreachable: the exception
it retries on could never be raised.
"""
import os
import re
import sys
from unittest.mock import patch

import pytest
import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import esi  # noqa: E402


class TestSessionTimeout:
    def test_the_session_injects_a_default(self):
        with patch.object(requests.Session, 'request', autospec=True) as req:
            req.return_value = None
            esi._session.get('https://example.invalid/x')
        assert req.call_args.kwargs['timeout'] == esi.DEFAULT_TIMEOUT

    def test_an_explicit_timeout_still_wins(self):
        """Callers that know an endpoint is slow must stay in control."""
        with patch.object(requests.Session, 'request', autospec=True) as req:
            req.return_value = None
            esi._session.get('https://example.invalid/x', timeout=5)
        assert req.call_args.kwargs['timeout'] == 5

    def test_it_covers_post_as_well_as_get(self):
        """resolve_names — where the hang was actually reported — is a POST."""
        with patch.object(requests.Session, 'request', autospec=True) as req:
            req.return_value = None
            esi._session.post('https://example.invalid/x', json=[1])
        assert req.call_args.kwargs['timeout'] == esi.DEFAULT_TIMEOUT

    def test_the_timeout_is_finite_and_has_both_halves(self):
        connect, read = esi.DEFAULT_TIMEOUT
        assert 0 < connect <= 30
        assert 0 < read <= 300

    def test_every_thread_gets_a_timeout_session(self):
        """The session is thread-local and the contracts scan runs in a pool, so
        a per-thread session built the old way would quietly lose the timeout."""
        import threading
        seen = []
        threading.Thread(target=lambda: seen.append(type(esi._session._thread_session))).start()
        while not seen:
            pass
        assert seen[0] is esi._TimeoutSession


class TestNoUnboundedCalls:
    def test_no_esi_helper_can_hang_forever(self):
        """A source check, not a behaviour one: a new helper that passes its own
        timeout is fine, but one that relies on nothing at all must not slip in
        if the session default is ever removed."""
        src = open(os.path.join(os.path.dirname(__file__), '..', 'esi.py'), encoding='utf-8').read()
        assert 'DEFAULT_TIMEOUT' in src
        assert re.search(r'class _TimeoutSession\(requests\.Session\)', src), \
            'the session no longer enforces a default timeout'
        assert re.search(r"kwargs\[.timeout.\] = DEFAULT_TIMEOUT", src)


class TestRetryReachesTimeouts:
    def test_timeout_is_treated_as_retryable(self):
        """Now that timeouts can actually be raised, the retry policy has to
        cover them — it always claimed to, but the branch was dead."""
        import esi_retry
        assert requests.exceptions.Timeout in esi_retry._RETRYABLE_EXCEPTIONS


class TestResolveNames:
    def test_falsy_ids_are_dropped(self):
        """Contracts can carry a missing issuer_id; passing None to ESI would be
        a 400 that fails the whole batch."""
        with patch.object(esi._session, 'post') as post:
            esi.resolve_names([0, None, ''], 'ua')
        post.assert_not_called()

    @pytest.mark.parametrize('ids', [[1, 2, 2, 3], [3, 1, 2]])
    def test_ids_are_deduped_and_sorted(self, ids):
        with patch.object(esi._session, 'post') as post:
            post.return_value.json.return_value = []
            esi.resolve_names(ids, 'ua')
        assert post.call_args.kwargs['json'] == [1, 2, 3]
