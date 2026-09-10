//! The evaluation seam — the one function the platform calls to learn a
//! compartment's authorization state.
//!
//! [`evaluate`] contains no thresholds, no reaches and no outcomes of its own.
//! It is handed a [`RuleSet`] (rules as data — ADR 0002), the hull's adjacency
//! graph, the live hazards, and the evaluation instant, and it applies them:
//! for every rule triggered by a live hazard, it walks that rule's bounded,
//! direction-respecting cascade and records a [`TraceStep`] wherever the subject
//! compartment is reached. The governing state is the most severe across the
//! trace.
//!
//! Every trace step carries the [`RuleVersionId`] that produced it, which is
//! what makes a decision from 2027 explainable in 2031 after the rule has
//! changed twice.
//!
//! The evaluation instant is data, not a clock read, so [`evaluate`] answers for
//! **any** instant a caller names. That is what a planner scrubbing to Thursday
//! is doing, and the two places the instant bites are the two ends of a hold: a
//! hazard not yet raised contributes nothing, and a hold that has elapsed
//! contributes nothing. A hold gated on a verification instead of a clock never
//! elapses, which is the distinction the whole time dimension is built to show.

use wadl_domain::compartment::CompartmentNo;
use wadl_domain::ids::RuleVersionId;
use wadl_domain::time::Timestamp;
use wadl_domain::units::HopDepth;

use crate::coupling::AdjacencyGraph;
use crate::decision::DecisionState;
use crate::rules::{Applies, HoldFrom, RuleEntry, RuleSet};
use crate::traversal::{cascade_from, TraversalBound};

/// A hazard that is live somewhere in the space set under evaluation.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Hazard {
    /// The compartment the hazard originates in.
    pub origin: CompartmentNo,
    /// What kind of hazard it is.
    pub kind: HazardKind,
    /// When the hazard was raised. Combined with a rule's hold period to price
    /// the earliest the affected space can clear.
    pub since: Timestamp,
    /// Human label for the trace, e.g. `CT-3160-4 · final coat, curing`.
    pub label: String,
    /// When the fact ended — the instant of the `HAZARD_CLEARED` row its
    /// clearing authority wrote, with a basis. `None` while the fact stands.
    /// Absent from an older payload = still live.
    #[serde(default)]
    pub ended: Option<Timestamp>,
}

impl Hazard {
    /// Whether this hazard has been raised by `at`.
    ///
    /// When a hazard stops *mattering* is still the rule's judgement, not the
    /// hazard's: the same open coating ticket blocks the deck above for eight
    /// hours (R03) and suspends the shared trunk for eight (R09); a different
    /// rule set could price them differently from the same ticket. So the end
    /// of a hold is priced per trace step from the rule's own `hold` and its
    /// anchor, and the hazard carries only when it began and — once a person
    /// has ended it — when.
    #[must_use]
    pub const fn raised_by(&self, at: Timestamp) -> bool {
        at.epoch_millis() >= self.since.epoch_millis()
    }

    /// Whether the fact had been ended by `at`. A clearance stamped later than
    /// `at` has not happened yet from that instant's point of view.
    #[must_use]
    pub const fn ended_by(&self, at: Timestamp) -> bool {
        match self.ended {
            Some(ended) => ended.epoch_millis() <= at.epoch_millis(),
            None => false,
        }
    }
}

/// The hazard kinds the platform recognises. A rule binds to one of these
/// (`rule_version.trigger_expr` in the schema); the *outcome* is the rule's, not
/// the hazard kind's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HazardKind {
    /// An open coating/service ticket — a flammable-vapour source with a cure
    /// clock (rules R03/R06/R09).
    CoatingOpen,
    /// Live hot work — a heat and ignition source (rule R04).
    HotWorkLive,
    /// An energised bus not in a verified zero-energy state (rules R07/R17).
    EnergisedBus,
    /// Open flammable stow in a coupled space (rule R13).
    FlammableStow,
    /// A stop-work recorded by an inspection authority (rule R22).
    StopWork,
}

/// Everything the engine needs to decide one compartment. Borrowed, not owned:
/// the engine holds nothing, mutates nothing, and reads no clock.
#[derive(Debug, Clone, Copy)]
pub struct EvaluationRequest<'a> {
    /// The compartment being authorized.
    pub subject: &'a CompartmentNo,
    /// The hull's resolved adjacency graph (class template + hull overrides).
    pub graph: &'a AdjacencyGraph,
    /// The rules in force for this work — data, not code.
    pub rules: &'a RuleSet,
    /// The hazards live across the space set.
    pub hazards: &'a [Hazard],
    /// The instant the decision is made at, supplied by the caller.
    ///
    /// Not necessarily now. A caller may ask for any instant — that is how a
    /// planner sees Thursday and how a decision from 2027 is re-derived in 2031
    /// — and the answer is a real evaluation with a real trace, never an
    /// interpolation.
    pub at: Timestamp,
}

/// One line of the decision trace: a single rule firing on the subject.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TraceStep {
    /// The rule's human code, e.g. `R03`.
    pub rule_code: String,
    /// The rule version that produced this line — the reason a historical
    /// decision remains explainable after the rule changes.
    pub rule_version: RuleVersionId,
    /// The outcome this line contributes.
    pub state: DecisionState,
    /// Where the hazard originated.
    pub source: CompartmentNo,
    /// The hazard's label, so the trace reads as an account of events.
    pub hazard: String,
    /// How many hops from the source the subject sits.
    pub depth: HopDepth,
    /// The compartments traversed, source-first, ending at the subject.
    pub path: Vec<CompartmentNo>,
    /// The coupling type codes traversed, in order — *why* the hazard reached.
    pub via: Vec<String>,
    /// The standard this decision is anchored to.
    pub authority: String,
    /// Who may clear the condition.
    pub clearing_authority: String,
    /// The earliest this line could clear, where the rule has a hold period.
    pub earliest_clear: Option<Timestamp>,
    /// Human-readable reason, rendered verbatim in the field-app trace.
    pub reason: String,
}

/// The decision for one compartment: the governing state plus the full trace.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Decision {
    /// The governing (most severe) state across every line of the trace.
    pub state: DecisionState,
    /// Every rule that fired, in the order encountered.
    pub trace: Vec<TraceStep>,
    /// The latest of the trace's hold expiries — the earliest the compartment as
    /// a whole could clear on time alone. `None` when nothing is time-bounded
    /// (an isolation clears on verification, not on a clock).
    pub earliest_clear: Option<Timestamp>,
}

impl Decision {
    /// Whether work may start or continue in the subject compartment.
    #[must_use]
    pub fn permits_work(&self) -> bool {
        self.state.permits_work()
    }

    /// The trace line that produced [`Self::state`] — the governing hold.
    ///
    /// Not `trace.first()`. The trace is in traversal order, so the first line
    /// is the *nearest* hazard, not the most severe one: a WARN in this space
    /// followed by a SUSPEND two hops away leaves `first()` naming the authority
    /// for the warning while the space is actually suspended. "Who can clear
    /// this" is the field a supervisor acts on, so it has to come from the line
    /// that decided the state.
    ///
    /// Ties go to the earliest matching line, which is the shallowest hop — the
    /// closest place the hold can be addressed.
    #[must_use]
    pub fn governing_step(&self) -> Option<&TraceStep> {
        self.trace.iter().find(|s| s.state == self.state)
    }
}

/// Where a step's clock stands: the earliest clear, and the clause the reason
/// sentence carries about it (none for a raise-anchored hold, whose sentence
/// has not changed since the first golden trace).
///
/// A raise-anchored hold runs from `since`. An end-anchored hold has **no
/// clock until the fact ends**: while the permit is open the step reads
/// *clears on verification* and says the watch starts at the close; once
/// `ended` is known and has happened by `at`, the watch runs from it.
fn hold_clock(
    entry: &RuleEntry,
    hazard: &Hazard,
    at: Timestamp,
) -> (Option<Timestamp>, Option<String>) {
    match (entry.hold_from, entry.hold) {
        (HoldFrom::End, Some(hold)) => match hazard.ended {
            Some(ended) if ended <= at => (
                Some(ended.plus_minutes(hold)),
                Some(format!(
                    "permit closed, fire watch of {} min running",
                    hold.get()
                )),
            ),
            _ => (
                None,
                Some(format!(
                    "fire watch of {} min starts when the permit closes",
                    hold.get()
                )),
            ),
        },
        (_, hold) => (hold.map(|hold| hazard.since.plus_minutes(hold)), None),
    }
}

/// Builds the trace step for a rule that fired, at `depth`, along `via`, as of
/// `at`.
fn step(
    entry: &RuleEntry,
    hazard: &Hazard,
    depth: HopDepth,
    path: Vec<CompartmentNo>,
    via: Vec<String>,
    at: Timestamp,
) -> TraceStep {
    let (earliest_clear, clock_clause) = hold_clock(entry, hazard, at);
    let reached = if depth == HopDepth::ZERO {
        format!("{} in this space", hazard.label)
    } else {
        format!(
            "{} in {} — reached via {} ({} hop{})",
            hazard.label,
            hazard.origin,
            via.join(" → "),
            depth.get(),
            if depth.get() == 1 { "" } else { "s" }
        )
    };
    let reason = match clock_clause {
        Some(clause) => format!("{reached}; {clause}."),
        None => format!("{reached}."),
    };
    TraceStep {
        rule_code: entry.rule_code.clone(),
        rule_version: entry.rule_version,
        state: entry.state,
        source: hazard.origin.clone(),
        hazard: hazard.label.clone(),
        depth,
        path,
        via,
        authority: entry.authority.clone(),
        clearing_authority: entry.clearing_authority.clone(),
        earliest_clear,
        reason,
    }
}

/// Records `step` unless its hold has already elapsed at `at`.
///
/// This is the whole difference between the platform's two kinds of hold, and it
/// is what lets the product answer *what is still stopped on Thursday*:
///
/// - a step with a `hold` **clears itself**. At `earliest_clear` the cure is
///   done and nobody had to do anything.
/// - a step without one (`earliest_clear: None`) is gated on a **verification** —
///   a marine chemist's certificate, a verified zero-energy state — and no
///   amount of elapsed time discharges it.
///
/// Comparing with `>=` matches the half-open reading used everywhere else: the
/// space clears *at* the instant the hold expires, not a millisecond later.
fn push_live(trace: &mut Vec<TraceStep>, step: TraceStep, at: Timestamp) {
    // Reads as: keep the step if it has no clock (a verification hold), or if its
    // clock has not run out yet.
    if step.earliest_clear.is_none_or(|clear| at < clear) {
        trace.push(step);
    }
}

/// Evaluates the authorization state of `req.subject` under `req.rules`, **as of
/// `req.at`**.
///
/// With no rule firing the state is [`DecisionState::Allow`] and the trace is
/// empty — an explicit "nothing applies here", not an absence of information.
///
/// `req.at` is load-bearing in two places, and it is the only reason this
/// function can be asked about an instant other than now. A hazard not yet
/// raised at `at` contributes nothing, and a step whose hold has elapsed by `at`
/// contributes nothing. Everything else about the answer is time-invariant, so a
/// decision handed a fixed instant is reproducible for a board of inquiry — the
/// point of taking the instant as data rather than reading a clock.
#[must_use]
pub fn evaluate(req: &EvaluationRequest<'_>) -> Decision {
    let mut trace = Vec::new();

    for hazard in req.hazards {
        // A hazard that has not been raised yet is not a reason for anything.
        // Without this, asking for an instant before a hazard began would hold
        // the space anyway, and a schedule of future work would read as a hull
        // that is shut today.
        if !hazard.raised_by(req.at) {
            continue;
        }
        for entry in req.rules.for_hazard(hazard.kind) {
            // A raise-anchored row has nothing to say about a fact a person has
            // already ended: the clearance ended it (the answer the store's
            // live filter used to give on its own). An end-anchored row is the
            // opposite case — the clearance is what STARTS its clock — so it
            // reads on; `hold_clock` prices it and `push_live` drops it when
            // the watch has run.
            if entry.hold_from == HoldFrom::Raise && hazard.ended_by(req.at) {
                continue;
            }
            match &entry.applies {
                Applies::SameSpace => {
                    if &hazard.origin == req.subject {
                        push_live(
                            &mut trace,
                            step(
                                entry,
                                hazard,
                                HopDepth::ZERO,
                                vec![hazard.origin.clone()],
                                Vec::new(),
                                req.at,
                            ),
                            req.at,
                        );
                    }
                }
                Applies::Coupled { code, max_hops } => {
                    let bound = TraversalBound::new(*max_hops, Some(code.clone()));
                    for hit in cascade_from(req.graph, &hazard.origin, &bound) {
                        if &hit.compartment != req.subject {
                            continue;
                        }
                        let mut path = vec![hazard.origin.clone()];
                        path.extend(hit.path.iter().map(|edge| edge.to.clone()));
                        let via = hit
                            .path
                            .iter()
                            .map(|edge| edge.code.as_str().to_owned())
                            .collect();
                        push_live(
                            &mut trace,
                            step(entry, hazard, hit.depth, path, via, req.at),
                            req.at,
                        );
                    }
                }
            }
        }
    }

    let state = trace
        .iter()
        .map(|s| s.state)
        .fold(DecisionState::Allow, DecisionState::max_severity);
    // The compartment clears no earlier than the LAST of its holds expires.
    let earliest_clear = trace.iter().filter_map(|s| s.earliest_clear).max();

    Decision {
        state,
        trace,
        earliest_clear,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coupling::{CouplingCode, CouplingEdge, Propagation};
    use wadl_domain::ids::CouplingTypeId;

    fn edge(from: &str, to: &str, code: &str, ty: u128) -> CouplingEdge {
        CouplingEdge {
            from: CompartmentNo::new(from),
            to: CompartmentNo::new(to),
            coupling_type: CouplingTypeId::from_uuid(uuid::Uuid::from_u128(ty)),
            code: CouplingCode::new(code),
            propagates: vec![Propagation::Vapour],
            max_reach: HopDepth::new(3),
        }
    }

    /// The prototype's "in service" coating cascade: a final coat curing in
    /// 3-160-2-Q. Vertical neighbours BLOCK, the bulkhead neighbour WARNs, and
    /// the shared exhaust trunk SUSPENDs.
    fn coating_world() -> (AdjacencyGraph, Vec<Hazard>) {
        let graph = AdjacencyGraph::new(vec![
            edge("3-160-2-Q", "2-160-2-Q", "deck_penetration", 1),
            edge("3-160-2-Q", "4-160-2-Q", "deck_penetration", 1),
            edge("3-160-2-Q", "3-156-2-Q", "shared_bulkhead", 2),
            edge("3-160-2-Q", "3-164-2-Q", "exhaust_trunk", 3),
            edge("3-164-2-Q", "4-164-2-Q", "exhaust_trunk", 3),
        ]);
        let hazards = vec![Hazard {
            origin: CompartmentNo::new("3-160-2-Q"),
            kind: HazardKind::CoatingOpen,
            since: Timestamp::from_epoch_millis(0),
            label: "CT-3160-4 · final coat, curing".to_owned(),
            ended: None,
        }];
        (graph, hazards)
    }

    fn decide(subject: &str) -> Decision {
        let (graph, hazards) = coating_world();
        let rules = RuleSet::seed_usn_hot_work();
        let subject = CompartmentNo::new(subject);
        evaluate(&EvaluationRequest {
            subject: &subject,
            graph: &graph,
            rules: &rules,
            hazards: &hazards,
            at: Timestamp::from_epoch_millis(0),
        })
    }

    #[test]
    fn deck_above_the_curing_coat_is_blocked() {
        let d = decide("2-160-2-Q");
        assert_eq!(d.state, DecisionState::Block);
        assert!(!d.permits_work());
        let s = d.trace.first().unwrap();
        assert_eq!(s.rule_code, "R03");
        assert_eq!(s.depth, HopDepth::new(1));
        assert_eq!(s.via, vec!["deck_penetration"]);
        // The eight-hour cure prices the earliest clear.
        assert_eq!(
            s.earliest_clear,
            Some(Timestamp::from_epoch_millis(480 * 60_000))
        );
    }

    #[test]
    fn deck_below_is_blocked_too_vapour_is_heavier_than_air() {
        assert_eq!(decide("4-160-2-Q").state, DecisionState::Block);
    }

    #[test]
    fn bulkhead_neighbour_warns_rather_than_blocks() {
        let d = decide("3-156-2-Q");
        assert_eq!(d.state, DecisionState::Warn);
        assert!(d.permits_work(), "work proceeds with the boundary posted");
        assert_eq!(d.trace.first().unwrap().rule_code, "R06");
    }

    #[test]
    fn shared_exhaust_trunk_suspends_and_reaches_two_hops() {
        // One hop along the trunk.
        assert_eq!(decide("3-164-2-Q").state, DecisionState::Suspend);
        // Two hops — the condition follows the air, not the deck plan.
        let far = decide("4-164-2-Q");
        assert_eq!(far.state, DecisionState::Suspend);
        assert_eq!(far.trace.first().unwrap().depth, HopDepth::new(2));
    }

    #[test]
    fn an_unrelated_compartment_is_allowed_with_an_empty_trace() {
        let d = decide("1-100-0-L");
        assert_eq!(d.state, DecisionState::Allow);
        assert!(d.trace.is_empty());
        assert_eq!(d.earliest_clear, None);
    }

    #[test]
    fn the_coated_space_itself_is_blocked_by_the_same_space_rule() {
        // The origin is never emitted as a *cascade hit* — but it is the
        // flammable-vapour space, so the same-space rule refuses work in it. A
        // cascade origin reading ALLOW would be the wrong answer in the most
        // dangerous space on the sheet.
        let d = decide("3-160-2-Q");
        assert_eq!(d.state, DecisionState::Block);
        let s = d.trace.first().unwrap();
        assert_eq!(s.depth, HopDepth::ZERO);
        assert!(s.via.is_empty(), "no coupling was traversed");
        assert_eq!(s.reason, "CT-3160-4 · final coat, curing in this space.");
    }

    #[test]
    fn stop_work_applies_to_the_same_space_only() {
        let (graph, _) = coating_world();
        let rules = RuleSet::seed_usn_hot_work();
        let hazards = vec![Hazard {
            origin: CompartmentNo::new("3-160-2-Q"),
            kind: HazardKind::StopWork,
            since: Timestamp::from_epoch_millis(0),
            label: "STOP WORK · Fire Marshal".to_owned(),
            ended: None,
        }];
        let here = CompartmentNo::new("3-160-2-Q");
        let next_door = CompartmentNo::new("2-160-2-Q");
        let at = Timestamp::from_epoch_millis(0);
        let in_space = evaluate(&EvaluationRequest {
            subject: &here,
            graph: &graph,
            rules: &rules,
            hazards: &hazards,
            at,
        });
        let adjacent = evaluate(&EvaluationRequest {
            subject: &next_door,
            graph: &graph,
            rules: &rules,
            hazards: &hazards,
            at,
        });
        assert_eq!(in_space.state, DecisionState::Suspend);
        assert_eq!(adjacent.state, DecisionState::Allow);
    }

    /// The eight-hour cure is priced from the hazard's `since`, so an evaluation
    /// after it has elapsed must not still block the deck above. Before this was
    /// wired the instant was ignored entirely and the demo hull showed a coat
    /// that had cured three months earlier as a live BLOCK.
    #[test]
    fn a_cure_that_has_elapsed_no_longer_holds_the_space() {
        let (graph, hazards) = coating_world();
        let rules = RuleSet::seed_usn_hot_work();
        let subject = CompartmentNo::new("2-160-2-Q");
        let decide_at = |ms: i64| {
            evaluate(&EvaluationRequest {
                subject: &subject,
                graph: &graph,
                rules: &rules,
                hazards: &hazards,
                at: Timestamp::from_epoch_millis(ms),
            })
        };
        let cure = 480 * 60_000;

        assert_eq!(
            decide_at(0).state,
            DecisionState::Block,
            "coat just applied"
        );
        assert_eq!(
            decide_at(cure - 1).state,
            DecisionState::Block,
            "one millisecond short of cured is still cured-not"
        );
        // Half-open: the space clears AT the instant the hold expires.
        let cleared = decide_at(cure);
        assert_eq!(cleared.state, DecisionState::Allow);
        assert!(cleared.trace.is_empty(), "an elapsed hold is not a reason");
        assert_eq!(cleared.earliest_clear, None);
    }

    /// The other half of the distinction: a hold gated on a verification does not
    /// discharge itself, however long the caller waits.
    #[test]
    fn a_verification_gated_hold_never_elapses() {
        let graph = AdjacencyGraph::new(vec![edge("3-148-2-E", "3-148-0-L", "shared_bulkhead", 2)]);
        let hazards = vec![Hazard {
            origin: CompartmentNo::new("3-148-2-E"),
            kind: HazardKind::EnergisedBus,
            since: Timestamp::from_epoch_millis(0),
            label: "Bus 3-SG-2 energised".to_owned(),
            ended: None,
        }];
        let rules = RuleSet::seed_usn_hot_work();
        let subject = CompartmentNo::new("3-148-2-E");
        let ten_years = 10 * 365 * 24 * 3_600_000;
        let d = evaluate(&EvaluationRequest {
            subject: &subject,
            graph: &graph,
            rules: &rules,
            hazards: &hazards,
            at: Timestamp::from_epoch_millis(ten_years),
        });
        assert_ne!(d.state, DecisionState::Allow, "still unisolated");
        assert!(
            d.trace.iter().all(|s| s.earliest_clear.is_none()),
            "nothing here is priced on a clock"
        );
    }

    /// Asking for an instant before the coat was applied must not report the
    /// space as held — otherwise a schedule of future hazards reads as a hull
    /// that is already shut.
    #[test]
    fn a_hazard_not_yet_raised_holds_nothing() {
        let (graph, hazards) = coating_world();
        let rules = RuleSet::seed_usn_hot_work();
        let subject = CompartmentNo::new("2-160-2-Q");
        let d = evaluate(&EvaluationRequest {
            subject: &subject,
            graph: &graph,
            rules: &rules,
            hazards: &hazards,
            at: Timestamp::from_epoch_millis(-1),
        });
        assert_eq!(d.state, DecisionState::Allow);
        assert!(d.trace.is_empty());
    }

    #[test]
    fn the_governing_state_is_the_most_severe_across_two_hazards() {
        // A curing coat next door (WARN via bulkhead) plus a stop-work in the
        // subject space (SUSPEND) governs as SUSPEND, and both lines are kept.
        let (graph, mut hazards) = coating_world();
        hazards.push(Hazard {
            origin: CompartmentNo::new("3-156-2-Q"),
            kind: HazardKind::StopWork,
            since: Timestamp::from_epoch_millis(0),
            label: "STOP WORK · QA".to_owned(),
            ended: None,
        });
        let rules = RuleSet::seed_usn_hot_work();
        let subject = CompartmentNo::new("3-156-2-Q");
        let d = evaluate(&EvaluationRequest {
            subject: &subject,
            graph: &graph,
            rules: &rules,
            hazards: &hazards,
            at: Timestamp::from_epoch_millis(0),
        });
        assert_eq!(d.state, DecisionState::Suspend);
        assert_eq!(
            d.trace.len(),
            2,
            "both the WARN and the SUSPEND are recorded"
        );
    }

    /// Hot work on 2-160-2-Q (permit raised at T), the deck below it the
    /// subject; R04 is the seed's end-anchored row.
    fn hot_work_world(ended_min: Option<i64>) -> (AdjacencyGraph, Vec<Hazard>) {
        let graph =
            AdjacencyGraph::new(vec![edge("2-160-2-Q", "3-160-2-Q", "deck_penetration", 1)]);
        let hazards = vec![Hazard {
            origin: CompartmentNo::new("2-160-2-Q"),
            kind: HazardKind::HotWorkLive,
            since: Timestamp::from_epoch_millis(0),
            label: "HW permit 2673 · weld".to_owned(),
            ended: ended_min.map(|m| Timestamp::from_epoch_millis(m * 60_000)),
        }];
        (graph, hazards)
    }

    fn decide_below(ended_min: Option<i64>, at_min: i64) -> Decision {
        let (graph, hazards) = hot_work_world(ended_min);
        let rules = RuleSet::seed_usn_hot_work();
        let subject = CompartmentNo::new("3-160-2-Q");
        evaluate(&EvaluationRequest {
            subject: &subject,
            graph: &graph,
            rules: &rules,
            hazards: &hazards,
            at: Timestamp::from_epoch_millis(at_min * 60_000),
        })
    }

    #[test]
    fn an_end_anchored_hold_never_elapses_while_the_permit_is_open() {
        // Forty-five minutes in — past the thirty the raise-anchored reading
        // priced — the torch may still be lit, so the deck below is suspended
        // with no clock and the sentence says when the clock will start.
        let d = decide_below(None, 45);
        assert_eq!(d.state, DecisionState::Suspend);
        assert_eq!(d.earliest_clear, None, "clears on verification");
        let s = d.trace.first().unwrap();
        assert_eq!(s.rule_code, "R04");
        assert_eq!(s.clearing_authority, "fire_marshal");
        assert_eq!(
            s.reason,
            "HW permit 2673 · weld in 2-160-2-Q — reached via deck_penetration (1 hop); \
             fire watch of 30 min starts when the permit closes."
        );
        // Ten years on, still open, still suspended.
        assert_eq!(
            decide_below(None, 10 * 365 * 24 * 60).state,
            DecisionState::Suspend
        );
    }

    #[test]
    fn an_end_anchored_hold_runs_from_the_close_and_drops_at_close_plus_hold() {
        // Permit closed at +60: at +70 the watch is running and prices +90.
        let running = decide_below(Some(60), 70);
        assert_eq!(running.state, DecisionState::Suspend);
        assert_eq!(
            running.earliest_clear,
            Some(Timestamp::from_epoch_millis(90 * 60_000))
        );
        assert_eq!(
            running.trace.first().unwrap().reason,
            "HW permit 2673 · weld in 2-160-2-Q — reached via deck_penetration (1 hop); \
             permit closed, fire watch of 30 min running."
        );
        // Half-open: the space clears AT +90.
        assert_eq!(decide_below(Some(60), 89).state, DecisionState::Suspend);
        let cleared = decide_below(Some(60), 90);
        assert_eq!(cleared.state, DecisionState::Allow);
        assert!(cleared.trace.is_empty());
    }

    #[test]
    fn a_clearance_later_than_the_instant_has_not_happened_yet() {
        // Closed at +60, read at +50: from that instant's point of view the
        // permit is still open — no clock, the sentence says so. Time-honest.
        let d = decide_below(Some(60), 50);
        assert_eq!(d.state, DecisionState::Suspend);
        assert_eq!(d.earliest_clear, None);
        assert!(d
            .trace
            .first()
            .unwrap()
            .reason
            .ends_with("starts when the permit closes."));
    }

    #[test]
    fn a_raise_anchored_row_ignores_a_hazard_ended_by_the_instant() {
        // A coat cleared by its marine chemist at +60 (re-tested early). The
        // raise-anchored R03 stops holding the deck above at +60, not at the
        // eight-hour cure — the clearance ended the fact.
        let (graph, mut hazards) = coating_world();
        hazards[0].ended = Some(Timestamp::from_epoch_millis(60 * 60_000));
        let rules = RuleSet::seed_usn_hot_work();
        let subject = CompartmentNo::new("2-160-2-Q");
        let decide_at = |min: i64| {
            evaluate(&EvaluationRequest {
                subject: &subject,
                graph: &graph,
                rules: &rules,
                hazards: &hazards,
                at: Timestamp::from_epoch_millis(min * 60_000),
            })
        };
        assert_eq!(decide_at(59).state, DecisionState::Block);
        assert_eq!(decide_at(60).state, DecisionState::Allow);
        assert!(decide_at(60).trace.is_empty());
        // Before the clearance the trace is exactly what it was without it.
        assert_eq!(
            decide_at(0),
            decide("2-160-2-Q"),
            "an unended read is byte-identical to the pre-`ended` trace"
        );
    }
}
