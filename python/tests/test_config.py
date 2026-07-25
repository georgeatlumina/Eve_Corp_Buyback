"""Tests for config defaults and the load/save merge.

Guards the release change that makes alliance quota auto-sync default to on,
plus the merge invariant the change relies on: a value already saved in a
user's config must win over the built-in default.
"""
import json
import os
import sys
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


@pytest.fixture()
def cfg_path(tmp_path):
    """Point config.py at a throwaway config.json."""
    import config
    p = tmp_path / 'config.json'
    with patch.object(config, 'CONFIG_PATH', str(p)), \
         patch.object(config, 'AUTH_DIR', str(tmp_path)):
        yield config, str(p)


class TestAutoSyncDefault:
    def test_defaults_to_on_for_a_fresh_install(self, cfg_path):
        config, _ = cfg_path  # no file on disk
        assert config.load_config()['alliance_quota_auto_sync'] is True

    def test_a_saved_off_value_survives_the_merge(self, cfg_path):
        """Users who deliberately turned auto-sync off must stay off."""
        config, path = cfg_path
        with open(path, 'w') as f:
            json.dump({'alliance_quota_auto_sync': False}, f)
        assert config.load_config()['alliance_quota_auto_sync'] is False

    def test_a_saved_on_value_is_preserved(self, cfg_path):
        config, path = cfg_path
        with open(path, 'w') as f:
            json.dump({'alliance_quota_auto_sync': True}, f)
        assert config.load_config()['alliance_quota_auto_sync'] is True


class TestLoadSaveMerge:
    def test_missing_keys_fall_back_to_defaults(self, cfg_path):
        config, path = cfg_path
        with open(path, 'w') as f:
            json.dump({'home_structure_id': 12345}, f)
        loaded = config.load_config()
        assert loaded['home_structure_id'] == 12345          # from file
        assert loaded['alliance_quota_auto_sync'] is True      # from defaults

    def test_save_then_load_roundtrips_a_value(self, cfg_path):
        config, _ = cfg_path
        cfg = config.load_config()
        cfg['home_structure_id'] = 98765
        config.save_config(cfg)
        assert config.load_config()['home_structure_id'] == 98765

    def test_save_drops_keys_not_in_the_schema(self, cfg_path):
        config, path = cfg_path
        cfg = config.load_config()
        cfg['not_a_real_setting'] = 'nope'
        config.save_config(cfg)
        with open(path) as f:
            on_disk = json.load(f)
        assert 'not_a_real_setting' not in on_disk
