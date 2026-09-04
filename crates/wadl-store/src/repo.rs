//! The repository seam.

use wadl_domain::ids::VesselId;
use wadl_engine::{AdjacencyGraph, Hazard, RuleSet};
use wadl_plan::Package;

use crate::error::StoreError;
use crate::model::{
    ActivitySummary, AuditRecord, CompartmentSummary, DeckSummary, PackageSummary,
    ScheduleEdgeSummary, StrandedReport, VesselSummary, WorkOrderSummary,
};
use crate::scope::TenantScope;

/// Everything the shell and API read from storage, always through a
/// [`TenantScope`]. Implementations MUST apply the scope's tenant and
/// assignment gates to every method; the in-memory implementation does so in
/// code, and the PostgreSQL implementation will do so via row-level security
/// plus an assignment filter.
///
/// Async because the real implementation talks to PostgreSQL. `#[async_trait]`
/// rather than native `async fn` in a trait: the API holds an
/// `Arc<dyn Repositories>`, and a native async fn in a trait is not
/// object-safe, so the futures have to be boxed either way.
#[async_trait::async_trait]
pub trait Repositories: Send + Sync {
    /// The hulls visible to `scope`: in-tenant AND assigned.
    async fn list_vessels(&self, scope: &TenantScope) -> Vec<VesselSummary>;

    /// Whether the store can answer, and at which schema — what `/health`
    /// reports. A database-backed store round-trips a query and reads the
    /// migration it is at; the in-memory world is always reachable and says
    /// so. Never a tenant read: health is answered before any identity is.
    async fn health(&self) -> crate::model::StoreHealth;

    /// One hull, or [`StoreError::NotFound`] if it is out of tenant or not
    /// assigned. A hull in another tenant is `NotFound`, never "forbidden".
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn get_vessel(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<VesselSummary, StoreError>;

    /// The compartment register for a hull.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn list_compartments(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Vec<CompartmentSummary>, StoreError>;

    /// The work orders on a hull, each with provenance.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn list_work_orders(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Vec<WorkOrderSummary>, StoreError>;

    /// The full activity register for a hull — every scheduled activity, mapped
    /// or not, in schedule order.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn list_activities(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Vec<ActivitySummary>, StoreError>;

    /// The schedule of record's dependency edges between activities.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn list_schedule_edges(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Vec<ScheduleEdgeSummary>, StoreError>;

    /// Where the served register comes from: `None` for the generated demo
    /// register, or the ingested export's label. Surfaced on the register so
    /// an ingested schedule never presents as the generated one (or the
    /// reverse — a demo row presenting as a scheduler's claim is worse).
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn schedule_source(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Option<String>, StoreError>;

    /// Replaces a hull's schedule of record with an ingested one.
    ///
    /// From this call on, the register, the edges and everything derived from
    /// them serve the ingested schedule. All-or-nothing at the caller: this
    /// method stores what it is given, and the mapping layer upstream refuses
    /// partial ingests.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn set_schedule_of_record(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
        sor: crate::memory::ScheduleOfRecord,
    ) -> Result<(), StoreError>;

    /// Reverts a hull to its generated register, discarding any ingested
    /// schedule of record. A no-op when none is loaded.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn clear_schedule_of_record(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<(), StoreError>;

    /// Which clock the served schedule of record's wall times were read in
    /// (`America/New_York · CVN73-clock.csv`), or `None` when no schedule
    /// is ingested or the record predates the yard clock. The clock door
    /// compares this with the clock being loaded and says when the schedule
    /// needs re-importing.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn schedule_parsed_in(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Option<String>, StoreError>;

    /// The hull's yard clock document — zone, offsets, watch and shifts —
    /// or `None` when every clock is served in UTC and says so.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn yard_clock(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Option<crate::memory::YardClockDoc>, StoreError>;

    /// Replaces a hull's yard clock. All-or-nothing at the caller: the API
    /// layer refuses a malformed clock whole.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn set_yard_clock(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
        doc: crate::memory::YardClockDoc,
    ) -> Result<(), StoreError>;

    /// Discards a hull's yard clock; every clock is UTC again. A no-op when
    /// none is loaded.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn clear_yard_clock(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<(), StoreError>;

    /// The hull's ingested zone chart — authored frame bounds per zone —
    /// or `None` when no chart has been ingested and every band a view draws
    /// is inferred from the register.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn zone_register(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Option<crate::memory::ZoneRegister>, StoreError>;

    /// Replaces a hull's zone chart with an ingested one. All-or-nothing at
    /// the caller: this stores what it is given, and the API layer upstream
    /// refuses malformed charts whole.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn set_zone_register(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
        register: crate::memory::ZoneRegister,
    ) -> Result<(), StoreError>;

    /// Discards a hull's ingested zone chart, returning the views to inferred
    /// bands. A no-op when none is loaded.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn clear_zone_register(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<(), StoreError>;

    /// The hull's ingested budget book — the hours authority per work item —
    /// or `None` when reconciliation runs against the seeded work items.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn budget_book(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Option<crate::memory::BudgetBook>, StoreError>;

    /// Replaces a hull's budget book. All-or-nothing at the caller: this
    /// stores what it is given, and the API layer refuses malformed books
    /// whole.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn set_budget_book(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
        book: crate::memory::BudgetBook,
    ) -> Result<(), StoreError>;

    /// Discards a hull's ingested budget book; reconciliation returns to the
    /// seeded work items. A no-op when none is loaded.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn clear_budget_book(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<(), StoreError>;

    /// The hull's ingested geometry register — surveyed compartment extents
    /// and deck coverage bands — or `None` when every drawn position is a
    /// placard parse and the surface says so.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn geometry_register(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Option<crate::memory::GeometryRegister>, StoreError>;

    /// Replaces a hull's geometry register. All-or-nothing at the caller.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn set_geometry_register(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
        register: crate::memory::GeometryRegister,
    ) -> Result<(), StoreError>;

    /// Discards a hull's geometry register; positions return to placard
    /// parses. A no-op when none is loaded.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn clear_geometry_register(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<(), StoreError>;

    /// The hull's ingested compartment register — its own decks and spaces
    /// — or `None` while the seeded register stands in.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn compartment_register(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Option<crate::memory::CompartmentRegister>, StoreError>;

    /// Installs (or replaces) the hull's compartment register. From the next
    /// read on, `list_compartments` and `list_decks` serve it.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn set_compartment_register(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
        register: crate::memory::CompartmentRegister,
    ) -> Result<(), StoreError>;

    /// Discards the ingested compartment register; the seed is served again.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn clear_compartment_register(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<(), StoreError>;

    /// The hull's ingested coupling register, or `None` while the seeded
    /// edges stand in.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn coupling_register(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Option<crate::memory::CouplingRegister>, StoreError>;

    /// Installs (or replaces) the hull's coupling register. From the next
    /// read on, `adjacency_graph` walks it.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn set_coupling_register(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
        register: crate::memory::CouplingRegister,
    ) -> Result<(), StoreError>;

    /// Discards the ingested coupling register; the seeded edges are walked again.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn clear_coupling_register(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<(), StoreError>;

    /// The coupling types a hull's rules bind to — what a coupling register's
    /// rows are validated against.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn coupling_types(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Vec<crate::model::CouplingTypeSummary>, StoreError>;

    /// The hull's ingested manning book — available people per trade, per
    /// half-shift — or `None` when the boards can show demand only.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn manning_book(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Option<crate::memory::ManningBook>, StoreError>;

    /// Replaces a hull's manning book. All-or-nothing at the caller.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn set_manning_book(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
        book: crate::memory::ManningBook,
    ) -> Result<(), StoreError>;

    /// Discards a hull's ingested manning book; the boards return to demand
    /// only. A no-op when none is loaded.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn clear_manning_book(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<(), StoreError>;

    /// The stranded man-hours on a hull.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn stranded_hours(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<StrandedReport, StoreError>;

    /// The hull's decks, ordered (ascending downward), so "the space directly
    /// above" is computable by the caller rather than guessed from a label.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn list_decks(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Vec<DeckSummary>, StoreError>;

    /// The hull's resolved adjacency graph — the class template with per-hull
    /// overrides applied. Input to the engine; the engine never loads it itself.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn adjacency_graph(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<AdjacencyGraph, StoreError>;

    /// The hazards live on the hull as of `at` — open coating tickets, live
    /// hot work, unisolated buses, stop-works — meaning every recorded hazard
    /// not administratively cleared by that instant.
    ///
    /// The instant matters for the past, not the future: a hazard cleared on
    /// Friday is still served for a Thursday read, so scrubbing the clock back
    /// past a clearance shows the hold that was really there. (When the hazard
    /// was *raised* is the engine's business — it carries `since` and decides
    /// from it — so a hazard raised after `at` is still returned here.)
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn live_hazards(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
        at: wadl_domain::time::Timestamp,
    ) -> Result<Vec<Hazard>, StoreError>;

    /// Records a field condition raised on the hull — a coating ticket
    /// opened, a bus energised, hot work started, a stop-work posted — from
    /// `since_ms`, and returns it as the engine will see it. The caller has
    /// already checked the space is on the register and that no live hazard
    /// of the same kind already originates there; the store only records.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn raise_hazard(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
        compartment: &str,
        kind: wadl_engine::HazardKind,
        since_ms: i64,
        label: &str,
    ) -> Result<Hazard, StoreError>;

    /// Administratively clears the live hazards of `kind` originating in
    /// `compartment` — the recorded fact verified ended by its clearing
    /// authority ("tags hung, zero energy confirmed"), as distinct from a
    /// rule's hold expiring on its own clock. Returns the hazards actually
    /// closed, as they were, for the caller's ledger entry; an empty return
    /// means nothing matched and the caller should say so rather than record
    /// a clearance of nothing.
    ///
    /// Closure, not deletion: implementations mark the hazard cleared (the
    /// PostgreSQL store sets `cleared_at`/`cleared_basis`; nothing is
    /// deleted) and every live-hazard read stops serving it.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn clear_hazard(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
        compartment: &str,
        kind: wadl_engine::HazardKind,
        basis: &str,
        cleared_at_ms: i64,
    ) -> Result<Vec<Hazard>, StoreError>;

    /// The rules in force for the hull at the evaluation instant. Rules are
    /// versioned data (ADR 0002); the engine is handed them, never hard-codes
    /// them.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn rules_in_force(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<RuleSet, StoreError>;

    /// The distributed packages on a hull.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn list_packages(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
    ) -> Result<Vec<PackageSummary>, StoreError>;

    /// Appends an entry to the hull's audit ledger, chained to the last one.
    ///
    /// `occurred_at_ms` is supplied by the caller rather than read here, because
    /// the store has no clock — the one door for wall-clock time is the injected
    /// [`wadl_domain::Clock`], and the API holds it.
    ///
    /// `detail` is hashed, so it is the record. `subject_ref` is an unhashed
    /// lookup key.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn append_audit(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
        action: &str,
        detail: &str,
        subject_ref: Option<&str>,
        occurred_at_ms: i64,
    ) -> Result<AuditRecord, StoreError>;

    /// The hull's audit entries, newest first, optionally narrowed to one subject.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`.
    async fn list_audit(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
        subject_ref: Option<&str>,
    ) -> Result<Vec<AuditRecord>, StoreError>;

    /// One package with its full segment topology and per-compartment work,
    /// ready to hand to [`wadl_plan`] for analysis.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] when the hull is outside `scope`, or no package
    /// on it carries `code`.
    async fn get_package(
        &self,
        scope: &TenantScope,
        vessel: VesselId,
        code: &str,
    ) -> Result<Package, StoreError>;
}
