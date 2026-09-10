# S14 — Rules the yard will sign

Date 2026-09-04 · head `81fdebb` · branch `claude/kickoff-from-docs-arhiib`.
Closes pilot barrier **B11** (`docs/pilot-readiness-review.md` §4). Wave 3, first slice; migration `0019_rule_table_document.sql` (`programme.md`). The sitting brief this packet builds on is `docs/briefs/safety-authority-sitting.md`; its §2 audit and §4 decisions are taken as read here and each contradiction is resolved or left with the authority by name.

## Summary

Nine seeded entries cover eight of the table's twenty rows, apply to every activity in a space regardless of what the work is, and clear a hot-work suspension thirty minutes after the permit was *raised* — while the torch may still be lit. The authority cannot sign what the engine runs because nothing they author can enter the product, and nothing they read from it is bound to their words.

This slice makes the rule table **a document through a door**: the safety authority's CSV in the handoff's own twelve columns, plus nine compile columns filled at the sitting, dry-run against the reference hull (*what would each row fire on today, and which spaces change state if this is committed*), committed with a ledger line, reverted to the seed, and **signed** — the signature recorded on the document and in the ledger under the signer's person, invalidated by any later commit. Rules bind by **work type, register category and effective range**; the activity's `work_type` (S13's field map) selects the rows through `RuleSet::bound_to` at the call site, so `evaluate()` is unchanged and a cold-work inspection above a curing coat is executable while the weld beside it is refused. The **R04 timing defect is fixed**: a hold anchored at the permit's close (`HoldFrom::End`), and the engine learns that instant from the `HAZARD_CLEARED` row it already writes — the hazard carries `ended`, no permit object is invented. Every row in force has a **golden trace**: a scenario table the authority writes the expectation into before the engine runs, one `insta` snapshot per scenario. The seed is audited row by row against the table, bindings written into it, and the reference hull's table is the seed exported in the CSV layout, proved equal by test.

Zero new runtime dependencies (the content-addressed version id uses `sha2`, already in `wadl-api` for the ledger and S13's stable ids).

## What already exists

- `crates/wadl-engine/src/rules.rs`: `RuleEntry { rule_code, rule_version, hazard, applies, state, authority, clearing_authority, hold, waivable }`, `RuleSet::{new, entries, for_hazard, seed_usn_hot_work}` with nine entries (`…0300 …0301 …0601 …0901 …0401 …0700 …0701 …1301 …2201`), the doc comment promising a per-(class, work type, category) load that nothing does. `evaluate.rs`: `Hazard { origin, kind, since, label }`, `raised_by`, `EvaluationRequest { subject, graph, rules, hazards, at }`, `step` (reason sentence, `earliest_clear = since + hold`), `push_live` (drops a step whose clock has run out), `Decision::governing_step`. `traversal.rs` respects direction, hop bound and the edge's own `max_reach`. Six golden snapshots in `crates/wadl-engine/tests/snapshots/` pin the coating cascade round 3-160-2-Q under the seed.
- Stores: `rules_in_force(scope, vessel)` returns the seed whole in memory (`memory.rs:2693`) and on PostgreSQL selects `rule_binding ⋈ rule_version ⋈ rule` by class with `effective_to IS NULL` (`pg_repo.rs:1512`), never reading `b.work_type`/`b.category`; `seed_demo_rules` (`pg_repo.rs:85`) writes `trigger_expr` = the entry's serde JSON (the 0011 payload contract) and `work_type = 'hot_work'` on every binding. `live_hazards(scope, vessel, at)` serves `cleared_at IS NULL OR cleared_at > at` (both stores; B8's time-honest read). `clear_hazard` (`handlers.rs:1590`) records `cleared_at`/basis and ledgers `HAZARD_CLEARED`. Ten engine call sites in `handlers.rs` assemble `graph + live_hazards + rules_in_force` by hand; `wadl_issues::Hull` and `wadl_mitigate` borrow the same triple.
- Doors: `yard_clock.rs` is the freshest door module (GET / POST `?dry_run` / revert, `ledger_document`, `read_import_body`, findings as `{severity, text}`); `documents.rs::rows` splits on commas without quoting (the handoff CSV is quoted). `ingested_document.kind` CHECK last widened by 0016 (S10); S13's 0018 adds `p6_field_map`. `CompartmentSummary.category` is a register word (`Living`, `Machinery / operational`, `Electrical`, `Aviation`).
- Reference hull: `CVN73-hazards.csv` raises eight `hot_work_live`, eight `coating_open`, four `flammable_stow`, four `energised_bus`, two `stop_work` at boot (`since` = boot); every `electrical_bus` row in `CVN73-couplings.csv` is one-way; two `exhaust_trunk` rows on the whole hull. The XER carries UDFs `compartment` and `wi_number` only; `tools/gen_full_xer.py` names every task from a verb table (`Fit & weld`, `Blast / mechanical prep`, `NDT survey`, `De-energize & tag out`…). S13 serves `work_type: string | null` per activity from the field map; S12 gives `TenantScope.actor` and the `roles.rs` capability matrix.

## Scope

1. **Engine**: `RuleBinding` and `HoldFrom` on `RuleEntry` (serde defaults, so stored payloads and snapshots read unchanged); `Hazard.ended`; `RuleSet::bound_to`, `longest_end_anchored_hold`; end-anchored holds in `evaluate`; the pure CSV compiler `wadl_engine::rule_table`.
2. **Seed audit**: bindings and the R04 fix written into `seed_usn_hot_work`, R09 split into the table's two readings, version ids bumped only where a reading that exists today changes; the seed exported as `reference/cvn73/CVN73-rule-table.csv` and proved equal by test.
3. **Golden traces**: `crates/wadl-engine/tests/fixtures/rule-scenarios.csv` (expectation first, in the authority's words) driving one snapshot per scenario.
4. **Stores**: `hazards_bearing_on(at, tail)` (the fire-watch tail with `ended`), the `rule_table` document on both stores, `rules_in_force` served from it when present, migration 0019, `seed_demo_rules` writing the binding it means.
5. **API**: `rule_table.rs` — `engine_inputs`, `RuleScopes` (rule sets per (work type, category)), the door (GET with CSV export, POST dry run / commit, revert, sign); the ten call sites read through `engine_inputs`; activity reads narrowed by the activity's work type.
6. **Reference hull**: `work_type` UDF generated from the verb table; the field map points at it.
7. **Shell**: a *Rule table* card on Data Sources (status, signature, dry-run fold with *fires on* and *spaces that change*, Sign); a *Work type* column and filter chip on the Sequence Board; `ruleTable.ts` pure summaries.

## Out of scope

- Mirroring the door's rows into `rule`/`rule_version`/`rule_binding` (0004): the document is the versioned record and its ids are content-addressed; the 0004 tables keep serving the seed. One line in 0019's header says so.
- A permit object, credential/equipment/ITP/evidence gates (R01, R08, R11, R12, R16–R19, R21, R23): the compiler reports each as *not compiled: needs a permit object* — the document still carries the row so the sitting's answer is on file.
- Category or work-type narrowing on the issues board (`/issues`), mitigation and leverage: they keep the effective-range-filtered set with every row (an option is never priced more permissively than the deck plan). S18 revisits with the trade taxonomy.
- `work_type` on the 24-space seed world's generated activities: stays `null` (every row applies, as today); the demo is the reference hull.
- Selecting rows by the *evaluation* instant across documents (a scrub back does not resurrect last month's table): effective ranges apply within the table in force; history is the ledger and the version id on every trace.
- Display names for clearing-authority codes (S20); trade→work-type mapping (S18).

## Contracts

### Engine (`crates/wadl-engine`)

```rust
// rules.rs
#[derive(Default, …)] pub struct RuleBinding {
    #[serde(default)] pub work_types: Vec<String>,        // empty = any work
    #[serde(default)] pub categories: Vec<String>,        // register words; empty = any space
    #[serde(default)] pub effective_from: Option<Timestamp>, #[serde(default)] pub effective_to: Option<Timestamp> }
#[derive(Default, …)] #[serde(rename_all = "snake_case")] pub enum HoldFrom { #[default] Raise, End }
pub struct RuleEntry { …existing nine fields…, #[serde(default)] pub binding: RuleBinding, #[serde(default)] pub hold_from: HoldFrom }
#[derive(Clone, Copy)] pub struct Work<'a> { pub work_type: Option<&'a str>, pub category: Option<&'a str> }
impl RuleEntry { pub fn binds(&self, work: Work<'_>, at: Timestamp) -> bool }
impl RuleSet   { pub fn bound_to(&self, work: Work<'_>, at: Timestamp) -> RuleSet; pub fn longest_end_anchored_hold(&self) -> Minutes }
// evaluate.rs
pub struct Hazard { …existing…, #[serde(default)] pub ended: Option<Timestamp> }   // the HAZARD_CLEARED instant
impl Hazard { pub const fn ended_by(&self, at: Timestamp) -> bool }
```

`binds`: `work_types` empty, or `work.work_type` is `None` (unknown work is treated as any work — the conservative reading, and the reading every compartment-level board takes), or the type is listed; same for `categories`; `effective_from ≤ at < effective_to` with `None` open at either end. **`evaluate()` and `EvaluationRequest` do not change**; the call site narrows the set with `bound_to` first. That is the whole answer to "how does work type reach evaluate()": through the `RuleSet`, chosen per subject, never through a new request field (sixteen struct literals across four crates stay as they are).

`evaluate` per (hazard, entry), after `raised_by`: **`HoldFrom::Raise`** — a hazard `ended_by(at)` contributes nothing (the clearance ended it, the answer the store's filter used to give); otherwise as today. **`HoldFrom::End`** (`hold` is `Some`, the compiler and the seed guarantee it) — `ended` `None` or later than `at`: the step is recorded with `earliest_clear: None` and the reason `"{label} in {origin} — reached via deck_penetration (1 hop); fire watch of 30 min starts when the permit closes."`; `ended = Some(e)` with `e ≤ at`: `earliest_clear = e + hold`, reason `"… (1 hop); permit closed, fire watch of 30 min running."`, and `push_live` drops it at `e + hold` as it drops any clock. The shell already renders `earliest_clear: null` as *clears on verification*; the sentence carries the rest.

`wadl_engine::rule_table` (pure; a 40-line RFC-4180 splitter, no crate): `parse(text) -> Result<Table, Vec<Refusal>>`, `Table { header, rows: Vec<Row> }`, `compile(&Table) -> Compiled { entries: Vec<(RowRef, RuleEntry)>, not_compiled: Vec<(RowRef, String)> }`, `export(&RuleSet, rows_for_context) -> String`. Entries whose row carries no `Version id` come out with `RuleVersionId::nil()`; the caller mints (`Compiled::with_versions(impl Fn(&RuleEntry) -> RuleVersionId)`).

### The CSV (the document; `text/csv`, UTF-8, quoted per RFC 4180, `#` comment lines ignored)

Columns 1–12 are the handoff's, **verbatim and in order**, or the file is refused whole: `Rule ID, Name, Kind, Trigger condition, Propagation type, Hop depth, Resulting state, Authority document, Clearing condition, Who may clear, Config anchor, Open question for the safety authority`. Columns 13–21 are the compile columns the sitting fills; 22 is optional:

| # | Column | Reads as |
|---|---|---|
| 13 | `Hazard kind` | `coating_open` `hot_work_live` `energised_bus` `flammable_stow` `stop_work`; blank on a non-cascade row |
| 14 | `Coupling code` | a register code (`deck_penetration` `shared_bulkhead` `exhaust_trunk` `electrical_bus` …); blank for hop 0 |
| 15 | `Hold minutes` | integer or blank (verification-gated) |
| 16 | `Hold from` | `raise` (default) or `end` |
| 17 | `Clearing authority code` | `marine_chemist` `fire_marshal` `isolation_authority` `issuing_authority` or a new `lower_snake` token |
| 18 | `Work types` | `;`-separated `lower_snake` tokens; blank = any |
| 19 | `Categories` | `;`-separated register words; blank = any |
| 20 | `Effective from` | `YYYY-MM-DD` (yard-local midnight through the hull's clock) or blank |
| 21 | `Effective to` | as above, exclusive, or blank |
| 22 | `Version id` | optional uuid; present only in the exported seed |

Compilation per row: `Kind` ≠ `Hazard cascade` → *not compiled: <kind> needs a permit object (out of the pilot)*; `Resulting state` ∉ {BLOCK, SUSPEND, WARN, ALLOW} → *not compiled: state "Conditional" is a process, not an outcome*; `Hop depth` `0` → `SameSpace`; `n` → `Coupled { code, n }`; `a–b`/`a-b` → `max_hops = b`, and `0–b` yields **two entries** (ordinal 0 same-space, ordinal 1 coupled) so R03's own space is expressible; `n/a` → not compiled. `Resulting state`, `Authority document` (→ `authority`), column 17 (→ `clearing_authority`) map directly. Findings, never refusals: a coupling code the hull's register does not carry (*fires on nothing*), a work type no served activity carries, an activity work type no row binds, a clearing code the shell has no name for, an `exhaust_trunk` row on a hull with fewer than ten such edges (Y2). Refusals (422, whole file): the header; a duplicate (`Rule ID`, ordinal); an unknown hazard kind on a cascade row; an unparseable hop, hold or date; `end` with no hold; `Effective to` ≤ `Effective from`; a token outside `[a-z0-9_]`. *Nothing compiles* is a finding on a dry run and a refusal on commit.

**Version ids** are content-addressed: `uuid8(sha256("wadl:rule-version:" ‖ canonical JSON of the entry with `rule_version` nil))`, S13's `stable_activity_id` recipe. The same row re-imported keeps its id and its snapshots; a changed cell is a new version, and only that row's. The seed's fixed ids travel in column 22 of the exported table.

### Seed audit → `seed_usn_hot_work` (the fallback in force until a table is committed)

| Entry | Binding written | Change | Verdict on the brief's finding |
|---|---|---|---|
| R03 `…0300` same-space, `…0301` deck_penetration | `hot_work` | binding only, ids kept | cold work in or above a coated space is no longer refused (B11's core) |
| R04 `…0401` → **`…0402`** | any work; `hold_from: end`, 30 min | new version: the reading changes for every hazard | **fixed**: the space below is suspended until the permit closes, then for the fire watch |
| R06 `…0601` | `hot_work`; WARN kept | binding only | **left with the authority (D1)**: the table's R06 is a race the engine cannot express; the seed row is the bulkhead case the table has no row for; recorded as such in the exported table's open-question cell |
| R07 `…0700`, `…0701` | any work ("any intrusive work") | none | matches; direction stays the register's (every reference bus edge is one-way — Y2 finding) |
| R09 `…0901` SUSPEND | `hot_work` | binding only | **resolved**: the table's own note says the build refuses grinding, cutting, torch |
| R09 **`…0902`** WARN, exhaust_trunk 2 hops, 480 min | any work | new entry after `…0901` | the table's WARN for every other work class |
| R13 `…1301` | `hot_work` | binding only | ignition risk; the closed-but-unsecured stow stays D7 |
| R22 `…2201` | any work | none | matches |

Rule for ids: an id changes only when a reading that exists today (a compartment-level board, an activity with no work type) changes; a binding that narrows nothing yet recorded keeps its id. `seed_demo_rules` writes `rule_binding.work_type` from the entry's first bound token (NULL = any) and retires `…0401` (`UPDATE rule_version SET effective_to = now() WHERE rule_version_id = …0401 AND effective_to IS NULL`) so a database seeded before this slice picks up the fix. The brief's fallback text (§6) is superseded by the bindings above; §6 is rewritten to cite them.

### Store (`repo.rs`, both implementations)

`hazards_bearing_on(scope, vessel, at, tail: Minutes) -> Vec<Hazard>` — rows with `cleared_at IS NULL OR cleared_at + tail > at`, `ended = cleared_at`; with `tail = 0` the set equals `live_hazards` (kept, for `list_hazards` and the zone strip's *live* list). `rule_table(scope, vessel) -> Option<RuleTableDoc>` · `set_rule_table` · `clear_rule_table` · `sign_rule_table(scope, vessel, SignOff) -> RuleTableDoc` (NotFound without a document). `rules_in_force` returns the document's `entries` when one is stored, else the seed (memory) / the seed rows (PG, query unchanged).

```rust
pub struct RuleTableDoc { pub label: String, pub rows: Vec<Vec<String>>, /* 21–22 columns, file order */
    pub entries: Vec<RuleEntry>, pub table_hash: String, pub signoff: Option<SignOff> }
pub struct SignOff { pub signed_at_ms: i64, pub signer_id: String, pub signer_name: String,
    pub statement: String, pub table_hash: String, pub rows: Vec<String>, pub ledger_seq: i64 }
```

Memory: `RwLock<BTreeMap<VesselId, RuleTableDoc>>` beside `YardClockDoc`. PG: one `ingested_document` row, kind `rule_table`, `schema_version` stamped by `put_document`.

### Migration `migrations/0019_rule_table_document.sql`

```sql
-- 0019: the rule table joins the ingested documents (pilot barrier B11). The
-- authority's CSV is the versioned record; entry ids are content-addressed and
-- recorded on every trace. The 0004 rule tables keep serving the seed.
ALTER TABLE ingested_document DROP CONSTRAINT ingested_document_kind_check;
ALTER TABLE ingested_document ADD CONSTRAINT ingested_document_kind_check
  CHECK (kind IN ('schedule_of_record','zone_register','budget_book','manning_book',
                  'geometry_register','compartment_register','coupling_register',
                  'yard_clock','p6_field_map','rule_table'));
```

### API module `crates/wadl-api/src/rule_table.rs`

`engine_inputs(state, scope, vessel, at) -> EngineInputs { graph, hazards, rules, at }` — rules first (`bound_to(Work { None, None }, at)`: the effective filter), then `hazards_bearing_on(at, rules.longest_end_anchored_hold())`. The ten hand-assembled triples in `handlers.rs` become one call each (net fewer lines). `RuleScopes::new(&rules, at, pairs)` builds one `RuleSet` per distinct `(work_type, category)` a read needs; `get(work_type, category) -> &RuleSet`. Compartment reads (`deck_states`, `readiness`, `decide`, zone adjacent, package footprint) use `(None, compartment.category)`; activity reads (`list_activities`, `schedule_alternatives`, `propose`, S13's `refused_by_code`) use `(activity.work_type, category of its compartment)` and build `wadl_issues::Hull` per activity from the scope — `Hull` is unchanged.

Routes (`routes.rs` rows; `gen-leak-tests` + `gen-ssp` regenerate):

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/api/vessels/:id/rule-table` | `?format=csv` | `{ "source": "seed"\|"document", "label", "table_hash", "rows_total", "rows_in_force", "rows": [RowReport…], "signoff": SignOff\|null, "work_types": { "on_schedule": [{ "work_type", "activities" }], "bound": [tokens], "unbound_on_schedule": [tokens], "unseen_in_table": [tokens] } }`; `csv` → the in-force set exported in the layout above (`text/csv`) |
| POST | `/api/vessels/:id/rule-table` | `?dry_run=true`; `{ "label", "csv" }` | `{ "stored": bool, "label", "table_hash", "findings": [{severity, text}], "preview": { "rows": [RowReport…], "in_force": n, "replaces": { "source", "label" }, "work_types": {…}, "moved": { "spaces": n, "examples": [{ "compartment", "before", "after", "rule" }] } } }`; 422 problem+json with every refusal |
| POST | `/api/vessels/:id/rule-table/revert` | — | `{ "reverted": true, "source": "seed" }` |
| POST | `/api/vessels/:id/rule-table/sign` | `{ "statement", "rows": [ids] \| null }` | `{ "signed": true, "signoff" }`; 422 without a document or with a blank statement |

`RowReport { rule, ordinal, name, kind, compiled: bool, why_not, entry: { hazard, applies, state, hold, hold_from, clearing_authority, work_types, categories, effective_from, effective_to } | null, version, fires_on: { hazards: n, spaces: [≤ 12], space_count, activities_bound: n } }` — *fires on* walks the hull's graph from every live hazard of the row's kind under the row's bound and counts served activities located in the reached spaces whose work type the row binds. `moved` re-evaluates every compartment at `now` under the current and the proposed set (two passes over 476 spaces). Ledger: commit `DOCUMENT_REPLACED` kind `rule_table`, counts `{ rows, compiled, in_force, moved_spaces, versions: [{rule, version}] }`; revert `DOCUMENT_REVERTED`; sign **`RULE_TABLE_SIGNED`** with `{ kind, label, table_hash, statement, rows, versions }` under the actor (S12) — the ledger seq is written back into `signoff.ledger_seq`. A commit clears `signoff`: the signature is of a hash. Capability `sign_rule_table` (new row in S12's matrix: `safety` only; gated route row in `GATED`); commit and revert are `commit_document` as every door. Leak-test bodies: `{"label":"leak test","csv":"Rule ID,Name,Kind,Trigger condition,Propagation type,Hop depth,Resulting state,Authority document,Clearing condition,Who may clear,Config anchor,Open question for the safety authority\n"}`, `{"statement":"leak test","rows":null}`.

`GET …/activities` gains top-level `"rules": { "source", "label", "signed": bool }`; every row gains `"rules_bound": n` (rows bound to its work type and category at `as_of`; the shell says *no rule binds to inspection* when 0). `GET …/timeframe` unchanged.

### Reference hull and boot

`tools/gen_full_xer.py`: UDF `903 work_type` per task from the step verb — weld/crop/cut out/grind/burn → `hot_work`; blast/prime/top coat/cure → `coating`; de-energize/pull & land/megger/energize → `electrical`; NDT/survey/inspect/test/ring-out → `inspection`; strip lagging/asbestos/re-insulate/sheathing → `insulation`; scaffolding/rig → `rigging`; else `mechanical`. The XER is regenerated; `reference/cvn73/CVN73-fieldmap.json` → `"work_type": { "source": "udf", "name": "work_type" }`. Boot keeps the seed in force (the card reads `SEEDED`); `reference/cvn73/CVN73-rule-table.csv` is imported live in the demo, and the engine test proves it equals the seed.

### Shell modules

- `api.ts`: `RuleTableInfo`, `RowReport`, `SignOff`, `getRuleTable`, `exportRuleTableCsv`, `importRuleTable(id, v, label, csv, dryRun)`, `revertRuleTable`, `signRuleTable(id, v, statement, rows)`; `Activity.work_type`, `Activity.rules_bound`; `ActivitiesResponse.rules`.
- `ruleTable.ts` (pure): `rowLine(row)` → `R04 · Hot work overhead of occupied space · SUSPEND · deck_penetration 1 hop · any work · fires on 7 spaces (23 activities)` / `R08 · not compiled — needs a permit object`; `movedLine(moved)` → `14 spaces change state · 3-156-2-Q WARN → ALLOW (R06) …`; `signoffLine(info)` → `signed by R. Alvarez · 09/11 14:02 · ledger #212` or `unsigned — the seed is in force` (amber); `workTypeLine(wt)` → `on the schedule: hot_work 1,204 · coating 980 · … · unbound: rigging`.
- `SourcesBoard.tsx`: a **Rule table** card: status `SEEDED`/`INGESTED`, name = label, lines `10 entries in force from 8 of 20 rows · signed …`, the work-type line, upload *⭱ Upload rule table CSV* → dry run → fold: findings, every row's `rowLine`, `movedLine`, Confirm; *⭳ Export CSV* (the seed in the layout — what the sitting starts from); **Sign** (only with `sign_rule_table`; a statement textarea; the button title is the refusal sentence otherwise); revert. Times through `clock.ts`.
- `SequenceBoard.tsx`: a *Work type* column (sortable; `—` when null, title *not carried by the field map*), a work-type chip row beside the trade chips, the column in the CSV export, and the tooltip on an *executable* row with `rules_bound === 0`: *no rule binds to this work type*.

## Files

New (9): `crates/wadl-engine/src/rule_table.rs`, `crates/wadl-engine/tests/golden_rule_table.rs`, `crates/wadl-engine/tests/fixtures/rule-scenarios.csv`, `crates/wadl-api/src/rule_table.rs`, `crates/wadl-api/tests/rule_table.rs`, `migrations/0019_rule_table_document.sql`, `reference/cvn73/CVN73-rule-table.csv`, `shell-web/src/ruleTable.ts`, `shell-web/src/ruleTable.test.ts` (plus generated snapshots).

Touched (Rust, 12): `crates/wadl-engine/src/{rules.rs, evaluate.rs, lib.rs}`, `crates/wadl-store/src/{repo.rs, memory.rs, pg_repo.rs}`, `crates/wadl-store/tests/pg_rls.rs`, `crates/wadl-api/src/{lib.rs, routes.rs, handlers.rs, roles.rs (S12), schedule_door.rs (S13)}`; generated `tests/generated_leak_test.rs`, `docs/ssp-input.md`. Mechanical, not counted: `ended: None,` at the 31 `Hazard` literals (`memory.rs`, `pg_repo.rs`, `evaluate.rs` tests, `golden_cascade.rs`, `wadl-issues/tests/{board,executability,scale}.rs`, `wadl-mitigate/tests/options.rs`) — one `sed`, no logic.

Touched (data, 3): `tools/gen_full_xer.py`, `reference/p6-sample/CVN73-PIA26-full.xer`, `reference/cvn73/CVN73-fieldmap.json`. Shell (3): `api.ts`, `SourcesBoard.tsx`, `SequenceBoard.tsx`. Docs (3): `docs/execution-plan.md` (row), `docs/briefs/safety-authority-sitting.md` (§5 points at the sign route and the fixture; §6 fallback rewritten to the bindings), `docs/pilot-playbook.md` Y11 (one line).

Thirty source files, over the fifteen preference because the barrier runs from the engine's binding to the authority's signature. Build order: 1 engine (bindings, `hold_from`, `ended`, `bound_to`, the literal sed) → 2 seed audit + scenarios + golden test → 3 stores + 0019 + `pg_rls` → 4 `engine_inputs` + `RuleScopes` at the call sites → 5 XER work type + field map → 6 compiler + door (GET/CSV, dry run, commit, revert) + routes + API tests — **cut line: B11 is closed at the API** (the table through the door, bound by work type, R04 fixed, a golden trace per row) → 7 sign route + capability → 8 Sources card → 9 Sequence Board column → 10 docs.

## Tests

Engine unit (`rules.rs`, `evaluate.rs`): `a_row_bound_to_hot_work_skips_cold_work_and_keeps_unknown_work`; `a_category_binding_reads_the_register_word`; `an_effective_range_is_half_open_at_the_instant`; `an_end_anchored_hold_never_elapses_while_the_permit_is_open`; `an_end_anchored_hold_runs_from_the_close_and_drops_at_close_plus_hold`; `a_clearance_later_than_the_instant_has_not_happened_yet`; `a_raise_anchored_row_ignores_a_hazard_ended_by_the_instant`; `the_longest_end_anchored_hold_is_the_store_tail`. `rule_table.rs`: `the_handoff_header_is_required_verbatim_and_in_order`; `quoted_commas_in_the_handoff_columns_survive`; `a_hop_range_from_zero_compiles_to_two_entries`; `a_gate_row_is_not_compiled_and_never_refuses`; `an_end_hold_without_minutes_is_refused`; `export_then_compile_is_the_identity_on_the_seed`.

`crates/wadl-engine/tests/golden_rule_table.rs`: `the_reference_rule_table_compiles_to_the_seed_entry_for_entry` (`include_str!` of `reference/cvn73/CVN73-rule-table.csv`, column 22 carrying the ids) and `every_scenario_matches_the_authority_expectation_and_is_snapshotted`, iterating `fixtures/rule-scenarios.csv` — `rule, ordinal, scenario, hazard_kind, origin, subject, work_type, at_min, ended_min, expect_state, expect_clearer, expect_clear_min` over the golden graph plus `2-160-2-Q → 3-160-2-Q deck_penetration` and `3-148-2-E → 3-148-0-L electrical_bus`. Sixteen rows: R03 hot work in the coated space (BLOCK, marine chemist, 480) and an inspection there (ALLOW); R03 the deck above (BLOCK) and once cured (ALLOW); R04 any work below live hot work at +45 min (SUSPEND, fire marshal, no clock), the same at +70 with the permit closed at +60 (SUSPEND, clear +90), at +90 (ALLOW); R06 hot work across the bulkhead (WARN); R07 an inspection in the envelope (BLOCK) and electrical work one bus hop out (BLOCK); R09 hot work on the trunk two hops out (SUSPEND) and mechanical work there (WARN); R13 hot work on the branch of an open stow (BLOCK) and coating work there (ALLOW); R22 rigging under a stop-work (SUSPEND) and next door (ALLOW). Snapshot per row: `golden_rule_table__R04-0-the-same-after-the-permit-closed.snap`. The authority signs the CSV row; the snapshot is the engine's answer to it.

`crates/wadl-api/tests/rule_table.rs` (in-memory, `TestClock`, `load_demo_docs` on `reference/cvn73` + the full XER through S13's field map): `a_dry_run_compiles_the_reference_table_and_reports_what_each_row_fires_on` (8 rule ids → 10 entries; R07 reaches ≥ 9 spaces from 3-148-2-E along one-way edges; the `exhaust_trunk` finding; `work_types.on_schedule` names seven tokens); `the_handoff_table_alone_compiles_nothing_and_says_so_on_a_dry_run_and_refuses_on_commit`; `a_commit_replaces_the_seed_ledgers_the_versions_and_a_trace_carries_a_content_addressed_id`; `the_same_row_reimported_keeps_its_version_and_a_changed_cell_gets_a_new_one`; `revert_returns_to_the_seed_and_is_ledgered`; `the_seed_export_reimports_with_the_same_ids` ; `a_cold_work_inspection_above_a_curing_coat_is_executable_and_the_weld_beside_it_is_not` (the B11 pin: one `inspection` and one `hot_work` activity located over 3-212-1-L's coat; `rules_bound` 0 vs ≥ 2); `the_deck_below_live_hot_work_stays_suspended_until_the_permit_closes_then_for_the_fire_watch` (raise at T; deck-states at T+45 → SUSPEND, `earliest_clear: null`; clear with basis at T+60; at T+70 → SUSPEND, `earliest_clear = T+90`; at T+90 → ALLOW; `as_of = T+50` → SUSPEND, null — time-honest); `signing_records_the_person_the_hash_and_the_versions_and_a_recommit_unsigns`; `a_foreman_may_not_sign_and_nothing_is_written` (403 via S12's gate). `pg_rls.rs`: `the_rule_table_round_trips_stays_in_tenant_and_rules_in_force_switch_to_it_and_back`; `hazards_bearing_on_serves_the_fire_watch_tail_with_the_end_instant`; the existing rules test asserts `…0402` in force and `…0401` retired after a re-seed.

**Tests that move, and why.** `rules.rs::seed_covers_the_prototype_coating_cascade`: coating entries 4 → 5 (R09 split; the trunk now carries SUSPEND for hot work and WARN for the rest). Snapshot `golden_cascade__golden_shared_exhaust_trunk_suspends_two_hops_out`: a second R09 line (`…0902`, WARN) after the SUSPEND; state and `earliest_clear` unchanged; the other five snapshots are byte-identical (coating rows keep their ids and, read with no work type, their outcomes). `pg_rls.rs` rules test: `…0401` → `…0402`, `…0902` added. `wadl-mitigate/tests/options.rs:247`: the comment saying hot work "expires again long before an eight-hour cure ends" is now false — hot work is verification-gated until the permit closes; the property tests hold (a wait is never offered against a hold with no clock) and the comment is rewritten. S13's `the_sample_export_ingests_whole`: `fields_seen.udfs` gains `work_type` and `UDFVALUE` rises by one row per task. `docs/demo-script.md` §3 A51350: still suspended under R04, now *until permit 2673 closes* — one sentence.

Shell — `ruleTable.test.ts`: `rowLine reads a compiled and a not-compiled row in yard words`; `movedLine counts and names the first spaces`; `signoffLine says unsigned in amber words and names the signer when signed`; `workTypeLine lists what the schedule carries and what nothing binds`.

## Acceptance

1. `scripts/dev.sh`; `curl …/rule-table` → `source: "seed"`, `rows_in_force: 10`, `work_types.on_schedule` names `hot_work`, `coating`, `electrical`, `inspection`, `insulation`, `rigging`, `mechanical` with counts; `unbound_on_schedule` lists `rigging`, `insulation` and the finding says so. `curl '…/rule-table?format=csv'` → 22 columns, ten data rows, the seed's ids in column 22.
2. `curl -X POST '…/rule-table?dry_run=true'` with `handoff/01-rule-table.csv` → 20 rows, none compiled, each `why_not` a sentence, `moved.spaces` = every space that has a hazard reach today, finding *nothing compiles — commit would put no rule in force*; commit → 422. With `reference/cvn73/CVN73-rule-table.csv` → 10 compiled, `moved.spaces == 0`, R07's `fires_on.space_count ≥ 9`, R09's `≤ 2` with the Y2 finding. Edit R04's hold to 60 → dry run shows a new version for R04 only; commit → `/ledger` newest `DOCUMENT_REPLACED` with `versions`.
3. Browser, Sequence Board on the reference hull: filter *coating* + *Not executable* → rows over curing coats; switch the chip to *inspection* → the same spaces' NDT rows are executable, tooltip *no rule binds to inspection*. The trace on Deck Explorer for 3-212-1-L's deck above still reads R03 with `…0301`.
4. Deck Explorer, 6-216-1-J (below permit 2673): *SUSPEND · fire marshal · clears on verification* with the sentence *fire watch of 30 min starts when the permit closes*. Clear permit 2673 with a basis; the space reads *SUSPEND · fire watch running · earliest clear 14:32*; scrub 30 min forward → ALLOW; scrub back before the clearance → SUSPEND, no clock.
5. Data Sources, Rule table card: *Export CSV*; upload it → fold shows every row's line and *0 spaces change state*; Confirm → `INGESTED`, *unsigned* amber; as Safety, Sign with a statement → *signed by … · ledger #n*; as Foreman the Sign button carries the refusal sentence and the API answers 403. Re-upload with one cell changed → *unsigned*.
6. Kill the API: the card reads *rule table unavailable*, the Sequence Board's rules line *rules unavailable*. `WADL_DEMO=seed`: every activity `work_type: null`, `rules_bound` = all, the card works on the 24-space hull. With `DATABASE_URL`: `pg_rls` green; `wadl seed` on a pre-S14 database leaves `…0401` retired.
7. Gates: fmt, clippy `-D warnings` pedantic, `cargo test --workspace --all-features` (new snapshots reviewed with `cargo insta review`, never `--accept` blind), `gen-leak-tests --check`, `gen-ssp --check`, `npm run typecheck`, `vitest`, `npm run build`. `handlers.rs` is shorter than before.

## Demo moment

Data Sources, the safety authority beside you. *Export CSV* — the ten rows the product runs today, in their own table's columns, with the two departures from their table written in the open-question cell. They change R04's hold to sixty minutes in the spreadsheet and upload it: the fold says *R04 · new version · fires on 7 spaces (23 activities) · 0 spaces change state right now*, and nothing else moved. Confirm. Open the Sequence Board: the NDT survey over the curing coat in crew berthing No. 3 is executable — *no rule binds to inspection* — while the weld beside it is refused under R03, `…0301`, the same id as yesterday's trace. Deck Explorer, the tank under permit 2673: *suspended, fire marshal, clears when the permit closes*. Close the permit with its basis; the space shows the fire watch running and the minute it ends; scrub forward and it clears; scrub back and the hold is still there. They sign. The ledger row names them, the table's hash and every version they signed; the snapshot for each scenario row is in the repository under their expectation.

## Depends on / conflicts with

- **S13** (work type on the activity read, the field map, `schedule_door.rs::refused_by_code`): required; this slice edits the reference field map and one function in S13's module. **S12** (`TenantScope.actor`, `roles.rs` matrix and `GATED`): required for the signature's person and the capability; without it the sign route writes `unattributed` and is open — do not ship the sign route before S12.
- **S10**: `Effective from` dates resolve through `clock_in_effect`; `SourcesBoard.tsx` is touched by S10, S12, S13 and this slice — rebase, never parallel.
- **S18** consumes `Work`, `RuleScopes` and the work-type tokens; it must not add a second vocabulary or a second scope builder. **S16** loads the reference table through `wadl load-docs` (`-rule-table.csv` suffix) — the loader hook is S16's, the parser is here. **S17** may move `engine_inputs` when it splits `handlers.rs`; the name stays.
- `wadl-issues` and `wadl-mitigate` are touched only by the `ended: None` sed.

## Risks

- Thirty-one `Hazard` literals gain a field: mechanical, but a missed test file fails to compile in a crate the builder was not looking at — run `cargo build --workspace --all-targets` before anything else after step 1.
- `hazards_bearing_on` widens the engine's input by the tail; a table row with a very long end-anchored hold (24 h) makes every read carry a day of closed permits. Bounded and cheap (a permit is a row), and the dry run's finding names any hold over 480 minutes.
- Content-addressed ids mean an *identical* row in two hulls' tables shares an id — intended (the same rule), but a reviewer may expect per-hull ids; the trace carries the hull already.
- The sitting may bind a row to a work type the field map cannot supply (the yard's XER carries none): the dry run's `unseen_in_table` / `unbound_on_schedule` findings make that visible before commit, and the conservative reading (unknown work = every row) keeps the board safe rather than silent.
- The R09 split adds a line to compartment-level traces on the trunk; a reader may ask why two R09 lines — the sentences differ by state and the shell shows both. The alternative (one row, cold work refused) is the defect this slice exists to fix.
- Regenerating the 25,000-line XER is a large diff; the generator is deterministic and the file is reviewed by its counts (`validate-p6-sample.py`), not by eye.

## Needs from the yard

- The sitting's answers as cells: the nine compile columns for every cascade row, the two blank anchors (cure minutes; fire-watch minutes), the work-type tokens per row, and whether R06 stays WARN on the bulkhead or becomes the table's ventilation SUSPEND (D1).
- Which XER field carries the work type, or the trade→work-type mapping (S18) if none does; the register categories they want rows bound to, in the register's words.
- The person who signs (their `x-wadl-person` id) and confirmation that `safety` alone holds `sign_rule_table`.
- Ventilation branches and bus direction in the coupling register (Y2): without them R09 and R13 fire on two spaces and R07 walks one way.

## Estimate

About 11 agent-hours in three sittings. **A (engine + seed + stores, ~4.5 h)**: bindings, `hold_from`, `ended`, `bound_to`, the sed 1.5; seed audit, scenario fixture, golden test, compiler 1.5; both stores, 0019, `pg_rls` 1.5. **B (API, ~3.5 h)**: `engine_inputs` + `RuleScopes` at the call sites 1.0; XER work type + field map 0.5; door, routes, leak/SSP regen, API tests 2.0 (**cut line**). **C (signature + shell + docs, ~3 h)**: sign route + capability 0.75; card + `ruleTable.ts` + tests 1.25; Sequence Board column, browser verification, docs 1.0.
