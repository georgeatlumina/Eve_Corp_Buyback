"""Contract-scan run history: what each scan cost, and which build produced it.

Design: docs/superpowers/specs/2026-07-24-scan-history-design.md

Two IO-light concerns, in the shape `liquidation.py` uses for its store +
engine pairing:

* **`ScanMetrics`** — a pure accumulator the scan reports into. No IO, an
  injectable clock, and lock-guarded counters because the item-fetch pool
  reports from three threads at once.
* **Store** — a JSON ring buffer under ``AUTH_DIR``, atomic and
  corrupt-tolerant, mirroring `pinned.py` / `liquidation.py`.

Records are stamped with the git revision *of the running process*, captured
once at first use rather than per scan. The sidecar loads its Python at process
start, so that sha is the code actually producing these numbers; a per-scan
lookup would label runs with a working tree that was never loaded — precisely
the wrong answer for comparing builds.
"""
import json
import logging
import os
import subprocess
import threading
import time
from datetime import datetime, timezone

from config import AUTH_DIR

logger = logging.getLogger(__name__)

HISTORY_PATH = os.path.join(AUTH_DIR, 'scan_history.json')
MAX_RUNS = 200

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_GIT_TIMEOUT = 2

_git_info_cache = None
_app_version_cache = None


# ----------------------------- build tagging -----------------------------

def git_info():
    """``{'git': <short sha>, 'dirty': <bool>}`` for the running checkout.

    Memoized. Both fields fall back to None when git is unavailable — a
    packaged app has no repo, and that is not an error worth surfacing.
    """
    global _git_info_cache
    if _git_info_cache is not None:
        return _git_info_cache

    info = {'git': None, 'dirty': None}
    try:
        rev = subprocess.run(
            ['git', 'rev-parse', '--short', 'HEAD'],
            cwd=_REPO_ROOT, capture_output=True, text=True, timeout=_GIT_TIMEOUT,
        )
        if rev.returncode == 0:
            info['git'] = (rev.stdout or '').strip() or None
            status = subprocess.run(
                ['git', 'status', '--porcelain'],
                cwd=_REPO_ROOT, capture_output=True, text=True, timeout=_GIT_TIMEOUT,
            )
            if status.returncode == 0:
                info['dirty'] = bool((status.stdout or '').strip())
    except (OSError, subprocess.SubprocessError):
        pass

    _git_info_cache = info
    return info


def app_version():
    """Version from package.json, or None. Memoized."""
    global _app_version_cache
    if _app_version_cache is not None:
        return _app_version_cache
    version = None
    try:
        with open(os.path.join(_REPO_ROOT, 'package.json'), encoding='utf-8') as f:
            version = (json.load(f) or {}).get('version')
    except (OSError, json.JSONDecodeError):
        pass
    _app_version_cache = version
    return version


# ----------------------------- accumulator -----------------------------

class ScanMetrics:
    """Tallies one contract scan. Every mutator is safe to call from the
    item-fetch pool threads."""

    def __init__(self, alliance='all', clock=time.monotonic, now=None):
        self._clock = clock
        self._now = now or (lambda: datetime.now(timezone.utc)
                            .strftime('%Y-%m-%dT%H:%M:%SZ'))
        self._lock = threading.Lock()
        self.alliance = alliance
        self.started = self._now()
        self._t0 = clock()
        self._phase_starts = {}
        self._phases = {}
        self._items_fetched = 0
        self._items_cached = 0
        self._retries = 0
        self._errors = {}
        self._sweep_attempted = 0
        self._sweep_recovered = 0

    # -- phases ------------------------------------------------------------

    def start_phase(self, name):
        with self._lock:
            self._phase_starts[name] = self._clock()

    def end_phase(self, name):
        with self._lock:
            started = self._phase_starts.pop(name, None)
            if started is not None:
                self._phases[name] = round(self._clock() - started, 3)

    # -- counters ----------------------------------------------------------

    def record_fetch(self, cached=False):
        with self._lock:
            if cached:
                self._items_cached += 1
            else:
                self._items_fetched += 1

    def record_error(self, status):
        key = 'unknown' if status is None else str(status)
        with self._lock:
            self._errors[key] = self._errors.get(key, 0) + 1

    def record_retry(self):
        with self._lock:
            self._retries += 1

    def record_sweep(self, attempted, recovered):
        with self._lock:
            self._sweep_attempted = int(attempted)
            self._sweep_recovered = int(recovered)

    # -- result ------------------------------------------------------------

    def finish(self, contracts, corps_scanned, items_failed):
        """Build the record. Totals the scan already knows are passed in rather
        than inferred, so the accumulator never has to model sweep semantics."""
        # Resolved before taking the lock: on a cold cache these shell out to
        # git, and holding the lock through that would stall reporting threads.
        build = git_info()
        version = app_version()
        with self._lock:
            return {
                'started': self.started,
                'seconds': round(self._clock() - self._t0, 3),
                'alliance': self.alliance,
                'contracts': int(contracts),
                'corps_scanned': int(corps_scanned),
                'items_fetched': self._items_fetched,
                'items_cached': self._items_cached,
                'items_failed': int(items_failed),
                'esi_errors': dict(self._errors),
                'retries': self._retries,
                'sweep_attempted': self._sweep_attempted,
                'sweep_recovered': self._sweep_recovered,
                'phases': dict(self._phases),
                **build,
                'app_version': version,
            }


# ----------------------------- store -----------------------------

def empty_history():
    return {'runs': []}


def normalize(data):
    if not isinstance(data, dict):
        return empty_history()
    runs = data.get('runs')
    if not isinstance(runs, list):
        return empty_history()
    return {'runs': [r for r in runs if isinstance(r, dict)]}


def load_history():
    """Read the store. A missing or corrupt file reads as empty — history is
    diagnostic data, never worth raising over."""
    if not os.path.exists(HISTORY_PATH):
        return empty_history()
    try:
        with open(HISTORY_PATH, encoding='utf-8') as f:
            return normalize(json.load(f))
    except (json.JSONDecodeError, OSError):
        return empty_history()


def append_run(record):
    """Append one run, trim to the newest MAX_RUNS, write atomically."""
    history = load_history()
    history['runs'].append(record)
    history['runs'] = history['runs'][-MAX_RUNS:]

    os.makedirs(AUTH_DIR, exist_ok=True)
    tmp = HISTORY_PATH + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(history, f, indent=2)
    os.replace(tmp, HISTORY_PATH)
    try:
        os.chmod(HISTORY_PATH, 0o600)
    except OSError:
        pass
    return history
