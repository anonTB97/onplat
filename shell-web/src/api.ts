// Thin API client. Identity is a milestone-1 header shim (x-org-id +
// x-assigned-vessels), matching wadl-api's auth extractor; a real session
// replaces it later. No external hosts — same-origin only.

export interface VesselSummary {
  vessel_id: string;
  hull_no: string;
  name: string;
  class_code: string;
  availability_code: string;
  confidence: string;
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
}

export interface PackageSummary {
  work_order_id: string;
  code: string;
  name: string;
  system: string;
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

export async function listWorkOrders(id: Identity, vesselId: string): Promise<WorkOrder[]> {
  const res = await fetch(`/api/vessels/${vesselId}/work-orders`, { headers: headers(id) });
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
): Promise<PackageDetail> {
  const res = await fetch(`/api/vessels/${vesselId}/packages/${encodeURIComponent(code)}`, {
    headers: headers(id),
  });
  if (!res.ok) throw new Error(`package ${code} → ${res.status}`);
  return (await res.json()) as PackageDetail;
}

export async function listDecks(id: Identity, vesselId: string): Promise<Deck[]> {
  const res = await fetch(`/api/vessels/${vesselId}/decks`, { headers: headers(id) });
  if (!res.ok) throw new Error(`decks → ${res.status}`);
  return (await res.json()) as Deck[];
}

// Authorization state is read THROUGH the engine, never computed here.
export async function deckStates(id: Identity, vesselId: string): Promise<DeckStateRow[]> {
  const res = await fetch(`/api/vessels/${vesselId}/deck-states`, { headers: headers(id) });
  if (!res.ok) throw new Error(`deck-states → ${res.status}`);
  return (await res.json()) as DeckStateRow[];
}

// The full decision trace for one compartment — what the field app renders and
// a board of inquiry reads.
export async function compartmentState(
  id: Identity,
  vesselId: string,
  compartmentNo: string,
): Promise<{ compartment: string; decision: Decision }> {
  const res = await fetch(
    `/api/vessels/${vesselId}/compartments/${encodeURIComponent(compartmentNo)}/state`,
    { headers: headers(id) },
  );
  if (!res.ok) throw new Error(`compartment state → ${res.status}`);
  return (await res.json()) as { compartment: string; decision: Decision };
}
