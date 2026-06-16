'use strict';

const { computePlan, num } = require('../renderer/hooks-hubs-utils.js');

describe('num', () => {
  test('coerces strings and rejects junk', () => {
    expect(num('1500')).toBe(1500);
    expect(num(42)).toBe(42);
    expect(num('')).toBe(0);
    expect(num('abc')).toBe(0);
    expect(num(undefined)).toBe(0);
    expect(num(null)).toBe(0);
  });
});

describe('computePlan', () => {
  test('empty plan yields zeroed totals', () => {
    const r = computePlan({});
    expect(r.systems).toEqual([]);
    expect(r.totals.system_count).toBe(0);
    expect(r.totals.infeasible_count).toBe(0);
  });

  test('per-system power/workforce balances and feasibility', () => {
    const plan = {
      systems: [
        {
          id: 'a',
          system_name: '1DQ1-A',
          power_available: 1000,
          workforce_available: 5000,
          upgrades: [
            { name: 'Cyno Suppression', power: 250, workforce: 3000 },
            { name: 'Capital Shipyard', power: 250, workforce: 1000 },
          ],
        },
      ],
      transfers: [],
    };
    const { systems, totals } = computePlan(plan);
    expect(systems[0].power_used).toBe(500);
    expect(systems[0].power_balance).toBe(500);
    expect(systems[0].workforce_used).toBe(4000);
    expect(systems[0].workforce_balance).toBe(1000);
    expect(systems[0].feasible).toBe(true);
    expect(totals.infeasible_count).toBe(0);
    expect(totals.workforce_surplus).toBe(1000);
  });

  test('power deficit is infeasible and cannot be rescued by another system', () => {
    const plan = {
      systems: [
        { id: 'a', power_available: 100, workforce_available: 0, upgrades: [{ name: 'X', power: 300, workforce: 0 }] },
        { id: 'b', power_available: 1000, workforce_available: 0, upgrades: [] },
      ],
      transfers: [],
    };
    const { systems, totals } = computePlan(plan);
    const a = systems.find((s) => s.id === 'a');
    expect(a.power_balance).toBe(-200);
    expect(a.feasible).toBe(false);
    // Cluster has +800 net power, but A is still infeasible — power is local.
    expect(totals.total_power_balance).toBe(800);
    expect(totals.infeasible_count).toBe(1);
  });

  test('workforce transfer nets in/out and flips feasibility', () => {
    const plan = {
      systems: [
        // Needs 4000 workforce, only generates 1000 locally.
        { id: 'need', power_available: 0, workforce_available: 1000, upgrades: [{ name: 'U', power: 0, workforce: 4000 }] },
        // Surplus system generating 6000, using none.
        { id: 'surplus', power_available: 0, workforce_available: 6000, upgrades: [] },
      ],
      transfers: [{ from: 'surplus', to: 'need', amount: 3000 }],
    };
    const { systems } = computePlan(plan);
    const need = systems.find((s) => s.id === 'need');
    const surplus = systems.find((s) => s.id === 'surplus');
    expect(need.workforce_in).toBe(3000);
    expect(need.workforce_net).toBe(4000);
    expect(need.workforce_balance).toBe(0);
    expect(need.feasible).toBe(true);
    expect(surplus.workforce_out).toBe(3000);
    expect(surplus.workforce_net).toBe(3000);
    expect(surplus.feasible).toBe(true);
  });

  test('exporting more workforce than generated locally is infeasible', () => {
    const plan = {
      systems: [
        { id: 'a', power_available: 0, workforce_available: 1000, upgrades: [] },
        { id: 'b', power_available: 0, workforce_available: 0, upgrades: [] },
      ],
      transfers: [{ from: 'a', to: 'b', amount: 2000 }],
    };
    const { systems } = computePlan(plan);
    const a = systems.find((s) => s.id === 'a');
    expect(a.over_export).toBe(true);
    expect(a.feasible).toBe(false);
  });

  test('transfers referencing unknown systems are flagged, not netted', () => {
    const plan = {
      systems: [{ id: 'a', power_available: 0, workforce_available: 1000, upgrades: [] }],
      transfers: [
        { from: 'a', to: 'ghost', amount: 500 },
        { from: 'a', to: 'a', amount: 100 },
      ],
    };
    const { systems, totals } = computePlan(plan);
    expect(totals.invalid_transfers).toBe(2);
    expect(systems[0].workforce_out).toBe(0);
  });

  test('string inputs from form fields are coerced', () => {
    const plan = {
      systems: [{ id: 'a', power_available: '500', workforce_available: '2000', upgrades: [{ name: 'U', power: '100', workforce: '500' }] }],
      transfers: [],
    };
    const { systems } = computePlan(plan);
    expect(systems[0].power_balance).toBe(400);
    expect(systems[0].workforce_balance).toBe(1500);
  });
});
