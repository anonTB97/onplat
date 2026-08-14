//! The production clock.

use std::time::{SystemTime, UNIX_EPOCH};

use wadl_domain::time::{Clock, Timestamp};

/// The one sanctioned reader of wall-clock time in the whole platform. Every
/// other component takes a [`Clock`] so that time is injected and decisions are
/// reproducible; this is the single place the injection bottoms out.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Timestamp {
        // The ONLY permitted call to SystemTime::now in the codebase — every
        // other component injects a Clock. Clamped, not unwrapped: a clock
        // reading before the epoch is impossible in practice, and a panic in a
        // widely-linked crate is banned.
        #[allow(
            clippy::disallowed_methods,
            reason = "SystemClock is by definition the sanctioned wall-clock source"
        )]
        let since_epoch = SystemTime::now().duration_since(UNIX_EPOCH);
        let millis = since_epoch.map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
        Timestamp::from_epoch_millis(millis.unwrap_or(0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_clock_is_after_2020() {
        // 2020-01-01T00:00:00Z in epoch millis.
        assert!(SystemClock.now().epoch_millis() > 1_577_836_800_000);
    }
}
