// The shell's share of the identity contract, pinned: what the dev shim
// asserts, what the proxy mode does not, and that a greyed button says the
// same words as the server's 403.

import { describe, expect, it } from "vitest";
import type { VesselSummary, WhoAmI } from "./api";
import { CVN73, DDG, DEMO_PEOPLE, LPD, YARD_ORG } from "./demo";
import {
  can,
  devIdentityFor,
  hullChoicesFrom,
  identityFromHealth,
  identityHeaders,
  problemSentence,
  refusalSentence,
  ROLES,
} from "./identity";

const cvn73: VesselSummary = {
  vessel_id: CVN73,
  hull_no: "CVN-73",
  name: "USS George Washington",
  class_code: "CVN-68",
  availability_code: "PIA-26",
  confidence: "At Risk",
  availability: null,
};

/** A `whoami` answer as the server shapes it, with the real matrix. */
function who(over: Partial<WhoAmI>): WhoAmI {
  return {
    identity_mode: "dev-headers",
    org: YARD_ORG,
    assigned_vessels: [CVN73],
    person: { id: "dev:foreman", name: "Demo Foreman (Y-1006)", source: "dev-shim" },
    roles: ["foreman"],
    capabilities: ["read", "raise_hazard"],
    hulls: [cvn73],
    role_matrix: {
      planner: ["raise_hazard", "commit_document", "propose", "decide"],
      ship_super: ["raise_hazard", "clear_hazard", "propose", "decide"],
      safety: ["raise_hazard", "clear_hazard", "decide"],
      zone_manager: ["raise_hazard", "decide"],
      production_super: ["raise_hazard", "decide"],
      foreman: ["raise_hazard"],
      project_manager: ["decide"],
      reader: [],
    },
    warnings: [],
    markings: ["A", "B"],
    decision_support_only: true,
    ...over,
  };
}

describe("identity", () => {
  it("a dev identity for a role sends that role and its demo person, name percent-encoded", () => {
    const id = devIdentityFor("safety");
    const h = identityHeaders(id);
    expect(h["x-org-id"]).toBe(YARD_ORG);
    expect(h["x-assigned-vessels"]).toContain(CVN73);
    expect(h["x-wadl-roles"]).toBe("safety");
    expect(h["x-wadl-person"]).toBe("dev:safety");
    expect(h["x-wadl-person-name"]).toBe("Demo%20Safety%20Officer%20(Y-1007)");
    // Every demo person id is inside the contract's charset — a role code's
    // underscore would be refused with a 401, so the ids use hyphens.
    for (const role of ROLES) {
      expect(DEMO_PEOPLE[role].id).toMatch(/^[A-Za-z0-9._:@/-]{1,128}$/);
      expect(DEMO_PEOPLE[role].id.startsWith("dev:")).toBe(true);
    }
    expect(identityFromHealth("dev-headers", "planner")).toEqual(devIdentityFor("planner"));
  });

  it("a proxy identity sends no identity headers", () => {
    const id = identityFromHealth("proxy-asserted", "planner");
    expect(id).toEqual({ mode: "proxy" });
    expect(identityHeaders(id)).toEqual({});
    // An unknown mode is not the shim: the shell must not assert on a guess.
    expect(identityHeaders(identityFromHealth("something-else", "planner"))).toEqual({});
  });

  it("can() reads capabilities, never role names", () => {
    const foreman = who({});
    expect(can(foreman, "raise_hazard")).toBe(true);
    expect(can(foreman, "clear_hazard")).toBe(false);
    // The server said this foreman may clear — the shell believes the
    // capability list, not its own idea of what a foreman is.
    const widened = who({ capabilities: ["read", "clear_hazard"] });
    expect(can(widened, "clear_hazard")).toBe(true);
    expect(can(widened, "raise_hazard")).toBe(false);
    // No answer, no door.
    expect(can(null, "read")).toBe(false);
  });

  it("hull choices come from whoami, with the unassigned demo hulls only in demo mode", () => {
    const answer = who({});
    const dev = hullChoicesFrom(answer, "dev");
    expect(dev.map((h) => h.id)).toEqual([CVN73, DDG, LPD]);
    expect(dev[0]?.label).toBe("CVN-73 · PIA-26");
    expect(dev[0]?.vessel).toBe(cvn73);
    expect(dev[1]?.vessel).toBeUndefined();
    expect(dev[1]?.label).toContain("not assigned · demo");
    const proxy = hullChoicesFrom(answer, "proxy");
    expect(proxy.map((h) => h.id)).toEqual([CVN73]);
    // No answer is no list — never an empty picker that reads as "no hulls".
    expect(hullChoicesFrom(null, "dev")).toEqual([]);
  });

  it("the refusal sentence names the role and who holds the capability", () => {
    expect(refusalSentence("clear_hazard", who({}))).toBe(
      "Foreman may not record a clearance — clear_hazard is held by Ship Super and Safety",
    );
    expect(refusalSentence("commit_document", who({ roles: ["foreman", "reader"] }))).toBe(
      "Foreman and Reader may not commit or revert a document — commit_document is held by Planner",
    );
    expect(refusalSentence("decide", who({ roles: [] }))).toBe(
      "A person with no recognised role may not answer for an option or an issue — decide is held by Planner, Ship Super, Safety, Zone Manager, Production Super and Project Manager",
    );
    expect(refusalSentence("decide", null)).toContain("identity unavailable");
    // A 403 body's detail is the sentence; a body with only the capability
    // still names it; anything else falls back to the caller's words.
    expect(problemSentence({ title: "forbidden", detail: "Foreman may not …" }, "x")).toBe("Foreman may not …");
    expect(problemSentence({ capability: "clear_hazard", roles: ["foreman"] }, "x")).toBe(
      "Foreman may not record a clearance — refused by the server (clear_hazard)",
    );
    expect(problemSentence(null, "clearance → 500")).toBe("clearance → 500");
  });
});
