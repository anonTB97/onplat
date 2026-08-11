// The one invariant that makes wheel zoom feel right, proven rather than
// eyeballed: **the point under the cursor stays under the cursor.** These were
// one-off browser scripts; a browser script proves the build you ran it
// against, a unit test proves every build after it too.

import { describe, expect, it } from "vitest";
import {
  clampZoom,
  planZoomAt,
  sheetBoxHeight,
  sheetZoomAt,
  wheelFactor,
  type SheetCamera,
} from "./camera";

// A deterministic LCG so the invariants run over many cameras without the test
// being different on every run.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("wheelFactor", () => {
  it("scroll up zooms in, scroll down zooms out, nothing is a no-op", () => {
    expect(wheelFactor(-100, 0, false)).toBeGreaterThan(1);
    expect(wheelFactor(100, 0, false)).toBeLessThan(1);
    expect(wheelFactor(0, 0, false)).toBe(1);
  });

  it("is symmetric: equal and opposite wheels cancel exactly", () => {
    expect(wheelFactor(-120, 0, false) * wheelFactor(120, 0, false)).toBeCloseTo(1, 12);
  });

  it("a pinch (ctrl+wheel) gets more gain than a scroll of the same delta", () => {
    expect(wheelFactor(-30, 0, true)).toBeGreaterThan(wheelFactor(-30, 0, false));
  });

  it("line-mode deltas (Firefox) are scaled to roughly match pixel deltas", () => {
    expect(wheelFactor(-3, 1, false)).toBeCloseTo(wheelFactor(-60, 0, false), 12);
  });
});

describe("clampZoom", () => {
  it("never below fitted (1) and never past the ceiling", () => {
    expect(clampZoom(0.2, 8)).toBe(1);
    expect(clampZoom(12, 8)).toBe(8);
    expect(clampZoom(3.3, 8)).toBe(3.3);
  });
});

describe("planZoomAt — SVG translate/scale views", () => {
  it("keeps the viewBox point under the cursor fixed across any zoom change", () => {
    const rnd = lcg(7);
    for (let i = 0; i < 200; i++) {
      const cam = {
        zoom: 1 + rnd() * 3,
        pan: { x: (rnd() - 0.5) * 400, y: (rnd() - 0.5) * 400 },
      };
      const cursor = { x: rnd() * 1000, y: rnd() * 400 };
      const zNew = clampZoom(cam.zoom * wheelFactor((rnd() - 0.5) * 240, 0, false), 4);
      const panNew = planZoomAt(cam, cursor, zNew);
      // The world point that was under the cursor before…
      const before = {
        x: (cursor.x - cam.pan.x) / cam.zoom,
        y: (cursor.y - cam.pan.y) / cam.zoom,
      };
      // …is still under the cursor after.
      const after = {
        x: (cursor.x - panNew.x) / zNew,
        y: (cursor.y - panNew.y) / zNew,
      };
      expect(after.x).toBeCloseTo(before.x, 9);
      expect(after.y).toBeCloseTo(before.y, 9);
    }
  });

  it("zooming to the same level moves nothing", () => {
    const cam = { zoom: 2, pan: { x: 30, y: -12 } };
    expect(planZoomAt(cam, { x: 500, y: 200 }, 2)).toEqual(cam.pan);
  });
});

/** A plausible plate camera at zoom `z`, mirroring how SheetView derives one. */
function sheetCam(z: number, panX: number, panY: number): SheetCamera {
  const W = 8000; // sheet width, sheet units
  const boxW = 1200; // CSS px
  const fit = boxW / W;
  const naturalH = boxW * (2400 / 8000);
  const maxH = 820;
  const scale = fit * z;
  const boxH = Math.min(maxH, Math.max(150, naturalH * z));
  const vw = boxW / scale;
  const vh = boxH / scale;
  // The derived centre before clamping; pan already applied.
  const centre = { x: W / 2 + panX, y: 1200 + panY };
  return { z, centre, vw, vh, u: 1 / scale, fit, naturalH, boxW, maxH, pan: { x: panX, y: panY } };
}

describe("sheetZoomAt — the plate view's clamped-centre camera", () => {
  it("keeps the sheet point under the cursor fixed across any zoom change", () => {
    const rnd = lcg(41);
    for (let i = 0; i < 200; i++) {
      const cam = sheetCam(1 + rnd() * 7, (rnd() - 0.5) * 2000, (rnd() - 0.5) * 800);
      const px = rnd() * cam.boxW;
      const py = rnd() * Math.min(cam.maxH, Math.max(150, cam.naturalH * cam.z));
      const zNew = clampZoom(cam.z * wheelFactor((rnd() - 0.5) * 240, 0, false), 8);
      const panNew = sheetZoomAt(cam, px, py, zNew);

      const before = {
        x: cam.centre.x - cam.vw / 2 + px * cam.u,
        y: cam.centre.y - cam.vh / 2 + py * cam.u,
      };
      // Rebuild the camera as the view would on the next render (ignoring the
      // edge clamp, which sheetZoomAt leaves to the view on purpose).
      const scaleN = cam.fit * zNew;
      const centreN = {
        x: cam.centre.x + (panNew.x - cam.pan.x),
        y: cam.centre.y + (panNew.y - cam.pan.y),
      };
      const after = {
        x: centreN.x - cam.boxW / scaleN / 2 + px / scaleN,
        y: centreN.y - sheetBoxHeight(cam, zNew) / scaleN / 2 + py / scaleN,
      };
      expect(after.x).toBeCloseTo(before.x, 6);
      expect(after.y).toBeCloseTo(before.y, 6);
    }
  });

  it("the pan comes back as an offset from the current centre, so a no-op zoom is a no-op pan", () => {
    const cam = sheetCam(3, 140, -60);
    // Zooming to the current level from the box centre must not move the pan
    // (the box centre is the one cursor position with no parallax).
    const boxH = Math.min(cam.maxH, Math.max(150, cam.naturalH * cam.z));
    const pan = sheetZoomAt(cam, cam.boxW / 2, boxH / 2, cam.z);
    expect(pan.x).toBeCloseTo(cam.pan.x, 9);
    expect(pan.y).toBeCloseTo(cam.pan.y, 9);
  });
});
