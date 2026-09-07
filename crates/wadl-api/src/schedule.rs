//! Loading an ingested schedule of record into the store.
//!
//! This is the mapping layer the P6 crosswalk describes: the ingest crate's
//! graded rows become the store's read models, and nothing downstream — the
//! register, Daily Ops, executability, the issue board — changes shape. It
//! lives in the API because this is the only place both vocabularies are in
//! scope; the store must not depend on the ingest crate, and the ingest crate
//! must not know how rows are served.
//!
//! Three things every path through here shares, door and boot alike:
//!
//! * **The file is read through the hull's field map and yard clock.** P6
//!   writes server-local time with no zone, and the clock document is the
//!   yard's statement of which zone that is; the map is the yard's statement
//!   of which fields carry the compartment, the work item, the work type and
//!   the trade. The record remembers both.
//! * **Rows are quarantined, not files.** The parser sets aside the rows it
//!   cannot honestly accept, with line and reason; the file is refused whole
//!   only when it is not a schedule export at all ([`whole_file_refusal`]).
//! * **Every load is a run.** [`build_run`] turns a parse into the
//!   [`ScheduleRun`] both stores record: the map, the encoding, who, when,
//!   the quarantine, the exclusions, the survey, and the document served.
//!
//! Activity ids are stable from `(hull, task_code)` ([`stable_activity_id`]),
//! so a re-baseline keeps every row's id and an open inspector survives it.

use sha2::{Digest, Sha256};

use wadl_domain::civil::YardClock;
use wadl_domain::ids::{ActivityId, VesselId};
use wadl_ingest::field_map::FieldMap;
use wadl_ingest::xer::{XerIngestReport, XerStatus};
use wadl_ingest::Reliability as IngestReliability;
use wadl_store::memory::{FieldMapDoc, InMemoryStore, ScheduleOfRecord};
use wadl_store::model::{
    ActivityStatus, ActivitySummary, ImportedBy, QuarantinedRow, Reliability, RunCounts,
    ScheduleEdgeSummary, ScheduleRun, ScheduleRunReport, ScheduleRunSummary,
};
use wadl_store::{Actor, ActorSource, Repositories, TenantScope};

/// A stable activity id from the hull and the scheduler's own code:
/// `sha256("wadl:activity:" ‖ hull uuid ‖ ":" ‖ task_code)`, first sixteen
/// bytes, version nibble `8` (a name-derived id that is not RFC 4122's v3 or
/// v5), RFC 4122 variant. Same hull and same code give the same id across
/// runs; a different hull gives a different id; and the `0xB…` range the
/// demo generators avoid is no longer needed, because a hash of a real code
/// cannot collide with a generated `0xAC…`/`0xAD…`/`0xAE…` id except by a
/// 2⁻¹²² accident.
#[must_use]
pub fn stable_activity_id(vessel: VesselId, code: &str) -> ActivityId {
    let mut hasher = Sha256::new();
    hasher.update(b"wadl:activity:");
    hasher.update(vessel.as_uuid().as_bytes());
    hasher.update(b":");
    hasher.update(code.as_bytes());
    let digest = hasher.finalize();
    let mut bytes = [0_u8; 16];
    for (dst, src) in bytes.iter_mut().zip(digest.iter()) {
        *dst = *src;
    }
    if let Some(b) = bytes.get_mut(6) {
        *b = (*b & 0x0F) | 0x80;
    }
    if let Some(b) = bytes.get_mut(8) {
        *b = (*b & 0x3F) | 0x80;
    }
    ActivityId::from_uuid(uuid::Uuid::from_bytes(bytes))
}

/// Converts an ingest report into a schedule of record ready to serve, with
/// ids stable from the hull and each row's code.
#[must_use]
pub fn schedule_of_record(
    vessel: VesselId,
    label: &str,
    report: &XerIngestReport,
) -> ScheduleOfRecord {
    let activities = report
        .activities
        .iter()
        .map(|a| ActivitySummary {
            activity_id: stable_activity_id(vessel, &a.code),
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
            work_type: a.work_type.clone(),
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

/// A parsed export: the schedule, and everything the parse said about the
/// file around it — the quarantine, the exclusions, the survey, the findings.
#[derive(Debug, Clone)]
pub struct ParsedSchedule {
    /// The schedule of record, stamped with the clock it was parsed in.
    pub sor: ScheduleOfRecord,
    /// The ingest report the schedule was made from.
    pub report: XerIngestReport,
}

/// How many reasons a whole-file refusal quotes before "…".
const REFUSAL_EXAMPLES: usize = 3;

/// Why a file is refused whole, when it is — the only three cases: the
/// parser would not hold it in memory (`MAX_CELLS`), it carries no `TASK`
/// section (not a schedule export), or not one activity survives the
/// quarantine and the map's exclusions. Everything else is served around
/// its quarantine. The text is the door's 422 detail and the boot's
/// refusal line.
#[must_use]
pub fn whole_file_refusal(report: &XerIngestReport) -> Option<String> {
    if let Some(r) = report
        .rejected
        .iter()
        .find(|r| r.class == "structure" && r.reason.contains("cells"))
    {
        return Some(format!("XER rejected: {}", r.reason));
    }
    if !report.has_task_section() {
        return Some(
            "XER rejected: the file carries no activities — no TASK section was found. \
             Is this a Primavera P6 XER export?"
                .to_owned(),
        );
    }
    if !report.activities.is_empty() {
        return None;
    }
    if report.task_rows == 0 {
        return Some(
            "XER rejected: the file carries no activities — its TASK section is empty. \
             Is this a Primavera P6 XER export?"
                .to_owned(),
        );
    }
    let mut reasons: Vec<String> = report
        .rejected
        .iter()
        .filter(|r| r.table == "TASK")
        .take(REFUSAL_EXAMPLES)
        .map(|r| format!("line {}: {}", r.row, r.reason))
        .collect();
    if !report.excluded_project.is_empty() {
        reasons.push(format!(
            "{} rows in projects the field map does not serve",
            report.excluded_project.len()
        ));
    }
    reasons.extend(
        report
            .findings
            .iter()
            .filter(|f| f.starts_with("projects:"))
            .take(1)
            .cloned(),
    );
    let excluded = report.excluded_loe.len() + report.excluded_wbs.len();
    if excluded > 0 {
        reasons.push(format!(
            "{excluded} level-of-effort or WBS-summary rows excluded from work"
        ));
    }
    let more = if report.rejected.len() > REFUSAL_EXAMPLES {
        " …"
    } else {
        ""
    };
    Some(format!(
        "XER rejected: every one of {} TASK rows was quarantined or excluded — {}{more}",
        report.task_rows,
        reasons.join("; ")
    ))
}

/// Parses an XER export through a field map in the hull's clock, without
/// storing it. `parsed_in` is the clock's name as the record will carry it
/// (`America/New_York · CVN73-clock.csv`).
///
/// # Errors
/// See [`whole_file_refusal`] — the three cases in which a file is refused
/// whole rather than served around its quarantine.
pub fn parse_xer_in(
    vessel: VesselId,
    label: &str,
    input: &str,
    map: &FieldMap,
    clock: &YardClock,
    parsed_in: &str,
) -> Result<ParsedSchedule, String> {
    let report = wadl_ingest::xer::ingest_xer_with(input, label, map, clock);
    if let Some(refusal) = whole_file_refusal(&report) {
        return Err(refusal);
    }
    let mut sor = schedule_of_record(vessel, label, &report);
    sor.parsed_in = Some(parsed_in.to_owned());
    Ok(ParsedSchedule { sor, report })
}

/// What one import counted, from the report.
#[must_use]
pub fn run_counts(report: &XerIngestReport) -> RunCounts {
    let key_events = report.activities.iter().filter(|a| a.is_milestone).count();
    RunCounts {
        task_rows: report.task_rows,
        served: report.activities.len(),
        work: report.activities.len() - key_events,
        key_events,
        quarantined: report.rejected.len(),
        excluded_loe: report.excluded_loe.len(),
        excluded_wbs: report.excluded_wbs.len(),
        excluded_project: report.excluded_project.len(),
        edges: report.relationships.len(),
        edges_quarantined: report
            .rejected
            .iter()
            .filter(|r| r.table == "TASKPRED")
            .count(),
        material_skipped: report.material_skipped,
        equipment_skipped: report.equipment_skipped,
    }
}

/// The quarantine as the run stores it.
#[must_use]
pub fn quarantine(report: &XerIngestReport) -> Vec<QuarantinedRow> {
    report
        .rejected
        .iter()
        .map(|r| QuarantinedRow {
            line: r.row,
            table: r.table.clone(),
            code: r.code.clone(),
            class: r.class.clone(),
            reason: r.reason.clone(),
        })
        .collect()
}

/// The run's report: the quarantine, the exclusions, the survey, and the
/// findings — the map's first, then the clock's.
#[must_use]
pub fn run_report(report: &XerIngestReport) -> ScheduleRunReport {
    ScheduleRunReport {
        quarantine: quarantine(report),
        excluded_loe: report.excluded_loe.clone(),
        excluded_wbs: report.excluded_wbs.clone(),
        excluded_project: report.excluded_project.clone(),
        fields_seen: serde_json::to_value(&report.fields_seen).unwrap_or_default(),
        findings: report
            .findings
            .iter()
            .chain(report.wall_clock_findings.iter())
            .cloned()
            .collect(),
    }
}

/// Who a run is imported by, from the scope it is committed under: the
/// tenant, the person the identity hop asserted (none when the binary acted
/// on its own account), and the door.
#[must_use]
pub fn imported_by(scope: &TenantScope, via: &str) -> ImportedBy {
    ImportedBy {
        org: scope.org,
        person: person_of(&scope.actor),
        via: via.to_owned(),
    }
}

/// The person on a run: the actor's id unless the actor is the process.
fn person_of(actor: &Actor) -> Option<String> {
    (actor.source != ActorSource::System).then(|| actor.id.clone())
}

/// What a run is built from besides the parse.
#[derive(Debug, Clone)]
pub struct RunInputs<'a> {
    /// The source label, e.g. `CVN73-PIA26-full.xer`.
    pub label: &'a str,
    /// `utf-8` or `windows-1252`.
    pub encoding: &'a str,
    /// `browser`, `server`, or `caller` for a text body that carried no hint.
    pub decoded_by: &'a str,
    /// Who, and through which door.
    pub imported_by: ImportedBy,
    /// When, epoch millis — the caller's clock.
    pub imported_at_ms: i64,
    /// The map the file was read through.
    pub field_map: &'a FieldMap,
}

/// The [`ScheduleRun`] a parse becomes: what both stores record and serve
/// in one write. `run_id` and `seq` are the store's to assign; `served`
/// is set on every read.
#[must_use]
pub fn build_run(parsed: &ParsedSchedule, inputs: &RunInputs<'_>) -> ScheduleRun {
    ScheduleRun {
        summary: ScheduleRunSummary {
            run_id: uuid::Uuid::nil(),
            seq: 0,
            label: inputs.label.to_owned(),
            imported_at_ms: inputs.imported_at_ms,
            imported_by: inputs.imported_by.clone(),
            encoding: inputs.encoding.to_owned(),
            decoded_by: inputs.decoded_by.to_owned(),
            projects_served: parsed.report.projects_served.clone(),
            counts: run_counts(&parsed.report),
            field_map: serde_json::to_value(inputs.field_map).unwrap_or_default(),
            served: false,
            schema_version: wadl_store::DOCUMENT_SCHEMA_VERSION,
        },
        report: run_report(&parsed.report),
        doc: Some(parsed.sor.clone()),
    }
}

/// The map a stored document puts in effect, or the default when there is
/// none — and which of the two it was, for the response and the banner.
///
/// # Errors
/// A stored document that does not parse as a map (it was validated on the
/// way in, so this is a store that was written around the door).
pub fn field_map_in_effect(
    doc: Option<&FieldMapDoc>,
) -> Result<(FieldMap, Option<String>), String> {
    match doc {
        Some(doc) => {
            let map: FieldMap = serde_json::from_value(doc.map.clone())
                .map_err(|e| format!("field map {}: {e}", doc.label))?;
            map.validate()
                .map_err(|problems| format!("field map {}: {}", doc.label, problems.join("; ")))?;
            Ok((map, Some(doc.label.clone())))
        }
        None => Ok((FieldMap::default(), None)),
    }
}

/// What a load of an export did, for the banner and the CLI's line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadedSchedule {
    /// Activities served.
    pub activities: usize,
    /// The clock the export's wall times were read in.
    pub parsed_in: String,
    /// Wall times the clock skipped or repeated, each with its line, what
    /// it was read as and the instant — findings, not rejections.
    pub wall_clock_findings: Vec<String>,
    /// `utf-8`, `utf-8 (byte-order mark stripped)` or `windows-1252`.
    pub encoding: String,
    /// The field map's label, or `None` for the default.
    pub field_map_label: Option<String>,
    /// The rows set aside, one line each: `line 44 · A4021 · unparseable …`.
    pub quarantine: Vec<String>,
    /// The map's findings against the file.
    pub findings: Vec<String>,
    /// The run as recorded — `seq` 1 on a fresh hull; `seq` 0 on a dry run,
    /// which records nothing.
    pub run: ScheduleRunSummary,
    /// The `SCHEDULE_REPLACED` ledger row's `seq`, when one was written.
    pub ledger_seq: Option<i64>,
}

/// The banner's view of a parse and the run it became.
fn loaded_schedule(
    parsed: &ParsedSchedule,
    encoding: wadl_ingest::encoding::Encoding,
    field_map_label: Option<String>,
    run: ScheduleRunSummary,
    ledger_seq: Option<i64>,
) -> LoadedSchedule {
    LoadedSchedule {
        activities: parsed.sor.activities.len(),
        parsed_in: parsed.sor.parsed_in.clone().unwrap_or_default(),
        wall_clock_findings: parsed.report.wall_clock_findings.clone(),
        encoding: encoding.describe().to_owned(),
        field_map_label,
        quarantine: parsed
            .report
            .rejected
            .iter()
            .map(|r| {
                format!(
                    "line {} · {} · {}",
                    r.row,
                    r.code.as_deref().unwrap_or(r.table.as_str()),
                    r.reason
                )
            })
            .collect(),
        findings: parsed.report.findings.clone(),
        run,
        ledger_seq,
    }
}

/// Reads an export's bytes in the hull's clock and through its field map —
/// both the store's, read unscoped, which is why the documents load before
/// the export — and records the load as a boot run at `now_ms`, served. A
/// quarantine at boot is reported and the rest is served, as the door would.
/// Memory-only and unledgered; the boot path and the CLI use [`commit_xer`].
///
/// # Errors
/// See [`whole_file_refusal`]; a hull the store does not carry; a stored
/// field map that will not parse.
pub fn load_xer(
    store: &InMemoryStore,
    vessel: VesselId,
    label: &str,
    bytes: &[u8],
    now_ms: i64,
) -> Result<LoadedSchedule, String> {
    let org = store
        .org_of(vessel)
        .ok_or_else(|| format!("hull {vessel} is not one this store carries"))?;
    let (text, encoding) = wadl_ingest::encoding::decode_xer(bytes);
    let (map, field_map_label) = field_map_in_effect(store.field_map_of(vessel).as_ref())?;
    let effect = crate::yard_clock::ClockInEffect::from_doc(store.yard_clock_doc_of(vessel));
    let parsed_in = effect.parsed_in();
    let parsed = parse_xer_in(vessel, label, &text, &map, &effect.clock, &parsed_in)?;
    let run = build_run(
        &parsed,
        &RunInputs {
            label,
            encoding: encoding.label(),
            decoded_by: wadl_ingest::encoding::DECODED_BY_SERVER,
            imported_by: ImportedBy {
                org,
                person: None,
                via: "boot".to_owned(),
            },
            imported_at_ms: now_ms,
            field_map: &map,
        },
    );
    let summary = store
        .load_schedule_run(vessel, run)
        .map_err(|e| e.to_string())?;
    Ok(loaded_schedule(
        &parsed,
        encoding,
        field_map_label,
        summary,
        None,
    ))
}

/// One export to commit through the scoped path — the boot loader's and the
/// CLI's, on either store.
#[derive(Debug, Clone, Copy)]
pub struct XerLoad<'a> {
    /// The source label, e.g. `CVN73-PIA26-full.xer`.
    pub label: &'a str,
    /// The file's bytes, decoded here (UTF-8 or Windows-1252).
    pub bytes: &'a [u8],
    /// `boot`, `cli` or `test` — on the run and on the ledger row.
    pub via: &'a str,
    /// The commit instant, epoch millis — the caller's clock.
    pub now_ms: i64,
    /// Parse and report; record and ledger nothing.
    pub dry_run: bool,
}

/// Commits an export as the hull's schedule of record exactly as the door
/// does, on any store and under a scope: decoded here, read through the
/// hull's stored field map and in its yard clock, recorded as a run with
/// `imported_by { org, person, via }` and served, and ledgered
/// `SCHEDULE_REPLACED` with the run's record (`delta: null` — the door's
/// re-import delta is computed against a served register at request time;
/// this path is the load itself). A quarantine is reported and the rest is
/// served. With `dry_run`, the parse is reported and nothing is written.
///
/// # Errors
/// A hull outside `scope`; see [`whole_file_refusal`]; a stored field map
/// that will not parse; a store that refuses the run or the ledger row.
pub async fn commit_xer(
    store: &dyn Repositories,
    scope: &TenantScope,
    vessel: VesselId,
    load: XerLoad<'_>,
) -> Result<LoadedSchedule, String> {
    store
        .get_vessel(scope, vessel)
        .await
        .map_err(|e| format!("hull {vessel}: {e}"))?;
    let (text, encoding) = wadl_ingest::encoding::decode_xer(load.bytes);
    let map_doc = store
        .field_map(scope, vessel)
        .await
        .map_err(|e| e.to_string())?;
    let (map, field_map_label) = field_map_in_effect(map_doc.as_ref())?;
    let map_source = if field_map_label.is_some() {
        "document"
    } else {
        "default"
    };
    let clock_doc = store
        .yard_clock(scope, vessel)
        .await
        .map_err(|e| e.to_string())?;
    let effect = crate::yard_clock::ClockInEffect::from_doc(clock_doc);
    let parsed_in = effect.parsed_in();
    let parsed = parse_xer_in(vessel, load.label, &text, &map, &effect.clock, &parsed_in)?;
    let run = build_run(
        &parsed,
        &RunInputs {
            label: load.label,
            encoding: encoding.label(),
            decoded_by: wadl_ingest::encoding::DECODED_BY_SERVER,
            imported_by: imported_by(scope, load.via),
            imported_at_ms: load.now_ms,
            field_map: &map,
        },
    );
    if load.dry_run {
        let summary = run.summary.clone();
        return Ok(loaded_schedule(
            &parsed,
            encoding,
            field_map_label,
            summary,
            None,
        ));
    }
    let summary = store
        .commit_schedule_run(scope, vessel, run)
        .await
        .map_err(|e| e.to_string())?;
    let detail = serde_json::json!({
        "label": summary.label,
        "activities": summary.counts.served,
        "edges": summary.counts.edges,
        "delta": serde_json::Value::Null,
        "parsed_in": parsed_in,
        "run_id": summary.run_id,
        "seq": summary.seq,
        "imported_by": summary.imported_by,
        "encoding": summary.encoding,
        "decoded_by": summary.decoded_by,
        "field_map": summary.field_map,
        "field_map_source": map_source,
        "counts": summary.counts,
        "via": load.via,
    });
    let detail = serde_json::to_string(&detail).unwrap_or_default();
    let record = store
        .append_audit(
            scope,
            vessel,
            "SCHEDULE_REPLACED",
            &detail,
            None,
            load.now_ms,
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(loaded_schedule(
        &parsed,
        encoding,
        field_map_label,
        summary,
        Some(record.seq),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activity_ids_are_stable_per_hull_and_code_and_carry_the_version_nibble() {
        let hull = VesselId::from_uuid(uuid::Uuid::from_u128(0x73));
        let other = VesselId::from_uuid(uuid::Uuid::from_u128(0x71));
        let a = stable_activity_id(hull, "A4021");
        assert_eq!(a, stable_activity_id(hull, "A4021"));
        assert_ne!(a, stable_activity_id(hull, "A4022"));
        assert_ne!(a, stable_activity_id(other, "A4021"));
        let uuid = a.as_uuid();
        assert_eq!(uuid.get_version_num(), 8);
        assert_eq!(uuid.get_variant(), uuid::Variant::RFC4122);
    }

    #[test]
    fn a_file_with_no_task_section_or_no_survivor_is_refused_whole() {
        let alien = wadl_ingest::xer::ingest_xer("meeting notes\n- coffee\n", "notes.xer");
        let reason = whole_file_refusal(&alien).unwrap();
        assert!(
            reason.contains("no activities") && reason.contains("P6 XER"),
            "{reason}"
        );

        let bad = "%T\tTASK\n%F\ttask_id\ttask_code\ttask_name\tstatus_code\ttask_type\tearly_start_date\tearly_end_date\n\
%R\t1\tA1\tBad\tTK_NotStart\tTT_Task\t2026-13-40 06:00\t2026-08-02 16:00\n\
%R\t2\tA2\tBackwards\tTK_NotStart\tTT_Task\t2026-08-02 16:00\t2026-08-01 06:00\n%E\n";
        let report = wadl_ingest::xer::ingest_xer(bad, "bad.xer");
        let reason = whole_file_refusal(&report).unwrap();
        assert!(
            reason.starts_with("XER rejected: every one of 2 TASK rows was quarantined"),
            "{reason}"
        );
        assert!(reason.contains("line 3:"), "{reason}");

        let fine = "%T\tTASK\n%F\ttask_id\ttask_code\ttask_name\tstatus_code\ttask_type\n\
%R\t1\tA1\tFine\tTK_NotStart\tTT_Task\n%E\n";
        assert!(whole_file_refusal(&wadl_ingest::xer::ingest_xer(fine, "x")).is_none());
    }
}
