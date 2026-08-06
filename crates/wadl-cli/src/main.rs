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
    /// Print the seeded demo world as JSON (no database required).
    Seed,
    /// Verify the audit ledger's hash chain from a JSON export.
    VerifyLedger {
        /// Path to a JSON array of ledger entries.
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
        Command::Seed => seed(),
        Command::VerifyLedger { input } => verify_ledger(&input),
        Command::SupportBundle {
            out,
            migrations_dir,
        } => support_bundle(&out, &migrations_dir),
    }
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

fn seed() -> Result<()> {
    let (store, world) = InMemoryStore::demo();
    let vessels = store.list_vessels(&world.yard_scope());
    let stranded = store
        .stranded_hours(&world.yard_scope(), world.cvn73)
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
