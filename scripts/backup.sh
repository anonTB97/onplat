#!/usr/bin/env bash
# Back up the WADL database: verify the ledger, dump, checksum, manifest.
#
#   DATABASE_URL=postgres://… scripts/backup.sh [outdir]
#
# Writes into outdir (default: backups/) three files that travel together:
#   wadl-<schema>-<git>-<UTC yyyymmddThhmmssZ>.dump   pg_dump custom format
#   …dump.sha256                                       checksum sidecar
#   …manifest.json                                     what the dump holds
# The manifest names the schema, the commit the CLI was built from, the
# instant, each hull and its ledger row count, whether every chain verified,
# and the dump's checksum — no uuids and no connection URL, so it can be
# filed with the pilot record.
#
# The ledger is verified first. A backup of a broken chain is still taken —
# the evidence must not be lost — but the manifest says `ledger_verified:
# false` and the exit code is 3, so a scheduled run is noticed.
#
# Needs: pg_dump and psql on PATH (client major ≥ the server's), the `wadl`
# binary at WADL_BIN (default target/release/wadl), jq. DATABASE_URL is used
# to connect and is never printed. Custom format so one hull's documents can
# be listed with `pg_restore -l` if ever needed.
set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL (it is never echoed)}"
WADL_BIN="${WADL_BIN:-target/release/wadl}"
OUTDIR="${1:-backups}"

step() { printf '→ %s\n' "$*"; }
ok()   { printf '✓ %s\n' "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }

for tool in pg_dump psql jq sha256sum; do
  command -v "$tool" >/dev/null || fail "$tool is not on PATH"
done
[ -x "$WADL_BIN" ] || fail "WADL_BIN=$WADL_BIN is not an executable (build with: cargo build --release -p wadl-cli)"
mkdir -p "$OUTDIR"

step "verify the ledger before backing it up"
verified=true
if "$WADL_BIN" verify-ledger --database-url "$DATABASE_URL"; then
  ok "every hull's chain verifies"
else
  code=$?
  [ "$code" -eq 1 ] || fail "verify-ledger failed (exit $code) — is the database reachable?"
  verified=false
  printf '! a chain is BROKEN — the backup is still taken, and the manifest says so\n'
fi

step "read the schema and the release stamp"
schema="$(psql "$DATABASE_URL" -Atc 'SELECT lpad(max(version)::text, 4, '"'"'0'"'"') FROM _sqlx_migrations')"
[ -n "$schema" ] || fail "the database has no _sqlx_migrations — run: wadl migrate"
git_stamp="$("$WADL_BIN" version --json | jq -r .git)"
taken_at="$(date -u +%Y%m%dT%H%M%SZ)"
ok "schema $schema · release $git_stamp · $taken_at"

name="wadl-${schema}-${git_stamp}-${taken_at}"
dump="$OUTDIR/$name.dump"

step "pg_dump (custom format, no owner) → $dump"
# Privileges are kept on purpose: the wadl_app grants are table DDL the
# migrations wrote, and they must come back with the tables.
pg_dump -Fc --no-owner -f "$dump" "$DATABASE_URL"
ok "$(du -h "$dump" | cut -f1) written"

step "checksum sidecar"
( cd "$OUTDIR" && sha256sum "$name.dump" > "$name.dump.sha256" )
dump_sha="$(cut -d' ' -f1 "$OUTDIR/$name.dump.sha256")"
ok "$dump_sha"

step "manifest"
hulls_json="$(psql "$DATABASE_URL" -Atc "
  SELECT coalesce(json_agg(json_build_object('hull_no', hull_no, 'ledger_rows', ledger_rows) ORDER BY hull_no), '[]'::json)
    FROM (SELECT v.hull_no, count(a.entry_id) AS ledger_rows
            FROM vessel v LEFT JOIN audit_entry a ON a.vessel_id = v.vessel_id
           GROUP BY v.hull_no) h")"
jq -n \
  --arg schema "$schema" --arg git "$git_stamp" --arg taken_at "$taken_at" \
  --argjson hulls "$hulls_json" --argjson verified "$verified" --arg sha "$dump_sha" \
  --arg dump "$name.dump" \
  '{schema: $schema, git: $git, taken_at: $taken_at, dump: $dump, hulls: $hulls,
    ledger_verified: $verified, dump_sha256: $sha}' > "$OUTDIR/$name.manifest.json"
ok "$OUTDIR/$name.manifest.json"
jq -c '{schema, git, taken_at, ledger_verified, hulls: (.hulls | length)}' "$OUTDIR/$name.manifest.json"

if [ "$verified" = false ]; then
  printf '✗ backup taken, but the ledger did not verify — see verify-ledger above\n' >&2
  exit 3
fi
ok "backup complete: $dump"
