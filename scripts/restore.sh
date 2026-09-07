#!/usr/bin/env bash
# Restore a WADL backup taken by scripts/backup.sh into DATABASE_URL.
#
#   DATABASE_URL=postgres://… scripts/restore.sh <dump> [--replace] [--yes]
#
# Refuses (exit 2) when the sidecar checksum does not match, when the target
# already holds any hull unless --replace is given, and without --yes — in
# which case it prints what it would do. With --yes it runs
# pg_restore --clean --if-exists --no-owner, then `wadl migrate` (applies
# anything newer than the dump — the upgrade-after-restore path; a no-op
# otherwise), then `wadl verify-ledger`, and prints the hulls and ledger
# lengths from the manifest beside the restored counts.
#
# Prerequisite: the role `wadl_app` exists in the target cluster. Any prior
# `wadl migrate` in that cluster created it; on a cluster that never ran
# WADL, run `wadl migrate` against the empty target first, then restore —
# the dump's grants name the role and fail readably without it.
#
# Needs: pg_restore and psql on PATH (client major ≥ the server's), the
# `wadl` binary at WADL_BIN (default target/release/wadl), jq. DATABASE_URL
# is used to connect and is never printed.
set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL (it is never echoed)}"
WADL_BIN="${WADL_BIN:-target/release/wadl}"

step()   { printf '→ %s\n' "$*"; }
ok()     { printf '✓ %s\n' "$*"; }
fail()   { printf '✗ %s\n' "$*" >&2; exit 1; }
refuse() { printf '✗ refused: %s\n' "$*" >&2; exit 2; }

dump=""; replace=false; yes=false
for arg in "$@"; do
  case "$arg" in
    --replace) replace=true ;;
    --yes) yes=true ;;
    -*) refuse "unknown flag $arg (usage: restore.sh <dump> [--replace] [--yes])" ;;
    *) dump="$arg" ;;
  esac
done
[ -n "$dump" ] || refuse "no dump named (usage: restore.sh <dump> [--replace] [--yes])"
[ -f "$dump" ] || refuse "$dump does not exist"
for tool in pg_restore psql jq sha256sum; do
  command -v "$tool" >/dev/null || fail "$tool is not on PATH"
done
[ -x "$WADL_BIN" ] || fail "WADL_BIN=$WADL_BIN is not an executable"

step "check the sidecar checksum"
[ -f "$dump.sha256" ] || refuse "$dump.sha256 is missing — a dump without its checksum is not restored"
( cd "$(dirname "$dump")" && sha256sum -c --quiet "$(basename "$dump").sha256" ) || refuse "checksum mismatch on $dump"
ok "checksum matches"

manifest="${dump%.dump}.manifest.json"
if [ -f "$manifest" ]; then
  ok "manifest: $(jq -c '{schema, git, taken_at, ledger_verified, hulls: (.hulls | length)}' "$manifest")"
else
  printf '! no manifest beside the dump; restoring without the record\n'
fi

step "check the target"
present="$(psql "$DATABASE_URL" -Atc "SELECT count(*) FROM vessel" 2>/dev/null || echo 0)"
if [ "$present" -gt 0 ] && [ "$replace" = false ]; then
  refuse "the target already holds $present hull(s); pass --replace to overwrite them"
fi
ok "target holds $present hull(s)$( [ "$present" -gt 0 ] && printf ' — will be replaced' )"

if [ "$yes" = false ]; then
  printf '\nThis would:\n'
  printf '  1. pg_restore --clean --if-exists --no-owner %s into the target\n' "$dump"
  printf '  2. wadl migrate (apply migrations newer than the dump, if any)\n'
  printf '  3. wadl verify-ledger against the restored database\n'
  refuse "pass --yes to do it"
fi

step "pg_restore --clean --if-exists --no-owner"
# pg_restore exits 1 when it ignored errors (e.g. a DROP of an object the
# target never had); the verify and counts below are the real test.
if pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" "$dump"; then
  ok "restored"
else
  printf '! pg_restore reported ignored errors (exit %s); checking the result\n' "$?"
fi

step "wadl migrate (anything newer than the dump)"
"$WADL_BIN" migrate --database-url "$DATABASE_URL"

step "wadl verify-ledger"
"$WADL_BIN" verify-ledger --database-url "$DATABASE_URL"
ok "every restored chain verifies"

step "restored counts beside the manifest"
restored="$(psql "$DATABASE_URL" -Atc "
  SELECT coalesce(json_agg(json_build_object('hull_no', hull_no, 'ledger_rows', ledger_rows) ORDER BY hull_no), '[]'::json)
    FROM (SELECT v.hull_no, count(a.entry_id) AS ledger_rows
            FROM vessel v LEFT JOIN audit_entry a ON a.vessel_id = v.vessel_id
           GROUP BY v.hull_no) h")"
if [ -f "$manifest" ]; then
  expected="$(jq -c '.hulls' "$manifest")"
  if [ "$(jq -cS . <<<"$expected")" = "$(jq -cS . <<<"$restored")" ]; then
    ok "hulls and ledger lengths match the manifest: $(jq -c . <<<"$restored")"
  else
    printf '✗ restored %s but the manifest said %s\n' "$restored" "$expected" >&2
    exit 1
  fi
else
  ok "restored: $(jq -c . <<<"$restored")"
fi
ok "restore complete"
