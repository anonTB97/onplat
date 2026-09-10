# Pilot-readiness review — Shipyard AI Onboard

Date 2026-09-02 · commit `7a802a8` · branch `claude/kickoff-from-docs-arhiib`

**Thesis under review.** A schedule ingest engine for on-board work on a vessel, in new construction or in maintenance, repair and overhaul. Planners use Shipyard AI Onboard to see where on the ship work is happening day by day, to find the conflicts the schedule was not intelligent enough to catch, and to adjudicate them once found. The interface speaks a shipbuilder's language. The tool transitions to production without a rewrite.

**How this was produced.** Eight subsystem maps were written from the code (planner surfaces, engine and domain, ingest and CLI, API, store, issues and mitigation and plan, operations posture and docs, ops surfaces in the shell). Six assessors then argued from those maps and from the code through six lenses: capability against the thesis, pilot readiness, shipbuilder UX, scale and data model, engineering risk, and new-construction fit. The twelve most consequential claims were re-verified by reading the code paths at the commit above. Every evidence citation is `file:line` at that commit.

## 1. Verdict

The loop the thesis describes is genuinely built, end to end, on one hull: a disciplined P6 door, a real day-by-day picture on scanned general-arrangement plates, a pure and traced decision engine that cascades hazards through authored ship couplings, and a closed adjudication loop into a hash-chained ledger. The production posture (row-level security, hardening, generated system security plan, SBOM, air-gap rehearsal) is ahead of the data it protects. What is not built is everything a real yard brings that the demo hard-codes: the ship itself, the yard's P6 conventions, its rule set, its hazards, its people, its clock. Thirteen items must be retired before a yard pilot starts. They total roughly 27 engineer-weeks. A team of three can be pilot-ready in about one quarter, and the pilot itself can run in the quarter after.

The single most important thing this review established, and confirmed by reading the code rather than by argument: **on the production store, an imported schedule produces an activity register and zero booked hours on every deck and readiness tile**, because the rollups read seeded work-order tables and never the ingested schedule (`crates/wadl-api/src/handlers.rs:556-615, 632, 706`). The demo's seeded work orders are load-bearing for the headline numbers. That is a two-week fix, and it is the first thing to fix.

Three more findings are of the kind that would end a pilot on the day a superintendent noticed them, and all three are cheap:

- **Clearing a hazard rewrites history.** Both stores serve hazards as "not cleared" with no reference to the evaluation instant, so a Friday clearance makes Thursday's hold vanish from every scrub back in time (`crates/wadl-store/src/pg_repo.rs:1157`, `crates/wadl-store/src/memory.rs:2076-2088`). The in-memory store also discards the basis and instant (`memory.rs:2104-2105`). One week.
- **A failed read renders as clearance.** The shell turns a failed verdict fetch into an empty list, and the chrome then says "No issues at this instant. That is a positive statement from the engine" (`shell-web/src/App.tsx:155-157, 165-167`; `shell-web/src/Chrome.tsx:587-591`). One week.
- **Every clock is Zulu.** XER wall-clock is stamped as UTC (`crates/wadl-ingest/src/xer.rs:149`), and the shift board's "Days 0700–1530" is anchored to UTC midnight (`shell-web/src/DailyOps.tsx:63-74`). For a Norfolk yard the day shift chip covers the wrong hours. One and a half weeks with a shift calendar.

The recommendation is to run a **one-hull MRO pilot** at one US yard, on PostgreSQL behind the yard's identity proxy, with the thirteen blockers retired first. A new-construction pilot is a separate decision: it needs a location model the product does not have, and it should not be attempted until the MRO pilot has run.

## 2. Where we are: capability matrix

| Thesis leg | What works today | Maturity | Evidence | Gap |
|---|---|---|---|---|
| Schedule ingest (P6 XER) | Dry-run preview, all-or-nothing commit, re-import delta, mapping and hours reconciliation, ledgered commit, revert. 40,586 activities through the door in 0.55 s. | PARTIAL | `handlers.rs:1559-1719`; `docs/stress-test.md:13-20` | Location comes only from a UDF literally named `compartment` (`xer.rs:403-404`); any one bad row refuses the file (`schedule.rs:76-87`); UTF-8 only; no labor filter on resources; no per-yard field map; no run history. |
| The ship (register, decks, geometry, adjacency) | Schema is built for scale: class template plus hull deltas, ordered decks, tenant coupling types, versioned rules. Geometry provenance ladder (unknown, parsed, registered, surveyed) with a surveyed-extents door and findings. | PARTIAL | `migrations/0002`, `0003`; `handlers.rs:2159-2340`; `docs/geometry-accuracy.md` | 24 seeded compartments and 8 hand-authored coupling edges are the only ship. No door for register, decks, or couplings. Hull-only `added` compartments are never served (`pg_repo.rs:336-341`). |
| Day-by-day spatial picture | Pins at compartment altitude on calibrated CV-67 plates, single server-owned instant with `as_of` on every read, 4-hour watch grid, VCR transport bar clamped to the availability, manning strip and zone interaction, printable shift board. | SUPPORTED | `shell-web/src/DeckExplorer.tsx`, `TimeControl.tsx`, `DailyOps.tsx` | Zulu everywhere; one plate set for every hull; register refetched on every scrub tick. |
| Conflict detection | Hazard cascade through ship physics with a rule code, rule version, path and clearing authority on every fired step; property-tested and golden-snapshotted; builds for wasm. | PARTIAL | `crates/wadl-engine/src/evaluate.rs:241-305`, `traversal.rs:78-118` | Hazards can be cleared but never raised (`routes.rs:70-76`). Rules are 7 of 21 prototype rows applied to every activity as hot work (`pg_repo.rs:1230-1238`; `memory.rs:2141-2152`). Hot-vs-flammable is an English keyword heuristic. Crowding is a shell constant. |
| Adjudication and ledger | Clear-with-basis closes the fact without deleting it; accept or reject a priced mitigation with a reason; acknowledge an issue. Hash chain verified on every read, UPDATE and DELETE revoked from the app role. | SUPPORTED | `handlers.rs:1336-1429`; `migrations/0007`; `crates/wadl-api/tests/clear_loop.rs` | No person on any entry (org UUID only). Cleared hazards vanish from the past. Four of five document doors commit and revert with no ledger entry. Ledger screen does not know `HAZARD_CLEARED` exists. |
| Shipbuilder language | The clear door ("tag-out log sighted, gas-free certificate in hand"), GO / WAIT / STOP with glosses that name the job, placards and frame stations everywhere, bow drawn right, shift board grouped by trade heaviest-first. | PARTIAL | `DeckExplorer.tsx:1532-1570`; `theme.ts:60-94`; `Chrome.tsx:287-297` | Primary legend and every state chip read ALLOW / WARN / SUSPEND / BLOCK bare. The trace reads "R03 · 1 hop · via deck_penetration · rule version uuid". Authorities render as `marine_chemist`. |
| Production transition | RLS on every table proven on live PostgreSQL in CI, 35 generated cross-tenant leak tests, hand-rolled hardening readable in one sitting, STIG-style self-assessment on every push, SSP input, SBOM, offline build rehearsal, hardened unit file. | PARTIAL | `crates/wadl-store/src/pg.rs:107-117`; `.github/workflows/ci.yml`; `docs/production-posture.md` | Every API test runs on the in-memory store; PostgreSQL tests pass silently with no database. Shell identity and hull list are compile-time constants. Empty `WADL_PROXY_KEY` admits everyone. No backup, restore, release, or health check that touches the database. |
| Scale | 40k activities measured: import 0.55 s, register read about 1 s p50 at 1.3 MB gzip, 64 concurrent readers at 11 requests per second. | PARTIAL | `docs/stress-test.md` | Map reads at "1 ms" were measured on 24 compartments. Evaluation is per compartment with a linear edge scan; unmeasured at a real register. |
| New construction | Nothing. Location is a USN compartment placard; time is an availability. | MISSING | `crates/wadl-domain/src/compartment.rs:106-137`; `handlers.rs:85-90` | Block, unit, erection stage, on-block versus on-board, and a dateless build period are unrepresentable. |

## 3. Strengths worth protecting

These are the parts of the codebase a pilot depends on and a rewrite would lose. They should be treated as fixed points while the blockers are retired.

- **A pure, traced engine.** Every decision carries the rule, its version, the state, the path, the clearing authority and the earliest clear. The evaluation instant is data, not a clock read, so a decision is reproducible from its inputs. The engine builds for `wasm32` on every push, which keeps it pure by force (`ci.yml:96-121`).
- **Doors, not scripts.** Five document kinds share one pattern: scope check before the body is read, dry-run preview, refusals with line numbers, all-or-nothing commit, revert. The missing doors this review asks for should copy that shape exactly (`handlers.rs:21-45, 1559-1636`).
- **Time discipline.** One server-owned instant, `as_of` on every evaluating read, projection labelled "NOT AN AUTHORIZATION", rows marked in or out of window and never filtered. The transport bar clamps to the availability grid and playback cannot run off the end (`TimeControl.tsx`, `TimeControl.test.ts`).
- **Priced mitigations.** Options are costed by counterfactual re-evaluation, with harm reported alongside benefit and the offered options verified server-side before a decision lands (`crates/wadl-mitigate/src/lib.rs:712-764`; six property tests including "triage never disagrees with assess").
- **Honest provenance.** Authored, name-derived, WBS-hinted, unlocated and unknown-space are graded at import and shown on every surface. Geometry says parsed or surveyed. The Sources board says what each hull is actually running on.
- **Tenancy that is real.** Row-level security with default-deny on an unset GUC, `SET LOCAL ROLE` so a superuser connection cannot bypass policy, and generated leak tests that fail on route drift.
- **Engineering hygiene.** `forbid(unsafe_code)`, deny on unwrap, expect, panic and indexing, `-D warnings`, locked dependencies, pinned toolchain, zero TODO markers. 237 Rust tests and 51 shell tests green at the commit.

## 4. Barriers to a pilot, ranked

Pilot definition used for the ranking: one MRO hull at one US yard, 5 to 15 named planners and superintendents, eight weeks, PostgreSQL behind the yard's identity proxy, initial data load done by our engineer with the yard's scheduler. Success is that the morning meeting runs off the tool and conflicts are found and adjudicated through it.

PILOT-BLOCKING means a superintendent would stop trusting the tool, or a yard could not load its data, or a security officer would refuse to connect it. Effort is engineer-weeks including tests.

| # | Barrier | Why it blocks | Effort |
|---|---|---|---|
| B1 | **Onboard the ship through the product.** No door for the compartment register, deck list or coupling graph. `added` hull compartments are never served. Vertical adjacency is one authored edge per pair. | A 3,000-space hull enters only by adapting `pg_seed.sql` by hand as table owner. Every placard the register lacks falls silently off every spatial view. Without edges the cascade engine has nothing to walk and the product's differentiator does nothing. | 5.0 |
| B2 | **Booked hours from the ingested schedule.** `booked_work` reads `work_order`, `work_segment` and packages only. | On PostgreSQL, import a real XER and every deck-state and readiness tile shows zero hours, readiness reads idle everywhere. The seeded orders are the only source of the headline numbers. | 2.0 |
| B3 | **Raise a hazard.** Routes are GET hazards and POST clear only; hazards come from constants and seed SQL. | The day's tag-outs, open coatings and hot-work permits cannot enter the tool, so every conflict a pilot sees traces to the seed. A daily hazard-log CSV door plus a raise route with a `HAZARD_RAISED` ledger entry. | 1.5 |
| B4 | **Survive the yard's XER.** UDF names hard-wired to `compartment` and `wi_number`; one bad row refuses the file; UTF-8 only; material resources summed as man-hours; no project filter; level-of-effort rows treated as work. | The first real export from a yard whose location UDF is called anything else imports 100% unlocated with no remedy short of a code change, or is refused whole on an ordinary cross-project predecessor. Needs a per-vessel field map door, row-level quarantine with reasons, Windows-1252 decoding, labor-only resources, and an `ingest_run` row per import. | 3.0 |
| B5 | **A person behind every decision.** Shell sends a compile-time `DEMO_IDENTITY`; hull picker is a constant list; `append_audit` has no actor; `by_person` is NULL on every ledger row; an empty `WADL_PROXY_KEY` arms proxy mode and admits every request (`auth.rs:41, 70-71`); handling markings are string constants. | A board of inquiry needs a name. The security officer will not connect an identity proxy to a gate that passes on an empty key. Extend the proxy header contract with a person id, thread it into the ledger hash, make the shell read `/api/whoami`, refuse to start on an empty key. | 3.0 |
| B6 | **Yard time zone and shift calendar.** Everything is UTC; shifts anchor to UTC midnight; watch, half-shift and shift are three names for the yard's day. | The shift board is wrong for every US yard on day one. Per-yard IANA zone and shift calendar as one small authored document; parse XER in that zone; render yard-local with the zone shown once; drive Daily Ops and the time grid from the calendar; call shifts what the yard calls them. | 1.5 |
| B7 | **Fail honestly.** Failed verdict and issue reads become empty arrays; `/health` is static; no metrics. | The tool asserts clearance on a network error. Carry fetch state with every list; "verdicts unavailable, do not read this board as clearance" in amber; `/health` that checks the database; request ids in the audit line and problem bodies. | 1.5 |
| B8 | **Time-honest hazards.** Cleared hazards vanish from every instant; the in-memory store drops basis and cleared-at. | The one action a planner takes in the tool rewrites history for every scrub, and the ledger contradicts the board. Serve hazards where `raised_at ≤ at` and `at` is before `cleared_at`; thread `as_of` into the hazard read; add the clear-then-scrub-back test. | 1.0 |
| B9 | **Engine at a real register.** Per-compartment `evaluate` with a linear `out_edges` scan, measured only at 24 compartments and 8 edges. | Rough scaling at 3,000 compartments, 30 hazards and 5,000 edges puts one deck-states call past the 30-second timeout, which cannot interrupt a CPU-bound handler. Index the graph by compartment, add an `evaluate_all` that runs each hazard-rule cascade once and buckets hits by subject, run a release-build scale test at 3,000 spaces and record it. | 2.0 |
| B10 | **Prove the PostgreSQL path.** All nine API test files run on the in-memory store; the 14 PostgreSQL tests report "passed" in 0.00 s with no database; the two seeds describe different ships; stored documents carry no schema version; demo mode will bind publicly. | The pilot runs on the path nobody has driven the shell against. Make the API suite store-generic and run it against PostgreSQL in CI; mark database tests ignored unless `DATABASE_URL` is set; generate the PG seed from the in-memory world; stamp `schema_version`; refuse demo mode off loopback. | 2.0 |
| B11 | **Rules the yard will sign.** Nine seeded entries covering 7 of 21 rule-table rows, contradicting the table in two places; bound by class only, ignoring work type, category and effective-from. | Cold-work inspections are refused by hot-work rules. Carry work type on activities, bind rules by work type and effective range, add a rule-set import door, and sit with the yard's safety authority to author the table as data with a golden trace per row. Minimum for pilot: audit the seed with the authority and restrict evaluation to hot-work activities. | 3.0 |
| B12 | **Confirmed defects.** Cascade re-emits the origin at depth 2 on symmetric edges; USN parser rejects two-letter usage codes (AA, FF, GG, JJ) and drops fuel and JP-5 spaces; `earliest_clear` is wrong when a timed and a verification hold coexist; `hours_at_risk` double-counts held and not-executable for the same work; acknowledgement timestamp is the scrubbed instant; `list_vessels` swallows backend errors; unknown `/api` paths return the index page. | Each is small and each would be found by a planner in week one. Fix as one pass with a regression test per item. | 1.5 |
| B13 | **Run it in production.** No backup or restore procedure, forward-only migrations with no rollback stance, no version stamp, no tagged release, no runbook, support bundle vestigial. | The yard's IT will ask for these before the proxy is connected. Write the runbook, drill a restore, tag a release with the commit and schema version in `/health`, decide the migration rollback policy in writing. | 1.5 |

**Total pilot-blocking: 28.5 engineer-weeks.** Taking the minimum on B11 (audit the seed, hot-work only) and B1 (register plus a coupling CSV door, derived vertical adjacency deferred) brings it to about 26.

HIGH items shape the pilot and should be built during it as planner feedback lands, not before:

| # | Item | Effort |
|---|---|---|
| H1 | Hot-vs-flammable and crowding as engine-derived issues with an adjudication path into the ledger, driven by a per-yard trade taxonomy document instead of English keyword matching. | 3.0 |
| H2 | Vocabulary pass: yard words for ALLOW / WARN / SUSPEND / BLOCK with glosses, the trace written as a sentence with engine detail behind a fold, authorities and coupling codes given display names, one badge primitive per fact across boards, `HAZARD_CLEARED` styled and summarised on the ledger screen, personas that land on their screen. | 3.0 |
| H3 | Morning-meeting artifacts: a Tomorrow mode on Daily Ops (next shift's work with the holds in front of it, split into clearable tonight versus clears on its own), and a Week page keyed to the next key event. | 3.0 |
| H4 | Schedule run history: one row per import with the served run pointed to, diff and revert against any prior run, stable activity ids from `(vessel, task_code)`, and "reading label, imported when by whom" in the breadcrumb. | 2.0 |
| H5 | Adjudication completeness: ledger every door commit and revert; owner, due-by and state on issues; a decisions export a scheduler can apply in P6. | 3.0 |
| H6 | Tests that prove the pilot rather than the demo: the five pilot-critical behaviours pinned, a Playwright smoke over load, scrub, trace, clear and ledger, shared test support. | 3.0 |
| H7 | Executor and fetch hygiene: `spawn_blocking` around serialisation and evaluation, ETag on the register, abort superseded fetches, fetch the register once per data epoch rather than per scrub tick. | 1.5 |
| H8 | The yard's own drawings: serve `drawing_sheet` rows with calibration through the API and a per-plate calibration door, so a second hull is data rather than a script run. | 3.0 |
| H9 | Bus factor: a second engineer does a cold clone, build, run, import, clear walkthrough and fixes what stops them; reconcile README status, BACKLOG, engine `lib.rs`, ADR 0002, the ingest schema doc and the traversal doc comment with the code; split `handlers.rs` business logic into its own crate. | 2.5 |
| H10 | Support runbooks, kiosk or shared-display deployment, and a failure drill. | 1.5 |

## 5. Timeline to pilot-ready

Assumptions: three engineers (two backend, one shell), a part-time shipbuilder subject-matter expert, and access to the pilot yard's scheduler and safety authority from week one. Engineer-weeks are converted to calendar weeks at three per week with a 25% allowance for integration and review.

| Phase | Weeks | Workstreams | Exit criteria |
|---|---|---|---|
| 0 · Trust | 1–2 | B8 time-honest hazards, B12 defect pass, B7 honest failure, B6 time zone and shift calendar, empty-key fix from B5. | Clear a hazard, scrub back, the hold is still there and a test pins it. A killed database renders "verdicts unavailable", never an empty positive. Shift chips are yard-local. Server refuses to start on an empty proxy key. |
| 1 · Doors | 2–7 | B1 register and coupling doors, B2 hours from the schedule, B3 hazard raise and hazard-log door, B4 field map and quarantine, B11 rule door and authority sitting. | The pilot hull's register, decks, couplings, hazard log, rule set and XER are loaded through the product with dry-run previews, on PostgreSQL, with no hand SQL. Deck and readiness tiles show hours from the schedule. |
| 2 · Production path | 5–9 | B5 person identity and whoami-driven shell, B10 PostgreSQL proof and one seed, B9 engine indexing and 3,000-space measurement, B13 runbook, release and health. | API suite green on PostgreSQL in CI. Every ledger row names a person. Deck-states at 3,000 spaces under one second in a release build, written into `stress-test.md`. A restore has been drilled from a backup. |
| 3 · Hardening | 9–12 | H2 vocabulary (state names, trace sentence, ledger clearance row), H6 tests (subset), H9 cold walkthrough and doc reconciliation, H10 runbooks. Dry run with the yard's real XER and drawings. | A second engineer runs it cold from the README. A superintendent reads the shift board and the trace without a glossary. The yard's actual export imports with a quarantine list the scheduler agrees with. |
| Pilot | 13–20 | H1 conflict issues, H3 morning-meeting views, H4 run history, H5 adjudication completeness, H7 fetch hygiene, built in flight from planner feedback. | Morning meeting runs off the tool. At least one conflict per week found and adjudicated through it. Ledger reviewed by the yard's safety authority. |

**Critical path.** B1 (the ship) gates B2 (hours on that ship), which gates a meaningful dry run with the yard's XER through B4. B11 and B5 both wait on people outside the team: the safety authority for the rule table and the yard's proxy owner for the identity header contract. Both conversations should start in week one, not when the code is ready.

**Staffing.** Backend engineer one: doors (B1, B3, B4, B11) then run history. Backend engineer two: hours, hazards in time, engine performance, PostgreSQL proof, ops (B2, B8, B9, B10, B13). Shell engineer: trust and vocabulary (B6, B7, part of B5, H2), then the morning-meeting views. The subject-matter expert owns the rule table sitting and the vocabulary sign-off.

**Total.** About 12 calendar weeks to pilot-ready, an 8-week pilot, and roughly 20 engineer-weeks of HIGH items built during the pilot. If the team is two engineers rather than three, pilot-ready moves to about 17 weeks.

## 6. Practical items to scale beyond the pilot

These are the things the pilot will not exercise but a second hull, a second yard or a new-construction programme will. None should be built before the pilot, and all should be designed for now so the pilot's doors do not have to be redone.

**Data model.**
- Make location an abstraction (compartment, block or unit, zone) with a per-class numbering scheme resolver. `ship_class.numbering_scheme` exists in the schema and nothing reads it. The USN parser should be one dispatch target, not the only parser.
- Replace the mandatory availability with a planning period so a hull without dated bounds can still be scrubbed, and let a hull carry more than one period. Today `AsOf::resolve` refuses any `as_of` for a hull with no availability and the vessel list picks the latest one.
- Version every stored document with `schema_version` and keep prior runs. The served schedule is one jsonb blob per hull replaced whole; a field rename in `model.rs` would turn every stored schedule into a 500.
- Open the hazard vocabulary. `HazardKind` is a closed MRO enum. New construction needs confined space, crane lift, radiography and energised test as first-class kinds, and a per-yard trade taxonomy should feed both conflict pairing and manning.
- Persist decisions with their rule version (`decision_event` is DDL only) and select rule versions by the evaluation instant, so a 2027 decision re-derived in 2031 really does use 2027's rules.

**Operations.**
- Metrics and a request id that correlates the audit line, the problem body and the ledger entry.
- A measured capacity envelope on PostgreSQL with several planners in playback, and `max_in_flight` sized from measured latency rather than a guess. The 40k-activity measurements are all on the in-memory store.
- Migration rollback policy, a release cadence, and a named owner and review cadence for each hand-rolled component. The posture is defensible for accreditation, and it moves every fix onto the team.
- A `cargo xtask ci-local` alias that runs exactly CI's lint gate, so the local-versus-CI drift that has already sent three pushes red becomes tooling rather than folklore.

**Multi-hull and multi-tenant.**
- Resolve assignments from `person_assignment` by the proxy-asserted person rather than an `x-assigned-vessels` header. The table is seeded and never read.
- Extend class policies with `vessel_grant` so a customer navy can see a yard's hull. Today a grantee sees no class row and therefore no vessel.
- Serve drawing sets per class from `drawing_sheet` and load calibration from the database. One committed CV-67 plate set currently draws every hull, including the destroyer and the amphib in the picker.

**Performance.**
- Cache the graph, rules and hazards tuple per hull epoch, not per request.
- Filter and page the register, and let the shell hold one copy across screens. Five components each pull it again today.

**UX language.**
- Make the period noun, the shift names, the persona names and the handling markings configuration served by the API rather than strings in the bundle. Personas should be the yard's roles and land on the screen where that role's day starts.
- Move the crew and occupancy heuristics behind the API with the tolerance as tenant data, so the warning triangle on a compartment means what the yard's occupancy determination says and not a shell constant of six.

**New construction.** A faithful new-construction pilot needs the location abstraction, a stage dimension on activities (on-block, on-board, erected), geometry that changes as blocks are erected, a build-milestone time bar, and the open hazard vocabulary. That is 10 to 14 engineer-weeks on top of the MRO work, and it should be scoped with a new-construction yard's planner in the room, the way the MRO work was scoped with Vince.

## 7. Risks and unknowns

- **The PostgreSQL path is the least-driven path in the repository.** Every shell session and every API test has run against the in-memory demo world. The pilot must run on PostgreSQL for ledger durability. B10 reduces this; it does not remove it until the shell has been driven against PostgreSQL by a person for a week.
- **The yard's XER is unknown.** Everything in B4 is inference from the P6 format and the sample. The first real export will teach the team something the sample did not. Get one in week one, before B4 is designed.
- **The rule table needs the yard's safety authority, not ours.** The seed is a prototype transcription and contradicts the handoff table in two rows. If the authority is not available in weeks two through four, B11 slips and the pilot runs on hot-work-only rules with the seed merely audited.
- **Bus factor.** 120 of 121 commits are agent-authored across 27 days. No second engineer has built or run it. The headline documents (README status, BACKLOG, engine `lib.rs`, ADR 0002) contradict the code in both directions. H9 is scheduled in phase 3; it would be safer in phase 1.
- **Engine scaling is estimated, not measured.** The B9 numbers are rough scaling from a 384-space debug-build test. The release-build measurement at 3,000 spaces should happen in week two so the estimate can be replaced before the doors land a real register.
- **Hand-rolled posture tax.** Middleware, compression, static serving, audit logging, the ledger, the XER parser and the CSV parsers are all owned in-house. The empty-key gap and the `/api` typo returning the index page are examples of what an upstream library would already have closed. This is a choice the accreditation story depends on, and it has a running cost that should be budgeted.
- **The demo and the product tell different stories.** The buyer saw a hull with 12 decks and a pump room; the PostgreSQL seed has 4 decks and a passage at the same placard. Whichever world the pilot uses, the other should be deleted or generated from it.

## 8. What not to build yet

- New-construction block and stage modelling. Reserve the words, do not build the model, until the MRO pilot has run.
- Multi-tenant sharing and `vessel_grant`. One yard, one tenant, for the pilot.
- A live permit or tag-out feed. A daily CSV through the hazard-log door is enough to learn the shape of the data.
- Automated write-back to P6. A decisions export the scheduler applies by hand is the right first step and teaches what the write-back would need.
- A drawing upload interface. One script run against the yard's plates is fine for one hull.
- The waiver workflow, issue ownership states beyond open and acknowledged, and a material model (VR-13). All three have seams in the code; none has a pilot user asking for it yet.
- Any machine-learning or predictive feature. The engine's value is that it is explainable and reproducible; nothing in the pilot should trade that away.
- Metrics dashboards beyond a health endpoint and a request id. Learn what to measure from the pilot first.

---

### Appendix A · Findings by lens

The six lens assessments and eight subsystem maps that fed this report are held as working files with the session; their findings are consolidated above. Counts per lens at the commit under review:

| Lens | Findings | Pilot-blocking | Weeks (blocking) |
|---|---|---|---|
| Capability against the thesis | 14 | 6 | 17.5 |
| Pilot readiness | 15 | 9 | 21.7 |
| Scale and data model | 12 | 7 | 13.5 |
| Engineering risk | 12 | 4 | 5.0 |
| Shipbuilder UX | 11 | 2 | 3.0 |
| New-construction fit | 10 | 3 | 6.5 |

The per-lens totals overlap heavily; the consolidated 28.5 in section 4 is the union after de-duplication, not the sum.

### Appendix B · Claims re-verified in code

Each of the following was checked by reading the code path at `7a802a8` rather than taken from an assessor's report. All twelve held.

1. Deck and readiness hours come from work orders and packages only (`handlers.rs:556-615, 632, 706`).
2. Cleared hazards are filtered without reference to the instant in both stores; the in-memory store discards basis and cleared-at (`pg_repo.rs:1154-1158`; `memory.rs:2076-2088, 2104-2105`).
3. An empty `WADL_PROXY_KEY` yields `Some("")`, the missing header defaults to `""`, and the constant-time compare passes (`auth.rs:39-43, 66-76`).
4. `cascade_from` never seeds the origin into `visited` and only keys on `(edge.to, coupling_type)` (`traversal.rs:84-114`).
5. `UsnCompartment::parse` requires an integer frame and a single-character usage (`compartment.rs:123-129`).
6. `pg_list_compartments` selects from `class_compartment` and only left-joins the hull delta (`pg_repo.rs:336-341`).
7. `rules_in_force` filters on class and `effective_to IS NULL` only; the in-memory store returns the seed unconditionally (`pg_repo.rs:1230-1238`; `memory.rs:2169-2179`).
8. Failed deck-state and issue reads become empty arrays (`App.tsx:155-157, 165-167`).
9. Shift windows anchor to UTC midnight (`DailyOps.tsx:63-74`); XER wall-clock is stamped UTC (`xer.rs:149`).
10. Location and work item UDF names are literals; one rejected row refuses the whole schedule (`xer.rs:403-404`; `schedule.rs:76-87`).
11. Hazard routes are GET and clear only (`routes.rs:70-76`).
12. `append_audit` is called from decision, acknowledgement, clear and schedule import only; zone, budget, manning and geometry commits and every revert write no ledger entry (`handlers.rs:1033, 1320, 1419, 1618`).
