//! Tests for package topology, testability and stranding.
//!
//! The worked example is the prototype's HVAC package (`WI-2201`, AC Plant No. 2
//! supply and return): a trunk feeding two branches and an aft trunk, which in
//! turn feeds a branch and a riser. It is the case the whole module exists for —
//! a finished branch that cannot be tested because the trunk under it is open.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::collections::BTreeMap;

use proptest::prelude::*;
use wadl_domain::compartment::CompartmentNo;
use wadl_domain::ids::{SegmentId, WorkOrderId};
use wadl_domain::units::ManHours;
use wadl_plan::{Package, Segment, SpaceWork};

fn seg(n: u128, code: &str, upstream: Option<u128>, comps: &[&str]) -> Segment {
    Segment {
        id: SegmentId::from_uuid(uuid::Uuid::from_u128(n)),
        code: code.to_owned(),
        kind: "Trunk".to_owned(),
        name: format!("segment {code}"),
        upstream: upstream.map(|u| SegmentId::from_uuid(uuid::Uuid::from_u128(u))),
        compartments: comps.iter().map(|c| CompartmentNo::new(*c)).collect(),
    }
}

/// Undated work: the topology analysis is time-invariant, so these tests say so
/// by leaving the window off rather than picking an arbitrary one. Whether a
/// compartment's hours are booked *at an instant* is a question for the surfaces;
/// whether they strand downstream scope is a question for the topology, and it
/// has the same answer on every day of the availability.
fn work(budget: i64, earned: i64) -> SpaceWork {
    SpaceWork {
        budget: ManHours::new(budget),
        earned: ManHours::new(earned),
        window: None,
    }
}

/// T1 (open) feeds B1 (complete) and T2 (complete); T2 feeds B3 (complete).
/// B1, T2 and B3 are all finished work that cannot be tested, because T1 is open.
fn package() -> Package {
    let spaces: BTreeMap<CompartmentNo, SpaceWork> = [
        // T1's compartments — one still open, 200 MH left.
        (CompartmentNo::new("3-172-0-M"), work(620, 620)),
        (CompartmentNo::new("3-148-0-L"), work(240, 40)),
        // B1 — finished.
        (CompartmentNo::new("2-160-1-Q"), work(560, 560)),
        // T2 — finished.
        (CompartmentNo::new("3-184-0-Q"), work(340, 340)),
        // B3 — finished.
        (CompartmentNo::new("2-176-0-Q"), work(300, 300)),
    ]
    .into_iter()
    .collect();

    Package {
        work_order_id: WorkOrderId::from_uuid(uuid::Uuid::from_u128(0x2201)),
        code: "WI-2201".to_owned(),
        name: "AC Plant No. 2 — supply & return distribution".to_owned(),
        test_verb: "leak-tested".to_owned(),
        segments: vec![
            seg(0x01, "T1", None, &["3-172-0-M", "3-148-0-L"]),
            seg(0x02, "B1", Some(0x01), &["2-160-1-Q"]),
            seg(0x03, "T2", Some(0x01), &["3-184-0-Q"]),
            seg(0x04, "B3", Some(0x03), &["2-176-0-Q"]),
        ],
        spaces,
    }
}

#[test]
fn an_open_trunk_holds_every_finished_thing_below_it() {
    let a = package().analyse();
    let status = |code: &str| a.segments.iter().find(|s| s.code == code).unwrap().clone();

    // T1 is open, so it is not testable and is held by nothing but itself.
    assert!(!status("T1").complete);
    assert!(!status("T1").testable);
    assert!(status("T1").held_by.is_empty());

    // B1, T2 and B3 are all COMPLETE but NOT testable — the whole point.
    for code in ["B1", "T2", "B3"] {
        let s = status(code);
        assert!(s.complete, "{code} is finished work");
        assert!(!s.testable, "{code} cannot be tested while T1 is open");
        assert!(
            s.held_by.contains(&"T1".to_owned()),
            "{code} must name T1 as its blocker, got {:?}",
            s.held_by
        );
    }

    // B3 is two levels down: it is held by T1, and T2 is complete so T2 is not
    // a blocker. A blocker list that named a complete ancestor would mislead.
    assert_eq!(status("B3").held_by, vec!["T1".to_owned()]);
    assert_eq!(a.testable_segment_count, 0);
}

#[test]
fn stranding_counts_hours_not_in_the_offending_compartment() {
    let a = package().analyse();
    // Only 3-148-0-L has work left, and it sits on T1.
    assert_eq!(a.stranding.len(), 1);
    let worst = &a.stranding[0];
    assert_eq!(worst.compartment, CompartmentNo::new("3-148-0-L"));
    assert_eq!(worst.own_remaining, ManHours::new(200));
    // Everything downstream is complete, so no *remaining* hours are stranded —
    // but the downstream segments are still named, because their TEST scope is
    // held even though their install is done.
    assert_eq!(worst.stranded_downstream, ManHours::ZERO);
    assert_eq!(worst.downstream_segments, vec!["B1", "B3", "T2"]);
}

#[test]
fn stranding_is_real_hours_when_downstream_work_remains() {
    let mut p = package();
    // Leave 500 MH open on B1, downstream of the open trunk.
    p.spaces
        .insert(CompartmentNo::new("2-160-1-Q"), work(560, 60));
    let a = p.analyse();

    let on_trunk = a
        .stranding
        .iter()
        .find(|s| s.compartment == CompartmentNo::new("3-148-0-L"))
        .unwrap();
    // The trunk compartment strands B1's outstanding 500 MH — hours it does not
    // contain.
    assert_eq!(on_trunk.stranded_downstream, ManHours::new(500));
    assert_eq!(on_trunk.own_remaining, ManHours::new(200));

    // And the worst offender is ranked first.
    assert_eq!(a.stranding[0].compartment, CompartmentNo::new("3-148-0-L"));

    // B1's own compartment strands nothing: nothing is downstream of it.
    let on_branch = a
        .stranding
        .iter()
        .find(|s| s.compartment == CompartmentNo::new("2-160-1-Q"))
        .unwrap();
    assert_eq!(on_branch.stranded_downstream, ManHours::ZERO);
    assert!(on_branch.downstream_segments.is_empty());
}

#[test]
fn a_complete_compartment_strands_nothing() {
    let a = package().analyse();
    assert!(
        a.stranding
            .iter()
            .all(|s| s.compartment != CompartmentNo::new("3-172-0-M")),
        "a finished compartment must not appear as a stranding source"
    );
}

#[test]
fn a_finished_package_has_no_stranding_and_is_fully_testable() {
    let mut p = package();
    p.spaces
        .insert(CompartmentNo::new("3-148-0-L"), work(240, 240));
    let a = p.analyse();
    assert!(a.stranding.is_empty());
    assert_eq!(a.testable_segment_count, a.segment_count);
    assert!(a.faults.is_empty());
}

// ---- Robustness: bad data must be reported, never hang or panic ----

#[test]
fn an_upstream_cycle_is_reported_and_terminates() {
    let mut p = package();
    // Point T1 at B1, which is already downstream of T1 — a loop.
    p.segments[0].upstream = Some(SegmentId::from_uuid(uuid::Uuid::from_u128(0x02)));
    let a = p.analyse(); // must not hang
    assert!(
        a.faults
            .iter()
            .any(|f| matches!(f, wadl_plan::TopologyFault::UpstreamCycle { .. })),
        "expected a cycle fault, got {:?}",
        a.faults
    );
}

#[test]
fn a_dangling_upstream_pointer_is_reported() {
    let mut p = package();
    p.segments[1].upstream = Some(SegmentId::from_uuid(uuid::Uuid::from_u128(0xDEAD)));
    let a = p.analyse();
    assert!(a
        .faults
        .iter()
        .any(|f| matches!(f, wadl_plan::TopologyFault::DanglingUpstream { .. })));
}

#[test]
fn a_segment_naming_an_unbooked_compartment_is_reported() {
    let mut p = package();
    p.segments[1]
        .compartments
        .push(CompartmentNo::new("9-999-9-X"));
    let a = p.analyse();
    assert!(a
        .faults
        .iter()
        .any(|f| matches!(f, wadl_plan::TopologyFault::UnknownCompartment { .. })));
}

#[test]
fn over_earned_work_never_yields_negative_remaining() {
    let mut p = package();
    // Over-earning is a data condition, not negative work.
    p.spaces
        .insert(CompartmentNo::new("3-148-0-L"), work(240, 900));
    let a = p.analyse();
    assert!(a
        .stranding
        .iter()
        .all(|s| s.own_remaining >= ManHours::ZERO));
    assert!(a.segments.iter().find(|s| s.code == "T1").unwrap().complete);
}

proptest! {
    /// However the earned hours fall, a compartment with no work left is never
    /// reported as stranding anything, and stranding is never negative.
    #[test]
    fn stranding_invariants_hold(
        earned in prop::collection::vec(0i64..700, 5),
    ) {
        let mut p = package();
        let keys: Vec<CompartmentNo> = p.spaces.keys().cloned().collect();
        for (key, e) in keys.iter().zip(earned.iter()) {
            let budget = p.spaces[key].budget;
            p.spaces.insert(key.clone(), SpaceWork { budget, earned: ManHours::new(*e), window: None });
        }
        let a = p.analyse();

        for item in &a.stranding {
            prop_assert!(item.own_remaining > ManHours::ZERO, "only open compartments strand");
            prop_assert!(item.stranded_downstream >= ManHours::ZERO);
        }
        // A testable segment is always itself complete.
        for s in &a.segments {
            if s.testable {
                prop_assert!(s.complete);
                prop_assert!(s.held_by.is_empty());
            }
        }
        // Well-formed topology yields no faults regardless of progress.
        prop_assert!(a.faults.is_empty());
    }

    /// Analysis is deterministic: the same package analysed twice is identical.
    /// The stranded number argues for moving crew, so it must not wobble.
    #[test]
    fn analysis_is_deterministic(earned in prop::collection::vec(0i64..700, 5)) {
        let mut p = package();
        let keys: Vec<CompartmentNo> = p.spaces.keys().cloned().collect();
        for (key, e) in keys.iter().zip(earned.iter()) {
            let budget = p.spaces[key].budget;
            p.spaces.insert(key.clone(), SpaceWork { budget, earned: ManHours::new(*e), window: None });
        }
        prop_assert_eq!(p.analyse(), p.analyse());
    }
}
