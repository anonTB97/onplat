# S10 — The yard's clock

Pilot barrier B6 (`docs/pilot-readiness-review.md` §4; ux-gap U6). Execution-plan slice 5, still "planned".

## Summary

Every clock in the product is Zulu: the XER's wall clock is stamped UTC (`crates/wadl-ingest/src/xer.rs:145-151`), the shift board's "Days 0700–1530" is anchored to UTC midnight (`shell-web/src/DailyOps.tsx:62-74`, `reports.ts:132-143`), the watch grid is `00–04Z … 20–24Z` (`watch.ts`), and the shell's one formatter module stamps `Z` on every time (`clock.ts`). For a Norfolk yard the day-shift chip covers 0300–1130 local and every XER start reads four hours early.

This slice adds **one small authored document per hull, the yard clock**: an IANA zone name, a standard offset, an optional daylight rule (two nth-weekday transitions), the watch length, and the yard's shifts by the yard's names. It enters through a door (dry run with findings, commit, revert, ledgered, both stores), is loaded at boot for the reference hull from `reference/cvn73/CVN73-clock.csv`, and is evaluated by a **pure civil-time module in `wadl-domain`** (`civil.rs`) **mirrored in the shell** (`yardClock.ts`), both pinned to one shared vector file. The XER is parsed in that clock; the shell renders every clock and sheet yard-local, shows the zone once on the time strip, and drives Daily Ops, the watch grid, the reports' shift windows and the P6 change-request CSV from the calendar.

**Offset schedule, confirmed.** No tz database exists in the workspace (`chrono` is present in `wadl-store` and `wadl-ingest` without `chrono-tz`; `wadl-domain` is dependency-free and wasm-safe). Adding `chrono-tz` would be a new runtime dependency carrying a 400 KB compiled table that must be re-released whenever a legislature moves a clock, and the shell would still need its own copy (browser `Intl`) with no guarantee the two agree. An authored `standard offset + optional daylight rule` covers every US yard (second-Sunday-March / first-Sunday-November at 02:00 wall), the EU (last Sundays, transition expressed in wall time), Australia (southern-hemisphere rule, start month > end month) and the no-DST yards (Guam, Pearl Harbor, Arizona) with ~150 lines of arithmetic that already exists in embryo (`documents.rs:323-334` computes days-from-civil by hand). The rule is the yard's signed claim about its own clock, ledgered like every other document; a legislative change is a document edit, not a code release. The shell's dry run cross-checks the authored rule against the browser's `Intl` tz database at four instants and reports disagreement as a finding, so a mis-authored rule is caught before commit. **Zero new dependencies.**

## What already exists

- Door pattern: scope check → `read_import_body` → rejections whole (422 problem+json) → `?dry_run=true` preview → store → `ledger_document(DOCUMENT_REPLACED/REVERTED)` (`handlers.rs:2655-2772, 3025-3044`). Documents are one jsonb row per `(vessel, kind)` in `ingested_document` (0011), `schema_version` stamped by `put_document` (`pg_repo.rs:544-560`); the in-memory store keeps a `BTreeMap<VesselId, Doc>` (`memory.rs:2188-2227`). `Repositories` has `manning_book/set_manning_book/clear_manning_book` as the template (`repo.rs:309-340`).
- Boot loader `documents::load_demo_docs` finds documents by suffix and loads them through the store (`documents.rs:375-405`); `serve.rs:84-158` loads the XER after the documents via `schedule::load_xer(&InMemoryStore, …)`.
- XER: `ingest_xer(input, label)` → `parse_when` uses `chrono::NaiveDateTime` then `.and_utc()` (`xer.rs:145-151`); `planned_window` (`xer.rs:361-384`). Ten test call sites and the CLI call `ingest_xer`.
- Time: `wadl_domain::time::Timestamp` (epoch ms), `Window` half-open; `/timeframe` serves `now` + availability (`handlers.rs:463-477`) and `App.tsx:214-230` fetches it per hull.
- Shell: `clock.ts` (six formatters, all UTC, `Z` stamped), `watch.ts` (UTC-day blocks), `TimeControl.tsx` (`availabilityGrid` anchors the day grid on `utcDayStart`; `fmtInstant` uses `getUTC*`; date picker in UTC), `DailyOps.tsx:53-74` + `Reports.tsx:44-49` + `reports.ts:122-143` (hard-coded Days/Swing/Night windows, "(Z)"), `DeckExplorer.tsx:1436-1442` (manning step noun "half-shift"), `Proposals.tsx:40-41` (P6 change-request dates written in UTC — wrong for P6, which reads wall clock), `SourcesBoard.tsx` `SourceCard` + `stageX` → `confirmStaged` pattern.
- Shift vocabulary today: DailyOps "Days 0700–1530 / Swing 1530–2400 / Night 0000–0700"; the SME requirements say "second, maybe third shift … hand to night shift" (`requirements-vince` VR-03).

## Scope

1. `wadl_domain::civil` — pure civil time and the `YardClock` type, serde, validated, test-vectored.
2. The yard-clock document on both stores, a migration extending the document CHECK, a door (`GET`/`POST ?dry_run`/`POST …/revert`) in a new module, ledgered, leak-tested, in the SSP.
3. XER wall clock parsed in the hull's clock (door and boot); gap/overlap wall times accepted with a finding; the schedule of record remembers which clock it was parsed in.
4. `reference/cvn73/CVN73-clock.csv` loaded at boot; the 24-space seed world carries the same clock in memory; the PostgreSQL store defaults to UTC and says so until a clock is loaded through the door.
5. Shell: one pure mirror module, `clock.ts` formatters rendering yard-local with the zone shown once on the time strip, the watch grid and the transport bar on the yard's day, Daily Ops and the reports on the calendar's shifts by the yard's names, the P6 CSV in wall-clock, the Sources card with the door.

## Out of scope

- `wadl-cli ingest-xer` keeps parsing UTC (it loads the evidence table, not the served schedule; the CLI document door was deferred in slice 6). Its banner is not changed to avoid a touch for one line.
- Week/month bucketing in `LoadDigest.tsx` and `ScheduleTrace.tsx` stays on UTC Monday/1st (a 4–5 h boundary shift at week grain; not a pilot blocker).
- The hazard-log `since` column keeps requiring `Z`-suffixed instants (`documents.rs:307`); a bare wall-clock form belongs with the B3/B4 door work.
- A `PERSONAS` "the yard's day starts at…" landing and Tomorrow mode (H3).
- Seeding the clock row into `pg_seed.sql` (B10 generates the PG seed from the in-memory world; until then the PG default is honest UTC).
- Per-trade or per-zone calendars, holidays, and the crew "day of the shift" convention beyond "a shift belongs to the local calendar date it starts on".
- `FieldGuide.tsx` paragraph — not a new module; one sentence may be added if time allows.

## Contracts

### Document: `yard_clock` (kind string in both stores)

Stored shape (`wadl_store::memory::YardClockDoc { label: String, clock: wadl_domain::civil::YardClock }`; PG stores `clock` as the jsonb `doc`, label on the row):

```json
{
  "zone": "America/New_York",
  "standard_offset_minutes": -300,
  "daylight": {
    "offset_minutes": -240,
    "start": { "month": 3,  "week": 2, "weekday": 0, "minute_of_day": 120 },
    "end":   { "month": 11, "week": 1, "weekday": 0, "minute_of_day": 120 }
  },
  "watch_minutes": 240,
  "shifts": [
    { "name": "Days",  "start_minute": 420, "length_minutes": 510 },
    { "name": "Swing", "start_minute": 930, "length_minutes": 510 },
    { "name": "Mids",  "start_minute": 0,   "length_minutes": 420 }
  ]
}
```

`week` 1–5 (5 = last); `weekday` 0 = Sunday; `minute_of_day` is the wall clock *as it reads at the moment it moves* (US: 02:00 both ways; EU: 02:00 standard / 03:00 daylight). `daylight: null` for a yard with no DST. The default when no document is loaded is `YardClock::utc()` (`zone: "UTC"`, offset 0, no daylight, 240, the three demo shifts) — served with `"source": "default_utc"`.

Validation (rejections, the document refused whole): zone empty or not `Area/City`|`UTC`; an offset outside ±14 h or not a multiple of 15 min; daylight offset equal to standard; a transition field out of range; `watch_minutes` not in 60..=720 or not dividing 1440; no shifts or more than six; a blank or duplicate shift name; a shift length outside 1..=1440. Findings (warn, not refusals): shifts leave part of the day uncovered or overlap; the schedule of record was parsed in a different clock ("re-import CVN73-PIA26-full.xer to re-stamp its wall clock").

CSV form (the boot loader and the shell's picker; comments and blanks skipped; one record kind per line):

```
# CVN-73 yard clock — Norfolk. Offsets are ±HH:MM; transition = month,week(1-5, 5=last),weekday(sun..sat),wall time.
zone,America/New_York,-05:00
daylight,-04:00,3,2,sun,02:00,11,1,sun,02:00
watch,240
shift,Days,07:00,15:30
shift,Swing,15:30,24:00
shift,Mids,00:00,07:00
```

A shift's `end` before its `start` crosses midnight (`23:00,07:00` = 480 min). File suffix `-clock.csv`.

### `civil.rs` API (mirrored one-to-one in `yardClock.ts`)

```rust
pub fn days_from_civil(y: i32, m: u8, d: u8) -> i64;  pub fn civil_from_days(days: i64) -> (i32, u8, u8);  pub fn weekday(days: i64) -> u8;
pub struct Transition { month: u8, week: u8, weekday: u8, minute_of_day: u16 }   // fn day_in(&self, year) -> i64 days
pub struct DaylightRule { offset_minutes: i32, start: Transition, end: Transition }
pub struct ShiftDef { name: String, start_minute: u16, length_minutes: u16 }
pub struct YardClock { zone, standard_offset_minutes, daylight: Option<DaylightRule>, watch_minutes, shifts }
pub struct LocalTime { days: i64, minute_of_day: u16, millis_of_minute: u32, offset_minutes: i32 }
pub enum WallNote { Gap, Overlap }
impl YardClock {
  pub fn utc() -> Self;                                  pub fn validate(&self) -> Vec<String>;
  pub fn offset_at(&self, utc_ms: i64) -> i32;           pub fn local(&self, utc_ms: i64) -> LocalTime;
  pub fn to_utc(&self, days: i64, minute_of_day: u16) -> (i64, Option<WallNote>);
  pub fn day_start(&self, utc_ms: i64) -> i64;           pub fn next_day_start(&self, utc_ms: i64) -> i64;
  pub fn watch_start(&self, utc_ms: i64) -> i64;         pub fn watch_end(&self, utc_ms: i64) -> i64;
  pub fn watches_of(&self, utc_ms: i64) -> Vec<Window>;  pub fn shift_windows(&self, utc_ms: i64) -> Vec<(String, Window)>;
  pub fn offset_label(minutes: i32) -> String;           // "UTC−04:00"
}
```

Semantics, fixed by the vector file: daylight is in force for `t` when `start_utc(year) ≤ t < end_utc(year)`, or when start month > end month, when `t` is *not* in `[end_utc, start_utc)` (southern hemisphere; year taken from the UTC civil year of `t`). `to_utc`: candidates `u_s = wall − standard`, `u_d = wall − daylight`; `u_s` valid iff not daylight at `u_s`, `u_d` valid iff daylight at `u_d`; both valid → `u_d` with `Overlap` (first occurrence); neither → `u_s` with `Gap`; else the valid one. Watches are bounded by wall-clock hours that are multiples of `watch_minutes` on the local date (so the 00–04 watch is five hours on the fall-back night and three on the spring-forward night, and the label still reads `00–04`). A shift belongs to the local calendar date its start falls on; its window is `to_utc(date, start) .. to_utc(date + carry, start + length)`.

### Routes (`routes.rs` rows; regenerate leak tests and SSP)

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/api/vessels/:id/yard-clock` | — | `{ "label": "CVN73-clock.csv" \| null, "source": "document" \| "default_utc", "clock": {…}, "now_local": "2026-09-04 09:15", "offset_now": "UTC−04:00" }` |
| POST | `/api/vessels/:id/yard-clock` | `?dry_run=true`; `{ "label": string, "clock": {…} }` | `{ "stored": bool, "label", "findings": [{ "severity": "warn"\|"info", "text" }], "preview": { "now_local", "offset_now", "transitions": [{ "at_ms", "local": "2026-11-01 02:00 → 01:00", "to": "UTC−05:00" }], "shifts_today": [{ "name", "start_ms", "end_ms", "local": "07:00–15:30" }], "schedule_of_record": { "label", "parsed_in" } \| null } }`; 422 problem+json `"the clock was refused whole: …"` |
| POST | `/api/vessels/:id/yard-clock/revert` | — | `{ "reverted": true }` (back to `default_utc`) |

Leak-test sample body: `{"label":"leak test","clock":{"zone":"UTC","standard_offset_minutes":0,"daylight":null,"watch_minutes":240,"shifts":[{"name":"Days","start_minute":420,"length_minutes":510}]}}`.

`GET /api/vessels/:id/timeframe` gains `"yard_clock": { "label", "source", "clock" }` (same object as the GET above) so the shell has the clock with the first read it already makes per hull.

`POST …/schedule-of-record` (both dry run and commit) gains `"clock": { "zone", "label" }` and `"wall_clock_findings": [ "line 812: A4020 start 2026-03-08 02:30 does not exist in America/New_York — read as 02:30 standard (07:30Z)" ]` (a finding, not a rejection). `ScheduleOfRecord` gains `#[serde(default)] parsed_in: Option<String>` (`"America/New_York · CVN73-clock.csv"`); `SCHEDULE_REPLACED` detail carries it.

Ledger: `DOCUMENT_REPLACED` with `kind: "yard_clock"`, label, counts `{ "zone", "shifts" }`; `DOCUMENT_REVERTED` kind `yard_clock`. Both stores, via `ledger_document` (make it `pub(crate)`).

### Migration `migrations/NNNN_yard_clock_document.sql`

```sql
-- NNNN: the yard's clock joins the ingested documents (pilot barrier B6).
-- One row per hull: IANA zone, standard offset, an optional daylight rule as two
-- nth-weekday transitions, the watch length, the shifts by the yard's names.
-- Evaluated by wadl_domain::civil on the server and its mirror in the shell; a
-- tz database would be a dependency that must be re-released when a clock law
-- changes, where this is a document that goes through a door with a ledger line.
ALTER TABLE ingested_document DROP CONSTRAINT ingested_document_kind_check;
ALTER TABLE ingested_document ADD CONSTRAINT ingested_document_kind_check
  CHECK (kind IN
    ('schedule_of_record','zone_register','budget_book','manning_book',
     'geometry_register','compartment_register','coupling_register','yard_clock'));
```

RLS is inherited from the table's existing policy; no new table. `DOCUMENT_SCHEMA_VERSION` stays 1 (the SoR gains an optional field, read with `serde(default)`).

### Store trait (`repo.rs`), both implementations

`yard_clock(scope, vessel) -> Result<Option<YardClockDoc>>`, `set_yard_clock(scope, vessel, YardClockDoc)`, `clear_yard_clock(scope, vessel)`. In-memory also gets the sync inherent `InMemoryStore::yard_clock_of(vessel) -> YardClock` (default UTC) so `schedule::load_xer` keeps its signature and reads the clock itself.

### Env / CLI / boot

No new env. `WADL_DEMO_DOCS` picks up `*-clock.csv` first (before the XER, which needs it); banner line `yard clock:           CVN73-clock.csv — America/New_York, 3 shifts`. `LoadedDocuments.clock: Option<(String, String)>` (label, zone). The seed world (`InMemoryStore::demo_at`) inserts the Norfolk clock for the three carriers, label `"seed · Norfolk"`.

### Shell modules

- `yardClock.ts` (new, pure): the types above, `offsetAt`, `local`, `toUtc`, `dayStart`, `nextDayStart`, `watchStart`, `watchEnd`, `watchesOf`, `shiftWindows`, `offsetLabel`, `validate`, `parseClockCsv`, `intlCrossCheck(clock, instants[]) → findings` (browser tzdb vs the rule at availability start/end and the two transitions), `UTC_CLOCK`.
- `clock.ts`: becomes the one place the yard clock is *applied*. `setYardClock(doc)` / `currentClock()`; `fmtDay/fmtDate/fmtTime/fmtDayTime/fmtMonth` render local wall clock — the suffix is `Z` only while the clock in effect is the UTC default (the honest marker), nothing otherwise (the zone is shown once); `fmtStamp` (ledger, print footers, CSV `cut_at`) always carries the numeric offset: `2026-09-04 09:15 −04:00`. New: `fmtWall(ms)` (`07:00`) and `zoneLabel()` (`America/New_York · UTC−04:00`, or `UTC · no yard clock loaded`).
- `watch.ts`: `dayStart`, `blockStart`, `blockEnd`, `blockLabel` (`00–04`, no Z), `watchBlocksOf(ms)` all delegate to the current clock; `WATCH_MS`/`DAY_MS` stay as horizon steps.
- `TimeControl.tsx`: the day grid is the yard's watches — `availabilityGrid("day").start = firstWatchAtOrAfter(availability.start)`; `clampInto`/`lastNotch`/`snap`/playback for the day horizon use `blockStart`/`blockEnd` (uniform arithmetic stays for week/month/availability); `click(±1)` at Day lands on the same watch index on the adjacent local day; the date input reads and writes the local date; `fmtInstant` uses local parts; the strip shows the zone once: `America/New_York · UTC−04:00` (amber `UTC · no yard clock — load one in Data Sources` when default).
- `DailyOps.tsx`: `SHIFTS` replaced by `shiftChoices(clock)` from `reports.ts` — chips read `This instant · Days 0700–1530 · Swing 1530–2400 · Mids 0000–0700`; the slice label reads `Days 0700–1530 · 09/04` (no `(Z)`); the printed board's footer carries `fmtStamp` and the zone once. `Shift` becomes `"instant" | string` (the shift's name).
- `reports.ts`: `shiftWindow(asOfMs, shift)` from the clock (label `Days 0700–1530`); `shiftChoices(clock)`; the print header and CSV `cut_at` carry the offset; `LAYER_NOTES` gains `Clocks: the yard's, America/New_York (UTC−04:00 at the cut).`
- `Reports.tsx`: its local `SHIFTS` replaced by `shiftChoices`.
- `Proposals.tsx`: `p6Date` writes the yard's wall clock (P6 reads wall clock); header comment says `Start/Finish in the yard's clock (America/New_York)`.
- `DeckExplorer.tsx`: `utcDayStart` → `dayStart`; the manning step noun `half-shift` → `watch` (the manning book's "per half-shift" wording in `SourcesBoard`/`api.ts` is left; the card text says "per watch (4 h)" only if the card is touched anyway).
- `api.ts`: `Timeframe.yard_clock`; `getYardClock`, `importYardClock(id, vesselId, label, clock, dryRun)`, `revertYardClock`.
- `App.tsx`: on timeframe, `setYardClock(frame.yard_clock)` and bump a `clockEpoch` state passed down with `frame` so boards re-render; the `dataEpoch` bump after a Sources commit already re-fetches the timeframe.
- `SourcesBoard.tsx`: a `Yard clock` `SourceCard` — status `INGESTED` or amber `DEFAULT · UTC`; name `CVN73-clock.csv — America/New_York`; lines `standard UTC−05:00 · daylight UTC−04:00 from 2nd Sun Mar 02:00 to 1st Sun Nov 02:00`, `watch 4 h · Days 0700–1530 · Swing 1530–2400 · Mids 0000–0700`, and the SoR finding when present; upload `⭱ Upload clock CSV` → `parseClockCsv` → dry run → findings incl. `intlCrossCheck` → `confirmStaged`; revert `back to UTC — every clock on screen is Z again`.

## Files

New: `crates/wadl-domain/src/civil.rs`; `crates/wadl-api/src/yard_clock.rs` (handlers, CSV parser, findings, preview); `migrations/NNNN_yard_clock_document.sql`; `reference/cvn73/CVN73-clock.csv`; `reference/clock/yard-clock-vectors.json`; `crates/wadl-api/tests/yard_clock.rs`; `shell-web/src/yardClock.ts`; `shell-web/src/yardClock.test.ts`.

Touched (Rust): `crates/wadl-domain/src/lib.rs` (`pub mod civil`); `crates/wadl-ingest/src/xer.rs` (`ingest_xer_in(input, label, &YardClock)`; `ingest_xer` delegates with `YardClock::utc()`; `parse_when` returns `(Timestamp, Option<WallNote>)`; `XerIngestReport.wall_clock_findings: Vec<String>`); `crates/wadl-ingest/tests/xer.rs` (one test); `crates/wadl-store/src/repo.rs`, `memory.rs` (`YardClockDoc`, map, three impls, `yard_clock_of`, seed clock, SoR `parsed_in`), `pg_repo.rs` (three impls over `document/put_document/delete_document`); `crates/wadl-store/tests/pg_rls.rs` (round trip); `crates/wadl-api/src/lib.rs` (`pub mod yard_clock`, three routes), `routes.rs` (three rows), `schedule.rs` (`parse_xer_in(label, xer, &clock)`, `load_xer` reads `store.yard_clock_of`), `handlers.rs` (`import_schedule` reads the clock and calls `parse_xer_in`; `timeframe` adds `yard_clock`; `ledger_document` `pub(crate)`), `documents.rs` (loader: `-clock.csv`, `LoadedDocuments.clock`), `bin/serve.rs` (banner line); generated: `crates/wadl-api/tests/generated_leak_test.rs`, `docs/ssp-input.md`.

Touched (shell): `clock.ts`, `watch.ts`, `watch.test.ts`, `TimeControl.tsx`, `TimeControl.test.ts`, `DailyOps.tsx`, `reports.ts`, `reports.test.ts`, `Reports.tsx`, `Proposals.tsx`, `DeckExplorer.tsx`, `api.ts`, `App.tsx`, `SourcesBoard.tsx`.

Docs: `docs/execution-plan.md` row 5 → landed; `README.md` run section one line (`CVN73-clock.csv`); `docs/demo-script.md` §1 two sentences.

That is 26 source files plus tests and generated output — over the fifteen-file preference because the barrier spans the server and every clock in the shell. The build order below puts a cut line after item 6: everything above it closes B6 on the boards; the tail is the reports and P6 CSV.

## Tests

Shared vectors `reference/clock/yard-clock-vectors.json`: `{ "clocks": { "norfolk": {…}, "utc": {…}, "guam": {…}, "sydney": {…} }, "offset_at": [ { "clock", "utc_ms", "minutes" } ], "to_utc": [ { "clock", "date": "2026-03-08", "minute_of_day": 150, "utc_ms", "note": "gap" } ], "day_start": [...], "watch_start": [...], "watches_of": [ { "clock", "utc_ms", "starts": [...], "labels": ["00–04", …] } ], "shift_windows": [ { "clock", "utc_ms", "windows": [ { "name", "start_ms", "end_ms" } ] } ] }` — including 2026-03-08 06:59:59Z / 07:00:00Z, 2026-11-01 05:59:59Z / 06:00:00Z, the gap 02:30 → 07:30Z, the overlap 01:30 → 05:30Z, the 25-hour 2026-11-01 day (00–04 watch = 5 h), a Sydney January instant (daylight across new year), and a Mids shift crossing midnight.

Rust — `crates/wadl-domain/src/civil.rs` `mod tests`: `the_shared_vectors_hold` (`include_str!("../../../reference/clock/yard-clock-vectors.json")`, every section); `civil_days_round_trip_over_four_centuries`; `a_wall_time_in_the_spring_gap_resolves_standard_and_says_gap`; `a_wall_time_in_the_autumn_overlap_takes_the_first_occurrence`; `a_southern_rule_is_daylight_in_january`; `validate_refuses_a_watch_that_does_not_divide_the_day_and_a_duplicate_shift`. `crates/wadl-ingest/tests/xer.rs`: `wall_clock_is_read_in_the_yard_clock` (a 06:00 start on 2026-08-10 → 10:00Z under Norfolk; UTC form unchanged) and `a_start_in_the_gap_is_accepted_with_a_finding`. `crates/wadl-api/tests/yard_clock.rs`: `the_door_refuses_a_malformed_clock_whole`; `a_dry_run_previews_transitions_and_stores_nothing`; `a_commit_is_ledgered_and_a_revert_returns_to_utc`; `the_timeframe_carries_the_clock_in_effect`; `the_schedule_door_parses_the_xer_in_the_yard_clock` (commit clock, import a two-task XER, `planned.start` is the local wall clock's UTC instant, response carries `clock` and `parsed_in`); `the_reference_hull_boots_with_its_clock` (`load_demo_docs` on `reference/cvn73`, `loaded.clock` is `Some`, `GET /timeframe` says `America/New_York`); `the_clock_door_warns_when_the_schedule_was_parsed_elsewhere`. `crates/wadl-store/tests/pg_rls.rs`: `the_yard_clock_round_trips_and_stays_in_tenant`. Generated leak tests: three new.

Shell — `yardClock.test.ts`: `agrees with the shared vector file` (reads `../../reference/clock/yard-clock-vectors.json` via `fs`), `parses the reference hull's clock CSV` (reads `reference/cvn73/CVN73-clock.csv`, three shifts, Mids 420 min), `the fall-back day has six watches and the first is five hours`, `validate mirrors the server's refusals`. `watch.test.ts`: existing cases under `UTC_CLOCK` unchanged; `blocks are bounded by local wall hours under Norfolk`. `TimeControl.test.ts`: existing five, plus `the day grid's notches are the yard's watches across the November fall-back and playback still advances strictly`, `the date picker keeps the watch index on the picked local day`. `reports.test.ts`: `shift windows follow the calendar and name the shifts the yard's way`, `the CSV cut line carries the offset once`.

## Acceptance

1. `scripts/dev.sh`; banner shows `yard clock: CVN73-clock.csv — America/New_York, 3 shifts` and `schedule of record … parsed in America/New_York`.
2. `curl -H x-org-id:… -H x-assigned-vessels:… localhost:8080/api/vessels/…73/timeframe` → `yard_clock.source == "document"`, `clock.zone == "America/New_York"`; `…/activities?…` → an activity the XER lists at `2026-07-27 06:00` has `planned.start == 1785319200000` (10:00Z).
3. Daily Ops as Foreman: chips read `This instant · Days 0700–1530 · Swing 1530–2400 · Mids 0000–0700`; the `Days` slice on the as-of day spans 11:00Z–19:30Z (verify by the row's slot text `09/04 06:00–14:00` against the XER); no `(Z)` anywhere on the board; the time strip shows `America/New_York · UTC−04:00` once.
4. Time control at Day: chips `00–04 … 20–24`; jump to 2026-11-01: the `00–04` chip's title says it is five hours; `▶` walks every watch and stops at the availability end (no frozen notch).
5. Data Sources: the Yard clock card reads `INGESTED · CVN73-clock.csv — America/New_York`. Upload a CSV with `watch,100` → 422 named in the card, nothing stored. Upload a Guam clock (`zone,Pacific/Guam,+10:00`, no daylight) → dry-run findings include `the schedule of record CVN73-PIA26-full.xer was parsed in America/New_York — re-import to re-stamp`; confirm → the strip reads `Pacific/Guam · UTC+10:00`; the ledger shows `DOCUMENT_REPLACED · yard_clock · CVN73-guam.csv`. Revert → the strip reads amber `UTC · no yard clock loaded`, every time carries `Z` again, ledger shows `DOCUMENT_REVERTED · yard_clock`.
6. Reports → Shift sheet → Days: scope `Days 0700–1530 · all zones`; the header's cut reads `cut 09/04 09:15` and the footer names `America/New_York (UTC−04:00 at the cut)`; the CSV's `cut_at` is `2026-09-04 09:15 −04:00`.
7. Sequence Board → Proposals → change-request CSV: Start/Finish columns are wall-clock (`2026-09-08 07:00`), header says the zone.
8. `WADL_DEMO=seed scripts/dev.sh`: the 24-space hull renders Norfolk-local with `seed · Norfolk` on the card. With `DATABASE_URL` and no document: the strip is amber UTC, the card offers the door, and `pg_rls` proves the round trip.
9. All gates green: fmt, clippy `-D warnings` pedantic, `cargo test --workspace --all-features`, `gen-leak-tests --check`, `gen-ssp --check`, `pg_rls`, `npm run typecheck`, `vitest`, `npm run build`.

## Demo moment

Open Daily Ops as the Foreman at 0700. Yesterday the day-shift chip said `Days 0700–1530` and covered three in the morning; today the strip says `America/New_York · UTC−04:00` once, the chip is the yard's own day, and the row for the shaft-alley weld reads `06:00` — the number the scheduler typed into P6. Scrub to the first Sunday in November: the `00–04` watch is five hours long, and the board says so instead of pretending the night was ordinary. Open Data Sources, revert the clock: every time on every screen turns back into a `Z`-stamped UTC instant, in amber, because the product would rather say "no yard clock" than guess one.

## Depends on / conflicts with

Depends on nothing unlanded (slices 1–9 are in). Conflicts: any slice touching `handlers.rs` `import_schedule`/`timeframe` (B4 field-map door, H4 run history) or `TimeControl.tsx`/`clock.ts` (H3 Tomorrow mode) must rebase on this; B5 (person on every ledger row) and this slice both edit `ledger_document` — take whichever lands first. `documents.rs` loader order: the clock loads first; a later hazard-log wall-clock form (B3/B4) should call `YardClock::to_utc`.

## Risks

- A mis-authored daylight rule is wrong by an hour for half the year. Mitigation: the dry-run preview lists the transitions as local dates and the shell cross-checks the rule against the browser's tz database at four instants; disagreement is a warn finding on the card.
- The shell formatters read a module-level clock; a board rendered before the timeframe lands shows UTC with `Z` for one paint. Acceptable because the marker is honest; `clockEpoch` re-renders on arrival.
- Re-stamping the XER shifts every ingested instant by the offset; `crates/wadl-api/tests/activities.rs` and the issues golden compare live-vs-as_of rather than absolute ms, but any test that pins a sample-XER instant must move (grep `planned` in `tests/` before building).
- The 25/23-hour day breaks the "six equal blocks" assumption in `TimeControl`'s playback and clamping; the design routes the day horizon through `blockStart/blockEnd` and pins it with a test across 2026-11-01.
- `DEMO_ANCHOR_MS` is 07:15 UTC; the seed's "coating three hours into cure" story still holds (offsets from the anchor are zone-free), but the seed's `Days` shift now covers a different set of seeded windows — check the demo-script numbers after the build.
- P6 server time: if the yard's P6 server runs in a different zone from the yard floor, the XER is that zone's wall clock. The clock document is *the schedule's* clock; confirm with the scheduler (below).

## Needs from the yard

- The IANA zone and the shift names and hours the yard actually uses (Days/Swing/Mids is the demo's guess), and whether a night shift is booked to the date it starts or ends on the pass-down sheet.
- Confirmation from the scheduler that P6 exports carry the yard's wall clock (P6 writes server-local time into the XER) — otherwise the document must name the P6 server's zone.
- Whether the yard runs a two-shift or a 4-10 week; a shift set that does not cover the day is a finding, and someone must say it is intended.

## Estimate

About 7 agent-hours across two sittings. Sitting one (server, ~3.5 h): `civil.rs` + vectors 1.0; store, migration, door, ledger, leak/SSP regen 1.0; XER in zone, boot loader, seed, `timeframe`, API tests 1.0; gates 0.5. Sitting two (shell, ~3.5 h): `yardClock.ts` mirror + vector test 1.0; `clock.ts`/`watch.ts`/`TimeControl.tsx` + tests 1.0; `DailyOps`/`reports`/`Reports`/`Proposals`/`DeckExplorer` 0.5; `api`/`App`/Sources card 0.5; browser verification and screenshots 0.5. Build order: civil → store → door → XER → boot/seed → shell mirror → clock/watch/TimeControl → DailyOps → **cut line** → reports/P6 CSV → Sources card → docs.
