// The transport bar's grid arithmetic, pinned where it broke.
//
// Review findings 2026-08-31: with the grid derived from a now-anchored
// window, « landed on "roughly yesterday" instead of the availability start,
// and playback at the Week horizon froze against a window edge with the
// playing flag stuck true. Both are properties of `availabilityGrid` +
// `clampInto`, so both are pinned here as pure arithmetic.

import { describe, expect, it } from "vitest";
import { availabilityGrid, clampInto, HORIZONS, isProjection } from "./TimeControl";
import { blockStart, DAY_MS, WATCH_MS } from "./watch";

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
});
