//! A person behind every decision — slice S12, the server half.
//!
//! Driven through the router as the shell and the proxy drive it: identity
//! headers in, problem+json or a ledger row out. Everything here runs on the
//! in-memory store under a `TestClock`, in dev-shim mode (no `WADL_PROXY_KEY`
//! in the test environment), which is where the roles header narrows what a
//! demo person may do and where the ledger must still name whoever acted.

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

/// The seeded energised bus and the space it lives in — the hold a clearance
/// is recorded against.
const BUS_SPACE: &str = "3-148-2-E";

fn app_at_anchor() -> (axum::Router, DemoWorld) {
    let (store, world) = InMemoryStore::demo_at(Timestamp::from_epoch_millis(DEMO_ANCHOR_MS));
    let clock = TestClock::new(Timestamp::from_epoch_millis(DEMO_ANCHOR_MS));
    let state = wadl_api::AppState::new(Arc::new(store), Arc::new(clock));
    (wadl_api::build_router(state), world)
}

/// A person as the proxy or the shim would assert one: id, percent-encoded
/// name, roles. `None` roles means the header is absent (demo mode: every
/// door open).
struct Person<'a> {
    id: &'a str,
    name: &'a str,
    roles: Option<&'a str>,
}

const ALVAREZ_SAFETY: Person<'static> = Person {
    id: "1234567890",
    name: "R.%20Alvarez",
    roles: Some("safety"),
};
const ALVAREZ_FOREMAN: Person<'static> = Person {
    id: "1234567890",
    name: "R.%20Alvarez",
    roles: Some("foreman"),
};
const DEMO_PLANNER: Person<'static> = Person {
    id: "dev:planner",
    name: "Demo%20Planner%20(Y-1001)",
    roles: Some("planner"),
};
const READER: Person<'static> = Person {
    id: "dev:reader",
    name: "Demo%20Reader",
    roles: Some("reader"),
};

async fn call(
    app: &axum::Router,
    world: &DemoWorld,
    person: Option<&Person<'_>>,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("x-org-id", world.yard_org.as_uuid().to_string())
        .header("x-assigned-vessels", world.cvn73.as_uuid().to_string())
        .header("content-type", "application/json");
    if let Some(p) = person {
        request = request
            .header("x-wadl-person", p.id)
            .header("x-wadl-person-name", p.name);
        if let Some(roles) = p.roles {
            request = request.header("x-wadl-roles", roles);
        }
    }
    let response = app
        .clone()
        .oneshot(
            request
                .body(body.map_or_else(Body::empty, |b| Body::from(b.to_owned())))
                .unwrap(),
        )
        .await
        .unwrap();
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

async fn ledger(app: &axum::Router, world: &DemoWorld) -> Value {
    let (status, body) = call(
        app,
        world,
        None,
        "GET",
        &format!("/api/vessels/{}/ledger", hull(world)),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    body
}

fn clear_bus_body() -> String {
    json!({
        "compartment": BUS_SPACE,
        "kind": "energised_bus",
        "basis": "tags hung and verified by test",
    })
    .to_string()
}

async fn bus_is_live(app: &axum::Router, world: &DemoWorld) -> bool {
    let (status, hazards) = call(
        app,
        world,
        None,
        "GET",
        &format!("/api/vessels/{}/hazards", hull(world)),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    hazards["hazards"]
        .as_array()
        .unwrap()
        .iter()
        .any(|h| h["origin"] == BUS_SPACE && h["kind"] == "energised_bus")
}

#[tokio::test]
async fn whoami_names_the_person_roles_capabilities_hulls_and_markings() {
    let (app, world) = app_at_anchor();
    let (status, who) = call(
        &app,
        &world,
        Some(&ALVAREZ_SAFETY),
        "GET",
        "/api/whoami",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    assert_eq!(who["identity_mode"], "dev-headers");
    assert_eq!(who["org"], world.yard_org.as_uuid().to_string());
    assert_eq!(who["person"]["id"], "1234567890");
    assert_eq!(who["person"]["name"], "R. Alvarez");
    // The test environment is the shim: a person it names is the shim's.
    assert_eq!(who["person"]["source"], "dev-shim");
    assert_eq!(who["roles"], json!(["safety"]));
    assert_eq!(
        who["capabilities"],
        json!(["read", "raise_hazard", "clear_hazard", "decide"])
    );
    let hulls = who["hulls"].as_array().unwrap();
    assert_eq!(hulls.len(), 1, "the hulls this scope is served");
    assert_eq!(hulls[0]["hull_no"], "CVN-73");
    assert_eq!(hulls[0]["vessel_id"], hull(&world));
    assert_eq!(
        who["role_matrix"]["planner"],
        json!(["raise_hazard", "commit_document", "propose", "decide"])
    );
    assert_eq!(who["role_matrix"]["reader"], json!([]));
    assert_eq!(who["warnings"], json!([]));
    let markings = who["markings"].as_array().unwrap();
    assert!(
        !markings.is_empty(),
        "the band always has something to wear"
    );
    assert_eq!(who["decision_support_only"], true);
}

#[tokio::test]
async fn a_clearance_lands_in_the_ledger_under_the_person_who_recorded_it() {
    let (app, world) = app_at_anchor();
    assert!(bus_is_live(&app, &world).await);

    let (status, _) = call(
        &app,
        &world,
        Some(&ALVAREZ_SAFETY),
        "POST",
        &format!("/api/vessels/{}/hazards/clear", hull(&world)),
        Some(&clear_bus_body()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!bus_is_live(&app, &world).await);

    let book = ledger(&app, &world).await;
    assert_eq!(book["verified"], true);
    let newest = &book["entries"][0];
    assert_eq!(newest["action"], "HAZARD_CLEARED");
    assert_eq!(newest["actor_id"], "1234567890");
    assert_eq!(newest["actor_name"], "R. Alvarez");
    assert_eq!(newest["chain_version"], 2);
}

#[tokio::test]
async fn a_foreman_is_refused_a_clearance_with_a_sentence_and_nothing_is_written() {
    let (app, world) = app_at_anchor();
    let before = ledger(&app, &world).await["entries"]
        .as_array()
        .unwrap()
        .len();

    let (status, problem) = call(
        &app,
        &world,
        Some(&ALVAREZ_FOREMAN),
        "POST",
        &format!("/api/vessels/{}/hazards/clear", hull(&world)),
        Some(&clear_bus_body()),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(problem["title"], "forbidden");
    assert_eq!(problem["status"], 403);
    assert_eq!(
        problem["detail"],
        "Foreman may not record a clearance — clear_hazard is held by Ship Super and Safety"
    );
    assert_eq!(problem["capability"], "clear_hazard");
    assert_eq!(problem["roles"], json!(["foreman"]));

    let after = ledger(&app, &world).await["entries"]
        .as_array()
        .unwrap()
        .len();
    assert_eq!(after, before, "a refusal writes no ledger row");
    assert!(bus_is_live(&app, &world).await, "the hold is still live");
}

#[tokio::test]
async fn a_reader_may_dry_run_the_register_but_not_commit_it() {
    let (app, world) = app_at_anchor();
    let register = json!({
        "label": "reader's register",
        "decks": [{"code": "3rd", "label": "Third Deck", "ordinal": 3}],
        "spaces": [{"compartment_no": "3-148-2-E", "name": "test", "deck_code": "3rd", "zone": "Z5", "category": "E"}],
    })
    .to_string();
    let before = ledger(&app, &world).await["entries"]
        .as_array()
        .unwrap()
        .len();

    let (status, preview) = call(
        &app,
        &world,
        Some(&READER),
        "POST",
        &format!("/api/vessels/{}/register?dry_run=true", hull(&world)),
        Some(&register),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "anyone may preview: {preview}");
    assert_eq!(preview["stored"], false);
    assert_eq!(preview["label"], "reader's register");

    let (status, problem) = call(
        &app,
        &world,
        Some(&READER),
        "POST",
        &format!("/api/vessels/{}/register", hull(&world)),
        Some(&register),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(problem["capability"], "commit_document");
    assert_eq!(
        problem["detail"],
        "Reader may not commit or revert a document — commit_document is held by Planner"
    );

    // Nothing stored, no ledger row: the register is still the seeded one.
    let (status, served) = call(
        &app,
        &world,
        None,
        "GET",
        &format!("/api/vessels/{}/register", hull(&world)),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_ne!(served["label"], "reader's register");
    let after = ledger(&app, &world).await["entries"]
        .as_array()
        .unwrap()
        .len();
    assert_eq!(after, before);
}

#[tokio::test]
async fn a_foreign_hull_is_not_found_before_a_capability_is_judged() {
    let (app, world) = app_at_anchor();
    let navy = world.navy_hull.as_uuid().to_string();
    let (status, problem) = call(
        &app,
        &world,
        Some(&READER),
        "POST",
        &format!("/api/vessels/{navy}/hazards/clear"),
        Some(&clear_bus_body()),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(problem["title"], "not found");
    assert!(problem.get("capability").is_none());
}

#[tokio::test]
async fn dev_mode_without_roles_opens_every_door_and_the_ledger_says_dev_anonymous() {
    let (app, world) = app_at_anchor();

    // No person, no roles — what the shell sends until sitting two.
    let (status, who) = call(&app, &world, None, "GET", "/api/whoami", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(who["person"]["id"], "dev:anonymous");
    assert_eq!(who["person"]["source"], "dev-shim-anonymous");
    assert_eq!(who["roles"], json!([]));
    assert_eq!(who["capabilities"].as_array().unwrap().len(), 6);
    assert_eq!(
        who["warnings"][0],
        "demo mode: no x-wadl-roles — every door is open"
    );

    let (status, _) = call(
        &app,
        &world,
        None,
        "POST",
        &format!("/api/vessels/{}/hazards/clear", hull(&world)),
        Some(&clear_bus_body()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let newest = &ledger(&app, &world).await["entries"][0];
    assert_eq!(newest["actor_id"], "dev:anonymous");
    assert_eq!(newest["actor_name"], "dev:anonymous");
    assert_eq!(newest["chain_version"], 2);
}

/// The seven doors, as documents small enough to commit and revert in a
/// loop. Each body is the door's minimal valid document.
fn door_bodies() -> Vec<(&'static str, String)> {
    vec![
        (
            "register",
            json!({"label": "t", "decks": [{"code": "3rd", "label": "Third Deck", "ordinal": 3}],
                   "spaces": [{"compartment_no": "3-148-2-E", "name": "t", "deck_code": "3rd", "zone": "Z5", "category": "E"}]})
            .to_string(),
        ),
        (
            "couplings",
            json!({"label": "t", "edges": [{"from": "3-148-2-E", "to": "3-160-2-Q", "code": "deck_penetration"}]})
                .to_string(),
        ),
        (
            "zones",
            json!({"label": "t", "bounds": [{"zone": "Z1", "lo_frame": 0, "hi_frame": 1}]}).to_string(),
        ),
        (
            "geometry",
            json!({"label": "t", "spaces": [{"compartment_no": "3-148-2-E", "fwd_frame": 148, "aft_frame": 152}], "decks": []})
                .to_string(),
        ),
        (
            "manning-book",
            json!({"label": "t", "crews": [{"trade": "Electrical", "headcount": 1}]}).to_string(),
        ),
        (
            "budget-book",
            json!({"label": "t", "items": [{"code": "WI-0", "title": "t", "trade": "t", "budget_hours": 1, "earned_hours": 0}]})
                .to_string(),
        ),
        (
            "yard-clock",
            json!({"label": "t", "clock": {"zone": "UTC", "standard_offset_minutes": 0, "daylight": null, "watch_minutes": 240,
                   "shifts": [{"name": "Days", "start_minute": 420, "length_minutes": 510}]}})
            .to_string(),
        ),
    ]
}

#[tokio::test]
async fn every_door_commit_and_revert_names_the_person() {
    let (app, world) = app_at_anchor();
    let mut expected_rows = 0;
    for (door, body) in door_bodies() {
        let (status, answer) = call(
            &app,
            &world,
            Some(&DEMO_PLANNER),
            "POST",
            &format!("/api/vessels/{}/{door}", hull(&world)),
            Some(&body),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{door} commit: {answer}");
        let (status, answer) = call(
            &app,
            &world,
            Some(&DEMO_PLANNER),
            "POST",
            &format!("/api/vessels/{}/{door}/revert", hull(&world)),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{door} revert: {answer}");
        expected_rows += 2;
    }

    let book = ledger(&app, &world).await;
    assert_eq!(book["verified"], true);
    let document_rows: Vec<&Value> = book["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| {
            e["action"]
                .as_str()
                .is_some_and(|a| a.starts_with("DOCUMENT_"))
        })
        .collect();
    assert_eq!(document_rows.len(), expected_rows);
    for row in document_rows {
        assert_eq!(row["actor_id"], "dev:planner", "{row}");
        assert_eq!(row["actor_name"], "Demo Planner (Y-1001)", "{row}");
        assert_eq!(row["chain_version"], 2, "{row}");
    }

    // And a foreman cannot revert what the planner committed.
    let (status, problem) = call(
        &app,
        &world,
        Some(&ALVAREZ_FOREMAN),
        "POST",
        &format!("/api/vessels/{}/zones/revert", hull(&world)),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(problem["capability"], "commit_document");
}

#[tokio::test]
async fn health_says_which_identity_boundary_is_armed() {
    let (app, world) = app_at_anchor();
    let (status, health) = call(&app, &world, None, "GET", "/health", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(health["identity_mode"], "dev-headers");
}
