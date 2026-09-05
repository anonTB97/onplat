# S18 + S19 — Conflict issues from the engine, and adjudication completeness

Date 2026-09-05 · head `91f2b63` · branch `claude/kickoff-from-docs-arhiib`.
One packet for two slices, built in one sequence: closes HIGH items **H1** (hot-vs-flammable and crowding as derived issues with an adjudication path, driven by a trade taxonomy instead of English keyword matching) and **H5** (owner, due-by and state on issues; a decisions export a scheduler can apply; the ledger screen summarising each decision kind) from `docs/pilot-readiness-review.md` §4. Wave 3, after S14. Migration `0020_trade_taxonomy_and_conflict_issues.sql` is used (one CHECK widening); **`0021_issue_ownership.sql` is not needed** — issue state lives in the ledger, not in a table (decided below). Contract decisions from `programme.md` this packet is bound to: work type is `work_type: string | null` on the activity read from S13's field map; S14 binds rules by it; the taxonomy maps trade codes to the **same** vocabulary; S19 adds state, owner and due-by to every issue kind including S18's; S18 adds no acknowledgement path of its own; the owner is a person id from S12's header contract, never free text.

## Summary

Today "hot vs flammable today" is `work_class()` in `handlers.rs:4227` — eight English substrings over trade and task name — served by `/work-conflicts` to three screens with a `basis` sentence that apologises for itself; crowding is `CREW_TOLERANCE = 6` in `DeckExplorer.tsx:72`. Neither is an issue: neither has hours at risk, a stable key, a place on the Conflicts & Risk board or a path into the ledger. And every issue has exactly one answer, *acknowledge*, with no owner, no date and no end: a board of 300 findings cannot say who has which, by when, or which were closed and which were accepted as risk.

This packet makes the yard's trade vocabulary **a document through a door** — trade code → work type (S14's tokens), work-type flags (`ignition_source`, `flammable_atmosphere`, `confined_space`), occupancy tolerances by register category — with a dry run that says what changes on the board if committed, a commit and revert on both stores, ledgered, a reference file for the CVN-73 trades and a seeded one for the 24-space world. Two new issue kinds are **derived in `wadl-issues`**, pure, over located activities and the coupling graph: `hot_vs_flammable` (an ignition-source activity and a flammable-atmosphere activity planned into the same yard day, in one space or across a coupling that carries heat or vapour — the graph's own `propagates`, not a word list) and `crowding` (more people planned into a space that day than its tolerance). Both carry hours at risk, the pair of activities and the space, rank on the same board, and take the same decisions. The keyword classifier is deleted; `/work-conflicts` stays as a projection of the derived pairs so the Deck Explorer, the job card and the zone interactions keep working. Every issue gains a **state machine** — `open → acknowledged → assigned → resolved | accepted_risk` — with an owner (person id + display name), a due-by and a decision text, written as `ISSUE_ACKNOWLEDGED` / `ISSUE_ASSIGNED` / `ISSUE_RESOLVED` / `ISSUE_RISK_ACCEPTED` under S12's actor; the state is **read back from the ledger** on every board read, so existing keys and acknowledgements stay valid without a migration. A **decisions export** — every decision in the chain (issue decisions, mitigation dispositions, clearances, proposals) in one CSV a scheduler reads beside P6 — and a **one-sentence summary per ledger action kind** shared by the Decisions Ledger and the export close H5.

Zero new runtime dependencies. **Decisions the builder does not revisit:** derivation in `wadl-issues` (not engine, not plan); flags keyed by work type, trade rows only supply a default work type; the field map's `work_type` wins over the taxonomy; the day is the yard's day from S10's clock; issue state is the ledger's latest `ISSUE_*` row per key (no table); four decision routes, one handler; `accept_risk` is a new capability; the decisions export is a separate file, the P6 change-request CSV is untouched; `/work-conflicts` is kept and re-implemented, `work_class` is deleted.

## What already exists

- `wadl-issues` (`lib.rs`, `board.rs`): `Issue` enum (five kinds), `key()` (`issue:<kind>:<subject>`), `space()`, `kind_rank`, `derive(world, register: &[RegisterRow], stranded, edges)` ranked by `hours_at_risk`; `RegisterRow { code, name, trade, compartment, planned, remaining }`; pure, tested in `tests/{board,executability,scale}.rs`. `wadl-mitigate::World { graph, rules, hazards, at, loads }`. `AdjacencyGraph::edges()` with `CouplingEdge { from, to, code, propagates: Vec<Propagation /* Heat Vapour Energy Load Egress */>, max_reach }` and an out-edge index.
- `handlers.rs`: `mitigation_inputs` (graph, live hazards, rules, compartments, orders, packages, stranded, load cache); `derived_issues` (1189) builds `RegisterRow`s from `list_activities` minus milestones; `issues` (1256) joins the ledger newest-first — `ISSUE_ACKNOWLEDGED` by `subject_ref == key` → `acknowledged { at, note }`, `MITIGATION_*` by space → `decision`; `acknowledge_issue` (1398) validates the key against the board derived at `as_of`, writes `AckDetail { key, note, as_of_ms, acknowledged_by_org, issue }` on the wall clock; `work_conflicts` (4260) + `work_class` (4227), `PAIR_CAP 200`, the UTC day (`div_euclid(DAY_MS)` — S10 left it on UTC). Ledger actions in force: `MITIGATION_ACCEPTED/REJECTED`, `ISSUE_ACKNOWLEDGED`, `HAZARD_RAISED/CLEARED`, `HAZARD_LOG_IMPORTED`, `SCHEDULE_REPLACED`, `SCHEDULE_CHANGE_PROPOSED/WITHDRAWN`, `DOCUMENT_REPLACED/REVERTED`; S14 adds `RULE_TABLE_SIGNED`.
- Doors: `yard_clock.rs` is the template (GET / POST `?dry_run` / revert, `ledger_document`, `read_import_body`, `DryRun`, findings `{severity, text}`, a `# comment` CSV with a row-kind first column parsed by `parse_clock_csv`, `-clock.csv` picked up by `documents::load_demo_docs`); `YardClockDoc::norfolk_seed()` seeds the 24-space world. PG documents are one `ingested_document (vessel_id, kind)` jsonb row via `put_document`; the kind CHECK was last widened by 0016 and will be by 0018 (`p6_field_map`) and 0019 (`rule_table`).
- Ledger: `append_audit(scope, vessel, action, detail, subject_ref, occurred_at_ms)` on both stores; `list_audit(scope, vessel, subject_ref)` newest-first; S12 adds `actor_id`, `actor_name`, `chain_version` to `AuditRecord` and `TenantScope.actor`; S12's `roles.rs` matrix gates `POST /issues/acknowledge` under `decide`.
- Activities: `ActivitySummary { code, name, compartment_no, trade /* RSRC short name: SM-WELD…; seed world: "Welding", "Preservation"… */, planned, budget_hours, earned_hours, status, is_milestone }` + S13's `work_type`; `CompartmentSummary.category` is the register word. Reference hull: ten `SM-*` trades (`tools/gen_full_xer.py` `TRADES`), `work_type` UDF from S14; `CVN73-couplings.csv` codes `shared_bulkhead`, `exhaust_trunk`, `electrical_bus`, derived `deck_penetration`.
- Shell: `IssuesBoard.tsx` (lenses, `KIND`, `claim`, `evidence`, `fixSpace`, inline ack input, paging); `LeverageBoard.tsx` mounts it as Conflicts & Risk; `LedgerBoard.tsx` `ACTION_STYLE` for three kinds and `summarise()` reading `disposition`/`reason`/`note`/`kind`/`label`; `Proposals.tsx::changeRequestCsv` (P6 import layout, six P6 columns then evidence); `reports.ts::conflictLog` reads `acknowledged`/`decision`; `App.tsx:100` holds `issues` from `listIssues` per `[selected, asOf]` and passes them to `Chrome`, `StatusStrip` and Reports; `SequenceBoard.tsx:138`, `DeckExplorer.tsx:417`, `JobCard.tsx:74` each fetch `workConflicts`; `manning.ts::zoneInteractions(conflicts, spaceZone)` folds pairs per zone pair; `demandByZone(…, crewTolerance)`.

## Scope

1. **`wadl_domain::trades`** — `TradeTaxonomy` (trade rows, work-type rows with flags, occupancy policy), `WorkFlags`, `resolve(work_type_from_map, trade) -> Resolved`, `tolerance(category)`, the built-in default for S14's vocabulary; serde, validation, pure.
2. **`wadl_issues::conflicts`** — `hot_vs_flammable` and `crowding` over `WorkRow`s, the graph and the yard day; two new `Issue` variants with `key`, `space`, `kind_rank`; `derive_with(…, &Conflicts)`; `derive` unchanged.
3. **Trade-taxonomy door** (`crates/wadl-api/src/trade_taxonomy.rs`): CSV parse, findings, dry run with the board delta, commit, revert, ledgered; `taxonomy_in_effect`; both stores; migration 0020; `reference/cvn73/CVN73-trades.csv` loaded by `load_demo_docs`; the 24-space seed.
4. **Issues module** (`crates/wadl-api/src/issue_decisions.rs`): `issues`, `derived_issues`, `work_conflicts` moved out of `handlers.rs`; the issues read gains the two kinds and the lifecycle (`state`, `owner`, `due_by_ms`, `overdue`, `last_decision`); `work_conflicts` projected from the derived pairs; `work_class` deleted.
5. **Decisions**: `POST …/issues/{acknowledge,assign,resolve,accept-risk}` through one handler with the transition table, four ledger actions, owner validated to S12's person-id charset, `accept_risk` capability; `GET …/issues/people` (the hull's roster from the ledger's actors).
6. **S14 hook**: the activity-grain `Work.work_type` at S14's call sites reads the resolved type (field map, else taxonomy).
7. **Shell**: `IssuesBoard` state/owner/due columns, a *Decide* popover (`IssueDecide.tsx`) with the owner picker and capability-gated buttons, a *Work-on-work · safety* lens, the two kinds' claim/evidence; Sequence Board chips fed from `issues` (prop from `App.tsx`), `workConflicts` removed from it; Deck Explorer's ⚠ from `crowding` issues, `CREW_TOLERANCE` deleted; `ledgerWords.ts` (one sentence per action kind) used by `LedgerBoard` and by `decisions.ts::decisionsCsv`; a *Trade taxonomy* card on Data Sources; Field Guide paragraph.

## Out of scope

- Reopening a resolved issue by a dedicated transition: a finding that still derives can be **re-assigned** from a terminal state (below); anything richer waits for a pilot user.
- A person directory or roster route beyond the ledger's actors (S12 out of scope): the picker offers the caller, people already on the hull's ledger, and a typed id with a name.
- Notifications, reminders or an "overdue" e-mail: `overdue` is a flag on the read; S11's Tomorrow board and the Reports read it.
- Hot-vs-flammable beyond one coupling hop, or across days (a cure that outlasts the shift is a **hazard** — `coating_open` — and the rules engine's, not this derivation's); confined-space pairing (`confined_space` is carried on the row for the S14 sitting and drives no issue kind in the pilot).
- Extending the P6 change-request CSV: its first six columns are P6's import layout; a clearance or an accepted risk is not an activity row. The decisions export is its own file.
- Removing `/work-conflicts`: three screens and `manning.ts` read it; it is re-implemented, not retired (S20 may retire it with the vocabulary pass).
- `JobCard.tsx`'s pairs: it keeps reading `/work-conflicts` (now derived); one line.
- A `decision_event` (0010) writer: the ledger row is the decision; the table stays DDL, as `programme.md`'s cuts leave it.

## Contracts

### `wadl_domain::trades` (pure; serde; no I/O)

```rust
#[derive(Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkFlags { pub ignition_source: bool, pub flammable_atmosphere: bool, pub confined_space: bool }
pub struct TradeRow    { pub trade: String, pub work_type: String, pub display_name: String }
pub struct WorkTypeRow { pub work_type: String, pub flags: WorkFlags, pub display_name: String }
pub struct Occupancy   { pub default_people: u32, pub by_category: Vec<(String, u32)> }   // register words
pub struct TradeTaxonomy { pub trades: Vec<TradeRow>, pub work_types: Vec<WorkTypeRow>, pub occupancy: Occupancy }
pub struct Resolved<'a> { pub work_type: Option<&'a str>, pub source: WorkTypeSource /* FieldMap | Taxonomy | None */, pub flags: WorkFlags }
impl TradeTaxonomy {
    pub fn default_vocabulary() -> Self;      // S14's seven tokens; hot_work → ignition_source, coating → flammable_atmosphere; no trade rows; occupancy 6
    pub fn validate(&self) -> Vec<String>;    // refusals, every reason
    pub fn resolve<'a>(&'a self, from_map: Option<&'a str>, trade: &str) -> Resolved<'a>;
    pub fn tolerance(&self, category: Option<&str>) -> u32;
}
```

`resolve`: `from_map` wins when `Some`; else the trade row's `work_type` (trade match is exact, then case-insensitive); flags come from the **work-type row** of whichever won, `WorkFlags::default()` when no row declares it. Refusals: a trade row naming a work type no work-type row declares; a duplicate trade, work type or category; a token outside `[a-z0-9_]`; an unknown flag; a tolerance of 0 or non-integer. The taxonomy never carries a work type S14's table does not — the door's finding names any token the served schedule's `work_types.on_schedule` (S14's GET) lacks.

### The document: `trade_taxonomy` (kind string on both stores; one per hull)

CSV, UTF-8, `#` comment lines ignored, first column is the row kind (the S10 clock CSV's shape):

```
# CVN-73 trade taxonomy — trades to work types, work-type flags, occupancy tolerances.
work_type,hot_work,ignition_source,Hot work
work_type,coating,flammable_atmosphere,Preservation / coatings
work_type,electrical,,Electrical
work_type,inspection,,Inspection & test
work_type,insulation,,Insulation & lagging
work_type,rigging,,Rigging & staging
work_type,mechanical,,Mechanical
trade,SM-WELD,hot_work,Structural Welding
trade,SM-PRES,coating,Preservation / Blast & Coat
trade,SM-ELEC,electrical,Electrical
trade,SM-ICEN,electrical,Interior Communications
trade,SM-INSL,insulation,Insulation & Lagging
trade,SM-RIGG,rigging,Rigging & Weight Handling
trade,SM-MECH,mechanical,Mechanical
trade,SM-MACH,mechanical,Inside Machinist
trade,SM-PIPE,mechanical,Pipefitting
trade,SM-SHTM,mechanical,Sheet Metal / HVAC
occupancy,default,6
occupancy,category,Tanks & voids,3
occupancy,category,Passage / trunk,4
```

Flags are `;`-separated tokens from `ignition_source | flammable_atmosphere | confined_space`. That file is `reference/cvn73/CVN73-trades.csv`; `documents::load_demo_docs` picks up `-trades.csv` after `-clock.csv` (S16's `wadl load-docs` therefore loads it too). The 24-space world seeds `TradeTaxonomyDoc::seed()` (`Welding → hot_work`, `Preservation → coating`, `Electrical`, `Mechanical`, `Sheet Metal → mechanical`, `Pipefitting → mechanical`, occupancy 6), status `SEEDED`, so the demo works on both worlds. Stored as `wadl_store::memory::TradeTaxonomyDoc { label: String, taxonomy: TradeTaxonomy }` (the store depends on `wadl-domain` already); PG one `ingested_document` row.

### Store (`repo.rs`, both implementations) and migration 0020

`trade_taxonomy(scope, v) -> Option<TradeTaxonomyDoc>` · `set_trade_taxonomy(scope, v, doc)` · `clear_trade_taxonomy(scope, v)`; memory adds sync `trade_taxonomy_of(vessel)` for boot. Nothing else: **issue state is not stored** — it is the ledger's latest `ISSUE_*` row per key, which both stores already hold, hash-chained and (after S12) actor-bearing; a table would be a second source of truth that can disagree with the chain, and the board already joins the ledger on every read.

```sql
-- 0020: the trade taxonomy joins the ingested documents (H1). Conflict issues
-- are derived, not stored; issue state (H5) is read from the ledger — no table.
ALTER TABLE ingested_document DROP CONSTRAINT ingested_document_kind_check;
ALTER TABLE ingested_document ADD CONSTRAINT ingested_document_kind_check
  CHECK (kind IN ('schedule_of_record','zone_register','budget_book','manning_book',
                  'geometry_register','compartment_register','coupling_register',
                  'yard_clock','p6_field_map','rule_table','trade_taxonomy'));
```

### Derivation (`wadl_issues::conflicts`) — why here

The engine answers *may work proceed here* from hazards, rules and the graph and must not learn what is scheduled (that seam is what keeps it pure and wasm-safe); `wadl-plan` answers *what is this work holding* from segment topology and knows nothing of couplings. A hot-vs-flammable pair is the **join of the schedule and the graph**, which is exactly what `wadl-issues` already is, and the `Issue` type lives there. So:

```rust
pub struct WorkRow<'a> { pub code: &'a str, pub name: &'a str, pub trade: &'a str, pub work_type: Option<&'a str>,
    pub flags: WorkFlags, pub compartment: &'a CompartmentNo, pub planned: Option<Window>, pub remaining: ManHours }
pub struct SpaceRow<'a> { pub compartment: &'a CompartmentNo, pub category: Option<&'a str>, pub tolerance: u32 }
pub struct Conflicts<'a> { pub rows: &'a [WorkRow<'a>], pub spaces: &'a [SpaceRow<'a>], pub day: Window, pub shift_hours: u32, pub pair_cap: usize }
pub fn hot_vs_flammable(graph: &AdjacencyGraph, c: &Conflicts<'_>) -> (Vec<Issue>, usize /* dropped */);
pub fn crowding(c: &Conflicts<'_>) -> Vec<Issue>;
pub fn derive_with(world, register, stranded, edges, conflicts: Option<&Conflicts<'_>>) -> Vec<Issue>;   // `derive` = derive_with(.., None)
```

*In the day*: `planned` overlaps `day`, or `planned` is `None` (undated rides every instant — the product's standing convention, stated on the row as `overlap: null`). Finished rows (`remaining == 0`) are skipped. **Hot vs flammable**: every (row with `ignition_source`, row with `flammable_atmosphere`) in the day where the spaces are equal (`via: "same space"`) or joined by an edge in either direction whose `propagates` contains `Heat` or `Vapour` (`via: <coupling code>`; an `electrical_bus` carries `Energy` only and is not a path for flame and vapour — the graph says so, no word list does). One hop; `pair_cap` (200) bounds the list and `dropped` is served. **Crowding**: per space, `people = ceil(Σ hours_in_day / shift_hours)` with `hours_in_day = remaining × |planned ∩ day| / |planned|` (undated rows contribute nothing — a headcount needs a date; the space's undated count is served as `undated_rows`); an issue when `people > tolerance`.

```rust
Issue::HotVsFlammable { hot: ConflictEnd, flammable: ConflictEnd, compartment: CompartmentNo /* the hot side's */, via: String,
    overlap: Option<Window>, hours_at_risk: ManHours /* the smaller remaining of the pair — the least work that must move to separate them */ }
Issue::Crowding { compartment: CompartmentNo, category: Option<String>, people: u32, tolerance: u32, activities: Vec<String>,
    undated_rows: usize, hours_at_risk: ManHours /* Σ hours_in_day − tolerance × shift_hours, floored at 0 — the hours that do not fit that day */ }
pub struct ConflictEnd { pub code: String, pub name: String, pub trade: String, pub work_type: Option<String>, pub space: CompartmentNo }
```

Keys: `issue:hot_vs_flammable:{hot.code}~{flammable.code}` and `issue:crowding:{compartment}` — stable across reads and days, so a decision recorded on Monday's pair attaches on Tuesday's. `space()` → the hot side's space / the crowded space; `kind_rank` 1 for `HotVsFlammable` (beside held-with-crews: people are in the space now) and 3 for `Crowding` (beside stranding). Serde tags `hot_vs_flammable`, `crowding`.

The API supplies `day = Window(clock.day_start(at), clock.next_day_start(at))` through S10's `clock_in_effect` (the UTC day the old route used goes away), `shift_hours` = the longest shift in the clock (8 under the UTC default), `WorkRow.work_type/flags` from `taxonomy.resolve(a.work_type, &a.trade)`, `SpaceRow.tolerance` from `taxonomy.tolerance(category)`.

### The issues read (`GET /api/vessels/:id/issues`, unchanged path)

Every row keeps `key`, `acknowledged { at, note } | null` (byte-compatible for `reports.ts` and S11) and `decision`, and gains:

```json
{ "state": "open" | "acknowledged" | "assigned" | "resolved" | "accepted_risk",
  "owner": { "id": "1234567890", "name": "J. Okafor" } | null,
  "due_by_ms": 1757649600000 | null,
  "overdue": false,                                   /* due_by_ms < as_of and state is assigned — judged at the read instant, time-honest */
  "last_decision": { "action": "ISSUE_ASSIGNED", "at": 1757300000000, "by": { "id": "…", "name": "R. Alvarez" }, "note": "…", "seq": 214 } | null }
```

Top level gains `"conflicts": { "day": Window, "taxonomy": { "source": "document"|"seed"|"default", "label" }, "pairs_dropped": n, "counts": { "hot_vs_flammable": n, "crowding": n } }` and `"by_state": { "open": n, "acknowledged": n, "assigned": n, "resolved": n, "accepted_risk": n, "overdue": n }`. The lifecycle join is one ledger read, newest first, first `ISSUE_*` row per `subject_ref == key` wins: `state` = its detail's `to_state`, or `acknowledged` for a pre-S19 `ISSUE_ACKNOWLEDGED` row (no `to_state`); `owner`/`due_by_ms` are carried forward from the latest `ISSUE_ASSIGNED` unless a later row is terminal. **Existing keys and acknowledgements stay valid**: key formats are unchanged, and an old ack row reads as `state: acknowledged` with the same `acknowledged { at, note }`. A resolved or accepted-risk issue whose facts still hold **stays on the board**, quieter, with its state — the derivation never hides a finding; it reports who closed it and how.

### Decisions (`crates/wadl-api/src/issue_decisions.rs`)

| Method | Path | Body | Capability | Ledger action |
|---|---|---|---|---|
| POST | `…/issues/acknowledge` (existing) | `{ key, note, as_of? }` | `decide` | `ISSUE_ACKNOWLEDGED` |
| POST | `…/issues/assign` | `{ key, owner: { id, name? }, due_by_ms?, note, as_of? }` | `decide` | `ISSUE_ASSIGNED` |
| POST | `…/issues/resolve` | `{ key, note /* required */, as_of? }` | `decide` | `ISSUE_RESOLVED` |
| POST | `…/issues/accept-risk` | `{ key, note /* required */, due_by_ms? /* review date */, as_of? }` | **`accept_risk`** (new row in S12's matrix: Ship Super, Safety, Project Manager) | `ISSUE_RISK_ACCEPTED` |
| GET | `…/issues/people` | — | read | — |

One handler `decide(transition)` behind four routes (the gate is by path; a body field cannot be gated). Scope first, body second (as today); the key is validated against the board derived at `as_of` (as today); then the transition table:

| From \ action | acknowledge | assign | resolve | accept_risk |
|---|---|---|---|---|
| open | ✓ | ✓ | ✓ | ✓ |
| acknowledged | 422 *already acknowledged on … by …* | ✓ | ✓ | ✓ |
| assigned | 422 *assigned to … — resolve, re-assign or accept the risk* | ✓ (re-assign) | ✓ | ✓ |
| resolved / accepted_risk | 422 *closed on … by … as <state>* | ✓ (takes it up again; `from_state` recorded) | 422 | 422 |

Refusals are problem+json 422 with the sentence. `owner.id` must match S12's person-id charset (`[A-Za-z0-9._:@/-]{1,128}`) → else 422 *an owner is a person id from the identity proxy, not a name*; `owner.name` ≤ 120 chars, defaults to the name the ledger last saw for that id, else the id; `owner: "me"` is accepted as shorthand for the caller's actor. `due_by_ms` earlier than the wall clock → 422 *a due-by in the past is not a plan*. `note` required on resolve and accept-risk (422 *a closure needs a sentence*). Hashed detail, fixed field order:

```rust
struct IssueDecisionDetail<'a> { key: &'a str, action: &'a str, from_state: &'a str, to_state: &'a str, note: &'a str,
    owner: Option<Owner>, due_by_ms: Option<i64>, as_of_ms: i64, decided_by: Owner /* the actor: id, name */, issue: Value /* as the server derived it */ }
```

`ISSUE_ACKNOWLEDGED` is written in this shape from S19 on (the reader needs only `note`, which both shapes carry); `AckDetail` is deleted with the handler it served. `subject_ref` = the key, as today. `occurred_at_ms` = the wall clock, as today. `GET …/issues/people` → `{ "people": [{ "id", "name", "last_seen_ms", "decisions": n }] }` — the distinct `actor_id`s on the hull's ledger, the caller first, dev-shim actors included in demo mode; a roster read from the record, not a directory.

### `/work-conflicts` (kept; re-implemented)

Same shape (`day`, `pairs[{hot, flammable, via, reason}]`, `dropped`, `scanned`, `basis`), projected from the `hot_vs_flammable` issues of the same derivation, `day` the yard's day, `basis` = *"Trade taxonomy <label> over the schedule of record: ignition-source work against flammable-atmosphere work planned into the same yard day, in one space or across a coupling that carries heat or vapour. The rules engine over recorded hazards remains the refusal authority."* `work_class` is deleted. `DeckExplorer`, `JobCard` and `manning.ts` need no change to keep drawing links.

### S14 hook

At S14's activity-grain call sites (`list_activities`, `schedule_alternatives`, `propose`, `refused_by_code`) `Work { work_type }` becomes `taxonomy.resolve(a.work_type.as_deref(), &a.trade).work_type` — a yard whose XER carries no work-type field gets its rules bound by trade. Compartment-grain reads are unchanged. `GET …/activities` rows gain `"work_type_source": "field_map" | "taxonomy" | "none"` and `"flags": ["ignition_source"]`; `work_type` stays the field map's raw value (S13's contract).

### Routes (`routes.rs` rows; `gen-leak-tests` + `gen-ssp` regenerate)

| Method | Path | Sample body | Response |
|---|---|---|---|
| GET | `/api/vessels/:id/trade-taxonomy` | — | `{ "source": "document"\|"seed"\|"default", "label", "taxonomy", "on_schedule": [{ "trade", "activities", "work_type", "source", "flags" }], "occupancy_in_use": [{ "category", "spaces", "tolerance" }] }` |
| POST | `/api/vessels/:id/trade-taxonomy` | `?dry_run=true`; `{"label":"leak test","csv":"work_type,hot_work,ignition_source,Hot work\n"}` | `{ "stored": bool, "label", "findings": [{severity, text}], "preview": { "trades": n, "work_types": n, "occupancy": n, "on_schedule": […], "board": { "before": { "hot_vs_flammable": n, "crowding": n }, "after": {…}, "examples": [claim…≤ 8] } } }`; 422 whole with every refusal |
| POST | `/api/vessels/:id/trade-taxonomy/revert` | — | `{ "reverted": true, "source": "seed"\|"default" }` |
| POST | `/api/vessels/:id/issues/assign` | `{"key":"issue:held:0-000-0-X","owner":{"id":"leak","name":"leak test"},"note":"leak test"}` | `{ "recorded": AuditRecord, "state": "assigned", "owner", "due_by_ms" }` |
| POST | `/api/vessels/:id/issues/resolve` | `{"key":"issue:held:0-000-0-X","note":"leak test"}` | `{ "recorded", "state": "resolved" }` |
| POST | `/api/vessels/:id/issues/accept-risk` | `{"key":"issue:held:0-000-0-X","note":"leak test"}` | `{ "recorded", "state": "accepted_risk" }` |
| GET | `/api/vessels/:id/issues/people` | — | `{ "people": […] }` |

Findings (never refusals) on the taxonomy dry run: a trade on the schedule with no row (*SM-PIPE: 612 activities take their work type from the field map only*), a work type on the schedule with no work-type row (*flags empty*), a register category with no occupancy row (*default 6 applies*), a trade row for a trade the schedule does not carry, a token S14's table does not bind (*no rule binds `rigging`*). Ledger: commit `DOCUMENT_REPLACED` kind `trade_taxonomy` with counts `{ trades, work_types, occupancy, board_before, board_after }`; revert `DOCUMENT_REVERTED`; commit/revert gated by `commit_document`, dry run open to anyone. `Capability::accept_risk` joins `roles.rs` with the sentence *"accept a risk on the record"*; `GATED` gains the three POST rows (`accept-risk` under it, the other two under `decide`).

### Shell modules

- `api.ts`: `Issue` union gains the two kinds; `IssueLifecycle` gains `state`, `owner`, `due_by_ms`, `overdue`, `last_decision`; `IssuesResponse` gains `conflicts`, `by_state`; `assignIssue`, `resolveIssue`, `acceptRisk`, `listIssuePeople`; `getTradeTaxonomy`, `importTradeTaxonomy(id, v, label, csv, dryRun)`, `revertTradeTaxonomy`; `AuditEntry` reads S12's `actor_name`.
- `ledgerWords.ts` (pure): `ledgerSentence(entry): string` — one sentence per action kind in yard words, actor first: `R. Alvarez assigned A4020 (not executable as planned) to J. Okafor, due 09/12 — “move to swing shift”`; `… accepted the risk on 5-212-2-Q (hot vs flammable) until 09/15 — “fire watch posted, permit 2633 amended”`; `… cleared hot_work_live in 5-212-2-Q — “permit 2633 closed, fire watch stood down”`; `… proposed A4020 → 09/14 06:00–09/16 15:30 (delay 2 d)`; `… replaced the yard_clock document CVN73-clock.csv`; `… signed the rule table (10 rows)`; unknown kind → `recorded <ACTION>` with the raw detail behind the fold. `ACTION_WORDS: Record<action, { label, tone }>` for every kind in force (the review's `HAZARD_CLEARED` finding closes here).
- `decisions.ts` (pure): `decisionsCsv(entries, proposals, issues, hullLabel, asOf): string[]` — header comments (hull, schedule source, as-of, producer, *nothing here has been applied; every row is a ledger entry*) then `Ledger Seq,Recorded At,Decided By,Decision,Subject,Activity ID,Space,State,Owner,Due By,Sentence,P6 Action,P6 Start,P6 Finish,Ledger Hash` — one row per `ISSUE_*`, `MITIGATION_*`, `HAZARD_CLEARED`, `SCHEDULE_CHANGE_PROPOSED/WITHDRAWN` entry, newest first; `P6 *` filled only for proposals (from the proposal row: `Start On or After`, wall-clock dates through `clock.ts`); the *State* column is the issue's current state from `issues` when the key is still on the board, else `no longer on the board`. Downloaded as `decisions-<hull>-asof-….csv` from the Decisions Ledger header and the Issues toolbar.
- `IssuesBoard.tsx`: `KIND` gains `hot_vs_flammable` (*HOT vs FLAMMABLE*, red-amber) and `crowding` (*CROWDED*, amber); lens *Work-on-work · safety*; `claim`: *A4020 hot work (SM-WELD) beside A4033 coating (SM-PRES) today — both in 5-212-2-Q* / *5-212-2-Q: ≈9 people planned today, tolerance 3 (Tanks & voids)*; `evidence`: *flame and vapour need only a path: exhaust_trunk carries vapour · 09/08 0700–1530* / *A4020 4 h · A4021 6 h · A4033 8 h · 2 undated rows not counted*; two new columns **State** (chip; `OVERDUE` amber when `overdue`) and **Owner · due** (`J. Okafor · due 09/12`); "Open only" becomes a state chip row *open · answered · overdue · closed*; the *acknowledge* link becomes **Decide** opening `IssueDecide`; the toolbar gains *Export decisions CSV* and the counts read from `by_state`.
- `IssueDecide.tsx` (new): a popover with four actions; owner picker = *me* (whoami), the roster from `listIssuePeople`, or *someone else…* (id + name, id validated client-side with the same charset and the server's sentence on refusal); a due-by date input (yard-local through `clock.ts`); the note field (required on resolve/accept); each button disabled with S12's refusal sentence when `!can("decide")` / `!can("accept_risk")`; the transition table mirrored so a disallowed action is greyed with the reason before the server says it.
- `SequenceBoard.tsx`: takes `issues: Issue[]` from `App.tsx` (already fetched there); the `workConflicts` fetch and import go; two chips: *hot vs flammable today* (count, title = the first five claims) and *crowded spaces today*; clicking either opens Conflicts & Risk on the *Work-on-work* lens (`onOpenIssues(lens)`).
- `DeckExplorer.tsx`: `CREW_TOLERANCE` deleted; the ⚠ marker and the zone strip's *crowded* read the `crowding` issue set for the day (`issues` prop from `App.tsx`), tooltip *≈9 people planned today over the tolerance of 3 (Tanks & voids) — engine*; the `workConflicts` fetch stays (links).
- `LedgerBoard.tsx`: `summarise` → `ledgerSentence`; `ACTION_STYLE` → `ACTION_WORDS`; header note *every decision kind, in one sentence, with who*; *Export decisions CSV*.
- `SourcesBoard.tsx`: a **Trade taxonomy** card (`INGESTED`/`SEEDED`/`DEFAULT`, label, *10 trades · 7 work types · 3 occupancy rows · 2 pairs, 1 crowded space today*, upload → dry run fold with findings and *board before → after* → Confirm; revert; times through `clock.ts`).
- `FieldGuide.tsx`: paragraph *Answering for an issue*: open, acknowledged, assigned to a person by a date, resolved or accepted as risk — every step a ledger row with a name.
