'use strict';

// Pure scenario math for the Hooks & Hubs upgrade/workforce planner.
//
// Equinox sovereignty rules modelled here:
//   - POWER is generated locally (sun + gas/storm/plasma planets) and CANNOT be
//     moved between systems. So a system's power_balance must be >= 0 on its own;
//     a cluster-wide power surplus can't rescue a power-starved system.
//   - WORKFORCE is generated locally (skyhooks on temperate/oceanic/barren
//     planets) but CAN be transferred to connected sov hubs in the same alliance.
//     A system may export at most the workforce it generates locally
//     (workforce_available) — imported workforce isn't re-exportable.
//   - UPGRADES installed in a sov hub consume power and workforce.
//
// All numbers are user-entered (ESI doesn't expose this layer), so we coerce
// defensively. No DOM, no I/O — unit-tested in tests/hooks-hubs-utils.test.js.

function num(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function sumUpgrades(upgrades, key) {
  if (!Array.isArray(upgrades)) return 0;
  return upgrades.reduce((acc, u) => acc + num(u && u[key]), 0);
}

// computePlan(plan) -> { systems: [...derived], totals: {...} }
// `plan` is the persisted document: { systems, transfers, catalog }.
function computePlan(plan) {
  const systems = Array.isArray(plan && plan.systems) ? plan.systems : [];
  const transfers = Array.isArray(plan && plan.transfers) ? plan.transfers : [];

  const ids = new Set(systems.map((s) => s && s.id));

  // Tally workforce moved in/out per system. Transfers referencing an unknown
  // system id are ignored for netting but reported via `invalid_transfers`.
  const inflow = {};
  const outflow = {};
  let invalidTransfers = 0;
  for (const t of transfers) {
    const from = t && t.from;
    const to = t && t.to;
    const amount = num(t && t.amount);
    if (amount <= 0) continue;
    const fromOk = ids.has(from);
    const toOk = ids.has(to);
    if (!fromOk || !toOk || from === to) {
      invalidTransfers += 1;
      continue;
    }
    outflow[from] = (outflow[from] || 0) + amount;
    inflow[to] = (inflow[to] || 0) + amount;
  }

  const derived = systems.map((s) => {
    const id = s && s.id;
    const powerAvail = num(s && s.power_available);
    const workforceAvail = num(s && s.workforce_available);
    const powerUsed = sumUpgrades(s && s.upgrades, 'power');
    const workforceUsed = sumUpgrades(s && s.upgrades, 'workforce');
    const workforceIn = inflow[id] || 0;
    const workforceOut = outflow[id] || 0;
    const workforceNet = workforceAvail + workforceIn - workforceOut;

    const powerBalance = powerAvail - powerUsed;
    const workforceBalance = workforceNet - workforceUsed;
    // You can only export workforce your own skyhooks generate.
    const overExport = workforceOut > workforceAvail;

    const feasible = powerBalance >= 0 && workforceBalance >= 0 && !overExport;

    return {
      id,
      system_name: (s && s.system_name) || '',
      power_available: powerAvail,
      power_used: powerUsed,
      power_balance: powerBalance,
      workforce_available: workforceAvail,
      workforce_in: workforceIn,
      workforce_out: workforceOut,
      workforce_net: workforceNet,
      workforce_used: workforceUsed,
      workforce_balance: workforceBalance,
      over_export: overExport,
      feasible,
      upgrade_count: Array.isArray(s && s.upgrades) ? s.upgrades.length : 0,
    };
  });

  const totals = derived.reduce(
    (acc, d) => {
      acc.total_power_available += d.power_available;
      acc.total_power_used += d.power_used;
      acc.total_workforce_available += d.workforce_available;
      acc.total_workforce_used += d.workforce_used;
      if (!d.feasible) acc.infeasible_count += 1;
      return acc;
    },
    {
      system_count: derived.length,
      total_power_available: 0,
      total_power_used: 0,
      total_workforce_available: 0,
      total_workforce_used: 0,
      infeasible_count: 0,
    }
  );
  // Power can't move, so a global power "surplus" is informational only.
  totals.total_power_balance = totals.total_power_available - totals.total_power_used;
  // Workforce nets out across transfers, so cluster surplus is meaningful.
  totals.workforce_surplus = totals.total_workforce_available - totals.total_workforce_used;
  totals.transfer_count = transfers.length;
  totals.invalid_transfers = invalidTransfers;

  return { systems: derived, totals };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computePlan, num };
}
