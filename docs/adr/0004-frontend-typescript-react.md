# ADR 0004 — The shell is TypeScript + React + Vite, with the engine in WASM

Status: accepted (milestone 1)

## Context

The build prompt offers two defensible frontends: TypeScript + React + Vite, or
Leptos (Rust/WASM end to end). The shell is a dense desktop surface: virtualised
tables, thirteen SVG deck sheets with pan/zoom, a sequence board with stacked
overlapping work, and a what-if sandbox — all shown in the prototype.

## Decision

**TypeScript + React + Vite**, with `wadl-engine` compiled to WASM and imported,
so the browser runs the *same* pre-check code as the server (ADR 0001).

Rationale, briefly:

- The highest-risk UI work here is the data grid and the drawing interaction.
  React's ecosystem for virtualised tables and SVG interaction is mature and
  battle-tested; Leptos would put that risk on the critical path.
- The invariant that matters — one engine, every surface — is satisfied either
  way, because the engine is a separate pure crate compiled to WASM. We get the
  single-decision-code guarantee without betting the UI on a younger ecosystem.
- Leptos's advantage (one language) does not outweigh the grid/drawing risk for
  a surface this dense.

## Consequences

- Everything is vendored: no Google Fonts, no icon CDN, no external anything
  (invariant 5). `reference/assets/` holds the deck drawings and logo.
- `shell-web/` is a Vite project. The engine is exposed to it via a
  `wasm-bindgen` wrapper crate (planned) so the same traversal that runs on the
  server runs in the browser for pre-checks.
- If drawing performance later demands it, individual hot paths can drop to
  WASM without changing the framework decision.
