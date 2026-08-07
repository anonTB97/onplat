//! Read models returned by the repositories.
//!
//! These are projections shaped for the surfaces that consume them, not the
//! storage rows. Every row that was ingested carries its provenance
//! (`source_ref`, `source_verified`) so the shell can say "seeded" when it is.

use wadl_domain::compartment::CompartmentNo;
use wadl_domain::ids::{VesselId, WorkOrderId};
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
    /// Athwartships side: `port`, `starboard` or `centreline`.
    pub side: String,
    /// Where the geometry came from — `register` when the class register stores
    /// it, `parsed` when it was read out of the placard number. A parsed
    /// position is a convenience for a scheme the platform understands, never a
    /// substitute for an authored register, and the surface labels it as such.
    pub geometry_source: String,
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
}

impl WorkOrderSummary {
    /// Remaining man-hours on this order.
    #[must_use]
    pub fn remaining_hours(&self) -> ManHours {
        self.budget_hours - self.earned_hours
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
