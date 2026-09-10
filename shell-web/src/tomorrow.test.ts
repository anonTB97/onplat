import { afterEach, describe, expect, it } from "vitest";
import type { Activity, DeckStateRow, Mitigation } from "./api";
import { setYardClock } from "./clock";
import { toCsv, toPrintHtml } from "./reports";
import {
  groupHeadline,
  nextShift,
  nextShiftWord,
  planSentence,
  selfClearSentence,
  tomorrowBoard,
  tomorrowSheet,
  type ShiftWindow,
} from "./tomorrow";
import { UTC_CLOCK, type YardClock } from "./yardClock";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// A UTC midnight: under the UTC default Days is 07:00–15:30, Swing 15:30–24:00, Mids 00:00–07:00.
const MIDNIGHT = Date.UTC(2026, 8, 2);

const NORFOLK: YardClock = {
  ...UTC_CLOCK,
  zone: "America/New_York",
  standard_offset_minutes: -300,
  daylight: {
    offset_minutes: -240,
    start: { month: 3, week: 2, weekday: 0, minute_of_day: 120 },
    end: { month: 11, week: 1, weekday: 0, minute_of_day: 120 },
  },
};

afterEach(() => setYardClock(null));

/** The shift under test: Days on 09/03, 07:00–15:30Z. */
const DAYS: ShiftWindow = { name: "Days", label: "Days 0700–1530", start: MIDNIGHT + DAY + 7 * HOUR, end: MIDNIGHT + DAY + 15.5 * HOUR };
const AS_OF = MIDNIGHT + 14 * HOUR;

function space(no: string, held: boolean, opts: { clear?: number | null; authority?: string; rules?: string[]; zone?: string } = {}): DeckStateRow {
  return {
    trades: ["SM-PIPE"],
    work_order_codes: ["WI-1"],
    remaining_hours: held ? 120 : 40,
    compartment: {
      frame: 160, fwd_frame: null, aft_frame: null, side: "port", geometry_source: "parsed",
      compartment_no: no, name: `Space ${no}`, deck_code: "3rd", deck_ordinal: 3, zone: opts.zone ?? "Z4", category: "Q",
    },
    state: held ? "SUSPEND" : "ALLOW",
    permits_work: !held,
    rules_fired: held ? (opts.rules ?? ["R07"]) : [],
    earliest_clear: held ? (opts.clear ?? null) : null,
    readiness: held ? "held" : "go",
    clearing_authority: held ? (opts.authority ?? "isolation_authority") : "",
  };
}

function activity(code: string, no: string | null, trade: string, planned: { start: number; end: number } | null, notExecutable = false): Activity {
  return {
    activity_id: code, code, name: `Task ${code}`, work_order_code: "WI-1", compartment_no: no,
    compartment_reliability: "high", wbs_area: null, trade,
    planned, budget_hours: 80, earned_hours: 0, remaining_hours: 80,
    status: "not_started", is_milestone: false, source_ref: "x", in_window: true,
    executability: notExecutable
      ? { verdict: "not_executable", at: planned?.start ?? 0, state: "SUSPEND", rule_code: "R07", origin: no ?? "", hazard: "bus live", clearing_authority: "isolation_authority", earliest_clear: null }
      : { verdict: "executable" },
  };
}

function discharge(origin: string, frees: string[], closes: string[] = []): Mitigation {
  return {
    action: { kind: "discharge", origin, hazard: "Bus 3-SG-2 energised — no verified zero-energy state", actor: "isolation_authority" },
    effect: { frees, closes, freed_hours: 100, closed_hours: 0 },
    confidence: "assumes_actor",
    subject_state: "SUSPEND",
  };
}

/** An eight-hour job across the whole of Days: 80 MH budget over 8.5 h planned → all of it on the shift. */
const onDays = { start: DAYS.start, end: DAYS.end };

describe("nextShift", () => {
  it("picks the first window after the instant, across the day boundary", () => {
    // Swing's afternoon under the UTC default: the next shift is the next day's Mids.
    const fromSwing = nextShift(UTC_CLOCK, MIDNIGHT + 18 * HOUR);
    expect(fromSwing?.name).toBe("Mids");
    expect(fromSwing?.start).toBe(MIDNIGHT + DAY);
    expect(fromSwing?.dayLabel).toBe("09/03");
    // Mids' small hours: today's Days.
    const fromMids = nextShift(UTC_CLOCK, MIDNIGHT + 2 * HOUR);
    expect(fromMids?.name).toBe("Days");
    expect(fromMids?.start).toBe(MIDNIGHT + 7 * HOUR);
    expect(fromMids?.label).toBe("Days 0700–1530");
    expect(nextShiftWord(UTC_CLOCK, MIDNIGHT + 2 * HOUR, fromMids as ShiftWindow)).toBe("Next shift");
    expect(nextShiftWord(UTC_CLOCK, MIDNIGHT + 18 * HOUR, fromSwing as ShiftWindow)).toBe("Tomorrow");
  });

  it("places the windows in a −5 h zone (−4 in summer)", () => {
    // 14:00 EDT on 09/02 = 18:00Z; the next shift is Swing 15:30 EDT = 19:30Z the same day.
    const fromAfternoon = nextShift(NORFOLK, MIDNIGHT + 18 * HOUR);
    expect(fromAfternoon?.name).toBe("Swing");
    expect(fromAfternoon?.start).toBe(MIDNIGHT + 19.5 * HOUR);
    // 22:00 EDT on 09/02 = 02:00Z 09/03: the next is Mids at 00:00 EDT 09/03 = 04:00Z.
    const fromNight = nextShift(NORFOLK, MIDNIGHT + DAY + 2 * HOUR);
    expect(fromNight?.name).toBe("Mids");
    expect(fromNight?.start).toBe(MIDNIGHT + DAY + 4 * HOUR);
    expect(fromNight?.dayLabel).toBe("09/03");
  });

  it("returns null for a clock that names no shifts", () => {
    expect(nextShift({ ...UTC_CLOCK, shifts: [] }, MIDNIGHT)).toBeNull();
  });
});

describe("tomorrowBoard", () => {
  it("a hold that clears on a clock before the shift start is self-clearing, not clearable", () => {
    const acts = [activity("A1", "2-91-2-L", "SM-PAINT", onDays)];
    const board = tomorrowBoard({
      clock: UTC_CLOCK, shift: DAYS, asOfMs: AS_OF, activities: acts, zone: null,
      spacesNow: [space("2-91-2-L", true, { clear: MIDNIGHT + 17 * HOUR, authority: "nobody", rules: ["R02"] })],
      spacesAtStart: [space("2-91-2-L", false)],
      leverageAtStart: [],
    });
    expect(board.clearable).toHaveLength(0);
    expect(board.selfClearing).toHaveLength(1);
    expect(board.selfClearing[0]?.when).toBe("before_shift");
    expect(board.selfClearing[0]?.heldNow).toBe(true);
    expect(board.selfClearing[0]?.heldAtStart).toBe(false);
    // Its work is sendable — the space is open when the crew arrives.
    expect(board.sendable).toHaveLength(1);
    expect(board.totals.mhSendable).toBeCloseTo(80);
    expect(board.totals.mhSelf).toBe(0);
    const words = selfClearSentence(board.selfClearing[0] as never, DAYS);
    expect(words).toContain("held now (R02)");
    expect(words).toContain("cures on its own by 17:00Z");
    expect(words).toContain("open at shift start");
  });

  it("a verification-gated hold at shift start groups under its discharge action with the shift's MH", () => {
    const acts = [
      activity("A1", "3-148-2-E", "SM-ELEC", onDays, true),
      activity("A2", "3-172-1-E", "SM-PIPE", onDays, true),
      // Half the job falls before the shift: 40 of its 80 MH are on the shift.
      activity("A3", "3-172-1-E", "SM-PIPE", { start: DAYS.start - 8.5 * HOUR, end: DAYS.end }, true),
      activity("A4", "4-1-0-Q", "SM-PIPE", onDays),
    ];
    const held = ["3-148-2-E", "3-172-1-E"];
    const board = tomorrowBoard({
      clock: UTC_CLOCK, shift: DAYS, asOfMs: AS_OF, activities: acts, zone: null,
      spacesNow: [...held.map((no) => space(no, true)), space("4-1-0-Q", false)],
      spacesAtStart: [...held.map((no) => space(no, true)), space("4-1-0-Q", false)],
      leverageAtStart: [
        discharge("3-148-2-E", ["3-148-2-E", "3-172-1-E", "9-9-9-X"], ["5-5-5-E"]),
        // The interrupt frees one of the same spaces: it must not double-list it.
        { action: { kind: "interrupt", from: "3-148-2-E", to: "3-172-1-E", coupling: "electrical_bus" }, effect: { frees: ["3-172-1-E"], closes: [], freed_hours: 1, closed_hours: 0 }, confidence: "assumes_own_authorization", subject_state: "SUSPEND" },
      ],
    });
    expect(board.clearable).toHaveLength(1);
    const g = board.clearable[0];
    expect(g?.rows.map((r) => r.a.code).sort()).toEqual(["A1", "A2", "A3"]);
    expect(g?.mhShift).toBeCloseTo(200);
    expect(g?.trades).toEqual(["SM-ELEC", "SM-PIPE"]);
    expect(g?.frees).toHaveLength(3);
    expect(g?.freesWithWork).toBe(2);
    expect(g?.closes).toEqual(["5-5-5-E"]);
    const head = groupHeadline(g as never);
    expect(head).toContain("isolation authority");
    expect(head).toContain("frees 3 spaces (2 with work on this shift)");
    expect(head).toContain("3 activities · 200 MH on the shift");
    expect(head).toContain("ASSUMES ATTENDANCE");
    expect(head).toContain("would shut 1 space");
    expect(board.needsPlan).toHaveLength(0);
    expect(board.sendable.flatMap((c) => c.rows.map((r) => r.a.code))).toEqual(["A4"]);
    expect(board.totals.mhClearable).toBeCloseTo(200);
    expect(board.totals.activities).toBe(4);
  });

  it("a timed clear inside the shift reads during_shift; after the shift end reads after_shift", () => {
    const acts = [activity("A1", "3-160-2-Q", "SM-PAINT", onDays), activity("A2", "4-160-2-Q", "SM-PAINT", onDays)];
    const board = tomorrowBoard({
      clock: UTC_CLOCK, shift: DAYS, asOfMs: AS_OF, activities: acts, zone: null,
      spacesNow: [space("3-160-2-Q", true, { clear: DAYS.start + 2 * HOUR }), space("4-160-2-Q", true, { clear: DAYS.end + 5 * HOUR })],
      spacesAtStart: [space("3-160-2-Q", true, { clear: DAYS.start + 2 * HOUR, rules: ["R02"] }), space("4-160-2-Q", true, { clear: DAYS.end + 5 * HOUR, rules: ["R02"] })],
      // A discharge that names the after-shift space must not steal it from the clock: the clock reads first only inside the shift.
      leverageAtStart: [],
    });
    expect(board.selfClearing.map((r) => r.when)).toEqual(["during_shift", "after_shift"]);
    expect(selfClearSentence(board.selfClearing[0] as never, DAYS)).toContain("clears at 09:00Z — send the crew after");
    expect(selfClearSentence(board.selfClearing[1] as never, DAYS)).toContain("will not clear before 15:30Z");
    expect(selfClearSentence(board.selfClearing[1] as never, DAYS)).toContain("see Week Ahead");
    expect(board.sendable).toHaveLength(0);
    expect(board.totals.mhSelf).toBeCloseTo(160);
  });

  it("a space held at start that no single action frees lands in needsPlan, never in sendable", () => {
    const acts = [activity("A1", "4-74-0-Q", "SM-PIPE", onDays, true), activity("A2", "4-74-0-Q", "SM-ELEC", onDays, true)];
    const board = tomorrowBoard({
      clock: UTC_CLOCK, shift: DAYS, asOfMs: AS_OF, activities: acts, zone: null,
      spacesNow: [space("4-74-0-Q", true, { rules: ["R03", "R07"], authority: "marine_chemist" })],
      spacesAtStart: [space("4-74-0-Q", true, { rules: ["R03", "R07"], authority: "marine_chemist" })],
      leverageAtStart: [discharge("3-148-2-E", ["3-148-2-E"])],
    });
    expect(board.needsPlan).toHaveLength(1);
    expect(board.sendable).toHaveLength(0);
    expect(board.clearable).toHaveLength(0);
    expect(planSentence(board.needsPlan[0] as never)).toBe(
      "held at shift start; no single action opens it (R03 + R07) · marine chemist · 2 activities · 160 MH — open the options panel",
    );
    expect(board.totals.mhPlan).toBeCloseTo(160);
  });

  it("sendable columns never carry a held space; undated and unlocated rows are counted, not dropped", () => {
    const acts = [
      activity("A1", "4-1-0-Q", "SM-PIPE", onDays),
      activity("A2", "4-1-0-Q", "SM-PIPE", null),
      activity("A3", null, "SM-ELEC", onDays),
      activity("A4", "3-148-2-E", "SM-ELEC", onDays, true),
      // Off the shift entirely: not on the board at all.
      activity("A5", "4-1-0-Q", "SM-PIPE", { start: DAYS.end + DAY, end: DAYS.end + 2 * DAY }),
    ];
    const board = tomorrowBoard({
      clock: UTC_CLOCK, shift: DAYS, asOfMs: AS_OF, activities: acts, zone: null,
      spacesNow: [space("4-1-0-Q", false), space("3-148-2-E", true)],
      spacesAtStart: [space("4-1-0-Q", false), space("3-148-2-E", true)],
      leverageAtStart: [],
    });
    const sendableSpaces = board.sendable.flatMap((c) => c.rows.map((r) => r.space));
    expect(sendableSpaces).not.toContain("3-148-2-E");
    expect(sendableSpaces.sort()).toEqual(["4-1-0-Q", "4-1-0-Q"]);
    expect(board.undated.map((a) => a.code)).toEqual(["A2"]);
    expect(board.unlocated.map((a) => a.code)).toEqual(["A3"]);
    expect(board.totals.activities).toBe(4);
    expect(board.needsPlan.map((r) => r.space)).toEqual(["3-148-2-E"]);
  });

  it("a zone in focus narrows the board and says nothing about the rest", () => {
    const acts = [activity("A1", "4-1-0-Q", "SM-PIPE", onDays), activity("A2", "5-1-0-Q", "SM-PIPE", onDays)];
    const board = tomorrowBoard({
      clock: UTC_CLOCK, shift: DAYS, asOfMs: AS_OF, activities: acts, zone: "Z4",
      spacesNow: [space("4-1-0-Q", false, { zone: "Z4" }), space("5-1-0-Q", false, { zone: "Z5" })],
      spacesAtStart: [space("4-1-0-Q", false, { zone: "Z4" }), space("5-1-0-Q", false, { zone: "Z5" })],
      leverageAtStart: [],
    });
    expect(board.totals.activities).toBe(1);
    expect(board.sendable[0]?.rows[0]?.a.code).toBe("A1");
  });
});

describe("tomorrowSheet", () => {
  it("carries the cut, the projection note and every section, and prints via toPrintHtml", () => {
    setYardClock({ label: "CVN73-clock.csv", source: "document", clock: NORFOLK });
    const acts = [
      activity("A1", "3-148-2-E", "SM-ELEC", onDays, true),
      activity("A2", "2-91-2-L", "SM-PAINT", onDays),
      activity("A3", "4-74-0-Q", "SM-PIPE", onDays, true),
      activity("A4", "4-1-0-Q", "SM-PIPE", onDays),
      activity("A5", null, "SM-ELEC", onDays),
    ];
    const board = tomorrowBoard({
      clock: NORFOLK, shift: DAYS, asOfMs: AS_OF, activities: acts, zone: null,
      spacesNow: [space("3-148-2-E", true), space("2-91-2-L", true, { clear: AS_OF + HOUR }), space("4-74-0-Q", true, { rules: ["R03"], authority: "marine_chemist" }), space("4-1-0-Q", false)],
      spacesAtStart: [space("3-148-2-E", true), space("2-91-2-L", false), space("4-74-0-Q", true, { rules: ["R03"], authority: "marine_chemist" }), space("4-1-0-Q", false)],
      leverageAtStart: [discharge("3-148-2-E", ["3-148-2-E"])],
    });
    const cut = { hull: "CVN-73 PIA-26", asOfMs: AS_OF, scheduleSource: "CVN73-PIA26-full.xer", producedBy: "Foreman" };
    const sheet = tomorrowSheet(board, cut, null);
    expect(sheet.id).toBe("tomorrow");
    expect(sheet.scope).toBe("Days 0700–1530 · 09/03 · all zones");
    expect(sheet.cut).toBe(cut);
    const headings = sheet.sections.map((s) => s.heading);
    expect(headings[0]).toBe("Clearable tonight · action 1 of 1");
    expect(sheet.sections[0]?.note).toContain("isolation authority · Bus 3-SG-2 energised");
    expect(headings).toContain("Clears on its own");
    expect(headings).toContain("Needs a plan");
    expect(headings.some((h) => h.startsWith("Sendable — "))).toBe(true);
    expect(headings).toContain("Counted, not placed");
    expect(sheet.notes[0]).toContain("PROJECTED · evaluated by the engine at 09/03 03:00");
    expect(sheet.notes[0]).toContain("NOT AN AUTHORIZATION");
    expect(sheet.notes.some((n) => n.startsWith("MH: schedule of record"))).toBe(true);
    expect(sheet.notes.some((n) => n.startsWith("Holds and clearances: the engine"))).toBe(true);
    expect(sheet.notes.some((n) => n.startsWith("Clocks: the yard's, America/New_York"))).toBe(true);
    const html = toPrintHtml(sheet);
    expect(html).toContain("Tomorrow's board");
    expect(html).toContain("NOT AN AUTHORIZATION");
    // The needs-a-plan row names its space and its work.
    expect(html).toContain("4-74-0-Q");
    expect(html).toContain("<td>A3</td>");
    // The clearable group lists its activity; the cured coat is sendable.
    expect(html).toContain("<td>A1</td>");
    expect(html).toContain("Sendable — SM-PAINT");
    expect(html).not.toContain("<script");
    const csv = toCsv(sheet);
    expect(csv[0]).toBe("report,Tomorrow's board");
    expect(csv.some((l) => l.startsWith("section,Needs a plan"))).toBe(true);
  });
});
