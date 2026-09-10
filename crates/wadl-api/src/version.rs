//! The release stamp: which commit this binary is, when that commit was
//! made, and the migration set it was built against.
//!
//! Baked by `build.rs` (std only; `git` with an env fallback) so the values
//! are a function of the commit and two clean builds of one commit hash
//! equal. Served on `/health` beside the database's own migration state,
//! printed in the boot banner, and printed by `wadl version` — the CLI is
//! built from the same tree, so it carries the same stamp.

use serde::Serialize;

/// The stamp. `git` and `built_at` read `unknown` in a tree with no `.git`
/// and no override; `schema` is always four digits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Version {
    /// `git describe --always --dirty --tags` at build, or `WADL_GIT`.
    pub git: &'static str,
    /// The commit's instant (ISO-8601), or `WADL_BUILT_AT`.
    pub built_at: &'static str,
    /// The highest migration in `migrations/` at build, `NNNN`.
    pub schema: &'static str,
    /// The document shape this build writes.
    pub document_schema: u32,
}

impl Version {
    /// The banner line: `df18c59 · built 2026-09-04T21:23:37+00:00 · schema 0016`.
    #[must_use]
    pub fn banner(&self) -> String {
        format!(
            "{} · built {} · schema {}",
            self.git, self.built_at, self.schema
        )
    }
}

/// This build's stamp.
#[must_use]
pub fn current() -> Version {
    Version {
        git: env!("WADL_GIT"),
        built_at: env!("WADL_BUILT_AT"),
        schema: env!("WADL_SCHEMA"),
        document_schema: wadl_store::DOCUMENT_SCHEMA_VERSION,
    }
}

/// The database's schema against the build's: `not_applicable` (no
/// migrations — the memory store), `current`, `database_behind` (the binary
/// refuses to serve it; run `wadl migrate`), or `database_ahead` (served
/// with a warning — a newer release wrote it). Numeric compare, so `0016`
/// and `16` are the same version.
#[must_use]
pub fn schema_state(build: &str, database: Option<&str>) -> &'static str {
    let Some(database) = database else {
        return "not_applicable";
    };
    match (build.trim().parse::<u64>(), database.trim().parse::<u64>()) {
        (Ok(b), Ok(d)) if d < b => "database_behind",
        (Ok(b), Ok(d)) if d > b => "database_ahead",
        (Ok(_), Ok(_)) => "current",
        // A version that is not a number is not one this build can compare;
        // it is reported as ahead so the boot rule warns rather than refuses.
        _ => "database_ahead",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_state_compares_zero_padded_numbers() {
        assert_eq!(schema_state("0016", Some("16")), "current");
        assert_eq!(schema_state("0016", Some("0016")), "current");
        assert_eq!(schema_state("0016", Some("15")), "database_behind");
        assert_eq!(schema_state("0016", Some("17")), "database_ahead");
        assert_eq!(schema_state("0016", None), "not_applicable");
    }

    #[test]
    fn the_stamp_is_never_empty() {
        let v = current();
        assert!(!v.git.is_empty());
        assert!(!v.built_at.is_empty());
        assert_eq!(v.schema.len(), 4, "{}", v.schema);
        assert!(v.schema.chars().all(|c| c.is_ascii_digit()), "{}", v.schema);
        assert!(v.banner().contains("schema"));
    }
}
