//! Golden traces for the rule table — one per row in force, on the authority's
//! own expectation.
//!
//! Two contracts. First, the reference hull's table
//! (`reference/cvn73/CVN73-rule-table.csv`) IS the seed exported in the
//! table's layout: byte for byte, and compiling it back gives the seed entry
//! for entry, ids included. Second, every scenario in
//! `fixtures/rule-scenarios.csv` — written expectation-first, in the
//! authority's words — matches the engine's answer, and that answer is pinned
//! as an `insta` snapshot per row. The authority signs the CSV row; the
//! snapshot is the engine's answer to it, and any byte of change fails here.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use wadl_domain::civil::YardClock;
use wadl_domain::compartment::CompartmentNo;
use wadl_domain::ids::CouplingTypeId;
use wadl_domain::time::Timestamp;
use wadl_domain::units::HopDepth;
use wadl_engine::coupling::{CouplingCode, CouplingEdge, Propagation};
use wadl_engine::rule_table::{compile, export, parse, seed_text};
use wadl_engine::{
    evaluate, AdjacencyGraph, Decision, DecisionState, EvaluationRequest, Hazard, HazardKind,
    RuleSet, Work,
};

/// The reference hull's table, as shipped.
const REFERENCE_TABLE: &str = include_str!("../../../reference/cvn73/CVN73-rule-table.csv");

/// The authority's scenarios.
const SCENARIOS: &str = include_str!("fixtures/rule-scenarios.csv");

/// 07:15 on the shift the hazards were raised — the golden cascade's instant.
const RAISED_AT: i64 = 1_778_649_300_000;

#[test]
fn the_reference_rule_table_compiles_to_the_seed_entry_for_entry() {
    let seed = RuleSet::seed_usn_hot_work();
    let clock = YardClock::utc();
    assert_eq!(
        REFERENCE_TABLE,
        export(&seed, &clock, seed_text),
        "reference/cvn73/CVN73-rule-table.csv is the seed exported; regenerate it from `export`"
    );
    let table = parse(REFERENCE_TABLE).expect("the reference table parses");
    assert_eq!(table.header.len(), 22);
    assert_eq!(table.rows.len(), 10, "ten rows from eight rule ids");
    let compiled = compile(&table, &clock).expect("the reference table compiles");
    assert!(compiled.not_compiled.is_empty());
    assert_eq!(
        compiled.rule_set(),
        seed,
        "entry for entry, ids in column 22"
    );
    let ids: Vec<String> = compiled
        .entries
        .iter()
        .map(|(_, e)| e.rule_version.to_string())
        .collect();
    assert!(
        ids.iter().any(|id| id.ends_with("0402")),
        "R04 is the end-anchored version"
    );
    assert!(
        ids.iter().any(|id| id.ends_with("0902")),
        "R09's WARN reading"
    );
    assert!(
        !ids.iter().any(|id| id.ends_with("0401")),
        "the raise-anchored R04 is retired"
    );
}

fn edge(from: &str, to: &str, code: &str, ty: u128, reach: u8) -> CouplingEdge {
    CouplingEdge {
        from: CompartmentNo::new(from),
        to: CompartmentNo::new(to),
        coupling_type: CouplingTypeId::from_uuid(uuid::Uuid::from_u128(ty)),
        code: CouplingCode::new(code),
        propagates: vec![Propagation::Vapour, Propagation::Heat],
        max_reach: HopDepth::new(reach),
    }
}

/// The golden cascade's graph plus the two edges the hot-work and bus
/// scenarios need.
fn graph() -> AdjacencyGraph {
    AdjacencyGraph::new(vec![
        edge("3-160-2-Q", "2-160-2-Q", "deck_penetration", 0x01, 1),
        edge("3-160-2-Q", "4-160-2-Q", "deck_penetration", 0x01, 1),
        edge("3-160-2-Q", "3-156-2-Q", "shared_bulkhead", 0x02, 2),
        edge("3-156-2-Q", "3-160-2-Q", "shared_bulkhead", 0x02, 2),
        edge("3-160-2-Q", "3-164-2-Q", "exhaust_trunk", 0x03, 3),
        edge("3-164-2-Q", "4-164-2-Q", "exhaust_trunk", 0x03, 3),
        edge("1-100-0-L", "1-104-0-L", "shared_bulkhead", 0x02, 2),
        // Hot work on the deck above the coated space reaches it downward.
        edge("2-160-2-Q", "3-160-2-Q", "deck_penetration", 0x01, 1),
        // One bus hop out of the switchboard room, one-way as the register has it.
        edge("3-148-2-E", "3-148-0-L", "electrical_bus", 0x04, 2),
    ])
}

/// One fixture row, in the authority's columns.
#[derive(Debug, Clone, serde::Serialize)]
struct Expectation {
    rule: String,
    ordinal: String,
    scenario: String,
    hazard_kind: String,
    origin: String,
    subject: String,
    work_type: String,
    at_min: i64,
    ended_min: Option<i64>,
    expect_state: String,
    expect_clearer: String,
    expect_clear_min: Option<i64>,
}

fn scenarios() -> Vec<Expectation> {
    let mut lines = SCENARIOS
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'));
    let header = lines.next().expect("header");
    assert_eq!(
        header,
        "rule,ordinal,scenario,hazard_kind,origin,subject,work_type,at_min,ended_min,expect_state,expect_clearer,expect_clear_min"
    );
    let opt = |s: &str| (!s.is_empty()).then(|| s.parse::<i64>().expect("minutes"));
    lines
        .map(|line| {
            let c: Vec<&str> = line.split(',').collect();
            assert_eq!(c.len(), 12, "{line}");
            Expectation {
                rule: c[0].to_owned(),
                ordinal: c[1].to_owned(),
                scenario: c[2].to_owned(),
                hazard_kind: c[3].to_owned(),
                origin: c[4].to_owned(),
                subject: c[5].to_owned(),
                work_type: c[6].to_owned(),
                at_min: c[7].parse().expect("at_min"),
                ended_min: opt(c[8]),
                expect_state: c[9].to_owned(),
                expect_clearer: c[10].to_owned(),
                expect_clear_min: opt(c[11]),
            }
        })
        .collect()
}

fn kind(token: &str) -> HazardKind {
    match token {
        "coating_open" => HazardKind::CoatingOpen,
        "hot_work_live" => HazardKind::HotWorkLive,
        "energised_bus" => HazardKind::EnergisedBus,
        "flammable_stow" => HazardKind::FlammableStow,
        "stop_work" => HazardKind::StopWork,
        other => panic!("unknown hazard kind {other}"),
    }
}

fn state(word: &str) -> DecisionState {
    match word {
        "ALLOW" => DecisionState::Allow,
        "WARN" => DecisionState::Warn,
        "BLOCK" => DecisionState::Block,
        "SUSPEND" => DecisionState::Suspend,
        other => panic!("unknown state {other}"),
    }
}

fn at(minutes: i64) -> Timestamp {
    Timestamp::from_epoch_millis(RAISED_AT + minutes * 60_000)
}

/// The field-condition log's words for each kind (the sentence adds the space).
fn label(kind: HazardKind) -> &'static str {
    match kind {
        HazardKind::CoatingOpen => "CT-3160-4 · final coat, curing",
        HazardKind::HotWorkLive => "HW permit 2673 · weld repair",
        HazardKind::EnergisedBus => "Bus 3-SG-2 energised",
        HazardKind::FlammableStow => "Open solvent stow · paint locker",
        HazardKind::StopWork => "STOP WORK · Fire Marshal",
    }
}

/// Runs one scenario: the seed bound to the scenario's work type at its
/// instant, one hazard of its kind at its origin, ended when the row says.
fn run(s: &Expectation) -> Decision {
    let graph = graph();
    let instant = at(s.at_min);
    let rules = RuleSet::seed_usn_hot_work().bound_to(
        Work {
            work_type: Some(&s.work_type),
            category: None,
        },
        instant,
    );
    let hazard_kind = kind(&s.hazard_kind);
    let hazards = vec![Hazard {
        origin: CompartmentNo::new(&s.origin),
        kind: hazard_kind,
        since: at(0),
        label: label(hazard_kind).to_owned(),
        ended: s.ended_min.map(at),
    }];
    let subject = CompartmentNo::new(&s.subject);
    evaluate(&EvaluationRequest {
        subject: &subject,
        graph: &graph,
        rules: &rules,
        hazards: &hazards,
        at: instant,
    })
}

/// `R04-0-the-same-after-the-permit-closed`.
fn snapshot_name(s: &Expectation) -> String {
    let slug: String = s
        .scenario
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let slug = slug
        .split('-')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    format!("{}-{}-{slug}", s.rule, s.ordinal)
}

#[test]
fn every_scenario_matches_the_authority_expectation_and_is_snapshotted() {
    let scenarios = scenarios();
    assert_eq!(scenarios.len(), 16);
    // Every rule id in force has at least one scenario.
    for code in ["R03", "R04", "R06", "R07", "R09", "R13", "R22"] {
        assert!(
            scenarios.iter().any(|s| s.rule == code),
            "{code} has no scenario"
        );
    }
    for s in &scenarios {
        let decision = run(s);
        let name = snapshot_name(s);
        assert_eq!(decision.state, state(&s.expect_state), "{name}: state");
        let clearer = decision
            .governing_step()
            .map_or("", |step| step.clearing_authority.as_str());
        assert_eq!(clearer, s.expect_clearer, "{name}: who may clear");
        assert_eq!(
            decision.earliest_clear,
            s.expect_clear_min.map(at),
            "{name}: earliest clear"
        );
        // The row that decided it is the row the scenario names.
        if let Some(step) = decision.governing_step() {
            assert_eq!(step.rule_code, s.rule, "{name}: governing rule");
        }
        insta::with_settings!({
            description => s.scenario.as_str(),
            info => s,
            omit_expression => true,
        }, {
            insta::assert_json_snapshot!(name, decision);
        });
    }
}
