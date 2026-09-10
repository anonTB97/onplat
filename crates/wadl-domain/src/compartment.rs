//! Compartment identity.
//!
//! A compartment number is what is printed on the placard, and the platform
//! stores it verbatim ([`CompartmentNo`]) because the numbering *scheme* is a
//! per-class property — a USN hull uses deck-frame-side-usage, a Royal Navy
//! hull does not. Where the class declares the USN scheme, the string can be
//! parsed into [`UsnCompartment`]; where it does not, the raw string is still
//! the truth and parsing is simply not attempted.

use core::fmt;
use core::str::FromStr;

use crate::units::Frame;

/// A compartment number exactly as printed on the placard, e.g. `4-110-2-W`.
///
/// This is deliberately a thin string newtype and not a parsed structure: the
/// register keys on it, per-hull deltas reference it, and a hull whose scheme
/// the platform cannot parse must still round-trip its own numbers unchanged.
#[derive(
    Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
#[serde(transparent)]
pub struct CompartmentNo(String);

impl CompartmentNo {
    /// Wraps a placard string.
    #[must_use]
    pub fn new(raw: impl Into<String>) -> Self {
        Self(raw.into())
    }

    /// The placard string.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Attempts to read this number as a USN deck-frame-side-usage designation.
    /// Returns `None` for any other scheme; the caller should hold the class's
    /// numbering scheme and only call this when it is `usn_deck_frame_side_use`.
    #[must_use]
    pub fn parse_usn(&self) -> Option<UsnCompartment> {
        UsnCompartment::parse(&self.0)
    }
}

impl fmt::Display for CompartmentNo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<&str> for CompartmentNo {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

/// The side field of a USN compartment number.
///
/// The convention is numeric — `0` centreline, odd to starboard, even to port —
/// so it is modelled as its meaning rather than the raw digit, which is what a
/// downstream reader actually needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub enum Side {
    /// On the centreline (side digit `0`).
    Centreline,
    /// To starboard (odd side digit).
    Starboard,
    /// To port (even non-zero side digit).
    Port,
}

impl Side {
    fn from_digit(digit: u32) -> Self {
        if digit == 0 {
            Self::Centreline
        } else if digit % 2 == 1 {
            Self::Starboard
        } else {
            Self::Port
        }
    }
}

/// A parsed USN compartment number: deck, frame, side, and usage code.
///
/// The `usage` code (Q, E, L, M, A, … and the doubled tank codes AA, FF, GG,
/// JJ) is retained as printed. The schema note is deliberate: it is the
/// compartment *category*, not this code, that decides secure status and
/// hazard defaults, so this type intentionally does not infer a category from
/// it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct UsnCompartment {
    /// Deck field as printed (`1`, `2`, `03`, …). Ordering across decks comes
    /// from `class_deck.ordinal`, not from this string.
    pub deck: String,
    /// Longitudinal frame station.
    pub frame: Frame,
    /// Athwartships side.
    pub side: Side,
    /// Usage code as printed: one or two uppercase letters.
    pub usage: String,
}

impl UsnCompartment {
    /// Parses `deck-frame-side-usage`, e.g. `4-110-2-W` or `5-140-0-FF`.
    /// Returns `None` unless there are exactly four hyphen-separated fields,
    /// the frame parses as an integer, the side parses as a non-negative
    /// integer, and the usage is one or two uppercase ASCII letters — the
    /// single letters of the general usage table and the doubled letters real
    /// registers stamp on cargo, fuel, gasoline and JP-5 tanks. Nothing here
    /// guesses: a malformed number is `None`, not a best effort.
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        let mut fields = raw.split('-');
        let deck = fields.next()?;
        let frame = fields.next()?;
        let side = fields.next()?;
        let usage = fields.next()?;
        if fields.next().is_some() || deck.is_empty() {
            return None;
        }

        let frame = Frame::new(frame.parse::<i32>().ok()?);
        let side = Side::from_digit(side.parse::<u32>().ok()?);
        let usage_ok =
            matches!(usage.len(), 1 | 2) && usage.chars().all(|c| c.is_ascii_uppercase());
        if !usage_ok {
            return None;
        }

        Some(Self {
            deck: deck.to_owned(),
            frame,
            side,
            usage: usage.to_owned(),
        })
    }
}

impl FromStr for UsnCompartment {
    type Err = ();
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::parse(s).ok_or(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_well_formed_number() {
        let c = CompartmentNo::new("4-110-2-W").parse_usn().unwrap();
        assert_eq!(c.deck, "4");
        assert_eq!(c.frame, Frame::new(110));
        assert_eq!(c.side, Side::Port);
        assert_eq!(c.usage, "W");
    }

    #[test]
    fn doubled_tank_codes_parse_as_printed() {
        // The doubled letters a real compartment list carries for cargo,
        // fuel, gasoline and JP-5 tanks — the spaces hot-work rules care
        // about most, and the ones a single-letter parser silently dropped.
        let c = UsnCompartment::parse("5-140-0-JJ").unwrap();
        assert_eq!(c.usage, "JJ");
        assert_eq!(c.frame, Frame::new(140));
        assert!(UsnCompartment::parse("6-88-2-FF").is_some());
        assert!(
            UsnCompartment::parse("6-88-2-ff").is_none(),
            "lowercase is not a placard"
        );
        assert!(
            UsnCompartment::parse("6-88-2-FFF").is_none(),
            "three letters is not a code"
        );
    }

    #[test]
    fn side_convention_holds() {
        assert_eq!(
            UsnCompartment::parse("4-141-0-C").unwrap().side,
            Side::Centreline
        );
        assert_eq!(
            UsnCompartment::parse("4-102-1-E").unwrap().side,
            Side::Starboard
        );
    }

    #[test]
    fn rejects_malformed_numbers() {
        assert!(UsnCompartment::parse("4-110-2").is_none());
        assert!(UsnCompartment::parse("4-110-2-W-X").is_none());
        assert!(UsnCompartment::parse("deck-frame-side-WW").is_none());
        assert!(UsnCompartment::parse("").is_none());
    }
}
