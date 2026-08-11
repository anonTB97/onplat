// The deck views' camera maths, pure and unit-tested.
//
// Extracted from the two wheel handlers so the one invariant that makes wheel
// zoom feel right — **the point under the cursor stays under the cursor** — is
// provable in a test instead of guarded by a one-off browser script. The two
// views solve it in different coordinate systems (the plate view pans a
// clamped centre in sheet units; the plan view pans an SVG transform in
// viewBox units), which is exactly why the algebra deserves a home of its own:
// two inline copies is how one gets fixed and the other stays wrong.

/** Wheel gain: pixels of deltaY per e-fold of zoom. */
export const WHEEL_GAIN = 0.0022;
/**
 * Pinch gain. A trackpad pinch arrives as ctrl+wheel with fine deltas, so it
 * gets more gain per pixel or pinching would feel like wading.
 */
export const PINCH_GAIN = 0.01;

/**
 * The zoom factor for one wheel event. deltaMode 1 is lines (Firefox), scaled
 * to roughly match pixels. Negative deltaY (scroll up / pinch out) zooms in.
 */
export function wheelFactor(deltaY: number, deltaMode: number, ctrlKey: boolean): number {
  const dy = deltaMode === 1 ? deltaY * 20 : deltaY;
  return Math.exp(-dy * (ctrlKey ? PINCH_GAIN : WHEEL_GAIN));
}

/** Zoom is clamped to [1, max]: never smaller than fitted, never past `max`. */
export function clampZoom(z: number, max: number): number {
  return Math.min(max, Math.max(1, z));
}

/**
 * Plan view (SVG `translate(pan) scale(zoom)`): the new pan that keeps the
 * viewBox point under the cursor fixed while zoom changes to `zNew`.
 * `cursor` is in viewBox units.
 */
export function planZoomAt(
  cam: { zoom: number; pan: { x: number; y: number } },
  cursor: { x: number; y: number },
  zNew: number,
): { x: number; y: number } {
  const px0 = (cursor.x - cam.pan.x) / cam.zoom;
  const py0 = (cursor.y - cam.pan.y) / cam.zoom;
  return { x: cursor.x - px0 * zNew, y: cursor.y - py0 * zNew };
}

/** The plate view's camera as the wheel handler reads it mid-gesture. */
export interface SheetCamera {
  /** Current zoom. */
  z: number;
  /** Current (clamped) viewport centre, sheet units. */
  centre: { x: number; y: number };
  /** Viewport width and height, sheet units. */
  vw: number;
  vh: number;
  /** Sheet units per CSS pixel at the current zoom. */
  u: number;
  /** Scale that fits the sheet's width into the box at zoom 1. */
  fit: number;
  /** The box's natural (fit) height in CSS pixels. */
  naturalH: number;
  /** Box width, CSS pixels. */
  boxW: number;
  /** Box height ceiling, CSS pixels. */
  maxH: number;
  /** Current pan offset from the derived centre, sheet units. */
  pan: { x: number; y: number };
}

/** The plate box's height at a given zoom — grows with zoom up to the ceiling. */
export function sheetBoxHeight(cam: SheetCamera, zNew: number): number {
  return Math.min(cam.maxH, Math.max(150, cam.naturalH * zNew));
}

/**
 * Plate view: the new pan that keeps the sheet point under the cursor fixed
 * while zoom changes to `zNew`. `px`/`py` are the cursor in CSS pixels from
 * the box's top-left. Returned as a pan offset from the *current* centre, so
 * the view's existing clamp still governs where the camera may actually go.
 */
export function sheetZoomAt(cam: SheetCamera, px: number, py: number, zNew: number): {
  x: number;
  y: number;
} {
  // The sheet point under the cursor now…
  const sheetX0 = cam.centre.x - cam.vw / 2 + px * cam.u;
  const sheetY0 = cam.centre.y - cam.vh / 2 + py * cam.u;
  // …stays under the cursor after the zoom: solve for the new centre.
  const scaleN = cam.fit * zNew;
  const boxHN = sheetBoxHeight(cam, zNew);
  const cxN = sheetX0 + cam.boxW / scaleN / 2 - px / scaleN;
  const cyN = sheetY0 + boxHN / scaleN / 2 - py / scaleN;
  return {
    x: cam.pan.x + (cxN - cam.centre.x),
    y: cam.pan.y + (cyN - cam.centre.y),
  };
}
