import type { DecisionState, ReadinessState } from "./api";
import { fmtStamp } from "./clock";

// One palette for authorization state, shared by every surface, so a colour
// means exactly one thing across the product.
//
// `label` is the word a deckplate reader says; `code` is the engine's own
// token, kept as a secondary mark so the trace and the API still agree. WARN
// permits work — its label has to say so, because amber on a plate reads as a
// hold to anyone who has not been told otherwise.
export const STATE_STYLE: Record<
  DecisionState,
  { fg: string; bg: string; border: string; label: string; gloss: string }
> = {
  ALLOW: {
    fg: "#22c55e", bg: "rgba(34,197,94,0.10)", border: "rgba(34,197,94,0.45)",
    label: "OPEN", gloss: "work may proceed",
  },
  WARN: {
    fg: "#f59e0b", bg: "rgba(245,158,11,0.12)", border: "rgba(245,158,11,0.50)",
    label: "OPEN · CONDITIONS", gloss: "work may proceed with the boundary posted — no ignition across it",
  },
  SUSPEND: {
    fg: "#c4b5fd", bg: "rgba(167,139,250,0.14)", border: "rgba(167,139,250,0.55)",
    label: "SECURED", gloss: "held until the condition clears — on a clock, or on verification",
  },
  BLOCK: {
    fg: "#f87171", bg: "rgba(220,38,38,0.14)", border: "rgba(220,38,38,0.55)",
    label: "NO ENTRY", gloss: "refused outright for this work until the hazard is cleared",
  },
};

/** The four states in the order a legend reads them: least to most restrictive. */
export const STATE_ORDER: DecisionState[] = ["ALLOW", "WARN", "SUSPEND", "BLOCK"];

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
  /** Inset canvases — the wells drawings and boards sit in. */
  well: "#0e0f13",
  /** Active-control fill: a chip that is ON, a row that is OPEN. */
  raised: "#20222b",
  line: "#2b2d36",
  /** Row separators inside tables — quieter than a panel border. */
  hairline: "#191a1f",
  rail: "linear-gradient(180deg,#0f2238 0%,#0b1830 100%)",
  text: "#f2f3f6",
  /** Emphasised secondary text — the bold half of a stat sentence. */
  bright: "#ccd1da",
  dim: "#94a3b8",
  /** De-emphasised annotations: rulers, provenance, counts of nothing. */
  subtle: "#6e7480",
  /** The faintest legible text — watermark-grade labels. */
  faint: "#4b5060",
  accent: "#3D6BFF",
  ok: "#22c55e",
  warn: "#f59e0b",
  danger: "#f87171",
  /** Danger's soft foreground — badge text on a translucent red fill. */
  dangerSoft: "#fca5a5",
};

/* --------------------------------------------------------------- primitives */
// The controls a user touches on every board, defined once. A chip that
// changes padding, radius or font size as the reader moves between adjacent
// modules reads as a different product per screen — these exist so
// consistency is the default rather than a copy-paste discipline.

/** A selectable filter/toggle chip. One geometry, one active treatment. */
export const chipStyle = (active: boolean): React.CSSProperties => ({
  padding: "3px 9px",
  borderRadius: 5,
  cursor: "pointer",
  font: "inherit",
  fontSize: 11,
  background: active ? C.raised : "transparent",
  color: active ? C.text : C.dim,
  border: `1px solid ${active ? C.accent : C.line}`,
});

/** A static state badge — ALL-CAPS, coloured by what it claims. */
export const badgeStyle = (tone: { fg: string; bg: string; border: string }): React.CSSProperties => ({
  fontSize: 9.5,
  fontWeight: 700,
  letterSpacing: 0.4,
  padding: "2px 7px",
  borderRadius: 4,
  color: tone.fg,
  background: tone.bg,
  border: `1px solid ${tone.border}`,
});

/** A square icon button — zoom, reset, close. */
export const iconBtnStyle: React.CSSProperties = {
  width: 26,
  height: 24,
  borderRadius: 5,
  cursor: "pointer",
  background: "transparent",
  color: C.dim,
  border: `1px solid ${C.line}`,
  font: "inherit",
  fontSize: 9,
  lineHeight: 1,
  padding: 0,
};

/** Table header cell, shared by every board. */
export const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 10px",
  fontSize: 10,
  letterSpacing: 0.6,
  textTransform: "uppercase",
  color: C.dim,
  borderBottom: `1px solid ${C.line}`,
  whiteSpace: "nowrap",
};

/** Table data cell, shared by every board. */
export const tdStyle: React.CSSProperties = {
  padding: "7px 10px",
  fontSize: 12.5,
  borderBottom: `1px solid ${C.hairline}`,
  verticalAlign: "top",
};

/**
 * Activity status, one palette for every surface: `fg` for text and chips,
 * `fill` for solid shapes like Gantt bars — linked here so they cannot drift.
 */
export const ACTIVITY_STATUS: Record<
  "not_started" | "in_progress" | "complete",
  { fg: string; fill: string }
> = {
  not_started: { fg: "#94a3b8", fill: "#475569" },
  in_progress: { fg: "#3D6BFF", fill: "#3D6BFF" },
  complete: { fg: "#22c55e", fill: "#1f7a44" },
};

/** Man-hours, grouped — these numbers are read aloud in a production meeting. */
export const mh = (n: number): string => `${n.toLocaleString()} MH`;

/** One colour convention for door messages: ✓ green, ⏳ amber, anything else red. */
export const msgColor = (m: string): string =>
  m.startsWith("✓") ? C.ok : m.startsWith("⏳") ? C.warn : C.danger;

/** An error, without the "Error:" scaffolding — copy a person reads. */
export const errText = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/** The commit button of a staged flow — one shape for every Confirm. */
export const commitBtnStyle: React.CSSProperties = {
  font: "inherit",
  fontSize: 11.5,
  cursor: "pointer",
  padding: "3px 10px",
  borderRadius: 6,
  color: C.text,
  background: C.raised,
  border: `1px solid ${C.accent}`,
};

/** A hold time, or an honest statement that there is no clock on it. The
 *  time itself is `clock.ts`'s record-grade stamp — the yard's wall clock
 *  with its offset, or Z under the UTC default. */
export const fmtClear = (ms: number | null): string =>
  ms === null ? "on verification, not on a clock" : fmtStamp(ms);

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

/** A trade's colour, same golden-angle discipline as zones but darker and
 *  less saturated — trade fills paint whole Gantt bars, and a bar field at
 *  62% lightness would shout down every finding drawn over it. */
export function tradeColour(trade: string): string {
  let h = 0;
  for (const ch of trade) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${Math.round((h * 137.508) % 360)} 42% 46%)`;
}
