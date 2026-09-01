# Stress test: a key-op-grain schedule against the read surface

Run 2026-08-31 on the development container (4 cores, release build,
in-memory store). Harness: `scripts/stress-test.sh` — regenerate the
schedule and reproduce every number here with one command. Method:
`scripts/stress/gen-xer.py` scales the reference CVN-73 export to
**40,586 activities** (26 clones at key-op grain; TASKPRED/TASKRSRC/UDF
cloned with referential integrity, verified). Dates are left overlapping
on purpose — tens of thousands of concurrently planned activities is the
worst case for every window computation, and staggering them would
measure a kinder world than the one claimed.

## The import door

| phase | status | time |
|---|---|---|
| dry-run (13.9 MB body, full mapping + delta) | 200 | 0.55 s |
| commit | 200 | 0.45 s |

The all-or-nothing door is not the bottleneck at 26× the demo scale.

## Read latency (sequential, 12 samples each, gzip on the wire)

| endpoint | p50 | p95 | wire payload | note |
|---|---|---|---|---|
| activities | 934 ms | 1.1 s | **1.3 MB** (23.3 MB uncompressed) | the register read |
| deck-states | 1 ms | 1 ms | 11 KB | full engine evaluation per space |
| readiness | 1 ms | 1 ms | 3 KB | |
| work-conflicts | 151 ms | 158 ms | 3 KB | PAIR_CAP bounds the scan |
| issues | 376 ms | 410 ms | 51 KB | O(register) derivation |
| schedule-alternatives | 477 ms | 484 ms | 40 KB | window search per refused row |
| work-orders / leverage / compartments / packages | 1 ms | 1 ms | ≤5 KB | |

Two facts worth stating plainly:

- **The map surface is untouched by scale.** Everything the deck plan,
  ship board, and readiness rollup read stays at 1 ms, because those are
  per-compartment computations and a hull has a bounded number of
  compartments. The product's core promise survives 40k activities.
- **The register read is the hot path** — and it is hot because of its
  size, not its algorithm: ~600 bytes/row × 40k rows. The gzip layer
  (below) took the wire from 23.3 MB to 1.3 MB and the p95 from 2.0 s to
  1.1 s (the pre-compression run's tails were allocation-noise: p50
  752 ms, p95 1,983 ms, worst 3,059 ms).

## The compression layer this run motivated

`wadl_api::hardening::compressed` — hand-rolled per the workspace's
stated posture (no tower-http), `flate2` admitted with its note in the
workspace manifest. Level-1 gzip on 2xx JSON/text bodies ≥16 KB for
clients that ask; ~18:1 on register JSON; runs inside the concurrency
permit so compression CPU is governed like any other work. Unit test
pins the contract (compresses exactly where claimed, round-trips,
identity otherwise).

## Concurrency (64 workers × 12 s on activities + deck-states)

| metric | before gzip | with gzip |
|---|---|---|
| requests completed | 98 | 133 |
| throughput | 8 rps | 11 rps |
| p50 / p95 | 11.3 s / 19.6 s | 7.9 s / 11.4 s |
| errors | 0 | 0 |
| RSS after | 1.58 GB | 1.63 GB |

The ceiling is CPU: 4 cores serializing a 23 MB register each ~1 s.
Nothing errors and nothing hangs — latency degrades honestly. Sixty-four
simultaneous full-register readers is far beyond the product's shape
(the shell fetches the register per screen, per hull, not in a loop),
but the number is recorded because a wall you have measured is a wall
you can plan around.

## Shed behaviour — and what it actually protects

With `WADL_MAX_IN_FLIGHT=2` (below core count), 32 workers × 64
requests: **3 served, 61 refused 503**, no hangs, no other statuses.
The semaphore refuses cleanly and instantly.

The subtler finding: at `WADL_MAX_IN_FLIGHT=4` on a 4-core host, zero
sheds occurred while peak concurrent handler execution was exactly 4
(measured from the audit stream). The in-memory store's handlers are
CPU-bound with no await points, so a permit-holder occupies an executor
worker start-to-finish — the runtime itself serializes arrivals at core
count, and the semaphore never observes contention. Consequences, stated
for the record:

- On the demo store, overload presents as **queueing latency**, not
  503s; the 30 s request timeout is the real backstop.
- On the PostgreSQL store the handlers await, tasks yield, and the
  semaphore is the limiter as designed.
- A production `max_in_flight` should be sized against measured handler
  latency, not guessed: 512 permits over ~1 s handlers means a 512-deep,
  ~2-minute queue is possible before the first shed. The timeout fires
  first. This is acceptable for rev 1 and recorded here so nobody
  re-derives it during an incident.

## Memory

Steady-state after import: ~650 MB (register + served document + the
run's allocator retention). After the 64-worker hammer: ~1.6 GB, which
is concurrent 23 MB response buffers plus allocator retention — it does
not grow run-over-run. Headroom items if a smaller footprint is ever
required: build the register response by direct serialization instead of
intermediate `serde_json::Value` trees (three materializations today),
and consider an ETag on the register read so unchanged registers are not
re-serialized at all. Neither is needed at rev-1 scale; both are named
so they are found by measurement, not archaeology.

## Verdict

40k activities — Vince's "a hundred key ops per job" world — passes
through the door in half a second and leaves every map-facing read at
1 ms. The register read is bandwidth-shaped and now compressed 18:1.
The overload machinery refuses cleanly where it can and degrades
honestly where the executor is the limiter, with the boundary between
those two regimes measured and written down.
