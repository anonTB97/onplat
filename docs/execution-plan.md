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
| 5 | **The yard's clock** | planned | Time zone and shift calendar as an authored document; XER wall-clock parsed in it; every clock and the shift board in yard-local with the zone shown once; the report shift windows follow it. |
| 6 | **Demo hardening** | planned | API integration suite run against PostgreSQL in CI; one demo seed for both stores; `schema_version` on stored documents; `/health` that checks the database; a scripted demo path over the sample schedule; a second engineer's cold walkthrough. The issues and leverage reads take two to three seconds on the reference hull in a release build — the engine's per-activity window evaluation — and want a pass here. |
| 7 | **The hull at scale, as documents** | landed `27ab339` | The zone scheme written down (`docs/zone-scheme.md`): zones are 3-D blocks — a frame band on a band of decks — and the chart, the audit and every view carry them. A generated CVN-73 hull at believable scale (`reference/cvn73`: 476 spaces on twelve decks, authored couplings with derived deck penetrations, geometry, a morning's log) and a schedule of record of 5,700 activities located to it; the demo boots on them through the doors' own paths (`WADL_DEMO_DOCS`). Vertical adjacency follows the deck order, not `ordinal + 1`. |
| 8 | **Zone focus with next-door awareness** | landed `10552cf` | A zone in focus blots out every other zone on the plate, the whole-ship view and the register — and keeps next-door work visible: spaces across the frame boundary, on the deck above or below, or coupled into the zone, each saying why. Served once from the register, chart and couplings (`/zones/:zone/adjacent`); the Zone Manager lands in it. |
| 9 | **Schedule change proposals** | landed `9e7eda6` | The path back to P6: a refused activity's alternative becomes a proposal the engine has checked (window, knock-on), ledgered; a Proposals view on the Sequence Board; a change-request CSV in P6's import layout; the XER door reports which proposals the next export reflects, so the loop closes where it started. |

After slice 6 the build is demoable end to end on the production store. The
pilot-blocking items that remain from the pilot review (person identity in
the ledger, the P6 field map and quarantine, the rule-set door and the
safety authority's table, the engine at a 3,000-space register, database
operations) are the pilot programme, sequenced in that review.

## What a demo walks through, once the slices land

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
