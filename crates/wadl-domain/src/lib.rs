//! Shared domain vocabulary for Shipyard AI Onboard + WADL.
//!
//! This crate is pure: no I/O, no async, no time source beyond the injected
//! [`Clock`] trait. It is depended on by both the decision engine and the
//! persistence layer, so anything expensive to get wrong — an identifier that
//! could be confused for another, a quantity without a unit, an illegal permit
//! transition — is made unrepresentable here rather than guarded at call sites.
//!
//! Two disciplines run through every module:
//!
//! * **Newtype every identifier and every unit.** A function that took two bare
//!   `Uuid`s, or a bare `i32` of "hours", is a defect waiting for a tired
//!   planner. See [`ids`] and [`units`].
//! * **Make the illegal unrepresentable.** The permit lifecycle is a typestate
//!   ([`permit`]); an illegal transition does not compile.

#![forbid(unsafe_code)]
// doc_markdown fires on this domain's own vocabulary — NAVSEA, MIL-STD, P6,
// UUIDv7, snake_case DB columns — where backticking every term hurts
// readability more than it helps. Rust items are still backticked in prose.
#![allow(clippy::doc_markdown)]
// Tests trade the production lint discipline for brevity: unwrap/expect/panic
// and indexing are acceptable in a test where a failure IS the assertion.
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

pub mod capability;
pub mod compartment;
pub mod ids;
pub mod permit;
pub mod time;
pub mod units;

pub use capability::Capability;
pub use compartment::{CompartmentNo, UsnCompartment};
pub use time::{Clock, TestClock, Timestamp};
