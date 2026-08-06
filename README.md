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
2. **Rules are versioned data.** No threshold in code; every decision carries a
   `rule_version_id` slot (ADR 0002). Milestone-1 outcomes are seeded and marked
   as such.
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

## Status

Milestone 1 lays the foundation and the seams: workspace, lints, the engine
traversal, the typestate, the validated RLS migrations, the store/API/ingest/CLI,
and the cross-tenant leak test. The shell modules (Daily Ops, Deck Explorer,
Sequence Board, …) build out on top of these seams; the rule engine, WADL field
app/console, ITP, offline sync and schedule ingest are later milestones.
