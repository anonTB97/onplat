#!/usr/bin/env bash
# Runs once when the container is created. Everything slow happens here, so that
# `scripts/dev.sh` is quick when someone is sitting at a terminal waiting for it.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "→ toolchain (pinned by rust-toolchain.toml)"
rustup show

echo "→ wasm target, so the engine's purity check can be run locally"
rustup target add wasm32-unknown-unknown

echo "→ shell dependencies"
(cd shell-web && npm ci --no-audit --no-fund)

# Warm the build now rather than making the first `dev.sh` take five minutes.
echo "→ pre-building the demo API"
cargo build -p wadl-api --bin serve

echo
echo "Ready. Start everything with:  scripts/dev.sh"
