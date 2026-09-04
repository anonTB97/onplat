# S11 — The morning meeting: Tomorrow on Daily Ops, and Week Ahead

Date 2026-09-04 · head `78fd3c7` · branch `claude/kickoff-from-docs-arhiib`.
Closes HIGH item H3 (`docs/pilot-readiness-review.md` §4) and the reporting
gaps R5/R8 (`docs/ux-gap-analysis.md` §4). Builds on the yard clock (S10).

## Summary

The morning meeting asks two questions the product cannot yet answer without a
tour guide: *what does the next shift walk into, and which of those holds can a
person clear tonight versus which will clear by themselves* — and *what is
standing between us and the next key event, and what have we already asked P6
to move.* Both answers are cuts of reads the API already serves. This slice is
shell-only: a **Tomorrow** mode on Daily Ops built from two engine evaluations
(now, and the next shift's start) plus the hull-wide leverage read at that
instant; and a **Week Ahead** module keyed to the schedule of record's next
milestone with logic, ranking the work gating it worst first with the open
proposals shown against it. Each has a print sheet through the existing
`Report` model. No route, no migration, no store method, no dependency.

## What already exists

- `DailyOps.tsx`: the shift board — this instant plus three fixed UTC shifts on
  the as-of day, per trade heaviest first, `HELD` / `REFUSED THIS SHIFT` /
  `NOT EXECUTABLE` per row, a hand-built print. Its `shiftWindow` and
  `reports.ts:shiftWindow` are the two places S10 replaces with `yardClock.ts`.
- Reads: `GET …/activities?as_of` (every row carries `executability`: first
  refusing instant, rule, origin, hazard, clearing authority, earliest clear;
  the register also carries `edges`, the schedule's own logic);
  `GET …/deck-states?as_of` (per space `permits_work`, `earliest_clear`,
  `clearing_authority`, `readiness`); `GET …/leverage?as_of` (hull-wide single
  actions, deduplicated: `discharge {origin,hazard,actor}`, `wait {until}`,
  `interrupt {from,to,coupling}`, each with `frees[]`, `closes[]`, confidence);
  `GET …/schedule-alternatives?as_of` (per refused activity the engine's viable
  window, verification gate, or no window, with `pushes`);
  `GET …/schedule-proposals` (status derived on every read: open / reflected /
  superseded / dropped / withdrawn); `GET …/timeframe` (server `now`, availability).
- Milestones: `is_milestone` from `TT_Mile`; the reference XER carries 14
  (availability start, 25/50/75 % reviews, light-off, crew cert, fast cruise,
  end of availability, six zone close-out reviews). Light-off and the six
  close-outs each have six predecessors; the reviews have none. The seed world
  has three (`M0100`–`M0300`) with no logic.
- `ActivityInspector.tsx` opens standalone with `a`, `alt`, `identity`,
  `vesselId`, `asOf`, `onOpenSpace`, `onOpenJob`, `onProposed` and carries the
  "Propose to P6" block; `Proposals.tsx` renders a `ProposalList`.
- `reports.ts`: `Report` model, `toPrintHtml`, `toCsv`, `reportFilename`,
  `CATALOGUE`; `Reports.tsx` renders whatever builder returns a `Report`.
- `App.tsx`: `MODULES` rail, one `asOf` for the app, `rows` (deck-states at
  as-of) and `verdictsOk` shared with every module, `jump(space)` to the plate
  where the clear-with-basis door lives, `TimeControl` with the
  `PROJECTION — NOT AN AUTHORIZATION` strip.
- `wadl-mitigate::leverage`: a `discharge` per (origin, hazard) on a blocking
  trace; `frees` is computed over the coupling reach.

## Scope

1. **Tomorrow mode on Daily Ops.** A fourth chip beside the shift chips:
   *Tomorrow · Days Fri 09/05 0700–1530 EDT* (the next shift after the as-of
   instant, in the yard's clock, zone named once). The board evaluates the next
   shift's work against the engine **at the shift's start** and splits the
   holds in front of it into *clearable tonight*, *clears on its own*, and
   *needs a plan*, then the sendable work per trade. A print sheet and CSV.
2. **Week Ahead module** (rail group *Today*, after Daily Ops): keyed to the
   next key event with logic in the schedule of record; the work gating it,
   worst first; the open proposals against it; a seven-day strip; the
   inspector inline so a proposal can be raised from the row. A print sheet
   (R8 key-event readiness) and CSV.
3. Two catalogue entries on Reports pointing at the boards where the sheets
   are cut. A Field Guide paragraph. Demo script steps.

## Out of scope

- A server route for key-event gating (`/key-events`): the shell already holds
  activities and edges; a route is worth adding when the CLI or S17 needs it.
- `TT_FinMile` finish milestones in the XER parser (one line + test): belongs
  to the XER-survival slice, since it changes the ingest contract.
- Owner and due-by on holds (H5), crowding and hot-vs-flammable on the
  Tomorrow board (H1), a per-trade filter for the Foreman role (Chrome.tsx is
  reserved for S10/S12/S18), P6 write-back, float from P6 (`total_float_hr_cnt`
  is not ingested; margin here is planned finish versus event date).
- Hazards raised with a future `since` (the raise route refuses them) — so
  tomorrow's projection is under the conditions known now, and says so.

## Contracts

### Assumed from S10 (state any drift in `programme.md`)

`GET /api/vessels/:id/timeframe` adds:

```json
"yard_clock": { "zone": "America/New_York", "standard_offset_minutes": -300,
  "daylight": { "rule": "us", "offset_minutes": -240 } | null,
  "block_minutes": 240, "source": "document" | "default",
  "shifts": [ { "name": "Days", "start_minutes": 420, "end_minutes": 930 },
              { "name": "Swing", "start_minutes": 930, "end_minutes": 1440 },
              { "name": "Night", "start_minutes": 0, "end_minutes": 420 } ] }
```

`shell-web/src/yardClock.ts` exports `shiftWindows(clock, dayStartMs)` →
`{ name, start, end }[]` (epoch ms, a shift crossing midnight ends on the next
day), `toCivil(clock, ms)` → `{ y, m, d, hh, mm, offsetMinutes, abbrev }`,
`fromCivil(clock, civil)` → ms, and `fmtYard(clock, ms)` → `09/05 07:00 EDT`.
`Timeframe.yard_clock` is always present (`source: "default"` = UTC with the
three shifts above). If S10 has not landed when S11 is built, S11 ships
`yardClock.ts` with exactly these signatures over the UTC default and
`Timeframe.yard_clock?` optional; S10 replaces the body, not the callers.

### Shell modules (new)

**`tomorrow.ts`** (pure, no fetch):

```ts
export function nextShift(clock: YardClock, fromMs: number): ShiftWindow & { dayLabel: string }
// first shift window with start > fromMs, scanning the as-of yard day and the next.
export interface TomorrowInput {
  clock: YardClock; shift: ShiftWindow; asOfMs: number;
  activities: Activity[]; spacesNow: DeckStateRow[]; spacesAtStart: DeckStateRow[];
  leverageAtStart: Mitigation[]; zone: string | null;
}
export interface TomorrowBoard {
  shift: ShiftWindow; evaluatedAt: number;
  clearable: ClearanceGroup[];   // discharge + interrupt actions whose frees ∩ shift spaces ≠ ∅
  selfClearing: SelfClearRow[];  // held now, open at start (cures before) or timed clear during/after
  needsPlan: SpaceRow[];         // held at start, freed by no single action
  sendable: TradeColumn[];       // everything else on the shift, per trade heaviest first
  undated: Activity[]; unlocated: Activity[];
  totals: { activities: number; mhShift: number; mhClearable: number; mhSelf: number; mhPlan: number };
}
export function tomorrowBoard(input: TomorrowInput): TomorrowBoard
export function tomorrowSheet(board: TomorrowBoard, cut: ReportCut, clock: YardClock): Report
```

Row semantics (the words on screen and on paper):

- `ClearanceGroup`: `{ action, actor, hazard, origin, confidence, frees: string[], closes: string[],
  rows: ShiftRow[], mhShift, trades[] }`. Header reads
  *"Isolation authority · Bus live · Switchgear Room No. 2 (3-148-2-E) — frees
  4 spaces · 6 activities · 312 MH tomorrow · Electrical, Pipefitting ·
  ASSUMES ATTENDANCE"*; an interrupt reads *"Isolate deck_penetration
  3-148-2-E → 3-140-0-Q — ASSUMES ITS OWN PERMIT"*; `closes` non-empty appends
  *"· would shut 1 space"* in red. Sorted by `mhShift` desc. Row: code · name ·
  space · trade · slot · MH tomorrow.
- `SelfClearRow`: `{ space, name, heldNow: boolean, heldAtStart: boolean, clearsAt: number,
  when: "before_shift" | "during_shift" | "after_shift", authority, rules[], rows, mhShift }`.
  Reads *"2-91-2-L Crew berthing No. 9 — held now (R02) · cures on its own by
  17:10 EDT today · open at shift start · 2 activities · 96 MH"*;
  `during_shift`: *"clears at 09:40 EDT — send the crew after"*; `after_shift`:
  *"will not clear before 15:30 EDT — see Week Ahead for the engine's window"*.
- `SpaceRow` (needs a plan): *"4-74-0-Q Forward pump room — held at shift start;
  no single action opens it (R03 + R07) · 3 activities · 410 MH — open the
  options panel"*.
- `TradeColumn`: today's column model; rows carry `NOT EXECUTABLE AS PLANNED`
  (plan-level, unchanged) but never `HELD` — nothing in this section is held at
  the shift start, which is the point of the section.
- MH tomorrow = `activityWindowHours(a, shift.start, shift.end)` (schedule of
  record, pro-rated by the shell — footnoted as such).

**`TomorrowBoard.tsx`**: props `{ identity, vesselId, hullLabel, clock, asOfMs,
activities, spacesNow, verdictsOk, zone, role, onOpenSpace, onOpenJob }`. Fetches
`deckStates(id, v, shift.start)` and `leverage(id, v, shift.start)` together;
both succeed or the board renders one amber block *"Projection unavailable —
the engine did not answer for 09/05 07:00 EDT; do not read this board as
tomorrow's clearance"* (never an empty board). A 422 (shift start outside the
availability) renders *"The next shift is outside the availability — no
projection"*. Above the sections a strip: *"PROJECTED · evaluated by the
engine at 09/05 07:00 EDT under the field conditions recorded as of
09/04 14:12 EDT · overnight tag-outs are not on this board · NOT AN
AUTHORIZATION"*. Buttons: *⎙ Print sheet*, *↓ CSV* (via `toPrintHtml` /
`toCsv`), *Open on the plate* per space (existing `jump`; the clear-with-basis
door is there).

**`keyEvents.ts`** (pure):

```ts
export function keyEvents(activities: Activity[], edges: ScheduleEdge[], fromMs: number): KeyEvent[]
// milestones with planned.start >= fromMs, status != complete, ascending; each with predCount.
export function gatingSet(code: string, activities: Activity[], edges: ScheduleEdge[]): Set<string>
// transitive predecessors over edges (any kind, lags not applied), excluding milestones and complete rows.
export function weekBoard(input: { event: KeyEvent; activities; edges; alternatives: AlternativeRow[];
  proposals: ScheduleProposal[]; fromMs: number; clock: YardClock; zone: string | null }): WeekBoard
export function keyEventSheet(board: WeekBoard, cut: ReportCut, clock: YardClock): Report
```

`WeekBoard.rows` — one per gating activity, `tier` then `remaining_hours` desc:

| tier | word on the row | condition |
|---|---|---|
| 0 | `MISSES THE EVENT` | refused as planned and the engine's window (alternative) ends after the event, is verification-gated, or has no window |
| 1 | `SLIDES · still makes it (+3 d)` | refused as planned, viable window ends before the event |
| 2 | `CANNOT BE ASSESSED` | unlocated or undated |
| 3 | `PLANNED PAST THE EVENT` | executable, planned finish after the event date (schedule-of-record fact) |
| 4 | `on plan · margin 12 d` | executable, finish before the event |

Each row: code · name · space (or *not located*) · trade · planned · MH left ·
the hold (*"R04 · HW permit 2673 at 5-212-1-Q · fire marshal · clears on
verification"*) · margin (event − planned end, days) · proposal (*"#7 OPEN → 12/02–12/09 · makes it"* / *"REFLECTED"* / *"—"*) · *Inspect →*.
`WeekBoard.days`: seven yard days from the as-of day, each `{ dayStart, starting, refused }`
over the gating set. `WeekBoard.eventsWithoutLogic`: milestones the schedule ties no
work to, listed under the picker as *"no logic ties work to this event"*.

**`WeekAhead.tsx`**: module id `week`, label *Week Ahead*. Fetches
`listActivities(as_of)`, `scheduleAlternatives(as_of)`, `listProposals`.
Header: kicker *Week Ahead · CVN-73 PIA-26*, title *"What stands between us and
{event}"*, stats: event date and days away · gating activities · MH left ·
misses the event · cannot be assessed · proposals open. Picker: chips for every
upcoming event, default = the earliest with logic. Table pages at 50 with the
Issues board's foot. Clicking a row opens `ActivityInspector` (right panel);
`onProposed` refetches proposals. Zone focus honoured as on the Sequence Board.

### Reports

`ReportId` gains `"tomorrow" | "keyEvent"`; `CATALOGUE` gains
`{ id: "tomorrow", name: "Tomorrow's board", audience: "production super · trade foremen",
question: "What the next shift walks into, and who can clear it tonight", cutOn: "dailyOps" }`
and `{ id: "keyEvent", name: "Key-event readiness", audience: "project super · programme office",
question: "Work gating the next key event, worst first, with what P6 has been asked", cutOn: "week" }`.
`Reports.tsx` renders a `cutOn` card as a link (*"Cut on the Tomorrow board →"*)
through a new `onOpenModule` prop; the sheet is produced where its reads are.
Both sheets carry the standard cut block and notes:
*MH: schedule of record, pro-rated into the shift by the shell · Holds and
clearances: the engine at the shift start, under conditions recorded at the cut
· Gating set: the schedule of record's own logic, walked by the shell,
lags not applied · Margin: planned finish against the event date, from the
schedule of record.*

### Routes, documents, migrations, env, CLI

None. No `routes.rs` change, so no `gen-leak-tests` / `gen-ssp` run.

## Files

New (6): `shell-web/src/tomorrow.ts`, `shell-web/src/TomorrowBoard.tsx`,
`shell-web/src/keyEvents.ts`, `shell-web/src/WeekAhead.tsx`,
`shell-web/src/tomorrow.test.ts`, `shell-web/src/keyEvents.test.ts`.

Touched (7): `shell-web/src/DailyOps.tsx` (Tomorrow chip; delegate to
`TomorrowBoard`; shift chips read `clock.shifts` when S10 has landed),
`shell-web/src/App.tsx` (register `week`; pass `now`/`yard_clock`, `role`,
`onOpenModule`), `shell-web/src/reports.ts` (`ReportId`, `CATALOGUE.cutOn`),
`shell-web/src/Reports.tsx` (cut-on cards), `shell-web/src/FieldGuide.tsx`
(§05 paragraph), `docs/execution-plan.md` (row), `docs/demo-script.md` (steps).
Plus `shell-web/src/yardClock.ts` only if S10 has not landed (shim, see above).

## Tests

`tomorrow.test.ts`:
- `nextShift picks the first window after the instant, across the day boundary`
  (Night after Swing rolls to the next yard day; a UTC default and a −5 h zone).
- `a hold that clears on a clock before the shift start is self-clearing, not clearable`
  (held now with `earliest_clear` < start, open at start).
- `a verification-gated hold at shift start groups under its discharge action with the shift's MH`
  (two spaces freed by one discharge → one group, MH pro-rated, trades listed, `closes` kept).
- `a timed clear inside the shift reads during_shift; after the shift end reads after_shift`.
- `a space held at start that no single action frees lands in needsPlan, never in sendable`.
- `sendable columns never carry a HELD word` and `undated and unlocated rows are counted, not dropped`.
- `tomorrowSheet carries the cut, the projection note and every section, and prints via toPrintHtml`.

`keyEvents.test.ts`:
- `keyEvents lists future, incomplete milestones ascending and counts predecessors`.
- `gatingSet is transitive, ignores lag sign, excludes milestones and complete rows, and survives a cycle`.
- `rows rank misses-the-event, slides, cannot-be-assessed, planned-past, on-plan; ties by MH left`.
- `a proposal on a gating activity reads makes-it or misses-it against the event date; reflected keeps its word`.
- `days strip counts starts and refusals per yard day over the gating set`.
- `keyEventSheet names the layer of every figure`.

Existing suites unchanged: `reports.test.ts`, `windowLoad.test.ts`, `TimeControl.test.ts`.
Rust suite untouched (`cargo test --workspace --all-features` still runs as the gate).

## Acceptance

1. `scripts/dev.sh`; Foreman → Daily Ops → **Tomorrow**: the chip reads the
   next shift in the yard clock with the zone once; the projection strip names
   the evaluated instant and the as-of; sections *Clearable tonight*, *Clears
   on its own*, *Needs a plan*, *Sendable* render; on the reference hull the
   first two are non-empty (energised buses / stop-works / hot-work permits /
   tank vapour under authorities; the five deck coats cured before the shift).
2. `curl -H x-org-id:… "…/deck-states?as_of=<shift start>"` returns the rows
   the board's held count agrees with; `…/leverage?as_of=<shift start>` lists
   the discharge actions the *Clearable tonight* headers name, in that order.
3. Kill the API, reopen Tomorrow: the amber *Projection unavailable* block,
   no sections, no zero counts. Scrub `as_of` a day back: Tomorrow is the next
   shift after that instant and the board re-derives; the present board is
   unchanged when the clock returns.
4. Record a clearance on a *Clearable tonight* origin from the plate; return:
   its group is gone from tomorrow, the ledger has `HAZARD_CLEARED`, and
   scrubbing back before the clearance shows the group again.
5. *Print sheet* opens a monochrome page with the cut block, four sections and
   the layer notes; *CSV* downloads `tomorrow-s-board-cvn-73-pia-26-…-asof-….csv`
   whose first rows are the cut.
6. Week Ahead on the reference hull: default event is the earliest upcoming
   milestone with logic (a zone close-out review); the picker lists the
   reviews under *no logic ties work to this event*; rows rank worst first
   with the hold sentence; *Inspect →* opens the inspector; *Propose to P6*
   there lands a ledger entry and the row's proposal column reads `#n OPEN`
   with *makes it* / *misses it*; withdrawing on the Sequence Board updates it.
7. `WADL_DEMO=seed`: Tomorrow renders on the 24-space world; Week Ahead says
   *no logic ties work to any upcoming event* and lists the three seed
   milestones rather than an empty table.
8. Gate green: `npm run typecheck`, `npx vitest run` (both new suites),
   `npm run build`; Rust gate unchanged; every rail module still renders.

## Demo moment

Foreman, 1400 on the wall clock: *Daily Ops → Tomorrow*. "Days, Friday 0700 to
1530, Eastern. Tonight we need the isolation authority on the bus in
Switchgear Room No. 2 — that alone opens four spaces and three hundred hours of
tomorrow's work; the fire marshal on permit 2673 in shaft alley 3. The five
deck coats cure by 1710, nothing to do there. The forward pump room needs a
plan, not a phone call." Print it; it goes on the wall. Then Ship Super:
*Week Ahead*. "Z4 close-out review, 30 December. Eleven activities miss it as
planned; three already have proposals headed to P6, two of which make the
date." Open one, propose the engine's window, watch the row change.

## Depends on / conflicts with

- **Depends on S10** for `yard_clock` and `yardClock.ts` (shim fallback above).
  Sequence S10 → S11 in `programme.md`.
- **Id collision**: the charter's proposed list used *S11* for XER survival;
  this packet was commissioned as *S11 morning meeting*. `programme.md` must
  renumber one; nothing in either packet references the other's number.
- Conflicts: none with S12/S18 (Chrome.tsx untouched). `App.tsx` and
  `DailyOps.tsx` are touched by S10 too — build S11 after S10 lands, not in
  parallel. `reports.ts` is touched only at the type and catalogue.

## Risks

- Leverage at a future instant on a 3,000-space hull may exceed a second;
  the board fetches it once per (hull, shift start) and shows *computing
  clearances…* meanwhile; S15 (engine at scale) is the real fix.
- `frees` covers the coupling reach, so a discharge may list spaces with no
  work tomorrow; the group counts only shift spaces and says *frees 4 spaces
  (2 with work tomorrow)*.
- The demo's milestones are dated; after 2027-01-23 nothing is upcoming and
  Week Ahead says so — the same clock sensitivity the whole demo has.
- A yard XER with `TT_FinMile` finish milestones shows fewer key events until
  the XER slice lands; the picker's count makes the gap visible.
- Transitive closure in the browser is memoised per register epoch;
  milliseconds at 5,706 activities, to be measured at a 40k register.

## Needs from the yard

- The shift names and windows (S10's document) — the chip labels are theirs.
- Which milestones are "key events" to them (P6 activity code or a WBS bucket),
  and whether close-out reviews count; the picker shows every milestone until
  a filter is a document.
- Who receives the *Clearable tonight* sheet (isolation authority, fire
  marshal, marine chemist, weapons department) — the authority display names
  land in S18; the sheet groups by them now.

## Estimate

About 5 agent-hours, as two commits: **S11a Tomorrow** (`tomorrow.ts`, tests,
`TomorrowBoard.tsx`, `DailyOps.tsx`, `App.tsx`, Reports catalogue) ≈ 2.5 h;
**S11b Week Ahead** (`keyEvents.ts`, tests, `WeekAhead.tsx`, Field Guide,
demo script, execution-plan row) ≈ 2.5 h. Each commit demoable on its own.
