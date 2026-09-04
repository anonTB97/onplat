// The transport bar's grid arithmetic, pinned where it broke.
//
// Review findings 2026-08-31: with the grid derived from a now-anchored
// window, « landed on "roughly yesterday" instead of the availability start,
// and playback at the Week horizon froze against a window edge with the
// playing flag stuck true. Both are properties of `availabilityGrid` +
// `clampInto`, so both are pinned here as pure arithmetic.

import { afterEach, describe, expect, it } from "vitest";
import { setYardClock } from "./clock";
import {
  availabilityGrid,
  clampInto,
  fmtInstant,
  HORIZONS,
  isProjection,
  nextNotch,
  onLocalDate,
  sameWatchOn,
} from "./TimeControl";
import { blockIndex, blockStart, DAY_MS, WATCH_MS } from "./watch";
import { UTC_CLOCK, type YardClock } from "./yardClock";

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

// A hull three months into a nine-month availability — long enough that every
// horizon's old window was smaller than the run.
const NOW = Date.UTC(2026, 7, 31, 13, 37); // odd time-of-day, deliberately
const AVAIL = { start: NOW - 90 * DAY_MS, end: NOW + 180 * DAY_MS };

describe("the availability grid", () => {
  it("« reaches the first notch at every horizon, months before now", () => {
    for (const horizon of ["day", "week", "month", "availability"] as const) {
      const grid = availabilityGrid(horizon, NOW, AVAIL);
      const step = HORIZONS[horizon].step;
      const landed = clampInto(AVAIL.start, grid, step);
      expect(landed - AVAIL.start).toBeGreaterThanOrEqual(0);
      expect(landed - AVAIL.start).toBeLessThan(step);
    }
  });

  it("» reaches a last notch inside the availability, months after now", () => {
    for (const horizon of ["day", "week", "month", "availability"] as const) {
      const grid = availabilityGrid(horizon, NOW, AVAIL);
      const step = HORIZONS[horizon].step;
      const landed = clampInto(AVAIL.end - 1, grid, step);
      expect(landed).toBeLessThan(AVAIL.end);
      expect(AVAIL.end - landed).toBeLessThanOrEqual(step);
    }
  });

  it("playback advances strictly and terminates — no frozen mid-run notch", () => {
    for (const horizon of ["day", "week", "month"] as const) {
      const grid = availabilityGrid(horizon, NOW, AVAIL);
      const step = HORIZONS[horizon].step;
      const end = clampInto(AVAIL.end - 1, grid, step);
      let at = clampInto(AVAIL.start, grid, step);
      let beats = 0;
      const ceiling = (AVAIL.end - AVAIL.start) / step + 2;
      // The playback loop's own rule: next = clamp(at) + step, stop past the
      // last notch. If any beat fails to advance, this loops forever — which
      // is exactly the frozen-playback bug, so the ceiling makes it a failure.
      for (;;) {
        const next = clampInto(at, grid, step) + step;
        if (next > end) break;
        expect(next).toBeGreaterThan(at);
        at = next;
        beats += 1;
        expect(beats).toBeLessThan(ceiling);
      }
      expect(at).toBe(end);
    }
  });

  it("the day grid's notches are the UTC watch blocks", () => {
    const grid = availabilityGrid("day", NOW, AVAIL);
    expect(blockStart(grid.start)).toBe(grid.start);
    expect((grid.start - blockStart(grid.start)) % WATCH_MS).toBe(0);
  });

  it("the wider grids run through now, so the present is a notch", () => {
    for (const horizon of ["week", "month", "availability"] as const) {
      const grid = availabilityGrid(horizon, NOW, AVAIL);
      expect((NOW - grid.start) % HORIZONS[horizon].step).toBe(0);
    }
  });

  it("live means live: a block start ninety minutes ago is a projection at Day", () => {
    expect(isProjection(NOW - 90 * 60_000, NOW, "day")).toBe(true);
    expect(isProjection(null, NOW, "day")).toBe(false);
    // At Week, half a step of slack keeps the grid's now-notch in the live band.
    expect(isProjection(NOW, NOW, "week")).toBe(false);
  });

  it("the day grid's notches are the yard's watches across the November fall-back and playback still advances strictly", () => {
    setYardClock({ label: "CVN73-clock.csv", source: "document", clock: NORFOLK });
    // Two local days: 00:00 EDT Oct 31 (04:00Z) to 00:00 EST Nov 2 (05:00Z) — 49 hours.
    const avail = { start: Date.UTC(2026, 9, 31, 4), end: Date.UTC(2026, 10, 2, 5) };
    const step = HORIZONS.day.step;
    const grid = availabilityGrid("day", NOW, avail);
    expect(grid.start).toBe(avail.start);
    const end = clampInto(avail.end - 1, grid, step);
    expect(end).toBe(Date.UTC(2026, 10, 2, 1)); // 20:00 EST Nov 1 — the last 20–24 watch
    const notches = [grid.start];
    for (;;) {
      const next = nextNotch(notches.at(-1)!, grid, step);
      if (next > end) break;
      expect(next).toBeGreaterThan(notches.at(-1)!);
      notches.push(next);
      expect(notches.length).toBeLessThan(20);
    }
    expect(notches).toHaveLength(12);
    expect(notches.at(-1)).toBe(end);
    // The 00–04 watch of Nov 1 starts at 04:00Z and runs five hours to 09:00Z.
    const fallBack = notches.indexOf(Date.UTC(2026, 10, 1, 4));
    expect(fallBack).toBe(6);
    expect(notches[fallBack + 1]).toBe(Date.UTC(2026, 10, 1, 9));
    expect(fmtInstant(notches[fallBack]!, "day")).toBe("Sun 1 Nov · 00–04");
    // An availability opening mid-watch starts its grid at the next watch.
    const late = availabilityGrid("day", NOW, { start: avail.start + 30 * 60_000, end: avail.end });
    expect(late.start).toBe(Date.UTC(2026, 9, 31, 8));
  });

  it("the date picker keeps the watch index on the picked local day", () => {
    setYardClock({ label: "CVN73-clock.csv", source: "document", clock: NORFOLK });
    // 08:00 EDT on Fri 4 Sep — the 08–12 watch.
    const at = Date.UTC(2026, 8, 4, 12);
    expect(blockIndex(at)).toBe(2);
    expect(fmtInstant(at, "day")).toBe("Fri 4 Sep · 08–12");
    // Picked Mon 2 Nov (EST): the same watch is 08:00 EST = 13:00Z.
    const picked = onLocalDate(at, 2026, 11, 2, "day");
    expect(picked).toBe(Date.UTC(2026, 10, 2, 13));
    expect(blockIndex(picked)).toBe(2);
    expect(fmtInstant(picked, "day")).toBe("Mon 2 Nov · 08–12");
    // At Week the place in the day is the time of day, on the picked local date.
    expect(onLocalDate(at, 2026, 9, 5, "week")).toBe(Date.UTC(2026, 8, 5, 12));
    // ‹ › move to the same watch on the adjacent local day — 25 hours across the fall-back.
    expect(sameWatchOn(at, 1)).toBe(Date.UTC(2026, 8, 5, 12));
    const beforeFallBack = Date.UTC(2026, 9, 31, 12); // 08:00 EDT Sat 31 Oct
    expect(sameWatchOn(beforeFallBack, 1)).toBe(Date.UTC(2026, 10, 1, 13)); // 08:00 EST Sun 1 Nov
    expect(sameWatchOn(beforeFallBack, 1) - beforeFallBack).toBe(25 * 3_600_000);
  });
});
