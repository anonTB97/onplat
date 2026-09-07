//! Rules as data.
//!
//! The engine contains no thresholds, no hop limits and no outcomes. It is
//! handed a [`RuleSet`] and applies it. That is what makes ADR 0002 true rather
//! than aspirational: a threshold change is a data change, and every decision
//! records the [`RuleVersionId`] of the entry that produced it, so a decision
//! made in 2027 is still explainable in 2031 after the rule has changed twice.
//!
//! A [`RuleEntry`] is the in-memory projection of one `rule_version` row joined
//! to its binding: which hazard triggers it, which coupling it propagates along,
//! how far it reaches, what state it produces, and who may clear it. The store
//! loads these; [`RuleSet::seed_usn_hot_work`] provides the development seed,
//! whose outcomes are taken from the prototype's cascade scenarios rather than
//! invented.

use wadl_domain::ids::RuleVersionId;
use wadl_domain::time::Timestamp;
use wadl_domain::units::{HopDepth, Minutes};

use crate::coupling::CouplingCode;
use crate::decision::DecisionState;
use crate::evaluate::HazardKind;

/// What an entry binds to: which work, in which kind of space, over which
/// range of instants. Every field empty is the row that applies to
/// everything — the reading every entry had before bindings existed, and
/// the reading a stored payload without these fields deserializes to.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RuleBinding {
    /// Work-type tokens (`hot_work`, `coating`, `inspection`…) from the
    /// schedule's field map. Empty = any work.
    #[serde(default)]
    pub work_types: Vec<String>,
    /// Register categories in the register's own words (`Living`,
    /// `Machinery / operational`…). Empty = any space.
    #[serde(default)]
    pub categories: Vec<String>,
    /// The first instant the entry is in force, inclusive. `None` = open.
    #[serde(default)]
    pub effective_from: Option<Timestamp>,
    /// The first instant the entry is no longer in force, exclusive. `None` =
    /// open.
    #[serde(default)]
    pub effective_to: Option<Timestamp>,
}

impl RuleBinding {
    /// Whether the binding covers `work` at `at`.
    ///
    /// Unknown work — `work_type` or `category` `None` — is treated as *any*
    /// work: the conservative reading, and the one every compartment-level
    /// board takes. The effective range is half-open, `from ≤ at < to`.
    #[must_use]
    pub fn covers(&self, work: Work<'_>, at: Timestamp) -> bool {
        let listed = |list: &[String], value: Option<&str>| {
            list.is_empty() || value.is_none_or(|v| list.iter().any(|w| w == v))
        };
        listed(&self.work_types, work.work_type)
            && listed(&self.categories, work.category)
            && self.effective_from.is_none_or(|from| from <= at)
            && self.effective_to.is_none_or(|to| at < to)
    }
}

/// Where a timed hold is anchored.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HoldFrom {
    /// The hold runs from the instant the hazard was raised — a cure clock
    /// starts when the coat goes on.
    #[default]
    Raise,
    /// The hold runs from the instant the hazard *ended* (the `HAZARD_CLEARED`
    /// row) — a fire watch starts when the permit closes, and until then the
    /// hold has no clock at all.
    End,
}

/// The work an evaluation is for, as far as the caller knows it. Either field
/// `None` means "unknown", which binds like "any".
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Work<'a> {
    /// The activity's work-type token from the field map, if the schedule
    /// carries one.
    pub work_type: Option<&'a str>,
    /// The subject compartment's register category, if known.
    pub category: Option<&'a str>,
}

impl Work<'_> {
    /// Unknown work in an unknown space — every entry binds.
    pub const ANY: Work<'static> = Work {
        work_type: None,
        category: None,
    };
}

/// Which spaces an entry applies to, relative to the hazard's origin.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Applies {
    /// The hazard's own compartment (hop 0) — a same-space rule.
    SameSpace,
    /// Spaces reached across couplings of this code, within `max_hops`.
    Coupled {
        /// The coupling-type code this rule propagates along.
        code: CouplingCode,
        /// The furthest hop depth this rule reaches.
        max_hops: HopDepth,
    },
}

/// One applicable rule version.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RuleEntry {
    /// The rule's human code, e.g. `R03`. Rendered in the trace.
    pub rule_code: String,
    /// The version that produced a decision. Recorded on every trace step so a
    /// historical decision stays explainable after the rule changes.
    pub rule_version: RuleVersionId,
    /// The hazard that triggers this rule.
    pub hazard: HazardKind,
    /// Where the rule reaches.
    pub applies: Applies,
    /// The state the rule produces where it applies.
    pub state: DecisionState,
    /// The authority document this rule is anchored to (NSTM Ch. 074, NFPA 306…).
    pub authority: String,
    /// Who may clear the condition.
    pub clearing_authority: String,
    /// The hold/cure period, where the rule has one. Used to price the earliest
    /// clear time; `None` where clearing is conditional rather than timed.
    pub hold: Option<Minutes>,
    /// Whether the rule may be waived. Hazard cascades are not (rule R15).
    pub waivable: bool,
    /// What the entry binds to. Absent from a stored payload = everything.
    #[serde(default)]
    pub binding: RuleBinding,
    /// Where `hold` is anchored. Absent from a stored payload = the raise.
    #[serde(default)]
    pub hold_from: HoldFrom,
}

impl RuleEntry {
    /// Whether this entry is in force for `work` at `at` — its binding covers
    /// the work type, the category and the instant.
    #[must_use]
    pub fn binds(&self, work: Work<'_>, at: Timestamp) -> bool {
        self.binding.covers(work, at)
    }
}

/// The set of rules in force for the work under evaluation.
///
/// Ordered: entries are applied in sequence, and the governing state is the most
/// severe across all that fire. The store serves the hull's set whole (the
/// committed rule table, else the seed); the call site narrows it to the work
/// in hand with [`RuleSet::bound_to`] before it reaches `evaluate()`.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RuleSet {
    entries: Vec<RuleEntry>,
}

impl RuleSet {
    /// Builds a rule set from entries.
    #[must_use]
    pub fn new(entries: Vec<RuleEntry>) -> Self {
        Self { entries }
    }

    /// The entries, in application order.
    #[must_use]
    pub fn entries(&self) -> &[RuleEntry] {
        &self.entries
    }

    /// Entries triggered by a given hazard kind.
    pub fn for_hazard(&self, hazard: HazardKind) -> impl Iterator<Item = &RuleEntry> + '_ {
        self.entries.iter().filter(move |e| e.hazard == hazard)
    }

    /// The entries bound to `work` at `at`, in the same order.
    ///
    /// This is how the work type reaches the engine: the caller picks the set
    /// per subject and hands `evaluate()` the narrowed set, so a cold-work
    /// inspection above a curing coat is judged by the rows that bind to
    /// inspection, and the weld beside it by the rows that bind to hot work.
    /// `Work::ANY` keeps every row whose effective range covers the instant —
    /// the compartment-level reading.
    #[must_use]
    pub fn bound_to(&self, work: Work<'_>, at: Timestamp) -> Self {
        Self::new(
            self.entries
                .iter()
                .filter(|e| e.binds(work, at))
                .cloned()
                .collect(),
        )
    }

    /// The longest hold anchored at a hazard's end across the set — how far
    /// past a clearance a hazard still bears on a decision, and therefore the
    /// tail the store must serve closed hazards for. Zero when no entry is
    /// end-anchored.
    #[must_use]
    pub fn longest_end_anchored_hold(&self) -> Minutes {
        self.entries
            .iter()
            .filter(|e| e.hold_from == HoldFrom::End)
            .filter_map(|e| e.hold)
            .max()
            .unwrap_or_default()
    }

    /// Version ids the seed once carried and no longer does. A store seeded
    /// before the reading changed retires these (`effective_to` set) so the
    /// new version is the one in force; the old id stays on every trace it
    /// produced. Today: `…0401`, R04 with its fire watch anchored at the
    /// permit's raise — the reading this seed corrects.
    #[must_use]
    pub fn seed_retired_versions() -> Vec<RuleVersionId> {
        vec![Self::version(0x0401)]
    }

    /// The development seed for USN hot-work and coating hazards — the set in
    /// force until a rule table is committed through the door.
    ///
    /// **This is seed data, not authored rules.** The outcomes and reaches are
    /// transcribed from the prototype's cascade scenarios — which are the
    /// statement of intent — and anchored to the standards named in
    /// `handoff/01-rule-table.csv`. Audited row by row against that table at
    /// the safety-authority sitting (`docs/programme/s14-rules-the-yard-will-sign.md`):
    /// the ignition-source rows bind to `hot_work`, R04's fire watch is
    /// anchored at the permit's close, R09 is split into the table's two
    /// readings. The open questions in the table (does an isolated branch
    /// break a coupling? does a downward coupling extend two decks through a
    /// penetration?) are deliberately **not** answered here; each is left at
    /// its narrower reading until the safety authority rules. The exported
    /// form of this seed is `reference/cvn73/CVN73-rule-table.csv`, proved
    /// equal by test.
    #[must_use]
    pub fn seed_usn_hot_work() -> Self {
        let mut entries = Self::seed_coating_rules();
        entries.extend(Self::seed_other_hazard_rules());
        Self::new(entries)
    }

    /// Deterministic version ids so a seeded decision trace is byte-reproducible
    /// in snapshots. An id changes only when a reading that exists today
    /// changes; a binding that narrows nothing yet recorded keeps its id.
    /// Authored rows get content-addressed ids at the door.
    fn version(n: u128) -> RuleVersionId {
        RuleVersionId::from_uuid(uuid::Uuid::from_u128(n))
    }

    /// The binding of an ignition-source row: hot work only. A cold-work
    /// inspection in the same space is not what these rows are about.
    fn hot_work_only() -> RuleBinding {
        RuleBinding {
            work_types: vec!["hot_work".to_owned()],
            ..RuleBinding::default()
        }
    }

    /// The coating cascade (R03/R06/R09) — the scenario the prototype walks
    /// through in full, and the one the golden acceptance tests pin.
    fn seed_coating_rules() -> Vec<RuleEntry> {
        let version = Self::version;
        vec![
            // R03/same-space — the coated compartment IS the flammable-vapour
            // space ("from this moment the space has a vapour hazard and a cure
            // clock"). Hot work in it is refused outright. Without this entry the
            // origin of a cascade reads as ALLOW, which is the wrong answer in
            // the most dangerous space on the sheet. Binds to hot work: the
            // inspection of the coat itself is not refused by its own vapour.
            RuleEntry {
                rule_code: "R03".to_owned(),
                rule_version: version(0x0300),
                hazard: HazardKind::CoatingOpen,
                applies: Applies::SameSpace,
                state: DecisionState::Block,
                authority: "NFPA 306; NSTM Ch. 074 Vol. 1".to_owned(),
                clearing_authority: "marine_chemist".to_owned(),
                hold: Some(Minutes::new(480)),
                waivable: false,
                binding: Self::hot_work_only(),
                hold_from: HoldFrom::Raise,
            },
            // R03 — the decks above and below a curing coat are heat paths into
            // it. BLOCK, one hop, vertical only, hot work. (Prototype: "in
            // service" scenario, R3 / STRUCTURE.)
            RuleEntry {
                rule_code: "R03".to_owned(),
                rule_version: version(0x0301),
                hazard: HazardKind::CoatingOpen,
                applies: Applies::Coupled {
                    code: CouplingCode::new("deck_penetration"),
                    max_hops: HopDepth::new(1),
                },
                state: DecisionState::Block,
                authority: "NSTM Ch. 074 Vol. 1; NFPA 306".to_owned(),
                clearing_authority: "marine_chemist".to_owned(),
                hold: Some(Minutes::new(480)), // eight-hour cure
                waivable: false,
                binding: Self::hot_work_only(),
                hold_from: HoldFrom::Raise,
            },
            // R06 — bulkhead-adjacent hot work is permitted with the boundary
            // posted and no ignition source carried across it. WARN, one hop.
            //
            // LEFT WITH THE AUTHORITY (sitting decision D1): the table's R06 is
            // a race — a coating opening beside an already-active permit — which
            // the engine cannot express; this row is the bulkhead case the
            // table has no row for. Recorded in the exported table's
            // open-question cell.
            RuleEntry {
                rule_code: "R06".to_owned(),
                rule_version: version(0x0601),
                hazard: HazardKind::CoatingOpen,
                applies: Applies::Coupled {
                    code: CouplingCode::new("shared_bulkhead"),
                    max_hops: HopDepth::new(1),
                },
                state: DecisionState::Warn,
                authority: "Yard safety standard; NSTM Ch. 074".to_owned(),
                clearing_authority: "marine_chemist".to_owned(),
                hold: Some(Minutes::new(480)),
                waivable: false,
                binding: Self::hot_work_only(),
                hold_from: HoldFrom::Raise,
            },
            // R09 — the condition follows the air, not the deck plan. Spark
            // producing work on the shared exhaust trunk is SUSPENDed (not
            // refused) because it resumes when the zone clears. Two hops. The
            // table's own note resolves the state: "refuses grinding, cutting,
            // torch" — so this row binds to hot work…
            RuleEntry {
                rule_code: "R09".to_owned(),
                rule_version: version(0x0901),
                hazard: HazardKind::CoatingOpen,
                applies: Applies::Coupled {
                    code: CouplingCode::new("exhaust_trunk"),
                    max_hops: HopDepth::new(2),
                },
                state: DecisionState::Suspend,
                authority: "NSTM Ch. 074; NFPA 306".to_owned(),
                clearing_authority: "marine_chemist".to_owned(),
                hold: Some(Minutes::new(480)),
                waivable: false,
                binding: Self::hot_work_only(),
                hold_from: HoldFrom::Raise,
            },
            // …and this one is the table's WARN for every other work class on
            // the same trunk ("allows mechanical/hanging").
            RuleEntry {
                rule_code: "R09".to_owned(),
                rule_version: version(0x0902),
                hazard: HazardKind::CoatingOpen,
                applies: Applies::Coupled {
                    code: CouplingCode::new("exhaust_trunk"),
                    max_hops: HopDepth::new(2),
                },
                state: DecisionState::Warn,
                authority: "NSTM Ch. 074; NFPA 306".to_owned(),
                clearing_authority: "marine_chemist".to_owned(),
                hold: Some(Minutes::new(480)),
                waivable: false,
                binding: RuleBinding::default(),
                hold_from: HoldFrom::Raise,
            },
        ]
    }

    /// The remaining seeded hazards: live hot work, energised buses, flammable
    /// stow, and stop-work.
    fn seed_other_hazard_rules() -> Vec<RuleEntry> {
        let version = Self::version;
        vec![
            // R04 — hot work on the deck directly above an occupied or
            // combustible-loaded space. SUSPEND, one hop, downward, any work
            // below. The fire watch is anchored at the permit's CLOSE: the
            // space below stays suspended while the torch may be lit, then for
            // thirty minutes after the HAZARD_CLEARED row. Version `…0402`;
            // `…0401` priced the watch from the raise and is retired.
            //
            // OPEN QUESTION (rule table R04): does the downward coupling extend
            // two decks where a deck penetration exists? Left at ONE hop — the
            // narrower reading — pending the safety authority.
            RuleEntry {
                rule_code: "R04".to_owned(),
                rule_version: version(0x0402),
                hazard: HazardKind::HotWorkLive,
                applies: Applies::Coupled {
                    code: CouplingCode::new("deck_penetration"),
                    max_hops: HopDepth::new(1),
                },
                state: DecisionState::Suspend,
                authority: "NSTM Ch. 074 Vol.1 para 074-13; MIL-STD-1689A".to_owned(),
                clearing_authority: "fire_marshal".to_owned(),
                hold: Some(Minutes::new(30)), // post-work fire watch
                waivable: false,
                binding: RuleBinding::default(),
                hold_from: HoldFrom::End,
            },
            // R07/same-space — the rule's own wording is "any intrusive work
            // INSIDE an electrical envelope whose bus is not in a verified
            // zero-energy state". The envelope's own compartment is the primary
            // case, so it needs a same-space entry; the coupled entry below
            // extends it along bus topology. Any work.
            RuleEntry {
                rule_code: "R07".to_owned(),
                rule_version: version(0x0700),
                hazard: HazardKind::EnergisedBus,
                applies: Applies::SameSpace,
                state: DecisionState::Block,
                authority: "NSTM Ch. 300; NAVSEA S9086-KC-STM-010".to_owned(),
                clearing_authority: "isolation_authority".to_owned(),
                hold: None, // cleared by verified isolation, not by elapsed time
                waivable: false,
                binding: RuleBinding::default(),
                hold_from: HoldFrom::Raise,
            },
            // R07 — the same hazard reaching a coupled bus segment. Direction
            // is the register's: every reference bus edge is authored one-way.
            //
            // OPEN QUESTION (rule table R07): does a coupled bus two
            // switchboards away require isolation, or notification only? Left at
            // ONE hop — the narrower reach — pending the safety authority.
            RuleEntry {
                rule_code: "R07".to_owned(),
                rule_version: version(0x0701),
                hazard: HazardKind::EnergisedBus,
                applies: Applies::Coupled {
                    code: CouplingCode::new("electrical_bus"),
                    max_hops: HopDepth::new(1),
                },
                state: DecisionState::Block,
                authority: "NSTM Ch. 300; NAVSEA S9086-KC-STM-010".to_owned(),
                clearing_authority: "isolation_authority".to_owned(),
                hold: None, // cleared by verified isolation, not by elapsed time
                waivable: false,
                binding: RuleBinding::default(),
                hold_from: HoldFrom::Raise,
            },
            // R13 — open flammable stow on the same ventilation branch: an
            // ignition risk, so hot work. BLOCK. (The closed-but-unsecured
            // stow stays open question D7.)
            RuleEntry {
                rule_code: "R13".to_owned(),
                rule_version: version(0x1301),
                hazard: HazardKind::FlammableStow,
                applies: Applies::Coupled {
                    code: CouplingCode::new("exhaust_trunk"),
                    max_hops: HopDepth::new(2),
                },
                state: DecisionState::Block,
                authority: "NFPA 306; NSTM Ch. 074".to_owned(),
                clearing_authority: "fire_marshal".to_owned(),
                hold: None,
                waivable: false,
                binding: Self::hot_work_only(),
                hold_from: HoldFrom::Raise,
            },
            // R22 — a stop-work recorded by an inspection authority suspends the
            // work in that space. Same space only; it is an instruction, not a
            // propagating hazard. Any work.
            RuleEntry {
                rule_code: "R22".to_owned(),
                rule_version: version(0x2201),
                hazard: HazardKind::StopWork,
                applies: Applies::SameSpace,
                state: DecisionState::Suspend,
                authority: "Yard safety programme; NAVSEA stop-work authority".to_owned(),
                clearing_authority: "issuing_authority".to_owned(),
                hold: None,
                waivable: false,
                binding: RuleBinding::default(),
                hold_from: HoldFrom::Raise,
            },
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_covers_the_prototype_coating_cascade() {
        let rules = RuleSet::seed_usn_hot_work();
        let coating: Vec<_> = rules.for_hazard(HazardKind::CoatingOpen).collect();
        assert_eq!(
            coating.len(),
            5,
            "same-space BLOCK, vertical BLOCK, bulkhead WARN, vent SUSPEND for hot work and WARN for the rest"
        );

        // The coated space itself must be refused: it IS the vapour space.
        let same_space: Vec<_> = coating
            .iter()
            .filter(|e| e.applies == Applies::SameSpace)
            .collect();
        assert_eq!(same_space.len(), 1);
        assert_eq!(
            same_space.first().map(|e| e.state),
            Some(DecisionState::Block)
        );

        // And the coupled paths carry three distinct outcomes.
        let coupled: Vec<DecisionState> = coating
            .iter()
            .filter(|e| e.applies != Applies::SameSpace)
            .map(|e| e.state)
            .collect();
        assert_eq!(coupled.len(), 4);
        assert!(
            coupled.contains(&DecisionState::Block),
            "vertical heat path"
        );
        assert!(coupled.contains(&DecisionState::Warn), "shared bulkhead");
        assert!(
            coupled.contains(&DecisionState::Suspend),
            "shared ventilation"
        );

        // The R09 split: the trunk carries SUSPEND for hot work and WARN for
        // everything else, so cold work on the trunk is flagged, not stopped.
        let trunk: Vec<_> = coating.iter().filter(|e| e.rule_code == "R09").collect();
        assert_eq!(trunk.len(), 2);
        let at = Timestamp::from_epoch_millis(0);
        let for_work = |wt: &str| -> Vec<DecisionState> {
            trunk
                .iter()
                .filter(|e| {
                    e.binds(
                        Work {
                            work_type: Some(wt),
                            category: None,
                        },
                        at,
                    )
                })
                .map(|e| e.state)
                .collect()
        };
        assert_eq!(
            for_work("hot_work"),
            vec![DecisionState::Suspend, DecisionState::Warn]
        );
        assert_eq!(for_work("mechanical"), vec![DecisionState::Warn]);
    }

    #[test]
    fn hazard_cascades_are_not_waivable() {
        // Rule R15 assumption: hazard cascades cannot be waived.
        assert!(RuleSet::seed_usn_hot_work()
            .entries()
            .iter()
            .all(|e| !e.waivable));
    }

    #[test]
    fn the_seed_fixes_r04_at_the_permits_close_and_retires_the_raise_reading() {
        let rules = RuleSet::seed_usn_hot_work();
        let r04: Vec<_> = rules
            .entries()
            .iter()
            .filter(|e| e.rule_code == "R04")
            .collect();
        assert_eq!(r04.len(), 1);
        let entry = r04[0];
        assert_eq!(entry.rule_version, RuleSet::version(0x0402));
        assert_eq!(entry.hold_from, HoldFrom::End);
        assert_eq!(entry.hold, Some(Minutes::new(30)));
        assert!(entry.binding.work_types.is_empty(), "any work below");
        assert_eq!(
            RuleSet::seed_retired_versions(),
            vec![RuleSet::version(0x0401)]
        );
        assert!(
            rules
                .entries()
                .iter()
                .all(|e| !RuleSet::seed_retired_versions().contains(&e.rule_version)),
            "a retired version is not in the seed"
        );
    }

    fn at(minute: i64) -> Timestamp {
        Timestamp::from_epoch_millis(minute * 60_000)
    }

    fn entry_bound(binding: RuleBinding) -> RuleEntry {
        RuleEntry {
            rule_code: "T01".to_owned(),
            rule_version: RuleSet::version(0xF001),
            hazard: HazardKind::CoatingOpen,
            applies: Applies::SameSpace,
            state: DecisionState::Block,
            authority: "test".to_owned(),
            clearing_authority: "marine_chemist".to_owned(),
            hold: None,
            waivable: false,
            binding,
            hold_from: HoldFrom::Raise,
        }
    }

    #[test]
    fn a_row_bound_to_hot_work_skips_cold_work_and_keeps_unknown_work() {
        let entry = entry_bound(RuleBinding {
            work_types: vec!["hot_work".to_owned()],
            ..RuleBinding::default()
        });
        let work = |wt: Option<&'static str>| Work {
            work_type: wt,
            category: None,
        };
        assert!(entry.binds(work(Some("hot_work")), at(0)));
        assert!(!entry.binds(work(Some("inspection")), at(0)), "cold work");
        assert!(
            entry.binds(work(None), at(0)),
            "unknown work is any work — the conservative reading"
        );
        assert!(entry.binds(Work::ANY, at(0)));

        // A set narrowed to inspection keeps only the rows that bind to it.
        let set = RuleSet::new(vec![entry, entry_bound(RuleBinding::default())]);
        assert_eq!(
            set.bound_to(work(Some("inspection")), at(0))
                .entries()
                .len(),
            1
        );
        assert_eq!(
            set.bound_to(work(Some("hot_work")), at(0)).entries().len(),
            2
        );
        assert_eq!(set.bound_to(Work::ANY, at(0)).entries().len(), 2);
    }

    #[test]
    fn a_category_binding_reads_the_register_word() {
        let entry = entry_bound(RuleBinding {
            categories: vec!["Machinery / operational".to_owned()],
            ..RuleBinding::default()
        });
        let in_space = |c: Option<&'static str>| Work {
            work_type: None,
            category: c,
        };
        assert!(entry.binds(in_space(Some("Machinery / operational")), at(0)));
        assert!(!entry.binds(in_space(Some("Living")), at(0)));
        assert!(
            entry.binds(in_space(None), at(0)),
            "unknown space is any space"
        );
    }

    #[test]
    fn an_effective_range_is_half_open_at_the_instant() {
        let entry = entry_bound(RuleBinding {
            effective_from: Some(at(100)),
            effective_to: Some(at(200)),
            ..RuleBinding::default()
        });
        assert!(!entry.binds(Work::ANY, at(99)));
        assert!(entry.binds(Work::ANY, at(100)), "in force from the instant");
        assert!(entry.binds(Work::ANY, at(199)));
        assert!(
            !entry.binds(Work::ANY, at(200)),
            "out of force at the instant"
        );

        let open_ended = entry_bound(RuleBinding {
            effective_from: Some(at(100)),
            ..RuleBinding::default()
        });
        assert!(open_ended.binds(Work::ANY, at(1_000_000)));
    }

    #[test]
    fn the_longest_end_anchored_hold_is_the_store_tail() {
        assert_eq!(
            RuleSet::seed_usn_hot_work().longest_end_anchored_hold(),
            Minutes::new(30),
            "R04's fire watch"
        );
        // Raise-anchored holds do not count, however long: the store already
        // stops serving a hazard once it is cleared.
        let mut raise_only = entry_bound(RuleBinding::default());
        raise_only.hold = Some(Minutes::new(480));
        assert_eq!(
            RuleSet::new(vec![raise_only]).longest_end_anchored_hold(),
            Minutes::new(0)
        );
    }

    #[test]
    fn a_payload_without_the_new_fields_reads_as_bound_to_everything() {
        // The 0011 payload contract: a rule_version.trigger_expr stored before
        // bindings existed deserializes with the reading it had.
        let stored = serde_json::json!({
            "rule_code": "R22",
            "rule_version": "00000000-0000-0000-0000-000000002201",
            "hazard": "stop_work",
            "applies": "SameSpace",
            "state": "SUSPEND",
            "authority": "Yard safety programme",
            "clearing_authority": "issuing_authority",
            "hold": null,
            "waivable": false
        });
        let entry: RuleEntry = serde_json::from_value(stored).unwrap();
        assert_eq!(entry.binding, RuleBinding::default());
        assert_eq!(entry.hold_from, HoldFrom::Raise);
        assert!(entry.binds(
            Work {
                work_type: Some("rigging"),
                category: Some("Living")
            },
            at(0)
        ));
    }
}
