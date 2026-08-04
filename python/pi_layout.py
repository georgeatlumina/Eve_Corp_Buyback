"""PI colony layout: the in-game template format <-> a clean internal model,
plus geometry helpers. Phase 2 (the layout builder) builds colonies against the
internal model; import/export translates to the exact JSON the EVE client reads
from Documents/EVE/PlanetaryInteractionTemplates.

Template JSON (keys sorted, as the client writes them):
  CmdCtrLv int      command-center level (0-5)
  Cmt      str      free-text comment
  Diam     float    planet diameter (km)
  Pln      int      planet *type* id (2016 Barren, 2014 Oceanic, ...)
  P        [pin]    pins: {H height, La lat, Lo lon, S schematic|resource|null, T type_id}
  L        [link]   links: {S srcNode, D dstNode, Lv level}
  R        [route]  routes: {P [srcNode,dstNode], Q qty, T commodity_type_id}

Node indexing (the subtle bit, verified against real templates): in L and R a
node value ``k`` refers to pin ``P[k-1]`` — i.e. pins are 1-indexed there — and
``0`` is the command center (which provides CPU/PG but is usually unlinked). The
model uses 0-based pin indices and the sentinel ``CC`` for the command center.
"""
import json
import math
import os

CC = 'cc'  # command-center node sentinel in the internal model


def _to_node_model(k):
    """template node value -> model reference (0-based pin index, or CC)."""
    return CC if k == 0 else k - 1


def _to_node_template(ref):
    """model reference -> template node value (1-based pin index, 0 for CC)."""
    return 0 if ref == CC else ref + 1


def parse_template(doc):
    """EVE template dict -> internal colony model (pure)."""
    pins = [{
        'type_id': p['T'],
        'schematic': p.get('S'),   # schematic id (factory) / resource id (ECU) / None
        'lat': p['La'],
        'lon': p['Lo'],
        'height': p.get('H', 0),
    } for p in doc.get('P', [])]
    links = [{
        'a': _to_node_model(e['S']),
        'b': _to_node_model(e['D']),
        'level': e.get('Lv', 0),
    } for e in doc.get('L', [])]
    routes = [{
        'src': _to_node_model(r['P'][0]),
        'dst': _to_node_model(r['P'][1]),
        'qty': r['Q'],
        'type_id': r['T'],
    } for r in doc.get('R', [])]
    return {
        'planet_type_id': doc['Pln'],
        'diameter': doc['Diam'],
        'cmd_ctr_level': doc['CmdCtrLv'],
        'comment': doc.get('Cmt', ''),
        'pins': pins,
        'links': links,
        'routes': routes,
    }


def export_template(model):
    """Internal colony model -> EVE template dict (pure). Round-trips
    parse_template exactly for a template the client wrote."""
    P = [{
        'H': p.get('height', 0),
        'La': p['lat'],
        'Lo': p['lon'],
        'S': p.get('schematic'),
        'T': p['type_id'],
    } for p in model['pins']]
    L = [{
        'D': _to_node_template(e['b']),
        'Lv': e.get('level', 0),
        'S': _to_node_template(e['a']),
    } for e in model['links']]
    R = [{
        'P': [_to_node_template(r['src']), _to_node_template(r['dst'])],
        'Q': r['qty'],
        'T': r['type_id'],
    } for r in model['routes']]
    return {
        'CmdCtrLv': model['cmd_ctr_level'],
        'Cmt': model.get('comment', ''),
        'Diam': model['diameter'],
        'L': L,
        'P': P,
        'Pln': model['planet_type_id'],
        'R': R,
    }


def dumps_template(model):
    """Serialize a model to the exact on-disk JSON string (sorted keys, as the
    EVE client writes it)."""
    return json.dumps(export_template(model), sort_keys=True, ensure_ascii=False)


# ----------------------------- geometry -----------------------------

def great_circle_km(lat1, lon1, lat2, lon2, diameter_km):
    """Surface distance between two pins (lat/lon in radians) on a planet of the
    given diameter. Used for link CPU/PG cost and for drawing/validating links."""
    radius = float(diameter_km) / 2.0
    sin_p = math.sin(lat1) * math.sin(lat2)
    cos_p = math.cos(lat1) * math.cos(lat2) * math.cos(lon1 - lon2)
    c = max(-1.0, min(1.0, sin_p + cos_p))
    return radius * math.acos(c)


# ----------------------------- file I/O -----------------------------

def load_template_file(path):
    with open(path, encoding='utf-8-sig') as f:   # -sig: tolerate a BOM
        return json.load(f)


def save_template_file(model, path):
    """Write a model to ``path`` as the client-compatible JSON."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(export_template(model), f, sort_keys=True, ensure_ascii=False)
