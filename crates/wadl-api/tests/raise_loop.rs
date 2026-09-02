//! Raising a field condition through the product.
//!
//! Until this route the engine's hazards entered only as seed data. Now the
//! day's tag-out, coating ticket or hot-work permit is posted against a
//! space the hull knows, lands in the ledger as `HAZARD_RAISED`, and every
//! verdict it drives re-derives on the next read — the same loop as the
//! clearance, run forwards.

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

/// A seeded space with nothing held in it at the anchor.
const QUIET_SPACE: &str = "2-152-0-Q";

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

async fn state_of(app: &axum::Router, world: &DemoWorld, space: &str) -> String {
    let (status, board) = call(
        app,
        world,
        "GET",
        &format!("/api/vessels/{}/deck-states", hull(world)),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    board
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["compartment"]["compartment_no"] == space)
        .map(|r| r["state"].as_str().unwrap().to_owned())
        .expect("the space is on the board")
}

/// An open coating ticket holds its own space (R03, same space) — the kind
/// whose effect is visible on the origin, which is what makes it the right
/// fact to raise here. (Hot work reaches coupled spaces, not its own.)
#[tokio::test]
async fn raising_a_coating_ticket_holds_the_space_and_lands_in_the_ledger() {
    let (app, world) = app_at_anchor();
    assert_eq!(state_of(&app, &world, QUIET_SPACE).await, "ALLOW");

    let (status, body) = call(
        &app,
        &world,
        "POST",
        &format!("/api/vessels/{}/hazards", hull(&world)),
        Some(&format!(
            r#"{{"compartment":"{QUIET_SPACE}","kind":"coating_open","label":"CT-2152-1 · primer, curing on the scullery deck"}}"#
        )),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["hazard"]["origin"], QUIET_SPACE);
    assert_eq!(
        body["hazard"]["since"], DEMO_ANCHOR_MS,
        "defaults to the wall clock"
    );
    assert_eq!(body["recorded"]["action"], "HAZARD_RAISED");

    // The hazard is served, and the space it lives in is no longer open.
    let (_, hazards) = call(
        &app,
        &world,
        "GET",
        &format!("/api/vessels/{}/hazards", hull(&world)),
        None,
    )
    .await;
    assert!(hazards["hazards"]
        .as_array()
        .unwrap()
        .iter()
        .any(|h| h["origin"] == QUIET_SPACE && h["kind"] == "coating_open"));
    assert_eq!(
        state_of(&app, &world, QUIET_SPACE).await,
        "BLOCK",
        "a curing coat refuses its own space"
    );

    // The ledger carries the raise, with the label in its hashed detail.
    let (_, ledger) = call(
        &app,
        &world,
        "GET",
        &format!("/api/vessels/{}/ledger", hull(&world)),
        None,
    )
    .await;
    let entries = ledger["entries"].as_array().unwrap();
    let raised = entries
        .iter()
        .find(|e| e["action"] == "HAZARD_RAISED")
        .expect("a HAZARD_RAISED entry");
    assert!(raised["detail"].as_str().unwrap().contains("CT-2152-1"));
    assert_eq!(ledger["verified"], true);
}

#[tokio::test]
async fn one_fact_once_and_only_against_the_register() {
    let (app, world) = app_at_anchor();
    let path = format!("/api/vessels/{}/hazards", hull(&world));

    // A space the hull does not know is a typo, not a fact.
    let (status, body) = call(
        &app,
        &world,
        "POST",
        &path,
        Some(r#"{"compartment":"9-999-9-Z","kind":"stop_work","label":"nowhere"}"#),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");

    // No label, no fact.
    let (status, _) = call(
        &app,
        &world,
        "POST",
        &path,
        Some(&format!(
            r#"{{"compartment":"{QUIET_SPACE}","kind":"stop_work","label":"  "}}"#
        )),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    // The future is not a fact yet.
    let future = DEMO_ANCHOR_MS + 60_000;
    let (status, _) = call(
        &app,
        &world,
        "POST",
        &path,
        Some(&format!(
            r#"{{"compartment":"{QUIET_SPACE}","kind":"stop_work","label":"later","since_ms":{future}}}"#
        )),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    // Raise once, then again: the second is refused, the first still stands.
    let body = format!(
        r#"{{"compartment":"{QUIET_SPACE}","kind":"stop_work","label":"SW-14 · inspector's stop-work"}}"#
    );
    let (status, _) = call(&app, &world, "POST", &path, Some(&body)).await;
    assert_eq!(status, StatusCode::OK);
    let (status, again) = call(&app, &world, "POST", &path, Some(&body)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(again["detail"].as_str().unwrap().contains("already live"));

    // And the clear loop closes what the raise opened.
    let (status, cleared) = call(
        &app,
        &world,
        "POST",
        &format!("/api/vessels/{}/hazards/clear", hull(&world)),
        Some(&format!(
            r#"{{"compartment":"{QUIET_SPACE}","kind":"stop_work","basis":"inspector released it in writing"}}"#
        )),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{cleared}");
    assert_eq!(
        cleared["cleared"][0]["label"],
        "SW-14 · inspector's stop-work"
    );
}
