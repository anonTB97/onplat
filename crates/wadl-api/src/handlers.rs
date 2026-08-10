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

/// The `?as_of=` parameter: the instant the caller wants the answer for.
///
/// Epoch milliseconds, matching how [`Timestamp`] already crosses the wire, so a
/// value read out of one response can be handed straight back in the next.
#[derive(Debug, Clone, Copy, Default, serde::Deserialize)]
pub(crate) struct AsOf {
    as_of: Option<i64>,
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
    let compartments = state
        .store
        .list_compartments(&scope, VesselId::from_uuid(id))
        .await?;
    Ok(Json(json!(compartments)))
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
    let compartments = state.store.list_compartments(&scope, vessel).await?;
    let graph = state.store.adjacency_graph(&scope, vessel).await?;
    let hazards = state.store.live_hazards(&scope, vessel).await?;
    let rules = state.store.rules_in_force(&scope, vessel).await?;
    let orders = state.store.list_work_orders(&scope, vessel).await?;
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
    let hazards = state.store.live_hazards(&scope, vessel).await?;
    let rules = state.store.rules_in_force(&scope, vessel).await?;
    let orders = state.store.list_work_orders(&scope, vessel).await?;
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

    Ok(Json(json!(roll_up(&spaces, unattributed))))
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
    let hazards = state.store.live_hazards(&scope, vessel).await?;
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
    let hazards = state.store.live_hazards(scope, vessel).await?;
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
