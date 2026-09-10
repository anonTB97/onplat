//! The ship through the product: the compartment register, the coupling
//! register and the hazard log arrive through doors, previewed with findings,
//! committed whole, reverted whole, and every commit and revert lands in the
//! ledger. Once a register is stored it IS the hull — the reads serve it and
//! the seeded template stops existing for that hull until a revert.

#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    // Each test walks one door end to end — preview, commit, read, revert,
    // ledger — and reads best as one scenario.
    clippy::too_many_lines
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

fn hull(world: &DemoWorld) -> String {
    world.cvn73.as_uuid().to_string()
}

async fn ledger_actions(app: &axum::Router, world: &DemoWorld) -> Vec<String> {
    let (_, ledger) = call(
        app,
        world,
        "GET",
        &format!("/api/vessels/{}/ledger", hull(world)),
        None,
    )
    .await;
    assert_eq!(ledger["verified"], true, "{ledger}");
    ledger["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["action"].as_str().unwrap().to_owned())
        .collect()
}

fn a_register() -> Value {
    json!({
        "label": "CVN73-compartment-list.csv",
        "decks": [
            {"code": "2nd", "label": "Second Deck", "ordinal": 2},
            {"code": "3rd", "label": "Third Deck", "ordinal": 3},
        ],
        "spaces": [
            {"compartment_no": "2-160-2-Q", "name": "Passage", "deck_code": "2nd", "zone": "Z6", "category": "Passage"},
            {"compartment_no": "3-160-2-Q", "name": "Pump Room", "deck_code": "3rd", "zone": "Z6", "category": "Machinery"},
            {"compartment_no": "3-148-2-E", "name": "Switchgear", "deck_code": "3rd", "zone": "Z5", "category": "Electrical", "frame": 148, "side": "port"},
            {"compartment_no": "5-140-0-JJ", "name": "JP-5 tank", "deck_code": "3rd", "zone": "Z4", "category": "Tank"},
        ],
    })
}

#[tokio::test]
async fn a_register_replaces_the_seed_and_a_revert_restores_it() {
    let (app, w) = app();
    let base = format!("/api/vessels/{}/register", hull(&w));

    let (_, before) = call(&app, &w, "GET", &base, None).await;
    assert_eq!(before["served"], "seeded");
    assert_eq!(before["spaces_served"], 24);

    // Dry run: findings on the table, nothing stored.
    let (status, preview) = call(
        &app,
        &w,
        "POST",
        &format!("{base}?dry_run=true"),
        Some(a_register()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["stored"], false);
    // The seeded coat in 3-160-2-Q survives; nothing is orphaned there. The
    // activities located to the 20 spaces this register drops are counted.
    assert_eq!(
        preview["findings"]["orphaned_hazards"]
            .as_array()
            .unwrap()
            .len(),
        0,
        "{preview}"
    );
    assert!(
        preview["findings"]["activities_losing_their_space"]
            .as_u64()
            .unwrap()
            > 0
    );
    let (_, still) = call(&app, &w, "GET", &base, None).await;
    assert_eq!(still["served"], "seeded");

    // Commit: the reads serve the yard's ship.
    let (status, stored) = call(&app, &w, "POST", &base, Some(a_register())).await;
    assert_eq!(status, StatusCode::OK, "{stored}");
    assert_eq!(stored["stored"], true);
    let (_, after) = call(&app, &w, "GET", &base, None).await;
    assert_eq!(after["served"], "ingested");
    assert_eq!(after["spaces_served"], 4);
    assert_eq!(after["decks_served"], 2);

    let (_, compartments) = call(
        &app,
        &w,
        "GET",
        &format!("/api/vessels/{}/compartments", hull(&w)),
        None,
    )
    .await;
    let rows = compartments.as_array().unwrap();
    assert_eq!(rows.len(), 4);
    let jp5 = rows
        .iter()
        .find(|r| r["compartment_no"] == "5-140-0-JJ")
        .unwrap();
    assert_eq!(jp5["frame"], 140, "a doubled tank code still places itself");
    assert_eq!(jp5["geometry_source"], "parsed");
    let sg = rows
        .iter()
        .find(|r| r["compartment_no"] == "3-148-2-E")
        .unwrap();
    assert_eq!(
        sg["geometry_source"], "register",
        "an authored frame is the register's"
    );

    let (_, decks) = call(
        &app,
        &w,
        "GET",
        &format!("/api/vessels/{}/decks", hull(&w)),
        None,
    )
    .await;
    let decks = decks.as_array().unwrap();
    assert_eq!(decks.len(), 2);
    assert_eq!(decks[1]["code"], "3rd");
    assert_eq!(decks[1]["compartment_count"], 3);

    // The deck board is the new ship, and the seeded coat still holds its space.
    let (_, board) = call(
        &app,
        &w,
        "GET",
        &format!("/api/vessels/{}/deck-states", hull(&w)),
        None,
    )
    .await;
    let board = board.as_array().unwrap();
    assert_eq!(board.len(), 4);
    let pump = board
        .iter()
        .find(|r| r["compartment"]["compartment_no"] == "3-160-2-Q")
        .unwrap();
    assert_eq!(pump["state"], "BLOCK");

    // Revert: the seed is back, and both moves are on the record.
    let (status, _) = call(&app, &w, "POST", &format!("{base}/revert"), None).await;
    assert_eq!(status, StatusCode::OK);
    let (_, back) = call(&app, &w, "GET", &base, None).await;
    assert_eq!(back["served"], "seeded");
    assert_eq!(back["spaces_served"], 24);
    let actions = ledger_actions(&app, &w).await;
    assert!(
        actions.contains(&"DOCUMENT_REPLACED".to_owned()),
        "{actions:?}"
    );
    assert!(
        actions.contains(&"DOCUMENT_REVERTED".to_owned()),
        "{actions:?}"
    );
}

#[tokio::test]
async fn a_malformed_register_is_refused_whole() {
    let (app, w) = app();
    let base = format!("/api/vessels/{}/register", hull(&w));
    let bad = json!({
        "label": "bad.csv",
        "decks": [{"code": "3rd", "label": "Third", "ordinal": 3}, {"code": "3rd", "label": "Again", "ordinal": 3}],
        "spaces": [
            {"compartment_no": "3-148-2-E", "name": "x", "deck_code": "9th", "zone": "Z5", "category": "E"},
            {"compartment_no": "3-148-2-E", "name": "x", "deck_code": "3rd", "zone": "Z5", "category": "E", "side": "left"},
        ],
    });
    let (status, body) = call(&app, &w, "POST", &base, Some(bad)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    let detail = body["detail"].as_str().unwrap();
    assert!(detail.contains("listed twice"), "{detail}");
    assert!(detail.contains("does not list"), "{detail}");
    assert!(
        detail.contains("not port, starboard or centreline"),
        "{detail}"
    );
    let (_, after) = call(&app, &w, "GET", &base, None).await;
    assert_eq!(after["served"], "seeded");
}

#[tokio::test]
async fn couplings_change_the_cascade_and_vertical_edges_can_be_derived() {
    let (app, w) = app();
    let base = format!("/api/vessels/{}/couplings", hull(&w));
    let (_, before) = call(&app, &w, "GET", &base, None).await;
    assert_eq!(before["served"], "seeded");
    assert_eq!(before["edges_served"], 8);
    assert!(before["types"]
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t["code"] == "deck_penetration"));

    // The scullery is clean at the anchor.
    let state_of = |board: &Value, no: &str| {
        board
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["compartment"]["compartment_no"] == no)
            .map(|r| r["state"].as_str().unwrap().to_owned())
            .unwrap()
    };
    let (_, board) = call(
        &app,
        &w,
        "GET",
        &format!("/api/vessels/{}/deck-states", hull(&w)),
        None,
    )
    .await;
    assert_eq!(state_of(&board, "2-152-0-Q"), "ALLOW");

    // An unknown type or an unknown space refuses the file.
    let (status, body) = call(
        &app,
        &w,
        "POST",
        &base,
        Some(json!({
            "label": "bad", "edges": [{"from": "3-160-2-Q", "to": "9-999-9-Z", "code": "teleport"}]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    let detail = body["detail"].as_str().unwrap();
    assert!(detail.contains("teleport"), "{detail}");
    assert!(detail.contains("9-999-9-Z"), "{detail}");

    // Couple the curing coat's space to the scullery by a deck penetration.
    let register = json!({
        "label": "CVN73-couplings.csv",
        "edges": [{"from": "3-160-2-Q", "to": "2-152-0-Q", "code": "deck_penetration"}],
    });
    let (status, stored) = call(&app, &w, "POST", &base, Some(register)).await;
    assert_eq!(status, StatusCode::OK, "{stored}");
    let (_, board) = call(
        &app,
        &w,
        "GET",
        &format!("/api/vessels/{}/deck-states", hull(&w)),
        None,
    )
    .await;
    assert_ne!(
        state_of(&board, "2-152-0-Q"),
        "ALLOW",
        "the coat now reaches the scullery"
    );
    let (_, after) = call(&app, &w, "GET", &base, None).await;
    assert_eq!(after["served"], "ingested");
    assert_eq!(after["edges_served"], 1);

    // Derivation proposes the seeded neighbourhood's vertical pairs from the
    // register alone: 3-160-2-Q sits directly above 4-160-2-Q.
    let (status, preview) = call(
        &app,
        &w,
        "POST",
        &format!("{base}?dry_run=true"),
        Some(json!({
            "label": "derived", "edges": [], "derive_vertical": true
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert!(preview["derived"].as_u64().unwrap() > 0, "{preview}");
    assert!(
        preview["derived_edges"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["from"] == "3-160-2-Q" && e["to"] == "4-160-2-Q"),
        "{preview}"
    );
    assert!(preview["derived_edges"]
        .as_array()
        .unwrap()
        .iter()
        .all(|e| e["provenance"] == "derived"));

    // Revert: the seed's eight edges walk again.
    let (status, _) = call(&app, &w, "POST", &format!("{base}/revert"), None).await;
    assert_eq!(status, StatusCode::OK);
    let (_, back) = call(&app, &w, "GET", &base, None).await;
    assert_eq!(back["edges_served"], 8);
    let (_, board) = call(
        &app,
        &w,
        "GET",
        &format!("/api/vessels/{}/deck-states", hull(&w)),
        None,
    )
    .await;
    assert_eq!(state_of(&board, "2-152-0-Q"), "ALLOW");
}

#[tokio::test]
async fn a_hazard_log_raises_what_is_new_and_skips_what_is_live() {
    let (app, w) = app();
    let base = format!("/api/vessels/{}/hazards/import", hull(&w));
    let log = json!({
        "label": "tagout-0902.csv",
        "rows": [
            {"compartment": "3-148-2-E", "kind": "energised_bus", "label": "Bus 3-SG-2 (still)"},
            {"compartment": "2-152-0-Q", "kind": "hot_work_live", "label": "HW-0912 · welding permit"},
            {"compartment": "4-110-2-W", "kind": "stop_work", "label": "SW-3 · inspector hold"},
        ],
    });
    let (status, preview) = call(
        &app,
        &w,
        "POST",
        &format!("{base}?dry_run=true"),
        Some(log.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["would_raise"].as_array().unwrap().len(), 2);
    assert_eq!(preview["already_live"][0]["compartment"], "3-148-2-E");

    let (status, stored) = call(&app, &w, "POST", &base, Some(log)).await;
    assert_eq!(status, StatusCode::OK, "{stored}");
    assert_eq!(stored["raised"].as_array().unwrap().len(), 2);
    let (_, hazards) = call(
        &app,
        &w,
        "GET",
        &format!("/api/vessels/{}/hazards", hull(&w)),
        None,
    )
    .await;
    assert_eq!(
        hazards["hazards"].as_array().unwrap().len(),
        4,
        "two seeded plus two raised"
    );

    let actions = ledger_actions(&app, &w).await;
    assert_eq!(actions.iter().filter(|a| *a == "HAZARD_RAISED").count(), 2);
    assert!(actions.contains(&"HAZARD_LOG_IMPORTED".to_owned()));

    // A row naming a space the hull does not know refuses the log whole.
    let (status, body) = call(&app, &w, "POST", &base, Some(json!({
        "label": "bad", "rows": [{"compartment": "9-999-9-Z", "kind": "stop_work", "label": "nowhere"}]
    }))).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
}

#[tokio::test]
async fn every_document_door_writes_the_ledger() {
    let (app, w) = app();
    let h = hull(&w);
    let (status, _) = call(
        &app,
        &w,
        "POST",
        &format!("/api/vessels/{h}/zones"),
        Some(json!({
            "label": "chart.csv", "bounds": [{"zone": "Z5", "lo_frame": 140, "hi_frame": 151}]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = call(
        &app,
        &w,
        "POST",
        &format!("/api/vessels/{h}/zones/revert"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = call(
        &app,
        &w,
        "POST",
        &format!("/api/vessels/{h}/manning-book"),
        Some(json!({
            "label": "manning.csv", "crews": [{"trade": "SM-PIPE", "headcount": 12}]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = call(
        &app,
        &w,
        "POST",
        &format!("/api/vessels/{h}/manning-book/revert"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (_, ledger) = call(&app, &w, "GET", &format!("/api/vessels/{h}/ledger"), None).await;
    let entries = ledger["entries"].as_array().unwrap();
    let replaced: Vec<&Value> = entries
        .iter()
        .filter(|e| e["action"] == "DOCUMENT_REPLACED")
        .collect();
    let reverted: Vec<&Value> = entries
        .iter()
        .filter(|e| e["action"] == "DOCUMENT_REVERTED")
        .collect();
    assert_eq!(replaced.len(), 2, "{entries:?}");
    assert_eq!(reverted.len(), 2, "{entries:?}");
    assert!(replaced
        .iter()
        .any(|e| e["detail"].as_str().unwrap().contains("zone_register")));
    assert!(replaced
        .iter()
        .any(|e| e["detail"].as_str().unwrap().contains("manning.csv")));
    assert_eq!(ledger["verified"], true);
}
