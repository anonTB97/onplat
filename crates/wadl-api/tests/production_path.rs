//! The production path, pinned on whichever store `DATABASE_URL` selects:
//! the reference hull loaded through the doors' own loader onto a fresh hull
//! and served whole, every commit ledgered in door order, a second load
//! ledgered again, a refused file leaving the files before it committed and
//! the files after it untouched, a dry run storing nothing — and `/health`
//! carrying the build stamp and a schema state. On `PostgreSQL` every test
//! runs on its own bootstrapped hull (`support`), so this is the suite the
//! `production-path` CI job runs against the database.

#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use axum::http::StatusCode;
use serde_json::Value;
use support::{Backend, TestWorld, VIA};
use wadl_api::documents::{self, LoadVia};
use wadl_store::memory::DEMO_ANCHOR_MS;

const DOOR_ORDER: [&str; 7] = [
    "yard_clock",
    "p6_field_map",
    "compartment_register",
    "zone_register",
    "geometry_register",
    "coupling_register",
    "hazard_log",
];

/// The document rows on the hull's ledger, oldest first, as (kind, via).
async fn document_rows(tw: &TestWorld) -> (Value, Vec<(String, String)>) {
    let (status, ledger) = tw.get("/ledger").await;
    assert_eq!(status, StatusCode::OK, "{ledger}");
    let rows: Vec<(String, String)> = ledger["entries"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .filter(|e| e["action"] == "DOCUMENT_REPLACED")
        .map(|e| {
            let detail: Value = serde_json::from_str(e["detail"].as_str().unwrap()).unwrap();
            (
                detail["kind"].as_str().unwrap().to_owned(),
                detail["via"].as_str().unwrap_or("").to_owned(),
            )
        })
        .collect();
    (ledger, rows)
}

#[tokio::test]
async fn health_carries_the_build_stamp_and_a_schema_state() {
    let tw = support::reference_hull().await;
    let (status, health) = tw.get_root("/health").await;
    assert_eq!(status, StatusCode::OK, "{health}");
    let version = &health["version"];
    assert!(!version["git"].as_str().unwrap().is_empty(), "{version}");
    let schema = version["schema"].as_str().unwrap();
    assert!(
        schema.len() == 4 && schema.chars().all(|c| c.is_ascii_digit()),
        "{version}"
    );
    assert!(!version["built_at"].as_str().unwrap().is_empty());
    let expected = match tw.backend {
        Backend::Memory => "not_applicable",
        Backend::Postgres => "current",
    };
    assert_eq!(health["schema_state"], expected, "{health}");
    if tw.backend == Backend::Postgres {
        assert_eq!(
            health["store"]["schema_version"]
                .as_str()
                .unwrap()
                .parse::<u32>()
                .unwrap(),
            schema.parse::<u32>().unwrap(),
            "{health}"
        );
    }
}

#[tokio::test]
async fn the_reference_hull_is_served_whole() {
    let tw = support::reference_hull().await;
    let (status, register) = tw.get("/register").await;
    assert_eq!(status, StatusCode::OK, "{register}");
    assert_eq!(register["served"], "ingested");
    assert_eq!(register["spaces_served"], 476, "{register}");
    assert_eq!(register["decks_served"], 12, "{register}");

    let (_, decks) = tw.get("/decks").await;
    assert_eq!(decks.as_array().unwrap().len(), 12);

    let (_, activities) = tw.get("/activities").await;
    assert_eq!(
        activities["activities"].as_array().unwrap().len(),
        5706,
        "the full export is served"
    );
    assert_eq!(activities["schedule_source"], "CVN73-PIA26-full.xer");

    let (_, zones) = tw.get("/zones").await;
    assert_eq!(zones["source"], "CVN73-zones.csv");
    for key in ["out_of_bounds", "unbounded_zones", "unassigned_bounds"] {
        assert_eq!(
            zones["audit"][key].as_array().unwrap().len(),
            0,
            "{key}: {}",
            zones["audit"]
        );
    }

    let (_, couplings) = tw.get("/couplings").await;
    assert_eq!(couplings["served"], "ingested");
    assert!(couplings["register"]["derived"].as_u64().unwrap() > 100);

    let (_, hazards) = tw.get("/hazards").await;
    assert!(hazards["hazards"].as_array().unwrap().len() >= 25);
}

#[tokio::test]
async fn loading_through_the_doors_is_ledgered_in_door_order() {
    let tw = support::reference_hull().await;
    let (ledger, rows) = document_rows(&tw).await;
    assert_eq!(ledger["verified"], true, "{ledger}");
    let entries = ledger["entries"].as_array().unwrap();
    assert_eq!(entries[0]["action"], "SCHEDULE_REPLACED", "newest first");
    let kinds: Vec<&str> = rows.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(kinds, DOOR_ORDER);
    assert!(rows.iter().all(|(_, via)| via == VIA), "{rows:?}");
    // Every row the load wrote is on the test account; the bootstrap row on
    // PostgreSQL is the CLI's (`system:cli`), as `wadl bootstrap-hull` writes it.
    for entry in entries
        .iter()
        .filter(|e| e["action"] != "HULL_BOOTSTRAPPED")
    {
        assert_eq!(entry["actor_id"], format!("system:{VIA}"), "{entry}");
    }
    let schedule: Value = serde_json::from_str(entries[0]["detail"].as_str().unwrap()).unwrap();
    assert_eq!(schedule["via"], VIA);
    assert_eq!(schedule["activities"], 5706);
    match tw.backend {
        Backend::Postgres => {
            assert_eq!(entries.last().unwrap()["action"], "HULL_BOOTSTRAPPED");
            assert_eq!(entries.len(), 9, "{ledger}");
        }
        Backend::Memory => assert_eq!(entries.len(), 8, "{ledger}"),
    }
    // The loader's own account of what it wrote is the ledger's.
    let seqs: Vec<i64> = tw.loaded.ledger.iter().map(|l| l.seq).collect();
    let ledgered: Vec<i64> = entries
        .iter()
        .rev()
        .filter(|e| e["action"] == "DOCUMENT_REPLACED")
        .map(|e| e["seq"].as_i64().unwrap())
        .collect();
    assert_eq!(seqs, ledgered);
}

#[tokio::test]
async fn a_second_load_replaces_and_ledgers_again() {
    let tw = support::reference_hull().await;
    let again = documents::load_docs(
        tw.store.as_ref(),
        &tw.scope(),
        tw.world.cvn73,
        &support::docs_dir(),
        DEMO_ANCHOR_MS + 60_000,
        LoadVia {
            via: VIA,
            dry_run: false,
        },
    )
    .await
    .expect("the second load");
    assert_eq!(again.register, tw.loaded.register);
    assert_eq!(again.couplings, tw.loaded.couplings);
    let (ledger, rows) = document_rows(&tw).await;
    assert_eq!(ledger["verified"], true, "{ledger}");
    assert_eq!(rows.len(), 14, "{rows:?}");
    let kinds: Vec<&str> = rows.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(&kinds[7..], DOOR_ORDER);
    let (_, register) = tw.get("/register").await;
    assert_eq!(register["spaces_served"], 476);
}

/// A scratch directory of documents: the reference clock, a register naming
/// a deck it does not declare, the reference zone chart.
fn bad_docs(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "wadl-production-path-{tag}-{}",
        uuid::Uuid::now_v7()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::copy(
        support::docs_dir().join("CVN73-clock.csv"),
        dir.join("T-clock.csv"),
    )
    .unwrap();
    std::fs::write(
        dir.join("T-register.csv"),
        "deck,3rd,Third,3\nspace,3-148-2-E,Switchgear,9th,Z4,Electrical\n",
    )
    .unwrap();
    std::fs::copy(
        support::docs_dir().join("CVN73-zones.csv"),
        dir.join("T-zones.csv"),
    )
    .unwrap();
    dir
}

#[tokio::test]
async fn a_bad_register_refuses_the_file_and_stores_nothing_after_it() {
    let tw = support::empty_hull().await;
    let dir = bad_docs("refused");
    let refused = documents::load_docs(
        tw.store.as_ref(),
        &tw.scope(),
        tw.world.cvn73,
        &dir,
        DEMO_ANCHOR_MS,
        LoadVia {
            via: VIA,
            dry_run: false,
        },
    )
    .await
    .unwrap_err();
    std::fs::remove_dir_all(&dir).ok();
    assert!(
        refused.reason.contains("T-register.csv") && refused.reason.contains("9th"),
        "{refused}"
    );
    // The clock before it committed and is on the ledger; nothing after it.
    assert!(refused.loaded_before.clock.is_some());
    assert!(refused.loaded_before.register.is_none());
    assert!(refused.loaded_before.zones.is_none());
    assert_eq!(refused.loaded_before.ledger.len(), 1);
    let (_, clock) = tw.get("/yard-clock").await;
    assert_eq!(clock["label"], "T-clock.csv", "{clock}");
    let (_, register) = tw.get("/register").await;
    assert_ne!(register["served"], "ingested", "{register}");
    let (_, zones) = tw.get("/zones").await;
    assert_ne!(zones["source"], "T-zones.csv", "{zones}");
    let (_, rows) = document_rows(&tw).await;
    assert_eq!(rows, vec![("yard_clock".to_owned(), VIA.to_owned())]);
}

#[tokio::test]
async fn a_dry_run_stores_nothing_and_ledgers_nothing() {
    let tw = support::empty_hull().await;
    let (before, _) = document_rows(&tw).await;
    let rows_before = before["entries"].as_array().unwrap().len();
    let loaded = documents::load_docs(
        tw.store.as_ref(),
        &tw.scope(),
        tw.world.cvn73,
        &support::docs_dir(),
        DEMO_ANCHOR_MS,
        LoadVia {
            via: VIA,
            dry_run: true,
        },
    )
    .await
    .expect("a dry run of the reference hull validates");
    // Every file parsed and counted…
    assert_eq!(
        loaded.register,
        Some(("CVN73-register.csv".to_owned(), 12, 476))
    );
    assert!(loaded.couplings.is_some(), "{loaded:?}");
    assert!(loaded.hazards.is_some(), "{loaded:?}");
    // …and nothing stored or ledgered.
    assert!(loaded.ledger.is_empty());
    let (after, _) = document_rows(&tw).await;
    assert_eq!(after["entries"].as_array().unwrap().len(), rows_before);
    let (_, register) = tw.get("/register").await;
    assert_ne!(register["served"], "ingested", "{register}");
    let (_, zones) = tw.get("/zones").await;
    assert_ne!(zones["source"], "CVN73-zones.csv", "{zones}");
}
