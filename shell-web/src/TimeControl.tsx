// The time dimension.
//
// Every board in this shell used to be a still photograph of *now*. The question
// a supervisor actually asks is "can I get into 4-164-2-Q at 1400", and nothing
// in the product could answer it.
//
// Why this is not one slider. The range asked for — hour to month — is about a
// 700:1 spread in resolution, and a single control spanning it is unusable at
// both ends: a pixel is four hours at the month end, and the month end is five
// hundred screens wide at the hour end. Three audiences are hiding inside that
// one request, each with its own horizon AND its own step:
//
//   mechanic     this shift        hour     can I get in there at 1400?
//   supervisor   this week         day      what frees up before Thursday?
//   planner      the availability  month    where does the work pile up?
//
// So the horizon sets the window and the step together, and the scrubber moves
// inside it. That pairs with the altitude control the Deck Explorer already has:
// personas carry the altitude they open at, and now the horizon too, so a foreman
// lands on the shift and an executive on the availability.
//
// The instant is fed to the API as `?as_of=` and evaluated by the engine, which
// takes the instant as data and reads no clock. Nothing here interpolates a
// state: a scrubbed board is a real decision with a real trace. Interpolating in
// the browser would look identical and be a fabrication, which is why the
// projection is fetched rather than computed.

import { useEffect, useRef } from "react";
import type { AsOf, Window as TimeWindow } from "./api";
import { C } from "./theme";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The four resolutions the work was asked for, each with the step that names it. */
export type Horizon = "shift" | "week" | "month" | "availability";

interface HorizonDef {
  label: string;
  /** The unit the scrubber moves in — this IS the horizon's claim of resolution. */
  step: number;
  /** How wide a window to open, or `null` for the whole availability. */
  span: number | null;
  /** What the step means in words, and who reads at this resolution. */
  gloss: string;
  who: string;
}

export const HORIZONS: Record<Horizon, HorizonDef> = {
  shift: {
    label: "Shift",
    step: HOUR,
    span: 12 * HOUR,
    gloss: "hour by hour",
    who: "Mechanic · can I get in there at 1400?",
  },
  week: {
    label: "Week",
    step: DAY,
    span: 7 * DAY,
    gloss: "day by day",
    who: "Supervisor · what frees up before Thursday?",
  },
  month: {
    label: "Month",
    step: 7 * DAY,
    span: 35 * DAY,
    gloss: "week by week",
    who: "Zone manager · which weeks are over-committed?",
  },
  availability: {
    label: "Availability",
    step: 28 * DAY,
    span: null,
    gloss: "month by month",
    who: "Planner · where does the work pile up?",
  },
};

export const HORIZON_ORDER: Horizon[] = ["shift", "week", "month", "availability"];

/**
 * The scrubbable window for a horizon.
 *
 * Opened with a fifth of its span behind `now`, because a shift that starts at
 * the present moment hides the thing a supervisor most often wants — what has
 * just happened. Then clamped into the availability, sliding rather than
 * truncating so the window keeps its full span near either end. The result is
 * always inside the availability, which is what the API will accept.
 */
export function windowFor(horizon: Horizon, now: number, availability: TimeWindow): TimeWindow {
  const span = HORIZONS[horizon].span;
  if (span === null || span >= availability.end - availability.start) {
    return availability;
  }
  let start = now - span / 5;
  if (start < availability.start) start = availability.start;
  if (start + span > availability.end) start = availability.end - span;
  return { start, end: start + span };
}

/** Snaps an instant to the horizon's step, measured from the window's start. */
function snap(ms: number, w: TimeWindow, step: number): number {
  const offset = Math.round((ms - w.start) / step) * step;
  return Math.min(w.end - 1, Math.max(w.start, w.start + offset));
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * An instant at the resolution the horizon claims.
 *
 * A month-resolution readout that printed minutes would be claiming a precision
 * the step cannot deliver, and a shift-resolution readout without a clock time is
 * useless. Everything is UTC and says so — a yard runs on Zulu and a local
 * rendering would be a different instant to different readers.
 */
export function fmtInstant(ms: number, horizon: Horizon): string {
  const d = new Date(ms);
  const day = `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  if (horizon === "shift") {
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    return `${day} · ${hh}${mm}Z`;
  }
  if (horizon === "availability") return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return day;
}

/** The offset from now, in the horizon's own unit. Signed, so direction is plain. */
export function fmtOffset(ms: number, now: number, horizon: Horizon): string {
  const delta = ms - now;
  if (Math.abs(delta) < HOUR) return "now";
  const sign = delta < 0 ? "−" : "+";
  const abs = Math.abs(delta);
  if (horizon === "shift") return `${sign}${Math.round(abs / HOUR)} h`;
  if (abs < 2 * DAY) return `${sign}${Math.round(abs / HOUR)} h`;
  if (horizon === "availability" && abs >= 28 * DAY) {
    return `${sign}${Math.round(abs / (28 * DAY))} mo`;
  }
  return `${sign}${Math.round(abs / DAY)} d`;
}

/**
 * How far from now counts as "not now".
 *
 * Half a step: inside that the scrubber cannot distinguish the instant from the
 * present, so calling it a projection would put a warning on the live board.
 */
export function isProjection(asOf: AsOf, now: number, horizon: Horizon): boolean {
  return asOf !== null && Math.abs(asOf - now) >= HORIZONS[horizon].step / 2;
}

export function TimeControl({
  now,
  availability,
  horizon,
  onHorizon,
  asOf,
  onAsOf,
  playing,
  onPlaying,
}: {
  now: number;
  /** null when the hull carries no availability dates — then there is nothing to
   *  scrub between, and the control says so instead of inventing bounds. */
  availability: TimeWindow | null;
  horizon: Horizon;
  onHorizon: (h: Horizon) => void;
  asOf: AsOf;
  onAsOf: (at: AsOf) => void;
  playing: boolean;
  onPlaying: (p: boolean) => void;
}) {
  const def = HORIZONS[horizon];
  const w = availability ? windowFor(horizon, now, availability) : null;
  const at = asOf ?? now;
  const projecting = isProjection(asOf, now, horizon);

  // Playback. One step per beat, stopping at the window's end rather than
  // wrapping — a loop would quietly re-run the day and read as live data
  // refreshing. The interval is held in a ref so a re-render mid-play does not
  // stack timers.
  const beat = useRef<number | null>(null);
  useEffect(() => {
    if (!playing || !w) return undefined;
    const id = window.setInterval(() => {
      const next = (asOf ?? now) + def.step;
      if (next >= w.end - 1) {
        onAsOf(w.end - 1);
        onPlaying(false);
      } else {
        onAsOf(next);
      }
    }, 800);
    beat.current = id;
    return () => window.clearInterval(id);
  }, [playing, asOf, now, def.step, w?.end, onAsOf, onPlaying, w]);

  // Changing horizon must leave the instant inside the new window, and re-snap it
  // to the new step. Scrubbing to Thursday at Week and switching to Shift would
  // otherwise leave an instant the shift window cannot represent.
  const pickHorizon = (h: Horizon) => {
    onPlaying(false);
    onHorizon(h);
    if (asOf === null || !availability) return;
    const next = windowFor(h, now, availability);
    onAsOf(snap(Math.min(next.end - 1, Math.max(next.start, asOf)), next, HORIZONS[h].step));
  };

  const chip = (active: boolean): React.CSSProperties => ({
    background: active ? "#20222b" : "transparent",
    border: `1px solid ${active ? C.accent : C.line}`,
    borderRadius: 5,
    padding: "3px 9px",
    font: "inherit",
    fontSize: 11,
    color: active ? C.text : C.dim,
    cursor: "pointer",
    whiteSpace: "nowrap",
  });

  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        alignItems: "center",
        flexWrap: "wrap",
        padding: "7px 16px",
        borderBottom: `1px solid ${projecting ? "rgba(245,158,11,0.45)" : "#191a1f"}`,
        // The one visual cue that the whole app is showing a moment other than
        // now. Deliberately the same amber the WAIT bucket uses for "held on a
        // clock" — both mean "this is about time, not about authorization".
        background: projecting ? "rgba(245,158,11,0.07)" : "transparent",
        fontSize: 11.5,
      }}
    >
      <span
        style={{ fontSize: 10, letterSpacing: 1.1, textTransform: "uppercase", color: C.dim }}
        title="The horizon sets both the window and the step. A single control spanning an hour to a month is unusable at both ends."
      >
        Horizon
      </span>
      <div style={{ display: "flex", gap: 5 }}>
        {HORIZON_ORDER.map((h) => (
          <button
            key={h}
            onClick={() => pickHorizon(h)}
            title={`${HORIZONS[h].gloss} — ${HORIZONS[h].who}`}
            style={chip(h === horizon)}
          >
            {HORIZONS[h].label}
          </button>
        ))}
      </div>

      {w === null ? (
        <span style={{ color: C.dim }}>
          This hull carries no availability dates, so it can only be read as of now.
        </span>
      ) : (
        <>
          <button
            onClick={() => onPlaying(!playing)}
            title="Step through the window one interval at a time"
            aria-label={playing ? "Pause playback" : "Play through the window"}
            style={{ ...chip(playing), width: 26, padding: "3px 0", textAlign: "center" }}
          >
            {playing ? "❙❙" : "▶"}
          </button>

          <input
            type="range"
            min={w.start}
            max={w.end - 1}
            step={def.step}
            value={at}
            aria-label={`Evaluation instant, ${def.gloss}`}
            onChange={(e) => {
              onPlaying(false);
              onAsOf(snap(Number(e.target.value), w, def.step));
            }}
            style={{ flex: 1, minWidth: 180, accentColor: projecting ? "#f59e0b" : C.accent }}
          />

          <span style={{ fontFamily: "monospace", color: projecting ? "#f59e0b" : "#ccd1da" }}>
            {fmtInstant(at, horizon)}
          </span>
          <span style={{ fontFamily: "monospace", color: C.dim, minWidth: 42 }}>
            {fmtOffset(at, now, horizon)}
          </span>

          {projecting ? (
            <span
              title="A projection, not an authorization. The engine evaluated this instant for real, but nothing here grants permission to work."
              style={{
                padding: "2px 8px",
                borderRadius: 4,
                border: "1px solid rgba(245,158,11,0.55)",
                background: "rgba(245,158,11,0.13)",
                color: "#f59e0b",
                fontFamily: "monospace",
                fontWeight: 700,
                fontSize: 10.5,
              }}
            >
              PROJECTION — NOT AN AUTHORIZATION
            </span>
          ) : (
            <span style={{ color: C.dim }} title="Reading the hull as of the server's clock">
              live
            </span>
          )}

          <button
            onClick={() => {
              onPlaying(false);
              onAsOf(null);
            }}
            disabled={asOf === null}
            title="Return to now"
            style={{ ...chip(false), opacity: asOf === null ? 0.4 : 1 }}
          >
            ⟲ Now
          </button>
        </>
      )}
    </div>
  );
}
