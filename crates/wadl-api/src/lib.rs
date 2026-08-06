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

mod auth;
mod error;
mod handlers;
pub mod routes;

use std::sync::Arc;

use axum::routing::get;
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
pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(handlers::health))
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
            "/api/vessels/:id/stranded-hours",
            get(handlers::stranded_hours),
        )
        .route(
            "/api/vessels/:id/compartments/:no/state",
            get(handlers::compartment_state),
        )
        .with_state(state)
}

/// Builds a router and state over the seeded demo world, returning the world's
/// identifiers too. Used by the server binary's demo mode and by the leak test.
pub fn demo_app() -> (Router, DemoWorld) {
    let (store, world) = InMemoryStore::demo();
    let state = AppState::new(Arc::new(store), Arc::new(SystemClock));
    (build_router(state), world)
}
