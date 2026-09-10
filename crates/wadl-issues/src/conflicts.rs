//! Work-on-work conflicts the schedule already plans: hot work beside a
//! flammable atmosphere, and more people into a space than it takes.
//!
//! Neither is the engine's question. The engine answers *may work proceed
//! here* from hazards, rules and the graph, and must not learn what is
//! scheduled — that seam is what keeps it pure. A hot-vs-flammable pair is
//! the **join of the schedule and the graph**: two activities the schedule of
//! record puts into the same yard day, in one space or across a coupling the
//! graph says carries heat or vapour. That join is what this crate already is,
//! so the derivation lives here, beside the executability join.
//!
//! What classes an activity is the yard's trade taxonomy
//! ([`wadl_domain::trades`]) resolved by the caller onto each [`WorkRow`] as
//! [`WorkFlags`] — never a word list in this crate. What joins two spaces is
//! the coupling edge's own `propagates`: an `electrical_bus` carries
//! `Energy` only and is not a path for flame and vapour; the graph says so,
//! and nothing here knows the code's name.

use std::collections::HashMap;

use wadl_domain::compartment::CompartmentNo;
use wadl_domain::time::Window;
use wadl_domain::trades::WorkFlags;
use wadl_domain::units::ManHours;
use wadl_engine::coupling::Propagation;
use wadl_engine::AdjacencyGraph;

use crate::Issue;

/// One located row of the schedule, with its work type resolved.
///
/// Located on purpose: an unlocated activity cannot be beside anything, and
/// the caller (which owns the register) decides what to do with those rows.
#[derive(Debug, Clone, Copy)]
pub struct WorkRow<'a> {
    /// Scheduler's activity code, e.g. `A4020`.
    pub code: &'a str,
    /// Activity name.
    pub name: &'a str,
    /// The trade doing the work, as the export carries it.
    pub trade: &'a str,
    /// The resolved work type, if either the field map or the taxonomy
    /// names one.
    pub work_type: Option<&'a str>,
    /// The work type's flags, from the taxonomy.
    pub flags: WorkFlags,
    /// Where the work is.
    pub compartment: &'a CompartmentNo,
    /// When, if the schedule says. Undated work rides every instant — the
    /// product's standing convention — and is reported as such.
    pub planned: Option<Window>,
    /// Man-hours still to do; a finished row is skipped.
    pub remaining: ManHours,
}

/// One space with its occupancy tolerance for the day.
#[derive(Debug, Clone, Copy)]
pub struct SpaceRow<'a> {
    /// The space.
    pub compartment: &'a CompartmentNo,
    /// Its register category, when the register says.
    pub category: Option<&'a str>,
    /// How many people it takes for a shift — the taxonomy's answer for
    /// the category.
    pub tolerance: u32,
}

/// The inputs both conflict derivations read, borrowed together.
#[derive(Debug, Clone, Copy)]
pub struct Conflicts<'a> {
    /// The located, resolved schedule rows.
    pub rows: &'a [WorkRow<'a>],
    /// The spaces with their tolerances; a row in a space not listed here
    /// cannot crowd it (no tolerance, no claim).
    pub spaces: &'a [SpaceRow<'a>],
    /// The yard's day: `[clock.day_start(at), clock.next_day_start(at))`.
    pub day: Window,
    /// The shift length people are counted over — the longest shift in the
    /// yard's clock (8 under the UTC default). Zero derives no crowding.
    pub shift_hours: u32,
    /// The most pairs served; the rest are counted as dropped.
    pub pair_cap: usize,
}

/// One end of a hot-vs-flammable pair: the activity as the pair names it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ConflictEnd {
    /// The activity code.
    pub code: String,
    /// Its name.
    pub name: String,
    /// The trade.
    pub trade: String,
    /// The resolved work type, if any.
    pub work_type: Option<String>,
    /// The space it is planned into.
    pub space: CompartmentNo,
}

impl ConflictEnd {
    fn of(row: &WorkRow<'_>) -> Self {
        Self {
            code: row.code.to_owned(),
            name: row.name.to_owned(),
            trade: row.trade.to_owned(),
            work_type: row.work_type.map(str::to_owned),
            space: row.compartment.clone(),
        }
    }
}

/// Whether a row is live in the day: unfinished, and either undated or
/// overlapping the day.
fn in_day(row: &WorkRow<'_>, day: Window) -> bool {
    row.remaining > ManHours::ZERO && row.planned.is_none_or(|w| w.overlaps(day))
}

/// The intersection of two windows, or `None` when they share no instant.
fn intersect(a: Window, b: Window) -> Option<Window> {
    let start = a.start.max(b.start);
    let end = a.end.min(b.end);
    (start < end).then(|| Window::new(start, end))
}

/// The spaces one hop from `space` across an edge that carries heat or
/// vapour, with the coupling code that carries it — first code wins where
/// two couplings join the same pair.
fn heat_or_vapour_paths<'g>(
    graph: &'g AdjacencyGraph,
    space: &'g CompartmentNo,
) -> HashMap<&'g CompartmentNo, &'g str> {
    let mut out = HashMap::new();
    for edge in graph
        .out_edges(space)
        .filter(|e| e.carries(Propagation::Heat) || e.carries(Propagation::Vapour))
    {
        out.entry(&edge.to).or_insert(edge.code.as_str());
    }
    out
}

/// Every (ignition-source row, flammable-atmosphere row) planned into the
/// day, in the same space (`via: "same space"`) or across one coupling in
/// either direction whose `propagates` carries heat or vapour (`via:` the
/// coupling code). One hop — a cure that outlasts the shift is a hazard and
/// the rules engine's, not this derivation's. `pair_cap` bounds the list;
/// the second value is how many pairs it dropped.
///
/// `hours_at_risk` is the smaller remaining of the pair: the least work that
/// must move to separate them. `overlap` is the two windows' common span
/// inside the day when both are dated and share an instant; `None` when
/// either is undated (rides every instant) or they share the day but not an
/// hour.
#[must_use]
pub fn hot_vs_flammable(graph: &AdjacencyGraph, c: &Conflicts<'_>) -> (Vec<Issue>, usize) {
    let live: Vec<&WorkRow<'_>> = c.rows.iter().filter(|r| in_day(r, c.day)).collect();
    let hot: Vec<&WorkRow<'_>> = live
        .iter()
        .copied()
        .filter(|r| r.flags.ignition_source)
        .collect();
    let flammable: Vec<&WorkRow<'_>> = live
        .iter()
        .copied()
        .filter(|r| r.flags.flammable_atmosphere)
        .collect();
    let mut paths: HashMap<&CompartmentNo, HashMap<&CompartmentNo, &str>> = HashMap::new();
    for row in hot.iter().chain(flammable.iter()) {
        paths
            .entry(row.compartment)
            .or_insert_with(|| heat_or_vapour_paths(graph, row.compartment));
    }
    let via_of = |h: &WorkRow<'_>, f: &WorkRow<'_>| -> Option<String> {
        if h.compartment == f.compartment {
            return Some("same space".to_owned());
        }
        paths
            .get(h.compartment)
            .and_then(|p| p.get(f.compartment))
            .or_else(|| paths.get(f.compartment).and_then(|p| p.get(h.compartment)))
            .map(|code| (*code).to_owned())
    };

    let mut issues = Vec::new();
    let mut dropped = 0usize;
    for h in &hot {
        for f in &flammable {
            if h.code == f.code {
                continue;
            }
            let Some(via) = via_of(h, f) else {
                continue;
            };
            if issues.len() >= c.pair_cap {
                dropped += 1;
                continue;
            }
            let overlap = match (h.planned, f.planned) {
                (Some(a), Some(b)) => intersect(a, b).and_then(|w| intersect(w, c.day)),
                _ => None,
            };
            issues.push(Issue::HotVsFlammable {
                hot: ConflictEnd::of(h),
                flammable: ConflictEnd::of(f),
                compartment: h.compartment.clone(),
                via,
                overlap,
                hours_at_risk: h.remaining.min(f.remaining),
            });
        }
    }
    (issues, dropped)
}

/// A dated row's hours inside the day, in thousandths of an hour:
/// `remaining × |planned ∩ day| / |planned|`, floored. Fixed point so a
/// space of many short rows does not lose each one to rounding.
fn milli_hours_in_day(row: &WorkRow<'_>, day: Window) -> Option<i128> {
    let w = row.planned?;
    let overlap = i128::from(w.end.min(day.end).epoch_millis())
        - i128::from(w.start.max(day.start).epoch_millis());
    let span = i128::from(w.end.epoch_millis()) - i128::from(w.start.epoch_millis());
    if overlap <= 0 || span <= 0 {
        return None;
    }
    Some(i128::from(row.remaining.get()) * 1000 * overlap / span)
}

/// Per space: `people = ceil(Σ hours_in_day / shift_hours)` over the day's
/// dated rows, an issue when `people > tolerance`. Undated rows contribute
/// nothing — a headcount needs a date — and are reported as `undated_rows`.
/// `hours_at_risk` is what does not fit: `Σ hours_in_day − tolerance ×
/// shift_hours`, floored at zero.
#[must_use]
pub fn crowding(c: &Conflicts<'_>) -> Vec<Issue> {
    if c.shift_hours == 0 {
        return Vec::new();
    }
    let mut by_space: HashMap<&CompartmentNo, Vec<&WorkRow<'_>>> = HashMap::new();
    for row in c.rows.iter().filter(|r| in_day(r, c.day)) {
        by_space.entry(row.compartment).or_default().push(row);
    }
    let shift_milli = i128::from(c.shift_hours) * 1000;
    let mut issues = Vec::new();
    for space in c.spaces {
        let Some(rows) = by_space.get(space.compartment) else {
            continue;
        };
        let mut milli_hours: i128 = 0;
        let mut activities = Vec::new();
        let mut undated_rows = 0usize;
        for row in rows {
            match milli_hours_in_day(row, c.day) {
                Some(mh) => {
                    milli_hours = milli_hours.saturating_add(mh);
                    activities.push(row.code.to_owned());
                }
                None if row.planned.is_none() => undated_rows += 1,
                None => {}
            }
        }
        let people =
            u32::try_from((milli_hours + shift_milli - 1) / shift_milli).unwrap_or(u32::MAX);
        if people <= space.tolerance {
            continue;
        }
        let hours_in_day = i64::try_from(milli_hours / 1000).unwrap_or(i64::MAX);
        let fits = i64::from(space.tolerance).saturating_mul(i64::from(c.shift_hours));
        issues.push(Issue::Crowding {
            compartment: space.compartment.clone(),
            category: space.category.map(str::to_owned),
            people,
            tolerance: space.tolerance,
            activities,
            undated_rows,
            hours_at_risk: ManHours::new(hours_in_day.saturating_sub(fits).max(0)),
        });
    }
    issues
}
