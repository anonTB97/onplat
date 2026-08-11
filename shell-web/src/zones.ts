// Zone geometry: authored when a zone chart has been ingested, inferred from
// the register until then — and this module is where both live, once, so the
// single-deck plate and the whole-ship view can never disagree about where Z4
// ends.
//
// The inferred mode is deliberately modest: a zone's band is the true extent
// of its own spaces, padded a couple of frames — NOT a tiling of the hull. An
// earlier cut tiled the bands edge to edge with midpoint boundaries, which
// presumes zones partition the ship longitudinally. The demo register itself
// refuted that: Z6 (command & surveillance) sits between Z5's clusters,
// because zones here are functional, and forcing a partition painted
// correctly-assigned spaces as errors. A view built to give confidence must
// not manufacture doubt.
//
// Once a chart arrives through the import door, its bounds are drawn AS
// AUTHORED — no padding, no inference — and the disagreement between chart
// and register (spaces outside their zone's bounds) is the server's audit to
// compute and the views' job to show. The audit lives on the API on purpose:
// "is this space inside its zone" implemented on both sides of the wire is
// how two screens end up arguing about the same placard.
//
// In either mode the extent audit reports where bands OVERLAP, as a fact with
// its frame range and its spaces — legitimate for interleaved functional
// zones, and exactly the place to look hard when a zone scheme is supposed to
// partition and does not.

/** The slice of a register row this module needs. */
export interface ZoneSpace {
  no: string;
  zone: string;
  frame: number | null;
}

/** One authored bound from an ingested zone chart. */
export interface AuthoredBound {
  zone: string;
  lo_frame: number;
  hi_frame: number;
}

/** Frames of padding around a zone's outermost pins (inferred mode only). */
const BAND_PAD = 2;

/** One zone's shaded band — authored from a chart, or inferred from spaces. */
export interface ZoneBand {
  zone: string;
  /** Shaded bounds — authored verbatim, or the raw extent padded and clamped. */
  lo: number;
  hi: number;
  /** The zone's own spaces' extent, unpadded (equals lo/hi when spaceless). */
  rawLo: number;
  rawHi: number;
  /** Placeable spaces assigned to the zone. */
  spaces: number;
  /** True when the band is a chart's word rather than this module's guess. */
  authored: boolean;
}

/** Two zones whose bands overlap — a fact, reported not smoothed over. */
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

/**
 * Derives the hull's zone bands and audits them for overlap.
 *
 * With no `chart`, bands are inferred: a zone's spaces' extent, padded, and
 * clamped to `hullLo`/`hullHi` — a band never claims hull its spaces do not
 * reach. With a chart, its bounds are drawn verbatim (authored), zones the
 * chart missed fall back to inference, and bounds naming a space-less zone
 * still draw — an authored empty zone is information, not an error.
 */
export function zoneBands(
  spaces: ZoneSpace[],
  hullLo: number,
  hullHi: number,
  chart?: { label: string; bounds: AuthoredBound[] } | null,
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

  const authored = new Map<string, AuthoredBound>();
  for (const b of chart?.bounds ?? []) authored.set(b.zone, b);

  const zones = new Set([...extents.keys(), ...authored.keys()]);
  const bands: ZoneBand[] = [...zones]
    .flatMap((zone) => {
      const bound = authored.get(zone);
      const e = extents.get(zone);
      if (bound) {
        return [
          {
            zone,
            lo: Math.max(hullLo, bound.lo_frame),
            hi: Math.min(hullHi, bound.hi_frame),
            rawLo: e?.lo ?? bound.lo_frame,
            rawHi: e?.hi ?? bound.hi_frame,
            spaces: e?.n ?? 0,
            authored: true,
          },
        ];
      }
      if (e) {
        return [
          {
            zone,
            lo: Math.max(hullLo, e.lo - BAND_PAD),
            hi: Math.min(hullHi, e.hi + BAND_PAD),
            rawLo: e.lo,
            rawHi: e.hi,
            spaces: e.n,
            authored: false,
          },
        ];
      }
      return [];
    })
    .sort(
      (a, b) => (a.rawLo + a.rawHi) / 2 - (b.rawLo + b.rawHi) / 2 || a.zone.localeCompare(b.zone),
    );

  // The extent audit: every pair of bands that share hull. Authored bands
  // audit on their authored bounds (the chart's own claim); inferred bands on
  // their raw extents, so padding never manufactures an overlap.
  const auditLo = (b: ZoneBand) => (b.authored ? b.lo : b.rawLo);
  const auditHi = (b: ZoneBand) => (b.authored ? b.hi : b.rawHi);
  const overlaps: ZoneOverlap[] = [];
  for (let i = 0; i < bands.length; i++) {
    for (let j = i + 1; j < bands.length; j++) {
      const a = bands[i];
      const b = bands[j];
      if (a === undefined || b === undefined) continue;
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
