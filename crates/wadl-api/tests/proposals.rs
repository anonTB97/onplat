//! Schedule change proposals: the path from a refusal on the board back to
//! P6. A proposal is engine-checked, ledgered, listed with a status the
//! served schedule decides, withdrawable by a later entry, and reflected
//! back at the XER door when the next export carries the proposed days.

#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines
)]

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{json, Value};
use tower::ServiceExt;
use wadl_domain::time::{TestClock, Timestamp};
use wadl_store::memory::{DemoWorld, InMemoryStore, DEMO_ANCHOR_MS};

const DAY: i64 = 86_400_000;

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
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 22)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// A refused activity on the seeded register, with its engine alternative.
async fn a_refusal(app: &axum::Router, w: &DemoWorld) -> Value {
    let (_, alts) = call(app, w, "GET", "/schedule-alternatives", None).await;
    alts["alternatives"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["alternative"]["kind"] == "viable")
        .cloned()
        .expect("the seed refuses something the engine can re-sequence")
}

#[tokio::test]
async fn a_proposal_is_engine_checked_ledgered_and_listed_open() {
    let (app, w) = app();
    let alt = a_refusal(&app, &w).await;
    let code = alt["activity"].as_str().unwrap();
    let window = &alt["alternative"]["window"];

    // Refused without a reason: P6 will be asked to move work on it.
    let (status, body) = call(
        &app,
        &w,
        "POST",
        "/schedule-proposals",
        Some(json!({ "activity": code, "start_ms": window["start"], "end_ms": window["end"], "kind": "engine_window", "reason": "  " })),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");

    let (status, body) = call(
        &app,
        &w,
        "POST",
        "/schedule-proposals",
        Some(json!({
            "activity": code,
            "start_ms": window["start"],
            "end_ms": window["end"],
            "kind": "engine_window",
            "reason": "slide to the engine's window — the coat clears first",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let p = &body["proposal"];
    assert_eq!(p["activity"], code);
    assert_eq!(p["status"], "open");
    assert_eq!(p["kind"], "engine_window");
    // The engine re-accepted the window it proposed.
    assert_eq!(p["verdict"]["verdict"], "executable", "{p}");
    assert!(p["seq"].is_i64() && p["entry_hash"].is_string());
    assert_eq!(body["recorded"]["action"], "SCHEDULE_CHANGE_PROPOSED");
    assert_eq!(body["recorded"]["subject_ref"], code);

    // A planner's own window is checked the same way and recorded with the
    // engine's verdict on it — the planner is told, never stopped.
    let planned = &alt["planned"];
    let (status, body) = call(
        &app,
        &w,
        "POST",
        "/schedule-proposals",
        Some(json!({
            "activity": code,
            "start_ms": planned["start"].as_i64().unwrap() + 3 * DAY,
            "end_ms": planned["end"].as_i64().unwrap() + 3 * DAY,
            "kind": "manual",
            "reason": "three days later suits the crew",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["proposal"]["verdict"]["verdict"].is_string(), "{body}");
    assert_eq!(body["proposal"]["status"], "open");

    let (_, list) = call(&app, &w, "GET", "/schedule-proposals", None).await;
    assert_eq!(list["counts"]["open"], 2, "{list}");
    assert_eq!(list["proposals"][0]["kind"], "manual", "newest first");

    // Withdrawn by a later entry; the original stays in the chain.
    let seq = list["proposals"][1]["seq"].as_i64().unwrap();
    let (status, _) = call(
        &app,
        &w,
        "POST",
        "/schedule-proposals/withdraw",
        Some(json!({ "seq": seq, "reason": "superseded by the manual one" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, list) = call(&app, &w, "GET", "/schedule-proposals", None).await;
    assert_eq!(list["counts"]["open"], 1);
    assert_eq!(list["counts"]["withdrawn"], 1);
    let (_, ledger) = call(&app, &w, "GET", "/ledger", None).await;
    assert_eq!(ledger["verified"], true);
    let actions: Vec<&str> = ledger["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["action"].as_str().unwrap())
        .collect();
    assert!(
        actions.contains(&"SCHEDULE_CHANGE_WITHDRAWN")
            && actions.contains(&"SCHEDULE_CHANGE_PROPOSED")
    );

    // An unknown activity, a backwards window, a bad kind: refused whole.
    for bad in [
        json!({ "activity": "NOPE", "start_ms": 1, "end_ms": 2, "kind": "manual", "reason": "x" }),
        json!({ "activity": code, "start_ms": 2, "end_ms": 1, "kind": "manual", "reason": "x" }),
        json!({ "activity": code, "start_ms": 1, "end_ms": 2, "kind": "wish", "reason": "x" }),
    ] {
        let (status, _) = call(&app, &w, "POST", "/schedule-proposals", Some(bad)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    }
}

#[tokio::test]
async fn a_hold_pending_verification_carries_no_date() {
    let (app, w) = app();
    let alt = a_refusal(&app, &w).await;
    let code = alt["activity"].as_str().unwrap();
    let (status, body) = call(
        &app,
        &w,
        "POST",
        "/schedule-proposals",
        Some(json!({ "activity": code, "kind": "hold_pending_verification", "reason": "clears on the chemist's word, not a clock" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["proposal"]["to"].is_null());
    assert!(body["proposal"]["verdict"].is_null());
    assert_eq!(body["proposal"]["status"], "open");
}

/// A minimal XER carrying one activity at a chosen window — enough for the
/// door to reflect a proposal against.
fn xer_with(code: &str, name: &str, compartment: &str, start_ms: i64, end_ms: i64) -> String {
    let fmt = |ms: i64| {
        let days = ms.div_euclid(DAY);
        let rem = ms.rem_euclid(DAY);
        // Civil date from days since the epoch (proleptic Gregorian).
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
        let y = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        let y = if m <= 2 { y + 1 } else { y };
        format!(
            "{y:04}-{m:02}-{d:02} {:02}:{:02}",
            rem / 3_600_000,
            (rem % 3_600_000) / 60_000
        )
    };
    format!(
        "ERMHDR\t19.12\t2026-08-10\tProject\tadmin\tA.PLANNER\tShipyard Planning\tUSD\n\
%T\tPROJECT\n%F\tproj_id\tproj_short_name\tproj_name\tplan_start_date\tplan_end_date\tclndr_id\tlast_recalc_date\n\
%R\t4410\tCVN73-TEST\tTest\t2026-07-27 06:00\t2027-01-23 18:00\t101\t2026-08-10 06:00\n\
%T\tPROJWBS\n%F\twbs_id\tproj_id\tparent_wbs_id\twbs_short_name\twbs_name\n%R\t9000\t4410\t\tTEST\tTest\n\
%T\tRSRC\n%F\trsrc_id\trsrc_short_name\trsrc_name\trsrc_type\tclndr_id\n%R\t7001\tSM-PRES\tPreservation\tRT_Labor\t101\n\
%T\tUDFTYPE\n%F\tudf_type_id\tudf_type_name\tudf_type_label\tlogical_data_type\n%R\t901\tcompartment\tCompartment\tFT_TEXT\n\
%T\tTASK\n%F\ttask_id\tproj_id\twbs_id\tclndr_id\ttask_code\ttask_name\ttask_type\tstatus_code\ttarget_start_date\ttarget_end_date\tearly_start_date\tearly_end_date\tact_start_date\tact_end_date\tcstr_type\tcstr_date\tphys_complete_pct\n\
%R\t900001\t4410\t9000\t101\t{code}\t{name}\tTT_Task\tTK_NotStart\t{s}\t{e}\t{s}\t{e}\t\t\t\t\t0\n\
%T\tTASKPRED\n%F\ttask_pred_id\ttask_id\tpred_task_id\tproj_id\tpred_proj_id\tpred_type\tlag_hr_cnt\n\
%T\tTASKRSRC\n%F\ttaskrsrc_id\ttask_id\tproj_id\trsrc_id\ttarget_qty\tact_reg_qty\tremain_qty\n%R\t980000\t900001\t4410\t7001\t40\t0\t40\n\
%T\tUDFVALUE\n%F\tudf_type_id\tfk_id\tproj_id\tudf_text\n%R\t901\t900001\t4410\t{compartment}\n%E\n",
        s = fmt(start_ms),
        e = fmt(end_ms),
    )
}

#[tokio::test]
async fn the_next_export_says_which_proposals_it_reflects() {
    let (app, w) = app();
    // Load a one-activity schedule, planned into the coated space during its cure.
    let start = DEMO_ANCHOR_MS + DAY;
    let end = start + 2 * DAY;
    let (status, body) = call(
        &app,
        &w,
        "POST",
        "/schedule-of-record",
        Some(json!({ "label": "wk1.xer", "xer": xer_with("A10", "Coat second pass", "3-160-2-Q", start, end) })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // Propose sliding it a week.
    let (status, body) = call(
        &app,
        &w,
        "POST",
        "/schedule-proposals",
        Some(json!({ "activity": "A10", "start_ms": start + 7 * DAY, "end_ms": end + 7 * DAY, "kind": "manual", "reason": "after the cure" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // The week-2 export moves it to those days: the preview says so, before Confirm.
    let (status, preview) = call(
        &app,
        &w,
        "POST",
        "/schedule-of-record?dry_run=true",
        Some(json!({ "label": "wk2.xer", "xer": xer_with("A10", "Coat second pass", "3-160-2-Q", start + 7 * DAY + 3_600_000, end + 7 * DAY) })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(
        preview["delta"]["proposals"]["open"], 1,
        "{}",
        preview["delta"]
    );
    assert_eq!(preview["delta"]["proposals"]["reflected"], json!(["A10"]));
    // Still open on the list until the export is committed…
    let (_, list) = call(&app, &w, "GET", "/schedule-proposals", None).await;
    assert_eq!(list["proposals"][0]["status"], "open");
    // …and reflected once it is.
    call(
        &app,
        &w,
        "POST",
        "/schedule-of-record",
        Some(json!({ "label": "wk2.xer", "xer": xer_with("A10", "Coat second pass", "3-160-2-Q", start + 7 * DAY + 3_600_000, end + 7 * DAY) })),
    )
    .await;
    let (_, list) = call(&app, &w, "GET", "/schedule-proposals", None).await;
    assert_eq!(list["proposals"][0]["status"], "reflected", "{list}");
    assert_eq!(list["counts"]["reflected"], 1);
    // The past did not change: the proposal's own record still says where it
    // came from. `xer_with` writes `start` as a UTC wall clock, and the seed
    // world reads the export in the yard's clock (Norfolk, UTC−04:00 in May),
    // so the activity — and the proposal's `from` — sits four hours after
    // the UTC instant the wall clock was written from.
    assert_eq!(
        list["proposals"][0]["from"]["start"],
        start + 4 * 3_600_000,
        "the export's wall clock is the yard's, not Zulu"
    );
}
