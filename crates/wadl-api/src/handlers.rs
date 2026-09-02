//! Request handlers. Thin: they resolve scope, call the store or the engine,
//! and shape the result. No business logic lives here.

use axum::extract::{Path, Query, State};
use axum::Json;
use serde_json::{json, Value};
use uuid::Uuid;

use wadl_domain::compartment::CompartmentNo;
use wadl_domain::ids::VesselId;
use wadl_domain::time::Timestamp;
use wadl_domain::units::ManHours;
use wadl_engine::{evaluate, Decision, EvaluationRequest};
use wadl_plan::governing_constraint;
use wadl_plan::readiness::{roll_up, Readiness, SpaceReadiness};

use crate::auth::Caller;
use crate::error::ApiError;
use crate::AppState;

/// Reads and parses an import door's JSON body — called AFTER the caller's
/// scope has admitted the vessel, so a foreign hull is not-found before a
/// single body byte is buffered. Read by hand against [`crate::MAX_IMPORT_BYTES`]
/// so the generous import ceiling applies to exactly these doors; every other
/// route keeps axum's small default limit.
async fn read_import_body<T: serde::de::DeserializeOwned>(
    req: axum::extract::Request,
) -> Result<T, ApiError> {
    let bytes = axum::body::to_bytes(req.into_body(), crate::MAX_IMPORT_BYTES)
        .await
        .map_err(|_| ApiError::PayloadTooLarge(crate::MAX_IMPORT_BYTES))?;
    serde_json::from_slice(&bytes)
        .map_err(|e| ApiError::OutOfRange(format!("invalid JSON body: {e}")))
}

/// Maps a deferred `Json` rejection to the honest status. The deferral exists
/// so scope is checked before the body is judged; the one thing that must not
/// get flattened in the process is a length-limit trip — that is a 413 with
/// the ceiling named (axum's small default on these routes; the import doors
/// read their own bodies against [`crate::MAX_IMPORT_BYTES`]), not a 422.
fn body_rejection(rejection: &axum::extract::rejection::JsonRejection) -> ApiError {
    // axum's default body ceiling on extractors, which these routes keep.
    const DEFAULT_BODY_LIMIT: usize = 2 * 1024 * 1024;
    if rejection.status() == axum::http::StatusCode::PAYLOAD_TOO_LARGE {
        ApiError::PayloadTooLarge(DEFAULT_BODY_LIMIT)
    } else {
        ApiError::OutOfRange(rejection.body_text())
    }
}

/// The `?as_of=` parameter: the instant the caller wants the answer for.
///
/// Epoch milliseconds, matching how [`Timestamp`] already crosses the wire, so a
/// value read out of one response can be handed straight back in the next.
#[derive(Debug, Clone, Copy, Default, serde::Deserialize)]
pub(crate) struct AsOf {
    pub(crate) as_of: Option<i64>,
}

impl AsOf {
    /// Resolves to a concrete instant, defaulting to the clock and bounded by the
    /// hull's availability.
    ///
    /// Three properties this has to hold, in order of how badly each would hurt:
    ///
    /// 1. **Omitting the parameter is exactly today's behaviour.** The clock is
    ///    read only in that case, so every existing caller is unchanged and the
    ///    default path never depends on a bound.
    /// 2. **An instant outside the availability is refused, not clamped.** The
    ///    hull has no hazards, no schedule and no rules on file out there;
    ///    clamping would silently answer a different question than the one asked,
    ///    and the caller would have no way to tell.
    /// 3. **A hull with no dated availability refuses every `as_of`.** Not
    ///    "accepts anything" — an unbounded scrub over a hull whose dates are
    ///    unknown is a projection with nothing behind it.
    fn resolve(
        self,
        state: &AppState,
        vessel: &wadl_store::model::VesselSummary,
    ) -> Result<Timestamp, ApiError> {
        let Some(ms) = self.as_of else {
            return Ok(state.clock.now());
        };
        let at = Timestamp::from_epoch_millis(ms);
        let Some(window) = vessel.availability else {
            return Err(ApiError::OutOfRange(format!(
                "{} {} carries no availability dates, so it can only be read as of now",
                vessel.hull_no, vessel.availability_code
            )));
        };
        if window.contains(at) {
            Ok(at)
        } else {
            Err(ApiError::OutOfRange(format!(
                "as_of {}ms is outside {} {} ({}ms – {}ms)",
                ms,
                vessel.hull_no,
                vessel.availability_code,
                window.start.epoch_millis(),
                window.end.epoch_millis()
            )))
        }
    }
}

pub(crate) async fn health() -> Json<Value> {
    Json(json!({ "status": "ok", "decision_support_only": true }))
}

pub(crate) async fn list_vessels(
    State(state): State<AppState>,
    Caller(scope): Caller,
) -> Json<Value> {
    Json(json!(state.store.list_vessels(&scope).await))
}

pub(crate) async fn get_vessel(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let vessel = state
        .store
        .get_vessel(&scope, VesselId::from_uuid(id))
        .await?;
    Ok(Json(json!(vessel)))
}

pub(crate) async fn list_compartments(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    let mut compartments = state.store.list_compartments(&scope, vessel).await?;
    overlay_geometry(&state, &scope, vessel, &mut compartments).await?;
    Ok(Json(json!(compartments)))
}

/// Overlays the ingested geometry register onto served compartments: a
/// surveyed space gains its frame extent, its forward boundary becomes the
/// drawn datum, and its provenance climbs to `surveyed`. Done here, once, so
/// both stores serve identical geometry and no view re-derives the grade.
async fn overlay_geometry(
    state: &AppState,
    scope: &wadl_store::TenantScope,
    vessel: VesselId,
    compartments: &mut [wadl_store::model::CompartmentSummary],
) -> Result<(), ApiError> {
    let Some(register) = state.store.geometry_register(scope, vessel).await? else {
        return Ok(());
    };
    let by_no: std::collections::BTreeMap<&str, &wadl_store::model::SpaceGeometrySummary> =
        register
            .spaces
            .iter()
            .map(|g| (g.compartment_no.as_str(), g))
            .collect();
    for c in compartments.iter_mut() {
        if let Some(g) = by_no.get(c.compartment_no.as_str()) {
            c.frame = Some(g.fwd_frame);
            c.fwd_frame = Some(g.fwd_frame);
            c.aft_frame = Some(g.aft_frame);
            "surveyed".clone_into(&mut c.geometry_source);
        }
    }
    Ok(())
}

/// The work orders on a hull, each marked with whether it is planned for `as_of`.
///
/// The list is never filtered by the instant. A planner scrubbing to next week
/// still needs to see the order that finished last week — what changes is whether
/// it reads as in progress, and that is a flag, not an omission.
pub(crate) async fn list_work_orders(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
    Query(as_of): Query<AsOf>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    let at = as_of.resolve(&state, &state.store.get_vessel(&scope, vessel).await?)?;
    let orders = state.store.list_work_orders(&scope, vessel).await?;
    let rows: Vec<Value> = orders
        .into_iter()
        .map(|o| {
            let mut row = json!(o);
            if let Some(obj) = row.as_object_mut() {
                obj.insert("in_window".to_owned(), json!(o.booked_at(at)));
            }
            row
        })
        .collect();
    Ok(Json(json!(rows)))
}

/// The full activity register — every scheduled activity at the doing grain,
/// marked with whether it is planned for `as_of` and whether it can execute as
/// planned.
///
/// Marked, never filtered, on the same reasoning as the work-order list: a
/// planner reading next week still needs to see the activity that finished last
/// week, and an omission is indistinguishable from missing data.
///
/// Executability is the A4 derivation from `wadl-issues`: the activity's
/// compartment evaluated over its planned window, exactly (see that crate's
/// piecewise-constancy argument). It deliberately does **not** move with
/// `as_of` — "as planned" is a property of the plan against the hazards on
/// file, not of where the reader has scrubbed the clock.
///
/// The response also says where the register came from (`schedule_source`:
/// null for the generated demo register, the export's label once one is
/// ingested) and carries the reconciliation report: register hours per work
/// item against the work orders' and packages' own budgets. For the generated
/// register the report is empty by construction; for an ingested schedule it
/// is the honest account of what the export does and does not cover.
///
/// Dependency edges ride along (`edges`), at the activity-code grain, so a
/// Gantt can draw the logic the dates were computed from — including the
/// negative lags where cure-window inversions hide.
pub(crate) async fn list_activities(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
    Query(as_of): Query<AsOf>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    let at = as_of.resolve(&state, &state.store.get_vessel(&scope, vessel).await?)?;
    let activities = state.store.list_activities(&scope, vessel).await?;
    let graph = state.store.adjacency_graph(&scope, vessel).await?;
    let hazards = state.store.live_hazards(&scope, vessel, at).await?;
    let rules = state.store.rules_in_force(&scope, vessel).await?;
    let hull = wadl_issues::Hull {
        graph: &graph,
        rules: &rules,
        hazards: &hazards,
    };
    let source = state.store.schedule_source(&scope, vessel).await?;
    let schedule_edges = state.store.list_schedule_edges(&scope, vessel).await?;
    let reconciliation = reconcile(&state, &scope, vessel, &activities).await?;
    // The location-mapping report rides on every read, not only on the import
    // preview: the Sources panel and the register both need it, and counting
    // the same marks twice — once per side of the wire — is how two screens
    // learn to disagree.
    let compartments = state.store.list_compartments(&scope, vessel).await?;
    let mapping = mapping_report(&activities, &compartments);
    let rows: Vec<Value> = activities
        .into_iter()
        .map(|a| {
            let exec = wadl_issues::executability(&hull, a.compartment_no.as_ref(), a.planned);
            let mut row = json!(a);
            if let Some(obj) = row.as_object_mut() {
                obj.insert("in_window".to_owned(), json!(a.booked_at(at)));
                obj.insert("remaining_hours".to_owned(), json!(a.remaining_hours()));
                obj.insert("executability".to_owned(), json!(exec));
            }
            row
        })
        .collect();
    Ok(Json(json!({
        "as_of": at,
        "schedule_source": source,
        "reconciliation": reconciliation,
        "mapping": mapping,
        "edges": schedule_edges,
        "activities": rows,
    })))
}

/// Viable alternatives to the schedule, for every activity the engine
/// refuses as planned.
///
/// Each proposal is the same engine's answer, never a heuristic: the activity
/// slides to the earliest window of its own duration that the rules in force
/// permit (`wadl_issues::earliest_viable_window`), or the response says
/// honestly that the governing hold clears only on a named authority's
/// verification (no date can be promised — the proposal is the action on the
/// space's options panel), or that nothing fits before the availability ends.
///
/// A slide is priced with its knock-on: the successors, from the schedule's
/// own dependency edges, whose planned start now falls before the proposed
/// finish — read at finish-to-start grain, which the response says out loud.
/// This endpoint PROPOSES. Re-sequencing happens in P6; deciding happens on
/// the options panel; nothing here writes anything.
pub(crate) async fn schedule_alternatives(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
    Query(as_of): Query<AsOf>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    let hull_row = state.store.get_vessel(&scope, vessel).await?;
    let at = as_of.resolve(&state, &hull_row)?;
    let horizon = hull_row
        .availability
        .map_or_else(|| Timestamp::from_epoch_millis(i64::MAX / 2), |w| w.end);
    let activities = state.store.list_activities(&scope, vessel).await?;
    let graph = state.store.adjacency_graph(&scope, vessel).await?;
    let hazards = state.store.live_hazards(&scope, vessel, at).await?;
    let rules = state.store.rules_in_force(&scope, vessel).await?;
    let hull = wadl_issues::Hull {
        graph: &graph,
        rules: &rules,
        hazards: &hazards,
    };
    let edges = state.store.list_schedule_edges(&scope, vessel).await?;
    let start_of: std::collections::BTreeMap<&str, i64> = activities
        .iter()
        .filter_map(|a| a.planned.map(|w| (a.code.as_str(), w.start.epoch_millis())))
        .collect();

    let mut rows: Vec<Value> = Vec::new();
    for a in &activities {
        let (Some(compartment), Some(planned)) = (a.compartment_no.as_ref(), a.planned) else {
            continue;
        };
        let exec = wadl_issues::executability(&hull, Some(compartment), Some(planned));
        let wadl_issues::Executability::NotExecutable(refusal) = exec else {
            continue;
        };
        let alternative = wadl_issues::earliest_viable_window(&hull, compartment, planned, horizon);
        // The slide's knock-on: successors whose planned start would now sit
        // before the proposed finish. Finish-to-start reading; lags ignored
        // and said so in the response's `knock_on_basis`.
        let pushed: Vec<&str> = match &alternative {
            wadl_issues::Alternative::Viable { window, .. } => edges
                .iter()
                .filter(|e| e.pred_code == a.code)
                .filter_map(|e| {
                    let succ_start = start_of.get(e.succ_code.as_str())?;
                    (*succ_start < window.end.epoch_millis()).then_some(e.succ_code.as_str())
                })
                .collect(),
            _ => Vec::new(),
        };
        rows.push(json!({
            "activity": a.code,
            "name": a.name,
            "compartment": compartment,
            "trade": a.trade,
            "planned": planned,
            "remaining_hours": a.remaining_hours(),
            "refusal": refusal,
            "alternative": alternative,
            "pushes": pushed,
        }));
    }
    rows.sort_by_key(|r| -r["remaining_hours"].as_i64().unwrap_or(0));
    Ok(Json(json!({
        "as_of": at,
        "horizon": horizon,
        "knock_on_basis": "finish-to-start, lags not applied",
        "alternatives": rows,
    })))
}

/// Register hours per work item versus the work items' own budgets.
///
/// Only mismatches are reported — a reconciled item is silence, not a row —
/// plus the budgeted hours the register maps to no work item at all. For the
/// generated register this is empty by construction (a test pins it); once a
/// real export is the register, this is where "the schedule does not cover the
/// package work" stops being a surprise in a meeting.
async fn reconcile(
    state: &AppState,
    scope: &wadl_store::TenantScope,
    vessel: VesselId,
    activities: &[wadl_store::model::ActivitySummary],
) -> Result<Value, ApiError> {
    let mut by_item: std::collections::BTreeMap<&str, (i64, i64)> =
        std::collections::BTreeMap::new();
    let mut unmapped_budget = 0_i64;
    for a in activities.iter().filter(|a| !a.is_milestone) {
        match a.work_order_code.as_deref() {
            Some(code) => {
                let entry = by_item.entry(code).or_insert((0, 0));
                entry.0 += a.budget_hours.get();
                entry.1 += a.earned_hours.get();
            }
            None => unmapped_budget += a.budget_hours.get(),
        }
    }
    // The other side of the comparison: an ingested budget book when one
    // exists — the yard's own hours authority — else the seeded work items.
    // The response names which, because "reconciles" is only as strong as
    // what it reconciles AGAINST.
    let book = state.store.budget_book(scope, vessel).await?;
    let (source, targets): (Option<String>, Vec<(String, i64, i64)>) = if let Some(book) = book {
        (
            Some(book.label),
            book.items
                .iter()
                .map(|i| (i.code.clone(), i.budget_hours.get(), i.earned_hours.get()))
                .collect(),
        )
    } else {
        let orders = state.store.list_work_orders(scope, vessel).await?;
        let packages = state.store.list_packages(scope, vessel).await?;
        (
            None,
            orders
                .iter()
                .map(|o| (o.code.clone(), o.budget_hours.get(), o.earned_hours.get()))
                .chain(
                    packages
                        .iter()
                        .map(|p| (p.code.clone(), p.budget_hours.get(), p.earned_hours.get())),
                )
                .collect(),
        )
    };
    let items = targets.len();
    let mismatches: Vec<Value> = targets
        .into_iter()
        .filter_map(|(code, budget, earned)| {
            let (rb, re) = by_item.get(code.as_str()).copied().unwrap_or((0, 0));
            (rb != budget || re != earned).then(|| {
                json!({
                    "code": code,
                    "item_budget": budget,
                    "register_budget": rb,
                    "item_earned": earned,
                    "register_earned": re,
                })
            })
        })
        .collect();
    Ok(json!({
        "source": source,
        "items": items,
        "mismatches": mismatches,
        "unmapped_budget_hours": unmapped_budget,
    }))
}

/// The hull's time frame: the server's clock and the availability it bounds
/// `as_of` with.
///
/// One read, and the shell's whole time control is built from it. Serving the
/// server's `now` matters more than it looks: a browser clock that is minutes or
/// hours out would otherwise make the shell mark a live view as a projection, or
/// worse, mark a projection as live.
pub(crate) async fn timeframe(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let vessel = state
        .store
        .get_vessel(&scope, VesselId::from_uuid(id))
        .await?;
    Ok(Json(json!({
        "now": state.clock.now(),
        "availability_code": vessel.availability_code,
        "availability": vessel.availability,
    })))
}

pub(crate) async fn stranded_hours(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let report = state
        .store
        .stranded_hours(&scope, VesselId::from_uuid(id))
        .await?;
    Ok(Json(json!(report)))
}

/// The hull's decks, ordered downward.
pub(crate) async fn list_decks(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let decks = state
        .store
        .list_decks(&scope, VesselId::from_uuid(id))
        .await?;
    Ok(Json(json!(decks)))
}

/// Reads one compartment's authorization state **through the engine**.
///
/// The handler's whole job is to assemble the engine's inputs — the hull's
/// resolved adjacency graph, the live hazards, the rules in force, and the
/// evaluation instant from the injected clock — and to persist/return what comes
/// back. It computes no authorization itself, which is the seam that lets the
/// same engine build run in the browser and on a phone.
pub(crate) async fn compartment_state(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path((id, compartment)): Path<(Uuid, String)>,
    Query(as_of): Query<AsOf>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    let at = as_of.resolve(&state, &state.store.get_vessel(&scope, vessel).await?)?;
    let decision = decide(&state, &scope, vessel, &compartment, at).await?;
    Ok(Json(
        json!({ "compartment": compartment, "decision": decision, "as_of": at }),
    ))
}

/// The work booked in one compartment: hours left, the orders, and the trades.
///
/// **One implementation, every caller.** A distributed package books its hours per
/// *segment*, so a compartment inside a package footprint has no work order of its
/// own and has to be picked up from the package.
///
/// The source of those hours is each package's own **footprint**
/// ([`wadl_plan::Package::spaces`]) and nothing else. It was briefly the stranded
/// report, which was wrong in a way worth remembering: that report lists the
/// compartments that *cause* stranding, not an inventory of booked work. On the
/// seeded hull it named three compartments out of an eleven-compartment footprint,
/// so 1,919 of 2,059 package man-hours went unseen — and, worse, unseen by the
/// very coverage figure built to catch hours the register cannot account for. A
/// report about causes is not a ledger.
struct BookedWork {
    remaining: ManHours,
    stranded_downstream: ManHours,
    order_codes: Vec<String>,
    trades: Vec<String>,
}

/// A package's footprint, paired with the trade that owns it.
struct PackageWork {
    code: String,
    trade: String,
    spaces: std::collections::BTreeMap<CompartmentNo, wadl_plan::SpaceWork>,
}

/// Reads every package on the hull with its footprint. Small N by construction —
/// a hull has a handful of distributed packages, not thousands.
async fn packages_with_footprints(
    state: &AppState,
    scope: &wadl_store::TenantScope,
    vessel: VesselId,
) -> Result<Vec<PackageWork>, ApiError> {
    let summaries = state.store.list_packages(scope, vessel).await?;
    let mut out = Vec::with_capacity(summaries.len());
    for summary in summaries {
        let package = state
            .store
            .get_package(scope, vessel, &summary.code)
            .await?;
        out.push(PackageWork {
            code: summary.code,
            trade: summary.trade,
            spaces: package.spaces,
        });
    }
    Ok(out)
}

/// Where a hull's booked hours come from, said on the response so a planner
/// can tell a demo register from their own schedule.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum HoursSource {
    /// The ingested schedule of record: every located, unfinished activity
    /// is booked work in its space over its planned window.
    ScheduleOfRecord,
    /// The seeded work orders — the demo world, before any import.
    SeededWorkOrders,
}

/// The work booked on the hull, as rows the readiness rollup can price.
///
/// Once a schedule of record is ingested, the schedule IS the work: each
/// located activity with hours left becomes one booked row in its space over
/// its planned window, so the deck and readiness tiles show the yard's own
/// hours rather than the six seeded orders the demo shipped with. Without an
/// ingest the seeded orders stand in, and the response says which.
async fn booked_orders(
    state: &AppState,
    scope: &wadl_store::TenantScope,
    vessel: VesselId,
) -> Result<(Vec<wadl_store::model::WorkOrderSummary>, HoursSource), ApiError> {
    if state.store.schedule_source(scope, vessel).await?.is_none() {
        return Ok((
            state.store.list_work_orders(scope, vessel).await?,
            HoursSource::SeededWorkOrders,
        ));
    }
    let activities = state.store.list_activities(scope, vessel).await?;
    let rows = activities
        .into_iter()
        .filter(|a| !a.is_milestone && a.status != wadl_store::model::ActivityStatus::Complete)
        .filter_map(|a| {
            let compartment_no = a.compartment_no?;
            Some(wadl_store::model::WorkOrderSummary {
                work_order_id: wadl_domain::ids::WorkOrderId::from_uuid(a.activity_id.as_uuid()),
                code: a.work_order_code.unwrap_or_else(|| a.code.clone()),
                title: a.name,
                trade: a.trade,
                system: String::new(),
                compartment_no,
                budget_hours: a.budget_hours,
                earned_hours: a.earned_hours,
                source_ref: a.source_ref,
                source_verified: true,
                planned: a.planned,
            })
        })
        .collect();
    Ok((rows, HoursSource::ScheduleOfRecord))
}

fn booked_work(
    compartment: &CompartmentNo,
    orders: &[wadl_store::model::WorkOrderSummary],
    packages: &[PackageWork],
    stranded: &wadl_store::model::StrandedReport,
    at: Timestamp,
) -> BookedWork {
    // Work counts as booked here only if it is planned for `at`. This is what
    // makes readiness a question about a moment rather than about the whole
    // availability: a space with nobody due in it is idle, not held, and a board
    // that ignored the dates would report every space as held from the first day
    // of the availability to the last.
    let in_space: Vec<_> = orders
        .iter()
        .filter(|o| &o.compartment_no == compartment && o.booked_at(at))
        .collect();
    // Every package whose footprint includes this compartment, with hours left.
    let in_packages: Vec<_> = packages
        .iter()
        .filter_map(|p| {
            p.spaces
                .get(compartment)
                .filter(|w| w.booked_at(at))
                .map(|w| (p, w.remaining()))
        })
        .filter(|(_, remaining)| remaining.get() > 0)
        .collect();

    let mut trades: Vec<String> = in_space.iter().map(|o| o.trade.clone()).collect();
    // A package's trade is the package's own — its owning order is not in the
    // work-order list, so looking there leaves every package space reading "no
    // trade recorded", which is exactly the work the trade lens most needs named.
    trades.extend(in_packages.iter().map(|(p, _)| p.trade.clone()));
    trades.sort_unstable();
    trades.dedup();

    let mut order_codes: Vec<String> = in_space.iter().map(|o| o.code.clone()).collect();
    order_codes.extend(in_packages.iter().map(|(p, _)| p.code.clone()));
    order_codes.sort_unstable();
    order_codes.dedup();

    BookedWork {
        remaining: in_space
            .iter()
            .map(|o| o.remaining_hours())
            .chain(in_packages.iter().map(|(_, r)| *r))
            .fold(ManHours::ZERO, |a, b| a + b),
        // Stranding IS the stranded report's job: hours in OTHER compartments that
        // cannot be tested until this one clears. That is a claim about causes, so
        // the causes report is the right source for it.
        stranded_downstream: stranded
            .items
            .iter()
            .filter(|i| &i.compartment_no == compartment)
            .map(|i| i.stranded_downstream)
            .fold(ManHours::ZERO, |a, b| a + b),
        order_codes,
        trades,
    }
}

/// Every compartment on the hull with its current authorization state — the
/// query Deck Explorer draws a deck sheet from.
pub(crate) async fn deck_states(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
    Query(as_of): Query<AsOf>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    let at = as_of.resolve(&state, &state.store.get_vessel(&scope, vessel).await?)?;
    let mut compartments = state.store.list_compartments(&scope, vessel).await?;
    overlay_geometry(&state, &scope, vessel, &mut compartments).await?;
    let graph = state.store.adjacency_graph(&scope, vessel).await?;
    let hazards = state.store.live_hazards(&scope, vessel, at).await?;
    let rules = state.store.rules_in_force(&scope, vessel).await?;
    // The deck board is an array of rows; the hours source rides on the
    // readiness rollup, which is the object the tiles read.
    let (orders, _hours_source) = booked_orders(&state, &scope, vessel).await?;
    let packages = packages_with_footprints(&state, &scope, vessel).await?;
    let stranded = state.store.stranded_hours(&scope, vessel).await?;

    let rows: Vec<Value> = compartments
        .into_iter()
        .map(|compartment| {
            let decision = evaluate(&EvaluationRequest {
                subject: &compartment.compartment_no,
                graph: &graph,
                rules: &rules,
                hazards: &hazards,
                at,
            });
            let work = booked_work(
                &compartment.compartment_no,
                &orders,
                &packages,
                &stranded,
                at,
            );
            let remaining = work.remaining.get();

            json!({
                "compartment": compartment,
                "state": decision.state,
                "permits_work": decision.permits_work(),
                "rules_fired": decision.trace.iter().map(|s| &s.rule_code).collect::<Vec<_>>(),
                "earliest_clear": decision.earliest_clear,
                "trades": work.trades,
                "work_order_codes": work.order_codes,
                "remaining_hours": remaining,
                "stranded_hours": work.stranded_downstream.get(),
                // Served rather than re-derived in the browser. The four-way
                // taxonomy is `wadl_plan::readiness`'s, and having two
                // implementations of it — one here, one in the shell — is how the
                // ship board and the deck plan start disagreeing about which
                // spaces are costing money.
                "readiness": Readiness::of(decision.permits_work(), remaining > 0),
                // Who can release it, for the readiness overlay's tooltip. From
                // the line that decided the state, not the first line reached.
                "clearing_authority": decision
                    .governing_step()
                    .map(|s| s.clearing_authority.as_str())
                    .unwrap_or_default(),
            })
        })
        .collect();
    Ok(Json(json!(rows)))
}

/// The hull rolled up to ship, zone and deck — the Deck Explorer's altitudes.
///
/// The rollup arithmetic is [`wadl_plan::readiness`], not this handler. That
/// matters: "620 man-hours are held behind the marine chemist" is a number that
/// re-sequences an availability, and it is property-tested in a pure crate
/// rather than assembled here where nothing could check it adds up.
///
/// Authorization still comes only from the engine. This endpoint joins the
/// engine's decision to the hours booked in each space — which is a different
/// question (*is anyone held up?*) from the one the engine answers (*may work
/// proceed?*), and the two are kept apart deliberately.
pub(crate) async fn readiness(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
    Query(as_of): Query<AsOf>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    let at = as_of.resolve(&state, &state.store.get_vessel(&scope, vessel).await?)?;
    let compartments = state.store.list_compartments(&scope, vessel).await?;
    let graph = state.store.adjacency_graph(&scope, vessel).await?;
    let hazards = state.store.live_hazards(&scope, vessel, at).await?;
    let rules = state.store.rules_in_force(&scope, vessel).await?;
    let (orders, hours_source) = booked_orders(&state, &scope, vessel).await?;
    // Distributed packages book their hours per *segment*, so a compartment in a
    // package footprint has no work order of its own. Without this the rollup
    // reports zero hours held in exactly the spaces the cascade suspends — the
    // held column reads clean while six compartments are shut. The stranded
    // report already carries per-compartment package hours, derived from real
    // segment topology by `wadl_plan`, so it is the right source.
    let stranded = state.store.stranded_hours(&scope, vessel).await?;
    let packages = packages_with_footprints(&state, &scope, vessel).await?;

    // Hours in the hull's work that name a compartment the register does not
    // contain. Handed to the rollup rather than dropped: a footprint authored
    // against the class, a hull delta that removed a space, or a mis-keyed
    // placard all land here, and a board that silently omitted them would
    // under-report what is outstanding.
    let registered: std::collections::BTreeSet<&CompartmentNo> =
        compartments.iter().map(|c| &c.compartment_no).collect();
    // Filtered by `at` on the same terms as the attributed hours below. Without
    // that the two halves of the rollup answer different questions: scrub forward
    // and the attributed hours fall away while these stay, so a board reports that
    // the only outstanding work on the hull is mis-keyed. The coverage figure
    // exists to catch hours the register cannot account for, not to inflate them.
    let unattributed = packages
        .iter()
        .flat_map(|p| p.spaces.iter())
        .filter(|(no, w)| !registered.contains(no) && w.booked_at(at))
        .map(|(_, w)| w.remaining())
        .fold(ManHours::ZERO, |a, b| a + b);

    let spaces: Vec<SpaceReadiness> = compartments
        .into_iter()
        .map(|compartment| {
            let decision = evaluate(&EvaluationRequest {
                subject: &compartment.compartment_no,
                graph: &graph,
                rules: &rules,
                hazards: &hazards,
                at,
            });
            let work = booked_work(
                &compartment.compartment_no,
                &orders,
                &packages,
                &stranded,
                at,
            );

            SpaceReadiness {
                compartment_no: compartment.compartment_no.as_str().to_owned(),
                zone: compartment.zone.clone(),
                deck_code: compartment.deck_code.clone(),
                permits_work: decision.permits_work(),
                remaining: work.remaining,
                trades: work.trades,
                // Empty rather than "unspecified" when nothing is holding: the
                // rollup groups by this string, and inventing a holder for an
                // unheld space would put a phantom name on the ship board.
                clearing_authority: decision
                    .governing_step()
                    .map(|s| s.clearing_authority.clone())
                    .unwrap_or_default(),
                stranded_downstream: work.stranded_downstream,
            }
        })
        .collect();

    // The rollup, with where its hours came from stamped on it — a planner
    // reading "564 MH held" is entitled to know whether that is their
    // schedule or the demo's six work orders.
    let mut body = json!(roll_up(&spaces, unattributed));
    if let Some(obj) = body.as_object_mut() {
        obj.insert("hours_source".to_owned(), json!(hours_source));
    }
    Ok(Json(body))
}

/// Assembles the world mitigation options are computed against.
///
/// The hours per space are the hours booked **at `at`**, from the same
/// [`booked_work`] every other surface uses. That matters more than it looks: the
/// leverage figure an option is ranked by is a man-hour count, and if it came from
/// a second implementation of "what is booked here" the options board and the
/// readiness board would rank the same action differently.
struct MitigationInputs {
    graph: wadl_engine::AdjacencyGraph,
    hazards: Vec<wadl_engine::Hazard>,
    rules: wadl_engine::RuleSet,
    compartments: Vec<wadl_store::model::CompartmentSummary>,
    orders: Vec<wadl_store::model::WorkOrderSummary>,
    packages: Vec<PackageWork>,
    stranded: wadl_store::model::StrandedReport,
}

impl MitigationInputs {
    /// The hours booked in every space **at `at`**.
    ///
    /// A closure over this, handed to `wadl_mitigate`, because an option that waits
    /// is evaluated at a future instant and must be priced there too — and because
    /// the hours have to come from the same [`booked_work`] every other board uses.
    fn loads(&self, at: Timestamp) -> Vec<wadl_mitigate::SpaceLoad> {
        self.compartments
            .iter()
            .map(|c| wadl_mitigate::SpaceLoad {
                booked: booked_work(
                    &c.compartment_no,
                    &self.orders,
                    &self.packages,
                    &self.stranded,
                    at,
                )
                .remaining,
                compartment: c.compartment_no.clone(),
            })
            .collect()
    }

    fn contains(&self, compartment: &CompartmentNo) -> bool {
        self.compartments
            .iter()
            .any(|c| &c.compartment_no == compartment)
    }
}

async fn mitigation_inputs(
    state: &AppState,
    scope: &wadl_store::TenantScope,
    vessel: VesselId,
    at: Timestamp,
) -> Result<MitigationInputs, ApiError> {
    Ok(MitigationInputs {
        graph: state.store.adjacency_graph(scope, vessel).await?,
        hazards: state.store.live_hazards(scope, vessel, at).await?,
        rules: state.store.rules_in_force(scope, vessel).await?,
        compartments: state.store.list_compartments(scope, vessel).await?,
        orders: booked_orders(state, scope, vessel).await?.0,
        packages: packages_with_footprints(state, scope, vessel).await?,
        stranded: state.store.stranded_hours(scope, vessel).await?,
    })
}

/// What could be done about one refused compartment, ranked by work recovered.
///
/// Every option in the response is a **counterfactual engine verdict**: the world
/// was rebuilt with that one action taken and the whole hull re-evaluated. None of
/// it is a remedy looked up in a table, which is why each option can state what it
/// frees *and what it would shut*.
///
/// Decision support, not automation. This proposes; a planner chooses; nothing
/// here changes a hazard, a schedule or an authorization.
pub(crate) async fn mitigations(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path((id, compartment)): Path<(Uuid, String)>,
    Query(as_of): Query<AsOf>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    let at = as_of.resolve(&state, &state.store.get_vessel(&scope, vessel).await?)?;
    let inputs = mitigation_inputs(&state, &scope, vessel, at).await?;
    let subject = CompartmentNo::new(compartment);
    // A placard the register does not contain is not-found, not an ALLOW. Answering
    // "nothing is holding 9-999-9-Z" is a confident statement about a space that
    // does not exist.
    if !inputs.contains(&subject) {
        return Err(ApiError::NotFound);
    }
    let loads = |instant: Timestamp| inputs.loads(instant);
    let world = wadl_mitigate::World {
        graph: &inputs.graph,
        rules: &inputs.rules,
        hazards: &inputs.hazards,
        at,
        loads: &loads,
    };
    let assessment = wadl_mitigate::assess(&world, &subject);
    // The history comes with the options in one read. A planner deciding what to do
    // needs to know what was already tried and rejected, and making that a second
    // request means a surface can forget to ask.
    let decided = state
        .store
        .list_audit(&scope, vessel, Some(subject.as_str()))
        .await?;
    let mut body = json!(assessment);
    if let Some(obj) = body.as_object_mut() {
        obj.insert("as_of".to_owned(), json!(at));
        obj.insert("decisions".to_owned(), json!(decided));
    }
    Ok(Json(body))
}

/// What a planner decided about a proposed option.
///
/// The whole option is echoed back in the request rather than re-derived from an
/// id, and that is deliberate. The record has to say what was on the screen when
/// the choice was made — the effect was priced under a rule set and a hazard state
/// that will both have moved on. Re-deriving "what would this have freed" years
/// later answers a different question.
#[derive(Debug, serde::Deserialize)]
pub(crate) struct DecisionBody {
    /// `accepted` or `rejected`.
    disposition: String,
    /// The option as the planner saw it.
    option: Value,
    /// Why. Optional on accept, and the surface should press for it on reject.
    #[serde(default)]
    reason: String,
    /// The instant the options were computed for.
    #[serde(default)]
    as_of: Option<i64>,
}

/// The immutable content of a decision, in a fixed field order.
///
/// A struct rather than an ad-hoc object because this is **hashed**: the ledger
/// chains on the serialised `detail`, so its byte layout has to be stable. A map
/// whose key order depended on insertion would produce a different hash for the
/// same decision.
#[derive(Debug, serde::Serialize)]
struct DecisionDetail<'a> {
    subject: &'a str,
    disposition: &'a str,
    as_of_ms: i64,
    reason: &'a str,
    /// Who decided, as far as the platform can currently tell.
    ///
    /// The tenant, because that is the only identity milestone 1 has: the caller is
    /// a header shim, not a session. Recorded anyway rather than omitted, so the
    /// field exists in the chain from the first entry and adding a real person later
    /// is not a change to the hashed shape of every historical record.
    decided_by_org: String,
    /// The option **as the server re-derived it**, not as the client sent it.
    option: &'a Value,
}

/// Records a planner's disposition of an option in the audit ledger.
///
/// This does **not** apply the mitigation. Nothing here clears a hazard, moves a
/// date or grants an authorization — the platform flags and prices; the yard acts.
/// What is written is a statement that this option was on offer and was taken or
/// turned down, which is the part a board of inquiry asks about and the part no other
/// system holds.
///
/// It does not yet say *who*, and this comment used to claim it did. Milestone 1's
/// caller is a header shim rather than a session, so the tenant is the only identity
/// available; it is recorded as `decided_by_org`, and the person arrives with
/// authentication. Overstating that would be the worst possible thing to overstate
/// about an audit record.
pub(crate) async fn record_decision(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path((id, compartment)): Path<(Uuid, String)>,
    body: Result<Json<DecisionBody>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    // Scope first, and before the body is looked at: a caller with no business
    // reading this hull must get the same not-found as for any other route, and
    // must not be able to tell a malformed body from a foreign hull. Taking the body
    // as a `Result` is what defers its rejection to here — as an `Option`, a
    // malformed body was indistinguishable from an absent one and every parse
    // failure was reported as "a decision needs a body".
    let hull = state.store.get_vessel(&scope, vessel).await?;
    let body = match body {
        Ok(Json(body)) => body,
        Err(rejection) => return Err(body_rejection(&rejection)),
    };

    let disposition = match body.disposition.as_str() {
        "accepted" => "MITIGATION_ACCEPTED",
        "rejected" => "MITIGATION_REJECTED",
        other => {
            return Err(ApiError::OutOfRange(format!(
                "disposition must be accepted or rejected, got {other:?}"
            )))
        }
    };
    let at = AsOf { as_of: body.as_of }.resolve(&state, &hull)?;

    // The submitted option is checked against what the engine actually offers, and
    // the SERVER's copy is what gets recorded.
    //
    // This is the difference between a tamper-evident ledger and a tamper-evident
    // record of whatever a client posted. Hashing the client's blob would let the
    // chain attest, unfalsifiably, to an option with an invented effect the engine
    // never produced: the hash would verify perfectly and the content would be
    // fiction. So the assessment is re-derived and the action matched into it.
    let subject = CompartmentNo::new(&compartment);
    let inputs = mitigation_inputs(&state, &scope, vessel, at).await?;
    if !inputs.contains(&subject) {
        return Err(ApiError::NotFound);
    }
    let verified = {
        let loads = |instant: Timestamp| inputs.loads(instant);
        let world = wadl_mitigate::World {
            graph: &inputs.graph,
            rules: &inputs.rules,
            hazards: &inputs.hazards,
            at,
            loads: &loads,
        };
        let assessment = wadl_mitigate::assess(&world, &subject);
        // Matched on the action — the part a planner actually chose. The effect is
        // the server's own computation regardless of what arrived.
        let submitted = body.option.get("action").cloned().unwrap_or(Value::Null);
        assessment
            .options
            .into_iter()
            .find(|o| json!(o.action) == submitted)
            .map(|o| json!(o))
            .or_else(|| {
                let plan = assessment.combined?;
                (json!(plan.actions) == body.option.get("actions").cloned().unwrap_or(Value::Null))
                    .then(|| json!(plan))
            })
    };
    let Some(option) = verified else {
        return Err(ApiError::OutOfRange(format!(
            "that option is not on offer for {compartment} at this instant, so it cannot \
             be recorded as a decision"
        )));
    };

    let detail = DecisionDetail {
        subject: &compartment,
        disposition: &body.disposition,
        as_of_ms: at.epoch_millis(),
        reason: &body.reason,
        decided_by_org: scope.org.to_string(),
        option: &option,
    };
    // A serialisation failure on a struct of strings and numbers is not reachable;
    // an empty detail would still be chained and would still verify, so there is
    // nothing to gain from failing the request over it.
    let detail = serde_json::to_string(&detail).unwrap_or_default();

    let record = state
        .store
        .append_audit(
            &scope,
            vessel,
            disposition,
            &detail,
            Some(&compartment),
            state.clock.now().epoch_millis(),
        )
        .await?;
    Ok(Json(json!(record)))
}

/// The hull's highest-leverage actions — the answer to *what is worth doing at
/// all*, as opposed to *what opens this one space*.
///
/// Deduplicated by action across every held space, so the one isolation holding
/// six compartments appears once with its full effect rather than six times.
pub(crate) async fn leverage(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
    Query(as_of): Query<AsOf>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    let at = as_of.resolve(&state, &state.store.get_vessel(&scope, vessel).await?)?;
    let inputs = mitigation_inputs(&state, &scope, vessel, at).await?;
    let loads = |instant: Timestamp| inputs.loads(instant);
    let world = wadl_mitigate::World {
        graph: &inputs.graph,
        rules: &inputs.rules,
        hazards: &inputs.hazards,
        at,
        loads: &loads,
    };
    Ok(Json(json!({
        "as_of": at,
        "actions": wadl_mitigate::leverage(&world),
    })))
}

/// The full issue derivation for one hull at one instant, shared by the board
/// read and the acknowledgement write — the write validates against exactly
/// what the read would serve, so an ack can never attach to a finding that is
/// not on the board.
async fn derived_issues(
    state: &AppState,
    scope: &wadl_store::TenantScope,
    vessel: VesselId,
    at: Timestamp,
) -> Result<Vec<wadl_issues::Issue>, ApiError> {
    let inputs = mitigation_inputs(state, scope, vessel, at).await?;
    let activities = state.store.list_activities(scope, vessel).await?;
    let loads = |instant: Timestamp| inputs.loads(instant);
    let world = wadl_mitigate::World {
        graph: &inputs.graph,
        rules: &inputs.rules,
        hazards: &inputs.hazards,
        at,
        loads: &loads,
    };
    let rows: Vec<wadl_issues::RegisterRow<'_>> = activities
        .iter()
        .filter(|a| !a.is_milestone)
        .map(|a| wadl_issues::RegisterRow {
            code: &a.code,
            name: &a.name,
            trade: &a.trade,
            compartment: a.compartment_no.as_ref(),
            planned: a.planned,
            remaining: a.remaining_hours(),
        })
        .collect();
    let stranded: Vec<wadl_issues::Stranding<'_>> = inputs
        .stranded
        .items
        .iter()
        .map(|s| wadl_issues::Stranding {
            compartment: &s.compartment_no,
            own_remaining: s.own_remaining,
            stranded_downstream: s.stranded_downstream,
            downstream_segments: s.downstream_segments.len(),
        })
        .collect();
    let schedule_edges = state.store.list_schedule_edges(scope, vessel).await?;
    let edges: Vec<wadl_issues::ScheduleEdge<'_>> = schedule_edges
        .iter()
        .map(|e| wadl_issues::ScheduleEdge {
            pred: &e.pred_code,
            succ: &e.succ_code,
            lag_hours: e.lag_hours,
        })
        .collect();
    Ok(wadl_issues::derive(&world, &rows, &stranded, &edges))
}

/// The issue board: every way the platform can show planned work is in
/// trouble, ranked by man-hours at risk.
///
/// Every row is a claim with evidence: a real engine refusal with crews booked,
/// a compound hold straight from the options planner, an activity shown
/// non-executable over its own window, a stranding read off real segment
/// topology, or a schedule-quality finding read off the schedule of record's
/// own dependency edges.
///
/// Each row also carries its lifecycle, joined from the audit ledger rather
/// than stored on the issue — the issue is re-derived on every read and holds
/// no state of its own. `acknowledged` is the ledger's `ISSUE_ACKNOWLEDGED`
/// entry for this issue's stable key; `decision` is the latest mitigation
/// disposition recorded against the issue's space. Both ride along and neither
/// removes the row: an acknowledged issue is still an issue, it is just an
/// issue somebody has answered for.
pub(crate) async fn issues(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
    Query(as_of): Query<AsOf>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    let at = as_of.resolve(&state, &state.store.get_vessel(&scope, vessel).await?)?;
    let issues = derived_issues(&state, &scope, vessel, at).await?;
    let hours_at_risk: i64 = issues.iter().map(|i| i.hours_at_risk().get()).sum();

    // The lifecycle join. One ledger read; newest-first order means the first
    // record seen per subject is the latest word on it.
    let ledger = state.store.list_audit(&scope, vessel, None).await?;
    let mut acks: std::collections::HashMap<&str, &wadl_store::model::AuditRecord> =
        std::collections::HashMap::new();
    let mut decisions: std::collections::HashMap<&str, &wadl_store::model::AuditRecord> =
        std::collections::HashMap::new();
    for rec in &ledger {
        let Some(subject) = rec.subject_ref.as_deref() else {
            continue;
        };
        match rec.action.as_str() {
            "ISSUE_ACKNOWLEDGED" => {
                acks.entry(subject).or_insert(rec);
            }
            "MITIGATION_ACCEPTED" | "MITIGATION_REJECTED" => {
                decisions.entry(subject).or_insert(rec);
            }
            _ => {}
        }
    }
    let field = |rec: &wadl_store::model::AuditRecord, name: &str| -> Value {
        serde_json::from_str::<Value>(&rec.detail)
            .ok()
            .and_then(|d| d.get(name).cloned())
            .unwrap_or(Value::Null)
    };
    let rows: Vec<Value> = issues
        .iter()
        .map(|i| {
            let mut row = json!(i);
            if let Some(obj) = row.as_object_mut() {
                obj.insert("key".to_owned(), json!(i.key()));
                let ack = acks
                    .get(i.key().as_str())
                    .map(|rec| json!({ "at": rec.occurred_at_ms, "note": field(rec, "note") }));
                obj.insert("acknowledged".to_owned(), ack.unwrap_or(Value::Null));
                let decision = i
                    .space()
                    .and_then(|c| decisions.get(c.as_str()))
                    .map(|rec| {
                        json!({
                            "disposition": field(rec, "disposition"),
                            "at": rec.occurred_at_ms,
                            "reason": field(rec, "reason"),
                        })
                    });
                obj.insert("decision".to_owned(), decision.unwrap_or(Value::Null));
            }
            row
        })
        .collect();
    Ok(Json(json!({
        "as_of": at,
        "hours_at_risk": hours_at_risk,
        "issues": rows,
    })))
}

/// The hull's audit ledger — every recorded decision and acknowledgement,
/// newest first, with the hash chain re-verified on every read.
///
/// The verification is not decoration: the ledger's whole claim is that a
/// silently altered or removed record is detectable, and a screen that shows
/// the records without checking the chain would be repeating that claim on
/// faith. `verified` is the server re-hashing the chain end to end right now;
/// a break names the sequence number where trust stops.
pub(crate) async fn ledger(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    state.store.get_vessel(&scope, vessel).await?;
    let records = state.store.list_audit(&scope, vessel, None).await?;
    // Served newest first (the reading order); hashed oldest first (the
    // chain's direction).
    let oldest_first: Vec<wadl_store::model::AuditRecord> = records.iter().rev().cloned().collect();
    let verdict = wadl_store::ledger::verify_records(&oldest_first);
    Ok(Json(json!({
        "verified": verdict.is_ok(),
        "break": verdict.err().map(|b| json!({
            "seq": b.seq,
            "reason": match b.reason {
                wadl_store::ledger::LedgerBreakKind::HashMismatch => "hash_mismatch",
                wadl_store::ledger::LedgerBreakKind::ChainBroken => "chain_broken",
            },
        })),
        "entries": records,
    })))
}

/// An acknowledgement, as posted: which finding, and what the acknowledger has
/// to say for it.
#[derive(Debug, serde::Deserialize)]
pub(crate) struct AckBody {
    /// The issue's stable key, as served on the board.
    key: String,
    /// Why it is acknowledged — pressed for on the surface, optional here.
    #[serde(default)]
    note: String,
    /// The instant the board was read at.
    #[serde(default)]
    as_of: Option<i64>,
}

/// The immutable content of an acknowledgement, in a fixed field order — the
/// ledger chains on the serialised detail, so its byte layout must be stable
/// (see [`DecisionDetail`]).
#[derive(Debug, serde::Serialize)]
struct AckDetail<'a> {
    key: &'a str,
    note: &'a str,
    as_of_ms: i64,
    /// The tenant, because that is the only identity milestone 1 has — same
    /// honesty as `DecisionDetail::decided_by_org`.
    acknowledged_by_org: String,
    /// The issue **as the server derived it** when the ack landed — the claim
    /// and its priced hours at that instant, not whatever a client believed.
    issue: Value,
}

/// Records that somebody answered for an issue on the board.
///
/// This does not close, hide or fix anything — the issue keeps deriving as
/// long as its facts hold, and the board keeps showing it. What changes is
/// that the row now carries who answered for it and why, out of the same
/// tamper-evident ledger as mitigation decisions. The key is validated
/// against the board as derived *right now*: acknowledging a finding that is
/// not on the board is refused, for the same reason a decision on an option
/// not on offer is refused.
pub(crate) async fn acknowledge_issue(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
    body: Result<Json<AckBody>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    // Scope first, body second: a foreign hull is not-found before a malformed
    // body can say anything else (see `record_decision`).
    let hull = state.store.get_vessel(&scope, vessel).await?;
    let body = match body {
        Ok(Json(body)) => body,
        Err(rejection) => return Err(body_rejection(&rejection)),
    };
    let at = AsOf { as_of: body.as_of }.resolve(&state, &hull)?;

    let issues = derived_issues(&state, &scope, vessel, at).await?;
    let Some(issue) = issues.iter().find(|i| i.key() == body.key) else {
        return Err(ApiError::OutOfRange(format!(
            "{:?} is not on the issue board at this instant, so it cannot be acknowledged",
            body.key
        )));
    };

    let detail = AckDetail {
        key: &body.key,
        note: &body.note,
        as_of_ms: at.epoch_millis(),
        acknowledged_by_org: scope.org.to_string(),
        issue: json!(issue),
    };
    let detail = serde_json::to_string(&detail).unwrap_or_default();
    let record = state
        .store
        .append_audit(
            &scope,
            vessel,
            "ISSUE_ACKNOWLEDGED",
            &detail,
            Some(&body.key),
            // The ledger's time is when the person answered, on the wall
            // clock; the instant they were looking at rides in the detail as
            // `as_of_ms`. Stamping the scrubbed instant here made an
            // acknowledgement recorded on Friday about Monday's board look
            // like it had been made on Monday.
            state.clock.now().epoch_millis(),
        )
        .await?;
    Ok(Json(json!({ "recorded": record })))
}

/// The live hazards on a hull — the recorded field conditions the engine
/// evaluates, served raw so the surface can show WHAT is shut (the fact)
/// alongside the trace's WHY (the consequences). Each carries its origin
/// space, kind, when it was raised, and its label.
pub(crate) async fn list_hazards(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
    Query(as_of): Query<AsOf>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    let at = as_of.resolve(&state, &state.store.get_vessel(&scope, vessel).await?)?;
    let hazards = state.store.live_hazards(&scope, vessel, at).await?;
    Ok(Json(json!({ "hazards": hazards, "as_of": at })))
}

/// A field condition, as raised: where, what kind, what it is called, and
/// since when.
#[derive(Debug, serde::Deserialize)]
pub(crate) struct RaiseHazardBody {
    /// The origin space — must be on the hull's register.
    compartment: String,
    /// The hazard kind, in the engine's serde names (`hot_work_live`, …).
    kind: wadl_engine::HazardKind,
    /// The fact as the deck says it — the ticket, the bus, the permit:
    /// "CT-3160-4 · final coat, curing". Required: a hazard with no label is
    /// a colour with no reason.
    label: String,
    /// When it was raised, epoch ms; defaults to the wall clock. Never in
    /// the future — a condition is raised when it is a fact, not before.
    #[serde(default)]
    since_ms: Option<i64>,
}

/// Raises a field condition: the day's tag-out, the coating ticket, the hot
/// work permit, the stop-work — the facts the engine evaluates against, which
/// until this route could enter the product only as seed data. Validated
/// against the register (a hazard in a space the hull does not know is a typo,
/// not a fact) and against what is already live (one fact, once). Lands in
/// the ledger as `HAZARD_RAISED` before the response returns; every verdict
/// the hazard drives re-derives on the next read.
pub(crate) async fn raise_hazard(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
    body: Result<Json<RaiseHazardBody>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    // Scope first, body second (see `record_decision`).
    state.store.get_vessel(&scope, vessel).await?;
    let body = match body {
        Ok(Json(body)) => body,
        Err(rejection) => return Err(body_rejection(&rejection)),
    };
    let label = body.label.trim();
    if label.is_empty() {
        return Err(ApiError::OutOfRange(
            "a field condition needs its label — the ticket, the bus, the permit — \
             so the trace can say what is holding the space, not just that something is."
                .to_owned(),
        ));
    }
    let compartment = body.compartment.trim();
    let register = state.store.list_compartments(&scope, vessel).await?;
    if !register
        .iter()
        .any(|c| c.compartment_no.as_str() == compartment)
    {
        return Err(ApiError::OutOfRange(format!(
            "{compartment} is not on this hull's register — a field condition is raised \
             against a space the hull knows, or it is a typo the engine would never evaluate"
        )));
    }
    let now_ms = state.clock.now().epoch_millis();
    let since_ms = body.since_ms.unwrap_or(now_ms);
    if since_ms > now_ms {
        return Err(ApiError::OutOfRange(
            "a field condition is raised when it is a fact, not before — since_ms is in the future"
                .to_owned(),
        ));
    }
    let live = state
        .store
        .live_hazards(&scope, vessel, state.clock.now())
        .await?;
    if live
        .iter()
        .any(|h| h.origin.as_str() == compartment && h.kind == body.kind)
    {
        return Err(ApiError::OutOfRange(format!(
            "a {} hazard is already live in {compartment} — one fact, once; clear it \
             before raising it again",
            json!(body.kind).as_str().unwrap_or("?"),
        )));
    }

    let hazard = state
        .store
        .raise_hazard(&scope, vessel, compartment, body.kind, since_ms, label)
        .await?;
    let detail = json!({
        "compartment": compartment,
        "kind": body.kind,
        "label": label,
        "since_ms": since_ms,
        "raised_by_org": scope.org.to_string(),
        "at_ms": now_ms,
    });
    let detail = serde_json::to_string(&detail).unwrap_or_default();
    let record = state
        .store
        .append_audit(
            &scope,
            vessel,
            "HAZARD_RAISED",
            &detail,
            Some(compartment),
            now_ms,
        )
        .await?;
    Ok(Json(json!({ "hazard": hazard, "recorded": record })))
}

/// An administrative clearance, as posted: which recorded fact is verified
/// ended, and on what basis.
#[derive(Debug, serde::Deserialize)]
pub(crate) struct ClearHazardBody {
    /// The hazard's origin space.
    compartment: String,
    /// The hazard kind, in the engine's serde names (`energised_bus`, …).
    kind: wadl_engine::HazardKind,
    /// What was verified and by whom — "tags hung, zero energy confirmed by
    /// shift electrician". Required: a clearance without its basis is a
    /// silent delete.
    basis: String,
}

/// Administratively clears a hazard: the crew verified the field condition
/// ended (tags hung, gas-free sighted), someone with the authority records
/// that here, and every verdict the hazard was driving re-derives clean on
/// the next read — same space, coupled spaces, refused activities alike.
/// That cascade is not this handler's doing: verdicts are computed from live
/// hazards on every read, so ending the fact IS the cascade.
///
/// The clearance happens at the wall clock, not the scrubbed instant — it is
/// a real recorded event, and it lands in the ledger (`HAZARD_CLEARED`,
/// basis in the hashed detail) before the response returns.
pub(crate) async fn clear_hazard(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
    body: Result<Json<ClearHazardBody>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    // Scope first, body second: a foreign hull is not-found before a malformed
    // body can say anything else (see `record_decision`).
    state.store.get_vessel(&scope, vessel).await?;
    let body = match body {
        Ok(Json(body)) => body,
        Err(rejection) => return Err(body_rejection(&rejection)),
    };
    let basis = body.basis.trim();
    if basis.is_empty() {
        return Err(ApiError::OutOfRange(
            "a clearance needs its basis — what was verified, and by whom. \
             Without it this would be a silent delete, not a record."
                .to_owned(),
        ));
    }

    let now_ms = state.clock.now().epoch_millis();
    let cleared = state
        .store
        .clear_hazard(&scope, vessel, &body.compartment, body.kind, basis, now_ms)
        .await?;
    if cleared.is_empty() {
        return Err(ApiError::OutOfRange(format!(
            "no live {} hazard originates in {} — either it was already \
             cleared, or the fact was never recorded here",
            json!(body.kind).as_str().unwrap_or("?"),
            body.compartment,
        )));
    }

    let detail = json!({
        "compartment": body.compartment,
        "kind": body.kind,
        "basis": basis,
        "cleared": cleared.iter().map(|h| h.label.clone()).collect::<Vec<_>>(),
        "cleared_by_org": scope.org.to_string(),
        "at_ms": now_ms,
    });
    let detail = serde_json::to_string(&detail).unwrap_or_default();
    let record = state
        .store
        .append_audit(
            &scope,
            vessel,
            "HAZARD_CLEARED",
            &detail,
            Some(&body.compartment),
            now_ms,
        )
        .await?;
    Ok(Json(json!({ "cleared": cleared, "recorded": record })))
}

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
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
    Query(dry): Query<DryRun>,
    req: axum::extract::Request,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    state.store.get_vessel(&scope, vessel).await?;
    let body: ImportSchedule = read_import_body(req).await?;
    let sor = crate::schedule::parse_xer(&body.label, &body.xer)
        .map_err(|reasons| ApiError::OutOfRange(format!("XER rejected: {reasons}")))?;
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
        })));
    }
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
    })))
}

/// The location-mapping report: how the export's work landed on the hull.
///
/// The dominant risk of every P6 import is WHERE — locations live in a UDF
/// when somebody maintained it, in free text when they did not, and nowhere
/// the rest of the time — so the import door reports the grading per path
/// instead of one located/unlocated number:
///
/// * `located_authored` — the dedicated UDF said where (High).
/// * `located_derived` — a placard was parsed out of the activity's own name
///   (Medium); each one is listed, because a guess a reader cannot inspect
///   is a guess they cannot refuse.
/// * `unlocated` — the schedule did not say (listed by code); each entry
///   carries the zone its WBS bucket names when that bucket is a real zone of
///   this hull — a hint at zone grain, never a location, but enough to put
///   the row in the right swim lane instead of "unzoned".
/// * `unknown_spaces` — located to a compartment the register does not
///   carry: mapped, and to nowhere this hull knows — the finding most worth
///   a look before Confirm.
///
/// Milestones are counted apart: key events carry dates and no place, and
/// folding them into `unlocated` would make every clean import look risky.
fn mapping_report(
    activities: &[wadl_store::model::ActivitySummary],
    compartments: &[wadl_store::model::CompartmentSummary],
) -> Value {
    let known: std::collections::BTreeSet<&str> = compartments
        .iter()
        .map(|c| c.compartment_no.as_str())
        .collect();
    let zones: std::collections::BTreeSet<&str> =
        compartments.iter().map(|c| c.zone.as_str()).collect();
    let work: Vec<_> = activities.iter().filter(|a| !a.is_milestone).collect();
    let mut located_authored = 0_usize;
    let mut located_derived: Vec<Value> = Vec::new();
    let mut unlocated: Vec<Value> = Vec::new();
    let mut unknown_spaces: Vec<Value> = Vec::new();
    for a in &work {
        match (&a.compartment_no, a.compartment_reliability) {
            (Some(no), wadl_store::model::Reliability::High) => {
                located_authored += 1;
                if !known.contains(no.as_str()) {
                    unknown_spaces.push(json!({ "activity": a.code, "compartment": no }));
                }
            }
            (Some(no), _) => {
                located_derived.push(json!({ "activity": a.code, "compartment": no }));
                if !known.contains(no.as_str()) {
                    unknown_spaces.push(json!({ "activity": a.code, "compartment": no }));
                }
            }
            (None, _) => {
                let hint = a.wbs_area.as_deref().filter(|area| zones.contains(area));
                unlocated.push(json!({ "activity": a.code, "zone_hint": hint }));
            }
        }
    }
    json!({
        "work_activities": work.len(),
        "located_authored": located_authored,
        "located_derived": located_derived,
        "unlocated": unlocated,
        "unknown_spaces": unknown_spaces,
        "milestones": activities.len() - work.len(),
    })
}

/// The `?dry_run=` flag on a schedule import.
#[derive(Debug, Clone, Copy, Default, serde::Deserialize)]
pub(crate) struct DryRun {
    pub(crate) dry_run: Option<bool>,
}

/// One ledger line per document that changes hands.
///
/// Every door commit and every revert lands here as `DOCUMENT_REPLACED` or
/// `DOCUMENT_REVERTED`, with the kind, the label and the counts in the hashed
/// detail. A tamper-evident record that let a whole zone chart or manning
/// book be swapped silently was a record with a hole in it exactly where an
/// auditor would look first.
async fn ledger_document(
    state: &AppState,
    scope: &wadl_store::TenantScope,
    vessel: VesselId,
    action: &str,
    kind: &str,
    label: Option<&str>,
    counts: Value,
) -> Result<(), ApiError> {
    let now_ms = state.clock.now().epoch_millis();
    let detail = json!({
        "kind": kind,
        "label": label,
        "counts": counts,
        "by_org": scope.org.to_string(),
        "at_ms": now_ms,
    });
    let detail = serde_json::to_string(&detail).unwrap_or_default();
    state
        .store
        .append_audit(scope, vessel, action, &detail, None, now_ms)
        .await?;
    Ok(())
}

/// Reverts the hull to its generated register, discarding the ingested
/// schedule of record. The undo the import door needs to be safe to try.
pub(crate) async fn revert_schedule(
    State(state): State<AppState>,
    Caller(scope): Caller,
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

/// The audit that joins a zone chart to the compartment register: which
/// assigned spaces fall outside their zone's authored bounds, which zones
/// carry spaces but no bound, which bounds name a zone with no spaces.
///
/// Computed HERE, once, and served — the shell only draws it. The rule "is
/// this space inside its zone" implemented twice, once per side of the wire,
/// is how the deck plan and the whole-ship view would eventually disagree
/// about the same placard.
fn zone_audit(
    compartments: &[wadl_store::model::CompartmentSummary],
    decks: &[wadl_store::model::DeckSummary],
    bounds: &[wadl_store::model::ZoneBoundSummary],
) -> Value {
    let ordinal: std::collections::BTreeMap<&str, i32> =
        decks.iter().map(|d| (d.code.as_str(), d.ordinal)).collect();
    // A zone owns one or more BLOCKS — a frame band on a band of decks. A
    // space is in bounds when any block of its zone contains its deck and
    // its frame (docs/zone-scheme.md).
    let mut blocks: std::collections::BTreeMap<&str, Vec<&wadl_store::model::ZoneBoundSummary>> =
        std::collections::BTreeMap::new();
    for b in bounds {
        blocks.entry(b.zone.as_str()).or_default().push(b);
    }
    let contains = |b: &wadl_store::model::ZoneBoundSummary, frame: i32, deck_ordinal: i32| {
        if frame < b.lo_frame || frame > b.hi_frame {
            return false;
        }
        match (&b.top_deck, &b.bottom_deck) {
            (Some(top), Some(bottom)) => {
                let (Some(&t), Some(&bo)) =
                    (ordinal.get(top.as_str()), ordinal.get(bottom.as_str()))
                else {
                    return false;
                };
                deck_ordinal >= t && deck_ordinal <= bo
            }
            _ => true,
        }
    };
    let describe = |bs: &[&wadl_store::model::ZoneBoundSummary]| {
        bs.iter()
            .map(|b| match (&b.top_deck, &b.bottom_deck) {
                (Some(t), Some(bo)) if t == bo => {
                    format!("Fr {}–{} on {t}", b.lo_frame, b.hi_frame)
                }
                (Some(t), Some(bo)) => format!("Fr {}–{} on {t}–{bo}", b.lo_frame, b.hi_frame),
                _ => format!("Fr {}–{}", b.lo_frame, b.hi_frame),
            })
            .collect::<Vec<_>>()
            .join("; ")
    };
    let mut out_of_bounds = Vec::new();
    let mut zones_seen = std::collections::BTreeSet::new();
    for c in compartments {
        zones_seen.insert(c.zone.as_str());
        let (Some(frame), Some(bs)) = (c.frame, blocks.get(c.zone.as_str())) else {
            continue;
        };
        if !bs.iter().any(|b| contains(b, frame, c.deck_ordinal)) {
            out_of_bounds.push(json!({
                "compartment": c.compartment_no,
                "zone": c.zone,
                "frame": frame,
                "deck_code": c.deck_code,
                "lo_frame": bs.first().map_or(0, |b| b.lo_frame),
                "hi_frame": bs.first().map_or(0, |b| b.hi_frame),
                "bounds": describe(bs),
            }));
        }
    }
    let unbounded_zones: Vec<&str> = zones_seen
        .iter()
        .filter(|z| !blocks.contains_key(**z))
        .copied()
        .collect();
    let unassigned_bounds: Vec<&str> = blocks
        .keys()
        .filter(|z| !zones_seen.contains(**z))
        .copied()
        .collect();
    json!({
        "out_of_bounds": out_of_bounds,
        "unbounded_zones": unbounded_zones,
        "unassigned_bounds": unassigned_bounds,
    })
}

/// The hull's zone chart, with the audit that joins it to the register.
///
/// `source` and `bounds` are the ingested chart, or null/empty when the views
/// are still inferring bands from space extents. The audit is only non-empty
/// once a chart exists: an inferred band cannot disagree with the spaces it
/// was inferred from.
pub(crate) async fn zones(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    state.store.get_vessel(&scope, vessel).await?;
    let register = state.store.zone_register(&scope, vessel).await?;
    let compartments = state.store.list_compartments(&scope, vessel).await?;
    let decks = state.store.list_decks(&scope, vessel).await?;
    let (source, bounds) = match register {
        Some(r) => (Some(r.label), r.bounds),
        None => (None, Vec::new()),
    };
    Ok(Json(json!({
        "source": source,
        "bounds": bounds,
        "audit": zone_audit(&compartments, &decks, &bounds),
    })))
}

/// How far across a frame boundary "next door" reaches: eight frames, 32 ft
/// on this class — about two compartments.
const BOUNDARY_FRAMES: i32 = 8;

/// The frame extent a space claims: the surveyed extent where the geometry
/// register has one, the placard's frame station otherwise.
fn frame_extent(c: &wadl_store::model::CompartmentSummary) -> Option<(i32, i32)> {
    match (c.fwd_frame, c.aft_frame, c.frame) {
        (Some(f), Some(a), _) => Some((f, a)),
        (_, _, Some(f)) => Some((f, f)),
        _ => None,
    }
}

/// Every reason a space outside a zone counts as next door to it, keyed by
/// placard: `frame_boundary`, `deck_above`, `deck_below`, `coupled:<code>`.
fn adjacency_reasons<'a>(
    compartments: &'a [wadl_store::model::CompartmentSummary],
    inside: &[&wadl_store::model::CompartmentSummary],
    graph: &wadl_engine::AdjacencyGraph,
) -> std::collections::BTreeMap<&'a str, std::collections::BTreeSet<String>> {
    // The hull's deck order: "directly above" is the previous ordinal the
    // register carries, not ordinal - 1.
    let mut ordinals: Vec<i32> = compartments.iter().map(|c| c.deck_ordinal).collect();
    ordinals.sort_unstable();
    ordinals.dedup();
    let neighbour_decks = |o: i32| -> (Option<i32>, Option<i32>) {
        let i = ordinals.iter().position(|&x| x == o);
        (
            i.and_then(|i| i.checked_sub(1))
                .and_then(|i| ordinals.get(i).copied()),
            i.and_then(|i| ordinals.get(i + 1).copied()),
        )
    };
    // The zone's frame extent per deck it occupies.
    let mut extent_by_deck: std::collections::BTreeMap<i32, (i32, i32)> =
        std::collections::BTreeMap::new();
    for c in inside {
        if let Some((f, a)) = frame_extent(c) {
            extent_by_deck
                .entry(c.deck_ordinal)
                .and_modify(|e| {
                    e.0 = e.0.min(f);
                    e.1 = e.1.max(a);
                })
                .or_insert((f, a));
        }
    }
    let inside_set: std::collections::BTreeSet<&str> =
        inside.iter().map(|c| c.compartment_no.as_str()).collect();

    let mut via: std::collections::BTreeMap<&str, std::collections::BTreeSet<String>> =
        std::collections::BTreeMap::new();
    for c in compartments {
        if inside_set.contains(c.compartment_no.as_str()) {
            continue;
        }
        let Some((of, oa)) = frame_extent(c) else {
            continue;
        };
        // Across the frame boundary: within reach of any zone space on this deck.
        let near = inside.iter().any(|i| {
            i.deck_ordinal == c.deck_ordinal
                && frame_extent(i).is_some_and(|(f, a)| (of - a).max(f - oa) <= BOUNDARY_FRAMES)
        });
        if near {
            via.entry(c.compartment_no.as_str())
                .or_default()
                .insert("frame_boundary".to_owned());
        }
        // On the deck directly above or below a zone deck, inside the zone's
        // frame extent there. `below` is the deck under this space: the space
        // sits ABOVE the zone when the zone occupies the deck below it.
        let (above, below) = neighbour_decks(c.deck_ordinal);
        for (deck, word) in [(below, "deck_above"), (above, "deck_below")] {
            let Some(deck) = deck else { continue };
            if let Some(&(lo, hi)) = extent_by_deck.get(&deck) {
                if of <= hi && oa >= lo {
                    via.entry(c.compartment_no.as_str())
                        .or_default()
                        .insert(word.to_owned());
                }
            }
        }
    }
    // Coupled: an edge with one end in the zone and one end outside, either way.
    for e in graph.edges() {
        let (from, to) = (e.from.as_str(), e.to.as_str());
        let outside = match (inside_set.contains(from), inside_set.contains(to)) {
            (true, false) => to,
            (false, true) => from,
            _ => continue,
        };
        if let Some(c) = compartments
            .iter()
            .find(|c| c.compartment_no.as_str() == outside)
        {
            via.entry(c.compartment_no.as_str())
                .or_default()
                .insert(format!("coupled:{}", e.code.as_str()));
        }
    }
    via
}

/// `GET /api/vessels/:id/zones/:zone/adjacent` — the spaces next door to a
/// zone, each saying why it counts as next door (docs/zone-scheme.md):
/// across the frame boundary on the same deck, on the deck directly above or
/// below inside the zone's frame extent, or coupled into the zone by a path
/// the rules bind to. Served with each space's authorization state and the
/// field conditions live in it at the instant, so a zone-focused screen can
/// blot out the rest of the hull and still show what is about to reach in.
///
/// Computed here, once, from the register, the geometry and the coupling
/// graph; the screens draw it and never re-derive it.
pub(crate) async fn zone_adjacent(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path((id, zone)): Path<(Uuid, String)>,
    Query(as_of): Query<AsOf>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    let at = as_of.resolve(&state, &state.store.get_vessel(&scope, vessel).await?)?;
    let mut compartments = state.store.list_compartments(&scope, vessel).await?;
    overlay_geometry(&state, &scope, vessel, &mut compartments).await?;
    let inside: Vec<&wadl_store::model::CompartmentSummary> =
        compartments.iter().filter(|c| c.zone == zone).collect();
    if inside.is_empty() {
        return Err(ApiError::NotFound);
    }
    let graph = state.store.adjacency_graph(&scope, vessel).await?;
    let hazards = state.store.live_hazards(&scope, vessel, at).await?;
    let rules = state.store.rules_in_force(&scope, vessel).await?;
    let via = adjacency_reasons(&compartments, &inside, &graph);

    let mut adjacent: Vec<Value> = compartments
        .iter()
        .filter_map(|c| {
            let ways = via.get(c.compartment_no.as_str())?;
            let decision = evaluate(&EvaluationRequest {
                subject: &c.compartment_no,
                graph: &graph,
                rules: &rules,
                hazards: &hazards,
                at,
            });
            let live: Vec<Value> = hazards
                .iter()
                .filter(|h| h.origin == c.compartment_no)
                .map(|h| json!({ "kind": h.kind, "label": h.label }))
                .collect();
            Some(json!({
                "compartment": c.compartment_no,
                "name": c.name,
                "zone": c.zone,
                "deck_code": c.deck_code,
                "deck_ordinal": c.deck_ordinal,
                "frame": c.frame,
                "side": c.side,
                "via": ways,
                "state": decision.state,
                "permits_work": decision.permits_work(),
                "hazards": live,
            }))
        })
        .collect();
    // Worst first: what refuses work next door is what a zone manager reads
    // first; then what carries a live condition; then by placard.
    adjacent.sort_by_key(|r| {
        (
            r["permits_work"].as_bool().unwrap_or(true),
            r["hazards"].as_array().map_or(0, Vec::len) == 0,
            r["compartment"].as_str().unwrap_or("").to_owned(),
        )
    });
    Ok(Json(json!({
        "zone": zone,
        "as_of": at,
        "inside": inside.iter().map(|c| &c.compartment_no).collect::<Vec<_>>(),
        "adjacent": adjacent,
        "basis": format!(
            "next door = within {BOUNDARY_FRAMES} frames of a zone space on the same deck, on the deck directly above or below inside the zone's frame extent there, or coupled to a zone space by a path the rules bind to; extents surveyed where the geometry register has them, placard frames otherwise"
        ),
    })))
}

/// The body of a zone-chart import: authored frame bounds per zone.
#[derive(Debug, serde::Deserialize)]
pub(crate) struct ImportZones {
    /// Where the chart came from, shown wherever the bands are drawn.
    pub(crate) label: String,
    /// The authored bounds.
    pub(crate) bounds: Vec<wadl_store::model::ZoneBoundSummary>,
}

/// Ingests a zone chart — authored frame bounds — as the hull's zone register.
///
/// All-or-nothing, like the schedule import: one malformed bound refuses the
/// whole chart with every reason listed, because a partially loaded chart
/// presenting as the authored one is the exact lie authored bounds exist to
/// end. `?dry_run=true` answers with the audit the chart WOULD produce —
/// including the spaces it would put out of bounds — without storing anything.
pub(crate) async fn import_zones(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
    Query(dry): Query<DryRun>,
    req: axum::extract::Request,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    state.store.get_vessel(&scope, vessel).await?;
    let body: ImportZones = read_import_body(req).await?;
    let decks = state.store.list_decks(&scope, vessel).await?;
    let rejections = zone_rejections(&body, &decks);
    if !rejections.is_empty() {
        return Err(ApiError::OutOfRange(format!(
            "the chart was refused whole: {}",
            rejections.join("; ")
        )));
    }

    let compartments = state.store.list_compartments(&scope, vessel).await?;
    let audit = zone_audit(&compartments, &decks, &body.bounds);
    if dry.dry_run.unwrap_or(false) {
        return Ok(Json(json!({
            "stored": false,
            "label": body.label,
            "zones": body.bounds.len(),
            "audit": audit,
        })));
    }
    let zones = body.bounds.len();
    let label = body.label.clone();
    state
        .store
        .set_zone_register(
            &scope,
            vessel,
            wadl_store::memory::ZoneRegister {
                label: body.label,
                bounds: body.bounds,
            },
        )
        .await?;
    ledger_document(
        &state,
        &scope,
        vessel,
        "DOCUMENT_REPLACED",
        "zone_register",
        Some(&label),
        json!({ "zones": zones }),
    )
    .await?;
    Ok(Json(json!({
        "stored": true,
        "label": label,
        "zones": zones,
        "audit": audit,
    })))
}

/// Every reason a candidate zone chart is refused whole: no label, no
/// bounds, a bound naming no zone, frames aft-to-forward, a block naming one
/// deck of its band or a deck the register does not carry, a top deck below
/// its bottom, or the same block twice. Capped so the refusal stays readable.
fn zone_rejections(body: &ImportZones, decks: &[wadl_store::model::DeckSummary]) -> Vec<String> {
    let mut rejections: Vec<String> = Vec::new();
    if body.label.trim().is_empty() {
        rejections.push("the chart carries no label".to_owned());
    }
    if body.bounds.is_empty() {
        rejections.push("the chart carries no bounds".to_owned());
    }
    let ordinal: std::collections::BTreeMap<&str, i32> =
        decks.iter().map(|d| (d.code.as_str(), d.ordinal)).collect();
    let mut seen = std::collections::BTreeSet::new();
    for b in &body.bounds {
        if b.zone.trim().is_empty() {
            rejections.push(format!(
                "a bound {}–{} names no zone",
                b.lo_frame, b.hi_frame
            ));
        }
        if b.lo_frame > b.hi_frame {
            rejections.push(format!(
                "{}: lo frame {} is aft of hi frame {}",
                b.zone, b.lo_frame, b.hi_frame
            ));
        }
        // A block names both decks of its band or neither; the decks must be
        // ones the register carries, and the top must not sit below the bottom.
        match (&b.top_deck, &b.bottom_deck) {
            (None, None) => {}
            (Some(top), Some(bottom)) => {
                for code in [top, bottom] {
                    if !ordinal.contains_key(code.as_str()) {
                        rejections.push(format!(
                            "{}: deck {code:?} is not one this hull's register carries",
                            b.zone
                        ));
                    }
                }
                if let (Some(t), Some(bo)) =
                    (ordinal.get(top.as_str()), ordinal.get(bottom.as_str()))
                {
                    if t > bo {
                        rejections.push(format!(
                            "{}: top deck {top} sits below bottom deck {bottom}",
                            b.zone
                        ));
                    }
                }
            }
            _ => rejections.push(format!(
                "{}: a block names one deck of its band, not both",
                b.zone
            )),
        }
        // The same zone may own several blocks; the same block twice is a
        // copy-paste error the chart should not carry.
        if !seen.insert((
            b.zone.as_str(),
            b.lo_frame,
            b.hi_frame,
            b.top_deck.as_deref(),
            b.bottom_deck.as_deref(),
        )) {
            rejections.push(format!(
                "{} Fr {}–{} is listed twice",
                b.zone, b.lo_frame, b.hi_frame
            ));
        }
    }
    if rejections.len() > 12 {
        rejections.truncate(12);
        rejections.push("…".to_owned());
    }
    rejections
}

/// The body of a budget-book import: one line per work item.
#[derive(Debug, serde::Deserialize)]
pub(crate) struct ImportBudgets {
    /// Where the book came from, named wherever its numbers are used.
    pub(crate) label: String,
    /// The budget lines.
    pub(crate) items: Vec<wadl_store::model::BudgetItemSummary>,
}

/// Ingests a budget book as the hull's hours authority.
///
/// From the next read on, reconciliation holds the register's hours to THIS
/// book instead of the seeded work items — the book does not replace the
/// operational work orders, it replaces what the hours answer to. Same seam
/// discipline as the other two doors: all-or-nothing with every rejection
/// reason listed, and `?dry_run=true` answers with the reconciliation the
/// book WOULD produce against the current register, storing nothing.
pub(crate) async fn import_budgets(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
    Query(dry): Query<DryRun>,
    req: axum::extract::Request,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    state.store.get_vessel(&scope, vessel).await?;
    let body: ImportBudgets = read_import_body(req).await?;

    let mut rejections: Vec<String> = Vec::new();
    if body.label.trim().is_empty() {
        rejections.push("the book carries no label".to_owned());
    }
    if body.items.is_empty() {
        rejections.push("the book carries no items".to_owned());
    }
    let mut seen = std::collections::BTreeSet::new();
    for item in &body.items {
        if item.code.trim().is_empty() {
            rejections.push(format!("a line titled {:?} names no code", item.title));
        }
        if item.budget_hours.get() < 0 || item.earned_hours.get() < 0 {
            rejections.push(format!("{}: negative hours", item.code));
        }
        if !seen.insert(item.code.as_str()) {
            rejections.push(format!("{} is budgeted twice", item.code));
        }
    }
    if !rejections.is_empty() {
        return Err(ApiError::OutOfRange(format!(
            "the book was refused whole: {}",
            rejections.join("; ")
        )));
    }

    let book = wadl_store::memory::BudgetBook {
        label: body.label,
        items: body.items,
    };
    if dry.dry_run.unwrap_or(false) {
        // Priced against the register as-if: swap the book in only for the
        // comparison, never for the store.
        let activities = state.store.list_activities(&scope, vessel).await?;
        let preview = reconcile_against(&activities, &book);
        return Ok(Json(json!({
            "stored": false,
            "label": book.label,
            "items": book.items.len(),
            "reconciliation": preview,
        })));
    }
    let label = book.label.clone();
    let items = book.items.len();
    state.store.set_budget_book(&scope, vessel, book).await?;
    ledger_document(
        &state,
        &scope,
        vessel,
        "DOCUMENT_REPLACED",
        "budget_book",
        Some(&label),
        json!({ "items": items }),
    )
    .await?;
    let activities = state.store.list_activities(&scope, vessel).await?;
    let reconciliation = reconcile(&state, &scope, vessel, &activities).await?;
    Ok(Json(json!({
        "stored": true,
        "label": label,
        "items": items,
        "reconciliation": reconciliation,
    })))
}

/// The dry run's comparison: the register's hours against a book that is NOT
/// stored — the same arithmetic as [`reconcile`], against a candidate.
fn reconcile_against(
    activities: &[wadl_store::model::ActivitySummary],
    book: &wadl_store::memory::BudgetBook,
) -> Value {
    let mut by_item: std::collections::BTreeMap<&str, (i64, i64)> =
        std::collections::BTreeMap::new();
    let mut unmapped_budget = 0_i64;
    for a in activities.iter().filter(|a| !a.is_milestone) {
        match a.work_order_code.as_deref() {
            Some(code) => {
                let entry = by_item.entry(code).or_insert((0, 0));
                entry.0 += a.budget_hours.get();
                entry.1 += a.earned_hours.get();
            }
            None => unmapped_budget += a.budget_hours.get(),
        }
    }
    let mismatches: Vec<Value> = book
        .items
        .iter()
        .filter_map(|i| {
            let (rb, re) = by_item.get(i.code.as_str()).copied().unwrap_or((0, 0));
            (rb != i.budget_hours.get() || re != i.earned_hours.get()).then(|| {
                json!({
                    "code": i.code,
                    "item_budget": i.budget_hours,
                    "register_budget": rb,
                    "item_earned": i.earned_hours,
                    "register_earned": re,
                })
            })
        })
        .collect();
    json!({
        "source": book.label,
        "items": book.items.len(),
        "mismatches": mismatches,
        "unmapped_budget_hours": unmapped_budget,
    })
}

/// Discards the ingested budget book; reconciliation returns to the seeded
/// work items.
pub(crate) async fn revert_budgets(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    state.store.clear_budget_book(&scope, vessel).await?;
    ledger_document(
        &state,
        &scope,
        vessel,
        "DOCUMENT_REVERTED",
        "budget_book",
        None,
        json!({}),
    )
    .await?;
    Ok(Json(json!({ "reverted": true })))
}

/// The body of a manning-book import: one line per trade.
#[derive(Debug, serde::Deserialize)]
pub(crate) struct ImportManning {
    /// Where the book came from, named wherever its numbers are used.
    pub(crate) label: String,
    /// The crew lines.
    pub(crate) crews: Vec<wadl_store::model::ManningCrewSummary>,
}

/// The hull's manning book, or `null` when none is loaded — in which case the
/// boards show demand only and say so.
pub(crate) async fn get_manning(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    let book = state.store.manning_book(&scope, vessel).await?;
    Ok(Json(json!({
        "book": book.map(|b| json!({ "label": b.label, "crews": b.crews })),
    })))
}

/// Ingests a manning book as the hull's crew-supply authority.
///
/// The demand side of crew planning is computed from the register (a window's
/// scheduled hours over the window). This door is the SUPPLY side — the people
/// the yard actually has per trade, per half-shift — and it is the only way a
/// headcount enters: the platform never invents one. All-or-nothing, same as
/// every document door: refused whole, previewed with `?dry_run=true`,
/// reverted whole.
pub(crate) async fn import_manning(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
    Query(dry): Query<DryRun>,
    req: axum::extract::Request,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    state.store.get_vessel(&scope, vessel).await?;
    let body: ImportManning = read_import_body(req).await?;

    let mut rejections: Vec<String> = Vec::new();
    if body.label.trim().is_empty() {
        rejections.push("the book carries no label".to_owned());
    }
    if body.crews.is_empty() {
        rejections.push("the book carries no crews".to_owned());
    }
    let mut seen = std::collections::BTreeSet::new();
    for crew in &body.crews {
        if crew.trade.trim().is_empty() {
            rejections.push("a line names no trade".to_owned());
        }
        if crew.headcount < 0 {
            rejections.push(format!("{}: negative headcount", crew.trade));
        }
        if !seen.insert(crew.trade.as_str()) {
            rejections.push(format!("{} is manned twice", crew.trade));
        }
    }
    if !rejections.is_empty() {
        return Err(ApiError::OutOfRange(format!(
            "the book was refused whole: {}",
            rejections.join("; ")
        )));
    }

    // The preview names which register trades the book does and does not
    // cover — a book that spells "Electrical" as "ELEC" would otherwise store
    // cleanly and then match nothing, which is worse than a refusal.
    let activities = state.store.list_activities(&scope, vessel).await?;
    let register_trades: std::collections::BTreeSet<&str> = activities
        .iter()
        .filter(|a| !a.is_milestone)
        .map(|a| a.trade.as_str())
        .collect();
    let book_trades: std::collections::BTreeSet<&str> =
        body.crews.iter().map(|c| c.trade.as_str()).collect();
    let unmatched_book: Vec<&&str> = book_trades.difference(&register_trades).collect();
    let uncovered_register: Vec<&&str> = register_trades.difference(&book_trades).collect();
    let coverage = json!({
        "book_trades_matching_no_register_trade": unmatched_book,
        "register_trades_with_no_manning_line": uncovered_register,
    });

    let book = wadl_store::memory::ManningBook {
        label: body.label,
        crews: body.crews,
    };
    if dry.dry_run.unwrap_or(false) {
        return Ok(Json(json!({
            "stored": false,
            "label": book.label,
            "crews": book.crews.len(),
            "coverage": coverage,
        })));
    }
    let label = book.label.clone();
    let crews = book.crews.len();
    state.store.set_manning_book(&scope, vessel, book).await?;
    ledger_document(
        &state,
        &scope,
        vessel,
        "DOCUMENT_REPLACED",
        "manning_book",
        Some(&label),
        json!({ "crews": crews }),
    )
    .await?;
    Ok(Json(json!({
        "stored": true,
        "label": label,
        "crews": crews,
        "coverage": coverage,
    })))
}

/// The body of a geometry-register import (`docs/geometry-accuracy.md`).
#[derive(Debug, serde::Deserialize)]
pub(crate) struct ImportGeometry {
    /// Where the register came from, e.g. a C&A drawing extract.
    pub(crate) label: String,
    /// Surveyed frame extents, one row per space.
    #[serde(default)]
    pub(crate) spaces: Vec<wadl_store::model::SpaceGeometrySummary>,
    /// Deck coverage bands — where each deck physically exists.
    #[serde(default)]
    pub(crate) decks: Vec<wadl_store::model::DeckCoverageSummary>,
}

/// The findings a geometry register raises against the current compartment
/// register. Computed at dry-run AND on every read, so they cannot go stale:
/// the placard number encodes the forward boundary, which makes a survey that
/// disagrees with it a computable finding; a space outside its deck's coverage
/// bands is a transcription error wearing coordinates.
fn geometry_findings(
    register: &wadl_store::memory::GeometryRegister,
    compartments: &[wadl_store::model::CompartmentSummary],
) -> Value {
    const EXAMPLES: usize = 8;
    let known: std::collections::BTreeMap<&str, &wadl_store::model::CompartmentSummary> =
        compartments
            .iter()
            .map(|c| (c.compartment_no.as_str(), c))
            .collect();
    let mut bands: std::collections::BTreeMap<&str, Vec<(i32, i32)>> =
        std::collections::BTreeMap::new();
    for d in &register.decks {
        bands
            .entry(d.deck_code.as_str())
            .or_default()
            .push((d.lo_frame, d.hi_frame));
    }
    // Coalesce overlapping or touching bands before any containment check: a
    // deck delineated 20..210 and 210..248 is continuous plating, and a space
    // surveyed 205..215 lies entirely on it — flagging that as "outside
    // coverage" would send a person to investigate a finding the data does
    // not support.
    for deck_bands in bands.values_mut() {
        deck_bands.sort_unstable();
        let mut merged: Vec<(i32, i32)> = Vec::with_capacity(deck_bands.len());
        for &(lo, hi) in deck_bands.iter() {
            match merged.last_mut() {
                Some(last) if lo <= last.1 => last.1 = last.1.max(hi),
                _ => merged.push((lo, hi)),
            }
        }
        *deck_bands = merged;
    }

    let mut placard_disagreements: Vec<Value> = Vec::new();
    let mut outside_coverage: Vec<Value> = Vec::new();
    let mut unknown = 0_usize;
    let mut unknown_examples: Vec<&str> = Vec::new();
    let mut surveyed = 0_usize;
    for g in &register.spaces {
        let Some(c) = known.get(g.compartment_no.as_str()) else {
            unknown += 1;
            if unknown_examples.len() < EXAMPLES {
                unknown_examples.push(&g.compartment_no);
            }
            continue;
        };
        surveyed += 1;
        if let Some(usn) = c.compartment_no.parse_usn() {
            if usn.frame.get() != g.fwd_frame {
                placard_disagreements.push(json!({
                    "compartment_no": g.compartment_no,
                    "placard_frame": usn.frame.get(),
                    "surveyed_fwd": g.fwd_frame,
                }));
            }
        }
        if let Some(deck_bands) = bands.get(c.deck_code.as_str()) {
            let inside = deck_bands
                .iter()
                .any(|&(lo, hi)| g.fwd_frame >= lo && g.aft_frame <= hi);
            if !inside {
                outside_coverage.push(json!({
                    "compartment_no": g.compartment_no,
                    "deck_code": c.deck_code,
                    "fwd_frame": g.fwd_frame,
                    "aft_frame": g.aft_frame,
                }));
            }
        }
    }
    json!({
        "surveyed": surveyed,
        "register_total": compartments.len(),
        "placard_disagreements": placard_disagreements,
        "outside_deck_coverage": outside_coverage,
        "unknown_spaces": { "count": unknown, "examples": unknown_examples },
    })
}

/// The hull's geometry register with its live findings, or `null` — placard
/// parses all round, and the surface says so.
pub(crate) async fn get_geometry(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    let Some(register) = state.store.geometry_register(&scope, vessel).await? else {
        state.store.get_vessel(&scope, vessel).await?;
        return Ok(Json(
            json!({ "register": Value::Null, "findings": Value::Null }),
        ));
    };
    let compartments = state.store.list_compartments(&scope, vessel).await?;
    let findings = geometry_findings(&register, &compartments);
    Ok(Json(json!({
        "register": {
            "label": register.label,
            "spaces": register.spaces.len(),
            "decks": register.decks,
        },
        "findings": findings,
    })))
}

/// Ingests a geometry register: surveyed frame extents per space and coverage
/// bands per deck. Refusals are structural (the file is malformed);
/// disagreements with the register are FINDINGS — previewed before Confirm,
/// served on every read — because a survey that contradicts a placard is
/// exactly the thing a person should look at, not a thing to hide.
pub(crate) async fn import_geometry(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
    Query(dry): Query<DryRun>,
    req: axum::extract::Request,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    state.store.get_vessel(&scope, vessel).await?;
    let body: ImportGeometry = read_import_body(req).await?;

    let mut rejections: Vec<String> = Vec::new();
    if body.label.trim().is_empty() {
        rejections.push("the register carries no label".to_owned());
    }
    if body.spaces.is_empty() && body.decks.is_empty() {
        rejections.push("the register carries neither spaces nor deck bands".to_owned());
    }
    let mut seen = std::collections::BTreeSet::new();
    for g in &body.spaces {
        if g.compartment_no.trim().is_empty() {
            rejections.push("a space row names no compartment".to_owned());
        }
        if g.fwd_frame > g.aft_frame {
            rejections.push(format!(
                "{}: fwd frame {} is aft of aft frame {}",
                g.compartment_no, g.fwd_frame, g.aft_frame
            ));
        }
        if g.fwd_frame < 0 {
            rejections.push(format!("{}: negative frame", g.compartment_no));
        }
        if !seen.insert(g.compartment_no.as_str()) {
            rejections.push(format!("{} is surveyed twice", g.compartment_no));
        }
    }
    let mut seen_bands = std::collections::BTreeSet::new();
    for d in &body.decks {
        if d.lo_frame > d.hi_frame || d.lo_frame < 0 {
            rejections.push(format!(
                "deck {}: band {}..{} is not a forward-to-aft interval",
                d.deck_code, d.lo_frame, d.hi_frame
            ));
        }
        if !seen_bands.insert((d.deck_code.as_str(), d.lo_frame, d.hi_frame)) {
            rejections.push(format!(
                "deck {}: band {}..{} is delineated twice",
                d.deck_code, d.lo_frame, d.hi_frame
            ));
        }
    }
    if !rejections.is_empty() {
        return Err(ApiError::OutOfRange(format!(
            "the register was refused whole: {}",
            rejections.join("; ")
        )));
    }

    let register = wadl_store::memory::GeometryRegister {
        label: body.label,
        spaces: body.spaces,
        decks: body.decks,
    };
    let compartments = state.store.list_compartments(&scope, vessel).await?;
    let findings = geometry_findings(&register, &compartments);
    if dry.dry_run.unwrap_or(false) {
        return Ok(Json(json!({
            "stored": false,
            "label": register.label,
            "spaces": register.spaces.len(),
            "deck_bands": register.decks.len(),
            "findings": findings,
        })));
    }
    let label = register.label.clone();
    let spaces = register.spaces.len();
    let deck_bands = register.decks.len();
    state
        .store
        .set_geometry_register(&scope, vessel, register)
        .await?;
    ledger_document(
        &state,
        &scope,
        vessel,
        "DOCUMENT_REPLACED",
        "geometry_register",
        Some(&label),
        json!({ "spaces": spaces, "deck_bands": deck_bands }),
    )
    .await?;
    Ok(Json(json!({
        "stored": true,
        "label": label,
        "spaces": spaces,
        "deck_bands": deck_bands,
        "findings": findings,
    })))
}

/// Discards the geometry register; positions return to placard parses.
pub(crate) async fn revert_geometry(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    state.store.clear_geometry_register(&scope, vessel).await?;
    ledger_document(
        &state,
        &scope,
        vessel,
        "DOCUMENT_REVERTED",
        "geometry_register",
        None,
        json!({}),
    )
    .await?;
    Ok(Json(json!({ "reverted": true })))
}

/// Discards the ingested manning book; the boards return to demand only.
pub(crate) async fn revert_manning(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    state.store.clear_manning_book(&scope, vessel).await?;
    ledger_document(
        &state,
        &scope,
        vessel,
        "DOCUMENT_REVERTED",
        "manning_book",
        None,
        json!({}),
    )
    .await?;
    Ok(Json(json!({ "reverted": true })))
}

/// Discards the ingested zone chart; the views return to inferred bands.
pub(crate) async fn revert_zones(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    state.store.clear_zone_register(&scope, vessel).await?;
    ledger_document(
        &state,
        &scope,
        vessel,
        "DOCUMENT_REVERTED",
        "zone_register",
        None,
        json!({}),
    )
    .await?;
    Ok(Json(json!({ "reverted": true })))
}

/* ------------------------------------------------------- the ship itself */

/// The body of a compartment-register import: the hull's decks and spaces.
#[derive(Debug, serde::Deserialize)]
pub(crate) struct ImportRegister {
    /// Where the list came from, e.g. the yard's compartment list extract.
    pub(crate) label: String,
    /// The decks, with ordinals ascending downward.
    #[serde(default)]
    pub(crate) decks: Vec<wadl_store::model::RegisterDeckSummary>,
    /// One row per space.
    #[serde(default)]
    pub(crate) spaces: Vec<wadl_store::model::RegisterSpaceSummary>,
}

/// The hull's compartment register as served: the ingested document if one
/// is loaded, and either way what the reads are currently built from.
pub(crate) async fn get_register(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    state.store.get_vessel(&scope, vessel).await?;
    let register = state.store.compartment_register(&scope, vessel).await?;
    let compartments = state.store.list_compartments(&scope, vessel).await?;
    let decks = state.store.list_decks(&scope, vessel).await?;
    Ok(Json(json!({
        "register": register.as_ref().map(|r| json!({
            "label": r.label,
            "decks": r.decks.len(),
            "spaces": r.spaces.len(),
        })),
        "served": if register.is_some() { "ingested" } else { "seeded" },
        "spaces_served": compartments.len(),
        "decks_served": decks.len(),
    })))
}

/// What a candidate register would change: placards the numbering scheme
/// cannot place and that carry no frame, decks with nothing on them, live
/// field conditions whose space the new register does not carry, and
/// scheduled work located to spaces it does not carry. Computed at dry-run
/// so the consequences are on the table before Confirm.
async fn register_findings(
    state: &AppState,
    scope: &wadl_store::TenantScope,
    vessel: VesselId,
    body: &ImportRegister,
) -> Result<Value, ApiError> {
    let known: std::collections::BTreeSet<&str> = body
        .spaces
        .iter()
        .map(|s| s.compartment_no.as_str())
        .collect();
    let unplaceable: Vec<&str> = body
        .spaces
        .iter()
        .filter(|s| {
            s.frame.is_none()
                && CompartmentNo::new(s.compartment_no.as_str())
                    .parse_usn()
                    .is_none()
        })
        .map(|s| s.compartment_no.as_str())
        .collect();
    let empty_decks: Vec<&str> = body
        .decks
        .iter()
        .filter(|d| !body.spaces.iter().any(|s| s.deck_code == d.code))
        .map(|d| d.code.as_str())
        .collect();
    let hazards = state
        .store
        .live_hazards(scope, vessel, state.clock.now())
        .await?;
    let orphaned_hazards: Vec<Value> = hazards
        .iter()
        .filter(|h| !known.contains(h.origin.as_str()))
        .map(|h| json!({ "compartment": h.origin, "label": h.label }))
        .collect();
    let activities = state.store.list_activities(scope, vessel).await?;
    let orphaned_activities = activities
        .iter()
        .filter(|a| {
            a.compartment_no
                .as_ref()
                .is_some_and(|no| !known.contains(no.as_str()))
        })
        .count();
    Ok(json!({
        "unplaceable": unplaceable,
        "empty_decks": empty_decks,
        "orphaned_hazards": orphaned_hazards,
        "activities_losing_their_space": orphaned_activities,
    }))
}

/// Every reason a candidate register is refused whole: no label, no decks or
/// spaces, a deck listed twice or sharing an ordinal, a placard listed twice
/// or on a deck the register does not carry, a side that is not one of the
/// three the hull has. Capped so the refusal stays readable.
fn register_rejections(body: &ImportRegister) -> Vec<String> {
    let mut rejections: Vec<String> = Vec::new();
    if body.label.trim().is_empty() {
        rejections.push("the register carries no label".to_owned());
    }
    if body.decks.is_empty() {
        rejections.push("the register carries no decks".to_owned());
    }
    if body.spaces.is_empty() {
        rejections.push("the register carries no spaces".to_owned());
    }
    let mut deck_codes = std::collections::BTreeSet::new();
    let mut ordinals = std::collections::BTreeSet::new();
    for d in &body.decks {
        if d.code.trim().is_empty() {
            rejections.push(format!("a deck at ordinal {} has no code", d.ordinal));
        }
        if !deck_codes.insert(d.code.as_str()) {
            rejections.push(format!("deck {} is listed twice", d.code));
        }
        if !ordinals.insert(d.ordinal) {
            rejections.push(format!(
                "deck {} shares ordinal {} with another deck",
                d.code, d.ordinal
            ));
        }
    }
    let mut placards = std::collections::BTreeSet::new();
    for s in &body.spaces {
        if s.compartment_no.trim().is_empty() {
            rejections.push("a space row has no placard".to_owned());
        }
        if !placards.insert(s.compartment_no.as_str()) {
            rejections.push(format!("{} is listed twice", s.compartment_no));
        }
        if !deck_codes.contains(s.deck_code.as_str()) {
            rejections.push(format!(
                "{} is on deck {:?}, which the register does not list",
                s.compartment_no, s.deck_code
            ));
        }
        if let Some(side) = s.side.as_deref() {
            if !matches!(side, "port" | "starboard" | "centreline") {
                rejections.push(format!(
                    "{}: side {side:?} is not port, starboard or centreline",
                    s.compartment_no
                ));
            }
        }
    }
    if rejections.len() > 12 {
        rejections.truncate(12);
        rejections.push("…".to_owned());
    }
    rejections
}

/// Ingests the hull's own compartment register — the ship, through the
/// product. All-or-nothing with every reason listed; `?dry_run=true` previews
/// the findings and stores nothing. Once stored, every read serves it and
/// the seeded register stops existing for this hull.
pub(crate) async fn import_register(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
    Query(dry): Query<DryRun>,
    req: axum::extract::Request,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    state.store.get_vessel(&scope, vessel).await?;
    let body: ImportRegister = read_import_body(req).await?;

    let rejections = register_rejections(&body);
    if !rejections.is_empty() {
        return Err(ApiError::OutOfRange(format!(
            "the register was refused whole: {}",
            rejections.join("; ")
        )));
    }

    let findings = register_findings(&state, &scope, vessel, &body).await?;
    if dry.dry_run.unwrap_or(false) {
        return Ok(Json(json!({
            "stored": false,
            "label": body.label,
            "decks": body.decks.len(),
            "spaces": body.spaces.len(),
            "findings": findings,
        })));
    }
    let label = body.label.clone();
    let (decks, spaces) = (body.decks.len(), body.spaces.len());
    state
        .store
        .set_compartment_register(
            &scope,
            vessel,
            wadl_store::memory::CompartmentRegister {
                label: body.label,
                decks: body.decks,
                spaces: body.spaces,
            },
        )
        .await?;
    ledger_document(
        &state,
        &scope,
        vessel,
        "DOCUMENT_REPLACED",
        "compartment_register",
        Some(&label),
        json!({ "decks": decks, "spaces": spaces }),
    )
    .await?;
    Ok(Json(json!({
        "stored": true,
        "label": label,
        "decks": decks,
        "spaces": spaces,
        "findings": findings,
    })))
}

/// Discards the ingested compartment register; the seed is served again.
pub(crate) async fn revert_register(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    state
        .store
        .clear_compartment_register(&scope, vessel)
        .await?;
    ledger_document(
        &state,
        &scope,
        vessel,
        "DOCUMENT_REVERTED",
        "compartment_register",
        None,
        json!({}),
    )
    .await?;
    Ok(Json(json!({ "reverted": true })))
}

/// The body of a coupling-register import.
#[derive(Debug, serde::Deserialize)]
pub(crate) struct ImportCouplings {
    /// Where the list came from.
    pub(crate) label: String,
    /// Authored rows.
    #[serde(default)]
    pub(crate) edges: Vec<wadl_store::model::CouplingRowSummary>,
    /// Also propose `deck_penetration` edges from deck order and frame
    /// overlap — "directly above" derived from the register rather than
    /// authored one pair at a time.
    #[serde(default)]
    pub(crate) derive_vertical: bool,
}

/// The hull's coupling register as served, with the coupling types a row
/// may name and how many edges the cascade currently walks.
pub(crate) async fn get_couplings(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    state.store.get_vessel(&scope, vessel).await?;
    let register = state.store.coupling_register(&scope, vessel).await?;
    let graph = state.store.adjacency_graph(&scope, vessel).await?;
    let types = state.store.coupling_types(&scope, vessel).await?;
    Ok(Json(json!({
        "register": register.as_ref().map(|r| json!({
            "label": r.label,
            "edges": r.edges.len(),
            "authored": r.edges.iter().filter(|e| e.provenance == "authored").count(),
            "derived": r.edges.iter().filter(|e| e.provenance == "derived").count(),
        })),
        "served": if register.is_some() { "ingested" } else { "seeded" },
        "edges_served": graph.edge_count(),
        "types": types,
    })))
}

use crate::documents::derive_vertical_edges;

/// Every reason a candidate coupling register is refused whole: no label,
/// nothing to store, a coupling type the hull's rules do not bind to, an end
/// that is not on the register, a space coupled to itself, a row listed
/// twice, or a provenance that is neither authored nor derived.
fn coupling_rejections(
    body: &ImportCouplings,
    types: &[wadl_store::model::CouplingTypeSummary],
    compartments: &[wadl_store::model::CompartmentSummary],
) -> Vec<String> {
    let known: std::collections::BTreeSet<&str> = compartments
        .iter()
        .map(|c| c.compartment_no.as_str())
        .collect();
    let mut rejections: Vec<String> = Vec::new();
    if body.label.trim().is_empty() {
        rejections.push("the register carries no label".to_owned());
    }
    if body.edges.is_empty() && !body.derive_vertical {
        rejections.push("the register carries no edges and asks for none to be derived".to_owned());
    }
    let mut seen = std::collections::BTreeSet::new();
    for e in &body.edges {
        if !types.iter().any(|t| t.code == e.code) {
            rejections.push(format!(
                "{} → {}: coupling type {:?} is not one this hull's rules know ({})",
                e.from,
                e.to,
                e.code,
                types
                    .iter()
                    .map(|t| t.code.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        for no in [&e.from, &e.to] {
            if !known.contains(no.as_str()) {
                rejections.push(format!("{no} is not on this hull's register"));
            }
        }
        if e.from == e.to {
            rejections.push(format!("{} is coupled to itself", e.from));
        }
        if !seen.insert((e.from.as_str(), e.to.as_str(), e.code.as_str())) {
            rejections.push(format!(
                "{} → {} ({}) is listed twice",
                e.from, e.to, e.code
            ));
        }
        if !matches!(e.provenance.as_str(), "authored" | "derived") {
            rejections.push(format!(
                "{} → {}: provenance must be authored or derived",
                e.from, e.to
            ));
        }
    }
    if rejections.len() > 12 {
        rejections.truncate(12);
        rejections.push("…".to_owned());
    }
    rejections
}

/// Ingests the hull's coupling register — the paths a hazard can travel.
/// Rows are validated against the coupling types the hull's rules bind to
/// and against the compartment register; `derive_vertical` adds proposed
/// deck penetrations, each marked `derived`. All-or-nothing; `?dry_run=true`
/// previews, including every derived edge, and stores nothing.
pub(crate) async fn import_couplings(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
    Query(dry): Query<DryRun>,
    req: axum::extract::Request,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    state.store.get_vessel(&scope, vessel).await?;
    let body: ImportCouplings = read_import_body(req).await?;
    let types = state.store.coupling_types(&scope, vessel).await?;
    let compartments = state.store.list_compartments(&scope, vessel).await?;
    let rejections = coupling_rejections(&body, &types, &compartments);
    if !rejections.is_empty() {
        return Err(ApiError::OutOfRange(format!(
            "the register was refused whole: {}",
            rejections.join("; ")
        )));
    }

    let mut compartments = compartments;
    overlay_geometry(&state, &scope, vessel, &mut compartments).await?;
    let derived = if body.derive_vertical {
        derive_vertical_edges(&compartments, &body.edges)
    } else {
        Vec::new()
    };
    let authored = body.edges.len();
    let mut edges = body.edges;
    edges.extend(derived.iter().cloned());
    let preview: Vec<&wadl_store::model::CouplingRowSummary> = derived.iter().take(50).collect();
    if dry.dry_run.unwrap_or(false) {
        return Ok(Json(json!({
            "stored": false,
            "label": body.label,
            "authored": authored,
            "derived": derived.len(),
            "derived_edges": preview,
            "edges": edges.len(),
        })));
    }
    let label = body.label.clone();
    let total = edges.len();
    state
        .store
        .set_coupling_register(
            &scope,
            vessel,
            wadl_store::memory::CouplingRegister {
                label: body.label,
                edges,
            },
        )
        .await?;
    ledger_document(
        &state,
        &scope,
        vessel,
        "DOCUMENT_REPLACED",
        "coupling_register",
        Some(&label),
        json!({ "authored": authored, "derived": derived.len() }),
    )
    .await?;
    Ok(Json(json!({
        "stored": true,
        "label": label,
        "authored": authored,
        "derived": derived.len(),
        "derived_edges": preview,
        "edges": total,
    })))
}

/// Discards the ingested coupling register; the seeded edges are walked again.
pub(crate) async fn revert_couplings(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    state.store.clear_coupling_register(&scope, vessel).await?;
    ledger_document(
        &state,
        &scope,
        vessel,
        "DOCUMENT_REVERTED",
        "coupling_register",
        None,
        json!({}),
    )
    .await?;
    Ok(Json(json!({ "reverted": true })))
}

/// One line of a hazard log — the day's tag-out or permit list.
#[derive(Debug, serde::Deserialize)]
pub(crate) struct HazardLogRow {
    /// The origin space.
    compartment: String,
    /// The hazard kind, in the engine's serde names.
    kind: wadl_engine::HazardKind,
    /// The fact as the deck says it.
    label: String,
    /// When it was raised, epoch ms; defaults to the wall clock.
    #[serde(default)]
    since_ms: Option<i64>,
}

/// The body of a hazard-log import.
#[derive(Debug, serde::Deserialize)]
pub(crate) struct ImportHazardLog {
    /// Where the log came from, e.g. the tag-out log's morning export.
    pub(crate) label: String,
    /// The lines.
    #[serde(default)]
    pub(crate) rows: Vec<HazardLogRow>,
}

/// Every reason a hazard log is refused whole: no label, no rows, a row
/// without a label, a row on a space the hull does not carry, or a row raised
/// in the future. Capped so the refusal stays readable.
fn hazard_log_rejections(
    body: &ImportHazardLog,
    register: &[wadl_store::model::CompartmentSummary],
    now_ms: i64,
) -> Vec<String> {
    let known: std::collections::BTreeSet<&str> =
        register.iter().map(|c| c.compartment_no.as_str()).collect();
    let mut rejections: Vec<String> = Vec::new();
    if body.label.trim().is_empty() {
        rejections.push("the log carries no label".to_owned());
    }
    if body.rows.is_empty() {
        rejections.push("the log carries no rows".to_owned());
    }
    for (n, row) in body.rows.iter().enumerate() {
        let line = n + 1;
        if row.label.trim().is_empty() {
            rejections.push(format!("line {line}: no label"));
        }
        if !known.contains(row.compartment.trim()) {
            rejections.push(format!(
                "line {line}: {} is not on this hull's register",
                row.compartment.trim()
            ));
        }
        if row.since_ms.is_some_and(|s| s > now_ms) {
            rejections.push(format!("line {line}: raised in the future"));
        }
    }
    if rejections.len() > 12 {
        rejections.truncate(12);
        rejections.push("…".to_owned());
    }
    rejections
}

/// Raises one logged row and ledgers it as `HAZARD_RAISED`, naming the log
/// it came from so the entry reads the same as a raise made by hand.
async fn raise_logged_row(
    state: &AppState,
    scope: &wadl_store::TenantScope,
    vessel: VesselId,
    log_label: &str,
    row: &HazardLogRow,
    now_ms: i64,
) -> Result<wadl_engine::Hazard, ApiError> {
    let compartment = row.compartment.trim();
    let label = row.label.trim();
    let since_ms = row.since_ms.unwrap_or(now_ms);
    let hazard = state
        .store
        .raise_hazard(scope, vessel, compartment, row.kind, since_ms, label)
        .await?;
    let detail = json!({
        "compartment": compartment,
        "kind": row.kind,
        "label": label,
        "since_ms": since_ms,
        "raised_by_org": scope.org.to_string(),
        "from_log": log_label,
        "at_ms": now_ms,
    });
    let detail = serde_json::to_string(&detail).unwrap_or_default();
    state
        .store
        .append_audit(
            scope,
            vessel,
            "HAZARD_RAISED",
            &detail,
            Some(compartment),
            now_ms,
        )
        .await?;
    Ok(hazard)
}

/// Raises the field conditions in a hazard log that are not already live.
///
/// The same validation as a single raise, applied to the whole file before
/// any row lands: an unknown space, an empty label or a future instant
/// refuses the log whole. A row whose fact is already live is skipped, not
/// refused — the morning log lists what is open, and most of it was open
/// yesterday too. `?dry_run=true` answers with what would be raised and what
/// is already live, storing nothing. Each raise lands as `HAZARD_RAISED`,
/// and the commit as one `HAZARD_LOG_IMPORTED` with the counts.
pub(crate) async fn import_hazard_log(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
    Query(dry): Query<DryRun>,
    req: axum::extract::Request,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    state.store.get_vessel(&scope, vessel).await?;
    let body: ImportHazardLog = read_import_body(req).await?;
    let now = state.clock.now();
    let now_ms = now.epoch_millis();

    let register = state.store.list_compartments(&scope, vessel).await?;
    let rejections = hazard_log_rejections(&body, &register, now_ms);
    if !rejections.is_empty() {
        return Err(ApiError::OutOfRange(format!(
            "the log was refused whole: {}",
            rejections.join("; ")
        )));
    }

    let live = state.store.live_hazards(&scope, vessel, now).await?;
    let is_live = |row: &HazardLogRow| {
        live.iter()
            .any(|h| h.origin.as_str() == row.compartment.trim() && h.kind == row.kind)
    };
    let mut seen = std::collections::BTreeSet::new();
    let mut would_raise: Vec<&HazardLogRow> = Vec::new();
    let mut already_live: Vec<Value> = Vec::new();
    for row in &body.rows {
        let key = (
            row.compartment.trim().to_owned(),
            json!(row.kind).to_string(),
        );
        if is_live(row) || !seen.insert(key) {
            already_live.push(json!({ "compartment": row.compartment.trim(), "kind": row.kind }));
        } else {
            would_raise.push(row);
        }
    }
    let preview: Vec<Value> = would_raise
        .iter()
        .map(|r| json!({ "compartment": r.compartment.trim(), "kind": r.kind, "label": r.label.trim() }))
        .collect();
    if dry.dry_run.unwrap_or(false) {
        return Ok(Json(json!({
            "stored": false,
            "label": body.label,
            "rows": body.rows.len(),
            "would_raise": preview,
            "already_live": already_live,
        })));
    }

    let mut raised = Vec::with_capacity(would_raise.len());
    for row in would_raise {
        raised.push(raise_logged_row(&state, &scope, vessel, &body.label, row, now_ms).await?);
    }
    let summary = json!({
        "label": body.label,
        "raised": raised.len(),
        "already_live": already_live.len(),
        "by_org": scope.org.to_string(),
        "at_ms": now_ms,
    });
    let summary = serde_json::to_string(&summary).unwrap_or_default();
    state
        .store
        .append_audit(
            &scope,
            vessel,
            "HAZARD_LOG_IMPORTED",
            &summary,
            None,
            now_ms,
        )
        .await?;
    Ok(Json(json!({
        "stored": true,
        "label": body.label,
        "rows": body.rows.len(),
        "raised": raised,
        "already_live": already_live,
    })))
}

/// A schedule change proposal, as posted: the activity, the window the
/// planner proposes (absent for a hold pending verification), and why.
#[derive(Debug, serde::Deserialize)]
pub(crate) struct ProposalBody {
    /// The activity code, as the schedule of record spells it.
    activity: String,
    /// The proposed start, epoch ms.
    #[serde(default)]
    start_ms: Option<i64>,
    /// The proposed finish, epoch ms.
    #[serde(default)]
    end_ms: Option<i64>,
    /// `engine_window` (the engine's own alternative), `manual` (a planner's
    /// window, engine-checked), or `hold_pending_verification` (no date can
    /// honestly be promised; the proposal is the hold).
    #[serde(default)]
    kind: Option<String>,
    /// Why — pressed for; a proposal without a reason is refused.
    #[serde(default)]
    reason: String,
    /// The instant the board was read at.
    #[serde(default)]
    as_of: Option<i64>,
}

/// Day-granular window equality: P6 carries times, a planner reads dates,
/// and "reflected" means the export moved the work to the proposed days.
fn same_days(a: &Value, b: Option<wadl_domain::time::Window>) -> bool {
    const DAY: i64 = 86_400_000;
    let (Some(a_start), Some(a_end), Some(b)) = (
        a.get("start").and_then(Value::as_i64),
        a.get("end").and_then(Value::as_i64),
        b,
    ) else {
        return false;
    };
    a_start.div_euclid(DAY) == b.start.epoch_millis().div_euclid(DAY)
        && a_end.div_euclid(DAY) == b.end.epoch_millis().div_euclid(DAY)
}

/// Where a proposal stands, derived on every read from the ledger and the
/// schedule currently served — never stored, so the past does not change
/// because somebody acted in the present:
/// `open` (the activity still sits where it was), `reflected` (the served
/// schedule now carries the proposed days — P6 took it), `superseded` (the
/// activity moved, but not to the proposal), `dropped` (the activity is no
/// longer on the register), `withdrawn` (a later ledger entry took it back).
fn proposal_status(
    detail: &Value,
    current: Option<&wadl_store::model::ActivitySummary>,
    withdrawn: bool,
) -> &'static str {
    if withdrawn {
        return "withdrawn";
    }
    let Some(a) = current else {
        return "dropped";
    };
    let to = &detail["to"];
    if !to.is_null() && same_days(to, a.planned) {
        return "reflected";
    }
    if same_days(&detail["from"], a.planned) {
        "open"
    } else {
        "superseded"
    }
}

/// The proposals in the ledger, joined to the schedule currently served.
/// Newest first, with the withdrawals folded in as status.
async fn proposal_rows(
    state: &AppState,
    scope: &wadl_store::TenantScope,
    vessel: VesselId,
    current: &[wadl_store::model::ActivitySummary],
) -> Result<Vec<Value>, ApiError> {
    let ledger = state.store.list_audit(scope, vessel, None).await?;
    let by_code: std::collections::BTreeMap<&str, &wadl_store::model::ActivitySummary> =
        current.iter().map(|a| (a.code.as_str(), a)).collect();
    let withdrawn: std::collections::BTreeSet<i64> = ledger
        .iter()
        .filter(|r| r.action == "SCHEDULE_CHANGE_WITHDRAWN")
        .filter_map(|r| serde_json::from_str::<Value>(&r.detail).ok())
        .filter_map(|d| d.get("seq").and_then(Value::as_i64))
        .collect();
    Ok(ledger
        .iter()
        .filter(|r| r.action == "SCHEDULE_CHANGE_PROPOSED")
        .filter_map(|r| {
            let detail = serde_json::from_str::<Value>(&r.detail).ok()?;
            let code = detail.get("activity")?.as_str()?.to_owned();
            let status = proposal_status(
                &detail,
                by_code.get(code.as_str()).copied(),
                withdrawn.contains(&r.seq),
            );
            let mut row = detail;
            if let Some(obj) = row.as_object_mut() {
                obj.insert("seq".to_owned(), json!(r.seq));
                obj.insert("entry_hash".to_owned(), json!(r.entry_hash));
                obj.insert("proposed_at_ms".to_owned(), json!(r.occurred_at_ms));
                obj.insert("status".to_owned(), json!(status));
                obj.insert(
                    "planned_now".to_owned(),
                    json!(by_code.get(code.as_str()).and_then(|a| a.planned)),
                );
            }
            Some(row)
        })
        .collect())
}

/// The kind and window a proposal carries, or why it is refused: no reason,
/// a dated kind without both instants, a finish not after its start, a kind
/// the product does not know.
fn proposed_window(
    body: &ProposalBody,
) -> Result<(String, Option<wadl_domain::time::Window>), ApiError> {
    if body.reason.trim().is_empty() {
        return Err(ApiError::OutOfRange(
            "a proposal needs a reason — P6 will be asked to move work on the strength of it"
                .to_owned(),
        ));
    }
    let kind = body.kind.clone().unwrap_or_else(|| {
        if body.start_ms.is_some() {
            "manual".to_owned()
        } else {
            "hold_pending_verification".to_owned()
        }
    });
    let window = match kind.as_str() {
        "hold_pending_verification" => None,
        "engine_window" | "manual" => {
            let (Some(start), Some(end)) = (body.start_ms, body.end_ms) else {
                return Err(ApiError::OutOfRange(format!(
                    "a {kind} proposal needs start_ms and end_ms"
                )));
            };
            if end <= start {
                return Err(ApiError::OutOfRange(
                    "the proposed finish is not after the proposed start".to_owned(),
                ));
            }
            Some(wadl_domain::time::Window::new(
                Timestamp::from_epoch_millis(start),
                Timestamp::from_epoch_millis(end),
            ))
        }
        other => {
            return Err(ApiError::OutOfRange(format!(
                "kind must be engine_window, manual or hold_pending_verification, got {other:?}"
            )))
        }
    };
    Ok((kind, window))
}

/// `POST /api/vessels/:id/schedule-proposals` — records a schedule change
/// proposal: the path from a refusal on this board back to P6.
///
/// Nothing here moves a date. The proposal is checked by the engine over
/// the proposed window under the hazards live at the instant (so a planner
/// never sends P6 a window the hull would refuse without knowing it), its
/// knock-on is read off the schedule's own logic, and the whole record —
/// what was proposed, from where, why, with what verdict — lands in the
/// ledger as `SCHEDULE_CHANGE_PROPOSED`, subject the activity. The export
/// to P6 is built from these rows; the next XER import says which of them
/// P6 reflected.
pub(crate) async fn propose_schedule_change(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
    body: Result<Json<ProposalBody>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    let hull_row = state.store.get_vessel(&scope, vessel).await?;
    let body = match body {
        Ok(Json(body)) => body,
        Err(rejection) => return Err(body_rejection(&rejection)),
    };
    let (kind, window) = proposed_window(&body)?;
    let activities = state.store.list_activities(&scope, vessel).await?;
    let Some(a) = activities.iter().find(|a| a.code == body.activity) else {
        return Err(ApiError::OutOfRange(format!(
            "activity {:?} is not on this hull's schedule of record",
            body.activity
        )));
    };
    let at = AsOf { as_of: body.as_of }.resolve(&state, &hull_row)?;

    // The engine's word on the proposed window, under the hazards live at the
    // instant: a proposal is never sent blind.
    let graph = state.store.adjacency_graph(&scope, vessel).await?;
    let hazards = state.store.live_hazards(&scope, vessel, at).await?;
    let rules = state.store.rules_in_force(&scope, vessel).await?;
    let hull = wadl_issues::Hull {
        graph: &graph,
        rules: &rules,
        hazards: &hazards,
    };
    let verdict =
        window.map(|w| wadl_issues::executability(&hull, a.compartment_no.as_ref(), Some(w)));
    // Knock-on, read finish-to-start off the schedule's own logic.
    let edges = state.store.list_schedule_edges(&scope, vessel).await?;
    let pushes: Vec<&str> = match window {
        Some(w) => edges
            .iter()
            .filter(|e| e.pred_code == a.code)
            .filter_map(|e| {
                let succ = activities.iter().find(|s| s.code == e.succ_code)?;
                (succ.planned?.start < w.end).then_some(e.succ_code.as_str())
            })
            .collect(),
        None => Vec::new(),
    };
    let now_ms = state.clock.now().epoch_millis();
    let detail = json!({
        "activity": a.code,
        "name": a.name,
        "compartment": a.compartment_no,
        "trade": a.trade,
        "from": a.planned,
        "to": window,
        "kind": kind,
        "reason": body.reason.trim(),
        "verdict": verdict,
        "pushes": pushes,
        "knock_on_basis": "finish-to-start, lags not applied",
        "as_of_ms": at.epoch_millis(),
        "proposed_by_org": scope.org.to_string(),
    });
    let detail = serde_json::to_string(&detail).unwrap_or_default();
    let record = state
        .store
        .append_audit(
            &scope,
            vessel,
            "SCHEDULE_CHANGE_PROPOSED",
            &detail,
            Some(&a.code),
            now_ms,
        )
        .await?;
    let rows = proposal_rows(&state, &scope, vessel, &activities).await?;
    let proposal = rows
        .into_iter()
        .find(|r| r["seq"].as_i64() == Some(record.seq))
        .unwrap_or(Value::Null);
    Ok(Json(json!({ "proposal": proposal, "recorded": record })))
}

/// `GET /api/vessels/:id/schedule-proposals` — every proposal in the
/// ledger with where it stands against the schedule currently served.
pub(crate) async fn list_schedule_proposals(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    state.store.get_vessel(&scope, vessel).await?;
    let activities = state.store.list_activities(&scope, vessel).await?;
    let rows = proposal_rows(&state, &scope, vessel, &activities).await?;
    let count = |s: &str| rows.iter().filter(|r| r["status"] == s).count();
    Ok(Json(json!({
        "as_of": state.clock.now(),
        "schedule_source": state.store.schedule_source(&scope, vessel).await?,
        "counts": {
            "open": count("open"),
            "reflected": count("reflected"),
            "superseded": count("superseded"),
            "dropped": count("dropped"),
            "withdrawn": count("withdrawn"),
        },
        "proposals": rows,
        "status_basis": "derived on every read: reflected when the served schedule carries the proposed days; superseded when the activity moved elsewhere; dropped when it left the register; withdrawn by a later ledger entry",
    })))
}

/// A withdrawal, as posted.
#[derive(Debug, serde::Deserialize)]
pub(crate) struct WithdrawBody {
    /// The proposal's ledger sequence.
    seq: i64,
    #[serde(default)]
    reason: String,
}

/// `POST /api/vessels/:id/schedule-proposals/withdraw` — takes a proposal
/// back, as a later ledger entry; the original stays in the chain.
pub(crate) async fn withdraw_schedule_proposal(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
    body: Result<Json<WithdrawBody>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    state.store.get_vessel(&scope, vessel).await?;
    let body = match body {
        Ok(Json(body)) => body,
        Err(rejection) => return Err(body_rejection(&rejection)),
    };
    let ledger = state.store.list_audit(&scope, vessel, None).await?;
    let Some(original) = ledger
        .iter()
        .find(|r| r.seq == body.seq && r.action == "SCHEDULE_CHANGE_PROPOSED")
    else {
        return Err(ApiError::OutOfRange(format!(
            "ledger entry {} is not a schedule change proposal on this hull",
            body.seq
        )));
    };
    let now_ms = state.clock.now().epoch_millis();
    let detail = json!({
        "seq": body.seq,
        "activity": original.subject_ref,
        "reason": body.reason.trim(),
        "withdrawn_by_org": scope.org.to_string(),
    });
    let detail = serde_json::to_string(&detail).unwrap_or_default();
    let record = state
        .store
        .append_audit(
            &scope,
            vessel,
            "SCHEDULE_CHANGE_WITHDRAWN",
            &detail,
            original.subject_ref.as_deref(),
            now_ms,
        )
        .await?;
    Ok(Json(json!({ "withdrawn": body.seq, "recorded": record })))
}

/// The distributed packages on a hull.
pub(crate) async fn list_packages(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let packages = state
        .store
        .list_packages(&scope, VesselId::from_uuid(id))
        .await?;
    Ok(Json(json!(packages)))
}

/// One package: its segment topology, the authorization state of every
/// compartment in its footprint, and the single constraint pacing it.
///
/// This is where the module's two central facts are made visible:
/// authorization state is a **distribution over the footprint**, not a value; and
/// a segment cannot be tested until it *and everything upstream* is complete, so
/// one held compartment strands man-hours it does not contain.
pub(crate) async fn get_package(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path((id, code)): Path<(Uuid, String)>,
    Query(as_of): Query<AsOf>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    let at = as_of.resolve(&state, &state.store.get_vessel(&scope, vessel).await?)?;
    let package = state.store.get_package(&scope, vessel, &code).await?;
    let analysis = package.analyse();

    // The engine's inputs, loaded once for the whole footprint.
    let graph = state.store.adjacency_graph(&scope, vessel).await?;
    let hazards = state.store.live_hazards(&scope, vessel, at).await?;
    let rules = state.store.rules_in_force(&scope, vessel).await?;
    let decide_space = |compartment: &CompartmentNo| {
        evaluate(&EvaluationRequest {
            subject: compartment,
            graph: &graph,
            rules: &rules,
            hazards: &hazards,
            at,
        })
    };

    // Authorization as a distribution over the footprint.
    let footprint: Vec<Value> = package
        .spaces
        .iter()
        .map(|(compartment, work)| {
            let decision = decide_space(compartment);
            json!({
                "compartment_no": compartment,
                "budget_hours": work.budget,
                "earned_hours": work.earned,
                "remaining_hours": work.remaining(),
                "complete": work.is_complete(),
                // WHEN this space is touched — its own slice of the package,
                // not the package's whole span. A trunk is worked before the
                // branches hanging off it, so the footprint moves through the
                // hull; a reader deciding whether to plan around this space
                // needs its dates, not the package's.
                "planned": work.window,
                "state": decision.state,
                "permits_work": decision.permits_work(),
                "rules_fired": decision.trace.iter().map(|s| &s.rule_code).collect::<Vec<_>>(),
                "earliest_clear": decision.earliest_clear,
            })
        })
        .collect();

    // The governing constraint needs both halves: the topology (what is held) and
    // the engine (whether anything refuses the work).
    let governing = governing_constraint(&analysis, &|c| Some(decide_space(c)));

    Ok(Json(json!({
        "package": {
            "work_order_id": analysis.work_order_id,
            "code": analysis.code,
            "name": analysis.name,
            "test_verb": analysis.test_verb,
            "budget_hours": analysis.budget,
            "earned_hours": analysis.earned,
            "compartment_count": analysis.compartment_count,
            "open_compartment_count": analysis.open_compartment_count,
            "segment_count": analysis.segment_count,
            "testable_segment_count": analysis.testable_segment_count,
            "total_stranded_hours": analysis.total_stranded(),
        },
        "segments": analysis.segments,
        "footprint": footprint,
        "stranding": analysis.stranding,
        "governing": governing,
        // Empty for well-formed data; a named fault beats a silent wrong answer.
        "faults": analysis.faults,
    })))
}

/// Shared evaluation path: assembles the engine's inputs for one compartment.
async fn decide(
    state: &AppState,
    scope: &wadl_store::TenantScope,
    vessel: VesselId,
    compartment: &str,
    at: Timestamp,
) -> Result<Decision, ApiError> {
    // Scope is enforced by each store call; the first failure short-circuits.
    let graph = state.store.adjacency_graph(scope, vessel).await?;
    let hazards = state.store.live_hazards(scope, vessel, at).await?;
    let rules = state.store.rules_in_force(scope, vessel).await?;
    let subject = CompartmentNo::new(compartment);
    Ok(evaluate(&EvaluationRequest {
        subject: &subject,
        graph: &graph,
        rules: &rules,
        hazards: &hazards,
        at,
    }))
}

/// `GET /api/whoami` — the caller's resolved identity, as the server sees it.
///
/// Serves the outcome of the trust boundary rather than echoing headers: the
/// tenant and hull assignments that every scoped query will actually run
/// under, plus which identity mode admitted them. The shell uses this to show
/// doors a caller can open instead of doors that exist (least privilege made
/// visible), and an operator uses it to verify a proxy configuration end to
/// end with one curl.
pub(crate) async fn whoami(Caller(scope): Caller) -> Json<Value> {
    Json(json!({
        "org": scope.org.to_string(),
        "assigned_vessels": scope
            .assigned_vessels
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>(),
        "identity_mode": crate::auth::identity_mode(),
        "decision_support_only": true,
    }))
}

/// How a scheduled activity participates in a work-on-work conflict, judged
/// from its trade and name. `None` = neither class.
///
/// This is a TRADE-CLASS HEURISTIC and says so on the wire: the authoritative
/// refusal machinery is the rules engine over recorded hazards, and it stays
/// so. What this classifier adds is the earlier warning — two activities the
/// SCHEDULE already plans into each other (hot work while flammables flow a
/// space away) before either becomes a recorded hazard. The word lists are
/// deliberately small and visible here; a yard tunes them as data when this
/// leaves the demo.
fn work_class(trade: &str, name: &str) -> Option<&'static str> {
    let t = trade.to_lowercase();
    let n = name.to_lowercase();
    let hot = ["weld", "burn", "hot work", "torch", "braz"];
    if hot.iter().any(|w| t.contains(w) || n.contains(w)) {
        return Some("hot");
    }
    let flam = [
        "preserv",
        "coat",
        "paint",
        "solvent",
        "flush",
        "fuel",
        "flammable",
        "lagging",
    ];
    if flam.iter().any(|w| t.contains(w) || n.contains(w)) {
        return Some("flammable");
    }
    None
}

/// `GET /api/vessels/:id/work-conflicts` — scheduled work colliding with
/// scheduled work on the DAY containing the reading instant.
///
/// A conflict pair is a hot-class activity and a flammable-class activity
/// booked the same day in the same compartment, or in compartments the
/// adjacency graph couples — because on a ship the flame and the vapour do
/// not need to share a room, only a vent trunk, a penetration, or a bulkhead.
/// Undated activities count (the product's standing convention: undated work
/// rides every instant), and the response's `basis` says everything above so
/// no screen has to re-explain it.
pub(crate) async fn work_conflicts(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
    Query(as_of): Query<AsOf>,
) -> Result<Json<Value>, ApiError> {
    const DAY_MS: i64 = 86_400_000;
    const PAIR_CAP: usize = 200;
    let vessel = VesselId::from_uuid(id);
    let at = as_of.resolve(&state, &state.store.get_vessel(&scope, vessel).await?)?;
    let activities = state.store.list_activities(&scope, vessel).await?;
    let graph = state.store.adjacency_graph(&scope, vessel).await?;

    let d0 = at.epoch_millis().div_euclid(DAY_MS) * DAY_MS;
    let d1 = d0 + DAY_MS;
    let in_day = |a: &wadl_store::model::ActivitySummary| {
        a.planned
            .is_none_or(|w| w.start.epoch_millis() < d1 && d0 < w.end.epoch_millis())
    };

    // The day's classed, located, unfinished work.
    let mut hot: Vec<(&str, String, &wadl_store::model::ActivitySummary)> = Vec::new();
    let mut flam: Vec<(&str, String, &wadl_store::model::ActivitySummary)> = Vec::new();
    let mut scanned = 0usize;
    for a in &activities {
        let Some(space) = a.compartment_no.as_ref() else {
            continue;
        };
        if a.is_milestone || a.status == wadl_store::model::ActivityStatus::Complete || !in_day(a) {
            continue;
        }
        scanned += 1;
        match work_class(&a.trade, &a.name) {
            Some("hot") => hot.push(("hot", space.as_str().to_owned(), a)),
            Some("flammable") => flam.push(("flammable", space.as_str().to_owned(), a)),
            _ => {}
        }
    }

    // Coupled lookup: either direction, with the coupling code that carries it.
    let coupled = |x: &str, y: &str| -> Option<String> {
        graph.edges().find_map(|e| {
            let hit = (e.from.as_str() == x && e.to.as_str() == y)
                || (e.from.as_str() == y && e.to.as_str() == x);
            hit.then(|| e.code.as_str().to_owned())
        })
    };

    let mut pairs: Vec<Value> = Vec::new();
    let mut dropped = 0usize;
    for (_, h_space, h) in &hot {
        for (_, f_space, f) in &flam {
            let via = if h_space == f_space {
                Some("same space".to_owned())
            } else {
                coupled(h_space, f_space)
            };
            let Some(via) = via else { continue };
            if pairs.len() >= PAIR_CAP {
                dropped += 1;
                continue;
            }
            let where_txt = if via == "same space" {
                format!("both in {h_space}")
            } else {
                format!(
                    "{h_space} and {f_space}, coupled by a {}",
                    via.replace('_', " ")
                )
            };
            pairs.push(json!({
                "hot": { "code": h.code, "name": h.name, "space": h_space, "trade": h.trade },
                "flammable": { "code": f.code, "name": f.name, "space": f_space, "trade": f.trade },
                "via": via,
                "reason": format!(
                    "{} ({}) and {} ({}) are booked the same day — {}. Flame and vapour need only a path, not a shared room.",
                    h.code, h.trade, f.code, f.trade, where_txt
                ),
            }));
        }
    }

    Ok(Json(json!({
        "day": { "start": d0, "end": d1 },
        "pairs": pairs,
        "dropped": dropped,
        "scanned": scanned,
        "basis": "Trade-class heuristic over the schedule of record: hot-class work (weld/burn/hot work/torch/braze) against flammable-class work (preservation/coating/paint/solvent/flush/fuel/lagging), booked the same day, in the same space or spaces the adjacency graph couples. Undated work counts at every instant. An early warning from the schedule — the rules engine over recorded hazards remains the refusal authority.",
    })))
}
