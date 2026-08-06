//! The repository seam.

use wadl_domain::ids::VesselId;
use wadl_engine::{AdjacencyGraph, Hazard, RuleSet};

use crate::error::StoreError;
use crate::model::{
    CompartmentSummary, DeckSummary, StrandedReport, VesselSummary, WorkOrderSummary,
};
use crate::scope::TenantScope;

/// Everything the shell and API read from storage, always through a
/// [`TenantScope`]. Implementations MUST apply the scope's tenant and
/// assignment gates to every method; the in-memory implementation does so in
/// code, and the PostgreSQL implementation will do so via row-level security
/// plus an assignment filter.
///
/// Synchronous by design in milestone 1: the working implementation is
/// in-memory, and keeping the trait object-safe without a boxed-future dance
/// keeps the API and the leak test simple. The async PostgreSQL repositories
/// wrap this shape when they land.
pub trait Repositories: Send + Sync {
    /// The hulls visible to `scope`: in-tenant AND assigned.
    fn list_vessels(&self, scope: &TenantScope) -> Vec<VesselSummary>;

    /// One hull, or [`StoreError::NotFound`] if it is out of tenant or not
    /// assigned. A hull in another tenant is `NotFound`, never "forbidden".
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    fn get_vessel(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<VesselSummary, StoreError>;

    /// The compartment register for a hull.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    fn list_compartments(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Vec<CompartmentSummary>, StoreError>;

    /// The work orders on a hull, each with provenance.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    fn list_work_orders(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Vec<WorkOrderSummary>, StoreError>;

    /// The stranded man-hours on a hull.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    fn stranded_hours(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<StrandedReport, StoreError>;

    /// The hull's decks, ordered (ascending downward), so "the space directly
    /// above" is computable by the caller rather than guessed from a label.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    fn list_decks(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Vec<DeckSummary>, StoreError>;

    /// The hull's resolved adjacency graph — the class template with per-hull
    /// overrides applied. Input to the engine; the engine never loads it itself.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    fn adjacency_graph(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<AdjacencyGraph, StoreError>;

    /// The hazards currently live on the hull — open coating tickets, live hot
    /// work, unisolated buses, stop-works.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    fn live_hazards(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Vec<Hazard>, StoreError>;

    /// The rules in force for the hull at the evaluation instant. Rules are
    /// versioned data (ADR 0002); the engine is handed them, never hard-codes
    /// them.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    fn rules_in_force(&self, scope: &TenantScope, vessel: VesselId) -> Result<RuleSet, StoreError>;
}
