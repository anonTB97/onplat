//! `wadl verify-ledger` — re-hashes an audit chain and reports the first
//! break, from a JSON export (`--input`) or from a live database
//! (`--database-url`, or `DATABASE_URL`).
//!
//! Database mode reads every hull's chain as the connecting role outside
//! row-level security — the operator's session, like `migrate` — read-only,
//! and prints one line per hull: `CVN-73 · 14 entries verify`, or
//! `CVN-73 · BROKEN at seq 9: HashMismatch`. Exit 0 when every hull
//! verifies, 1 when any chain is broken, 2 when there is nothing to verify
//! against (no file and no database named).

use std::path::Path;
use std::process::ExitCode;

use anyhow::{Context, Result};
use serde::Serialize;

use wadl_store::ledger::{self, LedgerEntry};
use wadl_store::pg::PgStore;

use crate::refused;

/// One hull's chain verdict — what the CLI prints and the support bundle
/// carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct ChainVerdict {
    /// The hull number.
    pub(crate) hull_no: String,
    /// Rows on the chain.
    pub(crate) entries: usize,
    /// Whether the whole chain re-hashes.
    pub(crate) verified: bool,
    /// `seq N: <reason>` for the first break, when there is one.
    pub(crate) first_break: Option<String>,
}

impl ChainVerdict {
    /// The line the CLI prints.
    fn line(&self) -> String {
        match &self.first_break {
            None if self.entries == 0 => format!("{} · no entries yet", self.hull_no),
            None => format!(
                "{} · {} entr{} verify",
                self.hull_no,
                self.entries,
                if self.entries == 1 { "y" } else { "ies" }
            ),
            Some(brk) => format!("{} · BROKEN at {brk}", self.hull_no),
        }
    }
}

/// Every hull's verdict, read from the database as the owner.
///
/// # Errors
/// A store that cannot be read.
pub(crate) async fn verdicts(store: &PgStore) -> Result<Vec<ChainVerdict>> {
    let chains = store
        .audit_chains_all()
        .await
        .context("reading the ledger chains")?;
    Ok(chains
        .iter()
        .map(|chain| {
            let verdict = ledger::verify_records(&chain.records);
            ChainVerdict {
                hull_no: chain.hull_no.clone(),
                entries: chain.records.len(),
                verified: verdict.is_ok(),
                first_break: verdict
                    .err()
                    .map(|brk| format!("seq {}: {:?}", brk.seq, brk.reason)),
            }
        })
        .collect())
}

/// The command: a file, or a database.
pub(crate) async fn run(input: Option<&Path>, database_url: Option<String>) -> Result<ExitCode> {
    if let Some(path) = input {
        return verify_file(path).map(|()| ExitCode::SUCCESS);
    }
    let Some(url) = database_url.or_else(|| std::env::var("DATABASE_URL").ok()) else {
        eprintln!(
            "refused: nothing to verify — pass --input <ledger.json>, or --database-url (or set DATABASE_URL)"
        );
        return Ok(refused());
    };
    let store = PgStore::connect(&url).await.context("connecting")?;
    let verdicts = verdicts(&store).await?;
    for v in &verdicts {
        println!("{}", v.line());
    }
    let broken = verdicts.iter().filter(|v| !v.verified).count();
    if broken > 0 {
        anyhow::bail!(
            "{broken} of {} hull chain{} BROKEN",
            verdicts.len(),
            if verdicts.len() == 1 { "" } else { "s" }
        );
    }
    println!(
        "{} hull{} verify",
        verdicts.len(),
        if verdicts.len() == 1 { "" } else { "s" }
    );
    Ok(ExitCode::SUCCESS)
}

/// A JSON export of one chain, as the ledger route serves it.
fn verify_file(input: &Path) -> Result<()> {
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
