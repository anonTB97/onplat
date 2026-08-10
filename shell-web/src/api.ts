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
