#!/usr/bin/env bash
# The CVN-scale load test behind docs/stress-test.md and
# docs/council/3-data-and-performance.md: generate a carrier-density hull
# (~3,300 spaces, ~45k activities, ~36k relationships, 400 live hazards, a
# 30-month availability) with the two generators, boot the release binary on
# it, and measure boot, RSS, per-endpoint p50/p95 at 1 and 10 clients, the
# schedule-of-record door, a hazard clear under readers and the run diff —
# with tools/load_test.mjs (Node, no dependency). With DATABASE_URL set and a
# postgres-feature build, the same hull is bootstrapped and loaded through
# `wadl bootstrap-hull` + `wadl load-docs` into a scratch tenant and the
# reads repeated against the PostgreSQL store.
#
# Usage: scripts/load-test.sh [--scale 7] [--hazards 400] [--months 30]
#                             [--chain-scale 1.3] [--out DIR] [--pg]
#   --pg   also run the PostgreSQL path (needs DATABASE_URL and
#          `cargo build --release -p wadl-api -p wadl-cli --bin serve
#           --bin wadl --features wadl-api/postgres`)
# The generated data is never committed: it lands under --out (default
# ${TMPDIR:-/tmp}/wadl-scale) and is a function of the seeds.
#
# Read the cautions in docs/stress-test.md before pointing this at a shared
# box: the register-shaped endpoints run for minutes at this scale, and a
# handler on the memory store cannot be cancelled once started.
set -euo pipefail
cd "$(dirname "$0")/.."

SCALE=7; HAZARDS=400; MONTHS=30; CHAIN=1.3; PG=0
OUT="${TMPDIR:-/tmp}/wadl-scale"
while [ $# -gt 0 ]; do
  case "$1" in
    --scale) SCALE="$2"; shift 2 ;;
    --hazards) HAZARDS="$2"; shift 2 ;;
    --months) MONTHS="$2"; shift 2 ;;
    --chain-scale) CHAIN="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --pg) PG=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
PORT="${WADL_LOAD_PORT:-8092}"
VESSEL=00000000-0000-0000-0000-000000000073
ORG=00000000-0000-0000-0000-000000000001
XER="$OUT/CVN73-PIA26-scale.xer"

echo "== generate (scale $SCALE, $HAZARDS hazards, $MONTHS months, chain ×$CHAIN) → $OUT =="
mkdir -p "$OUT"
python3 tools/gen_cvn73_hull.py --scale "$SCALE" --hazards "$HAZARDS" --out "$OUT"
cp reference/cvn73/CVN73-clock.csv reference/cvn73/CVN73-fieldmap.json reference/cvn73/CVN73-rule-table.csv "$OUT/"
python3 tools/gen_full_xer.py --register "$OUT/CVN73-register.csv" --out "$XER" --months "$MONTHS" --chain-scale "$CHAIN"

rss() { awk '/VmRSS/{print $2/1024 " MB"}' "/proc/$1/status"; }
hwm() { awk '/VmHWM/{print $2/1024 " MB"}' "/proc/$1/status"; }
boot() { # boot serve with the given env; prints the pid; records boot time
  local t0 t1
  t0=$(date +%s.%N)
  env WADL_PORT="$PORT" "$@" >"$OUT/serve.log" 2>&1 &
  local pid=$!
  for _ in $(seq 1 1200); do
    curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
    sleep 0.05
  done
  t1=$(date +%s.%N)
  echo "boot-to-health: $(echo "$t1 - $t0" | bc) s · RSS $(rss "$pid")" >&2
  echo "$pid"
}
stop() { kill "$1" 2>/dev/null || true; sleep 1; kill -9 "$1" 2>/dev/null || true; wait "$1" 2>/dev/null || true; }
measure() { # $1 base, $2 org, $3 vessel, $4 clear hazard
  local L="node tools/load_test.mjs --base $1 --org $2 --vessel $3"
  echo "### cheap reads"
  $L --only "compartments,compartment state,zones/Z4/adjacent,hazards,ledger,schedule-runs" --samples 10 --conc 1,10 latency
  echo "### map surface"
  $L --only "deck-states,readiness" --samples 4 --conc 1,10 --timeout 600000 latency
  echo "### register-shaped, one client, 600 s cap (see docs/stress-test.md: minutes at this scale)"
  $L --only "activities,work-conflicts,schedule-alternatives,issues,leverage" --samples 1 --conc 1 --timeout 600000 latency
  echo "### the door"
  $L --xer "$XER" --timeout 1500000 import
  echo "### a clear under readers"
  $L --clear "$4" --conc 10 --timeout 600000 clear
  echo "### the diff"
  $L --samples 2 --conc 1,4 --timeout 1500000 diff
}
CLEAR="$(awk -F, '!/^#/ && $2=="hot_work_live" {print $1":"$2; exit}' "$OUT/CVN73-hazards.csv")"

echo "== memory store (release build) =="
cargo build --release -p wadl-api --bin serve
PID="$(boot env WADL_DEMO_DOCS="$OUT" WADL_SCHEDULE_XER="$XER" ./target/release/serve)"
measure "http://127.0.0.1:$PORT" "$ORG" "$VESSEL" "$CLEAR"
echo "RSS after: $(rss "$PID") · peak $(hwm "$PID")"
stop "$PID"

if [ "$PG" = 1 ]; then
  : "${DATABASE_URL:?--pg needs DATABASE_URL}"
  echo "== PostgreSQL store =="
  cargo build --release -p wadl-api -p wadl-cli --bin serve --bin wadl --features wadl-api/postgres
  PORG=00000000-0000-0000-0000-00000000d001
  PVES=00000000-0000-0000-0000-00000000d073
  cat >"$OUT/hull.json" <<EOF
{"organization":{"org_id":"$PORG","kind":"shipbuilder","name":"Load Test Yard","country":"USA"},
 "class":{"class_id":"00000000-0000-0000-0000-0000000d0068","code":"CVN-68L","name":"Nimitz class (load test)","hull_type":"CVN","frame_min":1,"frame_max":273},
 "vessel":{"vessel_id":"$PVES","hull_no":"CVN-73L","name":"Load test hull"},
 "availability":{"availability_id":"00000000-0000-0000-0000-0000000ad073","code":"PIA-26L","kind":"PIA","location":"Graving Dry Dock 4","start_on":"2026-07-01","end_on":"2029-01-31"}}
EOF
  ./target/release/wadl bootstrap-hull --statement "$OUT/hull.json"
  time ./target/release/wadl load-docs --dir "$OUT" --xer "$XER" --org "$PORG" --vessel "$PVES" --person loadtest | grep -v "wall clock:"
  PID="$(boot ./target/release/serve)"
  measure "http://127.0.0.1:$PORT" "$PORG" "$PVES" "$CLEAR"
  echo "RSS after: $(rss "$PID") · peak $(hwm "$PID")"
  stop "$PID"
fi
echo "== done =="
