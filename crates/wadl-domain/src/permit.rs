//! The permit lifecycle as a compile-time typestate.
//!
//! A permit authorizes hot work on a warship. The set of *legal* transitions
//! between its states is safety-critical, so it is encoded in the type system:
//! [`Permit<Draft>`], [`Permit<Approved>`], [`Permit<Active>`], and so on are
//! distinct types, and a transition method exists only on the state it is legal
//! from. Approving a draft, or activating a rejected permit, is not a runtime
//! error to be caught — it fails to compile.
//!
//! Persistence stores a flat [`PermitStatus`]. [`AnyPermit`] bridges the two:
//! the store reconstitutes the correctly-typed permit from a row via
//! [`AnyPermit::from_parts`], and in-process code then transitions it with the
//! compiler watching.
//!
//! This module models the *shape* of the lifecycle. It deliberately does **not**
//! decide whether an approval may proceed: rule R20 (no approval past a live
//! BLOCK) is an engine + authorization concern, evaluated against live decision
//! state, not expressible as a static edge.

use core::marker::PhantomData;

use crate::ids::{AvailabilityId, PermitId, PersonId, VesselId, WorkOrderId};
use crate::time::Timestamp;

/// The flat lifecycle status, mirroring the `permit_status` SQL enum. This is
/// the persisted form; in-process code prefers the typestate below.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermitStatus {
    /// Being prepared by the raiser.
    Draft,
    /// Submitted, not yet routed.
    Submitted,
    /// Awaiting the group-foreman approval node.
    PendingGf,
    /// Awaiting the foreman / fire-marshal approval node.
    PendingFm,
    /// Approved, not yet started.
    Approved,
    /// Work in progress under a live authorization.
    Active,
    /// Suspended by a hazard cascade or stop-work; re-check required to resume.
    Suspended,
    /// Held pending a condition (e.g. an ITP hold point).
    Hold,
    /// Refused at an approval node.
    Rejected,
    /// Withdrawn by the raiser before approval.
    Withdrawn,
    /// Work finished, pending close-out.
    Complete,
    /// Closed out; terminal.
    Closed,
}

/// A bounded, explicitly-ended work window. Never optional on a permit: a
/// permit without a window is not a domain state worth representing (REQ-008/
/// 019/045).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PermitWindow {
    /// The calendar date the window falls on.
    pub permit_date: chrono_date::NaiveDateStr,
    /// The shift code, e.g. `D` / `S` / `M`.
    pub shift_code: String,
    /// Start instant.
    pub starts_at: Timestamp,
    /// End instant — always present and always after `starts_at`.
    pub ends_at: Timestamp,
}

// A minimal date-as-string holder keeps this crate free of a date library while
// still refusing to let the calendar date be confused with a wall-clock
// instant. The store maps this to a SQL `date`.
mod chrono_date {
    /// An ISO-8601 calendar date (`YYYY-MM-DD`) as an opaque string.
    #[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
    #[serde(transparent)]
    pub struct NaiveDateStr(String);

    impl NaiveDateStr {
        /// Wraps an ISO date string.
        #[must_use]
        pub fn new(iso: impl Into<String>) -> Self {
            Self(iso.into())
        }

        /// The ISO date string.
        #[must_use]
        pub fn as_str(&self) -> &str {
            &self.0
        }
    }
}

pub use chrono_date::NaiveDateStr;

/// The state-independent contents of a permit. The typestate wraps this; the
/// data does not change shape as the permit moves through its lifecycle.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PermitCore {
    /// Primary key.
    pub permit_id: PermitId,
    /// The hull this permit is scoped to.
    pub vessel_id: VesselId,
    /// The availability, if the permit is tied to one.
    pub availability_id: Option<AvailabilityId>,
    /// The work order, if the permit is tied to one.
    pub work_order_id: Option<WorkOrderId>,
    /// The permit code, e.g. `HW-1043`.
    pub code: String,
    /// The kind of work, e.g. `hot_work`.
    pub work_type: String,
    /// The bounded work window.
    pub window: PermitWindow,
    /// Who raised the permit.
    pub raised_by: PersonId,
}

/// Sealed so the set of lifecycle states is closed to this crate.
mod sealed {
    pub trait Sealed {}
}

/// A permit lifecycle state marker.
pub trait PermitState: sealed::Sealed {
    /// The persisted status this marker corresponds to.
    const STATUS: PermitStatus;
}

/// Declares a zero-sized state marker and its persisted status.
macro_rules! permit_state {
    ($(#[$meta:meta])* $name:ident => $status:expr) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub struct $name;
        impl sealed::Sealed for $name {}
        impl PermitState for $name {
            const STATUS: PermitStatus = $status;
        }
    };
}

permit_state!(
    /// Being prepared by the raiser.
    Draft => PermitStatus::Draft
);
permit_state!(
    /// Submitted, not yet routed.
    Submitted => PermitStatus::Submitted
);
permit_state!(
    /// Awaiting the group-foreman node.
    PendingGf => PermitStatus::PendingGf
);
permit_state!(
    /// Awaiting the foreman / fire-marshal node.
    PendingFm => PermitStatus::PendingFm
);
permit_state!(
    /// Approved, not yet started.
    Approved => PermitStatus::Approved
);
permit_state!(
    /// Work in progress.
    Active => PermitStatus::Active
);
permit_state!(
    /// Suspended; re-check required to resume.
    Suspended => PermitStatus::Suspended
);
permit_state!(
    /// Held pending a condition.
    Hold => PermitStatus::Hold
);
permit_state!(
    /// Refused at an approval node; terminal.
    Rejected => PermitStatus::Rejected
);
permit_state!(
    /// Withdrawn before approval; terminal.
    Withdrawn => PermitStatus::Withdrawn
);
permit_state!(
    /// Work finished, pending close-out.
    Complete => PermitStatus::Complete
);
permit_state!(
    /// Closed out; terminal.
    Closed => PermitStatus::Closed
);

/// A permit in a statically-known lifecycle state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Permit<S: PermitState> {
    core: PermitCore,
    _state: PhantomData<S>,
}

impl<S: PermitState> Permit<S> {
    /// The state-independent contents.
    #[must_use]
    pub fn core(&self) -> &PermitCore {
        &self.core
    }

    /// The persisted status of this permit's current state.
    #[must_use]
    pub fn status(&self) -> PermitStatus {
        S::STATUS
    }

    fn transition<T: PermitState>(self) -> Permit<T> {
        Permit {
            core: self.core,
            _state: PhantomData,
        }
    }
}

impl Permit<Draft> {
    /// Opens a fresh permit in `Draft`.
    #[must_use]
    pub fn new(core: PermitCore) -> Self {
        Self {
            core,
            _state: PhantomData,
        }
    }

    /// Submits the draft for routing.
    #[must_use]
    pub fn submit(self) -> Permit<Submitted> {
        self.transition()
    }

    /// Withdraws the draft.
    #[must_use]
    pub fn withdraw(self) -> Permit<Withdrawn> {
        self.transition()
    }
}

impl Permit<Submitted> {
    /// Routes to the group-foreman approval node.
    #[must_use]
    pub fn route_to_gf(self) -> Permit<PendingGf> {
        self.transition()
    }

    /// Withdraws before approval.
    #[must_use]
    pub fn withdraw(self) -> Permit<Withdrawn> {
        self.transition()
    }
}

impl Permit<PendingGf> {
    /// Group-foreman approves; routes to the foreman / fire-marshal node.
    #[must_use]
    pub fn approve_gf(self) -> Permit<PendingFm> {
        self.transition()
    }

    /// Refused at this node.
    #[must_use]
    pub fn reject(self) -> Permit<Rejected> {
        self.transition()
    }

    /// Withdrawn before approval.
    #[must_use]
    pub fn withdraw(self) -> Permit<Withdrawn> {
        self.transition()
    }
}

impl Permit<PendingFm> {
    /// Foreman / fire-marshal approves.
    #[must_use]
    pub fn approve_fm(self) -> Permit<Approved> {
        self.transition()
    }

    /// Refused at this node.
    #[must_use]
    pub fn reject(self) -> Permit<Rejected> {
        self.transition()
    }

    /// Withdrawn before approval.
    #[must_use]
    pub fn withdraw(self) -> Permit<Withdrawn> {
        self.transition()
    }
}

impl Permit<Approved> {
    /// Work begins on this shift.
    #[must_use]
    pub fn activate(self) -> Permit<Active> {
        self.transition()
    }

    /// The shift boundary is reached and work never started (rule R16): an
    /// unstarted permit completes rather than suspends.
    #[must_use]
    pub fn complete_unstarted(self) -> Permit<Complete> {
        self.transition()
    }
}

impl Permit<Active> {
    /// A hazard cascade or stop-work suspends live work (rules R04/R06/R17/R22),
    /// or the shift boundary is reached with work in progress (rule R16).
    #[must_use]
    pub fn suspend(self) -> Permit<Suspended> {
        self.transition()
    }

    /// Placed on hold pending a condition (e.g. an open ITP hold point).
    #[must_use]
    pub fn place_on_hold(self) -> Permit<Hold> {
        self.transition()
    }

    /// Work finished.
    #[must_use]
    pub fn complete(self) -> Permit<Complete> {
        self.transition()
    }
}

impl Permit<Suspended> {
    /// The suspending condition clears and the engine re-checks (never a replay
    /// of the old grant): work may resume.
    #[must_use]
    pub fn resume(self) -> Permit<Active> {
        self.transition()
    }

    /// The permit is completed out of suspension rather than resumed.
    #[must_use]
    pub fn complete(self) -> Permit<Complete> {
        self.transition()
    }
}

impl Permit<Hold> {
    /// The hold condition clears: work may resume.
    #[must_use]
    pub fn release(self) -> Permit<Active> {
        self.transition()
    }
}

impl Permit<Complete> {
    /// Closes the permit out; terminal.
    #[must_use]
    pub fn close(self) -> Permit<Closed> {
        self.transition()
    }
}

/// A permit whose state is only known at runtime — the form the store hands out
/// after reading a row, and before code narrows it to a specific typestate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AnyPermit {
    /// See [`Draft`].
    Draft(Permit<Draft>),
    /// See [`Submitted`].
    Submitted(Permit<Submitted>),
    /// See [`PendingGf`].
    PendingGf(Permit<PendingGf>),
    /// See [`PendingFm`].
    PendingFm(Permit<PendingFm>),
    /// See [`Approved`].
    Approved(Permit<Approved>),
    /// See [`Active`].
    Active(Permit<Active>),
    /// See [`Suspended`].
    Suspended(Permit<Suspended>),
    /// See [`Hold`].
    Hold(Permit<Hold>),
    /// See [`Rejected`].
    Rejected(Permit<Rejected>),
    /// See [`Withdrawn`].
    Withdrawn(Permit<Withdrawn>),
    /// See [`Complete`].
    Complete(Permit<Complete>),
    /// See [`Closed`].
    Closed(Permit<Closed>),
}

impl AnyPermit {
    /// Reconstitutes a typed permit from a persisted `(core, status)` pair.
    #[must_use]
    pub fn from_parts(core: PermitCore, status: PermitStatus) -> Self {
        fn wrap<S: PermitState>(core: PermitCore) -> Permit<S> {
            Permit {
                core,
                _state: PhantomData,
            }
        }
        match status {
            PermitStatus::Draft => Self::Draft(wrap(core)),
            PermitStatus::Submitted => Self::Submitted(wrap(core)),
            PermitStatus::PendingGf => Self::PendingGf(wrap(core)),
            PermitStatus::PendingFm => Self::PendingFm(wrap(core)),
            PermitStatus::Approved => Self::Approved(wrap(core)),
            PermitStatus::Active => Self::Active(wrap(core)),
            PermitStatus::Suspended => Self::Suspended(wrap(core)),
            PermitStatus::Hold => Self::Hold(wrap(core)),
            PermitStatus::Rejected => Self::Rejected(wrap(core)),
            PermitStatus::Withdrawn => Self::Withdrawn(wrap(core)),
            PermitStatus::Complete => Self::Complete(wrap(core)),
            PermitStatus::Closed => Self::Closed(wrap(core)),
        }
    }

    /// The state-independent contents, whatever the state.
    #[must_use]
    pub fn core(&self) -> &PermitCore {
        match self {
            Self::Draft(p) => p.core(),
            Self::Submitted(p) => p.core(),
            Self::PendingGf(p) => p.core(),
            Self::PendingFm(p) => p.core(),
            Self::Approved(p) => p.core(),
            Self::Active(p) => p.core(),
            Self::Suspended(p) => p.core(),
            Self::Hold(p) => p.core(),
            Self::Rejected(p) => p.core(),
            Self::Withdrawn(p) => p.core(),
            Self::Complete(p) => p.core(),
            Self::Closed(p) => p.core(),
        }
    }

    /// The persisted status.
    #[must_use]
    pub fn status(&self) -> PermitStatus {
        match self {
            Self::Draft(_) => PermitStatus::Draft,
            Self::Submitted(_) => PermitStatus::Submitted,
            Self::PendingGf(_) => PermitStatus::PendingGf,
            Self::PendingFm(_) => PermitStatus::PendingFm,
            Self::Approved(_) => PermitStatus::Approved,
            Self::Active(_) => PermitStatus::Active,
            Self::Suspended(_) => PermitStatus::Suspended,
            Self::Hold(_) => PermitStatus::Hold,
            Self::Rejected(_) => PermitStatus::Rejected,
            Self::Withdrawn(_) => PermitStatus::Withdrawn,
            Self::Complete(_) => PermitStatus::Complete,
            Self::Closed(_) => PermitStatus::Closed,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::units::Minutes;

    fn sample_core() -> PermitCore {
        let start = Timestamp::from_epoch_millis(1_700_000_000_000);
        PermitCore {
            permit_id: PermitId::from_uuid(uuid::Uuid::nil()),
            vessel_id: VesselId::from_uuid(uuid::Uuid::nil()),
            availability_id: None,
            work_order_id: None,
            code: "HW-1043".to_owned(),
            work_type: "hot_work".to_owned(),
            window: PermitWindow {
                permit_date: NaiveDateStr::new("2026-05-12"),
                shift_code: "D".to_owned(),
                starts_at: start,
                ends_at: start.plus_minutes(Minutes::new(8 * 60)),
            },
            raised_by: PersonId::from_uuid(uuid::Uuid::nil()),
        }
    }

    #[test]
    fn happy_path_walks_the_lifecycle() {
        let permit = Permit::<Draft>::new(sample_core());
        assert_eq!(permit.status(), PermitStatus::Draft);
        let active = permit
            .submit()
            .route_to_gf()
            .approve_gf()
            .approve_fm()
            .activate();
        assert_eq!(active.status(), PermitStatus::Active);
        let closed = active.suspend().resume().complete().close();
        assert_eq!(closed.status(), PermitStatus::Closed);
    }

    #[test]
    fn from_parts_round_trips_status() {
        let any = AnyPermit::from_parts(sample_core(), PermitStatus::Suspended);
        assert_eq!(any.status(), PermitStatus::Suspended);
        assert_eq!(any.core().code, "HW-1043");
    }

    // The following, uncommented, must NOT compile — the proof that illegal
    // transitions are unrepresentable:
    //
    //   Permit::<Draft>::new(sample_core()).approve_fm();   // no such method
    //   Permit::<Rejected>::new(...);                       // no `new` on Rejected
}
