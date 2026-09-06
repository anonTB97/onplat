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

use wadl_domain::civil::{self, WallNote, YardClock};
use wadl_domain::compartment::CompartmentNo;
use wadl_domain::time::{Timestamp, Window};
use wadl_domain::units::ManHours;

use crate::field_map::{
    ActivityCodeTypeSeen, FieldMap, FieldSource, FieldsSeen, ProjectSeen, UdfSeen,
};
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
                    doc.rejected.push(Rejection::new(
                        row,
                        "",
                        None,
                        "structure",
                        "%F before any %T",
                    ));
                    continue;
                };
                if let Some(table) = doc.tables.get_mut(name) {
                    table.fields = cells.map(|c| c.trim().to_owned()).collect();
                }
            }
            Some("%R") => {
                let Some(name) = &current else {
                    doc.rejected.push(Rejection::new(
                        row,
                        "",
                        None,
                        "structure",
                        "%R before any %T",
                    ));
                    continue;
                };
                let Some(table) = doc.tables.get_mut(name) else {
                    continue;
                };
                // Width is checked on borrowed cells BEFORE anything is
                // owned: a rejected row must not cost an allocation per cell.
                let borrowed: Vec<&str> = cells.collect();
                if borrowed.len() != table.fields.len() {
                    doc.rejected.push(Rejection::new(
                        row,
                        name,
                        None,
                        "width",
                        format!(
                            "{name}: {} values for {} fields",
                            borrowed.len(),
                            table.fields.len()
                        ),
                    ));
                    continue;
                }
                cell_count += borrowed.len();
                if cell_count > MAX_CELLS {
                    doc.rejected.push(Rejection::new(
                        row,
                        name,
                        None,
                        "structure",
                        format!(
                            "document exceeds {MAX_CELLS} cells — not a schedule export this tool will hold in memory"
                        ),
                    ));
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

/// An XER timestamp, `YYYY-MM-DD HH:MM`, read as the yard's wall clock, to
/// a UTC instant — plus what the wall clock did not say plainly (a time the
/// clock skipped, or one it repeated). P6 writes server-local wall time
/// with no zone, so the zone is the hull's clock document, never a guess.
fn parse_when(value: &str, clock: &YardClock) -> Option<(Timestamp, Option<WallNote>)> {
    use chrono::{Datelike as _, Timelike as _};
    let parsed = chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M").ok()?;
    let days = civil::days_from_civil(
        parsed.year(),
        u8::try_from(parsed.month()).ok()?,
        u8::try_from(parsed.day()).ok()?,
    );
    let minute = u16::try_from(parsed.hour() * 60 + parsed.minute()).ok()?;
    let (ms, note) = clock.to_utc(days, minute);
    Some((Timestamp::from_epoch_millis(ms), note))
}

/// The finding for a wall time the clock skipped or repeated: what the file
/// said, what it was read as, and the instant — so a scheduler can see the
/// hour P6 and the yard disagree about instead of a silent shift.
fn wall_clock_finding(
    line: usize,
    code: &str,
    what: &str,
    raw: &str,
    note: WallNote,
    clock: &YardClock,
    at: Timestamp,
) -> String {
    let zulu = civil::wall_label(YardClock::utc().local(at.epoch_millis()).minute_of_day);
    let wall = raw.split_once(' ').map_or(raw, |(_, t)| t);
    match note {
        WallNote::Gap => format!(
            "line {line}: {code} {what} {raw} does not exist in {} — read as {wall} standard ({zulu}Z)",
            clock.zone
        ),
        WallNote::Overlap => format!(
            "line {line}: {code} {what} {raw} occurs twice in {} — read as the first occurrence ({zulu}Z)",
            clock.zone
        ),
    }
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
    /// The WI/WO number from the mapped work-item field; `None` = unmapped,
    /// a visible state for the register.
    pub work_order_code: Option<String>,
    /// The compartment: from the mapped field, or parsed out of the task
    /// name when the field is silent and the map allows it.
    pub compartment_no: Option<CompartmentNo>,
    /// [`Reliability::High`] when the mapped UDF carried it — the schedule
    /// saying where. [`Reliability::Medium`] when an activity code carried it
    /// or a placard was parsed out of the task's own name — a convention or
    /// this parser guessing, graded as such. [`Reliability::Low`] when the
    /// schedule did not say at all.
    pub compartment_reliability: Reliability,
    /// The top-level WBS node this task sits under — `Z6`, `Z5`, `MSTN` in
    /// the sample. A structural HINT at zone grain, never a location: yards
    /// habitually cut the top of the WBS by zone, so an unlocated activity
    /// often still says which zone it belongs to through where it sits.
    pub wbs_area: Option<String>,
    /// The trade: the first labor resource's short name, or the mapped
    /// field. Empty when the file says nothing.
    pub trade: String,
    /// The work type from the mapped field, the vocabulary the rule table
    /// binds to. `None` when the map carries no work type.
    pub work_type: Option<String>,
    /// The window WADL works to: actuals override the CPM forward pass; the
    /// baseline is never consulted.
    pub planned: Option<Window>,
    /// Budgeted man-hours, summed over the activity's LABOR assignments.
    pub budget_hours: ManHours,
    /// Earned man-hours, likewise.
    pub earned_hours: ManHours,
    /// Where the schedule says it stands.
    pub status: XerStatus,
    /// `TT_Mile` or `TT_FinMile` — a key event, not work.
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

/// The outcome of an XER ingest run: what is served, what was quarantined
/// with its reason, what was excluded and why, and the survey of the file.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct XerIngestReport {
    /// The first served project's short name, e.g. `CVN73-PIA26`.
    pub project: Option<String>,
    /// Every served project's short name, in file order.
    pub projects_served: Vec<String>,
    /// Activities accepted, in file order.
    pub activities: Vec<XerActivity>,
    /// Relationships accepted, resolved to codes.
    pub relationships: Vec<XerRelationship>,
    /// Every line that could not be honestly accepted, and why — the
    /// quarantine. The rest of the file is served around it.
    pub rejected: Vec<Rejection>,
    /// Wall times the yard's clock skipped or repeated, accepted with the
    /// reading that was made — findings, not rejections.
    pub wall_clock_findings: Vec<String>,
    /// What the map meant against this file: a field matched by label only,
    /// several projects in the export, resources with no type. Never refuse.
    pub findings: Vec<String>,
    /// `TT_LOE` task codes — level of effort, not work; listed, not served.
    pub excluded_loe: Vec<String>,
    /// `TT_WBS` task codes — summary rows, not work; listed, not served.
    pub excluded_wbs: Vec<String>,
    /// `(task_code, proj_short_name)` for rows in projects the map does not
    /// serve.
    pub excluded_project: Vec<(String, String)>,
    /// `TASKPRED` rows with both ends in projects the map does not serve —
    /// dropped with their rows, neither served nor quarantined.
    pub excluded_project_edges: usize,
    /// `TASKRSRC` rows on material resources, not counted as man-hours.
    pub material_skipped: usize,
    /// `TASKRSRC` rows on equipment resources, not counted as man-hours.
    pub equipment_skipped: usize,
    /// `TASK` rows in the file, before any filter.
    pub task_rows: usize,
    /// The survey: which fields the file carries and how full they are.
    pub fields_seen: FieldsSeen,
}

impl XerIngestReport {
    /// Whether the file carried a `TASK` section at all — the one absence
    /// that makes it not a schedule export, refused whole at the door.
    #[must_use]
    pub fn has_task_section(&self) -> bool {
        self.fields_seen.sections.contains_key("TASK")
    }
}

/// What a resource is, per `RSRC.rsrc_type`. Only labor is man-hours: a
/// pallet of steel and a crane both carry `target_qty`, in tons and hours
/// of hire, and summing them into a trade's budget is the quiet lie this
/// distinction exists to stop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ResourceKind {
    Labor,
    Material,
    Equipment,
    /// `rsrc_type` blank or absent: counted as labor, said so.
    Untyped,
}

/// One `RSRC` row: its short name (the trade) and its kind.
struct ResourceRow<'a> {
    short_name: &'a str,
    kind: ResourceKind,
    type_name: Option<&'a str>,
}

/// The `RSRC` table by id, plus whether the file carries `rsrc_type` at all.
fn resources<'a>(
    doc: &'a XerDocument,
    findings: &mut Vec<String>,
) -> (BTreeMap<&'a str, ResourceRow<'a>>, bool) {
    let mut out = BTreeMap::new();
    let Some(rsrc) = doc.table("RSRC") else {
        return (out, false);
    };
    let has_type = rsrc.fields.iter().any(|f| f == "rsrc_type");
    for (_, row) in &rsrc.rows {
        let Some(id) = rsrc.get(row, "rsrc_id") else {
            continue;
        };
        let short_name = rsrc.get(row, "rsrc_short_name").unwrap_or("");
        let type_name = rsrc.get(row, "rsrc_type");
        let kind = match type_name {
            Some("RT_Labor") => ResourceKind::Labor,
            Some("RT_Mat") => ResourceKind::Material,
            Some("RT_Equip") => ResourceKind::Equipment,
            Some(other) => {
                findings.push(format!(
                    "resource {short_name}: rsrc_type {other:?} is not RT_Labor, RT_Mat or RT_Equip — counted as labor"
                ));
                ResourceKind::Untyped
            }
            None if has_type => {
                findings.push(format!(
                    "resource {short_name}: no rsrc_type — its assignments are counted as labor"
                ));
                ResourceKind::Untyped
            }
            None => ResourceKind::Untyped,
        };
        out.insert(
            id,
            ResourceRow {
                short_name,
                kind,
                type_name,
            },
        );
    }
    if !has_type && !rsrc.rows.is_empty() {
        findings.push(
            "RSRC carries no rsrc_type — every assignment is counted as labor man-hours".to_owned(),
        );
    }
    (out, has_type)
}

/// Labor assignments summed per task: (budget, earned, trade); material and
/// equipment rows counted aside; every assignment tallied by type for the
/// survey.
struct Assignments {
    by_task: BTreeMap<String, (i64, i64, String)>,
    material_skipped: usize,
    equipment_skipped: usize,
    by_type: BTreeMap<String, usize>,
}

fn assignments(doc: &XerDocument, resources: &BTreeMap<&str, ResourceRow<'_>>) -> Assignments {
    let mut out = Assignments {
        by_task: BTreeMap::new(),
        material_skipped: 0,
        equipment_skipped: 0,
        by_type: ["RT_Labor", "RT_Mat", "RT_Equip"]
            .into_iter()
            .map(|k| (k.to_owned(), 0))
            .collect(),
    };
    let Some(table) = doc.table("TASKRSRC") else {
        return out;
    };
    for (_, row) in &table.rows {
        let Some(task) = table.get(row, "task_id") else {
            continue;
        };
        let resource = table.get(row, "rsrc_id").and_then(|id| resources.get(id));
        let type_key = resource
            .and_then(|r| r.type_name)
            .unwrap_or("untyped")
            .to_owned();
        *out.by_type.entry(type_key).or_insert(0) += 1;
        match resource.map(|r| r.kind) {
            Some(ResourceKind::Material) => {
                out.material_skipped += 1;
                continue;
            }
            Some(ResourceKind::Equipment) => {
                out.equipment_skipped += 1;
                continue;
            }
            Some(ResourceKind::Labor | ResourceKind::Untyped) | None => {}
        }
        let budget = table
            .get(row, "target_qty")
            .and_then(parse_qty)
            .unwrap_or(0);
        let earned = table
            .get(row, "act_reg_qty")
            .and_then(parse_qty)
            .unwrap_or(0);
        let trade = resource.map_or("", |r| r.short_name);
        let entry = out
            .by_task
            .entry(task.to_owned())
            .or_insert((0, 0, String::new()));
        entry.0 += budget;
        entry.1 += earned;
        if entry.2.is_empty() {
            trade.clone_into(&mut entry.2);
        }
    }
    out
}

/// A field name matched the way the map promises: trimmed, case-insensitive.
fn same_field(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

/// The `UDFTYPE` row the map names — by `udf_type_name` first, then by
/// `udf_type_label`; returns its id, its real name, and whether only the
/// label matched.
fn udf_type<'a>(doc: &'a XerDocument, wanted: &str) -> Option<(&'a str, &'a str, bool)> {
    let types = doc.table("UDFTYPE")?;
    let find = |field: &str| {
        types.rows.iter().find_map(|(_, row)| {
            let value = types.get(row, field)?;
            same_field(value, wanted).then(|| {
                (
                    types.get(row, "udf_type_id").unwrap_or(""),
                    types.get(row, "udf_type_name").unwrap_or(value),
                )
            })
        })
    };
    find("udf_type_name")
        .map(|(id, name)| (id, name, false))
        .or_else(|| find("udf_type_label").map(|(id, name)| (id, name, true)))
}

/// UDF values of one type id, keyed by task id.
fn udf_values<'a>(doc: &'a XerDocument, type_id: &str) -> BTreeMap<&'a str, &'a str> {
    let mut out = BTreeMap::new();
    let Some(values) = doc.table("UDFVALUE") else {
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

/// Activity-code values of one code type, keyed by task id:
/// `ACTVTYPE.actv_code_type` → its `ACTVCODE` rows' `short_name` via
/// `TASKACTV`.
fn activity_code_values<'a>(
    doc: &'a XerDocument,
    wanted: &str,
) -> Option<BTreeMap<&'a str, &'a str>> {
    let types = doc.table("ACTVTYPE")?;
    let type_id = types.rows.iter().find_map(|(_, row)| {
        same_field(types.get(row, "actv_code_type")?, wanted)
            .then(|| types.get(row, "actv_code_type_id"))
            .flatten()
    })?;
    let mut short_name: BTreeMap<&str, &str> = BTreeMap::new();
    if let Some(codes) = doc.table("ACTVCODE") {
        for (_, row) in &codes.rows {
            if codes.get(row, "actv_code_type_id") == Some(type_id) {
                if let (Some(id), Some(name)) =
                    (codes.get(row, "actv_code_id"), codes.get(row, "short_name"))
                {
                    short_name.insert(id, name);
                }
            }
        }
    }
    let mut out = BTreeMap::new();
    if let Some(links) = doc.table("TASKACTV") {
        for (_, row) in &links.rows {
            if let (Some(task), Some(code)) =
                (links.get(row, "task_id"), links.get(row, "actv_code_id"))
            {
                if let Some(name) = short_name.get(code) {
                    out.insert(task, *name);
                }
            }
        }
    }
    Some(out)
}

/// One slot resolved against the file: the values by task id, and the
/// grade a value from it earns.
struct Slot<'a> {
    values: BTreeMap<&'a str, &'a str>,
    grade: Reliability,
}

impl Slot<'_> {
    fn empty() -> Self {
        Self {
            values: BTreeMap::new(),
            grade: Reliability::Low,
        }
    }
}

/// Resolves one mapped slot. A label-only UDF match is a finding; a field
/// the file does not carry has already been reported by
/// [`FieldMap::findings_against`] and resolves empty.
fn resolve_slot<'a>(
    doc: &'a XerDocument,
    slot: &str,
    source: &FieldSource,
    findings: &mut Vec<String>,
) -> Slot<'a> {
    match source {
        FieldSource::Udf { name } => match udf_type(doc, name) {
            Some((id, real_name, by_label)) => {
                if by_label {
                    findings.push(format!(
                        "{slot}: no UDF named {name:?} — matched by label to UDF {real_name:?}"
                    ));
                }
                Slot {
                    values: udf_values(doc, id),
                    grade: Reliability::High,
                }
            }
            None => Slot::empty(),
        },
        FieldSource::ActivityCode { name } => {
            activity_code_values(doc, name).map_or_else(Slot::empty, |values| Slot {
                values,
                grade: Reliability::Medium,
            })
        }
        FieldSource::Resource | FieldSource::NotCarried => Slot::empty(),
    }
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
/// dates section of `docs/p6-ingest-schema.md`. Returns the quarantine class
/// and reason for a present-but-unparseable date, because silently dropping
/// a malformed date would demote "the schedule said something broken" to
/// "the schedule said nothing", and those need different people to fix them.
fn planned_window(
    table: &XerTable,
    row: &[String],
    line: usize,
    code: &str,
    ctx: &TaskContext<'_>,
    findings: &mut Vec<String>,
) -> Result<Option<Window>, (&'static str, String)> {
    let mut when = |field: &str, what: &str| -> Result<Option<Timestamp>, (&'static str, String)> {
        match table.get(row, field) {
            None => Ok(None),
            Some(raw) => {
                let (at, note) = parse_when(raw, ctx.clock)
                    .ok_or_else(|| ("unparseable_date", format!("unparseable {field}: {raw:?}")))?;
                if let Some(note) = note {
                    findings.push(wall_clock_finding(
                        line, code, what, raw, note, ctx.clock, at,
                    ));
                }
                Ok(Some(at))
            }
        }
    };
    let start = match when("act_start_date", "actual start")? {
        Some(at) => Some(at),
        None => when("early_start_date", "start")?,
    };
    let finish = match when("act_end_date", "actual finish")? {
        Some(at) => Some(at),
        None => when("early_end_date", "finish")?,
    };
    match (start, finish) {
        (Some(a), Some(b)) if a < b => Ok(Some(Window::new(a, b))),
        // A milestone's start equals its finish; give it a minute of width so a
        // half-open window can contain it at all.
        (Some(a), Some(b)) if a == b => Ok(Some(Window::new(
            a,
            Timestamp::from_epoch_millis(b.epoch_millis() + 60_000),
        ))),
        (Some(a), Some(b)) => Err((
            "backwards_window",
            format!("window runs backwards: {a} → {b}"),
        )),
        // Undated is a real condition, not an error — the register shows it.
        _ => Ok(None),
    }
}

/// Ingests one XER export under today's default map with its wall clock read
/// as UTC — the CLI's evidence-table path, and any caller with neither a
/// map nor a clock in hand. The served schedule goes through
/// [`ingest_xer_with`] with the hull's map and clock.
#[must_use]
pub fn ingest_xer(input: &str, source_label: &str) -> XerIngestReport {
    ingest_xer_with(input, source_label, &FieldMap::default(), &YardClock::utc())
}

/// The lookups one TASK row is resolved against, and the clock its wall
/// times are read in.
struct TaskContext<'a> {
    resources: BTreeMap<String, (i64, i64, String)>,
    compartment: Slot<'a>,
    work_item: Slot<'a>,
    work_type: Slot<'a>,
    /// `None` when the trade comes from the labor resource.
    trade: Option<Slot<'a>>,
    placards_from_names: bool,
    areas: BTreeMap<String, String>,
    source_label: &'a str,
    clock: &'a YardClock,
}

/// The survey of a file: sections, projects, UDF types, activity code types,
/// task types and resource types with their row counts. No schedule content.
fn survey(doc: &XerDocument, assignments: &Assignments, has_rsrc_type: bool) -> FieldsSeen {
    let mut seen = FieldsSeen {
        has_rsrc_type,
        resource_types: assignments.by_type.clone(),
        ..FieldsSeen::default()
    };
    for (name, table) in &doc.tables {
        seen.sections.insert(name.clone(), table.rows.len());
    }
    for kind in ["TT_Task", "TT_Mile", "TT_FinMile", "TT_LOE", "TT_WBS"] {
        seen.task_types.insert(kind.to_owned(), 0);
    }
    let mut tasks_by_project: BTreeMap<&str, usize> = BTreeMap::new();
    if let Some(tasks) = doc.table("TASK") {
        for (_, row) in &tasks.rows {
            let kind = tasks.get(row, "task_type").unwrap_or("(blank)");
            *seen.task_types.entry(kind.to_owned()).or_insert(0) += 1;
            if let Some(project) = tasks.get(row, "proj_id") {
                *tasks_by_project.entry(project).or_insert(0) += 1;
            }
        }
    }
    if let Some(projects) = doc.table("PROJECT") {
        for (_, row) in &projects.rows {
            let id = projects.get(row, "proj_id").unwrap_or("");
            seen.projects.push(ProjectSeen {
                id: id.to_owned(),
                short_name: projects
                    .get(row, "proj_short_name")
                    .unwrap_or(id)
                    .to_owned(),
                tasks: tasks_by_project.get(id).copied().unwrap_or(0),
            });
        }
    }
    let mut values_by_udf: BTreeMap<&str, usize> = BTreeMap::new();
    if let Some(values) = doc.table("UDFVALUE") {
        for (_, row) in &values.rows {
            if let Some(id) = values.get(row, "udf_type_id") {
                *values_by_udf.entry(id).or_insert(0) += 1;
            }
        }
    }
    if let Some(types) = doc.table("UDFTYPE") {
        for (_, row) in &types.rows {
            let id = types.get(row, "udf_type_id").unwrap_or("");
            seen.udfs.push(UdfSeen {
                name: types.get(row, "udf_type_name").unwrap_or(id).to_owned(),
                label: types.get(row, "udf_type_label").map(str::to_owned),
                table: types.get(row, "table_name").map(str::to_owned),
                values: values_by_udf.get(id).copied().unwrap_or(0),
            });
        }
    }
    seen.activity_code_types = activity_code_types_seen(doc);
    seen
}

/// Every `ACTVTYPE` row with the number of `TASKACTV` assignments of its type
/// (via the link's own `actv_code_type_id`, or the code's when the link
/// does not carry one).
fn activity_code_types_seen(doc: &XerDocument) -> Vec<ActivityCodeTypeSeen> {
    let Some(types) = doc.table("ACTVTYPE") else {
        return Vec::new();
    };
    let mut type_of_code: BTreeMap<&str, &str> = BTreeMap::new();
    if let Some(codes) = doc.table("ACTVCODE") {
        for (_, row) in &codes.rows {
            if let (Some(code), Some(kind)) = (
                codes.get(row, "actv_code_id"),
                codes.get(row, "actv_code_type_id"),
            ) {
                type_of_code.insert(code, kind);
            }
        }
    }
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    if let Some(links) = doc.table("TASKACTV") {
        for (_, row) in &links.rows {
            let kind = links.get(row, "actv_code_type_id").or_else(|| {
                links
                    .get(row, "actv_code_id")
                    .and_then(|c| type_of_code.get(c).copied())
            });
            if let Some(kind) = kind {
                *counts.entry(kind).or_insert(0) += 1;
            }
        }
    }
    types
        .rows
        .iter()
        .map(|(_, row)| {
            let id = types.get(row, "actv_code_type_id").unwrap_or("");
            ActivityCodeTypeSeen {
                name: types.get(row, "actv_code_type").unwrap_or(id).to_owned(),
                values: counts.get(id).copied().unwrap_or(0),
            }
        })
        .collect()
}

/// Which projects the map serves: `(proj_id → short_name)` for the served
/// set, and the short name of every project for the exclusion list.
struct Projects<'a> {
    all: BTreeMap<&'a str, &'a str>,
    served: BTreeMap<&'a str, &'a str>,
    /// Served short names in file order.
    served_names: Vec<String>,
}

fn projects<'a>(doc: &'a XerDocument, map: &FieldMap, findings: &mut Vec<String>) -> Projects<'a> {
    let mut out = Projects {
        all: BTreeMap::new(),
        served: BTreeMap::new(),
        served_names: Vec::new(),
    };
    let Some(table) = doc.table("PROJECT") else {
        return out;
    };
    for (_, row) in &table.rows {
        let Some(id) = table.get(row, "proj_id") else {
            continue;
        };
        let name = table.get(row, "proj_short_name").unwrap_or(id);
        out.all.insert(id, name);
        let served = map.projects.is_empty() || map.projects.iter().any(|p| same_field(p, name));
        if served {
            out.served.insert(id, name);
            out.served_names.push(name.to_owned());
        }
    }
    if map.projects.is_empty() && out.all.len() > 1 {
        findings.push(format!(
            "{} projects in this export ({}) — every one is served; name the hull's in the field map to serve one",
            out.all.len(),
            out.all.values().copied().collect::<Vec<_>>().join(", ")
        ));
    }
    out
}

impl Projects<'_> {
    /// Whether a task's project is served. A task whose project is not in
    /// `PROJECT` at all is served when no filter is set — the file is the
    /// authority on its own rows — and excluded when one is.
    fn serves(&self, proj_id: Option<&str>, filtered: bool) -> bool {
        match proj_id {
            Some(id) => self.served.contains_key(id) || (!filtered && !self.all.contains_key(id)),
            None => !filtered,
        }
    }

    fn name_of(&self, proj_id: Option<&str>) -> String {
        proj_id
            .map_or("(no project)", |id| self.all.get(id).copied().unwrap_or(id))
            .to_owned()
    }
}

/// Why a TASK row that was neither served nor quarantined is absent — for
/// the logic pass to say so when a relationship reaches it.
#[derive(Debug, Clone, Copy)]
enum Absent<'a> {
    Loe,
    Wbs,
    Project(&'a str),
    Quarantined,
}

/// Ingests one XER export through the hull's field map, its wall clock read
/// in `clock`. `source_label` names the file for provenance — every accepted
/// activity carries it, because nothing enters without a source.
///
/// Never refuses a file: a row that cannot be honestly accepted is
/// quarantined with its line, class and reason, and the rest is served. The
/// door decides whether what survived is worth serving.
#[must_use]
pub fn ingest_xer_with(
    input: &str,
    source_label: &str,
    map: &FieldMap,
    clock: &YardClock,
) -> XerIngestReport {
    let doc = parse_xer(input);
    let mut report = XerIngestReport {
        rejected: doc.rejected.clone(),
        ..XerIngestReport::default()
    };
    let (resource_rows, has_rsrc_type) = resources(&doc, &mut report.findings);
    let assignments = assignments(&doc, &resource_rows);
    report.fields_seen = survey(&doc, &assignments, has_rsrc_type);
    report.material_skipped = assignments.material_skipped;
    report.equipment_skipped = assignments.equipment_skipped;
    report
        .findings
        .extend(map.findings_against(Some(&report.fields_seen)));
    let projects = projects(&doc, map, &mut report.findings);
    report.projects_served.clone_from(&projects.served_names);
    report.project = projects.served_names.first().cloned();

    let ctx = TaskContext {
        resources: assignments.by_task,
        compartment: resolve_slot(&doc, "compartment", &map.compartment, &mut report.findings),
        work_item: resolve_slot(&doc, "work_item", &map.work_item, &mut report.findings),
        work_type: resolve_slot(&doc, "work_type", &map.work_type, &mut report.findings),
        trade: (map.trade != FieldSource::Resource)
            .then(|| resolve_slot(&doc, "trade", &map.trade, &mut report.findings)),
        placards_from_names: map.placards_from_names,
        areas: wbs_area_by_id(&doc),
        source_label,
        clock,
    };

    let mut code_of_task: BTreeMap<&str, &str> = BTreeMap::new();
    let mut absent: BTreeMap<&str, Absent<'_>> = BTreeMap::new();
    let filtered = !map.projects.is_empty();
    if let Some(tasks) = doc.table("TASK") {
        // The file's rows, not the parser's: a row the width check refused
        // never reached `tasks.rows` but was a TASK row all the same.
        report.task_rows =
            tasks.rows.len() + doc.rejected.iter().filter(|r| r.table == "TASK").count();
        for (line, row) in &tasks.rows {
            let task_id = tasks.get(row, "task_id").unwrap_or_default();
            let code = tasks.get(row, "task_code");
            let named = code.unwrap_or("(no code)").to_owned();
            let proj_id = tasks.get(row, "proj_id");
            if !projects.serves(proj_id, filtered) {
                let project = projects.name_of(proj_id);
                if let Some(id) = proj_id {
                    absent.insert(
                        task_id,
                        Absent::Project(projects.all.get(id).copied().unwrap_or(id)),
                    );
                }
                report.excluded_project.push((named, project));
                continue;
            }
            match tasks.get(row, "task_type") {
                Some("TT_LOE") => {
                    absent.insert(task_id, Absent::Loe);
                    report.excluded_loe.push(named);
                    continue;
                }
                Some("TT_WBS") => {
                    absent.insert(task_id, Absent::Wbs);
                    report.excluded_wbs.push(named);
                    continue;
                }
                _ => {}
            }
            match extract_activity(tasks, row, *line, &ctx, &mut report.wall_clock_findings) {
                Ok(activity) => {
                    code_of_task.insert(task_id, code.unwrap_or_default());
                    report.activities.push(activity);
                }
                Err((class, reason)) => {
                    absent.insert(task_id, Absent::Quarantined);
                    report
                        .rejected
                        .push(Rejection::new(*line, "TASK", code, class, reason));
                }
            }
        }
    }

    if let Some(preds) = doc.table("TASKPRED") {
        let logic = LogicContext {
            code_of_task: &code_of_task,
            absent: &absent,
            projects: &projects,
        };
        for (line, row) in &preds.rows {
            match extract_relationship(preds, row, &logic) {
                Ok(Some(rel)) => report.relationships.push(rel),
                Ok(None) => report.excluded_project_edges += 1,
                Err((class, reason)) => {
                    let succ = preds
                        .get(row, "task_id")
                        .and_then(|id| code_of_task.get(id).copied());
                    report
                        .rejected
                        .push(Rejection::new(*line, "TASKPRED", succ, class, reason));
                }
            }
        }
    }
    report.rejected.sort_by_key(|r| r.row);
    report
}

/// One TASK row to an activity, or the class and reason it cannot be
/// honestly accepted.
fn extract_activity(
    tasks: &XerTable,
    row: &[String],
    line: usize,
    ctx: &TaskContext<'_>,
    findings: &mut Vec<String>,
) -> Result<XerActivity, (&'static str, String)> {
    let code = tasks.get(row, "task_code").ok_or((
        "no_code",
        "no task_code — nothing anonymous enters".to_owned(),
    ))?;
    let name = tasks
        .get(row, "task_name")
        .ok_or(("no_name", "no task_name".to_owned()))?;
    let status = match tasks.get(row, "status_code") {
        Some("TK_NotStart") => XerStatus::NotStarted,
        Some("TK_Active") => XerStatus::InProgress,
        Some("TK_Complete") => XerStatus::Complete,
        other => return Err(("unknown_status", format!("unknown status_code {other:?}"))),
    };
    let task_id = tasks.get(row, "task_id").unwrap_or_default();
    let (budget, earned, resource_trade) =
        ctx.resources
            .get(task_id)
            .cloned()
            .unwrap_or((0, 0, String::new()));
    // Locating an activity, in order of trust: the mapped field is the one
    // authored home the map names (High for a UDF, Medium for an activity
    // code — a convention, not a controlled field); failing that, a placard
    // parsed out of the activity's own NAME when the map allows it —
    // schedulers write "... (3-160-2-Q)" constantly, and refusing to read it
    // would unlocate half of a real export. The paths are graded apart
    // because they are different claims: the field is the schedule saying
    // where, the name is this parser guessing where.
    let (compartment, compartment_reliability) = match ctx.compartment.values.get(task_id).copied()
    {
        Some(field) => (Some(field.to_owned()), ctx.compartment.grade),
        None => match ctx.placards_from_names.then(|| placard_in(name)).flatten() {
            Some(found) => (Some(found), Reliability::Medium),
            None => (None, Reliability::Low),
        },
    };
    let trade = match &ctx.trade {
        None => resource_trade,
        Some(slot) => slot
            .values
            .get(task_id)
            .map(|s| (*s).to_owned())
            .unwrap_or_default(),
    };
    Ok(XerActivity {
        code: code.to_owned(),
        name: name.to_owned(),
        work_order_code: ctx.work_item.values.get(task_id).map(|s| (*s).to_owned()),
        compartment_no: compartment.map(CompartmentNo::new),
        compartment_reliability,
        trade,
        work_type: ctx.work_type.values.get(task_id).map(|s| (*s).to_owned()),
        planned: planned_window(tasks, row, line, code, ctx, findings)?,
        budget_hours: ManHours::new(budget),
        earned_hours: ManHours::new(earned),
        status,
        is_milestone: matches!(tasks.get(row, "task_type"), Some("TT_Mile" | "TT_FinMile")),
        wbs_area: tasks
            .get(row, "wbs_id")
            .and_then(|id| ctx.areas.get(id))
            .cloned(),
        source_ref: format!("{} · {code}", ctx.source_label),
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

/// What the logic pass resolves task ids against.
struct LogicContext<'a> {
    code_of_task: &'a BTreeMap<&'a str, &'a str>,
    absent: &'a BTreeMap<&'a str, Absent<'a>>,
    projects: &'a Projects<'a>,
}

impl LogicContext<'_> {
    fn in_unserved_project(&self, id: &str) -> bool {
        matches!(self.absent.get(id), Some(Absent::Project(_)))
    }

    /// A task id to its served code, or the class and reason it is not one:
    /// a row in an unserved project is `cross_project_logic` (the reason
    /// names the project); a row excluded, quarantined or unknown is
    /// `unknown_task_in_logic`.
    fn resolve(
        &self,
        field: &str,
        id: &str,
        own_project: Option<&str>,
        its_project: Option<&str>,
    ) -> Result<String, (&'static str, String)> {
        if let Some(code) = self.code_of_task.get(id) {
            return Ok((*code).to_owned());
        }
        match self.absent.get(id) {
            Some(Absent::Project(project)) => Err((
                "cross_project_logic",
                format!("{field} {id} is in project {project}, which is not served"),
            )),
            Some(Absent::Loe) => Err((
                "unknown_task_in_logic",
                format!("{field} {id} is a level-of-effort row, excluded from work"),
            )),
            Some(Absent::Wbs) => Err((
                "unknown_task_in_logic",
                format!("{field} {id} is a WBS summary row, excluded from work"),
            )),
            Some(Absent::Quarantined) => Err((
                "unknown_task_in_logic",
                format!("{field} {id} was quarantined"),
            )),
            None => match its_project {
                Some(project) if own_project.is_some_and(|own| own != project) => Err((
                    "cross_project_logic",
                    format!(
                        "{field} {id} is in project {}, which this export does not carry",
                        self.projects.name_of(Some(project))
                    ),
                )),
                _ => Err((
                    "unknown_task_in_logic",
                    format!("{field} {id} names no task in this export"),
                )),
            },
        }
    }
}

/// One TASKPRED row to a relationship, ids resolved to codes. `Ok(None)`
/// when both ends sit in projects the map does not serve: logic wholly
/// inside excluded work is excluded with it, not quarantined — nothing
/// served is touched by it.
fn extract_relationship(
    preds: &XerTable,
    row: &[String],
    logic: &LogicContext<'_>,
) -> Result<Option<XerRelationship>, (&'static str, String)> {
    let own_project = preds.get(row, "proj_id");
    let pred_project = preds.get(row, "pred_proj_id");
    let id = |field: &str| {
        preds
            .get(row, field)
            .ok_or(("structure", format!("no {field}")))
    };
    let (succ_id, pred_id) = (id("task_id")?, id("pred_task_id")?);
    if logic.in_unserved_project(succ_id) && logic.in_unserved_project(pred_id) {
        return Ok(None);
    }
    let succ = logic.resolve("task_id", succ_id, own_project, own_project)?;
    let pred = logic.resolve("pred_task_id", pred_id, own_project, pred_project)?;
    Ok(Some(XerRelationship {
        succ,
        pred,
        kind: preds
            .get(row, "pred_type")
            .ok_or(("structure", "no pred_type".to_owned()))?
            .to_owned(),
        lag_hours: preds
            .get(row, "lag_hr_cnt")
            .and_then(parse_qty)
            .unwrap_or(0),
    }))
}
