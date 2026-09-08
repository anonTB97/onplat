//! The rule table: the engine's inputs assembled once, narrowed per work, and
//! the door the safety authority's CSV enters through.
//!
//! Two things live here. First, [`engine_inputs`] — the one place the graph,
//! the hazards and the rules in force are read together for an instant, so
//! every handler that asks the engine a question asks it under the same
//! triple: the rules are the hull's set narrowed to the instant's effective
//! range, and the hazards are the store's *bearing* set — live ones plus
//! those cleared within the longest end-anchored hold, so a fire watch can
//! run from the permit's close. Second, [`RuleScopes`] — the set per
//! `(work type, register category)` an activity read hands the engine, which
//! is how a cold-work inspection above a curing coat is judged by the rows
//! that bind to inspection and the weld beside it by the rows that bind to
//! hot work, with `evaluate()` unchanged.
//!
//! The door (`GET` with a CSV export, `POST` with `?dry_run=true`, `POST`
//! commit, `POST …/revert`) is the same door discipline as every other
//! document: parsed and compiled whole or refused whole with every reason,
//! previewed against the reference hull — *what would each row fire on
//! today, and which spaces change state if this is committed* — committed
//! with a ledger line that names every version, reverted to the seed with
//! another. Version ids are content-addressed, so the same row re-imported
//! keeps its id and its traces, and a changed cell is a new version of that
//! row only. The compiler itself is `wadl_engine::rule_table`, pure; this
//! module reads the store, mints ids and shapes the wire.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Value};

use wadl_domain::compartment::CompartmentNo;
use wadl_domain::ids::VesselId;
use wadl_domain::time::Timestamp;
use wadl_engine::{evaluate, AdjacencyGraph, Decision, EvaluationRequest, Hazard, RuleSet, Work};
use wadl_store::model::{ActivitySummary, CompartmentSummary};
use wadl_store::TenantScope;

use crate::error::ApiError;
use crate::AppState;

// ---------------------------------------------------------------------------
// The engine's inputs.
// ---------------------------------------------------------------------------

/// The engine's inputs for one hull at one instant, read together.
///
/// `rules` is the hull's set in force — the committed table's entries or the
/// seed — narrowed to the rows whose effective range covers `at`
/// (`Work::ANY`: every work type, every category). `hazards` is the store's
/// bearing set at `at` with the tail the rules need. A compartment-level read
/// evaluates under `rules` as it stands; an activity read narrows further
/// through [`RuleScopes`].
pub(crate) struct EngineInputs {
    /// The hull's resolved adjacency graph.
    pub(crate) graph: AdjacencyGraph,
    /// The hazards bearing on a decision at `at`, `ended` set where cleared.
    pub(crate) hazards: Vec<Hazard>,
    /// The rules in force at `at`, every work type.
    pub(crate) rules: RuleSet,
    /// The instant the inputs were read for.
    pub(crate) at: Timestamp,
}

impl EngineInputs {
    /// The triple as `wadl_issues` borrows it, under a narrowed set — an
    /// activity's from [`RuleScopes::for_activity`], or `self.rules` for the
    /// every-work reading.
    pub(crate) fn hull_under<'a>(&'a self, rules: &'a RuleSet) -> wadl_issues::Hull<'a> {
        wadl_issues::Hull {
            graph: &self.graph,
            rules,
            hazards: &self.hazards,
        }
    }

    /// One compartment's decision under a set — the compartment-level
    /// reading when `rules` is [`RuleScopes::for_compartment`]'s answer.
    pub(crate) fn decide(&self, subject: &CompartmentNo, rules: &RuleSet) -> Decision {
        evaluate(&EvaluationRequest {
            subject,
            graph: &self.graph,
            rules,
            hazards: &self.hazards,
            at: self.at,
        })
    }

    /// The hazards live at `at` — the bearing set without the ones whose
    /// fact has ended by the instant. For lists that show *what is shut*,
    /// where a permit closed twenty minutes ago is a fire watch, not a hazard.
    pub(crate) fn live(&self) -> impl Iterator<Item = &Hazard> + '_ {
        self.hazards.iter().filter(|h| !h.ended_by(self.at))
    }
}

/// Reads the engine's inputs for a hull at `at`: the rules first (their
/// longest end-anchored hold is the tail the hazard read needs), then the
/// hazards bearing on the instant, then the graph.
///
/// # Errors
/// [`ApiError::NotFound`] when the hull is outside `scope`.
pub(crate) async fn engine_inputs(
    state: &AppState,
    scope: &TenantScope,
    vessel: VesselId,
    at: Timestamp,
) -> Result<EngineInputs, ApiError> {
    let rules = state
        .store
        .rules_in_force(scope, vessel)
        .await?
        .bound_to(Work::ANY, at);
    let hazards = state
        .store
        .hazards_bearing_on(scope, vessel, at, rules.longest_end_anchored_hold())
        .await?;
    let graph = state.store.adjacency_graph(scope, vessel).await?;
    Ok(EngineInputs {
        graph,
        hazards,
        rules,
        at,
    })
}

/// Which rules a hull is being read under, for the activity register's
/// `rules` object: `{ source: "seed" | "document", label, signed }` — so the
/// Sequence Board can say whose table judged its rows without a second read.
///
/// # Errors
/// [`ApiError::NotFound`] when the hull is outside `scope`.
pub(crate) async fn rules_served(
    state: &AppState,
    scope: &TenantScope,
    vessel: VesselId,
) -> Result<Value, ApiError> {
    Ok(match state.store.rule_table(scope, vessel).await? {
        Some(doc) => json!({
            "source": "document",
            "label": doc.label,
            "signed": doc.signoff.is_some(),
        }),
        None => json!({ "source": "seed", "label": SEED_LABEL, "signed": false }),
    })
}

/// The label the seed is served under.
pub(crate) const SEED_LABEL: &str = "seed_usn_hot_work";

/// The rule set per `(work type, register category)` a read needs.
///
/// Built once per read from the compartments (each registers
/// `(None, category)`) and the activities (each registers its work type with
/// its compartment's category); [`Self::get`] answers from the map, and a
/// pair nobody registered gets the every-work set — the conservative
/// reading, never a narrower one.
pub(crate) struct RuleScopes<'a> {
    base: &'a RuleSet,
    sets: BTreeMap<(Option<String>, Option<String>), RuleSet>,
    categories: BTreeMap<String, String>,
}

impl<'a> RuleScopes<'a> {
    /// Registers the pairs `compartments` and `activities` need under
    /// `rules` at `at`.
    pub(crate) fn new<'b>(
        rules: &'a RuleSet,
        at: Timestamp,
        compartments: &[CompartmentSummary],
        activities: impl IntoIterator<Item = &'b ActivitySummary>,
    ) -> Self {
        let categories: BTreeMap<String, String> = compartments
            .iter()
            .map(|c| (c.compartment_no.as_str().to_owned(), c.category.clone()))
            .collect();
        let mut pairs: BTreeSet<(Option<String>, Option<String>)> = compartments
            .iter()
            .map(|c| (None, Some(c.category.clone())))
            .collect();
        for a in activities {
            let category = a
                .compartment_no
                .as_ref()
                .and_then(|no| categories.get(no.as_str()))
                .cloned();
            pairs.insert((a.work_type.clone(), category));
        }
        let sets = pairs
            .into_iter()
            .map(|pair| {
                let work = Work {
                    work_type: pair.0.as_deref(),
                    category: pair.1.as_deref(),
                };
                let set = rules.bound_to(work, at);
                (pair, set)
            })
            .collect();
        Self {
            base: rules,
            sets,
            categories,
        }
    }

    /// The set bound to `work_type` in a space of `category`; the every-work
    /// set for a pair that was not registered.
    pub(crate) fn get(&self, work_type: Option<&str>, category: Option<&str>) -> &RuleSet {
        self.sets
            .get(&(work_type.map(str::to_owned), category.map(str::to_owned)))
            .unwrap_or(self.base)
    }

    /// The register category of a compartment, if the register carries it.
    pub(crate) fn category_of(&self, compartment: Option<&CompartmentNo>) -> Option<&str> {
        compartment
            .and_then(|no| self.categories.get(no.as_str()))
            .map(String::as_str)
    }

    /// The set an activity is judged by: its work type in its space.
    pub(crate) fn for_activity(&self, a: &ActivitySummary) -> &RuleSet {
        self.get(
            a.work_type.as_deref(),
            self.category_of(a.compartment_no.as_ref()),
        )
    }

    /// The set a compartment-level read uses: every work type in the space's
    /// category.
    pub(crate) fn for_compartment(&self, c: &CompartmentSummary) -> &RuleSet {
        self.get(None, Some(c.category.as_str()))
    }

    /// How many entries bind to an activity's work type and category — the
    /// `rules_bound` figure on every activity row.
    pub(crate) fn rules_bound(&self, a: &ActivitySummary) -> usize {
        self.for_activity(a).entries().len()
    }
}
