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
//! The compile-time-checked `query_as!` repositories that implement
//! [`crate::Repositories`] over this pool are the next step; they need a dev
//! database or an offline query cache to compile, which is why the working
//! milestone-1 store is [`crate::InMemoryStore`]. The count query below is a
//! deliberately small proof that a scoped query runs end to end.

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

    /// Opens a transaction with `app.org_id` set transaction-locally, so every
    /// statement in it is filtered by the row-level-security policies. This is
    /// the ONLY sanctioned way to read or write tenant data over Postgres.
    ///
    /// `set_config(..., true)` is used rather than `SET LOCAL` so the tenant id
    /// is a bound parameter, never interpolated into SQL.
    ///
    /// # Errors
    /// [`StoreError::Backend`] if the transaction cannot be opened or scoped.
    pub async fn with_tenant(&self, org: OrgId) -> Result<Transaction<'_, Postgres>, StoreError> {
        let mut tx = self.pool.begin().await?;
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
