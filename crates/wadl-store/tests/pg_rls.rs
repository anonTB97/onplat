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
//! DATABASE_URL=postgres://…/wadl_dev cargo test -p wadl-store --test pg_rls
//! ```

// doc_markdown fires on domain and product names (PostgreSQL, RLS); backticking
// them in prose hurts readability more than it helps.
#![allow(
    clippy::doc_markdown,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic
)]

use uuid::Uuid;
use wadl_domain::ids::{OrgId, VesselId};
use wadl_store::pg::PgStore;
use wadl_store::StoreError;
use wadl_store::TenantScope;

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
