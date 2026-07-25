# Contract scan history — design

**Date:** 2026-07-24
**Status:** approved, ready for implementation plan

## Problem

There is no record of how a contract scan performed. When the scan code changes
there is no way to answer "did that help?" beyond watching one run and forming an
impression. The ESI 520 work committed in `b209556` is the immediate motivation:
it changed retry timing and added a sweep pass, and its effect on scan duration
and failure count is currently unmeasurable.

## Goal

Persist one record per contracts scan — duration, contracts searched, and enough
ESI-health detail to explain a regression — tagged with the revision of the code
that produced it.

## Non-goals

- No UI. The store is read by script or by eye, not rendered in the app.
- No tracking of the sold-30d scan. Its work profile differs, so its rows would
  not be comparable to contract-scan rows.
- No aggregation, charting, or trend analysis in the app.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Consumption | JSON store only, no UI | Smallest surface; analysis is ad-hoc |
| Detail level | Core + ESI health | A slow scan must be diagnosable, not just visible |
| Scope | Every contracts scan, cold and warm | `items_cached` distinguishes them; nothing silently dropped |
| Retention | Ring buffer, last 200 runs | Bounds file at ~100 KB / ~19 ms round-trip |
| Git info | Captured once per process at startup | Faster *and* more correct (see below) |
| Seeding | None — file builds up naturally | Exact `retries`/`items_fetched` for past runs are unknown; fabricating them would pollute the dataset. Reversible: a row can be appended by hand later |

## Record shape

One entry per scan, appended to `runs`:

```json
{
  "started": "2026-07-24T23:41:02Z",
  "seconds": 78.2,
  "alliance": "main",
  "contracts": 154,
  "corps_scanned": 3,
  "items_fetched": 154,
  "items_cached": 0,
  "items_failed": 0,
  "esi_errors": {"520": 122},
  "retries": 47,
  "sweep_attempted": 31,
  "sweep_recovered": 30,
  "phases": {"contracts": 12.4, "items": 61.1, "names": 4.7},
  "git": "b209556",
  "dirty": false,
  "app_version": "2.0.3"
}
```

`items_cached == 0` marks a cold (fully comparable) run. Warm runs are retained
because they show whether the cache is doing its job.

Field semantics, where the name alone is ambiguous:

- `seconds` — end-to-end wall time for the whole scan, **including** the sweep's
  15 s pause when one occurs. A run with `sweep_attempted > 0` therefore carries
  that delay; subtract it before comparing against a run that had no sweep.
- `corps_scanned` — a **count**, not the list of ids that `done` carries.
- `items_fetched` — item requests that reached ESI and succeeded, so
  `items_fetched + items_cached + items_failed == contracts`.
- `retries` — total retry *attempts* across all contracts, not the number of
  contracts that needed retrying.
- `sweep_attempted` / `sweep_recovered` — contracts entering the sweep and
  contracts it rescued; `attempted - recovered` is what the user sees in the
  warning banner.
- `esi_errors` — keyed by HTTP status as a string, counting every failed
  attempt, so it exceeds `items_failed` whenever retries happened.

## Architecture

### New module: `python/scan_history.py`

One focused file with two cohesive concerns, mirroring how `liquidation.py`
pairs a store with its engine.

**`ScanMetrics`** — a pure accumulator, no IO:

- `start_phase(name)` / `end_phase(name)` — coarse timings via an injectable
  clock, defaulting to `time.monotonic`
- `record_fetch(cached=False)` — one item fetch, cached or live
- `record_error(status)` — buckets into `esi_errors` by HTTP status
- `record_retry()` — wired to `call_with_retry`'s existing `on_retry` hook
- `record_sweep(attempted, recovered)`
- `finish() → dict` — the record above

Counter mutations are guarded by a `threading.Lock`, since the three pool
workers report concurrently. The injectable clock means phase-timing tests need
no sleeps.

**Store** — follows `liquidation.py` / `pinned.py` exactly:

- `load_history()` → `{"runs": [...]}`, tolerant of a missing or corrupt file
  (returns empty rather than raising)
- `append_run(record)` → appends, trims to the last 200, writes atomically via
  `tmp` + `os.replace`, `chmod 600`
- Path: `AUTH_DIR/scan_history.json`

**Version tagging** — `git rev-parse --short HEAD` and `git status --porcelain`,
each with a 2 s timeout, memoized at first use and wrapped in try/except
(a packaged app has no repo; both fields fall back to `null`).

Capturing this once per process rather than once per scan is deliberate: the
sidecar loads Python code at process start, so the startup sha is the sha of the
code actually running. A per-scan lookup would stamp runs with the working
tree's current sha even when that code was never loaded — actively misleading
for the comparison this feature exists to support.

`app_version` is read from `package.json`.

### Wiring: `server.py`

`_scan_contracts_stream` creates a `ScanMetrics`, marks phase boundaries around
the three existing stages (corp contract listing → item fetch → name
resolution), passes the collector into `_fetch_items` and through `on_retry`,
and appends one record immediately before the final `done` emit.

Errors are counted at the item-fetch layer rather than globally in `esi.py`'s
response hook. A module-level counter there would capture all ESI traffic with
no plumbing, but it is global mutable state that concurrent scans would corrupt,
and it would fold unrelated market/sov traffic into a contracts-scan record.

## Error handling

The record-and-append step is wrapped so a history failure can never break or
slow a scan. Worst case: one row is lost and a warning is logged. The scan's
`done` payload is unaffected.

## Performance

Measured on the target machine:

| Component | Cost |
|---|---|
| 210 lock-guarded increments across 3 threads | 1.9 ms |
| History read + write at 200-run capacity (~100 KB) | 19 ms |
| `git rev-parse` | 88.9 ms, once per process |
| `git status --porcelain` | 145.1 ms, once per process |

**~21 ms per scan against a ~78 s scan (~0.03%).** No additional ESI calls. All
counter mutations happen between network calls on threads that are IO-blocked
~99% of the time, so nothing enters the critical path.

## Testing

Unit tests (`python/tests/test_scan_history.py`):

- accumulator arithmetic: fetches, cached vs live, error bucketing by status,
  retry and sweep counts
- phase timing with an injected clock — no sleeps
- ring buffer trims at exactly 200, keeping the newest
- corrupt and missing files load as empty rather than raising
- write is atomic (`tmp` + `os.replace`) and the file is chmod 600
- git helpers fall back to `null` when git is absent or times out

Scan-level tests (added to `python/tests/test_contracts_scan.py`):

- a scan appends exactly one correctly-shaped record
- a store that raises does not break the scan or alter the `done` payload

## Consequence to accept

The file starts empty, so the first runs provide no baseline. Pre-change
performance is known only anecdotally from the 2026-07-24 debugging session
(154 contracts, ~81 s, 31 permanently failed on pre-`b209556` code) and is
deliberately not seeded.
