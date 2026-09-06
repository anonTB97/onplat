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

#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use wadl_domain::units::ManHours;
use wadl_ingest::field_map::FieldMap;
use wadl_ingest::xer::{ingest_xer, ingest_xer_with, XerStatus};
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
    assert_eq!(report.activities.len(), 18, "15 tasks + 3 milestones");
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

/// Locating an activity, graded per path: UDF = the schedule saying where
/// (High); a placard parsed from the task's own name = this parser guessing
/// where (Medium, never presented as authored); neither = Low with `None`.
/// Guessing from free text is allowed exactly because it is graded and
/// reported — what stays forbidden is guessing SILENTLY.
#[test]
fn location_is_graded_per_path_udf_name_or_nothing() {
    let report = ingest_xer(SAMPLE, "CVN73-PIA26.xer");
    let by_code = |code: &str| report.activities.iter().find(|a| a.code == code).unwrap();

    // A task WITH the UDF is high-grade — and its name is never consulted.
    let a4020 = by_code("A4020");
    assert_eq!(
        a4020
            .compartment_no
            .as_ref()
            .map(wadl_domain::CompartmentNo::as_str),
        Some("3-160-2-Q")
    );
    assert_eq!(a4020.compartment_reliability, Reliability::High);

    // A4040 has no UDF, but its name carries "(3-185-0-L)": located from the
    // name, graded as the guess it is.
    let a4040 = by_code("A4040");
    assert_eq!(
        a4040
            .compartment_no
            .as_ref()
            .map(wadl_domain::CompartmentNo::as_str),
        Some("3-185-0-L"),
        "the placard written in the task name"
    );
    assert_eq!(a4040.compartment_reliability, Reliability::Medium);

    // "Fr 160" in a name is a frame reference, not a placard — it must NOT
    // locate anything. A4010 has a UDF; strip the UDF case by checking a
    // milestone, which carries neither UDF nor placard.
    let m0100 = by_code("M0100");
    assert_eq!(m0100.compartment_no, None);
    assert_eq!(m0100.compartment_reliability, Reliability::Low);

    // A2020 is the fully honest gap: no UDF, no placard in the name — but its
    // WBS bucket sits under Z5, and the ingest carries that as the hint it is.
    let a2020 = by_code("A2020");
    assert_eq!(a2020.compartment_no, None);
    assert_eq!(a2020.compartment_reliability, Reliability::Low);
    assert_eq!(a2020.wbs_area.as_deref(), Some("Z5"));
    // Located rows carry their bucket too — provenance, not a contradiction.
    assert_eq!(by_code("A1010").wbs_area.as_deref(), Some("Z6"));
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

/// A two-task export at chosen wall times, for the clock tests.
fn xer_at(start: &str, end: &str) -> String {
    format!(
        "\
%T\tTASK\n%F\ttask_id\ttask_code\ttask_name\tstatus_code\ttask_type\tearly_start_date\tearly_end_date\n\
%R\t1\tA1\tShaft alley weld\tTK_NotStart\tTT_Task\t{start}\t{end}\n%E\n"
    )
}

fn norfolk() -> wadl_domain::civil::YardClock {
    let v: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../reference/clock/yard-clock-vectors.json"
    )))
    .unwrap();
    serde_json::from_value(v["clocks"]["norfolk"].clone()).unwrap()
}

/// The XER's wall clock is the yard's: a 06:00 start on a Norfolk summer day
/// is 10:00Z. The UTC form (`ingest_xer`) is unchanged, so the CLI's
/// evidence table reads as it always did.
#[test]
fn wall_clock_is_read_in_the_yard_clock() {
    let input = xer_at("2026-08-10 06:00", "2026-08-10 14:00");
    let in_norfolk = ingest_xer_with(&input, "x", &FieldMap::default(), &norfolk());
    assert!(in_norfolk.rejected.is_empty(), "{:?}", in_norfolk.rejected);
    let w = in_norfolk.activities[0].planned.expect("dated");
    assert_eq!(w.start.epoch_millis(), hour("2026-08-10 10:00"));
    assert_eq!(w.end.epoch_millis(), hour("2026-08-10 18:00"));
    assert!(in_norfolk.wall_clock_findings.is_empty());

    let in_utc = ingest_xer(&input, "x");
    let u = in_utc.activities[0].planned.expect("dated");
    assert_eq!(u.start.epoch_millis(), hour("2026-08-10 06:00"));
}

/// A start the clock skipped is accepted — read as standard time, the
/// instant the clock reached when it jumped — and the finding names it.
#[test]
fn a_start_in_the_gap_is_accepted_with_a_finding() {
    let input = xer_at("2026-03-08 02:30", "2026-03-08 09:00");
    let report = ingest_xer_with(&input, "x", &FieldMap::default(), &norfolk());
    assert!(report.rejected.is_empty(), "{:?}", report.rejected);
    let w = report.activities[0].planned.expect("dated");
    assert_eq!(
        w.start.epoch_millis(),
        hour("2026-03-08 07:30"),
        "02:30 EST"
    );
    assert_eq!(
        report.wall_clock_findings.len(),
        1,
        "{:?}",
        report.wall_clock_findings
    );
    let finding = &report.wall_clock_findings[0];
    assert!(
        finding.starts_with("line 3: A1 start 2026-03-08 02:30 does not exist in America/New_York"),
        "{finding}"
    );
    assert!(
        finding.ends_with("read as 02:30 standard (07:30Z)"),
        "{finding}"
    );

    // The repeated hour: first occurrence, said so.
    let report = ingest_xer_with(
        &xer_at("2026-11-01 01:30", "2026-11-01 09:00"),
        "x",
        &FieldMap::default(),
        &norfolk(),
    );
    let w = report.activities[0].planned.expect("dated");
    assert_eq!(
        w.start.epoch_millis(),
        hour("2026-11-01 05:30"),
        "01:30 EDT, the first one"
    );
    assert!(
        report.wall_clock_findings[0].contains("occurs twice"),
        "{:?}",
        report.wall_clock_findings
    );
}

// ---------------------------------------------------------------------------
// The yard-shaped export: what a real yard's P6 writes, as opposed to what
// the reference sample was built to say. UDF `COMPT` rather than
// `compartment`, an activity code `LOC`, two projects, level-of-effort and
// WBS-summary rows, a material and an equipment assignment, one resource
// with no type, one cross-project predecessor, one bad date, one width
// error. The map makes all of it data.
// ---------------------------------------------------------------------------

use wadl_ingest::field_map::FieldSource;

const YARD_SHAPED: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../reference/p6-sample/CVN73-PIA26-yardshape.xer"
));

const YARD_LABEL: &str = "CVN73-PIA26-yardshape.xer";

fn utc() -> wadl_domain::civil::YardClock {
    wadl_domain::civil::YardClock::utc()
}

/// The map the yard would choose on the card: compartment from `COMPT`,
/// work item from `WI`, work type from `WTYPE`, trade from the resource,
/// this hull's availability only.
fn yard_map() -> FieldMap {
    FieldMap {
        compartment: FieldSource::Udf {
            name: "COMPT".to_owned(),
        },
        work_item: FieldSource::Udf {
            name: "WI".to_owned(),
        },
        work_type: FieldSource::Udf {
            name: "WTYPE".to_owned(),
        },
        trade: FieldSource::Resource,
        projects: vec!["CVN73-PIA26".to_owned()],
        placards_from_names: true,
    }
}

fn placard(a: &wadl_ingest::xer::XerActivity) -> Option<&str> {
    a.compartment_no
        .as_ref()
        .map(wadl_domain::CompartmentNo::as_str)
}

/// `ingest_xer` IS `ingest_xer_with(default, UTC)`, on both samples — so a
/// hull with no map on file imports exactly as it did before the map existed.
#[test]
fn the_default_map_reproduces_the_old_report_exactly() {
    let old = ingest_xer(SAMPLE, "CVN73-PIA26.xer");
    let new = ingest_xer_with(SAMPLE, "CVN73-PIA26.xer", &FieldMap::default(), &utc());
    assert_eq!(old.activities, new.activities);
    assert_eq!(old.relationships, new.relationships);
    assert_eq!(old.rejected, new.rejected);
    assert!(new.excluded_loe.is_empty() && new.excluded_wbs.is_empty());
    assert!(new.excluded_project.is_empty());
    assert_eq!(new.material_skipped + new.equipment_skipped, 0);
    assert_eq!(new.projects_served, vec!["CVN73-PIA26".to_owned()]);
    assert!(new.findings.is_empty(), "{:?}", new.findings);

    // The full export: the counts the boot banner has always printed.
    let full = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../reference/p6-sample/CVN73-PIA26-full.xer"
    ))
    .unwrap();
    let report = ingest_xer_with(&full, "CVN73-PIA26-full.xer", &FieldMap::default(), &utc());
    assert!(report.rejected.is_empty(), "{:?}", report.rejected);
    assert_eq!(report.activities.len(), 5706);
    assert_eq!(
        report.activities.iter().filter(|a| a.is_milestone).count(),
        14
    );
    assert_eq!(report.task_rows, 5706);
    assert_eq!(report.fields_seen.task_types["TT_Task"], 5692);
    assert_eq!(report.fields_seen.resource_types["RT_Labor"], 6160);
    assert!(report.fields_seen.has_rsrc_type);
    assert!(report.findings.is_empty(), "{:?}", report.findings);
    assert!(report.activities.iter().all(|a| a.work_type.is_none()));
}

/// The survey says what the reference sample carries — and nothing it says.
#[test]
fn the_survey_lists_fields_and_counts_without_schedule_content() {
    let report = ingest_xer(SAMPLE, "CVN73-PIA26.xer");
    let seen = &report.fields_seen;
    assert_eq!(seen.projects.len(), 1);
    assert_eq!(seen.projects[0].short_name, "CVN73-PIA26");
    assert_eq!(seen.projects[0].id, "4410");
    assert_eq!(seen.projects[0].tasks, 18);
    let names: Vec<&str> = seen.udfs.iter().map(|u| u.name.as_str()).collect();
    assert_eq!(names, ["compartment", "wi_number", "work_class"]);
    assert_eq!(
        seen.udfs[0].label.as_deref(),
        Some("Compartment (deck-frame-side-usage)")
    );
    assert_eq!(seen.udfs[0].table.as_deref(), Some("TASK"));
    assert_eq!(seen.udfs[0].values, 13);
    assert!(seen.activity_code_types.is_empty());
    assert_eq!(seen.resource_types["RT_Labor"], 14);
    assert_eq!(seen.resource_types["RT_Mat"], 0);
    assert_eq!(seen.resource_types["RT_Equip"], 0);
    assert!(seen.has_rsrc_type);
    assert_eq!(seen.task_types["TT_Task"], 15);
    assert_eq!(seen.task_types["TT_Mile"], 3);
    assert_eq!(seen.task_types["TT_LOE"], 0);
    assert_eq!(seen.sections["TASK"], 18);
    assert_eq!(seen.sections["TASKPRED"], 11);
    assert_eq!(seen.sections["TASKRSRC"], 14);
    assert_eq!(seen.sections["UDFVALUE"], 29);
    assert!(report.has_task_section());
    // The survey never carries a task code or a name.
    let json = serde_json::to_string(seen).unwrap();
    assert!(!json.contains("A1010") && !json.contains("Reserve feed"));
}

#[test]
fn the_yard_shaped_export_locates_through_a_named_udf_and_an_activity_code() {
    // Today's map, today's names: nothing is located, and the findings say
    // which fields the file does carry instead.
    let default = ingest_xer_with(YARD_SHAPED, YARD_LABEL, &FieldMap::default(), &utc());
    assert!(default
        .activities
        .iter()
        .all(|a| a.compartment_reliability != Reliability::High && a.work_order_code.is_none()));
    assert_eq!(
        default
            .activities
            .iter()
            .filter(|a| a.compartment_no.is_some())
            .map(|a| a.code.as_str())
            .collect::<Vec<_>>(),
        ["A4040"],
        "the one placard written in a task name"
    );
    assert!(
        default.findings.iter().any(|f| f
            .starts_with("compartment: this export carries no UDF named \"compartment\"")
            && f.contains("\"COMPT\"")),
        "{:?}",
        default.findings
    );
    let names: Vec<&str> = default
        .fields_seen
        .udfs
        .iter()
        .map(|u| u.name.as_str())
        .collect();
    assert_eq!(names, ["COMPT", "WI", "WTYPE"]);
    assert_eq!(default.fields_seen.udfs[0].values, 8);
    assert_eq!(default.fields_seen.activity_code_types[0].name, "LOC");
    assert_eq!(default.fields_seen.activity_code_types[0].values, 1);

    // The yard's map: seven authored through COMPT, one through LOC.
    let mapped = ingest_xer_with(YARD_SHAPED, YARD_LABEL, &yard_map(), &utc());
    assert_eq!(mapped.activities.len(), 9, "{:?}", mapped.excluded_project);
    let high = mapped
        .activities
        .iter()
        .filter(|a| a.compartment_reliability == Reliability::High)
        .count();
    let medium: Vec<&wadl_ingest::xer::XerActivity> = mapped
        .activities
        .iter()
        .filter(|a| a.compartment_reliability == Reliability::Medium)
        .collect();
    assert_eq!(high, 7);
    assert_eq!(medium.len(), 1);
    assert_eq!(medium[0].code, "A4040");
    assert_eq!(placard(medium[0]), Some("3-185-0-L"), "via the task name");
    let by_code = |code: &str| mapped.activities.iter().find(|a| a.code == code).unwrap();
    assert_eq!(placard(by_code("A1010")), Some("4-110-2-W"));
    assert_eq!(by_code("A1010").work_order_code.as_deref(), Some("WI-3318"));
    assert_eq!(by_code("A1010").work_type.as_deref(), Some("COATING"));
    assert_eq!(by_code("A2010").work_type.as_deref(), Some("HOT WORK"));
    assert_eq!(by_code("A1020").work_type, None);
    assert_eq!(by_code("M0300").compartment_reliability, Reliability::Low);
    assert!(
        !mapped
            .findings
            .iter()
            .any(|f| f.starts_with("compartment:")),
        "{:?}",
        mapped.findings
    );
}

/// A UDF matched by label only locates just the same and says so; an
/// activity code locates at Medium and can carry the trade.
#[test]
fn a_label_only_udf_and_an_activity_code_locate_and_say_how() {
    let by_label = FieldMap {
        compartment: FieldSource::Udf {
            name: "location placard".to_owned(),
        },
        ..yard_map()
    };
    let labelled = ingest_xer_with(YARD_SHAPED, YARD_LABEL, &by_label, &utc());
    assert_eq!(
        placard(
            labelled
                .activities
                .iter()
                .find(|a| a.code == "A1010")
                .unwrap()
        ),
        Some("4-110-2-W")
    );
    assert!(
        labelled.findings.iter().any(|f| {
            f
            == "compartment: no UDF named \"location placard\" — matched by label to UDF \"COMPT\""
        }),
        "{:?}",
        labelled.findings
    );

    // The compartment from an activity code, and the trade from one.
    let coded = FieldMap {
        compartment: FieldSource::ActivityCode {
            name: "loc".to_owned(),
        },
        trade: FieldSource::ActivityCode {
            name: "TRADE".to_owned(),
        },
        placards_from_names: false,
        ..yard_map()
    };
    let coded = ingest_xer_with(YARD_SHAPED, YARD_LABEL, &coded, &utc());
    let a4040 = coded.activities.iter().find(|a| a.code == "A4040").unwrap();
    assert_eq!(placard(a4040), Some("3-185-0-L"));
    assert_eq!(a4040.compartment_reliability, Reliability::Medium);
    assert_eq!(a4040.trade, "", "no TRADE code on this row");
    let a3010 = coded.activities.iter().find(|a| a.code == "A3010").unwrap();
    assert_eq!(
        a3010.trade, "SM-ELEC",
        "from the TRADE code, not the resource"
    );
    assert_eq!(
        coded
            .activities
            .iter()
            .filter(|a| a.compartment_no.is_some())
            .count(),
        1
    );
}

#[test]
fn material_and_equipment_assignments_are_not_man_hours() {
    let report = ingest_xer_with(YARD_SHAPED, YARD_LABEL, &yard_map(), &utc());
    let staging = report
        .activities
        .iter()
        .find(|a| a.code == "A2020")
        .unwrap();
    assert_eq!(
        staging.budget_hours,
        ManHours::new(40),
        "the labor row only"
    );
    assert_eq!(staging.trade, "SM-PRES", "from the labor row");
    assert_eq!(report.material_skipped, 1);
    assert_eq!(report.equipment_skipped, 1);
    assert_eq!(report.fields_seen.resource_types["RT_Mat"], 1);
    assert_eq!(report.fields_seen.resource_types["RT_Equip"], 1);
    assert_eq!(report.fields_seen.resource_types["RT_Labor"], 7);
    assert_eq!(report.fields_seen.resource_types["untyped"], 2);
    // The resource with no type is counted as labor, and the report says so.
    let a3010 = report
        .activities
        .iter()
        .find(|a| a.code == "A3010")
        .unwrap();
    assert_eq!(a3010.budget_hours, ManHours::new(340));
    assert_eq!(a3010.trade, "SM-ELEC");
    assert!(
        report
            .findings
            .iter()
            .any(|f| f == "resource SM-ELEC: no rsrc_type — its assignments are counted as labor"),
        "{:?}",
        report.findings
    );

    // A file whose RSRC carries no rsrc_type at all counts everything and
    // says so once.
    let untyped = "\
%T\tRSRC\n%F\trsrc_id\trsrc_short_name\n%R\t1\tSM-X\n%R\t2\tMAT-Y\n\
%T\tTASK\n%F\ttask_id\ttask_code\ttask_name\tstatus_code\ttask_type\n\
%R\t10\tA1\tDo the thing\tTK_NotStart\tTT_Task\n%E\n\
%T\tTASKRSRC\n%F\ttask_id\trsrc_id\ttarget_qty\n%R\t10\t1\t40\n%R\t10\t2\t500\n%E\n";
    let report = ingest_xer(untyped, "x");
    assert!(!report.fields_seen.has_rsrc_type);
    assert_eq!(report.activities[0].budget_hours, ManHours::new(540));
    assert_eq!(report.material_skipped, 0);
    assert_eq!(
        report.findings.first().map(String::as_str),
        Some("RSRC carries no rsrc_type — every assignment is counted as labor man-hours")
    );
}

#[test]
fn level_of_effort_and_wbs_summary_rows_are_excluded_and_listed() {
    let report = ingest_xer_with(YARD_SHAPED, YARD_LABEL, &FieldMap::default(), &utc());
    assert_eq!(report.excluded_loe, ["A9001", "A9002", "A9003"]);
    assert_eq!(report.excluded_wbs, ["Z6-SUM"]);
    assert!(report
        .activities
        .iter()
        .all(|a| !a.code.starts_with("A900") && a.code != "Z6-SUM"));
    assert!(
        !report
            .rejected
            .iter()
            .any(|r| r.code.as_deref() == Some("A9001")),
        "excluded is not quarantined"
    );
    assert_eq!(report.fields_seen.task_types["TT_LOE"], 3);
    assert_eq!(report.fields_seen.task_types["TT_WBS"], 1);
    assert_eq!(report.task_rows, 17);
}

#[test]
fn a_project_filter_serves_one_project_and_quarantines_cross_project_logic() {
    // No filter: both projects are served, the finding counts them, and the
    // relationship between them resolves like any other.
    let all = ingest_xer_with(YARD_SHAPED, YARD_LABEL, &FieldMap::default(), &utc());
    assert_eq!(all.projects_served, ["CVN73-PIA26", "CVN73-DSRA27"]);
    assert_eq!(all.project.as_deref(), Some("CVN73-PIA26"));
    assert_eq!(all.activities.len(), 11);
    assert!(all.excluded_project.is_empty());
    assert!(
        all.findings
            .iter()
            .any(|f| f.starts_with("2 projects in this export (CVN73-PIA26, CVN73-DSRA27)")),
        "{:?}",
        all.findings
    );
    assert!(all
        .relationships
        .iter()
        .any(|r| r.pred == "M0300" && r.succ == "D1010"));
    assert_eq!(all.rejected.len(), 2, "{:?}", all.rejected);

    // The hull's project only: the other's rows are listed as excluded, and
    // the one relationship into it is quarantined with the project's name.
    let one = ingest_xer_with(YARD_SHAPED, YARD_LABEL, &yard_map(), &utc());
    assert_eq!(one.projects_served, ["CVN73-PIA26"]);
    assert_eq!(one.activities.len(), 9);
    assert_eq!(
        one.excluded_project,
        [
            ("D1010".to_owned(), "CVN73-DSRA27".to_owned()),
            ("D1020".to_owned(), "CVN73-DSRA27".to_owned())
        ]
    );
    let cross: Vec<&wadl_ingest::Rejection> = one
        .rejected
        .iter()
        .filter(|r| r.class == "cross_project_logic")
        .collect();
    assert_eq!(cross.len(), 1, "{:?}", one.rejected);
    assert_eq!(cross[0].row, 58);
    assert_eq!(cross[0].table, "TASKPRED");
    assert_eq!(
        cross[0].reason,
        "task_id 2001 is in project CVN73-DSRA27, which is not served"
    );
    // The DSRA-internal edge goes with its rows: excluded, counted, not
    // quarantined — nothing served is touched by it.
    assert_eq!(
        one.rejected
            .iter()
            .filter(|r| r.table == "TASKPRED")
            .count(),
        1
    );
    assert_eq!(one.excluded_project_edges, 1);
    assert_eq!(one.relationships.len(), 4);
    assert!(
        !one.findings.iter().any(|f| f.starts_with("2 projects")),
        "{:?}",
        one.findings
    );

    // A filter naming a project the file does not carry serves nothing and
    // says why — the door's "no activity survives" refusal reads this.
    let wrong = FieldMap {
        projects: vec!["CVN75-DPIA27".to_owned()],
        ..FieldMap::default()
    };
    let none = ingest_xer_with(YARD_SHAPED, YARD_LABEL, &wrong, &utc());
    assert!(none.activities.is_empty());
    assert_eq!(none.excluded_project.len(), 16, "every parsed TASK row");
    assert_eq!(none.excluded_project_edges, 6);
    assert!(
        none.findings
            .iter()
            .any(|f| f.starts_with("projects: this export carries no project \"CVN75-DPIA27\"")),
        "{:?}",
        none.findings
    );
    assert!(none.has_task_section());
}

#[test]
fn a_finish_milestone_is_a_key_event() {
    let report = ingest_xer_with(YARD_SHAPED, YARD_LABEL, &yard_map(), &utc());
    let m0300 = report
        .activities
        .iter()
        .find(|a| a.code == "M0300")
        .unwrap();
    assert!(m0300.is_milestone);
    let w = m0300.planned.expect("dated");
    assert_eq!(w.start.epoch_millis(), hour("2027-01-23 18:00"));
    assert_eq!(w.end.epoch_millis() - w.start.epoch_millis(), 60_000);
    assert_eq!(m0300.budget_hours, ManHours::ZERO);
    assert_eq!(report.fields_seen.task_types["TT_FinMile"], 1);
    assert_eq!(
        report.activities.iter().filter(|a| a.is_milestone).count(),
        1
    );
}

#[test]
fn a_bad_row_is_quarantined_with_its_class_and_the_rest_ingests() {
    let report = ingest_xer_with(YARD_SHAPED, YARD_LABEL, &yard_map(), &utc());
    let rows: Vec<(usize, &str, Option<&str>, &str)> = report
        .rejected
        .iter()
        .filter(|r| r.table == "TASK")
        .map(|r| {
            (
                r.row,
                r.class.as_str(),
                r.code.as_deref(),
                r.reason.as_str(),
            )
        })
        .collect();
    assert_eq!(
        rows,
        [
            (
                44,
                "unparseable_date",
                Some("A4021"),
                "unparseable early_start_date: \"2026-13-40 06:00\""
            ),
            (45, "width", None, "TASK: 8 values for 11 fields"),
        ]
    );
    // Nine rows are served around them; the quarantined UDF value on A4021
    // is still in the survey's count, because the survey is the file, not
    // the import.
    assert_eq!(report.activities.len(), 9);
    assert_eq!(report.fields_seen.udfs[0].values, 8);

    // Every class the door groups by, on rows built for it.
    let rows = "\
%T\tTASK\n%F\ttask_id\ttask_code\ttask_name\tstatus_code\ttask_type\tearly_start_date\tearly_end_date\n\
%R\t1\t\tNo code\tTK_NotStart\tTT_Task\t\t\n\
%R\t2\tA2\t\tTK_NotStart\tTT_Task\t\t\n\
%R\t3\tA3\tOdd status\tTK_Paused\tTT_Task\t\t\n\
%R\t4\tA4\tBackwards\tTK_NotStart\tTT_Task\t2026-08-02 16:00\t2026-08-01 06:00\n\
%R\t5\tA5\tFine\tTK_NotStart\tTT_Task\t2026-08-01 06:00\t2026-08-02 16:00\n%E\n\
%T\tTASKPRED\n%F\ttask_id\tpred_task_id\tpred_type\n%R\t5\t4\tPR_FS\n%R\t5\t99\tPR_FS\n%E\n";
    let report = ingest_xer(rows, "x");
    assert_eq!(report.activities.len(), 1);
    let classes: Vec<(&str, Option<&str>)> = report
        .rejected
        .iter()
        .map(|r| (r.class.as_str(), r.code.as_deref()))
        .collect();
    assert_eq!(
        classes,
        [
            ("no_code", None),
            ("no_name", Some("A2")),
            ("unknown_status", Some("A3")),
            ("backwards_window", Some("A4")),
            ("unknown_task_in_logic", Some("A5")),
            ("unknown_task_in_logic", Some("A5")),
        ]
    );
    assert_eq!(report.rejected[4].reason, "pred_task_id 4 was quarantined");
    assert_eq!(
        report.rejected[5].reason,
        "pred_task_id 99 names no task in this export"
    );
    assert!(report.relationships.is_empty());

    // No TASK section at all is the one thing the survey cannot excuse.
    let alien = ingest_xer("%T\tRSRC\n%F\trsrc_id\n%R\t1\n%E\n", "x");
    assert!(!alien.has_task_section());
    assert!(alien.activities.is_empty() && alien.rejected.is_empty());
}

/// The yard-shaped file saved from Windows: the same rows, read through the
/// 1252 table — `é` in a task name and the em dashes survive.
#[test]
fn a_windows_1252_export_decodes_to_the_same_schedule() {
    use wadl_ingest::encoding::{decode_xer, Encoding};
    let bytes: Vec<u8> = YARD_SHAPED
        .chars()
        .map(|c| match c {
            '\u{E9}' => 0xE9,
            '\u{2014}' => 0x97,
            '&' | ' '..='~' | '\t' | '\n' => c as u8,
            other => panic!("the fixture must stay 1252-encodable: {other:?}"),
        })
        .collect();
    assert_ne!(bytes.as_slice(), YARD_SHAPED.as_bytes());
    let (text, encoding) = decode_xer(&bytes);
    assert_eq!(encoding, Encoding::Windows1252);
    assert_eq!(text, YARD_SHAPED);
    let from_1252 = ingest_xer_with(&text, YARD_LABEL, &yard_map(), &utc());
    let from_utf8 = ingest_xer_with(YARD_SHAPED, YARD_LABEL, &yard_map(), &utc());
    assert_eq!(from_1252.activities, from_utf8.activities);
    let a4040 = from_1252
        .activities
        .iter()
        .find(|a| a.code == "A4040")
        .unwrap();
    assert!(a4040.name.contains("crew caf\u{E9} ("), "{}", a4040.name);
}
