import json
import os

AUTH_DIR = os.environ.get('EVE_BUYBACK_DATA_DIR') or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', '.eve_auth'
)
CONFIG_PATH = os.path.join(AUTH_DIR, 'config.json')
TOKEN_CACHE_PATH = os.path.join(AUTH_DIR, 'tokens.json')

DEFAULT_STRUCTURES = [
    {'name': 'Fort', 'id': 0, 'accepts': ['non-ore']},
    {'name': 'Drill', 'id': 0, 'accepts': ['ore', 'moon']},
    {'name': 'UUH', 'id': 0, 'accepts': ['ore', 'non-ore', 'moon']},
]

JANICE_MARKETS = ['Jita 4-4', 'Amarr', 'Dodixie', 'Rens']

DEFAULTS = {
    'corp_id': 0,
    'scopes': [
        'publicData',
        'esi-markets.structure_markets.v1',
        'esi-wallet.read_corporation_wallets.v1',
        'esi-contracts.read_corporation_contracts.v1',
    ],
    'structures': DEFAULT_STRUCTURES,
    'janice_market': 'Jita 4-4',
    'janice_api_key': '',
    'moon_market': 'Jita 4-4',
    'refining_efficiency': 0.78,
    'ice_refining_efficiency': 0.78,
    'non_moon_payout_fraction': 0.90,
}

_USER_KEYS = set(DEFAULTS)


def _fresh_default():
    return {**DEFAULTS, 'structures': [dict(s) for s in DEFAULT_STRUCTURES]}


def _migrate(cfg):
    """Bring older config shapes forward."""
    structs = cfg.get('structures')
    if isinstance(structs, dict):
        # Old shape: {fort_id, drill_id, uuh_id}
        migrated = []
        if structs.get('fort_id'):
            migrated.append({'name': 'Fort', 'id': structs['fort_id'], 'accepts': ['non-ore']})
        if structs.get('drill_id'):
            migrated.append({'name': 'Drill', 'id': structs['drill_id'], 'accepts': ['ore']})
        if structs.get('uuh_id'):
            migrated.append({'name': 'UUH', 'id': structs['uuh_id'], 'accepts': ['ore', 'non-ore']})
        cfg['structures'] = migrated or [dict(s) for s in DEFAULT_STRUCTURES]
    return cfg


def load_config():
    if not os.path.exists(CONFIG_PATH):
        return _fresh_default()
    with open(CONFIG_PATH) as f:
        cfg = json.load(f)
    cfg = {k: v for k, v in cfg.items() if k in _USER_KEYS}
    cfg = _migrate(cfg)
    merged = _fresh_default()
    merged.update(cfg)
    return merged


def save_config(cfg):
    cfg = {k: v for k, v in cfg.items() if k in _USER_KEYS}
    os.makedirs(AUTH_DIR, exist_ok=True)
    with open(CONFIG_PATH, 'w') as f:
        json.dump(cfg, f, indent=2)
    os.chmod(CONFIG_PATH, 0o600)
