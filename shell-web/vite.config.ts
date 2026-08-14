import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// No external hosts: everything is vendored and bundled (invariant 5). The dev
// server proxies /api and /health to the local wadl-api during development.
//
// The target follows WADL_PORT so it stays in step with `serve`, which reads the
// same variable. Two places holding the same hardcoded port is how a dev setup
// starts failing in a way that looks like an application bug.
// Parsed and range-checked, falling back exactly as `serve` does on a bad value.
// Passing the raw string through would proxy to a port `serve` is not listening on
// while `serve` fell back to 8080 — reproducing the "looks like an application bug"
// failure this variable exists to remove.
const port = Number(process.env.WADL_PORT);
const api = `http://127.0.0.1:${Number.isInteger(port) && port > 0 && port < 65536 ? port : 8080}`;

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": api,
      "/health": api,
    },
  },
});
