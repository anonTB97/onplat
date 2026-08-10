//! The mitigation endpoints, over the seeded demo hull.
//!
//! Run with `--nocapture` to print the leverage board, which is the fastest way
//! to see what the crate actually proposes for a real hull.
//!
//! What is asserted here is the contract the shell will rely on: that an option's
//! effect is a real re-evaluation (so the numbers move when the instant does),
//! that the two endpoints agree, and that the demo hull's two hazards produce the
//! two different KINDS of answer — one that clears itself, one that needs a person.

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

const ANCHOR: i64 = DEMO_ANCHOR_MS;
const HOUR: i64 = 3_600_000;

fn app_at_anchor() -> (axum::Router, DemoWorld) {
    let (store, world) = InMemoryStore::demo_at(Timestamp::from_epoch_millis(ANCHOR));
    let clock = TestClock::new(Timestamp::from_epoch_millis(ANCHOR));
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

fn hull(world: &DemoWorld) -> String {
    world.cvn73.as_uuid().to_string()
}

fn describe(action: &Value) -> String {
    match action["kind"].as_str().unwrap_or_default() {
        "wait" => format!("WAIT until {}", action["until"]),
        "discharge" => format!(
            "DISCHARGE {} @ {} [{}]",
            action["hazard"].as_str().unwrap_or_default(),
            action["origin"].as_str().unwrap_or_default(),
            action["actor"].as_str().unwrap_or_default()
        ),
        _ => format!(
            "INTERRUPT {} {} -> {}",
            action["coupling"].as_str().unwrap_or_default(),
            action["from"].as_str().unwrap_or_default(),
            action["to"].as_str().unwrap_or_default()
        ),
    }
}

/// The board a planner would read, printed. Also the smoke test for the endpoint.
#[tokio::test]
async fn the_leverage_board_ranks_the_hulls_actions() {
    let (app, world) = app_at_anchor();
    let id = hull(&world);
    let (status, body) = get(&app, &world, &format!("/api/vessels/{id}/leverage")).await;
    assert_eq!(status, StatusCode::OK);

    let actions = body["actions"].as_array().expect("actions");
    println!("\n=== CVN-73 leverage board at the anchor ===");
    for m in actions {
        let e = &m["effect"];
        let harm = if e["closes"].as_array().is_some_and(|c| !c.is_empty()) {
            format!("  CLOSES {}", e["closes"])
        } else {
            String::new()
        };
        println!(
            "  {:<64} frees {} sp / {} MH   net {}   {}{}",
            describe(&m["action"]),
            e["frees"].as_array().map_or(0, Vec::len),
            e["freed_hours"],
            e["freed_hours"].as_i64().unwrap_or(0) - e["closed_hours"].as_i64().unwrap_or(0),
            m["confidence"].as_str().unwrap_or_default(),
            harm
        );
    }

    assert!(!actions.is_empty(), "the seeded hull has held spaces");
    // Ranked by net hours recovered, descending.
    let nets: Vec<i64> = actions
        .iter()
        .map(|m| {
            m["effect"]["freed_hours"].as_i64().unwrap_or(0)
                - m["effect"]["closed_hours"].as_i64().unwrap_or(0)
        })
        .collect();
    assert!(
        nets.windows(2).all(|w| w[0] >= w[1]),
        "not ranked: {nets:?}"
    );
    // Nothing on the board frees nothing.
    for m in actions {
        assert!(!m["effect"]["frees"].as_array().unwrap().is_empty());
    }
}

/// The demo's two hazards are seeded to produce the two different kinds of answer,
/// and that difference is the whole product. The coated cascade offers a wait; the
/// switchgear room never can.
#[tokio::test]
async fn the_two_seeded_hazards_produce_the_two_kinds_of_answer() {
    let (app, world) = app_at_anchor();
    let id = hull(&world);

    // Below the curing coat: clears itself.
    let (status, coat) = get(
        &app,
        &world,
        &format!("/api/vessels/{id}/compartments/4-160-2-Q/mitigations"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let options = coat["options"].as_array().expect("options");
    println!("\n=== 4-160-2-Q (below the curing coat) ===");
    for m in options {
        println!("  {}", describe(&m["action"]));
    }
    assert!(!options.is_empty());
    assert_eq!(
        options[0]["action"]["kind"], "wait",
        "the cheapest thing that works is to wait"
    );

    // The switchgear room: a verified zero-energy state, never a clock.
    let (status, bus) = get(
        &app,
        &world,
        &format!("/api/vessels/{id}/compartments/3-148-2-E/mitigations"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    println!("\n=== 3-148-2-E (energised bus) ===");
    for m in bus["options"].as_array().expect("options") {
        println!("  {}", describe(&m["action"]));
    }
    assert!(
        !bus["options"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["action"]["kind"] == "wait"),
        "nothing here clears on a clock"
    );
    for hold in bus["holds"].as_array().expect("holds") {
        assert!(
            hold["earliest_clear"].is_null(),
            "a bus isolation has no expiry"
        );
    }
}

/// An open space is not an issue, and the endpoint says so rather than 404ing —
/// "nothing to do here" and "no such compartment" are different answers.
#[tokio::test]
async fn an_open_space_returns_an_empty_option_list() {
    let (app, world) = app_at_anchor();
    let id = hull(&world);
    let (status, body) = get(
        &app,
        &world,
        &format!("/api/vessels/{id}/compartments/4-110-2-W/mitigations"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["state"], "ALLOW");
    assert!(body["options"].as_array().unwrap().is_empty());
    assert!(body["holds"].as_array().unwrap().is_empty());
}

/// The effect is a re-evaluation, not a stored figure — so it must move when the
/// instant does. Six hours on, the cure has elapsed and there is nothing left for
/// the coating actions to free.
#[tokio::test]
async fn the_board_changes_with_the_instant() {
    let (app, world) = app_at_anchor();
    let id = hull(&world);

    let (_, now) = get(&app, &world, &format!("/api/vessels/{id}/leverage")).await;
    let later = ANCHOR + 6 * HOUR;
    let (status, after) = get(
        &app,
        &world,
        &format!("/api/vessels/{id}/leverage?as_of={later}"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(after["as_of"], Value::from(later));

    let coating_actions = |b: &Value| -> usize {
        b["actions"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| {
                m["action"]["hazard"]
                    .as_str()
                    .is_some_and(|h| h.contains("final coat"))
                    || m["action"]["kind"] == "wait"
            })
            .count()
    };
    assert!(
        coating_actions(&now) > 0,
        "the coat holds spaces at the anchor"
    );
    assert_eq!(
        coating_actions(&after),
        0,
        "six hours on the cure has elapsed, so it holds nothing and needs no action"
    );
}

/// An instant outside the availability is refused here on the same terms as
/// everywhere else — the bound belongs to the hull, not to the endpoint.
#[tokio::test]
async fn an_out_of_range_instant_is_refused() {
    let (app, world) = app_at_anchor();
    let id = hull(&world);
    let far = ANCHOR + 400 * 24 * HOUR;
    for path in [
        format!("/api/vessels/{id}/leverage?as_of={far}"),
        format!("/api/vessels/{id}/compartments/4-160-2-Q/mitigations?as_of={far}"),
    ] {
        let (status, _) = get(&app, &world, &path).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{path}");
    }
}
