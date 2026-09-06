//! The schedule-of-record door: a P6 XER export becomes the hull's served
//! register, previewed before Confirm and ledgered on commit.
//!
//! Moved out of `handlers.rs` so the XER path has one home: the import, the
//! revert, the re-import delta and the proposal reflection it answers with.
//! The location-mapping report and the reconciliation stay in `handlers`
//! because the activity read serves them on every response, not only here.

use axum::extract::{Path, Query, State};
use axum::Json;
use serde_json::{json, Value};
use uuid::Uuid;

use wadl_domain::ids::VesselId;

use crate::auth::Caller;
use crate::error::ApiError;
use crate::handlers::{
    ledger_document, mapping_report, proposal_rows, read_import_body, reconcile, same_days, DryRun,
};
use crate::AppState;

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
    scope: &wadl_store::TenantScope,
    vessel: VesselId,
    incoming: &[wadl_store::model::ActivitySummary],
) -> Result<Value, ApiError> {
    use std::collections::{BTreeMap, BTreeSet};
    const EXAMPLES: usize = 6;
    let current = state.store.list_activities(scope, vessel).await?;
    let baseline = state
        .store
        .schedule_source(scope, vessel)
        .await?
        .unwrap_or_else(|| "the generated demo register".to_owned());

    let old: BTreeMap<&str, &wadl_store::model::ActivitySummary> =
        current.iter().map(|a| (a.code.as_str(), a)).collect();
    let new: BTreeMap<&str, &wadl_store::model::ActivitySummary> =
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
    let before = refused_by_code(&hull, &current);
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

    let proposals = proposals_reflected(state, scope, vessel, &current, incoming).await?;

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
    scope: &wadl_store::TenantScope,
    vessel: VesselId,
    current: &[wadl_store::model::ActivitySummary],
    incoming: &[wadl_store::model::ActivitySummary],
) -> Result<Value, ApiError> {
    let new: std::collections::BTreeMap<&str, &wadl_store::model::ActivitySummary> =
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
    acts: &[wadl_store::model::ActivitySummary],
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

/// The import half of the schedule-of-record area: a P6 XER export, posted as
/// text, becomes the hull's served register.
///
/// All-or-nothing: one rejected line refuses the whole import with the
/// rejection reasons in the response, because a partially loaded schedule
/// presenting as the whole one is the lie the ingest grading exists to
/// prevent. The scope check runs first — the body is read by hand after it,
/// so a foreign hull is not-found before a single body byte is buffered.
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
    // The export's wall clock is the yard's: read in the hull's clock, and
    // the record remembers which one, so a later clock change can say
    // "re-import" instead of serving instants four hours out.
    let clock = crate::yard_clock::clock_in_effect(state.store.as_ref(), &scope, vessel).await?;
    let parsed =
        crate::schedule::parse_xer_in(&body.label, &body.xer, &clock.clock, &clock.parsed_in())
            .map_err(|reasons| ApiError::OutOfRange(format!("XER rejected: {reasons}")))?;
    let clock_served = json!({ "zone": clock.clock.zone, "label": clock.label });
    let wall_clock_findings = parsed.wall_clock_findings;
    let sor = parsed.sor;
    // A file that parses to nothing is refused, not previewed: every line of
    // an alien file reads as XER "header noise", so without this check a
    // grabbed-the-wrong-file upload sails to a live Confirm button whose
    // click would empty every board.
    if sor.activities.is_empty() {
        return Err(ApiError::OutOfRange(
            "XER rejected: the file carries no activities — no TASK section was found.              Is this a Primavera P6 XER export?"
                .to_owned(),
        ));
    }
    let activities = sor.activities.len();
    let edges = sor.edges.len();
    // The dry run: everything the import would say, nothing it would do —
    // including the reconciliation the reader currently only sees AFTER the
    // swap, and the location-mapping report. Committing a schedule blind was
    // the sharpest edge on this door.
    let reconciliation = reconcile(&state, &scope, vessel, &sor.activities).await?;
    let compartments = state.store.list_compartments(&scope, vessel).await?;
    let mapping = mapping_report(&sor.activities, &compartments);
    let delta = schedule_delta(&state, &scope, vessel, &sor.activities).await?;
    if dry.dry_run.unwrap_or(false) {
        return Ok(Json(json!({
            "dry_run": true,
            "label": body.label,
            "activities": activities,
            "edges": edges,
            "reconciliation": reconciliation,
            "mapping": mapping,
            "delta": delta,
            "clock": clock_served,
            "wall_clock_findings": wall_clock_findings,
        })));
    }
    let parsed_in = sor.parsed_in.clone();
    state
        .store
        .set_schedule_of_record(&scope, vessel, sor)
        .await?;
    // The reissue's record: what replaced what, and what the replacement did
    // to the constraints — hash-chained, so the answer to "what did that
    // re-baseline change" cannot be quietly rewritten later.
    let detail = serde_json::to_string(&json!({
        "label": body.label,
        "activities": activities,
        "edges": edges,
        "delta": delta,
        "parsed_in": parsed_in,
    }))
    .unwrap_or_else(|_| format!("{{\"label\":\"{}\"}}", body.label));
    state
        .store
        .append_audit(
            &scope,
            vessel,
            "SCHEDULE_REPLACED",
            &detail,
            None,
            state.clock.now().epoch_millis(),
        )
        .await?;
    Ok(Json(json!({
        "label": body.label,
        "activities": activities,
        "edges": edges,
        "reconciliation": reconciliation,
        "mapping": mapping,
        "delta": delta,
        "clock": clock_served,
        "wall_clock_findings": wall_clock_findings,
    })))
}

/// Reverts the hull to its generated register, discarding the ingested
/// schedule of record. The undo the import door needs to be safe to try.
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

/// The body of a schedule-of-record import.
#[derive(Debug, serde::Deserialize)]
pub(crate) struct ImportSchedule {
    /// Where the export came from, shown on the register as its source.
    pub(crate) label: String,
    /// The XER file, verbatim.
    pub(crate) xer: String,
}
