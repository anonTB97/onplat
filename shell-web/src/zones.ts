// Zone geometry, derived from the register and audited against it.
//
// The register assigns each compartment a zone; it does not (yet) carry
// authored zone boundaries. So the bands every view shades are INFERRED — and
// this module is where the inference lives, once, so the single-deck plate and
// the whole-ship view can never disagree about where Z4 ends.
//
// The inference is deliberately modest: a zone's band is the true extent of
// its own spaces, padded a couple of frames — NOT a tiling of the hull. An
// earlier cut tiled the bands edge to edge with midpoint boundaries, which
// presumes zones partition the ship longitudinally. The demo register itself
// refuted that: Z6 (command & surveillance, Fr 152–164) sits wholly inside
// Z5's extent (Fr 140–192), because zones here are functional, and forcing a
// partition painted ten correctly-assigned spaces as errors. A view built to
// give confidence must not manufacture doubt.
//
// So the audit reports what is actually true instead: where zone extents
// OVERLAP, as a fact with its frame range and its spaces — legitimate for
// interleaved functional zones, and exactly the place to look hard when a
// zone scheme is supposed to partition and does not.

/** The slice of a register row this module needs. */
export interface ZoneSpace {
  no: string;
  zone: string;
  frame: number | null;
}

/** Frames of padding around a zone's outermost pins. */
const BAND_PAD = 2;

/** One zone's shaded band: its spaces' true extent, padded. */
export interface ZoneBand {
  zone: string;
  /** Shaded bounds — the raw extent padded and clamped to the hull. */
  lo: number;
  hi: number;
  /** The zone's own spaces' extent, unpadded. */
  rawLo: number;
  rawHi: number;
  /** How many placeable spaces the band was inferred from. */
  spaces: number;
}

/** Two zones whose extents overlap — a fact, reported not smoothed over. */
export interface ZoneOverlap {
  a: string;
  b: string;
  /** The shared stretch of hull, in frames (raw extents, unpadded). */
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
  /** Zones with no placeable spaces — they exist but cannot be shaded. */
  bandless: string[];
}

/**
 * Derives the hull's zone bands and audits the extents for overlap.
 *
 * `hullLo`/`hullHi` only clamp the padding: a band never claims hull beyond
 * the limits, and never claims hull its spaces do not reach — an uncovered
 * stretch means the register has nothing there, which is the honest answer.
 */
export function zoneBands(spaces: ZoneSpace[], hullLo: number, hullHi: number): ZoneGeometry {
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

  const bands: ZoneBand[] = [...extents.entries()]
    .map(([zone, e]) => ({
      zone,
      lo: Math.max(hullLo, e.lo - BAND_PAD),
      hi: Math.min(hullHi, e.hi + BAND_PAD),
      rawLo: e.lo,
      rawHi: e.hi,
      spaces: e.n,
    }))
    .sort((a, b) => (a.rawLo + a.rawHi) / 2 - (b.rawLo + b.rawHi) / 2 || a.zone.localeCompare(b.zone));

  // The audit: every pair of zones whose raw extents share hull. Reported with
  // the shared stretch and the spaces inside it, so a reader can judge whether
  // the interleaving is the zone scheme's nature or somebody's typo.
  const overlaps: ZoneOverlap[] = [];
  for (let i = 0; i < bands.length; i++) {
    for (let j = i + 1; j < bands.length; j++) {
      const a = bands[i];
      const b = bands[j];
      if (a === undefined || b === undefined) continue;
      const lo = Math.max(a.rawLo, b.rawLo);
      const hi = Math.min(a.rawHi, b.rawHi);
      if (lo > hi) continue;
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

  const bandless = [...zonesSeen].filter((z) => !extents.has(z)).sort();
  return { bands, overlaps, unplaced, bandless };
}
