//! The hull's documents as files.
//!
//! The shell's doors accept five comma-separated shapes — the compartment
//! register, the coupling register, the zone chart, the geometry register and
//! the field-condition log — and parse them in the browser before the server
//! previews them. This module is the same shapes on the server side, for two
//! callers: the demo boot loader (`WADL_DEMO_DOCS`), which loads a directory
//! of them into the in-memory world so the served hull *is* the documents;
//! and the coupling door, which shares [`derive_vertical_edges`] with it so
//! a deck penetration proposed at boot and one proposed through the door are
//! the same proposal.
//!
//! Every parser is strict about shape and permissive about noise: blank
//! lines and `#` comments are skipped; a row that cannot be carried refuses
//! the file, naming the line. The documents are illustrative
//! (`docs/zone-scheme.md`); the parsing is not.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde_json::{json, Value};
use wadl_domain::ids::VesselId;
use wadl_engine::HazardKind;
use wadl_store::memory::{CompartmentRegister, CouplingRegister, GeometryRegister, ZoneRegister};
use wadl_store::model::{
    AuditRecord, CompartmentSummary, CouplingRowSummary, DeckCoverageSummary, RegisterDeckSummary,
    RegisterSpaceSummary, SpaceGeometrySummary, ZoneBoundSummary,
};
use wadl_store::{Repositories, StoreError, TenantScope};

/// Proposes `deck_penetration` edges from the register: a space directly
/// above another when their decks are consecutive in the hull's deck order,
/// their frame extents overlap (surveyed extents from the geometry register
/// where it has them, the frame station otherwise), and they sit on the same
/// side or one is on the centreline. Heat goes down, so the edge runs from
/// the upper space to the lower.
///
/// "Directly below" is the next ordinal the register actually carries, not
/// `ordinal + 1`: the ordinals above the main deck are negative and skip
/// zero, and a scheme that lost the gallery-to-main penetration to an
/// arithmetic gap would let heat stop at the hangar overhead.
#[must_use]
pub fn derive_vertical_edges(
    compartments: &[CompartmentSummary],
    authored: &[CouplingRowSummary],
) -> Vec<CouplingRowSummary> {
    let mut ordinals: Vec<i32> = compartments.iter().map(|c| c.deck_ordinal).collect();
    ordinals.sort_unstable();
    ordinals.dedup();
    let below: BTreeMap<i32, i32> = ordinals
        .iter()
        .zip(ordinals.iter().skip(1))
        .map(|(&upper, &lower)| (upper, lower))
        .collect();
    let extent = |c: &CompartmentSummary| -> Option<(i32, i32)> {
        match (c.fwd_frame, c.aft_frame, c.frame) {
            (Some(f), Some(a), _) => Some((f, a)),
            (_, _, Some(f)) => Some((f, f)),
            _ => None,
        }
    };
    let compatible_side = |a: &str, b: &str| a == b || a == "centreline" || b == "centreline";
    let mut out = Vec::new();
    for upper in compartments {
        let (Some((uf, ua)), Some(&lower_ordinal)) =
            (extent(upper), below.get(&upper.deck_ordinal))
        else {
            continue;
        };
        for lower in compartments {
            if lower.deck_ordinal != lower_ordinal {
                continue;
            }
            let Some((lf, la)) = extent(lower) else {
                continue;
            };
            if uf > la || lf > ua || !compatible_side(&upper.side, &lower.side) {
                continue;
            }
            let from = upper.compartment_no.as_str();
            let to = lower.compartment_no.as_str();
            if authored
                .iter()
                .any(|e| e.from == from && e.to == to && e.code == "deck_penetration")
            {
                continue;
            }
            out.push(CouplingRowSummary {
                from: from.to_owned(),
                to: to.to_owned(),
                code: "deck_penetration".to_owned(),
                symmetric: false,
                provenance: "derived".to_owned(),
            });
        }
    }
    out
}

/// The data rows of a document: line number and trimmed columns, comments
/// and blanks skipped.
pub(crate) fn rows(text: &str) -> impl Iterator<Item = (usize, Vec<&str>)> {
    text.lines().enumerate().filter_map(|(i, line)| {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            return None;
        }
        Some((i + 1, t.split(',').map(str::trim).collect()))
    })
}

fn int(line: usize, what: &str, raw: Option<&&str>) -> Result<i32, String> {
    raw.and_then(|s| s.parse::<i32>().ok()).ok_or_else(|| {
        format!(
            "line {line}: {what} {:?} is not a whole number",
            raw.copied().unwrap_or("")
        )
    })
}

fn col<'a>(line: usize, what: &str, raw: Option<&&'a str>) -> Result<&'a str, String> {
    match raw {
        Some(s) if !s.is_empty() => Ok(s),
        _ => Err(format!("line {line}: no {what}")),
    }
}

/// `deck,<code>,<label>,<ordinal>` and
/// `space,<no>,<name>,<deck_code>,<zone>,<category>[,<frame>,<side>]`.
///
/// # Errors
/// The first row that cannot be carried, by line.
pub fn parse_register_csv(
    text: &str,
) -> Result<(Vec<RegisterDeckSummary>, Vec<RegisterSpaceSummary>), String> {
    let mut decks = Vec::new();
    let mut spaces = Vec::new();
    for (line, c) in rows(text) {
        match c.first().copied() {
            Some("deck") => decks.push(RegisterDeckSummary {
                code: col(line, "deck code", c.get(1))?.to_owned(),
                label: c.get(2).filter(|s| !s.is_empty()).or(c.get(1)).map_or_else(String::new, |s| (*s).to_owned()),
                ordinal: int(line, "ordinal", c.get(3))?,
            }),
            Some("space") => spaces.push(RegisterSpaceSummary {
                compartment_no: col(line, "placard", c.get(1))?.to_owned(),
                name: col(line, "name", c.get(2))?.to_owned(),
                deck_code: col(line, "deck code", c.get(3))?.to_owned(),
                zone: col(line, "zone", c.get(4))?.to_owned(),
                category: c.get(5).map_or_else(String::new, |s| (*s).to_owned()),
                frame: match c.get(6) {
                    Some(s) if !s.is_empty() => Some(int(line, "frame", c.get(6))?),
                    _ => None,
                },
                side: c.get(7).filter(|s| !s.is_empty()).map(|s| s.to_lowercase()),
            }),
            other => {
                return Err(format!(
                    "line {line}: unrecognised record kind {:?} — every line must start with deck, or space,",
                    other.unwrap_or("")
                ))
            }
        }
    }
    Ok((decks, spaces))
}

/// `from,to,code[,symmetric]` — every row a person lists is `authored`.
///
/// # Errors
/// The first row that cannot be carried, by line.
pub fn parse_couplings_csv(text: &str) -> Result<Vec<CouplingRowSummary>, String> {
    rows(text)
        .map(|(line, c)| {
            Ok(CouplingRowSummary {
                from: col(line, "from", c.first())?.to_owned(),
                to: col(line, "to", c.get(1))?.to_owned(),
                code: col(line, "coupling code", c.get(2))?.to_owned(),
                symmetric: c.get(3).is_some_and(|s| {
                    matches!(
                        s.to_lowercase().as_str(),
                        "yes" | "true" | "1" | "symmetric"
                    )
                }),
                provenance: "authored".to_owned(),
            })
        })
        .collect()
}

/// `zone,lo_frame,hi_frame[,top_deck,bottom_deck]` — a block per row.
///
/// # Errors
/// The first row that cannot be carried, by line.
pub fn parse_zones_csv(text: &str) -> Result<Vec<ZoneBoundSummary>, String> {
    rows(text)
        .map(|(line, c)| {
            Ok(ZoneBoundSummary {
                zone: col(line, "zone", c.first())?.to_owned(),
                lo_frame: int(line, "lo frame", c.get(1))?,
                hi_frame: int(line, "hi frame", c.get(2))?,
                top_deck: c.get(3).filter(|s| !s.is_empty()).map(|s| (*s).to_owned()),
                bottom_deck: c.get(4).filter(|s| !s.is_empty()).map(|s| (*s).to_owned()),
            })
        })
        .collect()
}

/// `space,<no>,<fwd_frame>,<aft_frame>` and `deck,<code>,<lo_frame>,<hi_frame>`.
///
/// # Errors
/// The first row that cannot be carried, by line.
pub fn parse_geometry_csv(
    text: &str,
) -> Result<(Vec<SpaceGeometrySummary>, Vec<DeckCoverageSummary>), String> {
    let mut spaces = Vec::new();
    let mut decks = Vec::new();
    for (line, c) in rows(text) {
        match c.first().copied() {
            Some("space") => spaces.push(SpaceGeometrySummary {
                compartment_no: col(line, "placard", c.get(1))?.to_owned(),
                fwd_frame: int(line, "fwd frame", c.get(2))?,
                aft_frame: int(line, "aft frame", c.get(3))?,
            }),
            Some("deck") => decks.push(DeckCoverageSummary {
                deck_code: col(line, "deck code", c.get(1))?.to_owned(),
                lo_frame: int(line, "lo frame", c.get(2))?,
                hi_frame: int(line, "hi frame", c.get(3))?,
            }),
            other => {
                return Err(format!(
                    "line {line}: unrecognised record kind {:?} — every line must start with space, or deck,",
                    other.unwrap_or("")
                ))
            }
        }
    }
    Ok((spaces, decks))
}

/// One line of a field-condition log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HazardLogLine {
    /// The origin space.
    pub compartment: String,
    /// The engine's kind.
    pub kind: HazardKind,
    /// The fact as the deck says it.
    pub label: String,
    /// When it was raised, epoch ms; the loader's clock when absent.
    pub since_ms: Option<i64>,
}

/// The engine's kind for a log's column, in the engine's names or the yard's
/// words (`Hot work live`, `stop-work`).
#[must_use]
pub fn hazard_kind_from_log(raw: &str) -> Option<HazardKind> {
    let norm = raw
        .trim()
        .to_lowercase()
        .split(|c: char| c.is_whitespace() || c == '-' || c == '_')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("_");
    serde_json::from_value(serde_json::Value::String(norm)).ok()
}

/// `compartment,kind,label[,since]` — the label runs to the last comma when
/// the final column is an instant (ISO-8601 or epoch milliseconds).
///
/// # Errors
/// The first row that cannot be carried, by line — a kind the engine does not
/// evaluate refuses the file rather than silently losing its clock.
pub fn parse_hazard_log_csv(text: &str) -> Result<Vec<HazardLogLine>, String> {
    rows(text)
        .map(|(line, c)| {
            let compartment = col(line, "compartment", c.first())?.to_owned();
            let kind_raw = col(line, "kind", c.get(1))?;
            let kind = hazard_kind_from_log(kind_raw).ok_or_else(|| {
                format!("line {line}: {kind_raw:?} is not a field condition the engine evaluates")
            })?;
            let mut label_cols: Vec<&str> = c.iter().skip(2).copied().collect();
            let mut since_ms = None;
            if label_cols.len() >= 2 {
                if let Some(last) = label_cols.last() {
                    if let Some(ms) = instant_from_log(last) {
                        since_ms = Some(ms);
                        label_cols.pop();
                    }
                }
            }
            let label = label_cols.join(", ");
            if label.trim().is_empty() {
                return Err(format!("line {line}: no label"));
            }
            Ok(HazardLogLine {
                compartment,
                kind,
                label,
                since_ms,
            })
        })
        .collect()
}

/// Epoch milliseconds from a log's `since`: thirteen or more digits verbatim,
/// else a `YYYY-MM-DDTHH:MM[:SS]Z` instant, else nothing.
fn instant_from_log(raw: &str) -> Option<i64> {
    let text = raw.trim();
    if text.len() >= 13 && text.chars().all(|c| c.is_ascii_digit()) {
        return text.parse().ok();
    }
    let (date, clock) = text.split_once('T')?;
    let clock = clock.trim_end_matches('Z');
    let mut date_parts = date.split('-').map(|p| p.parse::<i64>().ok());
    let (year, month, day) = (
        date_parts.next()??,
        date_parts.next()??,
        date_parts.next()??,
    );
    let mut clock_parts = clock.split(':').map(|p| p.parse::<i64>().ok());
    let (hour, minute) = (clock_parts.next()??, clock_parts.next()??);
    let second = clock_parts.next().flatten().unwrap_or(0);
    // Days from the civil date (proleptic Gregorian), then the wall clock.
    let (shifted_year, shifted_month) = if month <= 2 {
        (year - 1, month + 9)
    } else {
        (year, month - 3)
    };
    let era = shifted_year.div_euclid(400);
    let year_of_era = shifted_year - era * 400;
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    Some(((days * 24 + hour) * 60 + minute) * 60_000 + second * 1000)
}

/// One ledger row a load wrote: the document kind, its label, the row's `seq`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LedgerLine {
    /// `yard_clock`, `p6_field_map`, `compartment_register`, `zone_register`,
    /// `geometry_register`, `coupling_register` or `hazard_log`.
    pub kind: String,
    /// The file name.
    pub label: String,
    /// The `DOCUMENT_REPLACED` row's sequence on the hull's ledger.
    pub seq: i64,
}

/// What the loader loaded, for the startup banner and the CLI's lines.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct LoadedDocuments {
    /// The yard clock's label, zone and shift count.
    pub clock: Option<(String, String, usize)>,
    /// The P6 field map's label and one-line summary.
    pub field_map: Option<(String, String)>,
    /// The register's label, decks and spaces.
    pub register: Option<(String, usize, usize)>,
    /// The zone chart's label and blocks.
    pub zones: Option<(String, usize)>,
    /// The coupling register's label, authored and derived edges.
    pub couplings: Option<(String, usize, usize)>,
    /// The geometry register's label, surveyed spaces and deck bands.
    pub geometry: Option<(String, usize, usize)>,
    /// The field-condition log's label and the rows raised.
    pub hazards: Option<(String, usize)>,
    /// The ledger rows written, in door order — empty on a dry run.
    pub ledger: Vec<LedgerLine>,
}

impl LoadedDocuments {
    /// One banner line per document loaded, in door order, each with the
    /// document kind its ledger row carries — the boot banner prints the
    /// lines, the CLI appends the row's `seq`.
    #[must_use]
    pub fn banner_lines(&self) -> Vec<(&'static str, String)> {
        let mut out = Vec::new();
        if let Some((name, zone, shifts)) = &self.clock {
            out.push((
                "yard_clock",
                format!("yard clock:          {name} — {zone}, {shifts} shifts"),
            ));
        }
        if let Some((name, summary)) = &self.field_map {
            out.push((
                "p6_field_map",
                format!("field map:           {name} — {summary}"),
            ));
        }
        if let Some((name, decks, spaces)) = &self.register {
            out.push((
                "compartment_register",
                format!("register:            {name} — {spaces} spaces on {decks} decks"),
            ));
        }
        if let Some((name, blocks)) = &self.zones {
            out.push((
                "zone_register",
                format!("zone chart:          {name} — {blocks} blocks"),
            ));
        }
        if let Some((name, spaces, bands)) = &self.geometry {
            out.push((
                "geometry_register",
                format!("geometry:            {name} — {spaces} surveyed, {bands} deck bands"),
            ));
        }
        if let Some((name, authored, derived)) = &self.couplings {
            out.push((
                "coupling_register",
                format!("couplings:           {name} — {authored} authored, {derived} derived"),
            ));
        }
        if let Some((name, raised)) = &self.hazards {
            out.push((
                "hazard_log",
                format!("field conditions:    {name} — {raised} raised"),
            ));
        }
        out
    }

    /// The ledger `seq` of the row written for `kind`, when one was.
    #[must_use]
    pub fn ledger_seq(&self, kind: &str) -> Option<i64> {
        self.ledger.iter().find(|l| l.kind == kind).map(|l| l.seq)
    }
}

/// Which path is loading, and whether it stores anything. `via` is written
/// into every ledger row's detail: `boot` (the demo binary on its own
/// account), `cli` (`wadl load-docs`), `test`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LoadVia<'a> {
    /// `boot`, `cli` or `test`.
    pub via: &'a str,
    /// Parse and validate every file in order; store and ledger nothing.
    pub dry_run: bool,
}

/// A load refused at one file. Every file before it is committed — the
/// loader is a sequence of doors, each all-or-nothing, like data-load day —
/// and `loaded_before` says which, with their ledger rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadRefused {
    /// `<file name>: <reason>`.
    pub reason: String,
    /// What was committed before the refusal.
    pub loaded_before: LoadedDocuments,
}

impl std::fmt::Display for LoadRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.reason)
    }
}

impl From<LoadRefused> for String {
    fn from(refused: LoadRefused) -> Self {
        refused.reason
    }
}

/// The detail of one `DOCUMENT_REPLACED` / `DOCUMENT_REVERTED` ledger row.
#[derive(Debug, Clone)]
pub(crate) struct DocumentLedgerLine<'a> {
    /// `DOCUMENT_REPLACED` or `DOCUMENT_REVERTED`.
    pub(crate) action: &'a str,
    /// The document kind.
    pub(crate) kind: &'a str,
    /// The document's label — the file name — when it has one.
    pub(crate) label: Option<&'a str>,
    /// The counts the door reported.
    pub(crate) counts: Value,
    /// `door`, `boot`, `cli` or `test`.
    pub(crate) via: &'a str,
}

/// Writes one ledger row for a document changing hands, on any store: the
/// doors (`via: door`), the boot loader (`boot`), the CLI (`cli`) and the
/// tests share this so every such row has one shape —
/// `{ kind, label, counts, via, by_org, at_ms }` — hashed into the chain.
///
/// # Errors
/// [`StoreError::NotFound`] when the hull is outside `scope`;
/// [`StoreError::Backend`] when the row cannot be written.
pub(crate) async fn ledger_document_on(
    store: &dyn Repositories,
    scope: &TenantScope,
    vessel: VesselId,
    line: DocumentLedgerLine<'_>,
    now_ms: i64,
) -> Result<AuditRecord, StoreError> {
    let detail = json!({
        "kind": line.kind,
        "label": line.label,
        "counts": line.counts,
        "via": line.via,
        "by_org": scope.org.to_string(),
        "at_ms": now_ms,
    });
    let detail = serde_json::to_string(&detail).unwrap_or_default();
    store
        .append_audit(scope, vessel, line.action, &detail, None, now_ms)
        .await
}

fn find_doc(dir: &Path, suffix: &str) -> Option<(String, String)> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(suffix))
        .collect();
    names.sort();
    let name = names.into_iter().next()?;
    let text = std::fs::read_to_string(dir.join(&name)).ok()?;
    Some((name, text))
}

/// The boot loader: [`load_docs`] on the binary's own account, storing and
/// ledgering every document `via: boot`. Kept for the boot path and the
/// tests that boot the reference hull.
///
/// # Errors
/// The first document that cannot be carried, with the reason.
pub async fn load_demo_docs(
    store: &dyn Repositories,
    scope: &TenantScope,
    vessel: VesselId,
    dir: &Path,
    now_ms: i64,
) -> Result<LoadedDocuments, String> {
    load_docs(
        store,
        scope,
        vessel,
        dir,
        now_ms,
        LoadVia {
            via: "boot",
            dry_run: false,
        },
    )
    .await
    .map_err(String::from)
}

/// Loads a directory of documents into a hull, in the order the doors would
/// need them: the yard clock and the P6 field map first (the export that
/// follows is read in the one and through the other), then the register
/// (everything else names its spaces), then the zone chart and geometry,
/// then the couplings with their derived vertical adjacency, then the
/// morning's log. Files are found by suffix (`-clock.csv`, `-fieldmap.json`,
/// `-register.csv`, `-zones.csv`, `-couplings.csv`, `-geometry.csv`,
/// `-hazards.csv`); absent ones are skipped, and the seed stands in.
///
/// Every stored document writes one `DOCUMENT_REPLACED` row with its kind,
/// label, counts and `via` — the boot path included, which is the truth
/// about where a served hull came from. With `dry_run`, every file is parsed
/// and validated in order and nothing is stored or ledgered: later files
/// validate against the register and geometry parsed earlier in the same
/// run, which the store never saw.
///
/// # Errors
/// The first document that cannot be carried, with the reason and the
/// documents committed before it — the hull refuses to serve a half-loaded
/// world as though it were the whole one, and says how far it got.
pub async fn load_docs(
    store: &dyn Repositories,
    scope: &TenantScope,
    vessel: VesselId,
    dir: &Path,
    now_ms: i64,
    via: LoadVia<'_>,
) -> Result<LoadedDocuments, LoadRefused> {
    let mut doors = Loader {
        store,
        scope,
        vessel,
        now_ms,
        via,
        staged: Staged::default(),
        lines: Vec::new(),
    };
    let mut loaded = LoadedDocuments::default();
    if let Some((name, text)) = find_doc(dir, "-clock.csv") {
        match doors.clock(&name, &text).await {
            Ok(c) => loaded.clock = Some(c),
            Err(reason) => return Err(doors.refused(reason, loaded)),
        }
    }
    if let Some((name, text)) = find_doc(dir, "-fieldmap.json") {
        match doors.field_map(&name, &text).await {
            Ok(c) => loaded.field_map = Some(c),
            Err(reason) => return Err(doors.refused(reason, loaded)),
        }
    }
    if let Some((name, text)) = find_doc(dir, "-register.csv") {
        match doors.register(&name, &text).await {
            Ok(c) => loaded.register = Some(c),
            Err(reason) => return Err(doors.refused(reason, loaded)),
        }
    }
    if let Some((name, text)) = find_doc(dir, "-zones.csv") {
        match doors.zones(&name, &text).await {
            Ok(c) => loaded.zones = Some(c),
            Err(reason) => return Err(doors.refused(reason, loaded)),
        }
    }
    if let Some((name, text)) = find_doc(dir, "-geometry.csv") {
        match doors.geometry(&name, &text).await {
            Ok(c) => loaded.geometry = Some(c),
            Err(reason) => return Err(doors.refused(reason, loaded)),
        }
    }
    if let Some((name, text)) = find_doc(dir, "-couplings.csv") {
        match doors.couplings(&name, &text).await {
            Ok(c) => loaded.couplings = Some(c),
            Err(reason) => return Err(doors.refused(reason, loaded)),
        }
    }
    if let Some((name, text)) = find_doc(dir, "-hazards.csv") {
        match doors.hazards(&name, &text).await {
            Ok(c) => loaded.hazards = Some(c),
            Err(reason) => return Err(doors.refused(reason, loaded)),
        }
    }
    loaded.ledger = doors.lines;
    Ok(loaded)
}

/// The register and geometry as parsed in this load, so the documents after
/// them validate against what this run carries — on a dry run the store
/// never sees them, and on a real one they are what the store now holds.
#[derive(Default)]
struct Staged {
    register: Option<CompartmentRegister>,
    geometry: Option<GeometryRegister>,
}

/// One document at a time, each refusing with the file's name in front.
struct Loader<'a> {
    store: &'a dyn Repositories,
    scope: &'a TenantScope,
    vessel: VesselId,
    now_ms: i64,
    via: LoadVia<'a>,
    staged: Staged,
    lines: Vec<LedgerLine>,
}

fn err(name: &str, e: impl std::fmt::Display) -> String {
    format!("{name}: {e}")
}

impl Loader<'_> {
    /// Whether this load stores anything.
    fn storing(&self) -> bool {
        !self.via.dry_run
    }

    /// The refusal, carrying what was committed before it.
    fn refused(self, reason: String, mut loaded: LoadedDocuments) -> LoadRefused {
        loaded.ledger = self.lines;
        LoadRefused {
            reason,
            loaded_before: loaded,
        }
    }

    /// One `DOCUMENT_REPLACED` row for a document just stored.
    async fn ledger(
        &mut self,
        kind: &'static str,
        label: &str,
        counts: Value,
    ) -> Result<(), String> {
        let record = ledger_document_on(
            self.store,
            self.scope,
            self.vessel,
            DocumentLedgerLine {
                action: "DOCUMENT_REPLACED",
                kind,
                label: Some(label),
                counts,
                via: self.via.via,
            },
            self.now_ms,
        )
        .await
        .map_err(|e| err(label, e))?;
        self.lines.push(LedgerLine {
            kind: kind.to_owned(),
            label: label.to_owned(),
            seq: record.seq,
        });
        Ok(())
    }

    async fn clock(&mut self, name: &str, text: &str) -> Result<(String, String, usize), String> {
        let clock = crate::yard_clock::parse_clock_csv(text).map_err(|e| err(name, e))?;
        let problems = clock.validate();
        if !problems.is_empty() {
            return Err(err(name, problems.join("; ")));
        }
        let counts = (name.to_owned(), clock.zone.clone(), clock.shifts.len());
        if self.storing() {
            self.store
                .set_yard_clock(
                    self.scope,
                    self.vessel,
                    wadl_store::memory::YardClockDoc {
                        label: name.to_owned(),
                        clock,
                    },
                )
                .await
                .map_err(|e| err(name, e))?;
            self.ledger(
                "yard_clock",
                name,
                json!({ "zone": counts.1, "shifts": counts.2 }),
            )
            .await?;
        }
        Ok(counts)
    }

    /// The field map, in the JSON shape the door takes: refused whole with
    /// every reason, exactly as the door would refuse it.
    async fn field_map(&mut self, name: &str, text: &str) -> Result<(String, String), String> {
        let value: serde_json::Value = serde_json::from_str(text).map_err(|e| err(name, e))?;
        let map: wadl_ingest::field_map::FieldMap =
            serde_json::from_value(value.clone()).map_err(|e| err(name, e))?;
        map.validate()
            .map_err(|problems| err(name, problems.join("; ")))?;
        let counts = (name.to_owned(), map.summary());
        if self.storing() {
            self.store
                .set_field_map(
                    self.scope,
                    self.vessel,
                    wadl_store::memory::FieldMapDoc {
                        label: name.to_owned(),
                        map: value,
                    },
                )
                .await
                .map_err(|e| err(name, e))?;
            self.ledger(
                "p6_field_map",
                name,
                json!({ "summary": counts.1, "projects": map.projects.len() }),
            )
            .await?;
        }
        Ok(counts)
    }

    /// The hull's spaces: the register parsed in this load when there is
    /// one, else the store's.
    async fn placards(&self) -> Result<Vec<CompartmentSummary>, String> {
        if let Some(reg) = &self.staged.register {
            return Ok(wadl_store::memory::register_compartments(reg));
        }
        self.store
            .list_compartments(self.scope, self.vessel)
            .await
            .map_err(|e| e.to_string())
    }

    /// The hull's deck codes, from the same source as [`Self::placards`].
    async fn deck_codes(&self) -> Result<BTreeSet<String>, String> {
        if let Some(reg) = &self.staged.register {
            return Ok(reg.decks.iter().map(|d| d.code.clone()).collect());
        }
        Ok(self
            .store
            .list_decks(self.scope, self.vessel)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|d| d.code)
            .collect())
    }

    /// Surveyed extents by placard: this load's geometry when parsed, else
    /// the store's.
    async fn extents(&self) -> Result<BTreeMap<String, (i32, i32)>, String> {
        let staged = self.staged.geometry.clone();
        let stored = match staged {
            Some(g) => Some(g),
            None => self
                .store
                .geometry_register(self.scope, self.vessel)
                .await
                .map_err(|e| e.to_string())?,
        };
        Ok(stored
            .map(|g| {
                g.spaces
                    .iter()
                    .map(|s| (s.compartment_no.clone(), (s.fwd_frame, s.aft_frame)))
                    .collect()
            })
            .unwrap_or_default())
    }

    async fn register(&mut self, name: &str, text: &str) -> Result<(String, usize, usize), String> {
        let (decks, spaces) = parse_register_csv(text).map_err(|e| err(name, e))?;
        let known: BTreeSet<&str> = decks.iter().map(|d| d.code.as_str()).collect();
        if let Some(s) = spaces
            .iter()
            .find(|s| !known.contains(s.deck_code.as_str()))
        {
            return Err(err(
                name,
                format!(
                    "{} is on deck {:?}, which the register does not list",
                    s.compartment_no, s.deck_code
                ),
            ));
        }
        let counts = (name.to_owned(), decks.len(), spaces.len());
        let register = CompartmentRegister {
            label: name.to_owned(),
            decks,
            spaces,
        };
        if self.storing() {
            self.store
                .set_compartment_register(self.scope, self.vessel, register.clone())
                .await
                .map_err(|e| err(name, e))?;
            self.ledger(
                "compartment_register",
                name,
                json!({ "decks": counts.1, "spaces": counts.2 }),
            )
            .await?;
        }
        self.staged.register = Some(register);
        Ok(counts)
    }

    async fn zones(&mut self, name: &str, text: &str) -> Result<(String, usize), String> {
        let bounds = parse_zones_csv(text).map_err(|e| err(name, e))?;
        let deck_codes = self.deck_codes().await?;
        for b in &bounds {
            for code in [&b.top_deck, &b.bottom_deck].into_iter().flatten() {
                if !deck_codes.contains(code) {
                    return Err(err(
                        name,
                        format!("{}: deck {code:?} is not one the register carries", b.zone),
                    ));
                }
            }
        }
        let counts = (name.to_owned(), bounds.len());
        if self.storing() {
            self.store
                .set_zone_register(
                    self.scope,
                    self.vessel,
                    ZoneRegister {
                        label: name.to_owned(),
                        bounds,
                    },
                )
                .await
                .map_err(|e| err(name, e))?;
            self.ledger("zone_register", name, json!({ "blocks": counts.1 }))
                .await?;
        }
        Ok(counts)
    }

    async fn geometry(&mut self, name: &str, text: &str) -> Result<(String, usize, usize), String> {
        let (spaces, bands) = parse_geometry_csv(text).map_err(|e| err(name, e))?;
        let counts = (name.to_owned(), spaces.len(), bands.len());
        let register = GeometryRegister {
            label: name.to_owned(),
            spaces,
            decks: bands,
        };
        if self.storing() {
            self.store
                .set_geometry_register(self.scope, self.vessel, register.clone())
                .await
                .map_err(|e| err(name, e))?;
            self.ledger(
                "geometry_register",
                name,
                json!({ "spaces": counts.1, "deck_bands": counts.2 }),
            )
            .await?;
        }
        self.staged.geometry = Some(register);
        Ok(counts)
    }

    async fn couplings(
        &mut self,
        name: &str,
        text: &str,
    ) -> Result<(String, usize, usize), String> {
        let authored = parse_couplings_csv(text).map_err(|e| err(name, e))?;
        let compartments = self.placards().await?;
        let placards: BTreeSet<&str> = compartments
            .iter()
            .map(|c| c.compartment_no.as_str())
            .collect();
        let types = self
            .store
            .coupling_types(self.scope, self.vessel)
            .await
            .map_err(|e| e.to_string())?;
        for e in &authored {
            if !types.iter().any(|t| t.code == e.code) {
                return Err(err(
                    name,
                    format!(
                        "{} → {}: coupling type {:?} is not one this hull's rules know",
                        e.from, e.to, e.code
                    ),
                ));
            }
            for no in [&e.from, &e.to] {
                if !placards.contains(no.as_str()) {
                    return Err(err(name, format!("{no} is not on this hull's register")));
                }
            }
        }
        // Surveyed extents, where the geometry register has them, make the
        // derivation honest about what overlaps what.
        let extents = self.extents().await?;
        let mut with_extents = compartments;
        for c in &mut with_extents {
            if let Some(&(fwd, aft)) = extents.get(c.compartment_no.as_str()) {
                c.fwd_frame = Some(fwd);
                c.aft_frame = Some(aft);
            }
        }
        let derived = derive_vertical_edges(&with_extents, &authored);
        let counts = (name.to_owned(), authored.len(), derived.len());
        if self.storing() {
            let mut edges = authored;
            edges.extend(derived);
            self.store
                .set_coupling_register(
                    self.scope,
                    self.vessel,
                    CouplingRegister {
                        label: name.to_owned(),
                        edges,
                    },
                )
                .await
                .map_err(|e| err(name, e))?;
            self.ledger(
                "coupling_register",
                name,
                json!({ "authored": counts.1, "derived": counts.2 }),
            )
            .await?;
        }
        Ok(counts)
    }

    async fn hazards(&mut self, name: &str, text: &str) -> Result<(String, usize), String> {
        let lines = parse_hazard_log_csv(text).map_err(|e| err(name, e))?;
        let compartments = self.placards().await?;
        let placards: BTreeSet<&str> = compartments
            .iter()
            .map(|c| c.compartment_no.as_str())
            .collect();
        let live = self
            .store
            .live_hazards(
                self.scope,
                self.vessel,
                wadl_domain::time::Timestamp::from_epoch_millis(self.now_ms),
            )
            .await
            .map_err(|e| e.to_string())?;
        let mut raised = 0;
        for l in &lines {
            if !placards.contains(l.compartment.as_str()) {
                return Err(err(
                    name,
                    format!("{} is not on this hull's register", l.compartment),
                ));
            }
            if live
                .iter()
                .any(|h| h.origin.as_str() == l.compartment && h.kind == l.kind)
            {
                continue;
            }
            if self.storing() {
                self.store
                    .raise_hazard(
                        self.scope,
                        self.vessel,
                        &l.compartment,
                        l.kind,
                        l.since_ms.unwrap_or(self.now_ms),
                        &l.label,
                    )
                    .await
                    .map_err(|e| err(name, e))?;
            }
            raised += 1;
        }
        if self.storing() {
            self.ledger(
                "hazard_log",
                name,
                json!({ "listed": lines.len(), "raised": raised }),
            )
            .await?;
        }
        Ok((name.to_owned(), raised))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn space(no: &str, ordinal: i32, frame: i32, side: &str) -> CompartmentSummary {
        CompartmentSummary {
            frame: Some(frame),
            fwd_frame: None,
            aft_frame: None,
            side: side.to_owned(),
            geometry_source: "parsed".to_owned(),
            compartment_no: wadl_domain::compartment::CompartmentNo::new(no),
            name: no.to_owned(),
            deck_code: ordinal.to_string(),
            deck_ordinal: ordinal,
            zone: "Z1".to_owned(),
            category: String::new(),
        }
    }

    #[test]
    fn vertical_adjacency_follows_the_deck_order_across_the_gap_at_the_main_deck() {
        // Gallery is -1 and main is 1: consecutive in the hull, not in arithmetic.
        let rows = [
            space("03-100-0-Q", -1, 100, "centreline"),
            space("1-100-0-Q", 1, 100, "centreline"),
            space("2-100-2-L", 2, 100, "port"),
        ];
        let edges = derive_vertical_edges(&rows, &[]);
        let pairs: Vec<(&str, &str)> = edges
            .iter()
            .map(|e| (e.from.as_str(), e.to.as_str()))
            .collect();
        assert_eq!(
            pairs,
            vec![("03-100-0-Q", "1-100-0-Q"), ("1-100-0-Q", "2-100-2-L")]
        );
        assert!(edges
            .iter()
            .all(|e| e.provenance == "derived" && e.code == "deck_penetration"));
    }

    #[test]
    fn the_zone_chart_carries_blocks() {
        let bounds = parse_zones_csv("# chart\nZ1,0,273,flight,flight\nZ6,0,115\n").unwrap();
        assert_eq!(bounds.len(), 2);
        assert_eq!(bounds[0].top_deck.as_deref(), Some("flight"));
        assert_eq!(bounds[1].top_deck, None);
        assert!(parse_zones_csv("Z1,zero,1").unwrap_err().contains("line 1"));
    }

    #[test]
    fn the_hazard_log_reads_kinds_in_yard_words_and_keeps_a_labels_commas() {
        let lines = parse_hazard_log_csv(
            "3-148-2-E,Energised bus,Bus 3-SG-2 live, no ZES,2026-09-02T06:00:00Z\n5-96-0-E,hot_work_live,HW 2601\n",
        )
        .unwrap();
        assert_eq!(lines[0].kind, HazardKind::EnergisedBus);
        assert_eq!(lines[0].label, "Bus 3-SG-2 live, no ZES");
        // 2026-09-02T06:00:00Z: 20,698 days and six hours after the epoch.
        assert_eq!(lines[0].since_ms, Some(1_788_328_800_000));
        assert_eq!(lines[1].since_ms, None);
        assert!(parse_hazard_log_csv("3-148-2-E,gremlins,x")
            .unwrap_err()
            .contains("gremlins"));
    }

    #[test]
    fn the_register_refuses_a_record_kind_it_cannot_carry() {
        let (decks, spaces) = parse_register_csv(
            "deck,3rd,Third Deck,3\nspace,3-148-2-E,Switchgear,3rd,Z4,Electrical,148,Port\n",
        )
        .unwrap();
        assert_eq!(decks.len(), 1);
        assert_eq!(spaces[0].side.as_deref(), Some("port"));
        assert!(parse_register_csv("bulkhead,x")
            .unwrap_err()
            .contains("bulkhead"));
    }
}
