// The watch grid is the floor of the whole time dimension, so its boundary
// behaviour is pinned: a block belongs to its start, not its end, and the grid
// is UTC-calendar-aligned so a block is a name two readers share.

import { describe, expect, it } from "vitest";
import {
  blockIndex,
  blockLabel,
  blockStart,
  DAY_MS,
  utcDayStart,
  WATCH_MS,
  watchBlocksOf,
} from "./watch";

// 2026-08-14T00:00:00Z — a plain UTC midnight to anchor the assertions.
const MIDNIGHT = Date.UTC(2026, 7, 14);

describe("the 4-hour watch grid", () => {
  it("splits a UTC day into six blocks owned by their starts", () => {
    expect(blockIndex(MIDNIGHT)).toBe(0);
    expect(blockIndex(MIDNIGHT + WATCH_MS - 1)).toBe(0);
    expect(blockIndex(MIDNIGHT + WATCH_MS)).toBe(1);
    expect(blockIndex(MIDNIGHT + DAY_MS - 1)).toBe(5);
    expect(blockStart(MIDNIGHT + 9 * 60 * 60 * 1000)).toBe(MIDNIGHT + 2 * WATCH_MS);
  });

  it("names blocks by their Z bounds", () => {
    expect(blockLabel(MIDNIGHT)).toBe("00–04Z");
    expect(blockLabel(MIDNIGHT + 9 * 60 * 60 * 1000)).toBe("08–12Z");
    expect(blockLabel(MIDNIGHT + DAY_MS - 1)).toBe("20–24Z");
  });

  it("anchors the day at UTC midnight regardless of the instant inside it", () => {
    expect(utcDayStart(MIDNIGHT + 5)).toBe(MIDNIGHT);
    expect(utcDayStart(MIDNIGHT + DAY_MS - 1)).toBe(MIDNIGHT);
    expect(utcDayStart(MIDNIGHT + DAY_MS)).toBe(MIDNIGHT + DAY_MS);
  });

  it("lists a day's six blocks in order, sharing the day's anchor", () => {
    const blocks = watchBlocksOf(MIDNIGHT + 11 * 60 * 60 * 1000);
    expect(blocks).toHaveLength(6);
    expect(blocks[0]).toEqual({ start: MIDNIGHT, label: "00–04Z" });
    expect(blocks[5]).toEqual({ start: MIDNIGHT + 5 * WATCH_MS, label: "20–24Z" });
  });
});
