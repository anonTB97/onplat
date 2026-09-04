// The watch grid is the floor of the whole time dimension, so its boundary
// behaviour is pinned: a block belongs to its start, not its end, and the grid
// is calendar-aligned on the yard's clock so a block is a name two readers
// share. Under the UTC default the numbers are the old Zulu ones; under the
// reference hull's clock the same names bound different instants.

import { afterEach, describe, expect, it } from "vitest";
import { setYardClock } from "./clock";
import {
  blockEnd,
  blockIndex,
  blockLabel,
  blockStart,
  DAY_MS,
  dayStart,
  WATCH_MS,
  watchBlocksOf,
} from "./watch";
import { UTC_CLOCK, type YardClock } from "./yardClock";

// 2026-08-14T00:00:00Z — a plain UTC midnight to anchor the assertions.
const MIDNIGHT = Date.UTC(2026, 7, 14);

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

describe("the 4-hour watch grid", () => {
  it("splits a UTC day into six blocks owned by their starts", () => {
    expect(blockIndex(MIDNIGHT)).toBe(0);
    expect(blockIndex(MIDNIGHT + WATCH_MS - 1)).toBe(0);
    expect(blockIndex(MIDNIGHT + WATCH_MS)).toBe(1);
    expect(blockIndex(MIDNIGHT + DAY_MS - 1)).toBe(5);
    expect(blockStart(MIDNIGHT + 9 * 60 * 60 * 1000)).toBe(MIDNIGHT + 2 * WATCH_MS);
  });

  it("names blocks by their wall-clock bounds", () => {
    expect(blockLabel(MIDNIGHT)).toBe("00–04");
    expect(blockLabel(MIDNIGHT + 9 * 60 * 60 * 1000)).toBe("08–12");
    expect(blockLabel(MIDNIGHT + DAY_MS - 1)).toBe("20–24");
  });

  it("anchors the day at UTC midnight regardless of the instant inside it", () => {
    expect(dayStart(MIDNIGHT + 5)).toBe(MIDNIGHT);
    expect(dayStart(MIDNIGHT + DAY_MS - 1)).toBe(MIDNIGHT);
    expect(dayStart(MIDNIGHT + DAY_MS)).toBe(MIDNIGHT + DAY_MS);
  });

  it("lists a day's six blocks in order, sharing the day's anchor", () => {
    const blocks = watchBlocksOf(MIDNIGHT + 11 * 60 * 60 * 1000);
    expect(blocks).toHaveLength(6);
    expect(blocks[0]).toEqual({ start: MIDNIGHT, end: MIDNIGHT + WATCH_MS, label: "00–04" });
    expect(blocks[5]).toEqual({ start: MIDNIGHT + 5 * WATCH_MS, end: MIDNIGHT + DAY_MS, label: "20–24" });
  });

  it("blocks are bounded by local wall hours under Norfolk", () => {
    setYardClock({ label: "CVN73-clock.csv", source: "document", clock: NORFOLK });
    // 2026-08-14 00:00Z is 20:00 the previous evening in Norfolk (EDT).
    expect(blockLabel(MIDNIGHT)).toBe("20–24");
    expect(dayStart(MIDNIGHT)).toBe(MIDNIGHT - 20 * 60 * 60 * 1000);
    expect(blockStart(MIDNIGHT)).toBe(MIDNIGHT);
    expect(blockEnd(MIDNIGHT)).toBe(MIDNIGHT + WATCH_MS);
    // The fall-back night: 00–04 on 2026-11-01 runs five hours, 04:00Z–09:00Z.
    const fallBack = Date.UTC(2026, 10, 1, 8, 30);
    expect(blockLabel(fallBack)).toBe("00–04");
    expect(blockStart(fallBack)).toBe(Date.UTC(2026, 10, 1, 4));
    expect(blockEnd(fallBack)).toBe(Date.UTC(2026, 10, 1, 9));
    const blocks = watchBlocksOf(fallBack);
    expect(blocks).toHaveLength(6);
    expect(blocks[0]!.end - blocks[0]!.start).toBe(5 * 60 * 60 * 1000);
    expect(blocks.map((b) => b.label)).toEqual(["00–04", "04–08", "08–12", "12–16", "16–20", "20–24"]);
  });
});
