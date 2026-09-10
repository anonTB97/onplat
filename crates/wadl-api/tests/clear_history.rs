//! A clearance has a time of its own — it does not rewrite the past.
//!
//! Clear the energised bus at the clock's instant, then read the hull as of a
//! minute earlier: the bus is still served as a live hazard and the spaces it
//! held are still refused, because at that instant nobody had cleared it yet.
//! Read as of now and it is gone. This is the property the time control is
//! sold on — a board scrubbed back must show what was really held then — and
//! before this test both stores dropped a cleared hazard from every instant.

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

const BUS_SPACE: &str = "3-148-2-E";
const MINUTE_MS: i64 = 60_000;

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

/// Whether the bus is among the hazards served for the hull at `as_of`.
async fn bus_served(app: &axum::Router, world: &DemoWorld, as_of: Option<i64>) -> bool {
    let query = as_of.map_or_else(String::new, |t| format!("?as_of={t}"));
    let (status, body) = call(
        app,
        world,
        "GET",
        &format!("/api/vessels/{}/hazards{query}", hull(world)),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    body["hazards"]
        .as_array()
        .unwrap()
        .iter()
        .any(|h| h["origin"] == BUS_SPACE && h["kind"] == "energised_bus")
}

/// The bus space's authorization state at `as_of`, from the deck board.
async fn bus_state(app: &axum::Router, world: &DemoWorld, as_of: Option<i64>) -> String {
    let query = as_of.map_or_else(String::new, |t| format!("?as_of={t}"));
    let (status, board) = call(
        app,
        world,
        "GET",
        &format!("/api/vessels/{}/deck-states{query}", hull(world)),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    board
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["compartment"]["compartment_no"] == BUS_SPACE)
        .map(|r| r["state"].as_str().unwrap().to_owned())
        .expect("the bus space is on the board")
}

#[tokio::test]
async fn a_clearance_is_visible_only_from_its_own_instant_onward() {
    let (app, world) = app_at_anchor();
    let before = DEMO_ANCHOR_MS - MINUTE_MS;

    // The bus holds its space now and a minute ago alike.
    assert!(bus_served(&app, &world, None).await);
    assert!(bus_served(&app, &world, Some(before)).await);
    let held = bus_state(&app, &world, None).await;
    assert_ne!(held, "ALLOW", "the bus is live");
    assert_eq!(bus_state(&app, &world, Some(before)).await, held);

    // Clear it at the clock's instant (the anchor).
    let (status, _) = call(
        &app,
        &world,
        "POST",
        &format!("/api/vessels/{}/hazards/clear", hull(&world)),
        Some(r#"{"compartment":"3-148-2-E","kind":"energised_bus","basis":"tags hung, zero energy verified by the shift electrician"}"#),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Now: gone, and the space re-derives clean.
    assert!(!bus_served(&app, &world, None).await);
    assert_eq!(bus_state(&app, &world, None).await, "ALLOW");

    // A minute before the clearance: still there, still held. The past did
    // not change because somebody acted in the present.
    assert!(
        bus_served(&app, &world, Some(before)).await,
        "a scrub back past the clearance must still show the hazard"
    );
    assert_eq!(
        bus_state(&app, &world, Some(before)).await,
        held,
        "the hold that was really there is still there at that instant"
    );
}
