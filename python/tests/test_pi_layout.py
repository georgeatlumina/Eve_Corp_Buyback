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


def test_great_circle_distance():
    # Same point -> 0 km; antipodal-ish sanity: distance <= half-circumference.
    assert pi_layout.great_circle_km(1.0, 1.0, 1.0, 1.0, 4000.0) == 0.0
    d = pi_layout.great_circle_km(0.0, 0.0, 0.0, math.pi, 4000.0)
    assert abs(d - (2000.0 * math.pi)) < 1e-6  # half the circumference
