import { describe, expect, it } from "vitest";
import type { Activity, DeckStateRow, Issue, LiveHazard } from "./api";
import {
  conflictLog,
  csvCell,
  fieldConditions,
  reportFilename,
  shiftSheet,
  shiftWindow,
  toCsv,
  toPrintHtml,
  zoneSheet,
} from "./reports";

const DAY = 86_400_000;
const HOUR = 3_600_000;
// A UTC midnight, so the shift windows are easy to reason about.
const MIDNIGHT = Date.UTC(2026, 8, 2);
const CUT = { hull: "CVN-73 PIA-26", asOfMs: MIDNIGHT + 9 * HOUR, scheduleSource: "sample.xer", producedBy: "Foreman" };

function space(no: string, zone: string, held: boolean): DeckStateRow {
  return {
    trades: ["SM-PIPE"],
    work_order_codes: ["WI-1"],
    remaining_hours: held ? 120 : 40,
    compartment: {
      frame: 160, fwd_frame: null, aft_frame: null, side: "port", geometry_source: "parsed",
      compartment_no: no, name: `Space ${no}`, deck_code: "3rd", deck_ordinal: 3, zone, category: "Q",
    },
    state: held ? "BLOCK" : "ALLOW",
    permits_work: !held,
    rules_fired: held ? ["R03"] : [],
    earliest_clear: null,
    readiness: held ? "held" : "go",
    clearing_authority: held ? "marine_chemist" : "",
  };
}

function activity(code: string, no: string | null, trade: string, start: number, end: number, notExecutable = false): Activity {
  return {
    activity_id: code, code, name: `Task ${code}`, work_order_code: "WI-1", compartment_no: no,
    compartment_reliability: "high" as Activity["compartment_reliability"], wbs_area: null, trade,
    planned: { start, end }, budget_hours: 80, earned_hours: 0, remaining_hours: 80,
    status: "not_started", is_milestone: false, source_ref: "x", in_window: true,
    executability: notExecutable
      ? { verdict: "not_executable", at: start, state: "BLOCK", rule_code: "R03", origin: no ?? "", hazard: "coat curing", clearing_authority: "marine_chemist", earliest_clear: null }
      : { verdict: "executable" },
  };
}

const SPACES = [space("3-160-2-Q", "Z6", true), space("3-148-2-E", "Z5", false), space("3-152-0-Q", "Z6", false)];

describe("shift sheet", () => {
  it("groups by trade, heaviest first, and names what stands in the way", () => {
    const acts = [
      activity("A1", "3-160-2-Q", "SM-PIPE", MIDNIGHT, MIDNIGHT + DAY, true),
      activity("A2", "3-148-2-E", "SM-ELEC", MIDNIGHT, MIDNIGHT + DAY),
      activity("A3", null, "SM-ELEC", MIDNIGHT, MIDNIGHT + DAY),
    ];
    const r = shiftSheet({ cut: CUT, activities: acts, spaces: SPACES, shift: "days", zone: null });
    expect(r.scope).toContain("Days 0700–1530 (Z)");
    // SM-ELEC has two activities in the window, so it is the heavier trade.
    expect(r.sections.map((s) => s.heading)).toEqual(["SM-ELEC", "SM-PIPE"]);
    const pipe = r.sections[1]!.rows[0]!;
    expect(pipe[5]).toContain("HELD");
    expect(pipe[5]).toContain("NOT EXECUTABLE AS PLANNED");
    const unlocated = r.sections[0]!.rows.find((row) => row[0] === "A3")!;
    expect(unlocated[2]).toBe("not located");
    expect(unlocated[5]).toContain("UNLOCATED");
  });

  it("cuts to one zone when asked", () => {
    const acts = [
      activity("A1", "3-160-2-Q", "SM-PIPE", MIDNIGHT, MIDNIGHT + DAY),
      activity("A2", "3-148-2-E", "SM-ELEC", MIDNIGHT, MIDNIGHT + DAY),
    ];
    const r = shiftSheet({ cut: CUT, activities: acts, spaces: SPACES, shift: "instant", zone: "Z5" });
    expect(r.sections.map((s) => s.heading)).toEqual(["SM-ELEC"]);
    expect(r.scope).toContain("Zone Z5");
  });

  it("says so when nothing is planned rather than printing an empty table", () => {
    const r = shiftSheet({ cut: CUT, activities: [], spaces: SPACES, shift: "night", zone: null });
    expect(r.sections[0]!.rows[0]![0]).toMatch(/No activities/);
  });
});

describe("shift windows", () => {
  it("are anchored to the as-of day and labelled Zulu until the yard clock lands", () => {
    const days = shiftWindow(MIDNIGHT + 9 * HOUR, "days")!;
    expect(days.start).toBe(MIDNIGHT + 7 * HOUR);
    expect(days.end).toBe(MIDNIGHT + 15.5 * HOUR);
    expect(days.label).toContain("(Z)");
    expect(shiftWindow(MIDNIGHT, "instant")).toBeNull();
  });
});

describe("zone day sheet", () => {
  it("lists the zone's spaces worst first with its field conditions and broken plans", () => {
    const hazards: LiveHazard[] = [
      { origin: "3-160-2-Q", kind: "coating_open", since: MIDNIGHT, label: "CT-3160-4 final coat, curing" },
      { origin: "3-148-2-E", kind: "energised_bus", since: MIDNIGHT, label: "Bus energised" },
    ];
    const acts = [activity("A1", "3-160-2-Q", "SM-PIPE", MIDNIGHT, MIDNIGHT + DAY, true)];
    const r = zoneSheet({ cut: CUT, zone: "Z6", activities: acts, spaces: SPACES, hazards, windowMs: DAY });
    const [spaces, conditions, broken] = r.sections;
    expect(spaces!.rows.map((row) => row[0])).toEqual(["3-160-2-Q", "3-152-0-Q"]);
    expect(spaces!.rows[0]![3]).toBe("NO ENTRY (BLOCK)");
    expect(conditions!.rows).toHaveLength(1);
    expect(conditions!.rows[0]![0]).toBe("3-160-2-Q");
    expect(broken!.rows[0]![0]).toBe("A1");
  });
});

describe("conflict log and field conditions", () => {
  it("keeps the board's ranking and shows what was answered for", () => {
    const issues: Issue[] = [
      { key: "k1", acknowledged: null, decision: null, kind: "held_with_crews_booked", compartment: "3-160-2-Q", hours_at_risk: 484, state: "BLOCK", clearing_authority: "marine_chemist", earliest_clear: null },
      { key: "k2", acknowledged: { at: MIDNIGHT, note: "crew moved to swing" }, decision: null, kind: "negative_lag", pred: "A1", succ: "A2", lag_hours: -4, hours_at_risk: 10 },
    ];
    const r = conflictLog({ cut: CUT, issues, spaces: SPACES, zone: null });
    expect(r.sections[0]!.heading).toContain("2 issues · 1 not yet answered for");
    expect(r.sections[0]!.rows[0]![1]).toBe("HELD · CREWS BOOKED");
    expect(r.sections[0]!.rows[1]![6]).toContain("crew moved to swing");
    const z6 = conflictLog({ cut: CUT, issues, spaces: SPACES, zone: "Z6" });
    expect(z6.sections[0]!.rows).toHaveLength(1);
  });

  it("registers every open condition with how long it has been open", () => {
    const hazards: LiveHazard[] = [{ origin: "3-160-2-Q", kind: "coating_open", since: CUT.asOfMs - 3 * DAY, label: "curing" }];
    const r = fieldConditions({ cut: CUT, hazards, spaces: SPACES });
    expect(r.sections[0]!.rows[0]!.slice(0, 3)).toEqual(["3-160-2-Q", "3rd", "Z6"]);
    expect(r.sections[0]!.rows[0]![6]).toBe("3 days");
  });
});

describe("CSV and print", () => {
  it("quotes commas and doubles quotes", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('a, "b"')).toBe('"a, ""b"""');
  });

  it("carries the cut and every section into the CSV and the print page", () => {
    const r = fieldConditions({ cut: CUT, hazards: [], spaces: SPACES });
    const csv = toCsv(r);
    expect(csv[0]).toBe("report,Field-condition register");
    expect(csv).toContain("schedule,sample.xer");
    expect(csv.some((l) => l.startsWith("section,"))).toBe(true);
    const html = toPrintHtml(r);
    expect(html).toContain("CVN-73 PIA-26");
    expect(html).toContain("Decision support");
    expect(reportFilename(r, "csv")).toMatch(/^field-condition-register-cvn-73-pia-26-whole-hull-asof-\d{12}\.csv$/);
  });
});
