//! The rule table: the engine's inputs assembled once, narrowed per work, and
//! the door the safety authority's CSV enters through.
//!
//! Two things live here. First, [`engine_inputs`] — the one place the graph,
//! the hazards and the rules in force are read together for an instant, so
//! every handler that asks the engine a question asks it under the same
//! triple: the rules are the hull's set narrowed to the instant's effective
//! range, and the hazards are the store's *bearing* set — live ones plus
//! those cleared within the longest end-anchored hold, so a fire watch can
//! run from the permit's close. Second, [`RuleScopes`] — the set per
//! `(work type, register category)` an activity read hands the engine, which
//! is how a cold-work inspection above a curing coat is judged by the rows
//! that bind to inspection and the weld beside it by the rows that bind to
//! hot work, with `evaluate()` unchanged.
//!
//! The door (`GET` with a CSV export, `POST` with `?dry_run=true`, `POST`
//! commit, `POST …/revert`) is the same door discipline as every other
//! document: parsed and compiled whole or refused whole with every reason,
//! previewed against the reference hull — *what would each row fire on
//! today, and which spaces change state if this is committed* — committed
//! with a ledger line that names every version, reverted to the seed with
//! another. Version ids are content-addressed, so the same row re-imported
//! keeps its id and its traces, and a changed cell is a new version of that
//! row only. The compiler itself is `wadl_engine::rule_table`, pure; this
//! module reads the store, mints ids and shapes the wire.

use std::collections::{BTreeMap, BTreeSet};

use axum::extract::{Path, Query, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use wadl_domain::civil::YardClock;
use wadl_domain::compartment::CompartmentNo;
use wadl_domain::ids::{RuleVersionId, VesselId};
use wadl_domain::time::Timestamp;
use wadl_domain::units::Minutes;
use wadl_engine::rule_table::{self as compiler, Compiled, Row, RowRef, RowText, Table};
use wadl_engine::traversal::{affected_compartments, cascade_from};
use wadl_engine::{
    evaluate, AdjacencyGraph, Applies, Decision, EvaluationRequest, Hazard, HoldFrom, RuleEntry,
    RuleSet, TraversalBound, Work,
};
use wadl_store::memory::RuleTableDoc;
use wadl_store::model::{ActivitySummary, CompartmentSummary};
use wadl_store::TenantScope;

use crate::auth::Caller;
use crate::error::ApiError;
use crate::handlers::{ledger_document, read_import_body, DryRun};
use crate::AppState;

/// The document kind the rule table is stored and ledgered under.
pub(crate) const RULE_TABLE_KIND: &str = "rule_table";

// ---------------------------------------------------------------------------
// The engine's inputs.
// ---------------------------------------------------------------------------

/// The engine's inputs for one hull at one instant, read together.
///
/// `rules` is the hull's set in force — the committed table's entries or the
/// seed — narrowed to the rows whose effective range covers `at`
/// (`Work::ANY`: every work type, every category). `hazards` is the store's
/// bearing set at `at` with the tail the rules need. A compartment-level read
/// evaluates under `rules` as it stands; an activity read narrows further
/// through [`RuleScopes`].
pub(crate) struct EngineInputs {
    /// The hull's resolved adjacency graph.
    pub(crate) graph: AdjacencyGraph,
    /// The hazards bearing on a decision at `at`, `ended` set where cleared.
    pub(crate) hazards: Vec<Hazard>,
    /// The rules in force at `at`, every work type.
    pub(crate) rules: RuleSet,
    /// The instant the inputs were read for.
    pub(crate) at: Timestamp,
}

impl EngineInputs {
    /// The triple as `wadl_issues` borrows it, under a narrowed set — an
    /// activity's from [`RuleScopes::for_activity`], or `self.rules` for the
    /// every-work reading.
    pub(crate) fn hull_under<'a>(&'a self, rules: &'a RuleSet) -> wadl_issues::Hull<'a> {
        wadl_issues::Hull {
            graph: &self.graph,
            rules,
            hazards: &self.hazards,
        }
    }

    /// One compartment's decision under a set — the compartment-level
    /// reading when `rules` is [`RuleScopes::for_compartment`]'s answer.
    pub(crate) fn decide(&self, subject: &CompartmentNo, rules: &RuleSet) -> Decision {
        evaluate(&EvaluationRequest {
            subject,
            graph: &self.graph,
            rules,
            hazards: &self.hazards,
            at: self.at,
        })
    }

    /// The hazards live at `at` — the bearing set without the ones whose
    /// fact has ended by the instant. For lists that show *what is shut*,
    /// where a permit closed twenty minutes ago is a fire watch, not a hazard.
    pub(crate) fn live(&self) -> impl Iterator<Item = &Hazard> + '_ {
        self.hazards.iter().filter(|h| !h.ended_by(self.at))
    }
}

/// Reads the engine's inputs for a hull at `at`: the rules first (their
/// longest end-anchored hold is the tail the hazard read needs), then the
/// hazards bearing on the instant, then the graph.
///
/// # Errors
/// [`ApiError::NotFound`] when the hull is outside `scope`.
pub(crate) async fn engine_inputs(
    state: &AppState,
    scope: &TenantScope,
    vessel: VesselId,
    at: Timestamp,
) -> Result<EngineInputs, ApiError> {
    let rules = state
        .store
        .rules_in_force(scope, vessel)
        .await?
        .bound_to(Work::ANY, at);
    let hazards = state
        .store
        .hazards_bearing_on(scope, vessel, at, rules.longest_end_anchored_hold())
        .await?;
    let graph = state.store.adjacency_graph(scope, vessel).await?;
    Ok(EngineInputs {
        graph,
        hazards,
        rules,
        at,
    })
}

/// Which rules a hull is being read under, for the activity register's
/// `rules` object: `{ source: "seed" | "document", label, signed }` — so the
/// Sequence Board can say whose table judged its rows without a second read.
///
/// # Errors
/// [`ApiError::NotFound`] when the hull is outside `scope`.
pub(crate) async fn rules_served(
    state: &AppState,
    scope: &TenantScope,
    vessel: VesselId,
) -> Result<Value, ApiError> {
    Ok(match state.store.rule_table(scope, vessel).await? {
        Some(doc) => json!({
            "source": "document",
            "label": doc.label,
            "signed": doc.signoff.is_some(),
        }),
        None => json!({ "source": "seed", "label": SEED_LABEL, "signed": false }),
    })
}

/// The label the seed is served under.
pub(crate) const SEED_LABEL: &str = "seed_usn_hot_work";

/// The rule set per `(work type, register category)` a read needs.
///
/// Built once per read from the compartments (each registers
/// `(None, category)`) and the activities (each registers its work type with
/// its compartment's category); [`Self::get`] answers from the map, and a
/// pair nobody registered gets the every-work set — the conservative
/// reading, never a narrower one.
pub(crate) struct RuleScopes<'a> {
    base: &'a RuleSet,
    sets: BTreeMap<(Option<String>, Option<String>), RuleSet>,
    categories: BTreeMap<String, String>,
}

impl<'a> RuleScopes<'a> {
    /// Registers the pairs `compartments` and `activities` need under
    /// `rules` at `at`.
    pub(crate) fn new<'b>(
        rules: &'a RuleSet,
        at: Timestamp,
        compartments: &[CompartmentSummary],
        activities: impl IntoIterator<Item = &'b ActivitySummary>,
    ) -> Self {
        let categories: BTreeMap<String, String> = compartments
            .iter()
            .map(|c| (c.compartment_no.as_str().to_owned(), c.category.clone()))
            .collect();
        let mut pairs: BTreeSet<(Option<String>, Option<String>)> = compartments
            .iter()
            .map(|c| (None, Some(c.category.clone())))
            .collect();
        for a in activities {
            let category = a
                .compartment_no
                .as_ref()
                .and_then(|no| categories.get(no.as_str()))
                .cloned();
            pairs.insert((a.work_type.clone(), category));
        }
        let sets = pairs
            .into_iter()
            .map(|pair| {
                let work = Work {
                    work_type: pair.0.as_deref(),
                    category: pair.1.as_deref(),
                };
                let set = rules.bound_to(work, at);
                (pair, set)
            })
            .collect();
        Self {
            base: rules,
            sets,
            categories,
        }
    }

    /// The set bound to `work_type` in a space of `category`; the every-work
    /// set for a pair that was not registered.
    pub(crate) fn get(&self, work_type: Option<&str>, category: Option<&str>) -> &RuleSet {
        self.sets
            .get(&(work_type.map(str::to_owned), category.map(str::to_owned)))
            .unwrap_or(self.base)
    }

    /// The register category of a compartment, if the register carries it.
    pub(crate) fn category_of(&self, compartment: Option<&CompartmentNo>) -> Option<&str> {
        compartment
            .and_then(|no| self.categories.get(no.as_str()))
            .map(String::as_str)
    }

    /// The set an activity is judged by: its work type in its space.
    pub(crate) fn for_activity(&self, a: &ActivitySummary) -> &RuleSet {
        self.get(
            a.work_type.as_deref(),
            self.category_of(a.compartment_no.as_ref()),
        )
    }

    /// The set a compartment-level read uses: every work type in the space's
    /// category.
    pub(crate) fn for_compartment(&self, c: &CompartmentSummary) -> &RuleSet {
        self.get(None, Some(c.category.as_str()))
    }

    /// How many entries bind to an activity's work type and category — the
    /// `rules_bound` figure on every activity row.
    pub(crate) fn rules_bound(&self, a: &ActivitySummary) -> usize {
        self.for_activity(a).entries().len()
    }
}

// ---------------------------------------------------------------------------
// Hashes and ids.
// ---------------------------------------------------------------------------

/// The hash a signature is of: `sha256("wadl:rule-table:" ‖ header ‖ rows)`
/// over the table's *cells* (unit-separated, record-separated), hex. Cells
/// rather than bytes, so a table re-quoted or re-saved by a spreadsheet
/// hashes the same as the one the authority signed, and the seed's exported
/// table hashes the same whether served from the seed or re-imported.
#[must_use]
pub(crate) fn table_hash(header: &[String], rows: &[Vec<String>]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"wadl:rule-table:");
    for record in core::iter::once(header).chain(rows.iter().map(Vec::as_slice)) {
        for cell in record {
            hasher.update(cell.trim().as_bytes());
            hasher.update([0x1f]);
        }
        hasher.update([0x1e]);
    }
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// A content-addressed version id: `uuid8(sha256("wadl:rule-version:" ‖
/// canonical JSON of the entry with `rule_version` nil))` — S13's
/// `stable_activity_id` recipe. The same row re-imported keeps its id and
/// its snapshots; a changed cell is a new version, and only that row's.
#[must_use]
pub(crate) fn mint_version(entry: &RuleEntry) -> RuleVersionId {
    let canonical = RuleEntry {
        rule_version: RuleVersionId::from_uuid(Uuid::nil()),
        ..entry.clone()
    };
    let mut hasher = Sha256::new();
    hasher.update(b"wadl:rule-version:");
    hasher.update(serde_json::to_string(&canonical).unwrap_or_default());
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
    RuleVersionId::from_uuid(Uuid::from_bytes(bytes))
}

// ---------------------------------------------------------------------------
// The table in effect.
// ---------------------------------------------------------------------------

/// The table a hull runs: the committed document, or the seed exported in
/// the document's own layout.
struct TableInEffect {
    /// `seed` or `document`.
    source: &'static str,
    label: String,
    table: Table,
    compiled: Compiled,
    hash: String,
    signoff: Option<Value>,
}

/// What a text compiles to: the table, the entries with their ids settled,
/// and the rows whose carried id was set aside.
struct CompiledText {
    table: Table,
    compiled: Compiled,
    /// Rows that carried a version id their cells no longer answer to, each
    /// with the id that was set aside — a finding, so the authority sees the
    /// new version is theirs to sign.
    reminted: Vec<String>,
}

/// Two entries read the same when everything but the version id is equal.
fn same_reading(a: &RuleEntry, b: &RuleEntry) -> bool {
    let nil = RuleVersionId::from_uuid(Uuid::nil());
    RuleEntry {
        rule_version: nil,
        ..a.clone()
    } == RuleEntry {
        rule_version: nil,
        ..b.clone()
    }
}

/// Settles every entry's version id. A carried id (column 22) is honoured
/// only while the row still reads the same — it is the entry's content
/// address, or a seed id whose seed reading the entry equals. Any other
/// carried id is set aside and the row minted afresh: the exported table
/// carries the seed's fixed ids, and a cell edited in the spreadsheet must
/// become a new version of that row, never the old id on a new reading.
fn settle_versions(mut compiled: Compiled) -> (Compiled, Vec<String>) {
    let seed = RuleSet::seed_usn_hot_work();
    let mut reminted = Vec::new();
    for (row, entry) in &mut compiled.entries {
        let carried = entry.rule_version;
        if carried.as_uuid().is_nil() {
            continue;
        }
        let unchanged = carried == mint_version(entry)
            || seed
                .entries()
                .iter()
                .any(|s| s.rule_version == carried && same_reading(s, entry));
        if !unchanged {
            reminted.push(format!(
                "{row} (line {}) carried version {carried} but its cells changed — a new version is minted for it",
                row.line
            ));
            entry.rule_version = RuleVersionId::from_uuid(Uuid::nil());
        }
    }
    (compiled.with_versions(mint_version), reminted)
}

/// Parses and compiles CSV text against the hull's clock and settles the
/// version ids. Every refusal, or the compiled table.
fn compile_text(csv: &str, clock: &YardClock) -> Result<CompiledText, Vec<String>> {
    let sentences =
        |r: Vec<compiler::Refusal>| -> Vec<String> { r.iter().map(ToString::to_string).collect() };
    let table = compiler::parse(csv).map_err(sentences)?;
    let (compiled, reminted) =
        settle_versions(compiler::compile(&table, clock).map_err(sentences)?);
    Ok(CompiledText {
        table,
        compiled,
        reminted,
    })
}

/// The seed as a table: exported in the document layout, parsed and
/// compiled — the identity the engine test proves.
fn seed_table(clock: &YardClock) -> Result<TableInEffect, ApiError> {
    let csv = compiler::export(&RuleSet::seed_usn_hot_work(), clock, compiler::seed_text);
    let CompiledText {
        table, compiled, ..
    } = compile_text(&csv, clock).map_err(|refusals| {
        eprintln!(
            "{}",
            json!({ "event": "backend_error", "detail": format!("the seed does not compile: {}", refusals.join("; ")) })
        );
        ApiError::Internal
    })?;
    let rows: Vec<Vec<String>> = table.rows.iter().map(|r| r.cells.clone()).collect();
    Ok(TableInEffect {
        source: "seed",
        label: SEED_LABEL.to_owned(),
        hash: table_hash(&table.header, &rows),
        table,
        compiled,
        signoff: None,
    })
}

/// A stored document as a table, recompiled for its report. A document that
/// will not compile is a store written around the door — internal, not the
/// caller's.
fn document_table(doc: RuleTableDoc, clock: &YardClock) -> Result<TableInEffect, ApiError> {
    let header = if doc.header.is_empty() {
        compiler::export_header()
    } else {
        doc.header
    };
    let table = Table {
        header,
        rows: doc
            .rows
            .into_iter()
            .enumerate()
            .map(|(i, cells)| Row {
                line: i.saturating_add(2),
                cells,
            })
            .collect(),
    };
    let mut compiled = compiler::compile(&table, clock).map_err(|refusals| {
        eprintln!(
            "{}",
            json!({ "event": "backend_error", "detail": format!("stored rule table {} does not compile: {}", doc.label, refusals.iter().map(ToString::to_string).collect::<Vec<_>>().join("; ")) })
        );
        ApiError::Internal
    })?;
    // The versions in force are the stored entries' — what `rules_in_force`
    // serves — not a re-reading of the cells: a row that carried the seed's
    // id into the door and was minted afresh at commit reports the id it
    // was minted, and exports it in column 22. The entries and the rows are
    // one compile in file order; a document that disagrees with itself is
    // settled the way the door settles a fresh import.
    if compiled.entries.len() == doc.entries.len()
        && compiled
            .entries
            .iter()
            .zip(&doc.entries)
            .all(|((_, e), stored)| same_reading(e, stored))
    {
        for ((_, entry), stored) in compiled.entries.iter_mut().zip(&doc.entries) {
            entry.rule_version = stored.rule_version;
        }
    } else {
        compiled = settle_versions(compiled).0;
    }
    Ok(TableInEffect {
        source: "document",
        label: doc.label,
        table,
        compiled,
        hash: doc.table_hash,
        signoff: doc.signoff.map(|s| json!(s)),
    })
}

/// The table in effect on a hull.
async fn table_in_effect(
    state: &AppState,
    scope: &TenantScope,
    vessel: VesselId,
    clock: &YardClock,
) -> Result<TableInEffect, ApiError> {
    match state.store.rule_table(scope, vessel).await? {
        Some(doc) => document_table(doc, clock),
        None => seed_table(clock),
    }
}

// ---------------------------------------------------------------------------
// What a row fires on.
// ---------------------------------------------------------------------------

/// What the dry run and the GET report against: the hull as it stands now.
struct Hull {
    graph: AdjacencyGraph,
    hazards: Vec<Hazard>,
    compartments: Vec<CompartmentSummary>,
    activities: Vec<ActivitySummary>,
    at: Timestamp,
}

impl Hull {
    /// The hull's inputs at the wall clock, with a hazard tail long enough
    /// for both the table in force and a proposed one.
    async fn read(
        state: &AppState,
        scope: &TenantScope,
        vessel: VesselId,
        tail: Minutes,
    ) -> Result<Self, ApiError> {
        let at = state.clock.now();
        Ok(Self {
            graph: state.store.adjacency_graph(scope, vessel).await?,
            hazards: state
                .store
                .hazards_bearing_on(scope, vessel, at, tail)
                .await?,
            compartments: state.store.list_compartments(scope, vessel).await?,
            activities: state.store.list_activities(scope, vessel).await?,
            at,
        })
    }

    fn category_of(&self, no: &CompartmentNo) -> Option<&str> {
        self.compartments
            .iter()
            .find(|c| &c.compartment_no == no)
            .map(|c| c.category.as_str())
    }

    /// The coupling codes the hull's register carries, with edge counts.
    fn coupling_codes(&self) -> BTreeMap<String, usize> {
        let mut out = BTreeMap::new();
        for edge in self.graph.edges() {
            *out.entry(edge.code.as_str().to_owned()).or_insert(0) += 1;
        }
        out
    }

    /// Served work by work type: `(token, activities)`, most first.
    fn work_types_on_schedule(&self) -> Vec<(String, usize)> {
        let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
        for a in self.activities.iter().filter(|a| !a.is_milestone) {
            if let Some(wt) = a.work_type.as_deref() {
                *counts.entry(wt).or_insert(0) += 1;
            }
        }
        let mut out: Vec<(String, usize)> =
            counts.into_iter().map(|(k, v)| (k.to_owned(), v)).collect();
        out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        out
    }

    /// The spaces an entry fires on today: from every hazard of its kind
    /// raised by now (and, for an end-anchored row, closed within the tail),
    /// the origin for a same-space row or the cascade under the row's bound;
    /// and the served activities in those spaces whose work the row binds.
    fn fires_on(&self, entry: &RuleEntry) -> Value {
        const EXAMPLES: usize = 12;
        let sources: Vec<&Hazard> = self
            .hazards
            .iter()
            .filter(|h| h.kind == entry.hazard && h.raised_by(self.at))
            .filter(|h| entry.hold_from == HoldFrom::End || !h.ended_by(self.at))
            .collect();
        let mut spaces: BTreeSet<CompartmentNo> = BTreeSet::new();
        for hazard in &sources {
            match &entry.applies {
                Applies::SameSpace => {
                    spaces.insert(hazard.origin.clone());
                }
                Applies::Coupled { code, max_hops } => {
                    let bound = TraversalBound::new(*max_hops, Some(code.clone()));
                    spaces.extend(affected_compartments(&cascade_from(
                        &self.graph,
                        &hazard.origin,
                        &bound,
                    )));
                }
            }
        }
        let activities_bound = self
            .activities
            .iter()
            .filter(|a| !a.is_milestone)
            .filter(|a| {
                a.compartment_no
                    .as_ref()
                    .is_some_and(|no| spaces.contains(no))
            })
            .filter(|a| {
                let work = Work {
                    work_type: a.work_type.as_deref(),
                    category: a
                        .compartment_no
                        .as_ref()
                        .and_then(|no| self.category_of(no)),
                };
                entry.binds(work, self.at)
            })
            .count();
        json!({
            "hazards": sources.len(),
            "spaces": spaces.iter().take(EXAMPLES).collect::<Vec<_>>(),
            "space_count": spaces.len(),
            "activities_bound": activities_bound,
        })
    }

    /// Every compartment's state under `rules` at now.
    fn states_under(&self, rules: &RuleSet) -> Vec<Decision> {
        self.compartments
            .iter()
            .map(|c| {
                evaluate(&EvaluationRequest {
                    subject: &c.compartment_no,
                    graph: &self.graph,
                    rules,
                    hazards: &self.hazards,
                    at: self.at,
                })
            })
            .collect()
    }

    /// Which spaces change state right now if `proposed` replaces
    /// `current`: two passes over the register, the first examples named
    /// with the rule that decides the after state (or the before state when
    /// the space clears).
    fn moved(&self, current: &RuleSet, proposed: &RuleSet) -> Value {
        const EXAMPLES: usize = 12;
        let before = self.states_under(&current.bound_to(Work::ANY, self.at));
        let after = self.states_under(&proposed.bound_to(Work::ANY, self.at));
        let changed: Vec<Value> = self
            .compartments
            .iter()
            .zip(before.iter().zip(after.iter()))
            .filter(|(_, (b, a))| b.state != a.state)
            .map(|(c, (b, a))| {
                let rule = a
                    .governing_step()
                    .or_else(|| b.governing_step())
                    .map(|s| s.rule_code.as_str())
                    .unwrap_or_default();
                json!({
                    "compartment": c.compartment_no,
                    "before": b.state,
                    "after": a.state,
                    "rule": rule,
                })
            })
            .collect();
        json!({
            "spaces": changed.len(),
            "examples": changed.iter().take(EXAMPLES).collect::<Vec<_>>(),
        })
    }
}

// ---------------------------------------------------------------------------
// The report.
// ---------------------------------------------------------------------------

/// The `entry` object a row report carries.
fn entry_json(entry: &RuleEntry, clock: &YardClock) -> Value {
    let cells = compiler::export_row(entry, clock, &RowText::default());
    let cell = |i: usize| cells.get(i).cloned().unwrap_or_default();
    json!({
        "hazard": entry.hazard,
        "applies": entry.applies,
        "state": entry.state,
        "hold": entry.hold,
        "hold_from": entry.hold_from,
        "clearing_authority": entry.clearing_authority,
        "work_types": entry.binding.work_types,
        "categories": entry.binding.categories,
        "effective_from": cell(19),
        "effective_to": cell(20),
    })
}

/// One row of the report, in file order: every compiled entry and every row
/// that was not compiled, with its sentence.
fn row_reports(table: &Table, compiled: &Compiled, hull: &Hull, clock: &YardClock) -> Vec<Value> {
    let row_by_line: BTreeMap<usize, &Row> = table.rows.iter().map(|r| (r.line, r)).collect();
    let prose = |r: &RowRef, name: &str| {
        row_by_line
            .get(&r.line)
            .map_or_else(String::new, |row| table.cell(row, name).to_owned())
    };
    let mut rows: Vec<((usize, u8), Value)> = compiled
        .entries
        .iter()
        .map(|(r, entry)| {
            (
                (r.line, r.ordinal),
                json!({
                    "rule": r.rule,
                    "ordinal": r.ordinal,
                    "line": r.line,
                    "name": prose(r, "Name"),
                    "kind": prose(r, "Kind"),
                    "compiled": true,
                    "why_not": Value::Null,
                    "entry": entry_json(entry, clock),
                    "version": entry.rule_version,
                    "fires_on": hull.fires_on(entry),
                }),
            )
        })
        .chain(compiled.not_compiled.iter().map(|(r, why)| {
            (
                (r.line, r.ordinal),
                json!({
                    "rule": r.rule,
                    "ordinal": r.ordinal,
                    "line": r.line,
                    "name": prose(r, "Name"),
                    "kind": prose(r, "Kind"),
                    "compiled": false,
                    "why_not": why,
                    "entry": Value::Null,
                    "version": Value::Null,
                    "fires_on": Value::Null,
                }),
            )
        }))
        .collect();
    rows.sort_by_key(|(key, _)| *key);
    rows.into_iter().map(|(_, v)| v).collect()
}

/// The work-type audit: what the schedule carries, what the table names,
/// and the two differences.
fn work_types_json(compiled: &Compiled, hull: &Hull) -> Value {
    let on_schedule = hull.work_types_on_schedule();
    let bound: BTreeSet<&str> = compiled
        .entries
        .iter()
        .flat_map(|(_, e)| e.binding.work_types.iter().map(String::as_str))
        .collect();
    let carried: BTreeSet<&str> = on_schedule.iter().map(|(t, _)| t.as_str()).collect();
    json!({
        "on_schedule": on_schedule
            .iter()
            .map(|(t, n)| json!({ "work_type": t, "activities": n }))
            .collect::<Vec<_>>(),
        "bound": bound,
        "unbound_on_schedule": carried.difference(&bound).collect::<Vec<_>>(),
        "unseen_in_table": bound.difference(&carried).collect::<Vec<_>>(),
    })
}

fn finding(severity: &str, text: String) -> Value {
    json!({ "severity": severity, "text": text })
}

/// The clearing-authority codes the shell has a name for.
const NAMED_CLEARERS: [&str; 4] = [
    "marine_chemist",
    "fire_marshal",
    "isolation_authority",
    "issuing_authority",
];

/// A shift's cure: a hold longer than this widens every read's hazard tail.
const LONG_HOLD_MINUTES: i64 = 480;

/// Findings, never refusals: what the table would do on this hull that the
/// authority should see before Confirm. `reminted` names the rows whose
/// carried version id was set aside.
fn findings(
    compiled: &Compiled,
    hull: &Hull,
    work_types: &Value,
    reminted: &[String],
) -> Vec<Value> {
    let mut out: Vec<Value> = reminted
        .iter()
        .map(|text| finding("info", text.clone()))
        .collect();
    if compiled.entries.is_empty() {
        out.push(finding(
            "warn",
            "nothing compiles — commit would put no rule in force".to_owned(),
        ));
    }
    if !compiled.not_compiled.is_empty() {
        let names: Vec<String> = compiled
            .not_compiled
            .iter()
            .map(|(r, _)| r.rule.clone())
            .collect();
        out.push(finding(
            "info",
            format!(
                "{} of {} rows are not compiled and stay on file with their reason: {}",
                compiled.not_compiled.len(),
                compiled.not_compiled.len() + compiled.entries.len(),
                names.join(", ")
            ),
        ));
    }
    let codes = hull.coupling_codes();
    let mut seen_codes: BTreeSet<String> = BTreeSet::new();
    for (r, entry) in &compiled.entries {
        if let Applies::Coupled { code, .. } = &entry.applies {
            let code = code.as_str();
            if seen_codes.insert(format!("{}|{code}", r.rule)) {
                match codes.get(code) {
                    None => out.push(finding(
                        "warn",
                        format!(
                            "{} walks {code}, which this hull's coupling register does not carry — the row fires on nothing",
                            r.rule
                        ),
                    )),
                    Some(n) if code == "exhaust_trunk" && *n < 10 => out.push(finding(
                        "warn",
                        format!(
                            "{} walks exhaust_trunk on a hull with only {n} such edges (Y2: ventilation branches are not in the coupling register) — the row fires on little",
                            r.rule
                        ),
                    )),
                    Some(_) => {}
                }
            }
        }
        if !NAMED_CLEARERS.contains(&entry.clearing_authority.as_str()) {
            out.push(finding(
                "warn",
                format!(
                    "{} names clearing authority \"{}\", which the shell has no name for (S20)",
                    r.rule, entry.clearing_authority
                ),
            ));
        }
        if let Some(hold) = entry.hold.filter(|h| h.get() > LONG_HOLD_MINUTES) {
            out.push(finding(
                "warn",
                format!(
                    "{} holds {} min — longer than a shift's cure ({LONG_HOLD_MINUTES}); every read carries that long a tail",
                    r.rule,
                    hold.get()
                ),
            ));
        }
    }
    let list = |key: &str| -> Vec<String> {
        work_types
            .get(key)
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    };
    let unbound = list("unbound_on_schedule");
    if !unbound.is_empty() {
        out.push(finding(
            "warn",
            format!(
                "work types on the schedule that no row names: {} — they are judged by the any-work rows only",
                unbound.join(", ")
            ),
        ));
    }
    let unseen = list("unseen_in_table");
    if !unseen.is_empty() {
        out.push(finding(
            "warn",
            format!(
                "rows bind work types no served activity carries: {}",
                unseen.join(", ")
            ),
        ));
    }
    out
}

/// Entries whose effective range covers `at` — the count the card reads.
fn in_force(compiled: &Compiled, at: Timestamp) -> usize {
    compiled
        .entries
        .iter()
        .filter(|(_, e)| e.binds(Work::ANY, at))
        .count()
}

// ---------------------------------------------------------------------------
// The CSV export.
// ---------------------------------------------------------------------------

/// An RFC 4180 cell: always quoted, quotes doubled — the layout `export`
/// writes and the handoff uses.
fn quote(cell: &str) -> String {
    format!("\"{}\"", cell.replace('"', "\"\""))
}

/// The compiled set in the document layout, each entry's prose columns
/// taken from the row it came from, the version id in column 22.
fn export_csv(table: &Table, compiled: &Compiled, clock: &YardClock) -> String {
    let row_by_line: BTreeMap<usize, &Row> = table.rows.iter().map(|r| (r.line, r)).collect();
    let line = |cells: &[String]| cells.iter().map(|c| quote(c)).collect::<Vec<_>>().join(",");
    let mut out = line(&compiler::export_header());
    out.push('\n');
    for (r, entry) in &compiled.entries {
        let text = row_by_line
            .get(&r.line)
            .map_or_else(RowText::default, |row| RowText {
                name: table.cell(row, "Name").to_owned(),
                trigger: table.cell(row, "Trigger condition").to_owned(),
                propagation: table.cell(row, "Propagation type").to_owned(),
                clearing_condition: table.cell(row, "Clearing condition").to_owned(),
                who_may_clear: table.cell(row, "Who may clear").to_owned(),
                config_anchor: table.cell(row, "Config anchor").to_owned(),
                open_question: table
                    .cell(row, "Open question for the safety authority")
                    .to_owned(),
            });
        out.push_str(&line(&compiler::export_row(entry, clock, &text)));
        out.push('\n');
    }
    out
}

// ---------------------------------------------------------------------------
// The door.
// ---------------------------------------------------------------------------

/// `?format=csv` on the GET.
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub(crate) struct Format {
    /// `csv` for the export; anything else (or nothing) is JSON.
    pub(crate) format: Option<String>,
}

/// `GET /api/vessels/:id/rule-table[?format=csv]` — the table in force
/// (the committed document, or the seed in the document's layout), every
/// row's report against the hull as it stands, the signature, and the
/// work-type audit; or the in-force set as `text/csv` in the handoff layout
/// — what the sitting starts from.
pub(crate) async fn get_rule_table(
    State(state): State<AppState>,
    Caller { scope, .. }: Caller,
    Path(id): Path<Uuid>,
    Query(format): Query<Format>,
) -> Result<Response, ApiError> {
    let vessel = VesselId::from_uuid(id);
    state.store.get_vessel(&scope, vessel).await?;
    let clock = crate::yard_clock::clock_in_effect(state.store.as_ref(), &scope, vessel).await?;
    let table = table_in_effect(&state, &scope, vessel, &clock.clock).await?;
    if format.format.as_deref() == Some("csv") {
        let csv = export_csv(&table.table, &table.compiled, &clock.clock);
        return Ok(([(header::CONTENT_TYPE, "text/csv; charset=utf-8")], csv).into_response());
    }
    let rules = table.compiled.rule_set();
    let hull = Hull::read(&state, &scope, vessel, rules.longest_end_anchored_hold()).await?;
    let work_types = work_types_json(&table.compiled, &hull);
    Ok(Json(json!({
        "source": table.source,
        "label": table.label,
        "table_hash": table.hash,
        "rows_total": table.table.rows.len(),
        "rows_in_force": in_force(&table.compiled, hull.at),
        "rows": row_reports(&table.table, &table.compiled, &hull, &clock.clock),
        "signoff": table.signoff,
        "work_types": work_types,
        "findings": findings(&table.compiled, &hull, &work_types, &[]),
    }))
    .into_response())
}

/// The body of a rule-table import.
#[derive(Debug, serde::Deserialize)]
pub(crate) struct ImportRuleTable {
    /// Where the table came from, e.g. `CVN73-rule-table.csv`.
    pub(crate) label: String,
    /// The CSV text, UTF-8.
    pub(crate) csv: String,
}

/// `POST /api/vessels/:id/rule-table[?dry_run=true]` — the safety
/// authority's CSV through the door. Parsed and compiled whole against the
/// hull's clock or refused whole (422) with every reason; previewed row by
/// row against the hull as it stands — what each row fires on today, which
/// spaces change state if this replaces the table in force — with findings
/// that warn without refusing. *Nothing compiles* is a finding on a dry run
/// and a refusal on commit. A commit stores the cells and the entries,
/// clears any signature (the signature is of a hash), and ledgers
/// `DOCUMENT_REPLACED` naming every version.
pub(crate) async fn import_rule_table(
    State(state): State<AppState>,
    Caller { scope, .. }: Caller,
    Path(id): Path<Uuid>,
    Query(dry): Query<DryRun>,
    req: axum::extract::Request,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    state.store.get_vessel(&scope, vessel).await?;
    let body: ImportRuleTable = read_import_body(req).await?;
    let label = body.label.trim().to_owned();
    if label.is_empty() {
        return Err(ApiError::OutOfRange(
            "the rule table was refused whole: it carries no label".to_owned(),
        ));
    }
    let clock = crate::yard_clock::clock_in_effect(state.store.as_ref(), &scope, vessel).await?;
    let CompiledText {
        table,
        compiled,
        reminted,
    } = compile_text(&body.csv, &clock.clock).map_err(|refusals| {
        ApiError::OutOfRange(format!(
            "the rule table was refused whole: {}",
            refusals.join("; ")
        ))
    })?;
    let dry_run = dry.dry_run.unwrap_or(false);
    if !dry_run && compiled.entries.is_empty() {
        return Err(ApiError::OutOfRange(
            "the rule table was refused: nothing compiles — commit would put no rule in force"
                .to_owned(),
        ));
    }
    let current = table_in_effect(&state, &scope, vessel, &clock.clock).await?;
    let current_rules = current.compiled.rule_set();
    let proposed = compiled.rule_set();
    let hull = Hull::read(
        &state,
        &scope,
        vessel,
        current_rules
            .longest_end_anchored_hold()
            .max(proposed.longest_end_anchored_hold()),
    )
    .await?;
    let work_types = work_types_json(&compiled, &hull);
    let findings = findings(&compiled, &hull, &work_types, &reminted);
    let moved = hull.moved(&current_rules, &proposed);
    let rows: Vec<Vec<String>> = table.rows.iter().map(|r| r.cells.clone()).collect();
    let hash = table_hash(&table.header, &rows);
    let preview = json!({
        "rows": row_reports(&table, &compiled, &hull, &clock.clock),
        "in_force": in_force(&compiled, hull.at),
        "replaces": { "source": current.source, "label": current.label },
        "work_types": work_types,
        "moved": moved,
    });
    if dry_run {
        return Ok(Json(json!({
            "stored": false,
            "label": label,
            "table_hash": hash,
            "findings": findings,
            "preview": preview,
        })));
    }
    let versions: Vec<Value> = compiled
        .entries
        .iter()
        .map(|(r, e)| json!({ "rule": r.rule, "ordinal": r.ordinal, "version": e.rule_version }))
        .collect();
    let counts = json!({
        "rows": table.rows.len(),
        "compiled": compiled.entries.len(),
        "in_force": in_force(&compiled, hull.at),
        "moved_spaces": moved.get("spaces").cloned().unwrap_or(json!(0)),
        "table_hash": hash,
        "versions": versions,
    });
    let doc = RuleTableDoc {
        label: label.clone(),
        header: table.header.clone(),
        rows,
        entries: compiled.entries.iter().map(|(_, e)| e.clone()).collect(),
        table_hash: hash.clone(),
        signoff: None,
    };
    state.store.set_rule_table(&scope, vessel, doc).await?;
    ledger_document(
        &state,
        &scope,
        vessel,
        "DOCUMENT_REPLACED",
        RULE_TABLE_KIND,
        Some(&label),
        counts,
    )
    .await?;
    Ok(Json(json!({
        "stored": true,
        "label": label,
        "table_hash": hash,
        "findings": findings,
        "preview": preview,
    })))
}

/// `POST /api/vessels/:id/rule-table/revert` — back to the seed, and every
/// trace carries the seed's ids again. Ledgered like every revert.
pub(crate) async fn revert_rule_table(
    State(state): State<AppState>,
    Caller { scope, .. }: Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    state.store.clear_rule_table(&scope, vessel).await?;
    ledger_document(
        &state,
        &scope,
        vessel,
        "DOCUMENT_REVERTED",
        RULE_TABLE_KIND,
        None,
        json!({}),
    )
    .await?;
    Ok(Json(json!({ "reverted": true, "source": "seed" })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_hash_is_of_the_cells_not_the_bytes() {
        let header = vec!["Rule ID".to_owned(), "Name".to_owned()];
        let a = table_hash(&header, &[vec!["R03".to_owned(), "Coating".to_owned()]]);
        let b = table_hash(&header, &[vec![" R03 ".to_owned(), "Coating".to_owned()]]);
        let c = table_hash(&header, &[vec!["R04".to_owned(), "Coating".to_owned()]]);
        assert_eq!(a, b, "whitespace around a cell is not a change");
        assert_ne!(a, c);
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn a_version_id_is_content_addressed_and_ignores_the_id_it_carries() {
        let seed = RuleSet::seed_usn_hot_work();
        let r03 = seed.entries().first().cloned().expect("the seed has rows");
        let minted = mint_version(&r03);
        let mut renamed = r03.clone();
        renamed.rule_version = RuleVersionId::from_uuid(Uuid::from_u128(0xF00D));
        assert_eq!(
            mint_version(&renamed),
            minted,
            "the id is not part of the content"
        );
        let mut longer = r03.clone();
        longer.hold = Some(Minutes::new(600));
        assert_ne!(
            mint_version(&longer),
            minted,
            "a changed cell is a new version"
        );
        assert_eq!(minted.as_uuid().get_version_num(), 8);
        // Two entries of one row differ by reach, so they get distinct ids.
        let same_space = seed
            .entries()
            .iter()
            .find(|e| e.rule_code == "R03" && e.applies == Applies::SameSpace)
            .expect("R03 same-space");
        let coupled = seed
            .entries()
            .iter()
            .find(|e| e.rule_code == "R03" && e.applies != Applies::SameSpace)
            .expect("R03 coupled");
        assert_ne!(mint_version(same_space), mint_version(coupled));
    }

    #[test]
    fn the_seed_exports_as_a_table_and_its_csv_round_trips() {
        let clock = YardClock::utc();
        let seed = seed_table(&clock).expect("the seed compiles");
        assert_eq!(seed.compiled.entries.len(), 10);
        assert!(seed.compiled.not_compiled.is_empty());
        let csv = export_csv(&seed.table, &seed.compiled, &clock);
        assert_eq!(
            csv,
            compiler::export(&RuleSet::seed_usn_hot_work(), &clock, compiler::seed_text),
            "the door's export is the compiler's, byte for byte"
        );
        let CompiledText {
            table,
            compiled,
            reminted,
        } = compile_text(&csv, &clock).expect("the export compiles");
        assert_eq!(compiled.rule_set(), RuleSet::seed_usn_hot_work());
        assert!(reminted.is_empty(), "the seed's ids are honoured");
        let rows: Vec<Vec<String>> = table.rows.iter().map(|r| r.cells.clone()).collect();
        assert_eq!(table_hash(&table.header, &rows), seed.hash);
    }

    #[test]
    fn a_carried_id_is_honoured_only_while_the_row_reads_the_same() {
        let clock = YardClock::utc();
        // The seed's own export: every id carried, every id kept.
        let csv = compiler::export(&RuleSet::seed_usn_hot_work(), &clock, compiler::seed_text);
        // R04's hold edited in the spreadsheet, its seed id still in column 22.
        let edited = csv.replace(
            "\"deck_penetration\",\"30\",\"end\"",
            "\"deck_penetration\",\"60\",\"end\"",
        );
        assert_ne!(edited, csv, "the edit lands on R04");
        let CompiledText {
            compiled, reminted, ..
        } = compile_text(&edited, &clock).expect("the edited export compiles");
        assert_eq!(reminted.len(), 1, "{reminted:?}");
        assert!(
            reminted[0]
                .starts_with("R04-0 (line 7) carried version 00000000-0000-0000-0000-000000000402"),
            "{}",
            reminted[0]
        );
        let r04 = compiled
            .entries
            .iter()
            .find(|(r, _)| r.rule == "R04")
            .map(|(_, e)| e)
            .expect("R04 compiles");
        assert_eq!(r04.hold, Some(Minutes::new(60)));
        assert_eq!(r04.rule_version, mint_version(r04), "content-addressed");
        assert_eq!(r04.rule_version.as_uuid().get_version_num(), 8);
        // Every other row keeps the seed's id.
        let seed = RuleSet::seed_usn_hot_work();
        for (r, e) in compiled.entries.iter().filter(|(r, _)| r.rule != "R04") {
            assert!(
                seed.entries()
                    .iter()
                    .any(|s| s.rule_version == e.rule_version),
                "{r} keeps its seed id"
            );
        }
        // A content-addressed id re-imported is its own proof.
        let reexport = compiler::export(&compiled.rule_set(), &clock, compiler::seed_text);
        let again = compile_text(&reexport, &clock).expect("re-export compiles");
        assert!(again.reminted.is_empty(), "{:?}", again.reminted);
        assert_eq!(again.compiled.rule_set(), compiled.rule_set());
    }
}
