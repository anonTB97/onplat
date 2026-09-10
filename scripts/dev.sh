#!/usr/bin/env bash
# Launch the whole demo with one command: the API, then the shell.
#
#   scripts/dev.sh
#
# The API binds LOOPBACK ONLY (127.0.0.1:8080) and stays there — the shell's dev
# server proxies to it from inside the same machine/container, so the backend is
# never exposed. Only the shell's port (5173) is meant to be opened.
#
# Ctrl-C stops both. So does either one exiting on its own: leaving a half-dead
# pair behind means the next run fails on "address already in use", which reads
# like a broken repo rather than a stale process.
set -euo pipefail

cd "$(dirname "$0")/.."

API_PORT=8080
SHELL_PORT=5173
api_pid=""
shell_pid=""

# Signal a process and everything it spawned. `npm run dev` is a wrapper around
# a shell around node, so killing the pid we know about would orphan the actual
# dev server.
kill_tree() {
  local pid=$1
  [[ -z "$pid" ]] && return 0
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

cleanup() {
  trap - EXIT INT TERM  # don't re-enter while we are tearing down
  [[ -n "$shell_pid" ]] && kill_tree "$shell_pid"
  if [[ -n "$api_pid" ]]; then
    echo
    echo "→ stopping the API"
    kill_tree "$api_pid"
  fi
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "→ building the API"
echo "  (first build is cold and takes a few minutes)"
# A release build: the demo hull is carrier-sized (docs/zone-scheme.md), and
# the issue board over 5,700 activities is a two-second read in debug and a
# third of a second in release. WADL_PROFILE=debug keeps the fast compile.
profile="${WADL_PROFILE:-release}"
if [[ "$profile" == "release" ]]; then
  cargo build -q --release -p wadl-api --bin serve
else
  cargo build -q -p wadl-api --bin serve
fi

# Run the binary directly rather than through `cargo run`. cargo would sit
# between us and the server as a parent that does not forward signals, so
# shutdown would depend on walking its children; owning the pid makes teardown
# immediate and unambiguous.
serve_bin="${CARGO_TARGET_DIR:-target}/${profile}/serve"
# The demo boots on the reference hull — the documents in reference/cvn73
# through the doors' own paths, and the sample P6 export as the schedule of
# record. WADL_DEMO=seed serves the 24-space seed instead.
demo_env=()
if [[ "${WADL_DEMO:-hull}" != "seed" ]]; then
  demo_env=(WADL_DEMO_DOCS=reference/cvn73 WADL_SCHEDULE_XER=reference/p6-sample/CVN73-PIA26-full.xer)
  echo "→ demo hull: reference/cvn73 + CVN73-PIA26-full.xer (WADL_DEMO=seed for the seed alone)"
fi
echo "→ starting the API on 127.0.0.1:${API_PORT}"
env "${demo_env[@]}" "$serve_bin" &
api_pid=$!

# Wait for the API to answer rather than guessing at a sleep: if the shell comes
# up first it renders "API unreachable", which looks like a bug and is not one.
echo -n "→ waiting for the API"
for _ in $(seq 1 300); do
  if curl -sf "http://127.0.0.1:${API_PORT}/health" >/dev/null 2>&1; then
    echo " — up"
    break
  fi
  # If the build failed, say so instead of spinning for five minutes.
  if ! kill -0 "$api_pid" 2>/dev/null; then
    echo
    echo "✗ the API exited before becoming healthy — see the build output above" >&2
    exit 1
  fi
  echo -n "."
  sleep 1
done

if ! curl -sf "http://127.0.0.1:${API_PORT}/health" >/dev/null 2>&1; then
  echo
  echo "✗ the API did not become healthy in time" >&2
  exit 1
fi

if [[ ! -d shell-web/node_modules ]]; then
  echo "→ installing shell dependencies"
  (cd shell-web && npm install --no-audit --no-fund)
fi

echo "→ starting the shell on port ${SHELL_PORT}"
echo
echo "   Open http://localhost:${SHELL_PORT}"
echo "   (in a Codespace, click the forwarded ${SHELL_PORT} link in the Ports tab)"
echo
# --host binds 0.0.0.0 so a container's port forwarding can reach it.
#
# Backgrounded and waited on, deliberately NOT `exec`: exec would replace this
# shell and discard the trap above, leaving the API running after the dev server
# stops.
(cd shell-web && npm run dev -- --host --port "${SHELL_PORT}" --strictPort) &
shell_pid=$!
wait "$shell_pid"
