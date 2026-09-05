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

## Files

New (14): `crates/wadl-api/build.rs`, `crates/wadl-api/src/version.rs`, `crates/wadl-store/src/pg_bootstrap.rs` (behind `postgres`: `bootstrap_hull`, `audit_chains_all`, `migration_state`, `documents_inventory`), `crates/wadl-cli/src/{bootstrap.rs, load_docs.rs, bundle.rs}` (each command its own module; `main.rs` stays a dispatcher under `too_many_lines`), `crates/wadl-cli/tests/database.rs`, `crates/wadl-api/tests/support/mod.rs`, `crates/wadl-api/tests/production_path.rs`, `reference/cvn73/CVN73-hull.json`, `scripts/backup.sh`, `scripts/restore.sh`, `scripts/restore-drill.sh`, `docs/runbook.md`.

Touched (Rust, 12): `crates/wadl-api/Cargo.toml` (nothing but a comment: `build.rs` is auto-detected), `crates/wadl-api/src/lib.rs` (`pub mod version`), `handlers.rs` (`health`: three lines — `version`, `schema_state`; `ledger_document` delegates), `documents.rs` (`load_docs`, `LoadVia`, `ledger_document_on`, dry-run placards), `auth.rs` (`dev_shim_may_bind` + tests), `bin/serve.rs` (stamp banner, schema rule, shim gate, header doc), `crates/wadl-store/src/model.rs` (`HullStatement`, `BootstrapOutcome`), `crates/wadl-store/src/lib.rs` (`pub mod pg_bootstrap` under the feature), `crates/wadl-cli/Cargo.toml` (`wadl-api.workspace = true`; `uuid` v7 for the test hulls is already there), `crates/wadl-cli/src/main.rs` (five subcommands, `version`, `verify-ledger --database-url`), `crates/wadl-api/tests/{demo_docs, yard_clock, zone_focus, activities, manning, zones}.rs` (their local `app()`/`booted()` helpers replaced by `support::reference_hull()` / `seed_world()`; assertions unchanged), `crates/wadl-store/tests/pg_rls.rs` (one bootstrap round-trip test).

Touched (shell, 3): `api.ts`, `App.tsx`, `Chrome.tsx`. Touched (ops and docs, 9): `.github/workflows/ci.yml`, `deploy/README.md` ("prepare the database": `wadl migrate && wadl bootstrap-hull`; `wadl seed` demoted to "demo world only"), `deploy/wadl.service` (a comment line naming the shim gate), `xtask/src/ssp_template.md` + regenerated `docs/ssp-input.md`, `docs/ato-package.md` (§2.6 partial→ the CM inputs exist, §2.7 missing→ exists with the drill as evidence, §2.8 missing→ partial, §5 step 1 gains the bundle, §6 two bullets closed), `docs/pilot-playbook.md` §1 (the hull-row paragraph becomes the command), `docs/execution-plan.md` (row), `README.md` (the CLI line), `docs/poam.md` (the seed-generation deferral).

Thirty-eight files, over the fifteen preference because two slices share one packet and half the count is documents and tests. **Cut line** after build step 8 below: steps 1–8 close B13 in full (stamp, gate, bootstrap, load-docs, backup/restore/drill, verify-ledger, bundle, runbook) and B10's operational half (the reference hull on PostgreSQL in CI through the doors, `/health` asserted); steps 9–11 are the store-generic suites and the footer.

## Tests

`crates/wadl-api/src/version.rs` unit tests: `schema_state_compares_zero_padded_numbers` (`0016` vs `Some("16")` → current; `Some("15")` → behind; `Some("17")` → ahead; `None` → not applicable); `the_stamp_is_never_empty` (each field non-empty; `git` and `built_at` may be `unknown`, `schema` matches `^\d{4}$`). `auth.rs`: `the_dev_shim_binds_loopback_v4_and_v6`, `the_dev_shim_refuses_a_public_address_and_names_the_override`, `the_override_admits_it`. `documents.rs`: `redact` lives in the CLI — see below.

`crates/wadl-api/tests/production_path.rs` (store-generic via `support::reference_hull()`): `health_carries_the_build_stamp_and_a_schema_state` (`version.git`, `version.schema` 4 digits, `schema_state ∈ {not_applicable, current}` by backend); `the_reference_hull_is_served_whole` (476 compartments, twelve decks, 5,706 activities, zone audit clean); `loading_through_the_doors_is_ledgered_in_door_order` (ledger newest-first: `SCHEDULE_REPLACED`, then `DOCUMENT_REPLACED` × 6 with `via: "test"`, `verified: true`; on PostgreSQL `HULL_BOOTSTRAPPED` is the oldest row); `a_second_load_replaces_and_ledgers_again` (call `load_docs` twice → twelve document rows, counts equal, `verified`); `a_bad_register_refuses_the_file_and_stores_nothing_after_it` (a temp dir with a broken `-register.csv`: `Err` names the file; the clock before it committed; zones after it did not); `a_dry_run_stores_nothing_and_ledgers_nothing`. Migrated suites (`demo_docs`, `yard_clock`'s reference cases, `zone_focus`, `activities`' XER door, `manning`, `zones`) run unchanged in assertion on both backends.

`crates/wadl-cli/tests/database.rs` (all `#[ignore = "needs DATABASE_URL"]`): `bootstrap_hull_creates_four_rows_once_and_reports_existed_after` (fresh statement, second run all `existed`, one `HULL_BOOTSTRAPPED` row, `GET`-equivalent `list_vessels` under the new scope shows the hull); `bootstrap_hull_refuses_a_hull_number_clash_with_a_different_id_and_rolls_back`; `bootstrap_hull_dry_run_writes_nothing`; `load_docs_onto_a_bootstrapped_hull_ledgers_each_document` (register count, six rows, `via: "cli"`); `verify_ledger_reads_a_live_database_and_reports_per_hull` (break a hash with owner-mode SQL in the test → exit reason names the seq); `the_support_bundle_carries_no_uuid_no_url_and_no_env_value` (generate against the test database and a served health body; grep the JSON for the UUID regex, `postgres://`, and the value of a planted `WADL_PROXY_KEY`). Unit: `bundle::redact_replaces_uuids_and_identity_fields` (pure, always runs). `crates/wadl-store/tests/pg_rls.rs`: `a_bootstrapped_hull_is_invisible_to_the_other_tenant`.

Scripts are tested by the drill: `restore-drill.sh` **is** the test and CI runs it; `restore.sh` without `--yes` and with a populated target are asserted inside the drill as two expected refusals (exit 2) before the real restore. `serve` refusals are asserted in the `self-assessment` job step (`WADL_BIND=0.0.0.0` exits non-zero; `WADL_BIND=0.0.0.0 WADL_ALLOW_DEV_SHIM_OFF_LOOPBACK=yes` boots) and the schema rule in the drill (a database migrated to fewer versions is not cheap to make — asserted by unit test on `schema_state` and by reading the refusal string once by hand at acceptance).

Shell: `api.test.ts` (or the existing nearest vitest file) `health() parses the stamp and tolerates a missing version block` (older server → `version undefined` → App shows `version unavailable`).

## Acceptance

1. `cargo build -q --release -p wadl-api --bin serve`; `./target/release/serve` banner shows `release: <short-sha> · built <commit instant> · schema 0016`; `curl -s :8080/health | jq .version,.schema_state` → the same values, `"not_applicable"`. `git describe --always` equals `version.git`.
2. `WADL_BIND=0.0.0.0 ./target/release/serve` exits 1 with the shim message; with `WADL_ALLOW_DEV_SHIM_OFF_LOOPBACK=yes` it boots and WADL-SA-05 still WARNs; with `WADL_PROXY_KEY=k WADL_BIND=0.0.0.0` it boots without the variable.
3. Empty database: `wadl migrate`; `wadl bootstrap-hull --statement reference/cvn73/CVN73-hull.json --dry-run` prints four `would create`; without `--dry-run` prints four `created` and `ledger seq 1 HULL_BOOTSTRAPPED`; again → four `existed`, no new ledger row; `curl -H 'x-org-id: …0001' -H 'x-assigned-vessels: …0073' :8080/api/vessels` lists CVN-73 · PIA-26 and nothing else.
4. `wadl load-docs --dir reference/cvn73 --xer reference/p6-sample/CVN73-PIA26-full.xer --org …0001 --vessel …0073` prints the six document lines and the schedule line each with a `seq`; `…/ledger` reads `verified: true`, eight rows, `via: "cli"`; the Data Sources cards read `INGESTED` with the file labels; the Deck Explorer draws the reference hull on PostgreSQL.
5. `scripts/backup.sh` writes dump, sidecar and manifest (`ledger_verified: true`, `hulls: [{ "hull_no": "CVN-73", "ledger_rows": 8 }]`); `grep -c postgres:// *.manifest.json` → 0.
6. `WADL_BIN=target/release/wadl WADL_SERVE_BIN=target/release/serve scripts/restore-drill.sh` → `drill: PASS in <n> s`, with `476` and `verified: true` in the log; the same command against `DATABASE_URL` on a second host works with no edit.
7. `wadl verify-ledger --database-url "$DATABASE_URL"` → `CVN-73 · 8 entries verify`; after `psql -c "UPDATE audit_entry SET detail = detail || ' ' WHERE entry_id = 3"` as the owner → `BROKEN at seq 3`, exit 1.
8. `wadl support-bundle --out b.json --base http://127.0.0.1:8080 --database-url …`; `jq .migrations.pending b.json` → `[]`; `grep -E '[0-9a-f]{8}-[0-9a-f]{4}' b.json` → nothing; `grep -c "$WADL_PROXY_KEY" b.json` → 0; `audit_recent.lines[].org` all `redacted`.
9. CI: the `production-path` job is green on the push; its artifact holds the drill log, the health body and the bundle; `cargo test -p wadl-api --features postgres` in that job shows `production_path` and the migrated suites running on PostgreSQL (the support module prints `backend: postgresql` once per test binary).
10. Browser: the bottom marking band's right edge reads `df18c59 · schema 0016 · memory` (or `postgresql`); kill the API → `version unavailable`; markings still centred; a screenshot carries both.
11. Gates: fmt, clippy `-D warnings` pedantic (`build.rs` included), `cargo test --workspace --all-features`, `gen-ssp --check`, `gen-leak-tests --check` (no route changed; must stay current), `pg_rls`, `npm run typecheck`, `vitest`, `npm run build`. `docs/runbook.md` exists with every section below filled from the commands as built, not as planned.

`docs/runbook.md` sections (each a numbered procedure with the exact command, the expected line, and where the result is recorded): **1 Install** (artifact build with `WADL_GIT`, checksums, unit file, first `wadl migrate`, `bootstrap-hull`, the tag: `git tag -a pilot-<yard>-<n>` at the commit `/health` reports); **2 Configure the proxy** (points at `docs/briefs/proxy-owner-contract.md`; the staging `whoami` test; the shim gate); **3 Back up** (cadence proposal, `backup.sh`, where dumps live, the manifest as the record); **4 Restore** (`restore.sh`, the empty-cluster case, the drill and its record); **5 Upgrade** (backup → stop → migrate → start → `/health` `schema_state: current` → `verify-ledger` → the two self-assessment lines); **6 Roll back** (the policy above, the additive table for 0001–0016); **7 Incident** (what counts, from `ato-package.md` §2.8; what to collect: `journalctl` slice, ledger export + `verify-ledger`, the bundle, the proxy log; who is told); **8 Support bundle** (what it holds, what it never holds, how to send it); **9 Sizes and retention** (run docs ≈ 2 MB per 5,700 activities per import, audit rows, the journal — noted, not enforced).

## Demo moment

The yard's DBA at a terminal, the ISSO watching. An empty database. `wadl migrate` — sixteen migrations. `wadl bootstrap-hull --statement CVN73-hull.json` — four `created`, one ledger row that names the statement. `wadl load-docs --dir reference/cvn73 --xer …` — clock, register, zones, geometry, couplings, the morning's log, the export, each with its ledger `seq`. The shell opens on PostgreSQL behind the proxy and draws the hull; the bottom band reads the commit and the schema. `scripts/backup.sh`; `dropdb`; `scripts/restore.sh … --yes` — the ledger verifies, 476 spaces answer, the same commit and schema read back. `wadl support-bundle` — the ISSO reads a file with no secret in it. The same drill ran in CI this morning; the log is the artifact on the run.

## Depends on / conflicts with

- **S10** (landed): `load_docs` loads the clock first and the export in it; `yard_clock.rs` is migrated to the support module, its assertions untouched.
- **S12**: `--person` fills `Actor`; `HULL_BOOTSTRAPPED` and the CLI's document rows are `unattributed` until then. If S12 lands first, the `append_audit` signature carries the actor and `pg_bootstrap` passes it — a one-argument change.
- **S13**: `load-docs --xer` calls S13's `commit_schedule` with `via: "cli"`; the fallback if S13 has not landed is stated above. S13's `ImportedBy.via` vocabulary gains `cli` and `test`.
- **S11**: no overlap; wave order only.
- **S17**: the Playwright smoke and the evidence bundle build on `production-path`'s artifact and `restore-drill.sh`; the `handlers.rs` split moves `health` and `ledger_document` — this packet touches three lines of each, so S17 rebases trivially.
- **`Chrome.tsx`**: reserved by the charter for S10/S12/S18 in the top bar; this packet's only edit is inside `ClassificationBanner` (bottom band), which none of them touch.
- **`ci.yml`**: S17 adds jobs; this packet adds one job and one step and edits nothing existing except the `self-assessment` step list.

## Risks

- **Ledgering the boot path** adds six `DOCUMENT_REPLACED … via: boot` rows to the reference hull's ledger on every start. `yard_clock.rs` asserts an empty ledger only on the seed app (`app()`, not the reference hull) — verified by reading lines 165 and 203 — but the builder greps every `/ledger` assertion before build; the demo script's ledger walk-through gains six honest rows at the bottom.
- **`build.rs` and reproducibility**: `--dirty` can differ between a CI checkout and a local tree; the `reproducible` job builds from two clean checkouts of one commit, so both read the same. `WADL_GIT` is stamped in CI from `GITHUB_SHA` because `actions/checkout` is shallow and untagged (`git describe --tags` would fail; `--always` falls back to the short sha, which is the same twelve characters either way).
- **`pg_restore` and roles**: the dump carries policies and grants, not the `wadl_app` role. The drill and the runbook both create the role via `wadl migrate` on the empty target before restoring with `--clean`; a restore into a cluster that never ran `migrate` fails on the grant with a readable error — the runbook says so.
- **Client/server version skew**: `pg_dump` 16 against `postgres:16` in CI; the runbook requires the client major ≥ the server major at the yard.
- **`journalctl` in the bundle**: absent on the CI runner and possibly refused to the operator's user at the yard; the bundle records the absence instead of failing.
- **The per-test hull grows the CI database** by one hull and ~3 MB of documents per reference test (about twenty); ephemeral. A developer's local database accumulates `T-…` hulls — the support module prints the hull number so `wadl`'s owner session can drop them; a `--sweep-test-hulls` flag is out of scope.
- **`wadl-cli → wadl-api` dependency** pulls axum into the CLI's build. Acceptable: the CLI is a deployment tool that already carries sqlx; the alternative (moving the parsers to `wadl-ingest`) is S17's split, not this slice.
- **Two clocks in the drill**: `bootstrap-hull` and `load-docs` stamp `SystemClock`; the API's `as_of` reads at the yard's now. The reference availability runs to 2026-09-30 and the drill runs today; after that date `production_path` on `TestClock` is unaffected but a hand demo of the reference hull on a live clock reads "out of range" — a known property of the reference statement, noted in the runbook.

## Needs from the yard

- The hull-row statement filled (org uuid, class, hull number, name, availability code, bounds, location) — the JSON file this packet's template is for; the DBA's session that will run `migrate`, `bootstrap-hull`, `backup.sh` and the drill.
- The backup cadence and where dumps live (RPO), and an accepted RTO after the drill has been timed on their host (Y13).
- `pg_dump`/`pg_restore` 16 on the host that runs the scripts; whether the operator's account may read `journalctl -u wadl`.
- Who cuts a release tag and who approves an upgrade (the CM plan's two names, `ato-package.md` §2.6).

## Estimate

About 10 agent-hours in three sittings. **A (S15 core, ~3.5 h)**: `build.rs` + `version.rs` + health + serve banner and schema rule + shim gate + tests 1.25; `HullStatement` + `pg_bootstrap` + `bootstrap-hull` + statement template + `pg_rls` case 1.25; `load_docs` refactor with dry run and ledgering + `load-docs` command 1.0. **B (ops, ~3 h)**: `verify-ledger --database-url` 0.5; `backup.sh`/`restore.sh`/`restore-drill.sh` run locally against the dev PostgreSQL 1.0; `support-bundle` + redaction tests 0.75; `runbook.md`, `deploy/README.md`, `ato-package.md`, playbook, execution plan, README, SSP regen 0.75. **C (S16, ~3.5 h)**: `support/mod.rs` + `production_path.rs` 1.25; migrating six suites and running them on both backends 1.0; CI job + drill in CI + artifact, iterating on the runner 0.75; shell footer + vitest + browser check 0.5. Build order: version → health → serve rule → shim gate → statement + bootstrap → `load_docs` + ledgering → `load-docs` CLI → scripts + `verify-ledger` → bundle → runbook and docs (**cut line**) → support module → `production_path` → migrate suites → CI job → footer.
