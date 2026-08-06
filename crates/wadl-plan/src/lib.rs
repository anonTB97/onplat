//! Planning derivations for Shipyard AI Onboard.
//!
//! Pure, like [`wadl_engine`]: no I/O, no async, no clock. Where the engine
//! answers *may this work proceed*, this crate answers *what is this work
//! holding* — segment topology, testability, and stranded man-hours.
//!
//! Kept separate from the store for one reason: **stranded man-hours is the most
//! persuasive number in the product**, and a number that argues for re-sequencing
//! a warship's availability should be computed somewhere it can be
//! property-tested in isolation, not inside a SQL layer.
//!
//! # What "stranded" means
//!
//! A distributed package's segments form a network. A segment cannot be tested
//! until it *and everything upstream of it* is complete. So man-hours sitting in
//! a finished branch are stranded by an unfinished trunk — hours that are **not
//! in the compartment causing the problem**. Those are the hours worth moving
//! crew for, and [`package::Analysis`] surfaces them per compartment.

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

pub mod governing;
pub mod package;

pub use governing::{governing_constraint, ConstraintKind, GoverningConstraint};
pub use package::{Analysis, Package, Segment, SegmentStatus, SpaceWork, Stranding, TopologyFault};
