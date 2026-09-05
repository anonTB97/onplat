//! Roles, capabilities, and the one gate that judges them.
//!
//! The yard signs an eight-row table: which role may raise a field condition,
//! record a clearance, commit a document, propose a schedule change, answer
//! for an option or an issue. That table is [`MATRIX`], a code table served
//! on `/api/whoami` so the shell greys the doors a person may not open and an
//! assessor can read the policy off one response. Every write route is
//! listed in [`GATED`] with the capability it needs, and [`gate`] — one
//! `route_layer` middleware — refuses a caller without it, in a sentence that
//! names the role and who holds the capability. Capabilities are added here,
//! never checked ad hoc in a handler (`docs/programme/programme.md`).
//!
//! Three orderings are deliberate. A dry run is never gated: anyone may
//! preview. An identity that fails to resolve passes through so the handler
//! refuses it identically (401 before anything). A hull the caller is not
//! assigned passes through so the handler's 404 comes first: a capability is
//! never judged on a hull the caller cannot see.

use std::collections::BTreeSet;

use axum::extract::{MatchedPath, Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};
use uuid::Uuid;

use wadl_domain::ids::VesselId;

use crate::auth::{self, Caller};
use crate::error::ApiError;
use crate::AppState;

/// One thing a role may do. `Read` is implicit for every authenticated
/// caller and never gated; the rest each guard a set of write routes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Capability {
    /// See the hull. Everyone.
    Read,
    /// Raise a field condition (a hazard), by hand or from the morning's log.
    RaiseHazard,
    /// Record a clearance — the clearing authority's act.
    ClearHazard,
    /// Commit or revert a document through a door.
    CommitDocument,
    /// Propose or withdraw a schedule change.
    Propose,
    /// Answer for a mitigation option or an issue.
    Decide,
}

impl Capability {
    /// Every capability, in the order `whoami` serves them.
    pub const ALL: [Self; 6] = [
        Self::Read,
        Self::RaiseHazard,
        Self::ClearHazard,
        Self::CommitDocument,
        Self::Propose,
        Self::Decide,
    ];

    /// The wire code, as `whoami` and the refusal body spell it.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::RaiseHazard => "raise_hazard",
            Self::ClearHazard => "clear_hazard",
            Self::CommitDocument => "commit_document",
            Self::Propose => "propose",
            Self::Decide => "decide",
        }
    }

    /// The deed in yard words, for the refusal sentence ("may not …").
    #[must_use]
    pub const fn deed(self) -> &'static str {
        match self {
            Self::Read => "read the hull",
            Self::RaiseHazard => "raise a field condition",
            Self::ClearHazard => "record a clearance",
            Self::CommitDocument => "commit or revert a document",
            Self::Propose => "propose a schedule change",
            Self::Decide => "answer for an option or an issue",
        }
    }

    /// The roles that hold this capability, in matrix order.
    #[must_use]
    pub fn holders(self) -> Vec<Role> {
        Role::ALL
            .into_iter()
            .filter(|role| role.capabilities().contains(&self))
            .collect()
    }
}

/// A role code the identity proxy may assert in `x-wadl-roles`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Role {
    /// The planner: documents, proposals, decisions.
    Planner,
    /// The ship superintendent: clearances, proposals, decisions.
    ShipSuper,
    /// Safety: the clearing authority.
    Safety,
    /// A zone manager.
    ZoneManager,
    /// A production superintendent.
    ProductionSuper,
    /// A foreman: raises what the crew finds.
    Foreman,
    /// The project manager: answers for issues, touches no hull document.
    ProjectManager,
    /// Read only.
    Reader,
}

impl Role {
    /// Every role, in matrix order.
    pub const ALL: [Self; 8] = [
        Self::Planner,
        Self::ShipSuper,
        Self::Safety,
        Self::ZoneManager,
        Self::ProductionSuper,
        Self::Foreman,
        Self::ProjectManager,
        Self::Reader,
    ];

    /// The wire code the proxy asserts and `whoami` echoes.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::Planner => "planner",
            Self::ShipSuper => "ship_super",
            Self::Safety => "safety",
            Self::ZoneManager => "zone_manager",
            Self::ProductionSuper => "production_super",
            Self::Foreman => "foreman",
            Self::ProjectManager => "project_manager",
            Self::Reader => "reader",
        }
    }

    /// The yard word, for sentences.
    #[must_use]
    pub const fn yard_word(self) -> &'static str {
        match self {
            Self::Planner => "Planner",
            Self::ShipSuper => "Ship Super",
            Self::Safety => "Safety",
            Self::ZoneManager => "Zone Manager",
            Self::ProductionSuper => "Production Super",
            Self::Foreman => "Foreman",
            Self::ProjectManager => "Project Manager",
            Self::Reader => "Reader",
        }
    }

    /// Parses a wire code; `None` for anything not in the table.
    #[must_use]
    pub fn parse(code: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|role| role.code() == code)
    }

    /// What this role may do beyond reading, from [`MATRIX`].
    #[must_use]
    pub fn capabilities(self) -> &'static [Capability] {
        MATRIX
            .iter()
            .find(|(role, _)| *role == self)
            .map_or(&[], |(_, caps)| *caps)
    }
}

/// The role → capability matrix the yard signs. `Read` is implicit and not
/// listed. To add a capability (S14's `sign_rule_table`, safety only): add
/// the variant, its code and deed, a row here for each holder, and its
/// routes to [`GATED`] — nothing else in the tree decides who may do what.
pub const MATRIX: &[(Role, &[Capability])] = &[
    (
        Role::Planner,
        &[
            Capability::RaiseHazard,
            Capability::CommitDocument,
            Capability::Propose,
            Capability::Decide,
        ],
    ),
    (
        Role::ShipSuper,
        &[
            Capability::RaiseHazard,
            Capability::ClearHazard,
            Capability::Propose,
            Capability::Decide,
        ],
    ),
    (
        Role::Safety,
        &[
            Capability::RaiseHazard,
            Capability::ClearHazard,
            Capability::Decide,
        ],
    ),
    (
        Role::ZoneManager,
        &[Capability::RaiseHazard, Capability::Decide],
    ),
    (
        Role::ProductionSuper,
        &[Capability::RaiseHazard, Capability::Decide],
    ),
    (Role::Foreman, &[Capability::RaiseHazard]),
    (Role::ProjectManager, &[Capability::Decide]),
    (Role::Reader, &[]),
];

/// The capabilities a set of roles holds together — `Read` always, then the
/// union of the matrix rows.
#[must_use]
pub fn capabilities_of(roles: &[Role]) -> BTreeSet<Capability> {
    let mut caps = BTreeSet::from([Capability::Read]);
    for role in roles {
        caps.extend(role.capabilities().iter().copied());
    }
    caps
}

/// Every capability — what the dev shim grants when no roles are asserted.
#[must_use]
pub fn every_capability() -> BTreeSet<Capability> {
    Capability::ALL.into_iter().collect()
}

/// The matrix as `whoami` serves it: role code → capability codes.
#[must_use]
pub fn matrix_json() -> Value {
    let mut out = serde_json::Map::new();
    for (role, caps) in MATRIX {
        let codes: Vec<&str> = caps.iter().map(|c| c.code()).collect();
        out.insert(role.code().to_owned(), json!(codes));
    }
    Value::Object(out)
}

/// Joins yard words as a sentence would: `A`, `A and B`, `A, B and C`.
fn join_words(words: &[&str]) -> String {
    match words.split_last() {
        None => String::new(),
        Some((last, [])) => (*last).to_owned(),
        Some((last, rest)) => format!("{} and {last}", rest.join(", ")),
    }
}

/// The refusal in yard words: who the caller is, what they may not do, and
/// who may. `"Foreman may not record a clearance — clear_hazard is held by
/// Safety and Ship Super"`.
#[must_use]
pub fn refusal_sentence(roles: &[Role], capability: Capability) -> String {
    let who = if roles.is_empty() {
        "A person with no recognised role".to_owned()
    } else {
        let words: Vec<&str> = roles.iter().map(|r| r.yard_word()).collect();
        join_words(&words)
    };
    let holders: Vec<&str> = capability
        .holders()
        .into_iter()
        .map(Role::yard_word)
        .collect();
    let held_by = if holders.is_empty() {
        "held by nobody".to_owned()
    } else {
        format!("held by {}", join_words(&holders))
    };
    format!(
        "{who} may not {} — {} is {held_by}",
        capability.deed(),
        capability.code()
    )
}

/// The write routes and the capability each needs. Paths are the router's
/// patterns (axum `:param` syntax), matched against `MatchedPath` in the
/// gate. Every POST in `routes::inventory` must appear here or in
/// [`FREE_POSTS`]; a unit test holds the line.
pub const GATED: &[(&str, &str, Capability)] = &[
    ("POST", "/api/vessels/:id/hazards", Capability::RaiseHazard),
    (
        "POST",
        "/api/vessels/:id/hazards/import",
        Capability::RaiseHazard,
    ),
    (
        "POST",
        "/api/vessels/:id/hazards/clear",
        Capability::ClearHazard,
    ),
    (
        "POST",
        "/api/vessels/:id/compartments/:no/decision",
        Capability::Decide,
    ),
    (
        "POST",
        "/api/vessels/:id/issues/acknowledge",
        Capability::Decide,
    ),
    (
        "POST",
        "/api/vessels/:id/schedule-proposals",
        Capability::Propose,
    ),
    (
        "POST",
        "/api/vessels/:id/schedule-proposals/withdraw",
        Capability::Propose,
    ),
    (
        "POST",
        "/api/vessels/:id/register",
        Capability::CommitDocument,
    ),
    (
        "POST",
        "/api/vessels/:id/register/revert",
        Capability::CommitDocument,
    ),
    (
        "POST",
        "/api/vessels/:id/couplings",
        Capability::CommitDocument,
    ),
    (
        "POST",
        "/api/vessels/:id/couplings/revert",
        Capability::CommitDocument,
    ),
    ("POST", "/api/vessels/:id/zones", Capability::CommitDocument),
    (
        "POST",
        "/api/vessels/:id/zones/revert",
        Capability::CommitDocument,
    ),
    (
        "POST",
        "/api/vessels/:id/geometry",
        Capability::CommitDocument,
    ),
    (
        "POST",
        "/api/vessels/:id/geometry/revert",
        Capability::CommitDocument,
    ),
    (
        "POST",
        "/api/vessels/:id/schedule-of-record",
        Capability::CommitDocument,
    ),
    (
        "POST",
        "/api/vessels/:id/schedule-of-record/revert",
        Capability::CommitDocument,
    ),
    (
        "POST",
        "/api/vessels/:id/manning-book",
        Capability::CommitDocument,
    ),
    (
        "POST",
        "/api/vessels/:id/manning-book/revert",
        Capability::CommitDocument,
    ),
    (
        "POST",
        "/api/vessels/:id/budget-book",
        Capability::CommitDocument,
    ),
    (
        "POST",
        "/api/vessels/:id/budget-book/revert",
        Capability::CommitDocument,
    ),
    (
        "POST",
        "/api/vessels/:id/yard-clock",
        Capability::CommitDocument,
    ),
    (
        "POST",
        "/api/vessels/:id/yard-clock/revert",
        Capability::CommitDocument,
    ),
];

/// POST routes deliberately open to every authenticated caller. Empty today;
/// a new POST goes here or in [`GATED`], and the test says which.
pub const FREE_POSTS: &[&str] = &[];

/// The capability a `(method, matched path)` pair needs, if it is gated.
#[must_use]
pub fn capability_for(method: &str, path: &str) -> Option<Capability> {
    GATED
        .iter()
        .find(|(m, p, _)| *m == method && *p == path)
        .map(|(_, _, cap)| *cap)
}

/// Whether the query string carries `dry_run=true` — the preview nobody is
/// refused. Parsed by hand: the handler's `Query<DryRun>` runs later, and a
/// gate that depended on it would judge after the body was read.
fn is_dry_run(query: Option<&str>) -> bool {
    query
        .unwrap_or("")
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .any(|(key, value)| key == "dry_run" && value == "true")
}

/// The hull id in a `/api/vessels/:id/...` path, if it parses.
fn hull_in_path(path: &str) -> Option<VesselId> {
    let mut segments = path.split('/').filter(|s| !s.is_empty());
    segments.find(|s| *s == "vessels")?;
    segments
        .next()?
        .parse::<Uuid>()
        .ok()
        .map(VesselId::from_uuid)
}

/// Judges one request against the matrix. `None` means pass through — the
/// route is not gated, it is a dry run, identity failed (the handler will
/// refuse it), the hull is outside the caller's assignment (the handler will
/// not find it), or the capability is held.
fn refusal(
    method: &str,
    matched: &str,
    path: &str,
    query: Option<&str>,
    caller: Result<Caller, ApiError>,
) -> Option<ApiError> {
    let capability = capability_for(method, matched)?;
    if is_dry_run(query) {
        return None;
    }
    let caller = caller.ok()?;
    let hull = hull_in_path(path)?;
    if !caller.scope.is_assigned(hull) || caller.capabilities.contains(&capability) {
        return None;
    }
    Some(ApiError::Forbidden {
        detail: refusal_sentence(&caller.roles, capability),
        capability: capability.code(),
        roles: caller.roles.iter().map(|r| r.code().to_owned()).collect(),
    })
}

/// The capability gate, applied with `Router::route_layer` in `build_router`
/// so `MatchedPath` names the route pattern the request hit.
pub(crate) async fn gate(matched: MatchedPath, req: Request, next: Next) -> Response {
    let caller = auth::resolve(req.headers(), auth::env());
    let refused = refusal(
        req.method().as_str(),
        matched.as_str(),
        req.uri().path(),
        req.uri().query(),
        caller,
    );
    match refused {
        Some(err) => err.into_response(),
        None => next.run(req).await,
    }
}

/// `GET /api/whoami` — the caller as the server resolved them: tenant,
/// hulls, person, roles, capabilities, the matrix itself, any warnings the
/// resolution raised, and the handling markings the shell must wear. Serves
/// the outcome of the trust boundary rather than echoing headers, so a proxy
/// configuration is verifiable end to end with one curl, and the shell shows
/// doors a caller can open instead of doors that exist.
pub(crate) async fn whoami(State(state): State<AppState>, caller: Caller) -> Json<Value> {
    let hulls = state.store.list_vessels(&caller.scope).await;
    let scope = &caller.scope;
    Json(json!({
        "identity_mode": auth::identity_mode(),
        "org": scope.org.to_string(),
        "assigned_vessels": scope
            .assigned_vessels
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>(),
        "person": {
            "id": scope.actor.id,
            "name": scope.actor.name,
            "source": scope.actor.source,
        },
        "roles": caller.roles.iter().map(|r| r.code()).collect::<Vec<_>>(),
        "capabilities": caller.capabilities.iter().map(|c| c.code()).collect::<Vec<_>>(),
        "hulls": hulls,
        "role_matrix": matrix_json(),
        "warnings": caller.warnings,
        "markings": auth::env().markings,
        "decision_support_only": true,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    #[test]
    fn every_post_route_in_the_inventory_is_gated_or_named_free() {
        for route in crate::routes::inventory() {
            if route.method != "POST" {
                continue;
            }
            let placed =
                capability_for("POST", route.path).is_some() || FREE_POSTS.contains(&route.path);
            assert!(
                placed,
                "POST {} is neither in roles::GATED nor roles::FREE_POSTS — place it",
                route.path
            );
        }
        // And the gate table names no route the router does not have.
        let inventory = crate::routes::inventory();
        for (method, path, _) in GATED {
            assert!(
                inventory
                    .iter()
                    .any(|r| r.method == *method && r.path == *path),
                "{method} {path} is gated but not in the route inventory"
            );
        }
    }

    #[test]
    fn no_role_holds_every_capability_and_reader_holds_none() {
        let all = every_capability();
        for role in Role::ALL {
            assert_ne!(
                capabilities_of(&[role]),
                all,
                "{} would hold every capability",
                role.yard_word()
            );
        }
        assert_eq!(
            capabilities_of(&[Role::Reader]),
            BTreeSet::from([Capability::Read])
        );
        assert_eq!(
            Capability::ClearHazard.holders(),
            vec![Role::ShipSuper, Role::Safety]
        );
        for role in Role::ALL {
            assert_eq!(Role::parse(role.code()), Some(role));
        }
        assert_eq!(Role::parse("welder"), None);
    }

    #[test]
    fn the_refusal_names_the_role_the_deed_and_who_holds_it() {
        assert_eq!(
            refusal_sentence(&[Role::Foreman], Capability::ClearHazard),
            "Foreman may not record a clearance — clear_hazard is held by Ship Super and Safety"
        );
        assert_eq!(
            refusal_sentence(&[Role::Foreman, Role::Reader], Capability::CommitDocument),
            "Foreman and Reader may not commit or revert a document — commit_document is held by Planner"
        );
        assert_eq!(
            refusal_sentence(&[], Capability::Decide),
            "A person with no recognised role may not answer for an option or an issue — decide is held by Planner, Ship Super, Safety, Zone Manager, Production Super and Project Manager"
        );
    }

    #[test]
    fn a_dry_run_passes_the_gate() {
        assert!(is_dry_run(Some("dry_run=true")));
        assert!(is_dry_run(Some("as_of=1&dry_run=true")));
        assert!(!is_dry_run(Some("dry_run=false")));
        assert!(!is_dry_run(Some("dry_run=1")));
        assert!(!is_dry_run(None));
        let reader = auth::resolve(
            &headers(&[
                ("x-org-id", "00000000-0000-0000-0000-000000000001"),
                ("x-assigned-vessels", "00000000-0000-0000-0000-000000000073"),
                ("x-wadl-roles", "reader"),
            ]),
            &auth::Env::dev(),
        );
        let path = "/api/vessels/00000000-0000-0000-0000-000000000073/register";
        let matched = "/api/vessels/:id/register";
        assert!(refusal("POST", matched, path, Some("dry_run=true"), reader).is_none());
    }

    fn headers(pairs: &[(&str, &str)]) -> axum::http::HeaderMap {
        let mut h = axum::http::HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                v.parse().unwrap(),
            );
        }
        h
    }

    async fn post(path: &str, extra: &[(&str, &str)], body: &str) -> (StatusCode, Value) {
        let (app, world) = crate::demo_app();
        let mut req = Request::builder()
            .method("POST")
            .uri(path)
            .header("x-org-id", world.yard_org.as_uuid().to_string())
            .header("x-assigned-vessels", world.cvn73.as_uuid().to_string())
            .header("content-type", "application/json");
        for (k, v) in extra {
            req = req.header(*k, *v);
        }
        let res = app
            .oneshot(req.body(Body::from(body.to_owned())).unwrap())
            .await
            .unwrap();
        let status = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    /// Drives the real router: the gate sees `MatchedPath` under
    /// `route_layer` on this axum version (the risk the packet names), refuses
    /// a reader at a door with a 403 that names the capability, lets the
    /// handler's 404 come first on a foreign hull, and lets the extractor's
    /// 401 come first with no org.
    #[tokio::test]
    async fn the_gate_sees_the_matched_path_on_every_gated_route() {
        let (_, world) = crate::demo_app();
        let hull = world.cvn73.as_uuid().to_string();
        let body = r#"{"compartment":"3-148-2-E","kind":"energised_bus","basis":"test"}"#;

        let (status, problem) = post(
            &format!("/api/vessels/{hull}/hazards/clear"),
            &[("x-wadl-roles", "reader")],
            body,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(problem["title"], "forbidden");
        assert_eq!(problem["capability"], "clear_hazard");
        assert_eq!(problem["roles"], json!(["reader"]));
        assert_eq!(
            problem["detail"],
            "Reader may not record a clearance — clear_hazard is held by Ship Super and Safety"
        );

        // Every gated route refuses the reader the same way.
        for (method, pattern, cap) in GATED {
            assert_eq!(*method, "POST");
            let path = pattern.replace(":id", &hull).replace(":no", "4-141-0-C");
            let (status, problem) = post(&path, &[("x-wadl-roles", "reader")], "{}").await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{pattern}");
            assert_eq!(problem["capability"], cap.code(), "{pattern}");
        }

        // A foreign hull is not found before any capability is judged.
        let foreign = world.navy_hull.as_uuid().to_string();
        let (status, _) = post(
            &format!("/api/vessels/{foreign}/hazards/clear"),
            &[("x-wadl-roles", "reader")],
            body,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // No org: the extractor's 401, not the gate's 403.
        let (app, _) = crate::demo_app();
        let req = Request::builder()
            .method("POST")
            .uri(format!("/api/vessels/{hull}/hazards/clear"))
            .header("x-wadl-roles", "reader")
            .header("content-type", "application/json")
            .body(Body::from(body))
            .unwrap();
        assert_eq!(
            app.oneshot(req).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
    }
}
