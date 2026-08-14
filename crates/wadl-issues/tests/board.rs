//! What the issue board is allowed to claim.
//!
//! 1. **Every space issue is a real verdict**: held-with-crews only where the
//!    engine refuses and hours are booked; compound only where the options
//!    panel would genuinely offer no single action.
//! 2. **One issue per held space, never two** — the compound claim subsumes
//!    the held claim.
//! 3. **Latent spaces are not issues**: refused with nothing booked = skipped,
//!    the readiness taxonomy's distinction.
//! 4. **The ranking is man-hours at risk, descending, deterministic.**

#![allow(missing_docs, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use wadl_domain::compartment::CompartmentNo;
use wadl_domain::ids::CouplingTypeId;
use wadl_domain::time::{Timestamp, Window};
use wadl_domain::units::{HopDepth, ManHours};
use wadl_engine::coupling::{CouplingCode, CouplingEdge, Propagation};
use wadl_engine::{AdjacencyGraph, Hazard, HazardKind, RuleSet};
use wadl_issues::{derive, Issue, RegisterRow, ScheduleEdge, Stranding};
use wadl_mitigate::{SpaceLoad, World};

const T0: i64 = 1_778_649_300_000;
const HOUR: i64 = 3_600_000;

fn at(ms: i64) -> Timestamp {
    Timestamp::from_epoch_millis(ms)
}

fn edge(from: &str, to: &str, code: &str, ty: u128) -> CouplingEdge {
    CouplingEdge {
        from: CompartmentNo::new(from),
        to: CompartmentNo::new(to),
        coupling_type: CouplingTypeId::from_uuid(uuid::Uuid::from_u128(ty)),
        code: CouplingCode::new(code),
        propagates: vec![Propagation::Heat, Propagation::Vapour],
        max_reach: HopDepth::new(3),
    }
}

fn graph() -> AdjacencyGraph {
    let mut edges = Vec::new();
    for (a, b, code, ty) in [
        ("3-160-2-Q", "2-160-2-Q", "deck_penetration", 1),
        ("3-160-2-Q", "4-160-2-Q", "deck_penetration", 1),
        ("3-160-2-Q", "3-164-2-Q", "exhaust_trunk", 3),
        ("3-148-2-E", "3-148-0-L", "shared_bulkhead", 2),
    ] {
        edges.push(edge(a, b, code, ty));
        edges.push(edge(b, a, code, ty));
    }
    AdjacencyGraph::new(edges)
}

fn spaces() -> Vec<SpaceLoad> {
    [
        ("2-160-2-Q", 120),
        ("3-160-2-Q", 80),
        ("4-160-2-Q", 200),
        ("3-164-2-Q", 40),
        ("3-148-2-E", 224),
        ("3-148-0-L", 0), // booked nothing: held here must NOT be an issue
    ]
    .into_iter()
    .map(|(c, h)| SpaceLoad {
        compartment: CompartmentNo::new(c),
        booked: ManHours::new(h),
    })
    .collect()
}

fn coating(origin: &str, since: i64) -> Hazard {
    Hazard {
        origin: CompartmentNo::new(origin),
        kind: HazardKind::CoatingOpen,
        since: at(since),
        label: format!("CT-{origin} · curing"),
    }
}

fn bus(origin: &str, since: i64) -> Hazard {
    Hazard {
        origin: CompartmentNo::new(origin),
        kind: HazardKind::EnergisedBus,
        since: at(since),
        label: format!("Bus {origin} energised"),
    }
}

struct Fixture {
    graph: AdjacencyGraph,
    rules: RuleSet,
    hazards: Vec<Hazard>,
    loads: Box<dyn Fn(Timestamp) -> Vec<SpaceLoad> + Sync>,
}

impl Fixture {
    fn new(hazards: Vec<Hazard>) -> Self {
        Self {
            graph: graph(),
            rules: RuleSet::seed_usn_hot_work(),
            hazards,
            loads: Box::new(|_| spaces()),
        }
    }

    fn world(&self, at_ms: i64) -> World<'_> {
        World {
            graph: &self.graph,
            rules: &self.rules,
            hazards: &self.hazards,
            at: at(at_ms),
            loads: &self.loads,
        }
    }
}

fn is_space_issue_for(i: &Issue, space: &str) -> bool {
    match i {
        Issue::HeldWithCrewsBooked { compartment, .. }
        | Issue::CompoundHold { compartment, .. } => compartment.as_str() == space,
        _ => false,
    }
}

#[test]
fn a_held_space_with_crews_is_an_issue_and_a_latent_one_is_not() {
    let f = Fixture::new(vec![bus("3-148-2-E", T0)]);
    let issues = derive(&f.world(T0), &[], &[], &[]);
    let held: Vec<_> = issues
        .iter()
        .filter(|i| matches!(i, Issue::HeldWithCrewsBooked { .. }))
        .collect();
    assert!(
        held.iter().any(|i| is_space_issue_for(i, "3-148-2-E")),
        "the switchgear room has 224 MH booked and is refused: {issues:?}"
    );
    let Some(Issue::HeldWithCrewsBooked {
        hours_at_risk,
        earliest_clear,
        clearing_authority,
        ..
    }) = held.iter().find(|i| is_space_issue_for(i, "3-148-2-E"))
    else {
        unreachable!()
    };
    assert_eq!(*hours_at_risk, ManHours::new(224));
    assert_eq!(*earliest_clear, None, "a bus clears on verification");
    assert!(!clearing_authority.is_empty());
    // 3-148-0-L may be refused too — but nothing is booked there, so it is
    // latent capacity, not an issue.
    assert!(
        !issues.iter().any(|i| is_space_issue_for(i, "3-148-0-L")),
        "a held space with nothing booked is not an issue: {issues:?}"
    );
}

/// The compound case from the mitigation planner: two timed coating holds from
/// different neighbours, plus a bus that energises mid-cure — no single action
/// opens the space, and the issue must say so as its own kind, with the
/// working plan's size attached.
#[test]
fn a_compound_hold_is_its_own_kind_and_subsumes_the_held_claim() {
    let f = Fixture::new(vec![
        coating("3-164-2-Q", T0),
        coating("2-160-2-Q", T0),
        bus("3-160-2-Q", T0 + 7 * HOUR),
    ]);
    let issues = derive(&f.world(T0), &[], &[], &[]);
    let subject: Vec<_> = issues
        .iter()
        .filter(|i| is_space_issue_for(i, "3-160-2-Q"))
        .collect();
    assert_eq!(
        subject.len(),
        1,
        "one issue per held space, never both: {subject:?}"
    );
    let Issue::CompoundHold {
        holds,
        plan_actions,
        hours_at_risk,
        ..
    } = subject.first().unwrap()
    else {
        panic!("expected the compound kind, got {subject:?}");
    };
    assert!(*holds >= 2);
    assert!(
        *plan_actions >= 2,
        "the planner's combined plan rides the issue"
    );
    assert_eq!(*hours_at_risk, ManHours::new(80));
}

#[test]
fn a_not_executable_activity_joins_the_board_with_its_refusal() {
    let f = Fixture::new(vec![coating("3-160-2-Q", T0)]);
    let deck_below = CompartmentNo::new("4-160-2-Q");
    let rows = [
        RegisterRow {
            code: "A100",
            name: "Deck below, during the cure",
            trade: "SM-PRES",
            compartment: Some(&deck_below),
            planned: Some(Window::new(at(T0 + HOUR), at(T0 + 4 * HOUR))),
            remaining: ManHours::new(60),
        },
        // Finished work cannot be in trouble, however doomed its window looks.
        RegisterRow {
            code: "A101",
            name: "Same window, already complete",
            trade: "SM-PRES",
            compartment: Some(&deck_below),
            planned: Some(Window::new(at(T0 + HOUR), at(T0 + 4 * HOUR))),
            remaining: ManHours::ZERO,
        },
    ];
    let issues = derive(&f.world(T0), &rows, &[], &[]);
    let not_exec: Vec<_> = issues
        .iter()
        .filter_map(|i| match i {
            Issue::NotExecutableAsPlanned {
                activity, refusal, ..
            } => Some((activity.as_str(), refusal)),
            _ => None,
        })
        .collect();
    assert_eq!(not_exec.len(), 1, "{issues:?}");
    let (code, refusal) = not_exec.first().unwrap();
    assert_eq!(*code, "A100");
    assert_eq!(refusal.origin, CompartmentNo::new("3-160-2-Q"));
}

#[test]
fn stranding_and_negative_lags_pass_through_with_their_stakes() {
    let f = Fixture::new(vec![]);
    let cause = CompartmentNo::new("3-160-2-Q");
    let succ_space = CompartmentNo::new("4-160-2-Q");
    let rows = [RegisterRow {
        code: "A4050",
        name: "Hot work after the coat",
        trade: "WELD",
        compartment: Some(&succ_space),
        planned: None,
        remaining: ManHours::new(35),
    }];
    let stranded = [Stranding {
        compartment: &cause,
        own_remaining: ManHours::new(80),
        stranded_downstream: ManHours::new(400),
        downstream_segments: 3,
    }];
    let edges = [
        ScheduleEdge {
            pred: "A6010",
            succ: "A4050",
            lag_hours: -8,
        },
        ScheduleEdge {
            pred: "A1010",
            succ: "A4050",
            lag_hours: 4, // positive lag is not a finding
        },
    ];
    let issues = derive(&f.world(T0), &rows, &stranded, &edges);
    assert!(matches!(
        issues.first(),
        Some(Issue::StrandingConcentration { hours_at_risk, .. }) if hours_at_risk.get() == 400
    ));
    let lag: Vec<_> = issues
        .iter()
        .filter_map(|i| match i {
            Issue::NegativeLag {
                pred,
                succ,
                lag_hours,
                hours_at_risk,
            } => Some((
                pred.as_str(),
                succ.as_str(),
                *lag_hours,
                hours_at_risk.get(),
            )),
            _ => None,
        })
        .collect();
    assert_eq!(
        lag,
        vec![("A6010", "A4050", -8, 35)],
        "the successor's remaining hours are the stake"
    );
}

#[test]
fn the_board_ranks_by_hours_at_risk_and_is_deterministic() {
    let f = Fixture::new(vec![coating("3-160-2-Q", T0), bus("3-148-2-E", T0)]);
    let a = derive(&f.world(T0), &[], &[], &[]);
    let b = derive(&f.world(T0), &[], &[], &[]);
    assert_eq!(a, b, "same world, same board");
    let hours: Vec<i64> = a.iter().map(|i| i.hours_at_risk().get()).collect();
    let mut sorted = hours.clone();
    sorted.sort_unstable_by(|x, y| y.cmp(x));
    assert_eq!(hours, sorted, "worst first");
    assert!(!a.is_empty());
}
