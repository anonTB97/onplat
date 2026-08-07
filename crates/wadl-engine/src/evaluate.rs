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

use wadl_domain::compartment::CompartmentNo;
use wadl_domain::ids::RuleVersionId;
use wadl_domain::time::Timestamp;
use wadl_domain::units::HopDepth;

use crate::coupling::AdjacencyGraph;
use crate::decision::DecisionState;
use crate::rules::{Applies, RuleEntry, RuleSet};
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

/// Builds the trace step for a rule that fired, at `depth`, along `via`.
fn step(
    entry: &RuleEntry,
    hazard: &Hazard,
    depth: HopDepth,
    path: Vec<CompartmentNo>,
    via: Vec<String>,
) -> TraceStep {
    let earliest_clear = entry.hold.map(|hold| hazard.since.plus_minutes(hold));
    let reason = if depth == HopDepth::ZERO {
        format!("{} in this space.", hazard.label)
    } else {
        format!(
            "{} in {} — reached via {} ({} hop{}).",
            hazard.label,
            hazard.origin,
            via.join(" → "),
            depth.get(),
            if depth.get() == 1 { "" } else { "s" }
        )
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

/// Evaluates the authorization state of `req.subject` under `req.rules`.
///
/// With no rule firing the state is [`DecisionState::Allow`] and the trace is
/// empty — an explicit "nothing applies here", not an absence of information.
#[must_use]
pub fn evaluate(req: &EvaluationRequest<'_>) -> Decision {
    let mut trace = Vec::new();

    for hazard in req.hazards {
        for entry in req.rules.for_hazard(hazard.kind) {
            match &entry.applies {
                Applies::SameSpace => {
                    if &hazard.origin == req.subject {
                        trace.push(step(
                            entry,
                            hazard,
                            HopDepth::ZERO,
                            vec![hazard.origin.clone()],
                            Vec::new(),
                        ));
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
                        trace.push(step(entry, hazard, hit.depth, path, via));
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
}
