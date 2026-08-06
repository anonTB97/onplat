# shell-web — the Shipyard AI Onboard shell (skeleton)

TypeScript + React + Vite (see `docs/adr/0004-frontend-typescript-react.md`).
This is the milestone-1 skeleton: the shell chrome (guardrail strip, hull
context with the OUT OF SCOPE banner, module rail) rendering live data from
`wadl-api`.

## Run

From the repo root, one command starts the API and this shell together:

```
scripts/dev.sh                   # → http://localhost:5173
```

Or by hand, in two terminals:

```
cargo run -p wadl-api --bin serve   # 1. the API, on 127.0.0.1:8080
cd shell-web && npm install && npm run dev   # 2. Vite proxies /api and /health to :8080
```

## Notes

- **No external hosts.** Everything is vendored and bundled (invariant 5); the
  dev server only proxies to the local API.
- **Identity is a dev shim** (`src/demo.ts`): `x-org-id` + `x-assigned-vessels`
  headers matching the API's extractor. The seeded planner is assigned to the
  three carriers; picking the DDG or LPD shows the OUT OF SCOPE banner and the
  server returns 404 — the RBAC refusal made visible.
- **The engine belongs in WASM.** `wadl-engine` compiles to
  `wasm32-unknown-unknown` today; the `wasm-bindgen` wrapper that imports it
  here (so the browser runs the same pre-check code as the server) is the next
  frontend step. Until then, authorization state is read from the API's
  engine-backed endpoint, never computed in the client.
