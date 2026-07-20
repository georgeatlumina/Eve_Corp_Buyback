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

DEFAULT_MAIL_PRESETS = [
    {
        'label': 'Accepted',
        'subject': 'Buyback accepted',
        'body': 'Your contract {contract_id} dated {date} has been accepted.\n\nPayout: {payout}\n\no7',
    },
    {
        'label': 'Needs fix',
        'subject': 'Buyback needs correction',
        'body': 'Hi {issuer_name},\n\nYour contract {contract_id} has the following issues:\n{errors}\n\nPlease re-issue once corrected.\n\no7',
    },
    {'label': '', 'subject': '', 'body': ''},
    {'label': '', 'subject': '', 'body': ''},
]

DEFAULTS = {
    'corp_id': 0,
    'scopes': [
        'publicData',
        'esi-markets.structure_markets.v1',
        'esi-wallet.read_corporation_wallets.v1',
        'esi-contracts.read_corporation_contracts.v1',
        'esi-contracts.read_character_contracts.v1',
        'esi-mail.send_mail.v1',
        'esi-corporations.read_structures.v1',
        # Liquidation page: read the corp's open market (sell) orders in Jita so
        # open positions auto-reconcile. Needs Accountant or Trader corp role on
        # the authed character.
        'esi-markets.read_corporation_orders.v1',
    ],
    'structures': DEFAULT_STRUCTURES,
    'janice_market': 'Jita 4-4',
    'janice_api_key': '',
    'moon_market': 'Jita 4-4',
    'moon_ore_refining_efficiency': 0.78,
    'non_moon_ore_refining_efficiency': 0.78,
    'ice_refining_efficiency': 0.78,
    'moon_payout_fraction': 0.80,
    'non_moon_payout_fraction': 0.90,
    'mail_presets': DEFAULT_MAIL_PRESETS,
    # SRP rejection mail template (sent from the SRP tab on reject). Variables:
    # {pilot} {ship} {fleet} {fc} {kill_link} {loss_value} {reason} {date}
    'srp_reject_subject': 'SRP request rejected — {ship}',
    'srp_reject_body': (
        'Hi {pilot},\n\n'
        'Your SRP request for your {ship} ({kill_link}) from fleet "{fleet}" '
        'was not approved.\n\n'
        'If you believe this was in error, reach out on Discord.\n\no7'
    ),
    # How in-app external links (zKillboard, Janice, etc.) open:
    #   'panel'  -> dockable side panel with a pop-out button (same window)
    #   'window' -> straight into its own window
    'link_open_mode': 'panel',
    # Contracts page settings.
    'home_structure_id': 0,
    'home_region_id': 0,
    # List of {name, ship_type_id, ship_name, required, title_filter}.
    'quotas': [],
    # Institute (NLDF) doctrine quotas — same shape as quotas above.
    'quotas_institute': [],
    # EVE alliance IDs used to route contract scans per alliance.
    # Set these in Config so the alliance selector knows which slots belong to which alliance.
    'alliance_id_main': 0,
    'alliance_id_institute': 0,
    # Optional alliance-wide quota distribution: admin hosts a JSON file
    # (GitHub Gist raw URL, raw.githubusercontent.com, or any reachable
    # https endpoint) and users sync from it. Auto-sync hits the URL once
    # at sidecar startup if both URL and flag are set.
    'alliance_quota_url': '',
    'alliance_quota_auto_sync': False,
    'alliance_quota_last_synced': '',   # ISO timestamp of last successful sync
    'alliance_quota_last_status': '',   # short human-readable last result
    # Private-repo workflow (GitHub Contents API). Two PATs: a read-only one
    # the alliance admin distributes to every member for sync, and a
    # read+write one kept on the admin's machine for pushing changes back.
    # The Push button in the UI is gated on `alliance_quota_allow_push` so a
    # regular user pasting the admin's exported config doesn't unlock the
    # button just by having the write PAT in their file.
    'alliance_quota_pat_read': '',
    'alliance_quota_pat_write': '',
    'alliance_quota_allow_push': False,
    # Market-history archive: a dedicated private GitHub repo accumulates one
    # gzipped full-depth market snapshot per day (ESI exposes no history for
    # player structures, so we build our own). Read PAT for future analytics
    # reads, Write PAT for the daily push. Every client archives — the push is
    # idempotent (one file per day, skipped if it already exists). The repo URL
    # is the bare clone/blob URL; the per-day path is generated server-side.
    'market_history_repo_url': '',
    'market_history_pat_read': '',
    'market_history_pat_write': '',
    'market_history_last_archived': '',  # ISO timestamp of last push (per-machine)
    # ---- Stockpile page ----
    # Alliance industry-material stock levels. The admin pastes an EVE
    # inventory/asset list; the sidecar resolves + categorizes it and pushes a
    # JSON doc to the market-history repo at `inventory/stock.json` (shared,
    # SHA-checked writes — same repo + PATs as the liquidation board). Industry
    # pilots read it. The tab is client-side gated on Alliance Auth membership
    # in the group named below (a UX filter, not a security boundary — the real
    # protection is the repo PAT). `stockpile_allow_push` unhides the admin
    # paste/save panel, mirroring `alliance_quota_allow_push`.
    'stockpile_group_name': 'Industry',
    'stockpile_allow_push': False,
    'stockpile_last_synced': '',   # ISO timestamp of last successful push
    'stockpile_last_status': '',   # short human-readable last result
    # ---- Liquidation page ----
    # Buyback items are shipped Amarr -> Jita and sold. Cost basis = the payout
    # fraction of the live Janice Amarr *buy* price; margin is measured against
    # the live Jita sell/buy prices net of the fees below.
    'liquidation_buyback_fraction': 0.90,   # what the corp pays vs Amarr buy
    'liquidation_cost_market': 'Amarr',     # Janice market the cost basis prices from
    'liquidation_sell_market': 'Jita 4-4',  # Janice market items are sold in
    'liquidation_broker_fee_pct': 3.0,      # Jita sell-order listing broker fee (%)
    'liquidation_sales_tax_pct': 3.37,      # sales tax on a completed sale (%)
    'liquidation_min_margin_pct': 10.0,     # below this net margin -> prefer dumping
    'liquidation_min_annual_roi_pct': 50.0, # velocity floor for holding a listing
    'liquidation_window_safety': 1.3,       # days_to_sell * this must fit the window
    'liquidation_stale_factor': 1.5,        # age > expected_sell * this => STALE
    'liquidation_vol_window_days': 20,      # trailing days of ESI history for avg volume
    # The Forge / Jita 4-4 numeric IDs (region + station) for ESI market pulls.
    'liquidation_sell_region_id': 10000002,
    'liquidation_sell_station_id': 60003760,
    'liquidation_sell_system_id': 30000142,  # Jita (for buy-order range matching)
    # PushX courier rate card (see the in-app blurb). Cost is computed per
    # shipment from these; collateral = Janice Jita sell value of the shipment.
    'courier_base_isk': 450_000_000,
    'courier_max_volume_m3': 360_000,
    'courier_collateral_free_isk': 5_000_000_000,
    'courier_collateral_step_isk': 5_000_000_000,
    'courier_collateral_step_fee_isk': 50_000_000,
    'courier_rush_fee_isk': 200_000_000,
    'courier_accept_days': 3,
    'courier_deliver_days': 3,
    # Courier provider the Shipments view highlights among the corp's ESI
    # courier contracts (substring match on the assignee name). Blank = show all.
    'courier_provider_name': 'Push Industries',
}

_USER_KEYS = set(DEFAULTS)


def _fresh_default():
    return {
        **DEFAULTS,
        'structures': [dict(s) for s in DEFAULT_STRUCTURES],
        'mail_presets': [dict(p) for p in DEFAULT_MAIL_PRESETS],
    }


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

    # Ensure all baseline scopes are present so newer features (e.g. mail send)
    # work after an app upgrade without manually editing the persisted config.
    saved_scopes = list(cfg.get('scopes') or [])
    for s in DEFAULTS['scopes']:
        if s not in saved_scopes:
            saved_scopes.append(s)
    cfg['scopes'] = saved_scopes

    # Split legacy single refining_efficiency into moon-ore and non-moon-ore
    # buckets. Both inherit the old value so existing users see no change in
    # payout numbers until they explicitly edit one.
    if 'refining_efficiency' in cfg:
        legacy = cfg.pop('refining_efficiency')
        try:
            legacy_val = float(legacy)
        except (TypeError, ValueError):
            legacy_val = 0.78
        cfg.setdefault('moon_ore_refining_efficiency', legacy_val)
        cfg.setdefault('non_moon_ore_refining_efficiency', legacy_val)

    # The Contracts page setting was originally called home_station_id back
    # when the lookup helper only worked for NPC stations; the actual filter
    # has always been on start_location_id, which equally accepts a structure
    # id. Carry old values forward under the new name.
    if 'home_station_id' in cfg and not cfg.get('home_structure_id'):
        cfg['home_structure_id'] = cfg.pop('home_station_id')
    cfg.pop('home_station_id', None)

    return cfg


def load_config():
    if not os.path.exists(CONFIG_PATH):
        return _fresh_default()
    with open(CONFIG_PATH) as f:
        cfg = json.load(f)
    # Migrate FIRST so legacy keys (e.g. home_station_id) can be renamed
    # before the _USER_KEYS filter would otherwise drop them.
    cfg = _migrate(cfg)
    cfg = {k: v for k, v in cfg.items() if k in _USER_KEYS}
    merged = _fresh_default()
    merged.update(cfg)
    return merged


def save_config(cfg):
    cfg = {k: v for k, v in cfg.items() if k in _USER_KEYS}
    os.makedirs(AUTH_DIR, exist_ok=True)
    with open(CONFIG_PATH, 'w') as f:
        json.dump(cfg, f, indent=2)
    os.chmod(CONFIG_PATH, 0o600)
