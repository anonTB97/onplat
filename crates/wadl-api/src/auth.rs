//! The caller identity extractor — the one place identity enters the API.
//!
//! Identity arrives as headers either way; what changes between deployments is
//! **who is allowed to assert them**, and that trust boundary lives here:
//!
//! * **Dev shim** (default): `x-org-id` names the tenant and
//!   `x-assigned-vessels` carries the caller's per-hull assignments, trusted
//!   as given. Suitable only behind a loopback bind on a developer machine.
//! * **Proxy-asserted** (`WADL_PROXY_KEY` set): the same identity headers are
//!   trusted only when the request also carries `x-wadl-proxy-key` matching
//!   the configured value, compared in constant time. This is the accredited
//!   pattern for yards: CAC/PIV authentication terminates at the reverse
//!   proxy, which asserts the mapped identity headers plus the shared key on
//!   its private hop to this process. A request that reaches the port without
//!   the key — anything that did not come through the proxy — is refused
//!   before any identity is read.
//!
//! Either way the *shape* is the same — a [`TenantScope`] resolved before any
//! handler runs — and that shape is what the generated cross-tenant leak
//! tests exercise. Swapping in a different identity source (an OIDC broker, a
//! session store) means replacing the inside of this extractor and nothing
//! else.

use std::sync::OnceLock;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use uuid::Uuid;

use wadl_domain::ids::{OrgId, VesselId};
use wadl_store::TenantScope;

use crate::error::ApiError;

/// The resolved caller scope, injected into every scoped handler.
pub(crate) struct Caller(pub(crate) TenantScope);

/// The proxy key, read once. `None` means dev-shim trust.
///
/// An empty value is treated as unset here and refused at startup by the
/// server binary: `WADL_PROXY_KEY=""` used to arm proxy mode with a key every
/// request could match by presenting nothing, which is the opposite of a
/// gate. The binary refuses to boot in that state rather than quietly
/// downgrading to dev trust.
fn proxy_key() -> Option<&'static str> {
    static KEY: OnceLock<Option<String>> = OnceLock::new();
    KEY.get_or_init(|| {
        std::env::var("WADL_PROXY_KEY")
            .ok()
            .filter(|k| !k.is_empty())
    })
    .as_deref()
}

/// Whether `WADL_PROXY_KEY` is set to the empty string — the misconfiguration
/// the server refuses to start under. Exposed for the binary's boot check.
#[must_use]
pub fn proxy_key_is_empty() -> bool {
    std::env::var("WADL_PROXY_KEY").is_ok_and(|k| k.is_empty())
}

/// The human name of the active trust mode, served by `/api/whoami` and
/// printed at startup so an operator can see which boundary is armed.
pub(crate) fn identity_mode() -> &'static str {
    if proxy_key().is_some() {
        "proxy-asserted"
    } else {
        "dev-headers"
    }
}

/// Constant-time byte equality. The comparison must not leak how much of a
/// guessed key matched; folding every byte pair before deciding means the
/// work done is independent of where the first mismatch sits. (Length is
/// compared first — key length is not a secret.)
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The trust gate: decides whether this request may assert identity headers
/// at all. Split from the extractor (and handed the key) so tests can drive
/// both modes without touching process environment.
fn trust_gate(parts: &Parts, key: Option<&str>) -> Result<(), ApiError> {
    let Some(key) = key else {
        return Ok(()); // dev shim: headers trusted as given
    };
    // An empty key can never admit anyone: a missing header presents as the
    // empty string, and the two must not match.
    if key.is_empty() {
        return Err(ApiError::Unauthorized);
    }
    let presented = header(parts, "x-wadl-proxy-key").unwrap_or("");
    if ct_eq(presented.as_bytes(), key.as_bytes()) {
        Ok(())
    } else {
        Err(ApiError::Unauthorized)
    }
}

fn header<'a>(parts: &'a Parts, name: &str) -> Option<&'a str> {
    parts.headers.get(name).and_then(|v| v.to_str().ok())
}

#[axum::async_trait]
impl<S: Send + Sync> FromRequestParts<S> for Caller {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        trust_gate(parts, proxy_key())?;

        let org = header(parts, "x-org-id")
            .and_then(|s| s.parse::<Uuid>().ok())
            .map(OrgId::from_uuid)
            .ok_or(ApiError::Unauthorized)?;

        let assigned = header(parts, "x-assigned-vessels")
            .unwrap_or_default()
            .split(',')
            .filter(|s| !s.trim().is_empty())
            .filter_map(|s| s.trim().parse::<Uuid>().ok())
            .map(VesselId::from_uuid);

        Ok(Self(TenantScope::new(org, assigned)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;

    fn parts(headers: &[(&str, &str)]) -> Parts {
        let mut req = Request::builder().uri("/api/vessels");
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        req.body(()).unwrap().into_parts().0
    }

    #[test]
    fn dev_mode_trusts_headers_as_given() {
        assert!(trust_gate(&parts(&[]), None).is_ok());
    }

    #[test]
    fn proxy_mode_refuses_without_the_key() {
        let p = parts(&[("x-org-id", "00000000-0000-0000-0000-000000000001")]);
        assert!(trust_gate(&p, Some("sekrit")).is_err());
    }

    #[test]
    fn proxy_mode_refuses_a_wrong_key() {
        let p = parts(&[("x-wadl-proxy-key", "wrong")]);
        assert!(trust_gate(&p, Some("sekrit")).is_err());
    }

    #[test]
    fn an_empty_key_admits_nobody() {
        // The empty-key hole: no header presents as "", and "" == "".
        assert!(trust_gate(&parts(&[]), Some("")).is_err());
        assert!(trust_gate(&parts(&[("x-wadl-proxy-key", "")]), Some("")).is_err());
    }

    #[test]
    fn proxy_mode_admits_the_right_key() {
        let p = parts(&[("x-wadl-proxy-key", "sekrit")]);
        assert!(trust_gate(&p, Some("sekrit")).is_ok());
    }

    #[test]
    fn ct_eq_agrees_with_ordinary_equality() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"ab"));
        assert!(ct_eq(b"", b""));
    }
}
