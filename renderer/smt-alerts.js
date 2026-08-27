'use strict';

// ================= SMT intel alarms =================
// Shared by the Intel Map tab and the overlay window: both feed it the intel /
// kill events they poll plus a map of how far away each system is, and it
// decides whether to make a noise — and which noise. Settings live in the
// sidecar (/api/smt/alerts) so the two windows always agree on the rules.
//
// Everything is keyed on **distance tiers**: the first tier whose `max` covers
// the report decides its sound, and how the overlay draws it — colour, size,
// how long it takes to fade, and whether it flashes.
// Past the last tier a report is out of range: no alarm, and the overlay
// draws it in its plain default red rather than a tier colour.
//
// Sounds are synthesised with WebAudio rather than shipped as assets — no
// binaries in the repo, and they work identically in both windows. Any tier can
// point at a sound file of your own instead.

window.SmtAlerts = (function () {
  const TIER_DEFAULTS = [
    { max: 0, sound: 'siren', colour: '#ff2d2d', flash: 'fast', custom: '', flash_window: true, size: 1.7, fade: 900 },
    { max: 2, sound: 'klaxon', colour: '#ff6a1a', flash: 'fast', custom: '', flash_window: false, size: 1.3, fade: 600 },
    { max: 5, sound: 'beep', colour: '#e8c33a', flash: 'slow', custom: '', flash_window: false, size: 1.0, fade: 300 },
  ];
  const DEFAULTS = {
    enabled: true, tiers: TIER_DEFAULTS, hostile: true, clear: false, kills: false,
    volume: 0.6, clear_sound: 'chime', kill_sound: 'thud', gap: 3,
  };

  const st = { cfg: { ...DEFAULTS }, ctx: null, last: 0, lastWatch: 0, muted: false, watch: new Map() };

  // ---- synthesised sounds ------------------------------------------------
  // Each preset is a list of [waveform, startHz, endHz, startSec, durSec, gain]
  // partials, mixed into one AudioContext ramp.
  const SOUNDS = {
    klaxon: [['square', 440, 440, 0, 0.18, 1], ['square', 620, 620, 0.2, 0.18, 1],
             ['square', 440, 440, 0.4, 0.18, 1], ['square', 620, 620, 0.6, 0.22, 1]],
    siren:  [['sawtooth', 400, 1200, 0, 0.45, 0.8], ['sawtooth', 400, 1200, 0.45, 0.45, 0.8]],
    chime:  [['triangle', 880, 880, 0, 0.16, 0.9], ['triangle', 1320, 1320, 0.14, 0.4, 0.7]],
    blip:   [['sine', 1000, 1000, 0, 0.09, 0.9]],
    thud:   [['sine', 150, 70, 0, 0.32, 1]],
    beep:   [['square', 800, 800, 0, 0.1, 0.7], ['square', 800, 800, 0.16, 0.1, 0.7]],
    knock:  [['sine', 300, 180, 0, 0.08, 1], ['sine', 300, 180, 0.13, 0.08, 1]],
    alarm:  [['square', 950, 950, 0, 0.12, 0.9], ['square', 700, 700, 0.14, 0.12, 0.9],
             ['square', 950, 950, 0.28, 0.12, 0.9], ['square', 700, 700, 0.42, 0.16, 0.9]],
  };
  const SOUND_NAMES = Object.keys(SOUNDS);
  const FLASH = ['none', 'slow', 'fast'];

  function ctx() {
    if (!st.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      st.ctx = new AC();
    }
    // Chromium suspends the context until a gesture; both windows are launched
    // with autoplayPolicy relaxed, but resume anyway in case it slipped through.
    if (st.ctx.state === 'suspended') st.ctx.resume().catch(() => {});
    return st.ctx;
  }

  function synth(name, volume) {
    const c = ctx();
    const parts = SOUNDS[name] || SOUNDS.klaxon;
    if (!c) return;
    const now = c.currentTime;
    for (const [wave, f0, f1, at, dur, g] of parts) {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = wave;
      osc.frequency.setValueAtTime(f0, now + at);
      if (f1 !== f0) osc.frequency.linearRampToValueAtTime(f1, now + at + dur);
      // Short attack/release either side of the body, so nothing clicks.
      gain.gain.setValueAtTime(0, now + at);
      gain.gain.linearRampToValueAtTime(volume * g, now + at + 0.01);
      gain.gain.setValueAtTime(volume * g, now + at + dur - 0.03);
      gain.gain.linearRampToValueAtTime(0, now + at + dur);
      osc.connect(gain).connect(c.destination);
      osc.start(now + at);
      osc.stop(now + at + dur + 0.02);
    }
  }

  function fileUrl(p) {
    const s = String(p || '').trim();
    if (!s) return '';
    if (/^(file|https?):/i.test(s)) return s;
    return 'file:///' + s.replace(/\\/g, '/').replace(/^\/+/, '');
  }

  function emit(sound, custom) {
    const vol = Math.max(0, Math.min(1, Number(st.cfg.volume) || 0));
    if (!vol) return;
    if (custom) {
      try {
        const a = new Audio(fileUrl(custom));
        a.volume = vol;
        a.play().catch(() => synth(sound, vol));   // fall back if the file won't load
        return;
      } catch (_) { /* fall through to the synth */ }
    }
    synth(sound, vol);
  }

  // ---- watchlist ---------------------------------------------------------
  // Systems you always want to hear about. Checked before the distance tiers
  // and never distance-limited, so home still shouts while you're six regions
  // out. Each entry carries its own sound — that's what lets you tell staging
  // from a chokepoint without looking at anything.
  const WATCH_LOOK = { size: 1.5, fade: 900 };   // how the overlay draws a watch hit

  // A watch dressed up as a tier, so every renderer that already knows how to
  // draw a tier draws a watch too, in that system's own colour.
  const watchTier = (w) => ({ ...WATCH_LOOK, ...w, max: -1, watch: true });

  function watchFor(systems) {
    for (const sid of systems || []) {
      const w = st.watch.get(String(sid));
      if (w) return w;
    }
    return null;
  }

  // ---- distance tiers ----------------------------------------------------
  const tiers = () => (st.cfg.tiers && st.cfg.tiers.length ? st.cfg.tiers : TIER_DEFAULTS);

  // The first tier that covers this distance. null = past every tier, i.e. out
  // of range. A tier with max < 0 covers any distance and is always last.
  function tierFor(jumps, id) {
    if (id != null) {
      const w = st.watch.get(String(id));
      if (w) return watchTier(w);        // a watch outranks whatever distance says
    }
    if (jumps == null) return null;
    for (const t of tiers()) {
      if (t.max < 0 || jumps <= t.max) return t;
    }
    return null;
  }

  // How far out the furthest tier reaches — what the range map has to cover.
  // -1 means "anywhere", so no distance map is needed at all.
  function reach() {
    let r = 0;
    for (const t of tiers()) {
      if (t.max < 0) return -1;
      r = Math.max(r, t.max);
    }
    return r;
  }

  // The nearest tier any of these systems falls into, plus that distance.
  // With no distance map (no character, nothing pinned) we can't measure, so
  // fall back to the furthest tier — you still get a noise, the gentlest one.
  function match(systems, jumpsOf) {
    const w = watchFor(systems);
    if (w) {
      const j = jumpsOf ? jumpsOf.get(String(w.system_id)) : undefined;
      return { tier: watchTier(w), jumps: j == null ? null : j, watch: w };
    }
    if (!jumpsOf || !jumpsOf.size) {
      const all = tiers();
      return { tier: all[all.length - 1] || null, jumps: null };
    }
    let best = null, bestJ = null;
    for (const sid of systems || []) {
      const j = jumpsOf.get(String(sid));
      if (j == null) continue;
      if (bestJ == null || j < bestJ) { bestJ = j; best = tierFor(j); }
    }
    return { tier: best, jumps: bestJ };
  }

  // Watch hits throttle on their own clock. Sharing one would let a busy
  // channel three regions away silence the alarm you actually care about.
  function throttled(watch) {
    const gap = (Number(st.cfg.gap) || 0) * 1000;
    const key = watch ? 'lastWatch' : 'last';
    const now = Date.now();
    if (now - st[key] < gap) return true;
    st[key] = now;
    return false;
  }

  const armed = () => st.cfg.enabled;

  return {
    sounds: SOUND_NAMES,
    flashes: FLASH,
    defaults: () => ({ ...DEFAULTS, tiers: TIER_DEFAULTS.map((t) => ({ ...t })) }),
    config: () => ({ ...st.cfg }),
    setConfig(cfg) { st.cfg = { ...DEFAULTS, ...(cfg || {}) }; },
    // The watchlist as the sidecar hands it over: [{system_id, sound, ...}].
    setWatchlist(list) {
      st.watch = new Map((list || []).filter((w) => w && w.system_id != null)
        .map((w) => [String(w.system_id), w]));
    },
    watchlist: () => [...st.watch.values()],
    isWatched: (id) => st.watch.has(String(id)),
    watchFor,
    setMuted(m) { st.muted = !!m; },
    muted: () => st.muted,
    tiers,
    tierFor,
    reach,

    // Preview one sound at the configured volume, ignoring throttle and mute.
    // `kind` is 'clear', 'kill', or a tier index.
    test(kind) {
      if (kind === 'clear') return emit(st.cfg.clear_sound, '');
      if (kind === 'kill') return emit(st.cfg.kill_sound, '');
      const t = tiers()[Number(kind) || 0] || tiers()[0];
      if (t) emit(t.sound, t.custom);
    },

    // Preview an arbitrary sound — the watchlist rows each have their own, so
    // they can't go through test()'s tier index.
    testSound(sound, custom) { emit(sound, custom); },

    // Feed the intel events from one poll. Returns one entry per report that
    // triggered, so the caller can drive visuals (the whole-overlay flash) off
    // the same decision that made the sound. Muting silences the sound only —
    // the visuals still fire, which is the point of muting.
    intel(events, jumpsOf) {
      if (!armed() || !events || !events.length) return [];
      const fired = [];
      for (const e of events) {
        const want = e.clear ? st.cfg.clear : st.cfg.hostile;
        if (!want) continue;
        if (!e.systems || !e.systems.length) continue;   // no system, no distance
        const m = match(e.systems, jumpsOf);
        if (!m.tier) continue;                           // out of range
        // continue, not break: the two clocks mean a throttled distant report
        // must not stop us reaching a watch hit later in the same batch.
        if (throttled(!!m.watch)) continue;
        if (!st.muted) {
          if (e.clear) emit(st.cfg.clear_sound, '');
          else emit(m.tier.sound, m.tier.custom);
        }
        fired.push({ tier: m.tier, jumps: m.jumps, clear: !!e.clear, watch: m.watch || null });
      }
      return fired;
    },

    // Feed the kills from one poll.
    kills(kills, jumpsOf) {
      if (!armed() || !st.cfg.kills || !kills || !kills.length) return [];
      for (const k of kills) {
        const m = match([k.system_id], jumpsOf);
        if (!m.tier) continue;
        if (throttled(!!m.watch)) continue;
        // A kill in a watched system speaks with that system's voice, and at
        // any distance — but the global Kills toggle still gates it, so
        // watching a system never turns on a feed you'd switched off.
        if (!st.muted) emit(m.watch ? m.watch.sound : st.cfg.kill_sound, m.watch ? m.watch.custom : '');
        return [{ tier: m.tier, jumps: m.jumps, kill: true, watch: m.watch || null }];
      }
      return [];
    },
  };
})();
