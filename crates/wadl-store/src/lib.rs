//! Repositories, read models, and the tenant session scope.
//!
//! This crate owns persistence. Two things live here that the rest of the
//! platform depends on:
//!
//! * The [`Repositories`] trait and its read models — the shell and API speak to
//!   storage only through this seam. Milestone 1 ships a working
//!   [`memory::InMemoryStore`] that enforces tenant and RBAC scoping *in code*,
//!   mirroring the row-level-security policies in `/migrations`, so the API and
//!   the cross-tenant leak test are real and green without a database.
//! * [`clock::SystemClock`] — the one and only sanctioned caller of the wall
//!   clock. Every other crate injects a [`wadl_domain::Clock`].
//!
//! The `pg` module holds the PostgreSQL seam: the pool, the forward-only
//! migrator, and the per-transaction tenant scoping (`SET LOCAL app.org_id`)
//! that arms row-level security. It sits behind the `postgres` cargo feature —
//! a deployment opts in (wadl-cli does; a production server binary would);
//! every other consumer compiles without sqlx in its dependency tree at all.

#![forbid(unsafe_code)]
#![allow(clippy::doc_markdown)]
#![cfg_attr(
    test,
    allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing,
        clippy::float_arithmetic
    )
)]

pub mod clock;
pub mod error;
pub mod ledger;
pub mod memory;
pub mod model;
#[cfg(feature = "postgres")]
pub mod pg;
#[cfg(feature = "postgres")]
pub mod pg_repo;
pub mod repo;
pub mod scope;

pub use error::StoreError;
pub use memory::InMemoryStore;
pub use repo::Repositories;
pub use scope::{Actor, ActorSource, TenantScope};

/// The shape version stamped into every stored document (`schema_version`
/// in the jsonb). Bump it when a document's fields change meaning, so a
/// reader can tell a document written before the change from one written
/// after — and refuse or migrate rather than guess.
pub const DOCUMENT_SCHEMA_VERSION: u32 = 1;
