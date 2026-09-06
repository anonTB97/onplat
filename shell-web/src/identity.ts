// Who the shell is, and what that person may do — as the server resolves it.
//
// Two trust modes, read off `/health` before anything else is asked:
//
// * `dev-headers` — the dev shim, labelled DEMO MODE everywhere it shows.
//   The shell asserts the demo tenant, the demo hulls and a demo person for
//   the chosen role (`x-wadl-person`, `x-wadl-person-name`, `x-wadl-roles`),
//   so switching role switches what the server lets you do and the ledger
//   names who acted. It is not a login and the chrome says so.
// * `proxy-asserted` — the yard's identity proxy asserts every header on its
//   private hop; the shell sends none and shows the asserted person and
//   roles read-only.
//
// Either way the truth is `/api/whoami`: person, roles, capabilities, hulls,
// the role → capability matrix, markings. `can()` reads capabilities, never
// role names, so a matrix change on the server changes the shell with no
// edit here; `refusalSentence()` mirrors the server's 403 sentence so a
// greyed button and a refused request say the same words.

import { createContext, useContext } from "react";
import type { HullChoice } from "./Chrome";
import type { WhoAmI } from "./api";
import { DEMO_ASSIGNED_HULLS, DEMO_PEOPLE, DEMO_UNASSIGNED_HULLS, YARD_ORG } from "./demo";

/** The capabilities `roles.rs` gates, in the order `whoami` serves them. */
export const CAPABILITIES = [
  "read",
  "raise_hazard",
  "clear_hazard",
  "commit_document",
  "propose",
  "decide",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** The eight role codes the proxy may assert, in the matrix's order. */
export const ROLES = [
  "planner",
  "ship_super",
  "safety",
  "zone_manager",
  "production_super",
  "foreman",
  "project_manager",
  "reader",
] as const;
export type RoleCode = (typeof ROLES)[number];

/** The yard word for each role — the same table as `Role::yard_word`. */
export const ROLE_WORDS: Record<RoleCode, string> = {
  planner: "Planner",
  ship_super: "Ship Super",
  safety: "Safety",
  zone_manager: "Zone Manager",
  production_super: "Production Super",
  foreman: "Foreman",
  project_manager: "Project Manager",
  reader: "Reader",
};

/** The deed in yard words, as the server's refusal spells it ("may not …"). */
export const DEEDS: Record<Capability, string> = {
  read: "read the hull",
  raise_hazard: "raise a field condition",
  clear_hazard: "record a clearance",
  commit_document: "commit or revert a document",
  propose: "propose a schedule change",
  decide: "answer for an option or an issue",
};

/** What the shell asserts on the wire, by trust mode. */
export type Identity =
  | { mode: "proxy" }
  | {
      mode: "dev";
      org: string;
      assignedVessels: string[];
      person: { id: string; name: string };
      roles: RoleCode[];
    };

/** The dev-shim identity for a role: the demo tenant, hulls and person. */
export function devIdentityFor(role: RoleCode): Identity {
  return {
    mode: "dev",
    org: YARD_ORG,
    assignedVessels: DEMO_ASSIGNED_HULLS,
    person: DEMO_PEOPLE[role],
    roles: [role],
  };
}

/** The identity to send, given the mode `/health` reported. */
export function identityFromHealth(identityMode: string, role: RoleCode): Identity {
  return identityMode === "dev-headers" ? devIdentityFor(role) : { mode: "proxy" };
}

/**
 * The headers an identity puts on every request. Nothing in proxy mode — the
 * proxy asserts, and a client-set header would be stripped anyway; the five
 * dev headers on the shim, the name percent-encoded as the contract asks.
 */
export function identityHeaders(id: Identity): Record<string, string> {
  if (id.mode === "proxy") return {};
  return {
    "x-org-id": id.org,
    "x-assigned-vessels": id.assignedVessels.join(","),
    "x-wadl-person": id.person.id,
    "x-wadl-person-name": encodeURIComponent(id.person.name),
    "x-wadl-roles": id.roles.join(","),
  };
}

/**
 * The hulls the picker offers: what `whoami` served, and in demo mode the two
 * unassigned demo hulls too, so the RBAC refusal stays one click away. No
 * `whoami` answer, no hulls — an empty picker is "unavailable", never an
 * answer.
 */
export function hullChoicesFrom(who: WhoAmI | null, mode: Identity["mode"]): HullChoice[] {
  if (!who) return [];
  const served: HullChoice[] = who.hulls.map((v) => ({
    id: v.vessel_id,
    label: `${v.hull_no} · ${v.availability_code}`,
    vessel: v,
  }));
  if (mode !== "dev") return served;
  const demo = DEMO_UNASSIGNED_HULLS.filter((h) => !served.some((s) => s.id === h.id)).map((h) => ({
    id: h.id,
    label: h.label,
  }));
  return [...served, ...demo];
}

/** Whether the resolved person holds a capability. Unknown person: no. */
export function can(who: WhoAmI | null, cap: Capability): boolean {
  return who !== null && who.capabilities.includes(cap);
}

/** The roles that hold a capability, from the served matrix, in matrix order. */
export function holdersOf(who: WhoAmI, cap: Capability): RoleCode[] {
  return ROLES.filter((role) => (who.role_matrix[role] ?? []).includes(cap));
}

/** `A`, `A and B`, `A, B and C` — the server's `join_words`. */
function joinWords(words: string[]): string {
  if (words.length === 0) return "";
  if (words.length === 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

const wordFor = (code: string): string => (ROLE_WORDS as Record<string, string>)[code] ?? code;

/**
 * The sentence a refused request would come back with, written before it is
 * sent — the same words `roles::refusal_sentence` uses, so the tooltip on a
 * greyed button and the 403 body agree. Unknown person: says so.
 */
export function refusalSentence(cap: Capability, who: WhoAmI | null): string {
  if (!who) return "identity unavailable — /api/whoami did not answer, so no door is open";
  const whoWords = who.roles.length === 0
    ? "A person with no recognised role"
    : joinWords(who.roles.map(wordFor));
  const holders = holdersOf(who, cap).map((r) => ROLE_WORDS[r]);
  const heldBy = holders.length === 0 ? "held by nobody" : `held by ${joinWords(holders)}`;
  return `${whoWords} may not ${DEEDS[cap]} — ${cap} is ${heldBy}`;
}

/** The `application/problem+json` body a refused request carries. */
export interface ProblemBody {
  title?: string;
  detail?: string;
  capability?: string;
  roles?: string[];
}

/**
 * A problem body as one sentence. The server's `detail` is the sentence; a
 * 403 with only the capability and roles still names both, and nothing
 * falls through to a bare status code.
 */
export function problemSentence(problem: ProblemBody | null, fallback: string): string {
  if (problem?.detail) return problem.detail;
  if (problem?.capability) {
    const roles = problem.roles ?? [];
    const whoWords = roles.length === 0 ? "A person with no recognised role" : joinWords(roles.map(wordFor));
    const deed = (DEEDS as Record<string, string>)[problem.capability] ?? problem.capability;
    return `${whoWords} may not ${deed} — refused by the server (${problem.capability})`;
  }
  return fallback;
}

/** The deeds a person may do, in yard words, for the signed-in block. */
export function deedsOf(who: WhoAmI): string[] {
  return CAPABILITIES.filter((c) => c !== "read" && who.capabilities.includes(c)).map((c) => DEEDS[c]);
}

/* ---------------------------------------------------------------- context */

export type WhoState = "loading" | "ok" | "failed";

/** What every screen reads to grey a door: the identity, the answer, and `can`. */
export interface IdentityView {
  identity: Identity | null;
  who: WhoAmI | null;
  whoState: WhoState;
  can: (cap: Capability) => boolean;
  /** The tooltip for a door `can` refuses. */
  refusal: (cap: Capability) => string;
}

export function identityView(identity: Identity | null, who: WhoAmI | null, whoState: WhoState): IdentityView {
  return {
    identity,
    who,
    whoState,
    can: (cap) => can(who, cap),
    refusal: (cap) => refusalSentence(cap, who),
  };
}

export const IdentityContext = createContext<IdentityView>(identityView(null, null, "loading"));

export function useIdentity(): IdentityView {
  return useContext(IdentityContext);
}
