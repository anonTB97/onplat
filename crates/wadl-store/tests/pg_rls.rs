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
    clippy::panic,
    clippy::indexing_slicing
)]

use sqlx::Row as _;
use uuid::Uuid;
use wadl_domain::ids::{OrgId, VesselId};
use wadl_domain::time::Timestamp;
use wadl_store::memory::{GeometryRegister, ManningBook, RuleTableDoc, SignOff, YardClockDoc};
use wadl_store::model::{
    DeckCoverageSummary, HullStatement, ManningCrewSummary, RowOutcome, SpaceGeometrySummary,
};
use wadl_store::pg::PgStore;
use wadl_store::StoreError;
use wadl_store::TenantScope;

/// A read instant after every clearance these tests record, so "live" means
/// "not cleared at all" — the pre-time-aware contract these assertions were
/// written against.
fn far_future() -> Timestamp {
    // 2100-01-01T00:00:00Z: past every instant these tests stamp, and inside
    // the range a timestamptz bind accepts (an i64::MAX-scale instant is not).
    Timestamp::from_epoch_millis(4_102_444_800_000)
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

/// The seed's hulls visible to `org_id` under the policy — the count the
/// tenancy assertions were written against. Hulls other tests bootstrap in
/// this database (`T-…`) are set aside by name inside the same
/// policy-filtered query, so the count is still the policy's row set with no
/// application-side gate in it.
async fn seed_hulls(store: &PgStore, org_id: OrgId) -> i64 {
    let mut tx = store.with_tenant(org_id).await.unwrap();
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM vessel WHERE hull_no NOT LIKE 'T-%'")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    n
}

#[tokio::test]
async fn rls_hides_other_tenants_rows_entirely() {
    let store = require_db!();

    // Observed at the policy level, with no application-side filtering at all.
    assert_eq!(
        seed_hulls(&store, org(YARD_ORG)).await,
        5,
        "the yard owns five hulls"
    );
    assert_eq!(
        seed_hulls(&store, org(NAVY_ORG)).await,
        1,
        "the navy owns one"
    );
    assert!(store.pg_count_visible_vessels(org(NAVY_ORG)).await.unwrap() >= 1);
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
    // the 0011 contract, asserted at the byte level entry by entry — with the
    // bindings and the end-anchored hold the seed audit wrote.
    let rules = store.rules_in_force(&scope, vessel(CVN73)).await.unwrap();
    let expected = wadl_engine::RuleSet::seed_usn_hot_work();
    assert_eq!(
        rules.entries().len(),
        expected.entries().len(),
        "every seeded entry is served, and only those"
    );
    for want in expected.entries() {
        assert!(
            rules.entries().iter().any(|got| got == want),
            "rule {} v{:?} did not round-trip",
            want.rule_code,
            want.rule_version
        );
    }
    let ids: Vec<String> = rules
        .entries()
        .iter()
        .map(|e| e.rule_version.to_string())
        .collect();
    assert!(
        ids.iter().any(|id| id.ends_with("0402")),
        "R04 from the close"
    );
    assert!(
        ids.iter().any(|id| id.ends_with("0902")),
        "R09's WARN reading"
    );
    assert!(
        !ids.iter().any(|id| id.ends_with("0401")),
        "…0401 is retired"
    );
}

/// A hull-row statement for a brand-new tenant: its own organisation and
/// class, so the test may rewrite that tenant's rule rows without touching
/// the seed world the other tests read.
fn fresh_tenant_statement() -> HullStatement {
    let tag = &Uuid::now_v7().simple().to_string()[24..];
    serde_json::from_value(serde_json::json!({
        "organization": { "org_id": Uuid::now_v7(), "kind": "shipbuilder", "name": format!("T-Yard-{tag}"), "country": "USA" },
        "class": { "class_id": Uuid::now_v7(), "code": format!("T-{tag}"), "name": "Test class", "hull_type": "CVN", "frame_min": 1, "frame_max": 260 },
        "vessel": { "vessel_id": Uuid::now_v7(), "hull_no": format!("T-{tag}"), "name": "Test hull" },
        "availability": { "availability_id": Uuid::now_v7(), "code": "T-26", "kind": "PIA", "location": "Test dock", "start_on": "2026-01-05", "end_on": "2026-09-30" }
    }))
    .unwrap()
}

/// Puts a tenant's R04 and R07 back the way a pre-S14 `wadl seed` wrote
/// them — under the raw seed uuids that seed used, which is what a database
/// from before S15's derived ids carries: R04 as `…0401` alone (version 1,
/// the raise-anchored payload, in force), R07's same-space row with the old
/// payload shape and a `hot_work` binding.
async fn regress_to_pre_s14(pool: &sqlx::PgPool, org: Uuid) {
    let r04: Uuid =
        sqlx::query_scalar("SELECT rule_id FROM rule WHERE org_id = $1 AND code = 'R04'")
            .bind(org)
            .fetch_one(pool)
            .await
            .unwrap();
    sqlx::query("DELETE FROM rule_version WHERE rule_id = $1")
        .bind(r04)
        .execute(pool)
        .await
        .unwrap();
    let old_r04 = serde_json::json!({
        "rule_code": "R04", "rule_version": "00000000-0000-0000-0000-000000000401",
        "hazard": "hot_work_live",
        "applies": { "Coupled": { "code": "deck_penetration", "max_hops": 1 } },
        "state": "SUSPEND", "authority": "NSTM Ch. 074 Vol.1 para 074-13; MIL-STD-1689A",
        "clearing_authority": "fire_marshal", "hold": 30, "waivable": false
    });
    // The raw seed uuid is shared across tenants' tables only in a test; a
    // v7 tail keeps two tenants in one database apart.
    let raw_0401 = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO rule_version (rule_version_id, rule_id, version_no, effective_from,
             trigger_expr, max_hops, result_state, clearing_expr, clearing_authority, waivable)
         VALUES ($1, $2, 1, timestamptz '2026-01-01 00:00Z', $3, 1, 'SUSPEND', '{}', 'fire_marshal', false)",
    )
    .bind(raw_0401)
    .bind(r04)
    .bind(&old_r04)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO rule_binding (rule_version_id, class_id, work_type, category)
         VALUES ($1, NULL, 'hot_work', NULL)",
    )
    .bind(raw_0401)
    .execute(pool)
    .await
    .unwrap();
    let old_r07 = serde_json::json!({
        "rule_code": "R07", "rule_version": "00000000-0000-0000-0000-000000000700",
        "hazard": "energised_bus", "applies": "SameSpace", "state": "BLOCK",
        "authority": "NSTM Ch. 300; NAVSEA S9086-KC-STM-010",
        "clearing_authority": "isolation_authority", "hold": null, "waivable": false
    });
    sqlx::query(
        "UPDATE rule_version rv SET trigger_expr = $2
           FROM rule r
          WHERE r.rule_id = rv.rule_id AND r.org_id = $1
            AND rv.trigger_expr->>'rule_version' = '00000000-0000-0000-0000-000000000700'",
    )
    .bind(org)
    .bind(&old_r07)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE rule_binding b SET work_type = 'hot_work'
           FROM rule_version rv JOIN rule r ON r.rule_id = rv.rule_id
          WHERE b.rule_version_id = rv.rule_version_id AND r.org_id = $1
            AND rv.trigger_expr->>'rule_version' = '00000000-0000-0000-0000-000000000700'",
    )
    .bind(org)
    .execute(pool)
    .await
    .unwrap();
}

/// A seed version's row under `org`, found by its payload's `rule_version`:
/// version number, binding work type, retired, payload carries a binding.
async fn version_row(
    pool: &sqlx::PgPool,
    org: Uuid,
    seed_version: u128,
) -> (i32, Option<String>, bool, bool) {
    let row = sqlx::query(
        "SELECT rv.version_no, b.work_type, rv.effective_to IS NOT NULL AS retired,
                rv.trigger_expr ? 'binding' AS has_binding
           FROM rule_version rv
           JOIN rule r ON r.rule_id = rv.rule_id
           LEFT JOIN rule_binding b ON b.rule_version_id = rv.rule_version_id
          WHERE r.org_id = $1 AND rv.trigger_expr->>'rule_version' = $2",
    )
    .bind(org)
    .bind(Uuid::from_u128(seed_version).to_string())
    .fetch_one(pool)
    .await
    .unwrap();
    (
        row.get("version_no"),
        row.get("work_type"),
        row.get("retired"),
        row.get("has_binding"),
    )
}

/// `wadl seed` / `wadl bootstrap-hull` on a tenant seeded before this slice:
/// `…0402` arrives as R04's version 2 (0004's `UNIQUE (rule_id, version_no)`
/// honoured), bound to any work; `…0401` is retired and no longer served;
/// a kept id has its payload and binding rewritten to what the seed means;
/// the outcome says `updated` and is ledgered; a third run changes nothing.
#[tokio::test]
async fn a_reseed_retires_the_raise_anchored_r04_and_rewrites_the_binding_it_means() {
    let store = require_db!();
    let statement = fresh_tenant_statement();
    let org = statement.organization.org_id;
    let hull = VesselId::from_uuid(statement.vessel.vessel_id);
    let scope = TenantScope::new(OrgId::from_uuid(org), [hull]);
    let now_ms = 1_780_000_000_000;
    let first = store
        .bootstrap_hull(&statement, "test-hull.json", false, now_ms)
        .await
        .unwrap();
    assert_eq!(first.rules, RowOutcome::Created);

    let pool = sqlx::PgPool::connect(&std::env::var("DATABASE_URL").unwrap())
        .await
        .unwrap();
    regress_to_pre_s14(&pool, org).await;
    let before = store.rules_in_force(&scope, hull).await.unwrap();
    let ids = |set: &wadl_engine::RuleSet| -> Vec<String> {
        set.entries()
            .iter()
            .map(|e| e.rule_version.to_string())
            .collect()
    };
    assert!(ids(&before).iter().any(|id| id.ends_with("0401")));
    assert!(!ids(&before).iter().any(|id| id.ends_with("0402")));

    let again = store
        .bootstrap_hull(&statement, "test-hull.json", false, now_ms + 1)
        .await
        .unwrap();
    assert_eq!(again.rules, RowOutcome::Updated, "{again:?}");
    assert!(
        again.ledger_seq.is_some(),
        "the update is on the hull's record"
    );

    let (v0402_no, v0402_binding, v0402_retired, _) = version_row(&pool, org, 0x0402).await;
    assert_eq!(v0402_no, 2, "numbered after the version already there");
    assert_eq!(v0402_binding, None, "R04 binds to any work below");
    assert!(!v0402_retired);
    let (_, _, v0401_retired, _) = version_row(&pool, org, 0x0401).await;
    assert!(v0401_retired, "…0401 retired");
    let (_, v0700_binding, _, v0700_has_binding) = version_row(&pool, org, 0x0700).await;
    assert_eq!(v0700_binding, None, "R07 binds to any work again");
    assert!(
        v0700_has_binding,
        "the kept id's payload carries its binding"
    );

    let served = store.rules_in_force(&scope, hull).await.unwrap();
    let seed = wadl_engine::RuleSet::seed_usn_hot_work();
    assert_eq!(served.entries().len(), seed.entries().len());
    for want in seed.entries() {
        assert!(
            served.entries().contains(want),
            "{} did not round-trip",
            want.rule_version
        );
    }
    assert!(!ids(&served).iter().any(|id| id.ends_with("0401")));

    let third = store
        .bootstrap_hull(&statement, "test-hull.json", false, now_ms + 2)
        .await
        .unwrap();
    assert_eq!(third.rules, RowOutcome::Existed);
    assert!(!third.changes_anything(), "{third:?}");
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
                    top_deck: None,
                    bottom_deck: None,
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
                parsed_in: Some("America/New_York · test-clock.csv".to_owned()),
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
    // The clock it was parsed in survives the round trip with it.
    assert_eq!(
        store
            .schedule_parsed_in(&scope, hull)
            .await
            .unwrap()
            .as_deref(),
        Some("America/New_York · test-clock.csv")
    );
    store.clear_schedule_of_record(&scope, hull).await.unwrap();
    assert!(store
        .schedule_parsed_in(&scope, hull)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn the_rule_table_round_trips_stays_in_tenant_and_rules_in_force_switch_to_it_and_back() {
    let store = require_db!();
    let scope = yard_scope();
    // CVN-75: the CVN-73 rules read elsewhere must keep seeing the seed.
    let hull = vessel(CVN75);
    let seed = wadl_engine::RuleSet::seed_usn_hot_work();

    store.clear_rule_table(&scope, hull).await.unwrap();
    assert!(store.rule_table(&scope, hull).await.unwrap().is_none());
    let from_seed = store.rules_in_force(&scope, hull).await.unwrap();
    assert_eq!(from_seed.entries().len(), seed.entries().len());

    // A table with R22 alone in force replaces the seed whole.
    let only_r22: Vec<wadl_engine::RuleEntry> = seed
        .entries()
        .iter()
        .filter(|e| e.rule_code == "R22")
        .cloned()
        .collect();
    let doc = RuleTableDoc {
        label: "CVN75-rule-table.csv".to_owned(),
        header: wadl_engine::rule_table::export_header(),
        rows: vec![vec!["R22".to_owned(); 22]],
        entries: only_r22.clone(),
        table_hash: "deadbeef".to_owned(),
        signoff: None,
    };
    store
        .set_rule_table(&scope, hull, doc.clone())
        .await
        .unwrap();
    let served = store.rule_table(&scope, hull).await.unwrap().unwrap();
    assert_eq!(
        served, doc,
        "label, header, rows, entries, hash and signature intact"
    );
    assert_eq!(
        store.rules_in_force(&scope, hull).await.unwrap(),
        wadl_engine::RuleSet::new(only_r22)
    );

    // Another tenant cannot see, replace, sign or clear it — NotFound, all.
    let foreign = TenantScope::new(org(NAVY_ORG), [hull]);
    assert!(matches!(
        store.rule_table(&foreign, hull).await,
        Err(StoreError::NotFound)
    ));
    assert!(matches!(
        store.set_rule_table(&foreign, hull, doc.clone()).await,
        Err(StoreError::NotFound)
    ));
    assert!(matches!(
        store.clear_rule_table(&foreign, hull).await,
        Err(StoreError::NotFound)
    ));

    // Signing writes the person onto the document; a hull without a table is
    // NotFound.
    let signoff = SignOff {
        signed_at_ms: 1_780_000_000_000,
        signer_id: "Y-2001".to_owned(),
        signer_name: "R. Alvarez".to_owned(),
        statement: "signed at the sitting".to_owned(),
        table_hash: "deadbeef".to_owned(),
        rows: vec!["00000000-0000-0000-0000-000000002201".to_owned()],
        ledger_seq: 7,
    };
    let signed = store
        .sign_rule_table(&scope, hull, signoff.clone())
        .await
        .unwrap();
    assert_eq!(signed.signoff, Some(signoff.clone()));
    assert_eq!(
        store
            .rule_table(&scope, hull)
            .await
            .unwrap()
            .unwrap()
            .signoff,
        Some(signoff.clone())
    );
    assert!(matches!(
        store.sign_rule_table(&foreign, hull, signoff.clone()).await,
        Err(StoreError::NotFound)
    ));
    store.clear_rule_table(&scope, vessel(CVN71)).await.unwrap();
    assert!(matches!(
        store.sign_rule_table(&scope, vessel(CVN71), signoff).await,
        Err(StoreError::NotFound)
    ));

    // Revert: the seed rows again.
    store.clear_rule_table(&scope, hull).await.unwrap();
    assert!(store.rule_table(&scope, hull).await.unwrap().is_none());
    assert_eq!(
        store
            .rules_in_force(&scope, hull)
            .await
            .unwrap()
            .entries()
            .len(),
        seed.entries().len()
    );
}

#[tokio::test]
async fn hazards_bearing_on_serves_the_fire_watch_tail_with_the_end_instant() {
    let store = require_db!();
    let scope = yard_scope();
    let hull = vessel(CVN75);
    let pool = sqlx::PgPool::connect(&std::env::var("DATABASE_URL").unwrap())
        .await
        .unwrap();
    let raised_ms = 1_778_649_300_000;
    let minute = |m: i64| Timestamp::from_epoch_millis(raised_ms + m * 60_000);
    let raised_at = chrono::DateTime::from_timestamp_millis(raised_ms).unwrap();
    sqlx::query("DELETE FROM hazard WHERE vessel_id = $1 AND compartment_no = '2-101-0-E'")
        .bind(Uuid::from_u128(CVN75))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO hazard (org_id, vessel_id, compartment_no, kind, raised_at, label)
         VALUES ($1, $2, '2-101-0-E', 'hot_work_live', $3, 'HW permit 2673 · weld repair')",
    )
    .bind(Uuid::from_u128(YARD_ORG))
    .bind(Uuid::from_u128(CVN75))
    .bind(raised_at)
    .execute(&pool)
    .await
    .unwrap();
    let tail = wadl_domain::units::Minutes::new(30);
    let permit = |set: &[wadl_engine::Hazard]| -> Option<wadl_engine::Hazard> {
        set.iter()
            .find(|h| h.origin.as_str() == "2-101-0-E")
            .cloned()
    };

    // Live: served, no `ended`.
    let open = store
        .hazards_bearing_on(&scope, hull, minute(45), tail)
        .await
        .unwrap();
    assert_eq!(permit(&open).map(|h| h.ended), Some(None));

    // The permit closes at +60 with its basis.
    store
        .clear_hazard(
            &scope,
            hull,
            "2-101-0-E",
            wadl_engine::HazardKind::HotWorkLive,
            "torch out, area walked",
            minute(60).epoch_millis(),
        )
        .await
        .unwrap();

    // Read at +50: still served, `ended` set to the later instant (time-honest).
    let scrubbed_back = store
        .hazards_bearing_on(&scope, hull, minute(50), tail)
        .await
        .unwrap();
    assert_eq!(
        permit(&scrubbed_back).and_then(|h| h.ended),
        Some(minute(60))
    );
    // Read at +70: inside the tail, served with `ended`; the live read is without it.
    let in_tail = store
        .hazards_bearing_on(&scope, hull, minute(70), tail)
        .await
        .unwrap();
    assert_eq!(permit(&in_tail).and_then(|h| h.ended), Some(minute(60)));
    let live = store.live_hazards(&scope, hull, minute(70)).await.unwrap();
    assert!(permit(&live).is_none());
    assert_eq!(
        live,
        store
            .hazards_bearing_on(
                &scope,
                hull,
                minute(70),
                wadl_domain::units::Minutes::new(0)
            )
            .await
            .unwrap(),
        "a zero tail is the live read"
    );
    // At +90 the tail has run: half-open, gone at the instant.
    assert!(permit(
        &store
            .hazards_bearing_on(&scope, hull, minute(89), tail)
            .await
            .unwrap()
    )
    .is_some());
    assert!(permit(
        &store
            .hazards_bearing_on(&scope, hull, minute(90), tail)
            .await
            .unwrap()
    )
    .is_none());
    // Another tenant: NotFound.
    let foreign = TenantScope::new(org(NAVY_ORG), [hull]);
    assert!(matches!(
        store
            .hazards_bearing_on(&foreign, hull, minute(70), tail)
            .await,
        Err(StoreError::NotFound)
    ));

    sqlx::query("DELETE FROM hazard WHERE vessel_id = $1 AND compartment_no = '2-101-0-E'")
        .bind(Uuid::from_u128(CVN75))
        .execute(&pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn the_yard_clock_round_trips_and_stays_in_tenant() {
    let store = require_db!();
    let scope = yard_scope();
    let hull = vessel(CVN73);

    // The database-backed store defaults to no clock — UTC, honestly — until
    // one arrives through the door; nothing is seeded.
    store.clear_yard_clock(&scope, hull).await.unwrap();
    assert!(store.yard_clock(&scope, hull).await.unwrap().is_none());

    let mut doc = YardClockDoc::norfolk_seed();
    doc.label = "CVN73-clock.csv".to_owned();
    store
        .set_yard_clock(&scope, hull, doc.clone())
        .await
        .unwrap();
    let served = store.yard_clock(&scope, hull).await.unwrap().unwrap();
    assert_eq!(served, doc, "zone, offsets, rule, watch and shifts intact");
    assert_eq!(served.clock.zone, "America/New_York");
    assert_eq!(served.clock.shifts.len(), 3);

    // Another tenant cannot see the clock — the hull itself is not-found.
    let foreign = TenantScope::new(org(NAVY_ORG), [hull]);
    assert!(matches!(
        store.yard_clock(&foreign, hull).await,
        Err(StoreError::NotFound)
    ));
    assert!(matches!(
        store.clear_yard_clock(&foreign, hull).await,
        Err(StoreError::NotFound)
    ));

    // Replaced whole, then reverted whole.
    let mut guam = doc.clone();
    guam.label = "CVN73-guam.csv".to_owned();
    guam.clock.zone = "Pacific/Guam".to_owned();
    guam.clock.standard_offset_minutes = 600;
    guam.clock.daylight = None;
    store.set_yard_clock(&scope, hull, guam).await.unwrap();
    let served = store.yard_clock(&scope, hull).await.unwrap().unwrap();
    assert_eq!(served.label, "CVN73-guam.csv");
    assert!(served.clock.daylight.is_none());

    store.clear_yard_clock(&scope, hull).await.unwrap();
    assert!(store.yard_clock(&scope, hull).await.unwrap().is_none());
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

/// Migration 0017: a ledger row names its person, hashed under chain format
/// 2, and a format-1 row from before the migration still verifies in the same
/// chain — the pilot database will hold both.
#[tokio::test]
async fn a_ledger_row_names_its_person_and_a_v1_row_before_it_still_verifies() {
    use wadl_store::ledger::{compute_hash, verify_records};
    use wadl_store::{Actor, ActorSource};

    let store = require_db!();
    // The LPD: assigned only through `yard_scope_all`, so no other test's
    // appends interleave with this chain.
    let hull = vessel(LPD);
    let scope =
        yard_scope_all().with_actor(Actor::new("1234567890", "R. Alvarez", ActorSource::Proxy));

    // A format-1 row, as the build before this one wrote them: no actor, no
    // version (the column default is 1), hashed the old way onto the chain's
    // current tail. Inserted as the migration owner, which bypasses RLS the
    // same way the seed does.
    let pool = sqlx::PgPool::connect(&std::env::var("DATABASE_URL").unwrap())
        .await
        .unwrap();
    let tail: Option<Vec<u8>> = sqlx::query_scalar(
        "SELECT entry_hash FROM audit_entry WHERE vessel_id = $1 ORDER BY entry_id DESC LIMIT 1",
    )
    .bind(Uuid::from_u128(LPD))
    .fetch_optional(&pool)
    .await
    .unwrap();
    let v1_hash = compute_hash(tail.as_deref(), "LEGACY_ROW", "before 0017", 1_000);
    sqlx::query(
        "INSERT INTO audit_entry
            (org_id, vessel_id, action, detail, occurred_at, prev_hash, entry_hash)
         VALUES ($1, $2, 'LEGACY_ROW', 'before 0017', to_timestamp(1), $3, $4)",
    )
    .bind(Uuid::from_u128(YARD_ORG))
    .bind(Uuid::from_u128(LPD))
    .bind(tail.as_deref())
    .bind(v1_hash.as_slice())
    .execute(&pool)
    .await
    .unwrap();

    // A format-2 row through the store, under the person.
    let appended = store
        .append_audit(&scope, hull, "HAZARD_CLEARED", "3-148-2-E", None, 2_000)
        .await
        .unwrap();
    assert_eq!(appended.chain_version, 2);
    assert_eq!(appended.actor_id.as_deref(), Some("1234567890"));
    assert_eq!(appended.actor_name.as_deref(), Some("R. Alvarez"));

    // Read back newest first; the chain verifies oldest first across formats.
    let newest_first = store.list_audit(&scope, hull, None).await.unwrap();
    let newest = newest_first.first().unwrap();
    assert_eq!(newest.actor_id.as_deref(), Some("1234567890"));
    assert_eq!(newest.chain_version, 2);
    let legacy = newest_first.get(1).unwrap();
    assert_eq!(legacy.action, "LEGACY_ROW");
    assert_eq!(legacy.chain_version, 1);
    assert_eq!(legacy.actor_id, None);
    let oldest_first: Vec<_> = newest_first.iter().rev().cloned().collect();
    assert_eq!(verify_records(&oldest_first), Ok(()));

    // The constraint: a format-2 row that names nobody is refused by the
    // table itself, not only by the code that writes it.
    let refused = sqlx::query(
        "INSERT INTO audit_entry
            (org_id, vessel_id, action, detail, occurred_at, prev_hash, entry_hash, chain_version)
         VALUES ($1, $2, 'NOBODY', 'x', to_timestamp(3), NULL, '\\x00'::bytea, 2)",
    )
    .bind(Uuid::from_u128(YARD_ORG))
    .bind(Uuid::from_u128(LPD))
    .execute(&pool)
    .await;
    let message = refused.expect_err("a v2 row with no actor must not insert");
    assert!(
        message
            .to_string()
            .contains("audit_entry_v2_names_a_person"),
        "unexpected refusal: {message}"
    );
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

#[tokio::test]
async fn a_raised_hazard_is_a_row_under_the_callers_org_and_clears_like_any_other() {
    let store = require_db!();
    let scope = yard_scope();
    let hull = vessel(CVN73);
    let raised_at = 4_070_908_800_000; // 2099-01-01Z — unique to this test
    let raised = store
        .raise_hazard(
            &scope,
            hull,
            "2-152-0-Q",
            wadl_engine::HazardKind::StopWork,
            raised_at,
            "SW-pg · transient stop-work",
        )
        .await
        .unwrap();
    assert_eq!(raised.origin.as_str(), "2-152-0-Q");

    // Served live, under the caller's org, and not to the other tenant.
    let live = store
        .live_hazards(&scope, hull, far_future())
        .await
        .unwrap();
    assert!(live
        .iter()
        .any(|h| h.label == "SW-pg · transient stop-work"));
    let navy = TenantScope::new(org(NAVY_ORG), [hull]);
    assert!(matches!(
        store.live_hazards(&navy, hull, far_future()).await,
        Err(StoreError::NotFound)
    ));

    // A read before it was raised still serves it (raising is the engine's
    // `since` to judge); a clearance ends it from its own instant onward.
    let cleared = store
        .clear_hazard(
            &scope,
            hull,
            "2-152-0-Q",
            wadl_engine::HazardKind::StopWork,
            "released in writing",
            raised_at + 60_000,
        )
        .await
        .unwrap();
    assert_eq!(cleared.len(), 1);
    let before = store
        .live_hazards(&scope, hull, Timestamp::from_epoch_millis(raised_at + 1))
        .await
        .unwrap();
    assert!(before
        .iter()
        .any(|h| h.label == "SW-pg · transient stop-work"));
    let after = store
        .live_hazards(&scope, hull, far_future())
        .await
        .unwrap();
    assert!(!after
        .iter()
        .any(|h| h.label == "SW-pg · transient stop-work"));
}

#[tokio::test]
async fn the_ship_registers_round_trip_and_replace_the_seed() {
    let store = require_db!();
    let scope = yard_scope();
    let hull = vessel(CVN73);
    store
        .clear_compartment_register(&scope, hull)
        .await
        .unwrap();
    store.clear_coupling_register(&scope, hull).await.unwrap();
    let seeded_spaces = store.list_compartments(&scope, hull).await.unwrap().len();
    let seeded_edges = store
        .adjacency_graph(&scope, hull)
        .await
        .unwrap()
        .edge_count();

    store
        .set_compartment_register(
            &scope,
            hull,
            wadl_store::memory::CompartmentRegister {
                label: "CVN73-compartment-list.csv".to_owned(),
                decks: vec![wadl_store::model::RegisterDeckSummary {
                    code: "3rd".to_owned(),
                    label: "Third Deck".to_owned(),
                    ordinal: 3,
                }],
                spaces: vec![wadl_store::model::RegisterSpaceSummary {
                    compartment_no: "3-148-2-E".to_owned(),
                    name: "Switchgear".to_owned(),
                    deck_code: "3rd".to_owned(),
                    zone: "Z5".to_owned(),
                    category: "Electrical".to_owned(),
                    frame: Some(148),
                    side: Some("port".to_owned()),
                }],
            },
        )
        .await
        .unwrap();
    let served = store.list_compartments(&scope, hull).await.unwrap();
    assert_eq!(served.len(), 1, "the ingested register replaces the seed");
    assert_eq!(
        served.first().map(|c| c.geometry_source.as_str()),
        Some("register")
    );
    assert_eq!(store.list_decks(&scope, hull).await.unwrap().len(), 1);

    let types = store.coupling_types(&scope, hull).await.unwrap();
    assert!(
        types.iter().any(|t| t.code == "deck_penetration"),
        "{types:?}"
    );
    store
        .set_coupling_register(
            &scope,
            hull,
            wadl_store::memory::CouplingRegister {
                label: "couplings.csv".to_owned(),
                edges: vec![wadl_store::model::CouplingRowSummary {
                    from: "3-148-2-E".to_owned(),
                    to: "3-160-2-Q".to_owned(),
                    code: "deck_penetration".to_owned(),
                    symmetric: true,
                    provenance: "authored".to_owned(),
                }],
            },
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .adjacency_graph(&scope, hull)
            .await
            .unwrap()
            .edge_count(),
        2,
        "a symmetric row is two edges"
    );

    // Neither document leaks to the other tenant.
    let navy = TenantScope::new(org(NAVY_ORG), [hull]);
    assert!(matches!(
        store.compartment_register(&navy, hull).await,
        Err(StoreError::NotFound)
    ));

    store
        .clear_compartment_register(&scope, hull)
        .await
        .unwrap();
    store.clear_coupling_register(&scope, hull).await.unwrap();
    assert_eq!(
        store.list_compartments(&scope, hull).await.unwrap().len(),
        seeded_spaces
    );
    assert_eq!(
        store
            .adjacency_graph(&scope, hull)
            .await
            .unwrap()
            .edge_count(),
        seeded_edges
    );
}

/// A run as the door would build one: the summary's `run_id`, `seq` and
/// `served` are placeholders the store overwrites.
fn run_named(label: &str, code: &str, at_ms: i64) -> wadl_store::model::ScheduleRun {
    use wadl_store::model::{
        ActivityStatus, ActivitySummary, ImportedBy, QuarantinedRow, Reliability, RunCounts,
        ScheduleRun, ScheduleRunReport, ScheduleRunSummary,
    };
    let activity = ActivitySummary {
        activity_id: wadl_domain::ids::ActivityId::from_uuid(Uuid::from_u128(0xA1)),
        code: code.to_owned(),
        name: format!("Work {code}"),
        work_order_code: Some("WI-3318".to_owned()),
        compartment_no: Some(wadl_domain::CompartmentNo::new("4-110-2-W")),
        compartment_reliability: Reliability::High,
        wbs_area: Some("Z6".to_owned()),
        trade: "SM-PRES".to_owned(),
        planned: None,
        budget_hours: wadl_domain::units::ManHours::new(40),
        earned_hours: wadl_domain::units::ManHours::ZERO,
        status: ActivityStatus::NotStarted,
        is_milestone: false,
        source_ref: format!("{label} · {code}"),
        work_type: None,
    };
    ScheduleRun {
        summary: ScheduleRunSummary {
            run_id: Uuid::nil(),
            seq: 0,
            label: label.to_owned(),
            imported_at_ms: at_ms,
            imported_by: ImportedBy {
                org: org(YARD_ORG),
                person: Some("dev:planner".to_owned()),
                via: "door".to_owned(),
            },
            encoding: "utf-8".to_owned(),
            decoded_by: "browser".to_owned(),
            projects_served: vec!["CVN73-PIA26".to_owned()],
            counts: RunCounts {
                task_rows: 2,
                served: 1,
                work: 1,
                quarantined: 1,
                ..RunCounts::default()
            },
            field_map: serde_json::json!({ "compartment": { "source": "udf", "name": "COMPT" } }),
            served: false,
            schema_version: 0,
        },
        report: ScheduleRunReport {
            quarantine: vec![QuarantinedRow {
                line: 44,
                table: "TASK".to_owned(),
                code: Some("A4021".to_owned()),
                class: "unparseable_date".to_owned(),
                reason: "unparseable early_start_date: \"2026-13-40 06:00\"".to_owned(),
            }],
            fields_seen: serde_json::json!({ "sections": { "TASK": 2 } }),
            findings: vec!["2 projects in this export".to_owned()],
            ..ScheduleRunReport::default()
        },
        doc: Some(wadl_store::memory::ScheduleOfRecord {
            label: label.to_owned(),
            activities: vec![activity],
            edges: vec![],
            parsed_in: Some("America/New_York · CVN73-clock.csv".to_owned()),
        }),
    }
}

/// Two commits on the reference hull: each is a run AND the served
/// document, in one write.
async fn two_runs(
    store: &PgStore,
    scope: &TenantScope,
    hull: VesselId,
) -> (
    wadl_store::model::ScheduleRunSummary,
    wadl_store::model::ScheduleRunSummary,
) {
    let first = store
        .commit_schedule_run(scope, hull, run_named("a.xer", "A1", 1_000_000))
        .await
        .unwrap();
    let second = store
        .commit_schedule_run(scope, hull, run_named("b.xer", "B1", 2_000_000))
        .await
        .unwrap();
    (first, second)
}

#[tokio::test]
async fn schedule_runs_are_recorded_listed_newest_first_and_stay_in_tenant() {
    let store = require_db!();
    let scope = yard_scope();
    // Its own hull: the tests run in parallel, and two writers on one hull's
    // served pointer would race each other, not the store.
    let hull = vessel(CVN75);
    let (first, second) = two_runs(&store, &scope, hull).await;
    assert_ne!(first.run_id, second.run_id);
    assert_ne!(first.run_id, Uuid::nil(), "the store minted it");
    assert_eq!(second.seq, first.seq + 1);
    assert!(second.served);
    assert_eq!(second.schema_version, wadl_store::DOCUMENT_SCHEMA_VERSION);

    // Newest first, no documents, the served flag on the last commit only.
    let runs = store.list_schedule_runs(&scope, hull).await.unwrap();
    assert_eq!(runs[0].run_id, second.run_id);
    assert_eq!(runs[1].run_id, first.run_id);
    assert!(runs[0].served && !runs[1].served);
    assert_eq!(runs[1].label, "a.xer");
    assert_eq!(runs[1].imported_at_ms, 1_000_000);
    assert_eq!(runs[1].imported_by.person.as_deref(), Some("dev:planner"));
    assert_eq!(runs[1].imported_by.via, "door");
    assert_eq!(runs[1].encoding, "utf-8");
    assert_eq!(runs[1].decoded_by, "browser");
    assert_eq!(runs[1].counts.quarantined, 1);
    assert_eq!(runs[1].projects_served, ["CVN73-PIA26"]);
    assert_eq!(runs[1].field_map["compartment"]["name"], "COMPT");
    assert_eq!(
        store
            .served_schedule_run(&scope, hull)
            .await
            .unwrap()
            .map(|r| r.run_id),
        Some(second.run_id)
    );
    let served_rows = store.list_activities(&scope, hull).await.unwrap();
    assert_eq!(served_rows[0].code, "B1");

    // The detail carries the report and the document; the run's own row
    // says which run its document is.
    let whole = store
        .schedule_run(&scope, hull, first.run_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(whole.report.quarantine[0].line, 44);
    assert_eq!(whole.report.quarantine[0].class, "unparseable_date");
    assert_eq!(whole.report.fields_seen["sections"]["TASK"], 2);
    assert_eq!(whole.report.findings, ["2 projects in this export"]);
    let doc = whole.doc.expect("PostgreSQL keeps every document");
    assert_eq!(doc.label, "a.xer");
    assert_eq!(doc.activities[0].code, "A1");
    assert_eq!(
        doc.parsed_in.as_deref(),
        Some("America/New_York · CVN73-clock.csv")
    );

    // The navy sees none of it, even claiming the hull.
    let navy = TenantScope::new(org(NAVY_ORG), [hull]);
    assert!(matches!(
        store.list_schedule_runs(&navy, hull).await,
        Err(StoreError::NotFound)
    ));
    assert!(matches!(
        store.schedule_run(&navy, hull, first.run_id).await,
        Err(StoreError::NotFound)
    ));
    assert!(matches!(
        store.serve_schedule_run(&navy, hull, first.run_id).await,
        Err(StoreError::NotFound)
    ));
    assert!(matches!(
        store
            .commit_schedule_run(&navy, hull, run_named("navy.xer", "N1", 3_000_000))
            .await,
        Err(StoreError::NotFound)
    ));
}

#[tokio::test]
async fn serving_a_prior_run_moves_the_pointer_and_a_revert_keeps_history() {
    let store = require_db!();
    let scope = yard_scope();
    // Its own hull, for the same reason as the run-list test.
    let hull = vessel(CVN71);
    let (first, _second) = two_runs(&store, &scope, hull).await;

    // Serve run 1 again: the pointer follows, the register follows, no new
    // run is recorded.
    let before = store.list_schedule_runs(&scope, hull).await.unwrap().len();
    let served = store
        .serve_schedule_run(&scope, hull, first.run_id)
        .await
        .unwrap();
    assert_eq!(served.run_id, first.run_id);
    assert!(served.served);
    assert_eq!(
        store
            .served_schedule_run(&scope, hull)
            .await
            .unwrap()
            .map(|r| r.seq),
        Some(first.seq)
    );
    assert_eq!(
        store
            .schedule_source(&scope, hull)
            .await
            .unwrap()
            .as_deref(),
        Some("a.xer")
    );
    let served_rows = store.list_activities(&scope, hull).await.unwrap();
    assert_eq!(served_rows[0].code, "A1");
    let runs = store.list_schedule_runs(&scope, hull).await.unwrap();
    assert_eq!(runs.len(), before);
    assert!(runs[1].served && !runs[0].served);
    assert!(matches!(
        store.serve_schedule_run(&scope, hull, Uuid::nil()).await,
        Err(StoreError::NotFound)
    ));

    // A document set without a run is nobody's run; a revert keeps history.
    store
        .set_schedule_of_record(
            &scope,
            hull,
            run_named("plain.xer", "P1", 4_000_000).doc.unwrap(),
        )
        .await
        .unwrap();
    assert!(store
        .served_schedule_run(&scope, hull)
        .await
        .unwrap()
        .is_none());
    assert!(store
        .list_schedule_runs(&scope, hull)
        .await
        .unwrap()
        .iter()
        .all(|r| !r.served));
    store.clear_schedule_of_record(&scope, hull).await.unwrap();
    assert!(store
        .served_schedule_run(&scope, hull)
        .await
        .unwrap()
        .is_none());
    assert!(store.list_schedule_runs(&scope, hull).await.unwrap().len() >= 2);
}

#[tokio::test]
async fn the_field_map_round_trips_and_stays_in_tenant() {
    let store = require_db!();
    let scope = yard_scope();
    let hull = vessel(CVN73);

    store.clear_field_map(&scope, hull).await.unwrap();
    assert!(store.field_map(&scope, hull).await.unwrap().is_none());

    let doc = wadl_store::memory::FieldMapDoc {
        label: "CVN73-fieldmap.json".to_owned(),
        map: serde_json::json!({
            "compartment": { "source": "udf", "name": "COMPT" },
            "work_item": { "source": "udf", "name": "WI" },
            "work_type": { "source": "none" },
            "trade": { "source": "resource" },
            "projects": ["CVN73-PIA26"],
            "placards_from_names": true
        }),
    };
    store
        .set_field_map(&scope, hull, doc.clone())
        .await
        .unwrap();
    let served = store.field_map(&scope, hull).await.unwrap().unwrap();
    assert_eq!(served, doc, "the map comes back as it went in, unstamped");

    let foreign = TenantScope::new(org(NAVY_ORG), [hull]);
    assert!(matches!(
        store.field_map(&foreign, hull).await,
        Err(StoreError::NotFound)
    ));
    assert!(matches!(
        store.set_field_map(&foreign, hull, doc.clone()).await,
        Err(StoreError::NotFound)
    ));

    let mut replaced = doc;
    replaced.label = "CVN73-fieldmap-v2.json".to_owned();
    replaced.map["projects"] = serde_json::json!([]);
    store
        .set_field_map(&scope, hull, replaced.clone())
        .await
        .unwrap();
    assert_eq!(
        store.field_map(&scope, hull).await.unwrap().unwrap(),
        replaced
    );

    store.clear_field_map(&scope, hull).await.unwrap();
    assert!(store.field_map(&scope, hull).await.unwrap().is_none());
}

/// A hull-row statement for a fresh test hull in the yard tenant: the seed's
/// organisation and class (which will read `existed`), a new hull and
/// availability named by the caller.
fn test_statement(hull: Uuid, availability: Uuid, hull_no: &str) -> HullStatement {
    serde_json::from_value(serde_json::json!({
        "organization": { "org_id": org(YARD_ORG).as_uuid(), "kind": "shipbuilder", "name": "Demo Yard", "country": "USA" },
        "class": { "class_id": Uuid::from_u128(0xC0068), "code": "CVN-68", "name": "Nimitz class", "hull_type": "CVN", "frame_min": 1, "frame_max": 260 },
        "vessel": { "vessel_id": hull, "hull_no": hull_no, "name": "Test hull" },
        "availability": { "availability_id": availability, "code": "T-26", "kind": "PIA", "location": "Test dock", "start_on": "2026-01-05", "end_on": "2026-09-30" }
    }))
    .unwrap()
}

/// `wadl bootstrap-hull`'s store half: the four rows land once, the second
/// application is a no-op with no new ledger row, the hull's first ledger
/// row is `HULL_BOOTSTRAPPED` under `system:cli` and verifies, the other
/// tenant cannot see the hull even when "assigned" to it, a dry run writes
/// nothing, and the same hull number under a new id is refused whole.
#[tokio::test]
async fn a_bootstrapped_hull_is_invisible_to_the_other_tenant() {
    let store = require_db!();
    let hull_id = Uuid::now_v7();
    // The tail of a v7 uuid is its random half; the head is a timestamp that
    // two runs a minute apart share.
    let hull_no = format!("T-{}", &hull_id.simple().to_string()[24..]);
    let statement = test_statement(hull_id, Uuid::now_v7(), &hull_no);
    let now_ms = 1_780_000_000_000;

    let first = store
        .bootstrap_hull(&statement, "test-hull.json", false, now_ms)
        .await
        .unwrap();
    assert_eq!(first.organization, RowOutcome::Existed);
    assert_eq!(first.class, RowOutcome::Existed);
    assert_eq!(first.vessel, RowOutcome::Created);
    assert_eq!(first.availability, RowOutcome::Created);
    // The seed already gave the yard its rules; its coupling types too,
    // unless this database was seeded before the seed carried every baseline
    // code, in which case the bootstrap tops the tenant up once — either
    // way the second application below changes nothing.
    assert_eq!(first.rules, RowOutcome::Existed);
    assert_ne!(first.coupling_types, RowOutcome::WouldCreate);
    assert!(first.ledger_seq.is_some(), "{first:?}");

    let again = store
        .bootstrap_hull(&statement, "test-hull.json", false, now_ms + 1)
        .await
        .unwrap();
    assert!(!again.changes_anything(), "{again:?}");
    assert_eq!(again.ledger_seq, None);

    // Visible to the yard when assigned; invisible to the navy even when the
    // assignment claim names it — RLS, not the claim, decides.
    let hull = VesselId::from_uuid(hull_id);
    let yard = TenantScope::new(org(YARD_ORG), [hull]);
    let seen: Vec<String> = store
        .list_vessels(&yard)
        .await
        .into_iter()
        .map(|v| v.hull_no)
        .collect();
    assert_eq!(seen, vec![hull_no.clone()]);
    let navy = TenantScope::new(org(NAVY_ORG), [hull]);
    assert!(store.list_vessels(&navy).await.is_empty());
    assert!(matches!(
        store.list_audit(&navy, hull, None).await,
        Err(StoreError::NotFound)
    ));

    // The hull's ledger opens with the statement, chained and verifying.
    let ledger = store.list_audit(&yard, hull, None).await.unwrap();
    assert_eq!(ledger.len(), 1, "{ledger:?}");
    assert_eq!(ledger[0].action, "HULL_BOOTSTRAPPED");
    assert_eq!(ledger[0].actor_id.as_deref(), Some("system:cli"));
    assert_eq!(ledger[0].chain_version, 2);
    assert_eq!(Some(ledger[0].seq), first.ledger_seq);
    let detail: serde_json::Value = serde_json::from_str(&ledger[0].detail).unwrap();
    assert_eq!(detail["via"], "cli");
    assert_eq!(detail["statement"]["vessel"]["hull_no"], hull_no);
    assert_eq!(detail["outcome"]["vessel"], "created");
    assert_eq!(detail["outcome"]["class"], "existed");
    wadl_store::ledger::verify_records(&ledger).unwrap();

    // A dry run for another hull reports and writes nothing.
    let dry_id = Uuid::now_v7();
    let dry_no = format!("T-{}", &dry_id.simple().to_string()[24..]);
    let dry = store
        .bootstrap_hull(
            &test_statement(dry_id, Uuid::now_v7(), &dry_no),
            "test-hull.json",
            true,
            now_ms,
        )
        .await
        .unwrap();
    assert_eq!(dry.vessel, RowOutcome::WouldCreate);
    assert_eq!(dry.ledger_seq, None);
    let dry_scope = TenantScope::new(org(YARD_ORG), [VesselId::from_uuid(dry_id)]);
    assert!(store.list_vessels(&dry_scope).await.is_empty());

    // The same hull number under a new id is a mistake, refused whole.
    let clash = test_statement(Uuid::now_v7(), Uuid::now_v7(), &hull_no);
    match store
        .bootstrap_hull(&clash, "test-hull.json", false, now_ms)
        .await
    {
        Err(StoreError::Conflict(reason)) => {
            assert!(reason.contains(&hull_no), "{reason}");
            assert!(reason.contains("different id"), "{reason}");
        }
        other => panic!("expected a conflict, got {other:?}"),
    }
    let clash_scope =
        TenantScope::new(org(YARD_ORG), [VesselId::from_uuid(clash.vessel.vessel_id)]);
    assert!(store.list_vessels(&clash_scope).await.is_empty());

    // Leave the shared database as the seed left it: the owner's session can
    // delete what the application role never may.
    for sql in [
        "DELETE FROM audit_entry WHERE vessel_id = $1",
        "DELETE FROM ingest_run WHERE vessel_id = $1",
        "DELETE FROM availability WHERE vessel_id = $1",
        "DELETE FROM vessel WHERE vessel_id = $1",
    ] {
        sqlx::query(sql)
            .bind(hull_id)
            .execute(store.pool())
            .await
            .unwrap();
    }
    assert!(store.list_vessels(&yard).await.is_empty());
}
