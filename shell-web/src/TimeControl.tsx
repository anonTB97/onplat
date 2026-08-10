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

import { useEffect } from "react";
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
 * Moves a window's start onto the step grid that runs through `anchor`.
 *
 * This is load-bearing, not tidiness. `<input type="range">` only reaches
 * `min + k*step`, so unless `min` is congruent to `now` modulo the step, **no
 * reachable notch is `now`** — and the nearest one can sit closer than half a
 * step, which is the tolerance `isProjection` uses to decide whether to warn.
 * At the Week horizon that put a reachable instant 9.6 h away inside the "this is
 * live" band: the boards were evaluated 9.6 h out, the coating cascade had flipped
 * BLOCK to ALLOW, and the chrome said `evaluated live`. Aligning the grid means
 * every reachable notch is either exactly `now` or a full step away from it.
 *
 * Shifted forward only, so an aligned window never reaches back outside the
 * availability it was just clamped into.
 */
function alignStart(start: number, anchor: number, step: number): number {
  return anchor - Math.floor((anchor - start) / step) * step;
}

/**
 * The last grid notch strictly inside `w`.
 *
 * The window's exclusive end is almost never on the grid, so clamping to
 * `end - 1` would emit an instant the slider cannot represent — the thumb would
 * snap to the nearest notch and sit somewhere other than the readout it is
 * labelled with. Every instant this control emits is on the grid, top of the
 * window included.
 */
function lastNotch(w: TimeWindow, step: number): number {
  return w.start + Math.floor((w.end - 1 - w.start) / step) * step;
}

/** `at` moved onto the nearest grid notch inside `w`. */
export function clampInto(at: number, w: TimeWindow, step: number): number {
  return Math.min(lastNotch(w, step), Math.max(w.start, at));
}

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
  const { span, step } = HORIZONS[horizon];
  const whole = availability.end - availability.start;
  if (span === null || span >= whole) {
    return { start: alignStart(availability.start, now, step), end: availability.end };
  }
  let start = now - span / 5;
  if (start < availability.start) start = availability.start;
  if (start + span > availability.end) start = availability.end - span;
  return { start: alignStart(start, now, step), end: start + span };
}

/** Snaps an instant to the horizon's step grid, which runs through `now`. */
function snap(ms: number, w: TimeWindow, step: number): number {
  return clampInto(w.start + Math.round((ms - w.start) / step) * step, w, step);
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
  // The instant actually on screen. Not clamped: this is what the boards were
  // evaluated at, and a readout that clamped it would name an instant nobody
  // asked for.
  const at = asOf ?? now;
  const projecting = isProjection(asOf, now, horizon);
  // A hull whose availability has not opened (or has closed) has no notch on
  // `now`. Live still works — no parameter is sent and the server answers from
  // its own clock — but the slider cannot point at the present, so it says so
  // rather than sitting at one end implying it does.
  const nowOutside = w !== null && (now < w.start || now >= w.end);
  // What the slider is allowed to show. `<input type="range">` silently coerces
  // an out-of-range value to a bound, so feeding it `now` on a future
  // availability made the thumb read as an instant it was not at — and playback
  // then stepped from `now`, requesting instants the API refuses with a 422 that
  // surfaced as a bogus "out of scope" on every module.
  const knob = w ? clampInto(at, w, def.step) : at;

  // Playback. One step per beat, stopping at the window's end rather than
  // wrapping — a loop would quietly re-run the day and read as live data
  // refreshing.
  useEffect(() => {
    if (!playing || !w) return undefined;
    const id = window.setInterval(() => {
      // From the knob, never from `at`: starting outside the window would walk
      // the whole run of requests out of range.
      const end = lastNotch(w, def.step);
      const next = clampInto(at, w, def.step) + def.step;
      if (next >= end) {
        onAsOf(end);
        onPlaying(false);
      } else {
        onAsOf(next);
      }
    }, 800);
    return () => window.clearInterval(id);
  }, [playing, at, def.step, onAsOf, onPlaying, w]);

  // Changing horizon must leave the instant inside the new window, and re-snap it
  // to the new step. Scrubbing to Thursday at Week and switching to Shift would
  // otherwise leave an instant the shift window cannot represent.
  const pickHorizon = (h: Horizon) => {
    onPlaying(false);
    onHorizon(h);
    if (asOf === null || !availability) return;
    const next = windowFor(h, now, availability);
    onAsOf(snap(clampInto(asOf, next, HORIZONS[h].step), next, HORIZONS[h].step));
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
            max={lastNotch(w, def.step)}
            step={def.step}
            value={knob}
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

          {nowOutside && asOf === null && (
            <span
              title="Now falls outside this hull's availability, so the scrubber cannot point at the present. The boards are live; scrub to read a date inside the availability."
              style={{ color: C.dim }}
            >
              · now is outside this availability
            </span>
          )}

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
