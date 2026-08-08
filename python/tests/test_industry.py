"""Unit tests for the production-planner engine (industry.py).

Uses a small synthetic dataset built via industry.index_data so the tests don't
depend on the generated data/industry.json. Chain modelled:

    Ship (587)  = manufacturing, 1/run, from 2x Widget + 10x Goo
    Widget (100)= manufacturing, 1/run, from 100x Tritanium (34)
    Goo (200)   = reaction,     200/run, from 50x Pyerite (35)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import industry  # noqa: E402


def _data():
    raw = {
        'recipes': {
            '100': {'activity': 'manufacturing', 'blueprint_type_id': 1100, 'time': 300,
                    'output_qty': 1, 'max_runs': 100, 'materials': [[34, 100]]},
            '200': {'activity': 'reaction', 'blueprint_type_id': 1200, 'time': 3600,
                    'output_qty': 200, 'max_runs': 100, 'materials': [[35, 50]]},
            '587': {'activity': 'manufacturing', 'blueprint_type_id': 1587, 'time': 6000,
                    'output_qty': 1, 'max_runs': 10, 'materials': [[100, 2], [200, 10]]},
        },
        'types': {
            '34': {'name': 'Tritanium'}, '35': {'name': 'Pyerite'},
            '100': {'name': 'Widget'}, '200': {'name': 'Goo'}, '587': {'name': 'Ship'},
        },
    }
    return industry.index_data(raw)


def _raw_map(plan):
    return {r['type_id']: r['qty'] for r in plan['raw_materials']}


def _job_map(plan):
    return {j['type_id']: j for j in plan['jobs']}


def test_tiers():
    d = _data()
    assert d['tiers'][34] == 0 and d['tiers'][35] == 0
    assert d['tiers'][100] == 1 and d['tiers'][200] == 1
    assert d['tiers'][587] == 2


def test_full_explosion_me0():
    d = _data()
    p = industry.plan([{'type_id': 587, 'qty': 1}], config={'me': 0}, data=d)
    jobs = _job_map(p)
    assert set(jobs) == {587, 100, 200}
    assert jobs[100]['runs'] == 2               # need 2 widgets, 1/run
    assert jobs[200]['runs'] == 1 and jobs[200]['produced'] == 200  # 10 needed, 200/run batch
    raw = _raw_map(p)
    assert raw[34] == 200                        # 2 widget runs * 100 trit
    assert raw[35] == 50                         # 1 goo run * 50 pyerite
    # build order: components (tier 1) before the ship (tier 2)
    assert p['jobs'][-1]['type_id'] == 587


def test_me_reduces_materials():
    d = _data()
    p = industry.plan([{'type_id': 100, 'qty': 1}], config={'me': 10}, data=d)
    # max(runs=1, ceil(round(100*1*0.90, 2))) = 90
    assert _raw_map(p)[34] == 90


def test_me_minimum_is_runs():
    d = _data()
    # A material with base 1 at high ME still needs >= runs.
    raw = {'recipes': {'500': {'activity': 'manufacturing', 'output_qty': 1, 'time': 1,
                               'blueprint_type_id': 1, 'max_runs': 1, 'materials': [[34, 1]]}},
           'types': {'34': {'name': 'Tritanium'}, '500': {'name': 'Thing'}}}
    dd = industry.index_data(raw)
    p = industry.plan([{'type_id': 500, 'qty': 5}], config={'me': 10}, data=dd)
    assert _raw_map(p)[34] == 5                   # max(5 runs, ceil(1*5*0.9=4.5)=5) = 5


def test_reaction_batch_rounding():
    d = _data()
    # 201 Goo needed -> 2 runs (200/run) -> 100 pyerite.
    p = industry.plan([{'type_id': 200, 'qty': 201}], config={'me': 0}, data=d)
    assert _job_map(p)[200]['runs'] == 2
    assert _raw_map(p)[35] == 100


def test_stock_offsets_intermediate():
    d = _data()
    p = industry.plan([{'type_id': 587, 'qty': 1}], stock={100: 2}, config={'me': 0}, data=d)
    jobs = _job_map(p)
    assert 100 not in jobs                        # both widgets came from stock
    assert 34 not in _raw_map(p)                  # so no tritanium needed
    assert _raw_map(p)[35] == 50                  # goo still built


def test_stock_offsets_raw():
    d = _data()
    p = industry.plan([{'type_id': 100, 'qty': 1}], stock={34: 30}, config={'me': 0}, data=d)
    assert _raw_map(p)[34] == 70                  # 100 - 30 on hand


def test_buy_ids_forces_purchase():
    d = _data()
    p = industry.plan([{'type_id': 587, 'qty': 1}], config={'me': 0, 'buy_ids': [200]}, data=d)
    assert 200 not in _job_map(p)                 # not reacted...
    assert _raw_map(p)[200] == 10                 # ...bought instead


def test_shared_intermediate_aggregates():
    # Two ships share the widget/goo intermediates -> single aggregated jobs.
    d = _data()
    p = industry.plan([{'type_id': 587, 'qty': 3}], config={'me': 0}, data=d)
    jobs = _job_map(p)
    assert jobs[587]['runs'] == 3
    assert jobs[100]['runs'] == 6                 # 3 ships * 2 widgets
    assert _raw_map(p)[34] == 600


def _inv_data():
    """Ship (587) is *invented* (its blueprint 1587 comes from invention with
    2x Datacore A + 1x Datacore B at 30% base, 10 runs/copy)."""
    raw = {
        'recipes': {
            '100': {'activity': 'manufacturing', 'blueprint_type_id': 1100, 'time': 300,
                    'output_qty': 1, 'max_runs': 100, 'materials': [[34, 100]]},
            '200': {'activity': 'reaction', 'blueprint_type_id': 1200, 'time': 3600,
                    'output_qty': 200, 'max_runs': 100, 'materials': [[35, 50]]},
            '587': {'activity': 'manufacturing', 'blueprint_type_id': 1587, 'time': 6000,
                    'output_qty': 1, 'max_runs': 10, 'materials': [[100, 2], [200, 10]]},
        },
        'invention': {
            '1587': {'source_blueprint_id': 1586, 'datacores': [[40, 2], [41, 1]],
                     'probability': 0.3, 'output_runs': 10, 'time': 3600},
        },
        'types': {
            '34': {'name': 'Tritanium'}, '35': {'name': 'Pyerite'}, '100': {'name': 'Widget'},
            '200': {'name': 'Goo'}, '587': {'name': 'Ship'},
            '40': {'name': 'Datacore A'}, '41': {'name': 'Datacore B'},
        },
    }
    return industry.index_data(raw)


def test_invention_indexed():
    d = _inv_data()
    assert 587 in d['invention_by_item']
    assert d['invention_by_item'][587]['probability'] == 0.3


def test_invention_basic():
    d = _inv_data()
    p = industry.plan([{'type_id': 587, 'qty': 100}],
                      config={'me': 10, 'invention': True, 'decryptor': 'None',
                              'invention_skill_level': 4}, data=d)
    inv = [j for j in p['jobs'] if j['activity'] == 'invention']
    assert len(inv) == 1
    j = inv[0]
    assert j['produced'] == 10                       # ceil(100 runs / 10 per copy)
    assert abs(j['probability'] - 0.41) < 0.005       # 0.3 * 1.3667 skill factor
    assert j['runs'] == 25                            # ceil(10 / 0.41)
    assert _raw_map(p)[41] == 25                      # 1 Datacore B per attempt
    assert 40 in _raw_map(p)                          # Datacore A present too
    assert p['invention']['job_count'] == 1


def test_invention_decryptor():
    d = _inv_data()
    p = industry.plan([{'type_id': 587, 'qty': 100}],
                      config={'me': 10, 'invention': True, 'decryptor': 'Accelerant',
                              'invention_skill_level': 5}, data=d)
    j = [x for x in p['jobs'] if x['activity'] == 'invention'][0]
    assert j['output_qty'] == 11                      # 10 base + 1 decryptor run
    assert abs(j['probability'] - 0.525) < 0.005      # 0.3 * 1.2 * 1.4583
    raw = _raw_map(p)
    assert raw[34201] == 20                           # Accelerant Decryptor, 1/attempt
    assert raw[41] == 20                              # Datacore B, 1/attempt


def test_invention_applies_invented_me():
    d = _inv_data()
    on = industry.plan([{'type_id': 587, 'qty': 50}],
                       config={'me': 10, 'invention': True}, data=d)
    off = industry.plan([{'type_id': 587, 'qty': 50}],
                        config={'me': 10, 'invention': False}, data=d)
    # Widget demand from Ship uses the ship's ME: invented=2 -> 98, else global 10 -> 90.
    assert _job_map(on)[100]['runs'] == 98
    assert _job_map(off)[100]['runs'] == 90
    assert off['invention']['job_count'] == 0


def _child(node, name):
    return next(c for c in node['children'] if c['name'] == name)


def test_tree_structure():
    d = _data()
    p = industry.plan([{'type_id': 587, 'qty': 1}], config={'me': 0}, data=d)
    assert len(p['tree']) == 1
    root = p['tree'][0]
    assert root['type_id'] == 587 and root['activity'] == 'manufacturing' and root['runs'] == 1
    widget = _child(root, 'Widget')
    goo = _child(root, 'Goo')
    assert widget['qty'] == 2 and widget['activity'] == 'manufacturing'
    assert _child(widget, 'Tritanium')['qty'] == 200 and _child(widget, 'Tritanium')['activity'] == 'raw'
    assert goo['qty'] == 10 and goo['activity'] == 'reaction'
    assert _child(goo, 'Pyerite')['qty'] == 50


def test_tree_honors_buy():
    d = _data()
    p = industry.plan([{'type_id': 587, 'qty': 1}], config={'me': 0, 'buy_ids': [100]}, data=d)
    widget = _child(p['tree'][0], 'Widget')
    assert widget['activity'] == 'buy'
    assert 'children' not in widget            # bought -> not expanded


def test_tree_marks_invention():
    d = _inv_data()
    p = industry.plan([{'type_id': 587, 'qty': 1}], config={'me': 10, 'invention': True}, data=d)
    root = p['tree'][0]
    assert root.get('invented') is True
    assert 0.4 < root['probability'] < 0.42


def test_tree_can_be_disabled():
    d = _data()
    p = industry.plan([{'type_id': 587, 'qty': 1}], config={'me': 0, 'include_tree': False}, data=d)
    assert p['tree'] == []


def test_parse_targets():
    d = _data()
    parsed = industry.parse_targets('Ship x3\nWidget\nNotAThing x2', data=d)
    assert parsed[0] == {'type_id': 587, 'name': 'Ship', 'qty': 3, 'unresolved': False}
    assert parsed[1]['type_id'] == 100 and parsed[1]['qty'] == 1
    assert parsed[2]['unresolved'] is True and parsed[2]['name'] == 'NotAThing'
