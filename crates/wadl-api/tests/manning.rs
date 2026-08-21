//! The manning-book ingest seam: the supply side of crew planning arrives
//! whole or not at all. Demand (people a window's scheduled hours imply) is
//! computed from the register; a headcount is a yard's claim and only enters
//! through this door — with the preview naming which register trades the book
//! does and does not cover, because a book that spells a trade differently
//! would otherwise store cleanly and match nothing.

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
    format!("/api/vessels/{}/manning-book", world.cvn73.as_uuid())
}

#[tokio::test]
async fn the_door_refuses_a_malformed_book_whole() {
    let (app, w) = app();
    // Duplicate trade + negative headcount + blank trade: every defect named,
    // nothing stored.
    let bad = json!({
        "label": "bad.csv",
        "crews": [
            {"trade": "Electrical", "headcount": 10},
            {"trade": "Electrical", "headcount": 4},
            {"trade": "", "headcount": 2},
            {"trade": "Pipefitting", "headcount": -1},
        ],
    });
    let (status, body) = call(&app, &w, "POST", &base(&w), Some(bad)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    let detail = body["detail"].as_str().unwrap();
    assert!(detail.contains("manned twice"), "{detail}");
    assert!(detail.contains("negative headcount"), "{detail}");
    assert!(detail.contains("names no trade"), "{detail}");

    let (_, after) = call(&app, &w, "GET", &base(&w), None).await;
    assert!(after["book"].is_null(), "a refused book must not store");
}

#[tokio::test]
async fn dry_run_previews_coverage_without_storing() {
    let (app, w) = app();
    let book = json!({
        "label": "CVN73-manning.csv",
        "crews": [
            {"trade": "Electrical", "headcount": 12},
            {"trade": "Basketweaving", "headcount": 3},
        ],
    });
    let (status, body) = call(
        &app,
        &w,
        "POST",
        &format!("{}?dry_run=true", base(&w)),
        Some(book),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["stored"], false);
    // The made-up trade is named as matching nothing, and the register's other
    // trades are named as uncovered — the mapping honesty the preview exists for.
    let unmatched = body["coverage"]["book_trades_matching_no_register_trade"]
        .as_array()
        .unwrap();
    assert!(unmatched.iter().any(|t| t == "Basketweaving"), "{body}");
    assert!(
        !body["coverage"]["register_trades_with_no_manning_line"]
            .as_array()
            .unwrap()
            .is_empty(),
        "the demo register carries more trades than this two-line book: {body}"
    );

    let (_, after) = call(&app, &w, "GET", &base(&w), None).await;
    assert!(after["book"].is_null(), "dry run must not store");
}

#[tokio::test]
async fn commit_serves_the_book_and_revert_returns_to_demand_only() {
    let (app, w) = app();
    let book = json!({
        "label": "CVN73-manning.csv",
        "crews": [
            {"trade": "Electrical", "headcount": 12},
            {"trade": "Pipefitting", "headcount": 8},
        ],
    });
    let (status, body) = call(&app, &w, "POST", &base(&w), Some(book)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["stored"], true);

    let (_, served) = call(&app, &w, "GET", &base(&w), None).await;
    assert_eq!(served["book"]["label"], "CVN73-manning.csv");
    assert_eq!(served["book"]["crews"].as_array().unwrap().len(), 2);
    assert_eq!(served["book"]["crews"][0]["headcount"], 12);

    let (status, _) = call(&app, &w, "POST", &format!("{}/revert", base(&w)), None).await;
    assert_eq!(status, StatusCode::OK);
    let (_, after) = call(&app, &w, "GET", &base(&w), None).await;
    assert!(after["book"].is_null(), "revert must clear the book whole");
}
