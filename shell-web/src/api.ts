// Thin API client. Identity is a milestone-1 header shim (x-org-id +
// x-assigned-vessels), matching wadl-api's auth extractor; a real session
// replaces it later. No external hosts — same-origin only.

/** A half-open interval, `[start, end)`. Epoch milliseconds, as the API sends. */
export interface Window {
  start: number;
  end: number;
}

export interface VesselSummary {
  vessel_id: string;
  hull_no: string;
  name: string;
  class_code: string;
  availability_code: string;
  confidence: string;
  /** null when the availability carries no dates — then as_of is refused. */
  availability: Window | null;
}

/**
 * The hull's time frame: the server's clock, and the bounds it will refuse an
 * as_of outside of.
 *
 * The `now` here is the SERVER's, deliberately. A browser clock minutes out
 * would make the shell mark a live board as a projection, or worse the reverse.
 */
export interface Timeframe {
  now: number;
  availability_code: string;
  availability: Window | null;
}

/**
 * The instant a read is for. `null` means live — no parameter is sent, and the
 * server answers from its own clock.
 *
 * Passed explicitly to every read rather than held in a module-level variable:
 * one screen showing a scrubbed instant while another shows now is precisely the
 * cross-screen disagreement this codebase keeps having to fix.
 */
export type AsOf = number | null;

function withAsOf(path: string, asOf: AsOf): string {
  return asOf === null ? path : `${path}${path.includes("?") ? "&" : "?"}as_of=${asOf}`;
}

export interface Identity {
  org: string;
  assignedVessels: string[];
}

function headers(id: Identity): HeadersInit {
  return {
    "x-org-id": id.org,
    "x-assigned-vessels": id.assignedVessels.join(","),
  };
}

export async function listVessels(id: Identity): Promise<VesselSummary[]> {
  const res = await fetch("/api/vessels", { headers: headers(id) });
  if (!res.ok) throw new Error(`GET /api/vessels → ${res.status}`);
  return (await res.json()) as VesselSummary[];
}

export type DecisionState = "ALLOW" | "WARN" | "BLOCK" | "SUSPEND";

export interface TraceStep {
  rule_code: string;
  rule_version: string;
  state: DecisionState;
  source: string;
  hazard: string;
  depth: number;
  path: string[];
  via: string[];
  authority: string;
  clearing_authority: string;
  earliest_clear: number | null;
  reason: string;
}

export interface Decision {
  state: DecisionState;
  trace: TraceStep[];
  earliest_clear: number | null;
}

export interface Compartment {
  frame: number | null;
  side: string;
  geometry_source: string;
  compartment_no: string;
  name: string;
  deck_code: string;
  deck_ordinal: number;
  zone: string;
  category: string;
}

export interface Deck {
  code: string;
  label: string;
  ordinal: number;
  compartment_count: number;
}

export interface DeckStateRow {
  trades: string[];
  work_order_codes: string[];
  remaining_hours: number;
  compartment: Compartment;
  state: DecisionState;
  permits_work: boolean;
  rules_fired: string[];
  earliest_clear: number | null;
  /**
   * Served, not derived here. The taxonomy is wadl-plan's; two implementations
   * of it is how the ship board and the deck plan start disagreeing about which
   * spaces are costing money.
   */
  readiness: ReadinessState;
  /** Who can release the hold, from the trace line that decided the state. */
  clearing_authority: string;
}

// Readiness is not authorization. The engine says whether work MAY proceed;
// readiness says whether anyone is actually held up — which needs the hours
// booked in the space as well. See wadl-plan's readiness module.
export type ReadinessState = "go" | "held" | "idle" | "latent";

export interface Tally {
  spaces: number;
  go: number;
  held: number;
  idle: number;
  latent: number;
  held_hours: number;
  workable_hours: number;
}

export interface Holder {
  authority: string;
  spaces: number;
  hours: number;
}

export interface HeldSpace {
  compartment_no: string;
  zone: string;
  deck_code: string;
  hours: number;
  /** Hours elsewhere this hold strands. Exact per space; never summed. */
  stranded_hours: number;
  trades: string[];
  clearing_authority: string;
}

export interface ReadinessGroup {
  key: string;
  tally: Tally;
  holders: Holder[];
  worst_spaces: HeldSpace[];
}

export interface Rollup {
  ship: ReadinessGroup;
  zones: ReadinessGroup[];
  decks: ReadinessGroup[];
  /** Outstanding hours naming a compartment the register does not contain. */
  unattributed_hours: number;
}

export async function readiness(
  id: Identity,
  vesselId: string,
  asOf: AsOf = null,
): Promise<Rollup> {
  const res = await fetch(withAsOf(`/api/vessels/${vesselId}/readiness`, asOf), {
    headers: headers(id),
  });
  if (!res.ok) throw new Error(`readiness → ${res.status}`);
  return (await res.json()) as Rollup;
}

export async function timeframe(id: Identity, vesselId: string): Promise<Timeframe> {
  const res = await fetch(`/api/vessels/${vesselId}/timeframe`, { headers: headers(id) });
  if (!res.ok) throw new Error(`timeframe → ${res.status}`);
  return (await res.json()) as Timeframe;
}

/** The worst thing true of a tally — matches `Tally::worst` in wadl-plan. */
export function worstOf(t: Tally): ReadinessState {
  if (t.held > 0) return "held";
  if (t.go > 0) return "go";
  if (t.idle > 0) return "idle";
  return "latent";
}

export interface WorkOrder {
  work_order_id: string;
  code: string;
  title: string;
  trade: string;
  system: string;
  compartment_no: string;
  budget_hours: number;
  earned_hours: number;
  source_ref: string;
  source_verified: boolean;
  /** Planned window, or null when the schedule of record does not say. */
  planned: Window | null;
  /** Whether the order is planned for the instant this list was read at. */
  in_window: boolean;
}

export interface PackageSummary {
  work_order_id: string;
  code: string;
  name: string;
  system: string;
  /** Lead trade. A distributed package is a work order, so it has one. */
  trade: string;
  segment_count: number;
  compartment_count: number;
  budget_hours: number;
  earned_hours: number;
}

export interface SegmentStatus {
  code: string;
  kind: string;
  name: string;
  budget: number;
  earned: number;
  complete: boolean;
  open_compartments: string[];
  testable: boolean;
  held_by: string[];
}

export interface FootprintSpace {
  compartment_no: string;
  budget_hours: number;
  earned_hours: number;
  remaining_hours: number;
  complete: boolean;
  state: DecisionState;
  permits_work: boolean;
  rules_fired: string[];
  earliest_clear: number | null;
}

export type Constraint =
  | {
      kind: "authorization";
      state: DecisionState;
      rules: string[];
      clearing_authority: string;
      earliest_clear: number | null;
    }
  | { kind: "completion" };

export interface Governing {
  compartment: string;
  constraint: Constraint;
  own_remaining: number;
  stranded_downstream: number;
  downstream_segments: string[];
  consequence: string;
}

export interface PackageDetail {
  package: {
    code: string;
    name: string;
    test_verb: string;
    budget_hours: number;
    earned_hours: number;
    compartment_count: number;
    open_compartment_count: number;
    segment_count: number;
    testable_segment_count: number;
    total_stranded_hours: number;
  };
  segments: SegmentStatus[];
  footprint: FootprintSpace[];
  governing: Governing | null;
  faults: unknown[];
}

export async function listWorkOrders(
  id: Identity,
  vesselId: string,
  asOf: AsOf = null,
): Promise<WorkOrder[]> {
  const res = await fetch(withAsOf(`/api/vessels/${vesselId}/work-orders`, asOf), {
    headers: headers(id),
  });
  if (!res.ok) throw new Error(`work-orders → ${res.status}`);
  return (await res.json()) as WorkOrder[];
}

export async function listPackages(id: Identity, vesselId: string): Promise<PackageSummary[]> {
  const res = await fetch(`/api/vessels/${vesselId}/packages`, { headers: headers(id) });
  if (!res.ok) throw new Error(`packages → ${res.status}`);
  return (await res.json()) as PackageSummary[];
}

export async function getPackage(
  id: Identity,
  vesselId: string,
  code: string,
  asOf: AsOf = null,
): Promise<PackageDetail> {
  const res = await fetch(
    withAsOf(`/api/vessels/${vesselId}/packages/${encodeURIComponent(code)}`, asOf),
    { headers: headers(id) },
  );
  if (!res.ok) throw new Error(`package ${code} → ${res.status}`);
  return (await res.json()) as PackageDetail;
}

export async function listDecks(id: Identity, vesselId: string): Promise<Deck[]> {
  const res = await fetch(`/api/vessels/${vesselId}/decks`, { headers: headers(id) });
  if (!res.ok) throw new Error(`decks → ${res.status}`);
  return (await res.json()) as Deck[];
}

// Authorization state is read THROUGH the engine, never computed here.
export async function deckStates(
  id: Identity,
  vesselId: string,
  asOf: AsOf = null,
): Promise<DeckStateRow[]> {
  const res = await fetch(withAsOf(`/api/vessels/${vesselId}/deck-states`, asOf), {
    headers: headers(id),
  });
  if (!res.ok) throw new Error(`deck-states → ${res.status}`);
  return (await res.json()) as DeckStateRow[];
}

// The full decision trace for one compartment — what the field app renders and
// a board of inquiry reads.
export async function compartmentState(
  id: Identity,
  vesselId: string,
  compartmentNo: string,
  asOf: AsOf = null,
): Promise<{ compartment: string; decision: Decision }> {
  const res = await fetch(
    withAsOf(
      `/api/vessels/${vesselId}/compartments/${encodeURIComponent(compartmentNo)}/state`,
      asOf,
    ),
    { headers: headers(id) },
  );
  if (!res.ok) throw new Error(`compartment state → ${res.status}`);
  return (await res.json()) as { compartment: string; decision: Decision };
}

/* ------------------------------------------------------------- mitigations */

/**
 * Something a person could do that would change a verdict.
 *
 * Each kind maps onto one perturbation of the engine's inputs, which is why the
 * effect below can be trusted: the server rebuilt the world with this action taken
 * and re-evaluated the hull. Nothing here is interpolated or looked up.
 */
export type MitigationAction =
  | { kind: "discharge"; origin: string; hazard: string; actor: string }
  | { kind: "wait"; until: number }
  | { kind: "interrupt"; from: string; to: string; coupling: string };

export interface MitigationEffect {
  frees: string[];
  /** Spaces this action would SHUT. Never hide these. */
  closes: string[];
  freed_hours: number;
  closed_hours: number;
}

/** What is computed versus what the platform is assuming. */
export type Confidence = "computed" | "assumes_actor" | "assumes_own_authorization";

export interface Mitigation {
  action: MitigationAction;
  effect: MitigationEffect;
  confidence: Confidence;
  subject_state: DecisionState;
}

export interface Hold {
  rule_code: string;
  origin: string;
  hazard: string;
  clearing_authority: string;
  earliest_clear: number | null;
  /** WARN is a condition flagged, not a hold to be discharged. */
  state: DecisionState;
}

export interface AuditRecord {
  seq: number;
  action: string;
  detail: string;
  subject_ref: string | null;
  occurred_at_ms: number;
  entry_hash: string;
  prev_hash: string | null;
}

/** Several actions that only work together, priced as one plan. */
export interface Combined {
  actions: MitigationAction[];
  effect: MitigationEffect;
  /** The weakest confidence among the parts. */
  confidence: Confidence;
  subject_state: DecisionState;
}

export interface Assessment {
  subject: string;
  state: DecisionState;
  booked: number;
  holds: Hold[];
  /** Ranked, best first. Empty when no single action opens the space. */
  options: Mitigation[];
  /** The cheapest plan, present only when no single action opens the space. */
  combined: Combined | null;
  as_of: number;
  /** What has already been decided here, newest first. */
  decisions: AuditRecord[];
}

export async function mitigations(
  id: Identity,
  vesselId: string,
  compartmentNo: string,
  asOf: AsOf = null,
): Promise<Assessment> {
  const res = await fetch(
    withAsOf(
      `/api/vessels/${vesselId}/compartments/${encodeURIComponent(compartmentNo)}/mitigations`,
      asOf,
    ),
    { headers: headers(id) },
  );
  if (!res.ok) throw new Error(`mitigations → ${res.status}`);
  return (await res.json()) as Assessment;
}

export async function leverage(
  id: Identity,
  vesselId: string,
  asOf: AsOf = null,
): Promise<{ as_of: number; actions: Mitigation[] }> {
  const res = await fetch(withAsOf(`/api/vessels/${vesselId}/leverage`, asOf), {
    headers: headers(id),
  });
  if (!res.ok) throw new Error(`leverage → ${res.status}`);
  return (await res.json()) as { as_of: number; actions: Mitigation[] };
}

/**
 * Records what a planner decided. Does **not** apply the mitigation — nothing in
 * this product clears a hazard or moves a date.
 */
export async function recordDecision(
  id: Identity,
  vesselId: string,
  compartmentNo: string,
  body: { disposition: "accepted" | "rejected"; option: Mitigation; reason: string; as_of: AsOf },
): Promise<AuditRecord> {
  const res = await fetch(
    `/api/vessels/${vesselId}/compartments/${encodeURIComponent(compartmentNo)}/decision`,
    {
      method: "POST",
      headers: { ...headers(id), "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`decision → ${res.status}`);
  return (await res.json()) as AuditRecord;
}

/* --------------------------------------------------------------- activities */

export type ActivityStatus = "not_started" | "in_progress" | "complete";
/** How much to trust the compartment mapping — the dominant P6 import risk. */
export type ActivityReliability = "high" | "medium" | "low";

/**
 * One scheduled activity — the grain P6 plans at, the row a foreman is handed.
 * Work orders are the accounting grain; activities are the doing grain.
 */
export interface Activity {
  activity_id: string;
  code: string;
  name: string;
  /** null = scheduled work nobody has mapped — a visible state, not an error. */
  work_order_code: string | null;
  /** null with a low reliability = the schedule did not say where. */
  compartment_no: string | null;
  compartment_reliability: ActivityReliability;
  trade: string;
  planned: Window | null;
  budget_hours: number;
  earned_hours: number;
  remaining_hours: number;
  status: ActivityStatus;
  is_milestone: boolean;
  source_ref: string;
  /** Whether the activity is planned for the instant this register was read at. */
  in_window: boolean;
  /** Whether it can execute as planned — the register's issue signal. */
  executability: Executability;
}

/**
 * The A4 derivation: the activity's compartment evaluated over its planned
 * window. Exact, not sampled — see wadl-issues. Indifferent to as_of: "as
 * planned" is a property of the plan, not of where the clock was scrubbed.
 */
export type Executability =
  | { verdict: "executable" }
  | ({ verdict: "not_executable" } & Refusal)
  | { verdict: "unassessable"; reason: "unlocated" | "undated" };

/** The first refused instant in the window, and the hold that governs there. */
export interface Refusal {
  at: number;
  state: DecisionState;
  rule_code: string;
  origin: string;
  hazard: string;
  clearing_authority: string;
  earliest_clear: number | null;
}

export async function listActivities(
  id: Identity,
  vesselId: string,
  asOf: AsOf = null,
): Promise<{ as_of: number; activities: Activity[] }> {
  const res = await fetch(withAsOf(`/api/vessels/${vesselId}/activities`, asOf), {
    headers: headers(id),
  });
  if (!res.ok) throw new Error(`activities → ${res.status}`);
  return (await res.json()) as { as_of: number; activities: Activity[] };
}
