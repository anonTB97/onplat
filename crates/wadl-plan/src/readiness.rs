//! Readiness rollups: how much work is stopped, where, and who can release it.
//!
//! The Deck Explorer is read at three *altitudes*. A foreman wants one deck
//! plan. A zone superintendent wants their zone's spaces ranked by what is
//! costing the most. A project superintendent wants the hull on one screen and
//! the name of whoever is holding up the most man-hours. Same facts, three
//! summaries — and the summaries are what this module computes.
//!
//! It lives in the pure crate, next to stranded man-hours, for the same reason:
//! **"3,200 man-hours of crew are standing idle behind a marine chemist"** is a
//! sentence that moves crews and re-sequences an availability. A number with that
//! much weight is property-tested in isolation, not assembled ad hoc in a view.
//!
//! # Readiness is not authorization
//!
//! [`wadl_engine`] answers *may work proceed in this space* — that is
//! authorization, and it is the engine's alone. Readiness asks a different
//! question: *is anyone actually held up?* A suspended space with no work booked
//! in it costs nothing today. A suspended space with two crews and 400 hours
//! left is the whole problem. So readiness is the **join of authorization and
//! booked work**, and the two must not be conflated:
//!
//! | authorization | work booked | readiness |
//! |---------------|-------------|-----------|
//! | permits work  | yes         | [`Readiness::Go`]     |
//! | permits work  | no          | [`Readiness::Idle`]   |
//! | refuses work  | yes         | [`Readiness::Held`]   |
//! | refuses work  | no          | [`Readiness::Latent`] |
//!
//! [`Readiness::Latent`] exists rather than collapsing into `Idle` because the
//! two lead to opposite decisions. An idle space is somewhere you *could* send a
//! crew. A latent one is somewhere you must not, and sending a crew there
//! tomorrow — when someone books work into it — produces a surprise stand-down.
//! Losing that distinction would make the rollup read as "nothing to worry
//! about" for a space that is in fact closed.

use std::collections::BTreeMap;

use wadl_domain::units::ManHours;

/// Whether anyone is actually held up in a space, as opposed to whether the
/// space is authorized. See the module docs — these are different questions.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum Readiness {
    /// Work is booked here and authorized. Crews can be sent.
    Go,
    /// Work is booked here and refused. This is where the cost is.
    Held,
    /// Authorized, but nothing is booked. Spare capacity.
    Idle,
    /// Refused, and nothing is booked. Costs nothing today; do not plan into it.
    Latent,
}

impl Readiness {
    /// The readiness of one space, from its authorization and its booked work.
    #[must_use]
    pub const fn of(permits_work: bool, has_booked_work: bool) -> Self {
        match (permits_work, has_booked_work) {
            (true, true) => Self::Go,
            (false, true) => Self::Held,
            (true, false) => Self::Idle,
            (false, false) => Self::Latent,
        }
    }

    /// True when this readiness represents work that is stopped.
    #[must_use]
    pub const fn is_held(self) -> bool {
        matches!(self, Self::Held)
    }
}

/// One space's contribution to a rollup. Everything here is already known —
/// authorization comes from the engine, hours from the work orders — so this
/// module never decides authorization, only aggregates it.
#[derive(Debug, Clone)]
pub struct SpaceReadiness {
    /// Placard number, e.g. `4-164-2-Q`.
    pub compartment_no: String,
    /// Fire/damage-control zone the space belongs to.
    pub zone: String,
    /// Deck code, matching the register's `class_deck.code`.
    pub deck_code: String,
    /// From the engine's decision. Not recomputed here.
    pub permits_work: bool,
    /// Hours still to earn in this space across every order booked in it.
    pub remaining: ManHours,
    /// Trades with work booked here.
    pub trades: Vec<String>,
    /// Who may clear the hold, when there is one. Empty when nothing is held.
    pub clearing_authority: String,
    /// Hours in *other* compartments that cannot be tested until this one
    /// clears — from [`crate::package`]'s segment topology.
    ///
    /// Deliberately **not** rolled into any [`Tally`]. Two held compartments
    /// upstream of the same segment each strand it, so summing this across a
    /// zone double-counts the same hours and would inflate the headline. It is
    /// exact per space, so it is reported per space, on [`HeldSpace`].
    pub stranded_downstream: ManHours,
}

impl SpaceReadiness {
    /// This space's readiness — the join of its authorization and its booked work.
    #[must_use]
    pub fn readiness(&self) -> Readiness {
        // Booked work means hours still to earn. An order with nothing left to
        // earn is finished, and a finished order in a suspended space is not
        // somebody standing around.
        Readiness::of(self.permits_work, self.remaining.get() > 0)
    }
}

/// Counts and hours for one grouping — a zone, a deck, or the whole hull.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct Tally {
    /// Spaces in this grouping.
    pub spaces: usize,
    /// Authorized, with work booked.
    pub go: usize,
    /// Refused, with work booked — the ones costing the availability.
    pub held: usize,
    /// Authorized, nothing booked.
    pub idle: usize,
    /// Refused, nothing booked.
    pub latent: usize,
    /// Hours behind a hold — the number that argues for re-sequencing.
    pub held_hours: i64,
    /// Hours that could be worked today.
    pub workable_hours: i64,
}

impl Tally {
    fn add(&mut self, space: &SpaceReadiness) {
        self.spaces += 1;
        match space.readiness() {
            Readiness::Go => {
                self.go += 1;
                self.workable_hours += space.remaining.get();
            }
            Readiness::Held => {
                self.held += 1;
                self.held_hours += space.remaining.get();
            }
            Readiness::Idle => self.idle += 1,
            Readiness::Latent => self.latent += 1,
        }
    }

    /// The worst thing true of this grouping, for a single status colour.
    ///
    /// Ordered by what a superintendent acts on first: anything held outranks
    /// everything else, because held hours are the only category that is
    /// actively costing the availability.
    #[must_use]
    pub const fn worst(&self) -> Readiness {
        if self.held > 0 {
            Readiness::Held
        } else if self.go > 0 {
            Readiness::Go
        } else if self.idle > 0 {
            Readiness::Idle
        } else {
            Readiness::Latent
        }
    }
}

/// A named grouping and its tally, plus who is holding it up.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Group {
    /// Zone name, deck code, or `"ship"`.
    pub key: String,
    /// Counts and hours for the grouping.
    pub tally: Tally,
    /// Authorities holding work in this group, worst first by hours held. This
    /// is the actionable half: a zone is not "amber", it is "waiting on the
    /// marine chemist for 620 hours".
    pub holders: Vec<Holder>,
    /// Compartments held here, worst first by hours. Capped by the caller.
    pub worst_spaces: Vec<HeldSpace>,
}

/// An authority and the work waiting on them.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Holder {
    /// The role that can release the hold, e.g. `marine_chemist`.
    pub authority: String,
    /// How many held spaces are waiting on them.
    pub spaces: usize,
    /// Man-hours waiting on them.
    pub hours: i64,
}

/// A held space, for the "go look at this first" list.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct HeldSpace {
    /// Placard number.
    pub compartment_no: String,
    /// Fire/damage-control zone.
    pub zone: String,
    /// Deck code, so the caller can jump straight to the right plate.
    pub deck_code: String,
    /// Man-hours held here.
    pub hours: i64,
    /// Man-hours elsewhere that this hold strands. Per-space and exact; see
    /// [`SpaceReadiness::stranded_downstream`] for why it is never summed.
    pub stranded_hours: i64,
    /// Trades standing by.
    pub trades: Vec<String>,
    /// Who can release it.
    pub clearing_authority: String,
}

/// The hull at three altitudes at once.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Rollup {
    /// Ship altitude.
    pub ship: Group,
    /// Zone altitude, ordered by hours held descending — worst zone first,
    /// because that is the order a superintendent wants to read them in.
    pub zones: Vec<Group>,
    /// Compartment altitude's rail: per-deck counts for the deck selector.
    pub decks: Vec<Group>,
    /// Hours the caller found in the hull's work but could not attribute to any
    /// space in this rollup.
    ///
    /// A register is not guaranteed to contain every compartment a work package
    /// names — a hull delta removes a space, a placard is mis-keyed, a footprint
    /// is authored against the class rather than the hull. Those hours are real
    /// and they are not in any zone, so a rollup that simply dropped them would
    /// read "80 hours held" while 140 were outstanding. Reported rather than
    /// hidden, and non-zero here is a data-quality finding, not a rounding error.
    pub unattributed_hours: i64,
}

/// How many entries the per-group lists carry.
///
/// Bounded deliberately. An unbounded list turns a summary back into the table
/// it was meant to summarise, and the tally still reports the full count — so a
/// reader can always see that the list is a top-N of something larger.
const LIST_LIMIT: usize = 6;

/// Rolls a hull's spaces up to zone, deck, and ship.
///
/// `unattributed` is hours the caller knows about but could not place in a
/// space — see [`Rollup::unattributed_hours`]. It is a required argument rather
/// than an optional field so that claiming full coverage is a deliberate act
/// ([`ManHours::ZERO`]) instead of something a caller can forget to mention.
///
/// Deterministic: groups are keyed in a `BTreeMap` and ties break on the group
/// key, so the same hull always produces the same ordering. Two people looking
/// at the same screen have to be able to say "the third one down".
#[must_use]
pub fn roll_up(spaces: &[SpaceReadiness], unattributed: ManHours) -> Rollup {
    let mut ship = Tally::default();
    let mut by_zone: BTreeMap<&str, Tally> = BTreeMap::new();
    let mut by_deck: BTreeMap<&str, Tally> = BTreeMap::new();

    for space in spaces {
        ship.add(space);
        by_zone.entry(&space.zone).or_default().add(space);
        by_deck.entry(&space.deck_code).or_default().add(space);
    }

    let zones = by_zone
        .into_iter()
        .map(|(key, tally)| build_group(key, tally, spaces, |s| s.zone == key))
        .collect();
    let decks = by_deck
        .into_iter()
        .map(|(key, tally)| build_group(key, tally, spaces, |s| s.deck_code == key))
        .collect();

    Rollup {
        ship: build_group("ship", ship, spaces, |_| true),
        zones: order_by_pain(zones),
        decks: order_by_pain(decks),
        unattributed_hours: unattributed.get(),
    }
}

/// Worst first: hours held, then count held, then the key so ordering is total.
fn order_by_pain(mut groups: Vec<Group>) -> Vec<Group> {
    groups.sort_by(|a, b| {
        b.tally
            .held_hours
            .cmp(&a.tally.held_hours)
            .then(b.tally.held.cmp(&a.tally.held))
            .then(a.key.cmp(&b.key))
    });
    groups
}

fn build_group(
    key: &str,
    tally: Tally,
    spaces: &[SpaceReadiness],
    in_group: impl Fn(&SpaceReadiness) -> bool,
) -> Group {
    let held: Vec<&SpaceReadiness> = spaces
        .iter()
        .filter(|s| in_group(s) && s.readiness().is_held())
        .collect();

    let mut by_authority: BTreeMap<&str, (usize, i64)> = BTreeMap::new();
    for space in &held {
        let entry = by_authority.entry(&space.clearing_authority).or_default();
        entry.0 += 1;
        entry.1 += space.remaining.get();
    }
    let mut holders: Vec<Holder> = by_authority
        .into_iter()
        .map(|(authority, (spaces, hours))| Holder {
            authority: String::from(authority),
            spaces,
            hours,
        })
        .collect();
    holders.sort_by(|a, b| {
        b.hours
            .cmp(&a.hours)
            .then(b.spaces.cmp(&a.spaces))
            .then(a.authority.cmp(&b.authority))
    });
    holders.truncate(LIST_LIMIT);

    let mut worst_spaces: Vec<HeldSpace> = held
        .iter()
        .map(|s| HeldSpace {
            compartment_no: s.compartment_no.clone(),
            zone: s.zone.clone(),
            deck_code: s.deck_code.clone(),
            hours: s.remaining.get(),
            stranded_hours: s.stranded_downstream.get(),
            trades: s.trades.clone(),
            clearing_authority: s.clearing_authority.clone(),
        })
        .collect();
    // Ranked by total exposure — the hours in the space plus the hours its hold
    // strands elsewhere. A compartment with 80 hours left that strands 1,100
    // downstream outranks one with 300 that strands nothing, and it is the one
    // worth sending a marine chemist to first.
    worst_spaces.sort_by(|a, b| {
        (b.hours + b.stranded_hours)
            .cmp(&(a.hours + a.stranded_hours))
            .then(b.hours.cmp(&a.hours))
            .then(a.compartment_no.cmp(&b.compartment_no))
    });
    worst_spaces.truncate(LIST_LIMIT);

    Group {
        key: String::from(key),
        tally,
        holders,
        worst_spaces,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn space(
        no: &str,
        zone: &str,
        deck: &str,
        permits: bool,
        hours: i64,
        auth: &str,
    ) -> SpaceReadiness {
        SpaceReadiness {
            compartment_no: String::from(no),
            zone: String::from(zone),
            deck_code: String::from(deck),
            permits_work: permits,
            remaining: ManHours::new(hours),
            trades: vec![String::from("51 Electrical")],
            clearing_authority: String::from(auth),
            stranded_downstream: ManHours::ZERO,
        }
    }

    #[test]
    fn readiness_separates_held_from_latent() {
        // The distinction the module docs argue for: a closed space with no work
        // in it must not read the same as an open space with no work in it.
        assert_eq!(Readiness::of(false, true), Readiness::Held);
        assert_eq!(Readiness::of(false, false), Readiness::Latent);
        assert_eq!(Readiness::of(true, false), Readiness::Idle);
        assert_eq!(Readiness::of(true, true), Readiness::Go);
    }

    #[test]
    fn a_finished_order_in_a_closed_space_is_not_idle_crew() {
        // Zero hours left means nobody is standing around, whatever the state.
        let s = space("4-100-2-Q", "Z1", "4th", false, 0, "marine_chemist");
        assert_eq!(s.readiness(), Readiness::Latent);
        assert_eq!(roll_up(&[s], ManHours::ZERO).ship.tally.held_hours, 0);
    }

    #[test]
    fn held_hours_are_summed_per_zone_and_zones_ordered_worst_first() {
        let spaces = vec![
            space("4-100-2-Q", "Z1", "4th", false, 100, "marine_chemist"),
            space("4-104-2-Q", "Z1", "4th", false, 50, "marine_chemist"),
            space("3-200-0-L", "Z2", "3rd", false, 400, "ship_supt"),
            space("3-204-0-L", "Z2", "3rd", true, 90, ""),
        ];
        let r = roll_up(&spaces, ManHours::ZERO);

        assert_eq!(r.ship.tally.held_hours, 550);
        assert_eq!(r.ship.tally.workable_hours, 90);
        assert_eq!(r.ship.tally.held, 3);
        assert_eq!(r.ship.tally.go, 1);

        // Z2 holds 400 hours, Z1 holds 150 — Z2 must lead.
        assert_eq!(
            r.zones.iter().map(|z| z.key.as_str()).collect::<Vec<_>>(),
            ["Z2", "Z1"]
        );
        assert_eq!(r.zones[0].tally.held_hours, 400);
        assert_eq!(r.zones[1].tally.held_hours, 150);
    }

    #[test]
    fn holders_rank_by_hours_and_name_the_authority() {
        let spaces = vec![
            space("a", "Z1", "4th", false, 620, "marine_chemist"),
            space("b", "Z1", "4th", false, 80, "ship_supt"),
            space("c", "Z1", "4th", false, 40, "ship_supt"),
        ];
        let holders = &roll_up(&spaces, ManHours::ZERO).ship.holders;
        assert_eq!(
            holders[0],
            Holder {
                authority: String::from("marine_chemist"),
                spaces: 1,
                hours: 620
            }
        );
        assert_eq!(
            holders[1],
            Holder {
                authority: String::from("ship_supt"),
                spaces: 2,
                hours: 120
            }
        );
    }

    #[test]
    fn worst_prefers_held_over_everything() {
        let mut t = Tally::default();
        t.add(&space("a", "Z", "4th", true, 10, ""));
        assert_eq!(t.worst(), Readiness::Go);
        t.add(&space("b", "Z", "4th", false, 10, "x"));
        assert_eq!(t.worst(), Readiness::Held);
    }

    #[test]
    fn hours_the_caller_could_not_place_are_reported_not_dropped() {
        // The failure this guards: a package footprint naming a compartment the
        // register does not contain. Those hours are outstanding and belong to
        // no zone, so the board has to admit them rather than read clean.
        let spaces = vec![space("4-100-2-Q", "Z1", "4th", false, 80, "marine_chemist")];
        let r = roll_up(&spaces, ManHours::new(60));
        assert_eq!(r.ship.tally.held_hours, 80);
        assert_eq!(r.unattributed_hours, 60);
    }

    #[test]
    fn empty_hull_rolls_up_without_panicking() {
        let r = roll_up(&[], ManHours::ZERO);
        assert_eq!(r.ship.tally, Tally::default());
        assert_eq!(r.ship.tally.worst(), Readiness::Latent);
        assert!(r.zones.is_empty() && r.decks.is_empty());
    }

    #[test]
    fn lists_are_capped_but_the_tally_still_reports_the_truth() {
        let spaces: Vec<_> = (0..20)
            .map(|i| space(&format!("c{i}"), "Z1", "4th", false, 10, &format!("a{i}")))
            .collect();
        let g = roll_up(&spaces, ManHours::ZERO).ship;
        assert_eq!(
            g.tally.held, 20,
            "the count must not be truncated with the list"
        );
        assert_eq!(g.tally.held_hours, 200);
        assert_eq!(g.worst_spaces.len(), LIST_LIMIT);
        assert_eq!(g.holders.len(), LIST_LIMIT);
    }
}
