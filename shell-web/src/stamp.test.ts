// The bottom band's stamp: parsed from /health, honest when absent.

import { describe, expect, it } from "vitest";
import type { Health } from "./api";
import { stampOf } from "./stamp";

describe("stampOf", () => {
  it("reads the commit, the schema and the backend", () => {
    const h: Health = {
      status: "ok",
      identity_mode: "dev-headers",
      version: { git: "df18c59", built_at: "2026-09-04T21:23:37+00:00", schema: "0018", document_schema: 1 },
      schema_state: "current",
      store: { backend: "postgresql", reachable: true, schema_version: "18" },
    };
    expect(stampOf(h)).toBe("df18c59 · schema 0018 · postgresql");
  });

  it("tolerates an older server with no version block", () => {
    const h: Health = { status: "ok", identity_mode: "dev-headers" };
    expect(stampOf(h)).toBe("version unavailable");
    expect(stampOf(null)).toBe("version unavailable");
    expect(stampOf(undefined)).toBe("version unavailable");
  });

  it("names a missing store block rather than guessing", () => {
    const h: Health = {
      status: "ok",
      identity_mode: "dev-headers",
      version: { git: "abc1234", built_at: "x", schema: "0018", document_schema: 1 },
    };
    expect(stampOf(h)).toBe("abc1234 · schema 0018 · store unknown");
  });
});
