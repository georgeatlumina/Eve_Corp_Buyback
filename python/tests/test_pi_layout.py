"""Tests for the PI colony layout model (pi_layout.py), including an exact
round-trip against a real in-game template fixture."""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pi_layout  # noqa: E402

FIXTURE = os.path.join(os.path.dirname(__file__), 'fixtures', 'pi_template_sample.json')


def _load_fixture():
    with open(FIXTURE, encoding='utf-8-sig') as f:
        return json.load(f)


def test_roundtrip_real_template_is_exact():
    doc = _load_fixture()
    model = pi_layout.parse_template(doc)
    out = pi_layout.export_template(model)
    # Deep-equal against the original (ignores key order / float formatting).
    assert out == doc


def test_parse_shapes():
    doc = _load_fixture()
    m = pi_layout.parse_template(doc)
    assert m['planet_type_id'] == doc['Pln']
    assert m['cmd_ctr_level'] == doc['CmdCtrLv']
    assert len(m['pins']) == len(doc['P'])
    assert len(m['links']) == len(doc['L'])
    assert len(m['routes']) == len(doc['R'])
    # Pin indices are 0-based; template nodes were 1-based.
    for r in m['routes']:
        for ref in (r['src'], r['dst']):
            assert ref == pi_layout.CC or 0 <= ref < len(m['pins'])


def test_command_center_node_maps_to_sentinel():
    # A synthetic doc with a link to node 0 (the CC) must parse to CC and export back to 0.
    doc = {
        'CmdCtrLv': 1, 'Cmt': 'x', 'Diam': 4000.0, 'Pln': 2016,
        'P': [{'H': 0, 'La': 1.0, 'Lo': 1.0, 'S': None, 'T': 2524}],
        'L': [{'D': 1, 'Lv': 0, 'S': 0}],   # CC (0) <-> pin 1 (P[0])
        'R': [],
    }
    m = pi_layout.parse_template(doc)
    assert m['links'][0]['a'] == pi_layout.CC
    assert m['links'][0]['b'] == 0
    assert pi_layout.export_template(m) == doc


def test_dumps_is_sorted_keys():
    doc = _load_fixture()
    m = pi_layout.parse_template(doc)
    s = pi_layout.dumps_template(m)
    # Top-level keys appear in sorted order, matching the client's writer.
    assert s.index('"CmdCtrLv"') < s.index('"Diam"') < s.index('"Pln"')
    assert json.loads(s) == doc


def test_from_esi_detail_converts_ids_and_schematics():
    detail = {
        'pins': [
            {'pin_id': 1001, 'type_id': 2524, 'latitude': 1.0, 'longitude': 1.0},
            {'pin_id': 1002, 'type_id': 2848, 'latitude': 1.1, 'longitude': 1.0,
             'extractor_details': {'product_type_id': 2073}},
            {'pin_id': 1003, 'type_id': 2473, 'latitude': 1.0, 'longitude': 1.1, 'schematic_id': 81},
        ],
        'links': [{'source_pin_id': 1002, 'destination_pin_id': 1003, 'link_level': 0}],
        'routes': [{'source_pin_id': 1002, 'destination_pin_id': 1003, 'content_type_id': 2073, 'quantity': 3000}],
    }
    # schematic 81 makes Viral Agent (output type 3775)
    m = pi_layout.from_esi_detail(detail, 2016, 5000.0, 3, 'test', {81: 3775})
    assert len(m['pins']) == 3 and len(m['links']) == 1 and len(m['routes']) == 1
    assert m['pins'][2]['schematic'] == 3775       # factory: schematic_id -> output type
    assert m['pins'][1]['schematic'] == 2073       # ECU: product type id
    assert m['links'][0] == {'a': 1, 'b': 2, 'level': 0}   # pin_ids -> array indices
    assert m['routes'][0] == {'src': 1, 'dst': 2, 'type_id': 2073, 'qty': 3000}
    # unknown pin references are dropped, not crash
    detail['links'].append({'source_pin_id': 9999, 'destination_pin_id': 1003, 'link_level': 0})
    assert len(pi_layout.from_esi_detail(detail, 2016, 5000.0, 3, 't', {81: 3775})['links']) == 1


def test_great_circle_distance():
    # Same point -> 0 km; antipodal-ish sanity: distance <= half-circumference.
    assert pi_layout.great_circle_km(1.0, 1.0, 1.0, 1.0, 4000.0) == 0.0
    d = pi_layout.great_circle_km(0.0, 0.0, 0.0, math.pi, 4000.0)
    assert abs(d - (2000.0 * math.pi)) < 1e-6  # half the circumference
