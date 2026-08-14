//! The clear loop, end to end — requirements VR-05/06/07 and defect DEF-1
//! from `docs/requirements-vince-2026-08-14.md`.
//!
//! The scenario is the one from the 2026-08-14 expert session, on the seeded
//! facts it happened over: bus 3-SG-2 is energised in `3-148-2-E` with no
//! verified zero-energy state, and it holds work in the origin space and in
//! coupled spaces alike. The crew reports the tags hung; the manager records
//! an administrative clearance; and everything that hazard was refusing must
//! re-derive clean on the next read — the demo moment where the space stayed
//! red is exactly what these tests make impossible to regress into.

#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::Value;
use tower::ServiceExt;
use wadl_domain::time::{TestClock, Timestamp};
use wadl_store::memory::{DemoWorld, InMemoryStore, DEMO_ANCHOR_MS};

/// The seeded scenario: the energised bus and where it lives.
const BUS_SPACE: &str = "3-148-2-E";
const BUS_LABEL: &str = "Bus 3-SG-2 energised — no verified zero-energy state";

fn app_at_anchor() -> (axum::Router, DemoWorld) {
    let (store, world) = InMemoryStore::demo_at(Timestamp::from_epoch_millis(DEMO_ANCHOR_MS));
    let clock = TestClock::new(Timestamp::from_epoch_millis(DEMO_ANCHOR_MS));
    let state = wadl_api::AppState::new(Arc::new(store), Arc::new(clock));
    (wadl_api::build_router(state), world)
}

async fn call(
    app: &axum::Router,
    world: &DemoWorld,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header("x-org-id", world.yard_org.as_uuid().to_string())
        .header("x-assigned-vessels", world.cvn73.as_uuid().to_string())
        .header("content-type", "application/json")
        .body(body.map_or_else(Body::empty, |b| Body::from(b.to_owned())))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 22)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn hull(world: &DemoWorld) -> String {
    world.cvn73.as_uuid().to_string()
}

/// The spaces a hazard is currently refusing: every deck-state row whose
/// decision trace carries the hazard's label. Read through the same endpoints
/// the shell reads, so the assertion is about what a planner would see.
async fn spaces_held_by(app: &axum::Router, world: &DemoWorld, label: &str) -> Vec<String> {
    let (status, states) = call(
        app,
        world,
        "GET",
        &format!("/api/vessels/{}/deck-states", hull(world)),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let mut held = Vec::new();
    for row in states.as_array().unwrap() {
        let no = row["compartment"]["compartment_no"].as_str().unwrap();
        let (status, state) = call(
            app,
            world,
            "GET",
            &format!("/api/vessels/{}/compartments/{no}/state", hull(world)),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let trace = state["decision"]["trace"].as_array().unwrap();
        if trace.iter().any(|s| s["hazard"] == label) {
            held.push(no.to_owned());
        }
    }
    held
}

/// DEF-1 + VR-05 + VR-06: the clearance is recorded once, with its basis, and
/// every space the hazard was refusing — origin and coupled alike — re-derives
/// clean on the next read.
#[tokio::test]
async fn clearing_the_bus_flips_every_space_it_held() {
    let (app, world) = app_at_anchor();

    // Before: the bus is served as a live hazard…
    let (status, hazards) = call(
        &app,
        &world,
        "GET",
        &format!("/api/vessels/{}/hazards", hull(&world)),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        hazards["hazards"]
            .as_array()
            .unwrap()
            .iter()
            .any(|h| h["origin"] == BUS_SPACE && h["kind"] == "energised_bus"),
        "the seeded bus must be served live before the clearance: {hazards}"
    );

    // …and it is genuinely holding work. (The bus's rules bind same-space;
    // the cross-space half of the cascade is proven on the coating ticket in
    // its own test below.)
    let held_before = spaces_held_by(&app, &world, BUS_LABEL).await;
    assert!(
        held_before.contains(&BUS_SPACE.to_owned()),
        "the origin space must be held by its own bus, got {held_before:?}"
    );

    // The clearance: tags verified hung, recorded with its basis.
    let (status, cleared) = call(
        &app,
        &world,
        "POST",
        &format!("/api/vessels/{}/hazards/clear", hull(&world)),
        Some(
            r#"{"compartment":"3-148-2-E","kind":"energised_bus",
                "basis":"tag-out log verified; tags hung and second-checked by shift electrician"}"#,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "clearance refused: {cleared}");
    assert_eq!(cleared["cleared"].as_array().unwrap().len(), 1);
    assert_eq!(cleared["cleared"][0]["label"], BUS_LABEL);
    assert!(
        cleared["recorded"]["entry_hash"].is_string() && cleared["recorded"]["seq"].is_number(),
        "the clearance must return its chained ledger entry: {cleared}"
    );

    // After: no space anywhere is held by the bus — the whole set flipped.
    let held_after = spaces_held_by(&app, &world, BUS_LABEL).await;
    assert!(
        held_after.is_empty(),
        "cleared, yet still refusing {held_after:?} — this is DEF-1"
    );

    // The hazard has left the live list (closed, not deleted — the record is
    // the ledger's), and the ledger carries the clearance with its basis
    // under the space's own subject key.
    let (_, hazards) = call(
        &app,
        &world,
        "GET",
        &format!("/api/vessels/{}/hazards", hull(&world)),
        None,
    )
    .await;
    assert!(
        !hazards["hazards"]
            .as_array()
            .unwrap()
            .iter()
            .any(|h| h["origin"] == BUS_SPACE),
        "a cleared hazard must not be served live: {hazards}"
    );
    let (status, ledger) = call(
        &app,
        &world,
        "GET",
        &format!("/api/vessels/{}/ledger", hull(&world)),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(ledger["verified"].as_bool().unwrap(), "chain must verify");
    let entry = ledger["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["action"] == "HAZARD_CLEARED")
        .expect("the clearance must be in the ledger");
    assert_eq!(entry["subject_ref"], BUS_SPACE);
    assert!(
        entry["detail"].as_str().unwrap().contains("second-checked"),
        "the basis must be inside the hashed detail: {entry}"
    );

    // A second clearance of the same fact records nothing: the first one
    // closed it, and restamping history is exactly what closure forbids.
    let (status, again) = call(
        &app,
        &world,
        "POST",
        &format!("/api/vessels/{}/hazards/clear", hull(&world)),
        Some(r#"{"compartment":"3-148-2-E","kind":"energised_bus","basis":"double click"}"#),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "an already-cleared hazard must refuse, not silently re-clear: {again}"
    );
}

/// VR-05's guard: a clearance without its basis is a silent delete, and the
/// door refuses it before anything is written.
#[tokio::test]
async fn a_clearance_without_a_basis_is_refused() {
    let (app, world) = app_at_anchor();
    let (status, body) = call(
        &app,
        &world,
        "POST",
        &format!("/api/vessels/{}/hazards/clear", hull(&world)),
        Some(r#"{"compartment":"3-148-2-E","kind":"energised_bus","basis":"  "}"#),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");

    // And nothing was cleared by the refused call.
    let (_, hazards) = call(
        &app,
        &world,
        "GET",
        &format!("/api/vessels/{}/hazards", hull(&world)),
        None,
    )
    .await;
    assert_eq!(hazards["hazards"].as_array().unwrap().len(), 2);
}

/// The coating ticket keeps the two hazard kinds honest side by side: clearing
/// the bus must not touch the coat, and the coat clears by its own kind+space
/// key independently.
#[tokio::test]
async fn clearances_are_per_fact_not_per_hull() {
    let (app, world) = app_at_anchor();
    let (status, _) = call(
        &app,
        &world,
        "POST",
        &format!("/api/vessels/{}/hazards/clear", hull(&world)),
        Some(r#"{"compartment":"3-148-2-E","kind":"energised_bus","basis":"tags verified"}"#),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (_, hazards) = call(
        &app,
        &world,
        "GET",
        &format!("/api/vessels/{}/hazards", hull(&world)),
        None,
    )
    .await;
    let left = hazards["hazards"].as_array().unwrap();
    assert_eq!(left.len(), 1, "only the bus was cleared: {hazards}");
    assert_eq!(left[0]["kind"], "coating_open");

    // The wrong kind against a real space refuses: the key is the fact, not
    // the address.
    let (status, body) = call(
        &app,
        &world,
        "POST",
        &format!("/api/vessels/{}/hazards/clear", hull(&world)),
        Some(r#"{"compartment":"3-160-2-Q","kind":"hot_work_live","basis":"tags verified"}"#),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
}

/// VR-06's cross-space half, on the hazard that propagates: the curing coat in
/// `3-160-2-Q` reaches other spaces through the coupling graph (the deck
/// above, the shared trunk). Clearing the ONE fact must open ALL of them —
/// "when we clear that red X, does that clear all the other red?"
#[tokio::test]
async fn clearing_the_coat_opens_every_coupled_space() {
    const COAT_SPACE: &str = "3-160-2-Q";
    const COAT_LABEL: &str = "CT-3160-4 · final coat, curing";

    let (app, world) = app_at_anchor();
    let held_before = spaces_held_by(&app, &world, COAT_LABEL).await;
    assert!(
        held_before.len() >= 2,
        "the coat is seeded to reach beyond its own space, got {held_before:?}"
    );

    let (status, cleared) = call(
        &app,
        &world,
        "POST",
        &format!("/api/vessels/{}/hazards/clear", hull(&world)),
        Some(
            r#"{"compartment":"3-160-2-Q","kind":"coating_open",
                "basis":"gas-free certificate sighted; cure verified by coatings inspector"}"#,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "clearance refused: {cleared}");
    assert_eq!(cleared["cleared"][0]["origin"], COAT_SPACE);

    let held_after = spaces_held_by(&app, &world, COAT_LABEL).await;
    assert!(
        held_after.is_empty(),
        "one fact, one clearance, every consequence: still refusing {held_after:?}"
    );
}
