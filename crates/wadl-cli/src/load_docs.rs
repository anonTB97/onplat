//! `wadl load-docs` — the reference hull's documents and export through the
//! same parsers and store calls the doors use, from the operator's session.
//!
//! One function does the loading for boot, CLI and tests
//! (`wadl_api::documents::load_docs`); this module is a command line in front
//! of it. Each committed document and the export write their ledger rows
//! (`DOCUMENT_REPLACED … via: cli`, `SCHEDULE_REPLACED`), and the line
//! printed for each carries the row's `seq`. A refusal exits 2 with the file
//! name in front and nothing committed **for that file**; files before it
//! stay committed and are listed — the CLI is a sequence of doors, each
//! all-or-nothing, like data-load day.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, Result};
use uuid::Uuid;

use wadl_api::documents::{self, LoadVia, LoadedDocuments};
use wadl_api::schedule::{self, XerLoad};
use wadl_domain::ids::{OrgId, VesselId};
use wadl_domain::time::Timestamp;
use wadl_domain::Clock;
use wadl_store::clock::SystemClock;
use wadl_store::pg::PgStore;
use wadl_store::{Actor, ActorSource, InMemoryStore, Repositories, TenantScope};

use crate::refused;

/// The command's arguments.
pub(crate) struct LoadDocsArgs {
    /// The directory of documents (`reference/cvn73` is the shipped one).
    pub(crate) dir: PathBuf,
    /// A P6 export to commit as the schedule of record after the documents.
    pub(crate) xer: Option<PathBuf>,
    /// The tenant.
    pub(crate) org: Uuid,
    /// The hull.
    pub(crate) vessel: Uuid,
    /// The person on the record, when the operator names one.
    pub(crate) person: Option<String>,
    /// Parse and validate; commit nothing.
    pub(crate) dry_run: bool,
    /// PostgreSQL URL; falls back to `DATABASE_URL`.
    pub(crate) database_url: Option<String>,
}

/// How a load runs: committed to the database; a dry run against the
/// database's current state; or a rehearsal on a scratch in-memory hull
/// (no database at all) where everything is stored and nothing persists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Commit,
    DryRun,
    Scratch,
}

pub(crate) async fn run(args: LoadDocsArgs) -> Result<ExitCode> {
    let now_ms = SystemClock.now().epoch_millis();
    // `--person` puts a person on every row; without one the binary acts on
    // its own account through the CLI door, and the ledger says so.
    let actor = args.person.as_deref().map_or_else(
        || Actor::system("cli"),
        |p| Actor::new(p, p, ActorSource::Cli),
    );
    let url = args
        .database_url
        .clone()
        .or_else(|| std::env::var("DATABASE_URL").ok());
    match url {
        Some(url) => {
            let store = PgStore::connect(&url).await.context("connecting")?;
            let vessel = VesselId::from_uuid(args.vessel);
            let scope = TenantScope::new(OrgId::from_uuid(args.org), [vessel]).with_actor(actor);
            let mode = if args.dry_run {
                Mode::DryRun
            } else {
                Mode::Commit
            };
            load_into(&store, &scope, vessel, &args, now_ms, mode).await
        }
        None if args.dry_run => {
            // The yard checks its files on a laptop: a scratch in-memory hull
            // takes every document for real, so the export is read under the
            // staged clock and map, and nothing outlives the process.
            let (store, world) = InMemoryStore::demo_at(Timestamp::from_epoch_millis(now_ms));
            println!(
                "no database: validating against a scratch in-memory hull — nothing is persisted"
            );
            let scope = world.yard_scope().with_actor(actor);
            load_into(&store, &scope, world.cvn73, &args, now_ms, Mode::Scratch).await
        }
        None => anyhow::bail!(
            "provide --database-url or set DATABASE_URL (or --dry-run to validate the files without a database)"
        ),
    }
}

/// Loads the documents, then the export, printing one line per document.
async fn load_into(
    store: &dyn Repositories,
    scope: &TenantScope,
    vessel: VesselId,
    args: &LoadDocsArgs,
    now_ms: i64,
    mode: Mode,
) -> Result<ExitCode> {
    let via = LoadVia {
        via: "cli",
        dry_run: mode == Mode::DryRun,
    };
    let loaded = match documents::load_docs(store, scope, vessel, &args.dir, now_ms, via).await {
        Ok(loaded) => loaded,
        Err(refusal) => {
            print_documents(&refusal.loaded_before, mode);
            eprintln!("refused: {refusal}");
            let before = refusal.loaded_before.banner_lines().len();
            if before > 0 && mode == Mode::Commit {
                eprintln!("{before} document(s) before it stay committed, listed above");
            }
            return Ok(refused());
        }
    };
    print_documents(&loaded, mode);
    if loaded.banner_lines().is_empty() {
        println!(
            "no documents found in {} (looked for *-clock.csv, *-fieldmap.json, *-register.csv, *-zones.csv, *-geometry.csv, *-couplings.csv, *-hazards.csv)",
            args.dir.display()
        );
    }
    let Some(xer) = &args.xer else {
        print_footer(mode);
        return Ok(ExitCode::SUCCESS);
    };
    let code = load_xer(store, scope, vessel, xer, now_ms, mode).await?;
    print_footer(mode);
    Ok(code)
}

/// The export, committed and ledgered as the door would.
async fn load_xer(
    store: &dyn Repositories,
    scope: &TenantScope,
    vessel: VesselId,
    xer: &Path,
    now_ms: i64,
    mode: Mode,
) -> Result<ExitCode> {
    let label = xer.file_name().map_or_else(
        || xer.display().to_string(),
        |n| n.to_string_lossy().into_owned(),
    );
    let bytes = std::fs::read(xer).with_context(|| format!("reading {}", xer.display()))?;
    let load = XerLoad {
        label: &label,
        bytes: &bytes,
        via: "cli",
        now_ms,
        dry_run: mode == Mode::DryRun,
    };
    match schedule::commit_xer(store, scope, vessel, load).await {
        Ok(loaded) => {
            println!(
                "schedule of record:  {label} — {} activities, {} quarantined, {}, map {} · parsed in {}{}",
                loaded.activities,
                loaded.quarantine.len(),
                loaded.encoding,
                loaded.field_map_label.as_deref().unwrap_or("default"),
                loaded.parsed_in,
                seq_suffix(loaded.ledger_seq, mode),
            );
            for row in &loaded.quarantine {
                println!("  quarantined:         {row}");
            }
            for finding in loaded.findings.iter().chain(&loaded.wall_clock_findings) {
                println!("  finding:             {finding}");
            }
            if mode == Mode::DryRun {
                println!(
                    "  note: a dry run reads the export under the clock and field map the database holds now, not the staged files"
                );
            }
            Ok(ExitCode::SUCCESS)
        }
        Err(reason) => {
            eprintln!("refused: {label}: {reason}");
            Ok(refused())
        }
    }
}

/// One line per document, in door order, with its ledger `seq`.
fn print_documents(loaded: &LoadedDocuments, mode: Mode) {
    for (kind, line) in loaded.banner_lines() {
        println!("{line}{}", seq_suffix(loaded.ledger_seq(kind), mode));
    }
}

/// ` · ledger seq N` on a commit; what the mode did otherwise.
fn seq_suffix(seq: Option<i64>, mode: Mode) -> String {
    match (mode, seq) {
        (Mode::Commit, Some(seq)) => format!(" · ledger seq {seq}"),
        (Mode::Commit, None) => String::new(),
        (Mode::DryRun, _) => " · dry run, not stored".to_owned(),
        (Mode::Scratch, _) => " · validated, not persisted".to_owned(),
    }
}

fn print_footer(mode: Mode) {
    match mode {
        Mode::Commit => {}
        Mode::DryRun => println!("dry run — nothing stored, nothing ledgered"),
        Mode::Scratch => println!("scratch hull — nothing persisted"),
    }
}
