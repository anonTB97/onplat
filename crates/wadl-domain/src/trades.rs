//! The yard's trade taxonomy: trade codes to work types, work-type flags,
//! occupancy tolerances.
//!
//! Two questions the platform used to answer with English substrings are
//! answered here from a document the yard authors and signs for: *is this
//! activity an ignition source, a flammable atmosphere, a confined-space
//! entry* — and *how many people fit in this kind of space for a shift*.
//!
//! The vocabulary is S14's: a trade row names the **work type** its work
//! defaults to (`hot_work`, `coating`, `electrical`, …), the same tokens the
//! rule table binds rows to, and the flags hang off the work type — never off
//! the trade. So an SM-WELD crew doing an inspection (the field map says so)
//! carries no ignition flag, and the taxonomy never invents a second
//! vocabulary beside the rule table's.
//!
//! Pure: serde, validation, resolution; no I/O, no clock. The CSV form the
//! door and the boot loader read is parsed here too ([`TradeTaxonomy::parse_csv`])
//! so the shell's picker, the CLI and the API agree on one grammar.

use core::fmt;

/// What a work type means for work-on-work safety. Declared per work type
/// by the yard; defaulted to nothing for a work type no row declares.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WorkFlags {
    /// The work can start a fire: welding, burning, grinding.
    #[serde(default)]
    pub ignition_source: bool,
    /// The work fills a space with vapour: coating, solvent flush, fuel.
    #[serde(default)]
    pub flammable_atmosphere: bool,
    /// The work is a confined-space entry. Carried for the rules sitting;
    /// drives no issue kind in the pilot.
    #[serde(default)]
    pub confined_space: bool,
}

impl WorkFlags {
    /// The flag tokens the CSV accepts, in the order they are served.
    pub const TOKENS: [&'static str; 3] =
        ["ignition_source", "flammable_atmosphere", "confined_space"];

    /// Sets the flag named by `token`; `None` when no flag has that name.
    #[must_use]
    pub fn set(mut self, token: &str) -> Option<Self> {
        match token {
            "ignition_source" => self.ignition_source = true,
            "flammable_atmosphere" => self.flammable_atmosphere = true,
            "confined_space" => self.confined_space = true,
            _ => return None,
        }
        Some(self)
    }

    /// The set flags by name — what the activity read serves as `flags`.
    #[must_use]
    pub fn names(self) -> Vec<&'static str> {
        let mut out = Vec::new();
        if self.ignition_source {
            out.push("ignition_source");
        }
        if self.flammable_atmosphere {
            out.push("flammable_atmosphere");
        }
        if self.confined_space {
            out.push("confined_space");
        }
        out
    }

    /// Whether no flag is set.
    #[must_use]
    pub const fn is_empty(self) -> bool {
        !(self.ignition_source || self.flammable_atmosphere || self.confined_space)
    }
}

/// One trade as the scheduler exports it (`RSRC.rsrc_short_name`: `SM-WELD`)
/// and the work type its work defaults to when the field map is silent.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TradeRow {
    /// The trade code, exactly as the export carries it.
    pub trade: String,
    /// The work-type token the trade's work defaults to.
    pub work_type: String,
    /// The yard's name for the trade.
    pub display_name: String,
}

/// One work type: the token the rule table binds to, and its flags.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WorkTypeRow {
    /// The token, `[a-z0-9_]`.
    pub work_type: String,
    /// What the work type means for work-on-work safety.
    #[serde(default)]
    pub flags: WorkFlags,
    /// The yard's name for it.
    pub display_name: String,
}

/// How many people a space takes for a shift: a default, and overrides by
/// register category (the register's own words: `Tanks & voids`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Occupancy {
    /// The tolerance for a space whose category has no row.
    pub default_people: u32,
    /// `(category, tolerance)`, file order.
    #[serde(default)]
    pub by_category: Vec<(String, u32)>,
}

impl Default for Occupancy {
    fn default() -> Self {
        Self {
            default_people: DEFAULT_TOLERANCE,
            by_category: Vec::new(),
        }
    }
}

/// The tolerance the built-in default carries, and what the shell's crew
/// tolerance was before the taxonomy existed.
pub const DEFAULT_TOLERANCE: u32 = 6;

/// The taxonomy whole: trades, work types, occupancy.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TradeTaxonomy {
    /// Trade rows, file order.
    #[serde(default)]
    pub trades: Vec<TradeRow>,
    /// Work-type rows, file order.
    #[serde(default)]
    pub work_types: Vec<WorkTypeRow>,
    /// Occupancy policy.
    #[serde(default)]
    pub occupancy: Occupancy,
}

/// Where a resolved work type came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkTypeSource {
    /// The field map carried it on the activity (S13's `work_type`).
    FieldMap,
    /// The trade row supplied it.
    Taxonomy,
    /// Neither: the activity has no work type.
    None,
}

impl WorkTypeSource {
    /// The wire word: `field_map`, `taxonomy`, `none`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::FieldMap => "field_map",
            Self::Taxonomy => "taxonomy",
            Self::None => "none",
        }
    }
}

impl fmt::Display for WorkTypeSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// An activity's work type and flags, resolved from the field map first and
/// the trade row second — see [`TradeTaxonomy::resolve`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Resolved<'a> {
    /// The work type, or `None` when neither source names one.
    pub work_type: Option<&'a str>,
    /// Which source won.
    pub source: WorkTypeSource,
    /// The work type's flags; empty when no row declares it.
    pub flags: WorkFlags,
}

/// Whether a work-type token is well formed: non-empty, `[a-z0-9_]`.
#[must_use]
pub fn is_token(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

impl TradeTaxonomy {
    /// S14's seven work types with the flags the rule table already treats
    /// as fire and vapour — `hot_work` an ignition source, `coating` a
    /// flammable atmosphere — no trade rows, occupancy [`DEFAULT_TOLERANCE`].
    /// What a hull is on before the yard authors its own document; a hull
    /// whose export carries the `work_type` field derives its pairs from
    /// this alone.
    #[must_use]
    pub fn default_vocabulary() -> Self {
        let row = |token: &str, flags: WorkFlags, name: &str| WorkTypeRow {
            work_type: token.to_owned(),
            flags,
            display_name: name.to_owned(),
        };
        let ignition = WorkFlags {
            ignition_source: true,
            ..WorkFlags::default()
        };
        let vapour = WorkFlags {
            flammable_atmosphere: true,
            ..WorkFlags::default()
        };
        Self {
            trades: Vec::new(),
            work_types: vec![
                row("hot_work", ignition, "Hot work"),
                row("coating", vapour, "Preservation / coatings"),
                row("electrical", WorkFlags::default(), "Electrical"),
                row("inspection", WorkFlags::default(), "Inspection & test"),
                row("insulation", WorkFlags::default(), "Insulation & lagging"),
                row("rigging", WorkFlags::default(), "Rigging & staging"),
                row("mechanical", WorkFlags::default(), "Mechanical"),
            ],
            occupancy: Occupancy::default(),
        }
    }

    /// The work-type row for `token`, if declared.
    #[must_use]
    pub fn work_type(&self, token: &str) -> Option<&WorkTypeRow> {
        self.work_types.iter().find(|w| w.work_type == token)
    }

    /// The trade row for `code`: an exact match, else a case-insensitive
    /// one — a yard's export and its taxonomy are typed by different hands.
    #[must_use]
    pub fn trade(&self, code: &str) -> Option<&TradeRow> {
        self.trades.iter().find(|t| t.trade == code).or_else(|| {
            self.trades
                .iter()
                .find(|t| t.trade.eq_ignore_ascii_case(code))
        })
    }

    /// An activity's work type and flags. `from_map` (the field map's value
    /// on the activity) wins when `Some`; else the trade row's default; else
    /// nothing. The flags come from the **work-type row** of whichever won,
    /// and are empty when no row declares that type — a work type the
    /// taxonomy has never heard of is not silently fire.
    #[must_use]
    pub fn resolve<'a>(&'a self, from_map: Option<&'a str>, trade: &str) -> Resolved<'a> {
        let (work_type, source) = match from_map {
            Some(wt) => (Some(wt), WorkTypeSource::FieldMap),
            None => match self.trade(trade) {
                Some(row) => (Some(row.work_type.as_str()), WorkTypeSource::Taxonomy),
                None => (None, WorkTypeSource::None),
            },
        };
        let flags = work_type
            .and_then(|wt| self.work_type(wt))
            .map_or_else(WorkFlags::default, |row| row.flags);
        Resolved {
            work_type,
            source,
            flags,
        }
    }

    /// The occupancy tolerance for a register category: its row (exact,
    /// then case-insensitive), else the default.
    #[must_use]
    pub fn tolerance(&self, category: Option<&str>) -> u32 {
        let Some(category) = category else {
            return self.occupancy.default_people;
        };
        let rows = &self.occupancy.by_category;
        rows.iter()
            .find(|(c, _)| c == category)
            .or_else(|| rows.iter().find(|(c, _)| c.eq_ignore_ascii_case(category)))
            .map_or(self.occupancy.default_people, |(_, n)| *n)
    }

    /// Every reason this taxonomy cannot be served — all of them, so the
    /// yard fixes the file once. Empty means the document stands.
    #[must_use]
    pub fn validate(&self) -> Vec<String> {
        let mut problems = Vec::new();
        let mut seen_types: Vec<&str> = Vec::new();
        for w in &self.work_types {
            if !is_token(&w.work_type) {
                problems.push(format!(
                    "work type {:?} is not a token ([a-z0-9_])",
                    w.work_type
                ));
            }
            if seen_types.contains(&w.work_type.as_str()) {
                problems.push(format!("work type {:?} is declared twice", w.work_type));
            }
            seen_types.push(&w.work_type);
        }
        let mut seen_trades: Vec<&str> = Vec::new();
        for t in &self.trades {
            if t.trade.is_empty() {
                problems.push("a trade row has no trade code".to_owned());
            }
            if seen_trades.iter().any(|s| s.eq_ignore_ascii_case(&t.trade)) {
                problems.push(format!("trade {:?} is declared twice", t.trade));
            }
            seen_trades.push(&t.trade);
            if !is_token(&t.work_type) {
                problems.push(format!(
                    "trade {:?}: work type {:?} is not a token ([a-z0-9_])",
                    t.trade, t.work_type
                ));
            } else if self.work_type(&t.work_type).is_none() {
                problems.push(format!(
                    "trade {:?} names work type {:?}, which no work_type row declares",
                    t.trade, t.work_type
                ));
            }
        }
        if self.occupancy.default_people == 0 {
            problems.push("occupancy default tolerance is 0: no space takes nobody".to_owned());
        }
        let mut seen_cats: Vec<&str> = Vec::new();
        for (category, n) in &self.occupancy.by_category {
            if category.is_empty() {
                problems.push("an occupancy row has no category".to_owned());
            }
            if seen_cats.iter().any(|s| s.eq_ignore_ascii_case(category)) {
                problems.push(format!("occupancy category {category:?} is declared twice"));
            }
            seen_cats.push(category);
            if *n == 0 {
                problems.push(format!(
                    "occupancy category {category:?} has tolerance 0: no space takes nobody"
                ));
            }
        }
        problems
    }

    /// Parses the CSV form: `#` comment lines and blank lines ignored, the
    /// first column the row kind —
    ///
    /// ```text
    /// work_type,<token>,<flag;flag>,<display name>
    /// trade,<code>,<work_type>,<display name>
    /// occupancy,default,<people>
    /// occupancy,category,<register category>,<people>
    /// ```
    ///
    /// Flags are `;`-separated from [`WorkFlags::TOKENS`]; an empty flags
    /// cell is no flags. Refused whole with every reason, by line, and the
    /// typed document's own [`Self::validate`] reasons after them.
    ///
    /// # Errors
    /// Every reason the text is not a taxonomy.
    pub fn parse_csv(text: &str) -> Result<Self, Vec<String>> {
        let mut doc = Self {
            trades: Vec::new(),
            work_types: Vec::new(),
            occupancy: Occupancy::default(),
        };
        let mut problems = Vec::new();
        let mut default_seen = false;
        for (line, cells) in rows(text) {
            let cell = |i: usize| cells.get(i).copied().unwrap_or("");
            match cell(0) {
                "work_type" => match parse_flags(line, cell(2)) {
                    Ok(flags) => doc.work_types.push(WorkTypeRow {
                        work_type: cell(1).to_owned(),
                        flags,
                        display_name: display_or(cell(3), cell(1)),
                    }),
                    Err(reason) => problems.push(reason),
                },
                "trade" => doc.trades.push(TradeRow {
                    trade: cell(1).to_owned(),
                    work_type: cell(2).to_owned(),
                    display_name: display_or(cell(3), cell(1)),
                }),
                "occupancy" => match cell(1) {
                    "default" => match parse_people(line, cell(2)) {
                        Ok(n) => {
                            if default_seen {
                                problems.push(format!(
                                    "line {line}: the occupancy default is given twice"
                                ));
                            }
                            default_seen = true;
                            doc.occupancy.default_people = n;
                        }
                        Err(reason) => problems.push(reason),
                    },
                    "category" => match parse_people(line, cell(3)) {
                        Ok(n) => doc.occupancy.by_category.push((cell(2).to_owned(), n)),
                        Err(reason) => problems.push(reason),
                    },
                    other => problems.push(format!(
                        "line {line}: occupancy row kind {other:?} is not default or category"
                    )),
                },
                other => problems.push(format!(
                    "line {line}: row kind {other:?} is not work_type, trade or occupancy"
                )),
            }
        }
        problems.extend(doc.validate());
        if problems.is_empty() {
            Ok(doc)
        } else {
            Err(problems)
        }
    }
}

/// The display name, or the token when the cell is empty.
fn display_or(name: &str, fallback: &str) -> String {
    if name.is_empty() {
        fallback.to_owned()
    } else {
        name.to_owned()
    }
}

/// `;`-separated flag tokens; refused at the first unknown one, by name.
fn parse_flags(line: usize, cell: &str) -> Result<WorkFlags, String> {
    let mut flags = WorkFlags::default();
    for token in cell.split(';').map(str::trim).filter(|t| !t.is_empty()) {
        flags = flags.set(token).ok_or_else(|| {
            format!(
                "line {line}: flag {token:?} is not one of {}",
                WorkFlags::TOKENS.join(", ")
            )
        })?;
    }
    Ok(flags)
}

/// A tolerance cell: a whole number of people (0 is refused by `validate`).
fn parse_people(line: usize, cell: &str) -> Result<u32, String> {
    cell.parse::<u32>()
        .map_err(|_| format!("line {line}: tolerance {cell:?} is not a whole number of people"))
}

/// The data rows of a `#`-commented CSV, 1-based line numbers, cells trimmed.
/// Quotes are honoured for a cell that carries a comma in a display name.
fn rows(text: &str) -> impl Iterator<Item = (usize, Vec<&str>)> {
    text.lines().enumerate().filter_map(|(i, line)| {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            return None;
        }
        Some((i + 1, split_cells(t)))
    })
}

/// Splits one line on commas outside double quotes, trimming each cell and
/// stripping the quotes that wrapped it.
fn split_cells(line: &str) -> Vec<&str> {
    let mut cells = Vec::new();
    let mut start = 0;
    let mut quoted = false;
    for (i, c) in line.char_indices() {
        match c {
            '"' => quoted = !quoted,
            ',' if !quoted => {
                cells.push(unquote(line.get(start..i).unwrap_or("")));
                start = i + 1;
            }
            _ => {}
        }
    }
    cells.push(unquote(line.get(start..).unwrap_or("")));
    cells
}

fn unquote(cell: &str) -> &str {
    let t = cell.trim();
    t.strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .map_or(t, str::trim)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CVN73: &str = "\
# CVN-73 trade taxonomy
work_type,hot_work,ignition_source,Hot work
work_type,coating,flammable_atmosphere,Preservation / coatings
work_type,electrical,,Electrical
work_type,inspection,,Inspection & test
work_type,mechanical,,Mechanical
trade,SM-WELD,hot_work,Structural Welding
trade,SM-PRES,coating,Preservation / Blast & Coat
trade,SM-ELEC,electrical,Electrical
trade,SM-PIPE,mechanical,Pipefitting
occupancy,default,6
occupancy,category,Tanks & voids,3
occupancy,category,\"Passage, trunk\",4
";

    #[test]
    fn the_default_vocabulary_flags_hot_work_and_coating_only_and_has_no_trade_rows() {
        let d = TradeTaxonomy::default_vocabulary();
        assert!(d.trades.is_empty());
        assert_eq!(d.work_types.len(), 7);
        assert!(d.validate().is_empty(), "{:?}", d.validate());
        let flagged: Vec<(&str, Vec<&str>)> = d
            .work_types
            .iter()
            .filter(|w| !w.flags.is_empty())
            .map(|w| (w.work_type.as_str(), w.flags.names()))
            .collect();
        assert_eq!(
            flagged,
            vec![
                ("hot_work", vec!["ignition_source"]),
                ("coating", vec!["flammable_atmosphere"]),
            ]
        );
        assert_eq!(d.tolerance(Some("Tanks & voids")), DEFAULT_TOLERANCE);
        assert_eq!(d.tolerance(None), 6);
        // Every S14 token is declared.
        for token in [
            "hot_work",
            "coating",
            "electrical",
            "inspection",
            "insulation",
            "rigging",
            "mechanical",
        ] {
            assert!(d.work_type(token).is_some(), "{token}");
        }
    }

    #[test]
    fn the_field_map_wins_and_the_trade_row_is_the_fallback() {
        let t = TradeTaxonomy::parse_csv(CVN73).unwrap();
        let from_map = t.resolve(Some("coating"), "SM-WELD");
        assert_eq!(from_map.work_type, Some("coating"));
        assert_eq!(from_map.source, WorkTypeSource::FieldMap);
        assert!(from_map.flags.flammable_atmosphere && !from_map.flags.ignition_source);

        let from_trade = t.resolve(None, "SM-WELD");
        assert_eq!(from_trade.work_type, Some("hot_work"));
        assert_eq!(from_trade.source, WorkTypeSource::Taxonomy);
        assert!(from_trade.flags.ignition_source);

        // Case-insensitive on the trade code, exact first.
        assert_eq!(t.resolve(None, "sm-pres").work_type, Some("coating"));

        let neither = t.resolve(None, "SM-RIGG");
        assert_eq!(neither.work_type, None);
        assert_eq!(neither.source, WorkTypeSource::None);
        assert_eq!(neither.flags, WorkFlags::default());
        assert_eq!(WorkTypeSource::None.as_str(), "none");
        assert_eq!(WorkTypeSource::FieldMap.to_string(), "field_map");
    }

    #[test]
    fn flags_follow_the_work_type_not_the_trade() {
        let t = TradeTaxonomy::parse_csv(CVN73).unwrap();
        // An SM-WELD crew doing an inspection, per the field map: no fire.
        let r = t.resolve(Some("inspection"), "SM-WELD");
        assert_eq!(r.work_type, Some("inspection"));
        assert!(r.flags.is_empty(), "{r:?}");
        // A work type the taxonomy never declared carries no flags either —
        // and is still served as the field map's word.
        let r = t.resolve(Some("rigging"), "SM-WELD");
        assert_eq!(r.work_type, Some("rigging"));
        assert_eq!(r.source, WorkTypeSource::FieldMap);
        assert!(r.flags.is_empty());
    }

    #[test]
    fn validate_refuses_an_undeclared_work_type_a_duplicate_a_bad_token_an_unknown_flag_and_a_zero_tolerance(
    ) {
        let bad = "\
work_type,hot_work,ignition_source,Hot work
work_type,hot_work,,Again
work_type,Hot-Work,,Bad token
work_type,coating,vapour,Unknown flag
trade,SM-WELD,hot_work,Welding
trade,sm-weld,hot_work,Welding again
trade,SM-PRES,painting,Undeclared
occupancy,default,0
occupancy,category,Tanks & voids,3
occupancy,category,tanks & voids,0
occupancy,category,Passage,three
occupancy,shift,4
zone,Z1
";
        let reasons = TradeTaxonomy::parse_csv(bad).unwrap_err();
        let has = |needle: &str| {
            assert!(
                reasons.iter().any(|r| r.contains(needle)),
                "no reason mentions {needle:?}: {reasons:#?}"
            );
        };
        has("line 4: flag \"vapour\" is not one of");
        has("line 11: tolerance \"three\" is not a whole number");
        has("line 12: occupancy row kind \"shift\"");
        has("line 13: row kind \"zone\"");
        has("work type \"hot_work\" is declared twice");
        has("work type \"Hot-Work\" is not a token");
        has("trade \"sm-weld\" is declared twice");
        has("trade \"SM-PRES\" names work type \"painting\", which no work_type row declares");
        has("occupancy default tolerance is 0");
        has("occupancy category \"tanks & voids\" is declared twice");
        has("occupancy category \"tanks & voids\" has tolerance 0");
        // Everything is reported at once — the yard fixes the file once.
        assert!(reasons.len() >= 11, "{}", reasons.len());
    }

    #[test]
    fn tolerance_reads_the_category_then_the_default() {
        let t = TradeTaxonomy::parse_csv(CVN73).unwrap();
        assert_eq!(t.tolerance(Some("Tanks & voids")), 3);
        assert_eq!(t.tolerance(Some("TANKS & VOIDS")), 3);
        assert_eq!(t.tolerance(Some("Passage, trunk")), 4, "a quoted cell");
        assert_eq!(t.tolerance(Some("Machinery / electrical")), 6);
        assert_eq!(t.tolerance(None), 6);
    }

    #[test]
    fn the_csv_round_trips_through_serde_with_its_display_names() {
        let t = TradeTaxonomy::parse_csv(CVN73).unwrap();
        assert_eq!(t.trades.len(), 4);
        assert_eq!(t.work_types.len(), 5);
        assert_eq!(t.occupancy.by_category.len(), 2);
        assert_eq!(
            t.trade("SM-PRES").map(|r| r.display_name.as_str()),
            Some("Preservation / Blast & Coat")
        );
        let json = serde_json::to_string(&t).unwrap();
        let back: TradeTaxonomy = serde_json::from_str(&json).unwrap();
        assert_eq!(back, t);
        // A taxonomy with only work types deserialises with the defaults.
        let minimal: TradeTaxonomy = serde_json::from_str(
            r#"{"work_types":[{"work_type":"hot_work","display_name":"Hot work"}]}"#,
        )
        .unwrap();
        assert_eq!(minimal.occupancy.default_people, DEFAULT_TOLERANCE);
        assert!(minimal.trades.is_empty());
        assert_eq!(
            minimal.work_type("hot_work").map(|w| w.flags),
            Some(WorkFlags::default())
        );
    }
}
