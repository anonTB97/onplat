//! The issue board: every way the platform can show planned work is in
//! trouble, as one ranked list.
//!
//! Each variant of [`Issue`] is a **claim with its evidence attached**, and
//! every claim is either a real engine evaluation, a real counterfactual from
//! `wadl-mitigate`, or a fact read straight off the schedule of record. Nothing
//! here is a heuristic score: the ranking key is man-hours at risk, and every
//! hour of it is traceable to a booked load, a remaining budget, or a stranded
//! segment.
//!
//! The board deliberately reports **claims, not causes**. One energised bus can
//! surface as a held space, a compound hold, and three not-executable
//! activities at once — that is not duplication, it is the same fact seen at
//! the grain of a space, of a plan, and of a crew's morning. Collapsing them
//! would force one grain to speak for the others, and each routes to a
//! different fix.

use std::cmp::Reverse;

use wadl_domain::compartment::CompartmentNo;
use wadl_domain::time::{Timestamp, Window};
use wadl_domain::units::ManHours;
use wadl_engine::DecisionState;
use wadl_mitigate::{triage, World};

use crate::{executability, Executability, Hull, Refusal};

/// One row of the register, as the derivation needs it. Borrowed, because the
/// caller already owns a richer row and issues own their own copies.
#[derive(Debug, Clone, Copy)]
pub struct RegisterRow<'a> {
    /// Scheduler's activity code, e.g. `A4020`.
    pub code: &'a str,
    /// Activity name.
    pub name: &'a str,
    /// The trade doing the work.
    pub trade: &'a str,
    /// Where, if the mapping knows.
    pub compartment: Option<&'a CompartmentNo>,
    /// When, if the schedule says.
    pub planned: Option<Window>,
    /// Man-hours still to do — the stake if this activity is in trouble.
    pub remaining: ManHours,
}

/// One stranding item, pre-computed by `wadl-plan` from real segment topology.
/// Passed in rather than re-derived: two implementations of stranding is how
/// the issue board and the stranded-hours report start disagreeing.
#[derive(Debug, Clone, Copy)]
pub struct Stranding<'a> {
    /// The compartment whose outstanding work is the cause.
    pub compartment: &'a CompartmentNo,
    /// Man-hours left in the compartment itself.
    pub own_remaining: ManHours,
    /// Man-hours downstream that cannot be tested until it clears.
    pub stranded_downstream: ManHours,
    /// How many downstream segments are affected.
    pub downstream_segments: usize,
}

/// One dependency edge from the schedule of record.
#[derive(Debug, Clone, Copy)]
pub struct ScheduleEdge<'a> {
    /// Predecessor activity code.
    pub pred: &'a str,
    /// Successor activity code.
    pub succ: &'a str,
    /// Lag in hours; negative means the successor starts before the
    /// predecessor finishes.
    pub lag_hours: i64,
}

/// One issue: a typed claim that planned work is in trouble, with evidence.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Issue {
    /// An activity whose space refuses work inside its own planned window —
    /// the A4 derivation, at the grain of one crew's assignment.
    NotExecutableAsPlanned {
        /// The activity code.
        activity: String,
        /// Its name.
        name: String,
        /// The trade whose plan this breaks.
        trade: String,
        /// The space it is planned into.
        compartment: CompartmentNo,
        /// The activity's remaining hours — what is at stake.
        hours_at_risk: ManHours,
        /// Where in the window it is refused, and by what.
        refusal: Refusal,
    },
    /// A space the engine refuses at this instant with crews booked into it —
    /// people held up right now.
    HeldWithCrewsBooked {
        /// The held space.
        compartment: CompartmentNo,
        /// Hours booked into it at this instant.
        hours_at_risk: ManHours,
        /// The refusing state.
        state: DecisionState,
        /// Who can release the governing hold.
        clearing_authority: String,
        /// When the space clears on time alone — `None` when any hold needs
        /// verification, the asymmetry every surface reports.
        earliest_clear: Option<Timestamp>,
    },
    /// A held space that no single action opens — the issue *is* that it needs
    /// a plan, and the plan (when one exists) is attached by reference: the
    /// options panel for the space carries it in full.
    CompoundHold {
        /// The held space.
        compartment: CompartmentNo,
        /// Hours booked into it at this instant.
        hours_at_risk: ManHours,
        /// How many independent holds pin it.
        holds: usize,
        /// Actions in the cheapest working plan; 0 when even the planner found
        /// nothing — the worst finding on the board.
        plan_actions: usize,
    },
    /// One space stranding test-ready hours elsewhere — the topology fact from
    /// `wadl-plan`, surfaced as the issue it is instead of only as a report.
    StrandingConcentration {
        /// The compartment doing the stranding.
        compartment: CompartmentNo,
        /// Its own outstanding hours.
        own_remaining: ManHours,
        /// The downstream hours it strands — what is at stake.
        hours_at_risk: ManHours,
        /// Downstream segments affected.
        downstream_segments: usize,
    },
    /// A schedule-quality finding: a negative lag lets the successor start
    /// before its predecessor finishes. Legitimate as an overlap, and exactly
    /// where cure-window inversions hide — so it is surfaced, not buried.
    NegativeLag {
        /// Predecessor activity code.
        pred: String,
        /// Successor activity code.
        succ: String,
        /// The lag, in hours (negative).
        lag_hours: i64,
        /// The successor's remaining hours — what the overlap is betting.
        hours_at_risk: ManHours,
    },
}

impl Issue {
    /// The ranking key: man-hours at risk if the issue is ignored.
    #[must_use]
    pub const fn hours_at_risk(&self) -> ManHours {
        match self {
            Self::NotExecutableAsPlanned { hours_at_risk, .. }
            | Self::HeldWithCrewsBooked { hours_at_risk, .. }
            | Self::CompoundHold { hours_at_risk, .. }
            | Self::StrandingConcentration { hours_at_risk, .. }
            | Self::NegativeLag { hours_at_risk, .. } => *hours_at_risk,
        }
    }

    /// Tie-break order across kinds: the ones needing a person soonest first.
    const fn kind_rank(&self) -> u8 {
        match self {
            Self::CompoundHold { .. } => 0,
            Self::HeldWithCrewsBooked { .. } => 1,
            Self::NotExecutableAsPlanned { .. } => 2,
            Self::StrandingConcentration { .. } => 3,
            Self::NegativeLag { .. } => 4,
        }
    }

    /// A stable subject key so equal-ranked issues never reorder between runs.
    fn subject_key(&self) -> String {
        match self {
            Self::NotExecutableAsPlanned { activity, .. } => activity.clone(),
            Self::HeldWithCrewsBooked { compartment, .. }
            | Self::CompoundHold { compartment, .. }
            | Self::StrandingConcentration { compartment, .. } => compartment.to_string(),
            Self::NegativeLag { pred, succ, .. } => format!("{pred}->{succ}"),
        }
    }
}

/// The issues on one held space: compound when no single action opens it,
/// otherwise held-with-crews. One issue per space, never both — the compound
/// claim subsumes the held claim.
///
/// Built on [`wadl_mitigate::triage`] rather than `assess`: an issue is the
/// claim, not the price tag, and a property test over in `wadl-mitigate` pins
/// that the two can never disagree about the claims.
fn space_issue(world: &World<'_>, compartment: &CompartmentNo, booked: ManHours) -> Option<Issue> {
    let a = triage(world, compartment);
    if a.state.permits_work() {
        return None;
    }
    if !a.single_action_opens && a.holds.len() > 1 {
        return Some(Issue::CompoundHold {
            compartment: compartment.clone(),
            hours_at_risk: booked,
            holds: a.holds.len(),
            plan_actions: a.plan_actions,
        });
    }
    let blocking: Vec<_> = a.holds.iter().filter(|h| h.blocks()).collect();
    let earliest_clear = blocking
        .iter()
        .map(|h| h.earliest_clear)
        .collect::<Option<Vec<_>>>()
        .and_then(|expiries| expiries.into_iter().max());
    Some(Issue::HeldWithCrewsBooked {
        compartment: compartment.clone(),
        hours_at_risk: booked,
        state: a.state,
        clearing_authority: blocking
            .first()
            .map_or_else(String::new, |h| h.clearing_authority.clone()),
        earliest_clear,
    })
}

/// Derives the full issue board for one hull at one instant.
///
/// The space issues and the ranking move with `world.at`; the executability
/// issues do not — "as planned" is a property of the plan, and the register
/// rows carry their own windows. Rows with no remaining hours are skipped for
/// executability (finished work cannot be in trouble), and spaces with nothing
/// booked are skipped for holds (a held empty space is latent, not an issue —
/// the readiness taxonomy's distinction, kept).
#[must_use]
pub fn derive(
    world: &World<'_>,
    register: &[RegisterRow<'_>],
    stranded: &[Stranding<'_>],
    edges: &[ScheduleEdge<'_>],
) -> Vec<Issue> {
    let mut issues = Vec::new();
    let hull = Hull {
        graph: world.graph,
        rules: world.rules,
        hazards: world.hazards,
    };

    for load in (world.loads)(world.at) {
        if load.booked > ManHours::ZERO {
            issues.extend(space_issue(world, &load.compartment, load.booked));
        }
    }

    for row in register {
        if row.remaining == ManHours::ZERO {
            continue;
        }
        if let Executability::NotExecutable(refusal) =
            executability(&hull, row.compartment, row.planned)
        {
            issues.push(Issue::NotExecutableAsPlanned {
                activity: row.code.to_owned(),
                name: row.name.to_owned(),
                trade: row.trade.to_owned(),
                // `NotExecutable` only comes back for a located row; the
                // refusal's origin is the fallback that keeps this total.
                compartment: row.compartment.cloned().unwrap_or(refusal.origin.clone()),
                hours_at_risk: row.remaining,
                refusal,
            });
        }
    }

    for s in stranded {
        if s.stranded_downstream > ManHours::ZERO {
            issues.push(Issue::StrandingConcentration {
                compartment: s.compartment.clone(),
                own_remaining: s.own_remaining,
                hours_at_risk: s.stranded_downstream,
                downstream_segments: s.downstream_segments,
            });
        }
    }

    for e in edges {
        if e.lag_hours < 0 {
            let succ_remaining = register
                .iter()
                .find(|r| r.code == e.succ)
                .map_or(ManHours::ZERO, |r| r.remaining);
            issues.push(Issue::NegativeLag {
                pred: e.pred.to_owned(),
                succ: e.succ.to_owned(),
                lag_hours: e.lag_hours,
                hours_at_risk: succ_remaining,
            });
        }
    }

    issues.sort_by_key(|i| {
        (
            Reverse(i.hours_at_risk().get()),
            i.kind_rank(),
            i.subject_key(),
        )
    });
    issues
}
