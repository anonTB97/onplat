# Council 3 — Data & Performance: CVN scale without crashing

Reviewed on `claude/kickoff-from-docs-arhiib` at `e71af65` (clean tree; the
S14 sitting-C rule-table edits are in HEAD and were built). Nothing was
implemented except what the mandate asked to be run: two generator flags
(`tools/gen_cvn73_hull.py --scale/--hazards/--out`,
`tools/gen_full_xer.py --register/--out/--months/--chain-scale`, both
byte-identical at their defaults — verified with `git status` after a
regeneration), a load harness (`tools/load_test.mjs`, `scripts/load-test.sh`),
and the measurements below. Earlier council documents:
`1-chief-systems-architect.md`, `2-ato-rmf-compliance.md` (tensions in §4).

**The dataset.** `--scale 7 --hazards 400` and `--months 30 --chain-scale 1.3`
produce **3,332 compartments** on 12 decks, **45,201 activities** (14
milestones, 945 negative lags), **36,403 relationships**, **4,221 authored
couplings + 26,419 derived deck penetrations = 30,640 graph edges**, **400 live
hazards**, a **30-month availability** (2026-07-27 → 2029-01-23), 14.2 MB of
XER. It lives under the scratchpad, never in the tree; `scripts/load-test.sh`
regenerates it from the seeds. Reference hull for comparison: 476 spaces,
5,706 activities, 220 couplings, 27 hazards.

**The box.** 4 vCPU / 15 GB, release build (`CARGO_INCREMENTAL=0`), memory
store on 8080 and a `--features postgres` build (`target/pg-council/`, not
committed) on 8081 against PostgreSQL 16 on 55433. Another agent's server was
running on the box for part of the memory-store run; the numbers are what
the harness saw, quoted as measured.

## 1. Current state

### 1.1 Solid — the shape survives scale, the arithmetic does not

- **Boot and the doors are linear and fast.** Boot to `/health` with the
  full dataset through the doors' own paths: **1.02–1.10 s**, RSS **154 MB**
  (memory store). `wadl load-docs` of all seven documents plus the 14.2 MB
  XER into PostgreSQL: **8.2 s wall, 1.9 s user**; `bootstrap-hull` 0.8 s.
  The XER parser's `MAX_CELLS` (20 M, `wadl-ingest/src/xer.rs:57`) sits 10×
  above this file's ~1.9 M cells. The door remains all-or-nothing and its
  dry run reports the same delta the commit ledgers.
- **The engine is correct and cheap per question.** `evaluate` is pure
  (`wadl-engine/src/evaluate.rs:296-370`); the graph has an out-edge index
  built once (`coupling.rs:120-145`, `OnceLock<HashMap>`), so a single BFS is
  bounded by hops, not by `E`. One compartment's decision at 3,332 spaces
  and 400 hazards: **23 ms p50 at 1 client, 77 ms at 10** (§1.4). The
  single-space read is the product's promise and it holds.
- **The cheap reads are cheap**: `compartments` 23 ms, `hazards` 2 ms,
  `ledger` 1 ms (at 9 rows), `schedule-runs` <1 ms at 1 client; all serve
  10 concurrent clients under 140 ms p95.
- **Compression is doing its job**: the 45k-row register is 6.0 MB on the
  wire (`hardening.rs:176-223`) — the bandwidth half of the register read
  was solved in the last stress round and stays solved.
- **The shell already bounds its heaviest lists**: Sequence Board renders
  400 rows before asking (`SequenceBoard.tsx:201, 887`), Issues 50
  (`IssuesBoard.tsx:153`), Week Ahead pages (`WeekAhead.tsx:90`), zone lanes
  fold above 28 levels (`ZoneLanes.tsx:49`) and switch to inversions-only
  logic above 800 edges (`:147`), Daily Ops columns fold at 25
  (`DailyOps.tsx:59`); every fetch carries a stale guard; a failed verdict
  read renders "unavailable", never an empty board (`App.tsx:140, 278-285`).
- **PostgreSQL writes are one transaction per run** (`pg_repo.rs:1178-1229`,
  advisory lock per hull) and RLS stays engaged under load: every read in
  §1.5 ran as `wadl_app` through `with_tenant` (`pg.rs:107-117`).

### 1.2 Missing — the O(everything) reads, the unbounded lists, the update channel

1. **Every map read re-runs the whole engine for every compartment.**
   `deck_states` calls `inputs.decide` per compartment
   (`handlers.rs:735-741`); each `evaluate` loops **every hazard × every rule
   bound to its kind × a BFS from the hazard's origin** and keeps only hits
   equal to the subject (`evaluate.rs:299-356`). That is C × H × R cascades
   per request — ~3,332 × 400 × ~3 ≈ 4 M BFS walks — and it is time-invariant
   work redone per request and per subject. `readiness` (`:830-843`),
   `zone_adjacent` (`:2025-2048`), `mitigations`, `leverage`, `issues`, the
   register and the door all pay it again. Measured: **`deck-states` 14.1 s,
   `readiness` 11.0 s at one client** (§1.4). The reference-hull "1 ms map
   surface" in `docs/stress-test.md:36-39` scaled only the activities; it
   does not survive 7× the spaces and 15× the hazards.
2. **Booked work is O(compartments × activities).** `booked_work` filters
   every order for every compartment (`handlers.rs:666-669`), and the orders
   are the whole schedule once one is ingested (`booked_orders`, `:630-651`):
   3,332 × 45,201 ≈ 150 M comparisons per deck-states/readiness/issues read,
   plus the `MitigationInputs::loads` pass per instant a mitigation waits to
   (`:904-933`; the cache is per request, `:895`).
3. **The register read evaluates the engine 45,201 times.** `list_activities`
   computes `executability` per row (`handlers.rs:282`; `wadl-issues/src/lib.rs:139-155`
   — one `evaluate` per instant in the window), then `reconcile`,
   `mapping_report` (`:1691-1734`, one JSON object per unlocated/derived
   row) and three JSON materialisations. Measured **48.2 s at one client**,
   `dur_ms: 48214` on the audit line. The same 45k evaluations are repeated
   by `schedule_alternatives` (`:343-378`, plus up to 32 more per refused
   row in `earliest_viable_window`, `lib.rs:244-274`): **74.9 s**; by
   `derived_issues` (`:1219-1251`): **139.8 s**; twice by `refused_by_code`
   at the door and the diff (`schedule_door.rs:118-127, 211-234` — current
   and incoming registers, ~90k evaluations): §1.4 door row; and
   `work_conflicts` scans all 30,640 edges per (hot, flammable) pair
   (`handlers.rs:3980-3986`): **119.9 s**.
4. **The 30 s timeout, the shed, and the drain do not apply to this work.**
   `guarded` wraps the handler in `tokio::time::timeout` (`hardening.rs:143`),
   but the memory store's futures never yield (its `async fn`s complete
   synchronously; `evaluate` is pure CPU), so the timer is never polled:
   every row above is a **200 after 48–140 s**, not a 503 at 30 s. The
   semaphore never observes contention below core count
   (`docs/stress-test.md:79-86` already records this), a disconnected client
   does not stop the handler, and graceful shutdown waits for it: observed —
   SIGTERM did not stop a process mid-handler within a second; SIGKILL did
   (`serve.rs:378-380`). Under systemd that is `TimeoutStopSec`; under
   Kubernetes it is `terminationGracePeriodSeconds` and an OOM.
5. **Unbounded ledger.** `list_audit` returns every row for the hull
   (`memory.rs:2936-2967`; `pg_repo.rs:1973-1994`, no `LIMIT`), the `ledger`
   route re-hashes the whole chain per read (`handlers.rs:1355-1359`), and
   `issues` (`:1283`), `proposal_rows` (`:3526`), the door and the diff read
   the whole ledger too. `LedgerBoard.tsx:208` renders every entry. At 9
   rows it is 1 ms; a yard raising and clearing permits through the doors
   writes hundreds of rows a day, so a year is a 10^5-row, tens-of-MB
   read with an O(N) SHA-256 verification on every open of the Decisions
   Ledger, and on every Issues board read.
6. **PostgreSQL re-materialises the schedule on every trait call.** The
   served schedule is one jsonb: **24.9 MB as text, 4.5 MB TOAST-compressed**
   (§1.5). `list_activities`, `list_schedule_edges`, `schedule_source` and
   `served_schedule_run` each fetch it (`pg_repo.rs:947-998, 1332-1346`);
   the register handler calls all four, `deck_states` two, `issues` four —
   each fetch is a TOAST decompression + serde parse of 45k rows. Every
   trait method first runs `pg_get_vessel` → the full vessel/class/
   availability lateral query (`pg_repo.rs:91-127, 171-181`) in its own
   transaction, then opens a second transaction with two `SET` statements
   (`pg.rs:107-117`): a deck-states read is ~10 trait calls ≈ 20
   transactions and 40 round trips before any computation. This is the
   N+1 in this codebase — per trait call, not per row — and there is no
   per-hull cache (council 1 A15 names it; §4.1 here).
7. **Nothing tells a screen that the hull changed.** The shell refetches on
   `dataEpoch` (`App.tsx:172, 289, 323`), bumped only by this browser's own
   writes (`App.tsx:617, 757`; `DeckExplorer.tsx:532-535`). Another team's
   hazard clear, an import, a decision: invisible until the reader scrubs
   or reloads. There is no `/epoch`, no ETag (grep over `crates/wadl-api`
   and `shell-web/src/api.ts`: none; `Cache-Control` is set only on the
   shell index, `hardening.rs:335`), no SSE, no `visibilitychange`
   handling, no client-side fetch timeout — a hung server is a spinner
   forever. The playback tick fires every 800 ms (`TimeControl.tsx:312`)
   and every tick refetches deck-states + issues (`App.tsx:261-289`) and, on
   the Deck Explorer, deck-states + readiness + activities + hazards +
   manning + geometry + work-conflicts (+ zone adjacency)
   (`DeckExplorer.tsx:357-466`); the stale guards discard the answers, the
   server still computes each of them for 14–120 s (item 4).
8. **The shell loads the whole register into memory on five screens**
   (`listActivities` in `DeckExplorer.tsx:378`, `SequenceBoard.tsx:208`,
   `DailyOps.tsx:110`, `Reports.tsx:115`, `WeekAhead`, `JobCard`,
   `SourcesBoard`, `WorkOrders`), each its own `GET /activities` (45,201 rows
   + 36,403 edges + the mapping lists), parsed and held in component state;
   module switches remount and refetch. Renders that walk all of it:
   `SequenceBoard.tsx:295-380` (six full `filter` passes per render plus the
   sort in `rows`), `ZoneLanes.tsx:170-249` (one `dated.filter` per lane →
   lanes × A, and a `Bar` object per dated activity before any culling),
   `ShipView.tsx:151-215` (every work activity placed and level-stacked per
   render), `windowLoadBySpace` over all activities per window change
   (`DeckExplorer.tsx:481-491`). What is rendered is bounded (§1.1); what is
   fetched, parsed, filtered and laid out is not. Server-side filtering by
   zone/trade/window and paging do not exist on any list route
   (`routes.rs:37-225`: no route takes `limit`, `cursor`, `zone` or `from`).
9. **Smaller unbounded or quadratic spots**: `zone_adjacent` is O(C_out ×
   C_in) frame compares plus a linear `compartments.iter().find` per graph
   edge (`handlers.rs:1944-1992`; 30,640 × 3,332 string compares) — **1.05 s
   at one client, 2.1 s p50 at 10**; `ingested()` deep-clones the whole
   schedule of record per call (`memory.rs:2060-2066`; RSS 154 → 425 MB
   after one register read); `hazard`'s partial index (`0011:47`, `WHERE
   cleared_at IS NULL`) cannot serve `bearing_on`'s `OR cleared_at + tail >
   $2` predicate (`pg_repo.rs:649-655`); `audit_entry` has no `(vessel_id,
   action)` index for the action-filtered reads `issues` and
   `proposal_rows` do in memory today; the run document is stored twice per
   import (`ingest_run.doc` and `ingested_document.doc`, 4.5 MB each).

### 1.3 Disqualifying for carrier-scale concurrent use (not for the ATO as such)

- **Items 1–4 together**: at this scale the map surface is 11–14 s per
  reader on an idle 4-core box and **27 s p50 / 41 s p95 with 10 readers**
  (§1.4); the register, issues, alternatives and conflicts are 48–140 s
  each, `leverage` did not finish in 600 s, the door's dry run is 114 s and
  the run diff 100 s; **a hazard clear — a 1 ms write — took 41.5 s** because
  it queued behind ten readers on four worker threads; four teams' screens
  on playback stack un-cancellable minutes of CPU per tick; nothing sheds,
  nothing times out (12 audit lines over 30 s in this run, every one a
  200, the longest 139,793 ms, zero 503s), and a rolling restart waits.
  This is a stalled product, not a slow one. It is not architectural — the
  engine's per-question shape is right and the fix is one index built once
  per read (§3, C1) — but it must land before any multi-team pilot on a real
  hull, and the memory-store numbers in `docs/stress-test.md` must stop
  standing in for it.
- **Item 6 on the only store that scales out**: PostgreSQL adds «PGX»
  (§1.5) on top of the same computation. Council 1 §1.3.4 measured 2.9 rps
  at the reference hull; at this hull the read path is «PGDS» per
  deck-states.

Nothing here needs a rewrite. The engine stays pure and per-question; the
store trait stays; the shell keeps "server computes, shell renders". What
changes is that the server computes each time-invariant thing once per
(hull, epoch) and each time-varying thing once per (hull, epoch, instant),
serves lists in pages the screens can draw, and tells the screens when to
ask again.

### 1.4 Measurements — memory store, release build, CVN-scale hull

| what | value |
|---|---|
| Boot to `/health` 200 (7 documents + 14.2 MB XER through the doors) | 1.02 s, 1.07 s, 1.10 s (three boots); RSS 154–158 MB, 5 threads |
| XER parse at boot (45,201 activities, 0 quarantined, 20 wall-clock findings) | inside the 1.0 s boot |
| RSS after one `activities` read / after `issues` / after the door / peak (VmHWM) | 425 MB / 338 MB / 558 MB / 611 MB |
| Audit lines in the run with `dur_ms` > 30,000 | 12, all `status: 200`, longest 139,793 ms; 503s: 0 |
| Register response | 45,201 rows + 36,403 edges + mapping lists (3,510 derived, 3,188 unlocated); 30.7 MB raw, 6.0 MB gzip |
| `issues` / `schedule-alternatives` / `work-conflicts` responses | 12,738 rows, 5.6 MB raw / 10,442 rows, 7.3 MB raw / 200 pairs kept, 2,738 dropped at `PAIR_CAP`, 2,641 activities scanned |

Per endpoint (`tools/load_test.mjs`, gzip on the wire, `as_of` = now):

| endpoint | clients | p50 | p95 | max | rps | wire / raw | non-200 |
|---|---|---|---|---|---|---|---|
| compartments | 1 | 23 ms | 34 ms | 34 ms | 40.7 | 70 KB / 723 KB | 0 |
| compartments | 10 | 72 ms | 112 ms | 112 ms | 85.6 | | 0 |
| compartments/4-116-0-E/state | 1 | 23 ms | 31 ms | 31 ms | 40.5 | 1 KB | 0 |
| compartments/4-116-0-E/state | 10 | 77 ms | 136 ms | 136 ms | 72.9 | | 0 |
| zones/Z4/adjacent (705 spaces inside) | 1 | 1,049 ms | 1,107 ms | 1,107 ms | 0.9 | 12 KB / 110 KB | 0 |
| zones/Z4/adjacent | 10 | 2,126 ms | 4,175 ms | 4,175 ms | 2.4 | | 0 |
| hazards | 1 | 2 ms | 2 ms | 2 ms | 588 | 8 KB / 59 KB | 0 |
| hazards | 10 | 4 ms | 6 ms | 6 ms | 1,645 | | 0 |
| ledger (9 rows) | 1 | 1 ms | 1 ms | 1 ms | 1,772 | 5 KB | 0 |
| ledger | 10 | 2 ms | 2 ms | 2 ms | 4,271 | | 0 |
| schedule-runs | 1 / 10 | <1 ms / 2 ms | 1 / 2 ms | | 2,144 / 4,610 | 1 KB | 0 |
| deck-states (3,332 rows) | 1 | 12.3 s (14.1 s first call) | 12.7 s | 12.7 s | 0.1 | 134 KB / 1.5 MB | 0 |
| deck-states | 4 | 26.1 s | 26.4 s | 26.4 s | 0.15 | | 0 |
| deck-states | 10 | 27.0 s | 41.3 s | 41.3 s | 0.2 | | 0 |
| readiness | 1 | 10.5 s | 11.0 s | 11.0 s | 0.1 | 3 KB / 19 KB | 0 |
| readiness | 10 | 23.7 s | 46.5 s | 46.5 s | 0.2 | | 0 |
| activities | 1 | 48.2 s (one sample; `dur_ms` 48,214, status 200) | | | | 6.0 MB / 30.7 MB | 0 |
| work-conflicts | 1 | 119.9 s (one sample, status 200) | | | | 11 KB / 97 KB | 0 |
| schedule-alternatives | 1 | 74.9 s (one sample, status 200) | | | | 0.9 MB / 7.3 MB | 0 |
| issues | 1 | 139.8 s (one sample, status 200) | | | | 0.8 MB / 5.6 MB | 0 |
| leverage | 1 | > 600 s — abandoned; the handler kept its core until the process was killed | | | | | |

Four clients on four cores serve deck-states at 26 s, not 12: 0.15 rps for
4 × 12 s of work is ~1.8 cores effective. The rest is the allocator — each
read deep-clones the 45k-row schedule (§1.2 item 9) on every worker.

The single samples for the five register-shaped routes are single because
each is minutes of one core and cannot be cancelled: sampling them at 10
clients would have been 10 × that on 4 cores, and the box was shared.

| door and writes (memory store) | value |
|---|---|
| `POST schedule-of-record?dry_run=true`, 16.2 MB body, 45,201 activities | 200 in 113.9 s |
| `POST schedule-of-record` (commit → run #2, ledgered) | 200 in 103.6 s |
| `GET schedule-runs/diff?run=#2&against=#1` | 1 client 99.7 s p50; 4 clients 208.0 s p50 / 217.4 s p95 |
| `POST hazards/clear` with 10 deck-states readers in flight | **200 in 41.5 s**; the 30 reads around it p50 41.5 s, p95 45.3 s, 0 non-200 |
| SIGTERM with a register read in flight | did not exit within 1 s (drain waits for the handler); SIGKILL did |

### 1.5 Measurements — PostgreSQL store (`--features postgres`, scratch tenant `CVN-73L`)

| what | value |
|---|---|
| `wadl bootstrap-hull` / `wadl load-docs` (7 documents + XER) | 0.78 s / 8.19 s wall (1.87 s user) |
| `ingested_document` sizes (TOAST / text) | schedule_of_record 4,514 KB / 24,919 KB; coupling_register 196 KB / 3,432 KB; compartment_register 60 / 517 KB; geometry 29 / 222 KB; `ingest_run.doc` another 4,514 KB |
| database after load | 74 MB (from 65) ; 400 hazard rows; 9 ledger rows on the hull |
«PG»

## 2. Prioritised actions

Effort in agent-hours including tests. Class: **crash/perf** (falls over or
stalls under real load), **ATO**, **UX**. Targets are what the change
should measure to on this dataset, on this box, after it lands.

| id | action | class | effort | depends on |
|---|---|---|---|---|
| D1 | Reach index in the engine: `EvaluationIndex::build(graph, rules, hazards)` runs each (hazard, rule) cascade once and stores hits by subject; `evaluate` becomes a lookup + time filter. Target: deck-states 14 s → <0.5 s; register 48 s → <5 s | crash/perf | 8 | — |
| D2 | Booked-work index: group orders and package spaces by compartment once per read (`BTreeMap<CompartmentNo, Vec<_>>`), O(A + C). Target: readiness 11 s → <0.3 s with D1 | crash/perf | 2 | — |
| D3 | Engine work off the async runtime: `spawn_blocking` (or a bounded compute pool, `WADL_COMPUTE_THREADS`, queue = `max_in_flight`) so the 30 s timeout fires, the semaphore sees contention, a closed connection cancels at the next await, SIGTERM drains within `WADL_REQUEST_TIMEOUT_SECS`. Target: a 60 s handler answers 503 at 30 s; SIGTERM exits within 31 s | crash/perf | 6 | — |
| D4 | Hull epoch: `GET /api/vessels/:id/epoch` → `{ledger_seq, documents, hazards, as_of_now}`; every scoped GET carries `ETag: "<epoch>:<as_of>"`, answers 304 on `If-None-Match`. Memory: atomics bumped on every write; PG: one `hull_epoch` row updated in the same transaction as the write (with council 1 A3) | crash/perf | 8 | — |
| D5 | Per-hull computed cache keyed `(vessel, epoch, as_of-bucket)` for `EngineInputs`+index, the booked-work index and the register JSON; single-flight so ten identical in-flight reads share one computation. Target: deck-states at 10 clients p95 < 0.5 s | crash/perf | 8 | D1, D4 |
| D6 | PG document cache (council 1 A15) keyed by the epoch; drop the duplicate `pg_get_vessel` query where the following query fails closed under RLS. Target: PG deck-states within 2× memory | crash/perf | 8 | D4 |
| D7 | Ledger paging and incremental verification: `?limit=&before=`; `list_audit_by_action(vessel, &[actions])`; verify only the tail past a remembered `(seq, hash)` per hull; index `audit_entry (vessel_id, action, entry_id DESC)`. Target: ledger read O(page) | crash/perf | 6 | — |
| D8 | Register paging and server filters: `/activities?zone=&trade=&status=&from=&to=&q=&limit=&cursor=`; `edges` and `mapping` move to `/schedule-edges` and `/mapping-report`; the register carries `total` and the per-row verdict only. Shell screens ask for the window they draw | crash/perf | 12 | D1 |
| D9 | Shell update channel: poll `/epoch` every 15 s while visible, 60 s hidden (`visibilitychange`), bump `dataEpoch` on change; SSE later (§1.6) | UX | 6 | D4 |
| D10 | Shell degradation: 45 s `AbortController` on every fetch, abort on scrub; last-good data stays visible with a "stale since HH:MM" chip and the 503 sentence; playback skips a notch while a fetch is in flight | UX | 6 | — |
| D11 | Shell virtualisation: Sequence Board table windowed by scroll (hand-rolled, ~80 lines); zone lanes cull bars to the camera window before building `Bar`s; ship-view chips cull to visible decks/frames; ledger paged | UX | 10 | D8 |
| D12 | Small fixes: `zone_adjacent` placard `HashMap` (1.0 s → ~50 ms); `work_conflicts` uses `out_edges` instead of scanning `edges()`; `Arc<ScheduleOfRecord>` instead of clone in `ingested()`; `hazard (vessel_id, cleared_at)` index and a sargable predicate; `EXAMPLES`-bounded lists in `mapping_report` with counts | crash/perf | 4 | — |
| D13 | Import concurrency (council 1 A7) plus the dry run counted against the compute pool, not the import semaphore; `WADL_MAX_IMPORTS_IN_FLIGHT=1` on a 4-core box | crash/perf | 2 | D3 |
| D14 | `docs/stress-test.md` and `scripts/stress-test.sh` retired in favour of `scripts/load-test.sh`; CI runs the harness on a `--scale 2` hull as a regression gate on p95 | UX | 3 | D1–D5 |

Order: D1, D2, D12 (one sitting; they remove the O(C×H×R) and O(C×A)
terms and are pure), then D3 (the timeout becomes true), D4 + D5 + D6
(the cache is only correct once there is an epoch), D7, D8 + D11, D9 + D10,
D13, D14. Until D1 lands, size any pilot at one hull per process, one
reader per core, and keep playback off on carrier-sized hulls.

## 3. Concrete changes

| file | change | why |
|---|---|---|
| `crates/wadl-engine/src/evaluate.rs` (+ `index.rs`) | `pub struct EvaluationIndex { by_subject: HashMap<CompartmentNo, Vec<Hit>> }` where `Hit { hazard: usize, entry: usize, depth, path, via }`; `build(graph, rules, hazards)` runs `cascade_from` once per (hazard, coupled entry) and pushes hits under each reached compartment, plus a same-space hit per (hazard, same-space entry); `evaluate_indexed(index, subject, at)` applies exactly the `raised_by`/`ended_by`/`push_live` filters of `evaluate` to the subject's hits. Property test: `evaluate_indexed == evaluate` for random worlds/instants. `evaluate` stays as the reference implementation. | Time-invariant cascades are recomputed C × H × R times per read; the index is O(H × R × BFS + Σhits) once. Pure, wasm-safe, no I/O. |
| `crates/wadl-api/src/rule_table.rs` (`EngineInputs`) | Build the index in `engine_inputs` (`OnceLock` per `EngineInputs`; `RuleScopes` narrows by filtering hits on `entry` ids, so one index serves every work-type set); `decide` and `hull_under` use it. `wadl_issues::Hull` gains `index: Option<&EvaluationIndex>` and `executability` uses it when present. | One index per read serves deck-states, readiness, register, issues, alternatives, adjacency, the door. |
| `crates/wadl-api/src/handlers.rs` (`booked_work`, `MitigationInputs`) | `BookedIndex { by_space: HashMap<CompartmentNo, Vec<&WorkOrderSummary>>, packages_by_space }` built once in `deck_states`, `readiness`, `mitigation_inputs`; `booked_work` takes the index. `loads(at)` walks the index. | O(C × A) → O(A + C). |
| `crates/wadl-api/src/hardening.rs` (`guarded`) | Run `next.run(req)` unchanged but require handlers that compute to call `compute(|| …)` = `tokio::task::spawn_blocking` on a pool sized `WADL_COMPUTE_THREADS` (default cores − 1) with a `Semaphore(max_in_flight)` queue; add `tokio::select!` on the request body's connection close (axum `Request` extensions carry a `CancellationToken` set from `hyper`'s connection drop) so an abandoned request is not started. Test: a handler that sleeps 60 s blocking answers 503 at the timeout. | The timeout, the shed and the drain are only real when the future yields. |
| `crates/wadl-api/src/handlers.rs` (`epoch`), `routes.rs`, `lib.rs` | `GET /api/vessels/:id/epoch` → `{"ledger_seq", "documents_changed_at", "hazards_changed_at", "epoch": "<seq>-<ms>", "now"}`; scoped, in `routes::inventory`, leak test generated, SSP regenerated. Every scoped GET sets `ETag` from the epoch + `as_of` and honours `If-None-Match` → 304 in a small middleware after the audit layer. | The version key every cache, poll and 304 keys on; the ledger seq is already a total order of every fact change on the hull. |
| `crates/wadl-store/src/repo.rs`, `memory.rs`, `pg_repo.rs`, `migrations/0020_hull_epoch.sql` | Trait `hull_epoch(scope, vessel) -> HullEpoch`; memory: `AtomicU64`s bumped in every `set_*`/`clear_*`/`raise_hazard`/`clear_hazard`/`append_audit`; PG: `hull_epoch (vessel_id PK, ledger_seq bigint, documents_at timestamptz, hazards_at timestamptz)` updated inside the same transaction as each write (`append_audit_in`, `upsert_document`, hazard writes), RLS like every table. | Correct across replicas because the version lives in the database row, not in a process. |
| `crates/wadl-api/src/cache.rs` (new) | `HullCache { entries: RwLock<HashMap<(VesselId, epoch, as_of_ms/60000), Arc<Computed>>>, in_flight: Mutex<HashMap<key, Arc<Notify>>> }` with `Computed { inputs+index, booked index, register_json: Bytes }`; bounded (LRU of 8 instants per hull, `WADL_CACHE_INSTANTS`); single-flight: the second identical request awaits the first's `Notify`. Invalidation is by key: a new epoch is a new key. | Ten users scrubbing to the same watch cost one computation; playback costs one per notch, not one per screen per notch. |
| `crates/wadl-store/src/pg_repo.rs` | Council 1 A15's document cache keyed by the epoch (validated by one `SELECT` of `hull_epoch`), `Arc<ScheduleOfRecord>` returned; `pg_get_vessel` dropped where the next query fails closed under RLS (document reads, hazard reads, ledger reads). `bearing_on` predicate → `cleared_at IS NULL OR cleared_at > $2 - make_interval(mins => $3)`; migration adds `CREATE INDEX ON hazard (vessel_id, cleared_at)` and `CREATE INDEX ON audit_entry (vessel_id, action, entry_id DESC)`. | 4.5 MB TOAST + 25 MB parse per trait call becomes one per epoch; two transactions per read become one. |
| `crates/wadl-store/src/repo.rs` (`list_audit`), `handlers.rs` (`ledger`, `issues`, `proposal_rows`) | `list_audit(scope, vessel, AuditQuery { subject_ref, actions: &[&str], before_seq, limit })`; `ledger` serves `{entries, next_before, verified_through: {seq, hash}}` and verifies only rows past the hull's remembered head (`RwLock<HashMap<VesselId, (i64, [u8;32])>>`, re-verified from zero on a mismatch or on boot); `issues`/`proposal_rows` ask for their actions only. `LedgerBoard.tsx` pages with "older". | O(N) per open becomes O(page); the chain claim is unchanged — the head is re-checked every time and the tail is hashed. |
| `crates/wadl-api/src/handlers.rs` (`list_activities`), `routes.rs`, `shell-web/src/api.ts` | Query `ActivityQuery { zone, trade, status, from, to, q, compartment, limit (≤ 2000, default 500), cursor }` applied after the verdicts are read from the cache (server-side filter, never a truth change); response `{as_of, total, page, activities, cursor}`; `edges` → `GET /schedule-edges?codes=` (or whole, gzip, for the lanes), `mapping` → `GET /mapping-report` (counts + `EXAMPLES`-bounded lists). `listActivities(id, v, asOf, query)` in `api.ts`. | The register is bandwidth- and memory-shaped in the browser; the screens draw a window, so they should ask for one. |
| `shell-web/src/App.tsx`, `api.ts` | `useHullEpoch(identity, vesselId)`: `setInterval` 15 s (60 s when `document.hidden`), `GET /epoch`, `setDataEpoch` only on change; every fetch through one `apiFetch` with `AbortController` (45 s) and `If-None-Match` from a small `Map<url, {etag, body}>`; a 503/timeout keeps the last body and sets `stale: {since, reason}` rendered by `StatusStrip` as "showing the hull as of HH:MM — the server is busy". Playback: `TimeControl.tsx:309-324` skips the tick when `inFlight > 0`. | Other teams' writes reach every screen within 15 s; a hung request never hangs a tab; playback cannot stack minutes of server work. |
| `shell-web/src/SequenceBoard.tsx`, `ZoneLanes.tsx`, `ShipView.tsx`, `DeckExplorer.tsx` | Table: render rows `[scrollTop/rowH − 20, + viewportRows + 20]` inside a fixed-height scroller (hand-rolled, no dependency); lanes: `dated.filter(a => a.planned.end > win.v0 && a.planned.start < win.v1)` before `laneOf`, one pass grouping into a `Map` instead of a filter per lane; ship view: place only decks/frames inside the camera; Deck Explorer: `listActivities` with `from/to` = the reading window and `zone` = the focus, and `windowLoadBySpace` over that page. | What is fetched and laid out becomes proportional to what is on screen. |
| `crates/wadl-api/src/handlers.rs` (`zone_adjacent`, `work_conflicts`, `mapping_report`) | `by_no: HashMap<&str, &CompartmentSummary>`; `inside` bucketed by deck; `coupled(x, y)` via `graph.out_edges(x)`; `located_derived`/`unlocated`/`unknown_spaces` lists capped at 200 with counts. | Quadratic-in-C and E × C scans on the hot path. |
| `crates/wadl-store/src/memory.rs` | `schedule_of_record: RwLock<BTreeMap<VesselId, Arc<ScheduleOfRecord>>>`; `ingested()` returns the `Arc`; `list_activities` returns `Arc<[ActivitySummary]>` (trait change) or sorts once at load. | A 45k-row deep clone per call is the 154 → 425 MB step. |
| `scripts/load-test.sh`, `.github/workflows/ci.yml` | The harness at `--scale 2` in CI with thresholds: deck-states p95 < 1 s, register p95 < 3 s, no non-200; fails the build on regression. | A wall you measured is a wall you can plan around; a wall CI measures stays measured. |

### 1.6 The update channel, justified

Build on what exists: the ledger `seq` on the server (a total order of
every fact change on a hull — hazards raised and cleared, documents
replaced, decisions, acknowledgements, proposals) and `dataEpoch` in the
shell (already the thing every shared read is keyed on). The strategy is
**change-driven refetch keyed on the hull epoch**, delivered first by
polling and later, optionally, by SSE:

- *Polling `/epoch`* every 15 s per visible tab: 4 teams × ~25 screens ×
  1/15 s ≈ 7 requests/s of a ~150-byte, index-only read; at council 2's AU-2
  grain that is also 7 audit lines/s of noise (§4.3). Correct across
  replicas because the epoch is the database's. The `dataEpoch` bump then
  drives the existing effects, so no screen changes its data flow.
- *SSE* (`GET /api/vessels/:id/events`, axum's own `Sse` — no new crate):
  one `tokio::sync::watch<HullEpoch>` per hull, each connection forwards
  changes coalesced (backpressure is inherent: `watch` keeps only the latest
  value, a slow client sees the newest epoch, never a queue); the terminator
  passes it as plain HTTP with the six headers; CSP `connect-src 'self'`
  already allows it. Preferred once the identity proxy contract confirms
  long-lived responses (question §5.4). The shell falls back to polling when
  the stream errors.
- *Not websockets*: nothing here is bidirectional, the proxy contract is
  header-per-request (`docs/identity-proxy-contract.md`), and an upgrade is
  one more thing the terminator and the STIG must speak.
- *Never push data*: the event is "ask again", the answer is the same
  audited GET — server computes, shell renders, and the audit line for the
  read still exists.

Degradation, stated as behaviour: a read that fails or exceeds 45 s leaves
the last good board on screen with a visible "as of HH:MM, server busy"
chip and the 503 sentence; a screen never blanks to "nothing held"
(`App.tsx:278-285` already refuses that); playback pauses itself while a
request is in flight; the register is fetched as pages, so a partial
register is a labelled page, not a truncated whole; the server sheds at the
compute pool's queue with a 503 and a sentence rather than admitting work
it cannot finish inside the timeout.

## 4. Tensions with earlier personas and proposed resolutions

1. **Council 1 A15 (PG document cache validated by `ingested_at`).** Agreed
   in substance; keyed on the hull epoch instead (D4), because hazards are
   rows, not documents (`hazard` table), and a document-only key would serve
   a stale hazard set after a clear. One `SELECT` on `hull_epoch` validates
   everything. A15 becomes D6.
2. **Council 1 A6 (`statement_timeout` = request timeout) and A7 (import
   semaphore, dry run never gated).** Both agreed. Added: the app-side
   timeout is not real until D3, on either store — a PG read that spends
   its time in serde and the engine never yields either. And at this scale
   the dry run is the expensive half of the door (two full `refused_by_code`
   passes), so it must count against the compute pool (D13) even if not
   against the import semaphore — council 1 §4.5's UX point stands because
   the pool sheds with the same sentence.
3. **Council 2 R3/R4/R12 (audit line per request, `rows` per list read).**
   Agreed; two consequences. A 15 s epoch poll from every screen is ~7
   `/api` audit lines per second of no accountability value; propose
   `/api/vessels/:id/epoch` is excluded from 2xx logging like `/health`
   (`hardening.rs:104`), or SSE is used so one line marks the stream's open
   and close. And with paging, `rows` on the line is the page, and the
   query (`limit`, `cursor`, filters) must then be recorded — council 2's
   own R12 already moves `as_of` onto the line for the same reason.
4. **Council 2 R10b (NNPI segments, server-side redaction).** Compatible
   with D5 only if the cache key includes the clearance set (or the
   redaction runs after the cache, on the served copy). Proposed: cache the
   computed world unredacted per hull, redact per response — the cache
   never leaves the process and the audit line records the disclosure.
5. **Council 1 §1.3.4 ("replicas help linearly").** True only after D4–D6:
   today each replica repeats the full computation per request, and the PG
   path is «PGDS» per deck-states, so N replicas are N × slow, not N × fast.
6. **`docs/stress-test.md` (the standing claim that the map surface is
   1 ms and untouched by scale).** Contradicted by §1.4 because the earlier
   run scaled activities only. The document is updated with this run and
   the claim withdrawn; `scripts/stress-test.sh` stays until D14 replaces it.
7. **Council 1 A3 (ledgered commit in one transaction).** Agreed, and D4's
   `hull_epoch` row is written in that same transaction, so the epoch can
   never advance without its ledger row and vice versa.

## 5. Questions only the customer can answer

1. Concurrent users per hull and screens per user in the four teams, and
   which screens are unattended kiosks with playback or auto-refresh on —
   the poll budget and the compute-pool size follow from this.
2. The freshness requirement: after a fire-watch clears a permit on the
   deck plate, within how many seconds must the hot-work screen two decks
   up show it (15 s polling, or SSE)?
3. Reissue cadence and shape of the schedule of record: a weekly full 45k
   row XER (a two-minute dry run is acceptable), or daily, or deltas?
4. Does the identity terminator pass long-lived responses (SSE) with the
   six headers, or is request/response the only shape it accredits?
5. Ledger volume: permits raised and cleared per day, and whether the
   Decisions Ledger must open on the full history or on the last 30 days.
6. Whether reactor-plant (NNPI) redaction changes per person (council 2
   R10b) — decides the cache key in D5.
7. How many hulls a deployment serves at once and whether prior
   availabilities stay served (the per-hull cache budget: ~0.5 GB per
   carrier hull at this scale on the memory store, §1.4).
