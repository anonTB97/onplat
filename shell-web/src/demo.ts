// The DEMO MODE's people and hulls. These UUIDs match wadl-store's
// deterministic demo seed (InMemoryStore::demo). None of this is identity:
// on the dev shim the server trusts what the shell asserts, and the shell
// asserts a demo person per role so the ledger names who acted in the demo.
// Behind the yard's proxy the shell asserts nothing and `/api/whoami` says
// who the proxy resolved (`docs/identity-proxy-contract.md`).
import type { RoleCode } from "./identity";

const uuid = (n: number) => n.toString(16).padStart(32, "0").replace(
  /(.{8})(.{4})(.{4})(.{4})(.{12})/,
  "$1-$2-$3-$4-$5",
);

export const YARD_ORG = uuid(0x01);
export const CVN73 = uuid(0x73);
export const CVN71 = uuid(0x71);
export const CVN75 = uuid(0x75);
export const DDG = uuid(0xdd13);
export const LPD = uuid(0x1d28);

/** The hulls the demo planner is assigned — what the dev shim asserts. */
export const DEMO_ASSIGNED_HULLS = [CVN73, CVN71, CVN75];

/**
 * One demo person per role. The id is `dev:<role>` in the contract's charset
 * (`[A-Za-z0-9._:@/-]`, so the underscore of a role code becomes a hyphen);
 * the name is what the ledger's By column and the role button show.
 */
export const DEMO_PEOPLE: Record<RoleCode, { id: string; name: string }> = {
  planner: { id: "dev:planner", name: "Demo Planner (Y-1001)" },
  ship_super: { id: "dev:ship-super", name: "Demo Ship Super (Y-1002)" },
  zone_manager: { id: "dev:zone-manager", name: "Demo Zone Manager (Y-1003)" },
  production_super: { id: "dev:production-super", name: "Demo Production Super (Y-1004)" },
  project_manager: { id: "dev:project-manager", name: "Demo Project Manager (Y-1005)" },
  foreman: { id: "dev:foreman", name: "Demo Foreman (Y-1006)" },
  safety: { id: "dev:safety", name: "Demo Safety Officer (Y-1007)" },
  reader: { id: "dev:reader", name: "Demo Reader (Y-1008)" },
};

// Hulls in the yard tenant that the demo person is NOT assigned. Offered in
// the picker in demo mode only, so selecting one lands OUT OF SCOPE — the
// RBAC refusal (the server's 404) made visible, exactly as in the prototype.
export const DEMO_UNASSIGNED_HULLS = [
  { id: DDG, label: "DDG-113 · DSRA-26 · not assigned · demo" },
  { id: LPD, label: "LPD-28 · PSA-26 · not assigned · demo" },
];
