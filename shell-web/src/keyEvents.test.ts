import { afterEach, describe, expect, it } from "vitest";
import type { Activity, AlternativeRow, ScheduleEdge, ScheduleProposal } from "./api";
import { setYardClock } from "./clock";
import { daysStrip, gatingSet, keyEventSheet, keyEvents, proposalWord, weekBoard, type KeyEvent } from "./keyEvents";
import { toCsv, toPrintHtml } from "./reports";
import { UTC_CLOCK } from "./yardClock";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// A UTC midnight on a Wednesday (2026-09-02).
const T0 = Date.UTC(2026, 8, 2);
const EVENT_AT = T0 + 30 * DAY;

afterEach(() => setYardClock(null));

function activity(code: string, opts: Partial<Activity> & { start?: number; end?: number; refused?: { clear: number | null } } = {}): Activity {
  const planned = opts.planned === null ? null : { start: opts.start ?? T0 + DAY, end: opts.end ?? T0 + 5 * DAY };
  const base: Activity = {
    activity_id: code, code, name: `Task ${code}`, work_order_code: "WI-1", compartment_no: "3-148-2-E",
    compartment_reliability: "high", wbs_area: "Z4", trade: "SM-ELEC",
    planned, budget_hours: 100, earned_hours: 0, remaining_hours: 100,
    status: "not_started", is_milestone: false, source_ref: "x", in_window: true,
    executability: opts.refused
      ? { verdict: "not_executable", at: planned?.start ?? T0, state: "SUSPEND", rule_code: "R07", origin: "3-148-2-E", hazard: "Bus 3-SG-2 energised", clearing_authority: "isolation_authority", earliest_clear: opts.refused.clear }
      : planned === null
        ? { verdict: "unassessable", reason: "undated" }
        : { verdict: "executable" },
  };
  const { start: _s, end: _e, refused: _r, ...rest } = opts;
  return { ...base, ...rest, planned };
}

function milestone(code: string, at: number, status: Activity["status"] = "not_started"): Activity {
  return activity(code, { is_milestone: true, start: at, end: at, status, compartment_no: null, name: `${code} review` });
}

const edge = (pred: string, succ: string, lag = 0, kind = "PR_FS"): ScheduleEdge => ({ pred_code: pred, succ_code: succ, kind, lag_hours: lag });

function viable(code: string, start: number, end: number, delayH: number): AlternativeRow {
  return {
    activity: code, name: `Task ${code}`, compartment: "3-148-2-E", trade: "SM-ELEC",
    planned: { start: T0 + DAY, end: T0 + 5 * DAY }, remaining_hours: 100,
    refusal: { at: T0 + DAY, state: "SUSPEND", rule_code: "R07", origin: "3-148-2-E", hazard: "Bus", clearing_authority: "isolation_authority", earliest_clear: null },
    alternative: { kind: "viable", window: { start, end }, delay_hours: delayH },
    pushes: [],
  };
}

function gated(code: string): AlternativeRow {
  return { ...viable(code, 0, 0, 0), alternative: { kind: "verification_gated", refusal: { at: T0, state: "SUSPEND", rule_code: "R04", origin: "5-212-1-Q", hazard: "HW permit 2673", clearing_authority: "fire_marshal", earliest_clear: null } } };
}

function proposal(seq: number, code: string, status: ScheduleProposal["status"], to: { start: number; end: number } | null): ScheduleProposal {
  return {
    seq, entry_hash: "h", proposed_at_ms: T0, activity: code, name: `Task ${code}`, compartment: "3-148-2-E", trade: "SM-ELEC",
    from: { start: T0 + DAY, end: T0 + 5 * DAY }, to, kind: to ? "engine_window" : "hold_pending_verification", reason: "r",
    verdict: null, pushes: [], knock_on_basis: "b", status, planned_now: null,
  };
}

const M = milestone("M1", EVENT_AT);
const M_LATE = milestone("M2", EVENT_AT + 10 * DAY);
const M_DONE = milestone("M0", T0 - DAY, "complete");

describe("keyEvents", () => {
  it("lists future, incomplete milestones ascending and counts predecessors", () => {
    const acts = [M_LATE, M, M_DONE, activity("A1")];
    const edges = [edge("A1", "M1"), edge("A2", "M1")];
    const ev = keyEvents(acts, edges, T0);
    expect(ev.map((e) => e.code)).toEqual(["M1", "M2"]);
    expect(ev[0]?.predCount).toBe(2);
    expect(ev[1]?.predCount).toBe(0);
    // A milestone behind the instant is not upcoming.
    expect(keyEvents(acts, edges, EVENT_AT + DAY).map((e) => e.code)).toEqual(["M2"]);
  });
});

describe("gatingSet", () => {
  it("is transitive, ignores lag sign, excludes milestones and complete rows, and survives a cycle", () => {
    const acts = [M, M_DONE, activity("A1"), activity("A2"), activity("A3", { status: "complete" }), activity("A4")];
    const edges = [
      edge("A1", "M1"),
      edge("A2", "A1", -48, "PR_SS"),
      edge("A3", "A2"),
      edge("M0", "A2"),
      edge("A4", "A4"),
      edge("A1", "A2"), // the cycle A1 ↔ A2
    ];
    const g = gatingSet("M1", acts, edges);
    expect([...g].sort()).toEqual(["A1", "A2"]);
    expect(gatingSet("M2", acts, edges).size).toBe(0);
  });
});

describe("weekBoard", () => {
  const base = (rows: Activity[], edges: ScheduleEdge[], alts: AlternativeRow[] | null, props: ScheduleProposal[] | null = []) => {
    const acts = [M, M_LATE, ...rows];
    const events = keyEvents(acts, edges, T0);
    return weekBoard({ event: events[0] as KeyEvent, events, activities: acts, edges, alternatives: alts, proposals: props, fromMs: T0 + 9 * HOUR, clock: UTC_CLOCK, zone: null, zoneOf: new Map([["3-148-2-E", "Z4"]]) });
  };

  it("ranks misses-the-event, slides, cannot-be-assessed, planned-past, on-plan; ties by MH left", () => {
    const rows = [
      activity("ON1", { remaining_hours: 10 }),
      activity("ON2", { remaining_hours: 50 }),
      activity("PAST", { end: EVENT_AT + DAY }),
      activity("UNDATED", { planned: null }),
      activity("UNLOC", { compartment_no: null, executability: { verdict: "unassessable", reason: "unlocated" } }),
      activity("SLIDE", { refused: { clear: null } }),
      activity("MISS_WIN", { refused: { clear: null } }),
      activity("MISS_GATE", { refused: { clear: null } }),
      activity("MISS_NONE", { refused: { clear: T0 + 2 * DAY } }),
    ];
    const edges = rows.map((a) => edge(a.code, "M1"));
    const alts = [viable("SLIDE", T0 + 4 * DAY, T0 + 8 * DAY, 72), viable("MISS_WIN", T0 + 28 * DAY, EVENT_AT + DAY, 600), gated("MISS_GATE")];
    const board = base(rows, edges, alts);
    // Within a tier: MH left descending, then code — the three misses tie on MH.
    expect(board.rows.map((r) => r.a.code)).toEqual(["MISS_GATE", "MISS_NONE", "MISS_WIN", "SLIDE", "UNDATED", "UNLOC", "PAST", "ON2", "ON1"]);
    expect(board.rows.map((r) => r.tier)).toEqual([0, 0, 0, 1, 2, 2, 3, 4, 4]);
    const w = new Map(board.rows.map((r) => [r.a.code, r.word]));
    expect(w.get("MISS_WIN")).toBe("MISSES THE EVENT");
    expect(board.rows.find((r) => r.a.code === "MISS_WIN")?.why).toContain("after the event");
    expect(board.rows.find((r) => r.a.code === "MISS_GATE")?.why).toContain("clears on verification");
    expect(board.rows.find((r) => r.a.code === "MISS_NONE")?.why).toContain("served no window");
    expect(w.get("SLIDE")).toBe("SLIDES · still makes it (+3 d)");
    expect(w.get("UNDATED")).toBe("CANNOT BE ASSESSED");
    expect(w.get("PAST")).toBe("PLANNED PAST THE EVENT");
    expect(w.get("ON1")).toBe("on plan · margin 25 d");
    expect(board.rows.find((r) => r.a.code === "MISS_GATE")?.hold).toBe("R07 · Bus 3-SG-2 energised at 3-148-2-E · isolation authority · clears on verification");
    expect(board.rows.find((r) => r.a.code === "MISS_NONE")?.hold).toContain("clears by 09/04 00:00Z");
    expect(board.rows.find((r) => r.a.code === "ON1")?.marginDays).toBe(25);
    expect(board.totals).toMatchObject({ gating: 9, misses: 3, slides: 1, unassessed: 2, plannedPast: 1, onPlan: 2, proposalsOpen: 0, mhLeft: 760 });
    expect(board.eventsWithoutLogic.map((e) => e.code)).toEqual(["M2"]);
  });

  it("an unavailable alternatives read puts every refusal under misses-the-event and says why", () => {
    const rows = [activity("R1", { refused: { clear: null } })];
    const board = base(rows, [edge("R1", "M1")], null);
    expect(board.rows[0]?.tier).toBe(0);
    expect(board.rows[0]?.why).toContain("window is unavailable");
  });

  it("a proposal on a gating activity reads makes-it or misses-it against the event date; reflected keeps its word", () => {
    const props = [
      proposal(3, "A1", "open", { start: T0 + 10 * DAY, end: T0 + 20 * DAY }),
      proposal(1, "A1", "withdrawn", { start: T0, end: T0 + DAY }),
      proposal(4, "A2", "open", { start: T0 + 29 * DAY, end: EVENT_AT + 2 * DAY }),
      proposal(5, "A3", "reflected", { start: T0 + 10 * DAY, end: T0 + 20 * DAY }),
      proposal(6, "A4", "open", null),
    ];
    expect(proposalWord("A1", props, EVENT_AT)).toMatchObject({ seq: 3, text: "#3 OPEN → 09/12–09/22 · makes it", makesIt: true });
    expect(proposalWord("A2", props, EVENT_AT)).toMatchObject({ seq: 4, text: "#4 OPEN → 10/01–10/04 · misses it", makesIt: false });
    expect(proposalWord("A3", props, EVENT_AT)).toMatchObject({ seq: 5, text: "#5 REFLECTED", status: "reflected" });
    expect(proposalWord("A4", props, EVENT_AT)).toMatchObject({ seq: 6, text: "#6 OPEN · hold pending verification", makesIt: null });
    expect(proposalWord("A9", props, EVENT_AT)).toBeNull();
    expect(proposalWord("A1", null, EVENT_AT)).toBeNull();
    const rows = [activity("A1", { refused: { clear: null } }), activity("A2")];
    const board = base(rows, [edge("A1", "M1"), edge("A2", "M1")], [gated("A1")], props);
    expect(board.totals.proposalsOpen).toBe(2);
    expect(board.rows.find((r) => r.a.code === "A2")?.proposal?.text).toContain("misses it");
  });

  it("days strip counts starts and refusals per yard day over the gating set", () => {
    const rows = [
      activity("D1", { start: T0 + DAY + 2 * HOUR, end: T0 + 3 * DAY }),
      activity("D2", { start: T0 + DAY + 20 * HOUR, end: T0 + 2 * DAY }),
      // Refused from day 2 with a clear on day 4: refused on days 2 and 3.
      activity("R1", { start: T0 + 2 * DAY, end: T0 + 10 * DAY, refused: { clear: T0 + 4 * DAY } }),
      // Refused, no clock: refused on every day from its start.
      activity("R2", { start: T0 + 5 * DAY, end: T0 + 9 * DAY, refused: { clear: null } }),
    ];
    const board = base(rows, rows.map((a) => edge(a.code, "M1")), []);
    const strip = daysStrip(board.rows, T0 + 9 * HOUR, UTC_CLOCK);
    expect(strip).toHaveLength(7);
    expect(strip[0]?.label).toBe("Wed 09/02");
    expect(strip.map((d) => d.starting)).toEqual([0, 2, 1, 0, 0, 1, 0]);
    expect(strip.map((d) => d.refused)).toEqual([0, 0, 1, 1, 0, 1, 1]);
    expect(board.days).toEqual(strip);
  });

  it("a zone in focus narrows the rows to work located in it or hinted to it", () => {
    const rows = [activity("Z4A"), activity("Z5A", { compartment_no: "5-1-0-Q" }), activity("HINT", { compartment_no: null, wbs_area: "Z4", executability: { verdict: "unassessable", reason: "unlocated" } })];
    const acts = [M, ...rows];
    const events = keyEvents(acts, [], T0);
    const edges = rows.map((a) => edge(a.code, "M1"));
    const board = weekBoard({ event: events[0] as KeyEvent, events, activities: acts, edges, alternatives: [], proposals: [], fromMs: T0, clock: UTC_CLOCK, zone: "Z4", zoneOf: new Map([["3-148-2-E", "Z4"], ["5-1-0-Q", "Z5"]]) });
    expect(board.rows.map((r) => r.a.code).sort()).toEqual(["HINT", "Z4A"]);
  });
});

describe("keyEventSheet", () => {
  it("names the layer of every figure and prints", () => {
    const rows = [activity("A1", { refused: { clear: null } }), activity("A2")];
    const acts = [M, M_LATE, ...rows];
    const edges = [edge("A1", "M1"), edge("A2", "M1")];
    const events = keyEvents(acts, edges, T0);
    const board = weekBoard({ event: events[0] as KeyEvent, events, activities: acts, edges, alternatives: [gated("A1")], proposals: [proposal(2, "A1", "open", { start: T0 + 6 * DAY, end: T0 + 9 * DAY })], fromMs: T0 + 9 * HOUR, clock: UTC_CLOCK, zone: null, zoneOf: new Map() });
    const cut = { hull: "CVN-73 PIA-26", asOfMs: T0 + 9 * HOUR, scheduleSource: "CVN73-PIA26-full.xer", producedBy: "Ship Super" };
    const sheet = keyEventSheet(board, cut, null);
    expect(sheet.id).toBe("keyEvent");
    expect(sheet.scope).toBe("M1 review · 10/02 (30 d) · all zones");
    expect(sheet.sections[0]?.heading).toBe("Work gating M1 M1 review — 10/02");
    expect(sheet.sections[0]?.note).toContain("1 miss the event");
    expect(sheet.sections[0]?.rows[0]?.[0]).toContain("MISSES THE EVENT — clears on verification");
    expect(sheet.sections[0]?.rows[0]?.[9]).toBe("#2 OPEN → 09/08–09/11 · makes it");
    expect(sheet.sections[1]?.heading).toBe("The seven days ahead");
    expect(sheet.sections[2]?.rows[0]?.[0]).toBe("M2");
    expect(sheet.notes.some((n) => n.startsWith("MH left: the schedule of record"))).toBe(true);
    expect(sheet.notes.some((n) => n.includes("the engine, at the cut instant"))).toBe(true);
    expect(sheet.notes.some((n) => n.startsWith("Gating set: the schedule of record's own logic"))).toBe(true);
    expect(sheet.notes.some((n) => n.startsWith("Margin: planned finish against the event date"))).toBe(true);
    expect(sheet.notes.some((n) => n.startsWith("Clocks:"))).toBe(true);
    const html = toPrintHtml(sheet);
    expect(html).toContain("Key-event readiness");
    expect(html).toContain("MISSES THE EVENT");
    expect(toCsv(sheet)[0]).toBe("report,Key-event readiness");
  });
});
