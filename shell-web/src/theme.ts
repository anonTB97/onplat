import type { DecisionState } from "./api";

// One palette for authorization state, shared by every surface, so a colour
// means exactly one thing across the product.
export const STATE_STYLE: Record<DecisionState, { fg: string; bg: string; border: string }> = {
  ALLOW: { fg: "#22c55e", bg: "rgba(34,197,94,0.10)", border: "rgba(34,197,94,0.45)" },
  WARN: { fg: "#f59e0b", bg: "rgba(245,158,11,0.12)", border: "rgba(245,158,11,0.50)" },
  SUSPEND: { fg: "#c4b5fd", bg: "rgba(167,139,250,0.14)", border: "rgba(167,139,250,0.55)" },
  BLOCK: { fg: "#f87171", bg: "rgba(220,38,38,0.14)", border: "rgba(220,38,38,0.55)" },
};

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
