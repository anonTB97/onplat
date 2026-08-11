// What the zone shading is allowed to claim.
//
// The bands say "this zone's spaces span this stretch of hull" and the audit
// says "these zones share hull" — both claims a reader will act on, so both
// are pinned here rather than trusted to look right on a screenshot.

import { describe, expect, it } from "vitest";
import { zoneBands, type ZoneSpace } from "./zones";

const space = (no: string, zone: string, frame: number | null): ZoneSpace => ({ no, zone, frame });

describe("zoneBands", () => {
  it("a band is its zone's true extent, padded and clamped — never a claim beyond its spaces", () => {
    const g = zoneBands(
      [
        space("a", "Z2", 40), space("b", "Z2", 70),
        space("c", "Z4", 110), space("d", "Z4", 140),
      ],
      0,
      280,
    );
    expect(g.bands.map((b) => b.zone)).toEqual(["Z2", "Z4"]);
    const [z2, z4] = g.bands;
    expect(z2).toMatchObject({ rawLo: 40, rawHi: 70, lo: 38, hi: 72, spaces: 2 });
    expect(z4).toMatchObject({ rawLo: 110, rawHi: 140, lo: 108, hi: 142 });
    // Disjoint zones: the audit finds nothing, and the gap between bands is
    // honest — the register has nothing there.
    expect(g.overlaps).toEqual([]);
  });

  it("clamps padding to the hull limits", () => {
    const g = zoneBands([space("a", "Z1", 1), space("b", "Z1", 279)], 0, 280);
    expect(g.bands[0]).toMatchObject({ lo: 0, hi: 280 });
  });

  it("orders zones by where their spaces actually sit, not by name", () => {
    const g = zoneBands([space("a", "ZZ-aft", 30), space("b", "AA-fwd", 200)], 0, 280);
    expect(g.bands.map((b) => b.zone)).toEqual(["ZZ-aft", "AA-fwd"]);
  });

  it("reports overlapping extents as facts, with the shared stretch and its spaces", () => {
    // The demo's own shape: Z6 wholly inside Z5's extent.
    const g = zoneBands(
      [
        space("a", "Z5", 140), space("b", "Z5", 148), space("c", "Z5", 192),
        space("d", "Z6", 152), space("e", "Z6", 160), space("f", "Z6", 164),
      ],
      0,
      280,
    );
    expect(g.overlaps).toHaveLength(1);
    expect(g.overlaps[0]).toMatchObject({ a: "Z5", b: "Z6", lo: 152, hi: 164 });
    // Spaces of either zone inside the shared stretch: the three Z6 spaces.
    expect(g.overlaps[0]?.spaces).toBe(3);
  });

  it("a partial overlap counts both zones' spaces in the shared stretch", () => {
    const g = zoneBands(
      [
        space("a", "Z1", 100), space("b", "Z1", 150),
        space("c", "Z2", 140), space("d", "Z2", 200),
      ],
      0,
      280,
    );
    expect(g.overlaps[0]).toMatchObject({ lo: 140, hi: 150, spaces: 2 });
  });

  it("counts what it cannot place instead of hiding it", () => {
    const g = zoneBands(
      [space("a", "Z2", 40), space("b", "Z2", null), space("c", "Z9", null)],
      0,
      280,
    );
    expect(g.unplaced).toBe(2);
    expect(g.bandless).toEqual(["Z9"]);
    expect(g.bands.map((b) => b.zone)).toEqual(["Z2"]);
  });
});
