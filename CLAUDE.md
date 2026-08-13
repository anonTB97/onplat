# Working in this repository

Shipyard AI Onboard + WADL: availability planning and work authorization for
naval shipyards. Rust cargo workspace (`crates/`) + React/Vite shell
(`shell-web/`). The demo is built under production discipline on purpose —
read `docs/production-posture.md` before adding anything; it is the standing
plan and every slice is expected to advance it, or at minimum not regress it.

## Production/ATO philosophy (applies to every change)

- **No new dependencies without passing the admission test** in
  docs/production-posture.md §Pillar 1. Prefer std/tokio/~100 owned lines.
  Dev-and-test tooling goes in `[dev-dependencies]`, never the binary.
  Deployment-specific needs go behind a cargo feature, default off
  (pattern: `wadl-store`'s `postgres` feature).
- **The engine stays pure**: no I/O, no async, no wall clock (inject
  `Clock`), must build on wasm32. CI enforces this; don't fight it.
- **Identity enters in one place** (`wadl-api/src/auth.rs`). Every scoped
  handler runs the extractor first — scope check before body read, always.
  New routes must be added to `routes::inventory` and get a generated leak
  test (`cargo run -p xtask -- gen-leak-tests`).
- **Imports are all-or-nothing** with dry-run preview, typed refusals, and
  revert. Never commit a partial document; never parse before the scope
  check; respect `MAX_IMPORT_BYTES` at the three import doors only.
- **Server computes, shell renders.** Findings, verdicts, alternatives, and
  WHY-prose are served; the shell never derives an authorization truth.
- **Middleware is hand-rolled** in `wadl-api::hardening` on tokio
  primitives. Extend that module rather than adding tower-http et al.
- The lint wall is part of the product: no `unsafe`, no `unwrap`/`expect`/
  `panic`/indexing in non-test code, `-D warnings`, `--locked` in CI. Run
  `cargo fmt --all && cargo clippy --workspace --all-targets --all-features
  -- -D warnings` before committing; also featureless `cargo test
  --workspace` (this proves the no-sqlx tree still stands).

## Conventions

- UI: dark theme tokens in `shell-web/src/theme.ts`; message convention
  ✓ green / ⏳ amber / red (`msgColor`); destructive actions use the
  two-step `DiscardButton`; Escape closes panels; fetches carry stale
  guards; man-hours format via `mh()`. One pro-rating rule for windowed
  load lives in `shell-web/src/windowLoad.ts` — use it, don't re-derive.
- Dev servers: API `cargo run -p wadl-api --bin serve` (WADL_PORT, demo
  identity printed at startup); shell `npx vite --port 5173 --strictPort`
  in shell-web. Single-binary mode: set `WADL_STATIC_DIR=shell-web/dist`.
- Commit and push every completed slice immediately to the designated
  branch. Never put model identifiers in committed artifacts.
