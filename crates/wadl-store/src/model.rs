//! Read models returned by the repositories.
//!
//! These are projections shaped for the surfaces that consume them, not the
//! storage rows. Every row that was ingested carries its provenance
//! (`source_ref`, `source_verified`) so the shell can say "seeded" when it is.

use wadl_domain::compartment::CompartmentNo;
use wadl_domain::ids::{VesselId, WorkOrderId};
use wadl_domain::units::ManHours;

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

/// One compartment's stranded hours and the compartment that is stranding them.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct StrandedItem {
    /// The compartment that is ready but blocked.
    pub compartment_no: CompartmentNo,
    /// The remaining man-hours stranded there.
    pub hours: ManHours,
    /// The *different* compartment upstream that is not complete.
    pub blocked_by: CompartmentNo,
}

/// The stranded-man-hours report for an availability — "the most persuasive
/// number in the product": hours in compartments that are ready but blocked by
/// a *different* compartment upstream.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct StrandedReport {
    /// The total stranded man-hours.
    pub total: ManHours,
    /// Per-compartment breakdown.
    pub items: Vec<StrandedItem>,
}
