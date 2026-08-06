//! Quantities that carry a unit in the type.
//!
//! Man-hours and man-hours-worth of schedule are money in this domain, so they
//! are integers, never floats: `float_arithmetic` is a lint here for a reason.
//! A bare `i32` "hours" that gets added to a bare `i32` "frames" is exactly the
//! confusion these newtypes exist to forbid.

use core::fmt;
use core::iter::Sum;
use core::ops::{Add, Sub};

/// Whole man-hours of work. Budgets, earned, and stranded hours are all this.
///
/// Arithmetic saturates rather than overflows: a stopped shipyard must never be
/// caused by an hours total wrapping, and a panic in a library crate is banned.
#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    Hash,
    PartialOrd,
    Ord,
    Default,
    serde::Serialize,
    serde::Deserialize,
)]
#[serde(transparent)]
pub struct ManHours(i64);

impl ManHours {
    /// Zero hours.
    pub const ZERO: Self = Self(0);

    /// Constructs a man-hours quantity from a whole-hour count.
    #[must_use]
    pub const fn new(hours: i64) -> Self {
        Self(hours)
    }

    /// The whole-hour count.
    #[must_use]
    pub const fn get(self) -> i64 {
        self.0
    }
}

impl Add for ManHours {
    type Output = Self;
    fn add(self, rhs: Self) -> Self {
        Self(self.0.saturating_add(rhs.0))
    }
}

impl Sub for ManHours {
    type Output = Self;
    fn sub(self, rhs: Self) -> Self {
        Self(self.0.saturating_sub(rhs.0))
    }
}

impl Sum for ManHours {
    fn sum<I: Iterator<Item = Self>>(iter: I) -> Self {
        iter.fold(Self::ZERO, Add::add)
    }
}

impl fmt::Display for ManHours {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} MH", self.0)
    }
}

/// A frame number — the longitudinal station used in USN compartment numbering.
/// Ordered so "forward of" / "aft of" is a comparison, not a guess.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
#[serde(transparent)]
pub struct Frame(i32);

impl Frame {
    /// Constructs a frame number.
    #[must_use]
    pub const fn new(frame: i32) -> Self {
        Self(frame)
    }

    /// The frame number.
    #[must_use]
    pub const fn get(self) -> i32 {
        self.0
    }
}

impl fmt::Display for Frame {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Fr {}", self.0)
    }
}

/// How many couplings a hazard has been traversed across. The engine's hop
/// bound is expressed and compared in this unit so an off-by-one in traversal
/// depth cannot be hidden behind a bare integer.
#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    Hash,
    PartialOrd,
    Ord,
    Default,
    serde::Serialize,
    serde::Deserialize,
)]
#[serde(transparent)]
pub struct HopDepth(u8);

impl HopDepth {
    /// The origin compartment, before any coupling has been crossed.
    pub const ZERO: Self = Self(0);

    /// Constructs a hop depth.
    #[must_use]
    pub const fn new(hops: u8) -> Self {
        Self(hops)
    }

    /// The hop count.
    #[must_use]
    pub const fn get(self) -> u8 {
        self.0
    }

    /// The next depth outward. Saturates at [`u8::MAX`]; callers bound the
    /// traversal well below that, so saturation is a safety net, not a path.
    #[must_use]
    pub const fn increment(self) -> Self {
        Self(self.0.saturating_add(1))
    }
}

impl fmt::Display for HopDepth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} hop(s)", self.0)
    }
}

/// A duration in whole minutes — hold times, cure periods, retest clocks. Kept
/// distinct from a wall-clock [`crate::Timestamp`]: a duration is not a point
/// in time and the two must not be added by accident.
#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    Hash,
    PartialOrd,
    Ord,
    Default,
    serde::Serialize,
    serde::Deserialize,
)]
#[serde(transparent)]
pub struct Minutes(i64);

impl Minutes {
    /// Constructs a minute count.
    #[must_use]
    pub const fn new(minutes: i64) -> Self {
        Self(minutes)
    }

    /// The minute count.
    #[must_use]
    pub const fn get(self) -> i64 {
        self.0
    }
}

impl fmt::Display for Minutes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} min", self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn man_hours_sum_saturates() {
        let total: ManHours = [ManHours::new(680), ManHours::new(240)].into_iter().sum();
        assert_eq!(total, ManHours::new(920));
        assert_eq!(
            ManHours::new(i64::MAX) + ManHours::new(1),
            ManHours::new(i64::MAX)
        );
    }

    #[test]
    fn hop_depth_increments_and_saturates() {
        assert_eq!(HopDepth::ZERO.increment(), HopDepth::new(1));
        assert_eq!(HopDepth::new(u8::MAX).increment(), HopDepth::new(u8::MAX));
    }
}
