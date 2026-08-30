'use strict';

// ================= SMT activity layers =================
// The four ESI activity numbers — NPC, ship and pod kills, and ship jumps —
// shared by the Intel Map tab and the overlay window so both draw the same
// figure in the same colour. Thresholds live in the sidecar (/api/smt/activity)
// alongside the alarm rules and the watchlist.
//
// These all come from /universe/system_kills and /universe/system_jumps, which
// report the **last hour only** and refresh hourly. ESI publishes no longer
// window, so there is no 24-hour figure to show here.
//
// Unlike Sov, several of these can be on at once, so none of them may own the
// system's dot colour — they'd overwrite each other and you'd have no idea
// which layer you were looking at. Each enabled layer instead draws its own
// tagged number beside the node, in a fixed order, so two layers on at once
// read as "N120 S3" rather than one colour that means nothing.

window.SmtActivity = (function () {
  // Fixed order, so a system's numbers don't jump around as layers are toggled.
  const ORDER = ['npc', 'ship', 'pod', 'jumps'];
  const TAG = { npc: 'N', ship: 'S', pod: 'P', jumps: 'J' };
  const LABEL = { npc: 'NPC kills', ship: 'Ship kills', pod: 'Pod kills', jumps: 'Ship jumps' };
  const HINT = {
    npc: 'Rats killed in the last hour — ratting activity, and a sudden drop is its own kind of intel',
    ship: 'Ships killed in the last hour — actual fighting',
    pod: 'Pods killed in the last hour — someone died and didn’t get out',
    jumps: 'Ships that jumped into the system in the last hour — traffic',
  };

  const st = { cfg: null, live: null, liveTs: 0 };

  const layers = () => ORDER.slice();
  const cfg = () => (st.cfg && st.cfg.layers) || {};
  const layer = (name) => cfg()[name] || { on: false, bands: [] };
  const enabled = () => ORDER.filter((n) => layer(n).on);

  // The last band whose threshold the value clears. Below the first band the
  // value isn't drawn at all — with ~5000 systems, painting every 1 would bury
  // the handful that matter.
  function colourFor(name, value) {
    const v = Number(value) || 0;
    if (v <= 0) return null;
    let hit = null;
    for (const b of (layer(name).bands || [])) {
      if (v >= b.min) hit = b.colour;
    }
    return hit;
  }

  // The raw numbers for one system, as [{key, tag, value, colour}] in draw
  // order — only enabled layers, only values that clear their first band.
  function cellsFor(systemId) {
    const live = st.live;
    if (!live) return [];
    const id = String(systemId);
    const k = (live.kills || {})[id] || {};
    const out = [];
    for (const name of enabled()) {
      const value = name === 'jumps' ? ((live.jumps || {})[id] || 0) : (k[name] || 0);
      const colour = colourFor(name, value);
      if (colour) out.push({ key: name, tag: TAG[name], value, colour });
    }
    return out;
  }

  return {
    ORDER, TAG, LABEL, HINT,
    layers,
    enabled,
    layer,
    colourFor,
    cellsFor,
    config: () => st.cfg,
    setConfig(c) { st.cfg = c && c.layers ? c : { layers: {} }; },
    setLive(d) { st.live = d || null; st.liveTs = Date.now(); },
    live: () => st.live,
    // True when something needs /api/map/live polled at all.
    wanted: () => enabled().length > 0,
    // Compact "N120 S3" for a tooltip or a list row.
    summary(systemId) {
      return cellsFor(systemId).map((c) => `${c.tag}${c.value}`).join(' ');
    },
  };
})();
