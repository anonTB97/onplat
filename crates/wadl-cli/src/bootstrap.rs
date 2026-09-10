//! `wadl bootstrap-hull` — the hull-row statement applied from the DBA's
//! session, so data-load day has no hand SQL.
//!
//! The statement (`reference/cvn73/CVN73-hull.json` is the template) names
//! the organisation, class, hull and availability with their ids; the store
//! applies it as the owner, idempotently, in one transaction, and ledgers
//! `HULL_BOOTSTRAPPED` on the hull it created. Exit 0 when applied or already
//! present; 2 when refused (the statement does not validate, or it clashes
//! with a row already there under a different id), with the reasons listed
//! and nothing written.

use std::path::Path;
use std::process::ExitCode;

use anyhow::{Context, Result};

use wadl_domain::Clock;
use wadl_store::clock::SystemClock;
use wadl_store::model::{BootstrapOutcome, HullStatement};
use wadl_store::pg::PgStore;
use wadl_store::StoreError;

use crate::refused;

/// Reads, validates and applies the statement at `path`.
pub(crate) async fn run(
    path: &Path,
    dry_run: bool,
    database_url: Option<String>,
) -> Result<ExitCode> {
    let text =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    let statement: HullStatement = match serde_json::from_str(&text) {
        Ok(s) => s,
        Err(e) => {
            eprintln!(
                "refused: {} does not read as a hull-row statement — {e}",
                path.display()
            );
            return Ok(refused());
        }
    };
    let problems = statement.validate();
    if !problems.is_empty() {
        eprintln!(
            "refused: {} — {} problem{} with the statement, nothing written:",
            path.display(),
            problems.len(),
            if problems.len() == 1 { "" } else { "s" }
        );
        for p in &problems {
            eprintln!("  - {p}");
        }
        return Ok(refused());
    }
    let Some(url) = database_url.or_else(|| std::env::var("DATABASE_URL").ok()) else {
        if dry_run {
            // The yard checks its statement without a host: the plan as it
            // would apply to an empty database.
            print_statement(&statement);
            println!(
                "no database: the statement validates; whether the rows exist was not checked"
            );
            return Ok(ExitCode::SUCCESS);
        }
        anyhow::bail!(
            "provide --database-url or set DATABASE_URL (or --dry-run to validate the statement without a database)"
        );
    };
    let store = PgStore::connect(&url).await.context("connecting")?;
    let source_file = path.file_name().map_or_else(
        || path.display().to_string(),
        |n| n.to_string_lossy().into_owned(),
    );
    match store
        .bootstrap_hull(
            &statement,
            &source_file,
            dry_run,
            SystemClock.now().epoch_millis(),
        )
        .await
    {
        Ok(outcome) => {
            print_outcome(&statement, &outcome);
            Ok(ExitCode::SUCCESS)
        }
        Err(StoreError::Conflict(reason)) => {
            eprintln!("refused: {reason} — nothing written");
            Ok(refused())
        }
        Err(e) => Err(e).context("applying the hull-row statement"),
    }
}

/// The rows as the statement names them, one line each: its four, then the
/// tenant's baseline reference data.
fn describe(s: &HullStatement) -> [String; 6] {
    let rules = wadl_engine::RuleSet::seed_usn_hot_work();
    [
        format!("{} ({})", s.organization.name, s.organization.kind),
        format!("{} · {}", s.class.code, s.class.name),
        format!(
            "{} · {}",
            s.vessel.hull_no,
            s.vessel.name.as_deref().unwrap_or("(unnamed)")
        ),
        format!(
            "{} · {} → {}{}",
            s.availability.code,
            s.availability.start_on,
            s.availability.end_on,
            s.availability
                .location
                .as_deref()
                .map(|l| format!(" · {l}"))
                .unwrap_or_default()
        ),
        format!(
            "baseline coupling types · {}",
            wadl_store::pg_bootstrap::BASELINE_COUPLING_TYPES
                .iter()
                .map(|(code, ..)| *code)
                .collect::<Vec<_>>()
                .join(", ")
        ),
        format!(
            "baseline rule set · USN hot work, {} rules",
            rules.entries().len()
        ),
    ]
}

/// The plan without a database: every row would be created.
fn print_statement(s: &HullStatement) {
    for (name, what) in [
        "organization",
        "class",
        "vessel",
        "availability",
        "coupling_types",
        "rules",
    ]
    .into_iter()
    .zip(describe(s))
    {
        println!("{name:<14} would create   {what}");
    }
}

/// The outcome table and the ledger line.
fn print_outcome(s: &HullStatement, outcome: &BootstrapOutcome) {
    for ((name, row), what) in outcome.rows().into_iter().zip(describe(s)) {
        println!("{name:<14} {:<13}  {what}", row.as_str());
    }
    if outcome.dry_run {
        println!("dry run — nothing written");
    } else if let Some(seq) = outcome.ledger_seq {
        println!(
            "ledger seq {seq} {} on {}",
            wadl_store::pg_bootstrap::HULL_BOOTSTRAPPED,
            s.vessel.hull_no
        );
    } else {
        println!("hull already present — nothing written, no ledger row");
    }
}
