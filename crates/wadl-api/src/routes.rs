//! The route inventory.
//!
//! This is the single registry of the API's endpoints. Two things read it: the
//! router builder (indirectly — the routes it registers match this list), and
//! the generated cross-tenant leak test, which asserts that every
//! `tenant_scoped` endpoint returns not-found when called as one tenant with
//! another tenant's identifiers. `cargo xtask gen-leak-tests` regenerates that
//! test from this list, so adding a scoped endpoint here (and wiring it in
//! `build_router`) produces a leak test for it.

/// One endpoint. `path` uses axum's `:param` syntax.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RouteSpec {
    /// HTTP method.
    pub method: &'static str,
    /// Path pattern, e.g. `/api/vessels/:id`.
    pub path: &'static str,
    /// Whether the endpoint reads tenant-scoped data and must therefore refuse
    /// another tenant's identifiers.
    pub tenant_scoped: bool,
    /// A minimal valid JSON body, for methods that need one.
    ///
    /// The leak test drives every scoped route with a foreign hull id and expects
    /// not-found. A POST sent with no body fails body extraction *before* the
    /// handler can refuse the hull, so the test would pass on a 415 and prove
    /// nothing. Carrying a sample here keeps the inventory the single thing that
    /// has to be updated when a route is added.
    pub sample_body: Option<&'static str>,
}

/// The full endpoint inventory.
#[must_use]
pub fn inventory() -> Vec<RouteSpec> {
    vec![
        RouteSpec {
            method: "GET",
            path: "/health",
            tenant_scoped: false,
            sample_body: None,
        },
        RouteSpec {
            method: "GET",
            path: "/api/vessels",
            tenant_scoped: true,
            sample_body: None,
        },
        RouteSpec {
            method: "GET",
            path: "/api/vessels/:id",
            tenant_scoped: true,
            sample_body: None,
        },
        RouteSpec {
            method: "GET",
            path: "/api/vessels/:id/compartments",
            tenant_scoped: true,
            sample_body: None,
        },
        RouteSpec {
            method: "GET",
            path: "/api/vessels/:id/work-orders",
            tenant_scoped: true,
            sample_body: None,
        },
        RouteSpec {
            method: "GET",
            path: "/api/vessels/:id/stranded-hours",
            tenant_scoped: true,
            sample_body: None,
        },
        RouteSpec {
            method: "GET",
            path: "/api/vessels/:id/timeframe",
            tenant_scoped: true,
            sample_body: None,
        },
        RouteSpec {
            method: "GET",
            path: "/api/vessels/:id/compartments/:no/state",
            tenant_scoped: true,
            sample_body: None,
        },
        RouteSpec {
            method: "GET",
            path: "/api/vessels/:id/decks",
            tenant_scoped: true,
            sample_body: None,
        },
        RouteSpec {
            method: "GET",
            path: "/api/vessels/:id/deck-states",
            tenant_scoped: true,
            sample_body: None,
        },
        RouteSpec {
            method: "GET",
            path: "/api/vessels/:id/readiness",
            tenant_scoped: true,
            sample_body: None,
        },
        RouteSpec {
            method: "GET",
            path: "/api/vessels/:id/compartments/:no/mitigations",
            tenant_scoped: true,
            sample_body: None,
        },
        RouteSpec {
            method: "GET",
            path: "/api/vessels/:id/leverage",
            tenant_scoped: true,
            sample_body: None,
        },
        RouteSpec {
            method: "POST",
            path: "/api/vessels/:id/compartments/:no/decision",
            tenant_scoped: true,
            sample_body: Some(r#"{"disposition":"rejected","option":{},"reason":"leak test"}"#),
        },
        RouteSpec {
            method: "GET",
            path: "/api/vessels/:id/packages",
            tenant_scoped: true,
            sample_body: None,
        },
        RouteSpec {
            method: "GET",
            path: "/api/vessels/:id/packages/:no",
            tenant_scoped: true,
            sample_body: None,
        },
    ]
}

/// The tenant-scoped endpoints that address a specific hull by id — the ones the
/// leak test drives with a foreign id and expects not-found from.
#[must_use]
pub fn scoped_id_routes() -> Vec<RouteSpec> {
    inventory()
        .into_iter()
        .filter(|r| r.tenant_scoped && r.path.contains(":id"))
        .collect()
}
