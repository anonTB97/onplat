//! An in-memory [`Repositories`] implementation with the demo world seeded.
//!
//! This is the working store for milestone 1. It enforces the same two gates
//! the database enforces — tenant and per-hull assignment — but in Rust, so the
//! API and the cross-tenant leak test run with no database. The seed mirrors the
//! prototype: three carriers plus a DDG and an LPD in the yard tenant, a
//! separate hull in a second (navy) tenant for the cross-tenant test, and a demo
//! identity assigned to three of the yard's five hulls so RBAC refusal is
//! visible on the other two.

use std::collections::BTreeMap;

use uuid::Uuid;
use wadl_domain::compartment::CompartmentNo;
use wadl_domain::ids::{ActivityId, CouplingTypeId, OrgId, SegmentId, VesselId, WorkOrderId};
use wadl_domain::time::{Timestamp, Window};
use wadl_domain::units::{HopDepth, ManHours};
use wadl_engine::coupling::{CouplingCode, CouplingEdge, Propagation};
use wadl_engine::{AdjacencyGraph, Hazard, HazardKind, RuleSet};
use wadl_plan::{Package, Segment, SpaceWork};

use crate::error::StoreError;
use crate::model::{
    ActivityStatus, ActivitySummary, AuditRecord, CompartmentSummary, DeckSummary, PackageSummary,
    Reliability, ScheduleEdgeSummary, StrandedItem, StrandedReport, VesselSummary,
    WorkOrderSummary,
};
use crate::repo::Repositories;
use crate::scope::TenantScope;

/// The demo world's notional "now" when no anchor is supplied — 07:15 on the
/// demo shift. Fixed, not `now()`, so tests and golden snapshots read the same
/// on every run.
///
/// The seed expresses its whole story as offsets from an anchor rather than as
/// absolute instants, because the story has to stay true. Written as fixed
/// dates, the demo's eight-hour cure elapsed in May and every later run showed a
/// hull held by a hazard that had long since cleared — visible in the product as
/// a SUSPEND whose `earliest_clear` was three months in the past. Anchoring the
/// story to the instant the store is seeded keeps the coat curing when a reader
/// arrives.
pub const DEMO_ANCHOR_MS: i64 = 1_778_649_300_000;

const MS_PER_MIN: i64 = 60_000;
const MIN_PER_DAY: i64 = 24 * 60;

struct VesselRow {
    id: VesselId,
    org: OrgId,
    hull_no: &'static str,
    name: &'static str,
    class_code: &'static str,
    availability_code: &'static str,
    confidence: &'static str,
    /// The availability window, in days either side of the anchor. It bounds
    /// every as-of query: an instant outside the availability is not a question
    /// this hull's data can answer.
    avail_from_day: i64,
    avail_to_day: i64,
}

struct CompartmentRow {
    vessel: VesselId,
    no: &'static str,
    name: &'static str,
    deck_code: &'static str,
    deck_ordinal: i32,
    zone: &'static str,
    category: &'static str,
}

struct WorkOrderRow {
    vessel: VesselId,
    id: WorkOrderId,
    code: &'static str,
    title: &'static str,
    trade: &'static str,
    system: &'static str,
    compartment: &'static str,
    budget: i64,
    earned: i64,
    source_ref: &'static str,
    source_verified: bool,
    /// When this order is planned to be worked, in days either side of the
    /// anchor. Days rather than minutes because that is the resolution a
    /// schedule of record actually carries for a work item.
    from_day: i64,
    to_day: i64,
}

/// A directed coupling edge in the seed. Symmetric couplings appear twice, as
/// the schema requires, so a query never has to remember which way round a row
/// was stored.
struct CouplingRow {
    vessel: VesselId,
    from: &'static str,
    to: &'static str,
    /// The coupling type's code — what rules bind to.
    code: &'static str,
    /// Distinct per code, so the traversal's visited key separates a space
    /// reached by a bulkhead from the same space reached by a penetration.
    type_id: u128,
    propagates: &'static [Propagation],
    max_reach: u8,
}

struct HazardRow {
    vessel: VesselId,
    origin: &'static str,
    kind: HazardKind,
    /// When the hazard was raised, in minutes either side of the anchor.
    /// Minutes, not days: a cure clock is priced in minutes and the demo's whole
    /// point is that the coat is part-way through one.
    since_min: i64,
    label: &'static str,
}

/// A distributed package: one work order spread over many compartments.
struct PackageRow {
    vessel: VesselId,
    work_order_id: u128,
    code: &'static str,
    name: &'static str,
    system: &'static str,
    /// The lead trade that owns the package.
    trade: &'static str,
    /// The verb this package's segments are tested with. Carried as data because
    /// an HVAC package's gates are not interchangeable with a cableway's.
    test_verb: &'static str,
}

/// One segment of a package, with its upstream pointer — the topology that makes
/// "cannot be tested until everything upstream is complete" a query.
struct SegmentRow {
    package_code: &'static str,
    segment_id: u128,
    code: &'static str,
    kind: &'static str,
    name: &'static str,
    /// The segment code immediately upstream; empty for a root.
    upstream_code: &'static str,
    compartments: &'static [&'static str],
}

/// Work booked in one compartment of one package.
struct PackageSpaceRow {
    package_code: &'static str,
    compartment: &'static str,
    budget: i64,
    earned: i64,
    /// This compartment's share of the package, in days either side of the
    /// anchor. Per-space rather than per-package because that is the fact the
    /// topology already asserts: a trunk is worked before the branches hanging
    /// off it, so the footprint moves through the hull over the availability.
    from_day: i64,
    to_day: i64,
}

// ---------------------------------------------------------------- activities
//
// The activity register is GENERATED from the seeded work orders and package
// spaces rather than stored as rows of its own, and that is the point: every
// activity's hours and window are slices of a parent the boards already show, so
// the register reconciles with the boards by construction, not by discipline.
// When real XER ingest lands, ingested activities replace the generated ones and
// a reconciliation *report* replaces the structural guarantee.

/// Deterministic jitter for the generator: a plain LCG stepped from a fixed
/// seed, because the register must read identically on every load and this
/// workspace bans wall clocks and RNGs in seeds.
fn lcg_next(state: &mut u64) -> u64 {
    *state = state
        .wrapping_mul(6_364_136_223_846_793_005)
        .wrapping_add(1_442_695_040_888_963_407);
    *state >> 33
}

/// `n` weights in 3..=7 — enough spread that slices differ, never a zero.
fn jitter_weights(seed: u64, n: usize) -> Vec<i64> {
    let mut state = seed;
    (0..n)
        .map(|_| 3 + i64::try_from(lcg_next(&mut state) % 5).unwrap_or(0))
        .collect()
}

/// Splits `total` across `weights` exactly. Floor shares first, then the
/// remainder one unit at a time from the front — deterministic, and the sum is
/// the parent's total to the man-hour, which is what reconciliation means.
fn allocate(total: i64, weights: &[i64]) -> Vec<i64> {
    let sum: i64 = weights.iter().sum::<i64>().max(1);
    let mut shares: Vec<i64> = weights.iter().map(|w| total * w / sum).collect();
    let mut leftover = total - shares.iter().sum::<i64>();
    for share in &mut shares {
        if leftover == 0 {
            break;
        }
        *share += 1;
        leftover -= 1;
    }
    shares
}

/// Consecutive sub-windows of `window`, one per weight, covering it end to end.
fn slice_window(window: Window, weights: &[i64]) -> Vec<Window> {
    let (a, b) = (window.start.epoch_millis(), window.end.epoch_millis());
    let span = (b - a).max(1);
    let sum: i64 = weights.iter().sum::<i64>().max(1);
    let mut out = Vec::with_capacity(weights.len());
    let mut cursor = a;
    let mut used = 0_i64;
    for (i, w) in weights.iter().enumerate() {
        used += w;
        let end = if i + 1 == weights.len() {
            b
        } else {
            a + span * used / sum
        };
        out.push(Window::new(
            Timestamp::from_epoch_millis(cursor),
            Timestamp::from_epoch_millis(end.max(cursor + 1)),
        ));
        cursor = end.max(cursor + 1);
    }
    out
}

/// Earned hours filled front to back: the earliest slices complete first, so
/// status and the window tell one story — finished work in the past, current
/// work straddling now, unstarted work ahead — instead of contradicting each
/// other the way independently-jittered figures would.
fn fill_earned(budgets: &[i64], parent_earned: i64) -> Vec<i64> {
    let mut left = parent_earned;
    budgets
        .iter()
        .map(|b| {
            let e = left.min(*b);
            left -= e;
            e
        })
        .collect()
}

fn status_of(budget: i64, earned: i64) -> ActivityStatus {
    if earned == 0 && budget > 0 {
        ActivityStatus::NotStarted
    } else if earned >= budget {
        ActivityStatus::Complete
    } else {
        ActivityStatus::InProgress
    }
}

/// Phase names for a decomposed work order, in execution order.
const ORDER_PHASES: [&str; 6] = [
    "prep & access",
    "strip / rip-out",
    "execute",
    "inspect & rework",
    "close out",
    "test support",
];
/// Phase names for one compartment of a distributed package.
const PACKAGE_PHASES: [&str; 4] = [
    "rip-out & route",
    "hang / pull",
    "terminate / seal",
    "test support",
];

/// One appended ledger entry, held in memory.
struct AuditRow {
    vessel: VesselId,
    action: String,
    detail: String,
    subject_ref: Option<String>,
    occurred_at_ms: i64,
    prev_hash: Option<Vec<u8>>,
    entry_hash: Vec<u8>,
}

/// The seeded in-memory store.
pub struct InMemoryStore {
    /// The instant the demo's story is told relative to. Every dated row is an
    /// offset from here, resolved on read.
    anchor: Timestamp,
    vessels: Vec<VesselRow>,
    compartments: Vec<CompartmentRow>,
    work_orders: Vec<WorkOrderRow>,
    couplings: Vec<CouplingRow>,
    hazards: Vec<HazardRow>,
    packages: Vec<PackageRow>,
    segments: Vec<SegmentRow>,
    package_spaces: Vec<PackageSpaceRow>,
    /// The audit ledger. Behind a lock rather than `&mut self` because the
    /// repository seam is a shared `Arc<dyn>`.
    ///
    /// The chain is computed with the real [`crate::ledger::compute_hash`], not a
    /// stub: an in-memory ledger that skipped the chaining would let a chain bug
    /// reach production untested, and `wadl verify-ledger` is supposed to work
    /// against whatever wrote the entries.
    audit: std::sync::Mutex<Vec<AuditRow>>,
    /// An ingested schedule of record per hull. When present, serving prefers
    /// it over the generated register — the swap the generator was built to
    /// survive. Behind a lock for the same reason the ledger is: loading an
    /// export happens after the store is shared.
    schedule_of_record: std::sync::RwLock<BTreeMap<VesselId, ScheduleOfRecord>>,
    /// An ingested zone chart per hull. When present, the views draw its
    /// authored bounds instead of inferring bands from space extents — and can
    /// check the register's assignments against them.
    zone_register: std::sync::RwLock<BTreeMap<VesselId, ZoneRegister>>,
    /// An ingested budget book per hull. When present, reconciliation holds
    /// the register's hours to ITS budgets instead of the seeded work items'.
    budget_book: std::sync::RwLock<BTreeMap<VesselId, BudgetBook>>,
}

/// An ingested schedule of record, in the store's own read models.
///
/// Once one is set for a hull, the register stops being generated-and-
/// reconciled-by-construction and becomes what the scheduler actually said —
/// at which point reconciliation is a *report*, computed by the API against
/// the work orders, rather than a property.
#[derive(Debug, Clone)]
pub struct ScheduleOfRecord {
    /// Where it came from, e.g. `CVN73-PIA26.xer` — surfaced to the reader so
    /// an ingested register never presents as the generated one.
    pub label: String,
    /// The register rows.
    pub activities: Vec<ActivitySummary>,
    /// The dependency edges.
    pub edges: Vec<ScheduleEdgeSummary>,
}

/// An ingested zone chart: authored frame bounds per zone.
///
/// Deliberately NOT seeded. The demo's zone bands are inferred from the
/// register and say so on screen; a chart arriving through the import door is
/// how they become authored — the same seam discipline as the schedule of
/// record, on the geometry axis.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZoneRegister {
    /// Where it came from, e.g. `CVN73-zones.csv` — surfaced to the reader so
    /// authored bounds never present as inferred ones or vice versa.
    pub label: String,
    /// The authored bounds, one per zone.
    pub bounds: Vec<crate::model::ZoneBoundSummary>,
}

/// An ingested budget book: the hours authority per work item.
///
/// Deliberately NOT a work-order register — the operational work orders stay
/// what they are; the book replaces what the register's hours are held
/// accountable to, which is the reconciliation report's other side.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BudgetBook {
    /// Where it came from, e.g. `CVN73-budgets.csv`.
    pub label: String,
    /// One line per work item.
    pub items: Vec<crate::model::BudgetItemSummary>,
}

/// The identifiers of the seeded demo world, handed back so the API and tests
/// can build scopes and address specific hulls without guessing UUIDs.
#[derive(Debug, Clone)]
pub struct DemoWorld {
    /// The shipbuilder tenant that owns the five hulls.
    pub yard_org: OrgId,
    /// A second tenant (a navy) owning a separate hull, for the leak test.
    pub navy_org: OrgId,
    /// `CVN-73` — assigned to the demo identity.
    pub cvn73: VesselId,
    /// `CVN-71` — assigned to the demo identity.
    pub cvn71: VesselId,
    /// `CVN-75` — assigned to the demo identity.
    pub cvn75: VesselId,
    /// A DDG — present in the yard tenant but NOT assigned to the demo identity.
    pub ddg: VesselId,
    /// An LPD — present in the yard tenant but NOT assigned to the demo identity.
    pub lpd: VesselId,
    /// The navy tenant's hull — never visible to the yard tenant.
    pub navy_hull: VesselId,
}

const fn id(n: u128) -> Uuid {
    Uuid::from_u128(n)
}

impl DemoWorld {
    /// The demo yard planner's scope: the yard tenant, assigned to the three
    /// carriers only.
    #[must_use]
    pub fn yard_scope(&self) -> TenantScope {
        TenantScope::new(self.yard_org, [self.cvn73, self.cvn71, self.cvn75])
    }

    /// The navy tenant's scope, assigned to its own hull.
    #[must_use]
    pub fn navy_scope(&self) -> TenantScope {
        TenantScope::new(self.navy_org, [self.navy_hull])
    }

    /// A yard-tenant scope assigned to *every* yard hull — used to demonstrate
    /// that even full assignment never crosses the tenant boundary.
    #[must_use]
    pub fn yard_scope_all(&self) -> TenantScope {
        TenantScope::new(
            self.yard_org,
            [self.cvn73, self.cvn71, self.cvn75, self.ddg, self.lpd],
        )
    }
}

impl InMemoryStore {
    /// Builds the seeded store on the fixed [`DEMO_ANCHOR_MS`] anchor.
    ///
    /// Use this where byte-stable output matters — golden snapshots, tests that
    /// assert on specific instants. A served demo wants [`Self::demo_at`] with
    /// the real clock, so the story is current for whoever is reading it.
    #[must_use]
    pub fn demo() -> (Self, DemoWorld) {
        Self::demo_at(Timestamp::from_epoch_millis(DEMO_ANCHOR_MS))
    }

    /// Builds the seeded store with its story anchored on `anchor`.
    ///
    /// The anchor is the demo's notional "now": the coating ticket is three hours
    /// into its eight-hour cure, work is in progress in five spaces, and the
    /// availability runs from two weeks before to twenty-four weeks after.
    #[must_use]
    pub fn demo_at(anchor: Timestamp) -> (Self, DemoWorld) {
        let world = DemoWorld {
            yard_org: OrgId::from_uuid(id(0x01)),
            navy_org: OrgId::from_uuid(id(0x02)),
            cvn73: VesselId::from_uuid(id(0x73)),
            cvn71: VesselId::from_uuid(id(0x71)),
            cvn75: VesselId::from_uuid(id(0x75)),
            ddg: VesselId::from_uuid(id(0xDD13)),
            lpd: VesselId::from_uuid(id(0x1D28)),
            navy_hull: VesselId::from_uuid(id(0x68)),
        };
        let store = Self {
            anchor,
            vessels: Self::seed_vessels(&world),
            compartments: Self::seed_compartments(&world),
            work_orders: Self::seed_work_orders(&world),
            couplings: Self::seed_couplings(&world),
            hazards: Self::seed_hazards(&world),
            packages: Self::seed_packages(&world),
            segments: Self::seed_segments(),
            package_spaces: Self::seed_package_spaces(),
            audit: std::sync::Mutex::new(Vec::new()),
            schedule_of_record: std::sync::RwLock::new(BTreeMap::new()),
            zone_register: std::sync::RwLock::new(BTreeMap::new()),
            budget_book: std::sync::RwLock::new(BTreeMap::new()),
        };
        (store, world)
    }

    /// An instant `minutes` either side of the anchor.
    fn at_minutes(&self, minutes: i64) -> Timestamp {
        Timestamp::from_epoch_millis(
            self.anchor
                .epoch_millis()
                .saturating_add(minutes.saturating_mul(MS_PER_MIN)),
        )
    }

    /// A window running from the start of `from_day` to the start of `to_day`,
    /// both counted in days from the anchor.
    ///
    /// Half-open, per [`Window`]: a task ending on day 3 and one starting on day
    /// 3 hand over cleanly instead of both counting on the changeover.
    fn day_window(&self, from_day: i64, to_day: i64) -> Window {
        Window::new(
            self.at_minutes(from_day.saturating_mul(MIN_PER_DAY)),
            self.at_minutes(to_day.saturating_mul(MIN_PER_DAY)),
        )
    }

    /// Decomposes each work order into phase activities whose hours and windows
    /// are exact slices of the parent's.
    fn activities_from_orders(&self, vessel: VesselId, out: &mut Vec<ActivitySummary>) {
        for (wi, w) in self
            .work_orders
            .iter()
            .filter(|w| w.vessel == vessel)
            .enumerate()
        {
            let n = usize::try_from((w.budget / 80).clamp(2, 6)).unwrap_or(2);
            let weights = jitter_weights(0xA0 + wi as u64, n);
            let budgets = allocate(w.budget, &weights);
            let earneds = fill_earned(&budgets, w.earned);
            let windows = slice_window(self.day_window(w.from_day, w.to_day), &weights);
            for (i, ((budget, earned), window)) in
                budgets.iter().zip(&earneds).zip(&windows).enumerate()
            {
                // Every third order's execute phase loses its compartment: the
                // dominant risk of a real schedule import, kept representable so
                // every surface downstream has to handle it before ingest lands.
                let unknown_space = wi % 3 == 2 && i == n / 2;
                out.push(ActivitySummary {
                    activity_id: ActivityId::from_uuid(id(0xAC00_0000
                        + (wi as u128) * 0x100
                        + i as u128)),
                    code: format!("{}.{:02}", w.code.replace("WI-", "A"), i + 1),
                    name: format!(
                        "{} — {}",
                        w.title,
                        ORDER_PHASES.get(i).copied().unwrap_or("execute")
                    ),
                    work_order_code: Some(w.code.to_owned()),
                    compartment_no: (!unknown_space).then(|| CompartmentNo::new(w.compartment)),
                    compartment_reliability: if unknown_space {
                        Reliability::Low
                    } else {
                        Reliability::High
                    },
                    wbs_area: None,
                    trade: w.trade.to_owned(),
                    planned: Some(*window),
                    budget_hours: ManHours::new(*budget),
                    earned_hours: ManHours::new(*earned),
                    status: status_of(*budget, *earned),
                    is_milestone: false,
                    source_ref: w.source_ref.to_owned(),
                });
            }
        }
    }

    /// Decomposes each package space the same way, one activity per phase.
    fn activities_from_packages(&self, vessel: VesselId, out: &mut Vec<ActivitySummary>) {
        let codes: std::collections::BTreeSet<&str> = self
            .packages
            .iter()
            .filter(|p| p.vessel == vessel)
            .map(|p| p.code)
            .collect();
        for (si, sp) in self
            .package_spaces
            .iter()
            .filter(|sp| codes.contains(sp.package_code))
            .enumerate()
        {
            let n = usize::try_from((sp.budget / 100).clamp(1, 4)).unwrap_or(1);
            let weights = jitter_weights(0xB0 + si as u64, n);
            let budgets = allocate(sp.budget, &weights);
            let earneds = fill_earned(&budgets, sp.earned);
            let windows = slice_window(self.day_window(sp.from_day, sp.to_day), &weights);
            for (i, ((budget, earned), window)) in
                budgets.iter().zip(&earneds).zip(&windows).enumerate()
            {
                out.push(ActivitySummary {
                    activity_id: ActivityId::from_uuid(id(0xAD00_0000
                        + (si as u128) * 0x100
                        + i as u128)),
                    code: format!(
                        "{}.{:02}{}",
                        sp.package_code.replace("WI-", "A"),
                        si + 1,
                        (b'a' + u8::try_from(i).unwrap_or(0)) as char
                    ),
                    name: format!(
                        "{} — {}",
                        sp.compartment,
                        PACKAGE_PHASES.get(i).copied().unwrap_or("execute")
                    ),
                    work_order_code: Some(sp.package_code.to_owned()),
                    compartment_no: Some(CompartmentNo::new(sp.compartment)),
                    compartment_reliability: Reliability::High,
                    wbs_area: None,
                    trade: self
                        .packages
                        .iter()
                        .find(|p| p.code == sp.package_code)
                        .map_or_else(String::new, |p| p.trade.to_owned()),
                    planned: Some(*window),
                    budget_hours: ManHours::new(*budget),
                    earned_hours: ManHours::new(*earned),
                    status: status_of(*budget, *earned),
                    is_milestone: false,
                    source_ref: format!("{} footprint", sp.package_code),
                });
            }
        }
    }

    /// The availability's key events. Zero hours and no work order — unmapped is
    /// a visible state, and these are the honest members of it.
    fn milestones(&self, out: &mut Vec<ActivitySummary>) {
        for (i, (code, name, day)) in [
            ("M0100", "KEY EVENT — Undock", 102_i64),
            ("M0200", "KEY EVENT — Fast Cruise", 149),
            ("M0300", "KEY EVENT — Delivery", 165),
        ]
        .into_iter()
        .enumerate()
        {
            out.push(ActivitySummary {
                activity_id: ActivityId::from_uuid(id(0xAE00_0000 + i as u128)),
                code: code.to_owned(),
                name: name.to_owned(),
                work_order_code: None,
                // No compartment, authored as such — unlike a LOW grade, which
                // means "the schedule did not say".
                compartment_no: None,
                compartment_reliability: Reliability::High,
                wbs_area: None,
                trade: "—".to_owned(),
                planned: Some(self.day_window(day, day + 1)),
                budget_hours: ManHours::ZERO,
                earned_hours: ManHours::ZERO,
                status: ActivityStatus::NotStarted,
                is_milestone: true,
                source_ref: "availability key events".to_owned(),
            });
        }
    }

    /// The two distributed packages from the prototype. They deliberately share
    /// compartments (`3-140-0-Q`, `3-148-2-E`): the cableway must clear the
    /// overhead before HVAC can hang duct there, and both need the same isolation
    /// window on bus 3-SG-2.
    fn seed_packages(w: &DemoWorld) -> Vec<PackageRow> {
        vec![
            PackageRow {
                vessel: w.cvn73,
                work_order_id: 0x2201,
                code: "WI-2201",
                name: "AC Plant No. 2 — supply & return distribution",
                system: "Ventilation & air conditioning · Zone 3 forward and aft",
                trade: "Sheet Metal",
                test_verb: "leak-tested",
            },
            PackageRow {
                vessel: w.cvn73,
                work_order_id: 0x3310,
                code: "WI-3310",
                name: "Zone 3 overhead cableway — power and IC pulls",
                system: "Electrical distribution and interior communications",
                trade: "Electrical",
                test_verb: "continuity- and megger-tested",
            },
        ]
    }

    fn seed_segments() -> Vec<SegmentRow> {
        vec![
            // HVAC: T1 is the trunk feeding everything. B1/B2 hang off it, T2
            // continues aft and feeds B3 and the hangar riser R1.
            SegmentRow {
                package_code: "WI-2201",
                segment_id: 0x2201_0001,
                code: "T1",
                kind: "Trunk",
                name: "Main supply trunk — AC-2 to Fr 148",
                upstream_code: "",
                compartments: &["3-172-0-M", "3-160-2-Q", "3-148-0-L"],
            },
            SegmentRow {
                package_code: "WI-2201",
                segment_id: 0x2201_0002,
                code: "B1",
                kind: "Branch",
                name: "Branch 1 — Zone 3 upper, mess and scullery",
                upstream_code: "T1",
                compartments: &["2-160-1-Q", "2-152-0-Q"],
            },
            SegmentRow {
                package_code: "WI-2201",
                segment_id: 0x2201_0003,
                code: "B2",
                kind: "Branch",
                name: "Branch 2 — switchgear and berthing",
                upstream_code: "T1",
                compartments: &["3-148-2-E", "3-140-0-Q"],
            },
            SegmentRow {
                package_code: "WI-2201",
                segment_id: 0x2201_0004,
                code: "T2",
                kind: "Trunk",
                name: "Aft supply trunk — Fr 176 to Fr 192",
                upstream_code: "T1",
                compartments: &["3-184-0-Q", "3-192-2-E"],
            },
            SegmentRow {
                package_code: "WI-2201",
                segment_id: 0x2201_0005,
                code: "B3",
                kind: "Branch",
                name: "Branch 3 — wardroom terminal",
                upstream_code: "T2",
                compartments: &["2-176-0-Q"],
            },
            SegmentRow {
                package_code: "WI-2201",
                segment_id: 0x2201_0006,
                code: "R1",
                kind: "Riser",
                name: "Riser — Hangar Bay 2 supply",
                upstream_code: "T2",
                compartments: &["1-160-0-Q"],
            },
            // Cableway: one main run with two branch runs.
            SegmentRow {
                package_code: "WI-3310",
                segment_id: 0x3310_0001,
                code: "C1",
                kind: "Run",
                name: "Main run — Fr 140 to Fr 160, overhead 3rd deck",
                upstream_code: "",
                compartments: &["3-148-0-L", "3-152-0-Q"],
            },
            SegmentRow {
                package_code: "WI-3310",
                segment_id: 0x3310_0002,
                code: "C2",
                kind: "Run",
                name: "Berthing overhead — Fr 140",
                upstream_code: "C1",
                compartments: &["3-140-0-Q"],
            },
            SegmentRow {
                package_code: "WI-3310",
                segment_id: 0x3310_0003,
                code: "C3",
                kind: "Run",
                name: "Switchgear terminations",
                upstream_code: "C1",
                compartments: &["3-148-2-E"],
            },
        ]
    }

    /// The per-compartment work in each package, with the days it is planned for.
    ///
    /// The dates are not decoration. They are ordered to match what the topology
    /// already asserts — a trunk is worked before the branches hanging off it —
    /// so scrubbing the availability shows the footprint moving through the hull
    /// instead of the whole package lighting up at every instant. Completed
    /// spaces sit in the past, in-progress spaces straddle the anchor, and
    /// unstarted spaces sit ahead of it, so `earned` and the window tell the same
    /// story rather than contradicting each other.
    fn seed_package_spaces() -> Vec<PackageSpaceRow> {
        let hvac = |compartment, budget, earned, from_day, to_day| PackageSpaceRow {
            package_code: "WI-2201",
            compartment,
            budget,
            earned,
            from_day,
            to_day,
        };
        let cable = |compartment, budget, earned, from_day, to_day| PackageSpaceRow {
            package_code: "WI-3310",
            compartment,
            budget,
            earned,
            from_day,
            to_day,
        };
        vec![
            // HVAC footprint — 11 compartments. The trunk (T1) is open at
            // 3-160-2-Q, which is also where the coating cascade lands, so the
            // authorization hold and the completion hold meet in one space.
            hvac("3-172-0-M", 620, 620, -12, -6),
            hvac("3-160-2-Q", 380, 300, -2, 3),
            hvac("3-148-0-L", 240, 240, -6, -2),
            hvac("2-160-1-Q", 560, 410, -1, 5),
            hvac("2-152-0-Q", 400, 180, -1, 8),
            hvac("3-148-2-E", 320, 96, 0, 6),
            hvac("3-140-0-Q", 480, 0, 6, 30),
            hvac("3-184-0-Q", 340, 300, -8, -1),
            hvac("3-192-2-E", 210, 210, -10, -4),
            hvac("2-176-0-Q", 300, 165, -2, 9),
            hvac("1-160-0-Q", 300, 60, -3, 62),
            // Cableway footprint — 4 compartments.
            cable("3-148-0-L", 410, 410, -9, -3),
            cable("3-152-0-Q", 260, 240, -3, 2),
            cable("3-140-0-Q", 520, 310, -4, 26),
            cable("3-148-2-E", 300, 40, 0, 7),
        ]
    }

    /// The CVN-73 adjacency around the coated space, as the prototype draws it.
    /// Only the aft-third neighbourhood is seeded — enough to exercise a real
    /// cascade without pretending to be a full class template.
    fn seed_couplings(w: &DemoWorld) -> Vec<CouplingRow> {
        const VERTICAL: &[Propagation] = &[Propagation::Heat, Propagation::Vapour];
        const BULKHEAD: &[Propagation] = &[Propagation::Heat, Propagation::Vapour];
        const VENT: &[Propagation] = &[Propagation::Vapour];

        let vertical = |from, to| CouplingRow {
            vessel: w.cvn73,
            from,
            to,
            code: "deck_penetration",
            type_id: 0x01,
            propagates: VERTICAL,
            max_reach: 1,
        };
        // A shared bulkhead has no preferred sense, so both directions are
        // stored explicitly.
        let bulkhead = |from, to| CouplingRow {
            vessel: w.cvn73,
            from,
            to,
            code: "shared_bulkhead",
            type_id: 0x02,
            propagates: BULKHEAD,
            max_reach: 2,
        };
        let vent = |from, to| CouplingRow {
            vessel: w.cvn73,
            from,
            to,
            code: "exhaust_trunk",
            type_id: 0x03,
            propagates: VENT,
            max_reach: 3,
        };

        vec![
            // The coated space's vertical neighbours (the heat paths).
            vertical("3-160-2-Q", "2-160-2-Q"),
            vertical("3-160-2-Q", "4-160-2-Q"),
            // Athwartships neighbour, symmetric.
            bulkhead("3-160-2-Q", "3-156-2-Q"),
            bulkhead("3-156-2-Q", "3-160-2-Q"),
            // The ventilation zone: the condition follows the air.
            vent("3-160-2-Q", "3-164-2-Q"),
            vent("3-164-2-Q", "4-164-2-Q"),
            // Elsewhere on the hull, unrelated to the coat.
            bulkhead("4-110-2-W", "4-120-4-Q"),
            bulkhead("4-120-4-Q", "4-110-2-W"),
        ]
    }

    /// The hazards live on the demo hull. One open coating ticket, which is what
    /// makes the Deck Explorer light up.
    ///
    /// The two are timed to demonstrate the difference the whole time dimension
    /// turns on. The coat is **three hours into an eight-hour cure**, so it clears
    /// itself five hours after the anchor and a planner scrubbing to tomorrow
    /// watches it go. The energised bus was raised two days ago and clears on a
    /// *verified* zero-energy state, so no amount of scrubbing discharges it —
    /// it is still there at the end of the availability, waiting for someone to
    /// go and isolate it.
    fn seed_hazards(w: &DemoWorld) -> Vec<HazardRow> {
        vec![
            HazardRow {
                vessel: w.cvn73,
                origin: "3-160-2-Q",
                kind: HazardKind::CoatingOpen,
                since_min: -3 * 60,
                label: "CT-3160-4 · final coat, curing",
            },
            // Bus 3-SG-2 is live in the switchgear room. Duct penetration and
            // cable termination work inside that envelope both need a verified
            // zero-energy state, so this one hazard holds two packages.
            HazardRow {
                vessel: w.cvn73,
                origin: "3-148-2-E",
                kind: HazardKind::EnergisedBus,
                since_min: -2 * MIN_PER_DAY,
                label: "Bus 3-SG-2 energised — no verified zero-energy state",
            },
        ]
    }

    fn seed_vessels(w: &DemoWorld) -> Vec<VesselRow> {
        vec![
            VesselRow {
                id: w.cvn73,
                org: w.yard_org,
                hull_no: "CVN-73",
                name: "USS George Washington",
                class_code: "CVN-68",
                availability_code: "PIA-26",
                confidence: "At Risk",
                avail_from_day: -14,
                avail_to_day: 166,
            },
            VesselRow {
                id: w.cvn71,
                org: w.yard_org,
                hull_no: "CVN-71",
                name: "USS Theodore Roosevelt",
                class_code: "CVN-68",
                availability_code: "SRA-26",
                confidence: "On Track",
                avail_from_day: -40,
                avail_to_day: 20,
            },
            VesselRow {
                id: w.cvn75,
                org: w.yard_org,
                hull_no: "CVN-75",
                name: "USS Harry S. Truman",
                class_code: "CVN-68",
                availability_code: "DPIA-28",
                confidence: "Planning",
                avail_from_day: 60,
                avail_to_day: 300,
            },
            VesselRow {
                id: w.ddg,
                org: w.yard_org,
                hull_no: "DDG-113",
                name: "USS John Finn",
                class_code: "DDG-51 Flt IIA",
                availability_code: "DSRA-26",
                confidence: "On Track",
                avail_from_day: -5,
                avail_to_day: 120,
            },
            VesselRow {
                id: w.lpd,
                org: w.yard_org,
                hull_no: "LPD-28",
                name: "USS Fort Lauderdale",
                class_code: "LPD-17",
                availability_code: "PSA-26",
                confidence: "Planning",
                avail_from_day: -60,
                avail_to_day: 60,
            },
            VesselRow {
                id: w.navy_hull,
                org: w.navy_org,
                hull_no: "CVN-68",
                name: "USS Nimitz",
                class_code: "CVN-68",
                availability_code: "INACT-26",
                confidence: "Planning",
                avail_from_day: -30,
                avail_to_day: 150,
            },
        ]
    }

    /// The CVN-73 register: a subset of the prototype's, enough for Deck
    /// Explorer and the stranded-hours story. Split by neighbourhood because the
    /// two groups serve different demos.
    fn seed_compartments(w: &DemoWorld) -> Vec<CompartmentRow> {
        let mut rows = Self::seed_compartments_forward(w);
        rows.extend(Self::seed_compartments_aft_third(w));
        rows.extend(Self::seed_compartments_packages(w));
        rows
    }

    /// The forward/midships spaces that carry the work orders and the stranded
    /// man-hours. `deck_ordinal` ascends downward.
    fn seed_compartments_forward(w: &DemoWorld) -> Vec<CompartmentRow> {
        vec![
            CompartmentRow {
                vessel: w.cvn73,
                no: "1-136-0-Q",
                name: "Hangar Bay 2",
                deck_code: "Main",
                deck_ordinal: 1,
                zone: "Z4",
                category: "Machinery / operational",
            },
            CompartmentRow {
                vessel: w.cvn73,
                no: "3-185-0-L",
                name: "CPO Living Space",
                deck_code: "3rd",
                deck_ordinal: 3,
                zone: "Z7",
                category: "Living",
            },
            CompartmentRow {
                vessel: w.cvn73,
                no: "4-102-2-E",
                name: "Switchboard Room No. 1",
                deck_code: "4th",
                deck_ordinal: 4,
                zone: "Z2",
                category: "Electrical",
            },
            CompartmentRow {
                vessel: w.cvn73,
                no: "4-110-2-W",
                name: "Reserve Feed Water Tank",
                deck_code: "4th",
                deck_ordinal: 4,
                zone: "Z3",
                category: "Tanks & voids",
            },
            CompartmentRow {
                vessel: w.cvn73,
                no: "4-120-4-Q",
                name: "Fan Room",
                deck_code: "4th",
                deck_ordinal: 4,
                zone: "Z3",
                category: "Machinery / electrical",
            },
            CompartmentRow {
                vessel: w.cvn73,
                no: "4-141-0-C",
                name: "Aft IC & Gyro Room",
                deck_code: "4th",
                deck_ordinal: 4,
                zone: "Z5",
                category: "Command & surveillance",
            },
            CompartmentRow {
                vessel: w.cvn73,
                no: "4-149-2-Q",
                name: "Forced Draft Blower Room No. 3",
                deck_code: "4th",
                deck_ordinal: 4,
                zone: "Z5",
                category: "Machinery / electrical",
            },
        ]
    }

    /// The aft-third neighbourhood around the curing coat. These are the spaces
    /// the seeded cascade actually decides, so Deck Explorer shows a live
    /// BLOCK / WARN / SUSPEND pattern rather than a uniform ALLOW.
    fn seed_compartments_aft_third(w: &DemoWorld) -> Vec<CompartmentRow> {
        vec![
            CompartmentRow {
                vessel: w.cvn73,
                no: "2-160-2-Q",
                name: "Uptake Space No. 3",
                deck_code: "2nd",
                deck_ordinal: 2,
                zone: "Z6",
                category: "Machinery / electrical",
            },
            CompartmentRow {
                vessel: w.cvn73,
                no: "3-156-2-Q",
                name: "Auxiliary Machinery Room No. 4",
                deck_code: "3rd",
                deck_ordinal: 3,
                zone: "Z6",
                category: "Machinery / electrical",
            },
            CompartmentRow {
                vessel: w.cvn73,
                no: "3-160-2-Q",
                name: "Passage & Trunk (coating in work)",
                deck_code: "3rd",
                deck_ordinal: 3,
                zone: "Z6",
                category: "Passage",
            },
            CompartmentRow {
                vessel: w.cvn73,
                no: "3-164-2-Q",
                name: "Ship's Store",
                deck_code: "3rd",
                deck_ordinal: 3,
                zone: "Z6",
                category: "Stowage",
            },
            CompartmentRow {
                vessel: w.cvn73,
                no: "4-160-2-Q",
                name: "Pump Room No. 2",
                deck_code: "4th",
                deck_ordinal: 4,
                zone: "Z6",
                category: "Machinery / electrical",
            },
            CompartmentRow {
                vessel: w.cvn73,
                no: "4-164-2-Q",
                name: "Cable Trunk & IC Space",
                deck_code: "4th",
                deck_ordinal: 4,
                zone: "Z6",
                category: "Command & surveillance",
            },
            // These two are in a distributed package's footprint but were missing
            // from the register, so their outstanding hours belonged to no zone
            // and the ship board had to report them as unattributed. Keeping them
            // out was not a demo of anything — the endpoint's coverage warning is
            // still there and still tested, it just has nothing to report on this
            // hull now.
            CompartmentRow {
                vessel: w.cvn73,
                no: "3-152-0-Q",
                name: "Cableway Trunk — Zone 3 overhead",
                deck_code: "3rd",
                deck_ordinal: 3,
                zone: "Z6",
                category: "Electrical",
            },
            CompartmentRow {
                vessel: w.cvn73,
                no: "3-184-0-Q",
                name: "AC Plant No. 2 Machinery Room",
                deck_code: "3rd",
                deck_ordinal: 3,
                zone: "Z7",
                category: "Machinery / electrical",
            },
        ]
    }

    /// The two distributed packages' footprints.
    ///
    /// Separate from the cascade neighbourhood because it is a different story:
    /// those compartments demonstrate a hazard travelling, these demonstrate one
    /// work order spread over eleven spaces. Their names are the ones the
    /// packages' own segments use — "mess and scullery", "switchgear and
    /// berthing", "wardroom terminal" — so the register, the segment topology and
    /// the deck plates describe one ship rather than three.
    ///
    /// Registering them is what makes the demo add up. While they were absent,
    /// 1,919 of 2,059 package man-hours belonged to no zone and the ship board
    /// could only report them as unattributed.
    fn seed_compartments_packages(w: &DemoWorld) -> Vec<CompartmentRow> {
        vec![
            CompartmentRow {
                vessel: w.cvn73,
                no: "1-160-0-Q",
                name: "Hangar Bay 3",
                deck_code: "Main",
                deck_ordinal: 1,
                zone: "Z6",
                category: "Machinery / operational",
            },
            CompartmentRow {
                vessel: w.cvn73,
                no: "2-152-0-Q",
                name: "Scullery",
                deck_code: "2nd",
                deck_ordinal: 2,
                zone: "Z6",
                category: "Living",
            },
            CompartmentRow {
                vessel: w.cvn73,
                no: "2-160-1-Q",
                name: "Mess Decks",
                deck_code: "2nd",
                deck_ordinal: 2,
                zone: "Z6",
                category: "Living",
            },
            CompartmentRow {
                vessel: w.cvn73,
                no: "2-176-0-Q",
                name: "Wardroom Terminal Space",
                deck_code: "2nd",
                deck_ordinal: 2,
                zone: "Z7",
                category: "Living",
            },
            CompartmentRow {
                vessel: w.cvn73,
                no: "3-140-0-Q",
                name: "Cableway Trunk — Fr 140",
                deck_code: "3rd",
                deck_ordinal: 3,
                zone: "Z5",
                category: "Electrical",
            },
            CompartmentRow {
                vessel: w.cvn73,
                no: "3-148-0-L",
                name: "Chief Petty Officer Berthing",
                deck_code: "3rd",
                deck_ordinal: 3,
                zone: "Z5",
                category: "Living",
            },
            CompartmentRow {
                vessel: w.cvn73,
                no: "3-148-2-E",
                name: "Switchgear Room No. 2",
                deck_code: "3rd",
                deck_ordinal: 3,
                zone: "Z5",
                category: "Electrical",
            },
            CompartmentRow {
                vessel: w.cvn73,
                no: "3-172-0-M",
                name: "AC Plant No. 2",
                deck_code: "3rd",
                deck_ordinal: 3,
                zone: "Z7",
                category: "Machinery / electrical",
            },
            CompartmentRow {
                vessel: w.cvn73,
                no: "3-192-2-E",
                name: "IC Terminal Room",
                deck_code: "3rd",
                deck_ordinal: 3,
                zone: "Z7",
                category: "Electrical",
            },
        ]
    }

    fn seed_work_orders(w: &DemoWorld) -> Vec<WorkOrderRow> {
        // Provenance mirrors the prototype's ingest/verified stamps. The two
        // orders whose upstream_compartment points at the incomplete Aft IC &
        // Gyro Room (4-141-0-C) are the stranded ones.
        //
        // The windows widen the further out they sit, which is how a schedule of
        // record actually reads: work in progress is pinned to days, work three
        // months out is a month-wide intention. It also means the availability
        // horizon has work in it all the way out — a hull that went empty a
        // fortnight from now would read as missing data rather than as a
        // fortnight's schedule.
        vec![
            WorkOrderRow {
                vessel: w.cvn73,
                id: WorkOrderId::from_uuid(id(0x3318)),
                code: "WI-3318",
                title: "Reserve feed water tank preservation",
                trade: "Preservation",
                system: "506 Tanks & Voids",
                compartment: "4-110-2-W",
                budget: 680,
                earned: 512,
                source_ref: "AWR 73-26-3318",
                source_verified: true,
                from_day: -9,
                to_day: 4,
            },
            WorkOrderRow {
                vessel: w.cvn73,
                id: WorkOrderId::from_uuid(id(0x3402)),
                code: "WI-3402",
                title: "Sounding & vent piping modification",
                trade: "Mechanical",
                system: "529 Drainage & Tank Level",
                compartment: "4-110-2-W",
                budget: 240,
                earned: 0,
                source_ref: "AWR 73-26-3402",
                source_verified: true,
                from_day: 5,
                to_day: 12,
            },
            WorkOrderRow {
                vessel: w.cvn73,
                id: WorkOrderId::from_uuid(id(0x4471)),
                code: "WI-4471",
                title: "Hangar Bay 2 structural hot work",
                trade: "Welding",
                system: "130 Hull Decks",
                compartment: "1-136-0-Q",
                budget: 410,
                earned: 12,
                source_ref: "AWR 73-26-4471",
                source_verified: true,
                from_day: 7,
                to_day: 95,
            },
            WorkOrderRow {
                vessel: w.cvn73,
                id: WorkOrderId::from_uuid(id(0x3905)),
                code: "WI-3905",
                title: "Aft IC preservation & cableway closure",
                trade: "Electrical",
                system: "431 Interior Comm",
                compartment: "4-141-0-C",
                budget: 340,
                earned: 0,
                source_ref: "AWR 73-26-3905",
                source_verified: false,
                from_day: 2,
                to_day: 11,
            },
            // Stranded: switchboard rip-out is ready but cannot proceed until the
            // Aft IC & Gyro Room cableway work (a different compartment) closes.
            WorkOrderRow {
                vessel: w.cvn73,
                id: WorkOrderId::from_uuid(id(0x1905)),
                code: "WI-1905",
                title: "Switchboard No. 1 rip-out",
                trade: "Electrical",
                system: "322 Power Distribution",
                compartment: "4-102-2-E",
                budget: 160,
                earned: 0,
                source_ref: "AWR 73-26-1905",
                source_verified: false,
                from_day: 40,
                to_day: 74,
            },
            // Stranded: fan-room duct insulation waits on the same upstream room.
            WorkOrderRow {
                vessel: w.cvn73,
                id: WorkOrderId::from_uuid(id(0x5571)),
                code: "WI-5571",
                title: "Fan room duct insulation",
                trade: "Preservation",
                system: "512 Ventilation & Uptakes",
                compartment: "4-120-4-Q",
                budget: 140,
                earned: 0,
                source_ref: "AWR 73-26-5571",
                source_verified: true,
                from_day: 96,
                to_day: 130,
            },
        ]
    }

    /// Resolves a hull under `scope`, applying tenant then assignment. Every
    /// scoped query funnels through here so the two gates are enforced once.
    fn scoped_vessel(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<&VesselRow, StoreError> {
        self.vessels
            .iter()
            .find(|v| v.id == vessel && v.org == scope.org && scope.is_assigned(vessel))
            .ok_or(StoreError::NotFound)
    }

    /// Assembles a [`Package`] from the seed rows: segments with their upstream
    /// pointers resolved from codes to ids, plus the work booked per compartment.
    /// This is the shape [`wadl_plan`] analyses, and the shape the PostgreSQL
    /// repositories will produce from `work_segment` / `work_segment_space`.
    fn build_package(&self, row: &PackageRow) -> Package {
        let segment_id = |code: &str| {
            self.segments
                .iter()
                .find(|s| s.package_code == row.code && s.code == code)
                .map(|s| SegmentId::from_uuid(id(s.segment_id)))
        };
        let segments = self
            .segments
            .iter()
            .filter(|s| s.package_code == row.code)
            .map(|s| Segment {
                id: SegmentId::from_uuid(id(s.segment_id)),
                code: s.code.to_owned(),
                kind: s.kind.to_owned(),
                name: s.name.to_owned(),
                // An empty upstream code marks a root, not a missing pointer.
                upstream: if s.upstream_code.is_empty() {
                    None
                } else {
                    segment_id(s.upstream_code)
                },
                compartments: s
                    .compartments
                    .iter()
                    .map(|c| CompartmentNo::new(*c))
                    .collect(),
            })
            .collect();
        let spaces = self
            .package_spaces
            .iter()
            .filter(|s| s.package_code == row.code)
            .map(|s| {
                (
                    CompartmentNo::new(s.compartment),
                    SpaceWork {
                        budget: ManHours::new(s.budget),
                        earned: ManHours::new(s.earned),
                        window: Some(self.day_window(s.from_day, s.to_day)),
                    },
                )
            })
            .collect();
        Package {
            work_order_id: WorkOrderId::from_uuid(id(row.work_order_id)),
            code: row.code.to_owned(),
            name: row.name.to_owned(),
            test_verb: row.test_verb.to_owned(),
            segments,
            spaces,
        }
    }
}

impl InMemoryStore {
    /// Projects a seed row, resolving its availability offsets against the
    /// anchor. A method rather than a free function because the window is not in
    /// the row — the row carries offsets, and only the store knows from what.
    fn summarise_vessel(&self, v: &VesselRow) -> VesselSummary {
        VesselSummary {
            vessel_id: v.id,
            hull_no: v.hull_no.to_owned(),
            name: v.name.to_owned(),
            class_code: v.class_code.to_owned(),
            availability_code: v.availability_code.to_owned(),
            confidence: v.confidence.to_owned(),
            availability: Some(self.day_window(v.avail_from_day, v.avail_to_day)),
        }
    }
}

impl InMemoryStore {
    /// Loads an ingested schedule of record for a hull, unscoped — for boot
    /// wiring (the serve binary's env hook) before any tenant exists. Request
    /// paths go through the scoped trait method instead.
    pub fn load_schedule_of_record(&self, vessel: VesselId, sor: ScheduleOfRecord) {
        self.schedule_of_record
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(vessel, sor);
    }

    fn ingested(&self, vessel: VesselId) -> Option<ScheduleOfRecord> {
        self.schedule_of_record
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&vessel)
            .cloned()
    }

    fn ingested_zones(&self, vessel: VesselId) -> Option<ZoneRegister> {
        self.zone_register
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&vessel)
            .cloned()
    }

    fn ingested_budgets(&self, vessel: VesselId) -> Option<BudgetBook> {
        self.budget_book
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&vessel)
            .cloned()
    }
}

/// The schedule of record's edges, generated from the register the same way
/// the register is generated from the work orders — so every code resolves.
///
/// Two shapes, mirroring what a real P6 export carries:
///
/// * Consecutive slices of the same work item follow finish-to-start with no
///   lag — the unremarkable spine of any schedule, and deliberately not a
///   finding.
/// * One **deliberate negative lag**, from the coating space's work into the
///   next scheduled work in another space: the successor starts eight hours
///   before its predecessor finishes — the overlap-into-a-cure inversion the
///   sample XER carries (`A6010 → A4050`) and the schedule-quality issue
///   exists to surface. Generated deterministically so the demo board always
///   has one to show.
fn schedule_edges_from(activities: &[ActivitySummary]) -> Vec<ScheduleEdgeSummary> {
    let mut edges = Vec::new();
    let work: Vec<&ActivitySummary> = activities.iter().filter(|a| !a.is_milestone).collect();
    let mut by_order: BTreeMap<&str, Vec<&ActivitySummary>> = BTreeMap::new();
    for a in &work {
        if let Some(order) = a.work_order_code.as_deref() {
            by_order.entry(order).or_default().push(a);
        }
    }
    for slices in by_order.values() {
        for pair in slices.windows(2) {
            if let [pred, succ] = pair {
                edges.push(ScheduleEdgeSummary {
                    pred_code: pred.code.clone(),
                    succ_code: succ.code.clone(),
                    kind: "PR_FS".to_owned(),
                    lag_hours: 0,
                });
            }
        }
    }
    // The inversion starts at the coating story's *open* work — a finding into
    // slices already finished would be true but toothless, and the board ranks
    // by the successor's remaining hours.
    let mut rest = work.iter();
    let pred = rest.by_ref().find(|a| {
        a.status != ActivityStatus::Complete
            && a.compartment_no
                .as_ref()
                .is_some_and(|c| c.as_str() == "3-160-2-Q")
    });
    if let Some(pred) = pred {
        let succ = rest.find(|a| {
            a.status != ActivityStatus::Complete
                && a.compartment_no.is_some()
                && a.compartment_no != pred.compartment_no
        });
        if let Some(succ) = succ {
            edges.push(ScheduleEdgeSummary {
                pred_code: pred.code.clone(),
                succ_code: succ.code.clone(),
                kind: "PR_FS".to_owned(),
                lag_hours: -8,
            });
        }
    }
    edges
}

#[async_trait::async_trait]
impl Repositories for InMemoryStore {
    async fn list_vessels(&self, scope: &TenantScope) -> Vec<VesselSummary> {
        self.vessels
            .iter()
            .filter(|v| v.org == scope.org && scope.is_assigned(v.id))
            .map(|v| self.summarise_vessel(v))
            .collect()
    }

    async fn get_vessel(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<VesselSummary, StoreError> {
        self.scoped_vessel(scope, vessel)
            .map(|v| self.summarise_vessel(v))
    }

    async fn list_compartments(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Vec<CompartmentSummary>, StoreError> {
        self.scoped_vessel(scope, vessel)?;
        Ok(self
            .compartments
            .iter()
            .filter(|c| c.vessel == vessel)
            .map(|c| {
                let compartment_no = CompartmentNo::new(c.no);
                // This seed's class declares the USN deck-frame-side-usage
                // scheme, so the placard number carries the geometry. The
                // PostgreSQL store prefers the register's own columns; here the
                // parse IS the register, and it is labelled `parsed` so the
                // surface never presents a derived position as an authored one.
                let usn = compartment_no.parse_usn();
                CompartmentSummary {
                    frame: usn.as_ref().map(|u| u.frame.get()),
                    side: usn.as_ref().map_or_else(
                        || "unknown".to_owned(),
                        |u| format!("{:?}", u.side).to_lowercase(),
                    ),
                    geometry_source: if usn.is_some() { "parsed" } else { "unknown" }.to_owned(),
                    compartment_no,
                    name: c.name.to_owned(),
                    deck_code: c.deck_code.to_owned(),
                    deck_ordinal: c.deck_ordinal,
                    zone: c.zone.to_owned(),
                    category: c.category.to_owned(),
                }
            })
            .collect())
    }

    async fn list_work_orders(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Vec<WorkOrderSummary>, StoreError> {
        self.scoped_vessel(scope, vessel)?;
        Ok(self
            .work_orders
            .iter()
            .filter(|w| w.vessel == vessel)
            .map(|w| WorkOrderSummary {
                work_order_id: w.id,
                code: w.code.to_owned(),
                title: w.title.to_owned(),
                trade: w.trade.to_owned(),
                system: w.system.to_owned(),
                compartment_no: CompartmentNo::new(w.compartment),
                budget_hours: ManHours::new(w.budget),
                earned_hours: ManHours::new(w.earned),
                source_ref: w.source_ref.to_owned(),
                source_verified: w.source_verified,
                planned: Some(self.day_window(w.from_day, w.to_day)),
            })
            .collect())
    }

    async fn list_activities(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Vec<ActivitySummary>, StoreError> {
        self.scoped_vessel(scope, vessel)?;
        let mut out = if let Some(sor) = self.ingested(vessel) {
            sor.activities
        } else {
            let mut generated = Vec::new();
            self.activities_from_orders(vessel, &mut generated);
            self.activities_from_packages(vessel, &mut generated);
            if vessel == self.vessels.first().map_or(vessel, |v| v.id) {
                self.milestones(&mut generated);
            }
            generated
        };
        // Schedule order: by planned start, then code — the order a sequence
        // board reads in.
        out.sort_by(|a, b| {
            let ka = a.planned.map_or(i64::MAX, |w| w.start.epoch_millis());
            let kb = b.planned.map_or(i64::MAX, |w| w.start.epoch_millis());
            ka.cmp(&kb).then_with(|| a.code.cmp(&b.code))
        });
        Ok(out)
    }

    async fn list_schedule_edges(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Vec<ScheduleEdgeSummary>, StoreError> {
        self.scoped_vessel(scope, vessel)?;
        if let Some(sor) = self.ingested(vessel) {
            return Ok(sor.edges);
        }
        let activities = self.list_activities(scope, vessel).await?;
        Ok(schedule_edges_from(&activities))
    }

    async fn set_schedule_of_record(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
        sor: ScheduleOfRecord,
    ) -> Result<(), StoreError> {
        self.scoped_vessel(scope, vessel)?;
        self.load_schedule_of_record(vessel, sor);
        Ok(())
    }

    async fn clear_schedule_of_record(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<(), StoreError> {
        self.scoped_vessel(scope, vessel)?;
        self.schedule_of_record
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&vessel);
        Ok(())
    }

    async fn schedule_source(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Option<String>, StoreError> {
        self.scoped_vessel(scope, vessel)?;
        Ok(self.ingested(vessel).map(|sor| sor.label))
    }

    async fn zone_register(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Option<ZoneRegister>, StoreError> {
        self.scoped_vessel(scope, vessel)?;
        Ok(self.ingested_zones(vessel))
    }

    async fn set_zone_register(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
        register: ZoneRegister,
    ) -> Result<(), StoreError> {
        self.scoped_vessel(scope, vessel)?;
        self.zone_register
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(vessel, register);
        Ok(())
    }

    async fn clear_zone_register(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<(), StoreError> {
        self.scoped_vessel(scope, vessel)?;
        self.zone_register
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&vessel);
        Ok(())
    }

    async fn budget_book(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Option<BudgetBook>, StoreError> {
        self.scoped_vessel(scope, vessel)?;
        Ok(self.ingested_budgets(vessel))
    }

    async fn set_budget_book(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
        book: BudgetBook,
    ) -> Result<(), StoreError> {
        self.scoped_vessel(scope, vessel)?;
        self.budget_book
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(vessel, book);
        Ok(())
    }

    async fn clear_budget_book(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<(), StoreError> {
        self.scoped_vessel(scope, vessel)?;
        self.budget_book
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&vessel);
        Ok(())
    }

    async fn stranded_hours(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<StrandedReport, StoreError> {
        self.scoped_vessel(scope, vessel)?;
        // Derived from real segment topology by wadl-plan, per package, rather
        // than from a single upstream pointer: the hours that matter are the ones
        // in DOWNSTREAM segments a given compartment is holding.
        let mut items: Vec<StrandedItem> = Vec::new();
        let mut total = ManHours::ZERO;
        for row in self.packages.iter().filter(|p| p.vessel == vessel) {
            let analysis = self.build_package(row).analyse();
            total = total + analysis.total_stranded();
            items.extend(analysis.stranding.into_iter().filter_map(|s| {
                // Only a compartment actually holding downstream scope belongs in
                // a *stranding* report; a compartment with merely its own work
                // left is outstanding work, not stranded work.
                if s.stranded_downstream == ManHours::ZERO {
                    return None;
                }
                Some(StrandedItem {
                    package_code: row.code.to_owned(),
                    compartment_no: s.compartment,
                    own_remaining: s.own_remaining,
                    stranded_downstream: s.stranded_downstream,
                    downstream_segments: s.downstream_segments,
                })
            }));
        }
        items.sort_by(|a, b| {
            b.stranded_downstream
                .cmp(&a.stranded_downstream)
                .then(a.compartment_no.cmp(&b.compartment_no))
        });
        Ok(StrandedReport { total, items })
    }

    async fn list_packages(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Vec<PackageSummary>, StoreError> {
        self.scoped_vessel(scope, vessel)?;
        Ok(self
            .packages
            .iter()
            .filter(|p| p.vessel == vessel)
            .map(|row| {
                let package = self.build_package(row);
                PackageSummary {
                    work_order_id: WorkOrderId::from_uuid(id(row.work_order_id)),
                    code: row.code.to_owned(),
                    name: row.name.to_owned(),
                    system: row.system.to_owned(),
                    trade: row.trade.to_owned(),
                    segment_count: package.segments.len(),
                    compartment_count: package.spaces.len(),
                    budget_hours: package.spaces.values().map(|w| w.budget).sum(),
                    earned_hours: package.spaces.values().map(|w| w.earned).sum(),
                }
            })
            .collect())
    }

    async fn append_audit(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
        action: &str,
        detail: &str,
        subject_ref: Option<&str>,
        occurred_at_ms: i64,
    ) -> Result<AuditRecord, StoreError> {
        self.scoped_vessel(scope, vessel)?;
        // A poisoned lock means a previous append panicked mid-write. Recovering
        // the guard is right here: the ledger is append-only, so a partially
        // written Vec is not a possible state, and refusing every later entry
        // would turn one panic into a permanently unusable ledger.
        let mut log = self
            .audit
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Chained per hull. Two hulls in one store are two ledgers, which is what
        // the table's `(org_id, vessel_id)` scoping means in practice.
        let prev = log
            .iter()
            .rfind(|r| r.vessel == vessel)
            .map(|r| r.entry_hash.clone());
        let entry_hash =
            crate::ledger::compute_hash(prev.as_deref(), action, detail, occurred_at_ms);
        let seq = i64::try_from(log.len()).unwrap_or(i64::MAX) + 1;
        log.push(AuditRow {
            vessel,
            action: action.to_owned(),
            detail: detail.to_owned(),
            subject_ref: subject_ref.map(str::to_owned),
            occurred_at_ms,
            prev_hash: prev.clone(),
            entry_hash: entry_hash.clone(),
        });
        Ok(AuditRecord {
            seq,
            action: action.to_owned(),
            detail: detail.to_owned(),
            subject_ref: subject_ref.map(str::to_owned),
            occurred_at_ms,
            entry_hash: hex::encode(entry_hash),
            prev_hash: prev.map(hex::encode),
        })
    }

    async fn list_audit(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
        subject_ref: Option<&str>,
    ) -> Result<Vec<AuditRecord>, StoreError> {
        self.scoped_vessel(scope, vessel)?;
        let log = self
            .audit
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Newest first: a surface asking "what was decided here" wants the last
        // decision at the top, and the history under it.
        Ok(log
            .iter()
            .enumerate()
            .filter(|(_, r)| r.vessel == vessel)
            .filter(|(_, r)| subject_ref.is_none_or(|want| r.subject_ref.as_deref() == Some(want)))
            .map(|(i, r)| AuditRecord {
                seq: i64::try_from(i).unwrap_or(i64::MAX) + 1,
                action: r.action.clone(),
                detail: r.detail.clone(),
                subject_ref: r.subject_ref.clone(),
                occurred_at_ms: r.occurred_at_ms,
                entry_hash: hex::encode(&r.entry_hash),
                prev_hash: r.prev_hash.as_ref().map(hex::encode),
            })
            .rev()
            .collect())
    }

    async fn get_package(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
        code: &str,
    ) -> Result<Package, StoreError> {
        self.scoped_vessel(scope, vessel)?;
        let row = self
            .packages
            .iter()
            .find(|p| p.vessel == vessel && p.code == code)
            .ok_or(StoreError::NotFound)?;
        Ok(self.build_package(row))
    }

    async fn list_decks(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Vec<DeckSummary>, StoreError> {
        self.scoped_vessel(scope, vessel)?;
        // The deck register is the CLASS's, not a roll-up of whichever
        // compartments happen to be keyed. Deriving it from the register made a
        // deck disappear the moment nothing was keyed on it, which is wrong twice
        // over: the ship still has that deck, and its general-arrangement plate
        // is still the thing a planner needs to look at. A count of zero is a
        // statement about our data, not about the ship.
        let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
        for compartment in self.compartments.iter().filter(|c| c.vessel == vessel) {
            *counts.entry(compartment.deck_code).or_insert(0) += 1;
        }
        Ok(CLASS_DECKS
            .iter()
            .map(|(code, label, ordinal)| DeckSummary {
                code: (*code).to_owned(),
                label: (*label).to_owned(),
                ordinal: *ordinal,
                compartment_count: counts.get(code).copied().unwrap_or(0),
            })
            .collect())
    }

    async fn adjacency_graph(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<AdjacencyGraph, StoreError> {
        self.scoped_vessel(scope, vessel)?;
        Ok(AdjacencyGraph::new(
            self.couplings
                .iter()
                .filter(|c| c.vessel == vessel)
                .map(|c| CouplingEdge {
                    from: CompartmentNo::new(c.from),
                    to: CompartmentNo::new(c.to),
                    coupling_type: CouplingTypeId::from_uuid(id(c.type_id)),
                    code: CouplingCode::new(c.code),
                    propagates: c.propagates.to_vec(),
                    max_reach: HopDepth::new(c.max_reach),
                })
                .collect(),
        ))
    }

    async fn live_hazards(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Vec<Hazard>, StoreError> {
        self.scoped_vessel(scope, vessel)?;
        Ok(self
            .hazards
            .iter()
            .filter(|h| h.vessel == vessel)
            .map(|h| Hazard {
                origin: CompartmentNo::new(h.origin),
                kind: h.kind,
                since: self.at_minutes(h.since_min),
                label: h.label.to_owned(),
            })
            .collect())
    }

    async fn rules_in_force(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<RuleSet, StoreError> {
        self.scoped_vessel(scope, vessel)?;
        // The development seed. In production this is a query over `rule_binding`
        // joined to `rule_version`, filtered to the versions whose effective
        // range covers the evaluation instant and bound to this hull's class,
        // work type and compartment category.
        Ok(RuleSet::seed_usn_hot_work())
    }
}

/// The class's deck register: code, label, ordinal — ordered downward.
///
/// This is the CVN-67/73 arrangement, and the codes are the ones the deck plates
/// are keyed to (`shell-web/src/deckSheets.json`). The PostgreSQL store reads the
/// same thing out of `class_deck`, which is the authority for the ordinal.
///
/// Ordinals ascend downward and the ones above the main deck are negative, so
/// "the deck directly above" is arithmetic rather than a lookup — which is what
/// the vertical section relies on to show a hazard crossing a deck penetration.
/// The island is deliberately absent: it is not a deck, it is a stack of levels
/// on one plate, so it has no single ordinal and no frame axis.
const CLASS_DECKS: &[(&str, &str, i32)] = &[
    ("flight", "Flight Deck", -4),
    ("o2", "O-2 Level", -3),
    ("o1", "O-1 Level", -2),
    ("gallery", "Gallery Deck", -1),
    ("Main", "Main Deck", 1),
    ("2nd", "Second Deck", 2),
    ("3rd", "Third Deck", 3),
    ("4th", "Fourth Deck", 4),
    ("1stplat", "First Platform", 5),
    ("2ndplat", "Second Platform", 6),
    ("hold", "Hold", 7),
    ("db", "Inner Bottom", 8),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn assignment_gate_hides_unassigned_hulls() {
        let (store, w) = InMemoryStore::demo();
        let scope = w.yard_scope();
        // Three assigned carriers are visible.
        assert_eq!(store.list_vessels(&scope).await.len(), 3);
        // The unassigned DDG is NotFound even though it is in-tenant.
        assert!(matches!(
            store.get_vessel(&scope, w.ddg).await,
            Err(StoreError::NotFound)
        ));
    }

    #[tokio::test]
    async fn decks_are_ordered_downward() {
        let (store, w) = InMemoryStore::demo();
        let decks = store.list_decks(&w.yard_scope(), w.cvn73).await.unwrap();
        let ordinals: Vec<i32> = decks.iter().map(|d| d.ordinal).collect();
        let mut sorted = ordinals.clone();
        sorted.sort_unstable();
        assert_eq!(ordinals, sorted, "ascending downward");
        // "Directly above" is a comparison on the ordinal, not a label guess.
        let fourth = decks.iter().find(|d| d.code == "4th").unwrap();
        let third = decks.iter().find(|d| d.code == "3rd").unwrap();
        assert!(third.ordinal < fourth.ordinal);

        // The whole class register comes back, including decks nothing is keyed
        // on. A deck that vanished when its compartments were absent took its
        // general-arrangement plate with it, which is the opposite of useful.
        assert_eq!(decks.len(), CLASS_DECKS.len());
        let flight = decks.iter().find(|d| d.code == "flight").unwrap();
        assert_eq!(flight.compartment_count, 0, "no register data yet");
        assert!(flight.ordinal < fourth.ordinal, "the flight deck is above");
        assert!(
            decks.iter().any(|d| d.compartment_count > 0),
            "and the decks we do have data for still report it"
        );
    }

    #[tokio::test]
    async fn engine_inputs_are_scoped_like_everything_else() {
        let (store, w) = InMemoryStore::demo();
        // The unassigned hull refuses the engine's inputs too — a cascade cannot
        // be used as a side channel to read another hull's topology.
        let scope = w.yard_scope();
        assert!(matches!(
            store.adjacency_graph(&scope, w.ddg).await,
            Err(StoreError::NotFound)
        ));
        assert!(matches!(
            store.live_hazards(&scope, w.ddg).await,
            Err(StoreError::NotFound)
        ));
        assert!(matches!(
            store.rules_in_force(&scope, w.ddg).await,
            Err(StoreError::NotFound)
        ));
        assert!(matches!(
            store.list_decks(&scope, w.ddg).await,
            Err(StoreError::NotFound)
        ));
    }

    #[tokio::test]
    async fn the_seeded_hull_has_live_hazards_and_a_graph() {
        let (store, w) = InMemoryStore::demo();
        let scope = w.yard_scope();
        let hazards = store.live_hazards(&scope, w.cvn73).await.unwrap();
        // A curing coat in the passage, and a live bus in the switchgear room.
        assert_eq!(hazards.len(), 2);
        let origins: Vec<&str> = hazards.iter().map(|h| h.origin.as_str()).collect();
        assert!(origins.contains(&"3-160-2-Q"));
        assert!(origins.contains(&"3-148-2-E"));
        assert!(
            store
                .adjacency_graph(&scope, w.cvn73)
                .await
                .unwrap()
                .edge_count()
                > 0
        );
        // A hull with no seeded topology returns an empty graph, not an error —
        // "nothing is coupled here" is a valid answer.
        assert_eq!(
            store
                .adjacency_graph(&scope, w.cvn71)
                .await
                .unwrap()
                .edge_count(),
            0
        );
    }

    #[tokio::test]
    async fn tenant_gate_hides_other_tenants_hull() {
        let (store, w) = InMemoryStore::demo();
        // Even assigned to every yard hull, the yard never sees the navy hull.
        assert!(matches!(
            store.get_vessel(&w.yard_scope_all(), w.navy_hull).await,
            Err(StoreError::NotFound)
        ));
    }

    #[tokio::test]
    async fn stranded_hours_count_only_hours_held_downstream() {
        let (store, w) = InMemoryStore::demo();
        let report = store
            .stranded_hours(&w.yard_scope(), w.cvn73)
            .await
            .unwrap();

        // Every reported item is holding real hours somewhere else — a
        // compartment with only its own work left is outstanding, not stranded.
        assert!(!report.items.is_empty());
        for item in &report.items {
            assert!(item.stranded_downstream > ManHours::ZERO);
            assert!(!item.downstream_segments.is_empty());
            assert!(item.own_remaining > ManHours::ZERO);
        }

        // Worst offender first, and it is on the HVAC trunk: 3-160-2-Q has 80 MH
        // of its own left and sits on T1, so it holds every branch below it.
        let worst = report.items.first().unwrap();
        assert_eq!(worst.package_code, "WI-2201");
        assert_eq!(worst.compartment_no.as_str(), "3-160-2-Q");
        assert!(report
            .items
            .windows(2)
            .all(|p| p[0].stranded_downstream >= p[1].stranded_downstream));
    }

    #[tokio::test]
    async fn a_finished_branch_is_still_held_by_its_open_trunk() {
        let (store, w) = InMemoryStore::demo();
        let package = store
            .get_package(&w.yard_scope(), w.cvn73, "WI-2201")
            .await
            .unwrap();
        let analysis = package.analyse();
        assert!(
            analysis.faults.is_empty(),
            "seed topology must be well formed"
        );

        // 3-192-2-E is complete, so segment T2's own compartments are not all
        // done (3-184-0-Q still has 40 MH) — but the key case is B3/R1 below T2.
        let by = |code: &str| {
            analysis
                .segments
                .iter()
                .find(|s| s.code == code)
                .unwrap()
                .clone()
        };
        // T1 is open at 3-160-2-Q, so nothing in the package is testable.
        assert!(!by("T1").complete);
        assert_eq!(analysis.testable_segment_count, 0);
        // And every other segment names T1 among its blockers.
        for code in ["B1", "B2", "T2", "B3", "R1"] {
            assert!(
                by(code).held_by.contains(&"T1".to_owned()),
                "{code} must be held by T1, got {:?}",
                by(code).held_by
            );
        }
    }

    #[tokio::test]
    async fn packages_are_scoped_and_unknown_codes_are_not_found() {
        let (store, w) = InMemoryStore::demo();
        let scope = w.yard_scope();
        assert_eq!(store.list_packages(&scope, w.cvn73).await.unwrap().len(), 2);
        // Out of scope hull: no packages, and no package detail.
        assert!(matches!(
            store.list_packages(&scope, w.ddg).await,
            Err(StoreError::NotFound)
        ));
        assert!(matches!(
            store.get_package(&scope, w.ddg, "WI-2201").await,
            Err(StoreError::NotFound)
        ));
        // In-scope hull, unknown package.
        assert!(matches!(
            store.get_package(&scope, w.cvn73, "WI-9999").await,
            Err(StoreError::NotFound)
        ));
    }
}
