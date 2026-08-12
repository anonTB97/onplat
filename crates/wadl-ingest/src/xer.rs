//! Primavera P6 XER ingest.
//!
//! The XER format is tab-delimited with a table-per-section header (`%T` table,
//! `%F` field names, `%R` row, `%E` end). Two hard-won rules govern this parser,
//! both documented in `docs/p6-ingest-schema.md` and both first proven by the
//! Python reference parser in `scripts/validate-p6-sample.py`:
//!
//! * **Fields are resolved by name from each section's `%F` line, never by
//!   position.** Field order is not stable across P6 versions or export
//!   layouts; a positional parser works until the first upgrade and then
//!   silently reads the wrong column.
//! * **Empty is not null-safe by accident.** XER writes empty strings — and
//!   sometimes a single space — for absent values. Everything is trimmed, and
//!   empty means absent.
//!
//! What comes out is the middle layer of the three-layer model: activities as
//! the file states them, graded, with every questionable row **rejected with its
//! line number** rather than guessed at. Which of P6's three date pairs becomes
//! the planned window is the one judgement this module applies, and it is the
//! documented one: actuals override the CPM forward pass, and the baseline
//! (`target_*`) is never the source — importing the baseline produces a board
//! that is confidently a month stale.

use std::collections::BTreeMap;

use wadl_domain::compartment::CompartmentNo;
use wadl_domain::time::{Timestamp, Window};
use wadl_domain::units::ManHours;

use crate::{Rejection, Reliability};

/// One parsed XER section: its field names and its rows, verbatim.
#[derive(Debug, Clone, Default)]
pub struct XerTable {
    fields: Vec<String>,
    rows: Vec<(usize, Vec<String>)>,
}

impl XerTable {
    /// The named field of `row`, trimmed; `None` when absent or empty.
    fn get<'a>(&self, row: &'a [String], name: &str) -> Option<&'a str> {
        let index = self.fields.iter().position(|f| f == name)?;
        let value = row.get(index)?.trim();
        (!value.is_empty()).then_some(value)
    }
}

/// The most cells a document may carry. A real multi-year carrier export is
/// a few million cells; a 256 MB body of one-character cells would be ~10⁸,
/// and every cell becomes an owned `String` (header + heap block), so an
/// unbounded parse amplifies an adversarial body several-fold in resident
/// memory. Refused with its reason, like every other rejection.
const MAX_CELLS: usize = 20_000_000;

/// A parsed XER file: sections by table name.
#[derive(Debug, Clone, Default)]
pub struct XerDocument {
    tables: BTreeMap<String, XerTable>,
    /// Structurally broken lines, kept for the report.
    rejected: Vec<Rejection>,
}

impl XerDocument {
    fn table(&self, name: &str) -> Option<&XerTable> {
        self.tables.get(name)
    }
}

/// Parses the raw XER text into sections. Never fails wholesale: a broken line
/// is a rejection with its line number, because one bad row in a ten-thousand
/// row export must not turn the other 9,999 invisible.
#[must_use]
pub fn parse_xer(input: &str) -> XerDocument {
    let mut doc = XerDocument::default();
    let mut current: Option<String> = None;
    let mut cell_count: usize = 0;
    for (line_no, raw) in input.lines().enumerate() {
        let row = line_no + 1;
        let mut cells = raw.split('\t');
        match cells.next() {
            Some("%T") => {
                let name = cells.next().unwrap_or("").trim().to_owned();
                doc.tables.entry(name.clone()).or_default();
                current = Some(name);
            }
            Some("%F") => {
                let Some(name) = &current else {
                    doc.rejected.push(Rejection {
                        row,
                        reason: "%F before any %T".to_owned(),
                    });
                    continue;
                };
                if let Some(table) = doc.tables.get_mut(name) {
                    table.fields = cells.map(|c| c.trim().to_owned()).collect();
                }
            }
            Some("%R") => {
                let Some(name) = &current else {
                    doc.rejected.push(Rejection {
                        row,
                        reason: "%R before any %T".to_owned(),
                    });
                    continue;
                };
                let Some(table) = doc.tables.get_mut(name) else {
                    continue;
                };
                // Width is checked on borrowed cells BEFORE anything is
                // owned: a rejected row must not cost an allocation per cell.
                let borrowed: Vec<&str> = cells.collect();
                if borrowed.len() != table.fields.len() {
                    doc.rejected.push(Rejection {
                        row,
                        reason: format!(
                            "{name}: {} values for {} fields",
                            borrowed.len(),
                            table.fields.len()
                        ),
                    });
                    continue;
                }
                cell_count += borrowed.len();
                if cell_count > MAX_CELLS {
                    doc.rejected.push(Rejection {
                        row,
                        reason: format!(
                            "document exceeds {MAX_CELLS} cells — not a schedule export this tool will hold in memory"
                        ),
                    });
                    break;
                }
                table
                    .rows
                    .push((row, borrowed.into_iter().map(str::to_owned).collect()));
            }
            Some("%E") => current = None,
            // ERMHDR and anything else outside a section is header noise.
            _ => {}
        }
    }
    doc
}

/// An XER timestamp, `YYYY-MM-DD HH:MM`, to a UTC instant.
fn parse_when(value: &str) -> Option<Timestamp> {
    let parsed = chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M").ok()?;
    Some(Timestamp::from_epoch_millis(
        parsed.and_utc().timestamp_millis(),
    ))
}

/// A numeric quantity, integer man-hours. XER may write `680` or `680.0`; the
/// fraction is truncated because [`ManHours`] is a whole-hour ledger unit.
fn parse_qty(value: &str) -> Option<i64> {
    value.split('.').next()?.trim().parse::<i64>().ok()
}

/// Where the schedule says an activity stands. Mirrors P6's `status_code`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum XerStatus {
    /// `TK_NotStart`.
    NotStarted,
    /// `TK_Active`.
    InProgress,
    /// `TK_Complete`.
    Complete,
}

/// One activity as the file states it, graded, ready for the mapping layer.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct XerActivity {
    /// The scheduler's activity id, e.g. `A4020`.
    pub code: String,
    /// Activity name.
    pub name: String,
    /// The WI/WO number from the `wi_number` UDF; `None` = unmapped, a visible
    /// state for the register.
    pub work_order_code: Option<String>,
    /// The compartment: from the dedicated UDF, or parsed out of the task
    /// name when the UDF is silent.
    pub compartment_no: Option<CompartmentNo>,
    /// [`Reliability::High`] when the dedicated UDF carried it — the schedule
    /// saying where. [`Reliability::Medium`] when a placard was parsed out of
    /// the task's own name — this parser guessing where, graded as the guess
    /// it is. [`Reliability::Low`] when the schedule did not say at all.
    pub compartment_reliability: Reliability,
    /// The top-level WBS node this task sits under — `Z6`, `Z5`, `MSTN` in
    /// the sample. A structural HINT at zone grain, never a location: yards
    /// habitually cut the top of the WBS by zone, so an unlocated activity
    /// often still says which zone it belongs to through where it sits.
    pub wbs_area: Option<String>,
    /// The assigned resource's short name — the trade, where resources are
    /// modelled per trade.
    pub trade: String,
    /// The window WADL works to: actuals override the CPM forward pass; the
    /// baseline is never consulted.
    pub planned: Option<Window>,
    /// Budgeted man-hours, summed over the activity's resource assignments.
    pub budget_hours: ManHours,
    /// Earned man-hours, likewise.
    pub earned_hours: ManHours,
    /// Where the schedule says it stands.
    pub status: XerStatus,
    /// `TT_Mile` — a key event, not work.
    pub is_milestone: bool,
    /// Provenance: the export this row came from, and the task code within it.
    pub source_ref: String,
}

/// One relationship, resolved to activity codes (P6's internal integer ids are
/// not stable across exports).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct XerRelationship {
    /// Predecessor activity code.
    pub pred: String,
    /// Successor activity code.
    pub succ: String,
    /// `PR_FS`, `PR_SS`, `PR_FF` or `PR_SF`.
    pub kind: String,
    /// Lag in hours; negative permits overlap — which is a finding, not an error.
    pub lag_hours: i64,
}

/// The outcome of an XER ingest run.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct XerIngestReport {
    /// The project short name, e.g. `CVN73-PIA26`.
    pub project: Option<String>,
    /// Activities accepted, in file order.
    pub activities: Vec<XerActivity>,
    /// Relationships accepted, resolved to codes.
    pub relationships: Vec<XerRelationship>,
    /// Every line that could not be honestly accepted, and why.
    pub rejected: Vec<Rejection>,
}

/// Resource assignments summed per task: (budget, earned, trade).
fn resources_by_task(doc: &XerDocument) -> BTreeMap<String, (i64, i64, String)> {
    let mut trade_of: BTreeMap<&str, &str> = BTreeMap::new();
    if let Some(rsrc) = doc.table("RSRC") {
        for (_, row) in &rsrc.rows {
            if let (Some(id), Some(name)) =
                (rsrc.get(row, "rsrc_id"), rsrc.get(row, "rsrc_short_name"))
            {
                trade_of.insert(id, name);
            }
        }
    }
    let mut out: BTreeMap<String, (i64, i64, String)> = BTreeMap::new();
    if let Some(assignments) = doc.table("TASKRSRC") {
        for (_, row) in &assignments.rows {
            let Some(task) = assignments.get(row, "task_id") else {
                continue;
            };
            let budget = assignments
                .get(row, "target_qty")
                .and_then(parse_qty)
                .unwrap_or(0);
            let earned = assignments
                .get(row, "act_reg_qty")
                .and_then(parse_qty)
                .unwrap_or(0);
            let trade = assignments
                .get(row, "rsrc_id")
                .and_then(|id| trade_of.get(id))
                .copied()
                .unwrap_or("");
            let entry = out.entry(task.to_owned()).or_insert((0, 0, String::new()));
            entry.0 += budget;
            entry.1 += earned;
            if entry.2.is_empty() {
                trade.clone_into(&mut entry.2);
            }
        }
    }
    out
}

/// UDF values of one named type, keyed by task id.
fn udf_by_task<'a>(doc: &'a XerDocument, type_name: &str) -> BTreeMap<&'a str, &'a str> {
    let mut out = BTreeMap::new();
    let (Some(types), Some(values)) = (doc.table("UDFTYPE"), doc.table("UDFVALUE")) else {
        return out;
    };
    let Some(type_id) = types.rows.iter().find_map(|(_, row)| {
        (types.get(row, "udf_type_name") == Some(type_name))
            .then(|| types.get(row, "udf_type_id"))
            .flatten()
    }) else {
        return out;
    };
    for (_, row) in &values.rows {
        if values.get(row, "udf_type_id") == Some(type_id) {
            if let (Some(task), Some(text)) =
                (values.get(row, "fk_id"), values.get(row, "udf_text"))
            {
                out.insert(task, text);
            }
        }
    }
    out
}

/// Each WBS node's top-level area: the ancestor sitting directly under the
/// project root, by short name — `Z6`, `Z5`, `MSTN` in the sample.
///
/// This is a HINT, not a location. Yards habitually cut the top of the WBS by
/// zone, so an activity that names no compartment still often says which zone
/// it belongs to through where it sits in the tree — worth carrying, graded as
/// the structural inference it is, and never a substitute for a placard. Depth
/// is capped so a cyclic parent link in a malformed export terminates instead
/// of hanging the ingest.
fn wbs_area_by_id(doc: &XerDocument) -> BTreeMap<String, String> {
    let mut short = BTreeMap::new();
    let mut parent = BTreeMap::new();
    if let Some(wbs) = doc.table("PROJWBS") {
        for (_, row) in &wbs.rows {
            let Some(id) = wbs.get(row, "wbs_id") else {
                continue;
            };
            if let Some(name) = wbs.get(row, "wbs_short_name") {
                short.insert(id.to_owned(), name.to_owned());
            }
            if let Some(up) = wbs.get(row, "parent_wbs_id") {
                if !up.is_empty() {
                    parent.insert(id.to_owned(), up.to_owned());
                }
            }
        }
    }
    let mut out = BTreeMap::new();
    for id in short.keys() {
        let mut node = id.clone();
        for _ in 0..32 {
            match parent.get(&node) {
                // The node whose parent has no parent sits directly under the
                // root — that is the area.
                Some(up) if parent.contains_key(up) => node = up.clone(),
                Some(_) => break,
                // The root itself names no area.
                None => {
                    node.clear();
                    break;
                }
            }
        }
        if let Some(area) = short.get(&node) {
            out.insert(id.clone(), area.clone());
        }
    }
    out
}

/// The planned window: actuals override the CPM pass, field by field, per the
/// dates section of `docs/p6-ingest-schema.md`. Returns an error string for a
/// present-but-unparseable date, because silently dropping a malformed date
/// would demote "the schedule said something broken" to "the schedule said
/// nothing", and those need different people to fix them.
fn planned_window(table: &XerTable, row: &[String]) -> Result<Option<Window>, String> {
    let when = |field: &str| -> Result<Option<Timestamp>, String> {
        match table.get(row, field) {
            None => Ok(None),
            Some(raw) => parse_when(raw)
                .map(Some)
                .ok_or_else(|| format!("unparseable {field}: {raw:?}")),
        }
    };
    let start = when("act_start_date")?.or(when("early_start_date")?);
    let finish = when("act_end_date")?.or(when("early_end_date")?);
    match (start, finish) {
        (Some(a), Some(b)) if a < b => Ok(Some(Window::new(a, b))),
        // A milestone's start equals its finish; give it a minute of width so a
        // half-open window can contain it at all.
        (Some(a), Some(b)) if a == b => Ok(Some(Window::new(
            a,
            Timestamp::from_epoch_millis(b.epoch_millis() + 60_000),
        ))),
        (Some(a), Some(b)) => Err(format!("window runs backwards: {a} → {b}")),
        // Undated is a real condition, not an error — the register shows it.
        _ => Ok(None),
    }
}

/// Ingests one XER export. `source_label` names the file for provenance — every
/// accepted activity carries it, because nothing enters without a source.
#[must_use]
pub fn ingest_xer(input: &str, source_label: &str) -> XerIngestReport {
    let doc = parse_xer(input);
    let mut report = XerIngestReport {
        rejected: doc.rejected.clone(),
        ..XerIngestReport::default()
    };
    report.project = doc.table("PROJECT").and_then(|t| {
        t.rows
            .first()
            .and_then(|(_, row)| t.get(row, "proj_short_name"))
            .map(str::to_owned)
    });

    let resources = resources_by_task(&doc);
    let compartments = udf_by_task(&doc, "compartment");
    let wi_numbers = udf_by_task(&doc, "wi_number");
    let areas = wbs_area_by_id(&doc);

    let mut code_of_task: BTreeMap<&str, &str> = BTreeMap::new();
    if let Some(tasks) = doc.table("TASK") {
        for (line, row) in &tasks.rows {
            match extract_activity(
                tasks,
                row,
                &resources,
                &compartments,
                &wi_numbers,
                &areas,
                source_label,
            ) {
                Ok(activity) => {
                    if let (Some(id), code) = (tasks.get(row, "task_id"), activity.code.clone()) {
                        code_of_task.insert(id, tasks.get(row, "task_code").unwrap_or_default());
                        let _ = code;
                    }
                    report.activities.push(activity);
                }
                Err(reason) => report.rejected.push(Rejection { row: *line, reason }),
            }
        }
    }

    if let Some(preds) = doc.table("TASKPRED") {
        for (line, row) in &preds.rows {
            match extract_relationship(preds, row, &code_of_task) {
                Ok(rel) => report.relationships.push(rel),
                Err(reason) => report.rejected.push(Rejection { row: *line, reason }),
            }
        }
    }
    report
}

/// One TASK row to an activity, or the reason it cannot be honestly accepted.
#[allow(clippy::too_many_arguments, reason = "one lookup table per XER table")]
fn extract_activity(
    tasks: &XerTable,
    row: &[String],
    resources: &BTreeMap<String, (i64, i64, String)>,
    compartments: &BTreeMap<&str, &str>,
    wi_numbers: &BTreeMap<&str, &str>,
    areas: &BTreeMap<String, String>,
    source_label: &str,
) -> Result<XerActivity, String> {
    let code = tasks
        .get(row, "task_code")
        .ok_or("no task_code — nothing anonymous enters")?;
    let name = tasks.get(row, "task_name").ok_or("no task_name")?;
    let status = match tasks.get(row, "status_code") {
        Some("TK_NotStart") => XerStatus::NotStarted,
        Some("TK_Active") => XerStatus::InProgress,
        Some("TK_Complete") => XerStatus::Complete,
        other => return Err(format!("unknown status_code {other:?}")),
    };
    let task_id = tasks.get(row, "task_id").unwrap_or_default();
    let (budget, earned, trade) = resources
        .get(task_id)
        .cloned()
        .unwrap_or((0, 0, String::new()));
    // Locating an activity, in order of trust: the dedicated UDF is the one
    // authored home the crosswalk names; failing that, a placard parsed out of
    // the activity's own NAME — schedulers write "... (3-160-2-Q)" constantly,
    // and refusing to read it would unlocate half of a real export. The two
    // paths are graded apart because they are different claims: the UDF is the
    // schedule saying where, the name is this parser guessing where.
    let (compartment, compartment_reliability) = match compartments.get(task_id).copied() {
        Some(udf) => (Some(udf.to_owned()), Reliability::High),
        None => match placard_in(name) {
            Some(found) => (Some(found), Reliability::Medium),
            None => (None, Reliability::Low),
        },
    };
    Ok(XerActivity {
        code: code.to_owned(),
        name: name.to_owned(),
        work_order_code: wi_numbers.get(task_id).map(|s| (*s).to_owned()),
        compartment_no: compartment.map(CompartmentNo::new),
        compartment_reliability,
        trade,
        planned: planned_window(tasks, row)?,
        budget_hours: ManHours::new(budget),
        earned_hours: ManHours::new(earned),
        status,
        is_milestone: tasks.get(row, "task_type") == Some("TT_Mile"),
        wbs_area: tasks
            .get(row, "wbs_id")
            .and_then(|id| areas.get(id))
            .cloned(),
        source_ref: format!("{source_label} · {code}"),
    })
}

/// The first USN placard (`deck-frame-side-usage`, e.g. `3-160-2-Q`) written
/// inside free text, or `None`. Tokens are tried stripped of the punctuation
/// a scheduler wraps them in — `(3-160-2-Q)`, `3-160-2-Q,` — and validated by
/// the domain's own USN parser, never by a looser pattern of this crate's
/// invention: a string that only looks like a placard must not locate work.
fn placard_in(text: &str) -> Option<String> {
    text.split_whitespace()
        .map(|tok| tok.trim_matches(|c: char| !c.is_ascii_alphanumeric()))
        .find(|tok| CompartmentNo::new(*tok).parse_usn().is_some())
        .map(str::to_owned)
}

/// One TASKPRED row to a relationship, ids resolved to codes.
fn extract_relationship(
    preds: &XerTable,
    row: &[String],
    code_of_task: &BTreeMap<&str, &str>,
) -> Result<XerRelationship, String> {
    let resolve = |field: &str| -> Result<String, String> {
        let id = preds.get(row, field).ok_or(format!("no {field}"))?;
        code_of_task
            .get(id)
            .map(|c| (*c).to_owned())
            .ok_or(format!("{field} {id} names no task in this export"))
    };
    Ok(XerRelationship {
        succ: resolve("task_id")?,
        pred: resolve("pred_task_id")?,
        kind: preds
            .get(row, "pred_type")
            .ok_or("no pred_type")?
            .to_owned(),
        lag_hours: preds
            .get(row, "lag_hr_cnt")
            .and_then(parse_qty)
            .unwrap_or(0),
    })
}
