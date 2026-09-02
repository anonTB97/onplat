//! Integration tests against a real PostgreSQL.
//!
//! These prove the two claims that matter about the database layer and that no
//! unit test can prove:
//!
//! 1. **Row-level security isolates tenants.** The queries in `pg_repo` carry no
//!    `org_id` clause; the database supplies the filter. So if a policy were
//!    dropped or mis-written, these tests fail — which is the point. A unit test
//!    against an in-memory store cannot catch a bad policy.
//! 2. **The queries match the schema.** The architecture wants `query_as!` for
//!    compile-time verification, but that needs `sqlx-cli` in the build; until
//!    then, executing every query here is what stops a column rename from
//!    shipping silently.
//!
//! Skipped unless `DATABASE_URL` is set, so `cargo test` stays green for anyone
//! without a database. Run them with:
//!
//! ```text
//! createdb wadl_dev
//! DATABASE_URL=postgres://…/wadl_dev cargo run -p wadl-cli -- migrate
//! DATABASE_URL=postgres://…/wadl_dev cargo test -p wadl-store --features postgres --test pg_rls
//! ```

// The pg seam is behind the `postgres` feature; without it this file compiles
// to nothing, matching the library it tests.
#![cfg(feature = "postgres")]
// doc_markdown fires on domain and product names (PostgreSQL, RLS); backticking
// them in prose hurts readability more than it helps.
#![allow(
    clippy::doc_markdown,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic
)]

use sqlx::Row as _;
use uuid::Uuid;
use wadl_domain::ids::{OrgId, VesselId};
use wadl_domain::time::Timestamp;
use wadl_store::memory::{GeometryRegister, ManningBook};
use wadl_store::model::{DeckCoverageSummary, ManningCrewSummary, SpaceGeometrySummary};
use wadl_store::pg::PgStore;
use wadl_store::StoreError;
use wadl_store::TenantScope;

/// A read instant after every clearance these tests record, so "live" means
/// "not cleared at all" — the pre-time-aware contract these assertions were
/// written against.
fn far_future() -> Timestamp {
    Timestamp::from_epoch_millis(i64::MAX / 4)
}

const YARD_ORG: u128 = 0x01;
const NAVY_ORG: u128 = 0x02;
const CVN73: u128 = 0x73;
const CVN71: u128 = 0x71;
const CVN75: u128 = 0x75;
const DDG: u128 = 0xDD13;
const LPD: u128 = 0x1D28;
const NAVY_HULL: u128 = 0x68;

fn org(n: u128) -> OrgId {
    OrgId::from_uuid(Uuid::from_u128(n))
}
fn vessel(n: u128) -> VesselId {
    VesselId::from_uuid(Uuid::from_u128(n))
}

/// The demo planner: yard tenant, assigned to the three carriers only.
fn yard_scope() -> TenantScope {
    TenantScope::new(org(YARD_ORG), [vessel(CVN73), vessel(CVN71), vessel(CVN75)])
}

/// A yard scope assigned to *every* yard hull — used to show that even full
/// assignment never crosses the tenant boundary.
fn yard_scope_all() -> TenantScope {
    TenantScope::new(
        org(YARD_ORG),
        [
            vessel(CVN73),
            vessel(CVN71),
            vessel(CVN75),
            vessel(DDG),
            vessel(LPD),
            // Deliberately claim the navy's hull. RLS must still refuse it: an
            // assignment claim from the application cannot widen the tenant gate.
            vessel(NAVY_HULL),
        ],
    )
}

/// Connects and seeds, or returns `None` when no database is configured.
async fn store() -> Option<PgStore> {
    let url = std::env::var("DATABASE_URL").ok()?;
    let store = PgStore::connect(&url)
        .await
        .expect("connecting to DATABASE_URL");
    store.migrate().await.expect("migrations");
    store.seed_demo().await.expect("seed");
    Some(store)
}

macro_rules! require_db {
    () => {
        match store().await {
            Some(store) => store,
            None => {
                eprintln!("skipping: DATABASE_URL not set");
                return;
            }
        }
    };
}

#[tokio::test]
async fn rls_hides_other_tenants_rows_entirely() {
    let store = require_db!();

    // Observed at the policy level, with no application-side filtering at all.
    let yard_sees = store.pg_count_visible_vessels(org(YARD_ORG)).await.unwrap();
    let navy_sees = store.pg_count_visible_vessels(org(NAVY_ORG)).await.unwrap();
    assert_eq!(yard_sees, 5, "the yard owns five hulls");
    assert_eq!(navy_sees, 1, "the navy owns one");
}

#[tokio::test]
async fn an_assignment_claim_cannot_widen_the_tenant_gate() {
    let store = require_db!();

    // The scope claims assignment to the navy's hull. The database still refuses
    // it, because assignment is the *second* gate and never a substitute for the
    // first.
    let err = store
        .pg_get_vessel(&yard_scope_all(), vessel(NAVY_HULL))
        .await
        .expect_err("cross-tenant hull must not resolve");
    assert!(matches!(err, StoreError::NotFound));

    // And it never appears in a listing either.
    let listed = store.pg_list_vessels(&yard_scope_all()).await.unwrap();
    assert!(listed.iter().all(|v| v.vessel_id != vessel(NAVY_HULL)));
    assert_eq!(listed.len(), 5, "the five yard hulls, and only those");
}

#[tokio::test]
async fn the_assignment_gate_hides_unassigned_in_tenant_hulls() {
    let store = require_db!();
    let scope = yard_scope();

    let listed = store.pg_list_vessels(&scope).await.unwrap();
    assert_eq!(listed.len(), 3, "three assigned carriers");

    // In-tenant but unassigned: NotFound, the same answer as out-of-tenant, so
    // the response cannot be used to probe what exists.
    for unassigned in [vessel(DDG), vessel(LPD)] {
        assert!(matches!(
            store.pg_get_vessel(&scope, unassigned).await,
            Err(StoreError::NotFound)
        ));
    }
}

#[tokio::test]
async fn topology_reads_are_scoped_too() {
    let store = require_db!();
    let scope = yard_scope();

    // A cascade must not be usable as a side channel onto another hull's
    // topology, so the taxonomy reads refuse out-of-scope hulls as well.
    assert!(matches!(
        store.pg_list_decks(&scope, vessel(NAVY_HULL)).await,
        Err(StoreError::NotFound)
    ));
    assert!(matches!(
        store.pg_list_compartments(&scope, vessel(DDG)).await,
        Err(StoreError::NotFound)
    ));
}

#[tokio::test]
async fn decks_come_back_ordered_downward() {
    let store = require_db!();
    let decks = store
        .pg_list_decks(&yard_scope(), vessel(CVN73))
        .await
        .unwrap();

    assert_eq!(decks.len(), 4);
    let ordinals: Vec<i32> = decks.iter().map(|d| d.ordinal).collect();
    let mut sorted = ordinals.clone();
    sorted.sort_unstable();
    assert_eq!(ordinals, sorted, "ascending downward");

    // "Directly above" is a comparison on the ordinal, never a guess at a label.
    let third = decks.iter().find(|d| d.code == "3rd").unwrap();
    let fourth = decks.iter().find(|d| d.code == "4th").unwrap();
    assert!(third.ordinal < fourth.ordinal);
    assert!(
        decks.iter().all(|d| d.compartment_count > 0),
        "every seeded deck carries compartments"
    );
}

#[tokio::test]
async fn the_register_is_inherited_from_the_class() {
    let store = require_db!();
    let scope = yard_scope();

    let on_73 = store
        .pg_list_compartments(&scope, vessel(CVN73))
        .await
        .unwrap();
    let on_71 = store
        .pg_list_compartments(&scope, vessel(CVN71))
        .await
        .unwrap();

    assert!(!on_73.is_empty());
    // Sister ships share one authored template until a hull diverges — the whole
    // point of class/hull. No deltas are seeded, so the registers match exactly.
    let numbers = |v: &[wadl_store::model::CompartmentSummary]| {
        v.iter()
            .map(|c| c.compartment_no.to_string())
            .collect::<Vec<_>>()
    };
    assert_eq!(numbers(&on_73), numbers(&on_71));

    // And the compartment the cascade story turns on is present, with its deck
    // resolved through the class template rather than parsed from its number.
    let pump_room = on_73
        .iter()
        .find(|c| c.compartment_no.as_str() == "3-160-2-Q")
        .expect("3-160-2-Q is in the seeded register");
    assert_eq!(pump_room.deck_code, "3rd");
    assert_eq!(pump_room.deck_ordinal, 3);
    assert_eq!(pump_room.category, "Machinery / electrical");
}

// ============================================================================
// Full-trait coverage (POAM-2): every Repositories method against a real
// database, asserting the same invariants the in-memory tests pin — same
// topology math, same scope funnel, same ledger chain.
// ============================================================================

use wadl_domain::units::ManHours;
use wadl_store::memory::{BudgetBook, ScheduleOfRecord, ZoneRegister};
use wadl_store::model::ZoneBoundSummary;
use wadl_store::Repositories;

#[tokio::test]
async fn work_orders_roll_up_from_segment_spaces() {
    let store = require_db!();
    let orders = store
        .list_work_orders(&yard_scope(), vessel(CVN73))
        .await
        .unwrap();
    assert_eq!(orders.len(), 6, "six ordinary orders on the demo hull");
    let tank = orders.iter().find(|o| o.code == "WI-3318").unwrap();
    assert_eq!(tank.budget_hours, ManHours::new(680));
    assert_eq!(tank.earned_hours, ManHours::new(512));
    assert_eq!(tank.compartment_no.as_str(), "4-110-2-W");
    assert!(tank.planned.is_some(), "windows come from work_order");
    // Packages are not orders; the two registers do not bleed together.
    assert!(orders.iter().all(|o| o.code != "WI-2201"));
}

#[tokio::test]
async fn packages_carry_topology_and_the_trunk_holds_everything() {
    let store = require_db!();
    let scope = yard_scope();
    let packages = store.list_packages(&scope, vessel(CVN73)).await.unwrap();
    assert_eq!(packages.len(), 2);
    let hvac = packages.iter().find(|p| p.code == "WI-2201").unwrap();
    assert_eq!(hvac.segment_count, 6);
    assert_eq!(hvac.compartment_count, 11);

    // The same wadl-plan invariants the in-memory store pins: T1 is open at
    // 3-160-2-Q, so nothing is testable and every segment names T1.
    let package = store
        .get_package(&scope, vessel(CVN73), "WI-2201")
        .await
        .unwrap();
    let analysis = package.analyse();
    assert!(
        analysis.faults.is_empty(),
        "seed topology must be well formed"
    );
    assert_eq!(analysis.testable_segment_count, 0);
    for code in ["B1", "B2", "T2", "B3", "R1"] {
        let seg = analysis.segments.iter().find(|s| s.code == code).unwrap();
        assert!(seg.held_by.contains(&"T1".to_owned()), "{code} held by T1");
    }

    // And the stranded report agrees: worst offender is the open trunk space.
    let report = store.stranded_hours(&scope, vessel(CVN73)).await.unwrap();
    let worst = report.items.first().unwrap();
    assert_eq!(worst.package_code, "WI-2201");
    assert_eq!(worst.compartment_no.as_str(), "3-160-2-Q");

    // Unknown package code: not-found, same as an out-of-scope hull.
    assert!(matches!(
        store.get_package(&scope, vessel(CVN73), "WI-9999").await,
        Err(StoreError::NotFound)
    ));
}

#[tokio::test]
async fn engine_inputs_come_back_typed_with_rejection_paths_unused() {
    let store = require_db!();
    let scope = yard_scope();

    let graph = store.adjacency_graph(&scope, vessel(CVN73)).await.unwrap();
    assert_eq!(graph.edge_count(), 8, "the aft-third neighbourhood");

    let hazards = store
        .live_hazards(&scope, vessel(CVN73), far_future())
        .await
        .unwrap();
    assert_eq!(hazards.len(), 2);
    let origins: Vec<&str> = hazards.iter().map(|h| h.origin.as_str()).collect();
    assert!(origins.contains(&"3-160-2-Q"));
    assert!(origins.contains(&"3-148-2-E"));

    // The stored rule payloads must round-trip the engine's own seed exactly —
    // the 0011 contract, asserted at the byte level entry by entry.
    let rules = store.rules_in_force(&scope, vessel(CVN73)).await.unwrap();
    let expected = wadl_engine::RuleSet::seed_usn_hot_work();
    assert_eq!(
        rules.entries().len(),
        expected.entries().len(),
        "every seeded entry is served"
    );
    for want in expected.entries() {
        assert!(
            rules.entries().iter().any(|got| got == want),
            "rule {} v{:?} did not round-trip",
            want.rule_code,
            want.rule_version
        );
    }
}

#[tokio::test]
async fn ingested_documents_are_all_or_nothing_and_tenant_scoped() {
    let store = require_db!();
    let scope = yard_scope();
    let hull = vessel(CVN73);

    // Nothing ingested: the honest empty register, not an invented one.
    store.clear_schedule_of_record(&scope, hull).await.unwrap();
    assert!(store
        .list_activities(&scope, hull)
        .await
        .unwrap()
        .is_empty());
    assert!(store.schedule_source(&scope, hull).await.unwrap().is_none());

    // Install, read back, replace, revert.
    store
        .set_zone_register(
            &scope,
            hull,
            ZoneRegister {
                label: "CVN73-zones.csv".to_owned(),
                bounds: vec![ZoneBoundSummary {
                    zone: "Z6".to_owned(),
                    lo_frame: 140,
                    hi_frame: 180,
                }],
            },
        )
        .await
        .unwrap();
    let zones = store.zone_register(&scope, hull).await.unwrap().unwrap();
    assert_eq!(zones.label, "CVN73-zones.csv");
    assert_eq!(zones.bounds.len(), 1);

    // Another tenant cannot see the document, even claiming the hull.
    let navy = TenantScope::new(org(NAVY_ORG), [hull]);
    assert!(matches!(
        store.zone_register(&navy, hull).await,
        Err(StoreError::NotFound)
    ));

    store.clear_zone_register(&scope, hull).await.unwrap();
    assert!(store.zone_register(&scope, hull).await.unwrap().is_none());

    // The budget book uses the same door discipline.
    store
        .set_budget_book(
            &scope,
            hull,
            BudgetBook {
                label: "book.csv".to_owned(),
                items: vec![],
            },
        )
        .await
        .unwrap();
    assert!(store.budget_book(&scope, hull).await.unwrap().is_some());
    store.clear_budget_book(&scope, hull).await.unwrap();

    // A schedule of record round-trips through JSON with its full shape.
    let activities = vec![];
    store
        .set_schedule_of_record(
            &scope,
            hull,
            ScheduleOfRecord {
                label: "test.xer".to_owned(),
                activities,
                edges: vec![],
            },
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .schedule_source(&scope, hull)
            .await
            .unwrap()
            .as_deref(),
        Some("test.xer")
    );
    store.clear_schedule_of_record(&scope, hull).await.unwrap();
}

#[tokio::test]
async fn the_geometry_register_round_trips_and_stays_in_tenant() {
    let store = require_db!();
    let scope = yard_scope();
    let hull = vessel(CVN73);

    store.clear_geometry_register(&scope, hull).await.unwrap();
    assert!(store
        .geometry_register(&scope, hull)
        .await
        .unwrap()
        .is_none());

    store
        .set_geometry_register(
            &scope,
            hull,
            GeometryRegister {
                label: "CVN73-CA-extract.csv".to_owned(),
                spaces: vec![SpaceGeometrySummary {
                    compartment_no: "3-148-2-E".to_owned(),
                    fwd_frame: 148,
                    aft_frame: 154,
                }],
                decks: vec![DeckCoverageSummary {
                    deck_code: "3rd".to_owned(),
                    lo_frame: 20,
                    hi_frame: 210,
                }],
            },
        )
        .await
        .unwrap();
    let register = store
        .geometry_register(&scope, hull)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(register.label, "CVN73-CA-extract.csv");
    assert_eq!(register.spaces.first().map(|g| g.aft_frame), Some(154));
    assert_eq!(register.decks.first().map(|d| d.hi_frame), Some(210));

    let foreign = TenantScope::new(org(NAVY_ORG), [hull]);
    assert!(matches!(
        store.geometry_register(&foreign, hull).await,
        Err(StoreError::NotFound)
    ));

    store.clear_geometry_register(&scope, hull).await.unwrap();
    assert!(store
        .geometry_register(&scope, hull)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn the_manning_book_round_trips_and_stays_in_tenant() {
    let store = require_db!();
    let scope = yard_scope();
    let hull = vessel(CVN73);

    store.clear_manning_book(&scope, hull).await.unwrap();
    assert!(store.manning_book(&scope, hull).await.unwrap().is_none());

    store
        .set_manning_book(
            &scope,
            hull,
            ManningBook {
                label: "CVN73-manning.csv".to_owned(),
                crews: vec![ManningCrewSummary {
                    trade: "Electrical".to_owned(),
                    headcount: 12,
                }],
            },
        )
        .await
        .unwrap();
    let book = store.manning_book(&scope, hull).await.unwrap().unwrap();
    assert_eq!(book.label, "CVN73-manning.csv");
    assert_eq!(book.crews.len(), 1);
    assert_eq!(book.crews.first().map(|c| c.headcount), Some(12));

    // Another tenant cannot see the book — the hull itself is not-found.
    let foreign = TenantScope::new(org(NAVY_ORG), [hull]);
    assert!(matches!(
        store.manning_book(&foreign, hull).await,
        Err(StoreError::NotFound)
    ));

    store.clear_manning_book(&scope, hull).await.unwrap();
    assert!(store.manning_book(&scope, hull).await.unwrap().is_none());
}

#[tokio::test]
async fn the_ledger_chains_and_filters_in_postgres() {
    let store = require_db!();
    let scope = yard_scope();
    // CVN-75 so this test's entries do not interleave with other tests' hulls.
    let hull = vessel(CVN75);

    let first = store
        .append_audit(
            &scope,
            hull,
            "TEST_ONE",
            "detail one",
            Some("4-141-0-C"),
            1_000,
        )
        .await
        .unwrap();
    let second = store
        .append_audit(&scope, hull, "TEST_TWO", "detail two", None, 2_000)
        .await
        .unwrap();
    assert_eq!(
        second.prev_hash.as_deref(),
        Some(first.entry_hash.as_str()),
        "each entry chains to the last"
    );

    let all = store.list_audit(&scope, hull, None).await.unwrap();
    assert!(all.len() >= 2, "newest first, everything kept");
    assert_eq!(all.first().unwrap().action, "TEST_TWO");

    let filtered = store
        .list_audit(&scope, hull, Some("4-141-0-C"))
        .await
        .unwrap();
    assert!(filtered
        .iter()
        .all(|r| r.subject_ref.as_deref() == Some("4-141-0-C")));

    // The scope funnel applies to writes exactly as to reads.
    assert!(matches!(
        store
            .append_audit(&scope, vessel(DDG), "NOPE", "x", None, 3_000)
            .await,
        Err(StoreError::NotFound)
    ));
}

#[tokio::test]
async fn a_clearance_closes_the_row_and_respects_both_gates() {
    let store = require_db!();
    let scope = yard_scope();
    let hull = vessel(CVN71);

    // A transient hazard on CVN-71, so this test's mutation is disjoint from
    // the CVN-73 facts the other tests read. Inserted as the migration owner
    // (this pool), which bypasses RLS the same way the seed does.
    let pool = sqlx::PgPool::connect(&std::env::var("DATABASE_URL").unwrap())
        .await
        .unwrap();
    sqlx::query("DELETE FROM hazard WHERE vessel_id = $1 AND compartment_no = '2-100-0-E'")
        .bind(Uuid::from_u128(CVN71))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO hazard (org_id, vessel_id, compartment_no, kind, raised_at, label)
         VALUES ($1, $2, '2-100-0-E', 'hot_work_live', now(), 'transient test hazard')",
    )
    .bind(Uuid::from_u128(YARD_ORG))
    .bind(Uuid::from_u128(CVN71))
    .execute(&pool)
    .await
    .unwrap();

    // Another tenant cannot clear it — the hull itself is not-found.
    let foreign = TenantScope::new(org(NAVY_ORG), [hull]);
    assert!(matches!(
        store
            .clear_hazard(
                &foreign,
                hull,
                "2-100-0-E",
                wadl_engine::HazardKind::HotWorkLive,
                "x",
                0
            )
            .await,
        Err(StoreError::NotFound)
    ));

    // The owning scope clears it: served live before, closed after, and the
    // row keeps when and why (0012's pairing constraint holds them together).
    let before = store
        .live_hazards(&scope, hull, far_future())
        .await
        .unwrap();
    assert!(before.iter().any(|h| h.origin.as_str() == "2-100-0-E"));
    let cleared = store
        .clear_hazard(
            &scope,
            hull,
            "2-100-0-E",
            wadl_engine::HazardKind::HotWorkLive,
            "tags verified by test",
            1_778_649_300_000,
        )
        .await
        .unwrap();
    assert_eq!(cleared.len(), 1);
    assert_eq!(
        cleared.first().map(|h| h.label.as_str()),
        Some("transient test hazard")
    );
    let after = store
        .live_hazards(&scope, hull, far_future())
        .await
        .unwrap();
    assert!(!after.iter().any(|h| h.origin.as_str() == "2-100-0-E"));

    // A repeat clearance matches nothing — closure is not restampable.
    let again = store
        .clear_hazard(
            &scope,
            hull,
            "2-100-0-E",
            wadl_engine::HazardKind::HotWorkLive,
            "double click",
            1_778_649_300_001,
        )
        .await
        .unwrap();
    assert!(again.is_empty());

    // The closed row still exists with its basis — closure, not deletion.
    let row = sqlx::query(
        "SELECT cleared_basis FROM hazard
          WHERE vessel_id = $1 AND compartment_no = '2-100-0-E'",
    )
    .bind(Uuid::from_u128(CVN71))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        row.get::<Option<String>, _>("cleared_basis").as_deref(),
        Some("tags verified by test")
    );

    // Leave nothing behind for other runs.
    sqlx::query("DELETE FROM hazard WHERE vessel_id = $1 AND compartment_no = '2-100-0-E'")
        .bind(Uuid::from_u128(CVN71))
        .execute(&pool)
        .await
        .unwrap();
}
