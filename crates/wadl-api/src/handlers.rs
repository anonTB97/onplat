//! Request handlers. Thin: they resolve scope, call the store or the engine,
//! and shape the result. No business logic lives here.

use axum::extract::{Path, Query, State};
use axum::Json;
use serde_json::{json, Value};
use uuid::Uuid;

use wadl_domain::compartment::CompartmentNo;
use wadl_domain::ids::VesselId;
use wadl_domain::time::Timestamp;
use wadl_domain::units::ManHours;
use wadl_engine::{evaluate, Decision, EvaluationRequest};
use wadl_plan::governing_constraint;
use wadl_plan::readiness::{roll_up, Readiness, SpaceReadiness};

use crate::auth::Caller;
use crate::error::ApiError;
use crate::AppState;

/// The `?as_of=` parameter: the instant the caller wants the answer for.
///
/// Epoch milliseconds, matching how [`Timestamp`] already crosses the wire, so a
/// value read out of one response can be handed straight back in the next.
#[derive(Debug, Clone, Copy, Default, serde::Deserialize)]
pub(crate) struct AsOf {
    pub(crate) as_of: Option<i64>,
}

impl AsOf {
    /// Resolves to a concrete instant, defaulting to the clock and bounded by the
    /// hull's availability.
    ///
    /// Three properties this has to hold, in order of how badly each would hurt:
    ///
    /// 1. **Omitting the parameter is exactly today's behaviour.** The clock is
    ///    read only in that case, so every existing caller is unchanged and the
    ///    default path never depends on a bound.
    /// 2. **An instant outside the availability is refused, not clamped.** The
    ///    hull has no hazards, no schedule and no rules on file out there;
    ///    clamping would silently answer a different question than the one asked,
    ///    and the caller would have no way to tell.
    /// 3. **A hull with no dated availability refuses every `as_of`.** Not
    ///    "accepts anything" — an unbounded scrub over a hull whose dates are
    ///    unknown is a projection with nothing behind it.
    fn resolve(
        self,
        state: &AppState,
        vessel: &wadl_store::model::VesselSummary,
    ) -> Result<Timestamp, ApiError> {
        let Some(ms) = self.as_of else {
            return Ok(state.clock.now());
        };
        let at = Timestamp::from_epoch_millis(ms);
        let Some(window) = vessel.availability else {
            return Err(ApiError::OutOfRange(format!(
                "{} {} carries no availability dates, so it can only be read as of now",
                vessel.hull_no, vessel.availability_code
            )));
        };
        if window.contains(at) {
            Ok(at)
        } else {
            Err(ApiError::OutOfRange(format!(
                "as_of {}ms is outside {} {} ({}ms – {}ms)",
                ms,
                vessel.hull_no,
                vessel.availability_code,
                window.start.epoch_millis(),
                window.end.epoch_millis()
            )))
        }
    }
}

pub(crate) async fn health() -> Json<Value> {
    Json(json!({ "status": "ok", "decision_support_only": true }))
}

pub(crate) async fn list_vessels(
    State(state): State<AppState>,
    Caller(scope): Caller,
) -> Json<Value> {
    Json(json!(state.store.list_vessels(&scope).await))
}

pub(crate) async fn get_vessel(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let vessel = state
        .store
        .get_vessel(&scope, VesselId::from_uuid(id))
        .await?;
    Ok(Json(json!(vessel)))
}

pub(crate) async fn list_compartments(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let compartments = state
        .store
        .list_compartments(&scope, VesselId::from_uuid(id))
        .await?;
    Ok(Json(json!(compartments)))
}

/// The work orders on a hull, each marked with whether it is planned for `as_of`.
///
/// The list is never filtered by the instant. A planner scrubbing to next week
/// still needs to see the order that finished last week — what changes is whether
/// it reads as in progress, and that is a flag, not an omission.
pub(crate) async fn list_work_orders(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
    Query(as_of): Query<AsOf>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    let at = as_of.resolve(&state, &state.store.get_vessel(&scope, vessel).await?)?;
    let orders = state.store.list_work_orders(&scope, vessel).await?;
    let rows: Vec<Value> = orders
        .into_iter()
        .map(|o| {
            let mut row = json!(o);
            if let Some(obj) = row.as_object_mut() {
                obj.insert("in_window".to_owned(), json!(o.booked_at(at)));
            }
            row
        })
        .collect();
    Ok(Json(json!(rows)))
}

/// The full activity register — every scheduled activity at the doing grain,
/// marked with whether it is planned for `as_of` and whether it can execute as
/// planned.
///
/// Marked, never filtered, on the same reasoning as the work-order list: a
/// planner reading next week still needs to see the activity that finished last
/// week, and an omission is indistinguishable from missing data.
///
/// Executability is the A4 derivation from `wadl-issues`: the activity's
/// compartment evaluated over its planned window, exactly (see that crate's
/// piecewise-constancy argument). It deliberately does **not** move with
/// `as_of` — "as planned" is a property of the plan against the hazards on
/// file, not of where the reader has scrubbed the clock.
///
/// The response also says where the register came from (`schedule_source`:
/// null for the generated demo register, the export's label once one is
/// ingested) and carries the reconciliation report: register hours per work
/// item against the work orders' and packages' own budgets. For the generated
/// register the report is empty by construction; for an ingested schedule it
/// is the honest account of what the export does and does not cover.
///
/// Dependency edges ride along (`edges`), at the activity-code grain, so a
/// Gantt can draw the logic the dates were computed from — including the
/// negative lags where cure-window inversions hide.
pub(crate) async fn list_activities(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
    Query(as_of): Query<AsOf>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    let at = as_of.resolve(&state, &state.store.get_vessel(&scope, vessel).await?)?;
    let activities = state.store.list_activities(&scope, vessel).await?;
    let graph = state.store.adjacency_graph(&scope, vessel).await?;
    let hazards = state.store.live_hazards(&scope, vessel).await?;
    let rules = state.store.rules_in_force(&scope, vessel).await?;
    let hull = wadl_issues::Hull {
        graph: &graph,
        rules: &rules,
        hazards: &hazards,
    };
    let source = state.store.schedule_source(&scope, vessel).await?;
    let schedule_edges = state.store.list_schedule_edges(&scope, vessel).await?;
    let reconciliation = reconcile(&state, &scope, vessel, &activities).await?;
    let rows: Vec<Value> = activities
        .into_iter()
        .map(|a| {
            let exec = wadl_issues::executability(&hull, a.compartment_no.as_ref(), a.planned);
            let mut row = json!(a);
            if let Some(obj) = row.as_object_mut() {
                obj.insert("in_window".to_owned(), json!(a.booked_at(at)));
                obj.insert("remaining_hours".to_owned(), json!(a.remaining_hours()));
                obj.insert("executability".to_owned(), json!(exec));
            }
            row
        })
        .collect();
    Ok(Json(json!({
        "as_of": at,
        "schedule_source": source,
        "reconciliation": reconciliation,
        "edges": schedule_edges,
        "activities": rows,
    })))
}

/// Register hours per work item versus the work items' own budgets.
///
/// Only mismatches are reported — a reconciled item is silence, not a row —
/// plus the budgeted hours the register maps to no work item at all. For the
/// generated register this is empty by construction (a test pins it); once a
/// real export is the register, this is where "the schedule does not cover the
/// package work" stops being a surprise in a meeting.
async fn reconcile(
    state: &AppState,
    scope: &wadl_store::TenantScope,
    vessel: VesselId,
    activities: &[wadl_store::model::ActivitySummary],
) -> Result<Value, ApiError> {
    let mut by_item: std::collections::BTreeMap<&str, (i64, i64)> =
        std::collections::BTreeMap::new();
    let mut unmapped_budget = 0_i64;
    for a in activities.iter().filter(|a| !a.is_milestone) {
        match a.work_order_code.as_deref() {
            Some(code) => {
                let entry = by_item.entry(code).or_insert((0, 0));
                entry.0 += a.budget_hours.get();
                entry.1 += a.earned_hours.get();
            }
            None => unmapped_budget += a.budget_hours.get(),
        }
    }
    let orders = state.store.list_work_orders(scope, vessel).await?;
    let packages = state.store.list_packages(scope, vessel).await?;
    let targets = orders
        .iter()
        .map(|o| (o.code.as_str(), o.budget_hours, o.earned_hours))
        .chain(
            packages
                .iter()
                .map(|p| (p.code.as_str(), p.budget_hours, p.earned_hours)),
        );
    let mismatches: Vec<Value> = targets
        .filter_map(|(code, budget, earned)| {
            let (rb, re) = by_item.get(code).copied().unwrap_or((0, 0));
            (rb != budget.get() || re != earned.get()).then(|| {
                json!({
                    "code": code,
                    "item_budget": budget,
                    "register_budget": rb,
                    "item_earned": earned,
                    "register_earned": re,
                })
            })
        })
        .collect();
    Ok(json!({
        "mismatches": mismatches,
        "unmapped_budget_hours": unmapped_budget,
    }))
}

/// The hull's time frame: the server's clock and the availability it bounds
/// `as_of` with.
///
/// One read, and the shell's whole time control is built from it. Serving the
/// server's `now` matters more than it looks: a browser clock that is minutes or
/// hours out would otherwise make the shell mark a live view as a projection, or
/// worse, mark a projection as live.
pub(crate) async fn timeframe(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let vessel = state
        .store
        .get_vessel(&scope, VesselId::from_uuid(id))
        .await?;
    Ok(Json(json!({
        "now": state.clock.now(),
        "availability_code": vessel.availability_code,
        "availability": vessel.availability,
    })))
}

pub(crate) async fn stranded_hours(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let report = state
        .store
        .stranded_hours(&scope, VesselId::from_uuid(id))
        .await?;
    Ok(Json(json!(report)))
}

/// The hull's decks, ordered downward.
pub(crate) async fn list_decks(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let decks = state
        .store
        .list_decks(&scope, VesselId::from_uuid(id))
        .await?;
    Ok(Json(json!(decks)))
}

/// Reads one compartment's authorization state **through the engine**.
///
/// The handler's whole job is to assemble the engine's inputs — the hull's
/// resolved adjacency graph, the live hazards, the rules in force, and the
/// evaluation instant from the injected clock — and to persist/return what comes
/// back. It computes no authorization itself, which is the seam that lets the
/// same engine build run in the browser and on a phone.
pub(crate) async fn compartment_state(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path((id, compartment)): Path<(Uuid, String)>,
    Query(as_of): Query<AsOf>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    let at = as_of.resolve(&state, &state.store.get_vessel(&scope, vessel).await?)?;
    let decision = decide(&state, &scope, vessel, &compartment, at).await?;
    Ok(Json(
        json!({ "compartment": compartment, "decision": decision, "as_of": at }),
    ))
}

/// The work booked in one compartment: hours left, the orders, and the trades.
///
/// **One implementation, every caller.** A distributed package books its hours per
/// *segment*, so a compartment inside a package footprint has no work order of its
/// own and has to be picked up from the package.
///
/// The source of those hours is each package's own **footprint**
/// ([`wadl_plan::Package::spaces`]) and nothing else. It was briefly the stranded
/// report, which was wrong in a way worth remembering: that report lists the
/// compartments that *cause* stranding, not an inventory of booked work. On the
/// seeded hull it named three compartments out of an eleven-compartment footprint,
/// so 1,919 of 2,059 package man-hours went unseen — and, worse, unseen by the
/// very coverage figure built to catch hours the register cannot account for. A
/// report about causes is not a ledger.
struct BookedWork {
    remaining: ManHours,
    stranded_downstream: ManHours,
    order_codes: Vec<String>,
    trades: Vec<String>,
}

/// A package's footprint, paired with the trade that owns it.
struct PackageWork {
    code: String,
    trade: String,
    spaces: std::collections::BTreeMap<CompartmentNo, wadl_plan::SpaceWork>,
}

/// Reads every package on the hull with its footprint. Small N by construction —
/// a hull has a handful of distributed packages, not thousands.
async fn packages_with_footprints(
    state: &AppState,
    scope: &wadl_store::TenantScope,
    vessel: VesselId,
) -> Result<Vec<PackageWork>, ApiError> {
    let summaries = state.store.list_packages(scope, vessel).await?;
    let mut out = Vec::with_capacity(summaries.len());
    for summary in summaries {
        let package = state
            .store
            .get_package(scope, vessel, &summary.code)
            .await?;
        out.push(PackageWork {
            code: summary.code,
            trade: summary.trade,
            spaces: package.spaces,
        });
    }
    Ok(out)
}

fn booked_work(
    compartment: &CompartmentNo,
    orders: &[wadl_store::model::WorkOrderSummary],
    packages: &[PackageWork],
    stranded: &wadl_store::model::StrandedReport,
    at: Timestamp,
) -> BookedWork {
    // Work counts as booked here only if it is planned for `at`. This is what
    // makes readiness a question about a moment rather than about the whole
    // availability: a space with nobody due in it is idle, not held, and a board
    // that ignored the dates would report every space as held from the first day
    // of the availability to the last.
    let in_space: Vec<_> = orders
        .iter()
        .filter(|o| &o.compartment_no == compartment && o.booked_at(at))
        .collect();
    // Every package whose footprint includes this compartment, with hours left.
    let in_packages: Vec<_> = packages
        .iter()
        .filter_map(|p| {
            p.spaces
                .get(compartment)
                .filter(|w| w.booked_at(at))
                .map(|w| (p, w.remaining()))
        })
        .filter(|(_, remaining)| remaining.get() > 0)
        .collect();

    let mut trades: Vec<String> = in_space.iter().map(|o| o.trade.clone()).collect();
    // A package's trade is the package's own — its owning order is not in the
    // work-order list, so looking there leaves every package space reading "no
    // trade recorded", which is exactly the work the trade lens most needs named.
    trades.extend(in_packages.iter().map(|(p, _)| p.trade.clone()));
    trades.sort_unstable();
    trades.dedup();

    let mut order_codes: Vec<String> = in_space.iter().map(|o| o.code.clone()).collect();
    order_codes.extend(in_packages.iter().map(|(p, _)| p.code.clone()));
    order_codes.sort_unstable();
    order_codes.dedup();

    BookedWork {
        remaining: in_space
            .iter()
            .map(|o| o.remaining_hours())
            .chain(in_packages.iter().map(|(_, r)| *r))
            .fold(ManHours::ZERO, |a, b| a + b),
        // Stranding IS the stranded report's job: hours in OTHER compartments that
        // cannot be tested until this one clears. That is a claim about causes, so
        // the causes report is the right source for it.
        stranded_downstream: stranded
            .items
            .iter()
            .filter(|i| &i.compartment_no == compartment)
            .map(|i| i.stranded_downstream)
            .fold(ManHours::ZERO, |a, b| a + b),
        order_codes,
        trades,
    }
}

/// Every compartment on the hull with its current authorization state — the
/// query Deck Explorer draws a deck sheet from.
pub(crate) async fn deck_states(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
    Query(as_of): Query<AsOf>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    let at = as_of.resolve(&state, &state.store.get_vessel(&scope, vessel).await?)?;
    let compartments = state.store.list_compartments(&scope, vessel).await?;
    let graph = state.store.adjacency_graph(&scope, vessel).await?;
    let hazards = state.store.live_hazards(&scope, vessel).await?;
    let rules = state.store.rules_in_force(&scope, vessel).await?;
    let orders = state.store.list_work_orders(&scope, vessel).await?;
    let packages = packages_with_footprints(&state, &scope, vessel).await?;
    let stranded = state.store.stranded_hours(&scope, vessel).await?;

    let rows: Vec<Value> = compartments
        .into_iter()
        .map(|compartment| {
            let decision = evaluate(&EvaluationRequest {
                subject: &compartment.compartment_no,
                graph: &graph,
                rules: &rules,
                hazards: &hazards,
                at,
            });
            let work = booked_work(
                &compartment.compartment_no,
                &orders,
                &packages,
                &stranded,
                at,
            );
            let remaining = work.remaining.get();

            json!({
                "compartment": compartment,
                "state": decision.state,
                "permits_work": decision.permits_work(),
                "rules_fired": decision.trace.iter().map(|s| &s.rule_code).collect::<Vec<_>>(),
                "earliest_clear": decision.earliest_clear,
                "trades": work.trades,
                "work_order_codes": work.order_codes,
                "remaining_hours": remaining,
                "stranded_hours": work.stranded_downstream.get(),
                // Served rather than re-derived in the browser. The four-way
                // taxonomy is `wadl_plan::readiness`'s, and having two
                // implementations of it — one here, one in the shell — is how the
                // ship board and the deck plan start disagreeing about which
                // spaces are costing money.
                "readiness": Readiness::of(decision.permits_work(), remaining > 0),
                // Who can release it, for the readiness overlay's tooltip. From
                // the line that decided the state, not the first line reached.
                "clearing_authority": decision
                    .governing_step()
                    .map(|s| s.clearing_authority.as_str())
                    .unwrap_or_default(),
            })
        })
        .collect();
    Ok(Json(json!(rows)))
}

/// The hull rolled up to ship, zone and deck — the Deck Explorer's altitudes.
///
/// The rollup arithmetic is [`wadl_plan::readiness`], not this handler. That
/// matters: "620 man-hours are held behind the marine chemist" is a number that
/// re-sequences an availability, and it is property-tested in a pure crate
/// rather than assembled here where nothing could check it adds up.
///
/// Authorization still comes only from the engine. This endpoint joins the
/// engine's decision to the hours booked in each space — which is a different
/// question (*is anyone held up?*) from the one the engine answers (*may work
/// proceed?*), and the two are kept apart deliberately.
pub(crate) async fn readiness(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
    Query(as_of): Query<AsOf>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    let at = as_of.resolve(&state, &state.store.get_vessel(&scope, vessel).await?)?;
    let compartments = state.store.list_compartments(&scope, vessel).await?;
    let graph = state.store.adjacency_graph(&scope, vessel).await?;
    let hazards = state.store.live_hazards(&scope, vessel).await?;
    let rules = state.store.rules_in_force(&scope, vessel).await?;
    let orders = state.store.list_work_orders(&scope, vessel).await?;
    // Distributed packages book their hours per *segment*, so a compartment in a
    // package footprint has no work order of its own. Without this the rollup
    // reports zero hours held in exactly the spaces the cascade suspends — the
    // held column reads clean while six compartments are shut. The stranded
    // report already carries per-compartment package hours, derived from real
    // segment topology by `wadl_plan`, so it is the right source.
    let stranded = state.store.stranded_hours(&scope, vessel).await?;
    let packages = packages_with_footprints(&state, &scope, vessel).await?;

    // Hours in the hull's work that name a compartment the register does not
    // contain. Handed to the rollup rather than dropped: a footprint authored
    // against the class, a hull delta that removed a space, or a mis-keyed
    // placard all land here, and a board that silently omitted them would
    // under-report what is outstanding.
    let registered: std::collections::BTreeSet<&CompartmentNo> =
        compartments.iter().map(|c| &c.compartment_no).collect();
    // Filtered by `at` on the same terms as the attributed hours below. Without
    // that the two halves of the rollup answer different questions: scrub forward
    // and the attributed hours fall away while these stay, so a board reports that
    // the only outstanding work on the hull is mis-keyed. The coverage figure
    // exists to catch hours the register cannot account for, not to inflate them.
    let unattributed = packages
        .iter()
        .flat_map(|p| p.spaces.iter())
        .filter(|(no, w)| !registered.contains(no) && w.booked_at(at))
        .map(|(_, w)| w.remaining())
        .fold(ManHours::ZERO, |a, b| a + b);

    let spaces: Vec<SpaceReadiness> = compartments
        .into_iter()
        .map(|compartment| {
            let decision = evaluate(&EvaluationRequest {
                subject: &compartment.compartment_no,
                graph: &graph,
                rules: &rules,
                hazards: &hazards,
                at,
            });
            let work = booked_work(
                &compartment.compartment_no,
                &orders,
                &packages,
                &stranded,
                at,
            );

            SpaceReadiness {
                compartment_no: compartment.compartment_no.as_str().to_owned(),
                zone: compartment.zone.clone(),
                deck_code: compartment.deck_code.clone(),
                permits_work: decision.permits_work(),
                remaining: work.remaining,
                trades: work.trades,
                // Empty rather than "unspecified" when nothing is holding: the
                // rollup groups by this string, and inventing a holder for an
                // unheld space would put a phantom name on the ship board.
                clearing_authority: decision
                    .governing_step()
                    .map(|s| s.clearing_authority.clone())
                    .unwrap_or_default(),
                stranded_downstream: work.stranded_downstream,
            }
        })
        .collect();

    Ok(Json(json!(roll_up(&spaces, unattributed))))
}

/// Assembles the world mitigation options are computed against.
///
/// The hours per space are the hours booked **at `at`**, from the same
/// [`booked_work`] every other surface uses. That matters more than it looks: the
/// leverage figure an option is ranked by is a man-hour count, and if it came from
/// a second implementation of "what is booked here" the options board and the
/// readiness board would rank the same action differently.
struct MitigationInputs {
    graph: wadl_engine::AdjacencyGraph,
    hazards: Vec<wadl_engine::Hazard>,
    rules: wadl_engine::RuleSet,
    compartments: Vec<wadl_store::model::CompartmentSummary>,
    orders: Vec<wadl_store::model::WorkOrderSummary>,
    packages: Vec<PackageWork>,
    stranded: wadl_store::model::StrandedReport,
}

impl MitigationInputs {
    /// The hours booked in every space **at `at`**.
    ///
    /// A closure over this, handed to `wadl_mitigate`, because an option that waits
    /// is evaluated at a future instant and must be priced there too — and because
    /// the hours have to come from the same [`booked_work`] every other board uses.
    fn loads(&self, at: Timestamp) -> Vec<wadl_mitigate::SpaceLoad> {
        self.compartments
            .iter()
            .map(|c| wadl_mitigate::SpaceLoad {
                booked: booked_work(
                    &c.compartment_no,
                    &self.orders,
                    &self.packages,
                    &self.stranded,
                    at,
                )
                .remaining,
                compartment: c.compartment_no.clone(),
            })
            .collect()
    }

    fn contains(&self, compartment: &CompartmentNo) -> bool {
        self.compartments
            .iter()
            .any(|c| &c.compartment_no == compartment)
    }
}

async fn mitigation_inputs(
    state: &AppState,
    scope: &wadl_store::TenantScope,
    vessel: VesselId,
) -> Result<MitigationInputs, ApiError> {
    Ok(MitigationInputs {
        graph: state.store.adjacency_graph(scope, vessel).await?,
        hazards: state.store.live_hazards(scope, vessel).await?,
        rules: state.store.rules_in_force(scope, vessel).await?,
        compartments: state.store.list_compartments(scope, vessel).await?,
        orders: state.store.list_work_orders(scope, vessel).await?,
        packages: packages_with_footprints(state, scope, vessel).await?,
        stranded: state.store.stranded_hours(scope, vessel).await?,
    })
}

/// What could be done about one refused compartment, ranked by work recovered.
///
/// Every option in the response is a **counterfactual engine verdict**: the world
/// was rebuilt with that one action taken and the whole hull re-evaluated. None of
/// it is a remedy looked up in a table, which is why each option can state what it
/// frees *and what it would shut*.
///
/// Decision support, not automation. This proposes; a planner chooses; nothing
/// here changes a hazard, a schedule or an authorization.
pub(crate) async fn mitigations(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path((id, compartment)): Path<(Uuid, String)>,
    Query(as_of): Query<AsOf>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    let at = as_of.resolve(&state, &state.store.get_vessel(&scope, vessel).await?)?;
    let inputs = mitigation_inputs(&state, &scope, vessel).await?;
    let subject = CompartmentNo::new(compartment);
    // A placard the register does not contain is not-found, not an ALLOW. Answering
    // "nothing is holding 9-999-9-Z" is a confident statement about a space that
    // does not exist.
    if !inputs.contains(&subject) {
        return Err(ApiError::NotFound);
    }
    let loads = |instant: Timestamp| inputs.loads(instant);
    let world = wadl_mitigate::World {
        graph: &inputs.graph,
        rules: &inputs.rules,
        hazards: &inputs.hazards,
        at,
        loads: &loads,
    };
    let assessment = wadl_mitigate::assess(&world, &subject);
    // The history comes with the options in one read. A planner deciding what to do
    // needs to know what was already tried and rejected, and making that a second
    // request means a surface can forget to ask.
    let decided = state
        .store
        .list_audit(&scope, vessel, Some(subject.as_str()))
        .await?;
    let mut body = json!(assessment);
    if let Some(obj) = body.as_object_mut() {
        obj.insert("as_of".to_owned(), json!(at));
        obj.insert("decisions".to_owned(), json!(decided));
    }
    Ok(Json(body))
}

/// What a planner decided about a proposed option.
///
/// The whole option is echoed back in the request rather than re-derived from an
/// id, and that is deliberate. The record has to say what was on the screen when
/// the choice was made — the effect was priced under a rule set and a hazard state
/// that will both have moved on. Re-deriving "what would this have freed" years
/// later answers a different question.
#[derive(Debug, serde::Deserialize)]
pub(crate) struct DecisionBody {
    /// `accepted` or `rejected`.
    disposition: String,
    /// The option as the planner saw it.
    option: Value,
    /// Why. Optional on accept, and the surface should press for it on reject.
    #[serde(default)]
    reason: String,
    /// The instant the options were computed for.
    #[serde(default)]
    as_of: Option<i64>,
}

/// The immutable content of a decision, in a fixed field order.
///
/// A struct rather than an ad-hoc object because this is **hashed**: the ledger
/// chains on the serialised `detail`, so its byte layout has to be stable. A map
/// whose key order depended on insertion would produce a different hash for the
/// same decision.
#[derive(Debug, serde::Serialize)]
struct DecisionDetail<'a> {
    subject: &'a str,
    disposition: &'a str,
    as_of_ms: i64,
    reason: &'a str,
    /// Who decided, as far as the platform can currently tell.
    ///
    /// The tenant, because that is the only identity milestone 1 has: the caller is
    /// a header shim, not a session. Recorded anyway rather than omitted, so the
    /// field exists in the chain from the first entry and adding a real person later
    /// is not a change to the hashed shape of every historical record.
    decided_by_org: String,
    /// The option **as the server re-derived it**, not as the client sent it.
    option: &'a Value,
}

/// Records a planner's disposition of an option in the audit ledger.
///
/// This does **not** apply the mitigation. Nothing here clears a hazard, moves a
/// date or grants an authorization — the platform flags and prices; the yard acts.
/// What is written is a statement that this option was on offer and was taken or
/// turned down, which is the part a board of inquiry asks about and the part no other
/// system holds.
///
/// It does not yet say *who*, and this comment used to claim it did. Milestone 1's
/// caller is a header shim rather than a session, so the tenant is the only identity
/// available; it is recorded as `decided_by_org`, and the person arrives with
/// authentication. Overstating that would be the worst possible thing to overstate
/// about an audit record.
pub(crate) async fn record_decision(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path((id, compartment)): Path<(Uuid, String)>,
    body: Result<Json<DecisionBody>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    // Scope first, and before the body is looked at: a caller with no business
    // reading this hull must get the same not-found as for any other route, and
    // must not be able to tell a malformed body from a foreign hull. Taking the body
    // as a `Result` is what defers its rejection to here — as an `Option`, a
    // malformed body was indistinguishable from an absent one and every parse
    // failure was reported as "a decision needs a body".
    let hull = state.store.get_vessel(&scope, vessel).await?;
    let body = match body {
        Ok(Json(body)) => body,
        Err(rejection) => return Err(ApiError::OutOfRange(rejection.body_text())),
    };

    let disposition = match body.disposition.as_str() {
        "accepted" => "MITIGATION_ACCEPTED",
        "rejected" => "MITIGATION_REJECTED",
        other => {
            return Err(ApiError::OutOfRange(format!(
                "disposition must be accepted or rejected, got {other:?}"
            )))
        }
    };
    let at = AsOf { as_of: body.as_of }.resolve(&state, &hull)?;

    // The submitted option is checked against what the engine actually offers, and
    // the SERVER's copy is what gets recorded.
    //
    // This is the difference between a tamper-evident ledger and a tamper-evident
    // record of whatever a client posted. Hashing the client's blob would let the
    // chain attest, unfalsifiably, to an option with an invented effect the engine
    // never produced: the hash would verify perfectly and the content would be
    // fiction. So the assessment is re-derived and the action matched into it.
    let subject = CompartmentNo::new(&compartment);
    let inputs = mitigation_inputs(&state, &scope, vessel).await?;
    if !inputs.contains(&subject) {
        return Err(ApiError::NotFound);
    }
    let verified = {
        let loads = |instant: Timestamp| inputs.loads(instant);
        let world = wadl_mitigate::World {
            graph: &inputs.graph,
            rules: &inputs.rules,
            hazards: &inputs.hazards,
            at,
            loads: &loads,
        };
        let assessment = wadl_mitigate::assess(&world, &subject);
        // Matched on the action — the part a planner actually chose. The effect is
        // the server's own computation regardless of what arrived.
        let submitted = body.option.get("action").cloned().unwrap_or(Value::Null);
        assessment
            .options
            .into_iter()
            .find(|o| json!(o.action) == submitted)
            .map(|o| json!(o))
            .or_else(|| {
                let plan = assessment.combined?;
                (json!(plan.actions) == body.option.get("actions").cloned().unwrap_or(Value::Null))
                    .then(|| json!(plan))
            })
    };
    let Some(option) = verified else {
        return Err(ApiError::OutOfRange(format!(
            "that option is not on offer for {compartment} at this instant, so it cannot \
             be recorded as a decision"
        )));
    };

    let detail = DecisionDetail {
        subject: &compartment,
        disposition: &body.disposition,
        as_of_ms: at.epoch_millis(),
        reason: &body.reason,
        decided_by_org: scope.org.to_string(),
        option: &option,
    };
    // A serialisation failure on a struct of strings and numbers is not reachable;
    // an empty detail would still be chained and would still verify, so there is
    // nothing to gain from failing the request over it.
    let detail = serde_json::to_string(&detail).unwrap_or_default();

    let record = state
        .store
        .append_audit(
            &scope,
            vessel,
            disposition,
            &detail,
            Some(&compartment),
            state.clock.now().epoch_millis(),
        )
        .await?;
    Ok(Json(json!(record)))
}

/// The hull's highest-leverage actions — the answer to *what is worth doing at
/// all*, as opposed to *what opens this one space*.
///
/// Deduplicated by action across every held space, so the one isolation holding
/// six compartments appears once with its full effect rather than six times.
pub(crate) async fn leverage(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
    Query(as_of): Query<AsOf>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    let at = as_of.resolve(&state, &state.store.get_vessel(&scope, vessel).await?)?;
    let inputs = mitigation_inputs(&state, &scope, vessel).await?;
    let loads = |instant: Timestamp| inputs.loads(instant);
    let world = wadl_mitigate::World {
        graph: &inputs.graph,
        rules: &inputs.rules,
        hazards: &inputs.hazards,
        at,
        loads: &loads,
    };
    Ok(Json(json!({
        "as_of": at,
        "actions": wadl_mitigate::leverage(&world),
    })))
}

/// The full issue derivation for one hull at one instant, shared by the board
/// read and the acknowledgement write — the write validates against exactly
/// what the read would serve, so an ack can never attach to a finding that is
/// not on the board.
async fn derived_issues(
    state: &AppState,
    scope: &wadl_store::TenantScope,
    vessel: VesselId,
    at: Timestamp,
) -> Result<Vec<wadl_issues::Issue>, ApiError> {
    let inputs = mitigation_inputs(state, scope, vessel).await?;
    let activities = state.store.list_activities(scope, vessel).await?;
    let loads = |instant: Timestamp| inputs.loads(instant);
    let world = wadl_mitigate::World {
        graph: &inputs.graph,
        rules: &inputs.rules,
        hazards: &inputs.hazards,
        at,
        loads: &loads,
    };
    let rows: Vec<wadl_issues::RegisterRow<'_>> = activities
        .iter()
        .filter(|a| !a.is_milestone)
        .map(|a| wadl_issues::RegisterRow {
            code: &a.code,
            name: &a.name,
            trade: &a.trade,
            compartment: a.compartment_no.as_ref(),
            planned: a.planned,
            remaining: a.remaining_hours(),
        })
        .collect();
    let stranded: Vec<wadl_issues::Stranding<'_>> = inputs
        .stranded
        .items
        .iter()
        .map(|s| wadl_issues::Stranding {
            compartment: &s.compartment_no,
            own_remaining: s.own_remaining,
            stranded_downstream: s.stranded_downstream,
            downstream_segments: s.downstream_segments.len(),
        })
        .collect();
    let schedule_edges = state.store.list_schedule_edges(scope, vessel).await?;
    let edges: Vec<wadl_issues::ScheduleEdge<'_>> = schedule_edges
        .iter()
        .map(|e| wadl_issues::ScheduleEdge {
            pred: &e.pred_code,
            succ: &e.succ_code,
            lag_hours: e.lag_hours,
        })
        .collect();
    Ok(wadl_issues::derive(&world, &rows, &stranded, &edges))
}

/// The issue board: every way the platform can show planned work is in
/// trouble, ranked by man-hours at risk.
///
/// Every row is a claim with evidence: a real engine refusal with crews booked,
/// a compound hold straight from the options planner, an activity shown
/// non-executable over its own window, a stranding read off real segment
/// topology, or a schedule-quality finding read off the schedule of record's
/// own dependency edges.
///
/// Each row also carries its lifecycle, joined from the audit ledger rather
/// than stored on the issue — the issue is re-derived on every read and holds
/// no state of its own. `acknowledged` is the ledger's `ISSUE_ACKNOWLEDGED`
/// entry for this issue's stable key; `decision` is the latest mitigation
/// disposition recorded against the issue's space. Both ride along and neither
/// removes the row: an acknowledged issue is still an issue, it is just an
/// issue somebody has answered for.
pub(crate) async fn issues(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
    Query(as_of): Query<AsOf>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    let at = as_of.resolve(&state, &state.store.get_vessel(&scope, vessel).await?)?;
    let issues = derived_issues(&state, &scope, vessel, at).await?;
    let hours_at_risk: i64 = issues.iter().map(|i| i.hours_at_risk().get()).sum();

    // The lifecycle join. One ledger read; newest-first order means the first
    // record seen per subject is the latest word on it.
    let ledger = state.store.list_audit(&scope, vessel, None).await?;
    let mut acks: std::collections::HashMap<&str, &wadl_store::model::AuditRecord> =
        std::collections::HashMap::new();
    let mut decisions: std::collections::HashMap<&str, &wadl_store::model::AuditRecord> =
        std::collections::HashMap::new();
    for rec in &ledger {
        let Some(subject) = rec.subject_ref.as_deref() else {
            continue;
        };
        match rec.action.as_str() {
            "ISSUE_ACKNOWLEDGED" => {
                acks.entry(subject).or_insert(rec);
            }
            "MITIGATION_ACCEPTED" | "MITIGATION_REJECTED" => {
                decisions.entry(subject).or_insert(rec);
            }
            _ => {}
        }
    }
    let field = |rec: &wadl_store::model::AuditRecord, name: &str| -> Value {
        serde_json::from_str::<Value>(&rec.detail)
            .ok()
            .and_then(|d| d.get(name).cloned())
            .unwrap_or(Value::Null)
    };
    let rows: Vec<Value> = issues
        .iter()
        .map(|i| {
            let mut row = json!(i);
            if let Some(obj) = row.as_object_mut() {
                obj.insert("key".to_owned(), json!(i.key()));
                let ack = acks
                    .get(i.key().as_str())
                    .map(|rec| json!({ "at": rec.occurred_at_ms, "note": field(rec, "note") }));
                obj.insert("acknowledged".to_owned(), ack.unwrap_or(Value::Null));
                let decision = i
                    .space()
                    .and_then(|c| decisions.get(c.as_str()))
                    .map(|rec| {
                        json!({
                            "disposition": field(rec, "disposition"),
                            "at": rec.occurred_at_ms,
                            "reason": field(rec, "reason"),
                        })
                    });
                obj.insert("decision".to_owned(), decision.unwrap_or(Value::Null));
            }
            row
        })
        .collect();
    Ok(Json(json!({
        "as_of": at,
        "hours_at_risk": hours_at_risk,
        "issues": rows,
    })))
}

/// An acknowledgement, as posted: which finding, and what the acknowledger has
/// to say for it.
#[derive(Debug, serde::Deserialize)]
pub(crate) struct AckBody {
    /// The issue's stable key, as served on the board.
    key: String,
    /// Why it is acknowledged — pressed for on the surface, optional here.
    #[serde(default)]
    note: String,
    /// The instant the board was read at.
    #[serde(default)]
    as_of: Option<i64>,
}

/// The immutable content of an acknowledgement, in a fixed field order — the
/// ledger chains on the serialised detail, so its byte layout must be stable
/// (see [`DecisionDetail`]).
#[derive(Debug, serde::Serialize)]
struct AckDetail<'a> {
    key: &'a str,
    note: &'a str,
    as_of_ms: i64,
    /// The tenant, because that is the only identity milestone 1 has — same
    /// honesty as `DecisionDetail::decided_by_org`.
    acknowledged_by_org: String,
    /// The issue **as the server derived it** when the ack landed — the claim
    /// and its priced hours at that instant, not whatever a client believed.
    issue: Value,
}

/// Records that somebody answered for an issue on the board.
///
/// This does not close, hide or fix anything — the issue keeps deriving as
/// long as its facts hold, and the board keeps showing it. What changes is
/// that the row now carries who answered for it and why, out of the same
/// tamper-evident ledger as mitigation decisions. The key is validated
/// against the board as derived *right now*: acknowledging a finding that is
/// not on the board is refused, for the same reason a decision on an option
/// not on offer is refused.
pub(crate) async fn acknowledge_issue(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
    body: Result<Json<AckBody>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    // Scope first, body second: a foreign hull is not-found before a malformed
    // body can say anything else (see `record_decision`).
    let hull = state.store.get_vessel(&scope, vessel).await?;
    let body = match body {
        Ok(Json(body)) => body,
        Err(rejection) => return Err(ApiError::OutOfRange(rejection.body_text())),
    };
    let at = AsOf { as_of: body.as_of }.resolve(&state, &hull)?;

    let issues = derived_issues(&state, &scope, vessel, at).await?;
    let Some(issue) = issues.iter().find(|i| i.key() == body.key) else {
        return Err(ApiError::OutOfRange(format!(
            "{:?} is not on the issue board at this instant, so it cannot be acknowledged",
            body.key
        )));
    };

    let detail = AckDetail {
        key: &body.key,
        note: &body.note,
        as_of_ms: at.epoch_millis(),
        acknowledged_by_org: scope.org.to_string(),
        issue: json!(issue),
    };
    let detail = serde_json::to_string(&detail).unwrap_or_default();
    let record = state
        .store
        .append_audit(
            &scope,
            vessel,
            "ISSUE_ACKNOWLEDGED",
            &detail,
            Some(&body.key),
            at.epoch_millis(),
        )
        .await?;
    Ok(Json(json!({ "recorded": record })))
}

/// The import half of the schedule-of-record area: a P6 XER export, posted as
/// text, becomes the hull's served register.
///
/// All-or-nothing: one rejected line refuses the whole import with the
/// rejection reasons in the response, because a partially loaded schedule
/// presenting as the whole one is the lie the ingest grading exists to
/// prevent. The scope check runs first, so a foreign hull is not-found before
/// the body is ever parsed.
pub(crate) async fn import_schedule(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
    Query(dry): Query<DryRun>,
    Json(body): Json<ImportSchedule>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    state.store.get_vessel(&scope, vessel).await?;
    let sor = crate::schedule::parse_xer(&body.label, &body.xer)
        .map_err(|reasons| ApiError::OutOfRange(format!("XER rejected: {reasons}")))?;
    let activities = sor.activities.len();
    let edges = sor.edges.len();
    // The dry run: everything the import would say, nothing it would do —
    // including the reconciliation the reader currently only sees AFTER the
    // swap. Committing a schedule blind was the sharpest edge on this door.
    let reconciliation = reconcile(&state, &scope, vessel, &sor.activities).await?;
    if dry.dry_run.unwrap_or(false) {
        return Ok(Json(json!({
            "dry_run": true,
            "label": body.label,
            "activities": activities,
            "edges": edges,
            "reconciliation": reconciliation,
        })));
    }
    state
        .store
        .set_schedule_of_record(&scope, vessel, sor)
        .await?;
    Ok(Json(json!({
        "label": body.label,
        "activities": activities,
        "edges": edges,
        "reconciliation": reconciliation,
    })))
}

/// The `?dry_run=` flag on a schedule import.
#[derive(Debug, Clone, Copy, Default, serde::Deserialize)]
pub(crate) struct DryRun {
    pub(crate) dry_run: Option<bool>,
}

/// Reverts the hull to its generated register, discarding the ingested
/// schedule of record. The undo the import door needs to be safe to try.
pub(crate) async fn revert_schedule(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    state.store.clear_schedule_of_record(&scope, vessel).await?;
    Ok(Json(json!({ "reverted": true })))
}

/// The body of a schedule-of-record import.
#[derive(Debug, serde::Deserialize)]
pub(crate) struct ImportSchedule {
    /// Where the export came from, shown on the register as its source.
    pub(crate) label: String,
    /// The XER file, verbatim.
    pub(crate) xer: String,
}

/// The distributed packages on a hull.
pub(crate) async fn list_packages(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let packages = state
        .store
        .list_packages(&scope, VesselId::from_uuid(id))
        .await?;
    Ok(Json(json!(packages)))
}

/// One package: its segment topology, the authorization state of every
/// compartment in its footprint, and the single constraint pacing it.
///
/// This is where the module's two central facts are made visible:
/// authorization state is a **distribution over the footprint**, not a value; and
/// a segment cannot be tested until it *and everything upstream* is complete, so
/// one held compartment strands man-hours it does not contain.
pub(crate) async fn get_package(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path((id, code)): Path<(Uuid, String)>,
    Query(as_of): Query<AsOf>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    let at = as_of.resolve(&state, &state.store.get_vessel(&scope, vessel).await?)?;
    let package = state.store.get_package(&scope, vessel, &code).await?;
    let analysis = package.analyse();

    // The engine's inputs, loaded once for the whole footprint.
    let graph = state.store.adjacency_graph(&scope, vessel).await?;
    let hazards = state.store.live_hazards(&scope, vessel).await?;
    let rules = state.store.rules_in_force(&scope, vessel).await?;
    let decide_space = |compartment: &CompartmentNo| {
        evaluate(&EvaluationRequest {
            subject: compartment,
            graph: &graph,
            rules: &rules,
            hazards: &hazards,
            at,
        })
    };

    // Authorization as a distribution over the footprint.
    let footprint: Vec<Value> = package
        .spaces
        .iter()
        .map(|(compartment, work)| {
            let decision = decide_space(compartment);
            json!({
                "compartment_no": compartment,
                "budget_hours": work.budget,
                "earned_hours": work.earned,
                "remaining_hours": work.remaining(),
                "complete": work.is_complete(),
                "state": decision.state,
                "permits_work": decision.permits_work(),
                "rules_fired": decision.trace.iter().map(|s| &s.rule_code).collect::<Vec<_>>(),
                "earliest_clear": decision.earliest_clear,
            })
        })
        .collect();

    // The governing constraint needs both halves: the topology (what is held) and
    // the engine (whether anything refuses the work).
    let governing = governing_constraint(&analysis, &|c| Some(decide_space(c)));

    Ok(Json(json!({
        "package": {
            "work_order_id": analysis.work_order_id,
            "code": analysis.code,
            "name": analysis.name,
            "test_verb": analysis.test_verb,
            "budget_hours": analysis.budget,
            "earned_hours": analysis.earned,
            "compartment_count": analysis.compartment_count,
            "open_compartment_count": analysis.open_compartment_count,
            "segment_count": analysis.segment_count,
            "testable_segment_count": analysis.testable_segment_count,
            "total_stranded_hours": analysis.total_stranded(),
        },
        "segments": analysis.segments,
        "footprint": footprint,
        "stranding": analysis.stranding,
        "governing": governing,
        // Empty for well-formed data; a named fault beats a silent wrong answer.
        "faults": analysis.faults,
    })))
}

/// Shared evaluation path: assembles the engine's inputs for one compartment.
async fn decide(
    state: &AppState,
    scope: &wadl_store::TenantScope,
    vessel: VesselId,
    compartment: &str,
    at: Timestamp,
) -> Result<Decision, ApiError> {
    // Scope is enforced by each store call; the first failure short-circuits.
    let graph = state.store.adjacency_graph(scope, vessel).await?;
    let hazards = state.store.live_hazards(scope, vessel).await?;
    let rules = state.store.rules_in_force(scope, vessel).await?;
    let subject = CompartmentNo::new(compartment);
    Ok(evaluate(&EvaluationRequest {
        subject: &subject,
        graph: &graph,
        rules: &rules,
        hazards: &hazards,
        at,
    }))
}
