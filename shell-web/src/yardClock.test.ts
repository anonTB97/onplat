// The mirror is pinned to the server by one vector file whose instants come
// from the IANA database — neither implementation is the oracle for the
// other. Then the reference hull's own CSV, the 25-hour day, and the
// refusals in the server's words.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  coverageFindings,
  crossCheckInstants,
  daysFromCivil,
  civilFromDays,
  dayStart,
  intlCrossCheck,
  local,
  nextDayStart,
  offsetAt,
  offsetLabel,
  parseClockCsv,
  shiftChip,
  shiftWindows,
  stamp,
  toUtc,
  UTC_CLOCK,
  validate,
  watchEnd,
  watchesOf,
  watchStart,
  weekday,
  type YardClock,
} from "./yardClock";

const ROOT = new URL("../../", import.meta.url);
const VECTORS = JSON.parse(readFileSync(new URL("reference/clock/yard-clock-vectors.json", ROOT), "utf8")) as {
  clocks: Record<string, YardClock>;
  offset_at: { clock: string; utc_ms: number; minutes: number }[];
  to_utc: { clock: string; date: string; minute_of_day: number; utc_ms: number; note: "gap" | "overlap" | null }[];
  day_start: { clock: string; utc_ms: number; start_ms: number; next_ms: number }[];
  watch_start: { clock: string; utc_ms: number; start_ms: number; end_ms: number }[];
  watches_of: { clock: string; utc_ms: number; starts: number[]; ends: number[]; labels: string[] }[];
  shift_windows: { clock: string; utc_ms: number; windows: { name: string; start_ms: number; end_ms: number }[] }[];
};

const clock = (name: string): YardClock => {
  const c = VECTORS.clocks[name];
  if (!c) throw new Error(`no clock ${name} in the vector file`);
  return c;
};

const days = (date: string): number => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return daysFromCivil(y, m, d);
};

describe("the yard clock mirror", () => {
  it("agrees with the shared vector file", () => {
    for (const v of VECTORS.offset_at) expect(offsetAt(clock(v.clock), v.utc_ms), JSON.stringify(v)).toBe(v.minutes);
    for (const v of VECTORS.to_utc) {
      const [ms, note] = toUtc(clock(v.clock), days(v.date), v.minute_of_day);
      expect(ms, JSON.stringify(v)).toBe(v.utc_ms);
      expect(note, JSON.stringify(v)).toBe(v.note);
    }
    for (const v of VECTORS.day_start) {
      expect(dayStart(clock(v.clock), v.utc_ms), JSON.stringify(v)).toBe(v.start_ms);
      expect(nextDayStart(clock(v.clock), v.utc_ms), JSON.stringify(v)).toBe(v.next_ms);
    }
    for (const v of VECTORS.watch_start) {
      expect(watchStart(clock(v.clock), v.utc_ms), JSON.stringify(v)).toBe(v.start_ms);
      expect(watchEnd(clock(v.clock), v.utc_ms), JSON.stringify(v)).toBe(v.end_ms);
    }
    for (const v of VECTORS.watches_of) {
      const watches = watchesOf(clock(v.clock), v.utc_ms);
      expect(watches.map((w) => w.start), JSON.stringify(v)).toEqual(v.starts);
      expect(watches.map((w) => w.end), JSON.stringify(v)).toEqual(v.ends);
      expect(watches.map((w) => w.label), JSON.stringify(v)).toEqual(v.labels);
    }
    for (const v of VECTORS.shift_windows) {
      const windows = shiftWindows(clock(v.clock), v.utc_ms).map((w) => ({ name: w.name, start_ms: w.start, end_ms: w.end }));
      expect(windows, JSON.stringify(v)).toEqual(v.windows);
    }
  });

  it("round-trips civil days and knows the weekday", () => {
    expect(daysFromCivil(1970, 1, 1)).toBe(0);
    expect(weekday(0)).toBe(4);
    expect(weekday(days("2026-09-04"))).toBe(5);
    let expected = daysFromCivil(1990, 1, 1);
    for (let year = 1990; year < 2060; year += 1) {
      for (let month = 1; month <= 12; month += 1) {
        const next = month === 12 ? daysFromCivil(year + 1, 1, 1) : daysFromCivil(year, month + 1, 1);
        const length = next - daysFromCivil(year, month, 1);
        for (let day = 1; day <= length; day += 1) {
          const d = daysFromCivil(year, month, day);
          expect(d).toBe(expected);
          expect(civilFromDays(d)).toEqual([year, month, day]);
          expected += 1;
        }
      }
    }
  });

  it("parses the reference hull's clock CSV", () => {
    const text = readFileSync(new URL("reference/cvn73/CVN73-clock.csv", ROOT), "utf8");
    const c = parseClockCsv(text);
    expect(c.zone).toBe("America/New_York");
    expect(c.standard_offset_minutes).toBe(-300);
    expect(c.daylight).toEqual(clock("norfolk").daylight);
    expect(c.watch_minutes).toBe(240);
    expect(c.shifts).toHaveLength(3);
    expect(c.shifts[2]).toEqual({ name: "Mids", start_minute: 0, length_minutes: 420 });
    expect(validate(c)).toEqual([]);
    expect(c.shifts.map(shiftChip)).toEqual(["Days 0700–1530", "Swing 1530–2400", "Mids 0000–0700"]);
    // A shift whose end is before its start crosses midnight.
    expect(parseClockCsv("zone,Pacific/Guam,+10:00\nshift,Nights,23:00,07:00\n").shifts[0]?.length_minutes).toBe(480);
    expect(() => parseClockCsv("zone,UTC,+00:00\nwatch,lots\n")).toThrow(/line 2/);
    expect(() => parseClockCsv("shift,Days,07:00,15:30\n")).toThrow(/no zone row/);
    expect(() => parseClockCsv("zone,UTC,+00:00\nlunch,12:00\n")).toThrow(/lunch/);
  });

  it("the fall-back day has six watches and the first is five hours", () => {
    const norfolk = clock("norfolk");
    const noon = Date.UTC(2026, 10, 1, 12);
    const watches = watchesOf(norfolk, noon);
    expect(watches).toHaveLength(6);
    expect(watches[0]!.end - watches[0]!.start).toBe(5 * 3_600_000);
    expect(watches[0]!.label).toBe("00–04");
    // The spring-forward day: three hours in the same watch.
    const march = watchesOf(norfolk, Date.UTC(2026, 2, 8, 12));
    expect(march[0]!.end - march[0]!.start).toBe(3 * 3_600_000);
    // The gap resolves standard and says so; the overlap takes the first occurrence.
    const [gap, gapNote] = toUtc(norfolk, days("2026-03-08"), 150);
    expect(gapNote).toBe("gap");
    expect(stamp(local(UTC_CLOCK, gap))).toBe("2026-03-08 07:30");
    expect(stamp(local(norfolk, gap))).toBe("2026-03-08 03:30");
    const [overlap, overlapNote] = toUtc(norfolk, days("2026-11-01"), 90);
    expect(overlapNote).toBe("overlap");
    expect(offsetAt(norfolk, overlap)).toBe(-240);
    expect(offsetLabel(-240)).toBe("UTC−04:00");
    expect(offsetLabel(660)).toBe("UTC+11:00");
  });

  it("validate mirrors the server's refusals", () => {
    const c: YardClock = {
      ...clock("norfolk"),
      watch_minutes: 100,
      shifts: [...clock("norfolk").shifts, { name: "Days", start_minute: 0, length_minutes: 60 }],
    };
    const problems = validate(c);
    expect(problems.some((p) => p.includes("100 min"))).toBe(true);
    expect(problems.some((p) => p.includes("Days is listed twice"))).toBe(true);
    const wrong: YardClock = { ...UTC_CLOCK, zone: "Norfolk", standard_offset_minutes: 7 };
    const wrongProblems = validate(wrong);
    expect(wrongProblems.some((p) => p.includes("Area/City"))).toBe(true);
    expect(wrongProblems.some((p) => p.includes("multiple of 15"))).toBe(true);
    expect(validate(UTC_CLOCK)).toEqual([]);
    expect(coverageFindings(UTC_CLOCK)).toEqual([]);
    expect(coverageFindings({ ...UTC_CLOCK, shifts: UTC_CLOCK.shifts.slice(0, 2) })).toEqual(["the shifts leave 00:00–07:00 uncovered"]);
    expect(validate({ ...clock("norfolk"), daylight: { ...clock("norfolk").daylight!, offset_minutes: -300 } })).toContainEqual(
      expect.stringContaining("equals the standard offset"),
    );
  });

  it("agrees with the browser's tz database for the vector clocks", () => {
    const now = Date.UTC(2026, 8, 4, 13, 15);
    for (const name of ["norfolk", "utc", "guam", "sydney"]) {
      const c = clock(name);
      expect(intlCrossCheck(c, crossCheckInstants(c, now)), name).toEqual([]);
    }
    // A rule an hour out is caught at the transitions.
    const wrong: YardClock = { ...clock("norfolk"), daylight: { ...clock("norfolk").daylight!, offset_minutes: -180 } };
    expect(intlCrossCheck(wrong, crossCheckInstants(wrong, now)).length).toBeGreaterThan(0);
    // An unknown zone is one info finding, not a refusal.
    const unknown: YardClock = { ...UTC_CLOCK, zone: "Nowhere/Yard" };
    expect(intlCrossCheck(unknown, [now])).toEqual([expect.objectContaining({ severity: "info" })]);
  });
});
