"""Tests for the Planetary Interaction engine (pi.py) against the committed
static dataset. No network — pure data + math checks."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pi  # noqa: E402


DATA = pi.load_pi_data()


def test_dataset_shape():
    types = DATA['types']
    by_tier = {}
    for v in types.values():
        by_tier[v['tier']] = by_tier.get(v['tier'], 0) + 1
    # Matches live EVE: 15 P0, 15 P1, 24 P2, 21 P3, 8 P4.
    assert by_tier == {0: 15, 1: 15, 2: 24, 3: 21, 4: 8}
    assert len(DATA['schematics']) == 68
    assert len(DATA['p0_ids']) == 15


def test_every_planet_yields_five_p0():
    assert set(DATA['planet_types']) == set(DATA['planet_p0'])
    for planet, ids in DATA['planet_p0'].items():
        assert len(ids) == 5, f'{planet} should yield 5 P0'
        assert all(tid in DATA['p0_ids'] for tid in ids)


def test_single_planet_resources_are_unique():
    # Autotrophs/Felsic Magma/Reactive Gas each exist on exactly one planet.
    from collections import Counter
    counts = Counter(tid for ids in DATA['planet_p0'].values() for tid in ids)
    singles = {pi.type_name(tid) for tid, n in counts.items() if n == 1}
    assert {'Autotrophs', 'Felsic Magma', 'Reactive Gas'} <= singles


def test_expand_to_p0_bottoms_out_at_raw():
    # Every producible commodity expands to a basket of only P0 ids.
    for pid in pi.producible_ids(DATA):
        need = pi.expand_to_p0(pid, DATA)
        assert need, f'{pid} expanded to nothing'
        assert set(need).issubset(DATA['p0_ids']), \
            f'{pi.type_name(pid)} expansion leaked a non-P0 type'


def test_chain_steps_tiers_increase():
    # A P4's steps span P1..P4 and every step's inputs are a lower/equal tier.
    p4 = sorted(t for t, v in DATA['types'].items() if v['tier'] == 4)[0]
    steps = pi.chain_steps(p4, DATA)
    tiers = {s['tier'] for s in steps}
    assert tiers == {1, 2, 3, 4}
    for s in steps:
        for in_id, _q in s['inputs']:
            assert pi.tier_of(in_id, DATA) < s['tier']


def test_available_products_gates_on_planets():
    # With all 15 P0 available, everything is buildable.
    all_p0 = DATA['p0_ids']
    assert set(pi.available_products(all_p0, DATA)) == set(pi.producible_ids(DATA))
    # With a single planet's 5 P0, only chains whose P0 fit are offered.
    one_planet = DATA['planet_p0']['Barren']
    prods = pi.available_products(one_planet, DATA)
    for pid in prods:
        assert set(pi.expand_to_p0(pid, DATA)).issubset(set(one_planet))


def test_evaluate_math_is_consistent():
    p4 = sorted(t for t, v in DATA['types'].items() if v['tier'] == 4)[0]
    sell = {t: 1000.0 for t in DATA['types']}
    base = {t: 100.0 for t in DATA['types']}
    r = pi.evaluate(p4, sell, base, tax_rate=0.05, data=DATA)
    # chain profit = sell - chain export tax, exactly.
    assert abs(r['chain_profit'] - (r['unit_sell'] - r['chain_export_tax'])) < 1e-6
    # single-step margin = sell - input cost - one export tax.
    assert abs(r['step_margin'] - (r['unit_sell'] - r['step_input_cost'] - r['step_export_tax'])) < 1e-6
    # export tax on the finished unit = tax_rate * base.
    assert abs(r['step_export_tax'] - 0.05 * 100.0) < 1e-6


def test_evaluate_flags_missing_prices():
    p4 = sorted(t for t, v in DATA['types'].items() if v['tier'] == 4)[0]
    r = pi.evaluate(p4, {}, {}, data=DATA)  # no prices at all
    assert r['unit_sell'] == 0
    assert p4 in r['missing_prices']


def test_rank_chains_is_sorted_desc():
    sell = {t: (DATA['types'][t]['tier'] or 0) * 500.0 for t in DATA['types']}
    base = {t: 50.0 for t in DATA['types']}
    rows = pi.rank_chains(DATA['p0_ids'], sell, base, data=DATA)
    profits = [r['chain_profit'] for r in rows]
    assert profits == sorted(profits, reverse=True)
    assert len(rows) == len(pi.producible_ids(DATA))
