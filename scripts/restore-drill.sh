#!/usr/bin/env bash
# The restore drill: bootstrap → load → back up → drop → restore → the ledger
# verifies → the register answers 476 spaces → /health reads the stamp.
#
#   DATABASE_URL=postgres://user@host:port/anydb scripts/restore-drill.sh
#
# Runs on a scratch database named WADL_DRILL_DB (default wadl_drill) in the
# cluster DATABASE_URL points at — the database in the URL itself is never
# touched. CI runs it on every push; the same script against the yard's
# staging host is the pre-data-load-day drill the playbook asks for (Y13),
# and its printed time is the measured RTO.
#
#   WADL_BIN        the wadl binary (default target/release/wadl)
#   WADL_SERVE_BIN  the serve binary, built --features postgres
#                   (default target/release/serve)
#   WADL_DRILL_DB   scratch database name (default wadl_drill)
#   WADL_DRILL_KEEP set to keep the scratch database and backup dir after
#
# Every step prints `→ step` / `✓ result`; the log is the drill record. The
# last line is `drill: PASS in <s> s`, or the step that failed.
set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL (it is never echoed)}"
WADL_BIN="${WADL_BIN:-target/release/wadl}"
WADL_SERVE_BIN="${WADL_SERVE_BIN:-target/release/serve}"
WADL_DRILL_DB="${WADL_DRILL_DB:-wadl_drill}"
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/.."

step() { printf '→ %s\n' "$*"; }
ok()   { printf '✓ %s\n' "$*"; }
fail() { printf '✗ drill FAILED at: %s\n' "$*" >&2; exit 1; }

for tool in psql pg_dump pg_restore jq curl; do
  command -v "$tool" >/dev/null || fail "$tool is not on PATH"
done
[ -x "$WADL_BIN" ] || fail "WADL_BIN=$WADL_BIN is not an executable"
[ -x "$WADL_SERVE_BIN" ] || fail "WADL_SERVE_BIN=$WADL_SERVE_BIN is not an executable"

# The cluster's maintenance database and the scratch database, from the
# URL's prefix; the URL is never printed.
base="${DATABASE_URL%/*}"
admin_url="$base/postgres"
drill_url="$base/$WADL_DRILL_DB"
statement=reference/cvn73/CVN73-hull.json
org="$(jq -r .organization.org_id "$statement")"
hull="$(jq -r .vessel.vessel_id "$statement")"
hull_no="$(jq -r .vessel.hull_no "$statement")"
backups="$(mktemp -d)"
serve_pid=""
started="$(date +%s)"

cleanup() {
  if [ -n "$serve_pid" ]; then kill "$serve_pid" 2>/dev/null || true; fi
  if [ -z "${WADL_DRILL_KEEP:-}" ]; then
    psql -q "$admin_url" -c "DROP DATABASE IF EXISTS \"$WADL_DRILL_DB\"" >/dev/null 2>&1 || true
    rm -rf "$backups"
  else
    printf 'kept: database %s, backups in %s\n' "$WADL_DRILL_DB" "$backups"
  fi
}
trap cleanup EXIT

recreate() {
  psql -q "$admin_url" -c "DROP DATABASE IF EXISTS \"$WADL_DRILL_DB\"" >/dev/null
  psql -q "$admin_url" -c "CREATE DATABASE \"$WADL_DRILL_DB\"" >/dev/null
}

step "create scratch database $WADL_DRILL_DB"
recreate
ok "created"

step "wadl migrate"
"$WADL_BIN" migrate --database-url "$drill_url" || fail "migrate"

step "wadl bootstrap-hull --statement $statement"
"$WADL_BIN" bootstrap-hull --statement "$statement" --database-url "$drill_url" | tee "$backups/bootstrap.log" || fail "bootstrap-hull"
[ "$(grep -c ' created ' "$backups/bootstrap.log")" -ge 4 ] || fail "bootstrap-hull did not create the four rows"

step "wadl load-docs --dir reference/cvn73 --xer reference/p6-sample/CVN73-PIA26-full.xer"
"$WADL_BIN" load-docs --dir reference/cvn73 --xer reference/p6-sample/CVN73-PIA26-full.xer \
  --org "$org" --vessel "$hull" --database-url "$drill_url" || fail "load-docs"

step "scripts/backup.sh"
DATABASE_URL="$drill_url" WADL_BIN="$WADL_BIN" scripts/backup.sh "$backups" || fail "backup.sh"
dump="$(ls "$backups"/wadl-*.dump)"
manifest="${dump%.dump}.manifest.json"
[ "$(jq -r .ledger_verified "$manifest")" = true ] || fail "manifest says the ledger did not verify"
rows_before="$(jq -r --arg h "$hull_no" '.hulls[] | select(.hull_no == $h) | .ledger_rows' "$manifest")"
ok "manifest: $hull_no · $rows_before ledger rows"

step "restore.sh refuses without --yes (expected exit 2)"
if DATABASE_URL="$drill_url" WADL_BIN="$WADL_BIN" scripts/restore.sh "$dump" >/dev/null 2>&1; then
  fail "restore.sh ran without --yes"
else
  [ $? -eq 2 ] || fail "restore.sh without --yes exited with the wrong code"
fi
ok "refused"

step "restore.sh refuses a populated target without --replace (expected exit 2)"
if DATABASE_URL="$drill_url" WADL_BIN="$WADL_BIN" scripts/restore.sh "$dump" --yes >/dev/null 2>&1; then
  fail "restore.sh overwrote a populated target without --replace"
else
  [ $? -eq 2 ] || fail "restore.sh on a populated target exited with the wrong code"
fi
ok "refused"

step "drop and recreate $WADL_DRILL_DB, wadl migrate on the empty target (the role must exist)"
recreate
"$WADL_BIN" migrate --database-url "$drill_url" >/dev/null || fail "migrate on the empty target"
ok "empty, migrated"

step "scripts/restore.sh $dump --yes"
DATABASE_URL="$drill_url" WADL_BIN="$WADL_BIN" scripts/restore.sh "$dump" --yes || fail "restore.sh"

step "wadl verify-ledger after the restore"
"$WADL_BIN" verify-ledger --database-url "$drill_url" || fail "verify-ledger after restore"

step "serve the restored database on loopback"
port=""
for candidate in $(seq 18080 18180); do
  if ! (exec 3<>"/dev/tcp/127.0.0.1/$candidate") 2>/dev/null; then port="$candidate"; break; fi
done
[ -n "$port" ] || fail "no free loopback port"
DATABASE_URL="$drill_url" WADL_PORT="$port" "$WADL_SERVE_BIN" > "$backups/serve.log" 2>&1 &
serve_pid=$!
for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$port/health" >/dev/null 2>&1 && break
  kill -0 "$serve_pid" 2>/dev/null || { cat "$backups/serve.log"; fail "serve exited"; }
  sleep 0.5
done
health="$(curl -sf "http://127.0.0.1:$port/health")" || { cat "$backups/serve.log"; fail "/health unreachable"; }
ok "serving on 127.0.0.1:$port"

step "/health reads the stamp and schema_state: current"
echo "$health" | jq -e '.schema_state == "current" and .version.git != "unknown" and ((.version.schema | tonumber) == (.store.schema_version | tonumber))' >/dev/null \
  || { echo "$health" | jq .; fail "/health"; }
ok "$(echo "$health" | jq -r '"\(.version.git) · schema \(.version.schema) · \(.store.backend) · \(.schema_state)"')"

hdr=(-H "x-org-id: $org" -H "x-assigned-vessels: $hull")
step "GET /api/vessels/$hull_no/compartments counts 476"
spaces="$(curl -sf "${hdr[@]}" "http://127.0.0.1:$port/api/vessels/$hull/compartments" | jq 'length')"
[ "$spaces" = 476 ] || fail "compartments: $spaces"
ok "$spaces spaces"

step "GET …/ledger reads verified: true, HULL_BOOTSTRAPPED first, SCHEDULE_REPLACED last"
ledger="$(curl -sf "${hdr[@]}" "http://127.0.0.1:$port/api/vessels/$hull/ledger")"
echo "$ledger" | jq -e '.verified == true and (.entries | last.action) == "HULL_BOOTSTRAPPED" and (.entries | first.action) == "SCHEDULE_REPLACED"' >/dev/null \
  || { echo "$ledger" | jq -c '{verified, actions: [.entries[].action]}'; fail "ledger"; }
rows_after="$(echo "$ledger" | jq '.entries | length')"
[ "$rows_after" = "$rows_before" ] || fail "ledger has $rows_after rows, the manifest said $rows_before"
ok "verified · $rows_after rows · $(echo "$ledger" | jq -r '[.entries[].action] | reverse | join(" → ")')"

kill "$serve_pid"; wait "$serve_pid" 2>/dev/null || true; serve_pid=""
elapsed=$(( $(date +%s) - started ))
printf 'drill: PASS in %s s\n' "$elapsed"
