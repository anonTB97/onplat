//! The XER ingest, proven against the repo's own sample export.
//!
//! The sample (`reference/p6-sample/CVN73-PIA26.xer`) was built to mirror the
//! demo hull and is CI-validated by `scripts/validate-p6-sample.py`, so these
//! tests assert real facts about a real file — not a fixture invented to make
//! the parser look good. The properties pinned:
//!
//! 1. **Fields resolve by name, never by position.** The same rows with a
//!    reordered `%F` line must parse identically; a positional parser works
//!    until the first P6 upgrade and then silently reads the wrong column.
//! 2. **The planned window takes actuals over the CPM pass and never the
//!    baseline** — the documented date rule, the one judgement this layer makes.
//! 3. **Absence is graded, not guessed.** A task without the compartment UDF
//!    comes through as `None` + LOW, and a broken row is rejected with its line
//!    number rather than smoothed over.

#![allow(missing_docs, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use wadl_domain::units::ManHours;
use wadl_ingest::xer::{ingest_xer, XerStatus};
use wadl_ingest::Reliability;

const SAMPLE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../reference/p6-sample/CVN73-PIA26.xer"
));

fn hour(ms_date: &str) -> i64 {
    // "2026-08-01 06:30" → epoch millis, via the same library the parser uses.
    chrono::NaiveDateTime::parse_from_str(ms_date, "%Y-%m-%d %H:%M")
        .unwrap()
        .and_utc()
        .timestamp_millis()
}

#[test]
fn the_sample_export_ingests_whole() {
    let report = ingest_xer(SAMPLE, "CVN73-PIA26.xer");
    assert_eq!(report.project.as_deref(), Some("CVN73-PIA26"));
    assert!(report.rejected.is_empty(), "{:?}", report.rejected);
    assert_eq!(report.activities.len(), 17, "14 tasks + 3 milestones");
    assert_eq!(
        report.activities.iter().filter(|a| a.is_milestone).count(),
        3
    );
    assert_eq!(report.relationships.len(), 11);
}

#[test]
fn actuals_override_the_cpm_pass_and_the_baseline_is_never_consulted() {
    let report = ingest_xer(SAMPLE, "CVN73-PIA26.xer");
    let a1010 = report
        .activities
        .iter()
        .find(|a| a.code == "A1010")
        .unwrap();
    // Early start is 06:00; the actual start is 06:30. Actual wins. The finish
    // has no actual yet, so the CPM finish stands.
    let planned = a1010.planned.expect("dated");
    assert_eq!(planned.start.epoch_millis(), hour("2026-08-01 06:30"));
    assert_eq!(planned.end.epoch_millis(), hour("2026-08-14 16:00"));
    assert_eq!(a1010.status, XerStatus::InProgress);
    assert_eq!(a1010.work_order_code.as_deref(), Some("WI-3318"));
    assert_eq!(a1010.budget_hours, ManHours::new(680));
    assert_eq!(a1010.earned_hours, ManHours::new(512));
    assert_eq!(a1010.trade, "SM-PRES");

    // The coating activity: the demo's mid-cure story, 03:00–11:00.
    let a6010 = report
        .activities
        .iter()
        .find(|a| a.code == "A6010")
        .unwrap();
    let w = a6010.planned.expect("dated");
    assert_eq!(
        w.start.epoch_millis(),
        hour("2026-08-10 03:15"),
        "actual start"
    );
    assert_eq!(w.end.epoch_millis(), hour("2026-08-10 11:00"), "CPM finish");
}

#[test]
fn a_missing_compartment_udf_is_low_grade_none_not_a_guess() {
    let report = ingest_xer(SAMPLE, "CVN73-PIA26.xer");
    let a4040 = report
        .activities
        .iter()
        .find(|a| a.code == "A4040")
        .unwrap();
    assert_eq!(a4040.compartment_no, None, "the fixture's deliberate gap");
    assert_eq!(a4040.compartment_reliability, Reliability::Low);
    // And a task WITH the UDF is high-grade.
    let a4020 = report
        .activities
        .iter()
        .find(|a| a.code == "A4020")
        .unwrap();
    assert_eq!(
        a4020
            .compartment_no
            .as_ref()
            .map(wadl_domain::CompartmentNo::as_str),
        Some("3-160-2-Q")
    );
    assert_eq!(a4020.compartment_reliability, Reliability::High);
}

#[test]
fn relationships_resolve_to_codes_and_carry_the_negative_lag_finding() {
    let report = ingest_xer(SAMPLE, "CVN73-PIA26.xer");
    let overlap = report
        .relationships
        .iter()
        .find(|r| r.lag_hours < 0)
        .expect("the sample deliberately carries one");
    assert_eq!(
        (overlap.pred.as_str(), overlap.succ.as_str()),
        ("A6010", "A4050")
    );
    assert_eq!(overlap.lag_hours, -8);
    assert_eq!(overlap.kind, "PR_FS");
}

#[test]
fn provenance_is_stamped_on_every_row() {
    let report = ingest_xer(SAMPLE, "CVN73-PIA26.xer");
    for a in &report.activities {
        assert!(
            a.source_ref.starts_with("CVN73-PIA26.xer · "),
            "{}: {}",
            a.code,
            a.source_ref
        );
    }
}

/// Property 1, directly: shuffle the `%F` column order and nothing changes.
#[test]
fn field_order_does_not_matter() {
    let normal = "\
%T\tRSRC\n%F\trsrc_id\trsrc_short_name\n%R\t1\tSM-X\n\
%T\tTASK\n%F\ttask_id\ttask_code\ttask_name\tstatus_code\ttask_type\tearly_start_date\tearly_end_date\n\
%R\t10\tA1\tDo the thing\tTK_NotStart\tTT_Task\t2026-08-01 06:00\t2026-08-02 16:00\n%E\n";
    let reordered = "\
%T\tRSRC\n%F\trsrc_short_name\trsrc_id\n%R\tSM-X\t1\n\
%T\tTASK\n%F\ttask_name\tstatus_code\ttask_code\ttask_type\tearly_end_date\tearly_start_date\ttask_id\n\
%R\tDo the thing\tTK_NotStart\tA1\tTT_Task\t2026-08-02 16:00\t2026-08-01 06:00\t10\n%E\n";
    let a = ingest_xer(normal, "x");
    let b = ingest_xer(reordered, "x");
    assert_eq!(
        a.activities, b.activities,
        "by-name resolution is the contract"
    );
    assert!(a.rejected.is_empty() && b.rejected.is_empty());
}

/// Absence versus breakage: an empty date is "undated" (a real condition, kept);
/// a malformed date is a rejection with the line number.
#[test]
fn broken_rows_are_rejected_with_their_line_not_smoothed_over() {
    let input = "\
%T\tTASK\n%F\ttask_id\ttask_code\ttask_name\tstatus_code\ttask_type\tearly_start_date\tearly_end_date\n\
%R\t1\tA1\tUndated but honest\tTK_NotStart\tTT_Task\t\t\n\
%R\t2\tA2\tBroken date\tTK_NotStart\tTT_Task\tnot-a-date\t2026-08-02 16:00\n\
%R\t3\tA3\tWrong cell count\tTK_NotStart\n\
%R\t4\t\tNo code\tTK_NotStart\tTT_Task\t\t\n%E\n";
    let report = ingest_xer(input, "x");
    assert_eq!(
        report.activities.len(),
        1,
        "only the undated-but-honest row"
    );
    assert_eq!(report.activities.first().unwrap().planned, None);
    assert_eq!(report.rejected.len(), 3, "{:?}", report.rejected);
    let reasons: Vec<(usize, &str)> = report
        .rejected
        .iter()
        .map(|r| (r.row, r.reason.as_str()))
        .collect();
    // Line numbers count from the top of the file: %T is line 1, %F line 2, so
    // the first data row is line 3 and the broken ones are 4, 5 and 6.
    assert!(reasons
        .iter()
        .any(|(row, r)| *row == 4 && r.contains("unparseable")));
    assert!(reasons
        .iter()
        .any(|(row, r)| *row == 5 && r.contains("values for")));
    assert!(reasons
        .iter()
        .any(|(row, r)| *row == 6 && r.contains("task_code")));
}

/// The sample's hours reconcile with the demo hull's work orders — the file was
/// built to mirror them, and this is the cross-check that keeps the two honest
/// against each other.
#[test]
fn the_sample_reconciles_with_the_demo_work_orders() {
    let report = ingest_xer(SAMPLE, "CVN73-PIA26.xer");
    let hours = |wi: &str| -> (i64, i64) {
        report
            .activities
            .iter()
            .filter(|a| a.work_order_code.as_deref() == Some(wi))
            .fold((0, 0), |(b, e), a| {
                (b + a.budget_hours.get(), e + a.earned_hours.get())
            })
    };
    // The six seeded work orders, budgets and earned as the store seeds them.
    assert_eq!(hours("WI-3318"), (680, 512));
    assert_eq!(hours("WI-3402"), (240, 0));
    assert_eq!(hours("WI-4471"), (410, 12));
    assert_eq!(hours("WI-3905"), (340, 0));
    assert_eq!(hours("WI-1905"), (160, 0));
    assert_eq!(hours("WI-5571"), (140, 0));
}
