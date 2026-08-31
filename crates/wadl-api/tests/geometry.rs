//! The geometry-register seam (`docs/geometry-accuracy.md`): surveyed frame
//! extents and deck coverage bands arrive whole or not at all, disagreements
//! with the register are served as findings rather than hidden, and a surveyed
//! space's provenance climbs the ladder — the plan stops drawing a guess.

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
use serde_json::{json, Value};
use tower::ServiceExt;
use wadl_domain::time::{TestClock, Timestamp};
use wadl_store::memory::{DemoWorld, InMemoryStore, DEMO_ANCHOR_MS};

fn app() -> (axum::Router, DemoWorld) {
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
    body: Option<Value>,
) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header("x-org-id", world.yard_org.as_uuid().to_string())
        .header("x-assigned-vessels", world.cvn73.as_uuid().to_string())
        .header("content-type", "application/json")
        .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
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

fn base(world: &DemoWorld) -> String {
    format!("/api/vessels/{}/geometry", world.cvn73.as_uuid())
}

#[tokio::test]
async fn a_malformed_register_is_refused_whole() {
    let (app, w) = app();
    let bad = json!({
        "label": "bad.csv",
        "spaces": [
            {"compartment_no": "3-148-2-E", "fwd_frame": 152, "aft_frame": 148},
            {"compartment_no": "3-148-2-E", "fwd_frame": 148, "aft_frame": 152},
        ],
        "decks": [{"deck_code": "3rd", "lo_frame": 90, "hi_frame": 10}],
    });
    let (status, body) = call(&app, &w, "POST", &base(&w), Some(bad)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    let detail = body["detail"].as_str().unwrap();
    assert!(detail.contains("aft of aft frame"), "{detail}");
    assert!(detail.contains("surveyed twice"), "{detail}");
    assert!(detail.contains("not a forward-to-aft interval"), "{detail}");

    let (_, after) = call(&app, &w, "GET", &base(&w), None).await;
    assert!(after["register"].is_null());
}

#[tokio::test]
async fn disagreements_are_findings_not_refusals_and_the_grade_climbs() {
    let (app, w) = app();
    // 3-148-2-E surveyed at its own placard frame; 3-160-2-Q surveyed two
    // frames off its placard (the finding); one row naming a ghost space; a
    // third deck delineated 20..210 with one space's extent poking outside.
    let register = json!({
        "label": "CVN73-CA-extract.csv",
        "spaces": [
            {"compartment_no": "3-148-2-E", "fwd_frame": 148, "aft_frame": 154},
            {"compartment_no": "3-160-2-Q", "fwd_frame": 162, "aft_frame": 168},
            {"compartment_no": "3-184-0-Q", "fwd_frame": 184, "aft_frame": 214},
            {"compartment_no": "9-999-9-X", "fwd_frame": 1, "aft_frame": 2},
        ],
        "decks": [{"deck_code": "3rd", "lo_frame": 20, "hi_frame": 210}],
    });

    // Dry run: findings on the table BEFORE Confirm, nothing stored.
    let (status, preview) = call(
        &app,
        &w,
        "POST",
        &format!("{}?dry_run=true", base(&w)),
        Some(register.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["stored"], false);
    assert_eq!(
        preview["findings"]["placard_disagreements"][0]["compartment_no"], "3-160-2-Q",
        "{preview}"
    );
    assert_eq!(
        preview["findings"]["placard_disagreements"][0]["placard_frame"],
        160
    );
    assert_eq!(
        preview["findings"]["outside_deck_coverage"][0]["compartment_no"], "3-184-0-Q",
        "an extent running to frame 214 leaves a deck delineated to 210: {preview}"
    );
    assert_eq!(preview["findings"]["unknown_spaces"]["count"], 1);
    let (_, unstored) = call(&app, &w, "GET", &base(&w), None).await;
    assert!(unstored["register"].is_null(), "dry run must not store");

    // Commit, then read the register and the graded compartments.
    let (status, _) = call(&app, &w, "POST", &base(&w), Some(register)).await;
    assert_eq!(status, StatusCode::OK);
    let (_, served) = call(&app, &w, "GET", &base(&w), None).await;
    assert_eq!(served["register"]["label"], "CVN73-CA-extract.csv");
    assert_eq!(served["register"]["decks"][0]["hi_frame"], 210);
    assert_eq!(served["findings"]["surveyed"], 3);

    let (_, comps) = call(
        &app,
        &w,
        "GET",
        &format!("/api/vessels/{}/compartments", w.cvn73.as_uuid()),
        None,
    )
    .await;
    let rows = comps.as_array().unwrap();
    let surveyed = rows
        .iter()
        .find(|c| c["compartment_no"] == "3-148-2-E")
        .unwrap();
    assert_eq!(surveyed["geometry_source"], "surveyed");
    assert_eq!(surveyed["fwd_frame"], 148);
    assert_eq!(surveyed["aft_frame"], 154);
    let unsurveyed = rows
        .iter()
        .find(|c| c["compartment_no"] == "3-140-0-Q")
        .unwrap();
    assert_eq!(
        unsurveyed["geometry_source"], "parsed",
        "a space the register does not survey keeps its honest parse"
    );
    assert!(unsurveyed["fwd_frame"].is_null());

    // Revert: back to placard parses everywhere.
    let (status, _) = call(&app, &w, "POST", &format!("{}/revert", base(&w)), None).await;
    assert_eq!(status, StatusCode::OK);
    let (_, comps) = call(
        &app,
        &w,
        "GET",
        &format!("/api/vessels/{}/compartments", w.cvn73.as_uuid()),
        None,
    )
    .await;
    assert!(comps
        .as_array()
        .unwrap()
        .iter()
        .all(|c| c["geometry_source"] != "surveyed"));
}
