//! Zone focus: a zone's next-door spaces are served once, with the reason
//! each one counts — across the frame boundary, on the deck above or below,
//! or coupled in — so a zone-focused screen can blot out the rest of the
//! hull and still show what is about to reach in.

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

fn app() -> (axum::Router, DemoWorld) {
    let (store, world) = InMemoryStore::demo_at(Timestamp::from_epoch_millis(DEMO_ANCHOR_MS));
    let clock = TestClock::new(Timestamp::from_epoch_millis(DEMO_ANCHOR_MS));
    let state = wadl_api::AppState::new(Arc::new(store), Arc::new(clock));
    (wadl_api::build_router(state), world)
}

async fn get(app: &axum::Router, world: &DemoWorld, path: &str) -> (StatusCode, Value) {
    let request = Request::builder()
        .uri(format!("/api/vessels/{}{path}", world.cvn73.as_uuid()))
        .header("x-org-id", world.yard_org.as_uuid().to_string())
        .header("x-assigned-vessels", world.cvn73.as_uuid().to_string())
        .body(Body::empty())
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

#[tokio::test]
async fn next_door_to_a_zone_says_why_and_what_state_it_is_in() {
    let (app, w) = app();
    let (status, body) = get(&app, &w, "/zones/Z6/adjacent").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["zone"], "Z6");
    let inside: Vec<&str> = body["inside"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert!(inside.contains(&"3-160-2-Q"), "{inside:?}");

    let adjacent = body["adjacent"].as_array().unwrap();
    // Nothing inside the zone is also next door to it.
    assert!(adjacent
        .iter()
        .all(|a| !inside.contains(&a["compartment"].as_str().unwrap())));
    // The switchgear room at Fr 148 on the third deck is next door to the
    // zone's Fr 152 trunk on the same deck, and coupled into it by the seeded
    // bus and bulkhead — both reasons are named, and its live bus shows.
    let sg = adjacent
        .iter()
        .find(|a| a["compartment"] == "3-148-2-E")
        .unwrap_or_else(|| panic!("3-148-2-E is next door to Z6: {adjacent:?}"));
    let via: Vec<&str> = sg["via"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert!(via.contains(&"frame_boundary"), "{via:?}");
    assert!(
        sg["hazards"]
            .as_array()
            .unwrap()
            .iter()
            .any(|h| h["kind"] == "energised_bus"),
        "{sg}"
    );
    assert!(sg["state"].is_string() && sg["permits_work"].is_boolean());
    // Worst first: anything that refuses work sorts before anything that permits it.
    let refusing_first = adjacent
        .iter()
        .map(|a| a["permits_work"].as_bool().unwrap())
        .collect::<Vec<_>>();
    let mut sorted = refusing_first.clone();
    sorted.sort_unstable();
    assert_eq!(refusing_first, sorted);
    assert!(body["basis"].as_str().unwrap().contains("8 frames"));
}

/// The reference hull, loaded through the doors: zone blocks stacked on
/// decks and couplings that cross zone boundaries, which the seed lacks.
async fn reference_app() -> (axum::Router, DemoWorld) {
    let (store, world) = InMemoryStore::demo_at(Timestamp::from_epoch_millis(DEMO_ANCHOR_MS));
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../reference/cvn73");
    wadl_api::documents::load_demo_docs(
        &store,
        &world.yard_scope(),
        world.cvn73,
        &dir,
        DEMO_ANCHOR_MS,
    )
    .await
    .expect("the reference hull loads");
    let clock = TestClock::new(Timestamp::from_epoch_millis(DEMO_ANCHOR_MS));
    let state = wadl_api::AppState::new(Arc::new(store), Arc::new(clock));
    (wadl_api::build_router(state), world)
}

#[tokio::test]
async fn on_the_reference_hull_the_plant_has_neighbours_above_below_and_coupled_in() {
    let (app, w) = reference_app().await;
    let (status, body) = get(&app, &w, "/zones/Z4/adjacent").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let adjacent = body["adjacent"].as_array().unwrap();
    let reasons: std::collections::BTreeSet<String> = adjacent
        .iter()
        .flat_map(|a| a["via"].as_array().unwrap().iter())
        .map(|v| v.as_str().unwrap().split(':').next().unwrap().to_owned())
        .collect();
    // Z4 is a block of decks amidships: the hangar sits above it, the tanks
    // below it, Z3 and Z5 either side of it, and the switchgear buses and
    // bulkheads reach out of it.
    for r in ["frame_boundary", "deck_above", "deck_below", "coupled"] {
        assert!(reasons.contains(r), "{reasons:?}");
    }
    assert!(adjacent.iter().all(|a| a["zone"] != "Z4"));
    assert!(
        adjacent.iter().any(|a| a["zone"] == "Z2"),
        "the hangar is next door above"
    );
    assert!(
        adjacent.iter().any(|a| a["zone"] == "Z6"),
        "the tanks are next door below"
    );
}

#[tokio::test]
async fn a_zone_the_register_does_not_carry_is_not_found() {
    let (app, w) = app();
    let (status, _) = get(&app, &w, "/zones/Z99/adjacent").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
