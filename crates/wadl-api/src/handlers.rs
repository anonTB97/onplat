//! Request handlers. Thin: they resolve scope, call the store or the engine,
//! and shape the result. No business logic lives here.

use axum::extract::{Path, State};
use axum::Json;
use serde_json::{json, Value};
use uuid::Uuid;

use wadl_domain::compartment::CompartmentNo;
use wadl_domain::ids::VesselId;
use wadl_engine::{evaluate, Decision, EvaluationRequest};

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
    Json(json!(state.store.list_vessels(&scope)))
}

pub(crate) async fn get_vessel(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let vessel = state.store.get_vessel(&scope, VesselId::from_uuid(id))?;
    Ok(Json(json!(vessel)))
}

pub(crate) async fn list_compartments(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let compartments = state
        .store
        .list_compartments(&scope, VesselId::from_uuid(id))?;
    Ok(Json(json!(compartments)))
}

pub(crate) async fn list_work_orders(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let orders = state
        .store
        .list_work_orders(&scope, VesselId::from_uuid(id))?;
    Ok(Json(json!(orders)))
}

pub(crate) async fn stranded_hours(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let report = state
        .store
        .stranded_hours(&scope, VesselId::from_uuid(id))?;
    Ok(Json(json!(report)))
}

/// The hull's decks, ordered downward.
pub(crate) async fn list_decks(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let decks = state.store.list_decks(&scope, VesselId::from_uuid(id))?;
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
    let decision = decide(&state, &scope, vessel, &compartment)?;
    Ok(Json(
        json!({ "compartment": compartment, "decision": decision }),
    ))
}

/// Every compartment on the hull with its current authorization state — the
/// query Deck Explorer draws a deck sheet from.
pub(crate) async fn deck_states(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    let compartments = state.store.list_compartments(&scope, vessel)?;
    let graph = state.store.adjacency_graph(&scope, vessel)?;
    let hazards = state.store.live_hazards(&scope, vessel)?;
    let rules = state.store.rules_in_force(&scope, vessel)?;
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
            json!({
                "compartment": compartment,
                "state": decision.state,
                "permits_work": decision.permits_work(),
                "rules_fired": decision.trace.iter().map(|s| &s.rule_code).collect::<Vec<_>>(),
                "earliest_clear": decision.earliest_clear,
            })
        })
        .collect();
    Ok(Json(json!(rows)))
}

/// Shared evaluation path: assembles the engine's inputs for one compartment.
fn decide(
    state: &AppState,
    scope: &wadl_store::TenantScope,
    vessel: VesselId,
    compartment: &str,
) -> Result<Decision, ApiError> {
    // Scope is enforced by each store call; the first failure short-circuits.
    let graph = state.store.adjacency_graph(scope, vessel)?;
    let hazards = state.store.live_hazards(scope, vessel)?;
    let rules = state.store.rules_in_force(scope, vessel)?;
    let subject = CompartmentNo::new(compartment);
    Ok(evaluate(&EvaluationRequest {
        subject: &subject,
        graph: &graph,
        rules: &rules,
        hazards: &hazards,
        at: state.clock.now(),
    }))
}
