# Council 1 — Chief Systems Architect: containerization and platform

Reviewed on branch `claude/kickoff-from-docs-arhiib` at `5af958b` (working tree
carries S14 sitting-B edits in `rule_table.rs`/`roles.rs`/`routes.rs`, not
read for this pass). Nothing was implemented; the measurements in §1.4 were
run against `target/release/serve` (memory store) and a postgres-feature
build made for this pass under `target/pg-council/` (not committed).
`docs/council/` was empty when this was written: there is no earlier persona
to be in tension with, so §4 names the standing documents instead and the
personas expected after this one.

## 1. Current state

### 1.1 Solid — keep, and build the container around it

- **The process is already container-shaped.** Configuration is environment
  only, enumerated in one place (`crates/wadl-api/src/bin/serve.rs:13-47`),
  read once (`auth.rs:147-151`, `OnceLock`); unparseable values fall back
  rather than fail open (`serve.rs:321-330`). No config file, no working
  directory writes, no temp files: `readOnlyRootFilesystem: true` costs
  nothing. No egress of any kind (`docs/ssp-input.md` §2; CSP `connect-src
  'self'`, `hardening.rs:236-242`) so a deny-all egress NetworkPolicy with one
  exception (the database) is exact.
- **Shutdown is correct.** SIGTERM and Ctrl-C both drain (`serve.rs:389-416`,
  `axum::serve(..).with_graceful_shutdown`, `:378-380`). Measured: an
  in-flight register read during SIGTERM completed 200 and the process exited
  0 in 0.26 s. This is exactly what a pod deletion sends.
- **The identity boundary is loopback-safe by construction.** The dev shim
  refuses to bind off loopback without `WADL_PROXY_KEY` or the explicit
  override (`serve.rs:335-343`, `auth.rs:184-193`, CI proves it at
  `ci.yml:85-97`). A container that must bind `0.0.0.0` therefore cannot ship
  the shim by accident. Under an Istio sidecar the app may even stay on
  `127.0.0.1` (the sidecar forwards inbound to localhost), which is the
  strongest shape.
- **Data-tier isolation is transaction-scoped, which is pooler-compatible.**
  `SET LOCAL ROLE wadl_app` + `set_config(.., true)` (`pg.rs:107-117`) are
  transaction-local; per-hull serialisation uses `pg_advisory_xact_lock`
  (`pg_repo.rs:1182`, `:2049`), also transaction-scoped. Nothing is
  session-state. PgBouncer in transaction mode works without change, and the
  locks are database-side, so N replicas serialise correctly on the ledger
  chain and on `ingest_run.seq` (`pg_repo.rs:1178-1191`).
- **Upgrade order maps 1:1 onto a Helm pre-upgrade migration Job.** Forward-only
  additive migrations, a binary that refuses a database behind it and serves
  one ahead with a warning (`serve.rs:228-272`, `docs/runbook.md:221-277`).
  Old pods keep serving during a rolling upgrade; new pods refuse until the
  Job has run. `/health` carries the stamp and `schema_state`
  (`handlers.rs:106-138`).
- **Supply chain is ahead of most ATO packages**: `--locked`, cargo-deny, SPDX
  SBOM, vendored offline build rehearsal, on-demand reproducibility
  (`ci.yml:262-323`). The sqlx tree is feature-gated (`wadl-store/Cargo.toml`
  `postgres`).
- **Process sandbox is well thought through for systemd** (`deploy/wadl.service`
  `DynamicUser`, `ProtectSystem=strict`, empty capability set, seccomp
  `@system-service`, `MemoryMax=2G`). Every directive there has a Kubernetes
  equivalent (§3), and the binary needs nothing the sandbox removes.

### 1.2 Missing — nothing disqualifying, but none of it exists

- **No container artefacts at all.** No `Dockerfile`, no `.dockerignore`, no
  compose file, no Kubernetes manifests or Helm chart, no image build or scan
  in CI (`ls` of the repo root; `ci.yml` has no image job). `deploy/README.md:1-3`
  states the deployment shape as "one artifact, one unit file, one reverse
  proxy" — systemd on a host. `docs/ato-package.md:41-48` explicitly leaves
  enclave placement to the deploying activity. The platform story stops at
  the host boundary.
- **One health endpoint doing two jobs.** `/health` (`lib.rs:72`) performs a
  database round trip on every call and answers 503 when the database is
  unreachable (`pg_repo.rs:828-853`, `handlers.rs:117-122`). That is the right
  *readiness* answer and the wrong *liveness* answer: a kubelet liveness probe
  on it would restart every replica in a loop during a database outage,
  turning a data-tier incident into an app-tier one. There is no
  dependency-free liveness endpoint. `/health` is also unauthenticated and
  discloses the commit, schema version, backend and identity mode; behind
  the terminator that is fine, exposed to a load balancer it is a finding.
- **No pre-stop drain window.** The listener stops accepting the instant
  SIGTERM arrives; Kubernetes removes the endpoint asynchronously, so a
  rolling restart produces connection refusals for the seconds between. No
  `preStop` hook, no "draining" state in `/health`.
- **Secrets are env-only, and the unit file's credential hint does not work.**
  `deploy/wadl.service:36-38` suggests `LoadCredentialEncrypted`, but the
  binary reads only `WADL_PROXY_KEY` from the environment
  (`auth.rs:102-104`); nothing reads `$CREDENTIALS_DIRECTORY` or any `*_FILE`
  variable (`grep` over `crates/` is empty). `DATABASE_URL` carries the
  password in the environment (`serve.rs:78`), which every `kubectl describe`
  and crash dump prints. Kubernetes mounts secrets as files; the binary
  cannot consume them that way.
- **The pool is hard-coded at 8 with a 30 s acquire timeout** (`pg.rs:60-63`;
  sqlx default `acquire_timeout` 30 s) while the request gate admits 512
  (`hardening.rs:42-53`). Under pool starvation a request waits up to 30 s on
  the pool and then the request timeout fires at 30 s too: overload on the
  PostgreSQL store presents as a 30 s stall followed by a 503, not the
  immediate shed the posture claims (`docs/production-posture.md:155-157`).
  Neither pool size nor acquire timeout nor a statement timeout is
  configurable; a runaway statement holds a pooled connection past the
  request that was abandoned.
- **Every scoped read is two transactions, and the schedule is re-read from
  jsonb on each.** `pg_get_vessel` runs the full `list_vessels` query per call
  (`pg_repo.rs:171-181`) before the method's own transaction (25
  `with_tenant` sites); the schedule of record is fetched and deserialised
  whole — ~2 MB at 5,706 activities, ~14 MB at 40k — at four separate sites
  (`pg_repo.rs:954, 979, 995, 1025`) so one `issues` request pays it more
  than once. Measured in §1.4. Not wrong, but it sets the pod's CPU/memory
  request and the replica count.
- **Import-door memory is unbounded by concurrency.** `read_import_body`
  buffers up to 256 MB per request (`handlers.rs:26-31`, `lib.rs:263`) and
  the compression layer buffers whole responses up to 256 MB
  (`hardening.rs:155-160, 200`). The only limiter is the global 512-permit
  gate — no separate ceiling for concurrent imports (`grep Semaphore` finds
  only `hardening.rs`). A pod with a 2 GiB limit is OOM-killed (and the
  in-flight commits with it) by a handful of simultaneous large imports.
  `docs/stress-test.md:64` already measured 1.6 GB RSS at 64 concurrent
  register readers on the memory store.
- **Audit stream assumes journald.** AU-9 is delegated to journald sealing
  (`docs/poam.md` POAM-4; `deploy/wadl.service:86-91`); `wadl support-bundle`
  shells out to `journalctl -u wadl` (`crates/wadl-cli/src/bundle.rs:225-244`).
  In a container there is no journal: stdout/stderr go to the runtime and a
  log pipeline. The audit line carries no replica identity and no request id
  (`hardening.rs:107-116`; `docs/runbook.md:299-301` defers request ids), so
  N replicas' lines interleave indistinguishably.
- **The image base decision is open.** The release binary is dynamically
  linked against glibc (`ldd`: `libgcc_s`, `libm`, `libc`), 30 MB with
  `debug=1` line tables kept on purpose (`Cargo.toml [profile.release]`).
  That rules out `distroless/static` and `scratch` unless a musl target is
  added; `distroless/cc` (or an Iron Bank ubi9-micro) is the glibc-compatible
  minimal base. The dependency tree has no C library beyond libc (no
  OpenSSL, no ring — `Cargo.lock` has zero `rustls`/`native-tls`/`openssl`
  entries), so a fully static musl build is feasible and would close the
  question.
- **`migrations/0001:31-36` creates a cluster role** (`CREATE ROLE wadl_app`),
  so the migration Job needs `CREATEROLE` (or the DBA pre-creates the role),
  and the app's login role must be a member of `wadl_app` for `SET LOCAL
  ROLE`. Neither requirement is written anywhere an operator of a managed
  PostgreSQL (CloudNativePG, Crunchy PGO, RDS) would look.

### 1.3 Disqualifying for IL5/NNPI, or for carrier-scale concurrent use

1. **The binary cannot encrypt its database connection, and the paperwork
   says the DBA decides `sslmode`.** `Cargo.toml:66` enables no sqlx TLS
   feature; `Cargo.lock` contains no TLS stack; a `DATABASE_URL` with
   `sslmode=require` fails to connect. `docs/ato-package.md:82-84` says "the
   connection string decides `sslmode`" — untrue for this build. On a single
   host (the systemd shape) the hop is loopback and this is moot. The moment
   the database is on another host or another pod — every Kubernetes shape,
   every GovCloud managed database — the database hop is plaintext NNPI and
   fails SC-8/SC-13 (IL5 requires FIPS 140-validated encryption in transit).
   Two valid resolutions, one per topology (§4.1); either way the false
   statement in the ATO package must go now.
2. **A document commit and its ledger row are two transactions.** The door
   writes the document (`upsert_document`, `pg_repo.rs:465-491`) and then
   calls `ledger_document_on` → `store.append_audit` in a fresh transaction
   (`documents.rs:487-506`, `pg_repo.rs:1948-1971`); `commit_schedule_run`
   (`pg_repo.rs:1181-1229`) likewise commits before the door ledgers. A pod
   killed between the two — OOM, node drain past `terminationGracePeriod`,
   node loss — leaves a served document nobody signed for, which
   `docs/runbook.md:281-285` itself classifies as an incident. Kubernetes
   kills processes far more often than `systemctl stop` does, so this moves
   from theoretical to expected. The PG store already has the primitive
   (`append_audit_in(tx, ..)`, `pg_repo.rs:2038`, used by bootstrap); the
   trait does not expose a ledgered commit.
3. **Horizontal scaling is only valid on the PostgreSQL store, and nothing
   refuses the other case.** The in-memory store is process-local state
   (`memory.rs:306-354`); two replicas of it are two diverging hulls with two
   ledgers. Nothing in the binary or the (nonexistent) chart prevents
   `replicas: 2` without `DATABASE_URL`. The chart must make the memory
   store impossible above one replica, and the production image should not
   default to it.

4. **The PostgreSQL read path re-materialises every document on every
   request, and it is the only path that scales out.** Measured (§1.4): on
   the reference hull the map surface is 4× slower than the memory store
   (`deck-states` 214 ms vs 55 ms) because each read re-fetches and
   re-deserialises the register, couplings and schedule jsonb
   (`pg_repo.rs:593-609`, `:947-970`); at 32 concurrent readers one 4-core
   process serves **2.9 rps** with p50 10 s and never sheds (the 512 gate is
   never reached; `docs/stress-test.md:79-95` explains why). At 40k
   activities the jsonb is ~7× larger. Four teams polling a carrier
   schedule against this is a stalled screen, not a slow one. Not an
   architectural fault — the process is stateless and replicas help linearly,
   and a per-hull cache keyed on the row's `ingested_at` (A15) removes most
   of it — but it must land before any multi-team pilot, and the memory
   store's numbers must stop standing in for production's.

Nothing here is an architectural rewrite. The engine, the identity seam, the
store trait and the hardening layer are the right shapes for a container;
the gaps are a platform layer that has not been written and four
properties that a single-host, single-user deployment let stand.

### 1.4 Measurements (this pass, 4 vCPU / 15 GB dev box)

| What | Value |
|---|---|
| Boot to `/health` 200, memory store, reference hull (476 spaces, 5,706 activities) | 0.13 s |
| RSS idle after boot, memory store | 21 MB, 5 threads |
| `/health` latency, memory store, 20 samples | p50 0.7 ms, max 1.8 ms |
| SIGTERM with a register read in flight | request 200 in 0.30 s; exit 0 after 0.26 s |
| Release binary | 30.4 MB, glibc dynamic, debug line tables, not stripped |
| `shell-web/dist` | 11 MB (with source maps) |
| Boot to `/health` 200, PostgreSQL store (`5af958b-dirty`, schema 0019), RSS | 0.013 s, 7 MB |
| PG sequential p50, reference hull on a scratch org (schedule jsonb 591 KB on disk): `activities` / `issues` / `deck-states` / `readiness` / `work-conflicts` / `schedule-alternatives` / `ledger` | 520 / 686 / 214 / 203 / 292 / 301 / 3 ms |
| Memory store, same hull, same endpoints (baseline) | 302 / 314 / 55 / 50 / 216 / 208 ms |
| Burst, 32 workers × 8 requests alternating `activities`/`issues`, PG | 87 s wall, **2.9 rps**, 256 × 200, 0 × 503, p50 10.2 s, p95 14.5 s, max 16.4 s; RSS 182 → 412 MB; all 8 pool connections busy |
| Same burst, memory store | 28 s wall, 9.0 rps, p50 3.1 s, p95 6.5 s, max 8.9 s; RSS 160 MB |

The scratch org/hull used for the PG run (`…0c0001` / `…0c0073`, hull
`CVN-73C`) is left in the dev database; it is invisible to every other
tenant under RLS and shows up only in `wadl verify-ledger`.

## 2. Prioritised actions

Effort is agent-hours including tests and docs. Blocking class: **ATO**
(accreditation-blocking), **crash/perf** (falls over under real load or
loses data), **UX/polish**.

| id | action | class | effort | depends on |
|---|---|---|---|---|
| A1 | Correct `docs/ato-package.md` §2.3 and the PPSM row: the binary does no database TLS; state the two accepted topologies (same-host loopback, or mesh/stunnel mTLS) and the `postgres-tls` feature for the third | ATO | 1 | — |
| A2 | `postgres-tls` cargo feature (sqlx `tls-rustls-aws-lc-rs`, default off, admitted per Pillar 1 §3) + `WADL_DB_SSLMODE` boot check that refuses `disable` unless `WADL_DB_PLAINTEXT_OK=yes` | ATO | 6 | A1, customer Q1 |
| A3 | Ledgered commit in one transaction: `Repositories::commit_document_ledgered` (and the run commit) implemented with `append_audit_in(tx)` on PG and under the existing locks on memory; doors call it | crash/perf | 10 | — |
| A4 | Split probes: `/health/live` (no I/O, 200 while the process runs), `/health` stays readiness; add a `draining` flag set on SIGTERM that turns `/health` 503 for `WADL_DRAIN_SECS` before the listener closes | crash/perf | 4 | — |
| A5 | Secrets from files: `WADL_PROXY_KEY_FILE`, `WADL_DB_PASSWORD_FILE` (or `DATABASE_URL_FILE`), and `$CREDENTIALS_DIRECTORY/<name>` — one `read_secret(name)` helper; fix the unit-file hint | ATO | 3 | — |
| A6 | Pool contract: `WADL_DB_POOL_MAX` (default 8), `WADL_DB_ACQUIRE_TIMEOUT_SECS` (default 5), `SET LOCAL statement_timeout` = request timeout inside `with_tenant`; boot refuses a pool larger than the gate | crash/perf | 3 | — |
| A7 | Import semaphore: `WADL_MAX_IMPORTS_IN_FLIGHT` (default 2) taken in `read_import_body` after the scope check; 503 with a sentence | crash/perf | 3 | — |
| A8 | Multi-stage `Dockerfile` + `.dockerignore`; image runs as uid 65532, no shell, no secrets, `WADL_STATIC_DIR` baked, `reference/` optional layer | ATO | 5 | — |
| A9 | `serve --probe [url]` subcommand (std `TcpStream`, ~40 lines) so a distroless image has a `HEALTHCHECK` and compose has a health gate | UX/polish | 2 | A4 |
| A10 | `docker-compose.yml` for local dev: postgres 16, `migrate` one-shot, `api`, an nginx "terminator" that sets the six headers from a secret file | UX/polish | 4 | A8, A9 |
| A11 | `deploy/k8s/` raw manifests and `deploy/helm/wadl/` chart outline: Deployment, Service, PDB, HPA, NetworkPolicy, migration Job (pre-upgrade hook), Secret contract, values for the three topologies; chart refuses `replicaCount>1` without a database | ATO | 10 | A4, A5, A8 |
| A12 | CI `container` job: build image, `grype`/`trivy` scan gate, cosign sign (key-based, air-gap friendly), push on tag; SBOM attached to the image | ATO | 4 | A8 |
| A13 | Audit line gains `instance` (from `WADL_INSTANCE`, default `HOSTNAME`) and a per-request `req` id echoed as a response header; `support-bundle` reads a log file/stdin when `journalctl` is absent | ATO | 4 | — |
| A14 | POA&M and posture: rewrite POAM-4 for the container log pipeline (fluentbit → ECK or the enclave's SIEM), add POAM-8 (plaintext DB hop) and POAM-9 (two-transaction commit) until A2/A3 land; Pillar 6 gains the container shape; `deploy/README.md` gains a topology section | ATO | 3 | A1 |
| A15 | Per-hull document cache inside `PgStore`: `RwLock<HashMap<(VesselId, kind), (ingested_at, Arc<Parsed>)>>`, validated per request by one `SELECT ingested_at` (cheap) and refilled on mismatch — correct across replicas because the row's own timestamp is the version; drop the duplicate `pg_get_vessel` round trip where the following query already fails closed under RLS; re-run §1.4 and `scripts/stress-test.sh` with `DATABASE_URL` and record it in `docs/stress-test.md` | crash/perf | 8 | — |
| A16 | Static musl target (`x86_64-unknown-linux-musl` in `rust-toolchain.toml`) so the image is `distroless/static`-class; keep glibc as the documented fallback | UX/polish | 3 | A8 |
| A17 | `scripts/self-assessment.sh` WADL-SA-12: `/health/live` answers without a store; WADL-SA-13: `/health` is not reachable through the terminator unauthenticated | ATO | 2 | A4, A11 |
| A18 | Write the database-role contract for managed PostgreSQL: `CREATEROLE` for the migration Job's role, login role `IN ROLE wadl_app`, `wadl migrate` never runs as the app role | ATO | 1 | — |

Order: A1, A3, A15, A4, A5, A6, A7 first (code, no platform dependency —
A15 before any multi-user measurement is quoted); A8–A12 next (the
platform layer); A13–A18 alongside. Until A15 lands, size the pod at 1
replica per ~8 concurrent readers per hull and `WADL_MAX_IN_FLIGHT` at
8–16 so the 30 s timeout is not the first thing a user meets.

## 3. Concrete changes

Each row is specific enough to implement without asking. Paths are relative
to the repository root.

| file | change | why |
|---|---|---|
| `Dockerfile` (new) | Three stages. `shell`: `node:22-bookworm-slim`, `COPY shell-web/package*.json`, `npm ci --no-audit --no-fund`, `COPY shell-web`, `npx tsc -b && npx vite build`. `build`: `rust:1.94.1-bookworm` (or the Iron Bank rust image), `COPY Cargo.toml Cargo.lock rust-toolchain.toml crates xtask migrations`, `ARG WADL_GIT`, `ENV WADL_GIT`, `cargo build --locked --release -p wadl-api -p wadl-cli --bin serve --bin wadl --features wadl-api/postgres`; optional `ARG VENDOR=0` that copies a `vendor/` dir and `.cargo/config.toml` and builds `--offline` (the CI `air-gap` job made into the image path). `runtime`: `gcr.io/distroless/cc-debian12:nonroot` (Iron Bank: `registry1.dso.mil/ironbank/google/distroless/cc` or `ironbank/redhat/ubi/ubi9-micro`), `COPY --from=build /work/target/release/serve /app/serve`, `.../wadl /app/wadl`, `COPY --from=shell /work/shell-web/dist /app/dist`, `COPY reference /app/reference` (demo layer; omit in the production build via a `--target` split or a separate `Dockerfile.demo`), `USER 65532:65532`, `ENV WADL_STATIC_DIR=/app/dist WADL_PORT=8080`, **no** `WADL_BIND` default (loopback stays the default; the manifest sets it), `EXPOSE 8080`, `ENTRYPOINT ["/app/serve"]`, `HEALTHCHECK CMD ["/app/serve","--probe"]` once A9 exists. No `apt`, no shell, no `curl` in the final stage. | One artifact per Pillar 6, now an OCI image; non-root by uid, not by name; nothing secret in any layer. |
| `.dockerignore` (new) | `target`, `shell-web/node_modules`, `shell-web/dist`, `.git`, `docs`, `handoff`, `tools`, `*.dump`, `.env`, `*.local`. | Build context does not carry a stale dist or a local dump into the image. |
| `docker-compose.yml` (new) | Services: `db` (`postgres:16`, `POSTGRES_PASSWORD_FILE=/run/secrets/db_password`, `healthcheck: pg_isready`, volume); `migrate` (the same image, `command: ["/app/wadl","migrate"]` then `bootstrap-hull --statement /app/reference/cvn73/CVN73-hull.json` then `load-docs --dir /app/reference/cvn73 --xer ...`, `depends_on: db: condition: service_healthy`, `restart: "no"`); `api` (`depends_on: migrate: condition: service_completed_successfully`, `environment: WADL_BIND=0.0.0.0, WADL_PROXY_KEY_FILE=/run/secrets/proxy_key, WADL_DB_PASSWORD_FILE=/run/secrets/db_password, DATABASE_URL=postgres://wadl_login@db:5432/wadl`, `read_only: true`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, `mem_limit: 2g`, `healthcheck: ["/app/serve","--probe"]`); `edge` (`nginx:1.27-alpine`, dev-only stand-in for the terminator: strips and sets the six headers from `/run/secrets/proxy_key` via `proxy_set_header`, listens 8443 self-signed). `secrets:` from files under `deploy/compose/secrets/` (gitignored, `.example` files committed). | Local dev exercises the same image, the same proxy contract and the same secret-by-file path production uses; the `migrate` one-shot is the same order as the runbook §5. |
| `deploy/k8s/deployment.yaml` (new) | `replicas: 2`; `strategy.rollingUpdate.maxUnavailable: 0`; pod `securityContext: runAsNonRoot: true, runAsUser: 65532, fsGroup: 65532, seccompProfile: RuntimeDefault`; container `securityContext: readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities.drop: [ALL]`; `env`: `WADL_BIND=0.0.0.0` (or `127.0.0.1` under an Istio sidecar — documented switch), `WADL_PORT=8080`, `WADL_PROXY_KEY_FILE=/var/run/secrets/wadl/proxy-key`, `WADL_DB_PASSWORD_FILE=/var/run/secrets/wadl/db-password`, `DATABASE_URL` (no password) from a ConfigMap, `WADL_DEFAULT_ROLES`, `WADL_MARKINGS`, `WADL_MAX_IN_FLIGHT=64`, `WADL_DB_POOL_MAX=8`, `WADL_INSTANCE` from `metadata.name`; `volumeMounts`: the Secret at `/var/run/secrets/wadl` (`readOnly`), an `emptyDir` at `/tmp` (not needed today; harmless); `livenessProbe: httpGet /health/live, periodSeconds 10, failureThreshold 3`; `readinessProbe: httpGet /health, periodSeconds 5, failureThreshold 2`; `startupProbe: /health, failureThreshold 30`; `lifecycle.preStop.exec: ["/app/serve","--drain-wait"]` or `sleep`-free equivalent (A4 makes `/health` 503 on SIGTERM, so `preStop` is only needed without it); `terminationGracePeriodSeconds: 45` (request timeout 30 s + drain); `resources: requests {cpu: 1, memory: 1Gi}, limits {cpu: 2, memory: 2Gi}` (revisit after A15; the memory store needs 2Gi+ at 40k activities, `docs/stress-test.md:99-101`). | Every `deploy/wadl.service` directive has its equivalent here; probes are correct only once A4 splits them. |
| `deploy/k8s/service.yaml`, `pdb.yaml`, `hpa.yaml`, `networkpolicy.yaml` (new) | ClusterIP 8080; PDB `minAvailable: 1`; HPA on CPU 70 % between 2 and 6 (the PG pool math: replicas × `WADL_DB_POOL_MAX` + migration Job < `max_connections`); NetworkPolicy: ingress only from the ingress gateway/terminator namespace on 8080, egress only to the database selector on 5432 plus DNS. | Scaling is bounded by the pool contract, not guessed; no path to the pod except through the identity hop. |
| `deploy/k8s/migrate-job.yaml` (new) | A Job running `/app/wadl migrate` with the **owner** credentials (a separate Secret), `restartPolicy: Never`, `backoffLimit: 1`; in Helm, `helm.sh/hook: pre-upgrade,pre-install`, `hook-weight: -5`. Bootstrap and load-docs are a documented `kubectl exec`/one-off Job on data-load day, never automatic. | `docs/runbook.md:221-242` step order, encoded; the app never holds owner credentials. |
| `deploy/helm/wadl/` (outline) | `values.yaml` keys: `image.{repository,tag,digest}`, `replicaCount`, `store: postgres|memory` (template fails with a message when `memory` and `replicaCount>1`, or when `store=postgres` and no `database.secretName`), `database.{host,port,name,user,secretName,sslmode}`, `identity.{proxyKeySecretName,defaultRoles,markings}`, `limits.{maxInFlight,requestTimeoutSecs,maxImportsInFlight,dbPoolMax}`, `bind: 0.0.0.0|127.0.0.1`, `istio.enabled`, `topology: onprem|govcloud|airgap` (selects image registry prefix, log annotations, whether `database.sslmode=require` is mandatory). Big Bang packaging: the chart is consumable as a Big Bang "package" via a `bigbang` values overlay (Istio `VirtualService`, `AuthorizationPolicy` from the gateway principal only, `PeerAuthentication STRICT`, Kyverno-compliant securityContext, fluentbit annotations). | One chart, three topologies, and the invalid combinations refuse at template time. |
| `crates/wadl-api/src/bin/serve.rs` | (a) `/health/live` route added in `lib.rs` (`get(handlers::live)` returning `200 {"status":"alive"}` with no store call; add to `routes::inventory`, regenerate leak tests and SSP). (b) A `static DRAINING: AtomicBool`; `shutdown_signal()` sets it, then sleeps `WADL_DRAIN_SECS` (default 5, 0 to disable) before resolving; `handlers::health` answers 503 `{"status":"draining"}` while it is set. (c) `--probe [url]` and `--version` argument handling: `--probe` opens a `TcpStream` to `127.0.0.1:$WADL_PORT`, writes `GET /health/live HTTP/1.0`, exits 0 on `200`. (d) `WADL_DB_PLAINTEXT_OK` / sslmode check at `build_store` (with A2). (e) Print `instance` in the banner. | Liveness must not depend on the database; the endpoint must be withdrawn from rotation before the socket closes; a distroless image has no curl. |
| `crates/wadl-api/src/auth.rs` | `Env::from_process` reads the key through `read_secret("WADL_PROXY_KEY")`: value of `WADL_PROXY_KEY`, else contents of `$WADL_PROXY_KEY_FILE` (trimmed, refused if empty or world-readable), else `$CREDENTIALS_DIRECTORY/wadl-proxy-key`. Same helper for `WADL_DB_PASSWORD_FILE` in `serve.rs`, merged into `PgConnectOptions::password()`. | Kubernetes and systemd both deliver secrets as files; the unit file already promises this and the binary does not deliver it. |
| `crates/wadl-store/src/pg.rs` | `connect_with` takes `PoolConfig { max, acquire_timeout, statement_timeout }` from env (defaults 8 / 5 s / 30 s); `with_tenant` adds `SET LOCAL statement_timeout = $ms` (bound, not interpolated: `SELECT set_config('statement_timeout', $1, true)`); expose `pool_size` on `StoreHealth` so `/health` reports `pool: {size, idle}`. | A pool starve must shed in seconds, not stall for 30; an abandoned request must not keep a connection busy. |
| `crates/wadl-store/src/repo.rs`, `pg_repo.rs`, `memory.rs` | New trait method `commit_document_ledgered(scope, vessel, DocumentCommit { kind, label, doc, run: Option<ScheduleRun> }, ledger: LedgerLine) -> (DocumentReceipt, AuditRecord)`; PG: one `with_tenant` transaction — advisory lock, upsert/run insert, `append_audit_in`, commit; memory: document write and `audit` push under one critical section. `documents.rs`, `schedule_door.rs`, `yard_clock.rs`, `rule_table.rs` call it; the hazard raise/clear and decision routes get the same treatment (`clear_hazard` + its ledger row). A `pg_rls.rs` test kills the transaction between the two statements and asserts neither landed. | A commit that exists without its ledger row is the runbook's own incident definition; pods die mid-request. |
| `crates/wadl-api/src/handlers.rs` (`read_import_body`) | Acquire `IMPORTS: Semaphore(WADL_MAX_IMPORTS_IN_FLIGHT)` with `try_acquire` after the scope check and before `to_bytes`; on failure 503 `problem+json` "another import is in progress — retry shortly". Hold the permit through the handler (return it with the body). | 256 MB × N concurrent imports is the one OOM shape the global gate cannot prevent. |
| `crates/wadl-api/src/hardening.rs` (`audited`) | Add `"instance"` (read once from `WADL_INSTANCE` or `HOSTNAME`) and `"req"` (a v7 uuid minted per request, also set as `x-wadl-request` on the response) to the JSON line. | Multi-replica logs must be attributable per pod and joinable to a backend_error line. |
| `crates/wadl-cli/src/bundle.rs` | `--journal-file <path>` or stdin as an alternative source when `journalctl` is absent; the note already exists (`:241-244`). | The support bundle must work from a log-pipeline export in a container. |
| `.github/workflows/ci.yml` | New job `container`: `docker build --build-arg WADL_GIT=${GITHUB_SHA::12}`, `anchore/scan-action` (or trivy) with `fail-build: true` on high/critical, `cosign sign --key` from a secret on tags only, push to GHCR on tags; run `scripts/self-assessment.sh` against the **image** (`docker run -e WADL_ALLOW_DEV_SHIM_OFF_LOOPBACK=yes -p 8080:8080`) rather than only the debug binary. | The artifact that ships must be the artifact that is assessed. |
| `scripts/self-assessment.sh` | WADL-SA-12: `GET /health/live` is 200 with no `store` field; WADL-SA-13: through `BASE` (the terminator) `GET /health` without a session is 401/403, not 200. | The probe split and the disclosure boundary become assessable. |
| `docs/ato-package.md` §2.2, §2.3 | Replace "the connection string decides `sslmode`" with the topology rule; PPSM table gains the container flows (kubelet → pod 8080 probes; gateway → pod 8080; pod → database 5432 **mTLS via mesh or `postgres-tls`**; fluentbit ← stdout). Draw the boundary with the pod, the sidecar and the database as separate boxes. | The current sentence is false for the shipped binary. |
| `docs/production-posture.md` Pillar 6, `docs/poam.md` | Pillar 6: the OCI image is the artifact, the unit file and the chart are two deployment shapes of one image; POAM-4 rewritten for the log pipeline; POAM-8 (plaintext DB hop until A2 or a mesh) and POAM-9 (two-transaction commit until A3). | The register must carry the container gaps while they are open. |
| `deploy/README.md` | New section "Topologies" (below) and "Kubernetes" pointing at `deploy/k8s/` and the chart; the `LoadCredentialEncrypted` hint made true (`WADL_PROXY_KEY_FILE=%d/wadl-proxy-key` under `LoadCredential`). | Operators read this page, not the code. |
| `rust-toolchain.toml` (optional, A16) | `targets = ["wasm32-unknown-unknown", "x86_64-unknown-linux-musl"]`; Dockerfile `build` stage uses `--target x86_64-unknown-linux-musl`; final stage `distroless/static:nonroot`. | Removes the glibc question and the `cc` base-image dependency in Iron Bank. |

### Config contract (the full environment the image honours)

Existing, unchanged: `WADL_PORT`, `WADL_BIND`, `WADL_STATIC_DIR`,
`WADL_DEMO_DOCS`, `WADL_SCHEDULE_XER`, `WADL_MAX_IN_FLIGHT`,
`WADL_REQUEST_TIMEOUT_SECS`, `WADL_PROXY_KEY`, `WADL_DEFAULT_ROLES`,
`WADL_MARKINGS`, `WADL_ALLOW_DEV_SHIM_OFF_LOOPBACK`, `DATABASE_URL`, `WADL_GIT`
(build time). New: `WADL_PROXY_KEY_FILE`, `WADL_DB_PASSWORD_FILE`,
`WADL_DB_POOL_MAX`, `WADL_DB_ACQUIRE_TIMEOUT_SECS`, `WADL_DB_SSLMODE`
(`require` default under `postgres-tls`), `WADL_DB_PLAINTEXT_OK`,
`WADL_MAX_IMPORTS_IN_FLIGHT`, `WADL_DRAIN_SECS`, `WADL_INSTANCE`. Rule kept
from `serve.rs`: a value that fails to parse falls back to the default and
is printed in the banner; a value that would widen trust (`_OK`, the
off-loopback override) is honoured only when exactly `yes`. All of it goes
into `xtask gen-ssp` so the SSP lists every variable.

### Topologies and what changes by topology

| | On-prem yard host (today) | GovCloud IL5 (Platform One / Big Bang on EKS/AKS) | Air-gapped on-prem Kubernetes (Big Bang on RKE2, or OpenShift) |
|---|---|---|---|
| Artifact | binary + dist, `wadl.service` | OCI image from Iron Bank bases, signed, in Registry1 or the P1 Harbor | same image via the enclave's mirror; key-based cosign, vendored build (`ci.yml air-gap`) is the actual build path |
| Identity hop | nginx/HAProxy on the host, six headers | Istio ingress gateway + Keycloak/authservice (CAC); a small in-namespace nginx or EnvoyFilter maps the JWT to the six headers and holds the key | same, with the enclave's Keycloak; no OCSP reachability — CRL distribution is a design item |
| DB hop | loopback, plaintext acceptable | mesh `PeerAuthentication STRICT` if the database is in-mesh; otherwise `postgres-tls` **required** (RDS/CloudNativePG both offer TLS) | in-mesh mTLS, or `postgres-tls` to the yard's PostgreSQL |
| Secrets | `LoadCredential` files | Kubernetes Secrets with envelope encryption (KMS) or ExternalSecrets from Vault; files in the pod | same, Vault or sealed-secrets; never `env:` for the key |
| Audit AU-9 | journald `Seal=yes`, forwarding | fluentbit → ECK/SIEM in the Big Bang baseline; retention is the platform's | fluentbit → the enclave's SIEM; the bundle reads an export file |
| Probes/scale | none; `Restart=on-failure` | liveness/readiness split, HPA 2–6, PDB | same; usually fixed replicas |
| NNPI specifics | host in a NNPI-approved enclave; same as today | U-NNPI in a commercial cloud region needs the NNPI authority's approval on top of IL5 (customer Q1); mesh crypto must be the FIPS build of Istio | the default assumption for NNPI; no keyless signing, no public OCSP |

## 4. Tensions and proposed resolutions

No earlier council document exists. The tensions below are with the standing
documents, and with the personas expected after this one (identity/security,
data and ledger, UX), stated so they are not picked silently.

1. **Pillar 1 minimalism vs. the database TLS gap** (`docs/production-posture.md:39-60`
   vs §1.3.1). Adding rustls is ~20 crates and a FIPS question (IL5 wants a
   validated module; `aws-lc-rs` has one, `ring` does not). Resolution: keep
   TLS out of the *default* binary; make the mesh (Istio STRICT mTLS, FIPS
   build) or same-host loopback the accepted shapes and say so in the ATO
   package; add `postgres-tls` as a default-off feature for the topology
   that has neither, admitted under Pillar 1 §3. What is not acceptable is
   the current sentence that the DBA decides.
2. **"One artifact, one unit file" vs. a chart with twenty objects**
   (`deploy/README.md:1-3`, Pillar 6). Resolution: the image is the one
   artifact; the unit file and the chart are two *deployment shapes* of it,
   and the self-assessment runs against the image in CI so neither shape is
   the un-assessed one.
3. **Journald as the AU-9 story vs. containers** (POAM-4). Resolution: POAM-4
   is rewritten per topology; the ledger remains the tamper-evident record
   for decisions, the transport audit's integrity moves to the platform's
   pipeline. The identity/security persona should confirm the SIEM contract.
4. **The data persona will want the two-transaction commit fixed at the
   trait, not at the door.** Agreed; A3 is written that way. If that persona
   prefers an outbox row instead, the container argument is indifferent —
   either makes the commit and its row one unit.
5. **UX persona: a 503 "another import in progress" (A7) is new visible
   behaviour.** Resolution: the door's dry run is never gated by the import
   semaphore (it is the commit that buffers and writes); the shell already
   renders refusal sentences inline.
6. **Identity persona: the shared proxy key inside a mesh.** An Istio
   `AuthorizationPolicy` restricting the pod to the gateway principal makes
   the key redundant in principle. Resolution: keep the key as the contract
   (it is what the binary can verify without a TLS stack); the mesh policy
   is defence in depth, not a replacement, until the extractor learns a
   second trust anchor.

## 5. Questions only the customer can answer

1. Which topology is the target for the first ATO — the yard's own enclave
   host (systemd), a GovCloud IL5 tenancy under Platform One, or an
   air-gapped Kubernetes — and, for NNPI, has the NNPI authority stated
   whether commercial cloud at IL5 is admissible at all for this data?
2. Is there a Platform One / Big Bang landing zone with Istio and Keycloak
   already accredited that this system inherits, or does the yard operate
   its own Kubernetes with its own CAC terminator?
3. Is the PostgreSQL managed (CloudNativePG/Crunchy/RDS) or the yard's DBA's?
   Who holds the owner credentials the migration Job needs, and does that
   role have `CREATEROLE`?
4. Where must audit lines land for AU-9 (SIEM name, retention, transport)
   and what is the enclave's clock source (`ProtectClock`, NTP inside the
   pod is not a thing; the ledger hashes instants)?
5. Which image base is acceptable: Iron Bank only, or any distroless with
   the enclave's own scan?
6. Expected concurrent users per hull and number of hulls per deployment,
   so the HPA bounds and `WADL_DB_POOL_MAX` × replicas are sized against
   `max_connections` rather than guessed.
