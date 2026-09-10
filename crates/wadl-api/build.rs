//! Bakes the release stamp into the binary: which commit, the commit's
//! instant, and the migration set the tree was built against.
//!
//! Std only — no build-time crate. The three values are compile-time
//! environment variables read by `wadl_api::version::current()`:
//!
//! * `WADL_GIT` — `$WADL_GIT` when set (CI stamps the twelve-character sha;
//!   a vendored tarball has no `.git`), else `git describe --always --dirty
//!   --tags`, else `unknown`.
//! * `WADL_BUILT_AT` — `$WADL_BUILT_AT` when set, else the **commit's**
//!   instant (`git log -1 --date=iso-strict --format=%cd`), else `unknown`.
//!   Never the wall clock: two clean builds of one commit must hash equal
//!   (the `reproducible` CI job), and reading the clock is banned anyway.
//! * `WADL_SCHEMA` — the highest `NNNN` among `migrations/*.sql`, so the
//!   binary can say which schema it needs before it serves a database.
//!
//! Re-run when the migrations directory or the git head moves, or when either
//! override changes. A tracked file edited after the last build is not
//! watched, so `-dirty` reports the state at the last stamp, not the tree's.

use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    let root = workspace_root();
    println!("cargo:rerun-if-env-changed=WADL_GIT");
    println!("cargo:rerun-if-env-changed=WADL_BUILT_AT");
    // Only paths that exist: cargo re-runs a script on every build when a
    // watched path is missing, which a `.git`-less tarball would trip.
    for rel in ["migrations", ".git/HEAD", ".git/refs", ".git/packed-refs"] {
        let watched = root.join(rel);
        if watched.exists() {
            println!("cargo:rerun-if-changed={}", watched.display());
        }
    }

    let git = override_var("WADL_GIT")
        .or_else(|| git_output(&root, &["describe", "--always", "--dirty", "--tags"]))
        .unwrap_or_else(|| "unknown".to_owned());
    let built_at = override_var("WADL_BUILT_AT")
        .or_else(|| git_output(&root, &["log", "-1", "--date=iso-strict", "--format=%cd"]))
        .unwrap_or_else(|| "unknown".to_owned());
    let schema = highest_migration(&root.join("migrations"));

    println!("cargo:rustc-env=WADL_GIT={git}");
    println!("cargo:rustc-env=WADL_BUILT_AT={built_at}");
    println!("cargo:rustc-env=WADL_SCHEMA={schema}");
}

/// The workspace root, two levels above this crate's manifest.
fn workspace_root() -> PathBuf {
    std::env::var("CARGO_MANIFEST_DIR").map_or_else(
        |_| PathBuf::from("../.."),
        |dir| Path::new(&dir).join("../.."),
    )
}

/// An override variable, when set to something other than whitespace.
fn override_var(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

/// One line of `git` output from the workspace root, or `None` when git is
/// absent, the tree is not a repository, or the output is empty.
fn git_output(root: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8(out.stdout).ok()?;
    let line = text.lines().next()?.trim();
    (!line.is_empty()).then(|| line.to_owned())
}

/// The highest four-digit prefix among `NNNN_*.sql` in `dir`, zero-padded;
/// `0000` when the directory is missing or carries no migration.
fn highest_migration(dir: &Path) -> String {
    let highest = std::fs::read_dir(dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| {
            Path::new(name)
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("sql"))
        })
        .filter_map(|name| {
            let digits: String = name.chars().take_while(char::is_ascii_digit).collect();
            digits.parse::<u32>().ok()
        })
        .max()
        .unwrap_or(0);
    format!("{highest:04}")
}
