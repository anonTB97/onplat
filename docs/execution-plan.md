# Execution plan — from the reviews to a demoable, production-shaped build

Companion to `docs/pilot-readiness-review.md` and `docs/ux-gap-analysis.md`.
Those say what is wrong and why. This says what is being built, in what
order, and the rules every slice is held to. It is updated as slices land.

## The objective

A complete, demoable build — not pilot-ready, but real: every screen answers
a real person's question without a tour guide, every number traces to a
document or the engine, nothing on screen is a mock — built so that the path
to a Navy production deployment (an ATO, a yard's identity proxy, a
PostgreSQL behind row-level security) is a matter of configuration and
evidence, not a rewrite.

## The rules every slice is held to

1. **No new runtime dependency without a written reason.** The hand-rolled
   posture (middleware, compression, static serving, audit, ledger, parsers)
   is the accreditation story. A dependency is added only when the
   alternative is a worse security argument, and the reason goes in the
   commit message.
2. **Every fact carries its provenance, and every derived figure says so.**
   Man-hours come from the schedule of record; verdicts from the engine;
   estimates from the shell. A screen or a sheet that shows a figure names
   its layer.
3. **Nothing renders good news it cannot prove.** A failed read is
   "unavailable", never an empty list that reads as clearance.
4. **The past does not change because somebody acted in the present.** A
   clearance, an acknowledgement, a decision has its own instant; a board
   scrubbed back shows what was really there.
5. **The lint gate is CI's gate.** `cargo fmt --all` then
   `RUSTFLAGS="-D warnings" cargo clippy --workspace --all-targets --all-features -- -D warnings`
   then `cargo test --workspace --all-features`; `npx tsc -b`, `npx vitest run`,
   `npx vite build` for the shell. Nothing is pushed red.
6. **Each slice is pushed on its own**, with tests that pin the behaviour it
   adds, so the branch is always demoable at its head.

## The slices

| # | Slice | Status | What it delivers |
|---|---|---|---|
| 1 | **The front door** | landed `ef9469f` | Rail grouped by the working day; screen names as headlines; seven yard roles with real landing screens, remembered per browser; one status strip with the same numbers on every screen; yard words for the four authorization states with a Legend panel; first-run cards; empty decks folded; failed reads rendered as "unavailable". |
| 2 | **Trust fixes** | landed `3318243` | Cleared hazards stay visible at instants before the clearance (both stores, `as_of` on the hazards endpoint, integration test); cascade never re-emits the origin (unit + property test); doubled USN usage codes parse; empty proxy key refuses to boot and cannot admit; unknown `/api` paths 404; acknowledgements stamped on the wall clock. |
| 3 | **Reports** | landed `37db174` | A Reports module: shift sheet, zone day sheet, compartment card, conflict log, field-condition register — pure builders (`reports.ts`, unit-tested), one screen, monochrome print, CSV with the cut in its header. Every sheet carries hull, instant, schedule source and producer, and names the layer of each figure. |
| 4 | **The ship through the product** | landed `2000cf7`, `36599d4` | Booked hours derived from the ingested schedule instead of seeded work orders (the readiness rollup says which, `hours_source`); a hazard-raise route validated against the register, raised from the deck plan beside the clearance. Three doors in the Data Sources home: the hull's compartment register (once stored it *is* the hull; findings name what would lose its space), the coupling register with derived vertical adjacency marked `derived`, and the daily hazard-log CSV (already-live rows skipped, each raise ledgered under its log). Every document commit and revert writes the ledger, on both stores. |
| 5 | **The yard's clock** | landed `3621485`, `a64da11`, `bb99a3f`, `458ec6b` (server); `df18c59`, `4e0f002`, `3eeb876` (shell) | The yard's clock as an authored document (IANA zone, standard offset, an optional daylight rule as two nth-weekday transitions, the watch length, the shifts by the yard's names), evaluated by a pure civil-time module in `wadl-domain` pinned to a shared vector file whose instants come from the IANA database; stored on both stores (migration 0016), loaded at boot from `reference/cvn73/CVN73-clock.csv` before the export, seeded as Norfolk for the 24-space world, honest UTC on PostgreSQL until a clock is loaded. A door (GET, dry run with this year's transitions and today's shifts as findings, commit, revert, ledgered `DOCUMENT_REPLACED`/`DOCUMENT_REVERTED` kind `yard_clock`, leak-tested, in the SSP). The XER's wall clock is read in the hull's clock; a start the clock skipped or repeated is accepted with a finding naming the line and the reading; the schedule of record remembers the clock it was parsed in and the clock door warns when it needs re-importing. `/timeframe` carries the clock. Shell: `yardClock.ts` mirrors `civil.rs` one-to-one and is pinned to the same vector file, with an `Intl` cross-check of the authored rule against the browser's tz database at four instants; `clock.ts` is the one place the clock is applied — every formatter renders the yard's wall clock, `Z` only under the UTC default, the record-grade stamp always carries the offset (`2026-09-04 09:15 −04:00`); the time strip names the zone once (`America/New_York · UTC−04:00`, amber `UTC · no yard clock loaded` under the default) and the day grid is the yard's watches, five hours long on the fall-back night and labelled so; Daily Ops and the Reports run on the calendar's shifts by the yard's names (`Days 0700–1530 · Swing 1530–2400 · Mids 0000–0700`, no `(Z)`), the shift sheet's footer names the clock once, the P6 change-request CSV and the register export write wall clock with the zone said; the Sources board has the Yard clock card with the door (upload → dry run with the server's and the browser's findings → confirm; revert to UTC) and the ledger names the document kind on its row. Deferred: week/month bucketing in Load digest and Schedule trace stays on UTC Monday/1st; the hazard log's `since` keeps requiring `Z`; `wadl-cli ingest-xer` parses UTC; the PG seed carries no clock row until B10; a "the yard's day starts at…" landing and Tomorrow mode (H3). |
| 6 | **Demo hardening** | landed `49af293` | The demo boots on the reference hull by default (`scripts/dev.sh`, release build; `WADL_DEMO=seed` for the seed); the issues and leverage reads are a third of a second and under a second on it (out-edge index on the adjacency graph, memoised schedule loads); `/health` asks the store and answers 503 when it cannot reach it, reporting the migration and document schema versions; every stored document is stamped `schema_version`; the two long boards page; a cold walk of every module renders clean; `docs/demo-script.md` is the scripted, role-by-role path over the hull. Deferred: running the API suite against PostgreSQL in CI and a CLI door for the documents — operator tooling the demo does not need (the store's RLS test still runs against a real PostgreSQL). |
| 7 | **The hull at scale, as documents** | landed `27ab339` | The zone scheme written down (`docs/zone-scheme.md`): zones are 3-D blocks — a frame band on a band of decks — and the chart, the audit and every view carry them. A generated CVN-73 hull at believable scale (`reference/cvn73`: 476 spaces on twelve decks, authored couplings with derived deck penetrations, geometry, a morning's log) and a schedule of record of 5,700 activities located to it; the demo boots on them through the doors' own paths (`WADL_DEMO_DOCS`). Vertical adjacency follows the deck order, not `ordinal + 1`. |
| 8 | **Zone focus with next-door awareness** | landed `10552cf` | A zone in focus blots out every other zone on the plate, the whole-ship view and the register — and keeps next-door work visible: spaces across the frame boundary, on the deck above or below, or coupled into the zone, each saying why. Served once from the register, chart and couplings (`/zones/:zone/adjacent`); the Zone Manager lands in it. |
| 9 | **Schedule change proposals** | landed `9e7eda6` | The path back to P6: a refused activity's alternative becomes a proposal the engine has checked (window, knock-on), ledgered; a Proposals view on the Sequence Board; a change-request CSV in P6's import layout; the XER door reports which proposals the next export reflects, so the loop closes where it started. |

After slice 6 the build is demoable end to end on the production store. The
pilot-blocking items that remain from the pilot review (person identity in
the ledger, the P6 field map and quarantine, the rule-set door and the
safety authority's table, the engine at a 3,000-space register, database
operations) are the pilot programme, sequenced in that review.

## What a demo walks through, once the slices land

The scripted version, with every space, activity and hazard named from the
reference hull, is `docs/demo-script.md`. The outline:

1. Open as a Foreman: the shift board for today, the status strip, the
   legend. Print the shift sheet.
2. Switch to Zone Manager: the zone board, worst first; the zone day sheet.
3. Open a held space on the plate: the trace in yard words, the field
   condition holding it, the priced options. Record a clearance with its
   basis; watch every space it held re-derive; scrub back an hour and see
   the hold that was really there.
4. Data Sources: import the yard's schedule with a dry run; the mapping
   report; the re-import delta. Raise today's hazard from the log.
5. Conflicts and Actions: what is worth doing first, and the cascade of
   doing it. Acknowledge an issue; open the ledger and read the chain
   verify.
6. Reports: the conflict log and the field-condition register, cut, dated,
   printed.
