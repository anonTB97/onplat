# shell-web — the Shipyard AI Onboard shell (skeleton)

TypeScript + React + Vite (see `docs/adr/0004-frontend-typescript-react.md`).
This is the milestone-1 skeleton: the shell chrome (guardrail strip, hull
context with the OUT OF SCOPE banner, module rail) rendering live data from
`wadl-api`.

## Run

```
# 1. start the API (from the repo root)
cargo run -p wadl-api --bin serve   # serves on 127.0.0.1:8080

# 2. start the shell
cd shell-web
npm install
npm run dev                      # Vite proxies /api and /health to :8080
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
