//! Issues: planned work the platform can show is in trouble.
//!
//! The register says what is planned, where and when. The engine says whether a
//! space refuses work at an instant. Neither alone can say the sentence a
//! planner actually acts on — **this activity cannot execute as planned** —
//! because that sentence is a join: the activity's compartment, evaluated over
//! the activity's planned window. It is the platform's second novel derivation,
//! after stranded hours, and this crate is where it lives.
//!
//! # Why the answer is exact, not sampled
//!
//! [`wadl_engine::evaluate`] is a pure function of its inputs, and for a fixed
//! hull its verdict over time is **piecewise constant**: a rule's trace line
//! exists exactly while its hazard is raised and its hold (if timed) has not
//! expired. So a refusal can only *begin* at a hazard's raise instant — an
//! expiry ends a hold, it never starts one. A refusal that overlaps the planned
//! window is therefore visible either at the window's start (it began before)
//! or at some hazard's `since` inside the window (it began there). Evaluating at
//! exactly those instants decides the whole window — no sampling interval to
//! tune, no refusal that can slip between samples.
//!
//! # What an issue is not
//!
//! A refusal found here is a fact about the plan, not a command: the platform
//! reports the activity, the instant, and the governing hold, and a planner
//! decides whether to re-sequence the work or clear the hold. The route to
//! "what would clear it" is `wadl-mitigate`'s counterfactual machinery, keyed
//! by the same compartment this crate names.

#![forbid(unsafe_code)]
// See wadl-domain: doc_markdown fires on domain acronyms; allowed deliberately.
#![allow(clippy::doc_markdown)]

use wadl_domain::compartment::CompartmentNo;
use wadl_domain::time::{Timestamp, Window};
use wadl_engine::{evaluate, AdjacencyGraph, DecisionState, EvaluationRequest, Hazard, RuleSet};

mod board;

pub use board::{derive, Issue, RegisterRow, ScheduleEdge, Stranding};

/// The engine's inputs for one hull, borrowed together.
///
/// The same triple every counterfactual is computed against; carried as one
/// value so a caller cannot pair the hazards of one instant with the rules of
/// another.
#[derive(Clone, Copy)]
pub struct Hull<'a> {
    /// The hull's resolved adjacency graph.
    pub graph: &'a AdjacencyGraph,
    /// The rules in force.
    pub rules: &'a RuleSet,
    /// The hazards live on the hull.
    pub hazards: &'a [Hazard],
}

/// The evidence that an activity cannot execute as planned: the first instant
/// in its window at which its space refuses work, and the hold that governs.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Refusal {
    /// The first instant inside the planned window shown to refuse work.
    pub at: Timestamp,
    /// The state the space is in at that instant.
    pub state: DecisionState,
    /// The rule that fired, e.g. `R03`.
    pub rule_code: String,
    /// Where the governing hazard is.
    pub origin: CompartmentNo,
    /// The governing hazard's label, as the trace renders it.
    pub hazard: String,
    /// Who may clear the condition.
    pub clearing_authority: String,
    /// When the hold expires on a clock, or `None` when it clears on
    /// verification — the same asymmetry every other surface reports.
    pub earliest_clear: Option<Timestamp>,
}

/// Why the executability question has no answer for this activity.
///
/// A visible state, not an error: scheduled work with no located compartment or
/// no dates is exactly what a planner needs surfaced, and "unknown" presented
/// as "fine" would be the register lying about its own coverage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Unassessable {
    /// No compartment is mapped, so there is no space to evaluate.
    Unlocated,
    /// No planned window, so there is no "as planned" to test against.
    Undated,
}

/// Whether an activity can execute as planned — the A4 derivation.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "verdict", rename_all = "snake_case")]
pub enum Executability {
    /// The space permits work at every instant of the planned window.
    Executable,
    /// The space refuses work somewhere in the planned window; here is where,
    /// and what holds it.
    NotExecutable(Refusal),
    /// The question cannot be answered from the register's own data.
    Unassessable {
        /// What is missing.
        reason: Unassessable,
    },
}

impl Executability {
    /// Whether this verdict is a positive claim of trouble.
    #[must_use]
    pub const fn is_refused(&self) -> bool {
        matches!(self, Self::NotExecutable(_))
    }
}

/// Evaluates one activity's compartment over its planned window.
///
/// The instants checked are the window start plus every hazard raise instant
/// inside the window — exactly the instants a refusal can begin at, per the
/// piecewise-constancy argument in the crate docs. The first refusal found is
/// returned with its governing hold; the search stops there because one
/// counter-instant already settles "as planned".
#[must_use]
pub fn executability(
    hull: &Hull<'_>,
    compartment: Option<&CompartmentNo>,
    planned: Option<Window>,
) -> Executability {
    let Some(subject) = compartment else {
        return Executability::Unassessable {
            reason: Unassessable::Unlocated,
        };
    };
    let Some(window) = planned else {
        return Executability::Unassessable {
            reason: Unassessable::Undated,
        };
    };
    let mut instants = vec![window.start];
    instants.extend(
        hull.hazards
            .iter()
            .map(|h| h.since)
            .filter(|since| *since > window.start && window.contains(*since)),
    );
    instants.sort_unstable();
    instants.dedup();
    for at in instants {
        let decision = evaluate(&EvaluationRequest {
            subject,
            graph: hull.graph,
            rules: hull.rules,
            hazards: hull.hazards,
            at,
        });
        if decision.permits_work() {
            continue;
        }
        // A refused state always comes from a trace line; the fallback covers
        // the impossible case without unwrapping, and names the subject so the
        // refusal still points somewhere real.
        let refusal = decision.governing_step().map_or_else(
            || Refusal {
                at,
                state: decision.state,
                rule_code: String::new(),
                origin: subject.clone(),
                hazard: String::new(),
                clearing_authority: String::new(),
                earliest_clear: decision.earliest_clear,
            },
            |step| Refusal {
                at,
                state: decision.state,
                rule_code: step.rule_code.clone(),
                origin: step.source.clone(),
                hazard: step.hazard.clone(),
                clearing_authority: step.clearing_authority.clone(),
                earliest_clear: step.earliest_clear,
            },
        );
        return Executability::NotExecutable(refusal);
    }
    Executability::Executable
}

/// The earliest window of the same duration in which the space would permit
/// the work — the schedule alternative this tool may honestly propose.
///
/// A CVN availability's business rules are the rule set itself (hot work
/// against coating cures, energized-bus adjacency, tank certification…), so
/// the only honest way to propose a re-sequence is to ask the same engine the
/// refusal came from: start at the planned window; when it refuses, jump the
/// cursor to the governing hold's own `earliest_clear` and ask again, until a
/// window passes or the availability runs out. Three outcomes, none of them a
/// guess:
///
/// * [`Alternative::Viable`] — a date-certain window the rules permit.
/// * [`Alternative::VerificationGated`] — the governing hold clears only on a
///   named authority's verification, so no date can be promised; the honest
///   proposal is the action, not a date.
/// * [`Alternative::NoWindow`] — nothing of this duration fits before the
///   horizon.
///
/// This PROPOSES; re-sequencing happens in P6 and deciding happens on the
/// space's options panel. Nothing here mutates anything.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Alternative {
    /// A window of the same duration the rules permit, starting at the
    /// earliest instant the governing holds allow.
    Viable {
        /// The proposed window.
        window: Window,
        /// How far the work slides, in whole hours.
        delay_hours: i64,
    },
    /// The governing hold names no clearing instant — only an authority.
    VerificationGated {
        /// The refusal that gates the slide, with its clearing authority.
        refusal: Refusal,
    },
    /// No window of this duration fits before the horizon.
    NoWindow {
        /// The horizon that ran out — the availability's end.
        horizon: Timestamp,
    },
}

/// See [`Alternative`]. `horizon` is the availability's end: proposing work
/// after the ship has sailed would not be an alternative.
#[must_use]
pub fn earliest_viable_window(
    hull: &Hull<'_>,
    compartment: &CompartmentNo,
    planned: Window,
    horizon: Timestamp,
) -> Alternative {
    let duration = planned.end.epoch_millis() - planned.start.epoch_millis();
    let mut cursor = planned.start;
    // The walk is bounded by the number of distinct holds on the hull (each
    // step consumes at least one earliest_clear); the cap only guards a
    // malformed world from hanging the request.
    for _ in 0..32 {
        let candidate = Window::new(
            cursor,
            Timestamp::from_epoch_millis(cursor.epoch_millis() + duration),
        );
        if candidate.end > horizon {
            return Alternative::NoWindow { horizon };
        }
        match executability(hull, Some(compartment), Some(candidate)) {
            Executability::Executable => {
                return Alternative::Viable {
                    window: candidate,
                    delay_hours: (cursor.epoch_millis() - planned.start.epoch_millis()) / 3_600_000,
                }
            }
            Executability::NotExecutable(refusal) => match refusal.earliest_clear {
                // Advance to the hold's own clearing instant — and always by
                // at least a minute, so a stale earliest_clear cannot pin the
                // cursor in place.
                Some(clear) => {
                    cursor = Timestamp::from_epoch_millis(
                        clear.epoch_millis().max(cursor.epoch_millis() + 60_000),
                    );
                }
                None => return Alternative::VerificationGated { refusal },
            },
            // Unreachable with a located, dated activity; answered honestly
            // rather than unwrapped.
            Executability::Unassessable { .. } => return Alternative::NoWindow { horizon },
        }
    }
    Alternative::NoWindow { horizon }
}
