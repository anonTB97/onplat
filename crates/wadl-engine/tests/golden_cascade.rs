//! Golden acceptance tests — the contract with the safety authority.
//!
//! Each test snapshots the **full decision trace** for a scenario from the
//! steering pack, and asserts both what lights *and what must not*. These are
//! deliberately hard to update casually: a snapshot change means the safety
//! behaviour of the platform changed, and a reviewer must see exactly how.
//!
//! Scenario here: the prototype's "in service" coating cascade. A final coat is
//! curing in 3-160-2-Q on CVN-73. The space becomes a flammable-vapour space
//! with an eight-hour cure clock, and the decks above and below become heat
//! paths into it.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use wadl_domain::compartment::CompartmentNo;
use wadl_domain::ids::CouplingTypeId;
use wadl_domain::time::Timestamp;
use wadl_domain::units::HopDepth;
use wadl_engine::coupling::{CouplingCode, CouplingEdge, Propagation};
use wadl_engine::{
    evaluate, AdjacencyGraph, Decision, DecisionState, EvaluationRequest, Hazard, HazardKind,
    RuleSet,
};

/// 07:15 on the shift the coat went on. A fixed instant: the engine reads no
/// clock, so the trace is byte-reproducible years later.
const COAT_OPENED_AT: i64 = 1_778_649_300_000;

fn edge(from: &str, to: &str, code: &str, ty: u128, reach: u8) -> CouplingEdge {
    CouplingEdge {
        from: CompartmentNo::new(from),
        to: CompartmentNo::new(to),
        coupling_type: CouplingTypeId::from_uuid(uuid::Uuid::from_u128(ty)),
        code: CouplingCode::new(code),
        propagates: vec![Propagation::Vapour, Propagation::Heat],
        max_reach: HopDepth::new(reach),
    }
}

/// The CVN-73 aft-third adjacency around 3-160-2-Q, as the prototype draws it.
fn graph() -> AdjacencyGraph {
    AdjacencyGraph::new(vec![
        // Vertical: the deck above and the deck below the coated space.
        edge("3-160-2-Q", "2-160-2-Q", "deck_penetration", 0x01, 1),
        edge("3-160-2-Q", "4-160-2-Q", "deck_penetration", 0x01, 1),
        // Athwartships: a shared bulkhead, symmetric (both directions stored).
        edge("3-160-2-Q", "3-156-2-Q", "shared_bulkhead", 0x02, 2),
        edge("3-156-2-Q", "3-160-2-Q", "shared_bulkhead", 0x02, 2),
        // The ventilation zone: the condition follows the air, not the deck plan.
        edge("3-160-2-Q", "3-164-2-Q", "exhaust_trunk", 0x03, 3),
        edge("3-164-2-Q", "4-164-2-Q", "exhaust_trunk", 0x03, 3),
        // A space on no shared path with the coat — the control.
        edge("1-100-0-L", "1-104-0-L", "shared_bulkhead", 0x02, 2),
    ])
}

fn coating_hazard() -> Vec<Hazard> {
    vec![Hazard {
        origin: CompartmentNo::new("3-160-2-Q"),
        kind: HazardKind::CoatingOpen,
        since: Timestamp::from_epoch_millis(COAT_OPENED_AT),
        label: "CT-3160-4 · final coat, curing".to_owned(),
    }]
}

fn decide(subject: &str) -> Decision {
    let graph = graph();
    let rules = RuleSet::seed_usn_hot_work();
    let hazards = coating_hazard();
    let subject = CompartmentNo::new(subject);
    evaluate(&EvaluationRequest {
        subject: &subject,
        graph: &graph,
        rules: &rules,
        hazards: &hazards,
        at: Timestamp::from_epoch_millis(COAT_OPENED_AT),
    })
}

#[test]
fn golden_deck_above_curing_coat_blocks() {
    // "Directly above the curing coat. Heat conducts through the deck into a
    // flammable-vapour space — this is the refusal that prevents the fire."
    insta::assert_json_snapshot!(decide("2-160-2-Q"));
}

#[test]
fn golden_deck_below_curing_coat_blocks() {
    // "Directly below. Vapour is heavier than air and the boundary is a deck."
    insta::assert_json_snapshot!(decide("4-160-2-Q"));
}

#[test]
fn golden_bulkhead_neighbour_warns() {
    // "Shares a bulkhead. Permitted with the boundary posted and no ignition
    // source carried across it."
    insta::assert_json_snapshot!(decide("3-156-2-Q"));
}

#[test]
fn golden_shared_exhaust_trunk_suspends_two_hops_out() {
    // "Same exhaust trunk. The condition follows the air, not the deck plan."
    insta::assert_json_snapshot!(decide("4-164-2-Q"));
}

#[test]
fn golden_uncoupled_space_is_allowed() {
    insta::assert_json_snapshot!(decide("1-100-0-L"));
}

#[test]
fn golden_the_coated_space_itself_blocks() {
    // "From this moment the space has a vapour hazard and a cure clock."
    insta::assert_json_snapshot!(decide("3-160-2-Q"));
}

/// What must NOT light. A cascade that over-reaches is as much a defect as one
/// that under-reaches: it stops work that should be running.
#[test]
fn nothing_beyond_the_authored_reach_is_affected() {
    // The bulkhead rule (R06) reaches one hop, so a space two bulkheads out is
    // untouched even though an edge exists.
    assert_eq!(decide("1-104-0-L").state, DecisionState::Allow);

    // The coated space itself is BLOCKed by the same-space rule (it is the
    // flammable-vapour space), reached at depth 0 with no coupling traversed.
    let origin = decide("3-160-2-Q");
    assert_eq!(origin.state, DecisionState::Block);
    assert_eq!(
        origin.trace.len(),
        1,
        "the same-space rule only, not a cascade hit"
    );
    assert_eq!(origin.trace[0].depth, HopDepth::ZERO);

    // Every affected space clears on the eight-hour cure, and none reports a
    // clear time earlier than the cure.
    let cure_ends = COAT_OPENED_AT + 480 * 60_000;
    for space in [
        "2-160-2-Q",
        "4-160-2-Q",
        "3-156-2-Q",
        "3-164-2-Q",
        "4-164-2-Q",
    ] {
        let decision = decide(space);
        assert!(!decision.trace.is_empty(), "{space} must be affected");
        assert_eq!(
            decision.earliest_clear,
            Some(Timestamp::from_epoch_millis(cure_ends)),
            "{space} clears on the cure, not before"
        );
    }
}

/// Every decision must name the rule version that produced it — the property
/// that makes a 2027 decision explainable in 2031.
#[test]
fn every_trace_step_carries_its_rule_version_and_authority() {
    for space in ["2-160-2-Q", "4-160-2-Q", "3-156-2-Q", "4-164-2-Q"] {
        for step in decide(space).trace {
            assert!(!step.rule_code.is_empty(), "{space}: rule code");
            assert!(!step.authority.is_empty(), "{space}: authority document");
            assert!(
                !step.clearing_authority.is_empty(),
                "{space}: clearing authority"
            );
            assert_ne!(
                step.rule_version.as_uuid(),
                uuid::Uuid::nil(),
                "{space}: a real rule version"
            );
        }
    }
}
