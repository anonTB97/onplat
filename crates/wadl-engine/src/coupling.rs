//! The adjacency model — the semantics of "coupled", not the geometry.
//!
//! What counts as coupled is a safety judgement (a shared bulkhead, a deck
//! penetration, a shared ventilation branch), so coupling *types* are data. The
//! engine consumes a flat, directed [`AdjacencyGraph`]: symmetric couplings are
//! present as two directed edges, and each edge already carries the properties
//! the traversal needs (direction, hop reach) denormalised from the coupling
//! type, so the traversal never has to remember which way a row was stored.

use wadl_domain::compartment::CompartmentNo;
use wadl_domain::ids::CouplingTypeId;
use wadl_domain::units::HopDepth;

/// What a coupling can carry between spaces. A single coupling may propagate
/// several of these at once (a deck penetration carries heat *and* is an egress
/// path).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Propagation {
    /// Radiant or conducted heat.
    Heat,
    /// Flammable or toxic vapour.
    Vapour,
    /// Electrical energy.
    Energy,
    /// Structural load path.
    Load,
    /// Egress / access path.
    Egress,
}

/// Whether a coupling carries in one direction or both.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    /// The hazard flows only from `from` to `to` (e.g. a deck penetration
    /// carries heat downward; ventilation flows source→sink).
    Directional,
    /// The hazard flows both ways (a shared bulkhead has no preferred sense);
    /// such a coupling is represented as two [`Directional`](Self::Directional)
    /// edges so the traversal only ever walks `from → to`.
    Symmetric,
}

/// One directed coupling edge, ready for traversal.
///
/// Direction is baked in as `from → to`: a symmetric coupling contributes two
/// edges. `max_reach` is the hop budget this coupling type allows, copied from
/// the coupling type so the traversal input is self-describing.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct CouplingEdge {
    /// Source compartment (where the hazard is).
    pub from: CompartmentNo,
    /// Destination compartment (the coupled space).
    pub to: CompartmentNo,
    /// The coupling type this edge came from — part of the traversal's visited
    /// key, so a space may be reached again via a *different* coupling type.
    pub coupling_type: CouplingTypeId,
    /// The coupling type's stable code (`deck_penetration`, `shared_bulkhead`,
    /// `exhaust_trunk`, …). Carried alongside the id because rules bind to the
    /// *kind* of coupling, and a rule set authored as data must be matchable
    /// without a second lookup into the coupling-type table.
    pub code: CouplingCode,
    /// What this coupling carries.
    pub propagates: Vec<Propagation>,
    /// Hop budget for this coupling type.
    pub max_reach: HopDepth,
}

impl CouplingEdge {
    /// Whether this edge carries the given propagation kind.
    #[must_use]
    pub fn carries(&self, propagation: Propagation) -> bool {
        self.propagates.contains(&propagation)
    }
}

/// A coupling type's stable code, as stored in `coupling_type.code`.
///
/// A string newtype rather than an enum: coupling types are **tenant
/// configurable** (what counts as coupled is a safety judgement), so the engine
/// must not close the set. Rules match on this code.
#[derive(
    Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
#[serde(transparent)]
pub struct CouplingCode(String);

impl CouplingCode {
    /// Wraps a coupling-type code.
    #[must_use]
    pub fn new(code: impl Into<String>) -> Self {
        Self(code.into())
    }

    /// The code.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<&str> for CouplingCode {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

/// A directed adjacency graph for one hull, resolved from the class template
/// plus per-hull overrides. The engine treats this as immutable input.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AdjacencyGraph {
    edges: Vec<CouplingEdge>,
    /// Edge positions by source compartment, built on first use and never
    /// serialised: a traversal on a carrier-sized graph (hundreds of spaces,
    /// thousands of edges) walked from every live hazard for every space and
    /// every activity was scanning the whole edge list at every hop. The
    /// index makes a hop cost what a hop should — its own out-edges.
    #[serde(skip)]
    by_from: std::sync::OnceLock<std::collections::HashMap<CompartmentNo, Vec<usize>>>,
}

impl AdjacencyGraph {
    /// Builds a graph from directed edges.
    #[must_use]
    pub fn new(edges: Vec<CouplingEdge>) -> Self {
        Self {
            edges,
            by_from: std::sync::OnceLock::new(),
        }
    }

    fn index(&self) -> &std::collections::HashMap<CompartmentNo, Vec<usize>> {
        self.by_from.get_or_init(|| {
            let mut map: std::collections::HashMap<CompartmentNo, Vec<usize>> =
                std::collections::HashMap::new();
            for (i, e) in self.edges.iter().enumerate() {
                map.entry(e.from.clone()).or_default().push(i);
            }
            map
        })
    }

    /// All edges leaving `from`, in authored order.
    pub fn out_edges<'a>(
        &'a self,
        from: &'a CompartmentNo,
    ) -> impl Iterator<Item = &'a CouplingEdge> + 'a {
        self.index()
            .get(from)
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .filter_map(|&i| self.edges.get(i))
    }

    /// Total edge count.
    #[must_use]
    pub fn edge_count(&self) -> usize {
        self.edges.len()
    }

    /// Every edge, in authored order.
    ///
    /// Exposed so a caller can build a *variant* of this graph — the engine still
    /// treats what it is handed as immutable. `wadl_mitigate` uses it to model an
    /// engineering mitigation: blanking a duct or closing a penetration is the
    /// removal of a coupling, and the only honest way to price that is to rebuild
    /// the graph without it and evaluate for real.
    pub fn edges(&self) -> impl Iterator<Item = &CouplingEdge> {
        self.edges.iter()
    }
}
