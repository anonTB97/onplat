//! Loading an ingested schedule of record into the store.
//!
//! This is the mapping layer the P6 crosswalk describes: the ingest crate's
//! graded rows become the store's read models, and nothing downstream — the
//! register, Daily Ops, executability, the issue board — changes shape. It
//! lives in the API because this is the only place both vocabularies are in
//! scope; the store must not depend on the ingest crate, and the ingest crate
//! must not know how rows are served.
//!
//! The XER's wall clock is read in the hull's yard clock: P6 writes
//! server-local time with no zone, and the clock document is the yard's
//! statement of which zone that is. The schedule of record remembers the
//! clock it was parsed in, so a later clock change can say "re-import".

use wadl_domain::civil::YardClock;
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
        parsed_in: None,
    }
}

/// A parsed export: the schedule, and what its wall clock did not say plainly.
#[derive(Debug, Clone)]
pub struct ParsedSchedule {
    /// The schedule of record, stamped with the clock it was parsed in.
    pub sor: ScheduleOfRecord,
    /// Wall times the clock skipped or repeated, each with its line, what
    /// it was read as and the instant — findings, not rejections.
    pub wall_clock_findings: Vec<String>,
}

/// Parses an XER export in the hull's clock, without storing it. `parsed_in`
/// is the clock's name as the record will carry it
/// (`America/New_York · CVN73-clock.csv`).
///
/// # Errors
/// The rejection lines from the ingest, when any row could not be honestly
/// accepted — a schedule of record is all-or-nothing, because a partially
/// loaded schedule presenting as the whole one is exactly the lie the grading
/// exists to prevent.
pub fn parse_xer_in(
    label: &str,
    input: &str,
    clock: &YardClock,
    parsed_in: &str,
) -> Result<ParsedSchedule, String> {
    let report = wadl_ingest::xer::ingest_xer_in(input, label, clock);
    if !report.rejected.is_empty() {
        return Err(report
            .rejected
            .iter()
            .map(|r| format!("line {}: {}", r.row, r.reason))
            .collect::<Vec<_>>()
            .join("; "));
    }
    let mut sor = schedule_of_record(label, &report);
    sor.parsed_in = Some(parsed_in.to_owned());
    Ok(ParsedSchedule {
        sor,
        wall_clock_findings: report.wall_clock_findings,
    })
}

/// Parses an XER export with its wall clock read as UTC, without storing it.
/// The served path is [`parse_xer_in`] with the hull's clock; this stays for
/// a caller with no clock in hand.
///
/// # Errors
/// See [`parse_xer_in`].
pub fn parse_xer(label: &str, input: &str) -> Result<ScheduleOfRecord, String> {
    parse_xer_in(label, input, &YardClock::utc(), "UTC · default_utc").map(|p| p.sor)
}

/// What the boot loader loaded, for the banner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadedSchedule {
    /// Activities served.
    pub activities: usize,
    /// The clock the export's wall times were read in.
    pub parsed_in: String,
    /// See [`ParsedSchedule::wall_clock_findings`].
    pub wall_clock_findings: Vec<String>,
}

/// Parses an XER export in the hull's clock — the store's, read unscoped,
/// which is why the clock document loads before the export — and loads it
/// as the hull's schedule of record.
///
/// # Errors
/// See [`parse_xer_in`] — all-or-nothing, for the same reason.
pub fn load_xer(
    store: &InMemoryStore,
    vessel: VesselId,
    label: &str,
    input: &str,
) -> Result<LoadedSchedule, String> {
    let effect = crate::yard_clock::ClockInEffect::from_doc(store.yard_clock_doc_of(vessel));
    let parsed_in = effect.parsed_in();
    let parsed = parse_xer_in(label, input, &effect.clock, &parsed_in)?;
    let activities = parsed.sor.activities.len();
    store.load_schedule_of_record(vessel, parsed.sor);
    Ok(LoadedSchedule {
        activities,
        parsed_in,
        wall_clock_findings: parsed.wall_clock_findings,
    })
}
