//! The evaluation seam.
//!
//! [`evaluate`] is the one function the rest of the platform calls to learn a
//! compartment's authorization state. Milestone 1 keeps the rule *outcomes*
//! seeded — the mapping from a hazard kind to a [`DecisionState`] and a hop
//! bound is a hard-coded default here, standing in for the versioned rule data
//! that milestone 3 will look up — but the *structure* is real: the cascade is
//! the genuine [`crate::traversal`], every emitted [`TraceStep`] has a slot for
//! the `rule_version` that produced it, and the aggregate is the governing
//! (most severe) state. When the rule engine lands, the seeds become lookups;
//! nothing upstream changes.

use wadl_domain::compartment::CompartmentNo;
use wadl_domain::ids::RuleVersionId;
use wadl_domain::time::Timestamp;
use wadl_domain::units::HopDepth;

use crate::coupling::{AdjacencyGraph, Propagation};
use crate::decision::DecisionState;
use crate::traversal::{cascade_from, TraversalBound};

/// A hazard that is live somewhere in the space set under evaluation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hazard {
    /// The compartment the hazard originates in.
    pub origin: CompartmentNo,
    /// What kind of hazard it is.
    pub kind: HazardKind,
}

/// The hazard kinds milestone 1 recognises. Each maps to a seeded bound and
/// outcome below; in milestone 3 this mapping is rule data keyed by class,
/// work type and category.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HazardKind {
    /// An open coating/service ticket — a flammable-vapour source (R03/R06).
    CoatingOpen,
    /// Live hot work — a heat/ignition source (R04).
    HotWorkLive,
    /// An energised electrical bus not in a verified zero-energy state (R07).
    EnergisedBus,
    /// Flammable stow open in a coupled space (R13).
    FlammableStow,
    /// A stop-work recorded by an inspection authority (R22).
    StopWork,
}

impl HazardKind {
    /// The seeded traversal bound for this hazard. **Placeholder rule data:**
    /// replaced by a versioned `rule_version` lookup in milestone 3.
    fn seed_bound(self) -> TraversalBound {
        match self {
            Self::CoatingOpen => TraversalBound::new(HopDepth::new(1), Some(Propagation::Vapour)),
            Self::HotWorkLive => TraversalBound::new(HopDepth::new(1), Some(Propagation::Heat)),
            Self::EnergisedBus => TraversalBound::new(HopDepth::new(2), Some(Propagation::Energy)),
            Self::FlammableStow => TraversalBound::new(HopDepth::new(2), Some(Propagation::Vapour)),
            Self::StopWork => TraversalBound::new(HopDepth::ZERO, None),
        }
    }

    /// The seeded outcome for this hazard. **Placeholder rule data.**
    fn seed_state(self) -> DecisionState {
        match self {
            Self::CoatingOpen | Self::EnergisedBus | Self::FlammableStow => DecisionState::Block,
            Self::HotWorkLive | Self::StopWork => DecisionState::Suspend,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::CoatingOpen => "open coating ticket in a coupled space",
            Self::HotWorkLive => "live hot work overhead / coupled",
            Self::EnergisedBus => "energised bus in the work envelope",
            Self::FlammableStow => "flammable stow on a coupled ventilation branch",
            Self::StopWork => "stop-work recorded by an inspection authority",
        }
    }
}

/// Everything the engine needs to decide one compartment. Borrowed, not owned:
/// the engine holds nothing and mutates nothing.
#[derive(Debug, Clone, Copy)]
pub struct EvaluationRequest<'a> {
    /// The compartment being authorized.
    pub subject: &'a CompartmentNo,
    /// The hull's resolved adjacency graph.
    pub graph: &'a AdjacencyGraph,
    /// The hazards live across the space set.
    pub hazards: &'a [Hazard],
    /// The instant the decision is made at, supplied by the caller (the engine
    /// reads no clock).
    pub at: Timestamp,
}

/// One line of the decision trace — a single rule firing on the subject.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TraceStep {
    /// The rule version that produced this line, once rules are versioned data.
    /// `None` in milestone 1 (the outcome is seeded), but the slot is present
    /// so persistence and the field-app trace never need reshaping.
    pub rule_version: Option<RuleVersionId>,
    /// The outcome this line contributes.
    pub state: DecisionState,
    /// Where the hazard originated.
    pub source: CompartmentNo,
    /// How many hops from the source the subject sits.
    pub depth: HopDepth,
    /// The compartments traversed, source-first, ending at the subject.
    pub path: Vec<CompartmentNo>,
    /// Human-readable reason, rendered verbatim in the trace.
    pub reason: String,
}

/// The decision for one compartment: the governing state plus the full trace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    /// The governing (most severe) state across every line of the trace.
    pub state: DecisionState,
    /// Every rule that fired, in the order encountered.
    pub trace: Vec<TraceStep>,
    /// The earliest the subject could clear, once hold times are rule data.
    /// `None` in milestone 1.
    pub earliest_clear: Option<Timestamp>,
}

/// Evaluates the authorization state of `req.subject`.
///
/// For each live hazard, the cascade is walked under that hazard's bound; if the
/// subject is the hazard's own origin or is reached by the cascade, the hazard's
/// seeded outcome becomes a line of the trace. The returned [`Decision::state`]
/// is the governing state; with no firing hazard it is [`DecisionState::Allow`].
#[must_use]
pub fn evaluate(req: &EvaluationRequest<'_>) -> Decision {
    let mut trace = Vec::new();

    for hazard in req.hazards {
        if &hazard.origin == req.subject {
            trace.push(TraceStep {
                rule_version: None,
                state: hazard.kind.seed_state(),
                source: hazard.origin.clone(),
                depth: HopDepth::ZERO,
                path: vec![hazard.origin.clone()],
                reason: format!("Same-space: {}.", hazard.kind.label()),
            });
            continue;
        }

        let bound = hazard.kind.seed_bound();
        for hit in cascade_from(req.graph, &hazard.origin, &bound) {
            if &hit.compartment != req.subject {
                continue;
            }
            let mut path = vec![hazard.origin.clone()];
            path.extend(hit.path.iter().map(|edge| edge.to.clone()));
            trace.push(TraceStep {
                rule_version: None,
                state: hazard.kind.seed_state(),
                source: hazard.origin.clone(),
                depth: hit.depth,
                path,
                reason: format!("{} ({} hop).", hazard.kind.label(), hit.depth.get()),
            });
        }
    }

    let state = trace
        .iter()
        .map(|step| step.state)
        .fold(DecisionState::Allow, DecisionState::max_severity);

    Decision {
        state,
        trace,
        earliest_clear: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coupling::CouplingEdge;
    use wadl_domain::ids::CouplingTypeId;

    fn vapour_edge(from: &str, to: &str) -> CouplingEdge {
        CouplingEdge {
            from: CompartmentNo::new(from),
            to: CompartmentNo::new(to),
            coupling_type: CouplingTypeId::from_uuid(uuid::Uuid::from_u128(1)),
            propagates: vec![Propagation::Vapour],
            max_reach: HopDepth::new(2),
        }
    }

    #[test]
    fn no_hazards_allows() {
        let graph = AdjacencyGraph::default();
        let subject = CompartmentNo::new("4-110-2-W");
        let req = EvaluationRequest {
            subject: &subject,
            graph: &graph,
            hazards: &[],
            at: Timestamp::from_epoch_millis(0),
        };
        let decision = evaluate(&req);
        assert_eq!(decision.state, DecisionState::Allow);
        assert!(decision.trace.is_empty());
    }

    #[test]
    fn coating_next_door_blocks_via_ventilation() {
        let graph = AdjacencyGraph::new(vec![vapour_edge("4-110-2-W", "4-114-2-W")]);
        let subject = CompartmentNo::new("4-114-2-W");
        let hazards = [Hazard {
            origin: CompartmentNo::new("4-110-2-W"),
            kind: HazardKind::CoatingOpen,
        }];
        let req = EvaluationRequest {
            subject: &subject,
            graph: &graph,
            hazards: &hazards,
            at: Timestamp::from_epoch_millis(0),
        };
        let decision = evaluate(&req);
        assert_eq!(decision.state, DecisionState::Block);
        assert_eq!(decision.trace.len(), 1);
        let step = decision.trace.first().unwrap();
        assert_eq!(step.depth, HopDepth::new(1));
        assert_eq!(
            step.path,
            vec![
                CompartmentNo::new("4-110-2-W"),
                CompartmentNo::new("4-114-2-W")
            ]
        );
    }

    #[test]
    fn hazard_out_of_reach_does_not_fire() {
        // Subject is two hops away but the coating bound is one hop.
        let graph = AdjacencyGraph::new(vec![vapour_edge("A", "B"), vapour_edge("B", "C")]);
        let subject = CompartmentNo::new("C");
        let hazards = [Hazard {
            origin: CompartmentNo::new("A"),
            kind: HazardKind::CoatingOpen,
        }];
        let req = EvaluationRequest {
            subject: &subject,
            graph: &graph,
            hazards: &hazards,
            at: Timestamp::from_epoch_millis(0),
        };
        assert_eq!(evaluate(&req).state, DecisionState::Allow);
    }
}
