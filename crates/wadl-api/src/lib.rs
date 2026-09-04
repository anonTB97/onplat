//! The HTTP surface for Shipyard AI Onboard.
//!
//! Thin by policy: handlers resolve a [`wadl_store::TenantScope`], call the
//! store or the decision engine, and shape the result. The two invariants that
//! matter most here are enforced structurally — every scoped handler runs the
//! [`auth`] extractor first, so no tenant data is touched without a scope, and
//! authorization state is read *through* [`wadl_engine`], never computed in a
//! handler.

#![forbid(unsafe_code)]
#![allow(clippy::doc_markdown)]
#![cfg_attr(
    test,
    allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing,
        clippy::float_arithmetic
    )
)]

pub mod auth;
pub mod documents;
mod error;
mod handlers;
pub mod hardening;
pub mod routes;
pub mod schedule;
pub mod yard_clock;

use std::sync::Arc;

use axum::routing::{get, post};
use axum::Router;

use wadl_domain::Clock;
use wadl_store::clock::SystemClock;
use wadl_store::memory::DemoWorld;
use wadl_store::{InMemoryStore, Repositories};

/// Shared application state. Cloned per request; the `Arc`s are cheap.
#[derive(Clone)]
pub struct AppState {
    /// The repository seam.
    pub store: Arc<dyn Repositories>,
    /// The injected clock — production wiring passes [`SystemClock`].
    pub clock: Arc<dyn Clock>,
}

impl AppState {
    /// Builds state from a store and a clock.
    #[must_use]
    pub fn new(store: Arc<dyn Repositories>, clock: Arc<dyn Clock>) -> Self {
        Self { store, clock }
    }
}

/// Builds the router. The registered routes match [`routes::inventory`].
// A route table, one line per route: its length is the API's size, and
// splitting it would hide the inventory the leak tests and the SSP are
// generated from.
#[allow(clippy::too_many_lines)]
pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(handlers::health))
        .route("/api/whoami", get(handlers::whoami))
        .route("/api/vessels", get(handlers::list_vessels))
        .route("/api/vessels/:id", get(handlers::get_vessel))
        .route(
            "/api/vessels/:id/compartments",
            get(handlers::list_compartments),
        )
        .route(
            "/api/vessels/:id/work-orders",
            get(handlers::list_work_orders),
        )
        .route(
            "/api/vessels/:id/activities",
            get(handlers::list_activities),
        )
        .route(
            "/api/vessels/:id/schedule-alternatives",
            get(handlers::schedule_alternatives),
        )
        .route(
            "/api/vessels/:id/work-conflicts",
            get(handlers::work_conflicts),
        )
        .route(
            "/api/vessels/:id/stranded-hours",
            get(handlers::stranded_hours),
        )
        .route("/api/vessels/:id/timeframe", get(handlers::timeframe))
        .route(
            "/api/vessels/:id/compartments/:no/state",
            get(handlers::compartment_state),
        )
        .route("/api/vessels/:id/decks", get(handlers::list_decks))
        .route("/api/vessels/:id/deck-states", get(handlers::deck_states))
        .route("/api/vessels/:id/readiness", get(handlers::readiness))
        .route(
            "/api/vessels/:id/compartments/:no/mitigations",
            get(handlers::mitigations),
        )
        .route("/api/vessels/:id/leverage", get(handlers::leverage))
        .route("/api/vessels/:id/issues", get(handlers::issues))
        .route(
            "/api/vessels/:id/issues/acknowledge",
            post(handlers::acknowledge_issue),
        )
        .route("/api/vessels/:id/ledger", get(handlers::ledger))
        .route(
            "/api/vessels/:id/hazards",
            get(handlers::list_hazards).post(handlers::raise_hazard),
        )
        .route(
            "/api/vessels/:id/hazards/clear",
            post(handlers::clear_hazard),
        )
        .route(
            "/api/vessels/:id/zones",
            get(handlers::zones).post(handlers::import_zones),
        )
        .route(
            "/api/vessels/:id/zones/revert",
            post(handlers::revert_zones),
        )
        .route(
            "/api/vessels/:id/zones/:zone/adjacent",
            get(handlers::zone_adjacent),
        )
        .route(
            "/api/vessels/:id/budget-book",
            post(handlers::import_budgets),
        )
        .route(
            "/api/vessels/:id/budget-book/revert",
            post(handlers::revert_budgets),
        )
        .route(
            "/api/vessels/:id/manning-book",
            get(handlers::get_manning).post(handlers::import_manning),
        )
        .route(
            "/api/vessels/:id/manning-book/revert",
            post(handlers::revert_manning),
        )
        .route(
            "/api/vessels/:id/geometry",
            get(handlers::get_geometry).post(handlers::import_geometry),
        )
        .route(
            "/api/vessels/:id/geometry/revert",
            post(handlers::revert_geometry),
        )
        .route(
            "/api/vessels/:id/register",
            get(handlers::get_register).post(handlers::import_register),
        )
        .route(
            "/api/vessels/:id/register/revert",
            post(handlers::revert_register),
        )
        .route(
            "/api/vessels/:id/couplings",
            get(handlers::get_couplings).post(handlers::import_couplings),
        )
        .route(
            "/api/vessels/:id/couplings/revert",
            post(handlers::revert_couplings),
        )
        .route(
            "/api/vessels/:id/hazards/import",
            post(handlers::import_hazard_log),
        )
        .route(
            "/api/vessels/:id/schedule-of-record",
            post(handlers::import_schedule),
        )
        .route(
            "/api/vessels/:id/schedule-of-record/revert",
            post(handlers::revert_schedule),
        )
        .route(
            "/api/vessels/:id/yard-clock",
            get(yard_clock::get_yard_clock).post(yard_clock::import_yard_clock),
        )
        .route(
            "/api/vessels/:id/yard-clock/revert",
            post(yard_clock::revert_yard_clock),
        )
        .route(
            "/api/vessels/:id/schedule-proposals",
            get(handlers::list_schedule_proposals).post(handlers::propose_schedule_change),
        )
        .route(
            "/api/vessels/:id/schedule-proposals/withdraw",
            post(handlers::withdraw_schedule_proposal),
        )
        .route(
            "/api/vessels/:id/compartments/:no/decision",
            post(handlers::record_decision),
        )
        .route("/api/vessels/:id/packages", get(handlers::list_packages))
        .route("/api/vessels/:id/packages/:no", get(handlers::get_package))
        .with_state(state)
}

/// The largest document an import door accepts. Sized for a full multi-year
/// P6 XER export with generous headroom, and still small enough that a
/// mistaken upload cannot exhaust the host.
///
/// Deliberately NOT installed as a router-wide `DefaultBodyLimit`: that would
/// raise the ceiling on every small POST (`/issues/acknowledge`,
/// `/decision`), and — worse — a body extractor runs before the handler body,
/// so the megabytes would be buffered and parsed before the scope check ever
/// ran. Instead the three import handlers read their bodies by hand, after
/// the scope check, against this ceiling; every other route keeps axum's
/// small default.
pub const MAX_IMPORT_BYTES: usize = 256 * 1024 * 1024;

/// Builds a router and state over the seeded demo world, returning the world's
/// identifiers too. Used by the server binary's demo mode and by the leak test.
///
/// The world is anchored on the clock rather than on a fixed date, so the demo's
/// story is current for whoever is reading it: the coat is part-way through its
/// cure *now*, not in a May that has already passed. [`InMemoryStore::demo`] keeps
/// the fixed anchor for tests that need byte-stable instants.
pub fn demo_app() -> (Router, DemoWorld) {
    let clock = SystemClock;
    let (store, world) = InMemoryStore::demo_at(clock.now());
    let state = AppState::new(Arc::new(store), Arc::new(clock));
    (build_router(state), world)
}
