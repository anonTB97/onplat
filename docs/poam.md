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
  given; anyone who can reach the port can assert any tenant. Severity:
  **High** if the port is ever exposed; nil on loopback.
- **Mitigation in place.** Loopback bind is the default and widening it is
  an explicit unit-file decision; proxy-asserted mode exists, is tested, and
  is one environment variable away; WADL-SA-05 WARNs whenever the shim is
  active.
- **Closure.** Deploy behind the CAC/PIV terminator with `WADL_PROXY_KEY`
  set per `deploy/README.md`. Trigger: first deployment reachable by anyone
  but a developer. Verify: WADL-SA-05 reports `proxy-asserted`.

## POAM-2 — Demo store is in-memory

- **Weakness.** The demo serve binary holds state in memory: no durability,
  and the RLS layer (the second isolation gate) is not in the serving path.
  Severity: **High** for production data; intended for the demo.
- **Mitigation in place.** The PostgreSQL store, migrations, and RLS
  policies exist behind the `postgres` feature and are proven on a live
  database in CI (`migrations` job); the in-code scope checks — the first
  gate — are identical in both stores and leak-tested.
- **Closure.** Production wiring passes the PostgreSQL-backed store in
  `serve` (compile with `--features postgres`, connect via `DATABASE_URL`).
  Trigger: any deployment holding real availability data.

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

## POAM-6 — Role model is per-hull assignment only

- **Weakness.** Authorization distinguishes tenants and hull assignments
  but not duties within them (planner vs. operator vs. read-only);
  everyone assigned to a hull can use every door on it, including imports.
  Severity: **Moderate** once multiple duty roles share a deployment.
- **Mitigation in place.** All mutating doors are staged (dry-run, confirm,
  revert) and every decision lands in the ledger with the acting identity —
  misuse is recoverable and attributable, not silent.
- **Closure.** Introduce role claims asserted by the identity proxy
  alongside the existing headers, enforce at the same single extractor,
  serve the capability set via `/api/whoami`, and extend the generated leak
  tests to drive each door under the weakest role. Trigger: roles beyond
  per-hull assignment entering the domain model.
