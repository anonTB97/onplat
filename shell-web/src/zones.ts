// Zone geometry: authored when a zone chart has been ingested, inferred from
// the register until then — and this module is where both live, once, so the
// single-deck plate and the whole-ship view can never disagree about where Z4
// ends.
//
// A zone is a BLOCK, not a stripe (docs/zone-scheme.md): a band of frames on
// a band of decks. An authored chart carries one or more blocks per zone,
// each drawn only on the decks it covers — the flight deck's zone never
// shades the reactor compartments beneath it. Until a chart arrives, bands
// are inferred hull-wide from the register's spaces, and say so.
//
// Inferred bands TILE the hull: sorted by cluster centre, each pair of
// neighbouring bands meets at the midpoint between their raw extents, and the
// outermost bands run to the hull's ends — so the ship is covered edge to
// edge and bands never overlap or leave unexplained gaps. The boundaries
// between clusters are honest guesses and the interiors are not: `rawLo`/
// `rawHi` keep each zone's true extent, the views draw the raw extent
// stronger than the fill, and — critically — the overlap audit runs on RAW
// extents, never the tiled bounds, so tiling can never manufacture a
// finding. (An earlier cut refused to tile at all; the maintenance-zone
// reading won: a zone chart partitions the hull, and a band view with gaps
// reads as missing data, not modesty.)
//
// Once a chart arrives through the import door, its blocks are drawn AS
// AUTHORED — no padding, no inference — and the disagreement between chart
// and register (spaces outside their zone's blocks) is the server's audit to
// compute and the views' job to show. The audit lives on the API on purpose:
// "is this space inside its zone" implemented on both sides of the wire is
// how two screens end up arguing about the same placard.
//
// In either mode the extent audit reports where bands OVERLAP on decks they
// share, as a fact with its frame range and its spaces — legitimate for
// interleaved functional zones, and exactly the place to look hard when a
// zone scheme is supposed to partition and does not.

/** The slice of a register row this module needs. */
export interface ZoneSpace {
  no: string;
  zone: string;
  frame: number | null;
  /** The deck's ordinal, when the caller knows it — what places a space in a
   *  deck-banded block. */
  deckOrdinal?: number;
}

/** One authored block from an ingested zone chart. */
export interface AuthoredBound {
  zone: string;
  lo_frame: number;
  hi_frame: number;
  top_deck?: string | null;
  bottom_deck?: string | null;
}

/** Frames of padding around a zone's outermost pins (inferred mode only). */
const BAND_PAD = 2;

/** One zone's shaded band — an authored block, or inferred from spaces. */
export interface ZoneBand {
  /** Unique across the hull: the zone, suffixed when it owns several blocks. */
  key: string;
  zone: string;
  /** Shaded bounds — authored verbatim, or the raw extent padded and clamped. */
  lo: number;
  hi: number;
  /** The zone's own spaces' extent inside this band, unpadded (equals lo/hi when spaceless). */
  rawLo: number;
  rawHi: number;
  /** Placeable spaces assigned to the zone inside this band. */
  spaces: number;
  /** True when the band is a chart's word rather than this module's guess. */
  authored: boolean;
  /** The deck band as ordinals, top (smallest) to bottom; null = every deck. */
  top: number | null;
  bottom: number | null;
}

/** Two zones whose bands overlap on decks they share — a fact, reported not smoothed over. */
export interface ZoneOverlap {
  a: string;
  b: string;
  /** The shared stretch of hull, in frames. */
  lo: number;
  hi: number;
  /** Spaces of either zone inside the shared stretch. */
  spaces: number;
}

export interface ZoneGeometry {
  bands: ZoneBand[];
  overlaps: ZoneOverlap[];
  /** Spaces with no frame — assignable to no band, counted not hidden. */
  unplaced: number;
  /** Zones with spaces but no band to draw (no frames AND no authored bound). */
  bandless: string[];
  /** The ingested chart's label, or null when every band is inferred. */
  source: string | null;
}

/** Whether a band covers a deck: every deck when it carries no deck band. */
export function bandCoversDeck(band: { top: number | null; bottom: number | null }, ordinal: number): boolean {
  return band.top === null || band.bottom === null || (ordinal >= band.top && ordinal <= band.bottom);
}

/** Whether two deck bands share a deck (null = every deck). */
function decksIntersect(a: { top: number | null; bottom: number | null }, b: { top: number | null; bottom: number | null }): boolean {
  if (a.top === null || a.bottom === null || b.top === null || b.bottom === null) return true;
  return a.top <= b.bottom && b.top <= a.bottom;
}

/**
 * Derives the hull's zone bands and audits them for overlap.
 *
 * With no `chart`, bands are inferred: a zone's spaces' extent, padded, and
 * clamped to `hullLo`/`hullHi` — a band never claims hull its spaces do not
 * reach. With a chart, its blocks are drawn verbatim (authored), zones the
 * chart missed fall back to inference, and blocks naming a space-less zone
 * still draw — an authored empty zone is information, not an error. Deck
 * bands need `deckOrdinals` (register code → ordinal) to be placed; a block
 * whose decks the caller cannot resolve draws on every deck and audits as
 * such.
 */
export function zoneBands(
  spaces: ZoneSpace[],
  hullLo: number,
  hullHi: number,
  chart?: { label: string; bounds: AuthoredBound[] } | null,
  deckOrdinals?: Map<string, number>,
): ZoneGeometry {
  const extents = new Map<string, { lo: number; hi: number; n: number }>();
  let unplaced = 0;
  const zonesSeen = new Set<string>();
  for (const s of spaces) {
    zonesSeen.add(s.zone);
    if (s.frame === null) {
      unplaced += 1;
      continue;
    }
    const e = extents.get(s.zone);
    if (e) {
      e.lo = Math.min(e.lo, s.frame);
      e.hi = Math.max(e.hi, s.frame);
      e.n += 1;
    } else {
      extents.set(s.zone, { lo: s.frame, hi: s.frame, n: 1 });
    }
  }

  const authoredByZone = new Map<string, AuthoredBound[]>();
  for (const b of chart?.bounds ?? []) {
    const list = authoredByZone.get(b.zone) ?? [];
    list.push(b);
    authoredByZone.set(b.zone, list);
  }
  const ordinalOf = (code: string | null | undefined): number | null =>
    code ? (deckOrdinals?.get(code) ?? null) : null;

  const zones = new Set([...extents.keys(), ...authoredByZone.keys()]);
  const bands: ZoneBand[] = [...zones].flatMap((zone): ZoneBand[] => {
    const blocks = authoredByZone.get(zone);
    const e = extents.get(zone);
    if (blocks) {
      return blocks.map((block, i) => {
        const top = ordinalOf(block.top_deck);
        const bottom = ordinalOf(block.bottom_deck);
        // The zone's spaces inside this block's deck band — the raw extent
        // the views draw stronger, and the audit's own claim.
        const inside = spaces.filter(
          (s) =>
            s.zone === zone &&
            s.frame !== null &&
            (top === null || bottom === null || s.deckOrdinal === undefined ||
              (s.deckOrdinal >= top && s.deckOrdinal <= bottom)),
        );
        const frames = inside.map((s) => s.frame ?? 0);
        return {
          key: blocks.length > 1 ? `${zone}#${i + 1}` : zone,
          zone,
          lo: Math.max(hullLo, block.lo_frame),
          hi: Math.min(hullHi, block.hi_frame),
          rawLo: frames.length > 0 ? Math.min(...frames) : block.lo_frame,
          rawHi: frames.length > 0 ? Math.max(...frames) : block.hi_frame,
          spaces: inside.length,
          authored: true,
          top,
          bottom,
        };
      });
    }
    if (e) {
      return [
        {
          key: zone,
          zone,
          lo: Math.max(hullLo, e.lo - BAND_PAD),
          hi: Math.min(hullHi, e.hi + BAND_PAD),
          rawLo: e.lo,
          rawHi: e.hi,
          spaces: e.n,
          authored: false,
          top: null,
          bottom: null,
        },
      ];
    }
    return [];
  });
  bands.sort(
    (a, b) => (a.rawLo + a.rawHi) / 2 - (b.rawLo + b.rawHi) / 2 || a.key.localeCompare(b.key),
  );

  // Tile the inferred bands so the hull is covered end to end: neighbours
  // meet at the midpoint between their RAW extents, outermost bands take the
  // hull's ends. Authored bands are a chart's word and are never restated.
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    if (b === undefined || b.authored) continue;
    const prev = bands[i - 1];
    const next = bands[i + 1];
    b.lo = prev === undefined ? hullLo : prev.authored ? b.lo : Math.floor((prev.rawHi + b.rawLo) / 2);
    b.hi = next === undefined ? hullHi : next.authored ? b.hi : Math.floor((b.rawHi + next.rawLo) / 2);
    // Interleaved clusters can invert a midpoint; a band never claims less
    // than its own spaces reach.
    b.lo = Math.min(b.lo, b.rawLo);
    b.hi = Math.max(b.hi, b.rawHi);
  }

  // The extent audit: every pair of bands of DIFFERENT zones that share hull
  // on decks they share. Authored bands audit on their authored bounds (the
  // chart's own claim); inferred bands on their raw extents, so padding
  // never manufactures an overlap. Two blocks of one zone are that zone's
  // shape, not a finding.
  const auditLo = (b: ZoneBand) => (b.authored ? b.lo : b.rawLo);
  const auditHi = (b: ZoneBand) => (b.authored ? b.hi : b.rawHi);
  const overlaps: ZoneOverlap[] = [];
  for (let i = 0; i < bands.length; i++) {
    for (let j = i + 1; j < bands.length; j++) {
      const a = bands[i];
      const b = bands[j];
      if (a === undefined || b === undefined || a.zone === b.zone) continue;
      if (!decksIntersect(a, b)) continue;
      const lo = Math.max(auditLo(a), auditLo(b));
      const hi = Math.min(auditHi(a), auditHi(b));
      if (lo > hi) continue;
      // Two authored zones MEETING at a frame is a chart drawn properly, not
      // an overlap; a shared frame of actual space extents still is one.
      if (lo === hi && a.authored && b.authored) continue;
      const inside = spaces.filter(
        (s) =>
          s.frame !== null &&
          s.frame >= lo &&
          s.frame <= hi &&
          (s.zone === a.zone || s.zone === b.zone),
      ).length;
      // Pair named alphabetically, so "Z5 ∩ Z6" reads the same however the
      // extents happen to sort.
      const [first, second] = [a.zone, b.zone].sort();
      overlaps.push({ a: first ?? a.zone, b: second ?? b.zone, lo, hi, spaces: inside });
    }
  }

  const drawable = new Set(bands.map((b) => b.zone));
  const bandless = [...zonesSeen].filter((z) => !drawable.has(z)).sort();
  return { bands, overlaps, unplaced, bandless, source: chart?.label ?? null };
}
