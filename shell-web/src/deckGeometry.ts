// Positioning for the deck plan.
//
// The mapping from a compartment's frame onto the sheet is taken from the
// prototype verbatim, because the deck sheets it was tuned against are real
// general-arrangement drawings and the constants encode where the hull sits on
// those sheets. Re-deriving them would move every marker.
//
//   frX(frame) = clamp(0.95 - (frame / 280) * 0.86, 0.05, 0.96)
//
// Frames run bow-to-stern left-to-right on the sheet, hence the descending
// slope. 280 is the frame count the drawings are scaled to.
//
// Vertical placement is *not* the prototype's fixed ±0.16 band. That constant
// assumes at most one marker per side per frame region, and a real register
// puts six compartments on one side of one deck within sixty frames — they land
// on top of each other and the sheet becomes unreadable. Markers are packed
// into lanes instead (below), and the sheet grows to fit however many lanes the
// register turns out to need.

const FRAME_SPAN = 280;
const X_SPAN = 0.86;
const X_BOW = 0.95;

/** The hull outline occupies the middle 70% of the sheet, so half of it is 0.35. */
const HULL_HALF = 0.35;
/** Breathing room between the outermost marker and the hull edge, in sheet units. */
const HULL_PAD = 8;

/** Fraction across the sheet, 0 = left edge, 1 = right edge. */
export function frameToX(frame: number): number {
  return Math.max(0.05, Math.min(0.96, X_BOW - (frame / FRAME_SPAN) * X_SPAN));
}

/** Frame at a horizontal position — inverse of `frameToX`, for the hover readout. */
export function xToFrame(xFraction: number): number {
  return Math.round(((X_BOW - xFraction) / X_SPAN) * FRAME_SPAN);
}

/** How many frames something `span` wide covers on a sheet `sheet` wide. */
export function framesPerSpan(span: number, sheet: number): number {
  return (span / sheet / X_SPAN) * FRAME_SPAN;
}

export interface PlanItem {
  id: string;
  frame: number | null;
  side: string;
}

/**
 * Greedy lane packing: each marker takes the first lane whose previous marker
 * ends before this one starts.
 *
 * This is the fix for the overlap. Bucketing by frame number cannot work — two
 * compartments twelve frames apart fall in different buckets, both get lane 0,
 * and then collide anyway, because a marker is about thirty frames wide at
 * normal zoom. What decides a collision is the marker's *width*, so that is
 * what `minGap` is measured in.
 *
 * Deterministic: sorted before assigning, so the same register always lays out
 * the same way. That matters when two planners are looking at the same screen
 * and one of them says "the one below it".
 */
export function packLanes(items: PlanItem[], minGap: number): Map<string, number> {
  const level = new Map<string, number>();
  /** Frame of the rightmost marker placed in each lane so far. */
  const occupied: number[] = [];
  const ordered = items
    .filter((i) => i.frame !== null)
    .sort((a, b) => (a.frame ?? 0) - (b.frame ?? 0) || a.id.localeCompare(b.id));

  for (const item of ordered) {
    const frame = item.frame ?? 0;
    let lane = 0;
    while (lane < occupied.length && frame - (occupied[lane] ?? -Infinity) < minGap) lane += 1;
    occupied[lane] = frame;
    level.set(item.id, lane);
  }
  return level;
}

function laneCount(levels: Map<string, number>): number {
  let max = -1;
  for (const l of levels.values()) max = Math.max(max, l);
  return max + 1;
}

export interface PlanLayout {
  /** Sheet height needed to hold every lane — feeds the SVG `viewBox`. */
  height: number;
  /** Marker centres, in sheet units. Compartments with no frame are absent. */
  positions: Map<string, { x: number; y: number }>;
  /** Lanes in use each side of the centreline, for the caller's own reporting. */
  lanes: { centre: number; port: number; starboard: number };
}

/**
 * Places every compartment on the sheet: `x` from its frame, `y` from the lane
 * its side put it in.
 *
 * Side is kept honest. Port markers stay to port and starboard to starboard —
 * fanning is only ever *outward* from the centreline, never across it, because
 * a marker on the wrong side of the ship is worse than a crowded one. A
 * compartment whose side we could not establish is drawn on the centreline
 * rather than guessed onto a side.
 */
export function layoutPlan(
  items: PlanItem[],
  opts: { width: number; markerWidth: number; laneHeight: number; minHeight: number },
): PlanLayout {
  const minGap = framesPerSpan(opts.markerWidth + 6, opts.width);
  const centre = packLanes(
    items.filter((i) => i.side !== "port" && i.side !== "starboard"),
    minGap,
  );
  const port = packLanes(
    items.filter((i) => i.side === "port"),
    minGap,
  );
  const starboard = packLanes(
    items.filter((i) => i.side === "starboard"),
    minGap,
  );

  const centreLanes = laneCount(centre);
  // Offsets from the centreline, in lane units. The centreline stack is centred
  // on the keel line; the flanks start clear of whatever it occupies, so a deck
  // with centreline compartments pushes port and starboard outward instead of
  // colliding with them.
  const offset = new Map<string, number>();
  for (const [id, lane] of centre) offset.set(id, lane - (centreLanes - 1) / 2);
  const flank = centreLanes / 2 + 0.5;
  for (const [id, lane] of port) offset.set(id, -(flank + lane));
  for (const [id, lane] of starboard) offset.set(id, flank + lane);

  let deepest = 0;
  for (const o of offset.values()) deepest = Math.max(deepest, Math.abs(o));
  const height = Math.max(
    opts.minHeight,
    ((deepest + 0.5) * opts.laneHeight + HULL_PAD) / HULL_HALF,
  );

  const positions = new Map<string, { x: number; y: number }>();
  for (const item of items) {
    if (item.frame === null) continue;
    positions.set(item.id, {
      x: frameToX(item.frame) * opts.width,
      y: height / 2 + (offset.get(item.id) ?? 0) * opts.laneHeight,
    });
  }

  return {
    height,
    positions,
    lanes: {
      centre: centreLanes,
      port: laneCount(port),
      starboard: laneCount(starboard),
    },
  };
}
