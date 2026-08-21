// Crew arithmetic for the manning lens — pure, so it is testable and so the
// three places that talk about people (the map, the trade digest, the zone
// chips) cannot disagree.
//
// DEMAND is derived from the register with the shared pro-rating rule
// (`activityWindowHours`): an activity's hours land in a window by planned
// overlap, and people = hours ÷ the window's duration. A 4-hour half-shift
// holding 8 MH is two people; no other conversion exists in the app.
//
// SUPPLY is the imported manning book, or absent — in which case every reader
// of these numbers must say "demand only" rather than pretend the yard has
// whoever the schedule wishes for.

import type { Activity, WorkConflicts } from "./api";
import { activityWindowHours } from "./windowLoad";

/** People implied by `hours` of work spread over a window of `ms`. */
export function peopleFor(hours: number, ms: number): number {
  return ms > 0 ? hours / (ms / 3_600_000) : 0;
}

export interface TradeDemand {
  trade: string;
  hours: number;
  /** Fractional people; display with ≈ and a ceiling. */
  people: number;
}

/** Demand per trade inside [t0, t1), largest first. */
export function demandByTrade(activities: Activity[], t0: number, t1: number): TradeDemand[] {
  const acc = new Map<string, number>();
  for (const a of activities) {
    const h = activityWindowHours(a, t0, t1);
    if (h > 0) acc.set(a.trade, (acc.get(a.trade) ?? 0) + h);
  }
  return [...acc.entries()]
    .map(([trade, hours]) => ({ trade, hours, people: peopleFor(hours, t1 - t0) }))
    .sort((x, y) => y.hours - x.hours);
}

export interface ZoneDemand {
  zone: string;
  hours: number;
  people: number;
  /** Trade → hours inside the window, largest first when listed. */
  byTrade: Map<string, number>;
  /** Any single space in this zone implies more people than the tolerance. */
  crowded: boolean;
}

/**
 * Demand per zone inside [t0, t1). `spaceZone` maps compartment → zone (from
 * the served register — the shell never invents geography); activities whose
 * space maps to no zone land in the `unzoned` bucket rather than vanishing.
 */
export function demandByZone(
  activities: Activity[],
  spaceZone: Map<string, string>,
  t0: number,
  t1: number,
  crewTolerance: number,
): { zones: ZoneDemand[]; unzonedHours: number } {
  const acc = new Map<string, { hours: number; byTrade: Map<string, number> }>();
  const bySpace = new Map<string, number>();
  let unzonedHours = 0;
  for (const a of activities) {
    const h = activityWindowHours(a, t0, t1);
    if (h <= 0) continue;
    const zone = a.compartment_no ? spaceZone.get(a.compartment_no) : undefined;
    if (!zone) {
      unzonedHours += h;
      continue;
    }
    const z = acc.get(zone) ?? { hours: 0, byTrade: new Map<string, number>() };
    z.hours += h;
    z.byTrade.set(a.trade, (z.byTrade.get(a.trade) ?? 0) + h);
    acc.set(zone, z);
    if (a.compartment_no) {
      bySpace.set(a.compartment_no, (bySpace.get(a.compartment_no) ?? 0) + h);
    }
  }
  const crowdedZones = new Set<string>();
  for (const [space, hours] of bySpace) {
    if (peopleFor(hours, t1 - t0) > crewTolerance) {
      const zone = spaceZone.get(space);
      if (zone) crowdedZones.add(zone);
    }
  }
  const zones = [...acc.entries()]
    .map(([zone, z]) => ({
      zone,
      hours: z.hours,
      people: peopleFor(z.hours, t1 - t0),
      byTrade: z.byTrade,
      crowded: crowdedZones.has(zone),
    }))
    .sort((x, y) => y.hours - x.hours);
  return { zones, unzonedHours };
}

export interface ZoneInteraction {
  /** Zone pair, lexical order so A↔B and B↔A are one row. */
  a: string;
  b: string;
  pairs: number;
  /** A few of the served reasons, for the tooltip. */
  reasons: string[];
}

/**
 * The served hot-vs-flammable pairs, rolled up to zone-against-zone — the
 * "zones interacting with one another" read. Same-zone collisions are kept
 * (a zone fighting itself is still a fight); pairs whose spaces map to no
 * zone are dropped from THIS rollup only, never from the per-space links.
 */
export function zoneInteractions(
  conflicts: WorkConflicts | null,
  spaceZone: Map<string, string>,
): ZoneInteraction[] {
  if (!conflicts) return [];
  const acc = new Map<string, ZoneInteraction>();
  for (const p of conflicts.pairs) {
    const za = spaceZone.get(p.hot.space);
    const zb = spaceZone.get(p.flammable.space);
    if (!za || !zb) continue;
    const [a, b] = za <= zb ? [za, zb] : [zb, za];
    const key = `${a}↔${b}`;
    const row = acc.get(key) ?? { a, b, pairs: 0, reasons: [] };
    row.pairs += 1;
    if (row.reasons.length < 4) row.reasons.push(p.reason);
    acc.set(key, row);
  }
  return [...acc.values()].sort((x, y) => y.pairs - x.pairs);
}
