//! The budget-book ingest seam: the book arrives whole or not at all, and
//! from the next read reconciliation holds the register's hours to the book
//! instead of the seeded work items — with the response naming which side of
//! the comparison it ran against, because "reconciles" is only as strong as
//! what it reconciles WITH.

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

/// A budget book mirroring the hull's own served numbers — built from the
/// work-orders and packages endpoints so the test never hardcodes the seed.
async fn faithful_book(app: &axum::Router, world: &DemoWorld) -> Vec<Value> {
    let base = format!("/api/vessels/{}", world.cvn73.as_uuid());
    let (_, orders) = call(app, world, "GET", &format!("{base}/work-orders"), None).await;
    let (_, packages) = call(app, world, "GET", &format!("{base}/packages"), None).await;
    orders
        .as_array()
        .unwrap()
        .iter()
        .map(|o| (o, o["title"].clone()))
        .chain(
            packages
                .as_array()
                .unwrap()
                .iter()
                .map(|p| (p, p["name"].clone())),
        )
        .map(|(item, title)| {
            json!({
                "code": item["code"],
                "title": title,
                "trade": item["trade"],
                "budget_hours": item["budget_hours"],
                "earned_hours": item["earned_hours"],
            })
        })
        .collect()
}

#[tokio::test]
async fn the_book_becomes_the_hours_authority_and_names_itself() {
    let (app, world) = app();
    let base = format!("/api/vessels/{}", world.cvn73.as_uuid());
    let book_path = format!("{base}/budget-book");
    let activities_path = format!("{base}/activities");

    // Before any book: reconciliation runs against the seeded items, says so
    // (source null), and the generated register reconciles by construction.
    let (_, before) = call(&app, &world, "GET", &activities_path, None).await;
    assert!(before["reconciliation"]["source"].is_null());
    assert_eq!(
        before["reconciliation"]["mismatches"]
            .as_array()
            .unwrap()
            .len(),
        0
    );

    // A book that mirrors the hull exactly, except: WI-3318 budgeted 700
    // where the register carries 680, and WI-9101 growth work the register
    // has no hours against at all.
    let mut items = faithful_book(&app, &world).await;
    let wi3318 = items
        .iter_mut()
        .find(|i| i["code"] == "WI-3318")
        .expect("seeded");
    wi3318["budget_hours"] = json!(700);
    items.push(json!({
        "code": "WI-9101",
        "title": "Growth — pier services rerun",
        "trade": "Electrical",
        "budget_hours": 120,
        "earned_hours": 0,
    }));
    let n_items = items.len();

    // Dry run: both findings visible, nothing stored.
    let (status, preview) = call(
        &app,
        &world,
        "POST",
        &format!("{book_path}?dry_run=true"),
        Some(json!({ "label": "CVN73-budgets.csv", "items": items })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["stored"], false);
    let codes: Vec<&str> = preview["reconciliation"]["mismatches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["code"].as_str().unwrap())
        .collect();
    assert_eq!(codes, ["WI-3318", "WI-9101"], "{preview}");
    let (_, still) = call(&app, &world, "GET", &activities_path, None).await;
    assert!(still["reconciliation"]["source"].is_null());

    // The real import: every read now reconciles against the book, by name.
    let (status, stored) = call(
        &app,
        &world,
        "POST",
        &book_path,
        Some(json!({ "label": "CVN73-budgets.csv", "items": items })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{stored}");
    let (_, after) = call(&app, &world, "GET", &activities_path, None).await;
    assert_eq!(after["reconciliation"]["source"], "CVN73-budgets.csv");
    assert_eq!(after["reconciliation"]["items"], n_items);
    let codes: Vec<&str> = after["reconciliation"]["mismatches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["code"].as_str().unwrap())
        .collect();
    assert_eq!(codes, ["WI-3318", "WI-9101"], "{after}");

    // Revert: back to the seeded items, reconciled by construction again.
    let (status, _) = call(&app, &world, "POST", &format!("{book_path}/revert"), None).await;
    assert_eq!(status, StatusCode::OK);
    let (_, reverted) = call(&app, &world, "GET", &activities_path, None).await;
    assert!(reverted["reconciliation"]["source"].is_null());
    assert_eq!(
        reverted["reconciliation"]["mismatches"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
}

#[tokio::test]
async fn a_malformed_book_is_refused_whole_with_every_reason() {
    let (app, world) = app();
    let book_path = format!("/api/vessels/{}/budget-book", world.cvn73.as_uuid());
    let (status, body) = call(
        &app,
        &world,
        "POST",
        &book_path,
        Some(json!({
            "label": "bad.csv",
            "items": [
                { "code": "WI-1", "title": "a", "trade": "t", "budget_hours": -5, "earned_hours": 0 },
                { "code": "WI-1", "title": "b", "trade": "t", "budget_hours": 10, "earned_hours": 0 },
                { "code": "",     "title": "c", "trade": "t", "budget_hours": 10, "earned_hours": 0 },
            ],
        })),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let detail = body["detail"].as_str().unwrap_or_default();
    assert!(detail.contains("negative hours"), "{detail}");
    assert!(detail.contains("budgeted twice"), "{detail}");
    assert!(detail.contains("names no code"), "{detail}");
    // Nothing landed.
    let (_, after) = call(
        &app,
        &world,
        "GET",
        &format!("/api/vessels/{}/activities", world.cvn73.as_uuid()),
        None,
    )
    .await;
    assert!(after["reconciliation"]["source"].is_null());
}
