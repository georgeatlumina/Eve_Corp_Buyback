"""SMT-style intel + live activity collectors.

Tails EVE chat-log files for the configured intel channels and matches system
names (matcher ported from Slazanger's SMT, MIT-licensed), and long-polls
zKillboard's RedisQ for a live kill feed. Both run as background daemon threads;
server.py exposes the polling endpoints. Pure collectors — no FastAPI here.
"""
import glob
import json
import os
import re
import sys
import threading
import time
import uuid

import requests

import eve_map

_LOCK = threading.Lock()
_CFG = {'log_dir': None, 'channels': []}
_INTEL = []          # list of {ts, channel, text, raw, systems:[id], system_names:[name], clear}
_KILLS = []          # list of {ts, system_id, kill_id, value, ship_type_id, npc}
_MAX = 3000
_POS = {}            # file path -> byte offset consumed
_ENC = {}            # file path -> encoding
_started = False
_UA = 'EveCorpBuyback/1.0 (SMT intel)'
_ZKILL_QID = 'ndamt-' + uuid.uuid4().hex[:12]
_INTEL_TTL = 3600.0  # keep intel events for an hour
_KILL_TTL = 3600.0

_CLEAR_MARKERS = ('clr', 'clear')

# Words that must never match a system by prefix. SMT's matcher accepts a word
# when it prefixes a system name (or vice versa), which is what lets "uexo"
# find UEXO-Z — but it also means "and" matches Andabiar/Andole/Andrub and
# "gate" matches Gateway, lighting up systems nobody reported and, since the
# alarm runs off the same match, potentially sounding for them. An exact
# full-name match still wins, so a system genuinely called Gateway is fine.
_STOPWORDS = frozenset("""
and the for with that this they them then than there here have has had was were
are you your our not but all any can cant did does dont from get got how its
into just like more much need now off out over some still such take too very
want well what when where which who why will would about after again also
back been before being both down each even few first give good great high
into keep last left long made make many most move much must near new next
once only open other same see seem send should show side since small start
stay stop sure system take tell their these thing think three through time
today under until upon used using wait want warp watch way went what while
work yes yeah yep nope
gate gates camp camped camping station stations dock docked docking undock
undocked jump jumped jumping local grid fleet fleets red reds reds neut neuts
neutral neutrals hostile hostiles friendly blue blues spike spiked clear clr
inbound outbound coming going moving heading burning holding sitting bubble
bubbled bubbles cyno cynos safe safed hole holes chain scout scouts eyes eye
""".split())
# [ 2017.05.01 18:24:28 ] Charname > message
_LINE_RE = re.compile(r'^﻿?\[\s*[\d.]+\s+[\d:]+\s*\]\s*([^>]*?)\s*>\s*(.*)$')

# Where EVE keeps its chat logs. Windows/macOS have fixed spots; on Linux the
# game runs under Wine/Proton, so the logs sit inside a bottle whose path
# depends on the launcher (Steam, Flatpak Steam, plain Wine, Lutris) and, for
# Proton, on the Steam app id. Globbing the prefix roots beats hardcoding any
# single layout — and beats hardcoding an app id that could change.
_LINUX_LOG_GLOBS = [
    '~/.steam/steam/steamapps/compatdata/*/pfx/drive_c/users/*/Documents/EVE/logs/Chatlogs',
    '~/.local/share/Steam/steamapps/compatdata/*/pfx/drive_c/users/*/Documents/EVE/logs/Chatlogs',
    '~/.var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/compatdata/*/pfx/drive_c/users/*/Documents/EVE/logs/Chatlogs',
    '~/.steam/root/steamapps/compatdata/*/pfx/drive_c/users/*/Documents/EVE/logs/Chatlogs',
    '~/.wine/drive_c/users/*/Documents/EVE/logs/Chatlogs',
    '~/Games/*/drive_c/users/*/Documents/EVE/logs/Chatlogs',
    '~/.local/share/lutris/runners/*/*/drive_c/users/*/Documents/EVE/logs/Chatlogs',
    # Some bottles redirect Documents into the Wine user's home instead.
    '~/.wine/drive_c/users/*/My Documents/EVE/logs/Chatlogs',
]

_FIXED_LOG_DIRS = [
    '~/Documents/EVE/logs/Chatlogs',
    '~/EVE/logs/Chatlogs',
    # Windows Documents is often redirected into OneDrive.
    '~/OneDrive/Documents/EVE/logs/Chatlogs',
    '~/Library/Application Support/EVE Online/p_drive/User/My Documents/EVE/logs/Chatlogs',
]


def default_log_dirs():
    """Candidate chat-log folders for this machine, existing ones first. Scanned
    fresh each call so a bottle created after startup is still found."""
    out, seen = [], set()

    def add(path):
        if path and path not in seen:
            seen.add(path)
            out.append(path)

    for d in _FIXED_LOG_DIRS:
        add(os.path.expanduser(d))
    if sys.platform.startswith('linux'):
        for pat in _LINUX_LOG_GLOBS:
            try:
                for hit in sorted(glob.glob(os.path.expanduser(pat))):
                    add(hit)
            except OSError:
                continue
    return out


# Kept for callers that just want the list; prefer default_log_dirs().
DEFAULT_LOG_DIRS = default_log_dirs()

# ---- system-name matching (ported from SMT EveManager.cs) --------------------
_NAME_LIST = None  # [(name_lower, name, system_id)]


def _name_list():
    global _NAME_LIST
    if _NAME_LIST is None:
        d = eve_map.load_map()
        _NAME_LIST = [(rec['name'].lower(), rec['name'], int(sid)) for sid, rec in d['systems'].items()]
    return _NAME_LIST


def _match_systems(text):
    """For each word (len >= 3): a system matches if the word is a prefix of the
    system name OR the system name is a prefix of the word (case-insensitive).
    Also flags a clear marker ("clr"/"clear"). Returns
    (ids, names, clear, spans) — spans being where in `text` each hit sat, so
    the feed can highlight the words themselves."""
    ids, names, clear, spans = [], [], False, []
    seen = set()
    for m in re.finditer(r'\S+', text):
        w = m.group(0)
        wl = w.strip().lower()
        if len(wl) < 3:
            continue
        for marker in _CLEAR_MARKERS:
            if marker.startswith(wl):
                clear = True
        hit = None
        stop = wl in _STOPWORDS
        for nml, nm, sid in _name_list():
            # A stopword may still be a system's actual full name; only its
            # loose prefix matches are suppressed.
            if nml == wl or (not stop and (nml.startswith(wl) or wl.startswith(nml))):
                if hit is None:
                    hit = sid
                if sid not in seen:
                    seen.add(sid)
                    ids.append(sid)
                    names.append(nm)
        if hit is not None:
            # Trim trailing punctuation so "UEXO-Z," highlights just the name.
            a, b = m.span()
            while b > a and text[b - 1] in ',.;:!?)]}':
                b -= 1
            spans.append({'s': a, 'e': b, 'k': 'sys', 'id': hit})
    return ids, names, clear, spans


# ---- ship names --------------------------------------------------------------
_SHIP_RE = None
_SHIP_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'ship_names.json')


def _ship_re():
    """One compiled alternation over every ship name and bit of fleet slang.
    Longest-first so "Armageddon Navy Issue" wins over "Armageddon", and
    word-bounded so "Loki" doesn't match inside another word."""
    global _SHIP_RE
    if _SHIP_RE is None:
        try:
            with open(_SHIP_PATH, encoding='utf-8') as f:
                d = json.load(f)
            terms = list(d.get('ships') or []) + list(d.get('slang') or [])
        except (OSError, ValueError):
            terms = []
        if not terms:
            _SHIP_RE = re.compile(r'(?!x)x')      # matches nothing
        else:
            terms.sort(key=len, reverse=True)
            _SHIP_RE = re.compile(r'\b(?:' + '|'.join(re.escape(t) for t in terms) + r')\b', re.I)
    return _SHIP_RE


def _annotate(text, sys_spans):
    """Merge the system spans with ship-name spans into one ordered,
    non-overlapping list of {s, e, k} for the renderers to highlight. Systems
    win any overlap — a system name is the more useful thing to see."""
    spans = [dict(x) for x in sys_spans]
    for m in _ship_re().finditer(text):
        a, b = m.span()
        if any(a < x['e'] and x['s'] < b for x in spans):
            continue
        spans.append({'s': a, 'e': b, 'k': 'ship'})
    spans.sort(key=lambda x: x['s'])
    return spans


# ---- chat-log tailing --------------------------------------------------------
def _channel_files(log_dir):
    """{channel_name: newest_file_path} for every channel log in the dir."""
    out = {}
    if not log_dir or not os.path.isdir(log_dir):
        return out
    for path in glob.glob(os.path.join(log_dir, '*.txt')):
        m = re.match(r'(.+?)_\d{8}_\d{6}_\d+\.txt$', os.path.basename(path))
        if not m:
            continue
        ch = m.group(1)
        try:
            if ch not in out or os.path.getmtime(path) > os.path.getmtime(out[ch]):
                out[ch] = path
        except OSError:
            continue
    return out


def list_channels():
    with _LOCK:
        log_dir = _CFG['log_dir']
    return sorted(_channel_files(log_dir).keys(), key=str.lower)


def _process_line(raw, channel):
    if 'Channel MOTD:' in raw:
        return
    m = _LINE_RE.match(raw)
    if not m:
        return
    speaker = (m.group(1) or '').strip()
    msg = m.group(2).strip()
    if not msg:
        return
    now = time.time()
    with _LOCK:
        for e in reversed(_INTEL):          # 5s dedup on identical text
            if now - e['ts'] > 5:
                break
            if e['text'] == msg:
                return
    ids, names, clear, sys_spans = _match_systems(msg)
    spans = _annotate(msg, sys_spans)
    with _LOCK:
        _INTEL.append({'ts': now, 'channel': channel, 'text': msg, 'raw': raw,
                       'speaker': speaker, 'spans': spans,
                       'systems': ids, 'system_names': names, 'clear': clear})
        if len(_INTEL) > _MAX:
            del _INTEL[:len(_INTEL) - _MAX]


def _poll_intel_once():
    with _LOCK:
        log_dir = _CFG['log_dir']
        channels = list(_CFG['channels'])
    if not log_dir or not channels:
        return
    files = _channel_files(log_dir)
    lower = {k.lower(): v for k, v in files.items()}
    for ch in channels:
        path = files.get(ch) or lower.get(ch.lower())
        if not path:
            continue
        try:
            size = os.path.getsize(path)
        except OSError:
            continue
        if path not in _POS:                 # first sight → detect encoding, skip to end
            try:
                with open(path, 'rb') as f:
                    head = f.read(3)
            except OSError:
                continue
            _ENC[path] = 'utf-8' if head[:3] == b'\xef\xbb\xbf' else 'utf-16-le'
            _POS[path] = size
            continue
        pos = _POS[path]
        if size < pos:                       # rotated / truncated
            pos = 0
        if size <= pos:
            continue
        try:
            with open(path, 'rb') as f:
                f.seek(pos)
                data = f.read()
        except OSError:
            continue
        enc = _ENC.get(path, 'utf-16-le')
        nl = b'\x0a\x00' if enc == 'utf-16-le' else b'\x0a'
        cut = data.rfind(nl)                 # only consume up to the last complete line
        if cut == -1:
            continue
        consume = data[:cut + len(nl)]
        _POS[path] = pos + len(consume)
        for line in consume.decode(enc, errors='ignore').splitlines():
            _process_line(line, ch)


# ---- zKillboard RedisQ live feed --------------------------------------------
def _poll_zkill_once():
    try:
        r = requests.get('https://redisq.zkillboard.com/listen.php',
                         params={'queueID': _ZKILL_QID, 'ttw': 10},
                         headers={'User-Agent': _UA}, timeout=25)
        if r.status_code != 200:
            time.sleep(5)
            return
        pkg = (r.json() or {}).get('package')
        if not pkg:
            return
        km = pkg.get('killmail') or {}
        zkb = pkg.get('zkb') or {}
        sid = km.get('solar_system_id')
        if not sid:
            return
        with _LOCK:
            _KILLS.append({'ts': time.time(), 'system_id': int(sid),
                           'kill_id': pkg.get('killID') or km.get('killmail_id'),
                           'value': zkb.get('totalValue'),
                           'ship_type_id': (km.get('victim') or {}).get('ship_type_id'),
                           'npc': bool(zkb.get('npc'))})
            if len(_KILLS) > _MAX:
                del _KILLS[:len(_KILLS) - _MAX]
    except Exception:  # noqa: BLE001 — network hiccup; back off
        time.sleep(5)


# ---- Thera / Turnur wormhole connections (eve-scout) ------------------------
_HUBS = {31000005: 'Thera', 30002086: 'Turnur'}
_thera = {'ts': 0.0, 'conns': [], 'err': None}
_THERA_TTL = 180.0


def _fetch_thera():
    r = requests.get('https://api.eve-scout.com/v2/public/signatures',
                     headers={'User-Agent': _UA, 'Accept': 'application/json'}, timeout=25)
    r.raise_for_status()
    sysd = eve_map.load_map()['systems']
    conns = []
    for s in (r.json() or []):
        if s.get('signature_type') != 'wormhole':
            continue
        a, b = s.get('in_system_id'), s.get('out_system_id')
        an, bn = s.get('in_system_name'), s.get('out_system_name')
        if a in _HUBS:
            hub, hub_name, other, other_name = a, _HUBS[a], b, bn
        elif b in _HUBS:
            hub, hub_name, other, other_name = b, _HUBS[b], a, an
        else:
            continue
        if not other or str(other) not in sysd:   # only k-space exits are routable here
            continue
        rec = sysd.get(str(other)) or {}
        conns.append({'hub_id': hub, 'hub': hub_name, 'system_id': int(other),
                      'system': other_name or rec.get('name'), 'region': rec.get('region'),
                      'sec': rec.get('sec'), 'wh_type': s.get('wh_type'),
                      'max_ship_size': s.get('max_ship_size'),
                      'remaining_hours': s.get('remaining_hours'), 'expires_at': s.get('expires_at')})
    conns.sort(key=lambda c: (c['hub'], c['region'] or '~', c['system'] or ''))
    return conns


def get_thera(force=False):
    now = time.time()
    if not force and _thera['conns'] and now - _thera['ts'] < _THERA_TTL:
        return {'connections': _thera['conns'], 'ts': _thera['ts'], 'error': _thera['err']}
    try:
        _thera['conns'] = _fetch_thera()
        _thera['ts'] = now
        _thera['err'] = None
    except Exception as e:  # noqa: BLE001
        _thera['err'] = f'{type(e).__name__}: {e}'
    return {'connections': _thera['conns'], 'ts': _thera['ts'], 'error': _thera['err']}


def thera_edges():
    """(hub_id, system_id) pairs for routing. Turnur is a real system; Thera
    (31000005) is virtual (see THERA_VIRTUAL)."""
    return [(c['hub_id'], c['system_id']) for c in get_thera()['connections']]


THERA_VIRTUAL = {31000005: 'Thera'}


# ---- lifecycle ---------------------------------------------------------------
def _intel_loop():
    while True:
        try:
            _poll_intel_once()
            _prune()
        except Exception:  # noqa: BLE001
            pass
        time.sleep(2)


def _zkill_loop():
    while True:
        _poll_zkill_once()   # long-poll blocks up to ttw seconds


def _prune():
    cut = time.time() - max(_INTEL_TTL, _KILL_TTL)
    with _LOCK:
        if _INTEL and _INTEL[0]['ts'] < cut:
            keep = time.time() - _INTEL_TTL
            _INTEL[:] = [e for e in _INTEL if e['ts'] >= keep]
        keep = time.time() - _KILL_TTL
        if _KILLS and _KILLS[0]['ts'] < keep:
            _KILLS[:] = [k for k in _KILLS if k['ts'] >= keep]


def ensure_started():
    global _started
    with _LOCK:
        if _started:
            return
        _started = True
        if not _CFG['log_dir']:
            _CFG['log_dir'] = next((d for d in default_log_dirs() if os.path.isdir(d)), None)
    threading.Thread(target=_intel_loop, daemon=True, name='smt-intel').start()
    threading.Thread(target=_zkill_loop, daemon=True, name='smt-zkill').start()


# ---- public API for server.py -----------------------------------------------
def set_config(log_dir, channels):
    with _LOCK:
        _CFG['log_dir'] = (log_dir or '').strip() or None
        _CFG['channels'] = [c for c in (channels or []) if c]
        _POS.clear()   # re-scan from the ends of the new channel files
        _ENC.clear()


def get_config():
    with _LOCK:
        return {'log_dir': _CFG['log_dir'], 'channels': list(_CFG['channels'])}


def get_intel(since=0.0):
    now = time.time()
    with _LOCK:
        events = [dict(e) for e in _INTEL if e['ts'] > since]
        watching = bool(_CFG['log_dir'] and _CFG['channels'])
        log_dir = _CFG['log_dir']
    return {'events': events, 'ts': now, 'watching': watching,
            'log_dir_ok': bool(log_dir and os.path.isdir(log_dir))}


def get_kills(since=0.0):
    now = time.time()
    with _LOCK:
        kills = [dict(k) for k in _KILLS if k['ts'] > since]
    return {'kills': kills, 'ts': now}
