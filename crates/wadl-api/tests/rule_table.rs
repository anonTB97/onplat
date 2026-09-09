//! The rule-table door: the safety authority's CSV in and out of the hull.
//! A dry run compiles against the hull as it stands and stores nothing; a
//! commit ledgers every version; a revert returns the seed; the seed
//! round-trips through the door byte for byte; an activity is judged by the
//! rows bound to its work type; and R04's fire watch runs from the permit's
//! close. Runs on the memory store, and on PostgreSQL when `DATABASE_URL` is
//! set and the crate is built with `--features postgres`.

#![allow(
    missing_docs,
    clippy::doc_markdown,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use serde_json::{json, Value};
use tower::ServiceExt;
use wadl_domain::compartment::CompartmentNo;
use wadl_domain::time::{TestClock, Timestamp};
use wadl_domain::units::Minutes;
use wadl_store::memory::DEMO_ANCHOR_MS;

use support::{reference_hull, TestWorld};

/// The seed exported in the document layout — what the sitting starts from.
const REFERENCE_CSV: &str = include_str!("../../../reference/cvn73/CVN73-rule-table.csv");
/// The handoff's own twelve-column table: twenty rows, nothing compiled.
const HANDOFF_CSV: &str = include_str!("../../../handoff/01-rule-table.csv");
const SEED_R04: &str = "00000000-0000-0000-0000-000000000402";
const SEED_R03_ABOVE: &str = "00000000-0000-0000-0000-000000000301";
const MINUTE_MS: i64 = 60_000;
/// The R04 cell run the tests edit: `deck_penetration`, 30 minutes, from the end.
const R04_CELLS: &str = "\"deck_penetration\",\"30\",\"end\"";

fn body(label: &str, csv: &str) -> Value {
    json!({ "label": label, "csv": csv })
}

/// The table with R04's fire watch at `minutes`.
fn with_r04_hold(csv: &str, minutes: &str) -> String {
    let edited = csv.replace(
        R04_CELLS,
        &format!("\"deck_penetration\",\"{minutes}\",\"end\""),
    );
    assert_ne!(edited, csv, "the edit lands on R04");
    edited
}

/// The table without column 22 — a table authored fresh, no ids carried.
fn without_versions(csv: &str) -> String {
    let mut out = String::with_capacity(csv.len());
    for line in csv.lines() {
        out.push_str(line.rsplit_once(',').map_or(line, |(head, _)| head));
        out.push('\n');
    }
    out
}

fn rows_of(preview: &Value) -> &Vec<Value> {
    preview["rows"].as_array().unwrap()
}

fn row<'a>(rows: &'a [Value], rule: &str, ordinal: u64) -> &'a Value {
    rows.iter()
        .find(|r| r["rule"] == rule && r["ordinal"] == ordinal)
        .unwrap_or_else(|| panic!("{rule}-{ordinal} in the report"))
}

fn versions(rows: &[Value]) -> Vec<(String, String)> {
    rows.iter()
        .map(|r| {
            (
                format!("{}-{}", r["rule"].as_str().unwrap(), r["ordinal"]),
                r["version"].as_str().unwrap_or("").to_owned(),
            )
        })
        .collect()
}

fn finding_texts(body: &Value) -> Vec<String> {
    body["findings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["text"].as_str().unwrap().to_owned())
        .collect()
}

/// The ledger's rule-table lines, newest first: `(action, detail)`.
async fn rule_table_ledger(tw: &TestWorld) -> Vec<(String, Value)> {
    let (_, ledger) = tw.get("/ledger").await;
    ledger["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| {
            let detail: Value = serde_json::from_str(e["detail"].as_str()?).ok()?;
            (detail["kind"] == "rule_table")
                .then(|| (e["action"].as_str().unwrap().to_owned(), detail))
        })
        .collect()
}

/// `GET …/rule-table?format=csv`: status, content type, text.
async fn export_csv(tw: &TestWorld) -> (StatusCode, String, String) {
    let request = Request::builder()
        .method(Method::GET)
        .uri(format!(
            "/api/vessels/{}/rule-table?format=csv",
            tw.world.cvn73.as_uuid()
        ))
        .header("x-org-id", tw.world.yard_org.as_uuid().to_string())
        .header("x-assigned-vessels", tw.world.cvn73.as_uuid().to_string())
        .body(Body::empty())
        .unwrap();
    let response = tw.app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 24)
        .await
        .unwrap();
    (
        status,
        content_type,
        String::from_utf8(bytes.to_vec()).unwrap(),
    )
}

/// A request on `app` under the hull's headers, plus `extra` headers.
async fn call_app(
    app: &axum::Router,
    tw: &TestWorld,
    method: Method,
    path: &str,
    extra: &[(&str, &str)],
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(format!("/api/vessels/{}{path}", tw.world.cvn73.as_uuid()))
        .header("x-org-id", tw.world.yard_org.as_uuid().to_string())
        .header("x-assigned-vessels", tw.world.cvn73.as_uuid().to_string());
    for (k, v) in extra {
        request = request.header(*k, *v);
    }
    if body.is_some() {
        request = request.header("content-type", "application/json");
    }
    let request = request
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

async fn post_as(tw: &TestWorld, roles: &str, path: &str, body: Value) -> (StatusCode, Value) {
    call_app(
        &tw.app,
        tw,
        Method::POST,
        path,
        &[("x-wadl-roles", roles)],
        Some(body),
    )
    .await
}

/// The reference table through the door as a dry run: the response.
async fn dry_run_reference(tw: &TestWorld) -> Value {
    let (status, out) = tw
        .call(
            Method::POST,
            "/rule-table?dry_run=true",
            Some(body("CVN73-rule-table.csv", REFERENCE_CSV)),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(out["stored"], false);
    assert_eq!(out["label"], "CVN73-rule-table.csv");
    assert_eq!(out["table_hash"].as_str().unwrap().len(), 64);
    out
}

#[tokio::test]
async fn a_dry_run_compiles_the_reference_table_and_reports_what_each_row_fires_on() {
    let tw = reference_hull().await;
    let out = dry_run_reference(&tw).await;
    let preview = &out["preview"];
    let rows = rows_of(preview);
    assert_eq!(rows.len(), 10, "seven rule ids, ten entries");
    assert!(rows
        .iter()
        .all(|r| r["compiled"] == true && r["why_not"].is_null()));
    let refs: Vec<String> = versions(rows).into_iter().map(|(r, _)| r).collect();
    assert_eq!(
        refs,
        [
            "R03-0", "R03-1", "R06-0", "R09-0", "R09-1", "R04-0", "R07-0", "R07-1", "R13-0",
            "R22-0"
        ]
    );
    // The seed's ids travel in column 22 and are honoured.
    assert_eq!(row(rows, "R04", 0)["version"], SEED_R04);
    assert_eq!(row(rows, "R03", 1)["version"], SEED_R03_ABOVE);
    assert_eq!(preview["in_force"], 10);
    assert_eq!(
        preview["replaces"],
        json!({ "source": "seed", "label": "seed_usn_hot_work" })
    );
    assert_eq!(
        preview["moved"]["spaces"], 0,
        "the reference table is the seed: nothing moves"
    );

    // One row's report, cell by cell.
    let r04 = row(rows, "R04", 0);
    assert_eq!(r04["name"], "Hot work overhead of occupied space");
    assert_eq!(r04["kind"], "Hazard cascade");
    assert_eq!(r04["line"], 7);
    assert_eq!(r04["entry"]["hazard"], "hot_work_live");
    assert_eq!(r04["entry"]["state"], "SUSPEND");
    assert_eq!(r04["entry"]["hold"], 30);
    assert_eq!(r04["entry"]["hold_from"], "end");
    assert_eq!(r04["entry"]["clearing_authority"], "fire_marshal");
    assert_eq!(r04["entry"]["work_types"], json!([]));
    assert_eq!(r04["entry"]["categories"], json!([]));
    assert_eq!(r04["entry"]["effective_from"], "");
    assert_eq!(r04["entry"]["effective_to"], "");
    assert_eq!(
        r04["entry"]["applies"],
        json!({ "Coupled": { "code": "deck_penetration", "max_hops": 1 } })
    );

    // What each row fires on today: the live permits under R04, the four
    // energised buses under R07 walking one-way bus edges, the coats under R03.
    let (_, hazards) = tw.get("/hazards").await;
    let live = |kind: &str| {
        hazards["hazards"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|h| h["kind"] == kind)
            .count() as u64
    };
    assert_eq!(r04["fires_on"]["hazards"], live("hot_work_live"));
    assert!(
        r04["fires_on"]["space_count"].as_u64().unwrap() >= 1,
        "{r04}"
    );
    let r07 = row(rows, "R07", 1);
    assert_eq!(r07["fires_on"]["hazards"], live("energised_bus"));
    assert!(
        r07["fires_on"]["space_count"].as_u64().unwrap() >= 4,
        "{r07}"
    );
    assert!(
        r07["fires_on"]["activities_bound"].as_u64().unwrap() >= 1,
        "{r07}"
    );
    let r03 = row(rows, "R03", 0);
    assert_eq!(r03["fires_on"]["hazards"], live("coating_open"));
    assert_eq!(r03["fires_on"]["space_count"], live("coating_open"));
    assert_eq!(
        r03["fires_on"]["spaces"].as_array().unwrap().len() as u64,
        live("coating_open").min(12)
    );
    assert_eq!(r03["entry"]["work_types"], json!(["hot_work"]));
}

#[tokio::test]
async fn a_dry_run_audits_the_work_types_on_the_schedule_and_stores_nothing() {
    let tw = reference_hull().await;
    let out = dry_run_reference(&tw).await;
    let preview = &out["preview"];

    // The work-type audit: what the export carries, what the table names.
    let wt = &preview["work_types"];
    let names: Vec<&str> = wt["on_schedule"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w["work_type"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        [
            "mechanical",
            "inspection",
            "coating",
            "hot_work",
            "electrical",
            "insulation",
            "rigging"
        ]
    );
    let total: u64 = wt["on_schedule"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w["activities"].as_u64().unwrap())
        .sum();
    assert_eq!(
        total, 5692,
        "every task carries the UDF; milestones carry none"
    );
    assert_eq!(wt["bound"], json!(["hot_work"]));
    assert_eq!(
        wt["unbound_on_schedule"],
        json!([
            "coating",
            "electrical",
            "inspection",
            "insulation",
            "mechanical",
            "rigging"
        ])
    );
    assert_eq!(wt["unseen_in_table"], json!([]));

    // Findings, never refusals.
    let texts = finding_texts(&out);
    assert!(
        texts
            .iter()
            .any(|t| t.starts_with("R09 walks exhaust_trunk on a hull with only")),
        "{texts:?}"
    );
    assert!(
        texts
            .iter()
            .any(|t| t.starts_with("R13 walks exhaust_trunk on a hull with only")),
        "{texts:?}"
    );
    assert!(
        texts.iter().any(|t| t == "work types on the schedule that no row names: coating, electrical, inspection, insulation, mechanical, rigging — they are judged by the any-work rows only"),
        "{texts:?}"
    );
    assert!(!texts.iter().any(|t| t.contains("nothing compiles")));

    // A dry run stores nothing.
    let (_, served) = tw.get("/rule-table").await;
    assert_eq!(served["source"], "seed");
    assert_eq!(served["label"], "seed_usn_hot_work");
    assert_eq!(served["rows_in_force"], 10);
    assert_eq!(served["rows_total"], 10);
    assert!(served["signoff"].is_null());
    assert_eq!(served["work_types"]["on_schedule"], wt["on_schedule"]);
    assert!(rule_table_ledger(&tw).await.is_empty());
}

#[tokio::test]
async fn the_handoff_table_alone_compiles_nothing_and_says_so_on_a_dry_run_and_refuses_on_commit() {
    let tw = reference_hull().await;
    let (status, out) = tw
        .call(
            Method::POST,
            "/rule-table?dry_run=true",
            Some(body("01-rule-table.csv", HANDOFF_CSV)),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(out["stored"], false);
    let preview = &out["preview"];
    let rows = rows_of(preview);
    assert_eq!(rows.len(), 20);
    for r in rows {
        assert_eq!(r["compiled"], false, "{r}");
        let why = r["why_not"].as_str().unwrap();
        assert!(why.starts_with("not compiled: "), "{why}");
        assert!(r["entry"].is_null() && r["version"].is_null() && r["fires_on"].is_null());
    }
    assert_eq!(
        row(rows, "R01", 0)["why_not"],
        "not compiled: Completeness gate needs a permit object (out of the pilot)"
    );
    assert_eq!(
        row(rows, "R03", 0)["why_not"],
        "not compiled: no hazard kind — the compile columns are blank"
    );
    assert_eq!(preview["in_force"], 0);
    assert_eq!(
        out["findings"][0],
        json!({ "severity": "warn", "text": "nothing compiles — commit would put no rule in force" })
    );
    // Every space a hazard reaches today would clear.
    let moved = &preview["moved"];
    assert!(moved["spaces"].as_u64().unwrap() > 0, "{moved}");
    for example in moved["examples"].as_array().unwrap() {
        assert_ne!(example["before"], "ALLOW", "{example}");
        assert_eq!(example["after"], "ALLOW", "{example}");
        assert!(!example["rule"].as_str().unwrap().is_empty(), "{example}");
    }

    // On commit the same table is refused.
    let (status, refused) = tw
        .call(
            Method::POST,
            "/rule-table",
            Some(body("01-rule-table.csv", HANDOFF_CSV)),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{refused}");
    assert!(
        refused["detail"]
            .as_str()
            .unwrap()
            .contains("nothing compiles"),
        "{refused}"
    );
    let (_, served) = tw.get("/rule-table").await;
    assert_eq!(served["source"], "seed");
    assert!(rule_table_ledger(&tw).await.is_empty());
}

#[tokio::test]
async fn a_commit_replaces_the_seed_ledgers_the_versions_and_a_trace_carries_a_content_addressed_id(
) {
    let tw = reference_hull().await;
    let edited = with_r04_hold(REFERENCE_CSV, "60");
    let (status, out) = tw
        .call(
            Method::POST,
            "/rule-table",
            Some(body("CVN73-rule-table-60.csv", &edited)),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(out["stored"], true);
    let hash = out["table_hash"].as_str().unwrap().to_owned();
    let rows = rows_of(&out["preview"]);
    let r04 = row(rows, "R04", 0);
    let new_version = r04["version"].as_str().unwrap().to_owned();
    assert_ne!(new_version, SEED_R04, "a changed cell is a new version");
    assert_eq!(
        uuid::Uuid::parse_str(&new_version)
            .unwrap()
            .get_version_num(),
        8,
        "content-addressed"
    );
    assert_eq!(r04["entry"]["hold"], 60);
    for (r, v) in versions(rows).iter().filter(|(r, _)| r != "R04-0") {
        assert!(
            v.starts_with("00000000-0000-0000-0000-0000000"),
            "{r} keeps its seed id: {v}"
        );
    }
    let texts = finding_texts(&out);
    assert!(
        texts.iter().any(|t| t.starts_with(&format!(
            "R04-0 (line 7) carried version {SEED_R04} but its cells changed"
        ))),
        "{texts:?}"
    );

    // Served as the document now.
    let (_, served) = tw.get("/rule-table").await;
    assert_eq!(served["source"], "document");
    assert_eq!(served["label"], "CVN73-rule-table-60.csv");
    assert_eq!(served["table_hash"], hash);
    assert_eq!(served["rows_in_force"], 10);
    assert_eq!(served["rows_total"], 10);
    assert!(served["signoff"].is_null());
    assert_eq!(row(rows_of(&served), "R04", 0)["version"], new_version);

    // Ledgered with every version.
    let ledger = rule_table_ledger(&tw).await;
    assert_eq!(ledger.len(), 1);
    let (action, detail) = &ledger[0];
    assert_eq!(action, "DOCUMENT_REPLACED");
    assert_eq!(detail["label"], "CVN73-rule-table-60.csv");
    assert_eq!(detail["via"], "door");
    let counts = &detail["counts"];
    assert_eq!(counts["rows"], 10);
    assert_eq!(counts["compiled"], 10);
    assert_eq!(counts["in_force"], 10);
    assert_eq!(
        counts["moved_spaces"], 0,
        "a longer watch moves nothing while the permits are open"
    );
    assert_eq!(counts["table_hash"], hash);
    let ledgered = counts["versions"].as_array().unwrap();
    assert_eq!(ledgered.len(), 10);
    assert!(ledgered
        .iter()
        .any(|v| v == &json!({ "rule": "R04", "ordinal": 0, "version": new_version })));

    // The trace on the space below permit 2673 carries the new id.
    let (status, state) = tw.get("/compartments/6-216-1-J/state").await;
    assert_eq!(status, StatusCode::OK, "{state}");
    let step = state["decision"]["trace"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["rule_code"] == "R04")
        .expect("R04 fires on the tank below the permit");
    assert_eq!(
        step["rule_version"], new_version,
        "{}",
        state["decision"]["trace"]
    );
    let (_, register) = tw.get("/activities").await;
    assert_eq!(
        register["rules"],
        json!({ "source": "document", "label": "CVN73-rule-table-60.csv", "signed": false })
    );
}

#[tokio::test]
async fn the_same_row_reimported_keeps_its_version_and_a_changed_cell_gets_a_new_one() {
    let tw = reference_hull().await;
    let fresh = without_versions(REFERENCE_CSV);
    let dry = |csv: String| {
        let tw = &tw;
        async move {
            let (status, out) = tw
                .call(
                    Method::POST,
                    "/rule-table?dry_run=true",
                    Some(body("fresh.csv", &csv)),
                )
                .await;
            assert_eq!(status, StatusCode::OK, "{out}");
            versions(rows_of(&out["preview"]))
        }
    };
    let first = dry(fresh.clone()).await;
    assert_eq!(first.len(), 10);
    for (r, v) in &first {
        let id = uuid::Uuid::parse_str(v).unwrap();
        assert_eq!(id.get_version_num(), 8, "{r} is minted: {v}");
        assert!(!v.starts_with("00000000-0000"), "{r} is not a seed id");
    }
    assert_eq!(
        dry(fresh.clone()).await,
        first,
        "the same rows, the same ids"
    );

    let changed = dry(with_r04_hold(&fresh, "60")).await;
    for ((r, before), (_, after)) in first.iter().zip(changed.iter()) {
        if r == "R04-0" {
            assert_ne!(before, after, "R04 is a new version");
        } else {
            assert_eq!(before, after, "{r} is untouched");
        }
    }

    // Column 22 carried: the seed's own ids come back.
    let seeded = dry(REFERENCE_CSV.to_owned()).await;
    assert!(seeded.iter().any(|(r, v)| r == "R04-0" && v == SEED_R04));
}

#[tokio::test]
async fn revert_returns_to_the_seed_and_is_ledgered() {
    let tw = reference_hull().await;
    let (status, out) = tw
        .call(
            Method::POST,
            "/rule-table",
            Some(body("CVN73-rule-table.csv", REFERENCE_CSV)),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{out}");
    let (_, served) = tw.get("/rule-table").await;
    assert_eq!(served["source"], "document");

    let (status, out) = tw.call(Method::POST, "/rule-table/revert", None).await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(out, json!({ "reverted": true, "source": "seed" }));
    let (_, served) = tw.get("/rule-table").await;
    assert_eq!(served["source"], "seed");
    assert_eq!(served["label"], "seed_usn_hot_work");
    assert_eq!(served["rows_in_force"], 10);
    let ledger = rule_table_ledger(&tw).await;
    assert_eq!(ledger.len(), 2);
    assert_eq!(ledger[0].0, "DOCUMENT_REVERTED", "newest first");
    assert!(ledger[0].1["label"].is_null());
    assert_eq!(ledger[1].0, "DOCUMENT_REPLACED");
    let (_, register) = tw.get("/activities").await;
    assert_eq!(
        register["rules"],
        json!({ "source": "seed", "label": "seed_usn_hot_work", "signed": false })
    );
}

#[tokio::test]
async fn the_seed_export_reimports_with_the_same_ids_byte_for_byte() {
    let tw = reference_hull().await;
    let (status, content_type, csv) = export_csv(&tw).await;
    assert_eq!(status, StatusCode::OK);
    assert!(content_type.starts_with("text/csv"), "{content_type}");
    assert_eq!(
        csv, REFERENCE_CSV,
        "the seed exported is the reference table"
    );
    let (_, before) = tw.get("/rule-table").await;

    let (status, out) = tw
        .call(
            Method::POST,
            "/rule-table",
            Some(body("CVN73-rule-table.csv", &csv)),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(out["stored"], true);
    assert!(
        !finding_texts(&out)
            .iter()
            .any(|t| t.contains("carried version")),
        "every seed id is honoured"
    );
    assert_eq!(out["preview"]["moved"]["spaces"], 0);

    let (_, _, again) = export_csv(&tw).await;
    assert_eq!(again, REFERENCE_CSV, "the document exports as it came in");
    let (_, after) = tw.get("/rule-table").await;
    assert_eq!(after["source"], "document");
    assert_eq!(
        after["table_hash"], before["table_hash"],
        "the hash is of the cells"
    );
    assert_eq!(versions(rows_of(&after)), versions(rows_of(&before)));
    assert_eq!(after["rows_in_force"], 10);
}

#[tokio::test]
async fn the_door_refuses_a_malformed_table_whole_and_stores_nothing() {
    let tw = reference_hull().await;
    let refused = |label: &'static str, csv: String, dry_run: bool| {
        let tw = &tw;
        async move {
            let path = if dry_run {
                "/rule-table?dry_run=true"
            } else {
                "/rule-table"
            };
            let (status, out) = tw.call(Method::POST, path, Some(body(label, &csv))).await;
            assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{out}");
            out["detail"].as_str().unwrap().to_owned()
        }
    };
    // The header, verbatim and in order.
    let swapped = REFERENCE_CSV.replacen("\"Rule ID\",\"Name\"", "\"Name\",\"Rule ID\"", 1);
    let detail = refused("swapped.csv", swapped, true).await;
    assert!(
        detail.starts_with("the rule table was refused whole:"),
        "{detail}"
    );
    assert!(detail.contains("verbatim and in order"), "{detail}");
    // An end-anchored hold with no minutes, on the line it is on.
    let no_minutes = REFERENCE_CSV.replace(R04_CELLS, "\"deck_penetration\",\"\",\"end\"");
    let detail = refused("no-minutes.csv", no_minutes, false).await;
    assert!(
        detail.contains("line 7: R04-0: hold from \"end\" needs hold minutes"),
        "{detail}"
    );
    // Every unreadable cell at once.
    let two = REFERENCE_CSV
        .replace(R04_CELLS, "\"deck_penetration\",\"soon\",\"middle\"")
        .replace(
            "\"coating_open\",\"exhaust_trunk\"",
            "\"plasma\",\"exhaust_trunk\"",
        );
    let detail = refused("two.csv", two, true).await;
    for needle in [
        "hold minutes \"soon\"",
        "hold from \"middle\"",
        "unknown hazard kind \"plasma\"",
    ] {
        assert!(detail.contains(needle), "{needle} in {detail}");
    }
    // No label.
    let detail = refused("   ", REFERENCE_CSV.to_owned(), false).await;
    assert!(detail.contains("carries no label"), "{detail}");

    let (_, served) = tw.get("/rule-table").await;
    assert_eq!(served["source"], "seed");
    assert!(rule_table_ledger(&tw).await.is_empty());
}

#[tokio::test]
async fn a_foreman_may_preview_but_not_commit_or_revert() {
    let tw = reference_hull().await;
    let (status, out) = post_as(
        &tw,
        "foreman",
        "/rule-table",
        body("CVN73-rule-table.csv", REFERENCE_CSV),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{out}");
    assert_eq!(out["capability"], "commit_document");
    assert_eq!(
        out["detail"],
        "Foreman may not commit or revert a document — commit_document is held by Planner"
    );
    let (status, out) = post_as(&tw, "foreman", "/rule-table/revert", json!({})).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{out}");
    let (status, out) = post_as(
        &tw,
        "foreman",
        "/rule-table?dry_run=true",
        body("CVN73-rule-table.csv", REFERENCE_CSV),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(out["stored"], false);
    let (status, out) = post_as(
        &tw,
        "planner",
        "/rule-table",
        body("CVN73-rule-table.csv", REFERENCE_CSV),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(out["stored"], true);
    assert!(rule_table_ledger(&tw).await.len() == 1);
}

/// A two-task export located in `space`: an NDT survey (`inspection`) and a
/// weld (`hot_work`), both planned inside the coat's cure, both located and
/// typed through the reference field map's UDFs.
fn two_task_xer(space: &str) -> String {
    format!(
        "ERMHDR\t19.12\t2026-05-01\tProject\tadmin\tA.PLANNER\tShipyard Planning\tUSD\n\
%T\tPROJECT\n%F\tproj_id\tproj_short_name\n%R\t4410\tCVN73-B11\n\
%T\tUDFTYPE\n%F\tudf_type_id\tudf_type_name\tudf_type_label\tlogical_data_type\n\
%R\t901\tcompartment\tCompartment\tFT_TEXT\n%R\t903\twork_type\tWork Type\tFT_TEXT\n\
%T\tTASK\n%F\ttask_id\tproj_id\ttask_code\ttask_name\ttask_type\tstatus_code\tearly_start_date\tearly_end_date\n\
%R\t900001\t4410\tA90001\tNDT survey – {space}\tTT_Task\tTK_NotStart\t2026-05-13 02:00\t2026-05-13 06:00\n\
%R\t900002\t4410\tA90002\tFit & weld – {space}\tTT_Task\tTK_NotStart\t2026-05-13 02:00\t2026-05-13 06:00\n\
%T\tUDFVALUE\n%F\tudf_type_id\tfk_id\tproj_id\tudf_text\n\
%R\t901\t900001\t4410\t{space}\n%R\t903\t900001\t4410\tinspection\n\
%R\t901\t900002\t4410\t{space}\n%R\t903\t900002\t4410\thot_work\n%E\n"
    )
}

/// The space 3-212-1-L's curing coat reaches along the derived deck
/// penetration and nothing else holds: the B11 stage.
async fn space_under_the_coat(tw: &TestWorld) -> String {
    let graph = tw
        .store
        .adjacency_graph(&tw.scope(), tw.world.cvn73)
        .await
        .unwrap();
    let coat = CompartmentNo::new("3-212-1-L");
    let reached: Vec<String> = graph
        .out_edges(&coat)
        .filter(|e| e.code.as_str() == "deck_penetration")
        .map(|e| e.to.as_str().to_owned())
        .collect();
    assert!(!reached.is_empty(), "the coat reaches a deck");
    let (_, states) = tw.get("/deck-states").await;
    let only_r03 = states
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| {
            reached
                .iter()
                .any(|no| s["compartment"]["compartment_no"] == *no)
        })
        .find(|s| s["rules_fired"] == json!(["R03"]) && s["state"] == "BLOCK");
    only_r03.map_or_else(
        || panic!("a space under the coat held by R03 alone among {reached:?}"),
        |s| {
            s["compartment"]["compartment_no"]
                .as_str()
                .unwrap()
                .to_owned()
        },
    )
}

#[tokio::test]
async fn a_cold_work_inspection_above_a_curing_coat_is_executable_and_the_weld_beside_it_is_not() {
    let tw = reference_hull().await;
    let space = space_under_the_coat(&tw).await;
    let (status, out) = tw
        .call(
            Method::POST,
            "/schedule-of-record",
            Some(json!({ "label": "b11.xer", "xer": two_task_xer(&space) })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{out}");

    let (status, register) = tw.get("/activities").await;
    assert_eq!(status, StatusCode::OK, "{register}");
    assert_eq!(
        register["rules"],
        json!({ "source": "seed", "label": "seed_usn_hot_work", "signed": false })
    );
    let rows = register["activities"].as_array().unwrap();
    let by_code = |code: &str| rows.iter().find(|a| a["code"] == code).unwrap();
    let survey = by_code("A90001");
    let weld = by_code("A90002");
    assert_eq!(survey["compartment_no"], space);
    assert_eq!(weld["compartment_no"], space);
    assert_eq!(survey["work_type"], "inspection");
    assert_eq!(weld["work_type"], "hot_work");

    // The weld is refused under R03; the survey beside it is executable
    // because no coating row binds to inspection — only the any-work rows do.
    assert_eq!(survey["executability"]["verdict"], "executable", "{survey}");
    assert_eq!(weld["executability"]["verdict"], "not_executable", "{weld}");
    assert!(weld["executability"].to_string().contains("R03"), "{weld}");
    let survey_bound = survey["rules_bound"].as_u64().unwrap();
    let weld_bound = weld["rules_bound"].as_u64().unwrap();
    assert_eq!(weld_bound, 10, "every seed row binds to hot work");
    assert_eq!(
        survey_bound, 5,
        "the five any-work rows bind to an inspection"
    );
    assert!(survey_bound < weld_bound);

    // The compartment-level board still reads the space as held: unknown
    // work is every work.
    let (_, state) = tw.get(&format!("/compartments/{space}/state")).await;
    assert_eq!(state["decision"]["state"], "BLOCK");
    let step = &state["decision"]["trace"][0];
    assert_eq!(step["rule_code"], "R03");
    assert_eq!(step["rule_version"], SEED_R03_ABOVE);
}

/// The deck-states row for `no` at `as_of`.
async fn deck_state(app: &axum::Router, tw: &TestWorld, no: &str, as_of_ms: i64) -> Value {
    let (status, board) = call_app(
        app,
        tw,
        Method::GET,
        &format!("/deck-states?as_of={as_of_ms}"),
        &[],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{board}");
    board
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["compartment"]["compartment_no"] == no)
        .cloned()
        .unwrap_or_else(|| panic!("{no} on the deck board"))
}

#[tokio::test]
async fn the_deck_below_live_hot_work_stays_suspended_until_the_permit_closes_then_for_the_fire_watch(
) {
    let tw = reference_hull().await;
    let raised = DEMO_ANCHOR_MS;
    let clock = Arc::new(TestClock::new(Timestamp::from_epoch_millis(raised)));
    let app = wadl_api::build_router(wadl_api::AppState::new(tw.store.clone(), clock.clone()));
    let at = |minutes: i64| raised + minutes * MINUTE_MS;
    let tank = "6-216-1-J";

    // The permit is open: suspended, no clock, the fire marshal's to clear.
    let row = deck_state(&app, &tw, tank, at(45)).await;
    assert_eq!(row["state"], "SUSPEND", "{row}");
    assert!(row["earliest_clear"].is_null(), "{row}");
    assert!(row["rules_fired"]
        .as_array()
        .unwrap()
        .contains(&json!("R04")));
    assert_eq!(row["clearing_authority"], "fire_marshal");
    let (_, state) = call_app(
        &app,
        &tw,
        Method::GET,
        &format!("/compartments/{tank}/state?as_of={}", at(45)),
        &[],
        None,
    )
    .await;
    let reason = |state: &Value| {
        state["decision"]["trace"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["rule_code"] == "R04")
            .map(|s| s["reason"].as_str().unwrap().to_owned())
            .expect("an R04 line")
    };
    assert!(
        reason(&state).ends_with("fire watch of 30 min starts when the permit closes."),
        "{}",
        reason(&state)
    );

    // Permit 2673 closes an hour after it was raised.
    clock.advance(Minutes::new(60));
    let (status, cleared) = call_app(
        &app,
        &tw,
        Method::POST,
        "/hazards/clear",
        &[],
        Some(json!({
            "compartment": "5-212-1-Q",
            "kind": "hot_work_live",
            "basis": "permit 2673 closed; torch cold, fire watch posted",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{cleared}");

    // The fire watch runs from the close: earliest clear is close + 30.
    let row = deck_state(&app, &tw, tank, at(70)).await;
    assert_eq!(row["state"], "SUSPEND", "{row}");
    assert_eq!(row["earliest_clear"], at(90), "{row}");
    let (_, state) = call_app(
        &app,
        &tw,
        Method::GET,
        &format!("/compartments/{tank}/state?as_of={}", at(70)),
        &[],
        None,
    )
    .await;
    assert!(
        reason(&state).ends_with("permit closed, fire watch of 30 min running."),
        "{}",
        reason(&state)
    );
    // The watch has run.
    let row = deck_state(&app, &tw, tank, at(90)).await;
    assert_eq!(row["state"], "ALLOW", "{row}");
    assert!(row["earliest_clear"].is_null());
    // Time-honest: before the clearance was recorded, the hold was there.
    let row = deck_state(&app, &tw, tank, at(50)).await;
    assert_eq!(row["state"], "SUSPEND", "{row}");
    assert!(row["earliest_clear"].is_null(), "{row}");
}
