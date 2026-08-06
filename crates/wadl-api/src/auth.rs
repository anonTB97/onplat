//! The caller identity extractor.
//!
//! Milestone 1 uses a header shim for identity: `x-org-id` names the tenant and
//! `x-assigned-vessels` carries the caller's per-hull assignments. Server-side
//! session state replaces this shim later, but the *shape* — a [`TenantScope`]
//! resolved before any handler runs — is what the rest of the API depends on,
//! and it is what the cross-tenant leak test exercises.

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use uuid::Uuid;

use wadl_domain::ids::{OrgId, VesselId};
use wadl_store::TenantScope;

use crate::error::ApiError;

/// The resolved caller scope, injected into every scoped handler.
pub(crate) struct Caller(pub(crate) TenantScope);

fn header<'a>(parts: &'a Parts, name: &str) -> Option<&'a str> {
    parts.headers.get(name).and_then(|v| v.to_str().ok())
}

#[axum::async_trait]
impl<S: Send + Sync> FromRequestParts<S> for Caller {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
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
