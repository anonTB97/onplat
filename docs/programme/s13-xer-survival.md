# S13 — Survive the yard's XER, with run history

Date 2026-09-04 · head `3c286f8` · branch `claude/kickoff-from-docs-arhiib`.
Closes pilot barrier **B4** and HIGH item **H4** (`docs/pilot-readiness-review.md` §4).
(The charter's proposed list called this S11; `programme.md` renumbers — nothing here depends on the number.)

## Summary

The first real export from a yard whose location field is not literally named `compartment` imports 100 % unlocated with no remedy short of a code change; an ordinary cross-project predecessor refuses the whole file; a Windows-1252 export (P6's default on Windows) will not even read; material and equipment assignments are summed as man-hours; level-of-effort and WBS-summary rows are served as work; and once a schedule is served nothing says which import it was, when, or by whom.

This slice makes the yard's conventions **data**: a per-hull **P6 field map** document (which UDF or activity code carries the compartment, the work item, the work type and the trade; which projects to serve; whether to read placards out of task names) with defaults equal to today's behaviour, chosen on the Sources card from the fields the uploaded file actually contains. The XER door **quarantines rows with reasons** instead of refusing the file, decodes **Windows-1252** through a hand-rolled 128-entry table (shell and server), counts **labor resources only** as man-hours, **excludes LOE and WBS-summary rows** from work and lists them, and records **one run per import** — the field map used, the encoding, the quarantine, the exclusions, the served document — with the served run pointed to. Any two runs can be **diffed**; any prior run can be **served again**, ledgered. Activity ids become **stable from (hull, task_code)**, so an open inspector survives a re-baseline. The breadcrumb reads *reading CVN73-PIA26-full.xer · imported 09/04 06:12 by …*.

Zero new runtime dependencies. `sha2` (already in the workspace for the ledger) is added to `wadl-api` for the stable id; base64 is avoided by decoding in the browser and recording who decoded.

## What already exists

- `wadl_ingest::xer` (`crates/wadl-ingest/src/xer.rs`): by-name field resolution, `MAX_CELLS`, per-line `rejected: Vec<Rejection>` — the parser **already quarantines**; it is `crate::schedule::parse_xer` (`crates/wadl-api/src/schedule.rs:76-87`) that refuses whole on any rejection, and `serve.rs:151-156` that refuses to boot. UDF names are literals (`xer.rs:403-404`); `resources_by_task` sums every `TASKRSRC` row (`xer.rs:240-279`), `RSRC.rsrc_type` never read; `report.project` is the first `PROJECT` row only; `task_type` is read for `TT_Mile` only (`xer.rs:492`); `ACTVTYPE`/`ACTVCODE`/`TASKACTV` are not read. `wbs_area_by_id` is the zone hint. Ten `ingest_xer` call sites plus the CLI (`crates/wadl-cli/src/main.rs:87-140`).
- Activity ids: `0xB000_0000 + file index` (`schedule.rs:26`) — a re-import renumbers every row; `booked_orders` derives `WorkOrderId` from it (`handlers.rs:613`); the shell keys rows and the inspector on `activity_id`.
- The door (`handlers.rs:1829-1905`): scope check → `read_import_body` (256 MB ceiling) → `parse_xer` → empty-file refusal → `reconcile` + `mapping_report` + `schedule_delta` (`1658-1755`, incoming vs served, engine refusals before/after, `proposals_reflected`) → `?dry_run=true` returns the preview → `set_schedule_of_record` → `SCHEDULE_REPLACED` ledger line. `revert_schedule` → `clear_schedule_of_record` → `DOCUMENT_REVERTED`. `ledger_document` is shared by every door; `DryRun`, `mapping_report`, `proposal_rows`, `same_days` are private to `handlers.rs`.
- Stores: `ScheduleOfRecord { label, activities, edges }` (`memory.rs:361`); in-memory map + unscoped `load_schedule_of_record` for boot; PG one jsonb row in `ingested_document (vessel_id, kind)` with `schema_version` stamped by `put_document` (`pg_repo.rs:544-579`), `list_activities` reads the doc (`817-840`). `ingest_run` and `ingest_field_map` tables exist from 0008 with org RLS and **nothing writes them**; `p6_activity`/`p6_relationship` (0009) are DDL only.
- Shell: `SourcesBoard.tsx` `stageSchedule` reads `file.text()` (UTF-8 only), previews, stages, confirms (`112-146`, card `621-687`); `api.ts` `previewSchedule`/`importSchedule`/`revertSchedule` (`983-1080`), `ImportPreview`, `MappingReport`, `ScheduleDelta`; `ingest.ts` `deltaSummary`; `Chrome.tsx` hull crumb (`hull_no · availability_code`, `520-572`); `App.tsx` fetches `/timeframe` per hull on `[selected]` only (`217-226`); `dataEpoch` bumps after a Sources commit. Reports carry `scheduleSource`.
- `docs/p6-ingest-schema.md` grades compartment sources (UDF high, activity code medium, name low) and lists multi-project and `TT_LOE` as unconsumed. `scripts/validate-p6-sample.py` counts `TT_Task` only. Both samples are UTF-8 with UDFs `compartment`/`wi_number` (the small one also `503 work…`), all `RT_Labor`, one project, no LOE.

## Scope

1. **`wadl_ingest::field_map`** — the `FieldMap` type with serde, defaults = today, validation; **`wadl_ingest::encoding`** — `decode_xer(bytes)` with the Windows-1252 table.
2. **`xer.rs`** reads through the map: UDF by name or label, activity codes (`ACTVTYPE`/`ACTVCODE`/`TASKACTV`), resource trade; labor-only hours; project filter; LOE/WBS exclusion; `TT_FinMile` as key event; `fields_seen` survey; findings. Signature `ingest_xer_with(input, label, &FieldMap)`; `ingest_xer` delegates with the default.
3. **Quarantine** at the door: the file is refused whole only when no activity survives (or no `TASK` section, or `MAX_CELLS`); everything else is served with the quarantine list and reason classes in the preview, the run and the ledger.
4. **Runs** on both stores: one `ScheduleRun` per commit (map, encoding, report, doc, who, when), the served pointer, list / detail / diff / serve-prior-run routes, migration NNNN.
5. **Stable activity ids** from `(vessel, task_code)`.
6. **Field-map door** (`GET` / `POST ?dry_run` / `revert`), ledgered; the XER door accepts an inline map and commits it with the run.
7. **Boot and CLI**: bytes in, decoded; `reference/cvn73/CVN73-fieldmap.json` loaded; a run recorded at boot; `wadl ingest-xer --survey [--field-map f]` for the yard's own export.
8. **Shell**: browser-side decode with the encoding reported; a `ScheduleDoor` panel on the Sources card (field-map selects fed by `fields_seen`, quarantine fold, runs table with diff and serve); `/timeframe` carries the served run; the breadcrumb reads it.

## Out of scope

- Writing verbatim `p6_activity`/`p6_relationship` evidence rows (0009): the run's `doc` is the evidence at served grain; verbatim rows are S14/B10 territory (a data-load CLI on PostgreSQL). One line.
- Choosing the served run **by `as_of`** (a scrub back does not resurrect last week's schedule): documents are current-state throughout the product; history is inspectable through runs and the ledger, not automatic. One line.
- Rendering `work_type` on the Sequence Board and binding rules to it (S13-rules/B11): served on every activity here; consumed there.
- `CALENDAR`, `total_float_hr_cnt`, `phys_complete_pct`, baseline variance — unchanged, not pilot-blocking.
- Person id on the run beyond `person: null` until S12 threads the proxy header; the field exists and the breadcrumb says *no person on record* until then.
- A per-run **field-map CSV** form: the map is chosen in the browser from the file's own fields; the boot loader reads JSON.
- Retention policy on PostgreSQL runs (kept forever; S16's runbook notes the size).

## Contracts

### Document: `p6_field_map` (kind string in both stores; one per hull)

```json
{ "compartment": { "source": "udf", "name": "compartment" },
  "work_item":   { "source": "udf", "name": "wi_number" },
  "work_type":   { "source": "none" },
  "trade":       { "source": "resource" },
  "projects": [],
  "placards_from_names": true }
```

`source` ∈ `udf` (`UDFTYPE.udf_type_name` or `udf_type_label`, trimmed, case-insensitive; a label-only match is a finding), `activity_code` (`ACTVTYPE.actv_code_type` → `ACTVCODE.short_name` via `TASKACTV`), `resource` (trade only: first labor `TASKRSRC` → `RSRC.rsrc_short_name`), `none`. `projects` = `proj_short_name`s to serve; empty = every project (today). The default above **is** today's behaviour, so no hull needs a map to keep working. Refusals (422, the map refused whole): `resource` outside `trade`; blank `name` on `udf`/`activity_code`; a duplicate project. Findings (warn): `compartment: none` with `placards_from_names: false` (*every row will be unlocated*); a named field the served schedule's `fields_seen` does not carry.

Stored: `wadl_store::memory::FieldMapDoc { label: String, map: serde_json::Value }` — the store never depends on the ingest crate; the API validates. PG: `ingested_document` row, kind `p6_field_map`.

### Run (`wadl_store::model`)

```rust
pub struct ImportedBy { pub org: OrgId, pub person: Option<String>, pub via: String /* door | boot | cli */ }
pub struct RunCounts { task_rows, served, work, key_events, quarantined, excluded_loe, excluded_wbs,
                       excluded_project, edges, edges_quarantined, material_skipped, equipment_skipped: usize }
pub struct QuarantinedRow { pub line: usize, pub table: String, pub code: Option<String>, pub class: String, pub reason: String }
pub struct ScheduleRunSummary { pub run_id: uuid::Uuid, pub seq: i64, pub label: String, pub imported_at_ms: i64,
  pub imported_by: ImportedBy, pub encoding: String, pub decoded_by: String, pub projects_served: Vec<String>,
  pub counts: RunCounts, pub field_map: serde_json::Value, pub served: bool, pub schema_version: u32 }
pub struct ScheduleRunReport { pub quarantine: Vec<QuarantinedRow>, pub excluded_loe: Vec<String>, pub excluded_wbs: Vec<String>,
  pub excluded_project: Vec<(String, String)>, pub fields_seen: serde_json::Value, pub findings: Vec<String> }
pub struct ScheduleRun { pub summary: ScheduleRunSummary, pub report: ScheduleRunReport, pub doc: ScheduleOfRecord }
```

`class` ∈ `unparseable_date`, `backwards_window`, `unknown_status`, `no_code`, `no_name`, `width`, `cross_project_logic`, `unknown_task_in_logic`, `structure`. `ActivitySummary` gains `#[serde(default)] pub work_type: Option<String>`. `ScheduleOfRecord` is unchanged (its `label` stays the source label).

`fields_seen` (survey, no schedule content):

```json
{ "projects": [{ "id": "4410", "short_name": "CVN73-PIA26", "tasks": 5706 }],
  "udfs": [{ "name": "compartment", "label": "Compartment", "table": "TASK", "values": 5691 }],
  "activity_code_types": [{ "name": "LOC", "values": 0 }],
  "resource_types": { "RT_Labor": 5708, "RT_Mat": 0, "RT_Equip": 0 }, "has_rsrc_type": true,
  "task_types": { "TT_Task": 5692, "TT_Mile": 14, "TT_FinMile": 0, "TT_LOE": 0, "TT_WBS": 0 },
  "sections": { "TASK": 5706, "TASKPRED": 4581, "TASKRSRC": 5708, "UDFVALUE": 11382 } }
```

### Store trait (`repo.rs`), both implementations

`field_map(scope, v) -> Option<FieldMapDoc>` · `set_field_map(scope, v, FieldMapDoc)` · `clear_field_map(scope, v)` · `commit_schedule_run(scope, v, ScheduleRun) -> ScheduleRunSummary` (records the run **and** serves it, one transaction / one write lock; assigns `seq`) · `list_schedule_runs(scope, v) -> Vec<ScheduleRunSummary>` (newest first, no docs) · `schedule_run(scope, v, run_id) -> Option<ScheduleRun>` · `serve_schedule_run(scope, v, run_id)` (copies the run's doc into the served document with `run_id`) · `served_schedule_run(scope, v) -> Option<ScheduleRunSummary>`. Existing `set_schedule_of_record` / `clear_schedule_of_record` / `schedule_source` unchanged (`clear` leaves the runs: history is history). In-memory adds unscoped `load_schedule_run(vessel, run)` and sync `field_map_of(vessel) -> FieldMap-as-Value` for boot; runs held in `RwLock<BTreeMap<VesselId, Vec<ScheduleRun>>>`, docs kept for the last 12 runs (`MAX_RUN_DOCS`), older runs keep summary + report.

### Migration `migrations/NNNN_schedule_runs_and_field_map.sql`

```sql
-- NNNN: one row per schedule import, the served run pointed to (B4, H4).
-- ingest_run (0008) finally has a writer. Columns are nullable so the table's
-- (empty) history stays valid; RLS is 0008's org policy, the hull gate is the
-- store's get_vessel before every read.
ALTER TABLE ingest_run
  ADD COLUMN vessel_id      uuid REFERENCES vessel(vessel_id),
  ADD COLUMN seq            integer,
  ADD COLUMN label          text,
  ADD COLUMN encoding       text,
  ADD COLUMN decoded_by     text,
  ADD COLUMN imported_by    jsonb,   -- { org, person, via }
  ADD COLUMN field_map      jsonb,
  ADD COLUMN report         jsonb,   -- quarantine, exclusions, fields_seen, findings, counts
  ADD COLUMN doc            jsonb,   -- the run's schedule of record, the shape ingested_document serves
  ADD COLUMN schema_version integer;
CREATE INDEX ON ingest_run (vessel_id, seq DESC);
ALTER TABLE ingested_document ADD COLUMN run_id uuid REFERENCES ingest_run(run_id);
ALTER TABLE ingested_document DROP CONSTRAINT ingested_document_kind_check;
ALTER TABLE ingested_document ADD CONSTRAINT ingested_document_kind_check
  CHECK (kind IN ('schedule_of_record','zone_register','budget_book','manning_book',
                  'geometry_register','compartment_register','coupling_register',
                  /* 'yard_clock' if S10 landed first, */ 'p6_field_map'));
```

`source_system` is written `'primavera_p6'`, `source_file` = label, `started_at`/`finished_at` = the clock's instant, `row_count` = served, `reject_count` = quarantined. `DOCUMENT_SCHEMA_VERSION` stays 1 (`work_type` is `serde(default)`).

### Routes (`routes.rs` rows; `gen-leak-tests` + `gen-ssp` regenerate)

| Method | Path | Body / query | Response |
|---|---|---|---|
| POST | `/api/vessels/:id/schedule-of-record` (existing) | `?dry_run=true`; `{ "label", "xer", "encoding"?: "utf-8"\|"windows-1252", "field_map"?: {…} }` | existing keys plus `"run": { "encoding", "decoded_by", "projects_served", "counts", "field_map", "field_map_source": "inline"\|"document"\|"default" }`, `"fields_seen"`, `"quarantine": [QuarantinedRow…]`, `"exclusions": { "loe": [codes], "wbs": [codes], "project": [[code, project]] }`, `"findings": [string]`. Commit adds `"run_id"`. 422 problem+json only for *no TASK section*, *no activity survives* (`"XER rejected: every one of 12 TASK rows was quarantined — …first three reasons…"`), `MAX_CELLS`, a malformed inline map. |
| GET | `/api/vessels/:id/field-map` | — | `{ "source": "document"\|"default", "label": string\|null, "map": {…}, "fields_seen": {…}\|null }` (`fields_seen` from the served run) |
| POST | `/api/vessels/:id/field-map` | `?dry_run=true`; `{ "label", "map" }` | `{ "stored": bool, "label", "map", "findings": [string] }`; 422 refused whole |
| POST | `/api/vessels/:id/field-map/revert` | — | `{ "reverted": true }` (back to default) |
| GET | `/api/vessels/:id/schedule-runs` | — | `{ "served": run_id\|null, "runs": [ScheduleRunSummary…] }` |
| GET | `/api/vessels/:id/schedule-runs/detail` | `?run=<uuid>` | `{ "summary", "report" }` (no doc); 404 unknown run |
| GET | `/api/vessels/:id/schedule-runs/diff` | `?run=<uuid>&against=<uuid>` (`against` defaults to the served run) | `{ "run": summary, "against": summary, "delta": ScheduleDelta }` — same shape as the door's delta (`added/removed/retimed/rehoused/rebudgeted`, `refused_before/after` under today's hazards, examples) |
| POST | `/api/vessels/:id/schedule-runs/serve` | `{ "run_id" }` | `{ "served": summary, "delta" }`; ledger `SCHEDULE_REPLACED` |

Leak-test sample bodies: field-map `{"label":"leak test","map":{"compartment":{"source":"udf","name":"x"},"work_item":{"source":"none"},"work_type":{"source":"none"},"trade":{"source":"resource"},"projects":[],"placards_from_names":true}}`; serve `{"run_id":"00000000-0000-0000-0000-000000000000"}`. Query-string run ids rather than a `:run` path segment because the generator substitutes `:id` and `:no` only.

`GET /api/vessels/:id/timeframe` gains `"schedule_run": ScheduleRunSummary | null` (beside S10's `yard_clock`). `GET …/activities` gains the same key. Every activity row carries `work_type`.

Ledger: `SCHEDULE_REPLACED` detail gains `run_id`, `seq`, `imported_by`, `encoding`, `field_map`, `counts` (with `quarantined`), keeps `delta`; serve-prior-run writes `SCHEDULE_REPLACED` with `"reverted_to_run": true, "from_run": <uuid|null>`; the field map writes `DOCUMENT_REPLACED` / `DOCUMENT_REVERTED` with `kind: "p6_field_map"` through `ledger_document` (made `pub(crate)`); an XER commit carrying an inline map that differs from the stored one writes the field-map line first, then the schedule line.

### Stable activity ids

`schedule::stable_activity_id(vessel, code)`: `sha256("wadl:activity:" ‖ vessel-uuid ‖ ":" ‖ task_code)`, first 16 bytes, version nibble `8`, RFC 4122 variant. Same hull + same code → same id across runs; different hull → different id. `WorkOrderId::from_uuid(activity_id)` in `booked_orders` becomes stable for free.

### Encoding

`wadl_ingest::encoding::decode_xer(bytes: &[u8]) -> (Cow<'_, str>, Encoding)`: valid UTF-8 → borrowed (a leading BOM stripped, `Encoding::Utf8Bom`); otherwise Windows-1252 via `const CP1252_HIGH: [char; 128]` for `0x80..=0xFF` (WHATWG table; the five undefined bytes `81 8D 8F 90 9D` map to their C1 code points, nothing to U+FFFD). Shell mirror in `ingest.ts`: `decodeXerFile(file)` tries `new TextDecoder("utf-8", { fatal: true })` on the `ArrayBuffer`, falls back to `new TextDecoder("windows-1252")` (built into every browser and Node), returns `{ xer, encoding }`; the body carries `encoding`, the run records `decoded_by: "browser"`. Server-side decode (`decoded_by: "server"`) serves the boot loader and the CLI, which read bytes. One shared literal pins both: bytes `93 94 E9 96 80` → `“ ” é – €`.

### Env / CLI / boot

No new env. `WADL_DEMO_DOCS` picks up `*-fieldmap.json` (before the XER) → `set_field_map`; `serve.rs` reads the XER with `std::fs::read` and `decode_xer`; `schedule::load_xer(store, vessel, label, bytes)` reads `store.field_map_of(vessel)`, builds the run with `ImportedBy { org: world.yard_org, person: None, via: "boot" }`, calls `load_schedule_run`; a quarantine at boot **prints and continues** (`schedule of record: CVN73-PIA26-full.xer — 5706 activities, 0 quarantined, utf-8, map CVN73-fieldmap.json`), refusing only when nothing survives. `wadl ingest-xer --input f.xer [--survey] [--field-map map.json]`: `--survey` prints `fields_seen`, encoding, the quarantine classes with line numbers and nothing else (the mail-back the charter asks the yard for); without it, today's report plus the exclusions.

### Shell modules

- `api.ts`: `FieldMap`, `FieldSource`, `FieldsSeen`, `ScheduleRunSummary`, `QuarantinedRow`, `ImportPreview` gains `run`, `fields_seen`, `quarantine`, `exclusions`, `findings`; `previewSchedule`/`importSchedule` take `{ encoding, fieldMap? }`; `getFieldMap`, `importFieldMap(id, v, label, map, dryRun)`, `revertFieldMap`, `listScheduleRuns`, `scheduleRunDetail`, `diffScheduleRuns(run, against?)`, `serveScheduleRun`; `Timeframe.schedule_run`.
- `ingest.ts`: `decodeXerFile`, `fieldMapSummary(map)` → `compartment ← UDF "compartment" · work item ← UDF "wi_number" · work type ← not carried · trade ← resource · projects: all · placards read from task names`, `quarantineSummary(rows)` → `5 quarantined — 3 cross-project logic, 2 unparseable dates`, `fieldChoices(fieldsSeen, slot)` → the select options (`(none)`, `UDF: compartment (5,691 rows)`, `Activity code: LOC (0)`, and `Resource (RSRC)` for trade).
- `ScheduleDoor.tsx` (new; rendered inside the Sources card by `SourcesBoard.tsx`): **Field map** panel — four selects + a project checkbox list + *read placards out of task names when the field is silent*; while an XER is staged every change re-runs the dry run and the staged line updates (`location: 0 of 9 authored` → `8 of 9`); with no file staged the panel edits the stored map through its own door (dry run → findings → Confirm). **Quarantine** fold: `line 812 · A4021 · unparseable early_start_date "2026-13-40 06:00"`, grouped by class, plus *excluded: 3 level-of-effort (A9001, A9002, A9003) · 1 WBS summary · 2 in project CVN73-DSRA27*. **Runs** table, newest first: `#3 · CVN73-PIA26-full.xer · 09/04 06:12 · by org …0001 (no person on record) · 5,706 rows served · 0 quarantined · utf-8 · SERVED`, buttons *diff vs served* (renders `deltaSummary`) and *serve this run* (confirm → ledgered). A failed runs read renders *run history unavailable*, never an empty table.
- `SourcesBoard.tsx`: `stageSchedule` uses `decodeXerFile`, passes `encoding` and the panel's map; the card's name line becomes `CVN73-PIA26-full.xer · run #3 · imported 09/04 06:12 by …`; the summary line gains quarantine/exclusion counts; the upload title drops *one rejected line refuses the file*.
- `Chrome.tsx`: one new prop `scheduleRun: ScheduleRunSummary | null | "unavailable"`; under the hull crumb a 10.5 px line: *reading CVN73-PIA26-full.xer · imported 09/04 06:12 by org …0001 (no person on record)* — amber suffix until S12 supplies a person; *reading the generated register* (dim) when null; *schedule source unavailable* (amber) on a failed read. Times through `clock.ts` so S10's yard clock applies.
- `App.tsx`: the timeframe effect depends on `[selected, dataEpoch]` (today `[selected]` only — a commit did not refresh it); passes `frame.schedule_run` to `Chrome`.

## Files

New (9): `crates/wadl-ingest/src/field_map.rs`, `crates/wadl-ingest/src/encoding.rs`, `crates/wadl-api/src/schedule_door.rs` (the XER door moved out of `handlers.rs` — `import_schedule`, `revert_schedule`, `schedule_delta`, `proposals_reflected`, `refused_by_code`, `ImportSchedule` — plus the field-map door and the run routes), `migrations/NNNN_schedule_runs_and_field_map.sql`, `reference/cvn73/CVN73-fieldmap.json`, `reference/p6-sample/CVN73-PIA26-yardshape.xer` (UTF-8 text, ~60 lines: UDF `COMPT`, activity code type `LOC`, two projects, three `TT_LOE`, one `TT_WBS`, one `TT_FinMile`, one `RT_Mat` and one `RT_Equip` assignment, one cross-project predecessor, one bad date, one width error, no `rsrc_type` on one variant row), `crates/wadl-api/tests/schedule_runs.rs`, `shell-web/src/ScheduleDoor.tsx`, `shell-web/src/scheduleDoor.test.ts`.

Touched (Rust, 14): `crates/wadl-ingest/src/lib.rs` (`pub mod field_map; pub mod encoding;` `Rejection` gains `table`, `code`, `class` with defaults), `xer.rs`, `crates/wadl-ingest/tests/xer.rs`, `crates/wadl-store/src/model.rs`, `repo.rs`, `memory.rs`, `pg_repo.rs`, `crates/wadl-store/tests/pg_rls.rs`, `crates/wadl-api/Cargo.toml` (`sha2.workspace = true`), `crates/wadl-api/src/lib.rs` (`mod schedule_door`; seven route lines), `routes.rs`, `schedule.rs`, `handlers.rs` (removals; `ledger_document`, `DryRun`, `mapping_report`, `proposal_rows`, `same_days`, `reconcile` → `pub(crate)`; `timeframe` and `list_activities` add `schedule_run`), `documents.rs` (`-fieldmap.json`, `LoadedDocuments.field_map`), `bin/serve.rs`, `crates/wadl-cli/src/main.rs`; generated `tests/generated_leak_test.rs`, `docs/ssp-input.md`.

Touched (shell, 6): `api.ts`, `ingest.ts`, `ingest.test.ts`, `SourcesBoard.tsx`, `Chrome.tsx`, `App.tsx`. Docs: `docs/execution-plan.md` (row), `docs/p6-ingest-schema.md` (field map, encoding, LOE, runs — replaces the "not yet consumed" lines it closes), `docs/demo-script.md` §4, `README.md` CLI line.

Twenty-nine source files, over the fifteen preference because the barrier runs from bytes to breadcrumb. **Cut line** after build step 7 below: steps 1–7 close B4 (map, quarantine, encoding, labor, projects, LOE, runs recorded) with the door and the card; the tail is diff/serve-prior-run, the breadcrumb and the CLI survey.

## Tests

`crates/wadl-ingest/src/encoding.rs` tests: `utf8_passes_through_borrowed_and_a_bom_is_stripped`; `windows_1252_quotes_dashes_accents_and_the_euro_decode` (the shared literal); `the_five_undefined_bytes_keep_their_code_points`. `field_map.rs` tests: `the_default_map_is_todays_convention`; `validate_refuses_resource_outside_trade_a_blank_name_and_a_duplicate_project`.

`crates/wadl-ingest/tests/xer.rs` (existing eight unchanged; `the_sample_export_ingests_whole` now asserts `rejected.is_empty()` **and** `fields_seen`): `the_default_map_reproduces_the_old_report_exactly` (`ingest_xer` == `ingest_xer_with(default)` on both samples); `the_yard_shaped_export_locates_through_a_named_udf_and_an_activity_code` (COMPT → High; LOC → Medium; label-only match is a finding); `material_and_equipment_assignments_are_not_man_hours` (labor 40 MH, `material_skipped == 1`, trade from the labor row; a file without `rsrc_type` counts everything and says so); `level_of_effort_and_wbs_summary_rows_are_excluded_and_listed`; `a_project_filter_serves_one_project_and_quarantines_cross_project_logic` (class `cross_project_logic`, reason names the other project; no filter → finding *2 projects in this export*); `a_finish_milestone_is_a_key_event`; `a_bad_row_is_quarantined_with_its_class_and_the_rest_ingests`.

`crates/wadl-api/tests/schedule_runs.rs` (in-memory app, `TestClock`): `a_quarantined_row_no_longer_refuses_the_file_and_is_served_in_the_preview`; `a_file_with_no_surviving_activity_is_still_refused_whole`; `a_dry_run_surveys_the_fields_and_stores_no_run`; `an_inline_field_map_relocates_the_work_and_a_commit_stores_it_with_two_ledger_lines`; `every_commit_is_a_run_and_the_served_pointer_moves` (two commits → `seq` 1, 2; `served` on 2; `/timeframe.schedule_run.run_id` matches); `activity_ids_are_stable_across_reimports_and_differ_by_hull`; `a_diff_between_two_runs_counts_moves_and_refusals`; `serving_a_prior_run_is_ledgered_and_the_register_follows`; `revert_to_generated_keeps_the_run_history`; `the_field_map_door_refuses_a_malformed_map_whole_and_reverts_to_default`; `the_reference_hull_boots_with_its_field_map_and_a_boot_run` (`load_demo_docs` + `load_xer` on `reference/cvn73` and the full XER: `via == "boot"`, 5,706 rows, 0 quarantined); `a_windows_1252_export_loads_through_the_boot_path` (bytes built in the test from the shared literal). Existing `activities.rs`: `the_reimport_delta_is_served_and_ledgered` asserts the new `run_id` in the detail; `an_alien_file_is_refused_not_previewed` unchanged.

`crates/wadl-store/tests/pg_rls.rs`: `schedule_runs_round_trip_serve_a_prior_run_and_stay_in_tenant` (two commits, list newest first, the navy scope sees none, serve run 1, `served_schedule_run` follows, `list_activities` serves run 1's rows); `the_field_map_round_trips_and_stays_in_tenant`. Generated leak tests: seven new rows.

Shell — `scheduleDoor.test.ts`: `decodes a windows-1252 export and says so` (Node's `TextDecoder("windows-1252")`; the shared bytes), `a utf-8 export passes through as utf-8`, `fieldChoices lists the file's own fields with their row counts and (none)`, `fieldMapSummary and quarantineSummary read in yard words`. `ingest.test.ts`: `deltaSummary` cases unchanged.

## Acceptance

1. `scripts/dev.sh`; banner: `field map: CVN73-fieldmap.json` and `schedule of record: CVN73-PIA26-full.xer — 5706 activities, 0 quarantined, utf-8, map CVN73-fieldmap.json`. `curl …/timeframe` → `schedule_run.seq == 1`, `imported_by.via == "boot"`; `…/schedule-runs` lists it as served.
2. `curl -X POST '…/schedule-of-record?dry_run=true'` with `reference/p6-sample/CVN73-PIA26-yardshape.xer` under the stored map → `mapping.located_authored == 0`, `fields_seen.udfs[].name` contains `COMPT`, `quarantine` has two rows (`unparseable_date`, `width`) with line numbers, `exclusions.loe` has three codes, `run.counts.material_skipped == 1`, `findings` mentions two projects. Re-post with `field_map.compartment = {udf, COMPT}` and `projects = ["CVN73-PIA26"]` → located 8 of 9 (7 High, 1 Medium via LOC), `exclusions.project` non-empty, one `cross_project_logic` quarantine. Commit → `run_id`; `/ledger` newest two: `DOCUMENT_REPLACED p6_field_map`, `SCHEDULE_REPLACED` with `counts.quarantined == 1`.
3. Browser, Data Sources: upload the yard-shaped file → the staged line reads *location: 0 of 9 authored*, the Field map panel's Compartment select offers *UDF: COMPT (8 rows)*; pick it → *8 of 9 authored*; the Quarantine fold lists the reasons; Confirm. The breadcrumb reads *reading CVN73-PIA26-yardshape.xer · imported 09/04 14:12 by org …0001 (no person on record)*.
4. Runs table shows `#2 … SERVED` and `#1 CVN73-PIA26-full.xer`; *diff vs served* on #1 renders `vs … : +5,697 new · −8 gone …`; *serve this run* on #1 → the breadcrumb flips back to the full export, the Sequence Board re-renders 5,706 rows with the same `activity_id`s as before (verify: open an inspector, re-import the full file, the inspector stays open).
5. Save the yard-shaped file as Windows-1252 (`iconv -f utf-8 -t cp1252`); upload: the card says *windows-1252 (decoded by the browser)*, the *é* in a task name renders correctly, the run records `encoding: windows-1252`. `WADL_SCHEDULE_XER=<that file> scripts/dev.sh` boots and the banner says `windows-1252`.
6. `wadl ingest-xer --input reference/p6-sample/CVN73-PIA26-yardshape.xer --survey` prints projects, UDF names, activity code types, resource types, task types, section counts, encoding, quarantine classes with line numbers — and no task code or name.
7. Kill the API: the breadcrumb reads *schedule source unavailable*; the Runs table reads *run history unavailable*. `WADL_DEMO=seed`: breadcrumb *reading the generated register*, the door works on the 24-space hull, the map panel offers only `(none)` until a file is staged. With `DATABASE_URL`: `pg_rls` proves both round trips.
8. Gates: fmt, clippy `-D warnings` pedantic, `cargo test --workspace --all-features`, `gen-leak-tests --check`, `gen-ssp --check`, `pg_rls`, `npm run typecheck`, `vitest`, `npm run build`. `handlers.rs` is shorter than before.

## Demo moment

Data Sources, the scheduler beside you. Upload the export their P6 actually produced, saved from Windows: the card says *windows-1252, decoded*, and *0 of 9 located — this file carries no field named `compartment`; it carries `COMPT` and an activity code `LOC`.* Pick `COMPT`. Eight of nine light up authored; the ninth says why, with its line number; the three level-of-effort rows and the DSRA project's rows are listed as excluded, not lost; the staging pallet's material line is not in anyone's man-hours. Confirm. The breadcrumb now says whose export this is and when it came in; the ledger has the map and the run; the Runs fold shows last week's beside it with a diff. *Serve this run* on last week's — the whole product steps back one week, ledgered, and the row the inspector was open on is still the same row.

## Depends on / conflicts with

- **S10 (yard clock)**: both change `ingest_xer`'s signature and `parse_when`. If S10 lands first, the entry point is `ingest_xer_with(input, label, &FieldMap, &YardClock)` and `load_xer` reads both `yard_clock_of` and `field_map_of`; the migration's CHECK list includes `yard_clock`. Both touch `timeframe`, `serve.rs`'s banner, `documents.rs`'s loader, `SourcesBoard.tsx`, `App.tsx`, `Chrome.tsx` — build after S10 lands, not in parallel. `ledger_document` → `pub(crate)` is the same edit in both; take whichever lands first.
- **S12 (person)**: fills `ImportedBy.person` from the proxy header and drops the amber suffix; nothing else changes.
- **S13-rules (B11)** consumes `work_type`; **S14** (CLI data load) reuses `schedule_door`'s functions and `--field-map`; **S11 morning meeting** asked for `TT_FinMile` here — done.
- `Chrome.tsx` is reserved by the charter for S10/S12/S18: this slice's one prop and one line must rebase on whichever of those has landed.

## Risks

- A yard whose compartment lives in a WBS level or a `task_code` prefix has no source kind here; `placards_from_names` and `wbs_area` catch some; add `{"source":"wbs_level","depth":n}` when the real export shows it (a data change to `FieldSource`, one match arm).
- Two decoders (browser, server) must agree: the shared literal pins both, and the run says which one decoded.
- `serve_schedule_run` on PostgreSQL copies a multi-megabyte jsonb inside one transaction; measured on the full export it is a single row write. Run docs accumulate (~2 MB per 5,700 rows); the in-memory cap is 12, PostgreSQL keeps all — S16's runbook notes it.
- Refactoring the door out of `handlers.rs` moves ~300 lines; the existing `activities.rs` suite is the regression net, and `mapping_report`/`reconcile` stay where `list_activities` uses them.
- Quarantining instead of refusing shifts the risk to *reading the list*: the card's counts are red when non-zero and the ledger carries them, but a scheduler who never opens the fold serves a schedule minus its quarantine. The card's summary line always states the count.
- Stable ids change every served `activity_id` once (the `0xB…` range disappears): nothing persists them (proposals key on `code`), verified by grep before build.

## Needs from the yard

- One real XER export and the answers the survey cannot give: which UDF or activity code carries the compartment, the work item, the work type and the trade; which project(s) are this hull's availability; whether LOE rows should stay excluded or be shown as *support* on the shift board.
- The export's encoding as P6 writes it on their server (Windows-1252 assumed; UTF-16 exports exist and would need a fourth branch in `decode_xer`).
- Whether `task_code` is stable across their re-baselines (the stable-id assumption; 0009's comment already flags it).

## Estimate

About 9 agent-hours in three sittings. **A (ingest + store + migration, ~3 h)**: `encoding.rs` + `field_map.rs` + `xer.rs` through the map, labor, projects, LOE, survey, the yard-shaped fixture and tests 1.5; `model.rs` run types, both stores, migration, `pg_rls` 1.5. **B (door + boot + CLI, ~3 h)**: `schedule_door.rs` (move + runs + field-map door + diff/serve), routes, leak/SSP regen, stable ids, `timeframe`/`activities`, boot loader, `serve.rs`, API tests 2.5; CLI survey 0.5. **C (shell, ~3 h)**: `api.ts`/`ingest.ts` + tests 0.75; `ScheduleDoor.tsx` 1.25; card, breadcrumb, `App.tsx`, browser verification, docs 1.0. Build order: encoding → field map → xer → store + migration → door + routes → stable ids → boot/CLI (**cut line**) → runs list/diff/serve → shell panel → breadcrumb → survey → docs.
