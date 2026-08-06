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

export interface CompartmentState {
  compartment: string;
  state: "ALLOW" | "WARN" | "BLOCK" | "SUSPEND";
  trace_len: number;
}

// Authorization state is read THROUGH the engine, never computed here.
export async function compartmentState(
  id: Identity,
  vesselId: string,
  compartmentNo: string,
): Promise<CompartmentState> {
  const res = await fetch(
    `/api/vessels/${vesselId}/compartments/${encodeURIComponent(compartmentNo)}/state`,
    { headers: headers(id) },
  );
  if (!res.ok) throw new Error(`compartment state → ${res.status}`);
  return (await res.json()) as CompartmentState;
}
