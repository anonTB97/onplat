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
use wadl_domain::units::{HopDepth, Minutes};

use crate::coupling::CouplingCode;
use crate::decision::DecisionState;
use crate::evaluate::HazardKind;

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
}

/// The set of rules in force for the work under evaluation.
///
/// Ordered: entries are applied in sequence, and the governing state is the most
/// severe across all that fire. In production this is loaded per (class, work
/// type, category) from `rule_binding`, filtered to versions whose effective
/// range covers the evaluation instant.
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

    /// The development seed for USN hot-work and coating hazards.
    ///
    /// **This is seed data, not authored rules.** The outcomes and reaches are
    /// transcribed from the prototype's cascade scenarios — which are the
    /// statement of intent — and anchored to the standards named in
    /// `handoff/01-rule-table.csv`. The open questions in that table (does an
    /// isolated branch break a coupling? does a downward coupling extend two
    /// decks through a penetration?) are deliberately **not** answered here;
    /// each is left at its narrower reading until the safety authority rules.
    #[must_use]
    pub fn seed_usn_hot_work() -> Self {
        let mut entries = Self::seed_coating_rules();
        entries.extend(Self::seed_other_hazard_rules());
        Self::new(entries)
    }

    /// Deterministic version ids so a seeded decision trace is byte-reproducible
    /// in snapshots. Real rule versions are UUIDv7 minted at authoring time.
    fn version(n: u128) -> RuleVersionId {
        RuleVersionId::from_uuid(uuid::Uuid::from_u128(n))
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
            // the most dangerous space on the sheet.
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
            },
            // R03 — the decks above and below a curing coat are heat paths into
            // it. BLOCK, one hop, vertical only. (Prototype: "in service"
            // scenario, R3 / STRUCTURE.)
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
            },
            // R06 — bulkhead-adjacent work is permitted with the boundary posted
            // and no ignition source carried across it. WARN, one hop.
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
            },
            // R09 — the condition follows the air, not the deck plan. Spark
            // producing work on the shared exhaust trunk is SUSPENDed (not
            // refused) because it resumes when the zone clears. Two hops.
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
            },
        ]
    }

    /// The remaining seeded hazards: live hot work, energised buses, flammable
    /// stow, and stop-work.
    fn seed_other_hazard_rules() -> Vec<RuleEntry> {
        let version = Self::version;
        vec![
            // R04 — hot work on the deck directly above an occupied or
            // combustible-loaded space. SUSPEND, one hop, downward.
            //
            // OPEN QUESTION (rule table R04): does the downward coupling extend
            // two decks where a deck penetration exists? Left at ONE hop — the
            // narrower reading — pending the safety authority.
            RuleEntry {
                rule_code: "R04".to_owned(),
                rule_version: version(0x0401),
                hazard: HazardKind::HotWorkLive,
                applies: Applies::Coupled {
                    code: CouplingCode::new("deck_penetration"),
                    max_hops: HopDepth::new(1),
                },
                state: DecisionState::Suspend,
                authority: "NSTM Ch. 074 Vol.1 para 074-13; MIL-STD-1689A".to_owned(),
                clearing_authority: "fire_marshal".to_owned(),
                hold: Some(Minutes::new(30)), // post-work fire watch hold
                waivable: false,
            },
            // R07 — intrusive work inside an electrical envelope whose bus is
            // not in a verified zero-energy state. BLOCK.
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
            },
            // R13 — open flammable stow on the same ventilation branch. BLOCK.
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
            },
            // R22 — a stop-work recorded by an inspection authority suspends the
            // work in that space. Same space only; it is an instruction, not a
            // propagating hazard.
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
            4,
            "same-space BLOCK, vertical BLOCK, bulkhead WARN, vent SUSPEND"
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

        // And the three coupled paths carry three distinct outcomes.
        let coupled: Vec<DecisionState> = coating
            .iter()
            .filter(|e| e.applies != Applies::SameSpace)
            .map(|e| e.state)
            .collect();
        assert_eq!(coupled.len(), 3);
        assert!(
            coupled.contains(&DecisionState::Block),
            "vertical heat path"
        );
        assert!(coupled.contains(&DecisionState::Warn), "shared bulkhead");
        assert!(
            coupled.contains(&DecisionState::Suspend),
            "shared ventilation"
        );
    }

    #[test]
    fn hazard_cascades_are_not_waivable() {
        // Rule R15 assumption: hazard cascades cannot be waived.
        assert!(RuleSet::seed_usn_hot_work()
            .entries()
            .iter()
            .all(|e| !e.waivable));
    }
}
