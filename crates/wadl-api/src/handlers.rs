//! Request handlers. Thin: they resolve scope, call the store or the engine,
//! and shape the result. No business logic lives here.

use axum::extract::{Path, State};
use axum::Json;
use serde_json::{json, Value};
use uuid::Uuid;

use wadl_domain::compartment::CompartmentNo;
use wadl_domain::ids::VesselId;
use wadl_engine::{evaluate, AdjacencyGraph, EvaluationRequest};

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

/// Reads a compartment's authorization state **through the engine** — the seam
/// that milestone 3 replaces with the real rule evaluation. The adjacency graph
/// and hazard set are empty in milestone 1 (couplings are not yet seeded in the
/// store), so this returns ALLOW today; the point is that the shell never
/// computes authorization itself.
pub(crate) async fn compartment_state(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path((id, compartment)): Path<(Uuid, String)>,
) -> Result<Json<Value>, ApiError> {
    state.store.get_vessel(&scope, VesselId::from_uuid(id))?;
    let subject = CompartmentNo::new(compartment.clone());
    let graph = AdjacencyGraph::default();
    let request = EvaluationRequest {
        subject: &subject,
        graph: &graph,
        hazards: &[],
        at: state.clock.now(),
    };
    let decision = evaluate(&request);
    Ok(Json(json!({
        "compartment": compartment,
        "state": decision.state,
        "trace_len": decision.trace.len(),
    })))
}
