//! Properties of the readiness rollup.
//!
//! A rollup is a summary, and a summary that does not add up is worse than no
//! summary: a superintendent reads "410 hours held" off the ship board, opens
//! the zone that owns them, and finds 380. These tests pin the arithmetic that
//! makes the three altitudes agree with each other.

use proptest::prelude::*;

use wadl_domain::units::ManHours;
use wadl_plan::readiness::{roll_up, Readiness, SpaceReadiness, Tally};

/// A space with a small, deliberately colliding key space, so zones and decks
/// really do group and holders really do collide.
fn space() -> impl Strategy<Value = SpaceReadiness> {
    (
        0_u32..400,
        prop::sample::select(vec!["Z1", "Z2", "Z6", "—"]),
        prop::sample::select(vec!["Main", "2nd", "3rd", "4th"]),
        any::<bool>(),
        // Zero hours has to be reachable: it is what separates Held from Latent.
        0_i64..900,
        prop::sample::select(vec!["marine_chemist", "ship_supt", "fire_marshal", ""]),
        0_i64..2000,
    )
        .prop_map(
            |(n, zone, deck, permits, hours, auth, stranded)| SpaceReadiness {
                compartment_no: format!("{deck}-{n}-2-Q"),
                zone: zone.to_owned(),
                deck_code: deck.to_owned(),
                permits_work: permits,
                remaining: ManHours::new(hours),
                trades: vec!["51 Electrical".to_owned()],
                clearing_authority: auth.to_owned(),
                stranded_downstream: ManHours::new(stranded),
            },
        )
}

fn total(tallies: impl Iterator<Item = Tally>) -> Tally {
    tallies.fold(Tally::default(), |mut acc, t| {
        acc.spaces += t.spaces;
        acc.go += t.go;
        acc.held += t.held;
        acc.idle += t.idle;
        acc.latent += t.latent;
        acc.held_hours += t.held_hours;
        acc.workable_hours += t.workable_hours;
        acc
    })
}

proptest! {
    /// The three altitudes are three views of one set of facts, so the zone
    /// tallies and the deck tallies must each re-add to the ship tally. This is
    /// the property that makes drilling down trustworthy.
    #[test]
    fn altitudes_conserve_every_count_and_hour(spaces in prop::collection::vec(space(), 0..40)) {
        let r = roll_up(&spaces, ManHours::ZERO);
        prop_assert_eq!(total(r.zones.iter().map(|g| g.tally.clone())), r.ship.tally.clone());
        prop_assert_eq!(total(r.decks.iter().map(|g| g.tally.clone())), r.ship.tally.clone());
    }

    /// Every space lands in exactly one readiness bucket, and the buckets
    /// account for all of them — no space is dropped or double-counted.
    #[test]
    fn buckets_partition_the_hull(spaces in prop::collection::vec(space(), 0..40)) {
        let t = roll_up(&spaces, ManHours::ZERO).ship.tally;
        prop_assert_eq!(t.spaces, spaces.len());
        prop_assert_eq!(t.go + t.held + t.idle + t.latent, spaces.len());
    }

    /// Held hours are exactly the hours in held spaces — nothing from a space
    /// that is merely closed, and nothing from a space that is merely idle.
    /// Getting this wrong is how a rollup starts overstating the cost of a hold.
    #[test]
    fn held_hours_come_only_from_held_spaces(spaces in prop::collection::vec(space(), 0..40)) {
        let expected: i64 = spaces
            .iter()
            .filter(|s| s.readiness() == Readiness::Held)
            .map(|s| s.remaining.get())
            .sum();
        let t = roll_up(&spaces, ManHours::ZERO).ship.tally;
        prop_assert_eq!(t.held_hours, expected);
        prop_assert!(t.held_hours >= 0);
        prop_assert!(t.workable_hours >= 0);
    }

    /// Zones are read top-down as a worklist, so the ordering has to be a real
    /// ordering: non-increasing in hours held, and total (no ties left to
    /// chance) so two people see the same list in the same order.
    #[test]
    fn zones_are_ordered_worst_first_and_deterministically(
        spaces in prop::collection::vec(space(), 0..40),
    ) {
        let r = roll_up(&spaces, ManHours::ZERO);
        for pair in r.zones.windows(2) {
            let (Some(a), Some(b)) = (pair.first(), pair.get(1)) else { continue };
            prop_assert!(
                a.tally.held_hours > b.tally.held_hours
                    || (a.tally.held_hours == b.tally.held_hours
                        && (a.tally.held > b.tally.held
                            || (a.tally.held == b.tally.held && a.key <= b.key))),
                "zone ordering is not total: {a:?} before {b:?}"
            );
        }
        // Same input, same output — the ordering may not depend on hash order.
        let again = roll_up(&spaces, ManHours::ZERO);
        prop_assert_eq!(
            r.zones.iter().map(|g| g.key.clone()).collect::<Vec<_>>(),
            again.zones.iter().map(|g| g.key.clone()).collect::<Vec<_>>()
        );
    }

    /// The status colour must never say "fine" while hours are held, and never
    /// say "held" when nothing is.
    #[test]
    fn worst_tracks_held_exactly(spaces in prop::collection::vec(space(), 0..40)) {
        for group in roll_up(&spaces, ManHours::ZERO).zones {
            prop_assert_eq!(
                group.tally.worst() == Readiness::Held,
                group.tally.held > 0,
                "{:?}", group.tally
            );
        }
    }

    /// Holder hours re-add to the group's held hours. A holder list that lost
    /// hours would understate what an authority is sitting on — except where the
    /// list is truncated, which is why the check is an inequality with the
    /// full-list case pinned separately.
    #[test]
    fn holder_hours_never_exceed_the_group(spaces in prop::collection::vec(space(), 0..40)) {
        for group in roll_up(&spaces, ManHours::ZERO).zones {
            let listed: i64 = group.holders.iter().map(|h| h.hours).sum();
            prop_assert!(
                listed <= group.tally.held_hours,
                "holders claim more than the zone holds: {listed} > {}",
                group.tally.held_hours
            );
            // At most four distinct authorities exist in the generator, so the
            // holder list is never truncated and must account for everything.
            let listed_spaces: usize = group.holders.iter().map(|h| h.spaces).sum();
            prop_assert_eq!(listed_spaces, group.tally.held);
            prop_assert_eq!(listed, group.tally.held_hours);
        }
    }
}
