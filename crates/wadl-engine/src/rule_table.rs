//! The safety authority's rule table, compiled.
//!
//! The table is the authority's own CSV — `handoff/01-rule-table.csv`'s twelve
//! columns, verbatim and in order, plus nine compile columns the sitting fills
//! in and an optional version-id column the export carries. [`parse`] reads it
//! (RFC 4180 quoting, `#` comment lines ignored), [`compile`] turns each
//! *Hazard cascade* row into one or two [`RuleEntry`]s and says, for every row
//! it cannot compile, why not — a gate row *needs a permit object*, a
//! *Conditional* state *is a process, not an outcome* — and [`export`] writes
//! a [`RuleSet`] back out in the same layout, so what the yard signs is what
//! the engine runs and the round trip is an identity (proved on the seed).
//!
//! Pure, like the rest of the crate: no I/O, no clock. The two date columns
//! resolve through the hull's [`YardClock`], which the caller supplies.
//! Version ids are minted by the caller ([`Compiled::with_versions`]); rows
//! that carry one in column 22 keep it.

use core::fmt;
use std::collections::btree_map::Entry;
use std::collections::BTreeMap;

use wadl_domain::civil::{civil_from_days, days_from_civil, YardClock};
use wadl_domain::ids::RuleVersionId;
use wadl_domain::time::Timestamp;
use wadl_domain::units::{HopDepth, Minutes};

use crate::coupling::CouplingCode;
use crate::decision::DecisionState;
use crate::evaluate::HazardKind;
use crate::rules::{Applies, HoldFrom, RuleBinding, RuleEntry, RuleSet};

/// The handoff's twelve columns, required verbatim and in order.
pub const HANDOFF_COLUMNS: [&str; 12] = [
    "Rule ID",
    "Name",
    "Kind",
    "Trigger condition",
    "Propagation type",
    "Hop depth",
    "Resulting state",
    "Authority document",
    "Clearing condition",
    "Who may clear",
    "Config anchor",
    "Open question for the safety authority",
];

/// The nine compile columns the sitting fills, looked up by name.
pub const COMPILE_COLUMNS: [&str; 9] = [
    "Hazard kind",
    "Coupling code",
    "Hold minutes",
    "Hold from",
    "Clearing authority code",
    "Work types",
    "Categories",
    "Effective from",
    "Effective to",
];

/// The optional twenty-second column: a version id, present in the export.
pub const VERSION_COLUMN: &str = "Version id";

/// The one `Kind` the pilot compiles.
pub const CASCADE_KIND: &str = "Hazard cascade";

/// Why a file is refused whole. `line` is 1-based in the file; `0` is the
/// file as a whole (the header).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Refusal {
    /// The file line the refusal points at, or 0 for the file itself.
    pub line: usize,
    /// The reason, in a sentence.
    pub text: String,
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.line == 0 {
            write!(f, "{}", self.text)
        } else {
            write!(f, "line {}: {}", self.line, self.text)
        }
    }
}

/// One data record: its file line and its cells, padded to the header.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Row {
    /// The 1-based line the record began on.
    pub line: usize,
    /// The cells, in header order, padded with blanks to the header's width.
    pub cells: Vec<String>,
}

/// A parsed table: the header as given and the data rows in file order.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Table {
    /// The header cells, trimmed.
    pub header: Vec<String>,
    /// The data rows.
    pub rows: Vec<Row>,
}

impl Table {
    /// The index of a named column, if the header carries it.
    #[must_use]
    pub fn column(&self, name: &str) -> Option<usize> {
        self.header.iter().position(|h| h == name)
    }

    /// A row's cell under a named column, trimmed; blank when the column or
    /// the cell is absent.
    #[must_use]
    pub fn cell<'a>(&self, row: &'a Row, name: &str) -> &'a str {
        self.column(name)
            .and_then(|i| row.cells.get(i))
            .map_or("", |s| s.trim())
    }
}

/// Which row an entry or a refusal-to-compile came from.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RowRef {
    /// The `Rule ID` cell.
    pub rule: String,
    /// The row's ordinal among the rows of that rule id, counting from 0 in
    /// file order; a `0–n` hop range takes two (its same-space and its coupled
    /// entry).
    pub ordinal: u8,
    /// The file line.
    pub line: usize,
}

impl fmt::Display for RowRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}-{}", self.rule, self.ordinal)
    }
}

/// What a table compiles to.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Compiled {
    /// The entries, in file order, each with the row it came from.
    pub entries: Vec<(RowRef, RuleEntry)>,
    /// The rows that did not compile, each with the sentence saying why.
    pub not_compiled: Vec<(RowRef, String)>,
}

impl Compiled {
    /// Mints a version id for every entry that came out with a nil one; an
    /// entry whose row carried a `Version id` keeps it.
    #[must_use]
    pub fn with_versions(mut self, mint: impl Fn(&RuleEntry) -> RuleVersionId) -> Self {
        for (_, entry) in &mut self.entries {
            if entry.rule_version.as_uuid().is_nil() {
                entry.rule_version = mint(entry);
            }
        }
        self
    }

    /// The compiled entries as a rule set, in file order.
    #[must_use]
    pub fn rule_set(&self) -> RuleSet {
        RuleSet::new(self.entries.iter().map(|(_, e)| e.clone()).collect())
    }
}

// ---------------------------------------------------------------------------
// Parsing.
// ---------------------------------------------------------------------------

/// Splits RFC 4180 text into records of cells. A quoted cell may carry commas,
/// doubled quotes and line breaks; records end at a bare `\n` or `\r\n`. Each
/// record carries the 1-based line it began on.
fn records(text: &str) -> Vec<(usize, Vec<String>)> {
    let mut out = Vec::new();
    let mut cells = Vec::new();
    let mut cell = String::new();
    let mut quoted = false;
    let mut line = 1;
    let mut record_line = 1;
    let mut chars = text
        .strip_prefix('\u{feff}')
        .unwrap_or(text)
        .chars()
        .peekable();
    while let Some(c) = chars.next() {
        match (quoted, c) {
            (true, '"') => {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    cell.push('"');
                } else {
                    quoted = false;
                }
            }
            (true, '\n') => {
                line += 1;
                cell.push(c);
            }
            (false, '"') => quoted = true,
            (false, ',') => cells.push(core::mem::take(&mut cell)),
            (false, '\r') => {}
            (false, '\n') => {
                cells.push(core::mem::take(&mut cell));
                out.push((record_line, core::mem::take(&mut cells)));
                line += 1;
                record_line = line;
            }
            _ => cell.push(c),
        }
    }
    if !cell.is_empty() || !cells.is_empty() {
        cells.push(cell);
        out.push((record_line, cells));
    }
    out
}

/// Whether a record is a `#` comment line or blank.
fn is_comment_or_blank(cells: &[String]) -> bool {
    match cells.first() {
        None => true,
        Some(first) => {
            first.trim_start().starts_with('#') || (cells.len() == 1 && first.trim().is_empty())
        }
    }
}

/// Parses the table. Refused whole when the first twelve header cells are not
/// the handoff's, a header name repeats, or a row is wider than the header.
///
/// # Errors
/// Every refusal found, never just the first.
pub fn parse(text: &str) -> Result<Table, Vec<Refusal>> {
    let mut refusals = Vec::new();
    let mut records = records(text)
        .into_iter()
        .filter(|(_, cells)| !is_comment_or_blank(cells));
    let Some((_, header)) = records.next() else {
        return Err(vec![Refusal {
            line: 0,
            text: format!(
                "the file has no header; the first twelve columns must be: {}",
                HANDOFF_COLUMNS.join(", ")
            ),
        }]);
    };
    let header: Vec<String> = header.iter().map(|h| h.trim().to_owned()).collect();
    let handoff: Vec<&str> = header.iter().take(12).map(String::as_str).collect();
    if handoff != HANDOFF_COLUMNS {
        refusals.push(Refusal {
            line: 0,
            text: format!(
                "the first twelve columns must be the handoff's, verbatim and in order: {}; got: {}",
                HANDOFF_COLUMNS.join(", "),
                handoff.join(", ")
            ),
        });
    }
    for (i, name) in header.iter().enumerate() {
        if header.iter().take(i).any(|h| h == name) {
            refusals.push(Refusal {
                line: 0,
                text: format!("the header names \"{name}\" twice"),
            });
        }
    }
    let width = header.len();
    let mut rows = Vec::new();
    for (line, mut cells) in records {
        if cells.len() > width {
            refusals.push(Refusal {
                line,
                text: format!("{} cells, but the header has {width}", cells.len()),
            });
            continue;
        }
        cells.resize(width, String::new());
        rows.push(Row { line, cells });
    }
    if refusals.is_empty() {
        Ok(Table { header, rows })
    } else {
        Err(refusals)
    }
}

// ---------------------------------------------------------------------------
// Compiling.
// ---------------------------------------------------------------------------

/// The hop-depth cell, read.
enum Hops {
    /// `n/a`: nothing to walk.
    NotApplicable,
    /// `0`, `n`, or `a–b` read as `(a, b)`.
    Range(u8, u8),
}

/// Reads `0`, `n`, `a–b` / `a-b`, or `n/a`.
fn parse_hops(cell: &str) -> Result<Hops, String> {
    if cell.eq_ignore_ascii_case("n/a") {
        return Ok(Hops::NotApplicable);
    }
    let (lo, hi) = match cell.split_once(['–', '-']) {
        Some((a, b)) => (a.trim(), b.trim()),
        None => (cell, cell),
    };
    match (lo.parse::<u8>(), hi.parse::<u8>()) {
        (Ok(a), Ok(b)) if a <= b => Ok(Hops::Range(a, b)),
        (Ok(_), Ok(_)) => Err(format!("hop depth \"{cell}\" runs backwards")),
        _ => Err(format!(
            "hop depth \"{cell}\" is not a number, a range like 1–2, or n/a"
        )),
    }
}

/// Reads a `Resulting state` cell; `None` for a process word like
/// `Conditional`.
fn parse_state(cell: &str) -> Option<DecisionState> {
    match cell.to_ascii_uppercase().as_str() {
        "BLOCK" => Some(DecisionState::Block),
        "SUSPEND" => Some(DecisionState::Suspend),
        "WARN" => Some(DecisionState::Warn),
        "ALLOW" => Some(DecisionState::Allow),
        _ => None,
    }
}

/// Reads a hazard-kind token.
fn parse_hazard_kind(cell: &str) -> Option<HazardKind> {
    match cell {
        "coating_open" => Some(HazardKind::CoatingOpen),
        "hot_work_live" => Some(HazardKind::HotWorkLive),
        "energised_bus" => Some(HazardKind::EnergisedBus),
        "flammable_stow" => Some(HazardKind::FlammableStow),
        "stop_work" => Some(HazardKind::StopWork),
        _ => None,
    }
}

/// The serde name of a hazard kind — the same token the store's `hazard.kind`
/// column carries.
fn hazard_kind_token(kind: HazardKind) -> &'static str {
    match kind {
        HazardKind::CoatingOpen => "coating_open",
        HazardKind::HotWorkLive => "hot_work_live",
        HazardKind::EnergisedBus => "energised_bus",
        HazardKind::FlammableStow => "flammable_stow",
        HazardKind::StopWork => "stop_work",
    }
}

/// The word the table uses for a state.
fn state_word(state: DecisionState) -> &'static str {
    match state {
        DecisionState::Allow => "ALLOW",
        DecisionState::Warn => "WARN",
        DecisionState::Block => "BLOCK",
        DecisionState::Suspend => "SUSPEND",
    }
}

/// Whether a token is `lower_snake`: `[a-z0-9_]+`.
fn is_token(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// A `;`-separated list, trimmed, blanks dropped.
fn split_list(cell: &str) -> Vec<String> {
    cell.split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Reads `YYYY-MM-DD` as yard-local midnight through `clock`.
fn parse_date(cell: &str, clock: &YardClock) -> Result<Timestamp, String> {
    let bad = || format!("date \"{cell}\" is not YYYY-MM-DD");
    let mut parts = cell.split('-');
    let (Some(y), Some(m), Some(d), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(bad());
    };
    let (Ok(y), Ok(m), Ok(d)) = (y.parse::<i32>(), m.parse::<u8>(), d.parse::<u8>()) else {
        return Err(bad());
    };
    let days = days_from_civil(y, m, d);
    if civil_from_days(days) != (y, m, d) {
        return Err(format!("date \"{cell}\" is not on the calendar"));
    }
    Ok(Timestamp::from_epoch_millis(clock.to_utc(days, 0).0))
}

/// The yard-local calendar date of an instant, `YYYY-MM-DD`.
fn date_cell(at: Timestamp, clock: &YardClock) -> String {
    let (y, m, d) = civil_from_days(clock.local(at.epoch_millis()).days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// The compile columns of one row, read and checked. Every refusal a row can
/// raise is raised here; `Ok(None)` is a row that is honestly not compiled.
struct RowCompile {
    hazard: HazardKind,
    hops: (u8, u8),
    code: Option<CouplingCode>,
    state: DecisionState,
    hold: Option<Minutes>,
    hold_from: HoldFrom,
    clearing: String,
    binding: RuleBinding,
    version: RuleVersionId,
}

/// Why a row is not compiled, or what refuses the file.
enum RowOutcome {
    Compiled(RowCompile),
    NotCompiled(String),
}

/// Reads one row's compile columns.
fn compile_row(table: &Table, row: &Row, clock: &YardClock) -> Result<RowOutcome, Vec<String>> {
    let cell = |name: &str| table.cell(row, name);
    let kind = cell("Kind");
    if kind != CASCADE_KIND {
        return Ok(RowOutcome::NotCompiled(format!(
            "not compiled: {kind} needs a permit object (out of the pilot)"
        )));
    }
    let state_cell = cell("Resulting state");
    let Some(state) = parse_state(state_cell) else {
        return Ok(RowOutcome::NotCompiled(format!(
            "not compiled: state \"{state_cell}\" is a process, not an outcome"
        )));
    };
    let hazard_cell = cell("Hazard kind");
    if hazard_cell.is_empty() {
        return Ok(RowOutcome::NotCompiled(
            "not compiled: no hazard kind — the compile columns are blank".to_owned(),
        ));
    }
    let mut refusals = Vec::new();
    let hazard = parse_hazard_kind(hazard_cell);
    if hazard.is_none() {
        refusals.push(format!(
            "unknown hazard kind \"{hazard_cell}\"; one of coating_open, hot_work_live, energised_bus, flammable_stow, stop_work"
        ));
    }
    let hops = match parse_hops(cell("Hop depth")) {
        Ok(Hops::NotApplicable) => {
            return Ok(RowOutcome::NotCompiled(
                "not compiled: hop depth n/a — nothing to walk".to_owned(),
            ))
        }
        Ok(Hops::Range(a, b)) => Some((a, b)),
        Err(text) => {
            refusals.push(text);
            None
        }
    };
    let code_cell = cell("Coupling code");
    let code = if code_cell.is_empty() {
        if hops.is_some_and(|(_, b)| b > 0) {
            refusals.push("a hop depth above 0 needs a coupling code".to_owned());
        }
        None
    } else if is_token(code_cell) {
        Some(CouplingCode::new(code_cell))
    } else {
        refusals.push(format!(
            "coupling code \"{code_cell}\" is not a lower_snake token"
        ));
        None
    };
    let (hold, hold_from) = parse_hold(cell("Hold minutes"), cell("Hold from"), &mut refusals);
    let clearing = cell("Clearing authority code").to_owned();
    if clearing.is_empty() {
        refusals.push("needs a clearing authority code".to_owned());
    } else if !is_token(&clearing) {
        refusals.push(format!(
            "clearing authority code \"{clearing}\" is not a lower_snake token"
        ));
    }
    let binding = parse_binding(table, row, clock, &mut refusals);
    let version = parse_version(cell(VERSION_COLUMN), &mut refusals);
    match (refusals.is_empty(), hazard, hops) {
        (true, Some(hazard), Some(hops)) => Ok(RowOutcome::Compiled(RowCompile {
            hazard,
            hops,
            code,
            state,
            hold,
            hold_from,
            clearing,
            binding,
            version,
        })),
        _ => Err(refusals),
    }
}

/// Reads `Hold minutes` and `Hold from`; `end` needs minutes.
fn parse_hold(
    minutes: &str,
    from: &str,
    refusals: &mut Vec<String>,
) -> (Option<Minutes>, HoldFrom) {
    let hold = if minutes.is_empty() {
        None
    } else {
        match minutes.parse::<i64>() {
            Ok(n) if n >= 0 => Some(Minutes::new(n)),
            _ => {
                refusals.push(format!("hold minutes \"{minutes}\" is not a whole number"));
                None
            }
        }
    };
    let hold_from = match from.to_ascii_lowercase().as_str() {
        "" | "raise" => HoldFrom::Raise,
        "end" => {
            if hold.is_none() {
                refusals.push("hold from \"end\" needs hold minutes".to_owned());
            }
            HoldFrom::End
        }
        other => {
            refusals.push(format!("hold from \"{other}\" is neither raise nor end"));
            HoldFrom::Raise
        }
    };
    (hold, hold_from)
}

/// Reads the four binding columns.
fn parse_binding(
    table: &Table,
    row: &Row,
    clock: &YardClock,
    refusals: &mut Vec<String>,
) -> RuleBinding {
    let work_types = split_list(table.cell(row, "Work types"));
    for wt in work_types.iter().filter(|wt| !is_token(wt)) {
        refusals.push(format!("work type \"{wt}\" is not a lower_snake token"));
    }
    let categories = split_list(table.cell(row, "Categories"));
    let mut date = |name: &str| {
        let cell = table.cell(row, name);
        if cell.is_empty() {
            return None;
        }
        parse_date(cell, clock)
            .map_err(|text| refusals.push(format!("{name}: {text}")))
            .ok()
    };
    let effective_from = date("Effective from");
    let effective_to = date("Effective to");
    if let (Some(from), Some(to)) = (effective_from, effective_to) {
        if to <= from {
            refusals.push("Effective to is not after Effective from".to_owned());
        }
    }
    RuleBinding {
        work_types,
        categories,
        effective_from,
        effective_to,
    }
}

/// Reads the optional `Version id`; blank is nil, for the caller to mint.
fn parse_version(cell: &str, refusals: &mut Vec<String>) -> RuleVersionId {
    let nil = RuleVersionId::from_uuid(uuid::Uuid::nil());
    if cell.is_empty() {
        return nil;
    }
    cell.parse::<RuleVersionId>().unwrap_or_else(|_| {
        refusals.push(format!("version id \"{cell}\" is not a uuid"));
        nil
    })
}

/// The entries one compiled row yields: two for a `0–n` range.
fn entries_of(rule_code: &str, authority: &str, rc: &RowCompile) -> Vec<RuleEntry> {
    let entry = |applies: Applies| RuleEntry {
        rule_code: rule_code.to_owned(),
        rule_version: rc.version,
        hazard: rc.hazard,
        applies,
        state: rc.state,
        authority: authority.to_owned(),
        clearing_authority: rc.clearing.clone(),
        hold: rc.hold,
        waivable: false,
        binding: rc.binding.clone(),
        hold_from: rc.hold_from,
    };
    let (lo, hi) = rc.hops;
    let coupled = rc.code.clone().filter(|_| hi > 0).map(|code| {
        entry(Applies::Coupled {
            code,
            max_hops: HopDepth::new(hi),
        })
    });
    let mut out = Vec::new();
    if lo == 0 {
        out.push(entry(Applies::SameSpace));
    }
    out.extend(coupled);
    out
}

/// What two rows must share to be a duplicate: the same rule id and the same
/// reach, state and binding — a second version of the same reading.
fn duplicate_key(rule: &str, entry: &RuleEntry) -> String {
    format!(
        "{rule}|{:?}|{:?}|{:?}|{:?}",
        entry.hazard, entry.applies, entry.state, entry.binding
    )
}

/// Compiles a parsed table. Every *Hazard cascade* row with a compilable state
/// and a hazard kind becomes one entry (or two for a `0–n` range); every other
/// row is listed under `not_compiled` with a sentence, never refused. Refused
/// whole when a compile cell cannot be read, a hold is end-anchored without
/// minutes, a range runs backwards, a token is not `lower_snake`, a rule id is
/// blank, or two rows say the same thing.
///
/// # Errors
/// Every refusal found, never just the first.
pub fn compile(table: &Table, clock: &YardClock) -> Result<Compiled, Vec<Refusal>> {
    let mut compiled = Compiled::default();
    let mut refusals = Vec::new();
    // Next ordinal per rule id, and the first line each distinct reading was
    // seen on.
    let mut ordinals: BTreeMap<String, u8> = BTreeMap::new();
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    for row in &table.rows {
        let rule = table.cell(row, "Rule ID").to_owned();
        if rule.is_empty() {
            refusals.push(Refusal {
                line: row.line,
                text: "blank Rule ID".to_owned(),
            });
            continue;
        }
        let ordinal = ordinals.entry(rule.clone()).or_insert(0);
        let row_ref = |k: u8| RowRef {
            rule: rule.clone(),
            ordinal: ordinal.saturating_add(k),
            line: row.line,
        };
        let taken = match compile_row(table, row, clock) {
            Ok(RowOutcome::NotCompiled(why)) => {
                compiled.not_compiled.push((row_ref(0), why));
                1
            }
            Ok(RowOutcome::Compiled(rc)) => {
                let entries = entries_of(&rule, table.cell(row, "Authority document"), &rc);
                let count = u8::try_from(entries.len()).unwrap_or(u8::MAX).max(1);
                for (k, entry) in entries.into_iter().enumerate() {
                    match seen.entry(duplicate_key(&rule, &entry)) {
                        Entry::Occupied(first) => refusals.push(Refusal {
                            line: row.line,
                            text: format!(
                                "duplicate of line {} ({rule}: the same reach, state and binding)",
                                first.get()
                            ),
                        }),
                        Entry::Vacant(slot) => {
                            slot.insert(row.line);
                        }
                    }
                    let k = u8::try_from(k).unwrap_or(u8::MAX);
                    compiled.entries.push((row_ref(k), entry));
                }
                count
            }
            Err(texts) => {
                let at = row_ref(0);
                for text in texts {
                    refusals.push(Refusal {
                        line: row.line,
                        text: format!("{at}: {text}"),
                    });
                }
                1
            }
        };
        *ordinal = ordinal.saturating_add(taken);
    }
    if refusals.is_empty() {
        Ok(compiled)
    } else {
        Err(refusals)
    }
}

// ---------------------------------------------------------------------------
// Exporting.
// ---------------------------------------------------------------------------

/// The handoff's prose columns for one exported row — what the engine does
/// not carry and the table does.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RowText {
    /// `Name`.
    pub name: String,
    /// `Trigger condition`.
    pub trigger: String,
    /// `Propagation type`.
    pub propagation: String,
    /// `Clearing condition`.
    pub clearing_condition: String,
    /// `Who may clear`.
    pub who_may_clear: String,
    /// `Config anchor`.
    pub config_anchor: String,
    /// `Open question for the safety authority`.
    pub open_question: String,
}

/// An RFC 4180 cell: always quoted, quotes doubled — the handoff's own style.
fn quote(cell: &str) -> String {
    format!("\"{}\"", cell.replace('"', "\"\""))
}

/// The header of an exported table: 12 + 9 + 1 columns.
#[must_use]
pub fn export_header() -> Vec<String> {
    HANDOFF_COLUMNS
        .iter()
        .chain(COMPILE_COLUMNS.iter())
        .chain(core::iter::once(&VERSION_COLUMN))
        .map(|s| (*s).to_owned())
        .collect()
}

/// One entry as its 22 export cells; `text` supplies the prose columns.
#[must_use]
pub fn export_row(entry: &RuleEntry, clock: &YardClock, text: &RowText) -> Vec<String> {
    let (hops, code) = match &entry.applies {
        Applies::SameSpace => ("0".to_owned(), String::new()),
        Applies::Coupled { code, max_hops } => {
            (max_hops.get().to_string(), code.as_str().to_owned())
        }
    };
    let date = |at: Option<Timestamp>| at.map_or_else(String::new, |at| date_cell(at, clock));
    vec![
        entry.rule_code.clone(),
        text.name.clone(),
        CASCADE_KIND.to_owned(),
        text.trigger.clone(),
        text.propagation.clone(),
        hops,
        state_word(entry.state).to_owned(),
        entry.authority.clone(),
        text.clearing_condition.clone(),
        text.who_may_clear.clone(),
        text.config_anchor.clone(),
        text.open_question.clone(),
        hazard_kind_token(entry.hazard).to_owned(),
        code,
        entry.hold.map_or_else(String::new, |h| h.get().to_string()),
        match entry.hold_from {
            HoldFrom::Raise => "raise".to_owned(),
            HoldFrom::End => "end".to_owned(),
        },
        entry.clearing_authority.clone(),
        entry.binding.work_types.join(";"),
        entry.binding.categories.join(";"),
        date(entry.binding.effective_from),
        date(entry.binding.effective_to),
        entry.rule_version.to_string(),
    ]
}

/// Writes a rule set in the table's layout, one row per entry, every cell
/// quoted, `\n` line ends, the version id in column 22. `text` supplies each
/// row's prose columns. `compile(parse(export(set)))` is the identity on the
/// set.
#[must_use]
pub fn export(rules: &RuleSet, clock: &YardClock, text: impl Fn(&RuleEntry) -> RowText) -> String {
    let mut out = String::new();
    let line = |cells: &[String]| cells.iter().map(|c| quote(c)).collect::<Vec<_>>().join(",");
    out.push_str(&line(&export_header()));
    out.push('\n');
    for entry in rules.entries() {
        out.push_str(&line(&export_row(entry, clock, &text(entry))));
        out.push('\n');
    }
    out
}

/// The handoff's prose for a seed entry, with the seed's departures from the
/// table written into the open-question cell — what the exported reference
/// table (`reference/cvn73/CVN73-rule-table.csv`) carries and the sitting
/// starts from.
#[must_use]
pub fn seed_text(entry: &RuleEntry) -> RowText {
    let same_space = entry.applies == Applies::SameSpace;
    let t = |name: &str,
             trigger: &str,
             propagation: &str,
             clearing: &str,
             who: &str,
             anchor: &str,
             question: &str| RowText {
        name: name.to_owned(),
        trigger: trigger.to_owned(),
        propagation: propagation.to_owned(),
        clearing_condition: clearing.to_owned(),
        who_may_clear: who.to_owned(),
        config_anchor: anchor.to_owned(),
        open_question: question.to_owned(),
    };
    match entry.rule_code.as_str() {
        "R03" => t(
            "Coating active in certification set",
            "A spray/service coating ticket is OPEN in any space in the requesting activity’s certification set",
            if same_space { "Same space (the coated compartment is the vapour space)" } else { "Structural (vertical, deck penetration)" },
            "Coating ticket closed AND atmosphere re-tested by marine chemist",
            "Marine chemist",
            "coatingCureMinutes; ventilationGraph",
            if same_space {
                "Does a mechanically isolated branch break the coupling, or only a physical blank? Seed addition: the coated space itself is refused for hot work (without this row the origin of a cascade reads ALLOW). 480 min is the seed's cure; the table gives none."
            } else {
                "Does a mechanically isolated branch break the coupling, or only a physical blank? Seed reading: the derived vertical penetration is walked (a heat path), not a ventilation edge; hot work only."
            },
        ),
        "R04" => t(
            "Hot work overhead of occupied space",
            "Hot work authorized on the deck directly above an occupied or combustible-loaded space",
            "Structural (vertical, downward)",
            "Hot work complete AND post-work fire watch hold elapsed",
            "Fire watch / Fire Marshal",
            "fireWatchHoldMinutes",
            "Does the downward coupling extend two decks where a deck penetration exists? Seed: the fire watch (30 min) runs from the permit's close, not its raise; any work below is suspended while the permit is open.",
        ),
        "R06" => t(
            "Coating starts while hot work live",
            "A coating ticket opens in a space coupled to an ALREADY ACTIVE hot work permit",
            "Shared boundary (bulkhead)",
            "Coating closed and atmosphere re-tested; permit re-checked",
            "Marine chemist + engine re-check",
            "coatingCureMinutes",
            "Who wins on a race — is the later ticket refused, or the earlier one suspended? Current build suspends the earlier. Seed departure (D1, left with the authority): WARN on the shared bulkhead, one hop, hot work — the boundary-posted case the table has no row for; the table's race (a coating opening beside an already-active permit) is not expressible by the engine.",
        ),
        "R07" => t(
            "Energised bus in work envelope",
            "Any intrusive work inside an electrical envelope whose bus is not in a verified zero-energy state",
            if same_space { "Same space (inside the envelope)" } else { "Electrical (bus topology; direction is the coupling register's)" },
            "Isolation performed, tags hung, zero-energy verified and recorded",
            "Isolation authority",
            "isolationRegistry",
            "Does a coupled bus segment two switchboards away require isolation, or notification only?",
        ),
        "R09" => t(
            "Coating cure on shared ventilation branch",
            "A coating cure is in progress in a space sharing the exhaust branch, but not the compartment",
            "Ventilation (directional)",
            "Cure period elapsed and atmosphere re-tested",
            "Marine chemist",
            "coatingCureMinutes",
            if entry.state == DecisionState::Suspend {
                "What work classes remain permitted under WARN? Build allows mechanical/hanging, refuses grinding, cutting, torch. Seed departure: this row is the SUSPEND for hot work the table's own note describes."
            } else {
                "What work classes remain permitted under WARN? Build allows mechanical/hanging, refuses grinding, cutting, torch. Seed: this row is the table's WARN for every other work class."
            },
        ),
        "R13" => t(
            "Flammables staged in coupled space",
            "Open solvent/flammable stow in a space on the same ventilation branch",
            "Ventilation (directional) + gas path",
            "Stow secured OR vent boundary isolated and verified",
            "Marine chemist / Fire Marshal",
            "flammableStowRegistry",
            "Does a closed but unsecured stow count as secured? Seed: hot work only; the clearer is narrowed to the fire marshal.",
        ),
        "R22" => t(
            "Stop work by inspection authority",
            "Fire Marshal or QA records STOP WORK on live work",
            "Same space",
            "Condition cleared and re-checked like any suspension",
            "The issuing authority",
            "stopWorkAuthority",
            "Confirm QA holds stop-work authority, or restrict to Fire Marshal.",
        ),
        _ => RowText::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HANDOFF_HEADER: &str = "\"Rule ID\",\"Name\",\"Kind\",\"Trigger condition\",\"Propagation type\",\"Hop depth\",\"Resulting state\",\"Authority document\",\"Clearing condition\",\"Who may clear\",\"Config anchor\",\"Open question for the safety authority\"";

    fn full_header() -> String {
        export_header()
            .iter()
            .map(|c| quote(c))
            .collect::<Vec<_>>()
            .join(",")
    }

    fn table(rows: &[&str]) -> Table {
        let text = format!("{}\n{}\n", full_header(), rows.join("\n"));
        parse(&text).unwrap()
    }

    /// A cascade row with every compile cell filled; `hops` and `code` vary.
    fn cascade_row(rule: &str, hops: &str, code: &str, extra: &str) -> String {
        format!(
            "\"{rule}\",\"Name\",\"Hazard cascade\",\"trigger\",\"prop\",\"{hops}\",\"BLOCK\",\"NFPA 306\",\"clear\",\"who\",\"anchor\",\"q\",\"coating_open\",\"{code}\",\"480\",\"raise\",\"marine_chemist\",\"hot_work\",\"\",\"\",\"\",\"{extra}\""
        )
    }

    #[test]
    fn the_handoff_header_is_required_verbatim_and_in_order() {
        let swapped = "\"Name\",\"Rule ID\",\"Kind\",\"Trigger condition\",\"Propagation type\",\"Hop depth\",\"Resulting state\",\"Authority document\",\"Clearing condition\",\"Who may clear\",\"Config anchor\",\"Open question for the safety authority\"\n";
        let err = parse(swapped).unwrap_err();
        assert_eq!(err.len(), 1);
        assert_eq!(err[0].line, 0);
        assert!(err[0].text.contains("verbatim and in order"), "{}", err[0]);

        // The handoff's own header, with nothing after it, parses.
        let t = parse(&format!("{HANDOFF_HEADER}\n")).unwrap();
        assert_eq!(t.header.len(), 12);
        assert!(t.rows.is_empty());
        assert!(parse("").is_err(), "no header at all");
    }

    #[test]
    fn quoted_commas_in_the_handoff_columns_survive() {
        let text = format!(
            "{HANDOFF_HEADER}\n# a comment line\n\"R01\",\"Primary space, not selected\",\"Completeness gate\",\"x\",\"None\",\"0\",\"BLOCK\",\"Yard permit procedure\",\"a \"\"quoted\"\" word\",\"Raiser\",\"n/a\",\"None — mechanical.\"\r\n"
        );
        let t = parse(&text).unwrap();
        assert_eq!(t.rows.len(), 1);
        assert_eq!(t.rows[0].line, 3);
        assert_eq!(t.cell(&t.rows[0], "Name"), "Primary space, not selected");
        assert_eq!(
            t.cell(&t.rows[0], "Clearing condition"),
            "a \"quoted\" word"
        );
        assert_eq!(
            t.cell(&t.rows[0], "Hazard kind"),
            "",
            "an absent column reads blank"
        );
    }

    #[test]
    fn a_hop_range_from_zero_compiles_to_two_entries() {
        let t = table(&[
            &cascade_row("R03", "0–1", "deck_penetration", ""),
            &cascade_row("R09", "1-2", "exhaust_trunk", ""),
        ]);
        let c = compile(&t, &YardClock::utc()).unwrap();
        assert_eq!(c.entries.len(), 3);
        assert_eq!(c.entries[0].0.to_string(), "R03-0");
        assert_eq!(c.entries[0].1.applies, Applies::SameSpace);
        assert_eq!(c.entries[1].0.to_string(), "R03-1");
        assert_eq!(
            c.entries[1].1.applies,
            Applies::Coupled {
                code: CouplingCode::new("deck_penetration"),
                max_hops: HopDepth::new(1)
            }
        );
        assert_eq!(c.entries[2].0.to_string(), "R09-0");
        assert_eq!(
            c.entries[2].1.applies,
            Applies::Coupled {
                code: CouplingCode::new("exhaust_trunk"),
                max_hops: HopDepth::new(2)
            }
        );
        assert_eq!(c.entries[2].1.binding.work_types, vec!["hot_work"]);
        assert!(c
            .entries
            .iter()
            .all(|(_, e)| e.rule_version.as_uuid().is_nil()));

        // The caller mints what the rows did not carry.
        let minted = c.with_versions(|e| {
            RuleVersionId::from_uuid(uuid::Uuid::from_u128(u128::from(e.state.severity())))
        });
        assert!(minted
            .entries
            .iter()
            .all(|(_, e)| !e.rule_version.as_uuid().is_nil()));
    }

    #[test]
    fn a_gate_row_is_not_compiled_and_never_refuses() {
        let text = format!(
            "{HANDOFF_HEADER}\n\"R01\",\"Primary space not selected\",\"Completeness gate\",\"x\",\"None\",\"0\",\"BLOCK\",\"Yard permit procedure\",\"c\",\"Raiser\",\"n/a\",\"q\"\n\"R15\",\"Waiver\",\"Governance\",\"x\",\"Any\",\"n/a\",\"Conditional\",\"Contract deviation procedure\",\"c\",\"CTA\",\"waiverPolicy\",\"q\"\n\"R03\",\"Coating\",\"Hazard cascade\",\"x\",\"Ventilation\",\"1\",\"BLOCK\",\"NFPA 306\",\"c\",\"Marine chemist\",\"coatingCureMinutes\",\"q\"\n"
        );
        let t = parse(&text).unwrap();
        let c = compile(&t, &YardClock::utc()).unwrap();
        assert!(c.entries.is_empty());
        let why: Vec<&str> = c.not_compiled.iter().map(|(_, w)| w.as_str()).collect();
        assert_eq!(
            why,
            vec![
                "not compiled: Completeness gate needs a permit object (out of the pilot)",
                "not compiled: Governance needs a permit object (out of the pilot)",
                "not compiled: no hazard kind — the compile columns are blank",
            ]
        );
        assert_eq!(c.not_compiled[2].0.to_string(), "R03-0");
    }

    #[test]
    fn an_end_hold_without_minutes_is_refused() {
        let row = "\"R04\",\"Hot work\",\"Hazard cascade\",\"t\",\"p\",\"1\",\"SUSPEND\",\"NSTM\",\"c\",\"w\",\"a\",\"q\",\"hot_work_live\",\"deck_penetration\",\"\",\"end\",\"fire_marshal\",\"\",\"\",\"\",\"\",\"\"";
        let err = compile(&table(&[row]), &YardClock::utc()).unwrap_err();
        assert_eq!(err.len(), 1);
        assert_eq!(err[0].line, 2);
        assert!(
            err[0].text.contains("hold from \"end\" needs hold minutes"),
            "{}",
            err[0]
        );
    }

    #[test]
    fn every_unreadable_cell_is_a_refusal_and_all_are_listed() {
        let row = "\"R04\",\"n\",\"Hazard cascade\",\"t\",\"p\",\"two\",\"SUSPEND\",\"NSTM\",\"c\",\"w\",\"a\",\"q\",\"plasma\",\"Deck Penetration\",\"soon\",\"middle\",\"Fire Marshal\",\"Hot Work\",\"\",\"2026-13-01\",\"2026-01-01\",\"not-a-uuid\"";
        let err = compile(&table(&[row]), &YardClock::utc()).unwrap_err();
        let texts: Vec<String> = err.iter().map(ToString::to_string).collect();
        for needle in [
            "unknown hazard kind",
            "hop depth \"two\"",
            "coupling code \"Deck Penetration\"",
            "hold minutes \"soon\"",
            "hold from \"middle\"",
            "clearing authority code \"Fire Marshal\"",
            "work type \"Hot Work\"",
            "Effective from: date \"2026-13-01\" is not on the calendar",
            "version id \"not-a-uuid\"",
        ] {
            assert!(
                texts.iter().any(|t| t.contains(needle)),
                "missing {needle:?} in {texts:#?}"
            );
        }
        // A backwards range and a backwards effective range.
        let row = cascade_row("R09", "2–1", "exhaust_trunk", "").replace(
            "\"\",\"\",\"\",\"\"",
            "\"\",\"2026-02-01\",\"2026-01-01\",\"\"",
        );
        let err = compile(&table(&[&row]), &YardClock::utc()).unwrap_err();
        let texts: Vec<String> = err.iter().map(ToString::to_string).collect();
        assert!(
            texts.iter().any(|t| t.contains("runs backwards")),
            "{texts:?}"
        );
        assert!(
            texts
                .iter()
                .any(|t| t.contains("Effective to is not after")),
            "{texts:?}"
        );
        // A duplicate reading.
        let err = compile(
            &table(&[
                &cascade_row("R09", "2", "exhaust_trunk", ""),
                &cascade_row("R09", "2", "exhaust_trunk", ""),
            ]),
            &YardClock::utc(),
        )
        .unwrap_err();
        assert!(err[0].text.contains("duplicate of line 2"), "{}", err[0]);
    }

    #[test]
    fn effective_dates_are_yard_local_midnight_through_the_clock() {
        // A clock five hours west of UTC: local midnight is 05:00Z.
        let clock = YardClock {
            standard_offset_minutes: -300,
            daylight: None,
            ..YardClock::utc()
        };
        let row = cascade_row("R03", "1", "deck_penetration", "").replace(
            "\"\",\"\",\"\",\"\"",
            "\"\",\"2026-09-04\",\"2026-10-01\",\"\"",
        );
        let compiled = compile(&table(&[&row]), &clock).unwrap();
        let binding = &compiled.entries[0].1.binding;
        let midnight_utc = days_from_civil(2026, 9, 4) * 86_400_000 + 5 * 3_600_000;
        assert_eq!(
            binding.effective_from,
            Some(Timestamp::from_epoch_millis(midnight_utc))
        );
        // And back out through the same clock.
        let cells = export_row(&compiled.entries[0].1, &clock, &RowText::default());
        assert_eq!(cells[19], "2026-09-04");
        assert_eq!(cells[20], "2026-10-01");
    }

    #[test]
    fn export_then_compile_is_the_identity_on_the_seed() {
        let seed = RuleSet::seed_usn_hot_work();
        let clock = YardClock::utc();
        let csv = export(&seed, &clock, seed_text);
        let t = parse(&csv).unwrap();
        assert_eq!(t.header.len(), 22);
        assert_eq!(t.rows.len(), seed.entries().len());
        let c = compile(&t, &clock).unwrap();
        assert!(c.not_compiled.is_empty());
        assert_eq!(c.rule_set(), seed, "entry for entry, ids included");
        // Ordinals: R03-0, R03-1, R06-0, R09-0, R09-1, R04-0, R07-0, R07-1, R13-0, R22-0.
        let refs: Vec<String> = c.entries.iter().map(|(r, _)| r.to_string()).collect();
        assert_eq!(
            refs,
            vec![
                "R03-0", "R03-1", "R06-0", "R09-0", "R09-1", "R04-0", "R07-0", "R07-1", "R13-0",
                "R22-0"
            ]
        );
        // The export is stable: exporting the compiled set gives the same bytes.
        assert_eq!(export(&c.rule_set(), &clock, seed_text), csv);
    }
}
