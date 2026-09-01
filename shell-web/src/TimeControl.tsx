// The time dimension.
//
// Every board in this shell used to be a still photograph of *now*. The question
// a supervisor actually asks is "can I get into 4-164-2-Q at 1400", and nothing
// in the product could answer it.
//
// Two decisions shape this control:
//
// **The floor of resolution is the 4-hour watch block** (`watch.ts`). The finest
// instant a reader can pick is the start of a UTC-aligned block — 00–04Z,
// 04–08Z, … — because that is the lowest level anything on this hull is planned
// at. An hour-grain scrubber claimed a precision no schedule carries.
//
// **Dates are clicked, not scrubbed.** The control is a transport bar —
// « ‹ [calendar date] ▶ ■ t › » — because "show me Thursday" is a discrete
// question. Every gesture moves on ONE grid: the whole availability, notched
// at the horizon's step (`availabilityGrid`). Three audiences share the bar,
// each with their own step:
//
//   mechanic     Day     watch    can I get in there at 1400?
//   supervisor   Week    day      what frees up before Thursday?
//   planner      Availability     where does the work pile up?
//
// Personas carry the horizon they open at, pairing with the altitude control
// the Deck Explorer already has.
//
// The instant is fed to the API as `?as_of=` and evaluated by the engine, which
// takes the instant as data and reads no clock. Nothing here interpolates a
// state: a scrubbed board is a real decision with a real trace. Interpolating in
// the browser would look identical and be a fabrication, which is why the
// projection is fetched rather than computed.

import { useEffect } from "react";
import type { AsOf, Window as TimeWindow } from "./api";
import { C } from "./theme";
import {
  blockLabel,
  blockStart,
  DAY_MS as DAY,
  utcDayStart,
  WATCH_MS,
  watchBlocksOf,
} from "./watch";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** The four resolutions the work was asked for, each with the step that names it. */
export type Horizon = "day" | "week" | "month" | "availability";

interface HorizonDef {
  label: string;
  /** The unit the scrubber moves in — this IS the horizon's claim of resolution. */
  step: number;
  /** How wide a window to open, or `null` for the whole availability. */
  span: number | null;
  /** How far the day clicker's ◀ ▶ move, and what to call that unit. */
  click: { step: number; unit: string };
  /** Within this distance of now, an instant reads as the present (see
   *  `isProjection`). The day horizon's blocks are calendar-aligned, so almost
   *  no block start IS now — a tight tolerance keeps "live" meaning live. */
  liveTolerance: number;
  /** What the step means in words, and who reads at this resolution. */
  gloss: string;
  who: string;
}

export const HORIZONS: Record<Horizon, HorizonDef> = {
  day: {
    label: "Day",
    step: WATCH_MS,
    span: DAY,
    click: { step: DAY, unit: "day" },
    liveTolerance: MIN,
    gloss: "watch by watch — 4-hour blocks, the lowest level of planning",
    who: "Mechanic · can I get in there at 1400?",
  },
  week: {
    label: "Week",
    step: DAY,
    span: 7 * DAY,
    click: { step: DAY, unit: "day" },
    liveTolerance: DAY / 2,
    gloss: "day by day",
    who: "Supervisor · what frees up before Thursday?",
  },
  month: {
    label: "Month",
    step: 7 * DAY,
    span: 35 * DAY,
    click: { step: 7 * DAY, unit: "week" },
    liveTolerance: (7 * DAY) / 2,
    gloss: "week by week",
    who: "Zone manager · which weeks are over-committed?",
  },
  availability: {
    label: "Availability",
    step: 28 * DAY,
    span: null,
    click: { step: 28 * DAY, unit: "month" },
    liveTolerance: 14 * DAY,
    gloss: "month by month",
    who: "Planner · where does the work pile up?",
  },
};

export const HORIZON_ORDER: Horizon[] = ["day", "week", "month", "availability"];

/**
 * Moves a window's start onto the step grid that runs through `anchor`.
 *
 * This is load-bearing, not tidiness. Every instant this control emits is a
 * grid notch, and unless the grid is congruent to its anchor modulo the step,
 * no notch sits on the instants the readout names. At the Week horizon a
 * mis-anchored grid once put an emitted instant 9.6 h inside the "this is
 * live" band: the boards were evaluated 9.6 h out, the coating cascade had
 * flipped BLOCK to ALLOW, and the chrome said `evaluated live`.
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
 * `end - 1` would emit an off-grid instant the readout could not name. Every
 * instant this control emits is on the grid, top of the window included.
 */
function lastNotch(w: TimeWindow, step: number): number {
  return w.start + Math.floor((w.end - 1 - w.start) / step) * step;
}

/** `at` moved onto the nearest grid notch inside `w`. */
export function clampInto(at: number, w: TimeWindow, step: number): number {
  return Math.min(lastNotch(w, step), Math.max(w.start, at));
}

/**
 * The one grid every gesture moves on: the WHOLE availability, notched at the
 * horizon's step.
 *
 * The day grid is anchored to UTC midnight, so its notches ARE the watch
 * blocks — calendar names two readers share. The wider grids run through
 * `now`, so the present is itself a notch and the live band means what it
 * says. There is deliberately no windowing: « must reach the availability's
 * first notch and ▶ its last, whatever the horizon — anchoring a window on
 * `now` is exactly how « once landed on "roughly yesterday" and playback froze
 * against an edge the readout never named.
 */
export function availabilityGrid(
  horizon: Horizon,
  now: number,
  availability: TimeWindow,
): TimeWindow {
  const { step } = HORIZONS[horizon];
  const anchor = horizon === "day" ? utcDayStart(availability.start) : now;
  return { start: alignStart(availability.start, anchor, step), end: availability.end };
}

/** Snaps an instant to the horizon's step grid inside `w`. */
function snap(ms: number, w: TimeWindow, step: number): number {
  return clampInto(w.start + Math.round((ms - w.start) / step) * step, w, step);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * An instant at the resolution the horizon claims.
 *
 * A month-resolution readout that printed minutes would be claiming a precision
 * the step cannot deliver; the day horizon names the watch block, because the
 * block is the resolution. Everything is UTC and says so — a yard runs on Zulu
 * and a local rendering would be a different instant to different readers.
 */
export function fmtInstant(ms: number, horizon: Horizon): string {
  const d = new Date(ms);
  const day = `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  if (horizon === "day") return `${day} · ${blockLabel(ms)}`;
  if (horizon === "availability") return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return day;
}

/** The offset from now, in the horizon's own unit. Signed, so direction is plain. */
export function fmtOffset(ms: number, now: number, horizon: Horizon): string {
  const delta = ms - now;
  if (Math.abs(delta) < HOUR) return "now";
  const sign = delta < 0 ? "−" : "+";
  const abs = Math.abs(delta);
  if (horizon === "day") return `${sign}${Math.round(abs / HOUR)} h`;
  if (abs < 2 * DAY) return `${sign}${Math.round(abs / HOUR)} h`;
  if (horizon === "availability" && abs >= 28 * DAY) {
    return `${sign}${Math.round(abs / (28 * DAY))} mo`;
  }
  return `${sign}${Math.round(abs / DAY)} d`;
}

/**
 * How far from now counts as "not now".
 *
 * Per-horizon: the wide horizons use half a step (inside that the scrubber
 * cannot distinguish the instant from the present), and the day horizon uses a
 * minute — its blocks are calendar names, and calling "08–12Z" live at 0930
 * would put a live badge on an evaluation from ninety minutes ago. The one
 * instant that is genuinely live is the unset one (`asOf === null`), which the
 * block chips emit for the block containing now.
 */
export function isProjection(asOf: AsOf, now: number, horizon: Horizon): boolean {
  return asOf !== null && Math.abs(asOf - now) >= HORIZONS[horizon].liveTolerance;
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
  // The instant actually on screen. Not clamped: this is what the boards were
  // evaluated at, and a readout that clamped it would name an instant nobody
  // asked for.
  const at = asOf ?? now;
  const w = availability ? availabilityGrid(horizon, now, availability) : null;
  const projecting = isProjection(asOf, now, horizon);
  // A hull whose availability has not opened (or has closed) has no notch on
  // `now`. Live still works — no parameter is sent and the server answers from
  // its own clock — but the transport bar cannot land on the present, so it
  // says so rather than implying it can.
  const nowOutside = w !== null && (now < w.start || now >= w.end);

  // Playback: the transport-control contract. ▶ walks one grid notch per beat
  // and keeps going — across days, weeks, whatever the step — until the
  // availability's last notch or ■ stops it. Stopping, never wrapping: a loop
  // would quietly re-run the availability and read as live data refreshing.
  useEffect(() => {
    if (!playing || !w) return undefined;
    const end = lastNotch(w, def.step);
    const id = window.setInterval(() => {
      // From the grid, never from a raw `at`: starting off-grid would walk
      // the whole run of requests off the notches the readout names.
      const next = clampInto(at, w, def.step) + def.step;
      if (next > end) {
        onPlaying(false);
      } else {
        onAsOf(next);
      }
    }, 800);
    return () => window.clearInterval(id);
  }, [playing, at, def.step, onAsOf, onPlaying, w]);

  // Changing horizon must re-snap the instant to the new grid. A Thursday
  // picked at Week and switched to Day would otherwise not be a watch block.
  const pickHorizon = (h: Horizon) => {
    onPlaying(false);
    onHorizon(h);
    if (asOf === null || !availability) return;
    const grid = availabilityGrid(h, now, availability);
    onAsOf(snap(clampInto(asOf, grid, HORIZONS[h].step), grid, HORIZONS[h].step));
  };

  /** Jump to an arbitrary instant, clamped to the availability's grid — the
   *  date picker's and the « » buttons' move. Reaches the whole availability:
   *  « lands on the first notch, » on the last, whatever the horizon. */
  const jump = (ms: number) => {
    if (!w) return;
    onPlaying(false);
    onAsOf(clampInto(ms, w, def.step));
  };

  /** Step one clicking unit — a day at Day and Week, a week at Month, a month
   *  at Availability — staying on the grid. */
  const click = (dir: 1 | -1) => {
    if (!w) return;
    onPlaying(false);
    const base = horizon === "day" ? blockStart(at) : clampInto(at, w, def.step);
    onAsOf(clampInto(base + dir * def.click.step, w, def.step));
  };

  const chip = (active: boolean): React.CSSProperties => ({
    background: active ? C.raised : "transparent",
    border: `1px solid ${active ? C.accent : C.line}`,
    borderRadius: 5,
    padding: "3px 9px",
    font: "inherit",
    fontSize: 11,
    color: active ? C.text : C.dim,
    cursor: "pointer",
    whiteSpace: "nowrap",
  });

  // The six watch blocks of the day on screen, for the day horizon's chip row.
  // A block outside the availability is shown disabled rather than hidden: the
  // day still has six blocks, this hull just isn't in the yard for all of them.
  const blocks = horizon === "day" && availability ? watchBlocksOf(at) : null;

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
        title="The horizon sets both the window and the step. The floor is the 4-hour watch block — the lowest level anything here is planned at."
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
          {/* The stepper toolbar: jump to either end of the availability, step
              one unit, pick a date from the calendar, play/stop, and come back
              to now. The layout is the transport-control idiom a scheduler
              already knows — everything else on this strip annotates it. */}
          <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
            <button
              onClick={() => availability && jump(availability.start)}
              title="Jump to the start of the availability"
              aria-label="Jump to availability start"
              style={{ ...chip(false), padding: "3px 7px", fontFamily: "monospace" }}
            >
              «
            </button>
            <button
              onClick={() => click(-1)}
              title={`Back one ${def.click.unit}`}
              aria-label={`Back one ${def.click.unit}`}
              style={{ ...chip(false), padding: "3px 7px", fontFamily: "monospace" }}
            >
              ‹
            </button>
            <input
              type="date"
              value={new Date(at).toISOString().slice(0, 10)}
              onChange={(e) => {
                const [yy, mm, dd] = e.target.value.split("-").map(Number);
                if (!yy || !mm || !dd) return;
                onPlaying(false);
                // Jump to the picked UTC day, preserving the time within the
                // day — the chosen watch block at Day, the grid slot elsewhere.
                jump(Date.UTC(yy, mm - 1, dd) + (at - utcDayStart(at)));
              }}
              aria-label="Evaluation date"
              title="Pick the date to read the hull at (UTC)"
              style={{
                font: "inherit",
                fontFamily: "monospace",
                fontSize: 11.5,
                color: projecting ? C.warn : C.bright,
                background: "transparent",
                border: `1px solid ${C.line}`,
                borderRadius: 5,
                padding: "2px 6px",
                colorScheme: "dark",
              }}
            />
            <button
              onClick={() => onPlaying(true)}
              disabled={playing}
              title="Play through the window one interval at a time"
              aria-label="Play"
              style={{ ...chip(playing), padding: "3px 7px", opacity: playing ? 0.5 : 1 }}
            >
              ▶
            </button>
            <button
              onClick={() => onPlaying(false)}
              disabled={!playing}
              title="Stop playback"
              aria-label="Stop"
              style={{ ...chip(false), padding: "3px 7px", opacity: playing ? 1 : 0.5 }}
            >
              ■
            </button>
            <button
              onClick={() => {
                onPlaying(false);
                onAsOf(null);
              }}
              disabled={asOf === null}
              title="Back to now — read the hull live"
              aria-label="Back to now"
              style={{
                ...chip(false),
                padding: "3px 8px",
                fontWeight: 700,
                opacity: asOf === null ? 0.5 : 1,
              }}
            >
              t
            </button>
            <button
              onClick={() => click(1)}
              title={`Forward one ${def.click.unit}`}
              aria-label={`Forward one ${def.click.unit}`}
              style={{ ...chip(false), padding: "3px 7px", fontFamily: "monospace" }}
            >
              ›
            </button>
            <button
              onClick={() => availability && jump(availability.end - 1)}
              title="Jump to the end of the availability"
              aria-label="Jump to availability end"
              style={{ ...chip(false), padding: "3px 7px", fontFamily: "monospace" }}
            >
              »
            </button>
          </div>

          <span
            style={{
              fontFamily: "monospace",
              color: projecting ? C.warn : C.bright,
              minWidth: horizon === "day" ? 150 : 84,
            }}
          >
            {fmtInstant(at, horizon)}
          </span>

          {/* The watch blocks: the day horizon's floor of resolution, clickable.
              The block containing now emits live (asOf null) — the present
              watch's truth is the present. */}
          {blocks && availability && (
            <div style={{ display: "flex", gap: 3 }}>
              {blocks.map((b) => {
                const holdsNow = now >= b.start && now < b.start + WATCH_MS;
                const active = at >= b.start && at < b.start + WATCH_MS;
                const outside = b.start >= availability.end || b.start + WATCH_MS <= availability.start;
                return (
                  <button
                    key={b.start}
                    disabled={outside}
                    onClick={() => {
                      onPlaying(false);
                      onAsOf(holdsNow ? null : Math.max(b.start, w.start));
                    }}
                    title={
                      outside
                        ? `${b.label} — outside this availability`
                        : holdsNow
                          ? `${b.label} — the current watch (reads live)`
                          : `Read the hull at ${b.label}`
                    }
                    style={{
                      ...chip(active),
                      padding: "3px 6px",
                      fontFamily: "monospace",
                      fontSize: 10,
                      opacity: outside ? 0.35 : 1,
                      cursor: outside ? "default" : "pointer",
                      borderStyle: holdsNow ? "double" : "solid",
                    }}
                  >
                    {b.label.replace("Z", "")}
                  </button>
                );
              })}
            </div>
          )}

          <span style={{ marginLeft: "auto", fontFamily: "monospace", color: C.dim, minWidth: 42 }}>
            {fmtOffset(at, now, horizon)}
          </span>

          {nowOutside && asOf === null && (
            <span
              title="Now falls outside this hull's availability, so the transport bar cannot land on the present. The boards are live; pick a date inside the availability to read it."
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
                color: C.warn,
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


        </>
      )}
    </div>
  );
}
