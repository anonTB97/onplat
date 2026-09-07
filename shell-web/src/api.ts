// Thin API client. Identity is whatever `identity.ts` resolved from `/health`:
// the dev shim's five headers in DEMO MODE, nothing behind the yard's proxy
// (`docs/identity-proxy-contract.md`). Every write surfaces the server's
// refusal as its sentence — a 403 is the yard's words about who may, never a
// bare status. No external hosts — same-origin only.

import type { YardClockInfo } from "./clock";
import { identityHeaders, problemSentence, type Identity, type ProblemBody } from "./identity";
import type { YardClock } from "./yardClock";

export type { Identity } from "./identity";

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
  /** The clock the hull is on — the yard's document, or the UTC default,
   *  and which. Served with the first read the shell makes per hull so every
   *  board renders in the yard's clock from its first paint. Optional only
   *  for an API older than the clock. */
  yard_clock?: YardClockInfo;
  /** The run the served schedule of record came from — label, when, by
   *  whom — for the breadcrumb. `null` for the generated register; absent
   *  only on an API older than the run history. */
  schedule_run?: ScheduleRunSummary | null;
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

function headers(id: Identity): HeadersInit {
  return identityHeaders(id);
}

/**
 * A refused write, as the server's sentence. `message` is the problem's
 * `detail` — for a 403, "Foreman may not record a clearance — clear_hazard
 * is held by Ship Super and Safety" — and `String(err)` is the same sentence,
 * so no screen has to know this class to show the words.
 */
export class ApiRefusal extends Error {
  readonly status: number;
  /** The capability a 403 named, if it did. */
  readonly capability: string | undefined;
  /** The caller's role codes as the 403 saw them. */
  readonly roles: string[];
  constructor(status: number, message: string, problem: ProblemBody | null) {
    super(message);
    this.name = "ApiRefusal";
    this.status = status;
    this.capability = problem?.capability;
    this.roles = problem?.roles ?? [];
  }
  override toString(): string {
    return this.message;
  }
}

/**
 * A write's refusal as the sentence the server wrote, not the JSON it came
 * in. A `problem+json` body's `detail` is the sentence (a 403's names the
 * role and who holds the capability); a door that answered with reasons but
 * no `detail` keeps its text; a bare status names the door.
 */
async function doorRefusal(res: Response, door: string): Promise<ApiRefusal> {
  const text = await res.text().catch(() => "");
  let problem: ProblemBody | null = null;
  try {
    problem = JSON.parse(text) as ProblemBody;
  } catch {
    problem = null;
  }
  const fallback = text && res.status !== 403
    ? `${door} → ${res.status}: ${text.slice(0, 600)}`
    : `${door} → ${res.status}`;
  return new ApiRefusal(res.status, problemSentence(problem, fallback), problem);
}

export async function listVessels(id: Identity): Promise<VesselSummary[]> {
  const res = await fetch("/api/vessels", { headers: headers(id) });
  if (!res.ok) throw new Error(`GET /api/vessels → ${res.status}`);
  return (await res.json()) as VesselSummary[];
}

/**
 * `/health`: which trust boundary is armed, and the release stamp — the
 * commit, its instant and the migration set the binary was built against,
 * beside the store's own migration state. `version`, `schema_state` and
 * `store` are optional so an older server still boots the shell.
 */
export interface Health {
  status: string;
  identity_mode: string;
  version?: { git: string; built_at: string; schema: string; document_schema: number };
  schema_state?: string;
  store?: { backend: string; reachable: boolean; schema_version: string | null };
}

/** `/health`, read before anything is asserted (no identity headers: it is unscoped). */
export async function health(): Promise<Health> {
  const res = await fetch("/health");
  if (!res.ok) throw new Error(`GET /health → ${res.status}`);
  return (await res.json()) as Health;
}

/**
 * The caller's identity as the SERVER resolved it — not an echo of the headers
 * the shell sent. `identity_mode` names the trust boundary that admitted the
 * request (`dev-headers` or `proxy-asserted`); `person` is who the ledger
 * will name; `capabilities` is what the role matrix grants, and `hulls` is
 * the list every picker is built from. The matrix itself rides along so a
 * refusal can be worded here exactly as the server would word it.
 */
export interface WhoAmI {
  org: string;
  assigned_vessels: string[];
  identity_mode: string;
  person: { id: string; name: string; source: string };
  roles: string[];
  capabilities: string[];
  hulls: VesselSummary[];
  role_matrix: Record<string, string[]>;
  warnings: string[];
  markings: string[];
  decision_support_only: boolean;
}

/** One end of a scheduled-work conflict pair. */
export interface ConflictEnd {
  code: string;
  name: string;
  space: string;
  trade: string;
}

/**
 * Scheduled work colliding with scheduled work on one day — hot-class against
 * flammable-class, same space or coupled spaces. Served, not derived here:
 * the trade classes and the coupling walk are the server's business rules,
 * and `basis` carries its own honesty statement.
 */
export interface WorkConflicts {
  day: Window;
  pairs: { hot: ConflictEnd; flammable: ConflictEnd; via: string; reason: string }[];
  dropped: number;
  scanned: number;
  basis: string;
}

export async function workConflicts(
  id: Identity,
  vesselId: string,
  asOf: AsOf = null,
): Promise<WorkConflicts> {
  const res = await fetch(withAsOf(`/api/vessels/${vesselId}/work-conflicts`, asOf), {
    headers: headers(id),
  });
  if (!res.ok) throw new Error(`work-conflicts → ${res.status}`);
  return (await res.json()) as WorkConflicts;
}

export async function whoami(id: Identity): Promise<WhoAmI> {
  const res = await fetch("/api/whoami", { headers: headers(id) });
  if (!res.ok) throw new Error(`GET /api/whoami → ${res.status}`);
  return (await res.json()) as WhoAmI;
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
  /** Surveyed frame extent from the geometry register; null = pin only. */
  fwd_frame: number | null;
  aft_frame: number | null;
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
  /** WHEN this space is touched — its own slice of the package, not the
   *  package's span. null = undated, rides the whole availability. */
  planned: Window | null;
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

/* ----------------------------------------------------------------- hazards */

/** A live recorded field condition — the fact behind the trace's verdicts. */
export interface LiveHazard {
  /** The origin space. */
  origin: string;
  /** The engine's kind name, e.g. `energised_bus`. */
  kind: string;
  /** When it was raised, epoch ms. */
  since: number;
  /** Human label, e.g. `Bus 3-SG-2 energised — no verified zero-energy state`. */
  label: string;
}

/**
 * Raises a field condition on the hull — the day's tag-out, coating ticket,
 * hot-work permit or stop-work — against a space the register knows. The
 * server refuses a space it does not know, an empty label, a future instant,
 * and a second live fact of the same kind in the same space; lands
 * `HAZARD_RAISED` in the ledger; and every verdict re-derives on the next
 * read. The caller refetches, never repaints.
 */
export async function raiseHazard(
  id: Identity,
  vesselId: string,
  body: { compartment: string; kind: string; label: string; since_ms?: number },
): Promise<{ hazard: LiveHazard; recorded: unknown }> {
  const res = await fetch(`/api/vessels/${vesselId}/hazards`, {
    method: "POST",
    headers: { ...headers(id), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await doorRefusal(res, "raise hazard");
  return (await res.json()) as { hazard: LiveHazard; recorded: unknown };
}

/** The hazard kinds the engine evaluates, in yard words, for a raise form. */
export const HAZARD_KINDS: { kind: string; label: string; gloss: string }[] = [
  { kind: "hot_work_live", label: "Hot work live", gloss: "a welding, cutting or grinding permit is open here" },
  { kind: "coating_open", label: "Coating open", gloss: "a coating or preservation ticket is curing here" },
  { kind: "energised_bus", label: "Energised bus", gloss: "a bus is live with no verified zero-energy state" },
  { kind: "flammable_stow", label: "Flammable stow", gloss: "flammables are stowed or open here" },
  { kind: "stop_work", label: "Stop-work", gloss: "an inspection authority has posted a stop-work" },
];

// The raw live hazards on a hull. Served separately from the traces so the
// surface can show WHAT is shut (the fact) alongside WHY (its consequences).
export async function listHazards(
  id: Identity,
  vesselId: string,
  asOf: AsOf = null,
): Promise<LiveHazard[]> {
  // Hazards are read as of the instant like every verdict: a hazard cleared
  // on Friday is still a live fact on Thursday's board.
  const res = await fetch(withAsOf(`/api/vessels/${vesselId}/hazards`, asOf), {
    headers: headers(id),
  });
  if (!res.ok) throw new Error(`hazards → ${res.status}`);
  const body = (await res.json()) as { hazards: LiveHazard[] };
  return body.hazards;
}

/**
 * Records an administrative clearance: the crew verified the field condition
 * ended (tags hung, gas-free sighted) and someone with the authority says so,
 * with the basis. The server closes the fact, appends `HAZARD_CLEARED` to the
 * ledger, and every verdict the hazard drove re-derives clean on the next
 * read — the caller's job is to refetch, not to repaint.
 */
export async function clearHazard(
  id: Identity,
  vesselId: string,
  input: { compartment: string; kind: string; basis: string },
): Promise<{ cleared: LiveHazard[] }> {
  const res = await fetch(`/api/vessels/${vesselId}/hazards/clear`, {
    method: "POST",
    headers: { ...headers(id), "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await doorRefusal(res, "clearance");
  return (await res.json()) as { cleared: LiveHazard[] };
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
  if (!res.ok) throw await doorRefusal(res, "decision");
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
  /** The schedule's top-level WBS bucket — a zone hint at best, never a location. */
  wbs_area: string | null;
  trade: string;
  /** The work type the field map read for this row — what the rule table
   *  binds to. null when the map names no field for it. */
  work_type?: string | null;
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

/* -------------------------------------------------------------------- issues */

/**
 * The lifecycle an issue row carries, joined from the audit ledger on every
 * read. Neither field removes the row: an acknowledged issue is still an
 * issue, it is just an issue somebody has answered for.
 */
export interface IssueLifecycle {
  /** The issue's stable key across derivations — what an ack attaches to. */
  key: string;
  /** The ledger's acknowledgement of this finding, if one was recorded. */
  acknowledged: { at: number; note: string } | null;
  /** The latest mitigation disposition recorded against the issue's space. */
  decision: { disposition: string; at: number; reason: string } | null;
}

/**
 * One issue: a typed claim that planned work is in trouble, with its evidence.
 * The same fact can appear at several grains (a space, a plan, a crew's
 * morning) — that is deliberate; each grain routes to a different fix.
 */
export type Issue = IssueLifecycle &
  (
  | {
      kind: "not_executable_as_planned";
      activity: string;
      name: string;
      trade: string;
      compartment: string;
      hours_at_risk: number;
      refusal: Refusal;
    }
  | {
      kind: "held_with_crews_booked";
      compartment: string;
      hours_at_risk: number;
      state: DecisionState;
      clearing_authority: string;
      earliest_clear: number | null;
    }
  | {
      kind: "compound_hold";
      compartment: string;
      hours_at_risk: number;
      holds: number;
      /** Actions in the cheapest working plan; 0 = even the planner found nothing. */
      plan_actions: number;
    }
  | {
      kind: "stranding_concentration";
      compartment: string;
      own_remaining: number;
      hours_at_risk: number;
      downstream_segments: number;
    }
  | {
      kind: "negative_lag";
      pred: string;
      succ: string;
      lag_hours: number;
      hours_at_risk: number;
    }
  );

/**
 * Records that somebody answered for an issue. Appends to the same
 * tamper-evident ledger as mitigation decisions; closes and hides nothing.
 */
export async function acknowledgeIssue(
  id: Identity,
  vesselId: string,
  key: string,
  note: string,
): Promise<void> {
  const res = await fetch(`/api/vessels/${vesselId}/issues/acknowledge`, {
    method: "POST",
    headers: { ...headers(id), "content-type": "application/json" },
    body: JSON.stringify({ key, note }),
  });
  if (!res.ok) throw await doorRefusal(res, "acknowledge");
}

export async function listIssues(
  id: Identity,
  vesselId: string,
  asOf: AsOf = null,
): Promise<{ as_of: number; hours_at_risk: number; issues: Issue[] }> {
  const res = await fetch(withAsOf(`/api/vessels/${vesselId}/issues`, asOf), {
    headers: headers(id),
  });
  if (!res.ok) throw new Error(`issues → ${res.status}`);
  return (await res.json()) as { as_of: number; hours_at_risk: number; issues: Issue[] };
}

/** Register hours per work item vs the item's own budget — mismatches only. */
export interface ReconciliationMismatch {
  code: string;
  item_budget: number;
  register_budget: number;
  item_earned: number;
  register_earned: number;
}

/**
 * One dependency edge from the schedule of record, at the activity-code grain.
 * A negative lag lets the successor start before its predecessor finishes —
 * legitimate as an overlap, and exactly where cure-window inversions hide.
 */
export interface ScheduleEdge {
  pred_code: string;
  succ_code: string;
  /** Relationship kind as the scheduler writes it, e.g. `PR_FS`. */
  kind: string;
  lag_hours: number;
}

/* ------------------------------------------------------ schedule alternatives */

/** One refused activity's proposed re-sequence — the same engine's answer,
 *  never a heuristic. `viable` slides to the first window the rules permit;
 *  `verification_gated` refuses to promise a date (the hold clears only on a
 *  named authority's word); `no_window` fits nowhere before the horizon. */
export type ScheduleAlternative =
  | { kind: "viable"; window: Window; delay_hours: number }
  | {
      kind: "verification_gated";
      refusal: {
        at: number;
        state: DecisionState;
        rule_code: string;
        origin: string;
        hazard: string;
        clearing_authority: string;
        earliest_clear: number | null;
      };
    }
  | { kind: "no_window"; horizon: number };

export interface AlternativeRow {
  activity: string;
  name: string;
  compartment: string;
  trade: string;
  planned: Window;
  remaining_hours: number;
  refusal: {
    at: number;
    state: DecisionState;
    rule_code: string;
    origin: string;
    hazard: string;
    clearing_authority: string;
    earliest_clear: number | null;
  };
  alternative: ScheduleAlternative;
  /** Successors whose planned start falls before the proposed finish. */
  pushes: string[];
}

export interface ScheduleAlternatives {
  as_of: number;
  horizon: number;
  /** How the knock-on was read; served so the UI repeats it honestly. */
  knock_on_basis: string;
  /** Ranked by man-hours at stake, worst first. */
  alternatives: AlternativeRow[];
}

/** Proposals for every activity the engine refuses as planned. Read-only:
 *  re-sequencing happens in P6, deciding on the space's options panel. */
export async function scheduleAlternatives(
  id: Identity,
  vesselId: string,
  asOf: AsOf = null,
): Promise<ScheduleAlternatives> {
  const res = await fetch(withAsOf(`/api/vessels/${vesselId}/schedule-alternatives`, asOf), {
    headers: headers(id),
  });
  if (!res.ok) throw new Error(`alternatives → ${res.status}`);
  return (await res.json()) as ScheduleAlternatives;
}

/* ------------------------------------------------------ schedule proposals */

/** Where a proposal stands, derived on every read from the ledger and the
 *  schedule currently served — never stored. */
export type ProposalStatus = "open" | "reflected" | "superseded" | "dropped" | "withdrawn";

/** One schedule change proposal — the path from a refusal here back to P6. */
export interface ScheduleProposal {
  seq: number;
  entry_hash: string;
  proposed_at_ms: number;
  activity: string;
  name: string;
  compartment: string | null;
  trade: string;
  from: Window | null;
  /** The proposed window; null for a hold pending verification. */
  to: Window | null;
  kind: "engine_window" | "manual" | "hold_pending_verification";
  reason: string;
  /** The engine's verdict on the proposed window under the hazards live at the instant. */
  verdict: Executability | null;
  /** Successors whose planned start falls before the proposed finish. */
  pushes: string[];
  knock_on_basis: string;
  status: ProposalStatus;
  /** Where the activity sits on the schedule served now. */
  planned_now: Window | null;
}

export interface ProposalList {
  as_of: number;
  schedule_source: string | null;
  counts: Record<ProposalStatus, number>;
  proposals: ScheduleProposal[];
  status_basis: string;
}

/**
 * Records a schedule change proposal. Nothing moves: the engine checks the
 * proposed window under the live hazards, the knock-on is read off the
 * schedule's logic, and the whole record lands in the ledger. The export to
 * P6 is built from these; the next XER import says which P6 reflected.
 */
export async function proposeScheduleChange(
  id: Identity,
  vesselId: string,
  body: {
    activity: string;
    start_ms?: number;
    end_ms?: number;
    kind: ScheduleProposal["kind"];
    reason: string;
    as_of: AsOf;
  },
): Promise<{ proposal: ScheduleProposal; recorded: AuditRecord }> {
  const res = await fetch(`/api/vessels/${vesselId}/schedule-proposals`, {
    method: "POST",
    headers: { ...headers(id), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await doorRefusal(res, "proposal");
  return (await res.json()) as { proposal: ScheduleProposal; recorded: AuditRecord };
}

export async function listProposals(id: Identity, vesselId: string): Promise<ProposalList> {
  const res = await fetch(`/api/vessels/${vesselId}/schedule-proposals`, { headers: headers(id) });
  if (!res.ok) throw new Error(`proposals → ${res.status}`);
  return (await res.json()) as ProposalList;
}

/** Takes a proposal back as a later ledger entry; the original stays in the chain. */
export async function withdrawProposal(
  id: Identity,
  vesselId: string,
  seq: number,
  reason: string,
): Promise<void> {
  const res = await fetch(`/api/vessels/${vesselId}/schedule-proposals/withdraw`, {
    method: "POST",
    headers: { ...headers(id), "content-type": "application/json" },
    body: JSON.stringify({ seq, reason }),
  });
  if (!res.ok) throw await doorRefusal(res, "withdrawal");
}

export interface ActivityRegister {
  as_of: number;
  /** null = the generated demo register; a label = the ingested export it came from. */
  schedule_source: string | null;
  /** The run the served register came from; null for the generated one. */
  schedule_run?: ScheduleRunSummary | null;
  reconciliation: {
    /** What the hours answer to: an ingested budget book's label, or null =
     *  the seeded work items. "Reconciles" is only as strong as this. */
    source: string | null;
    /** How many work items sit on the other side of the comparison. */
    items: number;
    mismatches: ReconciliationMismatch[];
    /** Budgeted hours the register maps to no work item at all. */
    unmapped_budget_hours: number;
  };
  /** Where the work landed, graded per path — served on every read. */
  mapping: MappingReport;
  /** The schedule's logic — what the dates were computed from. */
  edges: ScheduleEdge[];
  activities: Activity[];
}

/* ------------------------------------------------- the P6 field map and runs */

/** The encodings the door reads — which branch the browser's decoder took. */
export type XerEncoding = "utf-8" | "windows-1252";

/**
 * Where one slot of the field map reads from: a UDF by name or label, an
 * activity code type, the first labor resource (trade only), or nothing.
 */
export type FieldSource =
  | { source: "udf"; name: string }
  | { source: "activity_code"; name: string }
  | { source: "resource" }
  | { source: "none" };

/** The four slots, in card order. */
export const FIELD_SLOTS = ["compartment", "work_item", "work_type", "trade"] as const;
export type FieldSlot = (typeof FIELD_SLOTS)[number];

/**
 * The yard's export conventions as data — which XER field carries the
 * compartment, the work item, the work type and the trade; which projects
 * to serve; whether to read placards out of task names when the compartment
 * field is silent. One per hull; the default is today's convention.
 */
export interface FieldMap {
  compartment: FieldSource;
  work_item: FieldSource;
  work_type: FieldSource;
  trade: FieldSource;
  /** `proj_short_name`s to serve; empty = every project in the file. */
  projects: string[];
  placards_from_names: boolean;
}

/** Today's convention, exactly — what a hull with no map on file imports through. */
export const DEFAULT_FIELD_MAP: FieldMap = {
  compartment: { source: "udf", name: "compartment" },
  work_item: { source: "udf", name: "wi_number" },
  work_type: { source: "none" },
  trade: { source: "resource" },
  projects: [],
  placards_from_names: true,
};

/**
 * The survey of an export: which fields it carries and how full they are —
 * no schedule content. The field-map selects are built from it.
 */
export interface FieldsSeen {
  projects: { id: string; short_name: string; tasks: number }[];
  udfs: { name: string; label: string | null; table: string | null; values: number }[];
  activity_code_types: { name: string; values: number }[];
  resource_types: Record<string, number>;
  has_rsrc_type: boolean;
  task_types: Record<string, number>;
  sections: Record<string, number>;
}

/** Who a run was imported by, and through which door. */
export interface ImportedBy {
  org: string;
  /** The person the identity hop asserted; null when the binary acted alone. */
  person: string | null;
  /** `door`, `boot` or `cli`. */
  via: string;
}

/** What one import counted. */
export interface RunCounts {
  task_rows: number;
  served: number;
  work: number;
  key_events: number;
  quarantined: number;
  excluded_loe: number;
  excluded_wbs: number;
  excluded_project: number;
  edges: number;
  edges_quarantined: number;
  material_skipped: number;
  equipment_skipped: number;
}

/** One row the import could not honestly accept, and why. */
export interface QuarantinedRow {
  /** 1-based line in the export. */
  line: number;
  /** `TASK`, `TASKPRED`. */
  table: string;
  code: string | null;
  /** `unparseable_date`, `width`, `cross_project_logic`… */
  class: string;
  reason: string;
}

/** A schedule run as the list and the breadcrumb read it — everything but its rows. */
export interface ScheduleRunSummary {
  run_id: string;
  /** 1, 2, 3… per hull. */
  seq: number;
  label: string;
  imported_at_ms: number;
  imported_by: ImportedBy;
  encoding: string;
  /** `browser`, `server` or `caller`. */
  decoded_by: string;
  projects_served: string[];
  counts: RunCounts;
  field_map: FieldMap;
  /** Whether this run's rows are the ones served now. */
  served: boolean;
  schema_version: number;
}

/** What one run found and set aside — the detail behind the counts. */
export interface ScheduleRunReport {
  quarantine: QuarantinedRow[];
  excluded_loe: string[];
  excluded_wbs: string[];
  excluded_project: [string, string][];
  fields_seen: FieldsSeen;
  findings: string[];
}

/** What a run as it would be recorded says about itself, on the preview. */
export interface RunPreview {
  encoding: string;
  decoded_by: string;
  projects_served: string[];
  counts: RunCounts;
  field_map: FieldMap;
  /** `inline` (the body carried one), `document` (the stored map), `default`. */
  field_map_source: "inline" | "document" | "default";
}

/** What the door needs beside the text: which decoder branch the browser
 *  took, and the map to read the file through instead of the stored one. */
export interface ScheduleDoorOptions {
  encoding: XerEncoding;
  fieldMap?: FieldMap;
}

/**
 * Imports a P6 XER export as the hull's schedule of record. Rows the parser
 * cannot honestly accept are quarantined with their reasons and served in
 * the response; the file is refused whole (422, the reasons in the error)
 * only when no activity survives. Every commit is a run.
 */
export async function importSchedule(
  id: Identity,
  vesselId: string,
  label: string,
  xer: string,
  opts: ScheduleDoorOptions,
): Promise<ImportPreview & { run_id: string; seq: number }> {
  const res = await fetch(`/api/vessels/${vesselId}/schedule-of-record`, {
    method: "POST",
    headers: { ...headers(id), "content-type": "application/json" },
    body: JSON.stringify({ label, xer, encoding: opts.encoding, field_map: opts.fieldMap }),
  });
  if (!res.ok) throw await doorRefusal(res, "import");
  return (await res.json()) as ImportPreview & { run_id: string; seq: number };
}

/**
 * The location-mapping report: how the export's work landed on the hull,
 * graded per path — the schedule saying where (authored), this parser
 * guessing where (derived, listed so the guess can be inspected and refused),
 * or nothing at all. `unknown_spaces` is the finding most worth a look:
 * mapped, and to nowhere this hull knows.
 */
export interface MappingReport {
  work_activities: number;
  located_authored: number;
  located_derived: { activity: string; compartment: string }[];
  /** Rows the schedule never located; `zone_hint` is the WBS bucket when it
   *  names a real zone of this hull — zone grain, never a place. */
  unlocated: { activity: string; zone_hint: string | null }[];
  unknown_spaces: { activity: string; compartment: string }[];
  milestones: number;
}

/** Everything a schedule import would claim — the dry run and the confirm alike. */
/** One activity named in the delta's constraint shift. */
export interface DeltaExample {
  code: string;
  space: string;
  rule: string;
}

/**
 * What an incoming schedule CHANGES against the register currently served —
 * counts of moved work, and the constraint shift only this platform can
 * compute (which moves land work inside a refusal, under the same hazards
 * and rules). Served at the import door so the consequences are on the
 * table before Confirm; recorded in the ledger at commit.
 */
export interface ScheduleDelta {
  baseline: string;
  added: number;
  removed: number;
  retimed: number;
  rehoused: number;
  rebudgeted: number;
  refused_before: number;
  refused_after: number;
  newly_refused: { count: number; examples: DeltaExample[] };
  newly_clear: { count: number; examples: DeltaExample[] };
  /** Which open proposals the incoming export reflects, to the day. */
  proposals?: { open: number; reflected: string[]; still_open: string[] };
}

export interface ImportPreview {
  label: string;
  activities: number;
  edges: number;
  reconciliation: { mismatches: ReconciliationMismatch[]; unmapped_budget_hours: number };
  mapping: MappingReport;
  delta: ScheduleDelta;
  /** The run as it would be recorded. */
  run: RunPreview;
  /** The survey of the file's own fields — the selects are built from it. */
  fields_seen: FieldsSeen;
  /** Every row set aside, with its line and reason. */
  quarantine: QuarantinedRow[];
  /** Rows excluded and listed, not lost: level-of-effort, WBS summaries,
   *  and `[code, project]` for projects the map does not serve. */
  exclusions: { loe: string[]; wbs: string[]; project: [string, string][] };
  /** The map's and the clock's findings — none of which refused. */
  findings: string[];
  /** The clock the export's wall clock was read in. */
  clock?: { zone: string; label: string | null };
  wall_clock_findings?: string[];
}

/** Dry-runs an import: everything the import would say, nothing it would do. */
export async function previewSchedule(
  id: Identity,
  vesselId: string,
  label: string,
  xer: string,
  opts: ScheduleDoorOptions,
): Promise<ImportPreview> {
  const res = await fetch(`/api/vessels/${vesselId}/schedule-of-record?dry_run=true`, {
    method: "POST",
    headers: { ...headers(id), "content-type": "application/json" },
    body: JSON.stringify({ label, xer, encoding: opts.encoding, field_map: opts.fieldMap }),
  });
  if (!res.ok) throw await doorRefusal(res, "preview");
  return (await res.json()) as ImportPreview;
}

/** Reverts to the generated register, discarding the ingested schedule.
 *  The runs stay: history is history, and any of them can be served again. */
export async function revertSchedule(id: Identity, vesselId: string): Promise<void> {
  const res = await fetch(`/api/vessels/${vesselId}/schedule-of-record/revert`, {
    method: "POST",
    headers: headers(id),
  });
  if (!res.ok) throw await doorRefusal(res, "revert");
}

/** The field map in effect, where it came from, and the served run's survey. */
export interface FieldMapInfo {
  source: "document" | "default";
  label: string | null;
  map: FieldMap;
  /** null when no run is served (the generated register). */
  fields_seen: FieldsSeen | null;
}

export async function getFieldMap(id: Identity, vesselId: string): Promise<FieldMapInfo> {
  const res = await fetch(`/api/vessels/${vesselId}/field-map`, { headers: headers(id) });
  if (!res.ok) throw new Error(`field map → ${res.status}`);
  return (await res.json()) as FieldMapInfo;
}

/** Stores the hull's field map — refused whole with every reason (422);
 *  findings against the served run's survey warn without refusing. */
export async function importFieldMap(
  id: Identity,
  vesselId: string,
  label: string,
  map: FieldMap,
  dryRun: boolean,
): Promise<{ stored: boolean; label: string; map: FieldMap; findings: string[] }> {
  const res = await fetch(`/api/vessels/${vesselId}/field-map${dryRun ? "?dry_run=true" : ""}`, {
    method: "POST",
    headers: { ...headers(id), "content-type": "application/json" },
    body: JSON.stringify({ label, map }),
  });
  if (!res.ok) throw await doorRefusal(res, "field map");
  return (await res.json()) as never;
}

/** Back to today's convention — the next import reads the default names. */
export async function revertFieldMap(id: Identity, vesselId: string): Promise<void> {
  const res = await fetch(`/api/vessels/${vesselId}/field-map/revert`, {
    method: "POST",
    headers: headers(id),
  });
  if (!res.ok) throw await doorRefusal(res, "field map revert");
}

/** Every import, newest first, with the served one pointed to. */
export async function listScheduleRuns(
  id: Identity,
  vesselId: string,
): Promise<{ served: string | null; runs: ScheduleRunSummary[] }> {
  const res = await fetch(`/api/vessels/${vesselId}/schedule-runs`, { headers: headers(id) });
  if (!res.ok) throw new Error(`schedule runs → ${res.status}`);
  return (await res.json()) as never;
}

/** One run's summary and report, without its rows. */
export async function scheduleRunDetail(
  id: Identity,
  vesselId: string,
  runId: string,
): Promise<{ summary: ScheduleRunSummary; report: ScheduleRunReport }> {
  const res = await fetch(`/api/vessels/${vesselId}/schedule-runs/detail?run=${encodeURIComponent(runId)}`, {
    headers: headers(id),
  });
  if (!res.ok) throw await doorRefusal(res, "run detail");
  return (await res.json()) as never;
}

/** What `run` changes against `against` (the served run when omitted), in
 *  the door's delta shape, under today's hazards. */
export async function diffScheduleRuns(
  id: Identity,
  vesselId: string,
  runId: string,
  against?: string,
): Promise<{ run: ScheduleRunSummary; against: ScheduleRunSummary; delta: ScheduleDelta }> {
  const q = `run=${encodeURIComponent(runId)}${against ? `&against=${encodeURIComponent(against)}` : ""}`;
  const res = await fetch(`/api/vessels/${vesselId}/schedule-runs/diff?${q}`, { headers: headers(id) });
  if (!res.ok) throw await doorRefusal(res, "run diff");
  return (await res.json()) as never;
}

/** A prior run's rows become the served schedule of record — a revert to an
 *  earlier import, ledgered `SCHEDULE_REPLACED` naming both runs. 409 when
 *  the store no longer holds the run's rows. */
export async function serveScheduleRun(
  id: Identity,
  vesselId: string,
  runId: string,
): Promise<{ served: ScheduleRunSummary; delta: ScheduleDelta }> {
  const res = await fetch(`/api/vessels/${vesselId}/schedule-runs/serve`, {
    method: "POST",
    headers: { ...headers(id), "content-type": "application/json" },
    body: JSON.stringify({ run_id: runId }),
  });
  if (!res.ok) throw await doorRefusal(res, "serve run");
  return (await res.json()) as never;
}

export async function listActivities(
  id: Identity,
  vesselId: string,
  asOf: AsOf = null,
): Promise<ActivityRegister> {
  const res = await fetch(withAsOf(`/api/vessels/${vesselId}/activities`, asOf), {
    headers: headers(id),
  });
  if (!res.ok) throw new Error(`activities → ${res.status}`);
  return (await res.json()) as ActivityRegister;
}

/* -------------------------------------------------------------------- ledger */

/** One audit ledger entry, as served — hashes hex, detail as recorded. */
export interface AuditEntry {
  seq: number;
  /** What was recorded, e.g. `MITIGATION_ACCEPTED`, `ISSUE_ACKNOWLEDGED`. */
  action: string;
  /** The full record. Hashed, so this is the trusted content. */
  detail: string;
  /** Denormalised lookup key — a placard or an issue key. Index, not record. */
  subject_ref: string | null;
  occurred_at_ms: number;
  entry_hash: string;
  prev_hash: string | null;
  /** The person who acted, as the identity hop asserted them; null on rows
   *  written before people were asserted (chain format 1). */
  actor_id: string | null;
  /** That person's display name at the time — hashed with the id from
   *  format 2 on, so a later rename does not rewrite history. */
  actor_name: string | null;
  /** 1 before people were asserted; 2 from the row that first named one. */
  chain_version: number;
}

/** The ledger with its chain re-verified server-side on this very read. */
export interface LedgerReport {
  verified: boolean;
  break: { seq: number; reason: string } | null;
  /** Newest first. */
  entries: AuditEntry[];
}

export async function listLedger(id: Identity, vesselId: string): Promise<LedgerReport> {
  const res = await fetch(`/api/vessels/${vesselId}/ledger`, { headers: headers(id) });
  if (!res.ok) throw new Error(`ledger → ${res.status}`);
  return (await res.json()) as LedgerReport;
}

/* --------------------------------------------------------------- zone chart */

/** One zone's authored frame bounds, from the yard's zone chart. */
export interface ZoneBound {
  zone: string;
  lo_frame: number;
  hi_frame: number;
  /** The block's deck band, by register deck code — a zone is a block of
   *  decks as well as a band of frames (docs/zone-scheme.md). Absent on
   *  both: the block spans every deck. */
  top_deck?: string | null;
  bottom_deck?: string | null;
}

/** The server's join of chart to register — computed once, on the API. */
export interface ZoneAudit {
  /** Spaces assigned to a zone whose authored bounds they sit outside. */
  out_of_bounds: {
    compartment: string;
    zone: string;
    frame: number;
    deck_code: string;
    lo_frame: number;
    hi_frame: number;
    /** The zone's blocks, in words — "Fr 96–191 on 2nd–2ndplat; Fr 116–175 on hold–db". */
    bounds: string;
  }[];
  /** Zones carrying spaces the chart does not bound. */
  unbounded_zones: string[];
  /** Chart bounds naming a zone with no spaces — information, not error. */
  unassigned_bounds: string[];
}

export interface ZoneChart {
  /** The ingested chart's label, or null when bands are inferred. */
  source: string | null;
  bounds: ZoneBound[];
  audit: ZoneAudit;
}

/** One space next door to a zone, and why it counts as next door. */
export interface AdjacentSpace {
  compartment: string;
  name: string;
  zone: string;
  deck_code: string;
  deck_ordinal: number;
  frame: number | null;
  side: string;
  /** `frame_boundary`, `deck_above`, `deck_below`, `coupled:<code>` — every reason that applies. */
  via: string[];
  state: DecisionState;
  permits_work: boolean;
  /** Field conditions live in the space at the instant. */
  hazards: { kind: string; label: string }[];
}

/** The spaces next door to a zone — the server's answer (docs/zone-scheme.md). */
export interface ZoneAdjacency {
  zone: string;
  as_of: number;
  inside: string[];
  adjacent: AdjacentSpace[];
  basis: string;
}

// What is about to reach into a zone from outside it: served once from the
// register, the geometry and the coupling graph, never re-derived here.
export async function zoneAdjacent(
  id: Identity,
  vesselId: string,
  zone: string,
  asOf: AsOf = null,
): Promise<ZoneAdjacency> {
  const res = await fetch(
    withAsOf(`/api/vessels/${vesselId}/zones/${encodeURIComponent(zone)}/adjacent`, asOf),
    { headers: headers(id) },
  );
  if (!res.ok) throw new Error(`zone adjacency → ${res.status}`);
  return (await res.json()) as ZoneAdjacency;
}

export async function getZoneChart(id: Identity, vesselId: string): Promise<ZoneChart> {
  const res = await fetch(`/api/vessels/${vesselId}/zones`, { headers: headers(id) });
  if (!res.ok) throw new Error(`zones → ${res.status}`);
  return (await res.json()) as ZoneChart;
}

/** Ingests a zone chart, all-or-nothing. `dryRun` previews the audit only. */
export async function importZoneChart(
  id: Identity,
  vesselId: string,
  label: string,
  bounds: ZoneBound[],
  dryRun: boolean,
): Promise<{ stored: boolean; label: string; zones: number; audit: ZoneAudit }> {
  const res = await fetch(`/api/vessels/${vesselId}/zones${dryRun ? "?dry_run=true" : ""}`, {
    method: "POST",
    headers: { ...headers(id), "content-type": "application/json" },
    body: JSON.stringify({ label, bounds }),
  });
  if (!res.ok) throw await doorRefusal(res, "zone chart");
  return (await res.json()) as { stored: boolean; label: string; zones: number; audit: ZoneAudit };
}

export async function revertZoneChart(id: Identity, vesselId: string): Promise<void> {
  const res = await fetch(`/api/vessels/${vesselId}/zones/revert`, {
    method: "POST",
    headers: headers(id),
  });
  if (!res.ok) throw await doorRefusal(res, "zones revert");
}

/* -------------------------------------------------------------- budget book */

/** One work item's budget line, as a book carries it. */
export interface BudgetItem {
  code: string;
  title: string;
  trade: string;
  budget_hours: number;
  earned_hours: number;
}

/** Ingests a budget book, all-or-nothing. `dryRun` previews the comparison. */
export async function importBudgetBook(
  id: Identity,
  vesselId: string,
  label: string,
  items: BudgetItem[],
  dryRun: boolean,
): Promise<{
  stored: boolean;
  label: string;
  items: number;
  reconciliation: {
    source: string | null;
    items: number;
    mismatches: ReconciliationMismatch[];
    unmapped_budget_hours: number;
  };
}> {
  const res = await fetch(`/api/vessels/${vesselId}/budget-book${dryRun ? "?dry_run=true" : ""}`, {
    method: "POST",
    headers: { ...headers(id), "content-type": "application/json" },
    body: JSON.stringify({ label, items }),
  });
  if (!res.ok) throw await doorRefusal(res, "budget book");
  return (await res.json()) as never;
}

export async function revertBudgetBook(id: Identity, vesselId: string): Promise<void> {
  const res = await fetch(`/api/vessels/${vesselId}/budget-book/revert`, {
    method: "POST",
    headers: headers(id),
  });
  if (!res.ok) throw await doorRefusal(res, "budget book revert");
}

/** One line of the manning book: people a trade has, per half-shift. */
export interface ManningCrew {
  trade: string;
  headcount: number;
}

/** The supply side of crew planning — imported, never invented. */
export interface ManningBook {
  label: string;
  crews: ManningCrew[];
}

/** Which register trades a candidate book does and does not cover. */
export interface ManningCoverage {
  book_trades_matching_no_register_trade: string[];
  register_trades_with_no_manning_line: string[];
}

// The hull's manning book, or null — in which case every crew read shows
// demand only and says so.
export async function getManningBook(id: Identity, vesselId: string): Promise<ManningBook | null> {
  const res = await fetch(`/api/vessels/${vesselId}/manning-book`, { headers: headers(id) });
  if (!res.ok) throw new Error(`manning book → ${res.status}`);
  const body = (await res.json()) as { book: ManningBook | null };
  return body.book;
}

/** Ingests a manning book, all-or-nothing. `dryRun` previews trade coverage. */
export async function importManningBook(
  id: Identity,
  vesselId: string,
  label: string,
  crews: ManningCrew[],
  dryRun: boolean,
): Promise<{ stored: boolean; label: string; crews: number; coverage: ManningCoverage }> {
  const res = await fetch(
    `/api/vessels/${vesselId}/manning-book${dryRun ? "?dry_run=true" : ""}`,
    {
      method: "POST",
      headers: { ...headers(id), "content-type": "application/json" },
      body: JSON.stringify({ label, crews }),
    },
  );
  if (!res.ok) throw await doorRefusal(res, "manning book");
  return (await res.json()) as never;
}

export async function revertManningBook(id: Identity, vesselId: string): Promise<void> {
  const res = await fetch(`/api/vessels/${vesselId}/manning-book/revert`, {
    method: "POST",
    headers: headers(id),
  });
  if (!res.ok) throw await doorRefusal(res, "manning book revert");
}

/* ------------------------------------------------------------ the yard clock */

/** One finding the clock door makes without refusing. */
export interface ClockDoorFinding {
  severity: "warn" | "info";
  text: string;
}

/** What the clock door previews: the wall clock now, this year's transitions
 *  as local readings, today's shifts as instants, and which clock the served
 *  schedule of record was parsed in. */
export interface ClockPreview {
  now_local: string;
  offset_now: string;
  transitions: { at_ms: number; local: string; to: string }[];
  shifts_today: { name: string; start_ms: number; end_ms: number; local: string }[];
  schedule_of_record: { label: string; parsed_in: string | null } | null;
}

/** The hull's clock in effect, with the wall clock and offset right now. */
export async function getYardClock(
  id: Identity,
  vesselId: string,
): Promise<YardClockInfo & { now_local: string; offset_now: string }> {
  const res = await fetch(`/api/vessels/${vesselId}/yard-clock`, { headers: headers(id) });
  if (!res.ok) throw new Error(`yard clock → ${res.status}`);
  return (await res.json()) as never;
}

/** Ingests the yard's clock, refused whole with every reason (422 — the
 *  server's sentence is the error). `dryRun` previews the findings and this
 *  year's transitions and stores nothing. */
export async function importYardClock(
  id: Identity,
  vesselId: string,
  label: string,
  clock: YardClock,
  dryRun: boolean,
): Promise<{ stored: boolean; label: string; findings: ClockDoorFinding[]; preview: ClockPreview }> {
  const res = await fetch(`/api/vessels/${vesselId}/yard-clock${dryRun ? "?dry_run=true" : ""}`, {
    method: "POST",
    headers: { ...headers(id), "content-type": "application/json" },
    body: JSON.stringify({ label, clock }),
  });
  if (!res.ok) throw await doorRefusal(res, "yard clock");
  return (await res.json()) as never;
}

/** Back to the UTC default — every clock on screen carries a Z again. */
export async function revertYardClock(id: Identity, vesselId: string): Promise<void> {
  const res = await fetch(`/api/vessels/${vesselId}/yard-clock/revert`, {
    method: "POST",
    headers: headers(id),
  });
  if (!res.ok) throw await doorRefusal(res, "yard clock revert");
}

/** One surveyed space of a geometry register (docs/geometry-accuracy.md). */
export interface SpaceGeometry {
  compartment_no: string;
  fwd_frame: number;
  aft_frame: number;
}

/** One coverage band: the frames where a deck physically exists. */
export interface DeckBand {
  deck_code: string;
  lo_frame: number;
  hi_frame: number;
}

/** The findings a geometry register raises against the register, live. */
export interface GeometryFindings {
  surveyed: number;
  register_total: number;
  placard_disagreements: { compartment_no: string; placard_frame: number; surveyed_fwd: number }[];
  outside_deck_coverage: { compartment_no: string; deck_code: string; fwd_frame: number; aft_frame: number }[];
  unknown_spaces: { count: number; examples: string[] };
}

/** The served geometry register, summarized, with its live findings. */
export interface GeometryInfo {
  register: { label: string; spaces: number; decks: DeckBand[] } | null;
  findings: GeometryFindings | null;
}

// The hull's geometry register with its live findings — or nulls, and every
// drawn position is a placard parse that says so.
export async function getGeometry(id: Identity, vesselId: string): Promise<GeometryInfo> {
  const res = await fetch(`/api/vessels/${vesselId}/geometry`, { headers: headers(id) });
  if (!res.ok) throw new Error(`geometry → ${res.status}`);
  return (await res.json()) as GeometryInfo;
}

/** Ingests a geometry register, all-or-nothing. `dryRun` previews findings. */
export async function importGeometry(
  id: Identity,
  vesselId: string,
  label: string,
  spaces: SpaceGeometry[],
  decks: DeckBand[],
  dryRun: boolean,
): Promise<{
  stored: boolean;
  label: string;
  spaces: number;
  deck_bands: number;
  findings: GeometryFindings;
}> {
  const res = await fetch(`/api/vessels/${vesselId}/geometry${dryRun ? "?dry_run=true" : ""}`, {
    method: "POST",
    headers: { ...headers(id), "content-type": "application/json" },
    body: JSON.stringify({ label, spaces, decks }),
  });
  if (!res.ok) throw await doorRefusal(res, "geometry");
  return (await res.json()) as never;
}

export async function revertGeometry(id: Identity, vesselId: string): Promise<void> {
  const res = await fetch(`/api/vessels/${vesselId}/geometry/revert`, {
    method: "POST",
    headers: headers(id),
  });
  if (!res.ok) throw await doorRefusal(res, "geometry revert");
}

/* ------------------------------------------ the ship, through the product */

/** One deck of a compartment register, ordered downward by `ordinal`. */
export interface RegisterDeck {
  code: string;
  label: string;
  ordinal: number;
}

/** One space of a compartment register — the hull's own placard list. */
export interface RegisterSpace {
  compartment_no: string;
  name: string;
  deck_code: string;
  zone: string;
  category: string;
  /** Frame station when the register carries it; else parsed from the placard. */
  frame?: number;
  /** `port`, `starboard` or `centreline` when the register carries it. */
  side?: string;
}

/** What a candidate register would change, computed before Confirm. */
export interface RegisterFindings {
  /** Placards the numbering scheme cannot place and that carry no frame. */
  unplaceable: string[];
  /** Decks with no space on them. */
  empty_decks: string[];
  /** Live field conditions whose space the new register does not carry. */
  orphaned_hazards: { compartment: string; label: string }[];
  /** Scheduled activities located to spaces the new register does not carry. */
  activities_losing_their_space: number;
}

/** The compartment register as served: ingested, or the seeded template. */
export interface RegisterInfo {
  register: { label: string; decks: number; spaces: number } | null;
  served: "ingested" | "seeded";
  spaces_served: number;
  decks_served: number;
}

// The hull's compartment register — what every read is built from.
export async function getRegister(id: Identity, vesselId: string): Promise<RegisterInfo> {
  const res = await fetch(`/api/vessels/${vesselId}/register`, { headers: headers(id) });
  if (!res.ok) throw new Error(`register → ${res.status}`);
  return (await res.json()) as RegisterInfo;
}

/**
 * Ingests the hull's compartment register, all-or-nothing. `dryRun` previews
 * the findings and stores nothing. Once stored, every screen serves it and
 * the seeded register stops existing for this hull until a revert.
 */
export async function importRegister(
  id: Identity,
  vesselId: string,
  label: string,
  decks: RegisterDeck[],
  spaces: RegisterSpace[],
  dryRun: boolean,
): Promise<{ stored: boolean; label: string; decks: number; spaces: number; findings: RegisterFindings }> {
  const res = await fetch(`/api/vessels/${vesselId}/register${dryRun ? "?dry_run=true" : ""}`, {
    method: "POST",
    headers: { ...headers(id), "content-type": "application/json" },
    body: JSON.stringify({ label, decks, spaces }),
  });
  if (!res.ok) throw await doorRefusal(res, "register");
  return (await res.json()) as never;
}

export async function revertRegister(id: Identity, vesselId: string): Promise<void> {
  const res = await fetch(`/api/vessels/${vesselId}/register/revert`, {
    method: "POST",
    headers: headers(id),
  });
  if (!res.ok) throw await doorRefusal(res, "register revert");
}

/** One coupling: a physical path a hazard can travel between two spaces. */
export interface CouplingRow {
  from: string;
  to: string;
  /** The coupling type's code — what the rules bind to. */
  code: string;
  /** Store the reverse path too. */
  symmetric?: boolean;
  /** `authored` by a person, or `derived` by the door from deck order and frames. */
  provenance?: "authored" | "derived";
}

/** A coupling type the hull's rules can bind to. */
export interface CouplingType {
  code: string;
  propagates: string[];
  max_reach: number;
}

/** The coupling register as served, and the graph the traces actually walk. */
export interface CouplingsInfo {
  register: { label: string; edges: number; authored: number; derived: number } | null;
  served: "ingested" | "seeded";
  edges_served: number;
  types: CouplingType[];
}

// The hull's coupling register with the graph edge count the traces walk.
export async function getCouplings(id: Identity, vesselId: string): Promise<CouplingsInfo> {
  const res = await fetch(`/api/vessels/${vesselId}/couplings`, { headers: headers(id) });
  if (!res.ok) throw new Error(`couplings → ${res.status}`);
  return (await res.json()) as CouplingsInfo;
}

/**
 * Ingests the hull's coupling register, all-or-nothing. `deriveVertical` asks
 * the door to propose deck penetrations from deck order and frame overlap,
 * each marked `derived`; `dryRun` previews every proposed edge and stores
 * nothing.
 */
export async function importCouplings(
  id: Identity,
  vesselId: string,
  label: string,
  edges: CouplingRow[],
  deriveVertical: boolean,
  dryRun: boolean,
): Promise<{
  stored: boolean;
  label: string;
  authored: number;
  derived: number;
  derived_edges: CouplingRow[];
  edges: number;
}> {
  const res = await fetch(`/api/vessels/${vesselId}/couplings${dryRun ? "?dry_run=true" : ""}`, {
    method: "POST",
    headers: { ...headers(id), "content-type": "application/json" },
    body: JSON.stringify({ label, edges, derive_vertical: deriveVertical }),
  });
  if (!res.ok) throw await doorRefusal(res, "couplings");
  return (await res.json()) as never;
}

export async function revertCouplings(id: Identity, vesselId: string): Promise<void> {
  const res = await fetch(`/api/vessels/${vesselId}/couplings/revert`, {
    method: "POST",
    headers: headers(id),
  });
  if (!res.ok) throw await doorRefusal(res, "couplings revert");
}

/** One line of a hazard log — the day's tag-out or permit list. */
export interface HazardLogRow {
  compartment: string;
  /** The engine's kind name, e.g. `energised_bus`. */
  kind: string;
  label: string;
  /** When it was raised, epoch ms; the wall clock when absent. */
  since_ms?: number;
}

/**
 * Raises every field condition in a log that is not already live. The same
 * validation as a single raise, applied to the whole file before any row
 * lands; a row already live is skipped, not refused. `dryRun` answers with
 * what would be raised and what is already live, storing nothing.
 */
export async function importHazardLog(
  id: Identity,
  vesselId: string,
  label: string,
  rows: HazardLogRow[],
  dryRun: boolean,
): Promise<{
  stored: boolean;
  label: string;
  rows: number;
  would_raise?: { compartment: string; kind: string; label: string }[];
  raised?: LiveHazard[];
  already_live: { compartment: string; kind: string }[];
}> {
  const res = await fetch(`/api/vessels/${vesselId}/hazards/import${dryRun ? "?dry_run=true" : ""}`, {
    method: "POST",
    headers: { ...headers(id), "content-type": "application/json" },
    body: JSON.stringify({ label, rows }),
  });
  if (!res.ok) throw await doorRefusal(res, "hazard log");
  return (await res.json()) as never;
}
