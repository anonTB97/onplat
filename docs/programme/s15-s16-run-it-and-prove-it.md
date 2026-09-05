# S15 + S16 — Run it in production, and prove the production path in CI

Date 2026-09-05 · head `df18c59` · branch `claude/kickoff-from-docs-arhiib`.
One packet for two slices, built in one sequence: closes pilot barrier **B13** (run it in production) and the remainder of **B10** (prove the PostgreSQL path) from `docs/pilot-readiness-review.md` §4. Wave 2, after S11; no migration (`programme.md` reserves none for S15/S16 and none is needed). The contract decisions in `programme.md` this packet is bound to: `/health` gains `version { git, built_at, schema }`; the PostgreSQL CI job loads the reference hull **through the doors** via a `wadl load-docs` CLI door and asserts `/health`.

## Summary

Today the production path is described but not operated: nothing backs a database up or restores it, a migration has no rollback stance in writing, the binary cannot say which commit or schema it is, `wadl support-bundle` writes a file list, and the pilot hull's own rows (organisation, class, hull, availability) have to be typed by a DBA because no door and no command creates them (`docs/pilot-playbook.md` §1). The API suite — fifteen files — runs on the in-memory store only, and the reference hull can reach PostgreSQL only through a browser. Demo mode binds any address a unit file names, and only a banner says "loopback only".

This packet makes the production path something an operator **runs and a CI job proves**. The binary carries a **release stamp** (commit, commit instant, migration set) baked by a dependency-free `build.rs`, served on `/health` beside the database's own migration state, and shown once in the shell's bottom band. Two new CLI doors — **`wadl bootstrap-hull`** (the hull-row statement the playbook already files, applied as the owner and ledgered on the hull it creates) and **`wadl load-docs`** (the reference hull's documents and export through the same parsers and store calls the doors use, with a dry run, each commit ledgered) — remove the last hand SQL from data-load day. **Backup and restore scripts** with a **drill** — bootstrap → load → back up → drop → restore → ledger verifies → the register answers 476 spaces — run in CI on every push and on the yard's staging host by the same script. `wadl verify-ledger` reads a live database; `wadl support-bundle` collects health, version, migration state, ledger verdicts and redacted audit lines, and never a secret. Demo mode **refuses to bind off loopback** unless an explicit variable says otherwise. A **test-support module** builds the API app over memory or PostgreSQL from `DATABASE_URL`, each PostgreSQL test on its own freshly bootstrapped hull, and the suites that boot the reference hull run on both stores in a new CI job that also runs the drill and asserts the version. `docs/runbook.md` is written from what the scripts and commands actually do, with the migration rollback policy in it.

Zero new runtime dependencies. `wadl-cli` gains a path dependency on `wadl-api` (the parsers and door functions are there); `build.rs` shells out to `git` and reads `migrations/` with `std` only.

## What already exists

- `/health` (`handlers.rs:106-128`) serves `status`, `decision_support_only`, `store` (`StoreHealth { backend, reachable, schema_version, document_schema_version, detail }` — PostgreSQL reads `max(version) FROM _sqlx_migrations`, memory reads `None`), `now`. No build identity anywhere; `Cargo.toml` `version = "0.1.0"`. The `reproducible` CI job requires two clean release builds to hash equal, so anything baked in must be a function of the commit.
- `serve.rs`: `WADL_BIND` defaults to loopback; the dev shim is the default identity mode; nothing compares the two. `build_store` ignores `WADL_SCHEDULE_XER` on PostgreSQL by design ("import via the API"). `auth::proxy_key_is_empty()` refuses boot on an empty key — the pattern to copy.
- `wadl` CLI (`crates/wadl-cli/src/main.rs`, 231 lines): `migrate`, `seed` (applies `pg_seed.sql` as the owner — the demo world a yard must not install, `docs/ato-package.md` §6), `verify-ledger --input <json>` (file only), `ingest-xer`, `support-bundle` (migration file list, no database, no health). `PgStore::connect / migrate / with_tenant / pool()`; `MIGRATOR` embeds `migrations/`.
- The boot loader `documents::load_demo_docs(store, scope, vessel, dir, now_ms)` loads `-clock/-register/-zones/-geometry/-couplings/-hazards.csv` through the parsers and `set_*` store calls, in door order, refusing whole on the first bad file — and **writes no ledger row** (no `append_audit` in `documents.rs`). `schedule::load_xer` is memory-only (`load_schedule_of_record`, unscoped). `handlers::ledger_document` (`pub(crate)`, S10) writes `{kind, label, counts, by_org, at_ms}` under `DOCUMENT_REPLACED`.
- Tenancy rows: `organization` (0001), `ship_class`, `vessel` (0002), `availability` (0005), all RLS-policied, written only by `pg_seed.sql`; `ingest_run` carries the seed's provenance row. `wadl_app` is created `IF NOT EXISTS` by 0001; policies and grants are table DDL (they travel in a `pg_dump`), the role is cluster-level (it does not).
- Tests: every API suite builds `InMemoryStore::demo_at(DEMO_ANCHOR_MS)` + `TestClock` + `AppState::new` + `build_router` and calls with `x-org-id`/`x-assigned-vessels` headers; `demo_docs.rs`, `yard_clock.rs`, `zone_focus.rs`, `activities.rs` boot the reference hull through `load_demo_docs`; the rest assert on the 24-space seed (`3-160-2-Q`, `WI-2201`, seeded hazards). `pg_rls.rs` skips unless `DATABASE_URL` is set and drives hazards, clearances, documents and the ledger on live PostgreSQL. `DEMO_ANCHOR_MS` = 2026-05-13 05:15Z; the PostgreSQL seed anchors its windows on 2026-08-10 and its hazards on `now()` — the two seed worlds are not the same world (B10's own finding).
- CI (`.github/workflows/ci.yml`): `migrations` job with a `postgres:16` service — migrate, seed, `pg_rls`, serve `--features postgres` and grep one stranded-hours answer. `self-assessment` boots the dev binary on loopback. `ubuntu-latest` carries `pg_dump`/`psql` 16 and `jq`. `Swatinem/rust-cache` everywhere.
- Shell: `ClassificationBanner({ edge })` (`Chrome.tsx:48`) is the fixed 18 px marking band top and bottom; `App.tsx:691` renders the bottom one; `api.ts` has `whoami()` and no `/health` call. S10 owns the time strip; the bottom band is untouched by any packet.
- Docs: `deploy/README.md` (build, unit, proxy, self-assessment, journal, stop; "prepare the database once: `wadl migrate && wadl seed`"), `deploy/wadl.service`, `docs/ato-package.md` §2.6 (CM plan: rollback stance, tagging missing), §2.7 (contingency: missing), §2.8 (IR: missing), §5 (assembly by hand until an evidence bundle exists).

## Scope

1. **Release stamp** — `crates/wadl-api/build.rs` + `src/version.rs`; `/health` gains `version` and `schema_state`; the binary refuses to serve a database behind its migration set; `wadl version`.
2. **Dev shim stays on loopback** — a pure gate in `auth.rs`, called by `serve.rs`, with one override variable.
3. **`wadl bootstrap-hull --statement <json>`** — the hull-row statement as a document; owner-mode insert, idempotent, dry run, ledgered on the hull.
4. **`wadl load-docs --dir <dir> [--xer <file>] [--dry-run]`** — the boot loader made scoped, ledgered and callable; the same function boots the demo.
5. **Backup, restore, drill** — `scripts/backup.sh`, `scripts/restore.sh`, `scripts/restore-drill.sh`; `wadl verify-ledger --database-url`.
6. **`wadl support-bundle`** made real.
7. **`docs/runbook.md`** with the migration rollback policy; `deploy/README.md` and `docs/ato-package.md` rows updated to point at it.
8. **Test support** — `crates/wadl-api/tests/support/mod.rs`; the reference-hull suites store-generic; a `production_path.rs` suite pinning the pilot behaviours.
9. **CI job `production-path`** — migrate → bootstrap → load-docs → suite on PostgreSQL → drill → serve → `/health` asserted → support bundle uploaded as the evidence artifact.
10. **Shell footer** — the stamp in the bottom band; `api.ts::health()`.

## Out of scope

- Generating `pg_seed.sql` from the in-memory world so the seed-dependent suites (`clear_loop`, `as_of`, `clear_history`, `mitigations`, `proposals`, `raise_loop`, `budgets`, `geometry`, `ship_doors`) run on PostgreSQL: the two seeds anchor time differently and the fix is a store slice of its own; `pg_rls` covers those store paths on PostgreSQL today. One line in `docs/poam.md`.
- Request ids correlating audit line, problem body and ledger row (B7's item, named in `ato-package.md` §2.8): hardening-layer work, not ops; after the pilot.
- A signed release (cosign / enclave PKI, POAM-5): key custody is the yard's.
- A tagged release in git: the runbook says how to tag; the tag itself is a human act at the yard's first install.
- An admin HTTP door for hull bootstrap: the header contract carries no admin identity, and a tenant-creating route reachable from the proxy is a larger threat surface than an owner-session command; the ledger row is kept, the route is not built.
- Down-migrations: rejected in writing (Contracts › Migration rollback policy).
- Retention of ingest runs and audit rows: noted in the runbook as sizes, not enforced.

## Contracts

### Release stamp (`crates/wadl-api/build.rs`, `crates/wadl-api/src/version.rs`)

`build.rs` (std only; `cargo:rerun-if-changed` on `../../migrations`, `../../.git/HEAD`, `../../.git/refs`, and `cargo:rerun-if-env-changed` on the two overrides) emits three compile-time variables:

| Variable | Value | Fallback |
|---|---|---|
| `WADL_GIT` | `$WADL_GIT` if set (CI stamps `${GITHUB_SHA::12}`; a vendored tarball has no `.git`), else `git describe --always --dirty --tags` (`df18c59`, `df18c59-dirty`, or `v0.1.0-3-gdf18c59` once a tag exists) | `unknown` |
| `WADL_BUILT_AT` | `$WADL_BUILT_AT` if set, else `git log -1 --date=iso-strict --format=%cd` — **the commit's instant**, so two clean builds of one commit hash equal (the `reproducible` job stays true; `build.rs` never reads the wall clock, which `clippy.toml` forbids anyway) | `unknown` |
| `WADL_SCHEMA` | the highest `NNNN` among `migrations/*.sql` (`0016` at this head) — the migration set this binary was built against | `0000` |

```rust
pub struct Version { pub git: &'static str, pub built_at: &'static str, pub schema: &'static str, pub document_schema: u32 }
pub fn current() -> Version   // env!() of the three, plus wadl_store::DOCUMENT_SCHEMA_VERSION
pub fn schema_state(build: &str, database: Option<&str>) -> &'static str
// "not_applicable" (memory) | "current" | "database_behind" | "database_ahead"; numeric compare, zero-padded strings
```

`/health` (unchanged status semantics: 200 reachable, 503 not):

```json
{ "status": "ok", "decision_support_only": true,
  "version": { "git": "df18c59", "built_at": "2026-09-04T21:23:37+00:00", "schema": "0016", "document_schema": 1 },
  "schema_state": "current",
  "store": { "backend": "postgresql", "reachable": true, "schema_version": "16", "document_schema_version": 1, "detail": null },
  "now": … }
```

`schema_state` is `version.schema` against `store.schema_version`. **Boot rule** in `serve.rs::build_store` (PostgreSQL only): `database_behind` → refuse to start, stderr `database is at 0015, this binary needs 0016 — run: wadl migrate`; `database_ahead` → start, banner line `WARNING: database is at 0017, this binary was built for 0016 — a newer release wrote this database` and `/health` says so. Banner gains `  release:             df18c59 · built 2026-09-04T21:23:37Z · schema 0016`. `wadl version` prints the CLI's own stamp (same module; the CLI is built from the same tree).

### Dev shim on loopback (`auth.rs`, `serve.rs`)

```rust
pub fn dev_shim_may_bind(bind: IpAddr, override_set: bool) -> Result<(), String>
```

Pure: `Ok` when `bind.is_loopback()`, or the override is set; otherwise `Err("the dev header shim trusts identity headers as given and may bind loopback only; set WADL_PROXY_KEY for proxy-asserted identity, or WADL_ALLOW_DEV_SHIM_OFF_LOOPBACK=yes if this host is itself isolated")`. `serve.rs` calls it after parsing `WADL_BIND` and before binding, only when `WADL_PROXY_KEY` is unset; the message is printed and the process exits non-zero. New env `WADL_ALLOW_DEV_SHIM_OFF_LOOPBACK` (documented in `serve.rs`'s header; `xtask/src/ssp_template.md` §4 "Identity trust" row gains "dev shim refuses non-loopback binds unless `WADL_ALLOW_DEV_SHIM_OFF_LOOPBACK` is set"; `gen-ssp` regenerated). `scripts/dev.sh`, the unit file and CI all bind loopback already; WADL-SA-05's WARN text is unchanged.

### `wadl bootstrap-hull` (`crates/wadl-cli/src/bootstrap.rs`, `crates/wadl-store/src/pg_bootstrap.rs`, `model.rs`)

The statement is the document `docs/pilot-playbook.md` §1 already files; the template is `reference/cvn73/CVN73-hull.json` (the seed's own ids, so on the seeded CI database the command is a no-op that says so):

```json
{ "organization": { "org_id": "00000000-0000-0000-0000-000000000001", "kind": "shipbuilder", "name": "Demo Yard", "country": "USA" },
  "class": { "class_id": "00000000-0000-0000-0000-0000000c0068", "code": "CVN-68", "name": "Nimitz class", "hull_type": "CVN", "frame_min": 1, "frame_max": 260 },
  "vessel": { "vessel_id": "00000000-0000-0000-0000-000000000073", "hull_no": "CVN-73", "name": "USS George Washington" },
  "availability": { "availability_id": "00000000-0000-0000-0000-00000000a073", "code": "PIA-26", "kind": "PIA", "location": "Graving Dry Dock 4", "start_on": "2026-01-05", "end_on": "2026-09-30" } }
```

`wadl_store::model::HullStatement` (serde, `validate() -> Vec<String>`: every id present and a UUID, `kind` one of 0001's `org_kind`, `end_on` after `start_on`, codes non-blank). Ids are **required**, never generated: the data-load record, the proxy's `x-assigned-vessels` and this file must name the same hull. Decks are not in the statement — the register door supplies them.

`PgStore::bootstrap_hull(&HullStatement, dry_run) -> Result<BootstrapOutcome, StoreError>`: runs as the **connecting role outside any tenant scope**, like `seed_demo` and for the same reason (RLS forbids `wadl_app` from creating a tenant); one transaction; four `INSERT … ON CONFLICT (pk) DO NOTHING` in FK order; each row reported `created | existed | conflict` (a `UNIQUE (org_id, hull_no)` or `(org_id, code)` clash with a *different* id is `conflict` and rolls the transaction back — a second statement for the same hull number with a new id is a mistake, not an update); an `ingest_run` row `{ source_system: "bootstrap", source_file: <statement path>, notes: "hull-row statement applied by wadl bootstrap-hull" }`; then — inside the same transaction, through `append_audit`'s chain logic under `TenantScope::new(org, [vessel])` — the ledger row `HULL_BOOTSTRAPPED` with detail `{ "statement": <the four blocks>, "outcome": { organization: "existed", class: "existed", vessel: "created", availability: "created" }, "via": "cli", "by_org": org, "at_ms": now }`. Dry run prints the outcome table and writes nothing. Exit codes: 0 applied or already present; 2 refused (validation, conflict), reasons listed. CLI: `wadl bootstrap-hull --statement reference/cvn73/CVN73-hull.json [--dry-run] [--database-url …]`; without a database URL, `--dry-run` validates the file and prints the plan (the yard can check its statement without a host). `GET /api/vessels` under the new hull's headers is the read-back the playbook asks for; the playbook's "hand SQL" paragraph becomes "run `wadl bootstrap-hull` from the DBA's session".

### `wadl load-docs` (`crates/wadl-cli/src/load_docs.rs`, `crates/wadl-api/src/documents.rs`)

```
wadl load-docs --dir reference/cvn73 [--xer reference/p6-sample/CVN73-PIA26-full.xer]
               --org <uuid> --vessel <uuid> [--person <id>] [--dry-run] [--database-url …]
```

`documents.rs` gains the scoped, ledgered entry point the boot loader and the CLI share:

```rust
pub struct LoadVia<'a> { pub via: &'a str /* "boot" | "cli" */, pub dry_run: bool }
pub async fn load_docs(store: &dyn Repositories, scope: &TenantScope, vessel: VesselId, dir: &Path, now_ms: i64, via: LoadVia<'_>) -> Result<LoadedDocuments, String>
pub(crate) async fn ledger_document_on(store, scope, vessel, action, kind, label, counts, via, now_ms) -> Result<(), StoreError>
```

`load_demo_docs` becomes `load_docs(…, LoadVia { via: "boot", dry_run: false })` and keeps its signature. `handlers::ledger_document` delegates to `ledger_document_on` with `via: "door"`, so every `DOCUMENT_REPLACED` detail gains `"via"` (`serde(default)`-tolerant; nothing reads it yet). Each committed document writes `DOCUMENT_REPLACED` with `kind ∈ yard_clock | compartment_register | zone_register | geometry_register | coupling_register | hazard_log` (the hazards CSV writes `HAZARD_RAISED` per row today through the store — unchanged — plus one `DOCUMENT_REPLACED hazard_log` summary line), `label` = file name, `counts` = the `LoadedDocuments` tuple as an object. The **boot path now ledgers too**: the demo's ledger opens with six `DOCUMENT_REPLACED … via: boot` rows, which is the truth about where the served hull came from. **Dry run** parses and validates every file in order and stores nothing; because the couplings step derives vertical edges from the register's placards, the loader carries the parsed register's spaces when `dry_run` and the store has none.

The schedule (`--xer`): read as bytes, decoded by S13's `decode_xer`, parsed under the stored field map and S10's clock via S13's `ingest_xer_with`, committed with `commit_schedule_run(ImportedBy { org, person, via: "cli" })` and ledgered `SCHEDULE_REPLACED` exactly as the door does (S13's `schedule_door` exposes `commit_schedule(store, scope, vessel, label, bytes, ImportedBy, now_ms)` for this; if S13 has not landed when this builds, the fallback is `parse_xer_in` + `set_schedule_of_record` + `SCHEDULE_REPLACED { label, counts, delta: null, via: "cli" }`). Refusals (any file rejected, no activity survives) exit 2 with the file name in front and nothing committed **for that file**; files before it stay committed and are listed — the CLI is a sequence of doors, each all-or-nothing, like data-load day. Output is one line per document in the boot banner's format plus the ledger `seq` of its row. `--person` fills S12's actor (`unattributed` when absent). Without a database URL and with `--dry-run`, the files are validated against a memory store — the yard can check its CSVs on a laptop.

### Backup, restore, drill (`scripts/backup.sh`, `scripts/restore.sh`, `scripts/restore-drill.sh`)

All three: `set -euo pipefail`, `DATABASE_URL` from the environment (never echoed), `pg_dump`/`pg_restore`/`psql` from `PATH`, `WADL_BIN` (default `target/release/wadl`), exit non-zero on any failed step, every step printed as `→ step` / `✓ result` so the log is the drill record.

- **`backup.sh [outdir]`**: `wadl verify-ledger --database-url` first (a backup of a broken chain is still taken, but the manifest says `verified: false` and the exit code is 3); `pg_dump -Fc --no-owner --no-privileges` to `wadl-<schema>-<git>-<UTC yyyymmddThhmmssZ>.dump`; `sha256sum` sidecar `.dump.sha256`; `.manifest.json` `{ schema, git, taken_at, hulls: [{hull_no, ledger_rows}], ledger_verified, dump_sha256 }` (schema and git from `wadl version` and the database's `_sqlx_migrations`; no uuids, no URL). Custom format so a single hull's documents can be listed with `pg_restore -l` if ever needed.
- **`restore.sh <dump> [--replace] [--yes]`**: checks the sidecar; refuses if the target already holds any `vessel` row unless `--replace`; refuses without `--yes` (prints what it will do); `pg_restore --clean --if-exists --no-owner --no-privileges -d "$DATABASE_URL"`; `wadl migrate` (applies anything newer than the dump — the upgrade-after-restore path; a no-op otherwise); `wadl verify-ledger --database-url`; prints the hulls and ledger lengths from the manifest beside the restored counts. Prerequisite stated in the script header: the role `wadl_app` exists in the cluster (any prior `wadl migrate` in that cluster created it; otherwise `wadl migrate` on the empty target first, then restore with `--clean`).
- **`restore-drill.sh`**: the CI and staging rehearsal on a scratch database named `WADL_DRILL_DB` (default `wadl_drill`): `createdb` → `wadl migrate` → `wadl bootstrap-hull --statement reference/cvn73/CVN73-hull.json` → `wadl load-docs --dir reference/cvn73 --xer reference/p6-sample/CVN73-PIA26-full.xer --org … --vessel …` → `backup.sh` → `dropdb` + `createdb` → `restore.sh <dump> --yes` → `wadl verify-ledger --database-url` must say every hull verifies → boots `WADL_SERVE_BIN` (default `target/release/serve`) on a free loopback port against the restored database → `GET /health` must read `schema_state: current`, `version.git != unknown`, `version.schema == store.schema_version` → `GET /api/vessels/<hull>/compartments` must count **476** and `…/ledger` must read `verified: true` with the `HULL_BOOTSTRAPPED` row first and `SCHEDULE_REPLACED` last → kills the server → `dropdb`. Prints `drill: PASS in <s> s` or the failed step. The same script, with `DATABASE_URL` pointing at the yard's staging host, is the pre-data-load-day drill Y13 asks for.

### `wadl verify-ledger` (extended) and `wadl support-bundle` (real)

`wadl verify-ledger (--input <json> | --database-url <url>)`: database mode reads every hull's chain **as the connecting role outside RLS** (read-only; the operator's session, like `migrate`), runs `ledger::verify_chain` per hull, prints `CVN-73 · 14 entries verify` per hull or `BROKEN at seq 9: <reason>`, exit 0 all verify, 1 any break, 2 no database. `PgStore::audit_chains_all() -> Vec<(hull_no, Vec<LedgerEntry>)>` in `pg_bootstrap.rs` (the owner-mode module).

`wadl support-bundle --out <file> [--database-url …] [--base http://127.0.0.1:8080] [--journal-lines 200]` writes JSON:

```json
{ "generated_by": "wadl support-bundle", "generated_at": "…",
  "cli_version": { "git", "built_at", "schema" },
  "health": { …the /health body from --base, or "unreachable: <reason>"… },
  "migrations": { "embedded": ["0001_…", …], "applied": [{ "version": 16, "description": "yard clock document", "installed_on": "…", "success": true }], "pending": [] },
  "ledger": [ { "hull_no": "CVN-73", "entries": 14, "verified": true, "first_break": null } ],
  "documents": [ { "hull_no": "CVN-73", "kind": "compartment_register", "label": "CVN73-register.csv", "schema_version": 1 } ],
  "environment": { "set": ["WADL_PORT","WADL_BIND","WADL_STATIC_DIR","DATABASE_URL","WADL_PROXY_KEY"], "unset": ["WADL_ALLOW_DEV_SHIM_OFF_LOOPBACK", …] },
  "audit_recent": { "source": "journalctl -u wadl -n 200 -o cat", "lines": [ { "audit": "http", "method": "GET", "path": "/api/vessels/<uuid>/deck-states", "status": 200, "ms": 41, "org": "redacted" } ], "note": "journalctl unavailable" },
  "redaction": "no env values, no URLs, no uuids, no person ids, no header values; hull numbers kept so a finding can be acted on" }
```

Redaction is a function with a test: every UUID in any string → `<uuid>`; `org`, `person`, `by_person` values → `redacted`; env **names** only. `journalctl` absent or refused → `audit_recent.lines: []` with the note. The bundle never opens the proxy key or the URL beyond connecting.

### Test support (`crates/wadl-api/tests/support/mod.rs`)

```rust
pub enum Backend { Memory, Postgres }
pub struct TestWorld { pub app: axum::Router, pub world: DemoWorld, pub store: Arc<dyn Repositories>, pub backend: Backend }
pub async fn seed_world() -> TestWorld          // memory demo_at(DEMO_ANCHOR_MS), always — the 24-space story
pub async fn reference_hull() -> TestWorld     // reference/cvn73 through load_docs(via "test"), + the full XER, on the backend DATABASE_URL selects
impl TestWorld { pub async fn call(&self, method, path_under_hull, body: Option<Value>) -> (StatusCode, Value); pub async fn get_root(&self, path) -> … }
```

Backend selection: `DATABASE_URL` set **and** the crate built with `--features postgres` → PostgreSQL; set without the feature → memory with one printed line `DATABASE_URL set but wadl-api built without --features postgres; running on memory`; unset → memory. **Reset strategy on PostgreSQL: a fresh hull per test, never a reset.** `reference_hull()` builds a `HullStatement` from `reference/cvn73/CVN73-hull.json` with a new v7 `vessel_id` and `availability_id` (hull number `T-<8 hex>`), applies `bootstrap_hull` (org and class `existed`), loads the documents onto it, and sets `world.cvn73` and the headers to that hull. Documents, hazards, the schedule and the ledger are all per hull, so tests run in parallel with no `TRUNCATE`, no per-test database and no ordering; the CI database is ephemeral and the yard never runs the suite. `TestClock` stays at `DEMO_ANCHOR_MS` on both backends (the template availability 2026-01-05 → 2026-09-30 contains it; the reference hazards carry their own `since`). Every test that only needs a hull with documents uses `reference_hull()`; the seed-world suites keep `seed_world()` and are memory-only by declaration. PostgreSQL-only tests are `#[ignore = "needs DATABASE_URL"]` and CI runs them with `-- --ignored`; store-generic tests are never ignored — they choose the backend at runtime.

### CI (`.github/workflows/ci.yml`)

New job **`production-path`** (`postgres:16` service; `DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres`; `WADL_GIT=${GITHUB_SHA::12}`): `cargo build --locked -p wadl-cli -p wadl-api --bin wadl --bin serve --features wadl-api/postgres` → `wadl migrate` → `wadl bootstrap-hull --statement reference/cvn73/CVN73-hull.json` (must print four `created`) → `wadl load-docs --dir reference/cvn73 --xer reference/p6-sample/CVN73-PIA26-full.xer --org …0001 --vessel …0073` → `cargo test --locked -p wadl-api --features postgres` (the reference-hull suites on PostgreSQL, each on its own hull; the seed suites on memory as always) → `cargo test --locked -p wadl-cli -- --ignored` → `WADL_BIN=target/debug/wadl WADL_SERVE_BIN=target/debug/serve scripts/restore-drill.sh` → `wadl support-bundle --out evidence/support-bundle.json --base http://127.0.0.1:<port>` against a served instance → `curl /health | jq -e '.version.git != "unknown" and .schema_state == "current" and (.version.schema|tonumber) == (.store.schema_version|tonumber)'` → `actions/upload-artifact` `wadl-production-path-evidence` (the drill log, the support bundle, the health body). The existing `migrations` job is unchanged (it proves RLS on the seed). `self-assessment` gains one step: `WADL_BIND=0.0.0.0 ./target/debug/serve` must exit non-zero within 5 s with the refusal on stderr.

### Migration rollback policy (written in `docs/runbook.md` §Upgrade and §Roll back; summarised here as the contract)

1. Migrations are forward-only; **no down-migration is ever written**. The binary stamps the set it was built for; a database behind it refuses to be served; a database ahead of it is served with a warning.
2. Every upgrade begins with `scripts/backup.sh` and records the dump's name on the pilot record; `wadl migrate` runs from the DBA's session **after** the backup and **before** the new binary starts.
3. Rolling back a release means installing the previous binary. It serves the newer schema when the migration was **additive** (a new document kind, a nullable column, an index — every migration 0001-0016 is additive; the runbook table classifies each, and every future migration file states `-- rollback: additive` or `-- rollback: restore-only` in its header). A `restore-only` migration is rolled back by `scripts/restore.sh` from the pre-upgrade dump, and the ledger rows written between backup and restore are gone: the restore is itself written on the pilot record, and the morning meeting runs on the last printed sheets until it is done.
4. RPO is the backup cadence the yard sets (the runbook proposes nightly plus before every upgrade and every data-load day); RTO is the drill's measured time on the yard's host, recorded by `restore-drill.sh`.

### Shell (`api.ts`, `App.tsx`, `Chrome.tsx`)

`api.ts`: `export interface Health { status; version: { git; built_at; schema; document_schema }; schema_state; store: { backend; reachable; schema_version } }`, `export async function health(): Promise<Health>` (no identity headers; `/health` is unscoped). `App.tsx`: one effect on mount, `health().then(h => setStamp(\`${h.version.git} · schema ${h.version.schema} · ${h.store.backend}\`)).catch(() => setStamp("version unavailable"))`, passed as `stamp` to the bottom band. `Chrome.tsx`: `ClassificationBanner({ edge, stamp })` — one absolutely-positioned `<span>` at the right edge, 9.5 px, dim, `stamp` text, rendered only when `edge === "bottom"`; markings unchanged and still centred. No new module, no Field Guide entry.
