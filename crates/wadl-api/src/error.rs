//! The API error type.
//!
//! Every failure leaves the process as `application/problem+json` and never
//! carries a SQL string, a stack detail, or another tenant's identifier. A
//! not-found is a not-found whether the row is absent or merely out of scope —
//! the distinction would itself leak information.

use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};

use wadl_store::StoreError;

/// The single error type every handler returns.
#[derive(Debug)]
pub(crate) enum ApiError {
    /// No caller identity, or an unparseable one.
    Unauthorized,
    /// An identity hop that asserted no person, or a person id outside the
    /// contract's charset. Carries a `detail` because this is the one 401 a
    /// proxy owner fixes by changing their configuration, and a bare
    /// "unauthorized" would send them to the key first.
    IdentityRefused(String),
    /// The caller is known and the hull is theirs, but their role lacks the
    /// capability the route needs. Carries the sentence in yard words, the
    /// capability's code and the caller's role codes, so the shell can show
    /// who may and an assessor can read the policy off the refusal.
    Forbidden {
        /// `"Foreman may not record a clearance — clear_hazard is held by …"`.
        detail: String,
        /// The capability's wire code.
        capability: &'static str,
        /// The caller's recognised role codes.
        roles: Vec<String>,
    },
    /// The resource does not exist within the caller's scope.
    NotFound,
    /// The request is well-formed but asks for something the data cannot answer —
    /// today, only an `as_of` instant outside the hull's availability.
    ///
    /// Carries a `detail` because this is the one refusal a caller can fix by
    /// changing the request, and "unprocessable" with no reason is a dead end for
    /// whoever is holding the time control.
    OutOfRange(String),
    /// The body exceeds the import ceiling. Carries the ceiling so the caller
    /// learns the actual limit instead of guessing at it.
    PayloadTooLarge(usize),
    /// An internal failure. Detail is logged, never returned.
    Internal,
}

impl From<StoreError> for ApiError {
    fn from(err: StoreError) -> Self {
        match err {
            StoreError::NotFound => Self::NotFound,
            StoreError::Backend(detail) => {
                // Emitted as a JSON line on stderr — the same shape as the
                // audit stream on stdout, but kept on the diagnostic channel.
                // This used to go through `tracing::error!`, which, with no
                // subscriber installed anywhere, dropped the one message that
                // explains a 500.
                eprintln!(
                    "{}",
                    serde_json::json!({ "event": "backend_error", "detail": detail })
                );
                Self::Internal
            }
        }
    }
}

impl ApiError {
    /// Status, title, detail, and any extra problem members.
    fn problem(
        self,
    ) -> (
        StatusCode,
        &'static str,
        Option<String>,
        Vec<(&'static str, Value)>,
    ) {
        match self {
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized", None, vec![]),
            Self::IdentityRefused(detail) => (
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                Some(detail),
                vec![],
            ),
            Self::Forbidden {
                detail,
                capability,
                roles,
            } => (
                StatusCode::FORBIDDEN,
                "forbidden",
                Some(detail),
                vec![("capability", json!(capability)), ("roles", json!(roles))],
            ),
            Self::NotFound => (StatusCode::NOT_FOUND, "not found", None, vec![]),
            Self::OutOfRange(detail) => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "instant out of range",
                Some(detail),
                vec![],
            ),
            Self::PayloadTooLarge(ceiling) => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "payload too large",
                Some(format!(
                    "the body exceeds the import ceiling of {} MB",
                    ceiling / (1024 * 1024)
                )),
                vec![],
            ),
            Self::Internal => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal error",
                None,
                vec![],
            ),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, title, detail, extras) = self.problem();
        let mut body = serde_json::Map::new();
        body.insert("type".to_owned(), json!("about:blank"));
        body.insert("title".to_owned(), json!(title));
        body.insert("status".to_owned(), json!(status.as_u16()));
        body.insert("detail".to_owned(), json!(detail));
        for (key, value) in extras {
            body.insert(key.to_owned(), value);
        }
        let body = serde_json::to_string(&Value::Object(body)).unwrap_or_else(|_| {
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
