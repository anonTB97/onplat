//! `wadl` — the operator CLI.
//!
//! Commands an operator will reach for on an air-gapped node: `migrate`
//! applies the forward-only schema, `seed` prints or applies the demo world,
//! `verify-ledger` re-hashes the audit chain and reports the first break,
//! `ingest-xer` reads a P6 export (`--survey` for the mail-back that carries
//! no schedule content), `support-bundle` collects what you would otherwise
//! never get off a production box into one redacted file, and `version`
//! prints the release stamp this tree was built with.

#![forbid(unsafe_code)]
#![allow(clippy::doc_markdown)]

mod bootstrap;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

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
        /// Path to the .xer file (UTF-8 or Windows-1252; decoded here).
        #[arg(long)]
        input: PathBuf,
        /// Print the survey only — which fields, projects, resource and task
        /// types the file carries, its encoding, and the quarantine classes
        /// by line — and no task code or name. The mail-back a yard can send
        /// about its own export.
        #[arg(long)]
        survey: bool,
        /// A P6 field map (JSON, the door's shape) to read the file through;
        /// the default convention without it.
        #[arg(long)]
        field_map: Option<PathBuf>,
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
    /// Print this build's release stamp: commit, commit instant, migration set.
    Version {
        /// Print the stamp as JSON (for scripts: `.git`, `.built_at`, `.schema`).
        #[arg(long)]
        json: bool,
    },
    /// Apply a hull-row statement (organisation, class, hull, availability)
    /// as the owner, idempotently, ledgered on the hull it creates.
    BootstrapHull {
        /// The statement JSON (template: reference/cvn73/CVN73-hull.json).
        #[arg(long)]
        statement: PathBuf,
        /// Validate and print what would be created; write nothing. Works
        /// without a database (existence is then not checked).
        #[arg(long)]
        dry_run: bool,
        /// PostgreSQL URL. Falls back to `DATABASE_URL`.
        #[arg(long)]
        database_url: Option<String>,
    },
}

/// The exit code for a refusal: the input was read and rejected for a reason
/// that was printed, and nothing was written. Distinct from 1 (a failure).
const REFUSED_CODE: u8 = 2;

/// [`REFUSED_CODE`] as the process exit code (`ExitCode::from` is not const).
fn refused() -> ExitCode {
    ExitCode::from(REFUSED_CODE)
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(code) => code,
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<ExitCode> {
    let done = |r: Result<()>| r.map(|()| ExitCode::SUCCESS);
    match Cli::parse().command {
        Command::Migrate { database_url } => done(migrate(database_url).await),
        Command::Seed { database_url } => done(seed(database_url).await),
        Command::VerifyLedger { input } => done(verify_ledger(&input)),
        Command::IngestXer {
            input,
            survey,
            field_map,
        } => done(ingest_xer_file(&input, survey, field_map.as_deref())),
        Command::SupportBundle {
            out,
            migrations_dir,
        } => done(support_bundle(&out, &migrations_dir)),
        Command::Version { json } => done(version(json)),
        Command::BootstrapHull {
            statement,
            dry_run,
            database_url,
        } => bootstrap::run(&statement, dry_run, database_url).await,
    }
}

/// The release stamp, the same one `serve` prints and `/health` serves: the
/// CLI is built from the same tree.
fn version(json: bool) -> Result<()> {
    let stamp = wadl_api::version::current();
    if json {
        println!("{}", serde_json::to_string_pretty(&stamp)?);
    } else {
        println!(
            "wadl {} · document schema {}",
            stamp.banner(),
            stamp.document_schema
        );
    }
    Ok(())
}

/// The field map a `--field-map` file names, or the default convention.
fn field_map_from(path: Option<&Path>) -> Result<wadl_ingest::field_map::FieldMap> {
    let Some(path) = path else {
        return Ok(wadl_ingest::field_map::FieldMap::default());
    };
    let text =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    let map: wadl_ingest::field_map::FieldMap =
        serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))?;
    if let Err(problems) = map.validate() {
        anyhow::bail!("{} refused whole: {}", path.display(), problems.join("; "));
    }
    Ok(map)
}

/// Runs the XER ingest and prints what a planner would want from a dry run:
/// what was accepted, what was set aside and why, what was excluded, and the
/// schedule-quality findings — starting with negative lags, which P6 is
/// perfectly happy with and the deconfliction engine exists to refuse. With
/// `--survey`, prints the survey and nothing of the schedule's content.
fn ingest_xer_file(input: &Path, survey: bool, field_map: Option<&Path>) -> Result<()> {
    let bytes = std::fs::read(input).with_context(|| format!("reading {}", input.display()))?;
    let (text, encoding) = wadl_ingest::encoding::decode_xer(&bytes);
    let label = input.file_name().map_or_else(
        || input.display().to_string(),
        |n| n.to_string_lossy().into_owned(),
    );
    let map = field_map_from(field_map)?;
    let report = wadl_ingest::xer::ingest_xer_with(
        &text,
        &label,
        &map,
        &wadl_domain::civil::YardClock::utc(),
    );
    if survey {
        return print_survey(&report, encoding);
    }

    println!(
        "project {} — {} activities ({} milestones), {} relationships, {} quarantined · {} · map: {}",
        report.project.as_deref().unwrap_or("<unnamed>"),
        report.activities.len(),
        report.activities.iter().filter(|a| a.is_milestone).count(),
        report.relationships.len(),
        report.rejected.len(),
        encoding.describe(),
        map.summary(),
    );
    print_exclusions(&report);
    for finding in &report.findings {
        println!("FINDING · {finding}");
    }
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
        println!(
            "QUARANTINED line {} ({} · {}): {}",
            reject.row,
            reject.table,
            reject.code.as_deref().unwrap_or("—"),
            reject.reason
        );
    }
    Ok(())
}

/// What the map set aside without quarantining: level of effort, WBS
/// summaries, other projects' rows, and the assignments that are not
/// man-hours.
fn print_exclusions(report: &wadl_ingest::xer::XerIngestReport) {
    if !report.excluded_loe.is_empty() {
        println!(
            "excluded level of effort ({}): {}",
            report.excluded_loe.len(),
            report.excluded_loe.join(", ")
        );
    }
    if !report.excluded_wbs.is_empty() {
        println!(
            "excluded WBS summary ({}): {}",
            report.excluded_wbs.len(),
            report.excluded_wbs.join(", ")
        );
    }
    if !report.excluded_project.is_empty() {
        let rows: Vec<String> = report
            .excluded_project
            .iter()
            .map(|(code, project)| format!("{code} ({project})"))
            .collect();
        println!(
            "excluded, project not served ({}): {}",
            rows.len(),
            rows.join(", ")
        );
    }
    if report.material_skipped + report.equipment_skipped > 0 {
        println!(
            "not man-hours: {} material and {} equipment assignments skipped",
            report.material_skipped, report.equipment_skipped
        );
    }
}

/// The survey: the file's fields and counts, its encoding, and the
/// quarantine's classes by line — never a task code, a name or a reason,
/// so the output can leave the yard.
fn print_survey(
    report: &wadl_ingest::xer::XerIngestReport,
    encoding: wadl_ingest::encoding::Encoding,
) -> Result<()> {
    let quarantine: Vec<serde_json::Value> = report
        .rejected
        .iter()
        .map(|r| serde_json::json!({ "line": r.row, "table": r.table, "class": r.class }))
        .collect();
    let survey = serde_json::json!({
        "encoding": encoding.describe(),
        "task_rows": report.task_rows,
        "has_task_section": report.has_task_section(),
        "fields_seen": report.fields_seen,
        "quarantine": quarantine,
    });
    println!("{}", serde_json::to_string_pretty(&survey)?);
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
    // Exports from before chain format 2 carry no `chain_version` or actor
    // fields; serde defaults read them as format 1, which is what they are.
    let entries: Vec<LedgerEntry> = serde_json::from_str(&text).context("parsing ledger JSON")?;
    match ledger::verify_chain(&entries) {
        Ok(()) => {
            let named = entries.iter().filter(|e| e.chain_version >= 2).count();
            println!(
                "ledger intact — {} entries verify ({} name a person, {} from before people were asserted)",
                entries.len(),
                named,
                entries.len() - named
            );
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
