//! The governing constraint — the one compartment pacing a package.
//!
//! There are **two different kinds of pacing item and they must not be
//! conflated**, because a planner acts on them differently:
//!
//! * An **authorization constraint** — a rule refuses the work. Someone named
//!   must clear a condition, and there is usually a window when that happens.
//!   Adding crew does nothing.
//! * A **completion constraint** — nothing refuses the work; there is simply
//!   work left, and downstream test scope is waiting on it. There is no
//!   earliest-clear time, because nothing has to be cleared. Adding crew helps.
//!
//! A surface that shows both as "blocked" sends a planner to argue with a marine
//! chemist about a manpower problem, or to add crew to a space nobody may enter.

use wadl_domain::compartment::CompartmentNo;
use wadl_domain::time::Timestamp;
use wadl_domain::units::ManHours;
use wadl_engine::{Decision, DecisionState};

use crate::package::{Analysis, Stranding};

/// Why a compartment is pacing the package.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConstraintKind {
    /// A rule refuses the work here. Clearing it is somebody's job, not a matter
    /// of effort.
    Authorization {
        /// The governing decision state.
        state: DecisionState,
        /// The rule codes that fired.
        rules: Vec<String>,
        /// Who may clear the condition.
        clearing_authority: String,
        /// The earliest the hold could lift, where the rule is time-bounded.
        /// `None` means it clears on verification, not on a clock.
        earliest_clear: Option<Timestamp>,
    },
    /// Nothing refuses the work; there is simply work outstanding. Deliberately
    /// carries **no** earliest-clear: there is nothing to clear.
    Completion,
}

/// The compartment pacing the package, and what it is holding.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct GoverningConstraint {
    /// The pacing compartment.
    pub compartment: CompartmentNo,
    /// Which kind of hold it is.
    pub constraint: ConstraintKind,
    /// Man-hours left in this compartment.
    pub own_remaining: ManHours,
    /// Man-hours downstream that cannot be tested until this compartment clears.
    pub stranded_downstream: ManHours,
    /// The downstream segment codes affected.
    pub downstream_segments: Vec<String>,
    /// A sentence a planner can act on, stating the consequence in hours.
    pub consequence: String,
}

/// Picks the governing constraint for a package.
///
/// Ranked by downstream stranding first — the hours *not* in the compartment are
/// what make the case — then by an authorization hold over a mere completion
/// hold at equal stranding (a refusal needs a different person and more lead
/// time), then by the compartment's own outstanding hours.
///
/// `authorization` supplies the engine's decision per compartment; a compartment
/// absent from it is treated as unrestricted. Returns `None` when nothing is
/// outstanding — a finished package has no pacing item.
#[must_use]
pub fn governing_constraint(
    analysis: &Analysis,
    authorization: &dyn Fn(&CompartmentNo) -> Option<Decision>,
) -> Option<GoverningConstraint> {
    let mut ranked: Vec<(&Stranding, Option<Decision>)> = analysis
        .stranding
        .iter()
        .map(|item| (item, authorization(&item.compartment)))
        .collect();

    ranked.sort_by(|a, b| {
        let restricted = |d: &Option<Decision>| d.as_ref().is_some_and(|d| !d.state.permits_work());
        b.0.stranded_downstream
            .cmp(&a.0.stranded_downstream)
            .then(restricted(&b.1).cmp(&restricted(&a.1)))
            .then(b.0.own_remaining.cmp(&a.0.own_remaining))
            .then(a.0.compartment.cmp(&b.0.compartment))
    });

    let (item, decision) = ranked.into_iter().next()?;
    let verb = &analysis.test_verb;

    // A decision only makes this an authorization constraint if it actually
    // restricts the work. An ALLOW with an empty trace is not a hold.
    let restricting = decision.filter(|d| d.state != DecisionState::Allow);
    let constraint = match &restricting {
        Some(d) => {
            let mut rules: Vec<String> = d.trace.iter().map(|s| s.rule_code.clone()).collect();
            rules.dedup();
            ConstraintKind::Authorization {
                state: d.state,
                rules,
                clearing_authority: d.trace.first().map_or_else(
                    || "unspecified".to_owned(),
                    |s| s.clearing_authority.clone(),
                ),
                earliest_clear: d.earliest_clear,
            }
        }
        None => ConstraintKind::Completion,
    };

    let consequence = if item.downstream_segments.is_empty() {
        format!(
            "{} remain in this compartment. No downstream segment depends on it.",
            item.own_remaining
        )
    } else {
        let plural = if item.downstream_segments.len() == 1 {
            ""
        } else {
            "s"
        };
        format!(
            "Holds {} downstream segment{} ({}) — {} that are not in this compartment cannot be {} until this one clears.",
            item.downstream_segments.len(),
            plural,
            item.downstream_segments.join(", "),
            item.stranded_downstream,
            verb
        )
    };

    Some(GoverningConstraint {
        compartment: item.compartment.clone(),
        constraint,
        own_remaining: item.own_remaining,
        stranded_downstream: item.stranded_downstream,
        downstream_segments: item.downstream_segments.clone(),
        consequence,
    })
}
