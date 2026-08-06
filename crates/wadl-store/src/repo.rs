//! The repository seam.

use wadl_domain::ids::VesselId;

use crate::error::StoreError;
use crate::model::{CompartmentSummary, StrandedReport, VesselSummary, WorkOrderSummary};
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
}
