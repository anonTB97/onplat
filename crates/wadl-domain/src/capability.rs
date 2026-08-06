//! Named capabilities.
//!
//! Authority in this domain is a *set of named capabilities*, never a numeric
//! "access level". A number cannot express "may stop work anywhere but may not
//! approve a permit"; a named set can. Personas are tenant-configurable, so the
//! set attached to a persona is data — but the vocabulary of capability names
//! is fixed here so the authorization layer can match on it exhaustively.

use core::fmt;

/// A single named capability, as stored in `persona_capability.capability`.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    /// Raise a permit request.
    RaisePermit,
    /// Approve at the group-foreman node.
    ApproveGf,
    /// Approve at the foreman/fire-marshal node.
    ApproveFm,
    /// Set the priority of work.
    SetPriority,
    /// Designate a space, inserting the Fire Marshal into the path.
    DesignateSpace,
    /// Stop work — available broadly, deliberately separate from approval.
    StopWork,
    /// Disposition an inspection hold point.
    DispositionHoldPoint,
    /// Provide the second attestation on a disposition or secure-space sign-off.
    SecondAttest,
    /// Administer users within the tenant.
    AdminUsers,
    /// Read-only access.
    ReadOnly,
}

impl Capability {
    /// The wire/DB token for this capability (snake_case).
    #[must_use]
    pub const fn as_token(self) -> &'static str {
        match self {
            Self::RaisePermit => "raise_permit",
            Self::ApproveGf => "approve_gf",
            Self::ApproveFm => "approve_fm",
            Self::SetPriority => "set_priority",
            Self::DesignateSpace => "designate_space",
            Self::StopWork => "stop_work",
            Self::DispositionHoldPoint => "disposition_hold_point",
            Self::SecondAttest => "second_attest",
            Self::AdminUsers => "admin_users",
            Self::ReadOnly => "read_only",
        }
    }

    /// Parses a DB token into a capability, returning `None` for an unknown
    /// token so an unrecognised capability is a caller decision, not a panic.
    #[must_use]
    pub fn from_token(token: &str) -> Option<Self> {
        let cap = match token {
            "raise_permit" => Self::RaisePermit,
            "approve_gf" => Self::ApproveGf,
            "approve_fm" => Self::ApproveFm,
            "set_priority" => Self::SetPriority,
            "designate_space" => Self::DesignateSpace,
            "stop_work" => Self::StopWork,
            "disposition_hold_point" => Self::DispositionHoldPoint,
            "second_attest" => Self::SecondAttest,
            "admin_users" => Self::AdminUsers,
            "read_only" => Self::ReadOnly,
            _ => return None,
        };
        Some(cap)
    }
}

impl fmt::Display for Capability {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_token())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_round_trips() {
        for cap in [
            Capability::RaisePermit,
            Capability::StopWork,
            Capability::SecondAttest,
            Capability::ReadOnly,
        ] {
            assert_eq!(Capability::from_token(cap.as_token()), Some(cap));
        }
        assert_eq!(Capability::from_token("approve_everything"), None);
    }
}
