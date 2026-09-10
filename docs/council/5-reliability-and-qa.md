# Council 5 — Reliability / QA lead: "does not crash" as an engineering property

Reviewed on `claude/kickoff-from-docs-arhiib` at `92cd856` (clean tree).
Nothing was implemented. What was run: the release binary (`target/release/serve`,
memory store) and the postgres-feature build council 1 left under
`target/pg-council/` against PostgreSQL 16 on 55433, the built shell
(`shell-web/dist`) under Chromium via `playwright-core`; scripts and
screenshots are in the session scratchpad (`m1`–`m7`). The PostgreSQL run
wrote ~120 `DOCUMENT_REPLACED yard_clock` rows labelled `QA-GUAM`/`QA-NY`
on tenant `…0001` hull `…0073` and left the clock as it found it
(`default_utc`, one `revert` through the door). Earlier council documents
read: 1 (platform), 2 (ATO), 3 (data/performance), 4 (UX), 7 (hull grid);
tensions in §4.

## 1. Current state

### 1.1 Solid — what already fails closed, with the evidence

- **One error type, no leakage in the response.** Every handler failure is
  `application/problem+json` through `ApiError` (`error.rs:14-56`); a backend
  failure is a 500 with no detail on the wire and one JSON line on stderr
  (`error.rs:65-76`); not-found and out-of-scope are the same 404
  (`error.rs:3-6`). Truncated import bodies never reach the parser
  (`handlers.rs:26-34`).
- **The shell's fail-closed convention exists and is applied.** A failed
  verdict pair clears the rows and sets `verdictsOk=false` (`App.tsx:278-285`),
  the strip then says *Do not read any board as clearance* (`Chrome.tsx:988`);
  `whoami` and `timeframe` failures render "unavailable", never an empty list
  (`App.tsx:192-196, 215-219, 313-318`; `Chrome.tsx:601, 718`); every fetch
  carries a stale guard (`App.tsx:233, 257, 296`). Measured: a mid-session
  401 and a login page both produced the banner and no positive count
  (§1.4 M7).
- **The facts are contention-safe on both stores.** Memory: `clear_hazard`
  holds the clearance mutex across the check and the push
  (`memory.rs:3101-3130`); PostgreSQL: `UPDATE … WHERE cleared_at IS NULL`
  (`pg_repo.rs:1838-1846`). Measured: 8 parallel clears → 1×200, 7×422, one
  `HAZARD_CLEARED` row; 8 parallel raises of one fact → 1×200, 7×422, one live
  row; chain verifies after (M2). The ledger append is serialised per hull
  (`pg_repo.rs:2049-2052` advisory lock in the same transaction as the
  insert; `memory.rs:2888-2925` under one mutex).
- **The pool survives the database being killed under load.** With four
  readers at ~100 rps, `pg_terminate_backend` on all 8 backends produced
  exactly 3×500 in that second, `/health` stayed 200, p50 unchanged at 40 ms
  before and after, three `backend_error` lines on stderr (M5). sqlx
  reconnects; nothing in the tree had to.
- **Boot refuses rather than serves wrong**: empty proxy key
  (`serve.rs:280-283`), unknown default role (`:284-297`), unreachable
  database (`:79-81`), database behind the binary (`:235-262`), dev shim off
  loopback (`:335-343`), bind failure (`:373`). Shutdown drains (`:377-380`,
  council 1 measured 0.26 s).
- **The lint wall removes the engine's own crash paths**: `panic`, `unwrap`,
  `expect`, indexing denied in non-test code (`Cargo.toml:104-106`); the
  engine is pure and builds on wasm32 (`ci.yml:111-136`). A lock poisoned by
  a panic elsewhere is recovered, not propagated (`memory.rs:2887-2891`).
- **The support bundle's redaction is one tested function**
  (`bundle.rs:63-72, 251-263, 324-350`): uuids, URLs, `org`, `person`,
  `actor_*` and the `x-wadl-person*` headers never leave the box.
- **The test base is real and runs on both stores.** Counted at head:

| layer | count | where |
|---|---|---|
| Rust unit + integration (`#[test]`/`#[tokio::test]`) | ~477 | api 247 (91 generated leak tests + 16 suites, 9,597 lines), store 55, engine 52, ingest 28, plan 25, domain 23, mitigate 22, issues 13, cli 7, xtask 5 |
| property (`proptest!`) | 4 | plan 2 (`topology.rs`), mitigate 1, engine 1 |
| golden / insta | 22 snapshots | `wadl-engine/tests/snapshots` (cascade 6, rule scenarios 16) |
| RLS proof on live PostgreSQL | 25 | `wadl-store/tests/pg_rls.rs` |
| API suites on PostgreSQL | the same 16 suites, `DATABASE_URL`-selected | `tests/support/mod.rs:79-98`; `ci.yml:234` |
| CLI against the database | 1 file | `wadl-cli/tests/database.rs` |
| shell vitest | 125 cases / 16 files | pure modules only — 0 files import `react` |
| Playwright | 0 | S17 designed (`docs/programme/s17-proof-and-cold-walkthrough.md`), `shell-web/e2e` absent |
| concurrency / fault-injection / chaos | 0 / 0 / 0 | no `tokio::spawn` or `join_all` in any test; no test `impl Repositories`; no test asserts a 500; `scripts/` has load, stress and the restore drill, nothing that kills or throttles |

### 1.2 Missing — each with what happens today

- **No React error boundary anywhere** (grep for `ErrorBoundary`/
  `componentDidCatch`/`getDerivedStateFromError`: none; `main.tsx:5-12`
  mounts `App` bare). Measured (M7 `issues-null-row`): `GET …/issues`
  answering `{"issues":[null]}` → `Chrome.tsx:790` `issue.kind` throws →
  React unmounts the tree → `#root` is **0 characters**, blank page, every
  role, no message, no recovery but a reload. Any of ~25 endpoints returning
  one row the shell does not expect does this; a bad `state` enum happened
  not to reach a throwing path (M7 `bad-record`), which is luck, not design.
- **No session-expiry behaviour.** The contract puts session lifetime on the
  proxy (`identity-proxy-contract.md:17-20`) and expects *the PIN challenge
  or 401* after idle (`:239-241`); the shell has no branch for either
  (`grep 401 shell-web/src` non-test: none). Measured (M7): a 401 mid-session
  reads *Verdicts unavailable — the engine did not answer* plus *Register
  unavailable (Error: activities → 401)*; the proxy's login page (200
  `text/html`) reads *Register unavailable (SyntaxError: Unexpected token
  '<', "<html><bod"… is not valid JSON)* (`DailyOps.tsx:208`,
  `SequenceBoard.tsx:400`). The fire watch is told the engine is down when
  their CAC session ended.
- **Audit stream failure is a panic, in both directions.** `audited` writes
  with `println!` (`hardening.rs:105`); the release profile unwinds
  (`Cargo.toml:110-113`, no `panic = "abort"`). Measured (M1): boot with
  stdout on a full disk → `exit 101`, `failed printing to stdout: No space
  left on device` with a backtrace (the banner's own `println!`,
  `serve.rs:301-370`). Council 2 §1.5 measured the mid-run shape (broken
  pipe → the connection task panics, request answered with nothing, lines
  lost silently, process keeps serving). `eprintln!` has the same contract:
  stderr on a full disk served 200s (nothing was written) and the first
  `backend_error` line (`error.rs:71`) would panic its task.
- **No request id, no correlation.** The audit line is eight fields
  (`hardening.rs:107-116`); the `backend_error` line is `{event, detail}`
  with no path, person or timestamp (`error.rs:71-74`,
  `schedule_door.rs:276`, `rule_table.rs:410, 449`); the problem body carries
  nothing joinable. A 500 in the audit stream and its cause on stderr are
  joined by wall clock only; `docs/runbook.md:299-301` says so and defers it.
  Council 1 A13 and council 2 R4 own the field; the contract (§3 Q4) is not
  written anywhere.
- **The diagnostic stream has no redaction rule and carries content.**
  `rule_table.rs:449-452` prints the document `label` and every refusal
  sentence — rule-table cell text; `serve.rs:221` prints the XER refusal
  reasons at boot, which quote raw cells (`xer.rs:670` `{raw:?}`) and project
  ids (`:1136`); `error.rs:71` prints sqlx's message verbatim (constraint and
  table names; no row values by `Display`). The audit line carries the
  person id (EDIPI/badge, council 2 §1.2) and a placard in every
  compartment path. The bundle redacts identities but keeps `path` and
  every `detail` string whole (`bundle.rs:269-320` masks only uuids and
  URLs). Under council 2 reading A, a cell of the rule table or a reason
  quoting a reactor-plant activity name on stderr is NNPI on the log
  pipeline.
- **Commit and ledger row are two transactions — measured inverting.**
  `upsert_document` runs without a per-hull lock (`pg_repo.rs:465-491`),
  the ledger row is a second transaction under the advisory lock
  (`documents.rs:487-506` → `pg_repo.rs:1948-1971`). Measured (M4,
  PostgreSQL): 20 concurrent yard-clock commits, round 5 → served document
  `QA-NY`, newest `DOCUMENT_REPLACED` row `QA-GUAM` (entries 818–820
  within 2 ms). The ledger's last word names a document that is not served.
  Memory store: 0 of 6 rounds inverted, but nothing prevents it
  (`memory.rs:2326-2331` write lock, then `append_audit` separately). The
  same two-call shape holds for hazards (`handlers.rs:1634-1665`: clear,
  then append) — a process killed between leaves a cleared hazard with no
  ledger row, which `docs/runbook.md:281-285` calls an incident.
- **Two people deciding the same thing is undefined.** `record_decision`
  (`handlers.rs:1070-1170`) and `acknowledge_issue` (`:1412-1460`) re-derive
  the option and append; neither reads what was already recorded. Two
  Safety officers accepting the same option in the same minute write two
  rows; a conflicting pair (accepted, rejected) writes both with no signal
  to either; the shell reads the newest (`handlers.rs:1303, 3532-3539`).
  Append-only is right; "which one is the decision" needs a rule (§5 Q3).
- **`whoami` serves an empty hull list when the database is down.**
  `list_vessels` swallows the backend error into `Vec::new()`
  (`pg_repo.rs:856-860`, "an empty portfolio rather than a lie");
  `whoami` uses it (`roles.rs:530`) and answers 200 `hulls: []` — the empty
  list `App.tsx:161-163` says it must never render. By code reading; the
  trait signature is infallible and needs to change.
- **A truncated import body is audited as 413.** `to_bytes` failure of any
  kind maps to `PayloadTooLarge` (`handlers.rs:32-33`). Measured (M6): a
  client declaring 400 bytes, sending 60 and closing → audit line
  `status: 413` on `/hazards/import`, `422` on `/hazards/clear`; a stalled
  body is waited on inside the 30 s guard (correct, `hardening.rs:143`).
- **The 30 s timeout does not cover the compute** (council 3 §1.2.4, D3):
  the guard's timer is never polled by a CPU-bound handler; measured there
  as 48–140 s 200s. Every failure-mode test below that says "503 at 30 s"
  is only true after D3.
- **Boot refusals are untested.** `refuse_a_database_behind` and the
  unreachable-database path (`serve.rs:79-83, 235-262`) have no test in
  `production_path.rs`, `database.rs` or CI; only the empty key
  (`auth.rs:512`) and the off-loopback shim (`ci.yml:85-97`) are pinned.
- **Nothing reads the audit stream in any test** (council 2 §1.5), no test
  asserts a 500, no test double fails the store, and the S17 smoke — whose
  step 11 is the only designed pin for "every board reads unavailable" — is
  not built. Every degradation sentence in the docs is unpinned.
- **Partial loads.** `wadl load-docs` keeps the documents before a refused
  one (`docs/execution-plan.md:55`, by design, each ledgered); the API doors
  are all-or-nothing per document (`pg_rls.rs:582`). A response body cut
  mid-transfer rejects `res.json()` in the shell — no partial list can be
  parsed — so the only partial-load risk is the server's own (above) and the
  runbook not saying a half-loaded set is served.

### 1.3 Disqualifying

1. **Audit failure = crash (AU-5).** A full disk under the log pipeline
   stops the process at boot and drops requests mid-run with nothing
   recorded. Council 2 R3 owns the writer; the tests that prove the chosen
   mode are Q3 here. ATO-blocking.
2. **One malformed row blanks the product for every role on that tab.**
   No boundary, no fallback, no message. For four teams on a carrier
   schedule against an API that will be paged, cached and re-shaped
   (council 3 D5–D8), this is a tab-level outage per bad record.
   Crash/perf-blocking; 4 hours (Q1).
3. **The served document and the ledger can disagree, measured** (§1.2).
   AU-12 and the runbook's own incident definition. Council 1 A3 is the
   fix; Q6 is the proof that must land with it.
4. **No failure-mode test exists for any of the six modes the mandate
   names** (session expiry, write conflict, outage mid-operation, partial
   load, database at boot, disk full). Each has a behaviour today — some
   correct, three wrong — and none is defined in a test. Not a rewrite:
   every seam the tests need (`support::reference_hull()`, `Repositories`,
   `apiFetch` once D10 lands, the S17 harness) already exists or is designed.

### 1.4 Measurements (4 vCPU dev box, release builds, this pass)

| id | what | value |
|---|---|---|
| M1 | boot, memory store, stdout → `/dev/full` | exit 101, `failed printing to stdout: No space left on device (os error 28)`, backtrace |
| M1b | stderr → `/dev/full`, `/api` reads | 200 (nothing written); a non-2xx or backend error is the first write that would panic |
| M2 | 8 ∥ `hazards/clear` on one live hazard, memory | 1×200, 7×422; 1 `HAZARD_CLEARED`; verified `true` |
| M2 | 8 ∥ `hazards` raise of one fact, then 4 ∥ clears | 1×200, 7×422; one live row; clears 1×200 3×422; ledger RAISED 1 / CLEARED 2 |
| M4 | 20 ∥ yard-clock commits × 6 rounds, memory | 120×200, 0 inversions (served label == newest ledger row) |
| M4 | same, PostgreSQL | 120×200, **1 inversion** (round 5: served `QA-NY`, ledger `QA-GUAM`; entries 818–820 at .145/.147/.145 s) |
| M5 | 4 readers on `deck-states` (PG), `pg_terminate_backend` × 8 at t=6.1 s | ~100 rps throughout; 3×500 at t=6 s (`terminating connection due to administrator command`); `/health` 200 at +0 s and +10 s; p50 40 ms before and after |
| M6 | POST with `Content-Length: 400`, 60 bytes, close | import door: audit `413` after 3.0 s; `/hazards/clear`: `422`; stalled body: server waits (30 s guard) |
| M7 | shell, 401 on every `/api` mid-session | *Verdicts unavailable — the engine did not answer* + *Register unavailable (Error: activities → 401)*; no positive counts |
| M7 | shell, 200 `text/html` login page on every `/api` | same banner + *Register unavailable (SyntaxError: Unexpected token '<' …)* on screen |
| M7 | shell, `deck-states` row with `state: "NOT_A_STATE"` | survived; strip rendered |
| M7 | shell, `issues: [null]` | `TypeError: Cannot read properties of null (reading 'kind')`; `#root` innerHTML **0 chars** |

## 2. Prioritised actions

Effort in agent-hours including tests and docs. Class: **ato**, **crash_perf**,
**ux_polish**.

| id | action | class | effort | depends on |
|---|---|---|---|---|
| Q1 | Error boundaries at three grains: root (`main.tsx`), per module (`App.tsx` switch), per panel (drawer, inspector, job card); fallback wears the unavailable sentence, the module name, `ref <req>`, one *Reload this board* button; the chrome, strip and rail stay mounted; a boundary logs `{module, message}` to the console once | crash_perf | 4 | — |
| Q2 | Session-expiry branch in the shell: `apiFetch` classifies 401, and any 2xx whose content-type is not JSON, as `reason: "session"` → one full-width sentence *Your session has ended — sign in again through the yard's proxy. Nothing on this screen is live*, counts cleared, a *Sign in* action (reload); 404 stays scope, 5xx/timeout/offline stay busy/unreachable; never `String(e)` on screen | crash_perf | 3 | council 3 D10 / council 4 U2 (`apiFetch`) |
| Q3 | Audit failure tests for council 2 R3: unit (writer fails on line N → counter, one stderr line, `AUDIT_DEAD`), CI boot with `> /dev/full` → exit 1 and a sentence, not 101; mid-run stdout closed after boot → `/api` 503 `audit unavailable`, `/health` 503; stderr failure never panics | ato | 3 | council 2 R3 |
| Q4 | Request-id contract as tests: `x-wadl-request` on every response incl. shed 503, 404 fallback and static; the same `req` on the audit line, the `backend_error` line (which gains `path`, `person`, `ts_ms`) and the problem body; a client-supplied id is never trusted; SA-12 | ato | 2 | council 1 A13 / council 2 R4 |
| Q5 | Log redaction rule and its canary test: diagnostics carry identifiers (kind, label hash, seq, row number, code), never content; `rule_table.rs:449`, `serve.rs:221`, `xer.rs:670` reworded; one `diag::emit` is the only stderr writer; a fixture with `CANARY-NNPI` in every user-supplied field boots, imports, fails every door and asserts the canary is on no stderr line and in no bundle | ato | 4 | Q3 (shares the emitter) |
| Q6 | PostgreSQL concurrency suite `wadl-store/tests/pg_concurrency.rs` + API twin on both stores: 20 ∥ commits of one kind → served == newest ledger row; 8 ∥ clears/raises → one row; a transaction rolled back after the upsert leaves neither document nor row; `hull_epoch` advances only with its row | crash_perf | 6 | council 1 A3 (lands red without it) |
| Q7 | Decision idempotency: same (subject, option action, disposition, as_of) → 200 with the existing record and `duplicate: true`, no new row; conflicting disposition → 409 carrying the existing record and its person; acknowledge likewise; the shell shows *already recorded by <person> at HH:MM*; 8 ∥ posts → one row on both stores | crash_perf | 5 | §5 Q3 |
| Q8 | Failing-store test double (`tests/support/failing.rs`: wraps any `Repositories`, fails call N or every call with `Backend("injected")`); pins: every scoped GET → 500 problem+json with no detail and one stderr line; `whoami` → 503 with no `hulls` key when `list_vessels` fails (`list_vessels` becomes fallible); `/health` 503 with `reachable:false` | crash_perf | 5 | — |
| Q9 | Boot failure-mode tests in `production-path`: closed port → exit 1 in < 2 s with the sentence; `_sqlx_migrations` row 19 marked `success=false` on a scratch database → refused with `run: wadl migrate`; full disk (Q3); a bind conflict → exit 1 naming the address | ato | 3 | — |
| Q10 | The S17 smoke built, plus the multi-team walk: three browser contexts (planner, supervisor, safety) — planner proposes on the Sequence Board; supervisor's Deck Explorer shows it (after the epoch bump; until D9, after a refresh); a `stop_work` raised; the conflict appears on Conflicts & Risk; safety clears with a basis; deck-states re-derive out of BLOCK; the ledger verifies with the five actions and three persons; plus the four degraded steps (503, hang, 401, login page) and the boundary step (`issues:[null]` → fallback, chrome intact). Memory on every push, PostgreSQL in `production-path` | crash_perf | 10 | S17 lib/words, Q1, Q2; council 3 D9 for "sees it update" without a refresh |
| Q11 | Chaos scripts under `scripts/chaos/`: `kill-db.sh` (terminate every backend under `tools/load_test.mjs`; asserts ≤ pool-size 500s, `/health` never 5xx after, recovery < 2 s), `slow-db.sh` (a ~80-line `tools/slowproxy.py` between serve and PostgreSQL adding latency/stalls; asserts the acquire and statement timeouts answer 503 within `WADL_REQUEST_TIMEOUT_SECS`+1), `stall-body.sh` (M6 as assertions), `audit-pipe.sh` (Q3), `sigterm-under-load.sh` (exit within timeout+1). `kill-db` and `stall-body` run in `production-path`; the rest are local with a recorded run in `docs/stress-test.md` | crash_perf | 6 | council 1 A6, council 3 D3 for the timing assertions |
| Q12 | Truncated body → 400 *the body ended early* (audited 400), 413 only when the ceiling is hit | ux_polish | 1 | — |
| Q13 | Runbook §7 gains the failure-mode table (§1.4 shape: mode → behaviour → test), the `req` join, and the note that a refused `load-docs` leaves the earlier documents served; ATO package §2.8 cites Q3/Q4/Q10 evidence | ato | 1 | Q3, Q4 |

Order: Q1 and Q2 now (shell, no server dependency). Q3–Q5 with council 2
R3/R4 as one sitting. Q8 and Q9 next (they need no other change and make
the 500/boot paths visible). Q6 with council 1 A3, Q7 after §5 Q3. Q10
after S17's harness exists; Q11 after A6/D3 so its timing assertions are
true. Q12, Q13 anywhere.

## 3. Concrete changes

| file | change | why |
|---|---|---|
| `shell-web/src/ErrorBoundary.tsx` (new) | Class component `ErrorBoundary { props: { name: string; req?: string; children }; state: { error: Error \| null } }`; `static getDerivedStateFromError`; `componentDidCatch(e, info)` → `console.error(JSON.stringify({ boundary: name, message: e.message.slice(0, 200), stack: info.componentStack?.split("\n")[1] }))`; render `<Unavailable what={name} error={…}>` (S20's primitive, or a `<p>` until it exists) with *ref <req>* when known and a `<button>` *Reload this board* that resets state and bumps a `key`; `resetOn` prop (the `dataEpoch`/`asOf`) so a scrub retries | The product must never be a blank page; one row cannot take the chrome down |
| `shell-web/src/main.tsx:5-12` | `<ErrorBoundary name="the shell"><App /></ErrorBoundary>`; the root fallback also carries *Verdicts unavailable … Do not read any board as clearance* verbatim | Last resort still fails closed |
| `shell-web/src/App.tsx` (module switch, `:529-553`) | Each module rendered inside `<ErrorBoundary name={module.name} key={module.id} resetOn={[selected, asOf, dataEpoch]}>`; drawer, `ActivityInspector`, `JobCard` each in their own | A crash in one panel closes that panel, not the plate |
| `shell-web/src/api.ts` (`apiFetch`, with council 3 D10) | After `fetch`: `if (res.status === 401) throw new ApiRefusal(401, SESSION_ENDED, null)`; `if (res.ok && !ct.startsWith("application/json")) throw new ApiRefusal(401, SESSION_ENDED, null)`; `ApiRefusal.reason: "session" \| "scope" \| "refused" \| "busy" \| "unreachable" \| "offline" \| "timeout"` set from status/error class; `DailyOps.tsx:208` and `SequenceBoard.tsx:400` render `refusal.message`, never `String(e)`; `words.ts` (S20) carries `SESSION_ENDED` | An expired CAC session is not an engine failure; a login page is not a syntax error |
| `shell-web/src/api.test.ts` (new) | Table test over the classifier: `{401, 403, 404, 409, 422, 500, 503, 200 text/html, AbortError, TypeError(offline)}` → the expected `reason` and sentence | The branch is pinned before a proxy exists to exercise it |
| `crates/wadl-api/src/hardening.rs` (`audited`; with R3/R4) | `audit::emit(line) -> Result<(), io::Error>` on a locked `stdout().write_all` + `\n`; `Err` → `AUDIT_FAILURES += 1`, once `diag::emit("audit_stream_failed")`, `AUDIT_DEAD.store(true)` under `WADL_AUDIT_FAIL=halt`; `req` minted (uuid v7) before `next.run`, inserted into request extensions and as `x-wadl-request` on every response; the guard returns 503 `problem+json {"title":"audit unavailable","req"}` while dead. Unit tests: a writer that fails on the third line; the shed 503 and the static fallback both carry the header | AU-5 measured; the one place the id is born |
| `crates/wadl-api/src/bin/serve.rs` (`main`, banner) | Banner lines through `audit::emit`/`diag::emit`; on `Err` at boot: `eprintln`-free exit 1 with *stdout unwritable: <errno> — the audit stream has nowhere to go*; wrap `main` so no `println!` remains in the binary (a `#![deny(clippy::print_stdout, clippy::print_stderr)]` on `wadl-api` with the two emitters `#[allow]`ed) | A full disk at boot is a refusal, not a panic with a backtrace |
| `crates/wadl-api/src/diag.rs` (new) | `pub fn emit(event: &'static str, fields: &[(&str, Value)])` — adds `ts_ms`, `req` (from a task-local set by `audited`), `path`, `person` when in a request; checked write to stderr, failure counted, never panics; **rule**: callers pass identifiers only — `label_hash: sha256[..8]`, `row`, `code`, `count` — and a `#[cfg(test)]` canary test asserts no field value longer than 120 chars or containing whitespace-separated prose | The diagnostic stream carries no schedule content, ever |
| `crates/wadl-api/src/error.rs:65-76`, `rule_table.rs:410-413, 449-452`, `schedule_door.rs:276`, `bin/serve.rs:185-221` | Route through `diag::emit`: `backend_error {detail: sqlx message, path, person, req}`; `rule_table_uncompilable {label_hash, refusals: count, rows: [n…]}` (the sentences stay in the door's receipt for the person who can act); `xer_refused {reasons: codes, rows}`; `problem` adds `"req"` | Content leaves stderr; the reader who needs the text has it on the receipt |
| `crates/wadl-ingest/src/xer.rs:670, 1136` | `format!("unparseable {field}: {} chars", raw.len())`; project ids stay (identifiers) | A raw cell is schedule content |
| `crates/wadl-api/tests/redaction.rs` (new) | Boots `support::reference_hull()` with a register, hazard log, rule table and XER whose every free-text field contains `CANARY-NNPI-<n>`; captures stderr via `diag::capture_for_test()`; drives every door to refusal and success, a 500 through the failing store (Q8), the bundle; asserts zero occurrences of `CANARY` on stderr and in the bundle; asserts the audit stream carries only `path`, never a label | The rule is a test, not a convention |
| `crates/wadl-store/tests/pg_concurrency.rs` (new) | `#[tokio::test]` (needs `DATABASE_URL`, skips without): (a) 20 `JoinSet` tasks calling `commit_document_ledgered` (A3's method) alternating two labels → `ingested_document.label == (SELECT detail->>'label' … ORDER BY entry_id DESC LIMIT 1)` over 10 rounds; (b) 8 tasks `clear_hazard` → 1 `Ok(non-empty)`, 7 `Ok(empty)`, 1 ledger row; (c) `with_tenant` tx: upsert, then `tx.rollback()` → no document, no row; (d) `hull_epoch.ledger_seq == max(entry_id)` after every round. Until A3 lands, (a) is `#[ignore = "POAM-9: two-transaction commit"]` and the CI job runs `--include-ignored` on a schedule so the red stays visible | The measured inversion becomes a gate |
| `crates/wadl-api/tests/concurrency.rs` (new, both stores) | Over `support::reference_hull()`: 8 ∥ `POST hazards/clear` → exactly one 200; 8 ∥ raises → one 200; 8 ∥ `record_decision` → one row (with Q7); 8 ∥ yard-clock commits → served == newest ledger row (with A3); a `JoinSet` over the router's `oneshot` clones | Every write door has its contention rule pinned on memory every push and on PostgreSQL in `production-path` |
| `crates/wadl-api/src/handlers.rs` (`record_decision` `:1070-1170`, `acknowledge_issue` `:1412-1460`) | Before the append: `store.list_audit(scope, vessel, Some(&subject))` filtered to `MITIGATION_*` at the same `as_of_ms` and the same `option.action`; same disposition → `Ok(Json(json!({ "recorded": existing, "duplicate": true })))`; other disposition → `ApiError::Conflict(format!("already {} by {} at {}", …))` with the existing record as `existing` in the problem body; the race window is closed by the per-hull ledger lock on PG (read inside the same `with_tenant` transaction as `append_audit_in`) and the audit mutex on memory (a `decide_once` trait method) | Two Safety officers, one decision |
| `crates/wadl-api/tests/support/failing.rs` (new) | `pub struct Failing<S> { inner: S, mode: FailMode }` with `FailMode::{Always, After(n), Only(&'static str)}`; `#[async_trait] impl Repositories` delegating every method and returning `Err(StoreError::Backend("injected".into()))` per mode; `support::failing_app(mode)`; tests in `tests/failure_modes.rs`: every `routes::inventory()` GET → 500 problem+json with `detail: null` and a `backend_error` line carrying `req`; `whoami` → 503; `/health` → 503 | The 500 path is exercised for every route, not assumed |
| `crates/wadl-store/src/repo.rs` (`list_vessels`), `pg_repo.rs:856-860`, `roles.rs:530` | `list_vessels -> Result<Vec<VesselSummary>, StoreError>`; `whoami` maps `Err` to 503 `{"title":"store unavailable"}` with no `hulls` key; memory store returns `Ok` | An empty hull list must mean no hulls |
| `crates/wadl-api/src/handlers.rs:26-34` | `to_bytes` error matched: length-limit → 413; anything else → `OutOfRange("the body ended early — <n> bytes of <declared>")` (400 via a new `ApiError::BadBody`) | Audited status tells the truth |
| `.github/workflows/ci.yml` (`production-path`) | Steps after `/health`: (1) `serve` against `postgres://…:1/wadl` → expect exit 1 within 2 s and the sentence; (2) on a scratch database `UPDATE _sqlx_migrations SET success=false WHERE version=19` → boot refused with `run: wadl migrate`; (3) `serve > /dev/full` → exit 1, sentence on stderr, no `panicked`; (4) `scripts/chaos/kill-db.sh` and `stall-body.sh`; (5) `cargo test -p wadl-store --test pg_concurrency --features postgres`; (6) the smoke (S17) with `SMOKE_BASE` | The failure modes are gates, on the store that ships |
| `scripts/chaos/kill-db.sh`, `slow-db.sh`, `stall-body.sh`, `audit-pipe.sh`, `sigterm-under-load.sh` (new), `tools/slowproxy.py` (new) | Each: `set -euo pipefail`, boots or takes `BASE`, drives `tools/load_test.mjs` at 4 clients, injects the fault, asserts (kill-db: non-200 ≤ `WADL_DB_POOL_MAX`, `/health` 200 at +1 s and +10 s, p50 after ≤ 2× before; slow-db: with the proxy adding 40 s stalls, every request answers 503 ≤ timeout+1 s and `/health` reports `pool` pressure; stall-body: 503 at 30 s, a truncated body 400; audit-pipe: `/api` 503 and `/health` 503 within one request of the pipe closing; sigterm: exit ≤ timeout+1 s, no 200 after the drain flag) and prints one `chaos: PASS|FAIL <name>` line plus a JSON record under `artifacts/` | The behaviours in §1.4 stay measured |
| `shell-web/e2e/` (S17) + `multi-team.mjs` (new) | `lib.mjs` gains `context(role)` (a browser context with that role's demo identity, or the proxy headers when `SMOKE_BASE` is a yard host); `multi-team.mjs` runs the seven-step walk in §2 Q10 with three contexts and one screenshot per actor per step; `degraded.mjs` adds `401`, `login-page`, `bad-record` (`issues:[null]`) and asserts `#root` non-empty, the boundary sentence present, the strip still mounted | The critical workflow and the crash shapes are walked every push |
| `docs/runbook.md` §7, `docs/ato-package.md` §2.8 | The failure-mode table (mode · behaviour · test · evidence artifact); the `req` join procedure (`grep <req>` across journal, stderr export and the problem body a user reported); *a refused `load-docs` leaves the earlier documents served — check the ledger's `via` rows before serving* | The support team has one page for "what does it do when" |

## 4. Tensions with earlier personas and proposed resolutions

1. **Council 2 R3 (`WADL_AUDIT_FAIL=halt` default) and the boot path.**
   Agreed on halt for `/api`. Added: the boot banner and every `println!`
   in `serve.rs` go through the same checked emitter, so a full disk at boot
   is exit 1 with a sentence (Q3/Q9), not the panic measured in M1; and
   stderr is *not* audit — a failed diagnostic write is counted and dropped,
   never a halt and never a panic. R3's "one stderr line" must therefore be
   a checked write too.
2. **Council 1 A13 / council 2 R4 (request id).** One implementation, R4's
   fields; this pass adds the contract as tests (Q4): the id is on every
   response including the static fallback, shed 503s and `/health`; minted
   server-side, never accepted from the client; the `backend_error` line
   gains `path`, `person`, `ts_ms` or it cannot be joined at all. Council 1
   A4's liveness probe stays out of the audit stream; a 503 from it is not.
3. **Council 3 D10 / council 4 U2 (`apiFetch`, staleness, last-good).**
   Adopted; two additions. A 401 or a non-JSON 2xx is a third reason
   (`session`) with its own sentence and no "engine" wording — U2's 404/5xx
   split is not enough for the CAC hop. And a boundary fallback and a stale
   chip never render for the same board: the boundary *replaces* a board
   that threw; the chip *annotates* a board that rendered.
4. **Council 3 D9 (15 s epoch poll) vs council 2 R3 (halt).** While
   `AUDIT_DEAD`, every tab polls a 503 it cannot be audited for. Resolution:
   `/epoch` and `/health` answer 503 with `Retry-After: 60` while dead and
   the shell backs the poll off to 60 s; the strip reads *audit stream
   unavailable — the server refuses to serve unrecorded*.
5. **Council 1 A3 outbox alternative.** Prefer the single transaction: Q6
   asserts directly on the two tables; an outbox needs its drain tested as
   well. Agreed with council 3 §4.7 that `hull_epoch` rides the same
   transaction — Q6(d) pins it.
6. **Council 4 U15 / S17 "one viewport, no `data-testid`, twelve steps".**
   The multi-team walk needs three contexts and `aria-label`s the shell
   already carries; no `data-testid` is added. The chaos scripts are not CI
   gates by default — `kill-db` and `stall-body` run in `production-path`
   because they need only PostgreSQL; `slow-db` and `sigterm-under-load`
   are recorded runs, like council 3's scale run, until their timing
   assertions are true (D3, A6).
7. **Council 2 R12 (placards and `rows` on the audit line) vs the redaction
   rule (Q5).** Both hold, split by stream: the audit line carries the
   identifiers of what was disclosed (path, placard, count) because that is
   its purpose; the diagnostic stream carries none of the content. Under
   reading A the bundle's `path` masking is a customer decision (§5 Q4).
8. **Council 3 D8 (paging) and "partial document load".** Agreed that a page
   is a labelled partial; a cut body is a rejected promise in the shell, so
   no truncated list is ever parsed. The partial-load risk that remains is
   the CLI's keep-the-earlier-documents rule, which is by design and must be
   written into the runbook (Q13), not changed.
9. **Council 1 §1.2 (`/health` does a database round trip).** Measured here
   as a strength under a backend kill (it stayed 200 because the pool
   reconnects) — A4's split is still right, and Q8 pins that `/health` says
   `reachable:false` with a 503 when the store is truly gone.

## 5. Questions only the customer can answer

1. **Session expiry shape.** After idle, does the proxy answer the browser's
   `fetch` with a 401, a 302 to the CAC page, or a 200 login page — and with
   which content type? Q2's classifier treats all three as `session`; the
   sentence and the *Sign in* action depend on which.
2. **Audit failure policy at boot and mid-run** (council 2 Q7 restated for
   the box): must the process refuse to start when the audit destination is
   full or absent, and is a halted `/api` acceptable on the deck plate while
   the pipeline is restored?
3. **Two decisions on one option.** When two Safety officers accept the same
   option within a minute, is the second a duplicate (one record) or a
   second signature (two records, both valid)? When they disagree, which
   stands — first, newest, or neither until adjudicated — and must the
   deck plate see a 409?
4. **Support bundles as CUI.** May a bundle carrying request paths (placards)
   and document labels leave the enclave, and to whom; must `path` be
   masked under NNPI handling (reading A)?
5. **Database failover expectations.** Is PostgreSQL HA (Patroni/managed
   failover) in the target topology, and is a burst of ≤ pool-size 500s
   during failover acceptable, or must the binary retry once on a dropped
   connection? Q11's `kill-db` assertion depends on this.
6. **Recovery action on the field devices.** On a kiosk or a gloved tablet,
   is *Reload this board* (Q1) a usable recovery, or must a crashed panel
   recover itself on the next epoch tick with no tap?
