//! The tenant + RBAC scope carried on every request.

use std::collections::BTreeSet;

use wadl_domain::ids::{OrgId, VesselId};

/// Who is asking, and what they may reach.
///
/// Every repository call takes one of these. It combines the two independent
/// gates the platform enforces:
///
/// * **Tenant** (`org`) — the row-level-security boundary. Mirrors the
///   `app.org_id` GUC the database policies read.
/// * **Assignment** (`assigned_vessels`) — the RBAC boundary. A person is
///   assigned per hull, so being in the right tenant is necessary but not
///   sufficient; the hull must also be one they are assigned to. This is why a
///   user assigned to three of five hulls cannot reach the other two.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TenantScope {
    /// The requesting organization.
    pub org: OrgId,
    /// The hulls this identity is assigned to within that organization.
    pub assigned_vessels: BTreeSet<VesselId>,
}

impl TenantScope {
    /// Builds a scope from a tenant and an assignment set.
    #[must_use]
    pub fn new(org: OrgId, assigned_vessels: impl IntoIterator<Item = VesselId>) -> Self {
        Self {
            org,
            assigned_vessels: assigned_vessels.into_iter().collect(),
        }
    }

    /// Whether this scope is assigned to the given hull.
    #[must_use]
    pub fn is_assigned(&self, vessel: VesselId) -> bool {
        self.assigned_vessels.contains(&vessel)
    }
}
