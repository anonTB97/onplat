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

/// The full endpoint inventory, as the data it is.
///
/// A table rather than seventeen struct literals: every row is
/// `(method, path, tenant_scoped, sample_body)`, and adding an endpoint is
/// adding a line — which is also what keeps this function inside the
/// workspace's function-length lint as the API grows.
#[must_use]
pub fn inventory() -> Vec<RouteSpec> {
    const ROUTES: &[(&str, &str, bool, Option<&str>)] = &[
        ("GET", "/health", false, None),
        // Scoped (it requires and reflects a caller identity) but addresses no
        // hull id, so the id-swap leak test has nothing to drive it with.
        ("GET", "/api/whoami", true, None),
        ("GET", "/api/vessels", true, None),
        ("GET", "/api/vessels/:id", true, None),
        ("GET", "/api/vessels/:id/compartments", true, None),
        ("GET", "/api/vessels/:id/work-orders", true, None),
        ("GET", "/api/vessels/:id/activities", true, None),
        ("GET", "/api/vessels/:id/schedule-alternatives", true, None),
        ("GET", "/api/vessels/:id/work-conflicts", true, None),
        ("GET", "/api/vessels/:id/stranded-hours", true, None),
        ("GET", "/api/vessels/:id/timeframe", true, None),
        ("GET", "/api/vessels/:id/compartments/:no/state", true, None),
        ("GET", "/api/vessels/:id/decks", true, None),
        ("GET", "/api/vessels/:id/deck-states", true, None),
        ("GET", "/api/vessels/:id/readiness", true, None),
        (
            "GET",
            "/api/vessels/:id/compartments/:no/mitigations",
            true,
            None,
        ),
        ("GET", "/api/vessels/:id/leverage", true, None),
        ("GET", "/api/vessels/:id/issues", true, None),
        (
            "POST",
            "/api/vessels/:id/issues/acknowledge",
            true,
            Some(r#"{"key":"issue:held:0-000-0-X","note":"leak test"}"#),
        ),
        ("GET", "/api/vessels/:id/ledger", true, None),
        ("GET", "/api/vessels/:id/hazards", true, None),
        (
            "POST",
            "/api/vessels/:id/hazards/clear",
            true,
            Some(r#"{"compartment":"3-148-2-E","kind":"energised_bus","basis":"leak test"}"#),
        ),
        ("GET", "/api/vessels/:id/zones", true, None),
        (
            "POST",
            "/api/vessels/:id/zones",
            true,
            Some(r#"{"label":"leak test","bounds":[{"zone":"Z1","lo_frame":0,"hi_frame":1}]}"#),
        ),
        ("POST", "/api/vessels/:id/zones/revert", true, None),
        (
            "POST",
            "/api/vessels/:id/budget-book",
            true,
            Some(
                r#"{"label":"leak test","items":[{"code":"WI-0","title":"t","trade":"t","budget_hours":1,"earned_hours":0}]}"#,
            ),
        ),
        ("POST", "/api/vessels/:id/budget-book/revert", true, None),
        ("GET", "/api/vessels/:id/manning-book", true, None),
        (
            "POST",
            "/api/vessels/:id/manning-book",
            true,
            Some(r#"{"label":"leak test","crews":[{"trade":"Electrical","headcount":1}]}"#),
        ),
        ("POST", "/api/vessels/:id/manning-book/revert", true, None),
        (
            "POST",
            "/api/vessels/:id/schedule-of-record",
            true,
            Some(r#"{"label":"leak test","xer":""}"#),
        ),
        (
            "POST",
            "/api/vessels/:id/schedule-of-record/revert",
            true,
            None,
        ),
        (
            "POST",
            "/api/vessels/:id/compartments/:no/decision",
            true,
            Some(r#"{"disposition":"rejected","option":{},"reason":"leak test"}"#),
        ),
        ("GET", "/api/vessels/:id/packages", true, None),
        ("GET", "/api/vessels/:id/packages/:no", true, None),
    ];
    ROUTES
        .iter()
        .map(|&(method, path, tenant_scoped, sample_body)| RouteSpec {
            method,
            path,
            tenant_scoped,
            sample_body,
        })
        .collect()
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
