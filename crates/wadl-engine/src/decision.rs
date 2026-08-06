//! The decision state a rule can produce.

use core::fmt;

/// The outcome of evaluating a rule (or the aggregate over several).
///
/// Mirrors the `decision_state` SQL enum exactly. Modelled as an enum, never a
/// string, so an impossible state cannot be persisted and a `match` over
/// outcomes is exhaustive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum DecisionState {
    /// The work may proceed with no restriction from this rule.
    Allow,
    /// Proceed, but a condition is flagged; some work classes may be limited.
    Warn,
    /// The work may not start until the underlying condition clears.
    Block,
    /// Live work is stopped until the underlying condition clears and a
    /// re-check passes (never a replay of the prior grant).
    Suspend,
}

impl DecisionState {
    /// Severity used only to pick the governing state when several rules fire
    /// on one space. Higher wins. This is an *aggregation* order for display
    /// and roll-up; it is not a claim that a BLOCK is operationally worse than
    /// a SUSPEND. A BLOCK outranks a SUSPEND here because a space that cannot
    /// start work should not present as merely "stopped".
    #[must_use]
    pub const fn severity(self) -> u8 {
        match self {
            Self::Allow => 0,
            Self::Warn => 1,
            Self::Suspend => 2,
            Self::Block => 3,
        }
    }

    /// The governing state over two outcomes: the more severe one.
    #[must_use]
    pub fn max_severity(self, other: Self) -> Self {
        if other.severity() > self.severity() {
            other
        } else {
            self
        }
    }

    /// Whether this state permits work to start or continue.
    #[must_use]
    pub const fn permits_work(self) -> bool {
        matches!(self, Self::Allow | Self::Warn)
    }
}

impl fmt::Display for DecisionState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Self::Allow => "ALLOW",
            Self::Warn => "WARN",
            Self::Block => "BLOCK",
            Self::Suspend => "SUSPEND",
        };
        f.write_str(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn block_governs_over_warn() {
        assert_eq!(
            DecisionState::Warn.max_severity(DecisionState::Block),
            DecisionState::Block
        );
        assert_eq!(
            DecisionState::Block.max_severity(DecisionState::Warn),
            DecisionState::Block
        );
    }

    #[test]
    fn only_allow_and_warn_permit_work() {
        assert!(DecisionState::Allow.permits_work());
        assert!(DecisionState::Warn.permits_work());
        assert!(!DecisionState::Block.permits_work());
        assert!(!DecisionState::Suspend.permits_work());
    }
}
