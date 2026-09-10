// The crew arithmetic is one rule used three ways, so the rule is pinned once:
// people = pro-rated hours ÷ window duration, zones roll up spaces, and the
// interaction rollup folds A↔B with B↔A.

import { describe, expect, it } from "vitest";
import type { Activity, WorkConflicts } from "./api";
import { demandByTrade, demandByZone, peopleFor, zoneInteractions } from "./manning";

const H = 3_600_000;

function act(over: Partial<Activity>): Activity {
  return {
    activity_id: "x",
    code: "A1",
    name: "n",
    work_order_code: null,
    compartment_no: null,
    compartment_reliability: "mapped" as Activity["compartment_reliability"],
    wbs_area: null,
    trade: "Electrical",
    planned: { start: 0, end: 4 * H },
    budget_hours: 8,
    earned_hours: 0,
    remaining_hours: 8,
    status: "not_started" as Activity["status"],
    is_milestone: false,
    source_ref: "t",
    in_window: true,
    executability: { state: "executable" } as unknown as Activity["executability"],
    ...over,
  };
}

describe("crew demand", () => {
  it("prices people as hours over the window: 8 MH in a 4-hour half-shift is two people", () => {
    expect(peopleFor(8, 4 * H)).toBe(2);
    const d = demandByTrade([act({})], 0, 4 * H);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ trade: "Electrical", hours: 8, people: 2 });
  });

  it("pro-rates by overlap, the shared rule: half the window overlapped, half the hours", () => {
    // Activity planned 0..4h; window 2h..6h → 2h of 4h overlap → 4 MH → 1 person over 4h.
    const d = demandByTrade([act({})], 2 * H, 6 * H);
    expect(d[0].hours).toBe(4);
    expect(d[0].people).toBe(1);
  });

  it("rolls zones up from spaces, keeps unzoned hours visible, and flags crowding per space", () => {
    const spaceZone = new Map([
      ["3-100-0-Q", "Z3"],
      ["3-200-0-Q", "Z5"],
    ]);
    const acts = [
      act({ compartment_no: "3-100-0-Q", budget_hours: 100, trade: "Electrical" }),
      act({ compartment_no: "3-200-0-Q", budget_hours: 8, trade: "Pipefitting" }),
      act({ compartment_no: "9-999-9-X", budget_hours: 4 }),
    ];
    const { zones, unzonedHours } = demandByZone(acts, spaceZone, 0, 4 * H, 6);
    expect(zones.map((z) => z.zone)).toEqual(["Z3", "Z5"]);
    // 100 MH in one space over 4h = 25 people > tolerance 6 → the zone is crowded.
    expect(zones[0]).toMatchObject({ hours: 100, people: 25, crowded: true });
    expect(zones[1]).toMatchObject({ hours: 8, people: 2, crowded: false });
    expect(unzonedHours).toBe(4);
  });

  it("folds conflict pairs into one row per zone pair, either direction", () => {
    const conflicts = {
      day: { start: 0, end: 24 * H },
      pairs: [
        { hot: { code: "A", name: "", space: "3-100-0-Q", trade: "" }, flammable: { code: "B", name: "", space: "3-200-0-Q", trade: "" }, via: "x", reason: "r1" },
        { hot: { code: "C", name: "", space: "3-200-0-Q", trade: "" }, flammable: { code: "D", name: "", space: "3-100-0-Q", trade: "" }, via: "x", reason: "r2" },
      ],
      dropped: 0,
      scanned: 2,
      basis: "",
    } as WorkConflicts;
    const spaceZone = new Map([
      ["3-100-0-Q", "Z3"],
      ["3-200-0-Q", "Z5"],
    ]);
    const rows = zoneInteractions(conflicts, spaceZone);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ a: "Z3", b: "Z5", pairs: 2 });
  });
});
