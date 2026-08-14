//! Time as an injected capability.
//!
//! Wall-clock time enters the system through exactly one door: the [`Clock`]
//! trait. Production wires a `SystemClock` (in a backend crate, the only place
//! allowed to call `SystemTime::now`); tests wire a [`TestClock`] they control.
//! The decision engine reads no clock at all — it is handed the evaluation
//! instant explicitly — which is what makes a decision reproducible years later
//! for a board of inquiry.
//!
//! [`Timestamp`] is UTC epoch milliseconds as a plain integer, so this crate
//! (and the wasm build of the engine that depends on it) needs no date library.

use core::fmt;

/// A UTC instant, stored as milliseconds since the Unix epoch.
///
/// Epoch millis rather than a `DateTime` keeps this crate dependency-free and
/// trivially serialisable across the server/wasm/mobile boundary. Formatting
/// for humans is a presentation concern and lives at the edges.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
#[serde(transparent)]
pub struct Timestamp(i64);

impl Timestamp {
    /// Wraps a UTC epoch-milliseconds value.
    #[must_use]
    pub const fn from_epoch_millis(millis: i64) -> Self {
        Self(millis)
    }

    /// The UTC epoch-milliseconds value.
    #[must_use]
    pub const fn epoch_millis(self) -> i64 {
        self.0
    }

    /// This instant advanced by a whole number of minutes (saturating), used to
    /// price hold times and cure periods without reaching for a date library.
    #[must_use]
    pub const fn plus_minutes(self, minutes: crate::units::Minutes) -> Self {
        Self(self.0.saturating_add(minutes.get().saturating_mul(60_000)))
    }
}

/// A half-open interval of time, `[start, end)`.
///
/// Half-open on purpose. Work windows abut — a swing shift starts exactly when
/// day shift ends — and a closed interval would count the hours in both, so
/// "how many man-hours are booked at 1600" would answer with two shifts' worth.
/// The same choice makes a hold that expires at `T` clear *at* `T`, not one
/// millisecond after.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct Window {
    /// First instant inside the window.
    pub start: Timestamp,
    /// First instant *after* the window.
    pub end: Timestamp,
}

impl Window {
    /// A window from `start` (inclusive) to `end` (exclusive).
    #[must_use]
    pub const fn new(start: Timestamp, end: Timestamp) -> Self {
        Self { start, end }
    }

    /// Whether `at` falls inside the window.
    ///
    /// A window whose `end` is not after its `start` contains nothing. That is
    /// the honest reading of reversed or empty bounds: a zero-length activity is
    /// never in progress, and inverting the comparison to "helpfully" accept it
    /// would make a mis-keyed schedule row look like work happening at every
    /// instant.
    #[must_use]
    pub const fn contains(&self, at: Timestamp) -> bool {
        at.0 >= self.start.0 && at.0 < self.end.0
    }

    /// Whether this window shares any instant with `other`.
    #[must_use]
    pub const fn overlaps(&self, other: Self) -> bool {
        self.start.0 < other.end.0 && other.start.0 < self.end.0
    }
}

impl fmt::Display for Timestamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}ms", self.0)
    }
}

/// The sole sanctioned source of wall-clock time.
///
/// Held as a trait object or generic by anything that needs "now", so the
/// non-determinism lives in one swappable place. Implementations must be cheap
/// and must not block.
pub trait Clock: Send + Sync {
    /// The current instant.
    fn now(&self) -> Timestamp;
}

/// A clock the test controls: it returns a fixed instant and can be advanced.
///
/// Interior mutability keeps `now(&self)` matching the trait while letting a
/// test move time forward to exercise hold-time and expiry behaviour.
#[derive(Debug)]
pub struct TestClock {
    millis: core::sync::atomic::AtomicI64,
}

impl TestClock {
    /// A test clock pinned to `at`.
    #[must_use]
    pub const fn new(at: Timestamp) -> Self {
        Self {
            millis: core::sync::atomic::AtomicI64::new(at.epoch_millis()),
        }
    }

    /// Advances the clock by whole minutes.
    pub fn advance(&self, minutes: crate::units::Minutes) {
        self.millis.fetch_add(
            minutes.get().saturating_mul(60_000),
            core::sync::atomic::Ordering::SeqCst,
        );
    }
}

impl Clock for TestClock {
    fn now(&self) -> Timestamp {
        Timestamp::from_epoch_millis(self.millis.load(core::sync::atomic::Ordering::SeqCst))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::units::Minutes;

    #[test]
    fn test_clock_advances() {
        let clock = TestClock::new(Timestamp::from_epoch_millis(0));
        assert_eq!(clock.now(), Timestamp::from_epoch_millis(0));
        clock.advance(Minutes::new(30));
        assert_eq!(clock.now(), Timestamp::from_epoch_millis(30 * 60_000));
    }

    #[test]
    fn a_window_is_half_open_so_abutting_shifts_do_not_double_count() {
        let t = Timestamp::from_epoch_millis;
        let day = Window::new(t(0), t(8 * 3_600_000));
        let swing = Window::new(t(8 * 3_600_000), t(16 * 3_600_000));
        let changeover = t(8 * 3_600_000);
        assert!(!day.contains(changeover));
        assert!(swing.contains(changeover));
        assert!(!day.overlaps(swing));
    }

    #[test]
    fn an_empty_or_reversed_window_contains_nothing() {
        let t = Timestamp::from_epoch_millis;
        assert!(!Window::new(t(100), t(100)).contains(t(100)));
        assert!(!Window::new(t(200), t(100)).contains(t(150)));
    }

    #[test]
    fn plus_minutes_prices_a_hold() {
        let start = Timestamp::from_epoch_millis(1_000);
        assert_eq!(
            start.plus_minutes(Minutes::new(60)).epoch_millis(),
            1_000 + 3_600_000
        );
    }
}
