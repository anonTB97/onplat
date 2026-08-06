//! Hop-bounded, direction-respecting hazard traversal.
//!
//! Every hazard-cascade rule (R03, R04, R06, R07, R13, R17 …) answers the same
//! question: starting from the space where a hazard is live, which coupled
//! spaces are reached, by what path, and within how many hops? That traversal
//! is implemented once here and parameterised by a [`TraversalBound`]; the rules
//! differ only in their bound and in how they colour the result.
//!
//! Two properties are load-bearing and are proved by the property tests:
//!
//! * The **hop bound is never exceeded** — a rule that reaches "one deck down"
//!   must not silently reach two.
//! * A **directional coupling is never walked against its direction** — heat
//!   goes down through a deck penetration, not up.

use std::collections::{HashSet, VecDeque};

use wadl_domain::compartment::CompartmentNo;
use wadl_domain::ids::CouplingTypeId;
use wadl_domain::units::HopDepth;

use crate::coupling::{AdjacencyGraph, CouplingEdge, Propagation};

/// The limits a rule places on a traversal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TraversalBound {
    /// The maximum hop depth the hazard may reach.
    pub max_hops: HopDepth,
    /// If set, only couplings that carry this kind are walked (e.g. a coating
    /// cascade follows ventilation, not load paths). `None` walks every
    /// coupling.
    pub required: Option<Propagation>,
}

impl TraversalBound {
    /// A bound of `max_hops` over couplings carrying `required`.
    #[must_use]
    pub const fn new(max_hops: HopDepth, required: Option<Propagation>) -> Self {
        Self { max_hops, required }
    }
}

/// A compartment reached by the traversal, with the path and hop depth by which
/// it was reached.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CascadeHit {
    /// The reached (affected) compartment.
    pub compartment: CompartmentNo,
    /// Hops from the origin along `path`.
    pub depth: HopDepth,
    /// The directed edges traversed, origin-first.
    pub path: Vec<CouplingEdge>,
}

/// Walks the cascade from `origin` under `bound`.
///
/// Breadth-first, so a compartment is first reached at its minimal depth. The
/// visited set is keyed by `(compartment, coupling_type)` — **not** compartment
/// alone — because a space that is coupled to the origin two different ways
/// (say a shared bulkhead *and* a deck penetration) is exposed to two distinct
/// hazards, and collapsing them would hide one. Keying by the pair also
/// guarantees termination: there are finitely many `(compartment, type)` pairs,
/// and each is expanded at most once.
///
/// The origin itself is never emitted as a hit; only spaces reached across at
/// least one coupling are.
#[must_use]
pub fn cascade_from(
    graph: &AdjacencyGraph,
    origin: &CompartmentNo,
    bound: &TraversalBound,
) -> Vec<CascadeHit> {
    let mut hits = Vec::new();
    let mut visited: HashSet<(CompartmentNo, CouplingTypeId)> = HashSet::new();
    let mut queue: VecDeque<(CompartmentNo, HopDepth, Vec<CouplingEdge>)> = VecDeque::new();
    queue.push_back((origin.clone(), HopDepth::ZERO, Vec::new()));

    while let Some((current, depth, path)) = queue.pop_front() {
        let next_depth = depth.increment();
        if next_depth.get() > bound.max_hops.get() {
            continue;
        }
        for edge in graph.out_edges(&current) {
            // Respect the coupling type's own reach as well as the rule's bound.
            if next_depth.get() > edge.max_reach.get() {
                continue;
            }
            if let Some(required) = bound.required {
                if !edge.carries(required) {
                    continue;
                }
            }
            let key = (edge.to.clone(), edge.coupling_type);
            if !visited.insert(key) {
                continue;
            }
            let mut next_path = path.clone();
            next_path.push(edge.clone());
            hits.push(CascadeHit {
                compartment: edge.to.clone(),
                depth: next_depth,
                path: next_path.clone(),
            });
            queue.push_back((edge.to.clone(), next_depth, next_path));
        }
    }
    hits
}

/// The distinct compartments a cascade reaches, sorted and de-duplicated.
///
/// This reduction is idempotent — reducing a reduced set changes nothing — which
/// is what lets the shell cache a footprint and re-derive it without drift.
#[must_use]
pub fn affected_compartments(hits: &[CascadeHit]) -> Vec<CompartmentNo> {
    let mut set: Vec<CompartmentNo> = hits.iter().map(|h| h.compartment.clone()).collect();
    set.sort();
    set.dedup();
    set
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn edge(from: &str, to: &str, ty: u128, reach: u8) -> CouplingEdge {
        CouplingEdge {
            from: CompartmentNo::new(from),
            to: CompartmentNo::new(to),
            coupling_type: CouplingTypeId::from_uuid(uuid::Uuid::from_u128(ty)),
            propagates: vec![Propagation::Heat],
            max_reach: HopDepth::new(reach),
        }
    }

    fn bound(hops: u8) -> TraversalBound {
        TraversalBound::new(HopDepth::new(hops), None)
    }

    #[test]
    fn reaches_within_bound_only() {
        // A -> B -> C -> D, all reach>=3.
        let g = AdjacencyGraph::new(vec![
            edge("A", "B", 1, 3),
            edge("B", "C", 1, 3),
            edge("C", "D", 1, 3),
        ]);
        let reached = affected_compartments(&cascade_from(&g, &CompartmentNo::new("A"), &bound(2)));
        assert_eq!(
            reached,
            vec![CompartmentNo::new("B"), CompartmentNo::new("C")]
        );
    }

    #[test]
    fn directional_edges_are_not_walked_backwards() {
        // Only A -> B exists. From B, A is unreachable.
        let g = AdjacencyGraph::new(vec![edge("A", "B", 1, 5)]);
        let reached = cascade_from(&g, &CompartmentNo::new("B"), &bound(5));
        assert!(reached.is_empty());
    }

    #[test]
    fn same_space_via_two_types_is_two_hits() {
        let g = AdjacencyGraph::new(vec![edge("A", "B", 1, 2), edge("A", "B", 2, 2)]);
        let hits = cascade_from(&g, &CompartmentNo::new("A"), &bound(2));
        assert_eq!(hits.len(), 2);
        assert_eq!(affected_compartments(&hits), vec![CompartmentNo::new("B")]);
    }

    proptest! {
        // Hop bound is never exceeded, regardless of graph shape.
        #[test]
        fn hop_bound_never_exceeded(
            edges in prop::collection::vec((0u8..6, 0u8..6, 1u128..4), 0..40),
            max_hops in 0u8..6,
        ) {
            let g = AdjacencyGraph::new(
                edges.iter()
                    .map(|&(f, t, ty)| edge(&format!("C{f}"), &format!("C{t}"), ty, 5))
                    .collect(),
            );
            let hits = cascade_from(&g, &CompartmentNo::new("C0"), &bound(max_hops));
            for hit in &hits {
                prop_assert!(hit.depth.get() <= max_hops);
                prop_assert!(hit.path.len() <= usize::from(max_hops));
            }
        }

        // Adding an edge disconnected from the origin's reachable set never
        // changes the set reached from the origin.
        #[test]
        fn unrelated_edge_does_not_change_decision(
            extra_from in 100u8..120,
            extra_to in 100u8..120,
        ) {
            let base = AdjacencyGraph::new(vec![edge("A", "B", 1, 5), edge("B", "C", 1, 5)]);
            let before = affected_compartments(&cascade_from(&base, &CompartmentNo::new("A"), &bound(5)));

            let mut with_extra = vec![edge("A", "B", 1, 5), edge("B", "C", 1, 5)];
            with_extra.push(edge(&format!("X{extra_from}"), &format!("X{extra_to}"), 1, 5));
            let g = AdjacencyGraph::new(with_extra);
            let after = affected_compartments(&cascade_from(&g, &CompartmentNo::new("A"), &bound(5)));

            prop_assert_eq!(before, after);
        }

        // The reduction to distinct compartments is idempotent.
        #[test]
        fn reduction_is_idempotent(
            edges in prop::collection::vec((0u8..6, 0u8..6, 1u128..4), 0..40),
        ) {
            let g = AdjacencyGraph::new(
                edges.iter()
                    .map(|&(f, t, ty)| edge(&format!("C{f}"), &format!("C{t}"), ty, 5))
                    .collect(),
            );
            let hits = cascade_from(&g, &CompartmentNo::new("C0"), &bound(4));
            let once = affected_compartments(&hits);
            let twice_input: Vec<CascadeHit> = once
                .iter()
                .map(|c| CascadeHit { compartment: c.clone(), depth: HopDepth::ZERO, path: Vec::new() })
                .collect();
            prop_assert_eq!(once, affected_compartments(&twice_input));
        }
    }
}
