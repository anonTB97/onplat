//! The activity register endpoint, over the seeded demo hull.
//!
//! The contract pinned here is the A4 derivation as the shell reads it: every
//! row carries an `executability` verdict; an unlocated activity is
//! `unassessable`, never a confident answer; and a refusal's evidence is
//! coherent — the refused instant sits inside the activity's own planned
//! window, and the governing hold names a real place.

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

fn app_at_anchor() -> (axum::Router, DemoWorld) {
    let (store, world) = InMemoryStore::demo_at(Timestamp::from_epoch_millis(DEMO_ANCHOR_MS));
    let clock = TestClock::new(Timestamp::from_epoch_millis(DEMO_ANCHOR_MS));
    let state = wadl_api::AppState::new(Arc::new(store), Arc::new(clock));
    (wadl_api::build_router(state), world)
}

async fn get(app: &axum::Router, world: &DemoWorld, path: &str) -> (StatusCode, Value) {
    let request = Request::builder()
        .method("GET")
        .uri(path)
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
async fn every_activity_carries_an_executability_verdict() {
    let (app, world) = app_at_anchor();
    let (status, body) = get(
        &app,
        &world,
        &format!("/api/vessels/{}/activities", world.cvn73.as_uuid()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let rows = body["activities"].as_array().expect("activities array");
    assert!(!rows.is_empty());

    let mut refused = 0usize;
    let mut unassessable = 0usize;
    for row in rows {
        let verdict = row["executability"]["verdict"]
            .as_str()
            .unwrap_or_else(|| panic!("{}: no verdict", row["code"]));
        match verdict {
            "executable" => {}
            "not_executable" => {
                refused += 1;
                let exec = &row["executability"];
                // The refused instant is inside the activity's own window.
                let at = exec["at"].as_i64().expect("refusal instant");
                let start = row["planned"]["start"].as_i64().expect("dated");
                let end = row["planned"]["end"].as_i64().expect("dated");
                assert!(
                    at >= start && at < end,
                    "{}: refused at {at} outside [{start},{end})",
                    row["code"]
                );
                assert!(
                    !exec["origin"].as_str().unwrap_or_default().is_empty(),
                    "{}: refusal names no origin",
                    row["code"]
                );
                assert!(
                    !exec["hazard"].as_str().unwrap_or_default().is_empty(),
                    "{}: refusal names no hazard",
                    row["code"]
                );
            }
            "unassessable" => {
                unassessable += 1;
                // The only unassessable rows the demo seeds are the unlocated
                // slices — and they must be exactly the rows with no
                // compartment, or the register is guessing somewhere.
                assert!(
                    row["compartment_no"].is_null(),
                    "{}: unassessable but locates {}",
                    row["code"],
                    row["compartment_no"]
                );
                assert_eq!(row["executability"]["reason"], "unlocated");
            }
            other => panic!("{}: unknown verdict {other}", row["code"]),
        }
    }
    assert!(
        unassessable > 0,
        "the demo seeds unlocated slices; none surfaced as unassessable"
    );
    assert!(
        refused > 0,
        "the demo hull carries a verification-gated bus hold; some planned work \
         must be not executable as planned"
    );
}

/// Executability does not move with `as_of`: "as planned" is a property of the
/// plan against the hazards on file, not of where the reader scrubbed the clock.
#[tokio::test]
async fn executability_is_indifferent_to_as_of() {
    let (app, world) = app_at_anchor();
    let base = format!("/api/vessels/{}/activities", world.cvn73.as_uuid());
    let (_, now) = get(&app, &world, &base).await;
    let day = 86_400_000;
    let (_, later) = get(
        &app,
        &world,
        &format!("{base}?as_of={}", DEMO_ANCHOR_MS + 7 * day),
    )
    .await;
    let verdicts = |v: &Value| -> Vec<(String, String)> {
        v["activities"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                (
                    r["code"].as_str().unwrap().to_owned(),
                    r["executability"]["verdict"].as_str().unwrap().to_owned(),
                )
            })
            .collect()
    };
    assert_eq!(verdicts(&now), verdicts(&later));
}
