//! The schedule-of-record door, the field-map door, and the run history.
//!
//! A P6 XER export becomes the hull's served register here — previewed
//! before Confirm, quarantined by row rather than refused by file, read
//! through the hull's field map and yard clock, and recorded as a run every
//! time it is committed. The field map — which of the export's fields carry
//! the compartment, the work item, the work type and the trade — is a
//! document of its own with the same door discipline (`GET`, `POST` with
//! `?dry_run=true`, `POST …/revert`, ledgered), and the XER door accepts one
//! inline so the map can be chosen from the file's own fields on the card.
//! Every run can be listed, inspected, diffed against another, and served
//! again; serving a prior run is ledgered like an import.
//!
//! The location-mapping report and the reconciliation stay in `handlers`
//! because the activity read serves them on every response, not only here.
//!
//! How bytes reach the server: the JSON body carries the export as text, so
//! the browser decodes the file (UTF-8, or Windows-1252 when UTF-8 fails)
//! and sends `encoding` as the hint of which branch it took; the run records
//! `decoded_by: "browser"`. A caller that sends no hint has already decoded
//! the file too (a JSON string is Unicode), so the run records `utf-8` and
//! `decoded_by: "caller"`. The boot loader and the CLI read bytes and decode
//! on the server (`decoded_by: "server"`).

use axum::extract::{Path, Query, State};
use axum::Json;
use serde_json::{json, Value};
use uuid::Uuid;

use wadl_domain::ids::VesselId;
use wadl_ingest::field_map::{FieldMap, FieldsSeen};
use wadl_store::memory::FieldMapDoc;
use wadl_store::model::{ActivitySummary, ScheduleRun, ScheduleRunSummary};
use wadl_store::TenantScope;

use crate::auth::Caller;
use crate::error::ApiError;
use crate::handlers::{
    ledger_document, mapping_report, proposal_rows, read_import_body, reconcile, same_days, DryRun,
};
use crate::schedule::{self, ParsedSchedule, RunInputs};
use crate::AppState;

/// The document kind the field map is stored and ledgered under.
const FIELD_MAP_KIND: &str = "p6_field_map";

// ---------------------------------------------------------------------------
// The re-import delta.
// ---------------------------------------------------------------------------

/// The re-import delta: what an incoming schedule changes against the
/// register currently served — the question a weekly re-baseline actually
/// raises. P6's own compare tools can say which dates moved; only this
/// platform can say which moves land work inside a constraint, because that
/// answer takes the coupling graph, the live hazards and the rules in force —
/// none of which are in the file. Computed at the import door so the
/// consequences are on the table BEFORE Confirm, and recorded in the ledger
/// at commit so "what did the week-34 reissue change" stays answerable.
async fn schedule_delta(
    state: &AppState,
    scope: &TenantScope,
    vessel: VesselId,
    incoming: &[ActivitySummary],
) -> Result<Value, ApiError> {
    let current = state.store.list_activities(scope, vessel).await?;
    let baseline = state
        .store
        .schedule_source(scope, vessel)
        .await?
        .unwrap_or_else(|| "the generated demo register".to_owned());
    delta_between(state, scope, vessel, &baseline, &current, incoming).await
}

/// The delta between any two registers under today's hull inputs — the
/// door's, and the run-to-run diff's. `baseline` names what `current` is.
async fn delta_between(
    state: &AppState,
    scope: &TenantScope,
    vessel: VesselId,
    baseline: &str,
    current: &[ActivitySummary],
    incoming: &[ActivitySummary],
) -> Result<Value, ApiError> {
    use std::collections::{BTreeMap, BTreeSet};
    const EXAMPLES: usize = 6;

    let old: BTreeMap<&str, &ActivitySummary> =
        current.iter().map(|a| (a.code.as_str(), a)).collect();
    let new: BTreeMap<&str, &ActivitySummary> =
        incoming.iter().map(|a| (a.code.as_str(), a)).collect();

    let mut added = 0usize;
    let mut retimed = 0usize;
    let mut rehoused = 0usize;
    let mut rebudgeted = 0usize;
    for (code, a) in &new {
        match old.get(code) {
            None => added += 1,
            Some(o) => {
                if o.planned != a.planned {
                    retimed += 1;
                }
                if o.compartment_no != a.compartment_no {
                    rehoused += 1;
                }
                if o.budget_hours != a.budget_hours {
                    rebudgeted += 1;
                }
            }
        }
    }
    let removed = old.keys().filter(|c| !new.contains_key(*c)).count();

    // The constraint half: executability under the SAME hull inputs, before
    // and after — so any shift is the schedule's doing, not the hazards'.
    // "Same inputs" means the hazards live now, on the wall clock.
    let graph = state.store.adjacency_graph(scope, vessel).await?;
    let hazards = state
        .store
        .live_hazards(scope, vessel, state.clock.now())
        .await?;
    let rules = state.store.rules_in_force(scope, vessel).await?;
    let hull = wadl_issues::Hull {
        graph: &graph,
        rules: &rules,
        hazards: &hazards,
    };
    let before = refused_by_code(&hull, current);
    let after = refused_by_code(&hull, incoming);
    let before_keys: BTreeSet<&String> = before.keys().collect();
    let after_keys: BTreeSet<&String> = after.keys().collect();

    let newly_refused: Vec<Value> = after
        .iter()
        .filter(|(code, _)| !before_keys.contains(code))
        .take(EXAMPLES)
        .map(|(code, (space, rule))| json!({ "code": code, "space": space, "rule": rule }))
        .collect();
    let newly_refused_count = after_keys.difference(&before_keys).count();
    // Cleared = was refused, still present, no longer refused. A refusal that
    // vanished because its activity was deleted is the `removed` column's
    // story, not a constraint clearing.
    let newly_clear: Vec<Value> = before
        .iter()
        .filter(|(code, _)| !after_keys.contains(code) && new.contains_key(code.as_str()))
        .take(EXAMPLES)
        .map(|(code, (space, rule))| json!({ "code": code, "space": space, "rule": rule }))
        .collect();
    let newly_clear_count = before
        .keys()
        .filter(|code| !after_keys.contains(code) && new.contains_key(code.as_str()))
        .count();

    let proposals = proposals_reflected(state, scope, vessel, current, incoming).await?;

    Ok(json!({
        "baseline": baseline,
        "added": added,
        "removed": removed,
        "retimed": retimed,
        "rehoused": rehoused,
        "rebudgeted": rebudgeted,
        "refused_before": before.len(),
        "refused_after": after.len(),
        "newly_refused": { "count": newly_refused_count, "examples": newly_refused },
        "newly_clear": { "count": newly_clear_count, "examples": newly_clear },
        "proposals": proposals,
    }))
}

/// The loop closing where it started: which open proposals an incoming
/// export reflects, to the day. Answered at the door so the planner sees
/// what P6 took before Confirm.
async fn proposals_reflected(
    state: &AppState,
    scope: &TenantScope,
    vessel: VesselId,
    current: &[ActivitySummary],
    incoming: &[ActivitySummary],
) -> Result<Value, ApiError> {
    let new: std::collections::BTreeMap<&str, &ActivitySummary> =
        incoming.iter().map(|a| (a.code.as_str(), a)).collect();
    let open: Vec<Value> = proposal_rows(state, scope, vessel, current)
        .await?
        .into_iter()
        .filter(|p| p.get("status").is_some_and(|s| s == "open"))
        .collect();
    let (reflected, still_open): (Vec<&Value>, Vec<&Value>) = open.iter().partition(|p| {
        proposal_activity(p)
            .and_then(|code| new.get(code))
            .is_some_and(|a| p.get("to").is_some_and(|to| same_days(to, a.planned)))
    });
    let codes = |ps: &[&Value]| -> Vec<String> {
        ps.iter()
            .filter_map(|p| proposal_activity(p).map(str::to_owned))
            .collect()
    };
    Ok(json!({
        "open": open.len(),
        "reflected": codes(&reflected),
        "still_open": codes(&still_open),
    }))
}

/// The activity code a proposal row names.
fn proposal_activity(p: &Value) -> Option<&str> {
    p.get("activity").and_then(Value::as_str)
}

/// The activities a hull refuses as planned, by code, with the space and
/// the governing rule — one side of the re-import delta's constraint half.
fn refused_by_code(
    hull: &wadl_issues::Hull<'_>,
    acts: &[ActivitySummary],
) -> std::collections::BTreeMap<String, (String, String)> {
    acts.iter()
        .filter(|a| !a.is_milestone)
        .filter_map(|a| {
            match wadl_issues::executability(hull, a.compartment_no.as_ref(), a.planned) {
                wadl_issues::Executability::NotExecutable(r) => Some((
                    a.code.clone(),
                    (
                        a.compartment_no
                            .as_ref()
                            .map_or_else(String::new, |c| c.as_str().to_owned()),
                        r.rule_code,
                    ),
                )),
                _ => None,
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// The field map in effect.
// ---------------------------------------------------------------------------

/// The map an import reads through, and where it came from: `inline` (the
/// body carried one), `document` (the hull's stored map), `default`.
struct MapInEffect {
    map: FieldMap,
    source: &'static str,
    /// The stored map, parsed — what an inline map is compared against on
    /// commit to decide whether the field-map document changes hands.
    stored: Option<FieldMap>,
}

/// Parses and validates a map from its wire form. Refused whole (422) with
/// every reason: a shape serde cannot read, or a map [`FieldMap::validate`]
/// will not have.
fn field_map_from_value(value: &Value) -> Result<FieldMap, ApiError> {
    let map: FieldMap = serde_json::from_value(value.clone())
        .map_err(|e| ApiError::OutOfRange(format!("the field map was refused whole: {e}")))?;
    map.validate().map_err(|problems| {
        ApiError::OutOfRange(format!(
            "the field map was refused whole: {}",
            problems.join("; ")
        ))
    })?;
    Ok(map)
}

/// The hull's stored map, parsed. A stored document that will not parse is
/// a store written around the door — an internal error, not the caller's.
async fn stored_field_map(
    state: &AppState,
    scope: &TenantScope,
    vessel: VesselId,
) -> Result<Option<(FieldMap, String)>, ApiError> {
    let Some(doc) = state.store.field_map(scope, vessel).await? else {
        return Ok(None);
    };
    let (map, label) = schedule::field_map_in_effect(Some(&doc)).map_err(|reason| {
        eprintln!("{}", json!({ "event": "backend_error", "detail": reason }));
        ApiError::Internal
    })?;
    Ok(Some((map, label.unwrap_or(doc.label))))
}

async fn map_in_effect(
    state: &AppState,
    scope: &TenantScope,
    vessel: VesselId,
    inline: Option<&Value>,
) -> Result<MapInEffect, ApiError> {
    let stored = stored_field_map(state, scope, vessel).await?;
    match inline {
        Some(value) => Ok(MapInEffect {
            map: field_map_from_value(value)?,
            source: "inline",
            stored: stored.map(|(m, _)| m),
        }),
        None => match stored {
            Some((map, _)) => Ok(MapInEffect {
                map,
                source: "document",
                stored: None,
            }),
            None => Ok(MapInEffect {
                map: FieldMap::default(),
                source: "default",
                stored: None,
            }),
        },
    }
}

/// The encoding a text body claims, and who decoded it. The hint is the
/// browser's report of which branch its decoder took; refused when it names
/// an encoding neither decoder has.
fn encoding_of(hint: Option<&str>) -> Result<(String, &'static str), ApiError> {
    match hint.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        None => Ok(("utf-8".to_owned(), "caller")),
        Some(e @ ("utf-8" | "windows-1252")) => Ok((e.to_owned(), "browser")),
        Some(other) => Err(ApiError::OutOfRange(format!(
            "encoding {other:?} is not one this door reads — send \"utf-8\" or \"windows-1252\""
        ))),
    }
}

// ---------------------------------------------------------------------------
// The XER door.
// ---------------------------------------------------------------------------

/// The body of a schedule-of-record import.
#[derive(Debug, serde::Deserialize)]
pub(crate) struct ImportSchedule {
    /// Where the export came from, shown on the register as its source.
    pub(crate) label: String,
    /// The XER file as text — decoded by whoever posted it.
    pub(crate) xer: String,
    /// Which branch the poster's decoder took: `utf-8` or `windows-1252`.
    #[serde(default)]
    pub(crate) encoding: Option<String>,
    /// A field map to read this file through instead of the hull's stored
    /// one; committed with the run when it differs.
    #[serde(default)]
    pub(crate) field_map: Option<Value>,
}

/// The dry-run and commit responses share everything but `dry_run`,
/// `run_id` and `seq`: the counts, the reconciliation, the location mapping,
/// the delta, the clock, the run as it would be recorded, the survey, the
/// quarantine, the exclusions and the findings.
fn door_response(
    label: &str,
    parsed: &ParsedSchedule,
    run: &ScheduleRun,
    map_source: &str,
    parts: [(&str, Value); 4],
) -> serde_json::Map<String, Value> {
    let mut out = serde_json::Map::new();
    out.insert("label".to_owned(), json!(label));
    out.insert("activities".to_owned(), json!(run.summary.counts.served));
    out.insert("edges".to_owned(), json!(run.summary.counts.edges));
    for (key, value) in parts {
        out.insert(key.to_owned(), value);
    }
    out.insert(
        "wall_clock_findings".to_owned(),
        json!(parsed.report.wall_clock_findings),
    );
    out.insert(
        "run".to_owned(),
        json!({
            "encoding": run.summary.encoding,
            "decoded_by": run.summary.decoded_by,
            "projects_served": run.summary.projects_served,
            "counts": run.summary.counts,
            "field_map": run.summary.field_map,
            "field_map_source": map_source,
        }),
    );
    out.insert("fields_seen".to_owned(), json!(parsed.report.fields_seen));
    out.insert("quarantine".to_owned(), json!(run.report.quarantine));
    out.insert(
        "exclusions".to_owned(),
        json!({
            "loe": run.report.excluded_loe,
            "wbs": run.report.excluded_wbs,
            "project": run.report.excluded_project,
        }),
    );
    out.insert("findings".to_owned(), json!(parsed.report.findings));
    out
}

/// The hashed record of a schedule changing hands: what replaced what, who,
/// through which map and encoding, what was set aside, and what the
/// replacement did to the constraints.
fn schedule_replaced_detail(
    summary: &ScheduleRunSummary,
    parsed_in: Option<&str>,
    delta: &Value,
    map_source: &str,
) -> Value {
    json!({
        "label": summary.label,
        "activities": summary.counts.served,
        "edges": summary.counts.edges,
        "delta": delta,
        "parsed_in": parsed_in,
        "run_id": summary.run_id,
        "seq": summary.seq,
        "imported_by": summary.imported_by,
        "encoding": summary.encoding,
        "decoded_by": summary.decoded_by,
        "field_map": summary.field_map,
        "field_map_source": map_source,
        "counts": summary.counts,
    })
}

async fn ledger_schedule_replaced(
    state: &AppState,
    scope: &TenantScope,
    vessel: VesselId,
    detail: Value,
) -> Result<(), ApiError> {
    let detail = serde_json::to_string(&detail).unwrap_or_default();
    state
        .store
        .append_audit(
            scope,
            vessel,
            "SCHEDULE_REPLACED",
            &detail,
            None,
            state.clock.now().epoch_millis(),
        )
        .await?;
    Ok(())
}

/// Stores a map and writes its ledger line — the field-map door's commit,
/// and the XER door's when an inline map differs from the stored one.
async fn commit_field_map(
    state: &AppState,
    scope: &TenantScope,
    vessel: VesselId,
    label: &str,
    map: &FieldMap,
) -> Result<(), ApiError> {
    let doc = FieldMapDoc {
        label: label.to_owned(),
        map: serde_json::to_value(map).unwrap_or_default(),
    };
    state.store.set_field_map(scope, vessel, doc).await?;
    ledger_document(
        state,
        scope,
        vessel,
        "DOCUMENT_REPLACED",
        FIELD_MAP_KIND,
        Some(label),
        json!({ "summary": map.summary(), "projects": map.projects.len() }),
    )
    .await
}

/// The import half of the schedule-of-record area: a P6 XER export, posted
/// as text, becomes the hull's served register.
///
/// Rows the parser cannot honestly accept are quarantined with their line
/// and reason and served in the preview, the run and the ledger; the file is
/// refused whole (422) only when it carries no `TASK` section, when not one
/// activity survives, when it exceeds the parser's cell ceiling, or when the
/// inline map is malformed. The scope check runs first — the body is read
/// by hand after it, so a foreign hull is not-found before a single body
/// byte is buffered.
pub(crate) async fn import_schedule(
    State(state): State<AppState>,
    Caller { scope, .. }: Caller,
    Path(id): Path<Uuid>,
    Query(dry): Query<DryRun>,
    req: axum::extract::Request,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    state.store.get_vessel(&scope, vessel).await?;
    let body: ImportSchedule = read_import_body(req).await?;
    let (encoding, decoded_by) = encoding_of(body.encoding.as_deref())?;
    let map = map_in_effect(&state, &scope, vessel, body.field_map.as_ref()).await?;
    // The export's wall clock is the yard's: read in the hull's clock, and
    // the record remembers which one, so a later clock change can say
    // "re-import" instead of serving instants four hours out.
    let clock = crate::yard_clock::clock_in_effect(state.store.as_ref(), &scope, vessel).await?;
    let parsed = schedule::parse_xer_in(
        vessel,
        &body.label,
        &body.xer,
        &map.map,
        &clock.clock,
        &clock.parsed_in(),
    )
    .map_err(ApiError::OutOfRange)?;
    let clock_served = json!({ "zone": clock.clock.zone, "label": clock.label });
    // The dry run: everything the import would say, nothing it would do —
    // including the reconciliation and the location-mapping report.
    // Committing a schedule blind was the sharpest edge on this door.
    let reconciliation = reconcile(&state, &scope, vessel, &parsed.sor.activities).await?;
    let compartments = state.store.list_compartments(&scope, vessel).await?;
    let mapping = mapping_report(&parsed.sor.activities, &compartments);
    let delta = schedule_delta(&state, &scope, vessel, &parsed.sor.activities).await?;
    let run = schedule::build_run(
        &parsed,
        &RunInputs {
            label: &body.label,
            encoding: &encoding,
            decoded_by,
            imported_by: schedule::imported_by(&scope, "door"),
            imported_at_ms: state.clock.now().epoch_millis(),
            field_map: &map.map,
        },
    );
    let mut response = door_response(
        &body.label,
        &parsed,
        &run,
        map.source,
        [
            ("reconciliation", reconciliation),
            ("mapping", mapping),
            ("delta", delta.clone()),
            ("clock", clock_served),
        ],
    );
    if dry.dry_run.unwrap_or(false) {
        response.insert("dry_run".to_owned(), json!(true));
        return Ok(Json(Value::Object(response)));
    }
    // An inline map that differs from the hull's stored one (or from the
    // default, when none is stored) is committed first, on its own ledger
    // line: the run's map is the document, not a one-off.
    if map.source == "inline" && map.stored.as_ref().unwrap_or(&FieldMap::default()) != &map.map {
        commit_field_map(&state, &scope, vessel, &body.label, &map.map).await?;
    }
    let parsed_in = parsed.sor.parsed_in.clone();
    let summary = state.store.commit_schedule_run(&scope, vessel, run).await?;
    // The reissue's record: what replaced what, and what the replacement did
    // to the constraints — hash-chained, so the answer to "what did that
    // re-baseline change" cannot be quietly rewritten later.
    ledger_schedule_replaced(
        &state,
        &scope,
        vessel,
        schedule_replaced_detail(&summary, parsed_in.as_deref(), &delta, map.source),
    )
    .await?;
    response.insert("run_id".to_owned(), json!(summary.run_id));
    response.insert("seq".to_owned(), json!(summary.seq));
    Ok(Json(Value::Object(response)))
}

/// Reverts the hull to its generated register, discarding the ingested
/// schedule of record. The undo the import door needs to be safe to try.
/// The runs stay: history is history, and any of them can be served again.
pub(crate) async fn revert_schedule(
    State(state): State<AppState>,
    Caller { scope, .. }: Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    state.store.clear_schedule_of_record(&scope, vessel).await?;
    ledger_document(
        &state,
        &scope,
        vessel,
        "DOCUMENT_REVERTED",
        "schedule_of_record",
        None,
        json!({}),
    )
    .await?;
    Ok(Json(json!({ "reverted": true })))
}

// ---------------------------------------------------------------------------
// The field-map door.
// ---------------------------------------------------------------------------

/// The served run's survey of its file, for the card's selects and the
/// map's findings. `None` when no run is served (the generated register, or
/// a document set outside the runs).
async fn served_fields_seen(
    state: &AppState,
    scope: &TenantScope,
    vessel: VesselId,
) -> Result<Option<Value>, ApiError> {
    let Some(served) = state.store.served_schedule_run(scope, vessel).await? else {
        return Ok(None);
    };
    Ok(state
        .store
        .schedule_run(scope, vessel, served.run_id)
        .await?
        .map(|run| run.report.fields_seen))
}

/// `GET /api/vessels/:id/field-map` — the map in effect, where it came from,
/// and the served run's survey of the fields its file carries.
pub(crate) async fn get_field_map(
    State(state): State<AppState>,
    Caller { scope, .. }: Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    state.store.get_vessel(&scope, vessel).await?;
    let stored = stored_field_map(&state, &scope, vessel).await?;
    let fields_seen = served_fields_seen(&state, &scope, vessel).await?;
    let (source, label, map) = match stored {
        Some((map, label)) => ("document", Some(label), map),
        None => ("default", None, FieldMap::default()),
    };
    Ok(Json(json!({
        "source": source,
        "label": label,
        "map": map,
        "fields_seen": fields_seen,
    })))
}

/// The body of a field-map import.
#[derive(Debug, serde::Deserialize)]
pub(crate) struct ImportFieldMap {
    /// Where the map came from, e.g. `CVN73-fieldmap.json`.
    pub(crate) label: String,
    /// The map, in the wire shape `FieldMap` serializes.
    pub(crate) map: Value,
}

/// `POST /api/vessels/:id/field-map[?dry_run=true]` — the hull's field map
/// as a document. Refused whole (422) with every reason; findings against
/// the served run's survey warn without refusing.
pub(crate) async fn import_field_map(
    State(state): State<AppState>,
    Caller { scope, .. }: Caller,
    Path(id): Path<Uuid>,
    Query(dry): Query<DryRun>,
    req: axum::extract::Request,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    state.store.get_vessel(&scope, vessel).await?;
    let body: ImportFieldMap = read_import_body(req).await?;
    if body.label.trim().is_empty() {
        return Err(ApiError::OutOfRange(
            "the field map was refused whole: it carries no label".to_owned(),
        ));
    }
    let map = field_map_from_value(&body.map)?;
    let seen: Option<FieldsSeen> = served_fields_seen(&state, &scope, vessel)
        .await?
        .and_then(|v| serde_json::from_value(v).ok());
    let findings = map.findings_against(seen.as_ref());
    if dry.dry_run.unwrap_or(false) {
        return Ok(Json(json!({
            "stored": false,
            "label": body.label,
            "map": map,
            "findings": findings,
        })));
    }
    commit_field_map(&state, &scope, vessel, &body.label, &map).await?;
    Ok(Json(json!({
        "stored": true,
        "label": body.label,
        "map": map,
        "findings": findings,
    })))
}

/// `POST /api/vessels/:id/field-map/revert` — back to the default
/// convention, and the next import reads today's names again.
pub(crate) async fn revert_field_map(
    State(state): State<AppState>,
    Caller { scope, .. }: Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    state.store.clear_field_map(&scope, vessel).await?;
    ledger_document(
        &state,
        &scope,
        vessel,
        "DOCUMENT_REVERTED",
        FIELD_MAP_KIND,
        None,
        json!({}),
    )
    .await?;
    Ok(Json(json!({ "reverted": true })))
}

// ---------------------------------------------------------------------------
// The run history.
// ---------------------------------------------------------------------------

/// The run ids a history read names. Query-string rather than a path
/// segment because the leak-test generator substitutes `:id` and `:no` only.
#[derive(Debug, Clone, Copy, Default, serde::Deserialize)]
pub(crate) struct RunQuery {
    /// The run in question.
    pub(crate) run: Option<Uuid>,
    /// The run to compare against; the served run when absent.
    pub(crate) against: Option<Uuid>,
}

/// `GET /api/vessels/:id/schedule-runs` — every import, newest first, with
/// the served one pointed to.
pub(crate) async fn list_schedule_runs(
    State(state): State<AppState>,
    Caller { scope, .. }: Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    let runs = state.store.list_schedule_runs(&scope, vessel).await?;
    let served = runs.iter().find(|r| r.served).map(|r| r.run_id);
    Ok(Json(json!({ "served": served, "runs": runs })))
}

/// One run, whole, or a refusal that says which: no `run` named (422), a run
/// the hull does not have (404).
async fn run_named(
    state: &AppState,
    scope: &TenantScope,
    vessel: VesselId,
    run_id: Option<Uuid>,
    what: &str,
) -> Result<ScheduleRun, ApiError> {
    let run_id = run_id.ok_or_else(|| {
        ApiError::OutOfRange(format!("{what} names no run — pass ?{what}=<run_id>"))
    })?;
    state
        .store
        .schedule_run(scope, vessel, run_id)
        .await?
        .ok_or(ApiError::NotFound)
}

/// A run's rows, or the 409 that says the store no longer holds them: the
/// run exists and lists, but the in-memory cap dropped its document, so it
/// can be inspected and not served again or diffed by rows.
fn rows_of(run: &ScheduleRun) -> Result<&wadl_store::memory::ScheduleOfRecord, ApiError> {
    run.doc.as_ref().ok_or_else(|| {
        ApiError::Conflict(format!(
            "run #{} ({}) is older than the last {} runs — its rows are no longer held, so it cannot be served again or diffed by rows; its summary and report still list",
            run.summary.seq,
            run.summary.label,
            wadl_store::memory::MAX_RUN_DOCS
        ))
    })
}

/// `GET /api/vessels/:id/schedule-runs/detail?run=<uuid>` — one run's
/// summary and report, without its rows.
pub(crate) async fn schedule_run_detail(
    State(state): State<AppState>,
    Caller { scope, .. }: Caller,
    Path(id): Path<Uuid>,
    Query(q): Query<RunQuery>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    state.store.get_vessel(&scope, vessel).await?;
    let run = run_named(&state, &scope, vessel, q.run, "run").await?;
    Ok(Json(
        json!({ "summary": run.summary, "report": run.report }),
    ))
}

/// `GET /api/vessels/:id/schedule-runs/diff?run=<uuid>[&against=<uuid>]` —
/// what `run` changes against `against` (the served run by default), in the
/// same shape the door's delta takes, under today's hazards.
pub(crate) async fn diff_schedule_runs(
    State(state): State<AppState>,
    Caller { scope, .. }: Caller,
    Path(id): Path<Uuid>,
    Query(q): Query<RunQuery>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    state.store.get_vessel(&scope, vessel).await?;
    let against_id = match q.against {
        Some(id) => Some(id),
        None => state
            .store
            .served_schedule_run(&scope, vessel)
            .await?
            .map(|s| s.run_id),
    };
    let against_id = against_id.ok_or_else(|| {
        ApiError::OutOfRange(
            "no run is served on this hull — name the run to compare against with ?against=<run_id>"
                .to_owned(),
        )
    })?;
    let run = run_named(&state, &scope, vessel, q.run, "run").await?;
    let against = run_named(&state, &scope, vessel, Some(against_id), "against").await?;
    let incoming = rows_of(&run)?;
    let current = rows_of(&against)?;
    let delta = delta_between(
        &state,
        &scope,
        vessel,
        &against.summary.label,
        &current.activities,
        &incoming.activities,
    )
    .await?;
    Ok(Json(json!({
        "run": run.summary,
        "against": against.summary,
        "delta": delta,
    })))
}

/// The body of a serve-this-run request.
#[derive(Debug, serde::Deserialize)]
pub(crate) struct ServeRun {
    /// The run whose document becomes the schedule of record.
    pub(crate) run_id: Uuid,
}

/// `POST /api/vessels/:id/schedule-runs/serve` — a prior run's document
/// becomes the served schedule of record, with the delta against what was
/// served, ledgered as `SCHEDULE_REPLACED` naming the run it stepped back
/// to and the run it left.
pub(crate) async fn serve_schedule_run(
    State(state): State<AppState>,
    Caller { scope, .. }: Caller,
    Path(id): Path<Uuid>,
    req: axum::extract::Request,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    state.store.get_vessel(&scope, vessel).await?;
    let body: ServeRun = read_import_body(req).await?;
    let run = run_named(&state, &scope, vessel, Some(body.run_id), "run_id").await?;
    let rows = rows_of(&run)?;
    let from_run = state
        .store
        .served_schedule_run(&scope, vessel)
        .await?
        .map(|s| s.run_id);
    let delta = schedule_delta(&state, &scope, vessel, &rows.activities).await?;
    let parsed_in = rows.parsed_in.clone();
    let summary = state
        .store
        .serve_schedule_run(&scope, vessel, body.run_id)
        .await?;
    let mut detail = schedule_replaced_detail(&summary, parsed_in.as_deref(), &delta, "run");
    if let Some(obj) = detail.as_object_mut() {
        obj.insert("reverted_to_run".to_owned(), json!(true));
        obj.insert("from_run".to_owned(), json!(from_run));
    }
    ledger_schedule_replaced(&state, &scope, vessel, detail).await?;
    Ok(Json(json!({ "served": summary, "delta": delta })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_encoding_hint_is_the_browsers_and_absent_means_the_caller_decoded() {
        assert_eq!(encoding_of(None).unwrap(), ("utf-8".to_owned(), "caller"));
        assert_eq!(
            encoding_of(Some(" Windows-1252 ")).unwrap(),
            ("windows-1252".to_owned(), "browser")
        );
        assert!(encoding_of(Some("utf-16")).is_err());
    }

    #[test]
    fn a_malformed_map_is_refused_whole_with_every_reason() {
        let err = field_map_from_value(
            &json!({ "compartment": { "source": "resource" }, "projects": ["a", "a"] }),
        )
        .err()
        .map(|e| format!("{e:?}"))
        .unwrap_or_default();
        assert!(err.contains("resource"), "{err}");
        assert!(err.contains("listed twice"), "{err}");
        let err = field_map_from_value(&json!({ "compartment": { "source": "wbs_level" } }))
            .err()
            .map(|e| format!("{e:?}"))
            .unwrap_or_default();
        assert!(err.contains("refused whole"), "{err}");
        assert!(
            field_map_from_value(&json!({})).is_ok(),
            "an empty object is the default"
        );
    }
}
