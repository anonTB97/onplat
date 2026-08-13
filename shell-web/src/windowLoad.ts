// The window's share of the schedule, per space — pure math, testable alone.
//
// The horizon control claims a reading window (a shift, a week, a month) and
// the Deck Explorer must answer for it: which spaces carry scheduled work
// inside that window, how much, and how much of it the engine refuses. One
// pro-rating rule, shared in spirit with the Load digest: an activity
// contributes its budget scaled by how much of its planned window overlaps
// the reading window, so a six-week job does not dog-pile its start date.

import type { Activity } from "./api";

export interface SpaceLoad {
  /** Budget man-hours pro-rated into the window. */
  hours: number;
  /** Activities whose planned window intersects the reading window. */
  count: number;
  /** Of those, how many the engine refuses as planned. */
  refused: number;
  /** The earliest activity that STARTS inside the window, if any. */
  next: { code: string; start: number } | null;
}

/** Per-compartment load inside [t0, t1). Milestones and undated rows carry
 *  no load; unlocated rows cannot land on a space and are the caller's
 *  business to count separately. */
export function windowLoadBySpace(
  activities: Activity[],
  t0: number,
  t1: number,
): Map<string, SpaceLoad> {
  const out = new Map<string, SpaceLoad>();
  if (!(t1 > t0)) return out;
  for (const a of activities) {
    if (a.is_milestone || a.planned === null || a.compartment_no === null) continue;
    const w = a.planned;
    const overlap = Math.min(w.end, t1) - Math.max(w.start, t0);
    if (overlap <= 0) continue;
    const span = Math.max(1, w.end - w.start);
    const cell = out.get(a.compartment_no) ?? { hours: 0, count: 0, refused: 0, next: null };
    cell.hours += (a.budget_hours * overlap) / span;
    cell.count += 1;
    if (a.executability.verdict === "not_executable") cell.refused += 1;
    if (w.start >= t0 && (cell.next === null || w.start < cell.next.start)) {
      cell.next = { code: a.code, start: w.start };
    }
    out.set(a.compartment_no, cell);
  }
  return out;
}

/** The hull-wide sum of a per-space load map, plus the unlocated remainder
 *  the map cannot carry — counted, never hidden. */
export function windowLoadTotal(
  activities: Activity[],
  t0: number,
  t1: number,
): { hours: number; count: number; refused: number; unlocated: number } {
  let hours = 0;
  let count = 0;
  let refused = 0;
  let unlocated = 0;
  if (!(t1 > t0)) return { hours, count, refused, unlocated };
  for (const a of activities) {
    if (a.is_milestone || a.planned === null) continue;
    const w = a.planned;
    const overlap = Math.min(w.end, t1) - Math.max(w.start, t0);
    if (overlap <= 0) continue;
    if (a.compartment_no === null) {
      unlocated += 1;
      continue;
    }
    const span = Math.max(1, w.end - w.start);
    hours += (a.budget_hours * overlap) / span;
    count += 1;
    if (a.executability.verdict === "not_executable") refused += 1;
  }
  return { hours, count, refused, unlocated };
}

/** One activity's scheduled man-hours inside [t0, t1) — budget pro-rated by
 *  overlap, zero for milestones, undated rows and empty windows. The same
 *  rule as everywhere: a long job contributes to a shift only what the shift
 *  actually holds of it. */
export function activityWindowHours(a: Activity, t0: number, t1: number): number {
  if (a.is_milestone || a.planned === null || !(t1 > t0)) return 0;
  const w = a.planned;
  const overlap = Math.min(w.end, t1) - Math.max(w.start, t0);
  if (overlap <= 0) return 0;
  return (a.budget_hours * overlap) / Math.max(1, w.end - w.start);
}

/** Whether the activity's REFUSAL interval overlaps [t0, t1) — from the
 *  served evidence alone: the first refusing instant, and the hold's own
 *  earliest clear (an unclocked, verification-gated hold is open-ended).
 *  This is what lets a shift board say "refused during THIS shift" instead
 *  of amber-flagging tonight for a hold that only bites next month. */
export function refusalOverlaps(a: Activity, t0: number, t1: number): boolean {
  const e = a.executability;
  if (e.verdict !== "not_executable") return false;
  if (e.at >= t1) return false;
  return e.earliest_clear === null || e.earliest_clear > t0;
}
