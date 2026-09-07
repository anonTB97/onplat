# Plan of Action & Milestones — seed register

The known gaps between this tree and a production authorization, each with
the mitigation already in place, the named closure path, and the event that
triggers closure. Kept in the repository so the POA&M is versioned with the
code it describes; `scripts/self-assessment.sh` flags the ones it can detect
at runtime (WARN verdicts cite these IDs).

Severity vocabulary: **High** blocks production exposure; **Moderate** is
acceptable behind compensating controls, time-boxed; **Low** is tracked.

## POAM-1 — Dev identity shim is the default trust mode

- **Weakness.** With `WADL_PROXY_KEY` unset, identity headers are trusted as
  given; anyone who can reach the port can assert any tenant, any person and
  any role. Severity: **High** if the port is ever exposed; nil on loopback.
- **Mitigation in place.** Loopback bind is the default and widening it is
  an explicit unit-file decision; proxy-asserted mode exists, is tested, and
  is one environment variable away; the shim is labelled **DEMO MODE** on
  the startup banner, on `/api/whoami` (`person.source` `dev-shim…`, a
  `demo mode` warning when no roles are asserted) and in the shell's amber
  badge, so a shim session cannot pass for an authenticated one in a
  screenshot; WADL-SA-05 WARNs whenever the shim is active and WADL-SA-11
  WARNs whenever the person is the shim's.
- **Closure.** Deploy behind the CAC/PIV terminator with `WADL_PROXY_KEY`
  set per `deploy/README.md` and the six-header contract in
  `docs/identity-proxy-contract.md`. Trigger: first deployment reachable by
  anyone but a developer. Verify: WADL-SA-05 reports `proxy-asserted`,
  WADL-SA-11 reports `whoami names a person (<id>)`, and the staging test in
  the contract (§8) is filed with the pilot record. Evidence today:
  `crates/wadl-api/src/auth.rs` tests `proxy_mode_refuses_a_request_with_no_person`,
  `an_empty_key_admits_nobody`; `scripts/self-assessment.sh` WADL-SA-05/11;
  `shell-web/src/identity.test.ts` "a proxy identity sends no identity headers".

## POAM-2 — Demo store is in-memory — **CLOSED**

- **Was.** The serve binary could only hold state in memory: no durability,
  and the RLS layer (the second isolation gate) was not in the serving path.
- **Closure, delivered.** `PgStore` now implements the full `Repositories`
  trait — work orders and packages from the `work_segment` topology,
  adjacency/hazards/rules as typed engine inputs with rejection paths for
  schema drift, ingested documents (schedule of record, zone chart, budget
  book) as atomic all-or-nothing rows, and the hash-chained ledger writing
  through `audit_entry` under an advisory lock. Building `serve` with
  `--features postgres` and setting `DATABASE_URL` serves the migrated,
  seeded database with RLS armed on every request; CI proves the trait
  suite and an end-to-end API answer against live PostgreSQL on every push
  (`migrations` job).
- **Residual, tracked here.** Development still defaults to the in-memory
  demo store (that is the point of it), and the demo register generator
  remains a demo-store property — the database serves only what was
  actually ingested. Real deployments must run `wadl migrate && wadl seed`
  (or their own data load) before first start.

## POAM-3 — No per-client throttling

- **Weakness.** Overload protection is global (semaphore + timeout); one
  hostile or runaway client inside the perimeter can consume the shared
  in-flight budget and starve others. Severity: **Moderate** — every caller
  has already passed CAC at the terminator, so this is an insider-noise
  concern, not an anonymous-DoS one.
- **Mitigation in place.** Global shed answers 503 immediately (the
  condition is loud, attributable in the audit stream per tenant, and
  self-clearing); the terminator can rate-limit per client certificate
  today.
- **Closure.** Per-tenant token bucket in `wadl_api::hardening`, keyed on
  the resolved scope, if audit data ever shows one tenant crowding the
  budget. Trigger: observed contention in the audit stream, not
  speculation.

## POAM-4 — Audit stream retention is delegated to journald

- **Weakness.** The application emits audit records but does not itself
  sign, forward, or retain them; a host administrator can alter the
  journal. Severity: **Moderate**, standard for host-logged services.
- **Mitigation in place.** Decision-grade events are separately recorded in
  the hash-chained ledger (tamper-evident, `verify-ledger`); the unit file
  routes both streams to journald, where sealing and forwarding are
  configurable enclave-side.
- **Closure.** Enable `Seal=yes` + `ForwardToSyslog`/remote forwarding in
  the enclave's journald per site policy. Trigger: site AU-9 requirements
  at deployment.

## POAM-5 — SBOM is generated but not attested

- **Weakness.** CI emits the SPDX SBOM as an artifact, but releases are not
  yet signed and the SBOM is not bound to a release artifact
  cryptographically. Severity: **Low** until artifacts leave CI.
- **Mitigation in place.** `--locked` builds from a committed lockfile, the
  reproducibility check makes the binary independently rebuildable — the
  strongest attestation available without key custody decisions.
- **Closure.** Sign release binaries + SBOM (cosign or the enclave's PKI)
  when a release process with key custody exists. Trigger: first versioned
  release consumed outside CI.

## POAM-6 — Role model is per-hull assignment only — **CLOSED**

- **Was.** Authorization distinguished tenants and hull assignments but not
  duties within them; everyone assigned to a hull could use every door on
  it, including imports, and no ledger row named a person.
- **Closure, delivered (S12).** The identity hop carries a person
  (`x-wadl-person`, `x-wadl-person-name`) and roles (`x-wadl-roles`),
  resolved once in the same extractor (`auth.rs::resolve`) into an `Actor`
  on `TenantScope`. One role → capability matrix (`roles.rs::MATRIX`, eight
  roles, five gated capabilities) and one `route_layer` gate over every POST
  in the route inventory (a unit test refuses a POST placed in neither the
  gated table nor the empty free list): a role without the capability is
  403 `problem+json` with a sentence naming who may, and nothing is written;
  a dry run is never gated; a foreign hull is 404 before any capability is
  judged. Every ledger row on both stores hashes the actor (chain format 2,
  migration `0017_ledger_actor.sql`); rows from before keep verifying in
  the same chain. `/api/whoami` serves person, roles, capabilities, hulls,
  the matrix and warnings; the shell boots from it, greys the doors the
  person may not open with the same sentence, and names the person in the
  ledger's By column. Evidence: `crates/wadl-api/tests/identity.rs`;
  `crates/wadl-api/tests/generated_leak_test.rs` `weakest_role_post_…` (one
  per gated route, driven as a Reader, plus the count test);
  `crates/wadl-api/src/roles.rs` tests (`every_post_route_in_the_inventory_is_gated_or_named_free`,
  `the_gate_sees_the_matched_path_on_every_gated_route`);
  `crates/wadl-store/src/ledger.rs` v1→v2 tests and `pg_rls.rs`
  `a_ledger_row_names_its_person_and_a_v1_row_before_it_still_verifies`;
  `shell-web/src/identity.test.ts`; SSP statements AC-6, AU-10, IA-2 in
  `docs/ssp-input.md`; WADL-SA-11.
- **Residual, tracked here.** Roles are per session, not per hull (the pilot
  is one hull). The proxy subject is a string (`actor_id text`); a
  directory-backed `person` row (`by_person uuid`) waits for a directory. A
  proxy that cannot map groups makes every user the `WADL_DEFAULT_ROLES`
  role — a deployment decision the yard signs, visible in the SSP.

## POAM-7 — The seed-dependent API suites run on the memory store only

- **Weakness.** Nine API suites (`clear_loop`, `as_of`, `clear_history`,
  `mitigations`, `proposals`, `raise_loop`, `budgets`, `geometry`,
  `ship_doors`) assert on the 24-space seed world, which `pg_seed.sql`
  anchors on a different instant from the memory store's `DEMO_ANCHOR_MS`;
  they cannot run on PostgreSQL until one seed is generated from the other.
  Severity: **Low** — the store paths they exercise are covered on
  PostgreSQL by `pg_rls.rs`, and the reference hull runs on PostgreSQL end
  to end (`crates/wadl-cli/tests/database.rs`, the restore drill).
- **Closure.** Generate `pg_seed.sql` from the in-memory world (a store
  slice of its own), then run the nine suites on both backends through the
  test-support module (S16). Trigger: the first defect found on PostgreSQL
  that a memory-store suite would have caught.
