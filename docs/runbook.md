# Runbook — operating Shipyard AI Onboard on the yard's PostgreSQL

Written from the commands and scripts as built (S15), not as planned: every
procedure below names the exact command, the line it prints when it
succeeds, and where the result is recorded. The policy behind the choices is
`docs/production-posture.md`; the deployment shape is `deploy/README.md`;
the data-load day is `docs/pilot-playbook.md` §2. Nothing here needs SQL
typed by hand.

Roles named: **the DBA** (owns the PostgreSQL host, runs `wadl migrate`,
`bootstrap-hull`, `load-docs`, the backup and the drill from their own
session as the database owner); **the operator** (owns the host the binary
runs on, the unit file and the proxy pairing); **the ISSO** (receives the
support bundle and the drill record). At a small yard these may be one
person; the record still names which hat.

## 0. What the binary knows about itself

Every `serve` and `wadl` binary carries a **release stamp**: the commit it
was built from, the commit's instant, and the migration set it was built
against. Read it three ways; they must agree:

```
$ wadl version
wadl a85368c · built 2026-09-07T23:22:10+00:00 · schema 0018 · document schema 1

$ curl -s http://127.0.0.1:8080/health | jq '.version, .schema_state'
{ "git": "a85368c", "built_at": "2026-09-07T23:22:10+00:00", "schema": "0018", "document_schema": 1 }
"current"
```

The banner's `release:` line says the same at boot. `schema_state` compares
the stamp's migration set with the database's `_sqlx_migrations`:
`current`, `database_behind` (the binary **refuses to start** — see §5),
`database_ahead` (starts, with a warning — see §6), or `not_applicable` on
the in-memory demo store.

## 1. Install

1. **Build the artifact**, stamping the commit so a vendored tarball with no
   `.git` still knows itself:

   ```sh
   export WADL_GIT="$(git rev-parse --short=12 HEAD)"     # CI: ${GITHUB_SHA::12}
   cd shell-web && npm ci && npx vite build && cd ..
   cargo build --locked --release -p wadl-api -p wadl-cli --bin serve --bin wadl --features wadl-api/postgres
   sha256sum target/release/serve target/release/wadl | tee release.sha256
   ```

   Record: `release.sha256` and the tag (step 6) on the pilot record.
2. **Install** per the header of `deploy/wadl.service`: `serve` and
   `shell-web/dist` under `/opt/wadl`, the unit into `/etc/systemd/system`,
   `systemctl daemon-reload && systemctl enable --now wadl`. Put `wadl` on
   the DBA's PATH (it is a deployment tool; it never runs as the service).
3. **First `wadl migrate`** (the DBA, `DATABASE_URL` in the session
   environment — never on the command line, never in a file the bundle
   reads): prints `migrations applied`. This creates the `wadl_app` role
   in the cluster; every table, policy and grant is migration DDL.
4. **`wadl bootstrap-hull`** — the hull-row statement the playbook files
   (`reference/cvn73/CVN73-hull.json` is the template: organisation,
   class, hull, availability, **ids included** — the proxy's
   `x-assigned-vessels` and this file must name the same hull):

   ```
   $ wadl bootstrap-hull --statement CVN73-hull.json --dry-run
   organization   would create   Demo Yard (shipbuilder)
   class          would create   CVN-68 · Nimitz class
   vessel         would create   CVN-73 · USS George Washington
   availability   would create   PIA-26 · 2026-01-05 → 2026-09-30 · Graving Dry Dock 4
   coupling_types would create   baseline coupling types · deck_penetration, shared_bulkhead, exhaust_trunk, electrical_bus
   rules          would create   baseline rule set · USN hot work, 7 rules

   $ wadl bootstrap-hull --statement CVN73-hull.json
   organization   created   …
   …
   ledger seq 1 HULL_BOOTSTRAPPED
   ```

   Idempotent: run again and every row reads `existed`, no new ledger row.
   The same hull number under a *different* id is **refused** (exit 2) and
   nothing is written — a second statement for one hull is a mistake, not
   an update. Read back: `GET /api/vessels` under the hull's headers lists
   it and nothing else. Record: the statement file and its `ledger seq 1`
   on the data-load record.
5. **`wadl load-docs`** on data-load day — playbook §2 — from the same
   session, one line per document with its ledger `seq`:

   ```
   $ wadl load-docs --dir <the yard's documents> --xer <the export>.xer --org <org uuid> --vessel <hull uuid> [--person <id>] [--dry-run]
   yard clock:          CVN73-clock.csv — America/New_York, 3 shifts · ledger seq 2
   field map:           CVN73-fieldmap.json — … · ledger seq 3
   register:            CVN73-register.csv — 476 spaces on 12 decks · ledger seq 4
   zone chart:          CVN73-zones.csv — 10 blocks · ledger seq 5
   geometry:            CVN73-geometry.csv — 476 surveyed, 12 deck bands · ledger seq 6
   couplings:           CVN73-couplings.csv — 220 authored, 1259 derived · ledger seq 7
   field conditions:    CVN73-hazards.csv — 27 raised · ledger seq 8
   schedule of record:  CVN73-PIA26-full.xer — 5706 activities, 0 quarantined, utf-8, map CVN73-fieldmap.json · parsed in America/New_York · CVN73-clock.csv · ledger seq 9
   ```

   `--dry-run` parses and validates every file in order and stores nothing
   (without a database it validates on a scratch in-memory hull — the
   yard checks its CSVs on a laptop). A refused file exits 2 with the file
   named first; the documents before it stay committed and are listed.
   `--person` puts the signer on every row; without it the rows read
   `system:cli`. Record: each line's `seq` beside the signature.
6. **Tag**: `git tag -a pilot-<yard>-1 <commit>` at the commit `/health`
   reports, by the person the CM plan names (`docs/ato-package.md` §2.6).
   The tag is a human act; nothing in the tree cuts one.

## 2. Configure the proxy

The contract and the staging test are `docs/briefs/proxy-owner-contract.md`
and `docs/identity-proxy-contract.md`; `deploy/README.md` has the
six-header summary. Two boot-time gates protect a misconfiguration:

- With `WADL_PROXY_KEY` **unset**, the dev header shim is the identity and
  the binary **refuses to bind anything but loopback** — a unit file that
  widens `WADL_BIND` without arming the key does not boot; the refusal names
  the two ways out (`WADL_PROXY_KEY`, or
  `WADL_ALLOW_DEV_SHIM_OFF_LOOPBACK=yes` for a host that is itself isolated
  and never behind a proxy).
- `WADL_PROXY_KEY=""` refuses to boot: an empty key admits nobody.

Verify: `curl -s https://yard-host/api/whoami` through the proxy reads
`"identity_mode":"proxy-asserted"` and a person; `scripts/self-assessment.sh`
reads WADL-SA-05 `proxy-asserted`, WADL-SA-11 `whoami names a person`.
Record: the staging test output on the pilot record.

## 3. Back up

**Cadence proposed** (the yard sets it, Y13): nightly, plus immediately
before every upgrade (§5) and at the end of every data-load day. RPO is
that cadence. Dumps live where the yard's backup policy says; they carry
no secret (no URL, no key) but they carry the hull's documents and ledger,
so they are handled at the system's marking.

```
$ DATABASE_URL=postgres://… scripts/backup.sh /var/backups/wadl
→ verify the ledger before backing it up
CVN-73 · 9 entries verify
1 hull verify
✓ every hull's chain verifies
→ read the schema and the release stamp
✓ schema 0018 · release a85368c · 20260907T232351Z
→ pg_dump (custom format, no owner) → /var/backups/wadl/wadl-0018-a85368c-20260907T232351Z.dump
✓ 924K written
→ checksum sidecar
✓ 96d70ac7…
→ manifest
✓ /var/backups/wadl/wadl-0018-a85368c-20260907T232351Z.manifest.json
{"schema":"0018","git":"a85368c","taken_at":"20260907T232351Z","ledger_verified":true,"hulls":1}
✓ backup complete: …
```

Three files travel together: the `.dump` (custom format), the `.sha256`
sidecar, the `.manifest.json` (`schema`, `git`, `taken_at`, `hulls:
[{hull_no, ledger_rows}]`, `ledger_verified`, `dump_sha256` — no uuids, no
URL). The ledger is verified **first**; a broken chain is still backed up
(the evidence must not be lost) but the manifest says `ledger_verified:
false` and the exit code is **3**, so a scheduled run is noticed.
`WADL_BIN` names the `wadl` binary (default `target/release/wadl`).
Requires `pg_dump` and `psql` with client major ≥ the server's, and `jq`.
**Record:** the manifest is the record; file it.

## 4. Restore

```
$ DATABASE_URL=postgres://… scripts/restore.sh <dump>            # prints what it would do, exit 2
$ DATABASE_URL=postgres://… scripts/restore.sh <dump> --yes      # into an empty target
$ DATABASE_URL=postgres://… scripts/restore.sh <dump> --replace --yes   # over a populated one
```

`restore.sh` checks the sidecar (a dump without its checksum is not
restored), refuses a target that already holds any hull unless
`--replace`, and does nothing without `--yes`. Then `pg_restore --clean
--if-exists --no-owner`, `wadl migrate` (applies anything newer than the
dump — the upgrade-after-restore path; a no-op otherwise), `wadl
verify-ledger --database-url`, and the restored hulls and ledger lengths
beside the manifest's — a mismatch fails the restore. The dump keeps the
tables' privileges on purpose: the `wadl_app` grants are migration DDL and
must come back with the tables.

**The empty-cluster case.** The dump carries policies and grants, not the
`wadl_app` role (roles are cluster-level). On a cluster that never ran WADL,
`wadl migrate` against the empty target first — it creates the role — then
`restore.sh <dump> --yes`. A restore into a cluster without the role fails
on the first grant with a readable error.

**The drill** — the rehearsal Y13 asks for before data-load day, and what
CI runs on every push:

```
$ DATABASE_URL=postgres://user@host:port/anydb scripts/restore-drill.sh
→ create scratch database wadl_drill
…
→ scripts/restore.sh …dump --yes
…
→ /health reads the stamp and schema_state: current
✓ a85368c · schema 0018 · postgresql · current
→ GET /api/vessels/CVN-73/compartments counts 476
✓ 476 spaces
→ GET …/ledger reads verified: true, HULL_BOOTSTRAPPED first, SCHEDULE_REPLACED last
✓ verified · 9 rows · HULL_BOOTSTRAPPED → DOCUMENT_REPLACED × 7 → SCHEDULE_REPLACED
drill: PASS in 5 s
```

It runs on a scratch database (`WADL_DRILL_DB`, default `wadl_drill`) in
the cluster the URL names and never touches the URL's own database:
migrate → bootstrap-hull → load-docs (the reference hull and export) →
backup → the two refusals (`restore.sh` without `--yes`; on a populated
target without `--replace`) → drop, recreate, migrate the empty target →
restore → verify-ledger → boots `WADL_SERVE_BIN` on a free loopback port
against the restored database → `/health` `schema_state: current`,
`version.git != unknown`, `version.schema == store.schema_version` → 476
compartments → the ledger verified with the bootstrap row oldest and the
export newest and the manifest's row count → drops the scratch database.
**RTO** is the printed time on the yard's host (5 s on the development
host for one hull; the yard's number goes on the record). **Record:** the
drill log is the drill record (M12 on the playbook).

## 5. Upgrade

In this order, from the DBA's session and the operator's, with the log
kept:

1. `scripts/backup.sh` — the manifest's name goes on the pilot record.
2. `systemctl stop wadl`.
3. Install the new `serve` (and `wadl`) per §1 steps 1–2; verify
   `release.sha256`.
4. `wadl migrate` with the **new** `wadl` — prints `migrations applied`.
5. `systemctl start wadl`.
6. `curl -s http://127.0.0.1:8080/health | jq '.version.git, .schema_state'`
   reads the new commit and `"current"`.
7. `wadl verify-ledger --database-url "$DATABASE_URL"` reads every hull
   `… entries verify`.
8. `scripts/self-assessment.sh` through the proxy: WADL-SA-05
   `proxy-asserted`, WADL-SA-11 names a person, no FAIL.

If step 4 is skipped, step 5 does not start: the binary reads
`database is at 0017, this binary needs 0018 — run: wadl migrate` on stderr
and exits — the database is never served by a binary built for a schema it
does not have.

## 6. Roll back

**Policy.**

1. Migrations are forward-only; **no down-migration is ever written**. The
   binary stamps the set it was built for; a database behind it refuses to
   be served; a database ahead of it is served with the banner line
   `WARNING: database is at NNNN, this binary was built for MMMM — a newer
   release wrote this database` and `/health` `schema_state:
   "database_ahead"`.
2. Every upgrade begins with `scripts/backup.sh` (§5 step 1).
3. Rolling back a release means **installing the previous binary**. It
   serves the newer schema when the migrations between the two releases
   were **additive** — the table below classifies every migration to date,
   and every future migration file states `-- rollback: additive` or
   `-- rollback: restore-only` in its header. A `restore-only` migration is
   rolled back by `scripts/restore.sh <the pre-upgrade dump> --replace
   --yes`; the ledger rows written between the backup and the restore are
   gone, the restore is itself written on the pilot record, and the
   morning meeting runs on the last printed shift and zone sheets until it
   is done.
4. RPO is the backup cadence (§3); RTO is the drill's measured time (§4).

| Migration | Rollback class | Why |
|---|---|---|
| 0001 tenancy and RLS baseline … 0011 hazards, documents, rule payloads | additive | new tables, policies, grants; nothing an older binary reads changes shape |
| 0012 hazard clearance basis | additive | a nullable column |
| 0013 manning book · 0014 geometry register · 0015 ship registers · 0016 yard clock | additive | each widens the `ingested_document.kind` check; every earlier kind stays valid |
| 0017 ledger actor | additive | nullable actor columns and `chain_version` defaulting to 1; format-1 rows verify unchanged |
| 0018 schedule runs and field map | additive | nullable columns on `ingest_run`, a nullable `run_id` on `ingested_document` |

Nothing to date is `restore-only`; the procedure exists so the first one is
not improvised.

## 7. Incident

What counts (from `docs/ato-package.md` §2.8): a ledger chain that reads
`verified: false` on any read or `BROKEN` from `verify-ledger`; a 5xx; a
401/403 pattern from one session; a shed-503 burst; a document commit
nobody signed for on the data-load record; a `database_ahead` or a refused
boot nobody scheduled.

Collect, in this order, before anything is restarted:

1. `journalctl -u wadl --since "<when>" -o cat > incident-<date>.journal` —
   the HTTP audit stream (one JSON line per `/api` request and per non-2xx
   anywhere; refusals as loud as successes) and the `backend_error` lines.
2. The ledger: `wadl verify-ledger --database-url "$DATABASE_URL"` (every
   hull, the first break's `seq`) and the hull's export from `GET
   …/ledger`, kept with `wadl verify-ledger --input <export>` on it.
3. `wadl support-bundle` (§8).
4. The proxy's access log for the window (the yard's).

Who is told: the ISSO, then the enclave's IR plan the procedure reports
into (Y14); the pilot record gets the incident line. Request ids that would
join an audit line to its problem body and ledger row are not built (after
the pilot, B7); until then the timestamp and path correlate.

## 8. Support bundle

```
$ wadl support-bundle --out bundle.json --database-url "$DATABASE_URL" --base http://127.0.0.1:8080 [--journal-lines 200]
wrote bundle.json
```

It holds: `cli_version` (the stamp), `health` (the served `/health` body,
or `unreachable: <reason>`), `migrations` (`embedded` in the binary,
`applied` from `_sqlx_migrations` with instants, `pending`), `ledger` (per
hull: entries, `verified`, `first_break`), `documents` (per hull: kind,
label, when — never content), `environment` (which configuration variables
are **set**, names only), `audit_recent` (the last N `journalctl -u wadl`
lines, or the note that the journal was unavailable or refused), and the
redaction statement.

It never holds: an environment value, a connection URL, a uuid, a person
id or name, a header value — every uuid in any string reads `<uuid>`,
every `postgres://` reads `<url>`, `org`/`person`/`by_person`/`actor_*`
read `redacted`. Hull numbers are kept so a finding can be acted on. The
database URL is used to connect and never written; the proxy key is never
opened. Send it to the ISSO by the enclave's channel for the system's
marking; the test `the_support_bundle_carries_no_uuid_no_url_and_no_env_value`
is the standing proof of what it does not carry.

## 9. Sizes and retention

Noted, not enforced:

- **Schedule runs** (`ingest_run.doc`): about 2 MB per 5,700-activity
  import; every commit keeps its run so a prior run can be served again.
  A yard importing daily grows about 60 MB a month per hull.
- **Ledger rows** (`audit_entry`): one per clearance, commit, proposal,
  decision, acknowledgement; a few hundred bytes each. Never deleted.
- **The journal**: one JSON line per request; `journald`'s retention and
  sealing are the yard's (POAM-4).
- **Dumps**: about 1 MB per hull with its documents and one export (924 K
  measured on the reference hull); the backup cadence times that.

When any of these needs a policy, it becomes a runbook section with a
command, not a manual deletion.
