// The one clock-rendering convention, stated once and imported everywhere.
//
// Every instant in this product is UTC: the API serves epoch milliseconds.
// Every surface renders them in the YARD'S clock — the authored document
// `yardClock.ts` evaluates, which `App.tsx` sets here when the hull's
// timeframe lands. This module is the one place that clock is *applied*:
// no board reads `Date` methods or `toISOString` for a clock time, because a
// board that did would render a different instant from the board beside it.
//
// The marker rule. Until a yard clock is loaded the clock in effect is the
// UTC default, and **every render carrying a clock time carries the Z
// marker** — an unmarked "04:15" reads as local, and for a yard running
// around the clock a UTC instant mistaken for local is an hours-sized misread
// on exactly the numbers (cure clears, refusal starts, shift bounds) this
// tool exists to get right. Once a yard clock is in effect the times are the
// yard's own wall clock and carry no suffix: the zone is shown ONCE, on the
// time strip (`zoneLabel`), rather than stamped on every number. Date-only
// renders carry no marker either way; a calendar date is not a clock reading.
//
// The record-grade stamp (`fmtStamp` — the ledger, print footers, CSV cuts)
// is the exception that always says its offset in full, because a sheet
// found on a desk next year has to say what clock it spoke in.
//
// The scrubber's label (`TimeControl.fmtInstant`) stays separate on purpose:
// it is a control's caption, horizon-aware, and reads the same clock.

import {
  civilFromDays,
  dateLabel,
  local,
  offsetAt,
  offsetLabel,
  UTC_CLOCK,
  wallLabel,
  type YardClock,
} from "./yardClock";

/** The clock a hull is on, as the timeframe serves it. */
export interface YardClockInfo {
  /** The document's label, or null for the UTC default. */
  label: string | null;
  /** `document`, or `default_utc` — served so nothing presents the default
   *  as a yard's claim. */
  source: "document" | "default_utc";
  clock: YardClock;
}

const DEFAULT: YardClockInfo = { label: null, source: "default_utc", clock: UTC_CLOCK };

let inEffect: YardClockInfo = DEFAULT;

/** Puts a hull's clock in effect for every formatter; null is the UTC default. */
export function setYardClock(info: YardClockInfo | null | undefined): void {
  inEffect = info && info.source === "document" ? info : DEFAULT;
}

/** The clock every formatter renders in. */
export const currentClock = (): YardClock => inEffect.clock;

/** The clock in effect, with its provenance. */
export const currentClockInfo = (): YardClockInfo => inEffect;

/** True while no yard clock is loaded and every time on screen is Zulu. */
export const clockIsDefault = (): boolean => inEffect.source !== "document";

/** The suffix a clock time carries: `Z` under the default, nothing under a
 *  yard clock (the zone is on the strip). */
const suffix = (): string => (clockIsDefault() ? "Z" : "");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A calendar day, compact: `08/14`. Boards, gutters, window columns. */
export const fmtDay = (ms: number): string => {
  const [, m, d] = civilFromDays(local(inEffect.clock, ms).days);
  return `${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}`;
};

/** A full calendar date: `2026-08-14`. Tooltips and anywhere ambiguity about
 *  the year would cost a re-read. */
export const fmtDate = (ms: number): string => dateLabel(local(inEffect.clock, ms).days);

/** A wall-clock time with no marker: `07:00`. Shift chips and P6's columns —
 *  places where the zone is already said once. */
export const fmtWall = (ms: number): string => wallLabel(local(inEffect.clock, ms).minuteOfDay);

/** A clock time: `04:15Z` under the default, `04:15` under a yard clock. */
export const fmtTime = (ms: number): string => `${fmtWall(ms)}${suffix()}`;

/** Day and time: `08/14 04:15Z` / `08/14 04:15`. Refusal instants, clears,
 *  as-of stamps. */
export const fmtDayTime = (ms: number): string => `${fmtDay(ms)} ${fmtWall(ms)}${suffix()}`;

/** A record-grade stamp with the year and the offset in full:
 *  `2026-08-14 04:15 −04:00` — or `2026-08-14 08:15Z` under the default, where
 *  Z is the offset. The ledger, print footers, CSV cut lines — anything
 *  somebody may read years later and in another zone. */
export const fmtStamp = (ms: number): string => {
  const t = local(inEffect.clock, ms);
  const base = `${dateLabel(t.days)} ${wallLabel(t.minuteOfDay)}`;
  return clockIsDefault() ? `${base}Z` : `${base} ${offsetLabel(t.offsetMinutes).slice(3)}`;
};

/** A short month name: `Aug`. Axis labels. */
export const fmtMonth = (ms: number): string => {
  const [, m] = civilFromDays(local(inEffect.clock, ms).days);
  return MONTHS[m - 1] ?? "";
};

/** The zone, said once: `America/New_York · UTC−04:00` at the instant, or
 *  `UTC · no yard clock loaded` under the default. */
export function zoneLabel(at: number = Date.now()): string {
  if (clockIsDefault()) return "UTC · no yard clock loaded";
  return `${inEffect.clock.zone} · ${offsetLabel(offsetAt(inEffect.clock, at))}`;
}
