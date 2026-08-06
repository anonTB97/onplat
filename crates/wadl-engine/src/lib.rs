//! The WADL decision engine — the load-bearing core of the platform.
//!
//! # Why this crate is shaped the way it is
//!
//! A suspension must commit in the same database transaction as the hazard that
//! caused it, and the field client must reach the *same* decision as the server
//! while offline. Both follow from one rule: **the engine is a pure library,
//! not a service.** So this crate has no I/O, no async, and no time source. It
//! is handed its inputs — the adjacency graph, the open hazards, the rules as
//! data, and the evaluation instant — and it returns a decision and a trace. It
//! compiles to native for the server, to `wasm32-unknown-unknown` for the
//! browser, and via UniFFI for mobile, so every surface runs identical code.
//!
//! # Milestone 1 status
//!
//! The rule *engine* proper is milestone 3. What is real here today is the
//! **seam**: [`DecisionState`], the coupling model, and the hop-bounded,
//! direction-respecting [`traversal`] that every hazard cascade rule will build
//! on. [`evaluate`] wires them together and returns a decision whose final
//! state is, for now, driven by the seeded rule data passed in — but the
//! traversal underneath it is the genuine algorithm, and it is property-tested.
//! The shell reads compartment authorization state *through this crate's types*
//! from day one, so linking the real rule evaluation in later is a change here,
//! not a restructuring everywhere.

#![forbid(unsafe_code)]
// See wadl-domain: doc_markdown fires on domain acronyms; allowed deliberately.
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

pub mod coupling;
pub mod decision;
pub mod evaluate;
pub mod traversal;

pub use coupling::{AdjacencyGraph, CouplingEdge, Direction, Propagation};
pub use decision::DecisionState;
pub use evaluate::{evaluate, Decision, EvaluationRequest, Hazard, HazardKind, TraceStep};
pub use traversal::{CascadeHit, TraversalBound};
