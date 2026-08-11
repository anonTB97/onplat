//! Strongly-typed identifiers.
//!
//! Every identifier is a distinct newtype over [`uuid::Uuid`] so the compiler
//! rejects passing a `VesselId` where a `PermitId` was meant. Primary keys are
//! UUIDv7 in the store layer (time-ordered for index locality); this crate only
//! wraps and moves them and never *mints* them, because minting a v7 needs a
//! clock and this crate stays time-free.

use core::fmt;
use core::str::FromStr;

/// Declares a UUID-backed identifier newtype with the standard trait set.
macro_rules! id_newtype {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(
            Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord,
            serde::Serialize, serde::Deserialize,
        )]
        #[serde(transparent)]
        pub struct $name(uuid::Uuid);

        impl $name {
            /// Wraps an existing UUID as this identifier.
            #[must_use]
            pub const fn from_uuid(id: uuid::Uuid) -> Self {
                Self(id)
            }

            /// Returns the underlying UUID.
            #[must_use]
            pub const fn as_uuid(self) -> uuid::Uuid {
                self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}", self.0)
            }
        }

        impl FromStr for $name {
            type Err = uuid::Error;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                uuid::Uuid::from_str(s).map(Self)
            }
        }

        impl From<uuid::Uuid> for $name {
            fn from(id: uuid::Uuid) -> Self {
                Self(id)
            }
        }
    };
}

id_newtype!(
    /// One scheduled activity — the grain P6 plans at and a foreman is handed.
    /// A work order is made of activities; the register lists them all.
    ActivityId
);

id_newtype!(
    /// Tenant. Every non-reference row is scoped to one organization.
    OrgId
);
id_newtype!(
    /// A person within a tenant.
    PersonId
);
id_newtype!(
    /// A tenant-configurable role with named capabilities.
    PersonaId
);
id_newtype!(
    /// A ship class — the template layer of the class/hull split.
    ClassId
);
id_newtype!(
    /// An individual hull — the truth layer of the class/hull split.
    VesselId
);
id_newtype!(
    /// An ordered deck level within a class.
    DeckId
);
id_newtype!(
    /// A docking or work period against a vessel.
    AvailabilityId
);
id_newtype!(
    /// A work order (WI/WO), which may span many compartments.
    WorkOrderId
);
id_newtype!(
    /// A segment of a distributed package, with upstream topology.
    SegmentId
);
id_newtype!(
    /// A tenant-configurable coupling type (shared bulkhead, deck penetration…).
    CouplingTypeId
);
id_newtype!(
    /// A rule — the code, not any one version of it.
    RuleId
);
id_newtype!(
    /// The versioned unit of truth for a rule. Every decision stores the
    /// `RuleVersionId` it was made under so a 2027 decision is explainable in
    /// 2031 after the rule has changed twice.
    RuleVersionId
);
id_newtype!(
    /// A permit — one authorization object covering N compartments.
    PermitId
);
id_newtype!(
    /// A single recorded evaluation in the decision ledger.
    DecisionId
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_string() {
        let id = VesselId::from_uuid(uuid::Uuid::nil());
        let parsed: VesselId = id.to_string().parse().unwrap();
        assert_eq!(id, parsed);
    }

    #[test]
    fn distinct_types_do_not_unify() {
        // This is a documentation test of intent: `VesselId` and `PermitId`
        // wrap the same UUID but are different types, so a mix-up cannot
        // type-check. We assert the underlying values can still be compared
        // once deliberately unwrapped.
        let raw = uuid::Uuid::nil();
        assert_eq!(
            VesselId::from_uuid(raw).as_uuid(),
            PermitId::from_uuid(raw).as_uuid()
        );
    }
}
