//! The tenant + RBAC scope carried on every request — and the person behind it.

use std::collections::BTreeSet;

use wadl_domain::ids::{OrgId, VesselId};

/// Where an [`Actor`] was resolved from. Served on `/api/whoami` as
/// `person.source` and stored beside nothing: the source is a property of the
/// hop, not of the ledger row, which records the id and the name only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ActorSource {
    /// Asserted by the yard's identity proxy (`x-wadl-person`).
    Proxy,
    /// Asserted by a dev-shim header — a demo person, not a login.
    DevShim,
    /// The dev shim with no person header at all: `dev:anonymous`.
    DevShimAnonymous,
    /// The binary itself (boot loaders, seeds) or a store caller that named
    /// nobody.
    System,
}

/// The person a request acts as. Hashed into every ledger row written under
/// the scope (chain format 2), so the id must be the proxy's **stable**
/// subject for the person; the name is display only and never decides
/// anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Actor {
    /// The stable subject: an EDIPI or badge from the proxy, `dev:…` on the
    /// shim, `system:…` for the binary.
    pub id: String,
    /// The display name; falls back to the id when none was asserted.
    pub name: String,
    /// Which hop asserted it.
    pub source: ActorSource,
}

impl Actor {
    /// An actor asserted by a header — the proxy's or the shim's.
    #[must_use]
    pub fn new(id: impl Into<String>, name: impl Into<String>, source: ActorSource) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            source,
        }
    }

    /// The binary acting on its own account — a boot loader, a seed, a CLI
    /// door. `what` names the path (`boot`, `import`); the id is
    /// `system:<what>` so a ledger reader can tell a person from a process.
    #[must_use]
    pub fn system(what: &str) -> Self {
        let id = format!("system:{what}");
        Self {
            name: id.clone(),
            id,
            source: ActorSource::System,
        }
    }

    /// The actor a scope carries when nobody named one — the honest default
    /// for store callers that predate people in the ledger. A row written
    /// under it still hashes an actor (`system:unattributed`), so the chain
    /// format never depends on whether a person was known.
    #[must_use]
    pub fn unattributed() -> Self {
        Self {
            id: "system:unattributed".to_owned(),
            name: "unattributed".to_owned(),
            source: ActorSource::System,
        }
    }
}

/// Who is asking, and what they may reach.
///
/// Every repository call takes one of these. It combines the two independent
/// gates the platform enforces, plus the person the request acts as:
///
/// * **Tenant** (`org`) — the row-level-security boundary. Mirrors the
///   `app.org_id` GUC the database policies read.
/// * **Assignment** (`assigned_vessels`) — the RBAC boundary. A person is
///   assigned per hull, so being in the right tenant is necessary but not
///   sufficient; the hull must also be one they are assigned to. This is why a
///   user assigned to three of five hulls cannot reach the other two.
/// * **Actor** (`actor`) — the person, written into every ledger row the
///   scope appends. Not a gate: capabilities are judged in the API's role
///   table, and the store records whoever the API resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TenantScope {
    /// The requesting organization.
    pub org: OrgId,
    /// The hulls this identity is assigned to within that organization.
    pub assigned_vessels: BTreeSet<VesselId>,
    /// The person (or process) acting under this scope.
    pub actor: Actor,
}

impl TenantScope {
    /// Builds a scope from a tenant and an assignment set, acting as
    /// [`Actor::unattributed`] until [`Self::with_actor`] names someone.
    #[must_use]
    pub fn new(org: OrgId, assigned_vessels: impl IntoIterator<Item = VesselId>) -> Self {
        Self {
            org,
            assigned_vessels: assigned_vessels.into_iter().collect(),
            actor: Actor::unattributed(),
        }
    }

    /// The same scope, acting as `actor`.
    #[must_use]
    pub fn with_actor(mut self, actor: Actor) -> Self {
        self.actor = actor;
        self
    }

    /// Whether this scope is assigned to the given hull.
    #[must_use]
    pub fn is_assigned(&self, vessel: VesselId) -> bool {
        self.assigned_vessels.contains(&vessel)
    }
}
