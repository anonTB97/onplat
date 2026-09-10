# Stress test: carrier-scale data against the read surface

Two runs are recorded here. The **CVN-scale run (2026-09-09)** is the one
that stands: a synthetic hull at carrier density — spaces, hazards, couplings
and activities all scaled — on both stores. The **key-op-grain run
(2026-08-31)** below it scaled only the activities on the reference hull; its
headline claim that the map surface is untouched by scale is **withdrawn** by
the first run, and its numbers are kept for the record of what was believed
and why. Assessment and change list: `docs/council/3-data-and-performance.md`.

## CVN-scale run (2026-09-09)

**Reproduce**: `scripts/load-test.sh [--pg]` — generates the hull under
`${TMPDIR:-/tmp}/wadl-scale`, boots the release binary on it, runs
`tools/load_test.mjs` (Node, no dependency) phase by phase, and with `--pg`
bootstraps a scratch tenant (`CVN-73L`, org `…d001`) through
`wadl bootstrap-hull` + `wadl load-docs` and repeats the reads. By hand:

```
python3 tools/gen_cvn73_hull.py --scale 7 --hazards 400 --out /tmp/scale
cp reference/cvn73/CVN73-{clock.csv,fieldmap.json,rule-table.csv} /tmp/scale/
python3 tools/gen_full_xer.py --register /tmp/scale/CVN73-register.csv \
    --out /tmp/scale/CVN73-PIA26-scale.xer --months 30 --chain-scale 1.3
CARGO_INCREMENTAL=0 cargo build --release -p wadl-api --bin serve
WADL_DEMO_DOCS=/tmp/scale WADL_SCHEDULE_XER=/tmp/scale/CVN73-PIA26-scale.xer \
    WADL_PORT=8080 target/release/serve
node tools/load_test.mjs --conc 1,10 --samples 8 latency
node tools/load_test.mjs --xer /tmp/scale/CVN73-PIA26-scale.xer import
node tools/load_test.mjs --clear 5-212-2-Q:hot_work_live --conc 10 clear
node tools/load_test.mjs diff
```

**Dataset**: 3,332 compartments on 12 decks · 45,201 activities (14
milestones, 945 negative lags) · 36,403 relationships · 48,767 assignments ·
4,221 authored couplings + 26,419 derived deck penetrations · 400 live
hazards · availability 2026-07-27 → 2029-01-23 · 14.2 MB XER. Both
generators are byte-identical at their defaults, so `reference/` is
unchanged. **Box**: 4 vCPU / 15 GB dev container, release build, another
process sharing the box for part of the memory-store run. **Caution**: the
register-shaped routes run for minutes at this scale and a handler on the
memory store cannot be cancelled once started (the 30 s timeout never
fires, see below); do not point this at a shared instance.

### Memory store

| what | value |
|---|---|
| boot → `/health` 200 (7 documents + 14.2 MB XER through the doors) | 1.02–1.10 s; RSS 154–158 MB |
| RSS after one register read / after the door / peak | 425 MB / 558 MB / 611 MB (VmHWM) |
| audit lines with `dur_ms` > 30,000 during the run | 12, every one `status: 200` (longest 139,793 ms); 503s: 0 |

| endpoint | clients | p50 | p95 | max | wire / raw |
|---|---|---|---|---|---|
| compartments | 1 / 10 | 23 / 72 ms | 34 / 112 ms | 34 / 112 ms | 70 KB / 723 KB |
| compartments/:no/state | 1 / 10 | 23 / 77 ms | 31 / 136 ms | 31 / 136 ms | 1 KB |
| zones/Z4/adjacent (705 spaces inside) | 1 / 10 | 1,049 / 2,126 ms | 1,107 / 4,175 ms | | 12 KB / 110 KB |
| hazards | 1 / 10 | 2 / 4 ms | 2 / 6 ms | | 8 KB / 59 KB |
| ledger (9 rows) | 1 / 10 | 1 / 2 ms | 1 / 2 ms | | 5 KB |
| schedule-runs | 1 / 10 | <1 / 2 ms | 1 / 2 ms | | 1 KB |
| deck-states (3,332 rows) | 1 / 4 / 10 | 12.3 / 26.1 / 27.0 s | 12.7 / 26.4 / 41.3 s | | 134 KB / 1.5 MB |
| readiness | 1 / 10 | 10.5 / 23.7 s | 11.0 / 46.5 s | | 3 KB / 19 KB |
| activities (45,201 rows + 36,403 edges) | 1 | 48.2 s | one sample | | 6.0 MB / 30.7 MB |
| work-conflicts (2,641 scanned, 200 pairs kept, 2,738 dropped) | 1 | 119.9 s | one sample | | 11 KB / 97 KB |
| schedule-alternatives (10,442 rows) | 1 | 74.9 s | one sample | | 0.9 MB / 7.3 MB |
| issues (12,738 rows) | 1 | 139.8 s | one sample | | 0.8 MB / 5.6 MB |
| leverage | 1 | > 600 s, abandoned | the handler kept its core until SIGKILL | | |

| door and writes | value |
|---|---|
| `POST schedule-of-record?dry_run=true` (16.2 MB body) | 200 in 113.9 s |
| `POST schedule-of-record` commit (run #2, ledgered) | 200 in 103.6 s |
| `GET schedule-runs/diff?run=#2&against=#1` | 1 client 99.7 s; 4 clients 208.0 s p50 / 217.4 s p95 |
| `POST hazards/clear` while 10 deck-states readers are in flight | **200 in 41.5 s** (the readers: p50 41.5 s, p95 45.3 s) |
| SIGTERM with a register read in flight | not stopped within 1 s; SIGKILL needed |

### PostgreSQL store (`--features postgres`, scratch tenant `CVN-73L`)

«PGTABLE»

### What the run says

- **The map surface is not untouched by scale.** `deck-states` evaluates
  the engine for every compartment, and each evaluation walks every hazard's
  cascade (`crates/wadl-engine/src/evaluate.rs:299-356`): C × H × R walks per
  read. At 7× the spaces and 15× the hazards that is 12 s per reader and
  27 s p50 with ten. The single-space read (23 ms) is the shape that scales;
  the whole-hull reads must be built from one cascade index per read
  (council 3, D1) rather than one cascade per subject.
- **The register-shaped reads evaluate the engine per activity** —
  45,201 times per request, again in the alternatives, the issues, the
  door's delta (twice) and the diff (twice). Minutes each.
- **The 30 s request timeout does not fire on CPU-bound handlers**: the
  memory store's futures never yield, so `tokio::time::timeout` is never
  polled; twelve requests in this run ran 30–140 s and every one answered
  200. The shed in `hardening.rs` cannot see them either, a closed
  connection does not cancel them, and the drain on SIGTERM waits for them.
  The 2026-08-31 note that "the 30 s timeout is the real backstop" was
  wrong for this store.
- **Writes starve behind reads**: a hazard clear is a 1 ms write and took
  41.5 s because it queued behind ten readers on four worker threads.
- **PostgreSQL adds the document re-materialisation per trait call** — the
  served schedule is 25 MB of jsonb (4.5 MB TOAST); one detoast to text is
  305 ms in the database alone before transfer and parse — and two
  transactions per trait call (the vessel gate, then the read).

## Key-op-grain run on the reference hull (2026-08-31) — superseded

Run on the development container (4 cores, release build, in-memory
store). Harness: `scripts/stress-test.sh` — `scripts/stress/gen-xer.py`
scaled the reference CVN-73 export to **40,586 activities** (26 clones at
key-op grain; TASKPRED/TASKRSRC/UDF cloned with referential integrity) over
the **same 476-space register and the same 27 hazards**, dates left
overlapping on purpose. The compartment and hazard counts did not scale,
which is why the map surface read as free.

| phase | status | time |
|---|---|---|
| dry-run (13.9 MB body, full mapping + delta) | 200 | 0.55 s |
| commit | 200 | 0.45 s |

| endpoint | p50 | p95 | wire payload | note |
|---|---|---|---|---|
| activities | 934 ms | 1.1 s | 1.3 MB (23.3 MB uncompressed) | the register read |
| deck-states | 1 ms | 1 ms | 11 KB | 476 spaces × 27 hazards |
| readiness | 1 ms | 1 ms | 3 KB | |
| work-conflicts | 151 ms | 158 ms | 3 KB | PAIR_CAP bounds the scan |
| issues | 376 ms | 410 ms | 51 KB | O(register) derivation |
| schedule-alternatives | 477 ms | 484 ms | 40 KB | window search per refused row |
| work-orders / leverage / compartments / packages | 1 ms | 1 ms | ≤5 KB | |

Concurrency (64 workers × 12 s on activities + deck-states): 133 requests,
11 rps, p50 7.9 s / p95 11.4 s, 0 errors, RSS 1.63 GB after (concurrent
23 MB response buffers plus allocator retention). Shed with
`WADL_MAX_IN_FLIGHT=2`: 3 served, 61 refused 503, no hangs. At
`WADL_MAX_IN_FLIGHT=4` on 4 cores zero sheds occurred while peak concurrent
handler execution was exactly 4: the in-memory store's handlers are
CPU-bound with no await points, so a permit-holder occupies an executor
worker start-to-finish and the semaphore never observes contention. The
compression layer (`wadl_api::hardening::compressed`, level-1 gzip on
≥16 KB JSON/text bodies) came out of this run: 23.3 MB → 1.3 MB on the wire,
p95 2.0 s → 1.1 s.

What this run got right: the door is linear and fast at 40k rows, the
register read is bandwidth-shaped and compresses ~18:1, the semaphore
refuses cleanly when it can see contention. What it got wrong: it measured
a hull whose compartments and hazards had not grown, and it called the
request timeout a backstop for handlers it cannot interrupt.
