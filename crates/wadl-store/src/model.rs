//! Read models returned by the repositories.
//!
//! These are projections shaped for the surfaces that consume them, not the
//! storage rows. Every row that was ingested carries its provenance
//! (`source_ref`, `source_verified`) so the shell can say "seeded" when it is.

use wadl_domain::compartment::CompartmentNo;
use wadl_domain::ids::{ActivityId, VesselId, WorkOrderId};
use wadl_domain::time::{Timestamp, Window};
use wadl_domain::units::ManHours;

/// A deck level, ordered. `ordinal` ascends *downward*, which is what makes
/// "the space directly above" a comparison rather than a guess at a label.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DeckSummary {
    /// Deck code as printed, e.g. `03`, `Main`, `4th`.
    pub code: String,
    /// Human label, e.g. `Fourth Deck`.
    pub label: String,
    /// Ordering key, ascending downward.
    pub ordinal: i32,
    /// How many compartments in the register sit on this deck.
    pub compartment_count: usize,
}

/// A hull as it appears in the portfolio and breadcrumb.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct VesselSummary {
    /// Primary key.
    pub vessel_id: VesselId,
    /// Hull number, e.g. `CVN-73`.
    pub hull_no: String,
    /// Ship name.
    pub name: String,
    /// Class code, e.g. `CVN-68`.
    pub class_code: String,
    /// The current availability code, e.g. `PIA-26`.
    pub availability_code: String,
    /// Planner-facing confidence label from the prototype: `At Risk`,
    /// `On Track`, `Planning`.
    pub confidence: String,
    /// The availability window this hull is in.
    ///
    /// It is the domain of every as-of question about the hull. An instant
    /// outside it is refused rather than answered: the hull has no hazards, no
    /// schedule and no rules on file for a date before the availability opened,
    /// so a decision there would be a confident statement about nothing.
    ///
    /// `None` when the availability carries no dates — the columns are nullable
    /// and a hull in planning may legitimately have neither. A hull with no
    /// window cannot be asked about another instant at all, which is the honest
    /// answer rather than inventing bounds to scrub between.
    pub availability: Option<Window>,
}

/// A compartment in the register, with its deck ordering so "directly above" is
/// computable by the caller.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct CompartmentSummary {
    /// Placard number.
    pub compartment_no: CompartmentNo,
    /// Human name.
    pub name: String,
    /// Deck code as printed.
    pub deck_code: String,
    /// Deck ordinal (ascending downward) — the reliable "above/below" key.
    pub deck_ordinal: i32,
    /// Zone label.
    pub zone: String,
    /// Category (decides secure status and hazard defaults).
    pub category: String,
    /// Longitudinal frame station, used to place the space fore-and-aft on a
    /// deck plan. `None` when the register does not carry it and the number
    /// cannot be parsed — the plan view must then say so rather than guess a
    /// position.
    pub frame: Option<i32>,
    /// Surveyed frame extent — forward and aft boundary — from an ingested
    /// geometry register. `None` until one is loaded; the plan then draws a
    /// pin, not a band. Overlaid by the API, so both stores serve it alike.
    pub fwd_frame: Option<i32>,
    /// See `fwd_frame`.
    pub aft_frame: Option<i32>,
    /// Athwartships side: `port`, `starboard` or `centreline`.
    pub side: String,
    /// Where the geometry came from — `register` when the class register stores
    /// it, `parsed` when it was read out of the placard number. A parsed
    /// position is a convenience for a scheme the platform understands, never a
    /// substitute for an authored register, and the surface labels it as such.
    pub geometry_source: String,
}

/// One space in an ingested compartment register — the yard's own list of
/// what the hull is made of, which until this document entered only as seed.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RegisterSpaceSummary {
    /// Placard number as printed.
    pub compartment_no: String,
    /// Human name.
    pub name: String,
    /// Deck code — must name a deck the same register carries.
    pub deck_code: String,
    /// Zone label.
    pub zone: String,
    /// Category (decides secure status and hazard defaults).
    pub category: String,
    /// Frame station when the register carries it; otherwise parsed from the
    /// placard where the numbering scheme allows, and labelled as a parse.
    #[serde(default)]
    pub frame: Option<i32>,
    /// `port`, `starboard` or `centreline` when the register carries it.
    #[serde(default)]
    pub side: Option<String>,
}

/// One deck in an ingested compartment register.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RegisterDeckSummary {
    /// Deck code as printed, e.g. `3rd`, `Main`, `03`.
    pub code: String,
    /// Human label.
    pub label: String,
    /// Ordering key, ascending downward — what "directly above" is read from.
    pub ordinal: i32,
}

/// One coupling in an ingested coupling register: a physical path a hazard
/// can travel between two spaces.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct CouplingRowSummary {
    /// The space the path starts in.
    pub from: String,
    /// The space it reaches.
    pub to: String,
    /// The coupling type's code — what rules bind to (`deck_penetration`, …).
    pub code: String,
    /// Store the reverse path too (a shared bulkhead has no preferred sense).
    #[serde(default)]
    pub symmetric: bool,
    /// `authored` when a person listed it, `derived` when the register door
    /// proposed it from deck order and frame overlap.
    #[serde(default = "authored")]
    pub provenance: String,
}

fn authored() -> String {
    "authored".to_owned()
}

/// A coupling type a hull's rules can bind to, as the store knows it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct CouplingTypeSummary {
    /// The traversal's type id — distinct per code.
    pub id: wadl_domain::ids::CouplingTypeId,
    /// The code rules bind to.
    pub code: String,
    /// What the coupling carries: `heat`, `vapour`, `energy`, `load`, `egress`.
    pub propagates: Vec<String>,
    /// How many hops the coupling type reaches at most.
    pub max_reach: u8,
}

/// One surveyed space in a geometry register: the compartment's true frame
/// extent, from a Compartment & Access drawing or the general plans. The
/// placard number encodes the FORWARD boundary, which is what makes a
/// disagreement between the two a computable finding rather than a mystery.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SpaceGeometrySummary {
    /// The placard number the row claims to survey.
    pub compartment_no: String,
    /// Forward boundary frame.
    pub fwd_frame: i32,
    /// Aft boundary frame (inclusive; `fwd <= aft`).
    pub aft_frame: i32,
}

/// One coverage band of a deck: the frame interval where the deck physically
/// exists. A deck may carry several bands; a platform that runs frames 60–180
/// is delineated as exactly that, and the plan shades the rest as "no deck
/// here" rather than "nothing scheduled".
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DeckCoverageSummary {
    /// The register's deck code, e.g. `3rd`.
    pub deck_code: String,
    /// Forward end of the band.
    pub lo_frame: i32,
    /// Aft end of the band (inclusive; `lo <= hi`).
    pub hi_frame: i32,
}

/// A work order with its provenance and, where distributed, its footprint.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct WorkOrderSummary {
    /// Primary key.
    pub work_order_id: WorkOrderId,
    /// WI / WO number.
    pub code: String,
    /// Title.
    pub title: String,
    /// Trade / shop.
    pub trade: String,
    /// System.
    pub system: String,
    /// The primary compartment.
    pub compartment_no: CompartmentNo,
    /// Budgeted man-hours.
    pub budget_hours: ManHours,
    /// Earned man-hours.
    pub earned_hours: ManHours,
    /// The document this row came from (provenance).
    pub source_ref: String,
    /// Whether the provenance has been confirmed by a planner.
    pub source_verified: bool,
    /// When the order is planned to be worked.
    ///
    /// `None` when the schedule of record does not say — see
    /// [`WorkOrderSummary::booked_at`] for why that is not treated as "never".
    pub planned: Option<Window>,
}

impl WorkOrderSummary {
    /// Remaining man-hours on this order.
    #[must_use]
    pub fn remaining_hours(&self) -> ManHours {
        self.budget_hours - self.earned_hours
    }

    /// Whether this order counts as booked at `at`.
    ///
    /// Undated orders count at every instant, matching
    /// [`wadl_plan::SpaceWork::booked_at`]. The two must agree: a compartment's
    /// hours come from both sources, and if one hid undated work while the other
    /// showed it, the deck plan and the work-order list would disagree about
    /// whether anybody is held up in that space.
    #[must_use]
    pub fn booked_at(&self, at: Timestamp) -> bool {
        self.planned.is_none_or(|w| w.contains(at))
    }
}

/// One compartment's outstanding work and what it is holding downstream.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct StrandedItem {
    /// The package this stranding belongs to.
    pub package_code: String,
    /// The compartment whose outstanding work is the cause.
    pub compartment_no: CompartmentNo,
    /// Man-hours left in this compartment.
    pub own_remaining: ManHours,
    /// Man-hours in *downstream* segments that cannot be tested until this
    /// compartment clears — hours this compartment does not contain.
    pub stranded_downstream: ManHours,
    /// The downstream segment codes affected.
    pub downstream_segments: Vec<String>,
}

/// The stranded-man-hours report for a hull — "the most persuasive number in the
/// product". Derived from real segment topology by [`wadl_plan`]: hours that
/// cannot be tested because a *different* compartment upstream is open.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct StrandedReport {
    /// The total stranded man-hours across every package on the hull.
    pub total: ManHours,
    /// Per-compartment breakdown, worst first.
    pub items: Vec<StrandedItem>,
}

/// A distributed package as it appears in a list.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PackageSummary {
    /// The work order this package is.
    pub work_order_id: WorkOrderId,
    /// WI / WO code.
    pub code: String,
    /// Package title.
    pub name: String,
    /// The system it belongs to.
    pub system: String,
    /// The lead trade. A distributed package *is* a work order, so it has one —
    /// and without it the trade lens is blind to exactly the work that spans
    /// compartments, which is the work most likely to be held up.
    pub trade: String,
    /// Segments in the package.
    pub segment_count: usize,
    /// Compartments in the footprint.
    pub compartment_count: usize,
    /// Total budgeted man-hours.
    pub budget_hours: ManHours,
    /// Total earned man-hours.
    pub earned_hours: ManHours,
}

/// How far an activity has actually got, per the schedule of record.
///
/// Mirrors P6's `status_code` (`TK_NotStart` / `TK_Active` / `TK_Complete`)
/// rather than inventing a richer lifecycle: the register reports what the
/// scheduler said, and anything the platform *derives* — executability, risk —
/// is kept separate so a derived judgement can never be mistaken for the
/// schedule's own claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityStatus {
    /// Not started.
    NotStarted,
    /// Started, not finished.
    InProgress,
    /// Finished.
    Complete,
}

/// How much a mapped field can be trusted, per the P6 crosswalk.
///
/// Carried per activity because the compartment mapping is the dominant risk of
/// any schedule import: a parsed value must never present as an authored one.
/// (The same grading lives in `wadl-ingest`; unifying the two enums is part of
/// the XER-ingest work, where the mapping actually happens.)
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reliability {
    /// Authored in a controlled field.
    High,
    /// Resolved through a convention that has been confirmed.
    Medium,
    /// Parsed or guessed — never to be presented as authored.
    Low,
}

/// One scheduled activity — the grain P6 plans at, and the row a foreman is
/// actually handed.
///
/// The register exists because an *issue*, properly, is an activity that cannot
/// execute as planned — and that is only detectable if the activities are in the
/// platform. Work orders are the accounting grain; activities are the doing
/// grain.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ActivitySummary {
    /// Primary key.
    pub activity_id: ActivityId,
    /// Scheduler's activity id, e.g. `A4020` — what a planner reads aloud.
    pub code: String,
    /// Activity name.
    pub name: String,
    /// The work order or package this activity belongs to.
    ///
    /// `None` is a **visible state, not an error**: scheduled work nobody has
    /// mapped onto a work item is exactly the gap a planner needs on a list,
    /// and hiding it would make the register look more reconciled than it is.
    pub work_order_code: Option<String>,
    /// The compartment the work happens in, where the mapping knows it.
    ///
    /// `None` with a low [`Self::compartment_reliability`] is the honest state
    /// for "the schedule did not say" — the dominant data risk of every P6
    /// import, so it is representable rather than papered over.
    pub compartment_no: Option<CompartmentNo>,
    /// How much to trust the compartment mapping.
    pub compartment_reliability: Reliability,
    /// The schedule's own top-level WBS bucket — a zone HINT at best, never a
    /// location. Yards habitually cut the top of the WBS by zone, so an
    /// unlocated activity often still says which zone it belongs to through
    /// where it sits in the tree. `None` for the generated register, which
    /// locates every row and needs no hints.
    pub wbs_area: Option<String>,
    /// The trade doing the work.
    pub trade: String,
    /// When it is planned. `None` when the schedule of record does not say.
    pub planned: Option<Window>,
    /// Budgeted man-hours.
    pub budget_hours: ManHours,
    /// Earned man-hours.
    pub earned_hours: ManHours,
    /// Where the schedule says it stands.
    pub status: ActivityStatus,
    /// A key event rather than work — carries dates and no hours.
    pub is_milestone: bool,
    /// Provenance: the document or run this row came from.
    pub source_ref: String,
}

impl ActivitySummary {
    /// Man-hours still to do. Never negative.
    #[must_use]
    pub fn remaining_hours(&self) -> ManHours {
        if self.earned_hours.get() >= self.budget_hours.get() {
            ManHours::ZERO
        } else {
            self.budget_hours - self.earned_hours
        }
    }

    /// Whether this activity is planned to be in progress at `at`. Undated
    /// activities count at every instant, on the same reasoning as
    /// [`WorkOrderSummary::booked_at`].
    #[must_use]
    pub fn booked_at(&self, at: Timestamp) -> bool {
        self.planned.is_none_or(|w| w.contains(at))
    }
}

/// One dependency edge from the schedule of record, at the activity grain.
///
/// The raw material of schedule-quality findings: a negative lag lets the
/// successor start before its predecessor finishes — legitimate as an overlap,
/// and exactly where cure-window inversions hide.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ScheduleEdgeSummary {
    /// Predecessor activity code.
    pub pred_code: String,
    /// Successor activity code.
    pub succ_code: String,
    /// Relationship kind as the scheduler writes it, e.g. `PR_FS`.
    pub kind: String,
    /// Lag in hours; negative means the successor starts early.
    pub lag_hours: i64,
}

/// One zone's authored frame bounds, from the yard's own zone chart.
///
/// Authored is the operative word: until a chart is ingested, every zone band
/// a view draws is *inferred* from the spaces assigned to the zone, and says
/// so. Once bounds arrive, the register's assignments can be checked against
/// them — a space whose frame falls outside its zone's authored bounds is a
/// finding about the data, and exactly the kind of disagreement the shading
/// exists to make visible.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ZoneBoundSummary {
    /// The zone, e.g. `Z5`.
    pub zone: String,
    /// The forward-most frame of the zone (inclusive).
    pub lo_frame: i32,
    /// The aft-most frame of the zone (inclusive).
    pub hi_frame: i32,
}

/// One work item's budget line from an ingested budget book.
///
/// One line of a manning book: the people a trade actually has for this
/// availability, per half-shift. The demand side (people a window's scheduled
/// hours imply) is computed from the register; THIS is the supply side, and it
/// only enters through the import door — the platform never invents a
/// headcount.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ManningCrewSummary {
    /// The trade, spelled the way the schedule spells it.
    pub trade: String,
    /// People available per half-shift.
    pub headcount: i64,
}

/// The reconciliation target, once a book is ingested: register hours are
/// compared against THESE budgets instead of the seeded work items'. The book
/// is the hours authority, not a work-order register — it does not replace
/// the operational work orders, it replaces what the register's hours are
/// held accountable to.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct BudgetItemSummary {
    /// WI / WO code, e.g. `WI-2201`.
    pub code: String,
    /// The item's title, as the book writes it.
    pub title: String,
    /// The owning trade.
    pub trade: String,
    /// Budgeted man-hours.
    pub budget_hours: ManHours,
    /// Earned man-hours.
    pub earned_hours: ManHours,
}

/// An append-only ledger record, as a surface reads it.
///
/// Hashes are hex rather than bytes because the only consumers are a JSON API and
/// `wadl verify-ledger`; neither wants a byte array, and hex survives a copy-paste
/// into a bug report.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct AuditRecord {
    /// Monotonic sequence.
    pub seq: i64,
    /// What was recorded, e.g. `MITIGATION_ACCEPTED`.
    pub action: String,
    /// The full record. Hashed, so this is the trusted content.
    pub detail: String,
    /// Denormalised lookup key — a compartment placard for a space-scoped entry.
    ///
    /// Outside the hash chain, so it is an index and not the record: the
    /// authoritative subject is inside `detail`.
    pub subject_ref: Option<String>,
    /// When it happened, epoch millis.
    pub occurred_at_ms: i64,
    /// This entry's hash, hex.
    pub entry_hash: String,
    /// The previous entry's hash, hex. `None` for the first entry.
    pub prev_hash: Option<String>,
}
