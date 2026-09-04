//! The yard-clock door, and what changes once a hull has a clock: the
//! timeframe carries it, the XER door reads the export's wall clock in it
//! and remembers which one, the reference hull boots with its own, and
//! reverting returns every clock to honest UTC.

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
use serde_json::{json, Value};
use tower::ServiceExt;
use wadl_domain::civil;
use wadl_domain::time::{TestClock, Timestamp};
use wadl_store::memory::{DemoWorld, InMemoryStore, DEMO_ANCHOR_MS};

/// The seed world at its fixed anchor, 2026-05-13 05:15Z — 01:15 in Norfolk.
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
        .uri(format!("/api/vessels/{}{path}", world.cvn73.as_uuid()))
        .header("x-org-id", world.yard_org.as_uuid().to_string())
        .header("x-assigned-vessels", world.cvn73.as_uuid().to_string())
        .header("content-type", "application/json")
        .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
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

fn norfolk_clock() -> Value {
    json!({
        "zone": "America/New_York",
        "standard_offset_minutes": -300,
        "daylight": {
            "offset_minutes": -240,
            "start": { "month": 3, "week": 2, "weekday": 0, "minute_of_day": 120 },
            "end": { "month": 11, "week": 1, "weekday": 0, "minute_of_day": 120 }
        },
        "watch_minutes": 240,
        "shifts": [
            { "name": "Days", "start_minute": 420, "length_minutes": 510 },
            { "name": "Swing", "start_minute": 930, "length_minutes": 510 },
            { "name": "Mids", "start_minute": 0, "length_minutes": 420 }
        ]
    })
}

fn guam_clock() -> Value {
    json!({
        "zone": "Pacific/Guam",
        "standard_offset_minutes": 600,
        "daylight": null,
        "watch_minutes": 240,
        "shifts": [
            { "name": "Days", "start_minute": 360, "length_minutes": 720 },
            { "name": "Nights", "start_minute": 1080, "length_minutes": 720 }
        ]
    })
}

/// A one-task export at chosen wall times.
fn xer_at(code: &str, start: &str, end: &str) -> String {
    format!(
        "ERMHDR\t19.12\t2026-08-10\tProject\tadmin\tA.PLANNER\tShipyard Planning\tUSD\n\
%T\tPROJECT\n%F\tproj_id\tproj_short_name\n%R\t4410\tCVN73-TEST\n\
%T\tUDFTYPE\n%F\tudf_type_id\tudf_type_name\tudf_type_label\tlogical_data_type\n%R\t901\tcompartment\tCompartment\tFT_TEXT\n\
%T\tTASK\n%F\ttask_id\tproj_id\ttask_code\ttask_name\ttask_type\tstatus_code\tearly_start_date\tearly_end_date\n\
%R\t900001\t4410\t{code}\tShaft alley weld\tTT_Task\tTK_NotStart\t{start}\t{end}\n\
%T\tUDFVALUE\n%F\tudf_type_id\tfk_id\tproj_id\tudf_text\n%R\t901\t900001\t4410\t3-160-2-Q\n%E\n"
    )
}

/// `2026-08-10 10:00Z` as epoch ms, from the domain's own civil arithmetic.
fn zulu(date: &str, minute: i64) -> i64 {
    let mut parts = date.split('-').map(|p| p.parse::<i64>().unwrap());
    let (y, m, d) = (
        parts.next().unwrap(),
        parts.next().unwrap(),
        parts.next().unwrap(),
    );
    let days = civil::days_from_civil(
        i32::try_from(y).unwrap(),
        u8::try_from(m).unwrap(),
        u8::try_from(d).unwrap(),
    );
    (days * 1440 + minute) * 60_000
}

async fn ledger_actions(app: &axum::Router, w: &DemoWorld) -> Vec<(String, String)> {
    let (_, ledger) = call(app, w, "GET", "/ledger", None).await;
    ledger["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            (
                e["action"].as_str().unwrap().to_owned(),
                e["detail"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

#[tokio::test]
async fn the_door_refuses_a_malformed_clock_whole() {
    let (app, w) = app();
    let mut bad = norfolk_clock();
    bad["watch_minutes"] = json!(100);
    bad["zone"] = json!("Norfolk");
    bad["shifts"]
        .as_array_mut()
        .unwrap()
        .push(json!({ "name": "Days", "start_minute": 0, "length_minutes": 60 }));
    let (status, body) = call(
        &app,
        &w,
        "POST",
        "/yard-clock",
        Some(json!({ "label": "bad-clock.csv", "clock": bad })),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    let detail = body["detail"].as_str().unwrap();
    assert!(
        detail.starts_with("the clock was refused whole:"),
        "{detail}"
    );
    assert!(detail.contains("100 min"), "{detail}");
    assert!(detail.contains("Area/City"), "{detail}");
    assert!(detail.contains("Days is listed twice"), "{detail}");

    // Nothing stored: the seed's own clock still stands.
    let (_, after) = call(&app, &w, "GET", "/yard-clock", None).await;
    assert_eq!(after["source"], "document");
    assert_eq!(after["label"], "seed · Norfolk");
    assert!(ledger_actions(&app, &w).await.is_empty());
}

#[tokio::test]
async fn a_dry_run_previews_transitions_and_stores_nothing() {
    let (app, w) = app();
    let (status, body) = call(
        &app,
        &w,
        "POST",
        "/yard-clock?dry_run=true",
        Some(json!({ "label": "CVN73-clock.csv", "clock": norfolk_clock() })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["stored"], false);
    assert_eq!(body["label"], "CVN73-clock.csv");
    assert_eq!(body["findings"], json!([]), "three shifts cover the day");
    let preview = &body["preview"];
    assert_eq!(preview["now_local"], "2026-05-13 01:15");
    assert_eq!(preview["offset_now"], "UTC−04:00");
    let transitions = preview["transitions"].as_array().unwrap();
    assert_eq!(transitions.len(), 2, "{preview}");
    assert_eq!(transitions[0]["local"], "2026-03-08 02:00 → 03:00");
    assert_eq!(transitions[0]["to"], "UTC−04:00");
    assert_eq!(transitions[1]["local"], "2026-11-01 02:00 → 01:00");
    assert_eq!(transitions[1]["to"], "UTC−05:00");
    assert_eq!(transitions[1]["at_ms"], zulu("2026-11-01", 360));
    let shifts = preview["shifts_today"].as_array().unwrap();
    assert_eq!(shifts[0]["name"], "Days");
    assert_eq!(shifts[0]["local"], "07:00–15:30");
    assert_eq!(shifts[0]["start_ms"], zulu("2026-05-13", 660), "07:00 EDT");
    assert_eq!(shifts[1]["local"], "15:30–24:00");
    assert_eq!(shifts[2]["local"], "00:00–07:00");
    assert!(preview["schedule_of_record"].is_null(), "no export loaded");

    let (_, after) = call(&app, &w, "GET", "/yard-clock", None).await;
    assert_eq!(after["label"], "seed · Norfolk", "dry run must not store");
    assert!(ledger_actions(&app, &w).await.is_empty());

    // A two-shift yard leaves the night open: a finding, not a refusal.
    let mut two = norfolk_clock();
    two["shifts"].as_array_mut().unwrap().truncate(2);
    let (status, body) = call(
        &app,
        &w,
        "POST",
        "/yard-clock?dry_run=true",
        Some(json!({ "label": "two.csv", "clock": two })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["findings"][0]["severity"], "warn");
    assert_eq!(
        body["findings"][0]["text"],
        "the shifts leave 00:00–07:00 uncovered"
    );
}

#[tokio::test]
async fn a_commit_is_ledgered_and_a_revert_returns_to_utc() {
    let (app, w) = app();
    let (status, body) = call(
        &app,
        &w,
        "POST",
        "/yard-clock",
        Some(json!({ "label": "CVN73-guam.csv", "clock": guam_clock() })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["stored"], true);

    let (_, served) = call(&app, &w, "GET", "/yard-clock", None).await;
    assert_eq!(served["source"], "document");
    assert_eq!(served["label"], "CVN73-guam.csv");
    assert_eq!(served["clock"]["zone"], "Pacific/Guam");
    assert_eq!(served["offset_now"], "UTC+10:00");
    assert_eq!(served["now_local"], "2026-05-13 15:15");

    let actions = ledger_actions(&app, &w).await;
    assert_eq!(actions.len(), 1);
    assert_eq!(actions[0].0, "DOCUMENT_REPLACED");
    let detail: Value = serde_json::from_str(&actions[0].1).unwrap();
    assert_eq!(detail["kind"], "yard_clock");
    assert_eq!(detail["label"], "CVN73-guam.csv");
    assert_eq!(detail["counts"]["zone"], "Pacific/Guam");
    assert_eq!(detail["counts"]["shifts"], 2);

    let (status, body) = call(&app, &w, "POST", "/yard-clock/revert", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["reverted"], true);
    let (_, after) = call(&app, &w, "GET", "/yard-clock", None).await;
    assert_eq!(after["source"], "default_utc");
    assert!(after["label"].is_null());
    assert_eq!(after["clock"]["zone"], "UTC");
    assert_eq!(after["offset_now"], "UTC+00:00");
    assert_eq!(after["now_local"], "2026-05-13 05:15");
    let actions = ledger_actions(&app, &w).await;
    assert_eq!(actions[0].0, "DOCUMENT_REVERTED", "newest first");
    assert!(actions[0].1.contains("\"yard_clock\""));
}

#[tokio::test]
async fn the_timeframe_carries_the_clock_in_effect() {
    let (app, w) = app();
    let (status, frame) = call(&app, &w, "GET", "/timeframe", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        frame["now"], DEMO_ANCHOR_MS,
        "the fields the shell already reads"
    );
    assert_eq!(frame["yard_clock"]["source"], "document");
    assert_eq!(frame["yard_clock"]["label"], "seed · Norfolk");
    assert_eq!(frame["yard_clock"]["clock"]["zone"], "America/New_York");
    assert_eq!(frame["yard_clock"]["clock"]["watch_minutes"], 240);
    assert_eq!(frame["yard_clock"]["clock"]["shifts"][2]["name"], "Mids");

    call(&app, &w, "POST", "/yard-clock/revert", None).await;
    let (_, frame) = call(&app, &w, "GET", "/timeframe", None).await;
    assert_eq!(frame["yard_clock"]["source"], "default_utc");
    assert_eq!(frame["yard_clock"]["clock"]["zone"], "UTC");
    assert!(frame["yard_clock"]["clock"]["daylight"].is_null());
}

#[tokio::test]
async fn the_schedule_door_parses_the_xer_in_the_yard_clock() {
    let (app, w) = app();
    call(
        &app,
        &w,
        "POST",
        "/yard-clock",
        Some(json!({ "label": "CVN73-clock.csv", "clock": norfolk_clock() })),
    )
    .await;

    // A 06:00 start on a Norfolk summer day is 10:00Z.
    let (status, body) = call(
        &app,
        &w,
        "POST",
        "/schedule-of-record",
        Some(json!({ "label": "wk1.xer", "xer": xer_at("A10", "2026-08-10 06:00", "2026-08-10 14:00") })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["clock"]["zone"], "America/New_York");
    assert_eq!(body["clock"]["label"], "CVN73-clock.csv");
    assert_eq!(body["wall_clock_findings"], json!([]));

    let (_, register) = call(&app, &w, "GET", "/activities", None).await;
    let row = register["activities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["code"] == "A10")
        .unwrap();
    assert_eq!(row["planned"]["start"], zulu("2026-08-10", 600), "10:00Z");
    assert_eq!(row["planned"]["end"], zulu("2026-08-10", 1080), "18:00Z");

    // The record remembers its clock, on the ledger too.
    let actions = ledger_actions(&app, &w).await;
    let (action, detail) = actions
        .iter()
        .find(|(a, _)| a == "SCHEDULE_REPLACED")
        .unwrap();
    assert_eq!(action, "SCHEDULE_REPLACED");
    let detail: Value = serde_json::from_str(detail).unwrap();
    assert_eq!(detail["parsed_in"], "America/New_York · CVN73-clock.csv");

    // A start the clock skipped: accepted, read as standard, and said so —
    // in the dry run, before Confirm.
    let (status, preview) = call(
        &app,
        &w,
        "POST",
        "/schedule-of-record?dry_run=true",
        Some(json!({ "label": "wk2.xer", "xer": xer_at("A10", "2026-03-08 02:30", "2026-03-08 09:00") })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    let findings = preview["wall_clock_findings"].as_array().unwrap();
    assert_eq!(findings.len(), 1, "{preview}");
    let finding = findings[0].as_str().unwrap();
    assert!(
        finding.contains("A10 start 2026-03-08 02:30 does not exist in America/New_York"),
        "{finding}"
    );
    assert!(
        finding.ends_with("read as 02:30 standard (07:30Z)"),
        "{finding}"
    );
}

#[tokio::test]
async fn the_clock_door_warns_when_the_schedule_was_parsed_elsewhere() {
    let (app, w) = app();
    // The seed clock is Norfolk; the export is read in it.
    let (status, body) = call(
        &app,
        &w,
        "POST",
        "/schedule-of-record",
        Some(json!({ "label": "wk1.xer", "xer": xer_at("A10", "2026-08-10 06:00", "2026-08-10 14:00") })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["clock"]["label"], "seed · Norfolk");

    // Loading a Guam clock now would leave every served instant four hours
    // out: the dry run names the re-import before anything is stored.
    let (status, body) = call(
        &app,
        &w,
        "POST",
        "/yard-clock?dry_run=true",
        Some(json!({ "label": "CVN73-guam.csv", "clock": guam_clock() })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let texts: Vec<&str> = body["findings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["text"].as_str().unwrap())
        .collect();
    assert!(
        texts.iter().any(|t| t.starts_with(
            "the schedule of record wk1.xer was parsed in America/New_York — re-import wk1.xer"
        )),
        "{texts:?}"
    );
    assert_eq!(
        body["preview"]["schedule_of_record"]["parsed_in"],
        "America/New_York · seed · Norfolk"
    );

    // The same zone again is not a finding.
    let (_, body) = call(
        &app,
        &w,
        "POST",
        "/yard-clock?dry_run=true",
        Some(json!({ "label": "CVN73-clock.csv", "clock": norfolk_clock() })),
    )
    .await;
    assert_eq!(body["findings"], json!([]), "{body}");
}

#[tokio::test]
async fn the_reference_hull_boots_with_its_clock() {
    let (store, world) = InMemoryStore::demo_at(Timestamp::from_epoch_millis(DEMO_ANCHOR_MS));
    let store = Arc::new(store);
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../reference/cvn73");
    let loaded = wadl_api::documents::load_demo_docs(
        store.as_ref(),
        &world.yard_scope(),
        world.cvn73,
        &dir,
        DEMO_ANCHOR_MS,
    )
    .await
    .expect("the reference hull loads through the doors");
    assert_eq!(
        loaded.clock,
        Some((
            "CVN73-clock.csv".to_owned(),
            "America/New_York".to_owned(),
            3
        ))
    );

    // The export that boots after it is read in it: the sample's A1010
    // actual start, 2026-08-01 06:30 wall, is 10:30Z.
    let sample = include_str!("../../../reference/p6-sample/CVN73-PIA26.xer");
    let schedule =
        wadl_api::schedule::load_xer(store.as_ref(), world.cvn73, "CVN73-PIA26.xer", sample)
            .expect("the sample ingests whole");
    assert_eq!(schedule.parsed_in, "America/New_York · CVN73-clock.csv");
    assert_eq!(schedule.activities, 18);

    let clock = TestClock::new(Timestamp::from_epoch_millis(DEMO_ANCHOR_MS));
    let repos: Arc<dyn wadl_store::Repositories> = store.clone();
    let app = wadl_api::build_router(wadl_api::AppState::new(repos, Arc::new(clock)));
    let (status, frame) = call(&app, &world, "GET", "/timeframe", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(frame["yard_clock"]["source"], "document");
    assert_eq!(frame["yard_clock"]["label"], "CVN73-clock.csv");
    assert_eq!(frame["yard_clock"]["clock"]["zone"], "America/New_York");

    let (_, register) = call(&app, &world, "GET", "/activities", None).await;
    let a1010 = register["activities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["code"] == "A1010")
        .unwrap();
    assert_eq!(a1010["planned"]["start"], zulu("2026-08-01", 630), "10:30Z");
}
