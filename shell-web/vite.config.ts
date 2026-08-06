import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// No external hosts: everything is vendored and bundled (invariant 5). The dev
// server proxies /api and /health to the local wadl-api during development.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8080",
      "/health": "http://127.0.0.1:8080",
    },
  },
});
