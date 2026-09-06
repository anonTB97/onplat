//! The P6 field map: the yard's export conventions as data.
//!
//! No two yards name the field that carries the compartment the same way —
//! a UDF called `compartment`, one called `COMPT`, an activity code type
//! `LOC`, or nothing but the task name. Before this document existed the
//! names were literals in the parser, so the first real export from a yard
//! whose UDF is not literally `compartment` imported entirely unlocated
//! with no remedy short of a code change. Now the convention is a per-hull
//! document with a door and a ledger line, and the parser reads through it.
//!
//! Two rules keep the map honest:
//!
//! * **The default is today's behaviour.** A hull with no map on file keeps
//!   importing exactly as before, so nothing regresses on the reference
//!   export ([`FieldMap::default`] is pinned by test).
//! * **Refusals refuse the map whole; findings never refuse.** A map that
//!   names a blank field or a resource outside the trade slot is malformed
//!   and is refused at the door with every reason; a map that names a field
//!   the file does not carry is a *finding* — the file may be the wrong one,
//!   the map may be for next week's export — and the import proceeds with
//!   the rows unlocated, graded as such.

use std::collections::BTreeMap;

/// Where one mapped slot reads from.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum FieldSource {
    /// A user-defined field: `UDFTYPE.udf_type_name` or `udf_type_label`,
    /// trimmed and matched case-insensitively (a label-only match is a
    /// finding), through `UDFVALUE.udf_text`.
    Udf {
        /// The UDF's name or label.
        name: String,
    },
    /// An activity code: `ACTVTYPE.actv_code_type` → `ACTVCODE.short_name`
    /// via `TASKACTV`.
    ActivityCode {
        /// The code type's name.
        name: String,
    },
    /// The first labor resource assigned (`TASKRSRC` → `RSRC.rsrc_short_name`).
    /// Valid for the trade slot only.
    Resource,
    /// The file does not carry this; the slot is empty on every row.
    #[serde(rename = "none")]
    NotCarried,
}

impl FieldSource {
    /// The named field, when the source names one.
    #[must_use]
    pub fn name(&self) -> Option<&str> {
        match self {
            Self::Udf { name } | Self::ActivityCode { name } => Some(name.as_str()),
            Self::Resource | Self::NotCarried => None,
        }
    }

    /// The source in yard words, for findings and the card:
    /// `UDF "COMPT"`, `activity code "LOC"`, `resource`, `not carried`.
    #[must_use]
    pub fn describe(&self) -> String {
        match self {
            Self::Udf { name } => format!("UDF {name:?}"),
            Self::ActivityCode { name } => format!("activity code {name:?}"),
            Self::Resource => "resource".to_owned(),
            Self::NotCarried => "not carried".to_owned(),
        }
    }
}

/// Which XER field carries each of the four things the register needs, which
/// projects to serve, and whether to read placards out of task names when the
/// compartment field is silent. One per hull.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct FieldMap {
    /// The compartment (deck-frame-side-usage placard).
    pub compartment: FieldSource,
    /// The work item / work order number.
    pub work_item: FieldSource,
    /// The work type the rule table binds to (S14).
    pub work_type: FieldSource,
    /// The trade doing the work.
    pub trade: FieldSource,
    /// `proj_short_name`s to serve; empty serves every project in the file.
    pub projects: Vec<String>,
    /// Read a placard out of the task name when the compartment field is
    /// silent (graded Medium — the parser guessing, never the schedule saying).
    pub placards_from_names: bool,
}

impl Default for FieldMap {
    /// Today's convention, exactly: UDF `compartment`, UDF `wi_number`, no
    /// work type, trade from the resource, every project, placards read
    /// from names.
    fn default() -> Self {
        Self {
            compartment: FieldSource::Udf {
                name: "compartment".to_owned(),
            },
            work_item: FieldSource::Udf {
                name: "wi_number".to_owned(),
            },
            work_type: FieldSource::NotCarried,
            trade: FieldSource::Resource,
            projects: Vec::new(),
            placards_from_names: true,
        }
    }
}

/// The four slots, in the order the card shows them.
const SLOTS: [&str; 4] = ["compartment", "work_item", "work_type", "trade"];

impl FieldMap {
    /// The slots with their sources, in card order.
    fn slots(&self) -> [(&'static str, &FieldSource); 4] {
        [
            ("compartment", &self.compartment),
            ("work_item", &self.work_item),
            ("work_type", &self.work_type),
            ("trade", &self.trade),
        ]
    }

    /// Whether the map is well-formed. Every reason at once, so the door can
    /// refuse with all of them: `resource` outside the trade slot, a blank
    /// name on a `udf` or `activity_code` source, a duplicate project.
    ///
    /// # Errors
    /// The reasons, in slot order, when any.
    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut problems = Vec::new();
        for (slot, source) in self.slots() {
            match source {
                FieldSource::Resource if slot != "trade" => problems.push(format!(
                    "{slot}: source \"resource\" is valid for the trade only"
                )),
                FieldSource::Udf { name } | FieldSource::ActivityCode { name }
                    if name.trim().is_empty() =>
                {
                    problems.push(format!(
                        "{slot}: source \"{}\" names no field",
                        if matches!(source, FieldSource::Udf { .. }) {
                            "udf"
                        } else {
                            "activity_code"
                        }
                    ));
                }
                _ => {}
            }
        }
        let mut seen: BTreeMap<String, usize> = BTreeMap::new();
        for project in &self.projects {
            let key = project.trim().to_owned();
            if key.is_empty() {
                problems.push("projects: a blank project name".to_owned());
                continue;
            }
            let count = seen.entry(key.clone()).or_insert(0);
            *count += 1;
            if *count == 2 {
                problems.push(format!("projects: {key:?} is listed twice"));
            }
        }
        if problems.is_empty() {
            Ok(())
        } else {
            Err(problems)
        }
    }

    /// What a map means against the fields a file actually carries. Never
    /// refuses: a compartment source of `none` with placards off (*every row
    /// will be unlocated*); a named field the survey does not list; a served
    /// project the file does not contain. `seen` is `None` when no file has
    /// been surveyed yet — only the self-contained finding is possible then.
    #[must_use]
    pub fn findings_against(&self, seen: Option<&FieldsSeen>) -> Vec<String> {
        let mut findings = Vec::new();
        if self.compartment == FieldSource::NotCarried && !self.placards_from_names {
            findings.push(
                "compartment: no field and placards not read from names — every row will be unlocated"
                    .to_owned(),
            );
        }
        let Some(seen) = seen else {
            return findings;
        };
        for (slot, source) in self.slots() {
            match source {
                FieldSource::Udf { name } if seen.udf(name).is_none() => findings.push(format!(
                    "{slot}: this export carries no UDF named {name:?} — {}",
                    seen.udf_names_phrase()
                )),
                FieldSource::ActivityCode { name } if seen.activity_code_type(name).is_none() => {
                    findings.push(format!(
                        "{slot}: this export carries no activity code type named {name:?} — {}",
                        seen.activity_code_names_phrase()
                    ));
                }
                _ => {}
            }
        }
        for project in &self.projects {
            if !seen
                .projects
                .iter()
                .any(|p| p.short_name.eq_ignore_ascii_case(project.trim()))
            {
                findings.push(format!(
                    "projects: this export carries no project {project:?} — it carries {}",
                    seen.project_names_phrase()
                ));
            }
        }
        findings
    }

    /// The map in one line of yard words, for the banner and the ledger.
    #[must_use]
    pub fn summary(&self) -> String {
        let projects = if self.projects.is_empty() {
            "all".to_owned()
        } else {
            self.projects.join(", ")
        };
        format!(
            "compartment ← {} · work item ← {} · work type ← {} · trade ← {} · projects: {projects} · placards {} from task names",
            self.compartment.describe(),
            self.work_item.describe(),
            self.work_type.describe(),
            self.trade.describe(),
            if self.placards_from_names {
                "read"
            } else {
                "not read"
            },
        )
    }

    /// The slot names, in card order.
    #[must_use]
    pub const fn slot_names() -> [&'static str; 4] {
        SLOTS
    }
}

/// One project in an export.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ProjectSeen {
    /// `PROJECT.proj_id`, the internal key `TASK.proj_id` carries.
    pub id: String,
    /// `PROJECT.proj_short_name`, what a scheduler calls it.
    pub short_name: String,
    /// `TASK` rows under it.
    pub tasks: usize,
}

/// One user-defined field type in an export.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct UdfSeen {
    /// `UDFTYPE.udf_type_name`.
    pub name: String,
    /// `UDFTYPE.udf_type_label`, when the export carries one.
    pub label: Option<String>,
    /// `UDFTYPE.table_name`, when the export carries one (`TASK`, `PROJWBS`…).
    pub table: Option<String>,
    /// `UDFVALUE` rows of this type.
    pub values: usize,
}

/// One activity code type in an export.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ActivityCodeTypeSeen {
    /// `ACTVTYPE.actv_code_type`.
    pub name: String,
    /// `TASKACTV` rows assigning a code of this type.
    pub values: usize,
}

/// The survey of an export: which fields it carries and how full they are —
/// no schedule content, so it is the one thing a yard can mail back about
/// its own file. The card's selects are built from it.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct FieldsSeen {
    /// Every `PROJECT` row, with its task count.
    pub projects: Vec<ProjectSeen>,
    /// Every `UDFTYPE` row, with its value count.
    pub udfs: Vec<UdfSeen>,
    /// Every `ACTVTYPE` row, with its assignment count.
    pub activity_code_types: Vec<ActivityCodeTypeSeen>,
    /// `TASKRSRC` rows by their resource's `rsrc_type` (`RT_Labor`, `RT_Mat`,
    /// `RT_Equip`; the three known kinds are always present, at zero when
    /// absent).
    pub resource_types: BTreeMap<String, usize>,
    /// Whether `RSRC` carries `rsrc_type` at all. When it does not, every
    /// assignment is counted as labor and the report says so.
    pub has_rsrc_type: bool,
    /// `TASK` rows by `task_type` (the five known kinds always present).
    pub task_types: BTreeMap<String, usize>,
    /// Row counts per section, by table name.
    pub sections: BTreeMap<String, usize>,
}

impl FieldsSeen {
    /// The UDF whose name or label matches `name` (trimmed, case-insensitive),
    /// name matches first; and whether it matched by label only.
    #[must_use]
    pub fn udf(&self, name: &str) -> Option<(&UdfSeen, bool)> {
        let wanted = name.trim();
        self.udfs
            .iter()
            .find(|u| u.name.trim().eq_ignore_ascii_case(wanted))
            .map(|u| (u, false))
            .or_else(|| {
                self.udfs
                    .iter()
                    .find(|u| {
                        u.label
                            .as_deref()
                            .is_some_and(|l| l.trim().eq_ignore_ascii_case(wanted))
                    })
                    .map(|u| (u, true))
            })
    }

    /// The activity code type named `name` (trimmed, case-insensitive).
    #[must_use]
    pub fn activity_code_type(&self, name: &str) -> Option<&ActivityCodeTypeSeen> {
        let wanted = name.trim();
        self.activity_code_types
            .iter()
            .find(|t| t.name.trim().eq_ignore_ascii_case(wanted))
    }

    fn udf_names_phrase(&self) -> String {
        if self.udfs.is_empty() {
            return "it carries no UDFs".to_owned();
        }
        format!(
            "it carries {}",
            self.udfs
                .iter()
                .map(|u| format!("{:?}", u.name))
                .collect::<Vec<_>>()
                .join(", ")
        )
    }

    fn activity_code_names_phrase(&self) -> String {
        if self.activity_code_types.is_empty() {
            return "it carries no activity codes".to_owned();
        }
        format!(
            "it carries {}",
            self.activity_code_types
                .iter()
                .map(|t| format!("{:?}", t.name))
                .collect::<Vec<_>>()
                .join(", ")
        )
    }

    fn project_names_phrase(&self) -> String {
        self.projects
            .iter()
            .map(|p| format!("{:?}", p.short_name))
            .collect::<Vec<_>>()
            .join(", ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_map_is_todays_convention() {
        let map = FieldMap::default();
        assert_eq!(
            map.compartment,
            FieldSource::Udf {
                name: "compartment".to_owned()
            }
        );
        assert_eq!(
            map.work_item,
            FieldSource::Udf {
                name: "wi_number".to_owned()
            }
        );
        assert_eq!(map.work_type, FieldSource::NotCarried);
        assert_eq!(map.trade, FieldSource::Resource);
        assert!(map.projects.is_empty());
        assert!(map.placards_from_names);
        assert!(map.validate().is_ok());
        assert!(map.findings_against(None).is_empty());

        // The wire shape the packet fixes, both directions; an empty object
        // is the default too, so a hull's file may name only what differs.
        let json = serde_json::to_value(&map).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "compartment": { "source": "udf", "name": "compartment" },
                "work_item": { "source": "udf", "name": "wi_number" },
                "work_type": { "source": "none" },
                "trade": { "source": "resource" },
                "projects": [],
                "placards_from_names": true
            })
        );
        let back: FieldMap = serde_json::from_value(json).unwrap();
        assert_eq!(back, map);
        let sparse: FieldMap = serde_json::from_str("{}").unwrap();
        assert_eq!(sparse, map);
        let partial: FieldMap =
            serde_json::from_str(r#"{"compartment":{"source":"activity_code","name":"LOC"}}"#)
                .unwrap();
        assert_eq!(
            partial.compartment,
            FieldSource::ActivityCode {
                name: "LOC".to_owned()
            }
        );
        assert_eq!(partial.trade, FieldSource::Resource);
    }

    #[test]
    fn validate_refuses_resource_outside_trade_a_blank_name_and_a_duplicate_project() {
        let map = FieldMap {
            compartment: FieldSource::Resource,
            work_item: FieldSource::Udf {
                name: "  ".to_owned(),
            },
            work_type: FieldSource::ActivityCode {
                name: String::new(),
            },
            trade: FieldSource::Resource,
            projects: vec![
                "CVN73-PIA26".to_owned(),
                "CVN73-DSRA27".to_owned(),
                "CVN73-PIA26".to_owned(),
            ],
            placards_from_names: true,
        };
        let problems = map.validate().unwrap_err();
        assert_eq!(problems.len(), 4, "{problems:?}");
        assert!(problems[0].starts_with("compartment: source \"resource\""));
        assert!(problems[1].starts_with("work_item: source \"udf\" names no field"));
        assert!(problems[2].starts_with("work_type: source \"activity_code\" names no field"));
        assert!(problems[3].contains("\"CVN73-PIA26\" is listed twice"));
    }

    #[test]
    fn findings_warn_but_never_refuse() {
        let seen = FieldsSeen {
            projects: vec![ProjectSeen {
                id: "4410".to_owned(),
                short_name: "CVN73-PIA26".to_owned(),
                tasks: 9,
            }],
            udfs: vec![
                UdfSeen {
                    name: "COMPT".to_owned(),
                    label: Some("Location placard".to_owned()),
                    table: Some("TASK".to_owned()),
                    values: 8,
                },
                UdfSeen {
                    name: "WI".to_owned(),
                    label: Some("Work Item".to_owned()),
                    table: Some("TASK".to_owned()),
                    values: 8,
                },
            ],
            activity_code_types: vec![ActivityCodeTypeSeen {
                name: "LOC".to_owned(),
                values: 1,
            }],
            ..FieldsSeen::default()
        };
        // Today's map against a yard-shaped file: neither UDF is there by
        // name or label.
        let findings = FieldMap::default().findings_against(Some(&seen));
        assert_eq!(findings.len(), 2, "{findings:?}");
        assert!(findings[0]
            .starts_with("compartment: this export carries no UDF named \"compartment\""));
        assert!(findings[0].contains("\"COMPT\""));
        assert!(findings[1].starts_with("work_item:"));

        // Matching by label, case-insensitively, is a match (the parser
        // reports the label-only case as its own finding).
        assert_eq!(
            seen.udf(" work item ")
                .map(|(u, by_label)| (u.name.as_str(), by_label)),
            Some(("WI", true))
        );
        assert_eq!(seen.udf("compt").map(|(_, by_label)| by_label), Some(false));
        let by_label = FieldMap {
            work_item: FieldSource::Udf {
                name: "Work Item".to_owned(),
            },
            compartment: FieldSource::Udf {
                name: "compt".to_owned(),
            },
            ..FieldMap::default()
        };
        assert!(by_label.findings_against(Some(&seen)).is_empty());
        assert!(seen.activity_code_type("loc").is_some());

        let silent = FieldMap {
            compartment: FieldSource::NotCarried,
            placards_from_names: false,
            projects: vec!["CVN73-DSRA27".to_owned()],
            ..FieldMap::default()
        };
        assert!(silent.validate().is_ok(), "findings are not refusals");
        let findings = silent.findings_against(Some(&seen));
        assert!(
            findings[0].contains("every row will be unlocated"),
            "{findings:?}"
        );
        assert!(
            findings
                .iter()
                .any(|f| f.contains("no project \"CVN73-DSRA27\"")),
            "{findings:?}"
        );
        assert!(FieldMap::default()
            .summary()
            .starts_with("compartment ← UDF \"compartment\""));
    }
}
