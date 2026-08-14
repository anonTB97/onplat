//! The `?as_of=` contract.
//!
//! Asking for an instant is the one way a caller can make the API answer a
//! different question than "what is true now", so the boundaries matter more than
//! the happy path. Four properties are pinned here:
//!
//! 1. Omitting `as_of` is byte-identical to passing the clock's own instant. If
//!    that ever diverged, every existing caller would silently change behaviour
//!    the day the parameter was added.
//! 2. An instant outside the hull's availability is refused, not clamped.
//! 3. Scrubbing past a cure clears the spaces it was holding.
//! 4. Scrubbing past a *verification* hold clears nothing — the whole point of
//!    the time dimension is that these two behave differently.

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
use wadl_domain::units::Minutes;
use wadl_store::memory::{DemoWorld, InMemoryStore, DEMO_ANCHOR_MS};

const ANCHOR: i64 = DEMO_ANCHOR_MS;
const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 24 * HOUR_MS;

/// An app whose clock and seed share the fixed demo anchor, so every instant in
/// these tests is a known offset from a known point.
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
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, value)
}

fn hull(world: &DemoWorld) -> String {
    world.cvn73.as_uuid().to_string()
}

/// Property 1. The default path must not be a special case that drifts.
#[tokio::test]
async fn omitting_as_of_matches_passing_the_clocks_own_instant() {
    let (app, world) = app_at_anchor();
    let id = hull(&world);
    for endpoint in ["deck-states", "readiness"] {
        let (live_status, live) = get(&app, &world, &format!("/api/vessels/{id}/{endpoint}")).await;
        let (asked_status, asked) = get(
            &app,
            &world,
            &format!("/api/vessels/{id}/{endpoint}?as_of={ANCHOR}"),
        )
        .await;
        assert_eq!(live_status, StatusCode::OK, "{endpoint}");
        assert_eq!(asked_status, StatusCode::OK, "{endpoint}");
        assert_eq!(live, asked, "{endpoint} differs with an explicit as_of");
    }
}

/// Property 2. Outside the availability is a refusal with a reason, not a
/// confident answer about a date the hull has no data for.
#[tokio::test]
async fn an_instant_outside_the_availability_is_refused() {
    let (app, world) = app_at_anchor();
    let id = hull(&world);
    // The demo hull's availability runs from 14 days before the anchor to 166
    // days after, so both of these are outside it.
    for offset in [-20 * DAY_MS, 200 * DAY_MS] {
        let at = ANCHOR + offset;
        let (status, body) = get(
            &app,
            &world,
            &format!("/api/vessels/{id}/deck-states?as_of={at}"),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "at {at}");
        assert!(
            body["detail"]
                .as_str()
                .unwrap_or_default()
                .contains("CVN-73"),
            "the refusal names the hull it is refusing for: {body}"
        );
    }
}

/// A malformed instant is a bad request, not a silent fallback to now. Falling
/// back would show a live board while the caller believed they were looking at a
/// projection.
#[tokio::test]
async fn an_unparseable_as_of_is_rejected() {
    let (app, world) = app_at_anchor();
    let id = hull(&world);
    let (status, _) = get(
        &app,
        &world,
        &format!("/api/vessels/{id}/deck-states?as_of=thursday"),
    )
    .await;
    assert!(
        status.is_client_error(),
        "expected a client error, got {status}"
    );
}

fn state_of(rows: &Value, compartment: &str) -> String {
    rows.as_array()
        .expect("deck-states returns an array")
        .iter()
        .find(|r| r["compartment"]["compartment_no"] == compartment)
        .map_or_else(
            || panic!("{compartment} not in deck-states"),
            |r| r["state"].as_str().unwrap_or_default().to_owned(),
        )
}

/// Properties 3 and 4 together, on the two hazards the demo seeds for exactly
/// this purpose: the coat is three hours into an eight-hour cure, and the bus is
/// held on a verified zero-energy state.
#[tokio::test]
async fn scrubbing_past_a_cure_clears_it_but_a_verification_hold_persists() {
    let (app, world) = app_at_anchor();
    let id = hull(&world);

    // Now: the coat is curing, so the deck below it is blocked.
    let (_, now) = get(&app, &world, &format!("/api/vessels/{id}/deck-states")).await;
    assert_eq!(state_of(&now, "4-160-2-Q"), "BLOCK", "coat still curing");
    let bus_now = state_of(&now, "3-148-2-E");
    assert_ne!(bus_now, "ALLOW", "the bus is live");

    // Six hours on, the cure has elapsed — the coat cleared itself and nobody had
    // to do anything.
    let later = ANCHOR + 6 * HOUR_MS;
    let (_, after) = get(
        &app,
        &world,
        &format!("/api/vessels/{id}/deck-states?as_of={later}"),
    )
    .await;
    assert_eq!(
        state_of(&after, "4-160-2-Q"),
        "ALLOW",
        "an elapsed cure holds nothing"
    );

    // The bus does not clear on a clock, so it is exactly as held five months
    // later as it is now. This is the asymmetry the time control exists to show.
    let much_later = ANCHOR + 150 * DAY_MS;
    let (_, far) = get(
        &app,
        &world,
        &format!("/api/vessels/{id}/deck-states?as_of={much_later}"),
    )
    .await;
    assert_eq!(
        state_of(&far, "3-148-2-E"),
        bus_now,
        "a verification hold does not elapse"
    );
}

/// The clock still governs the default. Advancing it past the cure changes the
/// unparameterised answer, which is the check that `as_of` did not accidentally
/// become the only path that consults time.
#[tokio::test]
async fn the_default_answer_follows_the_clock() {
    let (store, world) = InMemoryStore::demo_at(Timestamp::from_epoch_millis(ANCHOR));
    let clock = Arc::new(TestClock::new(Timestamp::from_epoch_millis(ANCHOR)));
    let state = wadl_api::AppState::new(Arc::new(store), clock.clone());
    let app = wadl_api::build_router(state);
    let id = hull(&world);

    let (_, before) = get(&app, &world, &format!("/api/vessels/{id}/deck-states")).await;
    assert_eq!(state_of(&before, "4-160-2-Q"), "BLOCK");

    clock.advance(Minutes::new(6 * 60));
    let (_, after) = get(&app, &world, &format!("/api/vessels/{id}/deck-states")).await;
    assert_eq!(state_of(&after, "4-160-2-Q"), "ALLOW");
}

/// The work-order list at an instant: how many rows came back, and which of them
/// are in their planned window. `at` of `None` omits the parameter entirely.
async fn work_orders_at(
    app: &axum::Router,
    world: &DemoWorld,
    at: Option<i64>,
) -> (usize, Vec<String>) {
    let id = hull(world);
    let path = match at {
        Some(ms) => format!("/api/vessels/{id}/work-orders?as_of={ms}"),
        None => format!("/api/vessels/{id}/work-orders"),
    };
    let (status, rows) = get(app, world, &path).await;
    assert_eq!(status, StatusCode::OK, "{path}");
    let rows = rows.as_array().expect("array").clone();
    let in_window = rows
        .iter()
        .filter(|r| r["in_window"] == Value::Bool(true))
        .map(|r| r["code"].as_str().unwrap_or_default().to_owned())
        .collect();
    (rows.len(), in_window)
}

/// Work-order rows are marked, never dropped.
///
/// Asserted as the property rather than against the seed's dates: the row count
/// is identical at every instant, and *which* orders are in their window changes.
/// An earlier version of this test pinned "at day 100 nothing is in window" and
/// broke the moment the demo schedule was widened — the test failing on the data
/// instead of on the behaviour it exists to protect.
#[tokio::test]
async fn work_orders_are_marked_in_window_rather_than_filtered() {
    let (app, world) = app_at_anchor();

    let (n_now, now_open) = work_orders_at(&app, &world, Some(ANCHOR)).await;
    let (n_later, later_open) = work_orders_at(&app, &world, Some(ANCHOR + 45 * DAY_MS)).await;

    assert_eq!(n_now, n_later, "the list is never filtered by the instant");
    assert!(
        !now_open.is_empty(),
        "some work is in progress at the anchor"
    );
    assert_ne!(
        now_open, later_open,
        "six weeks on, a different set of orders is in progress"
    );

    // And the unparameterised call agrees with asking for the clock's instant.
    let (n_live, live_open) = work_orders_at(&app, &world, None).await;
    assert_eq!((n_live, live_open), (n_now, now_open));
}

/// The shell builds its whole time control from this one read, so it has to carry
/// both the server's clock and the bounds it will refuse outside of.
#[tokio::test]
async fn timeframe_serves_the_clock_and_the_availability() {
    let (app, world) = app_at_anchor();
    let id = hull(&world);
    let (status, body) = get(&app, &world, &format!("/api/vessels/{id}/timeframe")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["now"], Value::from(ANCHOR));
    assert_eq!(body["availability_code"], "PIA-26");
    let start = body["availability"]["start"].as_i64().expect("start");
    let end = body["availability"]["end"].as_i64().expect("end");
    assert!(start < ANCHOR && ANCHOR < end, "now sits inside the window");
    // And the bounds it reports are exactly the bounds it enforces.
    let (inside, _) = get(
        &app,
        &world,
        &format!("/api/vessels/{id}/deck-states?as_of={}", end - 1),
    )
    .await;
    assert_eq!(
        inside,
        StatusCode::OK,
        "the last instant inside is accepted"
    );
    let (outside, _) = get(
        &app,
        &world,
        &format!("/api/vessels/{id}/deck-states?as_of={end}"),
    )
    .await;
    assert_eq!(
        outside,
        StatusCode::UNPROCESSABLE_ENTITY,
        "the window is half-open, so its end is outside it"
    );
}
