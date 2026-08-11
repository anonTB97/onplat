import type { DecisionState, ReadinessState } from "./api";

// One palette for authorization state, shared by every surface, so a colour
// means exactly one thing across the product.
export const STATE_STYLE: Record<DecisionState, { fg: string; bg: string; border: string }> = {
  ALLOW: { fg: "#22c55e", bg: "rgba(34,197,94,0.10)", border: "rgba(34,197,94,0.45)" },
  WARN: { fg: "#f59e0b", bg: "rgba(245,158,11,0.12)", border: "rgba(245,158,11,0.50)" },
  SUSPEND: { fg: "#c4b5fd", bg: "rgba(167,139,250,0.14)", border: "rgba(167,139,250,0.55)" },
  BLOCK: { fg: "#f87171", bg: "rgba(220,38,38,0.14)", border: "rgba(220,38,38,0.55)" },
};

// Readiness has its own palette, kept distinct from authorization on purpose.
// A space can be SUSPEND (authorization) and still cost nothing today because
// no work is booked in it — colouring both with the same swatch would invite
// exactly the conflation wadl-plan's readiness module exists to prevent.
export const READINESS_STYLE: Record<
  ReadinessState,
  { fg: string; bg: string; border: string; label: string; gloss: string }
> = {
  held: {
    fg: "#f87171",
    bg: "rgba(220,38,38,0.13)",
    border: "rgba(220,38,38,0.5)",
    label: "HELD",
    gloss: "work booked, authorization refused — crews standing by",
  },
  go: {
    fg: "#22c55e",
    bg: "rgba(34,197,94,0.10)",
    border: "rgba(34,197,94,0.45)",
    label: "GO",
    gloss: "work booked and authorized",
  },
  idle: {
    fg: "#94a3b8",
    bg: "rgba(148,163,184,0.09)",
    border: "rgba(148,163,184,0.35)",
    label: "IDLE",
    gloss: "authorized, nothing booked — spare capacity",
  },
  latent: {
    fg: "#6e7480",
    bg: "rgba(110,116,128,0.10)",
    border: "rgba(110,116,128,0.35)",
    label: "LATENT",
    gloss: "refused, nothing booked — costs nothing today, do not plan into it",
  },
};

/**
 * The readiness overlay's buckets — the prototype's GO / WAIT / STOP.
 *
 * WAIT and STOP are both "held", and the difference between them is the most
 * actionable thing on the screen: a hold with an `earliest_clear` timestamp
 * releases itself on a clock, so a planner can sequence around it. A hold with
 * no clock releases only when a named authority verifies the space, so somebody
 * has to be sent. Collapsing the two into one red would hide which of those two
 * completely different jobs the day actually needs.
 */
export type OverlayBucket = "go" | "wait" | "stop" | "none";

export const OVERLAY_STYLE: Record<
  OverlayBucket,
  { fg: string; bg: string; border: string; label: string; gloss: string }
> = {
  go: {
    fg: "#22c55e",
    bg: "rgba(34,197,94,0.12)",
    border: "rgba(34,197,94,0.5)",
    label: "GO",
    gloss: "ready to work now",
  },
  wait: {
    fg: "#f59e0b",
    bg: "rgba(245,158,11,0.13)",
    border: "rgba(245,158,11,0.55)",
    label: "WAIT",
    gloss: "held, but it clears on a clock — sequence around it",
  },
  stop: {
    fg: "#dc2626",
    bg: "rgba(220,38,38,0.14)",
    border: "rgba(220,38,38,0.55)",
    label: "STOP",
    gloss: "held until an authority verifies the space — someone has to go",
  },
  none: {
    fg: "#6e7480",
    bg: "rgba(110,116,128,0.10)",
    border: "rgba(110,116,128,0.4)",
    label: "NO WORK",
    gloss: "nothing booked here",
  },
};

/** Buckets a served row for the overlay. Presentational — nothing is derived. */
export function overlayBucket(row: {
  readiness: ReadinessState;
  earliest_clear: number | null;
}): OverlayBucket {
  if (row.readiness === "go") return "go";
  if (row.readiness !== "held") return "none";
  return row.earliest_clear === null ? "stop" : "wait";
}

export const C = {
  bg: "#0b0c0e",
  panel: "#121316",
  line: "#2b2d36",
  rail: "linear-gradient(180deg,#0f2238 0%,#0b1830 100%)",
  text: "#f2f3f6",
  dim: "#94a3b8",
  accent: "#3D6BFF",
  danger: "#f87171",
};

/** Man-hours, grouped — these numbers are read aloud in a production meeting. */
export const mh = (n: number): string => `${n.toLocaleString()} MH`;

/** A hold time, or an honest statement that there is no clock on it. */
export const fmtClear = (ms: number | null): string =>
  ms === null
    ? "on verification, not on a clock"
    : `${new Date(ms).toISOString().replace("T", " ").slice(0, 16)}Z`;

/**
 * A stable colour per zone, hashed from the name rather than indexed from a
 * list: zone shading exists so a reader can check the applied geometry by eye,
 * and a zone that changed colour between decks, views or sessions would defeat
 * the comparison it exists for.
 */
export function zoneColour(zone: string): string {
  let h = 0;
  for (const ch of zone) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  // Golden-angle spread: names one apart (Z4, Z5, Z6…) land ~137° apart on the
  // wheel instead of a few degrees — sibling zones are exactly the ones that
  // sit side by side and must not share a hue.
  return `hsl(${Math.round((h * 137.508) % 360)} 60% 62%)`;
}
