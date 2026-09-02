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

use crate::coupling::{AdjacencyGraph, CouplingCode, CouplingEdge};

/// The limits a rule places on a traversal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TraversalBound {
    /// The maximum hop depth the hazard may reach.
    pub max_hops: HopDepth,
    /// If set, only couplings of this type code are walked — mirroring
    /// `rule_version.coupling_type_id`, since a rule binds to a *kind* of
    /// coupling (a coating cascade follows ventilation, not load paths).
    /// `None` walks every coupling.
    pub code: Option<CouplingCode>,
}

impl TraversalBound {
    /// A bound of `max_hops` over couplings of type `code`.
    #[must_use]
    pub const fn new(max_hops: HopDepth, code: Option<CouplingCode>) -> Self {
        Self { max_hops, code }
    }

    /// A bound of `max_hops` over every coupling type.
    #[must_use]
    pub const fn any(max_hops: HopDepth) -> Self {
        Self {
            max_hops,
            code: None,
        }
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
            if let Some(required) = bound.code.as_ref() {
                if &edge.code != required {
                    continue;
                }
            }
            // The origin is where the hazard IS; it is never something the
            // hazard reaches. A symmetric coupling is stored as two directed
            // rows, so without this the walk comes home at depth 2 and the
            // hazard's own space gains a spurious "reached via" line.
            if edge.to == *origin {
                continue;
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
    use crate::coupling::Propagation;
    use proptest::prelude::*;

    fn edge(from: &str, to: &str, ty: u128, reach: u8) -> CouplingEdge {
        CouplingEdge {
            from: CompartmentNo::new(from),
            to: CompartmentNo::new(to),
            coupling_type: CouplingTypeId::from_uuid(uuid::Uuid::from_u128(ty)),
            code: CouplingCode::new(format!("type{ty}")),
            propagates: vec![Propagation::Heat],
            max_reach: HopDepth::new(reach),
        }
    }

    fn bound(hops: u8) -> TraversalBound {
        TraversalBound::any(HopDepth::new(hops))
    }

    #[test]
    fn only_the_bound_coupling_code_is_walked() {
        // A is coupled to B by type1 and to C by type2. A rule bound to type1
        // must reach B and not C — a coating cascade follows ventilation, not
        // every coupling that happens to exist.
        let g = AdjacencyGraph::new(vec![edge("A", "B", 1, 3), edge("A", "C", 2, 3)]);
        let only_type1 = TraversalBound::new(HopDepth::new(3), Some(CouplingCode::new("type1")));
        let reached =
            affected_compartments(&cascade_from(&g, &CompartmentNo::new("A"), &only_type1));
        assert_eq!(reached, vec![CompartmentNo::new("B")]);
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
    fn a_symmetric_edge_never_walks_home_to_the_origin() {
        // A <-> B stored as two directed rows (the symmetric convention) and
        // a bound of two hops. Before the origin guard this returned A at
        // depth 2, and evaluate() then gave the hazard's own space a cascade
        // line claiming it had been reached via itself.
        let g = AdjacencyGraph::new(vec![edge("A", "B", 1, 3), edge("B", "A", 1, 3)]);
        let hits = cascade_from(&g, &CompartmentNo::new("A"), &bound(2));
        assert_eq!(affected_compartments(&hits), vec![CompartmentNo::new("B")]);
        assert!(hits
            .iter()
            .all(|h| h.compartment != CompartmentNo::new("A")));
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

        // The origin is never emitted as a hit, whatever the graph's shape —
        // the invariant the doc comment states, now enforced.
        #[test]
        fn origin_is_never_a_hit(
            edges in prop::collection::vec((0u8..6, 0u8..6, 1u128..4), 0..40),
            max_hops in 0u8..6,
        ) {
            let g = AdjacencyGraph::new(
                edges.iter()
                    .map(|&(f, t, ty)| edge(&format!("C{f}"), &format!("C{t}"), ty, 5))
                    .collect(),
            );
            let origin = CompartmentNo::new("C0");
            for hit in cascade_from(&g, &origin, &bound(max_hops)) {
                prop_assert_ne!(hit.compartment, origin.clone());
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
