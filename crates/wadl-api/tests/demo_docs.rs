//! The reference hull boots through the doors: `reference/cvn73` loads into
//! the demo world by the same paths a yard's documents take, and what the
//! API then serves is the documents — the register at scale, a zone chart
//! that partitions every deck, couplings the traces walk, the morning's log.
//! If the generated documents and the doors ever disagree, this is where it
//! shows, before anyone boots a demo.

#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use std::path::Path;
use std::sync::Arc;

use axum::http::StatusCode;
use serde_json::Value;
use support::Backend;
use wadl_domain::time::Timestamp;
use wadl_store::memory::{InMemoryStore, DEMO_ANCHOR_MS};
use wadl_store::Actor;

fn docs_dir() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../reference/cvn73")
}

/// The reference hull through the loader on whichever store `DATABASE_URL`
/// selects (`support::reference_hull`), with every document accounted for.
async fn booted() -> support::TestWorld {
    let tw = support::reference_hull().await;
    let loaded = &tw.loaded;
    assert!(loaded.register.is_some(), "{loaded:?}");
    assert!(loaded.zones.is_some(), "{loaded:?}");
    assert!(loaded.couplings.is_some(), "{loaded:?}");
    assert!(loaded.geometry.is_some(), "{loaded:?}");
    assert!(loaded.hazards.is_some(), "{loaded:?}");
    tw
}

#[tokio::test]
async fn the_reference_hull_is_served_at_scale_with_a_clean_zone_audit() {
    let tw = booted().await;

    let (status, register) = tw.get("/register").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(register["served"], "ingested", "{register}");
    let spaces = register["spaces_served"].as_u64().unwrap();
    assert!(spaces >= 400, "a carrier-sized register, got {spaces}");
    assert_eq!(register["decks_served"], 12);

    // Every deck in the register carries spaces, in the hull's order.
    let (_, decks) = tw.get("/decks").await;
    let ordinals: Vec<i64> = decks
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["ordinal"].as_i64().unwrap())
        .collect();
    let mut sorted = ordinals.clone();
    sorted.sort_unstable();
    assert_eq!(ordinals, sorted);
    assert!(decks
        .as_array()
        .unwrap()
        .iter()
        .all(|d| d["compartment_count"].as_u64().unwrap() > 0));

    // The chart partitions every deck: no space is outside its zone's blocks,
    // every zone the register uses is bounded, every bound names a zone in use.
    let (_, zones) = tw.get("/zones").await;
    assert_eq!(zones["source"], "CVN73-zones.csv");
    assert_eq!(
        zones["audit"]["out_of_bounds"].as_array().unwrap().len(),
        0,
        "{}",
        zones["audit"]
    );
    assert_eq!(
        zones["audit"]["unbounded_zones"].as_array().unwrap().len(),
        0
    );
    assert_eq!(
        zones["audit"]["unassigned_bounds"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    assert!(zones["bounds"]
        .as_array()
        .unwrap()
        .iter()
        .all(|b| b["top_deck"].is_string() && b["bottom_deck"].is_string()));

    // Couplings: the authored rows plus derived deck penetrations, walked.
    let (_, couplings) = tw.get("/couplings").await;
    assert_eq!(couplings["served"], "ingested");
    assert!(
        couplings["register"]["derived"].as_u64().unwrap() > 100,
        "{couplings}"
    );
    assert!(
        couplings["edges_served"].as_u64().unwrap()
            > couplings["register"]["authored"].as_u64().unwrap()
    );

    // The morning's log is live — and on the demo store the seeded facts
    // survived alongside it (a bootstrapped hull has no seed to survive).
    let (_, hazards) = tw.get("/hazards").await;
    let live = hazards["hazards"].as_array().unwrap();
    assert!(live.len() >= 25, "{}", live.len());
    if tw.backend == Backend::Memory {
        assert!(live.iter().any(|h| h["origin"] == "3-160-2-Q"));
    }
}

#[tokio::test]
async fn the_served_hull_evaluates_every_space_and_rolls_up_by_zone() {
    let tw = booted().await;
    let (status, verdicts) = tw.get("/deck-states").await;
    assert_eq!(status, StatusCode::OK);
    let rows = verdicts.as_array().unwrap();
    assert!(rows.len() >= 400);
    // The log's hazards refuse work somewhere — a hull with nothing shut is
    // not a hull under availability.
    assert!(
        rows.iter().any(|r| r["state"] != "ALLOW"),
        "nothing refused"
    );

    let (_, rollup) = tw.get("/readiness").await;
    let zones: Vec<&str> = rollup["zones"]
        .as_array()
        .unwrap()
        .iter()
        .map(|z| z["key"].as_str().unwrap())
        .collect();
    for z in ["Z1", "Z2", "Z3", "Z4", "Z5", "Z6"] {
        assert!(zones.contains(&z), "{zones:?}");
    }
}

#[tokio::test]
async fn a_document_the_doors_would_refuse_refuses_the_boot() {
    let (store, world) = InMemoryStore::demo_at(Timestamp::from_epoch_millis(DEMO_ANCHOR_MS));
    let dir = std::env::temp_dir().join(format!("wadl-demo-docs-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("bad-register.csv"),
        "deck,3rd,Third,3\nspace,3-148-2-E,Switchgear,9th,Z4,Electrical\n",
    )
    .unwrap();
    let err = wadl_api::documents::load_demo_docs(
        &store,
        &world.yard_scope(),
        world.cvn73,
        &dir,
        DEMO_ANCHOR_MS,
    )
    .await
    .unwrap_err();
    std::fs::remove_dir_all(&dir).ok();
    assert!(
        err.contains("bad-register.csv") && err.contains("9th"),
        "{err}"
    );
}

/// The boot path is ledgered like every other path: the served hull's
/// ledger opens with one `DOCUMENT_REPLACED` row per document the boot
/// loader carried, in door order, each `via: boot` under the binary's own
/// account — the truth about where the served hull came from, verifiable.
/// Booted exactly as `serve` boots the demo store (`load_demo_docs` on
/// `system:boot`); the store-generic loader is pinned in `production_path`.
#[tokio::test]
async fn the_boot_path_ledgers_every_document_it_loaded_via_boot() {
    let (store, world) = InMemoryStore::demo_at(Timestamp::from_epoch_millis(DEMO_ANCHOR_MS));
    let store: Arc<dyn wadl_store::Repositories> = Arc::new(store);
    let boot_scope = world.yard_scope().with_actor(Actor::system("boot"));
    let loaded = wadl_api::documents::load_demo_docs(
        store.as_ref(),
        &boot_scope,
        world.cvn73,
        &docs_dir(),
        DEMO_ANCHOR_MS,
    )
    .await
    .expect("the reference hull boots");
    let clock = wadl_domain::time::TestClock::new(Timestamp::from_epoch_millis(DEMO_ANCHOR_MS));
    let tw = support::TestWorld {
        app: wadl_api::build_router(wadl_api::AppState::new(store.clone(), Arc::new(clock))),
        world,
        store,
        backend: Backend::Memory,
        loaded,
    };
    let (status, ledger) = tw.get("/ledger").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ledger["verified"], true, "{ledger}");

    let kinds: Vec<&str> = tw.loaded.ledger.iter().map(|l| l.kind.as_str()).collect();
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

    let entries = ledger["entries"].as_array().unwrap();
    let documents: Vec<&Value> = entries
        .iter()
        .filter(|e| e["action"] == "DOCUMENT_REPLACED")
        .collect();
    assert_eq!(documents.len(), tw.loaded.ledger.len(), "{ledger}");
    for entry in &documents {
        assert_eq!(entry["actor_id"], "system:boot", "{entry}");
        let detail: Value = serde_json::from_str(entry["detail"].as_str().unwrap()).unwrap();
        assert_eq!(detail["via"], "boot", "{detail}");
        let seq = entry["seq"].as_i64().unwrap();
        let line = tw
            .loaded
            .ledger
            .iter()
            .find(|l| l.seq == seq)
            .unwrap_or_else(|| panic!("seq {seq} is not one the loader reported"));
        assert_eq!(detail["kind"], line.kind, "{detail}");
        assert_eq!(detail["label"], line.label, "{detail}");
        assert!(detail["counts"].is_object(), "{detail}");
    }
    assert!(
        entries
            .iter()
            .all(|e| e["action"] == "DOCUMENT_REPLACED" || e["action"] == "HAZARD_RAISED"),
        "{ledger}"
    );
}
