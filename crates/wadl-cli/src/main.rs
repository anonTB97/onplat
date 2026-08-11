//! `wadl` — the operator CLI.
//!
//! Four commands, each one an operator will reach for on an air-gapped node:
//! `migrate` applies the forward-only schema, `seed` prints the demo world,
//! `verify-ledger` re-hashes the audit chain and reports the first break, and
//! `support-bundle` collects what you would otherwise never get off a
//! production box into one redacted file.

#![forbid(unsafe_code)]
#![allow(clippy::doc_markdown)]

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

use wadl_domain::Clock;
use wadl_store::clock::SystemClock;
use wadl_store::ledger::{self, LedgerEntry};
use wadl_store::pg::PgStore;
use wadl_store::{InMemoryStore, Repositories};

#[derive(Parser)]
#[command(name = "wadl", about = "Shipyard AI Onboard / WADL operator CLI")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Apply all outstanding forward-only migrations.
    Migrate {
        /// PostgreSQL URL. Falls back to `DATABASE_URL`.
        #[arg(long)]
        database_url: Option<String>,
    },
    /// Print the seeded demo world as JSON, or apply it to a database.
    Seed {
        /// Apply the SQL seed to this PostgreSQL instead of printing JSON.
        /// Falls back to `DATABASE_URL`; without either, prints the in-memory
        /// world so the command is useful with no database at all.
        #[arg(long)]
        database_url: Option<String>,
    },
    /// Verify the audit ledger's hash chain from a JSON export.
    VerifyLedger {
        /// Path to a JSON array of ledger entries.
        #[arg(long)]
        input: PathBuf,
    },
    /// Ingest a Primavera P6 XER export and print the graded report.
    IngestXer {
        /// Path to the .xer file.
        #[arg(long)]
        input: PathBuf,
    },
    /// Write a redacted support bundle to a file.
    SupportBundle {
        /// Output path.
        #[arg(long, default_value = "support-bundle.json")]
        out: PathBuf,
        /// Migrations directory to inventory.
        #[arg(long, default_value = "migrations")]
        migrations_dir: PathBuf,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Migrate { database_url } => migrate(database_url).await,
        Command::Seed { database_url } => seed(database_url).await,
        Command::VerifyLedger { input } => verify_ledger(&input),
        Command::IngestXer { input } => ingest_xer_file(&input),
        Command::SupportBundle {
            out,
            migrations_dir,
        } => support_bundle(&out, &migrations_dir),
    }
}

/// Runs the XER ingest and prints what a planner would want from a dry run:
/// what was accepted, what was refused and why, and the schedule-quality
/// findings — starting with negative lags, which P6 is perfectly happy with and
/// the deconfliction engine exists to refuse.
fn ingest_xer_file(input: &Path) -> Result<()> {
    let text =
        std::fs::read_to_string(input).with_context(|| format!("reading {}", input.display()))?;
    let label = input.file_name().map_or_else(
        || input.display().to_string(),
        |n| n.to_string_lossy().into_owned(),
    );
    let report = wadl_ingest::xer::ingest_xer(&text, &label);

    println!(
        "project {} — {} activities ({} milestones), {} relationships, {} rejected",
        report.project.as_deref().unwrap_or("<unnamed>"),
        report.activities.len(),
        report.activities.iter().filter(|a| a.is_milestone).count(),
        report.relationships.len(),
        report.rejected.len(),
    );
    let budget: i64 = report.activities.iter().map(|a| a.budget_hours.get()).sum();
    let earned: i64 = report.activities.iter().map(|a| a.earned_hours.get()).sum();
    println!("hours: {budget} MH budgeted, {earned} MH earned");

    let unmapped: Vec<&str> = report
        .activities
        .iter()
        .filter(|a| a.work_order_code.is_none() && !a.is_milestone)
        .map(|a| a.code.as_str())
        .collect();
    if !unmapped.is_empty() {
        println!("unmapped to any work item: {}", unmapped.join(", "));
    }
    let unlocated: Vec<&str> = report
        .activities
        .iter()
        .filter(|a| a.compartment_no.is_none() && !a.is_milestone)
        .map(|a| a.code.as_str())
        .collect();
    if !unlocated.is_empty() {
        println!(
            "no located compartment (LOW grade): {}",
            unlocated.join(", ")
        );
    }
    for rel in report.relationships.iter().filter(|r| r.lag_hours < 0) {
        println!(
            "FINDING · negative lag: {} → {} ({} h) — the successor may start inside \
             the predecessor. P6 accepts this; the hazard engine may not.",
            rel.pred, rel.succ, rel.lag_hours
        );
    }
    for reject in &report.rejected {
        println!("REJECTED line {}: {}", reject.row, reject.reason);
    }
    Ok(())
}

async fn migrate(database_url: Option<String>) -> Result<()> {
    let url = database_url
        .or_else(|| std::env::var("DATABASE_URL").ok())
        .context("provide --database-url or set DATABASE_URL")?;
    let store = PgStore::connect(&url).await.context("connecting")?;
    store.migrate().await.context("applying migrations")?;
    println!("migrations applied");
    Ok(())
}

async fn seed(database_url: Option<String>) -> Result<()> {
    // Seeding a database runs as the CONNECTING role (the owner), deliberately
    // outside the tenant-scoped path: a seed able to write across tenants would
    // defeat the row-level security it exists to demonstrate.
    if let Some(url) = database_url.or_else(|| std::env::var("DATABASE_URL").ok()) {
        let store = PgStore::connect(&url).await.context("connecting")?;
        store.migrate().await.context("applying migrations")?;
        store.seed_demo().await.context("applying the demo seed")?;
        println!("demo world seeded (illustrative / notional data)");
        return Ok(());
    }

    let (store, world) = InMemoryStore::demo();
    let vessels = store.list_vessels(&world.yard_scope()).await;
    let stranded = store
        .stranded_hours(&world.yard_scope(), world.cvn73)
        .await
        .context("computing stranded hours")?;
    let summary = serde_json::json!({
        "note": "illustrative / notional data — decision support only",
        "yard_org": world.yard_org.to_string(),
        "assigned_vessels": vessels,
        "cvn73_stranded_hours": stranded,
    });
    println!("{}", serde_json::to_string_pretty(&summary)?);
    Ok(())
}

fn verify_ledger(input: &Path) -> Result<()> {
    let text =
        std::fs::read_to_string(input).with_context(|| format!("reading {}", input.display()))?;
    let entries: Vec<LedgerEntry> = serde_json::from_str(&text).context("parsing ledger JSON")?;
    match ledger::verify_chain(&entries) {
        Ok(()) => {
            println!("ledger intact — {} entries verify", entries.len());
            Ok(())
        }
        Err(brk) => {
            anyhow::bail!(
                "ledger BROKEN at index {} (seq {}): {:?}",
                brk.index,
                brk.seq,
                brk.reason
            )
        }
    }
}

fn support_bundle(out: &Path, migrations_dir: &Path) -> Result<()> {
    let mut migrations: Vec<String> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(migrations_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("sql"))
            {
                migrations.push(entry.file_name().to_string_lossy().into_owned());
            }
        }
    }
    migrations.sort();
    let schema_version = migrations
        .last()
        .cloned()
        .unwrap_or_else(|| "none".to_owned());
    let bundle = serde_json::json!({
        "generated_by": "wadl support-bundle",
        "generated_at_epoch_ms": SystemClock.now().epoch_millis(),
        "schema_version": schema_version,
        "migration_count": migrations.len(),
        "migrations": migrations,
        "engine": "wadl-engine (milestone-1 seam)",
        "redaction": "no secrets, no PII, no tenant identifiers included",
    });
    std::fs::write(out, serde_json::to_string_pretty(&bundle)?)
        .with_context(|| format!("writing {}", out.display()))?;
    println!("wrote {}", out.display());
    Ok(())
}
