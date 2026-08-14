//! What the executability verdict is allowed to claim.
//!
//! The derivation's one hard promise is in the crate docs: evaluating at the
//! window start plus every in-window hazard raise instant decides the *whole*
//! window. These tests pin that promise where it can break:
//!
//! 1. **A refusal that begins mid-window is caught** even when the window start
//!    is clean — the case naive "check the start" logic misses.
//! 2. **A hold that expires before the window never troubles it** — the elapsed
//!    cure must not haunt later work.
//! 3. **Half-open semantics**: a hazard raised exactly at `window.end` is
//!    outside the plan.
//! 4. **Absence is answered, not guessed** — unlocated and undated activities
//!    get `Unassessable`, never a confident verdict either way.

#![allow(missing_docs, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use wadl_domain::compartment::CompartmentNo;
use wadl_domain::ids::CouplingTypeId;
use wadl_domain::time::{Timestamp, Window};
use wadl_domain::units::HopDepth;
use wadl_engine::coupling::{CouplingCode, CouplingEdge, Propagation};
use wadl_engine::{AdjacencyGraph, Hazard, HazardKind, RuleSet};
use wadl_issues::{executability, Executability, Hull, Unassessable};

const T0: i64 = 1_778_649_300_000;
const HOUR: i64 = 3_600_000;

fn at(ms: i64) -> Timestamp {
    Timestamp::from_epoch_millis(ms)
}

fn win(start: i64, end: i64) -> Window {
    Window::new(at(start), at(end))
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

/// The mitigate fixture's neighbourhood: a coating cascade around 3-160-2-Q,
/// plus the switchgear room whose energised bus clears on verification.
fn graph() -> AdjacencyGraph {
    let mut edges = Vec::new();
    for (a, b, code, ty) in [
        ("3-160-2-Q", "2-160-2-Q", "deck_penetration", 1),
        ("3-160-2-Q", "4-160-2-Q", "deck_penetration", 1),
        ("3-148-2-E", "3-148-0-L", "shared_bulkhead", 2),
    ] {
        edges.push(edge(a, b, code, ty));
        edges.push(edge(b, a, code, ty));
    }
    AdjacencyGraph::new(edges)
}

fn coating(since: i64) -> Hazard {
    Hazard {
        origin: CompartmentNo::new("3-160-2-Q"),
        kind: HazardKind::CoatingOpen,
        since: at(since),
        label: "CT-3160-4 · final coat, curing".to_owned(),
    }
}

fn energised_bus(since: i64) -> Hazard {
    Hazard {
        origin: CompartmentNo::new("3-148-2-E"),
        kind: HazardKind::EnergisedBus,
        since: at(since),
        label: "Bus 3-SG-2 energised".to_owned(),
    }
}

struct Fixture {
    graph: AdjacencyGraph,
    rules: RuleSet,
    hazards: Vec<Hazard>,
}

impl Fixture {
    fn new(hazards: Vec<Hazard>) -> Self {
        Self {
            graph: graph(),
            rules: RuleSet::seed_usn_hot_work(),
            hazards,
        }
    }

    fn hull(&self) -> Hull<'_> {
        Hull {
            graph: &self.graph,
            rules: &self.rules,
            hazards: &self.hazards,
        }
    }
}

fn assess(f: &Fixture, space: &str, window: Window) -> Executability {
    executability(&f.hull(), Some(&CompartmentNo::new(space)), Some(window))
}

#[test]
fn a_clean_window_is_executable() {
    let f = Fixture::new(vec![]);
    assert_eq!(
        assess(&f, "4-160-2-Q", win(T0, T0 + 8 * HOUR)),
        Executability::Executable
    );
}

#[test]
fn refused_at_the_window_start_names_the_governing_hold() {
    // The coat went down an hour before the crew is due; the deck below is held
    // from the first planned instant.
    let f = Fixture::new(vec![coating(T0 - HOUR)]);
    let Executability::NotExecutable(refusal) = assess(&f, "4-160-2-Q", win(T0, T0 + 4 * HOUR))
    else {
        panic!("the deck below a curing coat is not executable");
    };
    assert_eq!(refusal.at, at(T0), "refused from the window start");
    assert!(!refusal.state.permits_work());
    assert!(!refusal.rule_code.is_empty());
    assert_eq!(refusal.origin, CompartmentNo::new("3-160-2-Q"));
    assert_eq!(
        refusal.earliest_clear,
        Some(at(T0 - HOUR + 8 * HOUR)),
        "the eight-hour cure, priced from the hazard's own start"
    );
}

/// The completeness claim, directly: the window start is clean, the hazard is
/// raised mid-window, and the refusal is still found — at exactly that instant.
#[test]
fn a_hazard_raised_mid_window_is_caught() {
    let f = Fixture::new(vec![coating(T0 + 2 * HOUR)]);
    let Executability::NotExecutable(refusal) = assess(&f, "4-160-2-Q", win(T0, T0 + 6 * HOUR))
    else {
        panic!("the mid-window coat must surface");
    };
    assert_eq!(
        refusal.at,
        at(T0 + 2 * HOUR),
        "the first refused instant is the raise instant, not the window start"
    );
}

#[test]
fn a_cure_that_ends_before_the_window_never_troubles_it() {
    // Eight-hour cure, laid nine hours before the window: fully elapsed.
    let f = Fixture::new(vec![coating(T0 - 9 * HOUR)]);
    assert_eq!(
        assess(&f, "4-160-2-Q", win(T0, T0 + 4 * HOUR)),
        Executability::Executable
    );
}

/// Half-open windows: `[start, end)`. A hazard raised at the exact end instant
/// belongs to the next crew's problem, not this activity's.
#[test]
fn a_hazard_raised_at_the_window_end_is_outside_the_plan() {
    let f = Fixture::new(vec![coating(T0 + 6 * HOUR)]);
    assert_eq!(
        assess(&f, "4-160-2-Q", win(T0, T0 + 6 * HOUR)),
        Executability::Executable
    );
}

/// A verification-gated hold refuses at any horizon, and the refusal says so:
/// no `earliest_clear`, because no amount of time clears it.
#[test]
fn a_verification_gated_hold_refuses_at_any_horizon() {
    let f = Fixture::new(vec![energised_bus(T0)]);
    let year = 365 * 24 * HOUR;
    let Executability::NotExecutable(refusal) =
        assess(&f, "3-148-2-E", win(T0 + year, T0 + year + 8 * HOUR))
    else {
        panic!("the bus never elapses");
    };
    assert_eq!(refusal.earliest_clear, None, "not on a clock");
    assert_eq!(refusal.origin, CompartmentNo::new("3-148-2-E"));
}

#[test]
fn unlocated_and_undated_are_answered_honestly_not_guessed() {
    let f = Fixture::new(vec![coating(T0)]);
    assert_eq!(
        executability(&f.hull(), None, Some(win(T0, T0 + HOUR))),
        Executability::Unassessable {
            reason: Unassessable::Unlocated
        }
    );
    assert_eq!(
        executability(&f.hull(), Some(&CompartmentNo::new("4-160-2-Q")), None),
        Executability::Unassessable {
            reason: Unassessable::Undated
        }
    );
}
