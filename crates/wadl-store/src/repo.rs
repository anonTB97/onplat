//! The repository seam.

use wadl_domain::ids::VesselId;
use wadl_engine::{AdjacencyGraph, Hazard, RuleSet};
use wadl_plan::Package;

use crate::error::StoreError;
use crate::model::{
    AuditRecord, CompartmentSummary, DeckSummary, PackageSummary, StrandedReport, VesselSummary,
    WorkOrderSummary,
};
use crate::scope::TenantScope;

/// Everything the shell and API read from storage, always through a
/// [`TenantScope`]. Implementations MUST apply the scope's tenant and
/// assignment gates to every method; the in-memory implementation does so in
/// code, and the PostgreSQL implementation will do so via row-level security
/// plus an assignment filter.
///
/// Async because the real implementation talks to PostgreSQL. `#[async_trait]`
/// rather than native `async fn` in a trait: the API holds an
/// `Arc<dyn Repositories>`, and a native async fn in a trait is not
/// object-safe, so the futures have to be boxed either way.
#[async_trait::async_trait]
pub trait Repositories: Send + Sync {
    /// The hulls visible to `scope`: in-tenant AND assigned.
    async fn list_vessels(&self, scope: &TenantScope) -> Vec<VesselSummary>;

    /// One hull, or [`StoreError::NotFound`] if it is out of tenant or not
    /// assigned. A hull in another tenant is `NotFound`, never "forbidden".
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn get_vessel(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<VesselSummary, StoreError>;

    /// The compartment register for a hull.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn list_compartments(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Vec<CompartmentSummary>, StoreError>;

    /// The work orders on a hull, each with provenance.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn list_work_orders(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Vec<WorkOrderSummary>, StoreError>;

    /// The stranded man-hours on a hull.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn stranded_hours(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<StrandedReport, StoreError>;

    /// The hull's decks, ordered (ascending downward), so "the space directly
    /// above" is computable by the caller rather than guessed from a label.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn list_decks(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Vec<DeckSummary>, StoreError>;

    /// The hull's resolved adjacency graph — the class template with per-hull
    /// overrides applied. Input to the engine; the engine never loads it itself.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn adjacency_graph(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<AdjacencyGraph, StoreError>;

    /// The hazards currently live on the hull — open coating tickets, live hot
    /// work, unisolated buses, stop-works.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn live_hazards(
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
    async fn rules_in_force(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<RuleSet, StoreError>;

    /// The distributed packages on a hull.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn list_packages(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Vec<PackageSummary>, StoreError>;

    /// Appends an entry to the hull's audit ledger, chained to the last one.
    ///
    /// `occurred_at_ms` is supplied by the caller rather than read here, because
    /// the store has no clock — the one door for wall-clock time is the injected
    /// [`wadl_domain::Clock`], and the API holds it.
    ///
    /// `detail` is hashed, so it is the record. `subject_ref` is an unhashed
    /// lookup key.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn append_audit(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
        action: &str,
        detail: &str,
        subject_ref: Option<&str>,
        occurred_at_ms: i64,
    ) -> Result<AuditRecord, StoreError>;

    /// The hull's audit entries, newest first, optionally narrowed to one subject.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn list_audit(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
        subject_ref: Option<&str>,
    ) -> Result<Vec<AuditRecord>, StoreError>;

    /// One package with its full segment topology and per-compartment work,
    /// ready to hand to [`wadl_plan`] for analysis.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`, or no package
    /// on it carries `code`.
    async fn get_package(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
        code: &str,
    ) -> Result<Package, StoreError>;
}
