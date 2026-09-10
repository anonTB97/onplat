//! What the work-on-work conflict derivations are allowed to claim.
//!
//! A golden neighbourhood and a handful of rows: an exhaust trunk that
//! carries vapour one way, an electrical bus that carries energy only, a
//! tank with a tolerance of three. Every claim below is a fact of the
//! schedule joined to the graph — never a word in a name.

#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use wadl_domain::compartment::CompartmentNo;
use wadl_domain::ids::CouplingTypeId;
use wadl_domain::time::{Timestamp, Window};
use wadl_domain::trades::WorkFlags;
use wadl_domain::units::{HopDepth, ManHours};
use wadl_engine::coupling::{CouplingCode, CouplingEdge, Propagation};
use wadl_engine::{AdjacencyGraph, RuleSet};
use wadl_issues::{
    conflicts, derive, derive_board, derive_with, Conflicts, Issue, RegisterRow, SpaceRow, WorkRow,
};
use wadl_mitigate::{SpaceLoad, World};

/// 2026-09-08T04:00Z — a Norfolk day start (00:00 EDT).
const DAY0: i64 = 1_788_753_600_000;
const HOUR: i64 = 3_600_000;
const DAY: i64 = 24 * HOUR;

fn at(ms: i64) -> Timestamp {
    Timestamp::from_epoch_millis(ms)
}

fn win(start: i64, end: i64) -> Window {
    Window::new(at(start), at(end))
}

fn edge(from: &str, to: &str, code: &str, carries: &[Propagation]) -> CouplingEdge {
    CouplingEdge {
        from: CompartmentNo::new(from),
        to: CompartmentNo::new(to),
        coupling_type: CouplingTypeId::from_uuid(uuid::Uuid::from_u128(7)),
        code: CouplingCode::new(code),
        propagates: carries.to_vec(),
        max_reach: HopDepth::new(2),
    }
}

/// Shaft Alley No. 4 (5-212-2-Q) vents into the trunk 5-220-0-Q — one
/// directed edge carrying vapour; a bus joins it to the switchboard
/// 5-214-2-E both ways, carrying energy only; 6-216-1-J is a tank on its own.
fn graph() -> AdjacencyGraph {
    AdjacencyGraph::new(vec![
        edge(
            "5-212-2-Q",
            "5-220-0-Q",
            "exhaust_trunk",
            &[Propagation::Vapour],
        ),
        edge(
            "5-212-2-Q",
            "5-214-2-E",
            "electrical_bus",
            &[Propagation::Energy],
        ),
        edge(
            "5-214-2-E",
            "5-212-2-Q",
            "electrical_bus",
            &[Propagation::Energy],
        ),
    ])
}

const HOT: WorkFlags = WorkFlags {
    ignition_source: true,
    flammable_atmosphere: false,
    confined_space: false,
};
const VAPOUR: WorkFlags = WorkFlags {
    ignition_source: false,
    flammable_atmosphere: true,
    confined_space: false,
};

struct Row {
    code: &'static str,
    name: &'static str,
    trade: &'static str,
    work_type: Option<&'static str>,
    flags: WorkFlags,
    space: CompartmentNo,
    planned: Option<Window>,
    remaining: i64,
}

fn hot(code: &'static str, space: &str, planned: Option<Window>, remaining: i64) -> Row {
    Row {
        code,
        name: "Fit & weld",
        trade: "SM-WELD",
        work_type: Some("hot_work"),
        flags: HOT,
        space: CompartmentNo::new(space),
        planned,
        remaining,
    }
}

fn coat(code: &'static str, space: &str, planned: Option<Window>, remaining: i64) -> Row {
    Row {
        code,
        name: "Top coat",
        trade: "SM-PRES",
        work_type: Some("coating"),
        flags: VAPOUR,
        space: CompartmentNo::new(space),
        planned,
        remaining,
    }
}

fn cold(code: &'static str, space: &str, planned: Option<Window>, remaining: i64) -> Row {
    Row {
        code,
        name: "Reinstall & align",
        trade: "SM-MECH",
        work_type: Some("mechanical"),
        flags: WorkFlags::default(),
        space: CompartmentNo::new(space),
        planned,
        remaining,
    }
}

fn work_rows(rows: &[Row]) -> Vec<WorkRow<'_>> {
    rows.iter()
        .map(|r| WorkRow {
            code: r.code,
            name: r.name,
            trade: r.trade,
            work_type: r.work_type,
            flags: r.flags,
            compartment: &r.space,
            planned: r.planned,
            remaining: ManHours::new(r.remaining),
        })
        .collect()
}

fn day(n: i64) -> Window {
    win(DAY0 + n * DAY, DAY0 + (n + 1) * DAY)
}

fn pairs_of(issues: &[Issue]) -> Vec<(String, String, String, i64)> {
    issues
        .iter()
        .filter_map(|i| match i {
            Issue::HotVsFlammable {
                hot,
                flammable,
                via,
                hours_at_risk,
                ..
            } => Some((
                hot.code.clone(),
                flammable.code.clone(),
                via.clone(),
                hours_at_risk.get(),
            )),
            _ => None,
        })
        .collect()
}

fn conflicts<'a>(
    rows: &'a [WorkRow<'a>],
    spaces: &'a [SpaceRow<'a>],
    day: Window,
) -> Conflicts<'a> {
    Conflicts {
        rows,
        spaces,
        day,
        shift_hours: 8,
        pair_cap: 200,
    }
}

#[test]
fn a_hot_row_and_a_flammable_row_in_one_space_on_the_same_day_are_one_pair() {
    let rows = [
        hot(
            "A4020",
            "5-212-2-Q",
            Some(win(DAY0 + 7 * HOUR, DAY0 + 15 * HOUR)),
            40,
        ),
        coat(
            "A4033",
            "5-212-2-Q",
            Some(win(DAY0 + 7 * HOUR, DAY0 + 12 * HOUR)),
            60,
        ),
        cold(
            "A4090",
            "5-212-2-Q",
            Some(win(DAY0 + 7 * HOUR, DAY0 + 12 * HOUR)),
            60,
        ),
    ];
    let rows = work_rows(&rows);
    let (issues, dropped) = conflicts::hot_vs_flammable(&graph(), &conflicts(&rows, &[], day(0)));
    assert_eq!(dropped, 0);
    assert_eq!(
        pairs_of(&issues),
        vec![(
            "A4020".to_owned(),
            "A4033".to_owned(),
            "same space".to_owned(),
            40
        )]
    );
    let Some(Issue::HotVsFlammable {
        hot,
        flammable,
        compartment,
        overlap,
        ..
    }) = issues.first()
    else {
        panic!("{issues:?}");
    };
    assert_eq!(hot.trade, "SM-WELD");
    assert_eq!(hot.work_type.as_deref(), Some("hot_work"));
    assert_eq!(flammable.work_type.as_deref(), Some("coating"));
    assert_eq!(compartment.as_str(), "5-212-2-Q", "the hot side's space");
    assert_eq!(
        *overlap,
        Some(win(DAY0 + 7 * HOUR, DAY0 + 12 * HOUR)),
        "the common span inside the day"
    );
    assert_eq!(
        issues.first().map(Issue::key),
        Some("issue:hot_vs_flammable:A4020~A4033".to_owned())
    );
    assert_eq!(
        issues
            .first()
            .and_then(Issue::space)
            .map(CompartmentNo::as_str),
        Some("5-212-2-Q")
    );
}

#[test]
fn a_pair_across_an_exhaust_trunk_is_found_and_across_an_electrical_bus_is_not() {
    let rows = [
        hot("A4020", "5-212-2-Q", Some(day(0)), 40),
        coat("A4040", "5-220-0-Q", Some(day(0)), 80),
        coat("A4050", "5-214-2-E", Some(day(0)), 80),
    ];
    let rows = work_rows(&rows);
    let (issues, _) = conflicts::hot_vs_flammable(&graph(), &conflicts(&rows, &[], day(0)));
    assert_eq!(
        pairs_of(&issues),
        vec![(
            "A4020".to_owned(),
            "A4040".to_owned(),
            "exhaust_trunk".to_owned(),
            40
        )],
        "the bus carries energy only — the graph says so, no word list does"
    );
}

#[test]
fn either_direction_of_the_edge_pairs() {
    // The trunk edge runs 5-212-2-Q → 5-220-0-Q only; the hot side on the
    // far end must still pair, because flame and vapour meet either way.
    let rows = [
        hot("A4090", "5-220-0-Q", Some(day(0)), 24),
        coat("A4033", "5-212-2-Q", Some(day(0)), 60),
    ];
    let rows = work_rows(&rows);
    let (issues, _) = conflicts::hot_vs_flammable(&graph(), &conflicts(&rows, &[], day(0)));
    assert_eq!(
        pairs_of(&issues),
        vec![(
            "A4090".to_owned(),
            "A4033".to_owned(),
            "exhaust_trunk".to_owned(),
            24
        )]
    );
}

#[test]
fn rows_on_different_days_do_not_pair_and_an_undated_row_pairs_every_day() {
    let rows = [
        hot("A4020", "5-212-2-Q", Some(day(0)), 40),
        coat("A4060", "5-212-2-Q", Some(day(1)), 60),
        coat("A4070", "5-220-0-Q", None, 100),
    ];
    let rows = work_rows(&rows);
    let g = graph();
    let (today, _) = conflicts::hot_vs_flammable(&g, &conflicts(&rows, &[], day(0)));
    assert_eq!(
        pairs_of(&today),
        vec![(
            "A4020".to_owned(),
            "A4070".to_owned(),
            "exhaust_trunk".to_owned(),
            40
        )],
        "tomorrow's coat is not today's pair; the undated one is"
    );
    let Some(Issue::HotVsFlammable { overlap, .. }) = today.first() else {
        panic!("{today:?}");
    };
    assert_eq!(*overlap, None, "undated rides every instant: overlap null");
    let (tomorrow, _) = conflicts::hot_vs_flammable(&g, &conflicts(&rows, &[], day(1)));
    assert!(
        tomorrow.is_empty(),
        "no hot work tomorrow, so nothing pairs: {tomorrow:?}"
    );
}

#[test]
fn a_finished_row_never_pairs() {
    let rows = [
        hot("A4020", "5-212-2-Q", Some(day(0)), 40),
        coat("A4080", "5-212-2-Q", Some(day(0)), 0),
        hot("A4021", "5-212-2-Q", None, 0),
        coat("A4033", "5-212-2-Q", None, 60),
    ];
    let rows = work_rows(&rows);
    let (issues, _) = conflicts::hot_vs_flammable(&graph(), &conflicts(&rows, &[], day(0)));
    assert_eq!(
        pairs_of(&issues),
        vec![(
            "A4020".to_owned(),
            "A4033".to_owned(),
            "same space".to_owned(),
            40
        )]
    );
}

#[test]
fn hours_at_risk_is_the_smaller_remaining_of_the_pair() {
    let rows = [
        hot("A4020", "5-212-2-Q", Some(day(0)), 400),
        coat("A4033", "5-212-2-Q", Some(day(0)), 12),
    ];
    let rows = work_rows(&rows);
    let (issues, _) = conflicts::hot_vs_flammable(&graph(), &conflicts(&rows, &[], day(0)));
    assert_eq!(
        issues.first().map(Issue::hours_at_risk),
        Some(ManHours::new(12))
    );
}

#[test]
fn the_pair_cap_drops_and_counts() {
    let rows = [
        hot("A1", "5-212-2-Q", None, 10),
        coat("B1", "5-212-2-Q", None, 10),
        coat("B2", "5-212-2-Q", None, 10),
        coat("B3", "5-220-0-Q", None, 10),
    ];
    let rows = work_rows(&rows);
    let mut c = conflicts(&rows, &[], day(0));
    c.pair_cap = 2;
    let (issues, dropped) = conflicts::hot_vs_flammable(&graph(), &c);
    assert_eq!(issues.len(), 2);
    assert_eq!(dropped, 1);
    let board = derive_board(&world(&graph()), &[], &[], &[], Some(&c));
    assert_eq!(board.pairs_dropped, 1);
    assert_eq!(board.issues.len(), 2);
}

fn tank(no: &CompartmentNo, tolerance: u32) -> SpaceRow<'_> {
    SpaceRow {
        compartment: no,
        category: Some("Tanks & voids"),
        tolerance,
    }
}

#[test]
fn crowding_prorates_hours_into_the_day_and_ceils_people() {
    let rows = [
        // 16 h, all of it today.
        cold("B1", "6-216-1-J", Some(day(0)), 16),
        // 40 h over two days, half of it today.
        cold(
            "B2",
            "6-216-1-J",
            Some(win(DAY0 - 12 * HOUR, DAY0 + 12 * HOUR)),
            40,
        ),
        // Yesterday: not today's headcount.
        cold("B4", "6-216-1-J", Some(day(-1)), 800),
    ];
    let rows = work_rows(&rows);
    let no = CompartmentNo::new("6-216-1-J");
    let spaces = [tank(&no, 3)];
    let issues = conflicts::crowding(&conflicts(&rows, &spaces, day(0)));
    let Some(Issue::Crowding {
        compartment,
        category,
        people,
        tolerance,
        activities,
        undated_rows,
        hours_at_risk,
    }) = issues.first()
    else {
        panic!("{issues:?}");
    };
    assert_eq!(compartment.as_str(), "6-216-1-J");
    assert_eq!(category.as_deref(), Some("Tanks & voids"));
    assert_eq!(*people, 5, "ceil(36 h / 8 h)");
    assert_eq!(*tolerance, 3);
    assert_eq!(activities, &["B1".to_owned(), "B2".to_owned()]);
    assert_eq!(*undated_rows, 0);
    assert_eq!(*hours_at_risk, ManHours::new(12), "36 h − 3 × 8 h");
    assert_eq!(
        issues.first().map(Issue::key),
        Some("issue:crowding:6-216-1-J".to_owned())
    );

    // Under the tolerance: no claim. A space the tolerance list does not
    // carry: no claim either.
    let roomy = [tank(&no, 5)];
    assert!(conflicts::crowding(&conflicts(&rows, &roomy, day(0))).is_empty());
    assert!(conflicts::crowding(&conflicts(&rows, &[], day(0))).is_empty());
}

#[test]
fn an_undated_row_is_reported_not_counted() {
    let rows = [
        cold("B1", "6-216-1-J", Some(day(0)), 40),
        cold("B3", "6-216-1-J", None, 1_000),
    ];
    let rows = work_rows(&rows);
    let no = CompartmentNo::new("6-216-1-J");
    let spaces = [tank(&no, 3)];
    let issues = conflicts::crowding(&conflicts(&rows, &spaces, day(0)));
    let Some(Issue::Crowding {
        people,
        activities,
        undated_rows,
        ..
    }) = issues.first()
    else {
        panic!("{issues:?}");
    };
    assert_eq!(
        *people, 5,
        "40 h / 8 h; the undated 1,000 h is not a headcount"
    );
    assert_eq!(activities, &["B1".to_owned()]);
    assert_eq!(*undated_rows, 1);
}

#[test]
fn crowding_hours_at_risk_is_what_does_not_fit() {
    let rows = [cold("B1", "6-216-1-J", Some(day(0)), 25)];
    let rows = work_rows(&rows);
    let no = CompartmentNo::new("6-216-1-J");
    let spaces = [tank(&no, 3)];
    let issues = conflicts::crowding(&conflicts(&rows, &spaces, day(0)));
    // 25 h → 4 people > 3; 25 − 24 = 1 h does not fit.
    assert_eq!(
        issues.first().map(Issue::hours_at_risk),
        Some(ManHours::new(1))
    );
    // Exactly the tolerance's hours: 3 people, no claim.
    let rows = [cold("B1", "6-216-1-J", Some(day(0)), 24)];
    let rows = work_rows(&rows);
    assert!(conflicts::crowding(&conflicts(&rows, &spaces, day(0))).is_empty());
    // A zero shift length derives nothing rather than dividing by it.
    let mut c = conflicts(&rows, &spaces, day(0));
    c.shift_hours = 0;
    assert!(conflicts::crowding(&c).is_empty());
}

#[test]
fn keys_are_stable_across_days_and_independent_of_hours() {
    let monday = [
        hot("A4020", "5-212-2-Q", None, 40),
        coat("A4033", "5-212-2-Q", None, 60),
        cold("B1", "6-216-1-J", Some(win(DAY0, DAY0 + 3 * DAY)), 200),
    ];
    let tuesday = [
        hot("A4020", "5-212-2-Q", None, 32),
        coat("A4033", "5-212-2-Q", None, 51),
        cold("B1", "6-216-1-J", Some(win(DAY0, DAY0 + 3 * DAY)), 150),
    ];
    let no = CompartmentNo::new("6-216-1-J");
    let spaces = [tank(&no, 3)];
    let g = graph();
    let keys = |rows: &[Row], d: i64| -> Vec<String> {
        let rows = work_rows(rows);
        derive_with(
            &world(&g),
            &[],
            &[],
            &[],
            Some(&conflicts(&rows, &spaces, day(d))),
        )
        .iter()
        .map(Issue::key)
        .collect()
    };
    // The ranking moves with the hours; the keys do not.
    let mut a = keys(&monday, 0);
    let mut b = keys(&tuesday, 1);
    a.sort();
    b.sort();
    assert_eq!(a.len(), 2, "{a:?}");
    assert_eq!(a, b, "same pair, same space: same keys, whatever the hours");
}

/// A world with no hazards and nothing booked, so the board carries only
/// what the register and the conflict pass put on it.
fn world(graph: &AdjacencyGraph) -> World<'_> {
    fn none(_: Timestamp) -> Vec<SpaceLoad> {
        Vec::new()
    }
    static RULES: std::sync::OnceLock<RuleSet> = std::sync::OnceLock::new();
    World {
        graph,
        rules: RULES.get_or_init(RuleSet::seed_usn_hot_work),
        hazards: &[],
        at: at(DAY0 + 8 * HOUR),
        loads: &none,
    }
}

#[test]
fn derive_without_conflicts_is_byte_identical_to_before() {
    let g = graph();
    let space = CompartmentNo::new("5-212-2-Q");
    let register = [RegisterRow {
        code: "A4020",
        name: "Fit & weld",
        trade: "SM-WELD",
        compartment: Some(&space),
        planned: Some(day(0)),
        remaining: ManHours::new(40),
    }];
    let before = derive(&world(&g), &register, &[], &[]);
    let after = derive_with(&world(&g), &register, &[], &[], None);
    assert_eq!(before, after);
    assert_eq!(
        derive_board(&world(&g), &register, &[], &[], None).pairs_dropped,
        0
    );
    // The old kinds serialise as they did: the same tag, no new fields.
    let json = serde_json::to_value(&before).unwrap();
    assert!(json.as_array().unwrap().iter().all(|i| {
        let keys: Vec<&str> = i.as_object().unwrap().keys().map(String::as_str).collect();
        !keys.contains(&"via") && !keys.contains(&"people")
    }));
}

#[test]
fn the_conflict_kinds_serialise_under_their_tags_and_rank_on_the_board() {
    let rows = [
        hot("A4020", "5-212-2-Q", Some(day(0)), 40),
        coat("A4033", "5-212-2-Q", Some(day(0)), 60),
        cold("B1", "6-216-1-J", Some(day(0)), 80),
    ];
    let rows = work_rows(&rows);
    let no = CompartmentNo::new("6-216-1-J");
    let spaces = [tank(&no, 3)];
    let g = graph();
    let board = derive_with(
        &world(&g),
        &[],
        &[],
        &[],
        Some(&conflicts(&rows, &spaces, day(0))),
    );
    let json = serde_json::to_value(&board).unwrap();
    let kinds: Vec<&str> = json
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["kind"].as_str().unwrap())
        .collect();
    // 80 − 24 = 56 h at risk in the tank outranks the pair's 40.
    assert_eq!(kinds, ["crowding", "hot_vs_flammable"]);
    assert_eq!(json[1]["hot"]["code"], "A4020");
    assert_eq!(json[1]["via"], "same space");
    assert_eq!(json[0]["tolerance"], 3);
    let back: Vec<Issue> = serde_json::from_value(json).unwrap();
    assert_eq!(back, board);
}
