"""Tests for the crash-safe JSON store behind config.json and tokens.json.

Guards the fix for "Token exchange failed: Expecting ',' delimiter": the token
cache is read-modify-written from every authenticated call, and an endpoint like
/api/smt/characters refreshes up to 24 slots in one request. The old code held
no lock and truncated the file before writing, so concurrent refreshes
interleaved into unparseable JSON — and once corrupt, re-authing hit the same
parse error on its way to saving, which wedged the app for good.
"""
import json
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


@pytest.fixture()
def store(tmp_path, monkeypatch):
    """auth.py pointed at a throwaway token cache."""
    import config
    import auth
    p = tmp_path / 'tokens.json'
    monkeypatch.setattr(config, 'TOKEN_CACHE_PATH', str(p))
    monkeypatch.setattr(auth, 'TOKEN_CACHE_PATH', str(p))
    return auth, str(p)


def _tok(v):
    return {'access_token': v, 'refresh_token': f'r-{v}', 'expires_in': 1200}


class TestConcurrentWrites:
    def test_parallel_slot_saves_keep_the_file_parseable(self, store):
        auth, path = store
        slots = list(auth.VALID_SLOTS) + list(auth.PI_SLOTS) + list(auth.SMT_SLOTS)
        errors = []

        def worker(slot):
            try:
                for i in range(15):
                    auth.save_cached_tokens(_tok(f'{slot}-{i}'), slot=slot)
            except Exception as e:  # noqa: BLE001
                errors.append(f'{slot}: {e}')

        threads = [threading.Thread(target=worker, args=(s,)) for s in slots]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert errors == []
        with open(path) as f:
            data = json.load(f)          # the crux: still valid JSON
        # No slot may be dropped by a concurrent write landing on top of it.
        # SSO rotates refresh tokens, so a lost update is a dead token.
        assert sorted(data) == sorted(slots)
        assert all(data[s]['access_token'] == f'{s}-14' for s in slots)

    def test_no_temp_files_are_left_behind(self, store):
        auth, path = store
        for i in range(20):
            auth.save_cached_tokens(_tok(f'a{i}'), slot='slot1')
        leftovers = [f for f in os.listdir(os.path.dirname(path)) if f.startswith('.tmp-')]
        assert leftovers == []


class TestCorruptionRecovery:
    def test_a_truncated_file_falls_back_to_the_backup(self, store):
        auth, path = store
        auth.save_cached_tokens(_tok('good'), slot='slot1')
        auth.save_cached_tokens(_tok('newer'), slot='slot1')   # now there's a .bak
        with open(path) as f:
            raw = f.read()
        with open(path, 'w') as f:
            f.write(raw[:len(raw) // 2])                       # a half-finished write

        assert auth.load_cached_tokens('slot1') is not None    # used to raise
        assert os.path.exists(path + '.bak')

    def test_re_auth_works_against_a_corrupt_cache(self, store):
        """The bug users actually hit: the one action that fixes it was blocked
        by it, surfacing as "Token exchange failed: Expecting ',' delimiter"."""
        auth, path = store
        with open(path, 'w') as f:
            f.write('{"slot1": {"access_')

        auth.save_cached_tokens(_tok('after-reauth'), slot='slot1')
        assert auth.load_cached_tokens('slot1')['access_token'] == 'after-reauth'

    def test_an_unreadable_file_is_kept_for_diagnosis(self, store):
        auth, path = store
        with open(path, 'w') as f:
            f.write('not json at all')
        auth._load_all_slots()
        quarantined = [f for f in os.listdir(os.path.dirname(path)) if '.corrupt-' in f]
        assert len(quarantined) == 1

    def test_a_missing_file_is_not_an_error(self, store):
        auth, _ = store
        assert auth._load_all_slots() == {}
