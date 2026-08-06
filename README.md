# Shipyard AI Onboard + WADL

An operational planning and work-authorization platform for naval shipyards, in
Rust. This repository is **milestone 1**: the planning-and-operating shell, built
so that the five invariants that are expensive to retrofit are honoured from the
first commit.

> **Decision support, not automation.** The shell flags, ranks, prices and
> proposes. It never modifies the schedule of record and never grants an
> authorization. All data in the demo is illustrative / notional.

See `handoff/README.md` and `handoff/BUILD-PROMPT-shell.md` for the brief, and
`reference/` for the behaviour prototype (the more reliable statement of intent
where a written spec disagrees).

## Workspace

```
crates/
  wadl-engine/   THE core. Pure — no I/O, no async, no time source. Native + wasm32.
  wadl-domain/   Newtypes, units, the Clock trait, the permit lifecycle typestate.
  wadl-store/    Repositories + read models; the tenant scope; the PostgreSQL seam.
  wadl-api/      axum router, the caller/scope extractor, problem+json errors.
  wadl-ingest/   Provenance-stamped P6 ingest.
  wadl-cli/      wadl {migrate, seed, verify-ledger, support-bundle}.
xtask/           gen-leak-tests: generates the cross-tenant leak test from the route inventory.
migrations/      Forward-only PostgreSQL migrations; RLS from the first one.
shell-web/       The TypeScript + React + Vite shell (skeleton).
docs/adr/        Architecture decision records.
```

## The five non-negotiables, and where each lives

1. **The engine is a library, not a service.** `wadl-engine` is pure and builds
   for `wasm32-unknown-unknown` (CI job + ADR 0001). The same decision code runs
   on the server and in the browser.
2. **Rules are versioned data.** `evaluate()` holds no threshold, reach or
   outcome of its own — it is handed a `RuleSet` and applies it, and every trace
   step records the `rule_version_id` that produced it (ADR 0002). The seed rule
   set is transcribed from the prototype's cascade scenarios and anchored to the
   standards in `handoff/01-rule-table.csv`; the store loads it today and will
   load it from `rule_binding` unchanged.
3. **Never grant offline / nothing is deleted.** The audit ledger is append-only
   (privilege-enforced) and hash-chained; `wadl verify-ledger` detects tampering.
4. **Row-level security from the first migration.** Every tenant table; validated
   against PostgreSQL in CI and by the generated cross-tenant leak test (ADR 0003).
5. **Class holds the template, hull holds the truth.** The schema models per-hull
   divergence as deltas, never forks.

## Build and check

```
cargo test --workspace                                   # unit + property + leak tests
cargo clippy --workspace --all-targets -- -D warnings    # a warning is a build failure
cargo build -p wadl-engine --target wasm32-unknown-unknown
cargo run -p xtask -- gen-leak-tests --check             # leak tests match the route inventory
cargo run -p wadl-cli -- migrate                         # applies migrations (needs DATABASE_URL)
cargo run -p wadl-api --bin serve                        # demo API on 127.0.0.1:8080
```

## Milestone-1 first response (from the build prompt)

**1. Frontend.** TypeScript + React + Vite, engine imported as WASM. The
highest-risk UI is the dense grid and the deck-drawing interaction; React's
ecosystem de-risks that, and the "one engine, every surface" guarantee is
satisfied regardless because the engine is a separate pure crate. Full reasoning
in `docs/adr/0004`.

**2. Schema review.** The handoff DDL applies cleanly and its five stated
decisions are sound. Two things to raise, neither a blocker:
- RLS was illustrated on two tables; it is now on **every** tenant table, and the
  policy form is hardened to `NULLIF(current_setting('app.org_id', true), '')`
  so an unset/empty tenant is a default-deny, not an error. This depends on the
  app connecting as a **non-owner** role — added as `wadl_app` in migration 0001.
- `work_segment_space.budget_hours`/`earned_hours` are `numeric`. Man-hours are
  counted, not measured; integer hours would remove a class of rounding
  question. The domain type `ManHours` is already an integer. Flagged, not
  changed, pending your call.

**3. Crate graph.** `wadl-engine → wadl-domain` only; `wadl-store →
{domain, engine}`; `wadl-api → {domain, engine, store}`; `wadl-cli →
{domain, engine, ingest, store}`; `xtask → wadl-api`. Yes — `wadl-engine` stays
free of `tokio` and `sqlx`; the wasm CI job enforces it, and the `uuid` v7
generator (which needs an RNG) is kept off the engine's dependency and added
only in the crates that mint ids.

**4. Permit lifecycle.** A compile-time typestate: `Permit<Draft>`,
`Permit<Approved>`, `Permit<Active>`, … are distinct types and a transition
method exists only on the state it is legal from, so approving a draft does not
compile. `AnyPermit::from_parts` bridges the persisted flat status back to the
typed form. See `crates/wadl-domain/src/permit.rs`.

**5. Open questions — genuinely unresolved, not guessed.** The rule table marks
these for the safety authority; milestone 1 does not decide them, it leaves the
seam:
- R03: does a mechanically isolated branch break the coupling, or only a blank?
- R06: on a race, is the later ticket refused or the earlier permit suspended?
- R07: does a coupled bus two switchboards away need isolation, or notification?
- R08/R11: is a credential/bottle expiring **mid-window** a refusal at request
  time, or a scheduled mid-shift action?
- R15/R20: which rules are waivable, and may any persona override a live BLOCK?
  (The build assumes hazard cascades are not waivable and no override exists.)

## The worked example — a live cascade

The demo hull carries one live hazard: coating ticket `CT-3160-4`, a final coat
curing in `3-160-2-Q`. From that single fact, the engine decides the whole
neighbourhood, and the reach and outcome of each path come from the rule set, not
from code:

| Space | State | Rule | Why |
| --- | --- | --- | --- |
| `3-160-2-Q` | **BLOCK** | R03 (same space) | It *is* the flammable-vapour space |
| `2-160-2-Q` | **BLOCK** | R03 (deck penetration, 1 hop) | Directly above — heat path into vapour |
| `4-160-2-Q` | **BLOCK** | R03 (deck penetration, 1 hop) | Directly below — vapour is heavier than air |
| `3-156-2-Q` | **WARN** | R06 (shared bulkhead, 1 hop) | Permitted with the boundary posted |
| `3-164-2-Q` | **SUSPEND** | R09 (exhaust trunk, 1 hop) | Resumes when the vent zone clears |
| `4-164-2-Q` | **SUSPEND** | R09 (exhaust trunk, 2 hops) | The condition follows the air, not the deck plan |

Every one of those is reproduced as an `insta` golden snapshot of the **full
decision trace** in `crates/wadl-engine/tests/golden_cascade.rs`, asserting both
what lights and what must not. Deck Explorer renders it, and clicking a
compartment shows the rule, the path, the governing standard, who may clear it,
and the rule version.

## Status

Done: the workspace and lint gate; the engine (rules-as-data, property-tested
traversal, golden traces, wasm build); the domain typestate; the eight RLS
migrations validated against PostgreSQL; store/API/ingest/CLI; the generated
cross-tenant leak test; Deck Explorer end to end.

Next: the remaining shell modules (Daily Ops, Sequence Board, Work Orders,
Conflicts & Risk, Distributed Packages) on the same seams, the PostgreSQL
repositories behind `Repositories`, and the `wasm-bindgen` wrapper so the browser
pre-checks with the same engine build. Then the WADL field app and console, ITP
and dispositions, offline sync, and schedule ingest.
