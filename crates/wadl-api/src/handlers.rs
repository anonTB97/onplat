//! Request handlers. Thin: they resolve scope, call the store or the engine,
//! and shape the result. No business logic lives here.

use axum::extract::{Path, State};
use axum::Json;
use serde_json::{json, Value};
use uuid::Uuid;

use wadl_domain::compartment::CompartmentNo;
use wadl_domain::ids::VesselId;
use wadl_domain::units::ManHours;
use wadl_engine::{evaluate, Decision, EvaluationRequest};
use wadl_plan::governing_constraint;
use wadl_plan::readiness::{roll_up, Readiness, SpaceReadiness};

use crate::auth::Caller;
use crate::error::ApiError;
use crate::AppState;

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

pub(crate) async fn list_work_orders(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let orders = state
        .store
        .list_work_orders(&scope, VesselId::from_uuid(id))
        .await?;
    Ok(Json(json!(orders)))
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
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    let decision = decide(&state, &scope, vessel, &compartment).await?;
    Ok(Json(
        json!({ "compartment": compartment, "decision": decision }),
    ))
}

/// The work booked in one compartment: hours left, the orders, and the trades.
///
/// **One implementation, two callers.** A distributed package books its hours per
/// *segment*, so a compartment inside a package footprint has no work order of
/// its own; the per-compartment package hours come from the stranded report,
/// which derives them from real segment topology. When `deck_states` counted only
/// work orders and `readiness` counted both, the deck plan showed a space as
/// having nothing booked while the ship board billed it as 80 held man-hours.
/// Two readings of "is anyone working here" is not a rounding difference — it is
/// the screen contradicting itself.
struct BookedWork {
    remaining: ManHours,
    stranded_downstream: ManHours,
    order_codes: Vec<String>,
    trades: Vec<String>,
}

fn booked_work(
    compartment: &CompartmentNo,
    orders: &[wadl_store::model::WorkOrderSummary],
    packages: &[wadl_store::model::PackageSummary],
    stranded: &wadl_store::model::StrandedReport,
) -> BookedWork {
    let in_space: Vec<_> = orders
        .iter()
        .filter(|o| &o.compartment_no == compartment)
        .collect();
    let in_packages: Vec<_> = stranded
        .items
        .iter()
        .filter(|i| &i.compartment_no == compartment)
        .collect();

    let mut trades: Vec<String> = in_space.iter().map(|o| o.trade.clone()).collect();
    // A package's trade is the package's own — its owning order is not in the
    // work-order list, so looking there leaves every package space reading "no
    // trade recorded", which is exactly the work the trade lens most needs named.
    for item in &in_packages {
        if let Some(owner) = packages.iter().find(|p| p.code == item.package_code) {
            trades.push(owner.trade.clone());
        }
    }
    trades.sort_unstable();
    trades.dedup();

    let mut order_codes: Vec<String> = in_space.iter().map(|o| o.code.clone()).collect();
    for item in &in_packages {
        order_codes.push(item.package_code.clone());
    }
    order_codes.sort_unstable();
    order_codes.dedup();

    BookedWork {
        remaining: in_space
            .iter()
            .map(|o| o.remaining_hours())
            .chain(in_packages.iter().map(|i| i.own_remaining))
            .fold(ManHours::ZERO, |a, b| a + b),
        stranded_downstream: in_packages
            .iter()
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
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    let compartments = state.store.list_compartments(&scope, vessel).await?;
    let graph = state.store.adjacency_graph(&scope, vessel).await?;
    let hazards = state.store.live_hazards(&scope, vessel).await?;
    let rules = state.store.rules_in_force(&scope, vessel).await?;
    let orders = state.store.list_work_orders(&scope, vessel).await?;
    let packages = state.store.list_packages(&scope, vessel).await?;
    let stranded = state.store.stranded_hours(&scope, vessel).await?;
    let at = state.clock.now();

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
            let work = booked_work(&compartment.compartment_no, &orders, &packages, &stranded);
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
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
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
    // A package's lead trade. Read from the packages, not the work-order list: a
    // distributed package's owning order is not in that list, so looking there
    // leaves every package space reading "no trade recorded" — precisely the
    // spaces the trade lens most needs to name.
    let packages = state.store.list_packages(&scope, vessel).await?;
    let at = state.clock.now();

    // Hours in the hull's work that name a compartment the register does not
    // contain. Handed to the rollup rather than dropped: a footprint authored
    // against the class, a hull delta that removed a space, or a mis-keyed
    // placard all land here, and a board that silently omitted them would
    // under-report what is outstanding.
    let registered: std::collections::BTreeSet<&CompartmentNo> =
        compartments.iter().map(|c| &c.compartment_no).collect();
    let unattributed = stranded
        .items
        .iter()
        .filter(|i| !registered.contains(&i.compartment_no))
        .map(|i| i.own_remaining)
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
            let work = booked_work(&compartment.compartment_no, &orders, &packages, &stranded);

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
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    let package = state.store.get_package(&scope, vessel, &code).await?;
    let analysis = package.analyse();

    // The engine's inputs, loaded once for the whole footprint.
    let graph = state.store.adjacency_graph(&scope, vessel).await?;
    let hazards = state.store.live_hazards(&scope, vessel).await?;
    let rules = state.store.rules_in_force(&scope, vessel).await?;
    let at = state.clock.now();
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
        at: state.clock.now(),
    }))
}
