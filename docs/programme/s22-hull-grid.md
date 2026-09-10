# S22 — The hull grid: one document that places everything

Date 2026-09-09 · head `b05b5d8` · branch `claude/kickoff-from-docs-arhiib`.
Designed by the naval architect's council pass (`docs/council/7-hull-grid-template.md`);
answers the customer's direction that the implementers establish the grid —
frame by frame, deck by deck, port and starboard, zone by zone — once per
programme per vessel, and the system populates compartments and zones from
it. Wave 5, after S17/S20; server first, then shell; one migration; no new
dependency.

## Summary

Today the hull's shape is spread across four places that never meet: the
class row (`frame_min/max` 1..260, read by nothing), the register's deck
rows (no placard digit — `03 ↔ gallery` exists only in
`tools/gen_cvn73_hull.py:32-47`), the geometry register's coverage bands,
and five hard-coded `280`s in the shell. Zone membership is typed by hand
per row and audited after commit; zone names and owners are in no document;
the chart has no transverse dimension; frame 290 on a 273-frame ship passes.

This slice adds **one document, the hull grid** — frame table with FP, AP
and spacing changes; deck table with the placard digit, ordinal, name,
optional height and coverage bands; tiers generated from the USN convention
— and makes the chart (v2: names, owners, optional side) and an
**exceptions** document sit on it. Compartments are **placed from their
numbers at read time**, once, on the server (the `overlay_geometry` pattern,
`handlers.rs:174-198`), with `placement` and `zone_source` on every served
row; the register's `zone` column becomes optional; two silent errors become
refusals (a frame off the ship, a deck digit contradicting the deck code);
the chart must partition the grid; next-door reach is feet through the
station table; deck penetrations step through coverage; the shell reads its
frame span from the grid. Stored documents read unchanged; a hull with no
grid behaves exactly as today.

**Decisions the builder does not revisit:** the grid is per hull (a `class`
field and a content hash; no class-level document yet); placement is derived
at read, never written into the register document; a filled `zone` column is
an assertion, a blank one a derivation, an exception an override with a
reason; a chart that does not partition is refused, not audited; the placard
frame is an integer, the frame table may carry half-frames; the reference
hull is regenerated onto the grid so the demo is the filled template; no new
crate.

## What already exists

- `UsnCompartment::parse` (`crates/wadl-domain/src/compartment.rs:107-141`):
  deck string, integer frame, side by parity, usage 1–2 letters.
- `RegisterDeckSummary`, `RegisterSpaceSummary { …, zone, frame?, side? }`,
  `ZoneBoundSummary { zone, lo, hi, top_deck?, bottom_deck? }`,
  `DeckCoverageSummary` (`crates/wadl-store/src/model.rs:100-203, 443-460`);
  `register_compartments` (`memory.rs:681-727`), preferred by the PostgreSQL
  read (`pg_repo.rs:876-887`).
- `zone_audit` (`handlers.rs:1785-1862`), `zone_rejections` (`:2150-2215`),
  `import_zones` (`:2086-2144`), `zone_adjacent`/`adjacency_reasons`
  (`:1891-2068`, `BOUNDARY_FRAMES = 8`), `geometry_findings` (`:2520-2599`),
  `import_geometry` (`:2632-2730`), `register_rejections`/`register_findings`
  (`:2839-2952`); `documents.rs` parsers (`:133-239`),
  `derive_vertical_edges` (`:43-98`), the loader with staged register and
  geometry (`:549-640`).
- Shell: `zones.ts::zoneBands`, `ingest.ts` parsers (`:39-152`),
  `deckGeometry.ts` (`FRAME_SPAN = 280`), `deckSheets.ts` CV-67 calibration,
  the chart door on Data Sources and the Explorer.
- Reference hull at head: 476 spaces, 12 decks, 10 blocks; the chart
  partitions all 3,288 (deck, frame) cells; all 476 hand-typed zones equal
  their block-derived zone; 5 surveyed extents overrun their deck's band
  (`4-248-1-E`, `4-248-2-E`, `6-247-3-V`, `6-247-4-V`, `7-244-0-V`).

## Scope

1. `crates/wadl-api/src/hull_grid.rs`: grid, chart v2 and exceptions
   parsers; `place()`; refusals and findings; the three doors.
2. Store: `HullGrid`, `ZoneDef`, `ZoneException` as documents on both
   backends; migration `0022_hull_grid_document.sql`.
3. Read path: every compartment read placed against the grid; `zone_audit`
   v2; reach in feet; coverage-aware vertical edges.
4. Loader: `-grid.csv` before the register, `-exceptions.csv` after zones;
   the dry run stages both.
5. Shell: grid and exceptions cards; frame span from the grid; zone names
   and owners on the lanes and zone boards; ruler in frames and feet; the
   plate's grid label and a notice when it is not this hull's.
6. `tools/gen_cvn73_hull.py` emits the grid, chart v2, coverage from the
   spaces, register with `zone` blank; docs, playbook checklist, runbook.
7. Routes, leak tests, SSP, roles (`commit_document`), execution-plan row.

## Out of scope

- Transverse offsets and polygons (`geometry-accuracy.md:158`); the `tier`
  table's optional `offset_ft` lets them land without a shape change.
- Control-point plate calibration (`geometry-accuracy.md:121-140`); a plate
  only *declares* the grid it was calibrated on here.
- Plates out of the static bundle (council HG-4, an ATO item with its own
  route and asset store, before any real plate is loaded).
- A class-level grid for sister hulls; `owner` as a person id.

## Contracts

### The grid CSV (`<HULL>-grid.csv`, kind `hull_grid`)

The filled CVN-73 example is `reference/cvn73/CVN73-grid.csv` (generated;
this project's reasoning from public dimensions — 1,092 ft LOA, 1,040 ft
between perpendiculars, 4 ft spacing — which a yard replaces with its
Booklet of General Plans extract). Its shape:

```
hull,CVN-73,CVN-68,usn_deck_frame_side_use,32
frame,0,0,fp
frame,260,1040,ap
frame,273,1092,last
deck,flight,04,-4,Flight Deck (04 level)
deck,gallery,03,-3,Gallery Deck (03 level)
deck,Main,1,1,Main Deck (hangar)
deck,3rd,3,3,Third Deck
deck,db,8,8,Inner Bottom          # … the twelve decks of the register
band,flight,0,273
band,Main,10,265
band,4th,12,260                   # was 256: the two steering-gear rooms overran it
band,2ndplat,22,251
band,hold,30,256
band,db,34,236                    # … one or more bands per deck
```

Rules: `hull` once (`reach_ft` integer, default 32). `frame` rows sorted,
stations strictly increasing, exactly one `fp` and one `ap`, the last row
`last`; frames between rows interpolate (integer feet); a half-frame is
`148.5`. `deck`: unique code, unique `placard_digit`, unique ordinal,
optional `height_ft`. `band`: within the frame table, several per deck,
coalesced on read. `tier,<digit>,<side>,<label>[,<offset_ft>]` optional;
absent, the USN convention generates `0 centreline, 1 starboard, 2 port, 3
starboard, 4 port, …` up to the highest digit the register uses. Comments
and blanks skipped; any other record kind refuses the file naming the line.

### The zone chart v2 (`<HULL>-zones.csv`, kind `zone_register`)

```
zone,Z4,Propulsion Plant & Midships,Zone Manager 4
block,Z4,96,191,2nd,2ndplat
block,Z4,116,175,hold,db
```

`block` gains an optional seventh column `side ∈ all|port|starboard|centreline`
(default `all`). A row whose first column is neither `zone` nor `block` is a
legacy block row and reads as today; a zone code literally `zone` or `block`
is refused. `ZoneRegister` gains `zones: Vec<ZoneDef { code, name, owner }>`
(default empty); `ZoneBoundSummary` gains `side: Option<String>` (default).
With a grid stored, the chart is partition-checked: every (deck, frame,
side) cell inside the grid's bands is covered exactly once, else refused
with the first twelve cells named.

### The exceptions (`<HULL>-exceptions.csv`, kind `zone_exceptions`)

`space,<placard>,<zone>,<reason>` — the reason runs to end of line (commas
kept, as the hazard log does). Refused whole for a placard not on the
register, a zone not on the chart, a blank reason, or a duplicate placard.

### Placement (served on every compartment read)

`CompartmentSummary` gains, all `serde(default)`: `placement: "grid" |
"register" | "parsed" | "unknown"`, `station_ft: Option<i32>`, `tier:
Option<u32>`, `zone_source: "derived" | "register" | "exception"`.
`hull_grid::place(grid, chart, exceptions, &mut rows)`: parse the placard;
the deck is the grid deck whose `placard_digit` equals the parsed deck field
(a mismatch with the row's `deck_code` was refused at the door); frame from
the row's column else the parse; `station_ft` by interpolation; `tier` = the
side digit; zone = the exception if any, else the row's `zone` if filled,
else the first block containing (ordinal, frame, side); `zone_source`
accordingly. An unparseable row keeps the register's words with
`placement = register|unknown`. Memoised per (hull, document epoch).

### Doors

`GET /api/vessels/:id/grid` → `{ label, hull, frames, decks, bands, tiers,
first_frame, last_frame, fp, ap, reach_ft, findings }` or `{ grid: null }`.
`POST …/grid[?dry_run=true]` body `{ label, hull, frames, decks, bands,
tiers }` → 422 problem+json with every refusal (§rules, plus a stored
register whose deck codes or digits the grid does not carry), or `{ stored,
label, counts, findings }` with findings `class_frame_disagreement`
(`frame_min/max` vs `fp/ap`), `register_decks_superseded`,
`geometry_bands_superseded`, and the chart's partition audit against the new
bands. `POST …/grid/revert`. `GET/POST/POST revert …/zone-exceptions` in the
same shape. Ledgered `DOCUMENT_REPLACED`/`DOCUMENT_REVERTED` with kind,
label, counts and the grid's sha256 in `counts.hash`; the POSTs under
`commit_document`.

`GET /zones` gains `zones: [{ code, name, owner, blocks, spaces }]`; the
audit gains `derived`, `asserted`, `overrides: [{ compartment, zone,
derived, reason }]`, `side_contradiction: [{ compartment, side, zone,
zone_side }]`. The register door gains two refusals — `3-290-2-E: frame 290
is not on this hull (frames 0–273)`, `3-148-2-E is listed on 4th, whose
placard digit is 4` — and dry-run findings `outside_deck_coverage` (placard
frame outside its deck's bands) and, with a chart stored, a `zones` preview
`{ derived, asserted, disagreeing: [...] }`. `zone_adjacent.basis` reads
`within 32 ft (8 frames at 4 ft) …`, the reach converted at the space's
station; `derive_vertical_edges` and `adjacency_reasons` take the bands —
the deck below at frame f is the next ordinal whose bands contain f.

### Shell

`api.ts`: the grid and exceptions trios, `ZoneChart.zones`, the audit and
placement fields. `ingest.ts`: `parseGridCsv`, `parseExceptionsCsv`,
`parseZoneCsv` v2 and legacy. `SourcesBoard.tsx`: a *Hull grid* card first
in the ship group (`NOT LOADED` amber, *frame scale assumed 0–280; load the
grid before the register*, or `INGESTED` with `frames 0–273 · FP 0 · AP 260
· 12 decks · 12 bands`) and a *Zone exceptions* card. `deckGeometry.ts`:
`frameToX(frame, span)` with the span from the grid, 280 the fallback; the
five call sites read `grid?.last_frame`. The Explorer's readout shows `Fr
148 · 592 ft` with a grid. `deckSheets.json` gains `gridLabel` per plate
(`CV-67 BoGP 2011`); the plate footer reads *plate calibrated on CV-67 BoGP
2011 — not this hull's grid* whenever it differs from the served label.
Zone headings read `Z4 · Propulsion Plant & Midships · <owner>` on
`ZoneLanes.tsx`, the zone strip and the zone day sheet, code in the tooltip.
Zone focus and `zoneBands` are unchanged: they draw what is served.

## Files

New (4): `crates/wadl-api/src/hull_grid.rs`, `crates/wadl-api/tests/hull_grid.rs`,
`migrations/0022_hull_grid_document.sql`, `reference/cvn73/CVN73-grid.csv`.
Touched (server, 9): `wadl-store/src/{model,repo,memory,pg_repo}.rs`,
`wadl-api/src/{handlers,documents,routes,roles,lib}.rs`. Touched (shell, 12):
`api.ts`, `ingest.ts`, `SourcesBoard.tsx`, `deckGeometry.ts`, `deckSheets.ts`,
`deckSheets.json`, `DeckExplorer.tsx`, `ShipView.tsx`, `VerticalTrace.tsx`,
`CascadeBoard.tsx`, `ZoneLanes.tsx`, `reports.ts`. Touched (other): the
generator and its three reference CSVs, `docs/{zone-scheme,geometry-accuracy,
pilot-playbook,runbook,execution-plan}.md`, the regenerated `docs/ssp-input.md`
and `tests/generated_leak_test.rs`, `wadl-store/tests/pg_rls.rs`.

## Tests

`hull_grid.rs` (unit): `the_frame_table_interpolates_and_refuses_backwards_stations`;
`a_half_frame_is_a_station`; `tiers_generate_from_the_usn_convention`;
`the_chart_v2_reads_legacy_rows`; `a_chart_that_does_not_partition_is_refused_naming_the_cell`;
`a_side_split_chart_partitions`; `placement_derives_the_zone_and_names_its_source`;
`an_exception_overrides_and_is_reported`; `a_frame_off_the_ship_is_refused`;
`a_deck_digit_contradiction_is_refused`;
`coverage_aware_vertical_edges_skip_a_missing_platform`. `tests/hull_grid.rs`
(API, memory and PostgreSQL through `support::mod`): the door dry-runs,
commits, ledgers with the hash, reverts; the register refuses the two new
sentences; `GET /zones` on the booted reference hull reports `derived ==
476, asserted == 0, overrides == 0, out_of_bounds == 0`; `GET /geometry`
findings `outside_deck_coverage == 0` after regeneration; the leak and
weakest-role tests are generated. `pg_rls.rs`:
`the_hull_grid_and_exceptions_round_trip_and_stay_in_tenant`. Shell vitest:
the two parsers' shapes and refusals, `parseZoneCsv` v2 and legacy,
`frameToX` with a span; `words.mjs` (S17) edited in the same commit as the
zone heading. `gen-leak-tests` and `gen-ssp` clean; the gate green on both
stores.

## Acceptance

1. Boot the reference hull: the banner adds `hull grid: CVN73-grid.csv —
   frames 0–273, FP 0, AP 260, 12 decks, 12 bands` before the register line;
   `GET /zones` reads `derived: 476` and `zones[3].name == "Propulsion Plant
   & Midships"`; `GET /geometry` findings carry no `outside_deck_coverage`.
2. Dry-run a register with `3-290-2-E` on `3rd` and `3-148-2-E` on `4th`:
   422 naming both sentences; nothing stored; the ledger unchanged.
3. Dry-run the chart with Z4's second block removed: 422 `hold Fr 116
   centreline is in no zone`; with a block widened to overlap: `2nd Fr 96
   starboard is in Z3 and Z4`.
4. Commit `space,3-100-0-T,Z2,trunk serves the hangar`: the audit's
   `overrides` names it with `derived: Z4`; the Explorer shows it in Z2 focus
   with the reason in its tooltip; the ledger row names the person.
5. Revert the grid: every read returns to today's behaviour (span 280,
   coverage from the geometry register, `placement: register`, `zone_source:
   register`); the card reads `NOT LOADED`.
6. The playbook's data-load day carries the new-vessel checklist, each step
   a dry run then a commit with its ledger `seq` on the sign-off sheet: (a)
   hull statement; (b) **grid** — FP, AP, spacing changes, last frame, decks
   with placard digits and ordinals, bands per deck from the general plans;
   expect `class_frame_disagreement` where the statement guessed; (c)
   **chart** — the zone managers' blocks, names, owners; expect partition
   refusals on the first pass (every gap is a frame nobody owns); (d)
   **register** — the compartment list with `zone` blank; expect
   `outside_deck_coverage` where the plans' bands are coarse and the two
   refusals wherever the extract was hand-edited; (e) **exceptions** — from
   (d)'s `disagreeing` preview and the zone managers; (f) geometry,
   couplings, hazards as today; (g) sign-off by the yard's naval architect
   (grid) and the production superintendent (chart, exceptions), with the
   document hashes. The runbook quotes the reference hull's `wadl load-docs
   --dry-run` output as the worked example.
7. `grep -rn "280" shell-web/src/*.ts shell-web/src/*.tsx` → the
   `deckGeometry.ts` fallback only; the shell and Rust gates green with and
   without `--features postgres`.

## Demo moment

Data Sources, as the Planner, the register card reading *NOT LOADED — load
the grid before the register*. She drops `CVN73-grid.csv`: the dry run reads
*frames 0–273 · FP at 0 · AP at 260 (1,040 ft) · 12 decks · 12 bands* and one
finding, *the hull statement said frames 1–260; the grid says the ship runs
to 273 — the grid is the truth*. Confirm. The chart card shows six zones with
names and owners; the register's dry run, `zone` blank on every row, reads
*476 spaces · 476 zones derived · 0 asserted · 0 disagreeing* — then *2
refusals* on the hand-edited copy: `3-148-2-E is listed on 4th, whose placard
digit is 4`. On the Deck Explorer the ruler reads *Fr 148 · 592 ft*, the Z4
heading reads *Propulsion Plant & Midships · Zone Manager 4*, and the plate's
footer says, in amber, *plate calibrated on CV-67 BoGP 2011 — not this hull's
grid*. The Zone Manager asks how the system knew a switchgear room was hers;
the screen answers `zone: derived · 3rd · Fr 148 · port · block Z4 Fr 96–191`.

## Depends on / conflicts with

- **S17** (mutual): `words.mjs` quotes the zone heading, edited in the same
  commit; if S17 has moved the zone handlers out of `handlers.rs`, the
  `place()` call and audit fields land there.
- **S18/S19, S14**: independent. **S20**: the cards use `Badge`/`DOC_STATUS`
  when landed, `SourceCard.tsx` otherwise. **Council HG-4** (plates as
  scoped assets): after this slice. **Migration** `0022` follows
  `programme.md`'s table (0020/0021 reserved for S18/S19).
- **File contention**: `DeckExplorer.tsx`, `SourcesBoard.tsx`, `api.ts` —
  strictly after wave 4's shell slices, never in parallel with S20.

## Risks

- **A real extract carries frames the parser cannot read** (`148A`, `148½`):
  such rows come through as `placement: register` with the yard's frame
  column; the council document's question 1 asks whether that is acceptable.
- **The partition refusal is strict**: a chart that leaves the island
  unowned cannot load until it names an owner — the customer's stated rule;
  the dry run names the cells, so the fix is one row.
- **Derivation on every read**: 3,000 × 30 comparisons is microseconds and
  memoised on the document epoch regardless; the performance persona's
  numbers say whether it shows. The regenerated reference hull must leave
  the audit clean: the demo-docs test asserts it.

## Needs from the yard

- The frame table from the Booklet of General Plans: FP, AP, spacing and
  every change, the last numbered frame; whether half-frames occur.
- The deck list with each deck's placard digit and the frame intervals
  where it exists (coarse is fine; the survey refines it).
- The zone chart as the zone managers run it: blocks, names, owners, and
  whether any zone is split port/starboard.
- The spaces run outside their coordinates' zone, with a reason each.
- Who signs the grid and the chart at data-load day, and the marking the
  loaded grid carries.

## Estimate

About 21 agent-hours in three sittings. **A (~8 h)**: `hull_grid.rs`
parsers, `place()`, refusals, the frame table (2.5); store types, both
backends, migration, `pg_rls` (1.5); doors, loader order, routes, leak tests,
SSP, roles (2.5); the register door's refusals and preview, `zone_audit` v2,
reach in feet, coverage-aware edges (1.5). **B (~7 h)**: generator and
reference hull regenerated with a clean audit (1.5); shell parsers, cards,
span, ruler, plate label, zone headings (4); `words.mjs` and vitest (0.5);
browser check on the release build (1). **Cut line.** **C (~6 h)**: the
playbook checklist and sign-off sheet, the runbook's worked dry run, the two
design docs (2.5); execution-plan row (0.5); slack for the first real
extract's surprises (3). Build order: parsers and `place()` with tests →
store → doors → read path → **push** → generator → shell → **push (cut
line)** → records.
