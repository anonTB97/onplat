// The yard's clock — the shell's mirror of `wadl_domain::civil`.
//
// Every instant the API serves is a UTC epoch millisecond. The yard reads a
// wall clock: the scheduler types `06:00` into P6, the day shift starts at
// `07:00`, the watch turns over at `04:00`. This module converts the two
// honestly, in both directions, from an AUTHORED document — an IANA zone
// name, a standard offset, an optional daylight rule as two nth-weekday
// transitions, the watch length, the yard's shifts by the yard's names —
// with no tz database behind it. `crates/wadl-domain/src/civil.rs` is the
// server's half; `reference/clock/yard-clock-vectors.json` pins the two to
// the same instants, and its numbers come from the IANA database rather than
// from either implementation.
//
// Nothing here reads the module clock in `clock.ts`, the browser's locale or
// the wall clock: every function takes the clock it evaluates. `clock.ts` is
// the one place a yard clock is *applied*; this is where one is *evaluated*.
// The one deliberate exception is `intlCrossCheck`, which asks the browser's
// own tz database whether it agrees with an authored rule — the check that
// catches a mis-authored daylight rule before it is committed.

const MINUTE_MS = 60_000;
const DAY_MINUTES = 1440;
const DAY_MS = DAY_MINUTES * MINUTE_MS;

/* ---------------------------------------------------------------- types */

/** One clock change, as a law writes it: the nth weekday of a month, at a
 *  wall-clock minute as the clock reads at the moment it moves. */
export interface Transition {
  /** 1–12. */
  month: number;
  /** 1–5; 5 means "the last such weekday of the month". */
  week: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** The wall-clock minute the change happens at, 0–1439. */
  minute_of_day: number;
}

/** A daylight-time rule: the offset in force between two transitions. */
export interface DaylightRule {
  /** The offset while daylight time is in force, minutes east of UTC. */
  offset_minutes: number;
  /** When the clock goes forward (wall time read in standard time). */
  start: Transition;
  /** When the clock goes back (wall time read in daylight time). */
  end: Transition;
}

/** One of the yard's shifts, by the yard's name. */
export interface ShiftDef {
  name: string;
  /** The wall-clock minute it starts, 0–1439. */
  start_minute: number;
  /** How long it runs, 1–1440; a shift may cross midnight. */
  length_minutes: number;
}

/** The yard's clock: the authored document, in the wire's spelling. */
export interface YardClock {
  /** The IANA zone name (`America/New_York`), or `UTC`. */
  zone: string;
  /** The standard offset, minutes east of UTC. */
  standard_offset_minutes: number;
  /** The daylight rule, or null for a yard whose clock never moves. */
  daylight: DaylightRule | null;
  /** The watch length in minutes; must divide the day. */
  watch_minutes: number;
  /** The shifts, in the order the yard lists them. */
  shifts: ShiftDef[];
}

/** A wall-clock reading of a UTC instant. */
export interface LocalTime {
  /** The local calendar date as days since 1970-01-01. */
  days: number;
  /** Minute of the local day, 0–1439. */
  minuteOfDay: number;
  /** Milliseconds into that minute. */
  millisOfMinute: number;
  /** The offset in force at the instant, minutes east of UTC. */
  offsetMinutes: number;
}

/** What a wall-clock reading did not say plainly: the time never happened on
 *  that date (spring forward) or happened twice (fall back). */
export type WallNote = "gap" | "overlap" | null;

/** A half-open window of UTC milliseconds. */
export interface Span {
  start: number;
  end: number;
}

/** What the dry run says without refusing. */
export interface ClockFinding {
  severity: "warn" | "info";
  text: string;
}

/** The clock in effect when no document has been loaded: UTC, no daylight
 *  rule, four-hour watches, the three demo shifts. Served with
 *  `source: default_utc` so nothing presents it as a yard's claim. */
export const UTC_CLOCK: YardClock = Object.freeze({
  zone: "UTC",
  standard_offset_minutes: 0,
  daylight: null,
  watch_minutes: 240,
  shifts: [
    { name: "Days", start_minute: 420, length_minutes: 510 },
    { name: "Swing", start_minute: 930, length_minutes: 510 },
    { name: "Mids", start_minute: 0, length_minutes: 420 },
  ],
}) as YardClock;

/* ------------------------------------------------------------ civil days */

const floorDiv = (a: number, b: number): number => Math.floor(a / b);
const floorMod = (a: number, b: number): number => ((a % b) + b) % b;

/** Days since 1970-01-01 for a proleptic Gregorian civil date — Howard
 *  Hinnant's arithmetic, exact and table-free. */
export function daysFromCivil(y: number, m: number, d: number): number {
  const year = y - (m <= 2 ? 1 : 0);
  const era = floorDiv(year, 400);
  const yearOfEra = year - era * 400;
  const shiftedMonth = m > 2 ? m - 3 : m + 9;
  const dayOfYear = Math.floor((153 * shiftedMonth + 2) / 5) + d - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

/** The civil date `[year, month, day]` of a day count — the inverse of
 *  `daysFromCivil`. */
export function civilFromDays(days: number): [number, number, number] {
  const z = days + 719_468;
  const era = floorDiv(z, 146_097);
  const dayOfEra = z - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) / 365,
  );
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const shiftedMonth = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * shiftedMonth + 2) / 5) + 1;
  const month = shiftedMonth < 10 ? shiftedMonth + 3 : shiftedMonth - 9;
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  return [year, month, day];
}

/** The weekday of a day count: 0 = Sunday … 6 = Saturday. */
export function weekday(days: number): number {
  // 1970-01-01 was a Thursday.
  return floorMod(days + 4, 7);
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** `2026-03-08` for a day count. */
export function dateLabel(days: number): string {
  const [y, m, d] = civilFromDays(days);
  return `${String(y).padStart(4, "0")}-${pad2(m)}-${pad2(d)}`;
}

/** `02:30` for a minute of the day (`24:00` for minute 1440). */
export function wallLabel(minuteOfDay: number): string {
  return `${pad2(Math.floor(minuteOfDay / 60))}:${pad2(minuteOfDay % 60)}`;
}

/** `0230` — the compact form a shift chip reads. */
export function wallCompact(minuteOfDay: number): string {
  return wallLabel(minuteOfDay).replace(":", "");
}

/** `2026-09-04 09:15` for a wall-clock reading. */
export function stamp(t: LocalTime): string {
  return `${dateLabel(t.days)} ${wallLabel(t.minuteOfDay)}`;
}

/* ------------------------------------------------------------ transitions */

/** The day count of a transition in `year`. Total: an out-of-range field
 *  yields *a* day rather than a throw — `validate` is where it is refused. */
export function transitionDay(t: Transition, year: number): number {
  const month = Math.min(12, Math.max(1, t.month));
  const first = daysFromCivil(year, month, 1);
  const wanted = floorMod(t.weekday, 7);
  if (t.week >= 5) {
    const nextMonth = month === 12 ? daysFromCivil(year + 1, 1, 1) : daysFromCivil(year, month + 1, 1);
    const last = nextMonth - 1;
    return last - floorMod(weekday(last) - wanted, 7);
  }
  const week = Math.max(1, t.week) - 1;
  return first + floorMod(wanted - weekday(first), 7) + week * 7;
}

/** The UTC instant of a transition in `year`, given the offset the wall
 *  clock reads *before* it moves. */
function transitionUtc(t: Transition, year: number, offsetBefore: number): number {
  return (transitionDay(t, year) * DAY_MINUTES + t.minute_of_day - offsetBefore) * MINUTE_MS;
}

/** Whether daylight time is in force at `utcMs` under a rule and a standard
 *  offset. The year is the UTC civil year of the instant. A northern rule
 *  (start month before end month) is in force between the two; a southern
 *  rule is in force *except* between end and start — daylight across the
 *  new year. */
function inForce(rule: DaylightRule, standard: number, utcMs: number): boolean {
  const [year] = civilFromDays(floorDiv(utcMs, DAY_MS));
  const start = transitionUtc(rule.start, year, standard);
  const end = transitionUtc(rule.end, year, rule.offset_minutes);
  if (rule.start.month <= rule.end.month) return utcMs >= start && utcMs < end;
  return !(utcMs >= end && utcMs < start);
}

/* ------------------------------------------------------------ evaluation */

/** The offset in force at a UTC instant, minutes east of UTC. */
export function offsetAt(clock: YardClock, utcMs: number): number {
  const rule = clock.daylight;
  if (rule && inForce(rule, clock.standard_offset_minutes, utcMs)) return rule.offset_minutes;
  return clock.standard_offset_minutes;
}

/** The wall-clock reading of a UTC instant. */
export function local(clock: YardClock, utcMs: number): LocalTime {
  const offset = offsetAt(clock, utcMs);
  const shifted = utcMs + offset * MINUTE_MS;
  const rem = floorMod(shifted, DAY_MS);
  return {
    days: floorDiv(shifted, DAY_MS),
    minuteOfDay: Math.floor(rem / MINUTE_MS),
    millisOfMinute: rem % MINUTE_MS,
    offsetMinutes: offset,
  };
}

/**
 * The UTC instant of a wall-clock reading on a local date, and what the
 * reading did not say plainly.
 *
 * Two candidates: the reading taken in standard time and the reading taken
 * in daylight time. Each is valid iff the rule agrees with it at the instant
 * it names. Both valid is the repeated hour — the first occurrence (daylight)
 * wins, with `overlap`. Neither is the skipped hour — read as standard, with
 * `gap`, which lands on the instant the clock reached when it jumped.
 * `minuteOfDay` may run past 1439; the date carries.
 */
export function toUtc(clock: YardClock, days: number, minuteOfDay: number): [number, WallNote] {
  const wall = days * DAY_MINUTES + minuteOfDay;
  const standard = (wall - clock.standard_offset_minutes) * MINUTE_MS;
  const rule = clock.daylight;
  if (!rule) return [standard, null];
  const daylight = (wall - rule.offset_minutes) * MINUTE_MS;
  const standardValid = !inForce(rule, clock.standard_offset_minutes, standard);
  const daylightValid = inForce(rule, clock.standard_offset_minutes, daylight);
  if (standardValid && daylightValid) return [daylight, "overlap"];
  if (!standardValid && !daylightValid) return [standard, "gap"];
  return standardValid ? [standard, null] : [daylight, null];
}

/** The UTC instant the local calendar day containing `utcMs` began. */
export function dayStart(clock: YardClock, utcMs: number): number {
  return toUtc(clock, local(clock, utcMs).days, 0)[0];
}

/** The UTC instant the next local calendar day begins. */
export function nextDayStart(clock: YardClock, utcMs: number): number {
  return toUtc(clock, local(clock, utcMs).days + 1, 0)[0];
}

const watchLength = (clock: YardClock): number => Math.max(1, clock.watch_minutes);

/** The local date and 0-based index of the watch containing `utcMs`. */
export function watchOf(clock: YardClock, utcMs: number): { days: number; index: number } {
  const t = local(clock, utcMs);
  return { days: t.days, index: Math.floor(t.minuteOfDay / watchLength(clock)) };
}

/** The UTC instant the watch containing `utcMs` began. Watches are bounded
 *  by wall-clock minutes that are multiples of the watch length on the local
 *  date, so the `00–04` watch is five hours on the fall-back night and three
 *  on the spring-forward night — and still reads `00–04`. */
export function watchStart(clock: YardClock, utcMs: number): number {
  const { days, index } = watchOf(clock, utcMs);
  return toUtc(clock, days, index * watchLength(clock))[0];
}

/** The UTC instant the watch containing `utcMs` ends. */
export function watchEnd(clock: YardClock, utcMs: number): number {
  const { days, index } = watchOf(clock, utcMs);
  return toUtc(clock, days, (index + 1) * watchLength(clock))[0];
}

/** `00–04` — a watch's name, from its index on the local day. */
export function watchLabel(clock: YardClock, index: number): string {
  const lo = index * watchLength(clock);
  return `${pad2(Math.floor(lo / 60))}–${pad2(Math.floor((lo + watchLength(clock)) / 60))}`;
}

/** Every watch of the local calendar day containing `utcMs`, in order. */
export function watchesOf(clock: YardClock, utcMs: number): (Span & { label: string })[] {
  const { days } = local(clock, utcMs);
  const length = watchLength(clock);
  const count = Math.floor(DAY_MINUTES / length);
  return Array.from({ length: count }, (_, index) => ({
    start: toUtc(clock, days, index * length)[0],
    end: toUtc(clock, days, (index + 1) * length)[0],
    label: watchLabel(clock, index),
  }));
}

/** The shifts that belong to the local calendar day containing `utcMs` —
 *  each on the date its start falls on, running its full length even across
 *  midnight. */
export function shiftWindows(clock: YardClock, utcMs: number): (Span & { name: string })[] {
  const { days } = local(clock, utcMs);
  return clock.shifts.map((s) => ({
    name: s.name,
    start: toUtc(clock, days, s.start_minute)[0],
    end: toUtc(clock, days, s.start_minute + s.length_minutes)[0],
  }));
}

/** `07:00–15:30`; a shift that ends at midnight reads `24:00`. */
export function shiftLabel(def: ShiftDef): string {
  const end = def.start_minute + def.length_minutes;
  const endLabel = end === 1440 ? "24:00" : wallLabel(end % 1440);
  return `${wallLabel(def.start_minute)}–${endLabel}`;
}

/** `Days 0700–1530` — the shift as a chip names it. */
export function shiftChip(def: ShiftDef): string {
  return `${def.name} ${shiftLabel(def).replaceAll(":", "")}`;
}

/** `UTC−04:00` — the offset as the time strip shows it, with a real minus. */
export function offsetLabel(minutes: number): string {
  const sign = minutes < 0 ? "−" : "+";
  const magnitude = Math.abs(minutes);
  return `UTC${sign}${pad2(Math.floor(magnitude / 60))}:${pad2(magnitude % 60)}`;
}

/* ------------------------------------------------------------ validation */

/** The rejection, if any, of an offset: within ±14 h and on a quarter hour. */
function offsetProblem(minutes: number): string | null {
  if (!Number.isInteger(minutes)) return `${minutes} min is not whole minutes`;
  if (Math.abs(minutes) > 14 * 60) return `${minutes} min is outside ±14 h`;
  if (minutes % 15 !== 0) return `${minutes} min is not a multiple of 15`;
  return null;
}

/** `UTC`, or `Area/City` in the IANA spelling — letters, digits, `_`, `-`,
 *  `+`, with at least one `/`. */
function zoneIsWellFormed(zone: string): boolean {
  if (zone === "UTC") return true;
  const parts = zone.split("/");
  return parts.length >= 2 && parts.every((p) => /^[A-Za-z0-9_+-]+$/.test(p));
}

function transitionProblems(t: Transition, what: string, out: string[]): void {
  if (!(t.month >= 1 && t.month <= 12)) out.push(`${what}: month ${t.month} is not 1–12`);
  if (!(t.week >= 1 && t.week <= 5)) out.push(`${what}: week ${t.week} is not 1–5`);
  if (!(t.weekday >= 0 && t.weekday <= 6)) out.push(`${what}: weekday ${t.weekday} is not 0–6`);
  if (!(t.minute_of_day >= 0 && t.minute_of_day < 1440)) {
    out.push(`${what}: minute ${t.minute_of_day} is not inside the day`);
  }
}

function shiftProblems(clock: YardClock, out: string[]): void {
  if (clock.shifts.length === 0) out.push("no shifts");
  if (clock.shifts.length > 6) out.push(`${clock.shifts.length} shifts is more than six`);
  const seen: string[] = [];
  for (const shift of clock.shifts) {
    const name = shift.name.trim();
    if (name === "") out.push("a shift has no name");
    else if (seen.includes(name)) out.push(`shift ${name} is listed twice`);
    else seen.push(name);
    if (!(shift.start_minute >= 0 && shift.start_minute < 1440)) {
      out.push(`shift ${name} starts at minute ${shift.start_minute}, outside the day`);
    }
    if (!(shift.length_minutes >= 1 && shift.length_minutes <= 1440)) {
      out.push(`shift ${name} runs ${shift.length_minutes} min, not 1–1440`);
    }
  }
}

/** Every reason this clock must be refused whole — the server's own words,
 *  so the card can say them before the round trip. Empty means valid. */
export function validate(clock: YardClock): string[] {
  const out: string[] = [];
  if (!zoneIsWellFormed(clock.zone)) {
    out.push(`zone ${JSON.stringify(clock.zone)} is not an IANA Area/City name or UTC`);
  }
  const standard = offsetProblem(clock.standard_offset_minutes);
  if (standard) out.push(`standard offset ${standard}`);
  const rule = clock.daylight;
  if (rule) {
    const daylight = offsetProblem(rule.offset_minutes);
    if (daylight) out.push(`daylight offset ${daylight}`);
    if (rule.offset_minutes === clock.standard_offset_minutes) {
      out.push("daylight offset equals the standard offset — drop the rule for a yard whose clock does not move");
    }
    transitionProblems(rule.start, "daylight start", out);
    transitionProblems(rule.end, "daylight end", out);
  }
  const w = clock.watch_minutes;
  if (!(Number.isInteger(w) && w >= 60 && w <= 720 && 1440 % w === 0)) {
    out.push(`a watch of ${w} min must be 60–720 and divide the day`);
  }
  shiftProblems(clock, out);
  return out;
}

/** Maximal runs of minutes satisfying `pred`, as `[lo, hi)` in minutes. */
function runs(cover: number[], pred: (c: number) => boolean): [number, number][] {
  const out: [number, number][] = [];
  let open: number | null = null;
  cover.forEach((count, minute) => {
    if (open === null && pred(count)) open = minute;
    else if (open !== null && !pred(count)) {
      out.push([open, minute]);
      open = null;
    }
  });
  if (open !== null) out.push([open, 1440]);
  return out;
}

/** Findings, not refusals: the minutes of the day no shift covers and the
 *  minutes two shifts both claim. A two-shift yard leaves the night open on
 *  purpose; the door says so and lets a person confirm it. */
export function coverageFindings(clock: YardClock): string[] {
  const cover = new Array<number>(1440).fill(0);
  for (const shift of clock.shifts) {
    for (let k = 0; k < Math.min(1440, shift.length_minutes); k += 1) {
      const minute = floorMod(shift.start_minute + k, 1440);
      cover[minute] = (cover[minute] ?? 0) + 1;
    }
  }
  return [
    ...runs(cover, (c) => c === 0).map(([lo, hi]) => `the shifts leave ${wallLabel(lo)}–${wallLabel(hi)} uncovered`),
    ...runs(cover, (c) => c >= 2).map(([lo, hi]) => `the shifts overlap ${wallLabel(lo)}–${wallLabel(hi)}`),
  ];
}

/* --------------------------------------------------------------- the CSV */

/** `HH:MM` to minutes; `24:00` is allowed (a shift's end). */
function parseHhmm(raw: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if ((h < 24 && mm < 60) || (h === 24 && mm === 0)) return h * 60 + mm;
  return null;
}

/** `±HH:MM` (or `HH:MM`) to minutes east of UTC. */
function parseOffset(line: number, raw: string): number {
  let sign = 1;
  let rest = raw.trim();
  if (rest.startsWith("-") || rest.startsWith("−")) {
    sign = -1;
    rest = rest.slice(1);
  } else if (rest.startsWith("+")) {
    rest = rest.slice(1);
  }
  const minutes = parseHhmm(rest);
  if (minutes === null) throw new Error(`line ${line}: offset ${JSON.stringify(raw)} is not ±HH:MM`);
  return sign * minutes;
}

function parseWall(line: number, what: string, raw: string | undefined): number {
  const minutes = raw === undefined ? null : parseHhmm(raw);
  if (minutes === null) throw new Error(`line ${line}: ${what} ${JSON.stringify(raw ?? "")} is not HH:MM`);
  return minutes;
}

const WEEKDAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseWeekday(line: number, raw: string | undefined): number {
  const text = (raw ?? "").toLowerCase();
  const named = WEEKDAY_NAMES.findIndex((n) => text.startsWith(n));
  if (named >= 0) return named;
  const n = Number(text);
  if (/^\d$/.test(text) && n <= 6) return n;
  throw new Error(`line ${line}: weekday ${JSON.stringify(text)} is not sun..sat or 0–6`);
}

function parseSmall(line: number, what: string, raw: string | undefined): number {
  if (raw !== undefined && /^\d{1,3}$/.test(raw) && Number(raw) <= 255) return Number(raw);
  throw new Error(`line ${line}: ${what} ${JSON.stringify(raw ?? "")} is not a small whole number`);
}

function transitionFrom(line: number, cols: string[]): Transition {
  return {
    month: parseSmall(line, "month", cols[0]),
    week: parseSmall(line, "week", cols[1]),
    weekday: parseWeekday(line, cols[2]),
    minute_of_day: parseWall(line, "transition time", cols[3]),
  };
}

/**
 * The yard clock's CSV form — the boot loader's and this picker's:
 *
 *     zone,America/New_York,-05:00
 *     daylight,-04:00,3,2,sun,02:00,11,1,sun,02:00
 *     watch,240
 *     shift,Days,07:00,15:30
 *
 * Comments and blanks are skipped; a shift whose end is before its start
 * crosses midnight (`23:00,07:00` = 480 min); `24:00` ends a shift at
 * midnight. The result is parsed, not validated — the door runs `validate`
 * and refuses whole. Throws the first row that cannot be carried, by line.
 */
export function parseClockCsv(text: string): YardClock {
  let zone: { name: string; offset: number } | null = null;
  let daylight: DaylightRule | null = null;
  let watchMinutes = 240;
  const shifts: ShiftDef[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = i + 1;
    const t = raw.trim();
    if (!t || t.startsWith("#")) return;
    const c = t.split(",").map((x) => x.trim());
    switch (c[0]) {
      case "zone": {
        const name = c[1];
        if (!name) throw new Error(`line ${line}: no zone name`);
        if (c[2] === undefined) throw new Error(`line ${line}: no standard offset`);
        zone = { name, offset: parseOffset(line, c[2]) };
        break;
      }
      case "daylight": {
        if (c[1] === undefined) throw new Error(`line ${line}: no daylight offset`);
        daylight = {
          offset_minutes: parseOffset(line, c[1]),
          start: transitionFrom(line, c.slice(2, 6)),
          end: transitionFrom(line, c.slice(6, 10)),
        };
        break;
      }
      case "watch": {
        if (c[1] === undefined || !/^\d+$/.test(c[1]) || Number(c[1]) > 65_535) {
          throw new Error(`line ${line}: watch length is not whole minutes`);
        }
        watchMinutes = Number(c[1]);
        break;
      }
      case "shift": {
        const name = c[1];
        if (!name) throw new Error(`line ${line}: a shift has no name`);
        const start = parseWall(line, "shift start", c[2]);
        const end = parseWall(line, "shift end", c[3]);
        const length = floorMod(end - start, 1440);
        if (length === 0) throw new Error(`line ${line}: shift ${name} ends when it starts`);
        shifts.push({ name, start_minute: start, length_minutes: length });
        break;
      }
      default:
        throw new Error(
          `line ${line}: unrecognised record kind ${JSON.stringify(c[0] ?? "")} — every line must start with zone, daylight, watch, or shift,`,
        );
    }
  });
  if (zone === null) throw new Error("no zone row — the clock must name its zone");
  const { name, offset } = zone as { name: string; offset: number };
  return { zone: name, standard_offset_minutes: offset, daylight, watch_minutes: watchMinutes, shifts };
}

/* ------------------------------------------------------- the cross-check */

/** The browser's own offset for `zone` at an instant, minutes east of UTC,
 *  or null when its tz database does not know the zone. */
export function intlOffsetAt(zone: string, utcMs: number): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    }).formatToParts(new Date(utcMs));
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? NaN);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
    if (!Number.isFinite(asUtc)) return null;
    return Math.round((asUtc - utcMs) / MINUTE_MS);
  } catch {
    return null;
  }
}

/** The instants worth checking a rule at: now, half a year on, and an hour
 *  either side of each of this year's transitions — the four readings that
 *  catch a rule that names the wrong Sunday or the wrong hour. */
export function crossCheckInstants(clock: YardClock, nowMs: number): number[] {
  const out = [nowMs, nowMs + 182 * DAY_MS];
  const rule = clock.daylight;
  if (rule) {
    const [year] = civilFromDays(floorDiv(nowMs, DAY_MS));
    for (const at of [
      transitionUtc(rule.start, year, clock.standard_offset_minutes),
      transitionUtc(rule.end, year, rule.offset_minutes),
    ]) {
      out.push(at - 60 * MINUTE_MS, at + 60 * MINUTE_MS);
    }
  }
  return out;
}

/**
 * The authored rule against the browser's tz database at each instant. A
 * disagreement is a warn finding naming the instant and both readings; a
 * zone the browser does not know is one info finding. Agreement says
 * nothing — the rule is the yard's claim, and this only checks it.
 */
export function intlCrossCheck(clock: YardClock, instants: number[]): ClockFinding[] {
  const out: ClockFinding[] = [];
  for (const at of instants) {
    const browser = intlOffsetAt(clock.zone, at);
    if (browser === null) {
      return [{ severity: "info", text: `the browser's tz database does not know ${clock.zone} — the rule could not be cross-checked` }];
    }
    const rule = offsetAt(clock, at);
    if (browser !== rule) {
      // Deliberately a Z-marked UTC instant: the two readings disagree on what
      // the wall clock is, so UTC is the only clock both sides can name. This
      // module is pure and does not import the applied clock (`clock.ts`).
      out.push({
        severity: "warn",
        text: `at ${new Date(at).toISOString().slice(0, 16).replace("T", " ")}Z the rule reads ${offsetLabel(rule)} but the browser's ${clock.zone} reads ${offsetLabel(browser)} — check the daylight rule`,
      });
    }
  }
  return out;
}

/** `2nd Sun Mar 02:00` — a transition as the card describes it. */
export function transitionLabel(t: Transition): string {
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const ORD = ["1st", "2nd", "3rd", "4th", "last"];
  return `${ORD[Math.min(5, Math.max(1, t.week)) - 1]} ${DAYS[floorMod(t.weekday, 7)]} ${MONTHS[Math.min(12, Math.max(1, t.month)) - 1]} ${wallLabel(t.minute_of_day)}`;
}
