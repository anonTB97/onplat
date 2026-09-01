#!/usr/bin/env bash
# The load test the production plan calls for: a key-op-grain schedule
# (~40k activities) through the import door, then the read surface measured
# under sequential, concurrent, and shed conditions — release build, demo
# store by default; run with DATABASE_URL set to measure the PostgreSQL path.
#
# Usage: scripts/stress-test.sh [clones]   (default 26 → ~40.6k activities)
set -euo pipefail
cd "$(dirname "$0")/.."

CLONES="${1:-26}"
PORT="${WADL_STRESS_PORT:-8091}"
VESSEL="00000000-0000-0000-0000-000000000073"
OUT="${TMPDIR:-/tmp}/stress-$CLONES.xer"

echo "== build (release) =="
cargo build --release -p wadl-api --bin serve

echo "== generate =="
python3 scripts/stress/gen-xer.py reference/p6-sample/CVN73-PIA26-full.xer "$OUT" "$CLONES"
ls -la "$OUT"

boot() { # boot serve with the given extra env; echoes the pid
  env WADL_PORT="$PORT" "$@" ./target/release/serve >"${TMPDIR:-/tmp}/stress-serve.log" 2>&1 &
  local pid=$!
  for _ in $(seq 1 50); do
    curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
    sleep 0.2
  done
  echo "$pid"
}

rss() { awk '/VmRSS/{print $2/1024 " MB"}' "/proc/$1/status"; }

echo "== phase: import + latency + concurrency (default limits) =="
PID="$(boot)"
echo "RSS before import: $(rss "$PID")"
python3 scripts/stress/drive.py "http://127.0.0.1:$PORT" "$VESSEL" "$OUT" import latency concurrency
echo "RSS after: $(rss "$PID")"
kill "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true

echo "== phase: shed (WADL_MAX_IN_FLIGHT=4) =="
PID="$(boot WADL_MAX_IN_FLIGHT=4)"
python3 scripts/stress/drive.py "http://127.0.0.1:$PORT" "$VESSEL" "$OUT" import shed
kill "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true

echo "== done =="
