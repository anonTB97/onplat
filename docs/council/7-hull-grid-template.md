# 7 — The hull grid: the one-time template for zones and compartments

Persona: naval architect and implementation lead. Date 2026-09-09, head
`b05b5d8`, branch `claude/kickoff-from-docs-arhiib`. Companion packet:
`docs/programme/s22-hull-grid.md`. Every claim below cites the file and
line it was read from; the numbers in §1.4 were measured with a script over
`reference/cvn73/*.csv` at this head, not estimated.

## 0 The direction, restated as a naval architect reads it

A ship's own coordinate system has three axes and the placard is a point in
it. **Longitudinal**: the frame — a numbered transverse station, counted
from the forward perpendicular (FP) aft, at a spacing that is constant on
this class (4 ft) and changes along the hull on others; the after
perpendicular (AP) is a marked frame, and plating and decks may run past it
(a carrier's flight deck overhangs the stern). **Vertical**: the deck — an
ordered list, main deck `1`, decks below `2, 3, …`, levels above `01, 02,
…`, each existing only over some frame intervals. **Transverse**: the tier
— `0` on centreline, odd numbers to starboard and even to port counting
outboard (`1/2` the first tier, `3/4` the next). A USN compartment number
`3-148-2-E` is (deck 3, frame 148 forward bulkhead, first tier port, usage
E). A **zone** is a block on that grid: a frame band on a band of decks,
optionally one side of the ship, and the blocks of all zones partition every
deck (`docs/zone-scheme.md:24-37`).

The customer's answer to "how does the system know where the zones are" is
therefore: the implementers author the **grid** (frame table, deck table,
tier table) and the **zone chart** on it, once per programme per vessel;
the register lists what exists at each coordinate; the system **derives**
every compartment's placement, its zone, what is next door, and the frame
scale of every drawing. Nothing spatial is typed twice.

## 1 Current state

### 1.1 Solid

- **The placard parser is exact.** `UsnCompartment::parse`
  (`crates/wadl-domain/src/compartment.rs:107-141`) takes four hyphenated
  fields, an integer frame, a non-negative side digit, one or two uppercase
  usage letters (the doubled tank codes `FF`/`JJ`), and returns `None` for
  anything else — no best effort. The seed and the PostgreSQL read label a
  parsed position `parsed`, never `authored` (`memory.rs:2215-2237`,
  `pg_repo.rs:270-285`).
- **Zones are already 3-D blocks, served once.** `ZoneBoundSummary` carries
  `lo_frame, hi_frame, top_deck, bottom_deck` (`wadl-store/src/model.rs:443-460`);
  the audit that joins chart to register runs on the server
  (`wadl-api/src/handlers.rs:1785-1862`) and the shell explicitly refuses to
  re-derive membership (`shell-web/src/zones.ts:24-29`). The chart door
  refuses whole for a block naming one deck of its band, an unknown deck, a
  top below its bottom, or a duplicate block (`handlers.rs:2150-2215`) and
  dry-runs the audit before commit (`handlers.rs:2086-2113`).
- **Deck order is an ordinal, not a label**, on the class (`migrations/0002_ship_taxonomy.sql:24-34`)
  and in every register (`RegisterDeckSummary.ordinal`, `model.rs:130-139`);
  "directly below" is the next ordinal the register carries, not `ordinal+1`
  (`wadl-api/src/documents.rs:38-54`), and next-door reasons are computed
  from that order plus frame extents plus the coupling graph
  (`handlers.rs:1907-1994`).
- **A provenance ladder for geometry exists and is honest**: `unknown →
  parsed → register → surveyed` (`docs/geometry-accuracy.md:53-77`); the
  surveyed overlay happens once on the server (`handlers.rs:174-198`); the
  geometry door's findings — placard disagreement, outside deck coverage,
  unknown spaces, coverage count — are computed at dry run *and* on every
  read (`handlers.rs:2515-2599`).
- **Both stores carry the spatial documents identically** as JSON documents
  (`pg_repo.rs:1487-1537`), served through one function
  (`memory::register_compartments`, `memory.rs:681-727`; `pg_repo.rs:876-887`),
  behind the scope check, ledgered `DOCUMENT_REPLACED`/`DOCUMENT_REVERTED`
  with counts (`documents.rs:479-506`). The loader stages the register and
  geometry so a dry run validates later files against them
  (`documents.rs:633-640, 762-809`). The shell's parsers match the server's
  shapes line for line (`shell-web/src/ingest.ts:39-54, 91-152` vs
  `documents.rs:133-239`).
- **The reference hull is grid-consistent already** (§1.4): the chart
  partitions every deck exactly and the hand-typed zone of all 476 spaces
  equals the zone its block would derive. The derivation the customer asks
  for is lossless on the data that exists.

### 1.2 Missing

- **There is no hull grid document.** The longitudinal axis exists as
  `class.frame_min/frame_max` = 1..260 (`reference/cvn73/CVN73-hull.json`;
  `model.rs:713-718`), read by nothing except the statement's own
  `lo > hi` check (`model.rs:835-841`; no other use in `wadl-api` or
  `memory.rs`), while the chart and coverage run to 273
  (`CVN73-zones.csv`, `CVN73-geometry.csv:4`). Frame spacing (4 ft) is
  prose in three places (`docs/zone-scheme.md:15`,
  `docs/geometry-accuracy.md:39`, `handlers.rs:1891-1893`) and data
  nowhere; FP and AP appear nowhere. The three numbers 260, 265, 273 read as
  a contradiction until a grid says: AP at frame 260 (1,040 ft), hull
  plating to 265, flight-deck overhang to 273 (1,092 ft).
- **The deck table has no placard digit.** A register deck row is
  `deck,<code>,<label>,<ordinal>` (`documents.rs:128-144`); the mapping
  `03 ↔ gallery`, `1 ↔ Main` lives only in the generator
  (`tools/gen_cvn73_hull.py:32-47`, `DIGIT`). So the system cannot place a
  compartment on a deck from its number, and cannot detect the case the
  customer named — `3-148-2-E` listed on deck `4th` — because
  `register_compartments` takes `deck_code` from the row and parses only
  frame and side (`memory.rs:691-716`). `register_rejections` checks
  duplicates, unknown deck and side words only (`handlers.rs:2897-2952`).
- **Zone membership is typed by hand, per space, and audited afterwards.**
  The register's fifth column is required (`col(line, "zone", …)?`,
  `documents.rs:149`); 476 rows on the reference hull carry it; the chart
  cannot populate it. Zone names and owners exist only as `ZONE_NAMES` in
  the generator (`gen_cvn73_hull.py:63-70`) — no document, no endpoint, no
  board shows a zone's name or manager.
- **The chart has no transverse dimension.** `ZoneBoundSummary` is frame ×
  deck only (`model.rs:443-460`), so "side digit contradicts its zone" is not
  expressible; and `Side::from_digit` reduces the tier to parity
  (`compartment.rs:75-85`) — 100 of the 476 reference spaces carry tier
  digit 3 or 4 (§1.4) and the tier is lost on the way to the plate
  (`deckSheets.ts:73-89`: "a legible placement, not a position").
- **Deck coverage lives in the survey document, not the hull definition**
  (`deck,` rows of the geometry register, `model.rs:191-203`), and the
  generator builds it separately from the spaces (`COVERAGE`,
  `gen_cvn73_hull.py:501-505`, vs the `add()` clamp at `:89`), so the
  reference hull ships with **five** surveyed extents outside their own
  deck's coverage (§1.4), served as findings on every `GET /geometry`.
- **"Outside the hull" is not a refusal anywhere.** The register accepts any
  `i32` frame (`documents.rs:151-154`); geometry refuses negatives only
  (`handlers.rs:2661-2663`); the chart accepts any band (`handlers.rs:2168-2173`).
- **The frame scale is a constant, five times over**: `FRAME_SPAN = 280`
  (`shell-web/src/deckGeometry.ts:20`), `Math.max(280, …)` in
  `DeckExplorer.tsx:301-304`, `ShipView.tsx:182`, `VerticalTrace.tsx:179`,
  `CascadeBoard.tsx:159`; and `BOUNDARY_FRAMES = 8` is "32 ft on this class"
  by comment (`handlers.rs:1891-1893`), wrong on any class with a different
  spacing.
- **The plates are another ship.** `deckSheets.json` is calibrated from the
  CV-67 Booklet of General Plans (`deckSheets.ts:2-11`; source line in the
  JSON), per plate (`pxPerFrame`, `frame0X`), with no link to any hull's
  grid; the Explorer footer names the source (`DeckExplorer.tsx:2808`) but
  nothing says the plate is not this hull.
- **Vertical adjacency ignores coverage**: `derive_vertical_edges`
  (`documents.rs:43-98`) and `adjacency_reasons` (`handlers.rs:1912-1924`)
  step to the next ordinal whether or not that deck exists at the frame —
  listed as roadmap in `docs/geometry-accuracy.md:92-95`.
- **No implementation checklist or sign-off for a new vessel.** The loader's
  order is the only procedure (`documents.rs:549-556`: clock, field map,
  register, zones, geometry, couplings, hazards); there is no grid step, no
  expected-findings list, no sign-off record.

### 1.3 Disqualifying

- **Nothing in the spatial architecture is disqualifying.** Documents
  through doors, server-side audit, ordinals for decks, the provenance ladder
  — the grid is one more document in that pattern, and every change in §3
  is additive (serde defaults on new optional fields; behaviour without a
  grid identical to today). No rewrite is proposed.
- **One ATO-blocking pattern, latent until a real hull is loaded**: the
  deck plates are thirteen JPEGs under `shell-web/public/decks` (9.9 MB),
  served by `hardening::static_site` (`hardening.rs:276`) from
  `WADL_STATIC_DIR` (`bin/serve.rs:306`) to every reader of the site,
  outside the per-hull scope check. For the 2011 public reissue of a
  decommissioned CV-67 that is fine. A real hull's Booklet of General Plans
  and Compartment & Access drawings are distribution-limited, and a CVN's
  reactor-compartment arrangement is NNPI: hull drawings must never enter
  the static bundle. The same holds for the grid and register of a real
  hull: they are controlled extracts and must exist only as scoped
  documents, never under `reference/`. This is HG-4; the ATO persona should
  carry it by control ID.

### 1.4 Measurements (script over `reference/cvn73/*.csv`, this head)

| What | Value |
|---|---|
| Register | 476 spaces, 12 decks; frame column present on every row (`geometry_source` = `register` for all; the `parsed` rung is never exercised by the demo) |
| Chart | 10 blocks, 6 zones; over 12 decks × frames 0–273 (3,288 cells): 0 uncovered, 0 double-covered |
| Register zone vs block-derived zone | 476 of 476 agree |
| Placard deck digit vs `deck_code` (via the generator's `DIGIT`) | 476 of 476 agree; placard frame vs frame column: 476 of 476 agree |
| Side digits | `0` 103 · `1` 139 · `2` 134 · `3` 51 · `4` 49 |
| Frames past `class.frame_max` 260 | 0 placards; 4 surveyed aft extents and 2 chart/coverage bands reach 261–273 |
| Surveyed extents outside deck coverage | 5: `4-248-1-E`, `4-248-2-E` (248–260 on `4th` 12–256), `6-247-3-V`, `6-247-4-V` (247–251 on `2ndplat` 22–248), `7-244-0-V` (244–256 on `hold` 30–250) |
| Hard-coded frame span `280` in the shell | 5 sites (files above) |

## 2 The design

### 2.1 By hand, by the implementer, once per programme per vessel

1. **The grid** (`<HULL>-grid.csv`, document kind `hull_grid`) — record-typed
   lines like the register:
   - `hull,<hull_no>,<class>,<scheme>,<reach_ft>` — the numbering scheme
     (`usn_deck_frame_side_use`) and the next-door reach in feet.
   - `frame,<frame>,<station_ft>[,<mark>]` — one row at FP (`fp`), at every
     spacing change, at AP (`ap`) and at the last numbered frame (`last`);
     stations are feet from FP, positive aft; frames between rows
     interpolate linearly. Frames below the first row or above the last are
     **not on the ship**.
   - `deck,<code>,<placard_digit>,<ordinal>,<name>[,<height_ft>]` — the deck
     as the register names it, the digit the placard carries for it, the
     ordinal ascending downward, an optional height datum.
   - `band,<deck_code>,<lo_frame>,<hi_frame>` — where the deck exists;
     several per deck allowed; coalesced on read (as `geometry_findings`
     already does, `handlers.rs:2538-2553`).
   - `tier,<digit>,<side>,<label>[,<offset_ft>]` — optional; generated from
     the USN convention when absent (`0` centreline, odd starboard, even
     port, outboard by digit); listed only to name a tier or give it an
     offset once a C&A source exists.
2. **The zone chart** on that grid (`<HULL>-zones.csv`, kind `zone_register`,
   shape v2, legacy rows still read): `zone,<code>,<name>,<owner>` and
   `block,<zone>,<lo_frame>,<hi_frame>,<top_deck>,<bottom_deck>[,<side>]`
   with `side ∈ all|port|starboard|centreline` (default `all`). The chart
   must partition every (deck, frame, side) cell of the grid; gaps and
   double coverage are refusals, because a chart that does not partition
   cannot derive a zone.
3. **The exceptions** (`<HULL>-exceptions.csv`, kind `zone_exceptions`):
   `space,<placard>,<zone>,<reason>` — the spaces a yard deliberately runs
   under a zone other than the one their coordinates give (a trunk owned by
   the zone it serves, a sponson shop run by the hangar). Every override is
   named, reasoned, ledgered, and reported.
4. **The register** as today, with the `zone` column optional once a grid
   and chart are stored: blank means *derive*; filled means *assert*, and an
   assertion that disagrees with the derivation without an exception row is
   the `out_of_bounds` finding the audit already emits.

### 2.2 Derived by the system, at read time, once, on the server

Placement of every compartment from its number against the grid, in this
order: parse (`UsnCompartment`); deck by `placard_digit`, else the row's
`deck_code`; frame checked against the frame table; tier by side digit;
station in feet; coverage check; zone by the first block containing (deck
ordinal, frame, side), then the exceptions; served as
`placement ∈ grid|register|parsed|unknown` and `zone_source ∈
derived|register|exception`. This is the same overlay pattern as
`overlay_geometry` (`handlers.rs:174-198`), so stored documents do not
change and both stores serve identically. Also derived: zone membership and
the partition audit; next door with the reach converted from feet through
the station table; deck penetrations that step to the next deck *that exists
at that frame*; the frame span and ruler for the schematic, whole-ship and
vertical views; the label and residual a raster plate must declare against
the grid it was calibrated on.

### 2.3 Validations the doors emit

| Check | Door | Refusal / finding | Sentence |
|---|---|---|---|
| Frame table empty, unsorted, non-monotonic stations, no `fp`, two `ap` | grid | refusal | `frame 120 (480 ft) is aft of frame 118 (484 ft)` |
| Deck with no digit, duplicate digit or ordinal, band outside the frame table | grid | refusal | `deck 3rd: band 12–300 runs past the last frame 273` |
| Chart block outside the frame table, outside its decks' bands, unknown deck, unknown side | zones | refusal | `Z4: Fr 96–191 on 2nd–2ndplat runs past the last frame` |
| Chart does not partition: a cell uncovered or covered twice | zones | refusal, first 12 cells named | `2nd Fr 96 starboard is in Z3 and Z4` |
| Placard frame outside the frame table | register | refusal | `3-290-2-E: frame 290 is not on this hull (frames 0–273)` |
| Placard deck digit disagrees with `deck_code` | register | refusal | `3-148-2-E is listed on 4th, whose placard digit is 4` |
| Deck code the grid does not carry | register | refusal (exists today) | unchanged |
| Placard frame outside its deck's bands | register | finding `outside_deck_coverage` | the deck may be partly delineated; a person looks |
| Side digit contradicts the zone's `side` | register / zones | finding `side_contradiction` | `2-150-2-Q is port; Z7 is a starboard zone` |
| Register zone ≠ derived zone, no exception | register / zones | finding `out_of_bounds` (exists today) | unchanged |
| Exception names a placard not on the register or a zone not on the chart | exceptions | refusal | as the coupling door words it |
| Placard does not parse and has no frame | register | finding `unplaceable` (exists today) | unchanged |
| Surveyed extent outside its deck's grid bands | geometry | finding (exists today; bands now from the grid) | unchanged |
| Geometry `deck,` rows present while a grid is stored | geometry | finding `superseded_by_grid` | accepted, ignored for coverage |
| `class.frame_min/max` disagree with the grid's `fp`/`ap` | grid | finding | reported at load; the grid is the truth |

### 2.4 Converging the existing documents without breaking what is stored

New document kind only; every stored register, chart and geometry document
reads unchanged (`serde(default)` on `RegisterDeckSummary.placard_digit`,
`ZoneBoundSummary.side`, a `zones: Vec<ZoneDef>` on `ZoneRegister`). Without
a grid the hull behaves exactly as today. With one: the grid's decks are
authoritative and the register's `deck,` rows are checked against them; the
geometry register's `deck,` rows are superseded; the register's `zone` may
be blank; the chart is partition-checked against the grid's bands. Loader
order becomes clock, field map, **grid**, register, zones, exceptions,
geometry, couplings, hazards; the migration widens the kind CHECK with
`hull_grid` and `zone_exceptions` and is additive.

## 3 Prioritised actions

`ux_polish` here means "neither ATO- nor crash-blocking"; HG-1..3 are
pilot-blocking for any real hull, since the alternative is 3,000 hand-typed
zone cells.

| id | action | class | h | depends on |
|---|---|---|---|---|
| HG-1 | Hull grid document: parser, `HullGrid` on both stores, migration 0022, `GET/POST?dry_run/POST revert /grid`, loader step, routes + leak tests + SSP | ux_polish | 6 | — |
| HG-2 | Placement from the number: `placard_digit` on decks, frame-table and deck-digit refusals, `placement` and `station_ft` on served rows | ux_polish | 3 | HG-1 |
| HG-3 | Chart v2 (names, owners, side), exceptions document, partition refusal, zone derived at read, audit v2 (`derived`, `overrides`, `side_contradiction`) | ux_polish | 5 | HG-1, HG-2 |
| HG-4 | Plates out of the static bundle: per-hull scoped `/plates/:deck` asset carrying `grid_label` and residual; the demo keeps CV-67 as a labelled stand-in | ato | 4 | — |
| HG-5 | Shell reads the grid: the five `280`s, ruler in frames and feet, zone names and owners on the lanes and zone boards, "plate calibrated on CV-67, not this hull" notice | ux_polish | 3 | HG-1 |
| HG-6 | Reach in feet via the station table; deck penetrations and `deck_above/below` through coverage | ux_polish | 2 | HG-1 |
| HG-7 | Reference hull regenerated on the grid: generator emits `CVN73-grid.csv`, coverage from the spaces (closes the five findings), chart v2, register `zone` blank | ux_polish | 1.5 | HG-1..3 |
| HG-8 | Implementation checklist and sign-off (playbook, runbook); `wadl load-docs` prints the grid audit | ux_polish | 1.5 | HG-1 |
| HG-9 | `bootstrap-hull` statement's `frame_min/max` validated against the grid at load | ux_polish | 0.5 | HG-1 |

## 4 Concrete changes

| File | Change | Why |
|---|---|---|
| `crates/wadl-store/src/model.rs` | `RegisterDeckSummary.placard_digit: Option<String>` (default); `ZoneBoundSummary.side: Option<String>` (default); new `HullGrid { label, hull, frames: Vec<FrameStation>, decks: Vec<GridDeck>, bands: Vec<DeckCoverageSummary>, tiers: Vec<Tier> }`, `ZoneDef { code, name, owner }`, `ZoneException { compartment_no, zone, reason }`; `CompartmentSummary` gains `placement`, `station_ft: Option<i32>` (feet, integer), `tier: Option<u32>`, `zone_source` | stored JSON reads unchanged; served rows say where each fact came from |
| `crates/wadl-store/src/repo.rs`, `memory.rs`, `pg_repo.rs` | `hull_grid/set_hull_grid/clear_hull_grid`, `zone_exceptions/set/clear`, on both stores as documents; `ZoneRegister.zones: Vec<ZoneDef>` default empty | one door shape per document, both backends |
| `migrations/0022_hull_grid_document.sql` | widen `ingested_document.kind` CHECK with `hull_grid`, `zone_exceptions`, listing every kind in force | additive, forward-only, per `programme.md` |
| `crates/wadl-api/src/hull_grid.rs` (new) | `parse_grid_csv`, `parse_zones_csv_v2` (legacy rows accepted), `parse_exceptions_csv`; `place(&HullGrid, &ZoneRegister, &[ZoneException], &mut [CompartmentSummary])`; `grid_rejections`, `chart_partition_rejections`, `register_rejections_on_grid`; the door handlers | nothing new into `handlers.rs` (`programme.md:72-75`) |
| `crates/wadl-api/src/handlers.rs` | `list_compartments`/every read that calls `overlay_geometry` also calls `hull_grid::place`; `zone_audit` gains `derived`, `overrides`, `side_contradiction`; `BOUNDARY_FRAMES` replaced by `reach_ft` through the station table; `adjacency_reasons` and `documents::derive_vertical_edges` step through bands | server computes once |
| `crates/wadl-api/src/documents.rs` | loader: `-grid.csv` before the register, `-exceptions.csv` after zones; `Staged` carries the grid and chart; `parse_zones_csv` delegates to v2 | dry run validates the whole set in order |
| `crates/wadl-api/src/routes.rs`, `tests/generated_leak_test.rs`, `docs/ssp-input.md` | `GET/POST/POST revert /api/vessels/:id/grid`, `/zone-exceptions`; `GET /plates/:deck` (HG-4); regenerate | CI checks drift |
| `crates/wadl-api/src/roles.rs` | the three POSTs under `commit_document` | matrix, not ad hoc |
| `shell-web/src/deckGeometry.ts`, `DeckExplorer.tsx:301-304`, `ShipView.tsx:182`, `VerticalTrace.tsx:179`, `CascadeBoard.tsx:159` | span from `GET /grid` (`first..last`), 280 only as the fallback when no grid | one scale |
| `shell-web/src/deckSheets.ts`, `deckSheets.json`, `DeckExplorer.tsx:2808` | `gridLabel` and `residualFrames` per plate; notice when the plate's grid label is not the hull's | honest plates |
| `shell-web/src/ingest.ts`, `api.ts`, `SourcesBoard.tsx` | grid and exceptions parsers and cards (`INGESTED`/`NOT LOADED`); chart card shows names and owners | Data Sources is the door |
| `shell-web/src/ZoneLanes.tsx`, zone boards | zone name and owner beside the code | the customer's zone manager sees their name |
| `tools/gen_cvn73_hull.py` | emit `CVN73-grid.csv` (FP 0, AP 260, last 273, 4 ft); coverage from generated extents; chart v2 with `ZONE_NAMES`; register `zone` blank | the reference hull as the filled template |
| `docs/zone-scheme.md`, `docs/geometry-accuracy.md` | the grid section; coverage moves to the grid | the standing design says so |
| `docs/pilot-playbook.md`, `docs/runbook.md` | the new-vessel checklist and sign-off (packet §Acceptance) | the process the customer asked for |

## 5 Tensions with other personas

No council document precedes this one. The tensions below are the ones the
later passes will meet; each carries the resolution proposed here so the
persona can accept or contest it explicitly.

- **Product/domain owner (ownership: class vs hull).** Migration 0002 says
  "class holds the template, hull holds the truth" (`0002:4-6`); the
  documents are per hull. Resolution: the grid is a per-hull document with
  a `class` field and a content hash in its ledger row; a sister hull starts
  by loading the same file, and the door reports `same grid as CVN-72
  (hash …)`. No class-level document until two hulls of one class are in
  service — a class table with no second hull is a template nobody
  exercises.
- **ATO/RMF lead (plates and grid as controlled data).** The static bundle
  and `reference/` are fine for the public CV-67 plates and the invented
  CVN-73 numbers; they are not fine for a real hull. Resolution: HG-4 now,
  and a rule in the playbook that a real hull's grid, register and plates
  are loaded through the doors by the implementer on site and never
  committed.
- **Data and performance (derivation at read time).** Placement for 3,000
  spaces against 30 blocks is microseconds, but it runs on every read that
  lists compartments. Resolution: memoise `place()` on the document epoch
  the store already exposes for the schedule (`execution-plan.md` slice 6),
  the same way the engine's inputs are memoised.
- **Naval UX/HCI (what a zone is called).** A zone manager reads a name
  and a person, not `Z4`. Resolution: the chart v2 carries them; the shell
  shows `Z4 · Propulsion Plant & Midships · <owner>` wherever `Z4` is a
  heading, and the code stays in the tooltip.
- **Reliability/QA (refusal versus finding).** This pass makes two register
  checks refusals that were silent (frame off the ship, deck digit
  contradiction). A yard's first real extract will trip them. Resolution:
  the dry run lists every hit, capped at twelve like today
  (`handlers.rs:2947-2950`), and the packet's checklist tells the
  implementer to expect them on the first pass.

## 6 Questions only the customer can answer

1. Does the yard's compartment list carry fractional or lettered frames
   (`148½`, `148A`)? The parser takes integers only (`compartment.rs:126`);
   the frame table can carry half-frames, the placard field cannot.
2. Are zones ever split by side on this yard (a port and a starboard zone on
   the same frames and decks)? If never, `side` on a block stays optional
   and the tier check is informational.
3. What is the source of record for the grid: the Booklet of General Plans,
   the C&A drawings, or the NAVSEA product model — and who signs the grid
   at the end of data-load day (the yard's naval architect, the programme
   office, or ship's force)?
4. Is a hull's frame table and deck arrangement, as loaded, marked (NNPI,
   Distribution D) — and may the demo's invented CVN-73 numbers stay in the
   repository once a real hull is loaded elsewhere?
5. Who is the `owner` of a zone — a person id from the identity proxy, a
   role, or a code the yard's own system carries?
6. Do exceptions to derived zones need an authority's sign-off, or is the
   implementer's reason line enough for the ledger?
