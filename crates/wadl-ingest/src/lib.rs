//! Batch ingest with provenance on every row.
//!
//! The platform's rule is absolute: **nothing enters without a source.** This
//! crate ingests P6-style work-order exports and stamps each accepted row with
//! where it came from; a row with no `source_ref` is rejected, not guessed at.
//! The P6 field crosswalk (`handoff/03-p6-field-crosswalk.csv`) grades each
//! field's reliability — `compartment` is the dominant risk and is graded
//! [`Reliability::Low`] unless a planner confirms the mapping — so a
//! low-confidence value is never silently trusted downstream.

#![forbid(unsafe_code)]
#![allow(clippy::doc_markdown)]
#![cfg_attr(
    test,
    allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing
    )
)]

pub mod xer;

use std::io::Read;

use wadl_domain::compartment::CompartmentNo;
use wadl_domain::units::ManHours;

/// How much a mapped field can be trusted, from the P6 crosswalk.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reliability {
    /// Always populated and stable (activity id, name).
    High,
    /// Usually present, sometimes late (man-hours, trade).
    Medium,
    /// The dominant risk — often parsed or absent (compartment).
    Low,
    /// Present only for demonstration; never a basis for authorization.
    Theatre,
}

/// One work order as ingested, carrying its provenance.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct IngestedWorkOrder {
    /// WI / WO code.
    pub code: String,
    /// Title.
    pub title: String,
    /// Trade / shop.
    pub trade: String,
    /// System.
    pub system: String,
    /// Primary compartment (reliability [`Reliability::Low`] until confirmed).
    pub compartment_no: CompartmentNo,
    /// Reliability grade of the compartment mapping for this run.
    pub compartment_reliability: Reliability,
    /// Budgeted man-hours.
    pub budget_hours: ManHours,
    /// The document this row came from.
    pub source_ref: String,
    /// Never true at ingest — a planner confirms provenance separately.
    pub source_verified: bool,
}

/// A rejected input row and why.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Rejection {
    /// 1-based row number in the source.
    pub row: usize,
    /// Why the row was rejected.
    pub reason: String,
}

/// The outcome of an ingest run.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct IngestReport {
    /// The accepted, provenance-stamped rows.
    pub accepted: Vec<IngestedWorkOrder>,
    /// The rejected rows.
    pub rejected: Vec<Rejection>,
}

impl IngestReport {
    /// Rows accepted.
    #[must_use]
    pub fn accepted_count(&self) -> usize {
        self.accepted.len()
    }

    /// Rows rejected.
    #[must_use]
    pub fn rejected_count(&self) -> usize {
        self.rejected.len()
    }
}

/// Errors that abort an entire ingest run (as opposed to rejecting one row).
#[derive(Debug, thiserror::Error)]
pub enum IngestError {
    /// The CSV could not be read or parsed at all.
    #[error("csv error: {0}")]
    Csv(String),
}

#[derive(Debug, serde::Deserialize)]
struct RawRow {
    code: String,
    title: String,
    #[serde(default)]
    trade: String,
    #[serde(default)]
    system: String,
    #[serde(default)]
    compartment: String,
    #[serde(default)]
    budget_hours: Option<i64>,
    #[serde(default)]
    source_ref: String,
}

/// Ingests P6-style work orders from CSV.
///
/// Expected header: `code,title,trade,system,compartment,budget_hours,source_ref`.
/// A row with an empty `code` or `source_ref` is rejected — the platform admits
/// nothing anonymous. Accepted rows are graded, not trusted: `compartment` is
/// [`Reliability::Low`] pending planner confirmation.
///
/// # Errors
/// [`IngestError::Csv`] if the stream is not readable CSV.
pub fn ingest_work_orders<R: Read>(reader: R) -> Result<IngestReport, IngestError> {
    let mut csv_reader = csv::ReaderBuilder::new()
        .trim(csv::Trim::All)
        .from_reader(reader);
    let mut accepted = Vec::new();
    let mut rejected = Vec::new();

    for (offset, record) in csv_reader.deserialize::<RawRow>().enumerate() {
        let row = offset + 1;
        let raw = match record {
            Ok(raw) => raw,
            Err(err) => {
                rejected.push(Rejection {
                    row,
                    reason: format!("unparseable row: {err}"),
                });
                continue;
            }
        };
        if raw.code.trim().is_empty() {
            rejected.push(Rejection {
                row,
                reason: "missing work-order code".to_owned(),
            });
            continue;
        }
        if raw.source_ref.trim().is_empty() {
            rejected.push(Rejection {
                row,
                reason: "no source_ref — provenance required".to_owned(),
            });
            continue;
        }
        accepted.push(IngestedWorkOrder {
            code: raw.code,
            title: raw.title,
            trade: raw.trade,
            system: raw.system,
            compartment_no: CompartmentNo::new(raw.compartment),
            compartment_reliability: Reliability::Low,
            budget_hours: ManHours::new(raw.budget_hours.unwrap_or(0)),
            source_ref: raw.source_ref,
            source_verified: false,
        });
    }

    Ok(IngestReport { accepted, rejected })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
code,title,trade,system,compartment,budget_hours,source_ref
WI-3318,Reserve feed water tank preservation,Preservation,506 Tanks,4-110-2-W,680,AWR 73-26-3318
WI-0000,No provenance row,Mechanical,500,4-110-2-W,100,
,Missing code,Welding,130,1-136-0-Q,50,AWR 73-26-9999
";

    #[test]
    fn stamps_provenance_and_rejects_anonymous_rows() {
        let report = ingest_work_orders(SAMPLE.as_bytes()).unwrap();
        assert_eq!(report.accepted_count(), 1);
        assert_eq!(report.rejected_count(), 2);
        let wo = &report.accepted[0];
        assert_eq!(wo.code, "WI-3318");
        assert_eq!(wo.budget_hours, ManHours::new(680));
        assert_eq!(wo.compartment_reliability, Reliability::Low);
        assert!(!wo.source_verified);
    }
}
