// The 4-hour watch block — the platform's floor of time resolution.
//
// The decision (2026-08-21): the lowest level of planning is four hours. A ship
// runs on watches, and a yard plans against them; pretending to hour or minute
// precision on a planning board claims a resolution no schedule actually
// carries. So the finest instant the shell lets a reader pick is the start of a
// watch block, and the finest window it reads over is one block.
//
// Blocks are UTC-calendar-aligned — 00–04Z, 04–08Z, … 20–24Z — not offsets from
// "now". Two readers who both pick "Thu 08–12Z" are reading the same instant,
// today and next month, which is what makes a block a *name* rather than a
// stopwatch. (The Z convention: see `clock.ts`.)

/** One watch: four hours, in milliseconds. */
export const WATCH_MS = 4 * 60 * 60 * 1000;

/** One calendar day, in milliseconds. UTC days have no DST — this is exact. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Watches per day. */
export const WATCHES_PER_DAY = DAY_MS / WATCH_MS;

/** Midnight Z of the UTC day containing `ms`. */
export function utcDayStart(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** The index (0–5) of the watch block containing `ms`, within its UTC day. */
export function blockIndex(ms: number): number {
  return Math.floor((ms - utcDayStart(ms)) / WATCH_MS);
}

/** The start instant of the watch block containing `ms`. */
export function blockStart(ms: number): number {
  return utcDayStart(ms) + blockIndex(ms) * WATCH_MS;
}

/**
 * A block's name, e.g. `08–12Z`. Named by its bounds rather than a watch
 * tradition ("forenoon") because the register's readers include people who
 * never stood one.
 */
export function blockLabel(ms: number): string {
  const i = blockIndex(ms);
  const pad = (h: number) => String(h).padStart(2, "0");
  return `${pad(i * 4)}–${pad((i + 1) * 4)}Z`;
}

/** The six blocks of the UTC day containing `ms`, in order. */
export function watchBlocksOf(ms: number): { start: number; label: string }[] {
  const day = utcDayStart(ms);
  return Array.from({ length: WATCHES_PER_DAY }, (_, i) => ({
    start: day + i * WATCH_MS,
    label: blockLabel(day + i * WATCH_MS),
  }));
}
