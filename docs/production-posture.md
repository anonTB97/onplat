# Production posture — the path from demo to ATO

This is the standing plan for turning Shipyard AI Onboard + WADL into a system
a Navy authorizing official can accredit, and the philosophy every future
slice is built under. It is written the way an assessor reads: each claim
names the thing that *enforces* it — a CI job, a lint, a test, a module — 
because a control that nothing enforces is a sentence in a document, not a
control.

The one-line philosophy: **every dependency, port, header, byte limit, and
line of unsafe surface is a finding waiting to be written; the cheapest time
to close a finding is before it exists.**

---

## Where the codebase already stands (measured, 2026-08)

The demo was built under production discipline from the first commit, so the
baseline is unusually strong. What follows is *measured on this tree*, not
aspirational:

| Property | State | Enforced by |
|---|---|---|
| `unsafe` code | forbidden workspace-wide | `unsafe_code = "forbid"` + clippy in CI |
| Panics in the serving path | denied (`unwrap`/`expect`/`panic`/`todo`/indexing) | workspace clippy lints, `-D warnings` |
| Wall-clock access | one sanctioned caller (`SystemClock`) | `disallowed_methods` in clippy.toml |
| Tenant isolation | RLS policies **plus** in-code scope checks | `pg_rls` on a real PostgreSQL + 26 generated cross-tenant leak tests, regenerated-or-fail in CI |
| Decision logic | pure library, no I/O, no time, builds for wasm32 | CI wasm jobs for engine/plan/mitigate/issues |
| Import doors | all-or-nothing, scope check **before** body read, 256 MB ceiling at three named routes only | `read_import_body` + tests pinning both directions |
| Evidence ledger | hash-chained (sha2), served, verifiable | `wadl-cli verify-ledger`, ledger tests |
| Frontend runtime deps | react + react-dom, nothing else | `package.json`; no CDN, no telemetry, no fonts fetched |
| Rust dependency tree | 239 crates workspace-wide; the API server tree carries **no database driver and no TLS stack** | `postgres` feature gate (below), `cargo tree` |
| Licenses / advisories / duplicate majors / registry sources | vetted every push | `cargo-deny` in CI |
| Toolchain | pinned | `rust-toolchain.toml` |
| Lockfile honesty | CI builds exactly `Cargo.lock` or fails | `--locked` on every CI cargo invocation |

---

## Pillar 1 — Dependency minimalism and supply chain

An ATO package must justify every component; the SBOM is an inventory of
things that can be found vulnerable. The lever is therefore *not adding
things*, and the discipline is a written admission test.

**Admission test for any new dependency** (all five, in order):

1. Can the standard library, tokio, or ~100 lines of reviewed code in this
   repo do it? Then do that — a small module we own is cheaper to accredit
   than a crate nobody here reads. (Worked examples: the hardening layer,
   the XER parser, the CSV zone/budget parsers, the static file server.)
2. Is it needed at *runtime in the deployed binary*, or only in dev/test/CI?
   Dev-tooling goes in `[dev-dependencies]` or CI, never in the binary.
3. Is the need deployment-specific? Then it goes behind a cargo feature,
   default **off**, and only the binaries that need it opt in — the pattern
   `wadl-store`'s `postgres` feature sets.
4. Does `cargo deny check` pass with it — license, advisory history,
   maintenance signal, no new duplicate major versions?
5. Does it pull a transitive tree out of proportion to the job? A left-pad-
   sized need does not justify a 40-crate tree.

**Already applied:**

- `tower-http` removed — declared, never used; the middleware it would have
  provided is hand-rolled in `wadl-api::hardening` on tokio primitives.
- `tower` demoted to dev-dependency (test utilities only).
- `sqlx` (~90 transitive crates, its own TLS and protocol stack) is now
  behind `wadl-store`'s `postgres` feature. The demo server, the API tests,
  and the whole shell backend compile without it; `wadl-cli` and the RLS
  test job are the two sanctioned consumers. `cargo test --workspace` in CI
  runs featureless, which keeps the claim checkable; clippy runs
  `--all-features` so the gated code never rots.
- Workspace dependencies declare `default-features = false` and enumerate
  features (uuid carries no RNG except where IDs are minted; axum carries
  no websockets/multipart/http2; chrono carries no locale data).

**Wave 2 additions (done):** the direct `tracing` dependency and the whole
`tracing-subscriber` tree (regex and friends) removed — the audit and
diagnostic streams are hand-rolled JSON lines; a vendored-source `--offline` build
rehearsed in CI on every push so the air-gapped enclave build is a practiced
procedure; SBOM (SPDX, from both lockfiles) emitted as a CI artifact.

## Pillar 2 — Identity and access

The dev shim (`x-org-id` / `x-assigned-vessels` headers) is a *seam*, not a
liability to hide: `auth.rs` is the single place identity enters, every
scoped handler runs the extractor first, and the generated leak tests fail
CI if a route skips it. Production identity replaces the inside of that one
extractor — CAC/PIV client certificates terminated at the reverse proxy
(the yard norm) or an OIDC/SAML broker — and maps the authenticated subject
to the same `TenantScope`. Nothing downstream changes, which is the point
of having built the seam first.

Defense in depth is already two-layered and must stay so: the in-code scope
checks (provably present, leak-tested) and PostgreSQL row-level security
(provably effective, `pg_rls` on a real database). A dropped policy and a
skipped check each fail CI independently.

**Trust modes (wave 2, done).** The extractor now enforces *who may assert*
those identity headers. Default is the dev shim (headers trusted as given —
loopback only). Setting `WADL_PROXY_KEY` arms **proxy-asserted** mode: a
request must carry a matching `x-wadl-proxy-key`, compared in constant time,
before its identity headers are read at all. That is the accredited-yard
pattern — CAC/PIV terminates at the reverse proxy, which asserts the mapped
identity plus the shared key on its private hop (and strips all three
headers from client traffic; `deploy/README.md` documents the contract).
`GET /api/whoami` serves the resolved scope and the active mode, so a proxy
pairing is verifiable end to end with one call, and the shell can show a
caller the doors they can actually open (AC-6).

**Still ahead:** session lifetime/re-authentication rules at the broker, and
a full role→capability matrix once roles beyond per-hull assignment exist in
the domain.

## Pillar 3 — Transport and browser protections

- The binary binds **loopback by default**; exposing it is an explicit
  `WADL_BIND` decision made in a unit file, behind whatever terminates TLS.
  TLS stays out of the binary on purpose: yards already run accredited
  terminators (and CAC termination lives there anyway), and carrying a TLS
  stack would roughly double the crate tree to re-solve a solved problem.
- Every response — API, static, even shed 503s — carries the fixed header
  set in `wadl_api::hardening`: a CSP that allows exactly what the shell is
  (same-origin everything, inline style attributes, `data:` favicon, nothing
  framed, nothing third-party), `nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, COOP/CORP `same-origin`, a shut
  Permissions-Policy. The product loads nothing from any third party; the
  CSP converts that from a habit into an enforced property.
- No CORS layer exists because no cross-origin caller is allowed. Adding
  one would be a decision, not a default.

## Pillar 4 — Resource protection and availability

All hand-rolled in `wadl-api::hardening` (≈100 lines, readable in one
sitting — that is its accreditation story) and exercised daily because the
dev server runs the same stack:

- **Body ceilings at the doors**: the three import routes read their bodies
  by hand *after* the tenant scope check, against a 256 MB ceiling; every
  other route keeps axum's small default. Tests pin both directions
  (oversized body at a small route refused; scope refused before bytes are
  buffered).
- **Concurrency shedding**: a semaphore refuses work over the limit with an
  immediate 503 — loud degradation instead of queueing until the host dies.
- **Request timeout**: measured to first response so imports finish and
  large streamed reads are not cut off mid-body.
- **Graceful drain** on SIGTERM/Ctrl-C, so a deploy never truncates an
  import mid-commit.

## Pillar 5 — Audit and accountability

The domain already demands what AU controls ask for: decisions are recorded
in a hash-chained ledger with actor, timestamp, and rationale, the chain is
verifiable (`wadl-cli verify-ledger`), and the UI treats the ledger as a
first-class surface.

**Transport audit stream (wave 2, done).** The outermost middleware layer
emits one JSON object per request on stdout —

```json
{"audit":"http","ts_ms":1765432100123,"method":"POST",
 "path":"/api/vessels/…/schedule-of-record","status":413,"dur_ms":12,"org":"…"}
```

— hand-rolled on `serde_json` rather than the tracing stack, after the
tree's one `tracing::error!` call was found silently dropped for want of a
subscriber: a `println` cannot have that failure mode. The direct `tracing`
dependency and the whole `tracing-subscriber` tree (regex and friends) left
with it; a `tracing-core` remnant remains only as axum's own transitive. The governing rule is that
*refusals are logged at least as loudly as successes*: every `/api` request
and every non-2xx response anywhere is logged (shed 503s included — the
audit layer wraps the limiter), while 2xx asset/health noise, query strings,
and request bodies are excluded by design (bodies are accounted for by the
ledger and the import doors' own receipts). Backend errors emit
`{"event":"backend_error",…}` on stderr. Under systemd both streams land in
the journal, whose sealing and forwarding is the AU-9 tamper story
(`deploy/wadl.service`).

## Pillar 6 — Build and deploy integrity

- **One artifact**: the binary serves the API and the built shell
  (`WADL_STATIC_DIR`), with a hand-rolled static server whose traversal
  guard is ~15 visible lines, unit-tested. One artifact to scan, sign,
  and deploy; no separate web server to accredit or misconfigure.
- **Configuration is environment-only** and enumerated in the serve
  binary's doc comment; there is no config file to drift from deployed
  reality, and unparseable values fall back to safe defaults (loopback,
  8080) rather than failing open.
- Toolchain pinned; `--locked` everywhere in CI; release profile already
  builds with thin LTO, one codegen unit, and line-table debug info (kept
  deliberately: actionable backtraces from the field outweigh the size).
- **Wave 2, done:** `deploy/wadl.service` — a hardened unit template
  (DynamicUser, `ProtectSystem=strict`, empty capability set,
  `@system-service` seccomp filter, loopback-only address families, read-only
  `/opt/wadl`) with the install procedure in `deploy/README.md`; SBOM
  (SPDX from both lockfiles) generated as a CI artifact on every push; an
  air-gap rehearsal job (`cargo vendor` + `--offline` build) so the enclave
  build is a practiced procedure; and an on-demand reproducibility check
  (two clean release builds, hashes must match) for release cuts.

---

## NIST 800-53 anchor points (for the eventual SSP)

Not a compliance matrix — a map from control families to the mechanisms in
this tree. The SSP-shaped version of this table, with per-control
implementation statements and verification pointers, is the generated
`docs/ssp-input.md`:

| Family | Mechanism in this tree |
|---|---|
| AC-3 / AC-4 (enforcement, information flow) | `TenantScope` extractor on every scoped route; PostgreSQL RLS; generated cross-tenant leak tests |
| AU-2 / AU-9 / AU-10 (audit, protection, non-repudiation) | hash-chained decision ledger + `verify-ledger`; JSON audit stream (every /api request, every refusal) into the journal |
| CM-7 (least functionality) | feature-gated postgres; `default-features = false` everywhere; loopback bind default; no CORS; systemd sandbox in `deploy/wadl.service` |
| IA-2 (identification) | single identity seam in `auth.rs` with proxy-asserted trust mode (`WADL_PROXY_KEY`); `/api/whoami` for end-to-end verification |
| RA-5 / SA-11 (vuln monitoring, developer testing) | cargo-deny on every push; clippy wall; leak/RLS/property/golden tests in CI |
| SC-5 (denial-of-service protection) | per-door body ceilings; concurrency shed; request timeout |
| SC-8 (transmission confidentiality) | TLS at the accredited terminator; loopback default until then |
| SI-10 (input validation) | all-or-nothing imports with dry-run preview and typed refusals; XER cell caps; zero-activity rejection |

---

## Waves

- **Wave 1 — done in this change.** Dependency cuts (tower-http out, tower
  dev-only, sqlx feature-gated), the hardening layer (headers, shed,
  timeout, drain), single-binary static serving with traversal guard,
  `WADL_BIND`, `--locked` CI, this document, and the philosophy written
  into `CLAUDE.md` so it governs every future slice.
- **Wave 2 — done.** Proxy-asserted identity trust boundary
  (`WADL_PROXY_KEY`, constant-time compare) with `/api/whoami` serving the
  resolved scope and mode; the JSON audit stream (refusals as loud as
  successes) and the tracing stack removed in its favor; SBOM artifact,
  air-gap rehearsal, and reproducibility check in CI; the hardened systemd
  unit and deploy runbook in `deploy/`.
- **Wave 3 — done.** The accreditation package, as build products:
  `docs/ssp-input.md` is *generated* (`cargo xtask gen-ssp`) with the
  endpoint inventory and enforcement parameters read from the code, and CI
  refuses an API change that isn't reflected in it — the paperwork cannot
  drift from the system. `scripts/self-assessment.sh` is the STIG-style
  checklist as a runnable script (checks `WADL-SA-01…10`: headers, refusal
  shapes, scope, body ceilings, traversal, error hygiene), executed by CI
  against a booted binary on every push and by an assessor against a
  deployment with one command; WARN verdicts cite their POA&M entry.
  `docs/poam.md` seeds the POA&M register — six items, each with the
  mitigation in place, the named closure path, and the trigger. Session
  lifetime/re-auth rules are specified for the terminator in
  `deploy/README.md`.
- **Conditional (tracked as POAM-6).** Role→capability matrix beyond
  per-hull assignment, when such roles enter the domain model: asserted by
  the proxy, enforced at the one extractor, served via `/api/whoami`,
  leak-tested per role.
