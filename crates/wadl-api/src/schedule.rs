//! Loading an ingested schedule of record into the store.
//!
//! This is the mapping layer the P6 crosswalk describes: the ingest crate's
//! graded rows become the store's read models, and nothing downstream — the
//! register, Daily Ops, executability, the issue board — changes shape. It
//! lives in the API because this is the only place both vocabularies are in
//! scope; the store must not depend on the ingest crate, and the ingest crate
//! must not know how rows are served.

use wadl_domain::ids::{ActivityId, VesselId};
use wadl_ingest::xer::{XerIngestReport, XerStatus};
use wadl_ingest::Reliability as IngestReliability;
use wadl_store::memory::{InMemoryStore, ScheduleOfRecord};
use wadl_store::model::{ActivityStatus, ActivitySummary, Reliability, ScheduleEdgeSummary};

/// Converts an ingest report into a schedule of record ready to serve.
#[must_use]
pub fn schedule_of_record(label: &str, report: &XerIngestReport) -> ScheduleOfRecord {
    let activities = report
        .activities
        .iter()
        .enumerate()
        .map(|(i, a)| ActivitySummary {
            // Deterministic ids in a range the demo generators never mint, so
            // an ingested row cannot collide with a generated one mid-swap.
            activity_id: ActivityId::from_uuid(uuid::Uuid::from_u128(0xB000_0000_u128 + i as u128)),
            code: a.code.clone(),
            name: a.name.clone(),
            work_order_code: a.work_order_code.clone(),
            compartment_no: a.compartment_no.clone(),
            compartment_reliability: match a.compartment_reliability {
                IngestReliability::High => Reliability::High,
                IngestReliability::Medium => Reliability::Medium,
                // Theatre exists only for demonstration data; served, it gets
                // the lowest trust a register can express.
                IngestReliability::Low | IngestReliability::Theatre => Reliability::Low,
            },
            wbs_area: a.wbs_area.clone(),
            trade: a.trade.clone(),
            planned: a.planned,
            budget_hours: a.budget_hours,
            earned_hours: a.earned_hours,
            status: match a.status {
                XerStatus::NotStarted => ActivityStatus::NotStarted,
                XerStatus::InProgress => ActivityStatus::InProgress,
                XerStatus::Complete => ActivityStatus::Complete,
            },
            is_milestone: a.is_milestone,
            source_ref: a.source_ref.clone(),
        })
        .collect();
    let edges = report
        .relationships
        .iter()
        .map(|r| ScheduleEdgeSummary {
            pred_code: r.pred.clone(),
            succ_code: r.succ.clone(),
            kind: r.kind.clone(),
            lag_hours: r.lag_hours,
        })
        .collect();
    ScheduleOfRecord {
        label: label.to_owned(),
        activities,
        edges,
    }
}

/// Parses an XER export into a schedule of record, without storing it.
///
/// # Errors
/// The rejection lines from the ingest, when any row could not be honestly
/// accepted — a schedule of record is all-or-nothing, because a partially
/// loaded schedule presenting as the whole one is exactly the lie the grading
/// exists to prevent.
pub fn parse_xer(label: &str, input: &str) -> Result<ScheduleOfRecord, String> {
    let report = wadl_ingest::xer::ingest_xer(input, label);
    if !report.rejected.is_empty() {
        return Err(report
            .rejected
            .iter()
            .map(|r| format!("line {}: {}", r.row, r.reason))
            .collect::<Vec<_>>()
            .join("; "));
    }
    Ok(schedule_of_record(label, &report))
}

/// Parses an XER export and loads it as a hull's schedule of record.
///
/// # Errors
/// See [`parse_xer`] — all-or-nothing, for the same reason.
pub fn load_xer(
    store: &InMemoryStore,
    vessel: VesselId,
    label: &str,
    input: &str,
) -> Result<usize, String> {
    let sor = parse_xer(label, input)?;
    let count = sor.activities.len();
    store.load_schedule_of_record(vessel, sor);
    Ok(count)
}
