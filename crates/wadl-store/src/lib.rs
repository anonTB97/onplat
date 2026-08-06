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
//! The [`pg`] module holds the PostgreSQL seam: the pool, the forward-only
//! migrator, and the per-transaction tenant scoping (`SET LOCAL app.org_id`)
//! that arms row-level security. Wiring the compile-time-checked `query_as!`
//! repositories onto it is the next step once a dev database / offline cache is
//! present; the trait above is what they will implement.

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
pub mod pg;
pub mod repo;
pub mod scope;

pub use error::StoreError;
pub use memory::InMemoryStore;
pub use repo::Repositories;
pub use scope::TenantScope;
