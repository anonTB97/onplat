//! The XER door surviving the yard's export, and the run history behind it:
//! a quarantined row is served in the preview instead of refusing the file,
//! an inline field map relocates the work and is committed with the run,
//! every commit is a run with the served pointer moving, activity ids are
//! stable across re-imports, two runs diff, a prior run serves again with a
//! ledger line, the field map has a door of its own, and the reference hull
//! boots with its map and a boot run — through UTF-8 or Windows-1252 bytes.

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
use wadl_domain::time::{TestClock, Timestamp};
use wadl_store::memory::{DemoWorld, InMemoryStore, DEMO_ANCHOR_MS};
use wadl_store::Repositories;

const SAMPLE: &str = include_str!("../../../reference/p6-sample/CVN73-PIA26.xer");
const YARD_SHAPED: &str = include_str!("../../../reference/p6-sample/CVN73-PIA26-yardshape.xer");
const YARD_LABEL: &str = "CVN73-PIA26-yardshape.xer";

fn app() -> (axum::Router, DemoWorld) {
    let (store, world) = InMemoryStore::demo_at(Timestamp::from_epoch_millis(DEMO_ANCHOR_MS));
    let clock = TestClock::new(Timestamp::from_epoch_millis(DEMO_ANCHOR_MS));
    let state = wadl_api::AppState::new(Arc::new(store), Arc::new(clock));
    (wadl_api::build_router(state), world)
}

async fn call_on(
    app: &axum::Router,
    world: &DemoWorld,
    hull: wadl_domain::ids::VesselId,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(format!("/api/vessels/{}{path}", hull.as_uuid()))
        .header("x-org-id", world.yard_org.as_uuid().to_string())
        .header(
            "x-assigned-vessels",
            format!("{},{}", world.cvn73.as_uuid(), world.cvn71.as_uuid()),
        )
        .header("content-type", "application/json")
        .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 26)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn call(
    app: &axum::Router,
    world: &DemoWorld,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    call_on(app, world, world.cvn73, method, path, body).await
}

/// The yard's map for the yard-shaped export: compartment from `COMPT`,
/// work item from `WI`, work type from `WTYPE`, this hull's project only.
fn yard_map() -> Value {
    json!({
        "compartment": { "source": "udf", "name": "COMPT" },
        "work_item": { "source": "udf", "name": "WI" },
        "work_type": { "source": "udf", "name": "WTYPE" },
        "trade": { "source": "resource" },
        "projects": ["CVN73-PIA26"],
        "placards_from_names": true
    })
}

async fn commit(app: &axum::Router, w: &DemoWorld, label: &str, xer: &str) -> Value {
    let (status, body) = call(
        app,
        w,
        "POST",
        "/schedule-of-record",
        Some(json!({ "label": label, "xer": xer })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

async fn ledger(app: &axum::Router, w: &DemoWorld) -> Vec<(String, Value)> {
    let (_, body) = call(app, w, "GET", "/ledger", None).await;
    body["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            (
                e["action"].as_str().unwrap().to_owned(),
                serde_json::from_str(e["detail"].as_str().unwrap()).unwrap(),
            )
        })
        .collect()
}

#[tokio::test]
async fn a_quarantined_row_no_longer_refuses_the_file_and_is_served_in_the_preview() {
    let (app, w) = app();
    let (status, preview) = call(
        &app,
        &w,
        "POST",
        "/schedule-of-record?dry_run=true",
        Some(json!({ "label": YARD_LABEL, "xer": YARD_SHAPED })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["dry_run"], true);
    // Eleven rows served around the two set aside, with their lines.
    assert_eq!(preview["activities"], 11, "{preview}");
    let quarantine = preview["quarantine"].as_array().unwrap();
    let rows: Vec<(u64, &str, Option<&str>)> = quarantine
        .iter()
        .map(|q| {
            (
                q["line"].as_u64().unwrap(),
                q["class"].as_str().unwrap(),
                q["code"].as_str(),
            )
        })
        .collect();
    assert_eq!(
        rows,
        [(44, "unparseable_date", Some("A4021")), (45, "width", None)]
    );
    assert_eq!(quarantine[0]["table"], "TASK");
    assert!(quarantine[0]["reason"]
        .as_str()
        .unwrap()
        .contains("2026-13-40"));
    // The exclusions, listed not lost; the material line not in anyone's hours.
    assert_eq!(
        preview["exclusions"]["loe"],
        json!(["A9001", "A9002", "A9003"])
    );
    assert_eq!(preview["exclusions"]["wbs"], json!(["Z6-SUM"]));
    assert_eq!(preview["exclusions"]["project"], json!([]));
    let counts = &preview["run"]["counts"];
    assert_eq!(counts["material_skipped"], 1, "{counts}");
    assert_eq!(counts["equipment_skipped"], 1);
    assert_eq!(counts["quarantined"], 2);
    assert_eq!(counts["task_rows"], 17);
    assert_eq!(counts["served"], 11);
    assert_eq!(counts["key_events"], 1);
    // Under today's map nothing is authored; the findings say which fields
    // the file carries instead, and that it carries two projects.
    assert_eq!(
        preview["mapping"]["located_authored"], 0,
        "{}",
        preview["mapping"]
    );
    let findings: Vec<&str> = preview["findings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f.as_str().unwrap())
        .collect();
    assert!(
        findings
            .iter()
            .any(|f| f.starts_with("2 projects in this export")),
        "{findings:?}"
    );
    assert!(
        findings.iter().any(|f| f.contains("\"COMPT\"")),
        "{findings:?}"
    );
    let udfs: Vec<&str> = preview["fields_seen"]["udfs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| u["name"].as_str().unwrap())
        .collect();
    assert_eq!(udfs, ["COMPT", "WI", "WTYPE"]);
    assert_eq!(preview["run"]["field_map_source"], "default");
    assert_eq!(preview["run"]["encoding"], "utf-8");
    assert_eq!(preview["run"]["decoded_by"], "caller");
    assert_eq!(
        preview["run"]["projects_served"],
        json!(["CVN73-PIA26", "CVN73-DSRA27"])
    );
    assert!(preview.get("run_id").is_none(), "a dry run mints no run");
}

#[tokio::test]
async fn a_file_with_no_surviving_activity_is_still_refused_whole() {
    let (app, w) = app();
    let bad = "%T\tTASK\n%F\ttask_id\ttask_code\ttask_name\tstatus_code\ttask_type\tearly_start_date\tearly_end_date\n\
%R\t1\tA1\tBad\tTK_NotStart\tTT_Task\t2026-13-40 06:00\t2026-08-02 16:00\n\
%R\t2\tA2\tBackwards\tTK_NotStart\tTT_Task\t2026-08-02 16:00\t2026-08-01 06:00\n%E\n";
    let (status, body) = call(
        &app,
        &w,
        "POST",
        "/schedule-of-record?dry_run=true",
        Some(json!({ "label": "bad.xer", "xer": bad })),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    let detail = body["detail"].as_str().unwrap();
    assert!(
        detail.starts_with("XER rejected: every one of 2 TASK rows was quarantined"),
        "{detail}"
    );
    assert!(
        detail.contains("line 3:") && detail.contains("line 4:"),
        "{detail}"
    );

    // A map naming a project the file does not carry leaves nothing to
    // serve: refused, and the reason names the project.
    let (status, body) = call(
        &app,
        &w,
        "POST",
        "/schedule-of-record?dry_run=true",
        Some(json!({
            "label": YARD_LABEL,
            "xer": YARD_SHAPED,
            "field_map": { "projects": ["CVN75-DPIA27"] }
        })),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    let detail = body["detail"].as_str().unwrap();
    assert!(
        detail.contains("16 rows in projects the field map does not serve"),
        "{detail}"
    );
    assert!(detail.contains("\"CVN75-DPIA27\""), "{detail}");

    // An unknown encoding hint is a refusal that names the two the door reads.
    let (status, body) = call(
        &app,
        &w,
        "POST",
        "/schedule-of-record?dry_run=true",
        Some(json!({ "label": "x.xer", "xer": SAMPLE, "encoding": "utf-16" })),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert!(body["detail"].as_str().unwrap().contains("windows-1252"));
}

#[tokio::test]
async fn a_dry_run_surveys_the_fields_and_stores_no_run() {
    let (app, w) = app();
    let (status, preview) = call(
        &app,
        &w,
        "POST",
        "/schedule-of-record?dry_run=true",
        Some(json!({ "label": YARD_LABEL, "xer": YARD_SHAPED, "encoding": "windows-1252" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    let seen = &preview["fields_seen"];
    assert_eq!(seen["projects"][1]["short_name"], "CVN73-DSRA27");
    assert_eq!(seen["activity_code_types"][0]["name"], "LOC");
    assert_eq!(seen["resource_types"]["RT_Mat"], 1);
    assert_eq!(seen["task_types"]["TT_LOE"], 3);
    assert_eq!(seen["sections"]["TASK"], 16);
    assert_eq!(preview["run"]["encoding"], "windows-1252");
    assert_eq!(preview["run"]["decoded_by"], "browser");

    let (_, runs) = call(&app, &w, "GET", "/schedule-runs", None).await;
    assert!(runs["served"].is_null(), "{runs}");
    assert_eq!(runs["runs"], json!([]));
    let (_, frame) = call(&app, &w, "GET", "/timeframe", None).await;
    assert!(frame["schedule_run"].is_null(), "{frame}");
    let (_, register) = call(&app, &w, "GET", "/activities", None).await;
    assert!(register["schedule_source"].is_null());
    assert!(register["schedule_run"].is_null());
}

#[tokio::test]
async fn an_inline_field_map_relocates_the_work_and_a_commit_stores_it_with_two_ledger_lines() {
    let (app, w) = app();
    let (status, preview) = call(
        &app,
        &w,
        "POST",
        "/schedule-of-record?dry_run=true",
        Some(json!({ "label": YARD_LABEL, "xer": YARD_SHAPED, "field_map": yard_map() })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    // Seven authored through COMPT, one derived from its task name, nine
    // rows served (the milestone is the ninth), the other project excluded
    // with the one relationship into it quarantined by name.
    let m = &preview["mapping"];
    assert_eq!(m["located_authored"], 7, "{m}");
    assert_eq!(m["located_derived"].as_array().unwrap().len(), 1, "{m}");
    assert_eq!(m["located_derived"][0]["activity"], "A4040");
    assert_eq!(preview["activities"], 9);
    assert_eq!(
        preview["exclusions"]["project"],
        json!([["D1010", "CVN73-DSRA27"], ["D1020", "CVN73-DSRA27"]])
    );
    let cross: Vec<&Value> = preview["quarantine"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|q| q["class"] == "cross_project_logic")
        .collect();
    assert_eq!(cross.len(), 1, "{}", preview["quarantine"]);
    assert_eq!(cross[0]["table"], "TASKPRED");
    assert!(cross[0]["reason"]
        .as_str()
        .unwrap()
        .contains("CVN73-DSRA27"));
    assert_eq!(
        preview["run"]["counts"]["quarantined"], 3,
        "two bad rows and the edge"
    );
    assert_eq!(preview["run"]["field_map_source"], "inline");
    assert_eq!(preview["run"]["projects_served"], json!(["CVN73-PIA26"]));
    assert!(
        !preview["findings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f.as_str().unwrap().starts_with("compartment:")),
        "{}",
        preview["findings"]
    );

    // Nothing stored yet.
    let (_, map) = call(&app, &w, "GET", "/field-map", None).await;
    assert_eq!(map["source"], "default");

    // Commit: the map first, then the schedule, each on its own line.
    let (status, committed) = call(
        &app,
        &w,
        "POST",
        "/schedule-of-record",
        Some(json!({ "label": YARD_LABEL, "xer": YARD_SHAPED, "field_map": yard_map() })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{committed}");
    assert!(committed["run_id"].is_string(), "{committed}");
    assert_eq!(committed["seq"], 1);
    let entries = ledger(&app, &w).await;
    assert_eq!(entries[0].0, "SCHEDULE_REPLACED");
    assert_eq!(entries[1].0, "DOCUMENT_REPLACED");
    assert_eq!(entries[1].1["kind"], "p6_field_map");
    assert_eq!(entries[1].1["label"], YARD_LABEL);
    let detail = &entries[0].1;
    assert_eq!(detail["run_id"], committed["run_id"]);
    assert_eq!(detail["seq"], 1);
    assert_eq!(detail["counts"]["quarantined"], 3);
    assert_eq!(detail["encoding"], "utf-8");
    assert_eq!(detail["field_map"]["compartment"]["name"], "COMPT");
    assert_eq!(detail["imported_by"]["via"], "door");
    assert!(detail["delta"].is_object());

    // The map is now the hull's document, and the register carries the
    // work type the map named.
    let (_, map) = call(&app, &w, "GET", "/field-map", None).await;
    assert_eq!(map["source"], "document");
    assert_eq!(map["label"], YARD_LABEL);
    assert_eq!(map["map"]["compartment"]["name"], "COMPT");
    assert_eq!(map["fields_seen"]["udfs"][0]["name"], "COMPT");
    let (_, register) = call(&app, &w, "GET", "/activities", None).await;
    let a1010 = register["activities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["code"] == "A1010")
        .unwrap();
    assert_eq!(a1010["compartment_no"], "4-110-2-W");
    assert_eq!(a1010["work_type"], "COATING");
    assert_eq!(a1010["work_order_code"], "WI-3318");

    // The same map again is not a second document line.
    let (status, _) = call(
        &app,
        &w,
        "POST",
        "/schedule-of-record",
        Some(json!({ "label": YARD_LABEL, "xer": YARD_SHAPED, "field_map": yard_map() })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let entries = ledger(&app, &w).await;
    assert_eq!(entries[0].0, "SCHEDULE_REPLACED");
    assert_eq!(entries[1].0, "SCHEDULE_REPLACED");
}

#[tokio::test]
async fn every_commit_is_a_run_and_the_served_pointer_moves() {
    let (app, w) = app();
    let first = commit(&app, &w, "CVN73-PIA26.xer", SAMPLE).await;
    let second = commit(&app, &w, YARD_LABEL, YARD_SHAPED).await;
    assert_eq!(first["seq"], 1);
    assert_eq!(second["seq"], 2);
    assert_ne!(first["run_id"], second["run_id"]);

    let (status, runs) = call(&app, &w, "GET", "/schedule-runs", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(runs["served"], second["run_id"]);
    let list = runs["runs"].as_array().unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0]["seq"], 2, "newest first");
    assert_eq!(list[0]["served"], true);
    assert_eq!(list[1]["served"], false);
    assert_eq!(list[0]["label"], YARD_LABEL);
    assert_eq!(list[0]["imported_by"]["via"], "door");
    assert_eq!(list[0]["imported_by"]["person"], "dev:anonymous");
    assert_eq!(list[0]["imported_at_ms"], DEMO_ANCHOR_MS);
    assert_eq!(list[0]["counts"]["served"], 11);
    assert_eq!(list[0]["schema_version"], 1);

    let (_, frame) = call(&app, &w, "GET", "/timeframe", None).await;
    assert_eq!(frame["schedule_run"]["run_id"], second["run_id"], "{frame}");
    assert_eq!(frame["schedule_run"]["seq"], 2);
    let (_, register) = call(&app, &w, "GET", "/activities", None).await;
    assert_eq!(register["schedule_run"]["run_id"], second["run_id"]);
    assert_eq!(register["schedule_source"], YARD_LABEL);

    // The detail carries the report, not the rows; an unknown run is 404;
    // no run named is a refusal that says how to name one.
    let (status, detail) = call(
        &app,
        &w,
        "GET",
        &format!(
            "/schedule-runs/detail?run={}",
            second["run_id"].as_str().unwrap()
        ),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(detail["summary"]["seq"], 2);
    assert_eq!(detail["report"]["quarantine"].as_array().unwrap().len(), 2);
    assert_eq!(
        detail["report"]["excluded_loe"].as_array().unwrap().len(),
        3
    );
    assert!(detail["report"]["fields_seen"]["udfs"].is_array());
    assert!(detail.get("doc").is_none());
    let (status, _) = call(
        &app,
        &w,
        "GET",
        &format!("/schedule-runs/detail?run={}", uuid::Uuid::nil()),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, body) = call(&app, &w, "GET", "/schedule-runs/detail", None).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
}

#[tokio::test]
async fn activity_ids_are_stable_across_reimports_and_differ_by_hull() {
    let (app, w) = app();
    let ids = |register: &Value| -> std::collections::BTreeMap<String, String> {
        register["activities"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| {
                (
                    a["code"].as_str().unwrap().to_owned(),
                    a["activity_id"].as_str().unwrap().to_owned(),
                )
            })
            .collect()
    };
    commit(&app, &w, "CVN73-PIA26.xer", SAMPLE).await;
    let (_, first) = call(&app, &w, "GET", "/activities", None).await;
    // A re-baseline in the yard's own shape: the codes the two files share
    // keep their ids, so an open inspector survives it.
    commit(&app, &w, YARD_LABEL, YARD_SHAPED).await;
    let (_, second) = call(&app, &w, "GET", "/activities", None).await;
    let (a, b) = (ids(&first), ids(&second));
    let shared: Vec<&String> = a.keys().filter(|k| b.contains_key(*k)).collect();
    assert!(shared.len() >= 8, "{shared:?}");
    for code in shared {
        assert_eq!(a[code], b[code], "{code} changed id across the re-import");
    }
    assert_eq!(
        a["A1010"],
        wadl_api::schedule::stable_activity_id(w.cvn73, "A1010")
            .as_uuid()
            .to_string()
    );
    // The same file on another hull is another set of ids.
    let (status, _) = call_on(
        &app,
        &w,
        w.cvn71,
        "POST",
        "/schedule-of-record",
        Some(json!({ "label": "CVN71.xer", "xer": SAMPLE })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, other) = call_on(&app, &w, w.cvn71, "GET", "/activities", None).await;
    let c = ids(&other);
    assert_ne!(a["A1010"], c["A1010"]);
    assert_eq!(
        c["A1010"],
        wadl_api::schedule::stable_activity_id(w.cvn71, "A1010")
            .as_uuid()
            .to_string()
    );
}

#[tokio::test]
async fn a_diff_between_two_runs_counts_moves_and_refusals() {
    let (app, w) = app();
    let first = commit(&app, &w, "CVN73-PIA26.xer", SAMPLE).await;
    let second = commit(&app, &w, YARD_LABEL, YARD_SHAPED).await;
    let (r1, r2) = (
        first["run_id"].as_str().unwrap(),
        second["run_id"].as_str().unwrap(),
    );
    // Against the served run by default: run 1 versus run 2.
    let (status, diff) = call(
        &app,
        &w,
        "GET",
        &format!("/schedule-runs/diff?run={r1}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{diff}");
    assert_eq!(diff["run"]["seq"], 1);
    assert_eq!(diff["against"]["seq"], 2);
    let d = &diff["delta"];
    assert_eq!(d["baseline"], YARD_LABEL);
    // The sample has 18 rows, the yard-shaped file 11; the shared codes are
    // retimed and rehoused, and the rest are new or gone.
    assert!(d["added"].as_u64().unwrap() > 0, "{d}");
    assert!(d["removed"].as_u64().unwrap() > 0, "{d}");
    assert!(d["retimed"].is_u64() && d["rehoused"].is_u64() && d["rebudgeted"].is_u64());
    assert!(d["refused_before"].is_u64() && d["refused_after"].is_u64());
    assert!(d["newly_refused"]["examples"].is_array());
    assert!(d["proposals"]["open"].is_u64());
    // Explicitly the other way round.
    let (status, back) = call(
        &app,
        &w,
        "GET",
        &format!("/schedule-runs/diff?run={r2}&against={r1}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{back}");
    assert_eq!(back["delta"]["baseline"], "CVN73-PIA26.xer");
    assert_eq!(back["delta"]["added"], d["removed"]);
    assert_eq!(back["delta"]["removed"], d["added"]);
    // A run against itself moves nothing.
    let (_, same) = call(
        &app,
        &w,
        "GET",
        &format!("/schedule-runs/diff?run={r2}&against={r2}"),
        None,
    )
    .await;
    assert_eq!(same["delta"]["added"], 0);
    assert_eq!(same["delta"]["retimed"], 0);
    // An unknown run is 404; no run named is 422.
    let (status, _) = call(
        &app,
        &w,
        "GET",
        &format!("/schedule-runs/diff?run={}", uuid::Uuid::nil()),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = call(&app, &w, "GET", "/schedule-runs/diff", None).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn serving_a_prior_run_is_ledgered_and_the_register_follows() {
    let (app, w) = app();
    let first = commit(&app, &w, "CVN73-PIA26.xer", SAMPLE).await;
    let second = commit(&app, &w, YARD_LABEL, YARD_SHAPED).await;
    let (status, served) = call(
        &app,
        &w,
        "POST",
        "/schedule-runs/serve",
        Some(json!({ "run_id": first["run_id"] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{served}");
    assert_eq!(served["served"]["run_id"], first["run_id"]);
    assert_eq!(served["served"]["served"], true);
    assert_eq!(served["delta"]["baseline"], YARD_LABEL);
    assert!(served["delta"]["added"].as_u64().unwrap() > 0);

    let (_, runs) = call(&app, &w, "GET", "/schedule-runs", None).await;
    assert_eq!(runs["served"], first["run_id"]);
    assert_eq!(runs["runs"].as_array().unwrap().len(), 2, "history kept");
    let (_, register) = call(&app, &w, "GET", "/activities", None).await;
    assert_eq!(register["schedule_source"], "CVN73-PIA26.xer");
    assert_eq!(register["activities"].as_array().unwrap().len(), 18);
    assert_eq!(register["schedule_run"]["seq"], 1);
    let (_, frame) = call(&app, &w, "GET", "/timeframe", None).await;
    assert_eq!(frame["schedule_run"]["run_id"], first["run_id"]);

    let entries = ledger(&app, &w).await;
    assert_eq!(entries[0].0, "SCHEDULE_REPLACED");
    let detail = &entries[0].1;
    assert_eq!(detail["reverted_to_run"], true);
    assert_eq!(detail["from_run"], second["run_id"]);
    assert_eq!(detail["run_id"], first["run_id"]);
    assert_eq!(detail["label"], "CVN73-PIA26.xer");

    // A run the hull does not have is not found; a body without a run is refused.
    let (status, _) = call(
        &app,
        &w,
        "POST",
        "/schedule-runs/serve",
        Some(json!({ "run_id": uuid::Uuid::nil() })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = call(&app, &w, "POST", "/schedule-runs/serve", Some(json!({}))).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn a_run_older_than_the_document_cap_lists_but_cannot_be_served_or_diffed() {
    let (app, w) = app();
    let first = commit(&app, &w, "wk1.xer", SAMPLE).await;
    for week in 2..=(wadl_store::memory::MAX_RUN_DOCS + 1) {
        commit(&app, &w, &format!("wk{week}.xer"), SAMPLE).await;
    }
    let r1 = first["run_id"].as_str().unwrap();
    let (status, detail) = call(
        &app,
        &w,
        "GET",
        &format!("/schedule-runs/detail?run={r1}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(detail["summary"]["seq"], 1);
    let (status, body) = call(
        &app,
        &w,
        "POST",
        "/schedule-runs/serve",
        Some(json!({ "run_id": r1 })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["title"], "conflict");
    assert!(
        body["detail"]
            .as_str()
            .unwrap()
            .contains("run #1 (wk1.xer)"),
        "{body}"
    );
    let (status, body) = call(
        &app,
        &w,
        "GET",
        &format!("/schedule-runs/diff?run={r1}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    // The served pointer never moved.
    let (_, runs) = call(&app, &w, "GET", "/schedule-runs", None).await;
    assert_eq!(runs["runs"][0]["served"], true);
    assert_eq!(runs["runs"][0]["seq"], 13);
}

#[tokio::test]
async fn revert_to_generated_keeps_the_run_history() {
    let (app, w) = app();
    let first = commit(&app, &w, "CVN73-PIA26.xer", SAMPLE).await;
    let (status, body) = call(&app, &w, "POST", "/schedule-of-record/revert", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (_, register) = call(&app, &w, "GET", "/activities", None).await;
    assert!(register["schedule_source"].is_null());
    assert!(register["schedule_run"].is_null());
    let (_, frame) = call(&app, &w, "GET", "/timeframe", None).await;
    assert!(frame["schedule_run"].is_null());
    let (_, runs) = call(&app, &w, "GET", "/schedule-runs", None).await;
    assert!(runs["served"].is_null());
    assert_eq!(runs["runs"].as_array().unwrap().len(), 1);
    assert_eq!(runs["runs"][0]["served"], false);
    // And the run can be served again from the history.
    let (status, _) = call(
        &app,
        &w,
        "POST",
        "/schedule-runs/serve",
        Some(json!({ "run_id": first["run_id"] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, frame) = call(&app, &w, "GET", "/timeframe", None).await;
    assert_eq!(frame["schedule_run"]["run_id"], first["run_id"]);
}

#[tokio::test]
async fn the_field_map_door_refuses_a_malformed_map_whole() {
    let (app, w) = app();
    // Malformed: refused whole with every reason, nothing stored, no ledger line.
    let (status, body) = call(
        &app,
        &w,
        "POST",
        "/field-map",
        Some(json!({
            "label": "bad.json",
            "map": {
                "compartment": { "source": "resource" },
                "work_item": { "source": "udf", "name": " " },
                "projects": ["A", "A"]
            }
        })),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    let detail = body["detail"].as_str().unwrap();
    assert!(
        detail.starts_with("the field map was refused whole:"),
        "{detail}"
    );
    assert!(
        detail.contains("compartment: source \"resource\""),
        "{detail}"
    );
    assert!(detail.contains("work_item:"), "{detail}");
    assert!(detail.contains("listed twice"), "{detail}");
    let (status, body) = call(
        &app,
        &w,
        "POST",
        "/field-map",
        Some(json!({ "label": "bad.json", "map": { "compartment": { "source": "wbs_level" } } })),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert!(ledger(&app, &w).await.is_empty());
}

#[tokio::test]
async fn the_field_map_door_stores_a_map_with_findings_and_reverts_to_default() {
    let (app, w) = app();
    // With the yard-shaped export served, the default map's names are
    // findings against the file's own — warned, never refused.
    commit(&app, &w, YARD_LABEL, YARD_SHAPED).await;
    let (status, preview) = call(
        &app,
        &w,
        "POST",
        "/field-map?dry_run=true",
        Some(json!({ "label": "todays.json", "map": {} })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["stored"], false);
    assert_eq!(preview["map"]["compartment"]["name"], "compartment");
    let findings = preview["findings"].as_array().unwrap();
    assert!(
        findings[0]
            .as_str()
            .unwrap()
            .starts_with("compartment: this export carries no UDF named \"compartment\""),
        "{findings:?}"
    );
    let (_, map) = call(&app, &w, "GET", "/field-map", None).await;
    assert_eq!(map["source"], "default", "a dry run stores nothing");

    // Commit the yard's map: stored, ledgered, and clean against the file.
    let (status, stored) = call(
        &app,
        &w,
        "POST",
        "/field-map",
        Some(json!({ "label": "CVN73-yard.json", "map": yard_map() })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{stored}");
    assert_eq!(stored["stored"], true);
    assert_eq!(stored["findings"], json!([]));
    let (_, map) = call(&app, &w, "GET", "/field-map", None).await;
    assert_eq!(map["source"], "document");
    assert_eq!(map["label"], "CVN73-yard.json");
    assert_eq!(map["map"], yard_map());
    let entries = ledger(&app, &w).await;
    assert_eq!(entries[0].0, "DOCUMENT_REPLACED");
    assert_eq!(entries[0].1["kind"], "p6_field_map");
    assert_eq!(entries[0].1["label"], "CVN73-yard.json");
    assert!(entries[0].1["counts"]["summary"]
        .as_str()
        .unwrap()
        .starts_with("compartment ← UDF \"COMPT\""));
    // The next import reads through the stored map without being told.
    let (_, preview) = call(
        &app,
        &w,
        "POST",
        "/schedule-of-record?dry_run=true",
        Some(json!({ "label": YARD_LABEL, "xer": YARD_SHAPED })),
    )
    .await;
    assert_eq!(preview["run"]["field_map_source"], "document");
    assert_eq!(preview["mapping"]["located_authored"], 7);

    // Revert: back to default, ledgered.
    let (status, body) = call(&app, &w, "POST", "/field-map/revert", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["reverted"], true);
    let (_, map) = call(&app, &w, "GET", "/field-map", None).await;
    assert_eq!(map["source"], "default");
    assert!(map["label"].is_null());
    assert!(
        map["fields_seen"]["udfs"].is_array(),
        "the served run's survey still rides"
    );
    let entries = ledger(&app, &w).await;
    assert_eq!(entries[0].0, "DOCUMENT_REVERTED");
    assert_eq!(entries[0].1["kind"], "p6_field_map");
}

fn docs_dir() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../reference/cvn73")
}

#[tokio::test]
async fn the_reference_hull_boots_with_its_field_map_and_a_boot_run() {
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
    let (name, summary) = loaded.field_map.expect("the field map loads");
    assert_eq!(name, "CVN73-fieldmap.json");
    assert!(
        summary.starts_with("compartment ← UDF \"compartment\""),
        "{summary}"
    );

    let full = std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../reference/p6-sample/CVN73-PIA26-full.xer"),
    )
    .unwrap();
    let schedule = wadl_api::schedule::load_xer(
        store.as_ref(),
        world.cvn73,
        "CVN73-PIA26-full.xer",
        &full,
        DEMO_ANCHOR_MS,
    )
    .expect("the full export loads");
    assert_eq!(schedule.activities, 5706);
    assert_eq!(schedule.quarantine, Vec::<String>::new());
    assert_eq!(schedule.encoding, "utf-8");
    assert_eq!(
        schedule.field_map_label.as_deref(),
        Some("CVN73-fieldmap.json")
    );
    assert_eq!(schedule.parsed_in, "America/New_York · CVN73-clock.csv");
    assert_eq!(schedule.run.seq, 1);
    assert_eq!(schedule.run.imported_by.via, "boot");
    assert_eq!(schedule.run.imported_by.person, None);
    assert_eq!(schedule.run.imported_by.org, world.yard_org);
    assert_eq!(schedule.run.decoded_by, "server");
    assert_eq!(schedule.run.counts.quarantined, 0);
    assert_eq!(schedule.run.counts.key_events, 14);

    let clock = TestClock::new(Timestamp::from_epoch_millis(DEMO_ANCHOR_MS));
    let repos: Arc<dyn Repositories> = store.clone();
    let app = wadl_api::build_router(wadl_api::AppState::new(repos, Arc::new(clock)));
    let (status, frame) = call(&app, &world, "GET", "/timeframe", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(frame["schedule_run"]["seq"], 1, "{frame}");
    assert_eq!(frame["schedule_run"]["imported_by"]["via"], "boot");
    assert_eq!(frame["schedule_run"]["label"], "CVN73-PIA26-full.xer");
    let (_, runs) = call(&app, &world, "GET", "/schedule-runs", None).await;
    assert_eq!(runs["runs"].as_array().unwrap().len(), 1);
    assert_eq!(runs["runs"][0]["served"], true);
    assert_eq!(runs["served"], frame["schedule_run"]["run_id"]);
    let (_, map) = call(&app, &world, "GET", "/field-map", None).await;
    assert_eq!(map["source"], "document");
    assert_eq!(map["label"], "CVN73-fieldmap.json");
    assert_eq!(map["fields_seen"]["projects"][0]["tasks"], 5706);
}

/// The shared literal that pins the two decoders: bytes `93 94 E9 96 80`
/// read as `“ ” é – €`.
const CP1252_BYTES: [u8; 5] = [0x93, 0x94, 0xE9, 0x96, 0x80];
const CP1252_TEXT: &str = "\u{201C}\u{201D}\u{E9}\u{2013}\u{20AC}";

#[tokio::test]
async fn a_windows_1252_export_loads_through_the_boot_path() {
    let head = "ERMHDR\t19.12\t2026-08-10\tProject\tadmin\tA.PLANNER\tShipyard Planning\tUSD\n\
%T\tPROJECT\n%F\tproj_id\tproj_short_name\n%R\t4410\tCVN73-TEST\n\
%T\tTASK\n%F\ttask_id\tproj_id\ttask_code\ttask_name\tstatus_code\ttask_type\tearly_start_date\tearly_end_date\n\
%R\t1\t4410\tA10\tCaf";
    let tail =
        " cure - shaft alley\tTK_NotStart\tTT_Task\t2026-08-10 06:00\t2026-08-10 14:00\n%E\n";
    let mut bytes = head.as_bytes().to_vec();
    bytes.extend_from_slice(&CP1252_BYTES);
    bytes.extend_from_slice(tail.as_bytes());
    assert!(
        std::str::from_utf8(&bytes).is_err(),
        "not UTF-8 by construction"
    );

    let (store, world) = InMemoryStore::demo_at(Timestamp::from_epoch_millis(DEMO_ANCHOR_MS));
    let store = Arc::new(store);
    let schedule = wadl_api::schedule::load_xer(
        store.as_ref(),
        world.cvn73,
        "yard-ansi.xer",
        &bytes,
        DEMO_ANCHOR_MS,
    )
    .expect("a Windows-1252 export loads");
    assert_eq!(schedule.encoding, "windows-1252");
    assert_eq!(schedule.activities, 1);
    assert_eq!(schedule.run.encoding, "windows-1252");
    assert_eq!(schedule.run.decoded_by, "server");
    assert_eq!(
        schedule.field_map_label, None,
        "the seed hull has no map: default"
    );

    let clock = TestClock::new(Timestamp::from_epoch_millis(DEMO_ANCHOR_MS));
    let repos: Arc<dyn Repositories> = store.clone();
    let app = wadl_api::build_router(wadl_api::AppState::new(repos, Arc::new(clock)));
    let (_, register) = call(&app, &world, "GET", "/activities", None).await;
    let name = register["activities"][0]["name"].as_str().unwrap();
    assert_eq!(
        name,
        format!("Caf{CP1252_TEXT} cure - shaft alley"),
        "{name}"
    );
    assert_eq!(register["schedule_run"]["encoding"], "windows-1252");
}
