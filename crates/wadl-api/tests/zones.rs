//! The zone-chart ingest seam: authored bounds arrive whole or not at all,
//! the audit joins them to the register on the server, and the finding the
//! sample chart deliberately carries — a space assigned to a zone whose
//! authored bounds it sits outside — is pinned here so it stays a feature.

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
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("x-org-id", world.yard_org.as_uuid().to_string())
        .header("x-assigned-vessels", world.cvn73.as_uuid().to_string());
    if body.is_some() {
        builder = builder.header("content-type", "application/json");
    }
    let request = builder
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

/// The chart the demo ships: full coverage of the seeded zones, with Z7
/// deliberately ended at frame 190 so the seeded space at frame 192 becomes
/// the out-of-bounds finding the audit exists to surface.
fn sample_chart() -> Value {
    json!({
        "label": "CVN73-zones.csv",
        "bounds": [
            { "zone": "Z2", "lo_frame": 96,  "hi_frame": 108 },
            { "zone": "Z3", "lo_frame": 108, "hi_frame": 126 },
            { "zone": "Z4", "lo_frame": 126, "hi_frame": 140 },
            { "zone": "Z5", "lo_frame": 140, "hi_frame": 151 },
            { "zone": "Z6", "lo_frame": 151, "hi_frame": 170 },
            { "zone": "Z7", "lo_frame": 170, "hi_frame": 190 },
        ],
    })
}

#[tokio::test]
async fn a_chart_ingests_whole_and_the_audit_names_the_disagreement() {
    let (app, world) = app();
    let zones_path = format!("/api/vessels/{}/zones", world.cvn73.as_uuid());

    // Before any chart: inferred mode, empty audit — an inferred band cannot
    // disagree with the spaces it was inferred from.
    let (status, body) = call(&app, &world, "GET", &zones_path, None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["source"].is_null());
    assert_eq!(body["bounds"].as_array().unwrap().len(), 0);
    assert_eq!(body["audit"]["out_of_bounds"].as_array().unwrap().len(), 0);

    // Dry run: the finding is visible before anything is stored.
    let (status, preview) = call(
        &app,
        &world,
        "POST",
        &format!("{zones_path}?dry_run=true"),
        Some(sample_chart()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["stored"], false);
    let oob = preview["audit"]["out_of_bounds"].as_array().unwrap();
    assert_eq!(oob.len(), 1, "{preview}");
    assert_eq!(oob[0]["compartment"], "3-192-2-E");
    assert_eq!(oob[0]["zone"], "Z7");
    assert_eq!(oob[0]["frame"], 192);
    // And nothing was stored.
    let (_, body) = call(&app, &world, "GET", &zones_path, None).await;
    assert!(body["source"].is_null());

    // The real import: stored, served with the same audit.
    let (status, stored) = call(&app, &world, "POST", &zones_path, Some(sample_chart())).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stored["stored"], true);
    let (_, body) = call(&app, &world, "GET", &zones_path, None).await;
    assert_eq!(body["source"], "CVN73-zones.csv");
    assert_eq!(body["bounds"].as_array().unwrap().len(), 6);
    assert_eq!(
        body["audit"]["out_of_bounds"].as_array().unwrap().len(),
        1,
        "{body}"
    );

    // Revert: back to inferred mode.
    let (status, _) = call(&app, &world, "POST", &format!("{zones_path}/revert"), None).await;
    assert_eq!(status, StatusCode::OK);
    let (_, body) = call(&app, &world, "GET", &zones_path, None).await;
    assert!(body["source"].is_null());
}

#[tokio::test]
async fn a_malformed_chart_is_refused_whole_with_every_reason() {
    let (app, world) = app();
    let zones_path = format!("/api/vessels/{}/zones", world.cvn73.as_uuid());
    let (status, body) = call(
        &app,
        &world,
        "POST",
        &zones_path,
        Some(json!({
            "label": "bad.csv",
            "bounds": [
                { "zone": "Z5", "lo_frame": 160, "hi_frame": 140 },
                { "zone": "Z5", "lo_frame": 140, "hi_frame": 151 },
                { "zone": "",   "lo_frame": 1,   "hi_frame": 2 },
            ],
        })),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let detail = body["detail"].as_str().unwrap_or_default();
    assert!(detail.contains("aft of"), "{detail}");
    assert!(detail.contains("bounded twice"), "{detail}");
    assert!(detail.contains("names no zone"), "{detail}");
    // Nothing landed.
    let (_, body) = call(&app, &world, "GET", &zones_path, None).await;
    assert!(body["source"].is_null());
}
