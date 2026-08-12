// Zone lanes: the register as a Gantt, one swim lane per zone, one shared
// time axis — the cross-zone view a zone manager actually runs a week from.
// The same board also renders at compartment grain (`grain="compartment"`):
// one lane per space, ordered zone-then-space so neighbours stay neighbours,
// which is the sequence-inside-a-space view a trade supervisor reads. One
// honesty rule separates the grains: a WBS zone hint places work at zone
// grain and nothing finer, so at compartment grain those rows sit in the
// unlocated lane rather than a guessed one.
//
// The organising idea: a zone manager's day starts with three questions —
// what runs in MY zone this week, what of it cannot execute as planned, and
// what is happening in the neighbouring lanes that will arrive in mine. The
// lane gutter answers the first two as numbers (next-7-days activities,
// remaining hours, refusals, spaces the engine holds right now); the shared
// axis answers the third by putting every zone's bars on the same calendar.
//
// Two additions on top of the bars:
//
// * **Logic arrows** — the schedule's dependency edges, drawn from each
//   predecessor's finish to its successor's start. The unremarkable
//   finish-to-start spine stays faint on purpose; a negative lag is drawn red
//   and labelled, because an arrow pointing *backwards in time* is the
//   clearest possible statement of "the successor starts before its
//   predecessor finishes" — legitimate as an overlap, and exactly where
//   cure-window inversions hide.
// * **A time camera** — wheel zooms the axis around the cursor instant, drag
//   pans, both clamped to the availability. Same solved algebra as every
//   other canvas (`windowZoomAt` in camera.ts, unit-tested), because a
//   multi-month availability at day grain does not fit on one screen width.
//
// Milestones ride a key-events lane on top, because an undock date is the one
// thing every zone is actually sequenced around.

import { useEffect, useRef, useState } from "react";
import type { Activity, DeckStateRow, ScheduleEdge } from "./api";
import { wheelFactor, windowPan, windowZoomAt, type TimeWindow } from "./camera";
import { ACTIVITY_STATUS, C, mh, tradeColour, zoneColour } from "./theme";
import type { Window } from "./api";

const W = 1240;
const GUTTER_W = 225;
const PLOT_W = W - GUTTER_W - 8;
const ROW_H = 15;
const AXIS_H = 30;
const EVENTS_H = 26;
const DAY = 86_400_000;
/** The tightest the axis zooms: one day across the plot. */
const MIN_SPAN = DAY;

const STATUS_FILL: Record<Activity["status"], string> = {
  not_started: ACTIVITY_STATUS.not_started.fill,
  in_progress: ACTIVITY_STATUS.in_progress.fill,
  complete: ACTIVITY_STATUS.complete.fill,
};

/** How much of the logic to draw. Inversions never hide behind "off"‑by‑default. */
type LogicMode = "all" | "inversions" | "off";

interface Bar {
  a: Activity;
  start: number;
  end: number;
  level: number;
}

interface Lane {
  /** The lane's key: a zone name at zone grain, a compartment number at
   *  compartment grain, or the honest nowhere-bucket. */
  zone: string;
  bars: Bar[];
  rows: number;
  top: number;
  h: number;
  weekCount: number;
  weekHours: number;
  refused: number;
  heldSpaces: number;
}

/** Where an activity's bar sits, in time and lane coordinates. */
interface BarGeom {
  t0: number;
  t1: number;
  y: number;
}

export function ZoneLanes({
  activities,
  spaces,
  edges,
  asOf,
  grain = "zone",
  altWindows,
  onInspect,
  onOpenSpace,
}: {
  activities: Activity[];
  spaces: DeckStateRow[];
  /** The schedule's dependency logic, at the activity-code grain. */
  edges: ScheduleEdge[];
  /** The instant the register was read at — the "today" line. */
  asOf: number | null;
  /** The lane grain: a lane per zone, or a lane per compartment. */
  grain?: "zone" | "compartment";
  /** Engine-accepted re-sequence windows, by activity code — drawn as ghost
   *  bars so a proposal is visible where the plan is. */
  altWindows?: Map<string, Window>;
  /** When provided, clicking a bar opens the inspector instead of the deck. */
  onInspect?: (a: Activity) => void;
  onOpenSpace: (compartment: string) => void;
}) {
  // The time camera. `null` = the full availability; a window = zoomed in.
  const [view, setView] = useState<TimeWindow | null>(null);
  // At production scale a thousand forward arrows are fog, not logic, so the
  // spine defaults off past a threshold — but only as a DEFAULT: the reader's
  // explicit choice always wins, and inversions are never hidden.
  const [logicChoice, setLogicChoice] = useState<LogicMode | null>(null);
  /** What the bar fill encodes: the reader's choice of colour language. */
  const [colourBy, setColourBy] = useState<"status" | "trade" | "risk" | "grade">("status");
  const [showKey, setShowKey] = useState(false);
  const [showAlts, setShowAlts] = useState(true);
  const logic: LogicMode = logicChoice ?? (edges.length > 800 ? "inversions" : "all");
  const svgRef = useRef<SVGSVGElement | null>(null);
  // The wheel handler is a native non-passive listener (React's is passive, and
  // a wheel that scrolls the page instead of zooming the axis is unusable), so
  // it reads the current window and extent through refs.
  const winRef = useRef<TimeWindow>({ v0: 0, v1: 1 });
  const fullRef = useRef<TimeWindow>({ v0: 0, v1: 1 });
  const drag = useRef<{ x: number; win: TimeWindow; moved: boolean } | null>(null);

  const zoneOf = new Map<string, string>();
  for (const r of spaces) zoneOf.set(r.compartment.compartment_no, r.compartment.zone);
  const hullZones = new Set(zoneOf.values());

  const byCompartment = grain === "compartment";
  /** The honest nowhere-bucket's name, per grain. */
  const NOWHERE = byCompartment ? "unlocated" : "unzoned";

  const dated = activities.filter((a) => !a.is_milestone && a.planned !== null);
  // An unlocated activity whose WBS bucket names a real zone of this hull
  // lands in that zone's lane — a hint at exactly ZONE grain, so the zone
  // board is the one place it can honestly place work. The bar says it is a
  // hint. At compartment grain the hint is too coarse to place anything, so
  // those rows sit in the unlocated lane instead.
  const wbsHint = (a: Activity) =>
    !byCompartment &&
    a.compartment_no === null && a.wbs_area !== null && hullZones.has(a.wbs_area);
  const laneOf = (a: Activity) => {
    if (byCompartment) return a.compartment_no ?? NOWHERE;
    return (
      (a.compartment_no !== null
        ? zoneOf.get(a.compartment_no)
        : wbsHint(a)
          ? (a.wbs_area ?? undefined)
          : undefined) ?? NOWHERE
    );
  };

  const milestones = activities.filter((a) => a.is_milestone && a.planned !== null);
  const allWindows = [...dated, ...milestones].map((a) => a.planned).filter((w) => w !== null);
  // Every hook is called by now, so the empty return is legal again.
  if (allWindows.length === 0) {
    return <p style={{ color: C.dim, fontSize: 12.5 }}>Nothing dated in the register.</p>;
  }
  const t0 = Math.min(...allWindows.map((w) => w.start)) - 2 * DAY;
  const t1 = Math.max(...allWindows.map((w) => w.end)) + 2 * DAY;
  const full: TimeWindow = { v0: t0, v1: t1 };
  const win = view ?? full;
  const span = win.v1 - win.v0;
  winRef.current = win;
  fullRef.current = full;

  const x = (t: number) => GUTTER_W + ((t - win.v0) / span) * PLOT_W;
  const now = asOf ?? t0;
  const weekEnd = now + 7 * DAY;

  // Build lanes: zones in hull order (name-sorted works for Z2..Z7) — or, at
  // compartment grain, spaces ordered zone-then-space so a zone's compartments
  // stay adjacent — then the honest bucket for work the register cannot place.
  // Levels are stacked from the FULL register, not the visible slice, so a bar
  // keeps its row while the camera moves — a bar that jumps lanes mid-zoom
  // would break the reader's fix on it.
  const zoneNames = [...new Set(dated.map(laneOf))].sort((a, b) => {
    if (a === NOWHERE) return 1;
    if (b === NOWHERE) return -1;
    if (byCompartment) {
      const za = zoneOf.get(a) ?? "~";
      const zb = zoneOf.get(b) ?? "~";
      if (za !== zb) return za.localeCompare(zb);
    }
    return a.localeCompare(b);
  });
  let top = AXIS_H + EVENTS_H;
  const lanes: Lane[] = zoneNames.map((zone) => {
    const mine = dated
      .filter((a) => laneOf(a) === zone)
      .sort((a, b) => (a.planned?.start ?? 0) - (b.planned?.start ?? 0) || a.code.localeCompare(b.code));
    // Level-stack by time overlap so concurrent work reads as parallel rows.
    const levelEnds: number[] = [];
    const bars: Bar[] = mine.map((a) => {
      const w = a.planned;
      const start = w?.start ?? 0;
      const end = w?.end ?? 0;
      let level = 0;
      while (level < levelEnds.length && start < (levelEnds[level] ?? 0)) level += 1;
      levelEnds[level] = end;
      return { a, start, end, level };
    });
    const rows = Math.max(1, levelEnds.length);
    const inWeek = mine.filter((a) => (a.planned?.start ?? 0) < weekEnd && (a.planned?.end ?? 0) > now);
    const lane: Lane = {
      zone,
      bars,
      rows,
      top,
      h: rows * ROW_H + 14,
      weekCount: inWeek.length,
      weekHours: inWeek.reduce((s, a) => s + a.remaining_hours, 0),
      refused: mine.filter((a) => a.executability.verdict === "not_executable").length,
      heldSpaces: spaces.filter(
        (r) =>
          (byCompartment ? r.compartment.compartment_no === zone : r.compartment.zone === zone) &&
          !r.permits_work,
      ).length,
    };
    top += lane.h;
    return lane;
  });
  // A bottom strip: the last lane must not clip at the panel edge, and the
  // as-of label needs ground of its own instead of overlapping lane content.
  const H = top + 22;

  // Where each coded thing sits, for the logic arrows: bars mid-height, key
  // events at their diamond. Held in time units and mapped through x() at
  // draw, so the same geometry survives every camera move.
  const geom = new Map<string, BarGeom>();
  for (const lane of lanes) {
    for (const b of lane.bars) {
      geom.set(b.a.code, { t0: b.start, t1: b.end, y: lane.top + 7 + b.level * ROW_H + (ROW_H - 4) / 2 });
    }
  }
  for (const m of milestones) {
    const t = m.planned?.start ?? 0;
    geom.set(m.code, { t0: t, t1: t, y: AXIS_H + 12 });
  }
  const drawnEdges =
    logic === "off"
      ? []
      : edges.filter(
          (e) => (logic === "all" || e.lag_hours < 0) && geom.has(e.pred_code) && geom.has(e.succ_code),
        );
  const inversions = edges.filter((e) => e.lag_hours < 0).length;

  // The colour language the reader chose. Status is the default; trade paints
  // crews; risk paints the verdicts; grade paints how sure the location is.
  const fillOf = (a: Activity): string => {
    switch (colourBy) {
      case "status":
        return STATUS_FILL[a.status];
      case "trade":
        return a.trade === "—" || a.trade === "" ? "rgba(148,163,184,0.35)" : tradeColour(a.trade);
      case "risk":
        return a.executability.verdict === "not_executable"
          ? "rgba(220,38,38,0.75)"
          : a.executability.verdict === "unassessable"
            ? "rgba(148,163,184,0.35)"
            : "rgba(34,197,94,0.45)";
      case "grade":
        return a.compartment_no === null
          ? "rgba(148,163,184,0.28)"
          : a.compartment_reliability === "high"
            ? "rgba(93,124,183,0.7)"
            : "rgba(245,158,11,0.6)";
    }
  };
  const tradesDrawn = [...new Set(dated.map((a) => a.trade).filter((t) => t !== "—" && t !== ""))].sort();

  // Gridlines follow the camera: weekly across an availability, daily once the
  // window is tight enough for days to be readable columns.
  const step = span < 21 * DAY ? DAY : 7 * DAY;
  const ticks: number[] = [];
  for (let t = Math.ceil(win.v0 / step) * step; t <= win.v1; t += step) ticks.push(t);
  const fmtDay = (ms: number) => new Date(ms).toISOString().slice(5, 10).replace("-", "/");

  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 8, background: C.well, overflowX: "auto" }}>
      <ZoomWheel svgRef={svgRef} winRef={winRef} fullRef={fullRef} setView={setView} />
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", minWidth: 900, display: "block", touchAction: "none", cursor: drag.current ? "grabbing" : undefined }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          drag.current = { x: e.clientX, win, moved: false };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const dxPx = e.clientX - d.x;
          if (Math.abs(dxPx) > 4) d.moved = true;
          const dt = (-dxPx * (W / rect.width) * (d.win.v1 - d.win.v0)) / PLOT_W;
          const next = windowPan(d.win, fullRef.current, dt);
          setView(next.v0 <= fullRef.current.v0 && next.v1 >= fullRef.current.v1 ? null : next);
        }}
        onPointerUp={() => {
          // Cleared on the next tick so a bar's click handler can still see
          // whether this gesture was a pan.
          setTimeout(() => { drag.current = null; }, 0);
        }}
      >
        <defs>
          <clipPath id="lanes-plot">
            <rect x={GUTTER_W} y={0} width={PLOT_W + 8} height={H} />
          </clipPath>
          <marker id="dep-arrow" viewBox="0 0 8 8" refX={7} refY={4} markerWidth={5.5} markerHeight={5.5} orient="auto-start-reverse">
            <path d="M 0 0.5 L 8 4 L 0 7.5 z" fill="#5b6272" />
          </marker>
          <marker id="dep-arrow-neg" viewBox="0 0 8 8" refX={7} refY={4} markerWidth={6} markerHeight={6} orient="auto-start-reverse">
            <path d="M 0 0.5 L 8 4 L 0 7.5 z" fill={C.danger} />
          </marker>
        </defs>

        {/* Lane backgrounds first — they span the gutter too. */}
        {lanes.map((lane, i) => (
          <g key={lane.zone}>
            <rect x={0} y={lane.top} width={W} height={lane.h} fill={i % 2 === 0 ? "#101118" : C.well} />
            <rect
              x={0} y={lane.top} width={5} height={lane.h}
              fill={
                lane.zone === NOWHERE
                  ? C.faint
                  : zoneColour(byCompartment ? (zoneOf.get(lane.zone) ?? "") : lane.zone)
              }
              opacity={0.85}
            />
            {byCompartment ? (
              // The trade supervisor's gutter: the space, its zone, this week —
              // two lines, because a compartment's lane is usually one row tall.
              <>
                <text
                  x={12} y={lane.top + 13}
                  fill={lane.zone === NOWHERE ? C.warn : C.text}
                  fontSize={9.5} fontWeight={700} fontFamily="monospace"
                  onClick={() => {
                    if (lane.zone !== NOWHERE && !drag.current?.moved) onOpenSpace(lane.zone);
                  }}
                  style={lane.zone === NOWHERE ? undefined : { cursor: "pointer" }}
                >
                  <title>
                    {lane.zone === NOWHERE
                      ? "Scheduled work the register cannot place in a space. A WBS hint places at zone grain only — never finer — so it cannot lend a row here."
                      : "Open on the deck plan"}
                  </title>
                  {lane.zone === NOWHERE ? "No space (unlocated)" : lane.zone}
                </text>
                <text
                  x={12} y={lane.top + 25}
                  fill={lane.refused > 0 || lane.heldSpaces > 0 ? "#f87171" : "#8b93a2"}
                  fontSize={8}
                >
                  {[
                    lane.zone === NOWHERE ? null : (zoneOf.get(lane.zone) ?? "no zone"),
                    `7d: ${lane.weekCount} · ${mh(lane.weekHours)}`,
                    lane.refused > 0 ? `${lane.refused} refused` : null,
                    lane.heldSpaces > 0 ? "held now" : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </text>
              </>
            ) : (
              // The zone manager's gutter: this week, in numbers.
              <>
                <text x={12} y={lane.top + 14} fill={C.text} fontSize={10.5} fontWeight={700}>
                  {lane.zone === NOWHERE ? "No zone (unlocated)" : lane.zone}
                </text>
                <text x={12} y={lane.top + 26} fill="#8b93a2" fontSize={8.5}>
                  {`next 7d: ${lane.weekCount} act · ${mh(lane.weekHours)}`}
                </text>
                <text x={12} y={lane.top + 37} fill={lane.refused > 0 || lane.heldSpaces > 0 ? "#f87171" : C.faint} fontSize={8.5}>
                  {`${lane.refused} not executable · ${lane.heldSpaces} spaces held now`}
                </text>
              </>
            )}
          </g>
        ))}
        <text x={8} y={AXIS_H + 12} fill={C.accent} fontSize={9} fontWeight={700} letterSpacing={0.8}>
          KEY EVENTS
        </text>

        {/* Everything that lives on the time axis is clipped to the plot, so
            the camera can push it past the gutter without visual wreckage. */}
        <g clipPath="url(#lanes-plot)">
          {/* Calendar axis: gridlines down the whole board — the shared scale
              that makes cross-zone reading possible at all. */}
          {ticks.map((t) => (
            <g key={t}>
              <line x1={x(t)} y1={AXIS_H - 8} x2={x(t)} y2={H} stroke="#1d1f28" />
              <text x={x(t) + 3} y={AXIS_H - 12} fill={C.subtle} fontSize={8.5} fontFamily="monospace">
                {fmtDay(t)}
              </text>
            </g>
          ))}

          {/* Key events, above every lane: the dates every zone sequences around. */}
          {milestones.map((m) => {
            const t = m.planned?.start ?? 0;
            if (t < win.v0 - span || t > win.v1 + span) return null;
            return (
              <g key={m.activity_id}>
                <title>{`${m.code} — ${m.name} · ${fmtDay(t)}`}</title>
                <path
                  d={`M ${x(t)} ${AXIS_H + 6} l 5 6 l -5 6 l -5 -6 z`}
                  fill={C.accent}
                  opacity={0.9}
                />
                <text x={x(t) + 8} y={AXIS_H + 16} fill={C.accent} fontSize={8} fontFamily="monospace">
                  {m.code}
                </text>
                <line x1={x(t)} y1={AXIS_H + 18} x2={x(t)} y2={H} stroke={C.accent} strokeWidth={0.6} strokeDasharray="2 4" opacity={0.5} />
              </g>
            );
          })}

          {lanes.map((lane) => (
            <g key={lane.zone}>
              {lane.bars.map((b) => {
                if (b.end < win.v0 || b.start > win.v1) return null;
                const doomed = b.a.executability.verdict === "not_executable";
                const bx = x(b.start);
                const bw = Math.max(3, x(b.end) - bx);
                const by = lane.top + 7 + b.level * ROW_H;
                const located = b.a.compartment_no;
                const hinted = wbsHint(b.a);
                return (
                  <g
                    key={b.a.activity_id}
                    onClick={() => {
                      if (drag.current?.moved) return;
                      if (onInspect) onInspect(b.a);
                      else if (located) onOpenSpace(located);
                    }}
                    style={{ cursor: onInspect ?? located ? "pointer" : "default" }}
                  >
                    <title>
                      {`${b.a.code} — ${b.a.name}\n${b.a.trade} · ${located ? `${located}${b.a.compartment_reliability !== "high" ? " (≈ read from the task name, not authored)" : ""}` : hinted ? `not located · in this lane per its WBS bucket (${b.a.wbs_area}) — zone grain, nothing finer` : "not located"} · ${fmtDay(b.start)} → ${fmtDay(b.end)}\n${mh(b.a.remaining_hours)} remaining${doomed ? "\nNOT EXECUTABLE AS PLANNED — click for the options" : ""}`}
                    </title>
                    <rect
                      x={bx} y={by} width={bw} height={ROW_H - 4} rx={2}
                      fill={fillOf(b.a)}
                      opacity={0.92}
                      stroke={doomed ? C.danger : hinted ? C.warn : "none"}
                      strokeWidth={doomed ? 1.4 : hinted ? 1 : 0}
                      strokeDasharray={hinted && !doomed ? "3 2" : undefined}
                    />
                    {bw > 46 && (
                      <text x={bx + 4} y={by + ROW_H - 8} fill="#e6e9ef" fontSize={7.5} fontFamily="monospace">
                        {b.a.code}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          ))}

          {/* Engine-accepted re-sequence proposals, as ghosts: the same bar,
              dashed, where the rules WOULD permit it — a proposal drawn where
              the plan is, never a change. */}
          {showAlts && altWindows && [...altWindows.entries()].map(([code, w]) => {
            const g = geom.get(code);
            if (!g) return null;
            if (w.end < win.v0 || w.start > win.v1) return null;
            const gx = x(w.start);
            const gw = Math.max(3, x(w.end) - gx);
            const gy = g.y - (ROW_H - 4) / 2;
            const ox = x(g.t1);
            return (
              <g key={`alt-${code}`} pointerEvents="none">
                <title>{`${code} — proposed viable window (engine-accepted): ${fmtDay(w.start)} → ${fmtDay(w.end)}`}</title>
                {ox < gx && (
                  <line x1={ox} y1={g.y} x2={gx} y2={g.y} stroke={C.ok} strokeWidth={0.8} strokeDasharray="2 3" opacity={0.6} />
                )}
                <rect
                  x={gx} y={gy} width={gw} height={ROW_H - 4} rx={2}
                  fill="rgba(34,197,94,0.10)"
                  stroke={C.ok}
                  strokeWidth={1}
                  strokeDasharray="4 3"
                />
              </g>
            );
          })}

          {/* The schedule's logic, drawn over the bars it connects: each arrow
              runs predecessor-finish → successor-start. Forward arrows stay
              faint — they are the spine, not a finding. A negative lag points
              backwards in time, and is drawn like it. */}
          {drawnEdges.map((e) => {
            const p = geom.get(e.pred_code);
            const s = geom.get(e.succ_code);
            if (!p || !s) return null;
            if (Math.max(p.t1, s.t0) < win.v0 || Math.min(p.t1, s.t0) > win.v1) return null;
            const px = x(p.t1);
            const sx = x(s.t0);
            const neg = e.lag_hours < 0;
            const reach = Math.max(14, Math.min(40, Math.abs(sx - px) / 2 + 10));
            const key = `${e.pred_code}->${e.succ_code}`;
            return (
              <g key={key}>
                <title>{`${e.pred_code} → ${e.succ_code} · ${e.kind} ${e.lag_hours >= 0 ? "+" : ""}${e.lag_hours}h${neg ? "\nSuccessor starts before its predecessor finishes." : ""}`}</title>
                <path
                  d={`M ${px} ${p.y} C ${px + reach} ${p.y}, ${sx - reach} ${s.y}, ${sx} ${s.y}`}
                  fill="none"
                  stroke={neg ? C.danger : "#5b6272"}
                  strokeWidth={neg ? 1.5 : 0.8}
                  opacity={neg ? 0.95 : 0.4}
                  markerEnd={neg ? "url(#dep-arrow-neg)" : "url(#dep-arrow)"}
                />
                {neg && (
                  <text
                    x={(px + sx) / 2}
                    y={(p.y + s.y) / 2 - 4}
                    fill={C.danger}
                    fontSize={8.5}
                    fontWeight={700}
                    fontFamily="monospace"
                    textAnchor="middle"
                  >
                    {`${e.lag_hours}h`}
                  </text>
                )}
              </g>
            );
          })}

          {/* The as-of line: everything left of it is history, right is plan. */}
          {asOf !== null && now >= win.v0 && now <= win.v1 && (
            <g>
              <line x1={x(now)} y1={AXIS_H - 8} x2={x(now)} y2={H} stroke="#f87171" strokeWidth={1.2} strokeDasharray="5 3" />
              <text x={x(now) + 4} y={H - 6} fill="#f87171" fontSize={8.5}>
                as of {fmtDay(now)}
              </text>
            </g>
          )}
        </g>
      </svg>

      {showKey && (
        <div style={{ borderTop: `1px solid ${C.line}`, padding: "9px 12px", display: "grid", gap: "5px 22px", gridTemplateColumns: "repeat(auto-fit,minmax(330px,1fr))", fontSize: 11, color: C.text, background: "#101118" }}>
          {[
            [<svg key="k1" width={26} height={10}><rect x={1} y={1} width={24} height={8} rx={2} fill={STATUS_FILL.in_progress} /></svg>,
             "A bar is one activity, in its planned window. Fill = the colour language you pick below (status, trade, risk or location grade)."],
            [<svg key="k2" width={26} height={10}><rect x={1} y={1} width={24} height={8} rx={2} fill={STATUS_FILL.not_started} stroke={C.danger} strokeWidth={1.5} /></svg>,
             "Red outline: NOT EXECUTABLE as planned — its space refuses work somewhere inside the window. Click the bar for evidence, the suggested alternative and the space's options."],
            [<svg key="k3" width={26} height={10}><rect x={1} y={1} width={24} height={8} rx={2} fill={STATUS_FILL.not_started} stroke={C.warn} strokeWidth={1} strokeDasharray="3 2" /></svg>,
             "Amber dashed: unlocated work placed by its WBS zone hint — zone grain, nothing finer."],
            [<svg key="k4" width={26} height={10}><rect x={1} y={1} width={24} height={8} rx={2} fill="rgba(34,197,94,0.1)" stroke={C.ok} strokeWidth={1} strokeDasharray="4 3" /></svg>,
             "Green dashed ghost: the engine's re-sequence proposal — the first window the rules would permit. A proposal, never a change."],
            [<svg key="k5" width={26} height={10}><path d="M 1 8 C 8 8 18 2 25 2" fill="none" stroke="#5b6272" strokeWidth={1} /></svg>,
             "Grey arrow: finish-to-start logic from the schedule's own edges — why the dates are where they are."],
            [<svg key="k6" width={26} height={10}><path d="M 25 8 C 18 8 8 2 1 2" fill="none" stroke={C.danger} strokeWidth={1.5} /></svg>,
             "Red arrow: a NEGATIVE lag — the successor starts before its predecessor finishes. Legitimate as an overlap; exactly where cure-window inversions hide."],
            [<svg key="k7" width={26} height={10}><path d="M 13 0 l 5 5 l -5 5 l -5 -5 z" fill={C.accent} /></svg>,
             "Diamond: a key event (milestone) — the dates every zone is sequenced around."],
            [<svg key="k8" width={26} height={10}><line x1={13} y1={0} x2={13} y2={10} stroke="#f87171" strokeWidth={1.2} strokeDasharray="4 2" /></svg>,
             "Red dashed vertical: the instant on the time control. Left of it is history, right is plan. It marks — it never filters."],
          ].map(([glyph, text], i) => (
            <span key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <span style={{ flexShrink: 0, paddingTop: 2 }}>{glyph}</span>
              <span style={{ color: C.dim }}>{text}</span>
            </span>
          ))}
          <span style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <span style={{ flexShrink: 0, fontSize: 10, color: C.subtle, paddingTop: 1 }}>gutter</span>
            <span style={{ color: C.dim }}>
              Each lane&apos;s left numbers: the coming 7 days&apos; activity count and man-hours, then refusals and spaces held right now — a zone manager&apos;s morning, in two lines.
            </span>
          </span>
        </div>
      )}

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center", padding: "7px 11px", borderTop: `1px solid ${C.line}`, fontSize: 10.5, color: C.dim }}>
        <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <span style={{ fontSize: 8.5, letterSpacing: 0.8, textTransform: "uppercase", color: C.subtle }}>Colour</span>
          {(["status", "trade", "risk", "grade"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setColourBy(m)}
              title={
                m === "status" ? "Bar fill = activity status" :
                m === "trade" ? "Bar fill = the assigned trade — who is where, when" :
                m === "risk" ? "Bar fill = the executability verdict — the trouble map" :
                "Bar fill = location grade — how sure the register is about where"
              }
              style={{
                font: "inherit", fontSize: 10, padding: "1px 7px", borderRadius: 5, cursor: "pointer",
                background: colourBy === m ? C.raised : "transparent",
                color: colourBy === m ? C.text : C.dim,
                border: `1px solid ${colourBy === m ? C.accent : C.line}`,
              }}
            >
              {m}
            </button>
          ))}
        </span>
        <span style={{ width: 1, height: 14, background: C.line }} />
        {colourBy === "status" && (
          <>
            <span><span style={{ color: STATUS_FILL.in_progress }}>■</span> in progress</span>
            <span><span style={{ color: STATUS_FILL.not_started }}>■</span> not started</span>
            <span><span style={{ color: STATUS_FILL.complete }}>■</span> complete</span>
          </>
        )}
        {colourBy === "trade" && tradesDrawn.slice(0, 8).map((t) => (
          <span key={t}><span style={{ color: tradeColour(t) }}>■</span> {t}</span>
        ))}
        {colourBy === "trade" && tradesDrawn.length > 8 && <span>+{tradesDrawn.length - 8} more</span>}
        {colourBy === "risk" && (
          <>
            <span><span style={{ color: "rgba(34,197,94,0.7)" }}>■</span> executable as planned</span>
            <span><span style={{ color: C.danger }}>■</span> refused in its window</span>
            <span><span style={{ color: "rgba(148,163,184,0.6)" }}>■</span> unassessable</span>
          </>
        )}
        {colourBy === "grade" && (
          <>
            <span><span style={{ color: "rgb(93,124,183)" }}>■</span> location authored</span>
            <span><span style={{ color: C.warn }}>■</span> ≈ from the task name</span>
            <span><span style={{ color: "rgba(148,163,184,0.6)" }}>■</span> unlocated</span>
          </>
        )}
        <span><span style={{ color: C.danger }}>▭</span> not executable as planned</span>
        {!byCompartment && (
          <span title="Unlocated work whose WBS bucket names this zone — placed at zone grain, nothing finer.">
            <span style={{ color: C.warn }}>▤</span> placed by WBS hint
          </span>
        )}
        <span><span style={{ color: "#5b6272" }}>⟶</span> finish-to-start</span>
        <span title="The successor starts before its predecessor finishes — an overlap written into the schedule's own logic.">
          <span style={{ color: C.danger }}>⟶</span> negative lag{inversions > 0 ? ` (${inversions})` : ""}
        </span>
        <span><span style={{ color: C.accent }}>◆</span> key event</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          {altWindows && altWindows.size > 0 && (
            <button
              onClick={() => setShowAlts((v) => !v)}
              title="Engine-accepted re-sequence windows, drawn as dashed ghosts beside the plan. Proposals only — P6 decides."
              style={{
                font: "inherit", fontSize: 10, padding: "2px 8px", borderRadius: 5, cursor: "pointer",
                background: showAlts ? C.raised : "transparent",
                color: showAlts ? C.ok : C.dim,
                border: `1px solid ${showAlts ? "rgba(34,197,94,0.5)" : C.line}`,
              }}
            >
              ▻ {altWindows.size} alternatives
            </button>
          )}
          <button
            onClick={() => setShowKey((v) => !v)}
            title="What am I looking at? Every mark on this board, named."
            style={{
              font: "inherit", fontSize: 10, padding: "2px 8px", borderRadius: 5, cursor: "pointer",
              background: showKey ? C.raised : "transparent",
              color: showKey ? C.text : C.dim,
              border: `1px solid ${showKey ? C.accent : C.line}`,
            }}
          >
            ？ Key
          </button>
          <span title="Wheel zooms the time axis around the cursor · drag pans">wheel zooms · drag pans</span>
          {([["−", 1 / 1.4, "Zoom out (or scroll on the board)"], ["+", 1.4, "Zoom in (or scroll on the board)"]] as const).map(
            ([glyph, factor, hint]) => (
              <button
                key={glyph}
                onClick={() => {
                  const mid = (win.v0 + win.v1) / 2;
                  const next = windowZoomAt(win, full, mid, factor, MIN_SPAN);
                  setView(next.v0 <= full.v0 && next.v1 >= full.v1 ? null : next);
                }}
                title={hint}
                style={{
                  font: "inherit", fontSize: 10, width: 22, padding: "2px 0", borderRadius: 5, cursor: "pointer",
                  background: "transparent", color: C.dim, border: `1px solid ${C.line}`,
                }}
              >
                {glyph}
              </button>
            ),
          )}
          {(["all", "inversions", "off"] as LogicMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setLogicChoice(m)}
              title={
                m === "all" ? "Every dependency edge" : m === "inversions" ? "Only the negative lags" : "No arrows"
              }
              style={{
                font: "inherit", fontSize: 10, padding: "2px 8px", borderRadius: 5, cursor: "pointer",
                background: logic === m ? C.raised : "transparent",
                color: logic === m ? C.text : C.dim,
                border: `1px solid ${logic === m ? C.accent : C.line}`,
              }}
            >
              {m === "all" ? "Logic: all" : m === "inversions" ? "Inversions only" : "Logic off"}
            </button>
          ))}
          {view !== null && (
            <button
              onClick={() => setView(null)}
              title="Back to the full availability"
              style={{
                font: "inherit", fontSize: 10, padding: "2px 8px", borderRadius: 5, cursor: "pointer",
                background: "transparent", color: C.accent, border: `1px solid ${C.accent}`,
              }}
            >
              ⤢ {fmtDay(win.v0)} → {fmtDay(win.v1)} · reset
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

/**
 * The native wheel listener, as a null-rendering child so `ZoneLanes` can keep
 * its early return above the hook. Non-passive on purpose: a wheel over the
 * board zooms the axis, never scrolls the page.
 */
function ZoomWheel({
  svgRef,
  winRef,
  fullRef,
  setView,
}: {
  svgRef: { current: SVGSVGElement | null };
  winRef: { current: TimeWindow };
  fullRef: { current: TimeWindow };
  setView: (v: TimeWindow | null) => void;
}) {
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const sx = ((e.clientX - rect.left) * W) / rect.width;
      const win = winRef.current;
      const full = fullRef.current;
      const t = win.v0 + (Math.max(0, sx - GUTTER_W) / PLOT_W) * (win.v1 - win.v0);
      const next = windowZoomAt(win, full, t, wheelFactor(e.deltaY, e.deltaMode, e.ctrlKey), MIN_SPAN);
      setView(next.v0 <= full.v0 && next.v1 >= full.v1 ? null : next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [svgRef, winRef, fullRef, setView]);
  return null;
}
