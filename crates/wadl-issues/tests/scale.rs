//! The attack plan's scale question, measured instead of guessed.
//!
//! `leverage`, `assess` and `derive` re-evaluate the hull per candidate action;
//! fine at the demo's 24 spaces, unproven at a real availability's hundreds of
//! spaces and thousands of activities. This test builds a synthetic hull an
//! order of magnitude past the demo — a deck-and-frame grid with live hazards
//! spread across it — runs every board, prints the timings (visible with
//! `--nocapture`), and trips only past a ceiling generous enough to never
//! flake on a loaded CI runner. Its job is to catch an accidental
//! O(spaces³) — the difference between 100 ms and 30 s — not to benchmark.
//!
//! Measured at 384 spaces / 24 hazards / 1920 activities, debug build (which
//! CI also runs). Before bounding: leverage 8 977 ms, assess 798 ms, derive
//! 19 243 ms. After reach-bounded effects, the shadow-bounded shared baseline
//! and the unpriced triage path: leverage 2 120 ms, assess 430 ms, derive
//! 1 530 ms — same 31 actions and 75 issues. The remaining dominant term is
//! Wait actions in `leverage`, whose affected set is conservatively every
//! hazard's reach; bounding that further means reasoning about which holds can
//! flip before the waited instant, and nothing yet justifies the subtlety.

#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    // Synthetic indices modulo small constants; the casts cannot wrap.
    clippy::cast_possible_wrap
)]
// A measurement reads the monotonic clock; that is its job. The workspace ban
// exists so *decisions* stay deterministic — nothing here decides anything.
#![allow(clippy::disallowed_methods)]

use std::time::Instant;

use wadl_domain::compartment::CompartmentNo;
use wadl_domain::ids::CouplingTypeId;
use wadl_domain::time::{Timestamp, Window};
use wadl_domain::units::{HopDepth, ManHours};
use wadl_engine::coupling::{CouplingCode, CouplingEdge, Propagation};
use wadl_engine::{AdjacencyGraph, Hazard, HazardKind, RuleSet};
use wadl_issues::{derive, RegisterRow};
use wadl_mitigate::{assess, leverage, SpaceLoad, World};

const T0: i64 = 1_778_649_300_000;
const HOUR: i64 = 3_600_000;

const DECKS: usize = 8;
const FRAMES: usize = 48;
const SPACES: usize = DECKS * FRAMES; // 384
const HAZARDS: usize = 24;
const ACTIVITIES_PER_SPACE: usize = 5; // 1920 register rows

fn space_no(deck: usize, frame: usize) -> CompartmentNo {
    CompartmentNo::new(format!("{deck}-{:03}-2-Q", frame * 4))
}

fn edge(from: &CompartmentNo, to: &CompartmentNo, code: &str, ty: u128) -> CouplingEdge {
    CouplingEdge {
        from: from.clone(),
        to: to.clone(),
        coupling_type: CouplingTypeId::from_uuid(uuid::Uuid::from_u128(ty)),
        code: CouplingCode::new(code),
        propagates: vec![Propagation::Heat, Propagation::Vapour],
        max_reach: HopDepth::new(3),
    }
}

/// A deck-and-frame grid: every space coupled to its vertical neighbour by a
/// deck penetration and its longitudinal neighbour by a shared bulkhead —
/// denser than a real hull, which only makes the measurement more honest.
fn grid() -> AdjacencyGraph {
    let mut edges = Vec::new();
    for d in 0..DECKS {
        for f in 0..FRAMES {
            let here = space_no(d, f);
            if d + 1 < DECKS {
                let below = space_no(d + 1, f);
                edges.push(edge(&here, &below, "deck_penetration", 1));
                edges.push(edge(&below, &here, "deck_penetration", 1));
            }
            if f + 1 < FRAMES {
                let aft = space_no(d, f + 1);
                edges.push(edge(&here, &aft, "shared_bulkhead", 2));
                edges.push(edge(&aft, &here, "shared_bulkhead", 2));
            }
        }
    }
    AdjacencyGraph::new(edges)
}

/// Hazards spread across the hull, all five kinds, raised at staggered
/// instants so some holds are mid-cure and some verification-gated.
fn hazards() -> Vec<Hazard> {
    let kinds = [
        HazardKind::CoatingOpen,
        HazardKind::HotWorkLive,
        HazardKind::EnergisedBus,
        HazardKind::FlammableStow,
        HazardKind::StopWork,
    ];
    (0..HAZARDS)
        .map(|i| {
            let deck = (i * 3) % DECKS;
            let frame = (i * 7) % FRAMES;
            Hazard {
                origin: space_no(deck, frame),
                kind: kinds[i % kinds.len()],
                since: Timestamp::from_epoch_millis(T0 - ((i as i64 % 6) * HOUR)),
                label: format!("H{i:02} · synthetic"),
            }
        })
        .collect()
}

fn loads() -> Vec<SpaceLoad> {
    (0..DECKS)
        .flat_map(|d| (0..FRAMES).map(move |f| (d, f)))
        .enumerate()
        .map(|(i, (d, f))| SpaceLoad {
            compartment: space_no(d, f),
            booked: ManHours::new(((i % 7) as i64) * 20),
        })
        .collect()
}

struct Row {
    code: String,
    name: String,
    compartment: CompartmentNo,
    planned: Window,
    remaining: ManHours,
}

fn register() -> Vec<Row> {
    let day = 24 * HOUR;
    (0..SPACES * ACTIVITIES_PER_SPACE)
        .map(|i| {
            let d = (i / ACTIVITIES_PER_SPACE) / FRAMES;
            let f = (i / ACTIVITIES_PER_SPACE) % FRAMES;
            let start = T0 - 2 * day + ((i % 14) as i64) * day;
            Row {
                code: format!("A{i:04}"),
                name: format!("Synthetic activity {i}"),
                compartment: space_no(d, f),
                planned: Window::new(
                    Timestamp::from_epoch_millis(start),
                    Timestamp::from_epoch_millis(start + 2 * day),
                ),
                remaining: ManHours::new(((i % 5) as i64) * 8),
            }
        })
        .collect()
}

#[test]
fn the_boards_hold_up_at_register_scale() {
    let graph = grid();
    let hazards = hazards();
    let spaces = loads();
    let loads_fn = move |_: Timestamp| spaces.clone();
    let world = World {
        graph: &graph,
        rules: &RuleSet::seed_usn_hot_work(),
        hazards: &hazards,
        at: Timestamp::from_epoch_millis(T0),
        loads: &loads_fn,
    };

    let t = Instant::now();
    let actions = leverage(&world);
    let leverage_ms = t.elapsed().as_millis();
    eprintln!(
        "leverage over {SPACES} spaces / {HAZARDS} hazards: {leverage_ms} ms ({} actions)",
        actions.len()
    );
    assert!(!actions.is_empty(), "a hull this hazardous has leverage");

    // Assess the most-held space the leverage board knows about.
    let subject = actions
        .first()
        .and_then(|m| m.effect.frees.first())
        .expect("the top action frees something")
        .clone();
    let t = Instant::now();
    let a = assess(&world, &subject);
    let assess_ms = t.elapsed().as_millis();
    eprintln!(
        "assess {subject}: {assess_ms} ms ({} options)",
        a.options.len()
    );

    let rows_data = register();
    let rows: Vec<RegisterRow<'_>> = rows_data
        .iter()
        .map(|r| RegisterRow {
            code: &r.code,
            name: &r.name,
            trade: "SYN",
            compartment: Some(&r.compartment),
            planned: Some(r.planned),
            remaining: r.remaining,
        })
        .collect();
    let t = Instant::now();
    let issues = derive(&world, &rows, &[], &[]);
    let derive_ms = t.elapsed().as_millis();
    eprintln!(
        "derive over {} activities: {derive_ms} ms ({} issues)",
        rows.len(),
        issues.len()
    );
    assert!(!issues.is_empty());

    // The tripwire, not a benchmark: an accidental O(spaces³) blows through
    // this by an order of magnitude; a loaded CI runner does not.
    let total = leverage_ms + assess_ms + derive_ms;
    assert!(
        total < 15_000,
        "the boards took {total} ms at register scale — roughly 4x the \
         bounded measurement; something regressed the reach bounding"
    );
}
