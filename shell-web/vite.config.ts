import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// No external hosts: everything is vendored and bundled (invariant 5). The dev
// server proxies /api and /health to the local wadl-api during development.
//
// The target follows WADL_PORT so it stays in step with `serve`, which reads the
// same variable. Two places holding the same hardcoded port is how a dev setup
// starts failing in a way that looks like an application bug.
const api = `http://127.0.0.1:${process.env.WADL_PORT ?? "8080"}`;

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": api,
      "/health": api,
    },
  },
});
