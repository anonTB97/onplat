//! The PostgreSQL seam.
//!
//! Milestone 1 wires the parts that are load-bearing and cheap to get right now:
//! the connection pool, the forward-only migrator embedded from `/migrations`,
//! and — most importantly — [`PgStore::with_tenant`], which opens a transaction
//! and sets `app.org_id` transaction-locally so the row-level-security policies
//! engage. A suspension committing in the same transaction as its hazard (the
//! platform's first invariant) depends on this being a transaction, not a
//! connection setting.
//!
//! The queries — the full [`crate::Repositories`] implementation — live in
//! [`crate::pg_repo`] and are exercised against a real database by
//! `tests/pg_rls.rs`, from tenant isolation through package topology to the
//! ledger's hash chain.

use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{PgPool, Postgres, Transaction};

use wadl_domain::ids::OrgId;

use crate::error::StoreError;

/// The forward-only migration set, embedded at compile time from `/migrations`.
pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../../migrations");

impl From<sqlx::Error> for StoreError {
    fn from(err: sqlx::Error) -> Self {
        Self::Backend(err.to_string())
    }
}

impl From<sqlx::migrate::MigrateError> for StoreError {
    fn from(err: sqlx::migrate::MigrateError) -> Self {
        Self::Backend(err.to_string())
    }
}

/// A PostgreSQL-backed store: owns the pool and the tenant-scoping entry point.
#[derive(Clone)]
pub struct PgStore {
    pool: PgPool,
}

impl PgStore {
    /// Connects using a `postgres://` URL, so callers need not depend on sqlx.
    ///
    /// # Errors
    /// [`StoreError::Backend`] if the URL is invalid or the pool cannot be
    /// established.
    pub async fn connect(url: &str) -> Result<Self, StoreError> {
        let options: PgConnectOptions = url.parse()?;
        Self::connect_with(options).await
    }

    /// Connects with an already-parsed set of options.
    ///
    /// # Errors
    /// [`StoreError::Backend`] if the pool cannot be established.
    pub async fn connect_with(options: PgConnectOptions) -> Result<Self, StoreError> {
        let pool = PgPoolOptions::new()
            .max_connections(8)
            .connect_with(options)
            .await?;
        Ok(Self { pool })
    }

    /// The underlying pool, for code that manages its own transactions.
    #[must_use]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// Applies all outstanding migrations.
    ///
    /// # Errors
    /// [`StoreError::Backend`] if a migration fails to apply.
    pub async fn migrate(&self) -> Result<(), StoreError> {
        MIGRATOR.run(&self.pool).await?;
        Ok(())
    }

    /// Opens a transaction that is scoped to one tenant and runs as the
    /// application role, so every statement in it is filtered by the
    /// row-level-security policies. This is the ONLY sanctioned way to read or
    /// write tenant data over Postgres.
    ///
    /// Two statements, and both matter:
    ///
    /// * `SET LOCAL ROLE wadl_app` — **PostgreSQL does not apply RLS to a
    ///   table's owner.** A deployment that connected as the owner (or as a
    ///   superuser, which is easy to do by accident in development) would get
    ///   silent full access to every tenant's rows, with the policies present and
    ///   doing nothing. Switching role inside the transaction makes the isolation
    ///   guarantee a property of this function rather than of whatever credentials
    ///   happen to be in `DATABASE_URL`. It is transaction-local, so it cannot
    ///   leak to the next borrower of the pooled connection.
    /// * `set_config('app.org_id', …, true)` — the tenant the policies read.
    ///   Used rather than `SET LOCAL` so the tenant id is a bound parameter and
    ///   never interpolated into SQL.
    ///
    /// The connecting role must be `wadl_app` or a member of it (a superuser
    /// qualifies); migrations and seeding deliberately run *outside* this scope,
    /// as the owner.
    ///
    /// # Errors
    /// [`StoreError::Backend`] if the transaction cannot be opened or scoped.
    pub async fn with_tenant(&self, org: OrgId) -> Result<Transaction<'_, Postgres>, StoreError> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SET LOCAL ROLE wadl_app")
            .execute(&mut *tx)
            .await?;
        sqlx::query("SELECT set_config('app.org_id', $1, true)")
            .bind(org.as_uuid().to_string())
            .execute(&mut *tx)
            .await?;
        Ok(tx)
    }

    /// Counts the vessels visible to `org` — a minimal end-to-end proof that a
    /// tenant-scoped query engages row-level security.
    ///
    /// # Errors
    /// [`StoreError::Backend`] on any query failure.
    pub async fn count_vessels(&self, org: OrgId) -> Result<i64, StoreError> {
        let mut tx = self.with_tenant(org).await?;
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM vessel")
            .fetch_one(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(count)
    }
}
