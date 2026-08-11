//! Mitigation options for a detected issue.
//!
//! # What this crate is for
//!
//! [`wadl_engine`] answers *why is this space refused* — the rule, the hazard, the
//! path it travelled, who may clear it. That is a **diagnosis**: a statement about
//! the world as it is.
//!
//! A mitigation is a different object. It is a **counterfactual**: *if X were
//! true, would the answer change, and what would that cost?* Nothing in a
//! diagnosis answers that, and the question a planner actually has to settle is
//! not "what is wrong with this space" but:
//!
//! > What is the smallest number of things I can do today that unlocks the most
//! > work?
//!
//! Note that this is an inversion of how the rest of the product reports. Every
//! other surface is organised *per space*. Options are organised **per action**,
//! because an action is the thing a person can be sent to do, and one action may
//! free spaces held by several different authorities.
//!
//! # Why the answers can be trusted
//!
//! [`wadl_engine::evaluate`] takes every input as data — graph, rules, hazards,
//! instant — and reads no clock. So a hypothetical world is cheap to build, and
//! the verdict that comes back for it is **a real evaluation with a real trace**,
//! not a heuristic from a lookup table of remedies. Every number in an [`Effect`]
//! was computed by evaluating the hull, twice: once as it is, once as it would be.
//!
//! That discipline is the same one the time dimension follows, and for the same
//! reason: a plausible fabrication is indistinguishable from a fact on screen.
//!
//! Being pure, this also builds for `wasm32`, which is what lets a mechanic
//! standing at a locked compartment see what would open it with no network on the
//! ship.
//!
//! # What this crate deliberately does not do
//!
//! * **It decides nothing.** It ranks proposals. A planner chooses, and the
//!   choice is recorded elsewhere. Nothing here writes to a schedule.
//! * **It proposes no waivers.** [`wadl_engine::RuleEntry`] carries `waivable`,
//!   and hazard cascades set it false, so the data would keep a waiver proposal
//!   from being catastrophic. It is still a safety judgement that needs an
//!   authored set of compensatory measures behind it, and there is none yet. The
//!   seam is named in [`Action`]'s documentation; nothing fills it.
//! * **It reports harm, not just benefit.** See [`Effect::closes`]. An option
//!   that frees six spaces and shuts one is not the same as an option that frees
//!   six, and a tool that only counted upside would confidently propose the
//!   former as though it were the latter.

#![forbid(unsafe_code)]
// See wadl-domain: doc_markdown fires on domain acronyms; allowed deliberately.
#![allow(clippy::doc_markdown)]
#![cfg_attr(
    test,
    allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing
    )
)]

use std::collections::{BTreeMap, BTreeSet};

use wadl_domain::compartment::CompartmentNo;
use wadl_domain::time::Timestamp;
use wadl_domain::units::ManHours;
use wadl_engine::{
    evaluate, AdjacencyGraph, Decision, DecisionState, EvaluationRequest, Hazard, RuleSet,
};

/// A compartment and the man-hours booked in it at the instant under evaluation.
///
/// The hours are what turn "a space opens" into "so many hours are recovered",
/// and they must be the hours booked *at that instant* — which is why the caller
/// supplies them rather than this crate deriving them. Space with no booked hours
/// still counts as freed, but frees nothing: that is latent capacity, and the
/// distinction is the readiness taxonomy's, kept here deliberately.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SpaceLoad {
    /// The compartment.
    pub compartment: CompartmentNo,
    /// Man-hours booked here at the evaluation instant.
    pub booked: ManHours,
}

/// Everything an option is computed against: the engine's own inputs, plus what
/// work is booked where.
#[derive(Clone, Copy)]
pub struct World<'a> {
    /// The hull's resolved adjacency graph.
    pub graph: &'a AdjacencyGraph,
    /// The rules in force.
    pub rules: &'a RuleSet,
    /// The hazards live on the hull.
    pub hazards: &'a [Hazard],
    /// The instant everything is evaluated at.
    pub at: Timestamp,
    /// Every space in the register, with the hours booked in it **at a given
    /// instant**.
    ///
    /// A function rather than a slice, because a `Wait` is evaluated at a future
    /// instant and has to be *priced* at that instant too. Booked work is
    /// window-filtered, so pricing a twelve-hour cure with today's bookings was
    /// wrong in both directions — and recovered man-hours is the only ranking key
    /// this crate has. The caller supplies the closure so there stays exactly one
    /// implementation of "what is booked here", shared with every other board.
    /// `Sync` so that `&World` is `Send`: these are read from async request
    /// handlers, where a world held across an await point must cross threads. It
    /// costs the pure crate nothing — a closure over borrowed data already is.
    pub loads: &'a (dyn Fn(Timestamp) -> Vec<SpaceLoad> + Sync),
}

/// An owned variant of a [`World`] — the hypothetical an [`Action`] produces.
struct Variant {
    graph: AdjacencyGraph,
    hazards: Vec<Hazard>,
    at: Timestamp,
}

impl Variant {
    fn decide(&self, rules: &RuleSet, subject: &CompartmentNo) -> Decision {
        evaluate(&EvaluationRequest {
            subject,
            graph: &self.graph,
            rules,
            hazards: &self.hazards,
            at: self.at,
        })
    }
}

/// Something a person could do that would change the verdict.
///
/// Each variant maps onto exactly one perturbation of the engine's inputs, which
/// is what keeps the set honest — an action this crate cannot express as a change
/// to the world is an action it cannot price, and it does not invent one.
///
/// The absent variant is a waiver. `RuleEntry::waivable` is already in the rule
/// data, so the seam exists; filling it needs an authored compensatory-measure
/// set and a safety authority behind it, and until then proposing "get it waived"
/// would be the platform putting its name to a judgement it has no basis for.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Action {
    /// Discharge the condition at a hazard's source — an isolation verified, a
    /// stop-work lifted, a stow struck down. Models as removing the hazard.
    Discharge {
        /// Where the hazard is.
        origin: CompartmentNo,
        /// The hazard's label, as the trace renders it.
        hazard: String,
        /// Who the rule says may clear it.
        actor: String,
    },
    /// Let every timed hold elapse. Nobody is sent; the space opens itself.
    ///
    /// Only ever generated when *all* of the subject's holds are timed. A space
    /// with one verification-gated hold never opens by waiting, and offering
    /// "wait" there would be the single most misleading thing this crate could
    /// say.
    Wait {
        /// The earliest instant at which waiting demonstrably opens the space.
        ///
        /// Settled by re-evaluation rather than read off the current trace: a
        /// hazard whose start lies between now and the last expiry raises holds
        /// the current trace cannot show, so the wait is pushed past *their*
        /// expiries too — or withdrawn, if one of them never expires.
        until: Timestamp,
    },
    /// Interrupt the path the hazard travels — blank a duct, close a penetration,
    /// erect a barrier. Models as removing that coupling between two spaces.
    ///
    /// Carries [`Confidence::AssumesOwnAuthorization`] always: the closure is
    /// itself work in a compartment, and this crate does not model whether *that*
    /// work is authorized.
    Interrupt {
        /// The upstream space.
        from: CompartmentNo,
        /// The downstream space.
        to: CompartmentNo,
        /// The coupling type code being interrupted.
        coupling: String,
    },
}

impl Action {
    /// A stable sort key, so ranking is deterministic across runs and machines.
    fn key(&self) -> String {
        match self {
            Self::Wait { until } => format!("0:{}", until.epoch_millis()),
            Self::Discharge { origin, hazard, .. } => format!("1:{origin}:{hazard}"),
            // Endpoints ordered, because `apply` cuts the coupling in BOTH
            // directions. One physical closure must have one identity, or the
            // leverage board lists it twice — the exact duplication the dedup
            // there exists to prevent.
            Self::Interrupt { from, to, coupling } => {
                let (a, b) = if from.as_str() <= to.as_str() {
                    (from, to)
                } else {
                    (to, from)
                };
                format!("2:{a}:{b}:{coupling}")
            }
        }
    }

    /// How expensive the action is to mount, lowest first. Used only to break a
    /// tie on recovered hours: waiting costs nobody anything, discharging costs
    /// an attendance, and interrupting a coupling is itself a job needing its own
    /// authorization.
    const fn cost_rank(&self) -> u8 {
        match self {
            Self::Wait { .. } => 0,
            Self::Discharge { .. } => 1,
            Self::Interrupt { .. } => 2,
        }
    }

    /// What the platform knows versus what it is assuming.
    const fn confidence(&self) -> Confidence {
        match self {
            // A cure elapsing is a matter of record: the hold's expiry was priced
            // by the rule from the hazard's own start.
            Self::Wait { .. } => Confidence::Computed,
            // Whether the named authority can actually attend, and when, is
            // outside anything this platform holds.
            Self::Discharge { .. } => Confidence::AssumesActor,
            Self::Interrupt { .. } => Confidence::AssumesOwnAuthorization,
        }
    }
}

/// How much of an option is computed and how much is assumed.
///
/// Stated on every option rather than implied, because the effect and the
/// feasibility have completely different standing: the effect is always a real
/// re-evaluation, while "the chemist can be here by 1400" is a guess the platform
/// is not entitled to make.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    /// Effect re-evaluated, and the precondition is a matter of record.
    Computed,
    /// Effect re-evaluated, but whether the named actor can attend in time is
    /// outside what the platform knows.
    AssumesActor,
    /// Effect re-evaluated, but the action is itself work needing its own
    /// authorization, which is not modelled here.
    AssumesOwnAuthorization,
}

impl Confidence {
    /// How much is being assumed, least first. Used to take the weakest across a
    /// plan: a set of actions is only as certain as its least certain step.
    const fn rank(self) -> u8 {
        match self {
            Self::Computed => 0,
            Self::AssumesActor => 1,
            Self::AssumesOwnAuthorization => 2,
        }
    }
}

/// What taking an action would do to the hull, computed by evaluating it.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Effect {
    /// Spaces that go from refusing work to permitting it.
    pub frees: Vec<CompartmentNo>,
    /// Spaces that go from permitting work to refusing it.
    ///
    /// Usually empty, and never ignorable. Waiting is the case that bites: a
    /// hazard whose start is still ahead of the instant becomes live once the
    /// clock passes it, so "wait five hours for the coat to cure" can walk
    /// straight into hot work starting in three. An option that reported only
    /// upside would recommend it.
    pub closes: Vec<CompartmentNo>,
    /// Booked man-hours in the freed spaces.
    pub freed_hours: ManHours,
    /// Booked man-hours in the closed spaces.
    pub closed_hours: ManHours,
}

impl Effect {
    /// Hours recovered net of hours lost. The ranking key.
    #[must_use]
    pub fn net_hours(&self) -> i64 {
        self.freed_hours.get() - self.closed_hours.get()
    }

    /// Whether taking this action would shut a space that is currently open.
    #[must_use]
    pub fn does_harm(&self) -> bool {
        !self.closes.is_empty()
    }
}

/// One ranked proposal.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Mitigation {
    /// What someone would do.
    pub action: Action,
    /// The re-evaluated consequence across the whole hull.
    pub effect: Effect,
    /// What is computed and what is assumed.
    pub confidence: Confidence,
    /// The state the subject would be in afterwards. Present so a reader can see
    /// that an option took a space to WARN rather than ALLOW — both permit work,
    /// and they are not the same thing to a supervisor.
    pub subject_state: DecisionState,
}

/// One independent hold on a space: a hazard and the rule it fired.
///
/// Reported when no single action clears the subject, which is itself the answer
/// a planner needs — "this needs both the isolation and the cure" is actionable,
/// and much better than an empty list.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Hold {
    /// The rule that fired.
    pub rule_code: String,
    /// Where the hazard is.
    pub origin: CompartmentNo,
    /// The hazard's label.
    pub hazard: String,
    /// Who may clear it.
    pub clearing_authority: String,
    /// When it expires on a clock, or `None` when it clears on verification.
    pub earliest_clear: Option<Timestamp>,
    /// The state this hold contributes.
    ///
    /// Carried because a WARN and a BLOCK are not the same object to reason about.
    /// A WARN permits work — it is a condition flagged, not a hold to discharge —
    /// and treating the two alike let one advisory WARN with no clock suppress a
    /// `Wait` that demonstrably opened the space.
    pub state: DecisionState,
}

impl Hold {
    /// Whether this is what stops work, as opposed to a condition flagged alongside.
    #[must_use]
    pub const fn blocks(&self) -> bool {
        !self.state.permits_work()
    }
}

/// The full answer for one detected issue.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Assessment {
    /// The space the issue is on.
    pub subject: CompartmentNo,
    /// Its current state.
    pub state: DecisionState,
    /// Man-hours booked in it at the instant.
    pub booked: ManHours,
    /// Every independent hold on it.
    pub holds: Vec<Hold>,
    /// Ranked options, best first. Empty when no single action clears it — read
    /// `combined` then.
    pub options: Vec<Mitigation>,
    /// The cheapest set of actions that together open the space, present only when
    /// no single action does.
    pub combined: Option<Combined>,
}

/// Several actions that only work together, priced as one plan.
///
/// Kept separate from [`Mitigation`] rather than adding a "do all of these" variant
/// to [`Action`], so that the invariant holding the counterfactual honest survives:
/// one [`Action`] is exactly one perturbation of the engine's inputs.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Combined {
    /// Every action in the plan. All of them are needed.
    pub actions: Vec<Action>,
    /// The re-evaluated consequence of taking them all.
    pub effect: Effect,
    /// The weakest confidence among the parts — a plan is only as certain as its
    /// least certain step.
    pub confidence: Confidence,
    /// The state the subject would be in afterwards.
    pub subject_state: DecisionState,
}

impl Assessment {
    /// Whether the subject needs more than one action addressed to open.
    #[must_use]
    pub fn is_compound(&self) -> bool {
        self.options.is_empty() && self.holds.len() > 1
    }
}

fn decide(world: &World<'_>, subject: &CompartmentNo) -> Decision {
    evaluate(&EvaluationRequest {
        subject,
        graph: world.graph,
        rules: world.rules,
        hazards: world.hazards,
        at: world.at,
    })
}

/// The world as it is, owned so actions can be applied to it.
fn base(world: &World<'_>) -> Variant {
    Variant {
        graph: world.graph.clone(),
        hazards: world.hazards.to_vec(),
        at: world.at,
    }
}

/// One action applied to a world, yielding the world it would produce.
///
/// Takes and returns a [`Variant`] rather than reading a [`World`], so actions
/// compose: pricing a compound hold means applying several at once, and a function
/// per action that could only start from the real world could not be chained.
fn apply(mut variant: Variant, action: &Action) -> Variant {
    match action {
        Action::Discharge { origin, hazard, .. } => {
            variant
                .hazards
                .retain(|h| !(&h.origin == origin && &h.label == hazard));
        }
        Action::Wait { until } => variant.at = *until,
        Action::Interrupt { from, to, coupling } => {
            // Cut in both directions: a physical closure is not directional —
            // blanking a duct stops the air whichever way it was flowing — and the
            // schema stores symmetric couplings as two rows.
            let cut = |a: &CompartmentNo, b: &CompartmentNo, code: &str| {
                code == coupling.as_str() && ((a == from && b == to) || (a == to && b == from))
            };
            variant.graph = AdjacencyGraph::new(
                variant
                    .graph
                    .edges()
                    .filter(|e| !cut(&e.from, &e.to, e.code.as_str()))
                    .cloned()
                    .collect(),
            );
        }
    }
    variant
}

fn variant_for(world: &World<'_>, actions: &[Action]) -> Variant {
    actions.iter().fold(base(world), apply)
}

/// The holds on a space, one per (rule, hazard) that fired, deduplicated.
fn holds_of(decision: &Decision) -> Vec<Hold> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for step in &decision.trace {
        let key = (
            step.rule_code.clone(),
            step.source.clone(),
            step.hazard.clone(),
        );
        if !seen.insert(key) {
            continue;
        }
        out.push(Hold {
            rule_code: step.rule_code.clone(),
            origin: step.source.clone(),
            hazard: step.hazard.clone(),
            clearing_authority: step.clearing_authority.clone(),
            earliest_clear: step.earliest_clear,
            state: step.state,
        });
    }
    out
}

/// How many times a wait may be pushed out — or a plan grown — by holds that only
/// come live at the waited instant, before the search gives up.
///
/// Progress is guaranteed at every pass (a new discharge, or a strictly later
/// expiry from a finite set of hazards), so this is a backstop against a modelling
/// error, not a tuning knob.
const SETTLE_CAP: usize = 32;

/// The timed expiries of every step in a trace that stops work — `Some(latest)`
/// only when *all* of them are on a clock. One verification-gated hold among them
/// and no amount of time helps.
fn blocking_expiry(decision: &Decision) -> Option<Timestamp> {
    decision
        .trace
        .iter()
        .filter(|s| !s.state.permits_work())
        .map(|s| s.earliest_clear)
        .collect::<Option<Vec<_>>>()
        .and_then(|expiries| expiries.into_iter().max())
}

/// The earliest instant at which waiting alone opens the subject, or `None`.
///
/// Starts from the latest expiry among the holds visible now, then re-evaluates
/// *at that instant*. A hazard whose start lies between now and that expiry raises
/// holds the current trace cannot show, and a wait priced off the current trace
/// alone would be offered on the strength of holds it dodged, not holds it
/// outlived. Each pass either opens the space, pushes the wait to a later timed
/// expiry, or meets a verification-gated hold — which no wait clears.
fn settled_wait(world: &World<'_>, subject: &CompartmentNo, first: Timestamp) -> Option<Timestamp> {
    let mut until = first;
    for _ in 0..SETTLE_CAP {
        let after = variant_for(world, &[Action::Wait { until }]).decide(world.rules, subject);
        if after.permits_work() {
            return Some(until);
        }
        let next = blocking_expiry(&after)?;
        if next <= until {
            return None;
        }
        until = next;
    }
    None
}

/// Candidate actions for a refused space, drawn from its own trace.
///
/// Generated from the trace rather than from the whole world, which is what keeps
/// this tractable: the trace names the specific holds and the specific hops the
/// hazard took, so the candidate set is proportional to the trace and not to the
/// hull. Enumerating subsets of hazards and couplings would explode, and would be
/// answering a different question anyway — a planner executes one action, not a
/// combination found by search.
fn candidates(world: &World<'_>, subject: &CompartmentNo, decision: &Decision) -> Vec<Action> {
    let mut out: Vec<Action> = Vec::new();
    let mut seen = BTreeSet::new();

    // Restricted to blocking steps deliberately. Spanning the whole trace let a
    // single advisory WARN with no clock — a condition flagged, not a hold —
    // permanently suppress a wait that would have opened the space. The instant
    // is then settled by re-evaluation, so a wait is only ever offered at an
    // instant where it has been shown to work.
    if let Some(until) =
        blocking_expiry(decision).and_then(|first| settled_wait(world, subject, first))
    {
        out.push(Action::Wait { until });
    }

    for step in &decision.trace {
        if seen.insert(("d", step.source.to_string(), step.hazard.clone())) {
            out.push(Action::Discharge {
                origin: step.source.clone(),
                hazard: step.hazard.clone(),
                actor: step.clearing_authority.clone(),
            });
        }
        // Each hop the hazard travelled is a place the path could be cut. `path`
        // is source-first and `via` names the coupling used for each step of it,
        // so hop i runs path[i] -> path[i + 1] via via[i].
        for (i, coupling) in step.via.iter().enumerate() {
            let (Some(from), Some(to)) = (step.path.get(i), step.path.get(i + 1)) else {
                continue;
            };
            if seen.insert(("i", format!("{from}->{to}"), coupling.clone())) {
                out.push(Action::Interrupt {
                    from: from.clone(),
                    to: to.clone(),
                    coupling: coupling.clone(),
                });
            }
        }
    }
    out
}

/// Every space within the graph's maximum coupling reach of a seed set.
///
/// This is the load-bearing overapproximation behind every bound in this
/// crate: a trace step exists only for a hazard whose origin reaches the
/// subject through couplings within their hop limits, and a plain BFS that
/// ignores propagation legality and per-edge limits can only find MORE spaces
/// than the engine's traversal, never fewer. So a space outside the reach of
/// every changed input provably keeps its verdict, and skipping its
/// re-evaluation changes nothing but the bill.
fn reach<'a>(
    graph: &AdjacencyGraph,
    seeds: impl Iterator<Item = &'a CompartmentNo>,
) -> BTreeSet<CompartmentNo> {
    let max_hops = graph.edges().map(|e| e.max_reach.get()).max().unwrap_or(0);
    let mut adjacent: BTreeMap<&CompartmentNo, Vec<&CompartmentNo>> = BTreeMap::new();
    for e in graph.edges() {
        adjacent.entry(&e.from).or_default().push(&e.to);
    }
    let mut seen: BTreeSet<CompartmentNo> = seeds.cloned().collect();
    let mut frontier: Vec<CompartmentNo> = seen.iter().cloned().collect();
    for _ in 0..max_hops {
        let mut next = Vec::new();
        for space in &frontier {
            for &neighbour in adjacent.get(space).into_iter().flatten() {
                if seen.insert(neighbour.clone()) {
                    next.push(neighbour.clone());
                }
            }
        }
        if next.is_empty() {
            break;
        }
        frontier = next;
    }
    seen
}

/// The spaces whose verdicts a set of actions could possibly change.
///
/// Per action, the changed input is local: a discharge changes one hazard (its
/// origin's reach), an interruption changes one coupling (its endpoints'
/// reach), and a wait changes only what time changes — hazard-derived holds,
/// so the reach of every hazard origin. Everything outside the union keeps its
/// baseline verdict, by the argument on [`reach`].
fn affected_by(world: &World<'_>, actions: &[Action]) -> BTreeSet<CompartmentNo> {
    let mut seeds: Vec<&CompartmentNo> = Vec::new();
    for action in actions {
        match action {
            Action::Discharge { origin, .. } => seeds.push(origin),
            Action::Interrupt { from, to, .. } => {
                seeds.push(from);
                seeds.push(to);
            }
            Action::Wait { .. } => seeds.extend(world.hazards.iter().map(|h| &h.origin)),
        }
    }
    reach(world.graph, seeds.into_iter())
}

/// Which spaces permit work in the world as it is.
///
/// Computed once and shared — it is the same answer for every action and every
/// subject — and bounded to the hazard shadow: a space no hazard can reach is
/// open by construction and never evaluated. Exposed so `wadl-issues` can
/// derive a whole board against one baseline instead of one per held space.
pub struct Baseline {
    open: BTreeMap<CompartmentNo, bool>,
}

impl Baseline {
    fn is_open(&self, compartment: &CompartmentNo) -> bool {
        self.open.get(compartment).copied().unwrap_or(true)
    }
}

/// Computes the [`Baseline`] for a world. See the type for why it is shared.
#[must_use]
pub fn baseline(world: &World<'_>) -> Baseline {
    let shadow = reach(world.graph, world.hazards.iter().map(|h| &h.origin));
    let open = (world.loads)(world.at)
        .into_iter()
        .map(|load| {
            let open = !shadow.contains(&load.compartment)
                || decide(world, &load.compartment).permits_work();
            (load.compartment, open)
        })
        .collect();
    Baseline { open }
}

/// The consequence of a set of actions across every space in the register.
///
/// Hours come from the instant the variant is evaluated at, not from `world.at`.
/// That is the whole reason [`World::loads`] is a function: booked work is
/// window-filtered, so pricing a twelve-hour cure with today's bookings misstates
/// the one number the ranking is built on.
///
/// Only the spaces in [`affected_by`]'s union are re-evaluated; the rest keep
/// their baseline verdict and so can never enter `frees` or `closes`.
fn effect_of(world: &World<'_>, base: &Baseline, actions: &[Action]) -> Effect {
    let affected = affected_by(world, actions);
    let variant = variant_for(world, actions);
    let mut effect = Effect::default();
    for load in (world.loads)(variant.at) {
        if !affected.contains(&load.compartment) {
            continue;
        }
        let before = base.is_open(&load.compartment);
        let after = variant
            .decide(world.rules, &load.compartment)
            .permits_work();
        if !before && after {
            effect.frees.push(load.compartment.clone());
            effect.freed_hours = effect.freed_hours + load.booked;
        } else if before && !after {
            effect.closes.push(load.compartment.clone());
            effect.closed_hours = effect.closed_hours + load.booked;
        }
    }
    effect
}

/// Orders proposals: most work recovered, then least harm, then cheapest to
/// mount, then a stable key so the order never depends on iteration chance.
fn rank(options: &mut [Mitigation]) {
    options.sort_by(|a, b| {
        b.effect
            .net_hours()
            .cmp(&a.effect.net_hours())
            .then_with(|| a.effect.closes.len().cmp(&b.effect.closes.len()))
            .then_with(|| a.action.cost_rank().cmp(&b.action.cost_rank()))
            .then_with(|| a.action.key().cmp(&b.action.key()))
    });
}

/// Assesses one refused space and ranks the single actions that would open it.
///
/// An option is kept only if the subject actually permits work in the
/// hypothetical. That is the crate's central contract: **every option offered has
/// been shown to work**, by evaluating it. A list that included plausible
/// candidates without checking them would be worse than no list, because a
/// planner would send someone.
#[must_use]
pub fn assess(world: &World<'_>, subject: &CompartmentNo) -> Assessment {
    assess_with(world, subject, &baseline(world))
}

/// [`assess`] against a caller-supplied [`Baseline`].
///
/// The baseline is the same answer for every subject on the hull, so a caller
/// assessing many spaces — the issue board, a batch re-check — computes it once
/// and passes it in; [`assess`] is the single-subject convenience that pays
/// for its own.
#[must_use]
pub fn assess_with(world: &World<'_>, subject: &CompartmentNo, base: &Baseline) -> Assessment {
    let decision = decide(world, subject);
    let booked = (world.loads)(world.at)
        .into_iter()
        .find(|s| &s.compartment == subject)
        .map_or(ManHours::ZERO, |s| s.booked);

    let mut assessment = Assessment {
        subject: subject.clone(),
        state: decision.state,
        booked,
        holds: holds_of(&decision),
        options: Vec::new(),
        combined: None,
    };
    // Nothing to mitigate on a space that already permits work. Said explicitly:
    // an empty option list on an open space means "no issue", not "no idea".
    if decision.permits_work() {
        return assessment;
    }

    for action in candidates(world, subject, &decision) {
        let after = variant_for(world, std::slice::from_ref(&action)).decide(world.rules, subject);
        if !after.permits_work() {
            continue;
        }
        assessment.options.push(Mitigation {
            confidence: action.confidence(),
            effect: effect_of(world, base, std::slice::from_ref(&action)),
            subject_state: after.state,
            action,
        });
    }
    rank(&mut assessment.options);
    // Only when nothing single works. Offered alongside a working single action it
    // would be noise: a planner with one thing to do does not need the plan that
    // does everything.
    if assessment.options.is_empty() {
        assessment.combined = combined_for(world, base, subject, &assessment.holds);
    }
    assessment
}

/// What an issue derivation needs to know about a space, and nothing more.
///
/// The verdicts of [`assess`] — is it refused, what holds it, would any single
/// action open it, how many actions does the working plan need — without
/// pricing a single effect across the hull. Pricing is what a planner reads on
/// the options panel; an issue is the *claim*, and pricing every claim is what
/// made deriving a board quadratic in the hull.
#[derive(Debug, Clone)]
pub struct Triage {
    /// The space's current state.
    pub state: DecisionState,
    /// Man-hours booked in it at the instant.
    pub booked: ManHours,
    /// Every independent hold on it.
    pub holds: Vec<Hold>,
    /// Whether at least one single action demonstrably opens it.
    pub single_action_opens: bool,
    /// Actions in the cheapest working plan when nothing single does; 0 when
    /// no plan was found (or none was needed).
    pub plan_actions: usize,
}

/// Computes a [`Triage`] for one space. Agrees with [`assess`] by
/// construction: same candidates, same verification, same plan search — only
/// the pricing is skipped.
#[must_use]
pub fn triage(world: &World<'_>, subject: &CompartmentNo) -> Triage {
    let decision = decide(world, subject);
    let booked = (world.loads)(world.at)
        .into_iter()
        .find(|s| &s.compartment == subject)
        .map_or(ManHours::ZERO, |s| s.booked);
    let holds = holds_of(&decision);
    let mut out = Triage {
        state: decision.state,
        booked,
        holds,
        single_action_opens: false,
        plan_actions: 0,
    };
    if decision.permits_work() {
        return out;
    }
    out.single_action_opens = candidates(world, subject, &decision).iter().any(|action| {
        variant_for(world, std::slice::from_ref(action))
            .decide(world.rules, subject)
            .permits_work()
    });
    if !out.single_action_opens {
        out.plan_actions = combined_plan(world, subject, &out.holds).map_or(0, |plan| plan.len());
    }
    out
}

/// The cheapest set of actions that together open a space no single action opens.
///
/// Cheapest, not simply "discharge everything". A compound of one curing coat and
/// one stop-work does not need two attendances: the coat expires on its own, so the
/// plan is *wait for the cure and get the stop-work lifted*, and reporting two
/// discharges would overstate the cost by a whole attendance.
///
/// So: one `Wait` covering every timed hold, plus one `Discharge` per hazard whose
/// hold has no clock — then re-evaluated, and grown until it demonstrably works.
/// The growing matters: a hazard whose start lies between now and the waited
/// instant holds the space *then* without appearing in the trace *now*, so each
/// pass folds in whatever the re-evaluation surfaces — a discharge for a
/// verification-gated hold, a later instant for a timed one — until the space
/// opens or nothing new can be done.
///
/// Only the holds that actually stop work are considered. An advisory WARN alongside
/// them needs nothing done: including it added a step to the plan that was not
/// needed, and pushed the `Wait` out to an instant that could bring fresh hazards
/// live and put spaces in `closes` for no reason.
fn combined_for(
    world: &World<'_>,
    base: &Baseline,
    subject: &CompartmentNo,
    holds: &[Hold],
) -> Option<Combined> {
    let actions = combined_plan(world, subject, holds)?;
    let after = variant_for(world, &actions).decide(world.rules, subject);
    let confidence = actions
        .iter()
        .map(Action::confidence)
        .max_by_key(|c| c.rank())
        .unwrap_or(Confidence::Computed);
    Some(Combined {
        effect: effect_of(world, base, &actions),
        subject_state: after.state,
        confidence,
        actions,
    })
}

/// The plan search behind [`combined_for`], returning the actions alone so the
/// issue board can ask "does a plan exist, and how big is it" without paying
/// for the pricing. Every returned plan has been shown to open the subject.
fn combined_plan(
    world: &World<'_>,
    subject: &CompartmentNo,
    holds: &[Hold],
) -> Option<Vec<Action>> {
    let blocking: Vec<&Hold> = holds.iter().filter(|h| h.blocks()).collect();
    if blocking.len() < 2 {
        return None;
    }
    let mut wait_until = blocking.iter().filter_map(|h| h.earliest_clear).max();
    let mut discharges: Vec<Action> = Vec::new();
    let mut seen = BTreeSet::new();
    let discharge = |seen: &mut BTreeSet<(CompartmentNo, String)>,
                     discharges: &mut Vec<Action>,
                     origin: &CompartmentNo,
                     hazard: &str,
                     actor: &str| {
        if seen.insert((origin.clone(), hazard.to_owned())) {
            discharges.push(Action::Discharge {
                origin: origin.clone(),
                hazard: hazard.to_owned(),
                actor: actor.to_owned(),
            });
            true
        } else {
            false
        }
    };
    for hold in blocking.iter().filter(|h| h.earliest_clear.is_none()) {
        discharge(
            &mut seen,
            &mut discharges,
            &hold.origin,
            &hold.hazard,
            &hold.clearing_authority,
        );
    }
    for _ in 0..SETTLE_CAP {
        let actions: Vec<Action> = wait_until
            .map(|until| Action::Wait { until })
            .into_iter()
            .chain(discharges.iter().cloned())
            .collect();
        let after = variant_for(world, &actions).decide(world.rules, subject);
        if after.permits_work() {
            // A plan of one is an option, and the single-action pass has already
            // tried and rejected every one of these; reaching here with one
            // action would only rediscover that rejection.
            if actions.len() < 2 {
                return None;
            }
            return Some(actions);
        }
        // Still refused: the waited instant raised holds the original trace could
        // not show. Fold them in and try again.
        let mut progressed = false;
        for step in after.trace.iter().filter(|s| !s.state.permits_work()) {
            match step.earliest_clear {
                None => {
                    progressed |= discharge(
                        &mut seen,
                        &mut discharges,
                        &step.source,
                        &step.hazard,
                        &step.clearing_authority,
                    );
                }
                Some(expiry) => {
                    if wait_until.is_none_or(|u| expiry > u) {
                        wait_until = Some(expiry);
                        progressed = true;
                    }
                }
            }
        }
        if !progressed {
            return None;
        }
    }
    None
}

/// The hull's highest-leverage actions, regardless of which space you started from.
///
/// This is the screen that answers the planner's real question. [`assess`] is
/// per-space and answers "what opens *this*"; this is per-action across the whole
/// hull and answers "what is worth doing at all". They share every primitive, so
/// the two can never disagree about what an action would achieve.
///
/// Deduplicated by action, because the same isolation shows up in the trace of
/// every space it holds, and a list that repeated it six times would bury the
/// five other things worth doing.
#[must_use]
pub fn leverage(world: &World<'_>) -> Vec<Mitigation> {
    let mut by_action: BTreeMap<String, Action> = BTreeMap::new();
    for load in &(world.loads)(world.at) {
        let decision = decide(world, &load.compartment);
        if decision.permits_work() {
            continue;
        }
        for action in candidates(world, &load.compartment, &decision) {
            by_action.entry(action.key()).or_insert(action);
        }
    }

    let base = baseline(world);
    let mut out: Vec<Mitigation> = by_action
        .into_values()
        .map(|action| {
            let effect = effect_of(world, &base, std::slice::from_ref(&action));
            Mitigation {
                confidence: action.confidence(),
                // Hull-wide, so there is no one subject. The state reported is the
                // aggregate claim the option makes: it frees at least one space.
                subject_state: if effect.frees.is_empty() {
                    DecisionState::Block
                } else {
                    DecisionState::Allow
                },
                effect,
                action,
            }
        })
        // An action that frees nothing is not leverage. It can happen: cutting one
        // of two parallel couplings leaves the cascade arriving by the other.
        .filter(|m| !m.effect.frees.is_empty())
        .collect();
    rank(&mut out);
    out
}
