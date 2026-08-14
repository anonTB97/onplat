// DEV-SHIM identity. These UUIDs match wadl-store's deterministic demo seed
// (InMemoryStore::demo). A real session replaces all of this. The yard planner
// is assigned to the three carriers only; the DDG and LPD are deliberately
// unassigned so the OUT OF SCOPE banner (and the server's 404) are visible.
import type { Identity } from "./api";

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

export const DEMO_IDENTITY: Identity = {
  org: YARD_ORG,
  assignedVessels: [CVN73, CVN71, CVN75],
};

// Hulls the planner may pick in the rail. The last two are in-tenant but
// unassigned, so selecting them lands OUT OF SCOPE — the RBAC refusal made
// visible, exactly as in the prototype.
export const PICKABLE_HULLS = [
  { id: CVN73, label: "CVN-73 · PIA-26" },
  { id: CVN71, label: "CVN-71 · SRA-26" },
  { id: CVN75, label: "CVN-75 · DPIA-28" },
  { id: DDG, label: "DDG-113 · DSRA-26 (unassigned)" },
  { id: LPD, label: "LPD-28 · PSA-26 (unassigned)" },
];
