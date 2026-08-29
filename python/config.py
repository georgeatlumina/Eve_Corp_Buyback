import json
import os
import shutil
import tempfile
import threading
import time

AUTH_DIR = os.environ.get('EVE_BUYBACK_DATA_DIR') or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', '.eve_auth'
)
CONFIG_PATH = os.path.join(AUTH_DIR, 'config.json')
TOKEN_CACHE_PATH = os.path.join(AUTH_DIR, 'tokens.json')

# One lock per file. auth.py reaches for TOKEN_LOCK so both modules serialise
# against the same object rather than each holding their own.
CONFIG_LOCK = threading.RLock()
TOKEN_LOCK = threading.RLock()

# ---- crash-safe JSON storage ------------------------------------------------
# Both files under AUTH_DIR (config.json and tokens.json) are read-modify-write
# from many places at once: FastAPI serves on a thread pool, and an endpoint
# like /api/smt/characters refreshes tokens for up to 24 slots in one request.
# A plain open(path, 'w') truncates first and writes after, which loses the file
# outright if the process dies in between — and the updater deliberately kills
# the sidecar process tree so the installer can replace it. Two threads doing it
# at once interleave into unparseable JSON.
#
# So: writes go to a temp file in the same directory and are swapped in with
# os.replace (atomic on both Windows and POSIX), the previous copy is kept as
# .bak, and every read-modify-write cycle holds a lock.

def _atomic_write_json(path, data, lock):
    with lock:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix='.tmp-', suffix='.json')
        try:
            with os.fdopen(fd, 'w') as f:
                json.dump(data, f, indent=2)
                f.flush()
                os.fsync(f.fileno())          # the bytes must be on disk before the swap
            try:
                os.chmod(tmp, 0o600)
            except OSError:
                pass                          # best effort; Windows ACLs don't map cleanly
            if os.path.exists(path):
                try:
                    shutil.copy2(path, path + '.bak')
                except OSError:
                    pass                      # a missing backup must not block the write
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise


def _read_json_resilient(path, lock):
    """Parse `path`, falling back to its .bak and finally to None.

    A corrupt file used to raise out of every caller, which wedged the whole
    app: the token cache is read by every authenticated call, and re-authing to
    fix it hit the same parse on the way to saving. Now a bad file is set aside
    (.corrupt-<epoch>, kept for diagnosis) and the last good copy takes over, so
    at worst one slot needs a re-auth instead of all of them.
    """
    with lock:
        if not os.path.exists(path):
            return None
        try:
            with open(path) as f:
                return json.load(f)
        except (ValueError, OSError) as e:
            try:
                os.replace(path, f'{path}.corrupt-{int(time.time())}')
            except OSError:
                pass
            print(f'[store] {os.path.basename(path)} unreadable ({e}); trying backup', flush=True)
        bak = path + '.bak'
        if os.path.exists(bak):
            try:
                with open(bak) as f:
                    data = json.load(f)
                shutil.copy2(bak, path)       # reinstate it so the next write has a base
                print(f'[store] recovered {os.path.basename(path)} from backup', flush=True)
                return data
            except (ValueError, OSError) as e:
                print(f'[store] backup unusable ({e}); starting fresh', flush=True)
        return None


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
        # Fitting sync: read/write the character's in-game saved fittings so the
        # Fitting tab can open and save fits. Also requested by the dedicated
        # fitting slots (auth.FIT_SCOPES) for extra characters.
        'esi-fittings.read_fittings.v1',
        'esi-fittings.write_fittings.v1',
        # Resolve moon/ore-buyback contract locations (player structures) to
        # names. Only ESI endpoint that returns citadel names; needs docking
        # access too. Enable it in the EVE developer portal before release, or
        # structure locations just fall back to their numeric id.
        'esi-universe.read_structures.v1',
        # My Assets tab + the reactions auto-detect: read the character's assets
        # (type, quantity, location). Also requested by the PI + fitting slots
        # (auth.PI_SCOPES / FIT_SCOPES) so every connected toon's assets show.
        'esi-assets.read_assets.v1',
        # NB: the PI colony scope (esi-planets.manage_planets.v1) is NOT here —
        # it's requested only by the dedicated PI slots (auth.PI_SCOPES) so PI
        # alts can be authorized without re-scoping the main characters.
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
    'alliance_quota_auto_sync': True,
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
    # Buyback items are shipped to Jita and sold. Cost basis = the payout
    # fraction of the live Janice *buy* price on the configured market hub
    # (`janice_market`), so it tracks the buyback hub automatically; margin is
    # measured against the live Jita sell/buy prices net of the fees below.
    'liquidation_buyback_fraction': 0.90,   # what the corp pays vs hub buy
    'liquidation_cost_market': 'Jita 4-4',  # deprecated/unused — cost basis now follows `janice_market`
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
    # ---- Planetary Interaction (PI planner) ----
    # POCO export tax rate used when scoring PI production chains: each produced
    # tier pays tax_rate * base_value on export through the customs office. 0.05
    # is the NPC high-sec baseline; player-owned null POCOs are often lower. The
    # PI tab can override this per-analysis, but this is the saved default.
    'pi_poco_tax_rate': 0.05,
    # Folder the EVE client reads/writes PI colony templates from. Blank = the
    # standard location (<Documents>/EVE/PlanetaryInteractionTemplates). The PI
    # layout builder lists saved templates here and saves exports straight to it.
    'pi_templates_dir': '',
    # ---- Acquisitions analysis thresholds ----
    # Hull must have at least this fraction of modules in stock to generate
    # a shopping list. 0.5 = 50% inventory coverage required.
    'acq_shopping_min_coverage': 0.5,
    # Hull's missing modules (priced at UEXO min) must total less than this
    # ISK value to generate a shopping list. 500m default.
    'acq_shopping_max_isk_gap': 500_000_000.0,
}

_USER_KEYS = set(DEFAULTS) | {'smt_log_dir', 'smt_channels', 'smt_jump_bridges', 'smt_alerts', 'smt_watchlist'}


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
    # Also strip any scopes that are no longer valid (e.g. esi-fleets.read_fleet.v1
    # was removed from the ESI spec and causes OAuth errors if requested).
    _removed_scopes = {'esi-fleets.read_fleet.v1'}
    saved_scopes = [s for s in (cfg.get('scopes') or []) if s not in _removed_scopes]
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
    cfg = _read_json_resilient(CONFIG_PATH, CONFIG_LOCK)
    if not isinstance(cfg, dict):
        return _fresh_default()
    # Migrate FIRST so legacy keys (e.g. home_station_id) can be renamed
    # before the _USER_KEYS filter would otherwise drop them.
    cfg = _migrate(cfg)
    cfg = {k: v for k, v in cfg.items() if k in _USER_KEYS}
    merged = _fresh_default()
    merged.update(cfg)
    return merged


def save_config(cfg):
    cfg = {k: v for k, v in cfg.items() if k in _USER_KEYS}
    _atomic_write_json(CONFIG_PATH, cfg, CONFIG_LOCK)
