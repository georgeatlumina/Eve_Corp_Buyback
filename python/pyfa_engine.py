"""Headless bridge to Pyfa's vendored `eos` fitting engine.

The renderer owns the fit *document* (JSON); this module is a pure function:
given a fit doc it builds a transient eos fit, computes it, extracts a rich
stats/validation dict, then rolls back the in-memory saveddata (no server-side
fit state). The engine is bootstrapped once, and calc calls are serialized with
a lock (eos uses process-global sessions; a single calc is sub-100ms).

See the feasibility spike + plan: the exact headless recipe (wx-free config stub
already patched into the vendored eos.db.migration, in-memory saveddata via
`sys._called_from_test`, All-5 character, session flush before calc) lives here.

`eos` is LGPL/GPL (Pyfa) — vendored under python/pyfa/eos. The distributed app
is therefore GPLv3; see COPYING / the About notice.
"""
import os
import re
import sqlite3
import sys
import threading

_LOCK = threading.RLock()
_READY = False
_IMPORTS = {}

# --- read-only sqlite over eve.db for fast item/ship/skill browsing (no ORM) ---
_SQL_CONN = None
_SQL_LOCK = threading.RLock()
_FIT_CATEGORIES = ('Module', 'Charge', 'Drone', 'Fighter', 'Subsystem', 'Implant', 'Deployable')


def _sql():
    global _SQL_CONN
    if _SQL_CONN is None:
        with _SQL_LOCK:
            if _SQL_CONN is None:
                db = eve_db_path()
                uri = 'file:' + os.path.abspath(db).replace('\\', '/') + '?mode=ro'
                conn = sqlite3.connect(uri, uri=True, check_same_thread=False)
                conn.row_factory = sqlite3.Row
                _SQL_CONN = conn
    return _SQL_CONN


def _query(sql, params=()):
    with _SQL_LOCK:
        return _sql().execute(sql, params).fetchall()


def list_ships():
    rows = _query(
        """select t.typeID, t.typeName, t.groupID, g.name gname, t.raceID, t.factionID, t.metaGroupID
           from invtypes t join invgroups g on t.groupID=g.groupID
           join invcategories c on g.categoryID=c.categoryID
           where c.name='Ship' and t.published=1 order by g.name, t.typeName""")
    return [{'typeID': r['typeID'], 'name': r['typeName'], 'group': r['gname'], 'groupID': r['groupID'],
             'raceID': r['raceID'], 'factionID': r['factionID'], 'metaGroupID': r['metaGroupID']} for r in rows]


def list_skills():
    rows = _query(
        """select t.typeID, t.typeName, g.name gname from invtypes t join invgroups g on t.groupID=g.groupID
           join invcategories c on g.categoryID=c.categoryID
           where c.name='Skill' and t.published=1 order by g.name, t.typeName""")
    return [{'typeID': r['typeID'], 'name': r['typeName'], 'group': r['gname']} for r in rows]


# Fitting-slot effect IDs (a module carries exactly one) — used to filter the
# item browser to modules that fit the clicked slot.
_SLOT_EFFECT = {'high': 12, 'med': 13, 'low': 11, 'rig': 2663, 'subsystem': 3772}


def search_items(query, categories=None, limit=60, slot=None):
    """Search/browse fittable items. An empty query browses the whole
    category/slot-filtered set (so the picker is scrollable without typing)."""
    query = (query or '').strip()
    cats = tuple(categories) if categories else _FIT_CATEGORIES
    ph = ','.join('?' * len(cats))
    slot_join, slot_where, slot_params = '', '', ()
    eff = _SLOT_EFFECT.get(slot)
    if eff:
        slot_join = 'join dgmtypeeffects te on te.typeID=t.typeID'
        slot_where = 'and te.effectID=?'
        slot_params = (eff,)
    name_where, name_order, name_params = '', 't.metaLevel, t.typeName', ()
    if query:
        name_where = 'and t.typeName like ?'
        name_order = '(t.typeName like ?) desc, t.metaLevel, t.typeName'
        name_params = (f'%{query}%', f'{query}%')
    rows = _query(
        f"""select t.typeID, t.typeName, g.name gname, c.name cname, t.metaGroupID, t.metaLevel
            from invtypes t join invgroups g on t.groupID=g.groupID
            join invcategories c on g.categoryID=c.categoryID {slot_join}
            where t.published=1 and c.name in ({ph}) {slot_where} {name_where}
            order by {name_order} limit ?""",
        (*cats, *slot_params, *name_params, int(min(400, limit))))
    return [{'typeID': r['typeID'], 'name': r['typeName'], 'group': r['gname'], 'category': r['cname'],
             'metaGroupID': r['metaGroupID'], 'metaLevel': r['metaLevel']} for r in rows]


# Module charge-compatibility: chargeGroup1..5 (allowed charge groups) + chargeSize.
_CHARGE_GROUP_ATTRS = (604, 605, 606, 609, 610)
_CHARGE_SIZE_ATTR = 128


def compatible_charges(module_type_id):
    """Charges a module accepts: items in its chargeGroup1..5 groups matching its
    chargeSize (covers ammo AND scripts). Empty if the module takes no charge."""
    attrs = _query(
        'select attributeID, value from dgmtypeattribs where typeID=? and attributeID in (604,605,606,609,610,128)',
        (int(module_type_id),))
    groups, size = [], None
    for r in attrs:
        if r['attributeID'] == _CHARGE_SIZE_ATTR:
            size = r['value']
        elif r['value']:
            groups.append(int(r['value']))
    if not groups:
        return []
    gph = ','.join('?' * len(groups))
    size_where, size_params = '', ()
    if size is not None:
        size_where = 'and (sz.value = ? or sz.value is null)'
        size_params = (size,)
    rows = _query(
        f"""select t.typeID, t.typeName, g.name gname, t.metaGroupID, t.metaLevel
            from invtypes t join invgroups g on t.groupID=g.groupID
            left join dgmtypeattribs sz on sz.typeID=t.typeID and sz.attributeID=128
            where t.published=1 and t.groupID in ({gph}) {size_where}
            order by t.metaGroupID, t.metaLevel, t.typeName""",
        (*groups, *size_params))
    return [{'typeID': r['typeID'], 'name': r['typeName'], 'group': r['gname'], 'category': 'Charge',
             'metaGroupID': r['metaGroupID'], 'metaLevel': r['metaLevel']} for r in rows]


def item_detail(type_id):
    rows = _query(
        """select t.typeID, t.typeName, g.name gname, c.name cname, t.marketGroupID, t.metaGroupID
           from invtypes t join invgroups g on t.groupID=g.groupID
           join invcategories c on g.categoryID=c.categoryID where t.typeID=?""", (int(type_id),))
    if not rows:
        return None
    r = rows[0]
    return {'typeID': r['typeID'], 'name': r['typeName'], 'group': r['gname'], 'category': r['cname'],
            'marketGroupID': r['marketGroupID'], 'metaGroupID': r['metaGroupID']}


def _type_by_name(name):
    rows = _query(
        """select t.typeID, c.name cat from invtypes t join invgroups g on t.groupID=g.groupID
           join invcategories c on g.categoryID=c.categoryID where t.typeName=? and t.published=1 limit 1""",
        (name,))
    return (rows[0]['typeID'], rows[0]['cat']) if rows else (None, None)


def _name_by_id(type_id):
    rows = _query('select typeName from invtypes where typeID=?', (int(type_id),))
    return rows[0]['typeName'] if rows else None


# ---------------------------------- EFT ----------------------------------------
_EFT_QTY = re.compile(r'^(.*?)\s+x(\d+)$')


def parse_eft(text):
    """Parse an EFT block into a fit doc. Names are resolved to typeIDs via eve.db;
    drones/cargo detected by trailing `xN` + item category."""
    lines = [l.rstrip() for l in (text or '').splitlines()]
    hdr, start = None, 0
    for i, l in enumerate(lines):
        s = l.strip()
        if s.startswith('[') and ',' in s and s.endswith(']'):
            hdr, start = s[1:-1], i + 1
            break
    if hdr is None:
        return {'error': 'No [Ship, Fit Name] header found.'}
    ship, _, name = hdr.partition(',')
    doc = {'ship': ship.strip(), 'name': name.strip(), 'modules': [], 'drones': [], 'cargo': [], 'warnings': []}
    for l in lines[start:]:
        s = l.strip()
        if not s or (s.startswith('[') and 'empty' in s.lower()):
            continue
        state = 'active'
        if s.endswith('/OFFLINE'):
            state = 'offline'
            s = s[:-len('/OFFLINE')].rstrip().rstrip(',').rstrip()
        m = _EFT_QTY.match(s)
        if m:
            nm, qty = m.group(1).strip(), int(m.group(2))
            tid, cat = _type_by_name(nm)
            if tid is None:
                doc['warnings'].append(f'unknown item: {nm}')
            elif cat in ('Drone', 'Fighter'):
                doc['drones'].append({'type': tid, 'amount': qty})
            else:
                doc['cargo'].append({'type': tid, 'amount': qty})
            continue
        nm, _, charge = s.partition(',')
        nm, charge = nm.strip(), charge.strip()
        tid, cat = _type_by_name(nm)
        if tid is None:
            doc['warnings'].append(f'unknown item: {nm}')
            continue
        if cat in ('Drone', 'Fighter'):
            doc['drones'].append({'type': tid, 'amount': 1})
            continue
        mod = {'type': tid, 'state': state}
        if charge:
            ctid, _ = _type_by_name(charge)
            if ctid:
                mod['charge'] = ctid
        doc['modules'].append(mod)
    return doc


def render_eft(doc):
    """Render a fit doc back to EFT text (modules in doc order, then drones/cargo)."""
    ship = _name_by_id(doc['ship']) if str(doc.get('ship', '')).isdigit() else doc.get('ship')
    name = doc.get('name') or 'Fit'
    out = [f'[{ship}, {name}]']
    for md in doc.get('modules', []) or []:
        nm = _name_by_id(md['type']) if str(md['type']).isdigit() else md['type']
        line = nm
        ch = md.get('charge')
        if ch:
            cn = _name_by_id(ch) if str(ch).isdigit() else ch
            line += f', {cn}'
        if str(md.get('state', '')).lower() in ('offline',):
            line += ' /OFFLINE'
        out.append(line)
    if doc.get('drones') or doc.get('cargo'):
        out.append('')
    for dd in doc.get('drones', []) or []:
        nm = _name_by_id(dd['type']) if str(dd['type']).isdigit() else dd['type']
        out.append(f"{nm} x{int(dd.get('amount', 1))}")
    for cg in doc.get('cargo', []) or []:
        nm = _name_by_id(cg['type']) if str(cg['type']).isdigit() else cg['type']
        out.append(f"{nm} x{int(cg.get('amount', 1))}")
    return '\n'.join(out)


def _base_dir():
    return getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))


def eve_db_path():
    return os.path.join(_base_dir(), 'data', 'eve.db')


def _eos_pkg_dir():
    return os.path.join(_base_dir(), 'pyfa')


def available():
    """True when the engine can run (vendored eos importable + eve.db present)."""
    try:
        _bootstrap()
        return True
    except Exception:
        return False


def _bootstrap():
    global _READY
    if _READY:
        return
    with _LOCK:
        if _READY:
            return
        pkg = _eos_pkg_dir()
        if pkg not in sys.path:
            sys.path.insert(0, pkg)
        db = eve_db_path()
        if not os.path.exists(db):
            raise RuntimeError(f'eve.db not found at {db} — build it with build_eve_db.py')
        # In-memory saveddata; eos.config picks this up on import.
        sys._called_from_test = True
        import eos.config as ecfg
        ecfg.gamedataCache = False
        ecfg.gamedata_connectionstring = 'sqlite:///' + os.path.abspath(db).replace('\\', '/')
        # eos runs saveddata as sqlite ":memory:", which is *per connection* — a
        # threadpool request would get a fresh schema-less DB. Force a StaticPool
        # (one shared connection) for the in-memory engine so every thread sees
        # the same saveddata. Patch before eos.db binds `create_engine`.
        import sqlalchemy as _sa
        from sqlalchemy.pool import StaticPool as _StaticPool
        if not getattr(_sa, '_pyfa_mem_patched', False):
            _orig_ce = _sa.create_engine

            def _ce(*a, **k):
                url = a[0] if a else k.get('url', '')
                if isinstance(url, str) and ':memory:' in url:
                    k.setdefault('poolclass', _StaticPool)
                    ca = dict(k.get('connect_args') or {})
                    ca.setdefault('check_same_thread', False)
                    k['connect_args'] = ca
                return _orig_ce(*a, **k)

            _sa.create_engine = _ce
            _sa._pyfa_mem_patched = True
        import eos.db  # noqa: F401  (initializes engines/sessions from config above)
        from eos.db.gamedata.queries import getItem
        from eos.saveddata.fit import Fit
        from eos.saveddata.ship import Ship
        from eos.saveddata.module import Module
        from eos.saveddata.drone import Drone
        from eos.saveddata.implant import Implant
        from eos.saveddata.booster import Booster
        from eos.saveddata.cargo import Cargo
        from eos.saveddata.character import Character
        from eos.const import FittingModuleState, ImplantLocation, FittingSlot, FittingHardpoint
        _IMPORTS.update(dict(
            edb=eos.db, getItem=getItem, Fit=Fit, Ship=Ship, Module=Module, Drone=Drone,
            Implant=Implant, Booster=Booster, Cargo=Cargo,
            Character=Character, FittingModuleState=FittingModuleState,
            ImplantLocation=ImplantLocation, FittingSlot=FittingSlot, FittingHardpoint=FittingHardpoint,
        ))
        _READY = True


_STATE_MAP = {'offline': -1, 'online': 0, 'active': 1, 'overheat': 2, 'overheated': 2}


def _resolve_state(name, EnumCls):
    if name is None:
        return EnumCls.ACTIVE
    val = _STATE_MAP.get(str(name).lower())
    if val is None:
        return EnumCls.ACTIVE
    return EnumCls(val)


def _make_character(doc):
    """All-5 by default; a custom character when skills overrides are supplied."""
    Character = _IMPORTS['Character']
    skills = doc.get('skills')
    if not skills or skills == 'all5':
        return Character.getAll5()
    if skills == 'all0':
        return Character.getAll0()
    default = 5
    overrides = {}
    if isinstance(skills, dict):
        default = int(skills.get('default', 5))
        overrides = {int(k): int(v) for k, v in (skills.get('overrides') or skills).items() if str(k).isdigit()}
    char = Character('custom', defaultLevel=default)
    for sid, lvl in overrides.items():
        try:
            char.getSkill(sid).setLevel(max(0, min(5, lvl)), ignoreRestriction=True)
        except Exception:
            pass
    return char


def _dmg_total(dmg):
    if dmg is None:
        return 0.0
    for a in ('total',):
        if hasattr(dmg, a):
            try:
                return float(getattr(dmg, a))
            except Exception:
                pass
    try:
        return float(dmg.em + dmg.thermal + dmg.kinetic + dmg.explosive)
    except Exception:
        try:
            return float(dmg)
        except Exception:
            return 0.0


def _dmg_bytype(dmg):
    out = {}
    for k in ('em', 'thermal', 'kinetic', 'explosive'):
        try:
            out[k] = round(float(getattr(dmg, k)), 2)
        except Exception:
            out[k] = 0.0
    return out


def compute_fit(doc):
    """Build a transient eos fit from `doc`, compute, return a stats dict.

    doc = {ship, modules:[{type,state,charge}], drones:[{type,amount,active}],
           skills: 'all5' | {default, overrides:{skillId:level}}}
    (cargo/implants/boosters/T3/mutaplasmids come in later phases.)
    """
    _bootstrap()
    with _LOCK:
        I = _IMPORTS
        edb, getItem = I['edb'], I['getItem']
        Fit, Ship, Module, Drone = I['Fit'], I['Ship'], I['Module'], I['Drone']
        FittingModuleState = I['FittingModuleState']
        warnings = []
        try:
            ship_item = getItem(doc['ship'])
            if ship_item is None:
                return {'error': f"unknown ship: {doc.get('ship')!r}"}
            fit = Fit(Ship(ship_item), name='calc')
            fit.character = _make_character(doc)
            fit.implantLocation = I['ImplantLocation'].FIT
            edb.saveddata_session.add(fit)

            for md in doc.get('modules', []) or []:
                try:
                    item = getItem(md['type'])
                    if item is None:
                        warnings.append(f"unknown module: {md.get('type')!r}")
                        continue
                    m = Module(item)
                    ch = md.get('charge')
                    if ch:
                        ci = getItem(ch)
                        if ci is not None:
                            m.charge = ci
                    try:
                        m.state = _resolve_state(md.get('state'), FittingModuleState)
                    except Exception:
                        pass
                    fit.modules.append(m)
                except Exception as e:
                    warnings.append(f"module {md.get('type')!r}: {e}")

            for dd in doc.get('drones', []) or []:
                try:
                    item = getItem(dd['type'])
                    if item is None:
                        warnings.append(f"unknown drone: {dd.get('type')!r}")
                        continue
                    d = Drone(item)
                    d.amount = int(dd.get('amount', 1))
                    if dd.get('active', True):
                        d.amountActive = d.amount
                    fit.drones.append(d)
                except Exception as e:
                    warnings.append(f"drone {dd.get('type')!r}: {e}")

            Implant, Booster, Cargo = I['Implant'], I['Booster'], I['Cargo']
            for iid in doc.get('implants', []) or []:
                try:
                    it = getItem(iid)
                    if it is not None:
                        fit.implants.append(Implant(it))
                except Exception as e:
                    warnings.append(f"implant {iid!r}: {e}")
            for bid in doc.get('boosters', []) or []:
                try:
                    it = getItem(bid)
                    if it is not None:
                        fit.boosters.append(Booster(it))
                except Exception as e:
                    warnings.append(f"booster {bid!r}: {e}")
            for cg in doc.get('cargo', []) or []:
                try:
                    it = getItem(cg['type'])
                    if it is not None:
                        c = Cargo(it)
                        c.amount = int(cg.get('amount', 1))
                        fit.cargo.append(c)
                except Exception as e:
                    warnings.append(f"cargo {cg.get('type')!r}: {e}")
            if doc.get('mode'):
                try:
                    mi = getItem(doc['mode'])
                    if mi is not None:
                        fit.mode = fit.ship.validateModeItem(mi, owner=fit)
                except Exception as e:
                    warnings.append(f"mode {doc.get('mode')!r}: {e}")

            edb.saveddata_session.flush()
            fit.calculateModifiedAttributes()
            stats = _extract(fit)
            stats['warnings'] = warnings
            return stats
        finally:
            try:
                edb.saveddata_session.rollback()
            except Exception:
                pass


def _extract(fit):
    """Pull a comprehensive stats + validation + per-module dict off a computed fit."""
    FittingSlot = _IMPORTS['FittingSlot']
    FittingHardpoint = _IMPORTS['FittingHardpoint']
    ship = fit.ship

    def sa(attr, default=0.0):
        try:
            v = ship.getModifiedItemAttr(attr)
            return float(v) if v is not None else default
        except Exception:
            return default

    def fp(name, default=None):
        try:
            return getattr(fit, name)
        except Exception:
            return default

    def resists(prefix):
        # resist% = 1 - resonance; hull attrs have no prefix
        keys = {'em': 'EmDamageResonance', 'thermal': 'ThermalDamageResonance',
                'kinetic': 'KineticDamageResonance', 'explosive': 'ExplosiveDamageResonance'}
        out = {}
        for k, suf in keys.items():
            attr = (prefix + suf) if prefix else (suf[0].lower() + suf[1:])
            out[k] = round((1.0 - sa(attr, 1.0)) * 100, 1)
        return out

    weapon = fit.getWeaponDps()
    drone = fit.getDroneDps()
    total = fit.getTotalDps()
    try:
        volley = _dmg_total(fit.getWeaponVolley())
    except Exception:
        volley = 0.0

    ehp = fit.ehp if isinstance(fit.ehp, dict) else {}
    hp = {'shield': round(sa('shieldCapacity')), 'armor': round(sa('armorHP')), 'hull': round(sa('hp'))}

    cap_capacity = sa('capacitorCapacity')

    modules = []
    used_by_slot = {}
    for m in fit.modules:
        if getattr(m, 'isEmpty', False):
            continue
        try:
            slot = int(m.slot) if m.slot is not None else None
            if slot is not None:
                used_by_slot[slot] = used_by_slot.get(slot, 0) + 1
            chargeable = bool(m.getModifiedItemAttr('chargeSize') or m.getModifiedItemAttr('chargeGroup1'))
            modules.append({
                'position': m.position,
                'slot': slot,
                'typeID': m.item.ID,
                'name': m.item.name,
                'state': int(m.state),
                'charge': ({'typeID': m.charge.ID, 'name': m.charge.name} if m.charge else None),
                'chargeable': chargeable,
                'cpu': round(m.getModifiedItemAttr('cpu') or 0, 2),
                'pg': round(m.getModifiedItemAttr('power') or 0, 2),
            })
        except Exception:
            pass

    drones = []
    for d in fit.drones:
        try:
            drones.append({
                'typeID': d.item.ID, 'name': d.item.name,
                'amount': int(d.amount or 0), 'active': int(d.amountActive or 0),
                'dps': round(_dmg_total(d.getDps()), 2),
            })
        except Exception:
            pass

    def slot_pair(slotEnum):
        try:
            total = fit.getNumSlots(slotEnum)
        except Exception:
            total = 0
        return {'used': used_by_slot.get(int(slotEnum), 0), 'total': round(total)}

    res = {
        'cpu': {'used': round(fp('cpuUsed', 0) or 0, 2), 'total': round(sa('cpuOutput'), 2)},
        'pg': {'used': round(fp('pgUsed', 0) or 0, 2), 'total': round(sa('powerOutput'), 2)},
        'calibration': {'used': round(fp('calibrationUsed', 0) or 0), 'total': round(sa('upgradeCapacity'))},
        'droneBandwidth': {'used': round(fp('droneBandwidthUsed', 0) or 0, 2), 'total': round(sa('droneBandwidth'), 2)},
        'slots': {
            'high': slot_pair(FittingSlot.HIGH),
            'med': slot_pair(FittingSlot.MED),
            'low': slot_pair(FittingSlot.LOW),
            'rig': slot_pair(FittingSlot.RIG),
            'subsystem': slot_pair(FittingSlot.SUBSYSTEM),
        },
        'hardpoints': {
            'turret': {'used': _safe(lambda: fit.getHardpointsUsed(FittingHardpoint.TURRET), 0),
                       'total': round(sa('turretSlotsLeft'))},
            'launcher': {'used': _safe(lambda: fit.getHardpointsUsed(FittingHardpoint.MISSILE), 0),
                         'total': round(sa('launcherSlotsLeft'))},
        },
    }

    over = []
    if res['cpu']['used'] > res['cpu']['total'] + 0.01:
        over.append('CPU')
    if res['pg']['used'] > res['pg']['total'] + 0.01:
        over.append('Powergrid')
    if res['calibration']['used'] > res['calibration']['total'] + 0.01:
        over.append('Calibration')

    return {
        'ship': {'typeID': ship.item.ID, 'name': ship.item.name},
        'dps': {
            'weapon': round(_dmg_total(weapon), 2),
            'drone': round(_dmg_total(drone), 2),
            'total': round(_dmg_total(total), 2),
            'byType': _dmg_bytype(total),
        },
        'volley': round(volley, 2),
        'hp': hp,
        'ehp': {k: round(v) for k, v in ehp.items()} if ehp else {},
        'resists': {'shield': resists('shield'), 'armor': resists('armor'), 'hull': resists('')},
        'capacitor': {
            'capacity': round(cap_capacity),
            'stable': bool(fp('capStable')),
            'stableFraction': (round(fp('capState'), 1) if fp('capStable') else None),
            'lasts_s': (None if fp('capStable') else round(fp('capState') or 0, 1)),
        },
        'speed': {
            'max': round(fp('maxSpeed', 0) or 0, 2),
            'alignTime': round(fp('alignTime', 0) or 0, 2),
            'warpSpeed': round(sa('warpSpeedMultiplier', 1.0), 2),
        },
        'targeting': {
            'maxTargetRange': round(fp('maxTargetRange', 0) or 0),
            'scanResolution': round(sa('scanResolution')),
            'maxLockedTargets': round(sa('maxLockedTargets')),
            'sensorStrength': round(fp('scanStrength', 0) or 0, 1),
        },
        'resources': res,
        'valid': not over,
        'overLimit': over,
        'modules': modules,
        'drones': drones,
        'droneControl': {'used': len([d for d in drones if d['active']]),
                         'total': round(sa('maxActiveDrones'))},
        'implants': _safe(lambda: [{'typeID': im.item.ID, 'name': im.item.name} for im in fit.implants], []),
        'boosters': _safe(lambda: [{'typeID': b.item.ID, 'name': b.item.name} for b in fit.boosters], []),
        'cargo': _safe(lambda: [{'typeID': c.item.ID, 'name': c.item.name, 'amount': int(c.amount or 0)} for c in fit.cargo], []),
        'mode': _safe(lambda: ({'typeID': fit.mode.item.ID, 'name': fit.mode.item.name} if getattr(fit, 'mode', None) else None), None),
    }


def _safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default
