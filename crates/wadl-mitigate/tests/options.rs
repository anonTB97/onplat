//! What a mitigation option is allowed to claim.
//!
//! This crate's output is a list a planner acts on — someone gets sent somewhere
//! because of it. So the properties worth pinning are not "the code runs" but the
//! claims the list makes:
//!
//! 1. **Every option offered has been shown to work.** If it is on the list, the
//!    subject permits work in the hypothetical. A list containing plausible but
//!    unchecked candidates is worse than no list.
//! 2. **"Wait" appears only where waiting can possibly help** — every hold timed.
//!    One verification-gated hold and no amount of time opens the space; offering
//!    "wait" there is the most misleading thing this crate could say.
//! 3. **Harm is never hidden.** Removing a hazard or cutting a coupling can only
//!    ever free spaces, so those options never report harm and that is provable.
//!    Waiting is the one that can shut a space, and it must say so.
//! 4. **The two entry points cannot disagree.** `assess` (per space) and
//!    `leverage` (per action, hull-wide) share every primitive; an action's effect
//!    must read identically from either.
//! 5. **The order is deterministic.** Same world, same ranking, on any machine.

#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use proptest::prelude::*;
use wadl_domain::compartment::CompartmentNo;
use wadl_domain::ids::CouplingTypeId;
use wadl_domain::time::Timestamp;
use wadl_domain::units::{HopDepth, ManHours};
use wadl_engine::coupling::{CouplingCode, CouplingEdge, Propagation};
use wadl_engine::{AdjacencyGraph, Hazard, HazardKind, RuleSet};
use wadl_mitigate::{assess, leverage, Action, Confidence, SpaceLoad, World};

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

/// The seeded demo's neighbourhood: a coating cascade around 3-160-2-Q, plus the
/// switchgear room whose energised bus clears on verification rather than a clock.
/// Symmetric couplings appear twice, as the schema requires.
fn graph() -> AdjacencyGraph {
    let mut edges = Vec::new();
    for (a, b, code, ty) in [
        ("3-160-2-Q", "2-160-2-Q", "deck_penetration", 1),
        ("3-160-2-Q", "4-160-2-Q", "deck_penetration", 1),
        ("3-160-2-Q", "3-156-2-Q", "shared_bulkhead", 2),
        ("3-160-2-Q", "3-164-2-Q", "exhaust_trunk", 3),
        ("3-164-2-Q", "4-164-2-Q", "exhaust_trunk", 3),
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
        ("3-156-2-Q", 60),
        ("3-164-2-Q", 40),
        ("4-164-2-Q", 90),
        ("3-148-2-E", 224),
        ("3-148-0-L", 30),
    ]
    .into_iter()
    .map(|(c, h)| SpaceLoad {
        compartment: CompartmentNo::new(c),
        booked: ManHours::new(h),
    })
    .collect()
}

fn coating() -> Hazard {
    Hazard {
        origin: CompartmentNo::new("3-160-2-Q"),
        kind: HazardKind::CoatingOpen,
        since: at(T0),
        label: "CT-3160-4 · final coat, curing".to_owned(),
    }
}

fn energised_bus() -> Hazard {
    Hazard {
        origin: CompartmentNo::new("3-148-2-E"),
        kind: HazardKind::EnergisedBus,
        since: at(T0),
        label: "Bus 3-SG-2 energised".to_owned(),
    }
}

struct Fixture {
    graph: AdjacencyGraph,
    rules: RuleSet,
    hazards: Vec<Hazard>,
    spaces: Vec<SpaceLoad>,
}

impl Fixture {
    fn new(hazards: Vec<Hazard>) -> Self {
        Self {
            graph: graph(),
            rules: RuleSet::seed_usn_hot_work(),
            hazards,
            spaces: spaces(),
        }
    }

    fn world(&self, at_ms: i64) -> World<'_> {
        World {
            graph: &self.graph,
            rules: &self.rules,
            hazards: &self.hazards,
            at: at(at_ms),
            spaces: &self.spaces,
        }
    }
}

/// Property 1, on the case a planner meets most: a coating cure holding the deck
/// below. Every option must open the space, and the cheapest that does should win.
#[test]
fn every_option_offered_actually_opens_the_space() {
    let f = Fixture::new(vec![coating()]);
    let world = f.world(T0);
    let subject = CompartmentNo::new("4-160-2-Q");
    let a = assess(&world, &subject);

    assert!(
        !a.state.permits_work(),
        "the deck below a curing coat is held"
    );
    assert!(!a.options.is_empty(), "and something can be done about it");
    for option in &a.options {
        assert!(
            option.subject_state.permits_work(),
            "{:?} was offered but leaves the space refused",
            option.action
        );
    }
}

/// The top option here is to do nothing, because the hold is on a clock. Getting
/// this ordering right is most of the product's value: yards escalate everything
/// by reflex, and the distinction between a hold that discharges itself and one
/// that needs a person sent is the whole point.
#[test]
fn waiting_wins_when_the_hold_clears_itself() {
    let f = Fixture::new(vec![coating()]);
    let world = f.world(T0);
    let a = assess(&world, &CompartmentNo::new("4-160-2-Q"));

    let top = &a.options[0];
    match &top.action {
        Action::Wait { until } => {
            assert_eq!(*until, at(T0 + 8 * HOUR), "the eight-hour cure");
            assert_eq!(top.confidence, Confidence::Computed, "nobody is assumed");
        }
        other => panic!("expected waiting to rank first, got {other:?}"),
    }
    // Discharging the coat frees exactly as much work, so it is offered too — it
    // loses on cost, not on effect.
    let discharge = a
        .options
        .iter()
        .find(|o| matches!(o.action, Action::Discharge { .. }))
        .expect("discharging the hazard is also an option");
    assert_eq!(
        discharge.effect.freed_hours, top.effect.freed_hours,
        "same effect, higher cost"
    );
    assert_eq!(discharge.confidence, Confidence::AssumesActor);
}

/// Property 2. The bus clears on a verified zero-energy state, never on a clock.
#[test]
fn waiting_is_never_offered_for_a_verification_gated_hold() {
    let f = Fixture::new(vec![energised_bus()]);
    let world = f.world(T0);
    for subject in ["3-148-2-E", "3-148-0-L"] {
        let a = assess(&world, &CompartmentNo::new(subject));
        if a.state.permits_work() {
            continue;
        }
        assert!(
            !a.options
                .iter()
                .any(|o| matches!(o.action, Action::Wait { .. })),
            "{subject}: offered waiting on a hold that never elapses"
        );
        assert!(
            a.holds.iter().all(|h| h.earliest_clear.is_none()),
            "{subject}: this hold is not on a clock"
        );
    }
}

/// Ten years on, the bus is exactly as held. A "wait" option must not appear at
/// any instant, not merely at the one the test happened to pick.
#[test]
fn a_verification_hold_offers_no_wait_at_any_instant() {
    let f = Fixture::new(vec![energised_bus()]);
    for days in [0, 1, 30, 365, 3650] {
        let world = f.world(T0 + days * 24 * HOUR);
        let a = assess(&world, &CompartmentNo::new("3-148-2-E"));
        assert!(
            !a.options
                .iter()
                .any(|o| matches!(o.action, Action::Wait { .. })),
            "day {days}: offered waiting"
        );
    }
}

/// Property 3, the case that bites. Waiting five hours for the coat to cure walks
/// straight into a bus being energised for testing, so the option must report what
/// it shuts as well as what it opens. An upside-only tool recommends this.
///
/// Note which hazard this uses. A hot-work hazard will not do, and finding out why
/// was worth the detour: hot work carries a thirty-minute fire-watch hold, so the
/// engine treats it as live for thirty minutes from its start and it has expired
/// again long before an eight-hour cure ends. Only a hold that does not elapse —
/// one gated on a verification, like an energised bus — is still there when the
/// wait finishes. Which is the same asymmetry the whole feature turns on, arriving
/// from the other direction.
#[test]
fn waiting_reports_the_space_it_would_shut() {
    let bus_energised_later = Hazard {
        origin: CompartmentNo::new("3-148-2-E"),
        kind: HazardKind::EnergisedBus,
        since: at(T0 + 5 * HOUR),
        label: "Bus 3-SG-2 energised for testing".to_owned(),
    };
    let f = Fixture::new(vec![coating(), bus_energised_later]);
    let world = f.world(T0);
    let a = assess(&world, &CompartmentNo::new("4-160-2-Q"));

    let wait = a
        .options
        .iter()
        .find(|o| matches!(o.action, Action::Wait { .. }))
        .expect("the coating hold is still timed, so waiting is still a candidate");
    assert!(
        wait.effect.does_harm(),
        "waiting past the cure brings hot work live and must say so"
    );
    assert!(
        wait.effect
            .closes
            .contains(&CompartmentNo::new("3-148-2-E")),
        "the switchgear room the bus is in, got {:?}",
        wait.effect.closes
    );
    assert!(
        wait.effect.closed_hours.get() > 0,
        "and the hours in it are priced"
    );
    assert!(
        wait.effect.net_hours() < wait.effect.freed_hours.get(),
        "net is below gross once harm is counted"
    );
}

/// Property 4. The same action must read the same from either entry point.
#[test]
fn per_space_and_hull_wide_agree_about_an_action() {
    let f = Fixture::new(vec![coating(), energised_bus()]);
    let world = f.world(T0);
    let hull = leverage(&world);
    assert!(!hull.is_empty());

    for load in &f.spaces {
        for option in assess(&world, &load.compartment).options {
            let Some(same) = hull.iter().find(|m| m.action == option.action) else {
                // Only legitimate when the action frees nothing hull-wide, which
                // cannot happen if it freed the subject.
                panic!("{:?} opened a space but is absent hull-wide", option.action);
            };
            assert_eq!(
                same.effect, option.effect,
                "{:?} has two different effects",
                option.action
            );
        }
    }
}

/// An open space has no issue, and says so as an empty list rather than by
/// omission.
#[test]
fn a_space_that_permits_work_yields_no_options() {
    let f = Fixture::new(vec![coating()]);
    let world = f.world(T0);
    // Far from the cascade, and after the cure the coated space itself is clear.
    let a = assess(&f.world(T0 + 9 * HOUR), &CompartmentNo::new("4-160-2-Q"));
    assert!(a.state.permits_work());
    assert!(a.options.is_empty());
    assert!(a.holds.is_empty());
    let unrelated = assess(&world, &CompartmentNo::new("3-148-0-L"));
    assert!(unrelated.state.permits_work());
    assert!(unrelated.options.is_empty());
}

/// Two independent hazards on one space: no single action opens it, and the
/// honest answer is the list of holds rather than an empty list.
#[test]
fn a_compound_hold_names_everything_that_must_be_addressed() {
    let stop_work = Hazard {
        origin: CompartmentNo::new("4-160-2-Q"),
        kind: HazardKind::StopWork,
        since: at(T0),
        label: "STOP WORK · Fire Marshal".to_owned(),
    };
    let f = Fixture::new(vec![coating(), stop_work]);
    let world = f.world(T0);
    let a = assess(&world, &CompartmentNo::new("4-160-2-Q"));

    assert!(!a.state.permits_work());
    assert!(
        a.options.is_empty(),
        "neither hazard alone opens it, so nothing may be offered"
    );
    assert!(a.is_compound());
    assert!(a.holds.len() >= 2, "got {:?}", a.holds);
    let hazards: Vec<&str> = a.holds.iter().map(|h| h.hazard.as_str()).collect();
    assert!(hazards.iter().any(|h| h.contains("STOP WORK")));
    assert!(hazards.iter().any(|h| h.contains("final coat")));
}

/// The compound case, priced. Neither hazard alone opens the space, so the answer is
/// the plan — and the plan must be the CHEAPEST one, not "discharge everything".
/// The coat expires on its own, so this needs one attendance (the stop-work) and a
/// wait, not two attendances.
#[test]
fn a_compound_hold_is_priced_as_one_cheapest_plan() {
    let stop_work = Hazard {
        origin: CompartmentNo::new("4-160-2-Q"),
        kind: HazardKind::StopWork,
        since: at(T0),
        label: "STOP WORK · Fire Marshal".to_owned(),
    };
    let f = Fixture::new(vec![coating(), stop_work]);
    let world = f.world(T0);
    let a = assess(&world, &CompartmentNo::new("4-160-2-Q"));

    assert!(a.options.is_empty(), "no single action opens it");
    let plan = a.combined.expect("but a plan does");
    assert!(
        plan.subject_state.permits_work(),
        "and it demonstrably works"
    );

    let waits = plan
        .actions
        .iter()
        .filter(|x| matches!(x, Action::Wait { .. }))
        .count();
    let discharges = plan
        .actions
        .iter()
        .filter(|x| matches!(x, Action::Discharge { .. }))
        .count();
    assert_eq!(waits, 1, "one wait covers every timed hold");
    assert_eq!(
        discharges, 1,
        "only the stop-work needs a person; discharging the coat too would \
         overstate the cost by a whole attendance: {:?}",
        plan.actions
    );
    // A plan is only as certain as its least certain step.
    assert_eq!(plan.confidence, Confidence::AssumesActor);
    assert!(plan.effect.freed_hours.get() > 0);
}

/// A plan is offered only when nothing single works. Alongside a working single
/// action it would be noise.
#[test]
fn no_plan_is_offered_when_one_action_is_enough() {
    let f = Fixture::new(vec![coating()]);
    let world = f.world(T0);
    let a = assess(&world, &CompartmentNo::new("4-160-2-Q"));
    assert!(!a.options.is_empty());
    assert!(
        a.combined.is_none(),
        "one action suffices, so there is no plan to make"
    );
}

/// Cutting the path is a real mitigation and must be offered, with its cost
/// stated: the closure is itself work needing its own authorization.
#[test]
fn interrupting_the_path_is_offered_and_priced_as_its_own_work() {
    let f = Fixture::new(vec![coating()]);
    let world = f.world(T0);
    let a = assess(&world, &CompartmentNo::new("4-164-2-Q"));
    assert!(!a.state.permits_work(), "two hops out along the trunk");

    let cut = a
        .options
        .iter()
        .find(|o| matches!(o.action, Action::Interrupt { .. }))
        .expect("the trunk can be blanked");
    assert_eq!(cut.confidence, Confidence::AssumesOwnAuthorization);
    assert!(
        !cut.effect.does_harm(),
        "removing a coupling cannot shut a space"
    );
}

/// Determinism. The ranking must not depend on iteration chance.
#[test]
fn the_ranking_is_stable() {
    let f = Fixture::new(vec![coating(), energised_bus()]);
    let world = f.world(T0);
    let once = leverage(&world);
    for _ in 0..5 {
        assert_eq!(leverage(&world), once);
    }
    let subject = CompartmentNo::new("4-160-2-Q");
    let a = assess(&world, &subject);
    for _ in 0..5 {
        assert_eq!(assess(&world, &subject).options, a.options);
    }
}

/// Ranking is by net hours recovered, descending. Asserted over the list rather
/// than on one pair, since a comparator can be right locally and wrong overall.
#[test]
fn options_are_ordered_by_work_recovered() {
    let f = Fixture::new(vec![coating(), energised_bus()]);
    let world = f.world(T0);
    let hull = leverage(&world);
    for pair in hull.windows(2) {
        assert!(
            pair[0].effect.net_hours() >= pair[1].effect.net_hours(),
            "{:?} ranked above {:?} with less recovered",
            pair[0].action,
            pair[1].action
        );
    }
}

/// Nothing on the leverage board frees nothing — that is the definition of the
/// board.
#[test]
fn leverage_never_lists_an_action_that_frees_nothing() {
    let f = Fixture::new(vec![coating(), energised_bus()]);
    let world = f.world(T0);
    for m in leverage(&world) {
        assert!(!m.effect.frees.is_empty(), "{:?} frees nothing", m.action);
        assert!(m.effect.net_hours() != 0 || m.effect.freed_hours.get() == 0);
    }
}

// ---------------------------------------------------------------------- proptest

/// A hazard placed on one of the fixture's spaces, at some instant near T0.
fn any_hazard() -> impl Strategy<Value = Hazard> {
    let places = [
        "2-160-2-Q",
        "3-160-2-Q",
        "4-160-2-Q",
        "3-156-2-Q",
        "3-164-2-Q",
        "4-164-2-Q",
        "3-148-2-E",
        "3-148-0-L",
    ];
    let kinds = [
        HazardKind::CoatingOpen,
        HazardKind::HotWorkLive,
        HazardKind::EnergisedBus,
        HazardKind::FlammableStow,
        HazardKind::StopWork,
    ];
    (0..places.len(), 0..kinds.len(), -4i64..12i64).prop_map(move |(p, k, hours)| Hazard {
        origin: CompartmentNo::new(places[p]),
        kind: kinds[k],
        since: at(T0 + hours * HOUR),
        label: format!("H{p}{k} · generated"),
    })
}

proptest! {
    /// Property 1, generalised. Whatever the hazard set, nothing reaches the list
    /// without having been shown to open the subject.
    #[test]
    fn no_offered_option_ever_fails_to_open_the_subject(
        hazards in proptest::collection::vec(any_hazard(), 1..5),
        subject_idx in 0usize..8,
    ) {
        let f = Fixture::new(hazards);
        let world = f.world(T0);
        let subject = f.spaces[subject_idx].compartment.clone();
        for option in assess(&world, &subject).options {
            prop_assert!(
                option.subject_state.permits_work(),
                "{:?} offered but the space stays refused", option.action
            );
        }
    }

    /// Property 3, generalised. Discharging a hazard or cutting a coupling removes
    /// input from the engine, and less input cannot produce a more severe verdict —
    /// so those two can never shut a space. Waiting is the only action that can,
    /// which is exactly why it is the one that needs watching.
    #[test]
    fn only_waiting_can_ever_shut_a_space(
        hazards in proptest::collection::vec(any_hazard(), 1..5),
    ) {
        let f = Fixture::new(hazards);
        let world = f.world(T0);
        for m in leverage(&world) {
            match m.action {
                Action::Wait { .. } => {}
                ref other => prop_assert!(
                    !m.effect.does_harm(),
                    "{other:?} shut {:?}", m.effect.closes
                ),
            }
        }
    }

    /// Property 2, generalised. "Wait" is offered only where every hold is timed.
    #[test]
    fn wait_appears_only_when_every_hold_is_timed(
        hazards in proptest::collection::vec(any_hazard(), 1..5),
        subject_idx in 0usize..8,
    ) {
        let f = Fixture::new(hazards);
        let world = f.world(T0);
        let subject = f.spaces[subject_idx].compartment.clone();
        let a = assess(&world, &subject);
        if a.options.iter().any(|o| matches!(o.action, Action::Wait { .. })) {
            prop_assert!(
                a.holds.iter().all(|h| h.earliest_clear.is_some()),
                "wait offered with an untimed hold present: {:?}", a.holds
            );
        }
    }

    /// A space that no single action opens always gets a plan, and the plan always
    /// works. The first half follows from the engine: remove every hazard named in
    /// the trace and nothing is left to hold the space. Asserting it anyway is what
    /// catches the day that stops being true.
    #[test]
    fn a_compound_hold_always_yields_a_working_plan(
        hazards in proptest::collection::vec(any_hazard(), 2..5),
        subject_idx in 0usize..8,
    ) {
        let f = Fixture::new(hazards);
        let world = f.world(T0);
        let subject = f.spaces[subject_idx].compartment.clone();
        let a = assess(&world, &subject);
        if a.state.permits_work() || !a.options.is_empty() || a.holds.len() < 2 {
            return Ok(());
        }
        let plan = a.combined.clone();
        prop_assert!(plan.is_some(), "no single action works and no plan offered: {:?}", a.holds);
        if let Some(plan) = plan {
            prop_assert!(plan.subject_state.permits_work());
            prop_assert!(plan.actions.len() >= 2, "a plan of one is an option");
        }
    }

    /// Property 4, generalised: the two entry points never disagree.
    #[test]
    fn the_two_entry_points_never_disagree(
        hazards in proptest::collection::vec(any_hazard(), 1..4),
    ) {
        let f = Fixture::new(hazards);
        let world = f.world(T0);
        let hull = leverage(&world);
        for load in &f.spaces {
            for option in assess(&world, &load.compartment).options {
                if let Some(same) = hull.iter().find(|m| m.action == option.action) {
                    prop_assert_eq!(&same.effect, &option.effect);
                }
            }
        }
    }
}
