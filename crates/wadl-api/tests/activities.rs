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

/// The issue board endpoint: ranked worst-first, every row a typed claim.
#[tokio::test]
async fn the_issue_board_is_ranked_and_typed() {
    let (app, world) = app_at_anchor();
    let (status, body) = get(
        &app,
        &world,
        &format!("/api/vessels/{}/issues", world.cvn73.as_uuid()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let issues = body["issues"].as_array().expect("issues array");
    assert!(!issues.is_empty(), "the demo hull carries live hazards");
    let known = [
        "not_executable_as_planned",
        "held_with_crews_booked",
        "compound_hold",
        "stranding_concentration",
        "negative_lag",
    ];
    let mut previous = i64::MAX;
    for issue in issues {
        let kind = issue["kind"].as_str().expect("typed");
        assert!(known.contains(&kind), "unknown kind {kind}");
        let hours = issue["hours_at_risk"].as_i64().expect("ranked by hours");
        assert!(hours <= previous, "not ranked worst-first");
        previous = hours;
    }
    // The demo's standing stories must all surface: crews held by the bus,
    // activities the coating/bus hazards make non-executable, and the
    // deliberate overlap-into-a-cure the generated schedule edges carry.
    let kinds: Vec<&str> = issues
        .iter()
        .map(|i| i["kind"].as_str().unwrap_or_default())
        .collect();
    assert!(kinds.contains(&"held_with_crews_booked"), "{kinds:?}");
    assert!(kinds.contains(&"not_executable_as_planned"), "{kinds:?}");
    assert!(kinds.contains(&"negative_lag"), "{kinds:?}");
    // And the finding's codes must resolve in the register the same response
    // family serves — a finding naming an unknown activity is noise.
    let lag = issues
        .iter()
        .find(|i| i["kind"] == "negative_lag")
        .expect("asserted present");
    let (activities_status, activities) = get(
        &app,
        &world,
        &format!("/api/vessels/{}/activities", world.cvn73.as_uuid()),
    )
    .await;
    assert_eq!(activities_status, StatusCode::OK);
    let codes: Vec<&str> = activities["activities"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["code"].as_str().unwrap_or_default())
        .collect();
    assert!(codes.contains(&lag["pred"].as_str().unwrap()), "{lag}");
    assert!(codes.contains(&lag["succ"].as_str().unwrap()), "{lag}");
    assert_eq!(
        body["hours_at_risk"].as_i64().unwrap(),
        issues
            .iter()
            .map(|i| i["hours_at_risk"].as_i64().unwrap())
            .sum::<i64>()
    );
}

const SAMPLE_XER: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../reference/p6-sample/CVN73-PIA26.xer"
));

/// The seam the generator was built to survive, exercised end to end: a real
/// P6 export becomes the schedule of record, and the same endpoints serve it —
/// same shapes, same derivations — while reconciliation stops being true by
/// construction and becomes a report.
#[tokio::test]
async fn an_ingested_export_replaces_the_register_without_changing_the_screen() {
    // The generated register first: no source label, and reconciliation is
    // empty by construction.
    let (app, world) = app_at_anchor();
    let base = format!("/api/vessels/{}/activities", world.cvn73.as_uuid());
    let (_, body) = get(&app, &world, &base).await;
    assert!(body["schedule_source"].is_null());
    assert_eq!(
        body["reconciliation"]["mismatches"]
            .as_array()
            .unwrap()
            .len(),
        0,
        "the generated register reconciles by construction: {}",
        body["reconciliation"]
    );

    // Now the sample export as the schedule of record.
    let (store, world) = InMemoryStore::demo_at(Timestamp::from_epoch_millis(DEMO_ANCHOR_MS));
    wadl_api::schedule::load_xer(&store, world.cvn73, "CVN73-PIA26.xer", SAMPLE_XER)
        .expect("the sample ingests whole");
    let clock = TestClock::new(Timestamp::from_epoch_millis(DEMO_ANCHOR_MS));
    let state = wadl_api::AppState::new(Arc::new(store), Arc::new(clock));
    let app = wadl_api::build_router(state);

    let (status, body) = get(&app, &world, &base).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["schedule_source"], "CVN73-PIA26.xer");
    let rows = body["activities"].as_array().unwrap();
    assert_eq!(rows.len(), 18, "the export's rows, not the generator's");
    for row in rows {
        assert!(
            row["executability"]["verdict"].is_string(),
            "{}: the derivations run unchanged over ingested rows",
            row["code"]
        );
    }
    // The report says what the export does not cover: the six work orders
    // reconcile (the sample mirrors their hours), the two distributed packages
    // are absent from it, and the unmapped activity's hours are counted.
    let mismatches: Vec<&str> = body["reconciliation"]["mismatches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["code"].as_str().unwrap())
        .collect();
    assert!(!mismatches.contains(&"WI-3318"), "{mismatches:?}");
    assert!(mismatches.contains(&"WI-2201"), "{mismatches:?}");
    assert!(
        body["reconciliation"]["unmapped_budget_hours"]
            .as_i64()
            .unwrap()
            > 0,
        "A6010 is deliberately unmapped"
    );

    // And the issue board carries the file's own inversion, not the generated one.
    let (_, issues) = get(
        &app,
        &world,
        &format!("/api/vessels/{}/issues", world.cvn73.as_uuid()),
    )
    .await;
    let lag = issues["issues"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["kind"] == "negative_lag")
        .expect("the sample carries A6010 -> A4050");
    assert_eq!(lag["pred"], "A6010");
    assert_eq!(lag["succ"], "A4050");
    assert_eq!(lag["lag_hours"], -8);
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

async fn post(
    app: &axum::Router,
    world: &DemoWorld,
    path: &str,
    body: Value,
) -> (StatusCode, Value) {
    let request = Request::builder()
        .method("POST")
        .uri(path)
        .header("x-org-id", world.yard_org.as_uuid().to_string())
        .header("x-assigned-vessels", world.cvn73.as_uuid().to_string())
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
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

/// The issue lifecycle: an acknowledgement lands in the audit ledger and joins
/// back onto the board's next read by the issue's stable key — the issue keeps
/// deriving (nothing is closed or hidden), it just carries who answered for it.
/// A key not on the board is refused, like a decision on an option not on offer.
#[tokio::test]
async fn an_acknowledgement_joins_the_ledger_to_the_board() {
    let (app, world) = app_at_anchor();
    let issues_path = format!("/api/vessels/{}/issues", world.cvn73.as_uuid());
    let ack_path = format!("{issues_path}/acknowledge");

    let (_, before) = get(&app, &world, &issues_path).await;
    let rows = before["issues"].as_array().expect("issues array");
    let first = &rows[0];
    let key = first["key"].as_str().expect("every issue carries its key");
    assert!(key.starts_with("issue:"), "{key}");
    assert!(
        first["acknowledged"].is_null(),
        "nothing acknowledged yet: {first}"
    );

    let (status, recorded) = post(
        &app,
        &world,
        &ack_path,
        serde_json::json!({ "key": key, "note": "raised at the 0700" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{recorded}");
    assert_eq!(recorded["recorded"]["action"], "ISSUE_ACKNOWLEDGED");
    assert!(
        recorded["recorded"]["entry_hash"].is_string(),
        "chained: {recorded}"
    );

    // The board's next read carries it, on the same row, and the row is still
    // there — acknowledged, not hidden.
    let (_, after) = get(&app, &world, &issues_path).await;
    let row = after["issues"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["key"] == key)
        .expect("the issue still derives");
    assert_eq!(row["acknowledged"]["note"], "raised at the 0700");
    assert!(row["acknowledged"]["at"].is_i64());

    // A key that names no current finding is refused with the reason.
    let (status, _) = post(
        &app,
        &world,
        &ack_path,
        serde_json::json!({ "key": "issue:held:9-999-9-Z", "note": "" }),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

/// The ledger read: every recorded entry, newest first, with the chain
/// re-verified server-side on the same read — showing records without
/// checking the chain would repeat the ledger's claim on faith.
#[tokio::test]
async fn the_ledger_serves_verified_entries() {
    let (app, world) = app_at_anchor();
    let issues_path = format!("/api/vessels/{}/issues", world.cvn73.as_uuid());
    let ledger_path = format!("/api/vessels/{}/ledger", world.cvn73.as_uuid());

    // Record two acknowledgements so the chain has links to verify.
    let (_, board) = get(&app, &world, &issues_path).await;
    let keys: Vec<String> = board["issues"]
        .as_array()
        .unwrap()
        .iter()
        .take(2)
        .map(|i| i["key"].as_str().unwrap().to_owned())
        .collect();
    for key in &keys {
        let (status, _) = post(
            &app,
            &world,
            &format!("{issues_path}/acknowledge"),
            serde_json::json!({ "key": key, "note": "ledger test" }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }

    let (status, body) = get(&app, &world, &ledger_path).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["verified"], true, "{body}");
    assert!(body["break"].is_null());
    let entries = body["entries"].as_array().unwrap();
    assert!(entries.len() >= 2);
    // Newest first, and the acks are on top with their subjects.
    assert_eq!(entries[0]["action"], "ISSUE_ACKNOWLEDGED");
    let subjects: Vec<&str> = entries
        .iter()
        .filter_map(|e| e["subject_ref"].as_str())
        .collect();
    for key in &keys {
        assert!(subjects.contains(&key.as_str()), "{subjects:?}");
    }
    // Every entry is chained: a hash of its own, linked to the previous.
    for e in entries {
        assert!(e["entry_hash"].is_string());
    }
}

/// The import door's location-mapping report: how the export's work landed on
/// the hull, graded per path, visible in the dry run BEFORE anything is
/// stored. The dominant risk of every P6 import is WHERE, and one
/// located/unlocated number would bury the difference between the schedule
/// saying so and this parser guessing.
#[tokio::test]
async fn the_dry_run_reports_the_location_mapping() {
    let (app, world) = app_at_anchor();
    let (status, preview) = post(
        &app,
        &world,
        &format!(
            "/api/vessels/{}/schedule-of-record?dry_run=true",
            world.cvn73.as_uuid()
        ),
        serde_json::json!({ "label": "CVN73-PIA26.xer", "xer": SAMPLE_XER }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    let m = &preview["mapping"];
    assert_eq!(m["work_activities"], 15, "{m}");
    assert_eq!(m["milestones"], 3);
    // Thirteen located by the dedicated UDF — the schedule saying where.
    assert_eq!(m["located_authored"], 13, "{m}");
    // One located out of its own task name — the guess, listed so a reader
    // can inspect and refuse it.
    let derived = m["located_derived"].as_array().unwrap();
    assert_eq!(derived.len(), 1, "{m}");
    assert_eq!(derived[0]["activity"], "A4040");
    assert_eq!(derived[0]["compartment"], "3-185-0-L");
    // One row the schedule never located — but its WBS bucket names a real
    // zone of this hull, so it carries the hint: zone grain, never a place.
    let unlocated = m["unlocated"].as_array().unwrap();
    assert_eq!(unlocated.len(), 1, "{m}");
    assert_eq!(unlocated[0]["activity"], "A2020");
    assert_eq!(unlocated[0]["zone_hint"], "Z5");
    // Every located space is one the register knows.
    assert_eq!(m["unknown_spaces"].as_array().unwrap().len(), 0, "{m}");
}
