//! The API error type.
//!
//! Every failure leaves the process as `application/problem+json` and never
//! carries a SQL string, a stack detail, or another tenant's identifier. A
//! not-found is a not-found whether the row is absent or merely out of scope —
//! the distinction would itself leak information.

use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};

use wadl_store::StoreError;

/// The single error type every handler returns.
#[derive(Debug)]
pub(crate) enum ApiError {
    /// No caller identity, or an unparseable one.
    Unauthorized,
    /// The resource does not exist within the caller's scope.
    NotFound,
    /// The request is well-formed but asks for something the data cannot answer —
    /// today, only an `as_of` instant outside the hull's availability.
    ///
    /// Carries a `detail` because this is the one refusal a caller can fix by
    /// changing the request, and "unprocessable" with no reason is a dead end for
    /// whoever is holding the time control.
    OutOfRange(String),
    /// An internal failure. Detail is logged, never returned.
    Internal,
}

impl From<StoreError> for ApiError {
    fn from(err: StoreError) -> Self {
        match err {
            StoreError::NotFound => Self::NotFound,
            StoreError::Backend(detail) => {
                tracing::error!(%detail, "store backend error");
                Self::Internal
            }
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, title, detail) = match self {
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized", None),
            Self::NotFound => (StatusCode::NOT_FOUND, "not found", None),
            Self::OutOfRange(detail) => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "instant out of range",
                Some(detail),
            ),
            Self::Internal => (StatusCode::INTERNAL_SERVER_ERROR, "internal error", None),
        };
        let body = serde_json::json!({
            "type": "about:blank",
            "title": title,
            "status": status.as_u16(),
            "detail": detail,
        });
        let body = serde_json::to_string(&body).unwrap_or_else(|_| {
            // A serde_json failure on a fixed literal object is not reachable;
            // fall back to a minimal valid problem document rather than panic.
            String::from("{\"type\":\"about:blank\",\"title\":\"internal error\",\"status\":500}")
        });
        (
            status,
            [(header::CONTENT_TYPE, "application/problem+json")],
            body,
        )
            .into_response()
    }
}
