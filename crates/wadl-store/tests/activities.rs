//! What the generated activity register is allowed to claim.
//!
//! The register is the platform's statement of *what work is planned at the
//! doing grain*, and its one non-negotiable property is that it reconciles with
//! the boards: every man-hour in an activity is a slice of a work order or a
//! package space the other surfaces already show. Today that is true by
//! construction — the register is generated from those rows — and these tests
//! exist so it STAYS true the day XER ingest replaces the generator with real
//! rows, when the guarantee stops being structural and becomes a report.

#![allow(missing_docs, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;

use wadl_domain::time::Timestamp;
use wadl_store::memory::{InMemoryStore, DEMO_ANCHOR_MS};
use wadl_store::model::{ActivityStatus, Reliability};
use wadl_store::Repositories;

fn store() -> (InMemoryStore, wadl_store::memory::DemoWorld) {
    InMemoryStore::demo_at(Timestamp::from_epoch_millis(DEMO_ANCHOR_MS))
}

#[tokio::test]
async fn every_activity_hour_reconciles_with_its_parent() {
    let (s, w) = store();
    let scope = w.yard_scope();
    let acts = s.list_activities(&scope, w.cvn73).await.unwrap();
    let orders = s.list_work_orders(&scope, w.cvn73).await.unwrap();
    let packages = s.list_packages(&scope, w.cvn73).await.unwrap();

    let mut budget: BTreeMap<String, i64> = BTreeMap::new();
    let mut earned: BTreeMap<String, i64> = BTreeMap::new();
    for a in &acts {
        if let Some(code) = &a.work_order_code {
            *budget.entry(code.clone()).or_default() += a.budget_hours.get();
            *earned.entry(code.clone()).or_default() += a.earned_hours.get();
        } else {
            assert!(
                a.is_milestone && a.budget_hours.get() == 0,
                "{}: unmapped work with hours would silently break the boards",
                a.code
            );
        }
    }
    for o in &orders {
        assert_eq!(
            budget.get(&o.code),
            Some(&o.budget_hours.get()),
            "{}",
            o.code
        );
        assert_eq!(
            earned.get(&o.code),
            Some(&o.earned_hours.get()),
            "{}",
            o.code
        );
    }
    for p in &packages {
        assert_eq!(
            budget.get(&p.code),
            Some(&p.budget_hours.get()),
            "{}",
            p.code
        );
        assert_eq!(
            earned.get(&p.code),
            Some(&p.earned_hours.get()),
            "{}",
            p.code
        );
    }
    // And nothing else: every mapped code is a real parent.
    let known: Vec<String> = orders
        .iter()
        .map(|o| o.code.clone())
        .chain(packages.iter().map(|p| p.code.clone()))
        .collect();
    for code in budget.keys() {
        assert!(
            known.contains(code),
            "activity mapped to unknown parent {code}"
        );
    }
}

#[tokio::test]
async fn the_register_is_deterministic_and_sized_like_a_register() {
    let (s1, w1) = store();
    let (s2, w2) = store();
    let a1 = s1
        .list_activities(&w1.yard_scope(), w1.cvn73)
        .await
        .unwrap();
    let a2 = s2
        .list_activities(&w2.yard_scope(), w2.cvn73)
        .await
        .unwrap();
    assert_eq!(
        a1, a2,
        "same anchor must mean the same register, byte for byte"
    );
    assert!(
        a1.len() >= 60,
        "a register of {} rows is a list, not a register",
        a1.len()
    );
}

#[tokio::test]
async fn status_earned_and_window_tell_one_story() {
    let (s, w) = store();
    let acts = s.list_activities(&w.yard_scope(), w.cvn73).await.unwrap();
    let mut saw_unknown_space = false;
    for a in &acts {
        match a.status {
            ActivityStatus::NotStarted => assert_eq!(a.earned_hours.get(), 0, "{}", a.code),
            ActivityStatus::InProgress => assert!(
                a.earned_hours.get() > 0 && a.earned_hours < a.budget_hours,
                "{}",
                a.code
            ),
            ActivityStatus::Complete => {
                assert_eq!(a.earned_hours, a.budget_hours, "{}", a.code);
            }
        }
        let w = a.planned.expect("the generated register is fully dated");
        assert!(w.start < w.end, "{}: empty window", a.code);
        if a.compartment_no.is_none() && !a.is_milestone {
            saw_unknown_space = true;
            assert_eq!(
                a.compartment_reliability,
                Reliability::Low,
                "{}: an unknown space must carry the grade that says so",
                a.code
            );
        }
    }
    assert!(
        saw_unknown_space,
        "the register must exercise the absent-compartment case before ingest lands"
    );
}

#[tokio::test]
async fn the_register_is_tenant_scoped() {
    let (s, w) = store();
    let err = s.list_activities(&w.yard_scope(), w.navy_hull).await;
    assert!(err.is_err(), "a foreign hull's register must be not-found");
}

/// The generated schedule edges: deterministic, every code resolving in the
/// register, the FS spine unremarkable, and exactly one deliberate negative
/// lag — the overlap-into-a-cure inversion the demo board surfaces.
#[tokio::test]
async fn the_schedule_edges_resolve_and_carry_one_deliberate_inversion() {
    let (store, world) = InMemoryStore::demo_at(Timestamp::from_epoch_millis(DEMO_ANCHOR_MS));
    let scope = world.yard_scope();
    let a = store
        .list_schedule_edges(&scope, world.cvn73)
        .await
        .unwrap();
    let b = store
        .list_schedule_edges(&scope, world.cvn73)
        .await
        .unwrap();
    assert_eq!(a, b, "same seed, same edges");
    assert!(!a.is_empty());

    let register = store.list_activities(&scope, world.cvn73).await.unwrap();
    let codes: std::collections::BTreeSet<&str> =
        register.iter().map(|r| r.code.as_str()).collect();
    for e in &a {
        assert!(codes.contains(e.pred_code.as_str()), "{e:?}");
        assert!(codes.contains(e.succ_code.as_str()), "{e:?}");
        assert_ne!(e.pred_code, e.succ_code, "{e:?}");
    }
    let negative: Vec<_> = a.iter().filter(|e| e.lag_hours < 0).collect();
    assert_eq!(negative.len(), 1, "{negative:?}");
    let inversion = negative.first().unwrap();
    let pred = register
        .iter()
        .find(|r| r.code == inversion.pred_code)
        .unwrap();
    assert_eq!(
        pred.compartment_no
            .as_ref()
            .map(wadl_domain::CompartmentNo::as_str),
        Some("3-160-2-Q"),
        "the inversion starts at the coating story's space"
    );
}
