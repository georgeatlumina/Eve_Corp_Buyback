"""SMT-style intel + live activity collectors.

Tails EVE chat-log files for the configured intel channels and matches system
names (matcher ported from Slazanger's SMT, MIT-licensed), and long-polls
zKillboard's RedisQ for a live kill feed. Both run as background daemon threads;
server.py exposes the polling endpoints. Pure collectors — no FastAPI here.
"""
import glob
import os
import re
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
# [ 2017.05.01 18:24:28 ] Charname > message
_LINE_RE = re.compile(r'^﻿?\[\s*[\d.]+\s+[\d:]+\s*\]\s*[^>]*>\s*(.*)$')

DEFAULT_LOG_DIRS = [
    os.path.expanduser('~/Documents/EVE/logs/Chatlogs'),
    os.path.expanduser('~/EVE/logs/Chatlogs'),
    os.path.expanduser('~/Library/Application Support/EVE Online/p_drive/User/My Documents/EVE/logs/Chatlogs'),
]

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
    Also flags a clear marker ("clr"/"clear"). Returns (ids, names, clear)."""
    ids, names, clear = [], [], False
    seen = set()
    for w in text.split():
        wl = w.strip().lower()
        if len(wl) < 3:
            continue
        for marker in _CLEAR_MARKERS:
            if marker.startswith(wl):
                clear = True
        for nml, nm, sid in _name_list():
            if (nml.startswith(wl) or wl.startswith(nml)) and sid not in seen:
                seen.add(sid)
                ids.append(sid)
                names.append(nm)
    return ids, names, clear


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
    msg = m.group(1).strip()
    if not msg:
        return
    now = time.time()
    with _LOCK:
        for e in reversed(_INTEL):          # 5s dedup on identical text
            if now - e['ts'] > 5:
                break
            if e['text'] == msg:
                return
    ids, names, clear = _match_systems(msg)
    with _LOCK:
        _INTEL.append({'ts': now, 'channel': channel, 'text': msg, 'raw': raw,
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
            _CFG['log_dir'] = next((d for d in DEFAULT_LOG_DIRS if os.path.isdir(d)), None)
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
