//! Store errors.

/// A failure in the persistence layer. Deliberately coarse: it never carries a
/// SQL string or a tenant id outward, so an error surfaced to a client cannot
/// leak schema or another tenant's identifiers.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// The requested row does not exist *within the caller's scope*. A row that
    /// exists in another tenant is reported as `NotFound`, never as "forbidden"
    /// — the difference would itself leak that the row exists.
    #[error("not found")]
    NotFound,
    /// A backend failure (connection, query, migration). The detail is for logs.
    #[error("backend error: {0}")]
    Backend(String),
}
