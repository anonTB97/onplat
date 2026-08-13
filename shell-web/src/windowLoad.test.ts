// The window-load rule, pinned: pro-rating by overlap, boundary honesty, and
// the unlocated remainder never disappearing into a map it cannot join.

import { describe, expect, it } from "vitest";
import type { Activity } from "./api";
import { windowLoadBySpace, windowLoadTotal } from "./windowLoad";

const DAY = 86_400_000;

function act(over: Partial<Activity>): Activity {
  return {
    activity_id: over.code ?? "id",
    code: "A1",
    name: "n",
    work_order_code: null,
    compartment_no: "3-100-0-Q",
    compartment_reliability: "high",
    wbs_area: null,
    trade: "T",
    planned: { start: 0, end: 10 * DAY },
    budget_hours: 100,
    earned_hours: 0,
    remaining_hours: 100,
    status: "not_started",
    is_milestone: false,
    source_ref: "t",
    in_window: false,
    executability: { verdict: "executable" },
    ...over,
  } as Activity;
}

describe("windowLoadBySpace", () => {
  it("pro-rates budget by the overlapping fraction of the planned window", () => {
    // 10-day activity, window covers 5 of them → half the budget.
    const m = windowLoadBySpace([act({})], 0, 5 * DAY);
    expect(m.get("3-100-0-Q")?.hours).toBeCloseTo(50);
    expect(m.get("3-100-0-Q")?.count).toBe(1);
  });

  it("an activity fully inside the window contributes its whole budget", () => {
    const m = windowLoadBySpace([act({ planned: { start: DAY, end: 2 * DAY } })], 0, 5 * DAY);
    expect(m.get("3-100-0-Q")?.hours).toBeCloseTo(100);
  });

  it("no overlap, no load — a window is half-open at its end", () => {
    const m = windowLoadBySpace([act({ planned: { start: 5 * DAY, end: 6 * DAY } })], 0, 5 * DAY);
    expect(m.size).toBe(0);
  });

  it("refusals ride the same cells", () => {
    const refused = act({
      code: "A2",
      executability: {
        verdict: "not_executable",
        at: 0, state: "BLOCK", rule_code: "R1", origin: "3-100-0-Q",
        hazard: "h", clearing_authority: "x", earliest_clear: null,
      } as never,
    });
    const m = windowLoadBySpace([act({}), refused], 0, 5 * DAY);
    expect(m.get("3-100-0-Q")?.count).toBe(2);
    expect(m.get("3-100-0-Q")?.refused).toBe(1);
  });

  it("`next` is the earliest start INSIDE the window, not one already running", () => {
    const running = act({ code: "RUN", planned: { start: -DAY, end: 3 * DAY } });
    const later = act({ code: "LATER", planned: { start: 2 * DAY, end: 4 * DAY } });
    const m = windowLoadBySpace([running, later], 0, 5 * DAY);
    expect(m.get("3-100-0-Q")?.next?.code).toBe("LATER");
  });

  it("milestones and undated rows carry no load", () => {
    const m = windowLoadBySpace(
      [act({ is_milestone: true }), act({ code: "A3", planned: null })],
      0,
      5 * DAY,
    );
    expect(m.size).toBe(0);
  });
});

describe("windowLoadTotal", () => {
  it("sums located load and counts the unlocated remainder separately", () => {
    const t = windowLoadTotal(
      [act({}), act({ code: "A4", compartment_no: null })],
      0,
      5 * DAY,
    );
    expect(t.hours).toBeCloseTo(50);
    expect(t.count).toBe(1);
    expect(t.unlocated).toBe(1);
  });

  it("an empty or inverted window answers zero, not garbage", () => {
    const t = windowLoadTotal([act({})], 5 * DAY, 0);
    expect(t).toEqual({ hours: 0, count: 0, refused: 0, unlocated: 0 });
  });
});
