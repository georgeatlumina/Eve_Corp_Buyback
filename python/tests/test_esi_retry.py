"""Tests for the ESI retry policy (python/esi_retry.py).

Background: ESI's /corporations/{id}/contracts/{id}/items/ endpoint emits bursts
of HTTP 520. Measured during a real scan — 154 contracts, 122 failures — bursts
recurred every ~1.25s and all in-flight requests failed together, so 31
contracts burned all 3 of their attempts inside a 3.1s window and were reported
as permanently failed. Those same contracts succeeded on a later scan.

The policy therefore has to (a) spread attempts across tens of seconds, and
(b) not waste attempts (or ESI's 100-errors/60s budget) on 4xx.
"""
import os
import sys

import pytest
import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from esi_retry import (  # noqa: E402
    DEFAULT_ATTEMPTS,
    backoff_delay,
    call_with_retry,
    is_retryable,
    retry_after_seconds,
    status_of,
)


def _http_error(status, headers=None):
    """Build the HTTPError requests raises from resp.raise_for_status()."""
    resp = requests.Response()
    resp.status_code = status
    resp.headers.update(headers or {})
    return requests.exceptions.HTTPError(f'{status} Server Error', response=resp)


class TestStatusOf:
    def test_extracts_status_from_http_error(self):
        assert status_of(_http_error(520)) == 520

    def test_none_for_exception_without_response(self):
        assert status_of(ValueError('boom')) is None

    def test_none_for_connection_error(self):
        assert status_of(requests.exceptions.ConnectionError()) is None


class TestIsRetryable:
    @pytest.mark.parametrize('status', [500, 502, 503, 504, 520, 522, 524])
    def test_5xx_is_retryable(self, status):
        assert is_retryable(_http_error(status)) is True

    def test_520_is_retryable(self):
        """The exact failure that motivated this module."""
        assert is_retryable(_http_error(520)) is True

    def test_429_is_retryable(self):
        assert is_retryable(_http_error(429)) is True

    @pytest.mark.parametrize('status', [400, 401, 403, 404, 422])
    def test_4xx_is_not_retryable(self, status):
        """Retrying these can never succeed and burns ESI's error budget."""
        assert is_retryable(_http_error(status)) is False

    @pytest.mark.parametrize('exc', [
        requests.exceptions.ConnectionError(),
        requests.exceptions.Timeout(),
        requests.exceptions.ChunkedEncodingError(),
    ])
    def test_transport_errors_are_retryable(self, exc):
        assert is_retryable(exc) is True

    def test_unknown_exception_is_not_retryable(self):
        assert is_retryable(ValueError('bad json')) is False


class TestRetryAfter:
    def test_parses_retry_after_seconds(self):
        assert retry_after_seconds(_http_error(429, {'Retry-After': '7'})) == 7.0

    def test_none_when_header_absent(self):
        assert retry_after_seconds(_http_error(503)) is None

    def test_none_when_header_unparseable(self):
        assert retry_after_seconds(_http_error(503, {'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT'})) is None


class TestBackoffDelay:
    def test_grows_exponentially(self):
        mid = lambda: 0.5  # noqa: E731 - no jitter, exact values
        delays = [backoff_delay(i, rand=mid) for i in range(5)]
        assert delays == [1.0, 2.0, 4.0, 8.0, 16.0]

    def test_capped(self):
        mid = lambda: 0.5  # noqa: E731
        assert backoff_delay(20, rand=mid) == 20.0

    def test_jitter_stays_within_band(self):
        lo = backoff_delay(2, rand=lambda: 0.0)
        hi = backoff_delay(2, rand=lambda: 1.0)
        assert lo == pytest.approx(3.0)   # 4.0 - 25%
        assert hi == pytest.approx(5.0)   # 4.0 + 25%

    def test_default_schedule_outlasts_the_burst_window(self):
        """The whole point: attempts must not all land inside one ESI bad patch.

        The observed failure had 3 attempts inside 3.1s. Nominal spread is 15s;
        even at the unluckiest jitter it stays several times the burst window.
        Sustained bad patches (the worst measured ran ~56s) are the deferred
        sweep's job, not this schedule's — holding a pool worker for a minute
        per contract would make scans crawl.
        """
        mid = lambda: 0.5  # noqa: E731
        nominal = sum(backoff_delay(i, rand=mid) for i in range(DEFAULT_ATTEMPTS - 1))
        worst = sum(backoff_delay(i, rand=lambda: 0.0) for i in range(DEFAULT_ATTEMPTS - 1))
        assert nominal == 15.0
        assert worst > 10.0, 'must stay well clear of the 3.1s window that caused the bug'


class TestCallWithRetry:
    def test_returns_immediately_on_success(self):
        slept = []
        assert call_with_retry(lambda: 'ok', sleep=slept.append) == 'ok'
        assert slept == []

    def test_retries_transient_then_succeeds(self):
        calls = []
        slept = []

        def flaky():
            calls.append(1)
            if len(calls) < 3:
                raise _http_error(520)
            return 'ok'

        assert call_with_retry(flaky, sleep=slept.append) == 'ok'
        assert len(calls) == 3
        assert len(slept) == 2

    def test_does_not_retry_4xx(self):
        calls = []
        slept = []

        def forbidden():
            calls.append(1)
            raise _http_error(403)

        with pytest.raises(requests.exceptions.HTTPError):
            call_with_retry(forbidden, sleep=slept.append)
        assert len(calls) == 1, 'a 403 must not be retried'
        assert slept == []

    def test_exhausts_attempts_then_raises_last_error(self):
        calls = []
        slept = []

        def always_520():
            calls.append(1)
            raise _http_error(520)

        with pytest.raises(requests.exceptions.HTTPError) as exc:
            call_with_retry(always_520, attempts=4, sleep=slept.append)
        assert status_of(exc.value) == 520
        assert len(calls) == 4
        assert len(slept) == 3, 'no sleep after the final attempt'

    def test_honors_retry_after_over_backoff(self):
        slept = []
        calls = []

        def rate_limited():
            calls.append(1)
            if len(calls) < 2:
                raise _http_error(429, {'Retry-After': '9'})
            return 'ok'

        call_with_retry(rate_limited, sleep=slept.append)
        assert slept == [9.0]

    def test_total_spread_escapes_a_three_second_burst(self):
        """End-to-end guard against a regression to the old 3-attempt/3.1s policy."""
        slept = []

        def always_520():
            raise _http_error(520)

        with pytest.raises(requests.exceptions.HTTPError):
            call_with_retry(always_520, sleep=slept.append, rand=lambda: 0.0)
        assert len(slept) == DEFAULT_ATTEMPTS - 1
        assert sum(slept) > 10.0, 'the old policy spent all its attempts in 3.1s'
