"""Retry policy for flaky ESI endpoints.

ESI's ``/corporations/{id}/contracts/{id}/items/`` endpoint serves bursts of
HTTP 520 (Cloudflare's "origin returned an unknown error"). Measured on a real
scan of 154 contracts: 122 of the item requests failed, bursts recurred every
~1.25s, and every in-flight request failed together — 31 contracts burned all
three of their attempts inside a 3.1s window and were reported to the user as
permanently failed. The same contracts succeeded on a later scan, so the
failures are a property of *when* a request lands, not of the contract.

Two consequences shape this module:

* Attempts must be spread across tens of seconds. Three tries in three seconds
  is almost guaranteed to sit inside a single burst.
* Only transient failures are worth retrying. A 4xx will never succeed on
  retry, and each wasted request eats into ESI's error budget (100 errors per
  60s, after which it returns 420 and blocks the client outright).
"""
import logging
import random
import time

import requests

logger = logging.getLogger(__name__)

# 5 attempts with the default schedule span ~31s of backoff (~23s at the
# unluckiest jitter) — an order of magnitude past the bursts we measured.
DEFAULT_ATTEMPTS = 5
DEFAULT_BASE = 1.0
DEFAULT_FACTOR = 2.0
DEFAULT_CAP = 20.0
DEFAULT_JITTER = 0.25

# Transport-level failures: the request never got a usable answer, so it is
# always worth another go.
_RETRYABLE_EXCEPTIONS = (
    requests.exceptions.ConnectionError,
    requests.exceptions.Timeout,
    requests.exceptions.ChunkedEncodingError,
)


def status_of(exc):
    """HTTP status carried by an exception, or None if it isn't an HTTP error."""
    resp = getattr(exc, 'response', None)
    if resp is None:
        return None
    status = getattr(resp, 'status_code', None)
    return int(status) if status is not None else None


def retry_after_seconds(exc):
    """Seconds requested by a ``Retry-After`` header, or None.

    Only the delta-seconds form is honoured; the HTTP-date form is rare from
    ESI and not worth the clock-skew risk.
    """
    resp = getattr(exc, 'response', None)
    if resp is None:
        return None
    raw = (getattr(resp, 'headers', None) or {}).get('Retry-After')
    if raw is None:
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def is_retryable(exc):
    """True if another attempt could plausibly succeed.

    5xx (including Cloudflare's 520/522/524) and 429 are transient. Everything
    else — 4xx, JSON decode errors, programming errors — is not.
    """
    if isinstance(exc, _RETRYABLE_EXCEPTIONS):
        return True
    status = status_of(exc)
    if status is None:
        return False
    return status >= 500 or status == 429


def backoff_delay(attempt, base=DEFAULT_BASE, factor=DEFAULT_FACTOR,
                  cap=DEFAULT_CAP, jitter=DEFAULT_JITTER, rand=random.random):
    """Exponential backoff with symmetric jitter, in seconds.

    Jitter keeps the three scan workers from re-colliding on the same instant
    after a shared burst knocked them all down together.
    """
    delay = min(base * (factor ** attempt), cap)
    return delay * (1 + jitter * (rand() * 2 - 1))


def call_with_retry(fn, attempts=DEFAULT_ATTEMPTS, sleep=None,
                    rand=None, on_retry=None):
    """Call ``fn`` until it succeeds, giving up after ``attempts`` tries.

    Re-raises the last exception on exhaustion, and re-raises immediately for
    anything :func:`is_retryable` rejects. ``sleep`` and ``rand`` are injectable
    so tests can assert the schedule without burning wall-clock time; they
    resolve at call time so patching ``esi_retry.time.sleep`` works too.
    """
    sleep = time.sleep if sleep is None else sleep
    rand = random.random if rand is None else rand
    for attempt in range(attempts):
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 - re-raised below
            last_attempt = attempt == attempts - 1
            if last_attempt or not is_retryable(exc):
                raise
            delay = retry_after_seconds(exc)
            if delay is None:
                delay = backoff_delay(attempt, rand=rand)
            if on_retry is not None:
                on_retry(attempt, delay, exc)
            logger.info(
                'ESI retry %d/%d in %.1fs after %s',
                attempt + 1, attempts - 1, delay, exc,
            )
            sleep(delay)
