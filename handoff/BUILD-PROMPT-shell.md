# BUILD PROMPT — Shipyard AI Onboard (shell) — Milestone 1 — RUST

Paste this whole file into your coding agent as the first message, with the
repository open. Attach `reference/Shipyard Onboard Shell.dc.html`.

---

## Your task

Stand up **Shipyard AI Onboard**, the planning and operating shell for a naval
shipyard availability, in Rust. This system authorizes hot work on warships. It
will be read by an accreditor and, eventually, by a board of inquiry. Build it to
that standard.

`reference/Shipyard Onboard Shell.dc.html` is a **behaviour reference** — open
it, use it, treat it as the statement of intent for layout, density, interaction
and copy. Do not transliterate its code; it is a single-file prototype and its
structure is not the architecture.

## Read before writing any code

From `/docs`, in this order:

1. `01-index-and-delivery-plan` — epics, NFRs, and the glossary. Read the
   glossary properly. This is a domain where guessing at vocabulary produces
   confident nonsense that a chief petty officer will reject on sight.
2. `02-platform-data-model` + `handoff/04-platform-schema.sql` — the schema.
   Start from the DDL. Section 9 of the doc lists the compromises I already know
   about.
3. `07-architecture-and-deployment` — service boundaries, and §1 before you add
   any dependency.
4. `03-rule-engine` — not implemented in milestone 1, but the shell reads its
   output and the seam must be right.
5. `10-security-and-rbac` — §3 and §4 are milestone-1 work, not later work.

---

## Stack — decided, not open

### Workspace

A Cargo workspace. The crate boundaries are load-bearing and follow the
architecture document's service boundaries, not domain nouns.

```
crates/
  wadl-engine/       # THE core. Pure, no I/O, no async, no time source.
                     # Compiles to native, wasm32-unknown-unknown, and via
                     # UniFFI to iOS/Android. This crate has no database
                     # dependency and no knowledge of HTTP.
  wadl-domain/       # Newtypes, IDs, value objects, lifecycle typestates.
                     # Shared by engine and persistence. No I/O.
  wadl-store/        # sqlx repositories. Owns every SQL statement.
  wadl-api/          # axum handlers, extractors, authz middleware. Thin.
  wadl-ingest/       # batch ingest, own schema, own transaction scope.
  wadl-cli/          # migrate, seed, verify-ledger, support-bundle.
  shell-web/         # the SPA (see below)
xtask/               # cargo xtask for schema checks, SBOM, leak-test codegen
```

**Rule:** `wadl-engine` must compile with `--no-default-features` on
`wasm32-unknown-unknown` and must not depend on `tokio`, `sqlx`, `std::time`,
or anything that touches the filesystem or the network. If a dependency creeps
in that breaks the wasm build, the CI wasm job fails. That job exists precisely
to keep this crate honest.

### Backend

- **HTTP:** `axum` on `tokio`. `tower-http` for tracing, timeouts, body limits.
- **Database:** PostgreSQL 15+ via `sqlx` with `offline` mode and
  `query_as!` macros so every statement is verified against the schema at
  compile time. No ORM. No query builder for anything non-trivial — write SQL.
- **Migrations:** `sqlx migrate`, forward-only, checked into the repo. The first
  migration is `handoff/04-platform-schema.sql` split into logical steps, with
  row-level security enabled in that same first migration.
- **Errors:** `thiserror` in every library crate. `anyhow` only in `wadl-cli`
  and test harnesses. An API error type that maps to problem+json and never
  leaks internals.
- **Serialisation:** `serde` with `deny_unknown_fields` on every inbound type.
- **Time:** a `Clock` trait in `wadl-domain`. `SystemClock` in production, a
  `TestClock` in tests. **`SystemTime::now()` and `Utc::now()` are banned
  outside `SystemClock`** — enforce with a clippy `disallowed_methods` lint.
- **IDs:** UUIDv7 (`uuid` crate) so primary keys are time-ordered and index
  locality is sane.

### Frontend

The shell is a dense desktop surface. Two defensible options; pick one and say
which:

- **TypeScript + React + Vite**, with the engine compiled to WASM and imported so
  the browser runs the *same* pre-check code as the server. Mature ecosystem for
  dense virtualised tables and the SVG deck views. This is the lower-risk choice.
- **Leptos** (Rust/WASM end to end). One language, and the engine links natively.
  Higher risk on the data-grid and drawing-interaction work.

Either way: **vendor every asset.** No Google Fonts, no icon CDN, no external
anything. `reference/assets/` holds the deck drawings and the logo.

### Explicitly excluded

No managed cloud service in any path. No serverless. No hosted queue, search,
identity provider, APM or push service. No container image pulled from a public
registry at deploy time. No outbound connection by default — not opt-out,
**absent**. Every one of these is normal and every one becomes an accreditation
finding.

---

## Engineering standards — non-negotiable

These are what "world class" means concretely. Enforce them in CI from the first
commit, because retrofitting a lint across a codebase is how standards die.

### Lints

```toml
# workspace Cargo.toml
[workspace.lints.rust]
unsafe_code = "forbid"
missing_docs = "warn"
unreachable_pub = "warn"
rust_2018_idioms = { level = "warn", priority = -1 }

[workspace.lints.clippy]
all = { level = "deny", priority = -1 }
pedantic = { level = "warn", priority = -1 }
unwrap_used = "deny"
expect_used = "deny"        # allow only in tests, via #[cfg(test)] scoping
panic = "deny"
todo = "deny"
indexing_slicing = "deny"   # a panic in the engine is a stopped shipyard
float_arithmetic = "warn"   # money and man-hours are not floats
disallowed_methods = "deny" # configure: Utc::now, SystemTime::now
```

CI runs `cargo clippy --all-targets --all-features -- -D warnings`. A warning
is a build failure. No `#[allow]` without a comment naming the reason.

### Type discipline

- **Newtype every identifier.** `VesselId(Uuid)`, `CompartmentNo(String)`,
  `RuleVersionId(Uuid)`. A function signature that takes two bare `Uuid`s in a
  row is a bug waiting to happen, and this domain has dozens of id types.
- **Newtype every unit.** `ManHours`, `Frame`, `HopDepth`, `Minutes`. Never a
  bare `i32` for a quantity with a unit.
- **Typestate the permit lifecycle.** `Permit<Draft>`, `Permit<Submitted>`,
  `Permit<Approved>`, `Permit<Active>`, `Permit<Suspended>`. Illegal
  transitions must not compile. This is the single highest-value use of Rust's
  type system in the product.
- **Make the illegal unrepresentable.** `DecisionState` is an enum, not a
  string. A cascade path is `Vec<CouplingEdge>`, not `Vec<String>`.
- **No `Option<T>` where a domain type will do.** If a permit always has a
  window, the window is not optional.

### Testing

Four layers, all in CI:

1. **Golden acceptance tests.** The twenty scenarios from the steering pack, as
   `insta` snapshots of the full decision trace. Assert what lights *and what
   must not*. These are the contract with the safety authority; they should fail
   loudly and be hard to update casually.
2. **Property tests** (`proptest`) on the traversal: hop bound never exceeded, a
   directional coupling never traversed against direction, adding an unrelated
   compartment never changes an existing decision, reduction idempotent.
3. **Generated cross-tenant leak test.** `cargo xtask gen-leak-tests` walks the
   axum route table and emits a test per endpoint that calls it as tenant A with
   tenant B's ids and asserts not-found. **Fail the build if an endpoint has no
   generated test.** This is the single most valuable test in the repository.
4. **Benchmarks** (`criterion`) against the NFR budgets — 400 ms p95 pre-check,
   worst-case cascade fan-out on the largest hull. Run in CI and fail on
   regression beyond a threshold.

Plus: `cargo nextest` for speed, `cargo llvm-cov` with a floor on
`wadl-engine` specifically (aim high there; the shell can be lower).

### Supply chain

- `cargo deny` in CI: licences, advisories, duplicate versions, and a
  `bans` list. Vendored sources (`cargo vendor`) committed or mirrored so an
  air-gapped build works.
- `cargo auditable` builds, SBOM generated in CI and shipped with the artifact.
- MSRV pinned in `rust-toolchain.toml`. Reproducible builds.

### Observability

- `tracing` with structured fields, `tracing-subscriber` to stdout as JSON.
  Correlation ids that match audit ledger entry ids so the two can be joined.
- Prometheus metrics via `metrics` + an in-process exporter. No hosted APM.
- `cargo run -p wadl-cli -- support-bundle` collecting logs, metrics, schema
  version, rule inventory and a redacted decision sample into one file. Build it
  in the first month; you will never have access to production.

### Documentation

- `#![warn(missing_docs)]` on every public item in `wadl-engine` and
  `wadl-domain`. These crates will be read by people auditing safety behaviour.
- Doc comments explain **why**, not what. A comment restating the code is noise;
  a comment explaining why the visited set is keyed by compartment *and coupling
  type* is the difference between a maintainable engine and a broken one.
- `cargo doc` clean, no broken intra-doc links.
- ADRs in `/docs/adr` for every decision that reverses expensively. Start with
  the four in architecture §4.

---

## Milestone 1 scope

Build in this order. Each is done when a planner could use it.

**1.1 Tenancy, vessels, personas.** Organization, ship class with ordered decks,
vessel, availability, person, persona with named capabilities, per-vessel
assignment. Row-level security in the first migration. Seed three carriers
(CVN-73 PIA-26, CVN-71 SRA-26, CVN-75 DPIA-28) plus a DDG and an LPD so
multi-class is exercised; leave two hulls unassigned to the demo user so RBAC
refusal is visible.

**1.2 Shared operating context.** Hull and persona as one selection that follows
the user across surfaces. `reference/shipyard-context.js` shows the prototype's
mechanism; server-side session state in the real thing. **When the context names
a hull the surface has no data for, say so** — the prototype shows an OUT OF
SCOPE banner rather than silently rendering the previous hull.

**1.3 Compartment register and Deck Explorer.** Class-templated register with
per-hull deltas. Ordered decks so "directly above" is computable. Thirteen deck
sheets, each linked to a deck, so selecting a compartment opens the right one.
Plan view first, the three-deck vertical section second.

**1.4 Work Orders and Distributed Packages.** Ingest provenance on every row.
Segment topology with an upstream pointer so "cannot be tested until everything
upstream is complete" is a query. **Compute stranded man-hours** — hours in
compartments that are ready but blocked by a *different* compartment. It is the
most persuasive number in the product.

**1.5 Sequence Board.** NOW line, week ruler, milestone gates, per-zone health,
overlapping work stacked not collided. What-if sandbox that prices a move and
**never writes the baseline**.

**1.6 Conflicts & Risk.** Boundary, resource, sequence-inversion and saturation
conflicts, each priced in critical-path days, recovery costed at three horizons.

**1.7 Daily Ops.** Shift muster by zone, blockers with aging, service dispatch
ranked by schedule impact rather than request age.

**1.8 Decision Log.** Every consequential action records what moved, what it
cost, and the reasoning, evidence-linked at the moment of decision.

## Out of scope for milestone 1

The rule engine, the WADL field app and console, ITP and dispositions, offline
sync, schedule ingest, Configuration & History.

**But:** create `crates/wadl-engine` now, with the `DecisionState` enum, the
`Clock` trait, the traversal signature and the wasm CI job — even if
`evaluate()` returns seeded values. Authorization state on a compartment must be
read through that crate's interface from day one. Computing it in the shell means
restructuring later; a seam with seeded values behind it means linking the real
engine in.

## Invariants

1. **Decision support, not automation.** The shell flags, ranks, prices and
   proposes. It never modifies the schedule of record and never grants an
   authorization.
2. **Provenance on every ingested row.** If it was seeded, it says seeded.
3. **Nothing is deleted.** Supersession is a state.
4. **Row-level security from the first migration.**
5. **No outbound network calls.** Vendor everything.
6. **No panics in library crates.** A panic in the engine is a stopped shipyard.

## Definition of done

- A planner opens a hull, sees today's shift plan, finds a compartment, opens its
  deck drawing, sees the work orders in it, sees a package footprint with its
  governing constraint and stranded hours, and reads the sequence board with its
  gates and zone health.
- Switching hull or persona re-scopes every module; a hull with no data says so.
- A user assigned to three of five hulls cannot reach the other two by any path,
  and the generated leak test proves it endpoint by endpoint.
- `cargo clippy -- -D warnings` clean. `cargo deny check` clean. The wasm build
  of `wadl-engine` passes. No outbound connections in a network trace.

## How to work

- Small commits, each one runnable and each one green.
- Write the generated leak test in week one.
- **When the specs mark something an open question, stop and ask.** Those are
  genuinely unresolved. A plausible guess is worse than a question because it
  looks settled.
- When you disagree with a spec, say so. Several decisions in them are marked
  arguable and I would rather argue now.

## First response — before any code

1. Your frontend choice (TypeScript+React or Leptos) and why.
2. Anything in `04-platform-schema.sql` you think is wrong. Doc 02 §9 lists the
   compromises I know about — tell me what I missed.
3. Your crate dependency graph, and whether you agree `wadl-engine` can stay
   free of `tokio` and `sqlx`.
4. How you intend to typestate the permit lifecycle.
5. Any open question from the specs you need answered before starting.
