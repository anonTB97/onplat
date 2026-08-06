# ADR 0001 — The decision engine is a pure library, not a service

Status: accepted (milestone 1)

## Context

A suspension must commit in the same database transaction as the hazard that
caused it, and the field client must reach the *same* decision as the server
while offline. A network hop to a "rules service" makes both impossible: the
transaction boundary is broken, and the offline device has nothing to call.

## Decision

`wadl-engine` is a pure crate: no I/O, no async, no time source. It is handed
its inputs (adjacency graph, hazards, rules-as-data, the evaluation instant) and
returns a decision plus a trace. It compiles to native for the server, to
`wasm32-unknown-unknown` for the browser, and (planned) via UniFFI for mobile,
so every surface runs identical decision code.

This is enforced, not merely intended:

- `wadl-engine`'s dependencies are `wadl-domain` and `serde` only. `tokio`,
  `sqlx`, `std::time`, filesystem and network crates are forbidden.
- A CI job builds the crate for `wasm32-unknown-unknown`. A dependency that
  breaks the wasm build fails CI.
- Wall-clock time is injected via the `Clock` trait in `wadl-domain`; the engine
  is handed the evaluation instant explicitly and never reads a clock, so a
  decision is reproducible years later for a board of inquiry.

## Consequences

Callers assemble the engine's inputs and persist its outputs in their own
transaction. Authorization state is read *through* the engine from day one (the
API's compartment-state endpoint already does), even though milestone-1 outcomes
are seeded — so wiring the real rule evaluation in is a change inside this crate,
not a restructuring of everything above it.
