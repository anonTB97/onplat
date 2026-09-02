//! The reference hull boots through the doors: `reference/cvn73` loads into
//! the demo world by the same paths a yard's documents take, and what the
//! API then serves is the documents — the register at scale, a zone chart
//! that partitions every deck, couplings the traces walk, the morning's log.
//! If the generated documents and the doors ever disagree, this is where it
//! shows, before anyone boots a demo.

#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::path::Path;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::Value;
use tower::ServiceExt;
use wadl_domain::time::{TestClock, Timestamp};
use wadl_store::memory::{DemoWorld, InMemoryStore, DEMO_ANCHOR_MS};
use wadl_store::Repositories;

fn docs_dir() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../reference/cvn73")
}

async fn booted() -> (axum::Router, DemoWorld, Arc<InMemoryStore>) {
    let (store, world) = InMemoryStore::demo_at(Timestamp::from_epoch_millis(DEMO_ANCHOR_MS));
    let store = Arc::new(store);
    let loaded = wadl_api::documents::load_demo_docs(
        store.as_ref(),
        &world.yard_scope(),
        world.cvn73,
        &docs_dir(),
        DEMO_ANCHOR_MS,
    )
    .await
    .expect("the reference hull loads through the doors");
    assert!(loaded.register.is_some(), "{loaded:?}");
    assert!(loaded.zones.is_some(), "{loaded:?}");
    assert!(loaded.couplings.is_some(), "{loaded:?}");
    assert!(loaded.geometry.is_some(), "{loaded:?}");
    assert!(loaded.hazards.is_some(), "{loaded:?}");
    let clock = TestClock::new(Timestamp::from_epoch_millis(DEMO_ANCHOR_MS));
    let repos: Arc<dyn Repositories> = store.clone();
    let state = wadl_api::AppState::new(repos, Arc::new(clock));
    (wadl_api::build_router(state), world, store)
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
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 24)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn the_reference_hull_is_served_at_scale_with_a_clean_zone_audit() {
    let (app, w, _) = booted().await;

    let (status, register) = get(&app, &w, "/register").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(register["served"], "ingested", "{register}");
    let spaces = register["spaces_served"].as_u64().unwrap();
    assert!(spaces >= 400, "a carrier-sized register, got {spaces}");
    assert_eq!(register["decks_served"], 12);

    // Every deck in the register carries spaces, in the hull's order.
    let (_, decks) = get(&app, &w, "/decks").await;
    let ordinals: Vec<i64> = decks
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["ordinal"].as_i64().unwrap())
        .collect();
    let mut sorted = ordinals.clone();
    sorted.sort_unstable();
    assert_eq!(ordinals, sorted);
    assert!(decks
        .as_array()
        .unwrap()
        .iter()
        .all(|d| d["compartment_count"].as_u64().unwrap() > 0));

    // The chart partitions every deck: no space is outside its zone's blocks,
    // every zone the register uses is bounded, every bound names a zone in use.
    let (_, zones) = get(&app, &w, "/zones").await;
    assert_eq!(zones["source"], "CVN73-zones.csv");
    assert_eq!(
        zones["audit"]["out_of_bounds"].as_array().unwrap().len(),
        0,
        "{}",
        zones["audit"]
    );
    assert_eq!(
        zones["audit"]["unbounded_zones"].as_array().unwrap().len(),
        0
    );
    assert_eq!(
        zones["audit"]["unassigned_bounds"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    assert!(zones["bounds"]
        .as_array()
        .unwrap()
        .iter()
        .all(|b| b["top_deck"].is_string() && b["bottom_deck"].is_string()));

    // Couplings: the authored rows plus derived deck penetrations, walked.
    let (_, couplings) = get(&app, &w, "/couplings").await;
    assert_eq!(couplings["served"], "ingested");
    assert!(
        couplings["register"]["derived"].as_u64().unwrap() > 100,
        "{couplings}"
    );
    assert!(
        couplings["edges_served"].as_u64().unwrap()
            > couplings["register"]["authored"].as_u64().unwrap()
    );

    // The morning's log is live, and the seeded facts survived alongside it.
    let (_, hazards) = get(&app, &w, "/hazards").await;
    let live = hazards["hazards"].as_array().unwrap();
    assert!(live.len() >= 25, "{}", live.len());
    assert!(live.iter().any(|h| h["origin"] == "3-160-2-Q"));
}

#[tokio::test]
async fn the_served_hull_evaluates_every_space_and_rolls_up_by_zone() {
    let (app, w, _) = booted().await;
    let (status, verdicts) = get(&app, &w, "/deck-states").await;
    assert_eq!(status, StatusCode::OK);
    let rows = verdicts.as_array().unwrap();
    assert!(rows.len() >= 400);
    // The log's hazards refuse work somewhere — a hull with nothing shut is
    // not a hull under availability.
    assert!(
        rows.iter().any(|r| r["state"] != "ALLOW"),
        "nothing refused"
    );

    let (_, rollup) = get(&app, &w, "/readiness").await;
    let zones: Vec<&str> = rollup["zones"]
        .as_array()
        .unwrap()
        .iter()
        .map(|z| z["key"].as_str().unwrap())
        .collect();
    for z in ["Z1", "Z2", "Z3", "Z4", "Z5", "Z6"] {
        assert!(zones.contains(&z), "{zones:?}");
    }
}

#[tokio::test]
async fn a_document_the_doors_would_refuse_refuses_the_boot() {
    let (store, world) = InMemoryStore::demo_at(Timestamp::from_epoch_millis(DEMO_ANCHOR_MS));
    let dir = std::env::temp_dir().join(format!("wadl-demo-docs-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("bad-register.csv"),
        "deck,3rd,Third,3\nspace,3-148-2-E,Switchgear,9th,Z4,Electrical\n",
    )
    .unwrap();
    let err = wadl_api::documents::load_demo_docs(
        &store,
        &world.yard_scope(),
        world.cvn73,
        &dir,
        DEMO_ANCHOR_MS,
    )
    .await
    .unwrap_err();
    std::fs::remove_dir_all(&dir).ok();
    assert!(
        err.contains("bad-register.csv") && err.contains("9th"),
        "{err}"
    );
}
