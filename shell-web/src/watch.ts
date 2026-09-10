// The watch block — the platform's floor of time resolution.
//
// The decision (2026-08-21): the lowest level of planning is the watch. A ship
// runs on watches, and a yard plans against them; pretending to hour or minute
// precision on a planning board claims a resolution no schedule actually
// carries. So the finest instant the shell lets a reader pick is the start of a
// watch block, and the finest window it reads over is one block.
//
// Blocks are bounded by the YARD'S wall clock — 00–04, 04–08, … 20–24 on the
// hull's local date, per the yard clock in effect (`clock.ts`) — not offsets
// from "now". Two readers who both pick "Thu 08–12" are reading the same
// instant, today and next month, which is what makes a block a *name* rather
// than a stopwatch. On the night the clock moves, the 00–04 watch is five
// hours long (or three) and still reads 00–04: the name is the yard's, the
// length is the calendar's. Under the UTC default the blocks are the old
// Zulu ones, and the strip says so once.

import { currentClock } from "./clock";
import {
  dayStart as clockDayStart,
  nextDayStart as clockNextDayStart,
  watchEnd,
  watchLabel,
  watchOf,
  watchStart,
  watchesOf,
} from "./yardClock";

/** One watch as a horizon STEP: four hours, in milliseconds. The day grid's
 *  own notches come from the clock (a yard may stand six-hour watches, and
 *  a watch across a clock change is not four hours); this is the uniform
 *  unit the wider horizons and the offset readout count in. */
export const WATCH_MS = 4 * 60 * 60 * 1000;

/** One calendar day, in milliseconds — the uniform horizon step. The yard's
 *  own day is `dayStart`/`nextDayStart`, which know about the 23- and
 *  25-hour days. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Watches per day under the UTC default's four-hour watch. */
export const WATCHES_PER_DAY = DAY_MS / WATCH_MS;

/** The instant the yard's calendar day containing `ms` began. */
export function dayStart(ms: number): number {
  return clockDayStart(currentClock(), ms);
}

/** The instant the yard's next calendar day begins — 23, 24 or 25 hours on. */
export function nextDayStart(ms: number): number {
  return clockNextDayStart(currentClock(), ms);
}

/** The index (0-based) of the watch block containing `ms`, within its local day. */
export function blockIndex(ms: number): number {
  return watchOf(currentClock(), ms).index;
}

/** The start instant of the watch block containing `ms`. */
export function blockStart(ms: number): number {
  return watchStart(currentClock(), ms);
}

/** The end instant of the watch block containing `ms` — the next block's start. */
export function blockEnd(ms: number): number {
  return watchEnd(currentClock(), ms);
}

/**
 * A block's name, e.g. `08–12`. Named by its wall-clock bounds rather than a
 * watch tradition ("forenoon") because the register's readers include people
 * who never stood one. No zone marker: the strip says the zone once.
 */
export function blockLabel(ms: number): string {
  return watchLabel(currentClock(), blockIndex(ms));
}

/** The blocks of the yard's day containing `ms`, in order, with their ends —
 *  which are not `start + WATCH_MS` on the night the clock moves. */
export function watchBlocksOf(ms: number): { start: number; end: number; label: string }[] {
  return watchesOf(currentClock(), ms);
}
