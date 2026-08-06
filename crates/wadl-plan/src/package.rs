//! A distributed package and its segment topology.
//!
//! A distributed package is **one** work order whose execution is spread over
//! many compartments and whose segments form a network. Two facts follow, and
//! this module exists to make them computable:
//!
//! 1. Authorization state is a **distribution over the footprint**, not a value.
//! 2. A segment cannot be tested until it *and everything upstream of it* is
//!    complete — so one held compartment can strand man-hours it does not
//!    contain.

use std::collections::{BTreeMap, BTreeSet};

use wadl_domain::compartment::CompartmentNo;
use wadl_domain::ids::{SegmentId, WorkOrderId};
use wadl_domain::units::ManHours;

/// One segment of a package: a trunk, branch, riser, run or header.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Segment {
    /// Primary key.
    pub id: SegmentId,
    /// Short code, e.g. `T1`, `B2`.
    pub code: String,
    /// What kind of run this is, e.g. `Trunk`.
    pub kind: String,
    /// Human description.
    pub name: String,
    /// The segment immediately upstream, if any. `None` marks a root.
    pub upstream: Option<SegmentId>,
    /// The compartments this segment passes through.
    pub compartments: Vec<CompartmentNo>,
}

/// The work booked in one compartment of the package.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SpaceWork {
    /// Budgeted man-hours.
    pub budget: ManHours,
    /// Earned man-hours.
    pub earned: ManHours,
}

impl SpaceWork {
    /// Man-hours still to do here. Never negative: over-earning is a data
    /// condition, not a negative quantity of work.
    #[must_use]
    pub fn remaining(self) -> ManHours {
        if self.earned.get() >= self.budget.get() {
            ManHours::ZERO
        } else {
            self.budget - self.earned
        }
    }

    /// Whether the work in this compartment is finished.
    #[must_use]
    pub fn is_complete(self) -> bool {
        self.remaining() == ManHours::ZERO
    }
}

/// A distributed package: its segments and the work booked per compartment.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Package {
    /// The work order this package is.
    pub work_order_id: WorkOrderId,
    /// WI / WO code, e.g. `WI-2201`.
    pub code: String,
    /// Package title.
    pub name: String,
    /// The verb this package's segments are tested with — "leak-tested",
    /// "continuity- and megger-tested". Carried as data because the gates of an
    /// HVAC package are not positionally interchangeable with a cableway's.
    pub test_verb: String,
    /// The segments, in authoring order.
    pub segments: Vec<Segment>,
    /// Work booked per compartment across the whole footprint.
    pub spaces: BTreeMap<CompartmentNo, SpaceWork>,
}

/// A defect in a package's topology. Reported rather than panicked on: bad
/// ingest data must never take down a planning surface.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum TopologyFault {
    /// A segment's `upstream` points at a segment that is not in the package.
    DanglingUpstream {
        /// The segment with the bad pointer.
        segment: String,
    },
    /// Following `upstream` from this segment revisits it — the data describes a
    /// loop, which has no root and therefore no meaningful "everything upstream".
    UpstreamCycle {
        /// A segment on the cycle.
        segment: String,
    },
    /// A segment names a compartment with no work booked in the footprint.
    UnknownCompartment {
        /// The segment naming it.
        segment: String,
        /// The compartment named.
        compartment: String,
    },
}

impl Package {
    /// Segments indexed by id.
    fn index(&self) -> BTreeMap<SegmentId, &Segment> {
        self.segments.iter().map(|s| (s.id, s)).collect()
    }

    /// The chain of segments upstream of `segment`, nearest first.
    ///
    /// Bounded by the segment count, so a cycle in the data terminates instead of
    /// looping forever. A cycle or dangling pointer is reported as a
    /// [`TopologyFault`]; the partial chain walked so far is still returned,
    /// because a partial answer plus a named fault is more useful to a planner
    /// than an error with no detail.
    fn ancestors_of(
        &self,
        segment: &Segment,
        index: &BTreeMap<SegmentId, &Segment>,
        faults: &mut Vec<TopologyFault>,
    ) -> Vec<SegmentId> {
        let mut chain = Vec::new();
        let mut seen: BTreeSet<SegmentId> = BTreeSet::new();
        seen.insert(segment.id);
        let mut cursor = segment.upstream;
        while let Some(id) = cursor {
            let Some(next) = index.get(&id) else {
                faults.push(TopologyFault::DanglingUpstream {
                    segment: segment.code.clone(),
                });
                break;
            };
            if !seen.insert(id) {
                faults.push(TopologyFault::UpstreamCycle {
                    segment: segment.code.clone(),
                });
                break;
            }
            chain.push(id);
            cursor = next.upstream;
            // Belt and braces: the `seen` set already bounds this, but an
            // explicit ceiling makes the termination argument obvious to a
            // reader auditing the traversal.
            if chain.len() > self.segments.len() {
                faults.push(TopologyFault::UpstreamCycle {
                    segment: segment.code.clone(),
                });
                break;
            }
        }
        chain
    }

    /// Every segment downstream of `id`, transitively.
    fn descendants_of(&self, id: SegmentId) -> Vec<SegmentId> {
        let mut out: Vec<SegmentId> = Vec::new();
        let mut seen: BTreeSet<SegmentId> = BTreeSet::new();
        let mut frontier = vec![id];
        while let Some(current) = frontier.pop() {
            for child in self.segments.iter().filter(|s| s.upstream == Some(current)) {
                if seen.insert(child.id) {
                    out.push(child.id);
                    frontier.push(child.id);
                }
            }
        }
        out
    }

    /// Rolls each segment's budget, earned and open compartments up from the
    /// compartments it passes through. Completeness only; testability needs every
    /// segment's completeness known first and is a second pass.
    fn roll_up_segments(
        &self,
        faults: &mut Vec<TopologyFault>,
    ) -> BTreeMap<SegmentId, SegmentStatus> {
        let mut status: BTreeMap<SegmentId, SegmentStatus> = BTreeMap::new();
        for segment in &self.segments {
            let mut budget = ManHours::ZERO;
            let mut earned = ManHours::ZERO;
            let mut open = Vec::new();
            for compartment in &segment.compartments {
                let Some(work) = self.spaces.get(compartment) else {
                    faults.push(TopologyFault::UnknownCompartment {
                        segment: segment.code.clone(),
                        compartment: compartment.to_string(),
                    });
                    continue;
                };
                budget = budget + work.budget;
                earned = earned + work.earned;
                if !work.is_complete() {
                    open.push(compartment.clone());
                }
            }
            status.insert(
                segment.id,
                SegmentStatus {
                    segment_id: segment.id,
                    code: segment.code.clone(),
                    kind: segment.kind.clone(),
                    name: segment.name.clone(),
                    budget,
                    earned,
                    complete: open.is_empty(),
                    open_compartments: open,
                    // Filled in below, once every segment's completeness is known.
                    testable: false,
                    held_by: Vec::new(),
                },
            );
        }
        status
    }

    /// Second pass: testable = this segment complete AND every ancestor
    /// complete. This is the whole point of the topology — a finished branch is
    /// not testable while the trunk feeding it is open.
    fn mark_testability(
        &self,
        index: &BTreeMap<SegmentId, &Segment>,
        status: &mut BTreeMap<SegmentId, SegmentStatus>,
        faults: &mut Vec<TopologyFault>,
    ) {
        for segment in &self.segments {
            let ancestors = self.ancestors_of(segment, index, faults);
            let self_complete = status.get(&segment.id).is_some_and(|s| s.complete);
            let held_by: Vec<String> = ancestors
                .iter()
                .filter(|id| !status.get(id).is_some_and(|s| s.complete))
                .filter_map(|id| index.get(id).map(|s| s.code.clone()))
                .collect();
            if let Some(entry) = status.get_mut(&segment.id) {
                entry.testable = self_complete && held_by.is_empty();
                entry.held_by = held_by;
            }
        }
    }

    /// Per-compartment stranding: the man-hours in DOWNSTREAM segments that
    /// cannot be tested until this compartment's own work clears. A compartment
    /// with nothing left to do strands nothing, by definition.
    fn compute_stranding(
        &self,
        index: &BTreeMap<SegmentId, &Segment>,
        status: &BTreeMap<SegmentId, SegmentStatus>,
    ) -> Vec<Stranding> {
        let mut stranding: Vec<Stranding> = Vec::new();
        for (compartment, work) in &self.spaces {
            let own_remaining = work.remaining();
            if own_remaining == ManHours::ZERO {
                continue;
            }
            let mut downstream: BTreeSet<SegmentId> = BTreeSet::new();
            for home in self
                .segments
                .iter()
                .filter(|s| s.compartments.contains(compartment))
            {
                downstream.extend(self.descendants_of(home.id));
            }
            let stranded: ManHours = downstream
                .iter()
                .filter_map(|id| status.get(id))
                .map(SegmentStatus::remaining)
                .sum();
            let mut codes: Vec<String> = downstream
                .iter()
                .filter_map(|id| index.get(id).map(|s| s.code.clone()))
                .collect();
            codes.sort();
            stranding.push(Stranding {
                compartment: compartment.clone(),
                own_remaining,
                stranded_downstream: stranded,
                downstream_segments: codes,
            });
        }
        // Most stranding first; own remaining work breaks the tie. Compartment
        // number last so the order is total and the output is deterministic.
        stranding.sort_by(|a, b| {
            b.stranded_downstream
                .cmp(&a.stranded_downstream)
                .then(b.own_remaining.cmp(&a.own_remaining))
                .then(a.compartment.cmp(&b.compartment))
        });
        stranding
    }

    /// Analyses the package: per-segment status and testability, then
    /// per-compartment stranding.
    #[must_use]
    pub fn analyse(&self) -> Analysis {
        let index = self.index();
        let mut faults = Vec::new();
        let mut status = self.roll_up_segments(&mut faults);
        self.mark_testability(&index, &mut status, &mut faults);
        let stranding = self.compute_stranding(&index, &status);

        let budget: ManHours = self.spaces.values().map(|w| w.budget).sum();
        let earned: ManHours = self.spaces.values().map(|w| w.earned).sum();
        let mut segments: Vec<SegmentStatus> = self
            .segments
            .iter()
            .filter_map(|s| status.get(&s.id).cloned())
            .collect();
        segments.sort_by(|a, b| a.code.cmp(&b.code));

        Analysis {
            work_order_id: self.work_order_id,
            code: self.code.clone(),
            name: self.name.clone(),
            test_verb: self.test_verb.clone(),
            budget,
            earned,
            compartment_count: self.spaces.len(),
            open_compartment_count: self.spaces.values().filter(|w| !w.is_complete()).count(),
            testable_segment_count: segments.iter().filter(|s| s.testable).count(),
            segment_count: segments.len(),
            segments,
            stranding,
            faults,
        }
    }
}

/// One segment's derived status.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SegmentStatus {
    /// Primary key.
    pub segment_id: SegmentId,
    /// Short code.
    pub code: String,
    /// Kind of run.
    pub kind: String,
    /// Human description.
    pub name: String,
    /// Budgeted man-hours across this segment's compartments.
    pub budget: ManHours,
    /// Earned man-hours.
    pub earned: ManHours,
    /// Whether every compartment on this segment is finished.
    pub complete: bool,
    /// The compartments on this segment with work outstanding.
    pub open_compartments: Vec<CompartmentNo>,
    /// Whether this segment may be tested: itself complete and every upstream
    /// segment complete.
    pub testable: bool,
    /// The upstream segment codes holding this one, if any.
    pub held_by: Vec<String>,
}

impl SegmentStatus {
    /// Man-hours still to do on this segment.
    ///
    /// Floored at zero: an over-earned segment (earned beyond budget, which
    /// happens in real progress data) has no work left, and must not report a
    /// *negative* quantity that would then subtract from a stranded total and
    /// understate the case for re-sequencing.
    #[must_use]
    pub fn remaining(&self) -> ManHours {
        if self.earned.get() >= self.budget.get() {
            ManHours::ZERO
        } else {
            self.budget - self.earned
        }
    }
}

/// What one compartment's outstanding work is holding elsewhere.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Stranding {
    /// The compartment with work outstanding.
    pub compartment: CompartmentNo,
    /// Man-hours left in this compartment.
    pub own_remaining: ManHours,
    /// Man-hours in downstream segments that cannot be tested until this
    /// compartment clears — **hours this compartment does not contain**. This is
    /// the number that makes the case for re-sequencing.
    pub stranded_downstream: ManHours,
    /// The downstream segment codes affected.
    pub downstream_segments: Vec<String>,
}

/// The full derived picture of a package.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Analysis {
    /// The work order.
    pub work_order_id: WorkOrderId,
    /// WI / WO code.
    pub code: String,
    /// Package title.
    pub name: String,
    /// The verb this package's segments are tested with.
    pub test_verb: String,
    /// Total budgeted man-hours across the footprint.
    pub budget: ManHours,
    /// Total earned man-hours.
    pub earned: ManHours,
    /// Compartments in the footprint.
    pub compartment_count: usize,
    /// Compartments with work outstanding.
    pub open_compartment_count: usize,
    /// Segments currently testable.
    pub testable_segment_count: usize,
    /// Segments in the package.
    pub segment_count: usize,
    /// Per-segment status, ordered by code.
    pub segments: Vec<SegmentStatus>,
    /// Per-compartment stranding, worst first.
    pub stranding: Vec<Stranding>,
    /// Any topology defects found. Empty for well-formed data.
    pub faults: Vec<TopologyFault>,
}

impl Analysis {
    /// Total man-hours stranded across the footprint — the headline number.
    ///
    /// Summed over the *worst* stranding claim per downstream segment rather than
    /// per compartment: two open compartments feeding the same branch do not
    /// strand its hours twice.
    #[must_use]
    pub fn total_stranded(&self) -> ManHours {
        let mut counted: BTreeSet<&str> = BTreeSet::new();
        let mut total = ManHours::ZERO;
        for item in &self.stranding {
            for code in &item.downstream_segments {
                if !counted.insert(code.as_str()) {
                    continue;
                }
                if let Some(segment) = self.segments.iter().find(|s| &s.code == code) {
                    total = total + segment.remaining();
                }
            }
        }
        total
    }
}
