//! The production path, end to end, on a real PostgreSQL: `wadl
//! bootstrap-hull` creates a hull from a statement, `wadl load-docs` carries
//! the reference hull's documents and export onto it through the doors' own
//! parsers and store calls, and the scoped API — the router the shell talks
//! to, over the database store — serves the documents back, with every
//! commit on the hull's ledger and the chain verifying.
//!
//! The commands run as the built binary (`CARGO_BIN_EXE_wadl`), not as
//! library calls, so what is proven is the command line the runbook names.
//! Each run bootstraps its own hull (a v7 id, hull number `T-<8 hex>`), so
//! runs never collide and nothing is reset.
//!
//! Skipped unless `DATABASE_URL` is set, like `pg_rls`, so `cargo test`
//! stays green for anyone without a database:
//!
//! ```text
//! DATABASE_URL=postgres://…/wadl cargo test -p wadl-cli --test database
//! ```

#![allow(
    clippy::doc_markdown,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;
use wadl_domain::time::{TestClock, Timestamp};
use wadl_store::memory::DEMO_ANCHOR_MS;
use wadl_store::pg::PgStore;
use wadl_store::Repositories;

/// The seed's yard tenant and class: the statement names them, so on the
/// seeded development database they read `existed` and on a freshly
/// migrated one `created` — the command is the same either way.
const YARD_ORG: Uuid = Uuid::from_u128(0x01);
const NAVY_ORG: Uuid = Uuid::from_u128(0x02);

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// `DATABASE_URL`, or the reason the test is skipped.
fn database_url() -> Option<String> {
    let url = std::env::var("DATABASE_URL").ok()?;
    if url.trim().is_empty() {
        return None;
    }
    Some(url)
}

/// A fresh hull under the yard tenant, as `wadl bootstrap-hull` takes it.
struct TestHull {
    vessel: Uuid,
    hull_no: String,
    statement: PathBuf,
    dir: PathBuf,
}

impl TestHull {
    fn mint() -> Self {
        let vessel = Uuid::now_v7();
        // The tail of a v7 uuid is its random half.
        let hull_no = format!("T-{}", &vessel.simple().to_string()[24..]);
        let dir = std::env::temp_dir().join(format!("wadl-database-test-{vessel}"));
        std::fs::create_dir_all(&dir).unwrap();
        let statement = dir.join(format!("{hull_no}-hull.json"));
        let body = serde_json::json!({
            "organization": { "org_id": YARD_ORG, "kind": "shipbuilder", "name": "Demo Yard", "country": "USA" },
            "class": { "class_id": Uuid::from_u128(0xC0068), "code": "CVN-68", "name": "Nimitz class", "hull_type": "CVN", "frame_min": 1, "frame_max": 260 },
            "vessel": { "vessel_id": vessel, "hull_no": hull_no, "name": "Test hull" },
            "availability": { "availability_id": Uuid::now_v7(), "code": "T-26", "kind": "PIA", "location": "Test dock", "start_on": "2026-01-05", "end_on": "2026-09-30" }
        });
        std::fs::write(&statement, serde_json::to_vec_pretty(&body).unwrap()).unwrap();
        Self {
            vessel,
            hull_no,
            statement,
            dir,
        }
    }
}

impl Drop for TestHull {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.dir).ok();
    }
}

/// Runs the built `wadl` with `args`, returning exit code, stdout, stderr.
fn wadl(args: &[&str]) -> (i32, String, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_wadl"))
        .args(args)
        .current_dir(repo_root())
        .output()
        .expect("the wadl binary runs");
    (
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

/// The API over the database store, as the shell reaches it.
async fn router(url: &str) -> axum::Router {
    let store = PgStore::connect(url).await.expect("connects");
    let repos: Arc<dyn Repositories> = Arc::new(store);
    let clock = TestClock::new(Timestamp::from_epoch_millis(DEMO_ANCHOR_MS));
    wadl_api::build_router(wadl_api::AppState::new(repos, Arc::new(clock)))
}

async fn get(app: &axum::Router, org: Uuid, hull: Uuid, path: &str) -> (StatusCode, Value) {
    let request = Request::builder()
        .uri(format!("/api/vessels/{hull}{path}"))
        .header("x-org-id", org.to_string())
        .header("x-assigned-vessels", hull.to_string())
        .body(Body::empty())
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

fn actions(ledger: &Value) -> Vec<String> {
    ledger["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["action"].as_str().unwrap().to_owned())
        .collect()
}

/// The served hull, read through the scoped API: the documents are what is
/// served, and the export's activities. Returns (activities served, live
/// hazards) for the report line.
async fn assert_reference_hull_served(app: &axum::Router, hull: Uuid) -> (usize, usize) {
    let (status, register) = get(app, YARD_ORG, hull, "/register").await;
    assert_eq!(status, StatusCode::OK, "{register}");
    assert_eq!(register["served"], "ingested", "{register}");
    assert_eq!(register["spaces_served"], 476, "{register}");
    assert_eq!(register["decks_served"], 12, "{register}");

    let (_, zones) = get(app, YARD_ORG, hull, "/zones").await;
    assert_eq!(zones["source"], "CVN73-zones.csv", "{zones}");
    assert_eq!(zones["audit"]["out_of_bounds"].as_array().unwrap().len(), 0);
    assert_eq!(
        zones["audit"]["unbounded_zones"].as_array().unwrap().len(),
        0
    );

    let (_, couplings) = get(app, YARD_ORG, hull, "/couplings").await;
    assert_eq!(couplings["served"], "ingested", "{couplings}");
    assert!(
        couplings["register"]["derived"].as_u64().unwrap() > 100,
        "{couplings}"
    );

    let (status, geometry) = get(app, YARD_ORG, hull, "/geometry").await;
    assert_eq!(status, StatusCode::OK, "{geometry}");

    let (_, hazards) = get(app, YARD_ORG, hull, "/hazards").await;
    let live = hazards["hazards"].as_array().unwrap().len();
    assert!(live >= 25, "the log's hazards are live: {live}");

    let (status, activities) = get(app, YARD_ORG, hull, "/activities").await;
    assert_eq!(status, StatusCode::OK, "{activities}");
    let served = activities["activities"].as_array().unwrap().len();
    assert_eq!(served, 5706, "the export's activities are served");

    let (_, runs) = get(app, YARD_ORG, hull, "/schedule-runs").await;
    let runs = runs["runs"].as_array().unwrap();
    assert_eq!(runs.len(), 1, "{runs:?}");
    assert_eq!(runs[0]["label"], "CVN73-PIA26-full.xer");
    assert_eq!(runs[0]["imported_by"]["via"], "cli");
    assert_eq!(runs[0]["imported_by"]["person"], Value::Null);
    (served, live)
}

/// The hull's ledger after a load: the statement first, the export last,
/// one row per document between in door order, every one on the binary's
/// account through the CLI, the chain verifying. Returns the row count.
async fn assert_load_ledgered(app: &axum::Router, hull: Uuid) -> usize {
    let (_, ledger) = get(app, YARD_ORG, hull, "/ledger").await;
    assert_eq!(ledger["verified"], true, "{ledger}");
    let entries = ledger["entries"].as_array().unwrap();
    assert_eq!(entries[0]["action"], "SCHEDULE_REPLACED", "newest first");
    assert_eq!(entries[entries.len() - 1]["action"], "HULL_BOOTSTRAPPED");
    let documents: Vec<&Value> = entries
        .iter()
        .filter(|e| e["action"] == "DOCUMENT_REPLACED")
        .collect();
    assert_eq!(documents.len(), 7, "{ledger}");
    let mut kinds = Vec::new();
    for entry in documents.iter().rev() {
        assert_eq!(entry["actor_id"], "system:cli", "{entry}");
        let detail: Value = serde_json::from_str(entry["detail"].as_str().unwrap()).unwrap();
        assert_eq!(detail["via"], "cli", "{detail}");
        kinds.push(detail["kind"].as_str().unwrap().to_owned());
    }
    assert_eq!(
        kinds,
        [
            "yard_clock",
            "p6_field_map",
            "compartment_register",
            "zone_register",
            "geometry_register",
            "coupling_register",
            "hazard_log",
        ]
    );
    let schedule: Value = serde_json::from_str(entries[0]["detail"].as_str().unwrap()).unwrap();
    assert_eq!(schedule["via"], "cli", "{schedule}");
    assert_eq!(schedule["activities"], 5706, "{schedule}");
    entries.len()
}

/// The reference hull, through the production path: bootstrap, a dry run
/// that stores nothing, the load, then the read-back.
#[tokio::test]
async fn the_reference_hull_loads_onto_a_bootstrapped_hull_and_is_served_from_postgres() {
    let Some(url) = database_url() else {
        eprintln!("DATABASE_URL not set; skipping the database test");
        return;
    };
    let hull = TestHull::mint();
    let org = YARD_ORG.to_string();
    let vessel = hull.vessel.to_string();
    let statement = hull.statement.to_string_lossy().into_owned();
    let bootstrap = [
        "bootstrap-hull",
        "--statement",
        &statement,
        "--database-url",
        &url,
    ];
    let load = [
        "load-docs",
        "--dir",
        "reference/cvn73",
        "--xer",
        "reference/p6-sample/CVN73-PIA26-full.xer",
        "--org",
        &org,
        "--vessel",
        &vessel,
        "--database-url",
        &url,
    ];

    // 1. The hull-row statement, applied from the operator's session.
    let (code, out, err) = wadl(&bootstrap);
    assert_eq!(code, 0, "bootstrap-hull\n{out}\n{err}");
    assert!(out.contains("vessel") && out.contains("created"), "{out}");
    assert!(out.contains("HULL_BOOTSTRAPPED"), "{out}");

    let app = router(&url).await;
    let (status, ledger) = get(&app, YARD_ORG, hull.vessel, "/ledger").await;
    assert_eq!(status, StatusCode::OK, "{ledger}");
    assert_eq!(actions(&ledger), ["HULL_BOOTSTRAPPED"], "{ledger}");

    // 2. A dry run parses every file and the export, and stores nothing.
    let mut dry_run = load.to_vec();
    dry_run.push("--dry-run");
    let (code, out, err) = wadl(&dry_run);
    assert_eq!(code, 0, "load-docs --dry-run\n{out}\n{err}");
    assert!(out.contains("dry run, not stored"), "{out}");
    assert!(out.contains("nothing stored, nothing ledgered"), "{out}");
    let (_, ledger) = get(&app, YARD_ORG, hull.vessel, "/ledger").await;
    assert_eq!(actions(&ledger), ["HULL_BOOTSTRAPPED"], "{ledger}");
    let (_, register) = get(&app, YARD_ORG, hull.vessel, "/register").await;
    assert_ne!(register["served"], "ingested", "{register}");

    // 3. The load: documents in door order, then the export.
    let (code, out, err) = wadl(&load);
    println!("wadl load-docs onto {}:\n{out}", hull.hull_no);
    assert_eq!(code, 0, "load-docs\n{out}\n{err}");
    let seq_lines = out.lines().filter(|l| l.contains("ledger seq")).count();
    assert_eq!(
        seq_lines, 8,
        "seven documents and the export, each with its row:\n{out}"
    );
    assert!(out.contains("schedule of record:"), "{out}");

    // 4. The read-back through the scoped API, and 5. the ledger.
    let (served, live) = assert_reference_hull_served(&app, hull.vessel).await;
    let rows = assert_load_ledgered(&app, hull.vessel).await;
    println!(
        "served from PostgreSQL: 476 spaces on 12 decks, {served} activities, {live} live hazards, {rows} ledger rows (verified)"
    );

    // 6. The other tenant sees none of it, even claiming the assignment.
    let (status, _) = get(&app, NAVY_ORG, hull.vessel, "/register").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = get(&app, NAVY_ORG, hull.vessel, "/ledger").await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // 7. Applying the statement again changes nothing and writes no row.
    let (code, out, _) = wadl(&bootstrap);
    assert_eq!(code, 0, "{out}");
    assert!(!out.contains("created"), "{out}");
    let (_, again) = get(&app, YARD_ORG, hull.vessel, "/ledger").await;
    assert_eq!(again["entries"].as_array().unwrap().len(), rows);
}

/// A refusal at one file is a refusal of that file: what came before it is
/// committed and listed, what came after it is not touched, exit code 2.
#[tokio::test]
async fn a_bad_document_refuses_that_file_and_keeps_the_ones_before_it() {
    let Some(url) = database_url() else {
        eprintln!("DATABASE_URL not set; skipping the database test");
        return;
    };
    let hull = TestHull::mint();
    let statement = hull.statement.to_string_lossy().into_owned();
    let (code, out, err) = wadl(&[
        "bootstrap-hull",
        "--statement",
        &statement,
        "--database-url",
        &url,
    ]);
    assert_eq!(code, 0, "{out}\n{err}");

    // The clock is good, the register names a deck it does not declare, the
    // zones never get their turn.
    let docs = hull.dir.join("docs");
    std::fs::create_dir_all(&docs).unwrap();
    std::fs::copy(
        repo_root().join("reference/cvn73/CVN73-clock.csv"),
        docs.join("T-clock.csv"),
    )
    .unwrap();
    std::fs::write(
        docs.join("T-register.csv"),
        "deck,3rd,Third,3\nspace,3-148-2-E,Switchgear,9th,Z4,Electrical\n",
    )
    .unwrap();
    std::fs::copy(
        repo_root().join("reference/cvn73/CVN73-zones.csv"),
        docs.join("T-zones.csv"),
    )
    .unwrap();

    let (code, out, err) = wadl(&[
        "load-docs",
        "--dir",
        &docs.to_string_lossy(),
        "--org",
        &YARD_ORG.to_string(),
        "--vessel",
        &hull.vessel.to_string(),
        "--database-url",
        &url,
    ]);
    assert_eq!(code, 2, "a refusal exits 2\n{out}\n{err}");
    assert!(
        err.contains("T-register.csv") && err.contains("9th"),
        "{err}"
    );
    assert!(
        out.contains("yard clock:") && out.contains("ledger seq"),
        "{out}"
    );
    assert!(err.contains("stay committed"), "{err}");

    let app = router(&url).await;
    let (_, ledger) = get(&app, YARD_ORG, hull.vessel, "/ledger").await;
    assert_eq!(ledger["verified"], true);
    assert_eq!(
        actions(&ledger),
        ["DOCUMENT_REPLACED", "HULL_BOOTSTRAPPED"],
        "the clock committed, nothing after the refusal did: {ledger}"
    );
    let (_, clock) = get(&app, YARD_ORG, hull.vessel, "/yard-clock").await;
    assert_eq!(clock["label"], "T-clock.csv", "{clock}");
    let (_, register) = get(&app, YARD_ORG, hull.vessel, "/register").await;
    assert_ne!(register["served"], "ingested", "{register}");
}

/// `wadl verify-ledger --database-url` reads every hull's chain as the owner
/// and names the hull; a row altered under the owner's own session is
/// reported at its `seq`, exit 1; put back, the chain verifies again.
#[tokio::test]
async fn verify_ledger_reads_a_live_database_and_reports_per_hull() {
    let Some(url) = database_url() else {
        eprintln!("DATABASE_URL not set; skipping the database test");
        return;
    };
    let hull = TestHull::mint();
    let statement = hull.statement.to_string_lossy().into_owned();
    let (code, out, err) = wadl(&[
        "bootstrap-hull",
        "--statement",
        &statement,
        "--database-url",
        &url,
    ]);
    assert_eq!(code, 0, "{out}\n{err}");

    let (code, out, err) = wadl(&["verify-ledger", "--database-url", &url]);
    assert_eq!(code, 0, "{out}\n{err}");
    assert!(
        out.contains(&format!("{} · 1 entry verify", hull.hull_no)),
        "{out}"
    );
    assert!(out.contains("hulls verify"), "{out}");

    // Tamper as the owner, the way no door can: the row's own detail.
    let store = PgStore::connect(&url).await.unwrap();
    let seq: i64 = sqlx::query_scalar("SELECT min(entry_id) FROM audit_entry WHERE vessel_id = $1")
        .bind(hull.vessel)
        .fetch_one(store.pool())
        .await
        .unwrap();
    sqlx::query("UPDATE audit_entry SET detail = detail || ' ' WHERE entry_id = $1")
        .bind(seq)
        .execute(store.pool())
        .await
        .unwrap();
    let (code, out, err) = wadl(&["verify-ledger", "--database-url", &url]);
    assert_eq!(code, 1, "{out}\n{err}");
    assert!(
        out.contains(&format!(
            "{} · BROKEN at seq {seq}: HashMismatch",
            hull.hull_no
        )),
        "{out}"
    );
    assert!(err.contains("BROKEN"), "{err}");

    // Put back; the chain re-hashes.
    sqlx::query(
        "UPDATE audit_entry SET detail = left(detail, length(detail) - 1) WHERE entry_id = $1",
    )
    .bind(seq)
    .execute(store.pool())
    .await
    .unwrap();
    let (code, out, _) = wadl(&["verify-ledger", "--database-url", &url]);
    assert_eq!(code, 0, "{out}");

    // Nothing named: refused, exit 2.
    let output = Command::new(env!("CARGO_BIN_EXE_wadl"))
        .arg("verify-ledger")
        .env_remove("DATABASE_URL")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2), "{output:?}");
}

/// The support bundle against the test database and a planted secret: no
/// uuid, no connection URL, no environment value, no person; the
/// migrations pending list is empty, the hull's chain verdict is in it.
#[tokio::test]
async fn the_support_bundle_carries_no_uuid_no_url_and_no_env_value() {
    let Some(url) = database_url() else {
        eprintln!("DATABASE_URL not set; skipping the database test");
        return;
    };
    let hull = TestHull::mint();
    let statement = hull.statement.to_string_lossy().into_owned();
    let (code, out, err) = wadl(&[
        "bootstrap-hull",
        "--statement",
        &statement,
        "--database-url",
        &url,
    ]);
    assert_eq!(code, 0, "{out}\n{err}");

    let out_path = hull.dir.join("bundle.json");
    let secret = "planted-proxy-key-value-7f3a";
    let output = Command::new(env!("CARGO_BIN_EXE_wadl"))
        .args([
            "support-bundle",
            "--out",
            &out_path.to_string_lossy(),
            "--database-url",
            &url,
            // Port 1 answers nothing: the bundle records the reason, not a failure.
            "--base",
            "http://127.0.0.1:1",
            "--journal-lines",
            "5",
        ])
        .env("WADL_PROXY_KEY", secret)
        .env("WADL_MARKINGS", "CUI|planted")
        .current_dir(repo_root())
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    let text = std::fs::read_to_string(&out_path).unwrap();
    let bundle: Value = serde_json::from_str(&text).unwrap();

    // Nothing that should not leave the yard.
    assert!(
        !text.contains(secret),
        "the proxy key value is in the bundle"
    );
    assert!(!text.contains("planted"), "an env value is in the bundle");
    assert!(
        !text.contains("postgres://"),
        "a connection URL is in the bundle"
    );
    assert!(
        !text.contains(&hull.vessel.to_string()) && !text.contains(&YARD_ORG.to_string()),
        "a uuid is in the bundle"
    );
    let bytes = text.as_bytes();
    let uuid_like = (0..bytes.len().saturating_sub(36)).any(|i| {
        bytes[i..i + 36]
            .iter()
            .enumerate()
            .all(|(pos, b)| match pos {
                8 | 13 | 18 | 23 => *b == b'-',
                _ => b.is_ascii_hexdigit(),
            })
    });
    assert!(!uuid_like, "a uuid-shaped string is in the bundle");

    // What it does carry.
    assert_eq!(bundle["generated_by"], "wadl support-bundle");
    assert_eq!(bundle["cli_version"]["schema"].as_str().unwrap().len(), 4);
    assert!(
        bundle["health"]
            .as_str()
            .is_some_and(|h| h.starts_with("unreachable:")),
        "{}",
        bundle["health"]
    );
    assert_eq!(bundle["migrations"]["pending"], json!([]));
    assert!(bundle["migrations"]["applied"].as_array().unwrap().len() >= 18);
    let verdict = bundle["ledger"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["hull_no"] == hull.hull_no)
        .unwrap_or_else(|| panic!("the hull's verdict: {}", bundle["ledger"]));
    assert_eq!(verdict["entries"], 1);
    assert_eq!(verdict["verified"], true);
    let set: Vec<&str> = bundle["environment"]["set"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert!(
        set.contains(&"WADL_PROXY_KEY") && set.contains(&"WADL_MARKINGS"),
        "{set:?}"
    );
    assert!(
        bundle["audit_recent"]["lines"].is_array(),
        "{}",
        bundle["audit_recent"]
    );
}
