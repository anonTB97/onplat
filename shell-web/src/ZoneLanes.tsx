// Zone lanes: the register as a Gantt, one swim lane per zone, one shared
// time axis — the cross-zone view a zone manager actually runs a week from.
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
import { C, mh, zoneColour } from "./theme";

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
  not_started: "#475569",
  in_progress: "#3D6BFF",
  complete: "#1f7a44",
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
  onOpenSpace,
}: {
  activities: Activity[];
  spaces: DeckStateRow[];
  /** The schedule's dependency logic, at the activity-code grain. */
  edges: ScheduleEdge[];
  /** The instant the register was read at — the "today" line. */
  asOf: number | null;
  onOpenSpace: (compartment: string) => void;
}) {
  // The time camera. `null` = the full availability; a window = zoomed in.
  const [view, setView] = useState<TimeWindow | null>(null);
  const [logic, setLogic] = useState<LogicMode>("all");
  const svgRef = useRef<SVGSVGElement | null>(null);
  // The wheel handler is a native non-passive listener (React's is passive, and
  // a wheel that scrolls the page instead of zooming the axis is unusable), so
  // it reads the current window and extent through refs.
  const winRef = useRef<TimeWindow>({ v0: 0, v1: 1 });
  const fullRef = useRef<TimeWindow>({ v0: 0, v1: 1 });
  const drag = useRef<{ x: number; win: TimeWindow; moved: boolean } | null>(null);

  const zoneOf = new Map<string, string>();
  for (const r of spaces) zoneOf.set(r.compartment.compartment_no, r.compartment.zone);

  const dated = activities.filter((a) => !a.is_milestone && a.planned !== null);
  const laneOf = (a: Activity) =>
    (a.compartment_no !== null ? zoneOf.get(a.compartment_no) : undefined) ?? "unzoned";

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

  // Build lanes: zones in hull order (name-sorted works for Z2..Z7), then the
  // honest bucket for work the register cannot place in a zone. Levels are
  // stacked from the FULL register, not the visible slice, so a bar keeps its
  // row while the camera moves — a bar that jumps lanes mid-zoom would break
  // the reader's fix on it.
  const zoneNames = [...new Set(dated.map(laneOf))].sort((a, b) =>
    a === "unzoned" ? 1 : b === "unzoned" ? -1 : a.localeCompare(b),
  );
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
        (r) => r.compartment.zone === zone && !r.permits_work,
      ).length,
    };
    top += lane.h;
    return lane;
  });
  const H = top + 6;

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

  // Gridlines follow the camera: weekly across an availability, daily once the
  // window is tight enough for days to be readable columns.
  const step = span < 21 * DAY ? DAY : 7 * DAY;
  const ticks: number[] = [];
  for (let t = Math.ceil(win.v0 / step) * step; t <= win.v1; t += step) ticks.push(t);
  const fmtDay = (ms: number) => new Date(ms).toISOString().slice(5, 10).replace("-", "/");

  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 8, background: "#0e0f13", overflowX: "auto" }}>
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
            <path d="M 0 0.5 L 8 4 L 0 7.5 z" fill="#ef4444" />
          </marker>
        </defs>

        {/* Lane backgrounds first — they span the gutter too. */}
        {lanes.map((lane, i) => (
          <g key={lane.zone}>
            <rect x={0} y={lane.top} width={W} height={lane.h} fill={i % 2 === 0 ? "#101118" : "#0e0f13"} />
            <rect x={0} y={lane.top} width={5} height={lane.h} fill={lane.zone === "unzoned" ? "#4b5060" : zoneColour(lane.zone)} opacity={0.85} />
            {/* The zone manager's gutter: this week, in numbers. */}
            <text x={12} y={lane.top + 14} fill={C.text} fontSize={10.5} fontWeight={700}>
              {lane.zone === "unzoned" ? "No zone (unlocated)" : lane.zone}
            </text>
            <text x={12} y={lane.top + 26} fill="#8b93a2" fontSize={8.5}>
              {`next 7d: ${lane.weekCount} act · ${mh(lane.weekHours)}`}
            </text>
            <text x={12} y={lane.top + 37} fill={lane.refused > 0 || lane.heldSpaces > 0 ? "#f87171" : "#4b5060"} fontSize={8.5}>
              {`${lane.refused} not executable · ${lane.heldSpaces} spaces held now`}
            </text>
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
              <text x={x(t) + 3} y={AXIS_H - 12} fill="#6e7480" fontSize={8.5} fontFamily="monospace">
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
                return (
                  <g
                    key={b.a.activity_id}
                    onClick={() => {
                      if (drag.current?.moved) return;
                      if (located) onOpenSpace(located);
                    }}
                    style={{ cursor: located ? "pointer" : "default" }}
                  >
                    <title>
                      {`${b.a.code} — ${b.a.name}\n${b.a.trade} · ${located ?? "not located"} · ${fmtDay(b.start)} → ${fmtDay(b.end)}\n${mh(b.a.remaining_hours)} remaining${doomed ? "\nNOT EXECUTABLE AS PLANNED — click for the options" : ""}`}
                    </title>
                    <rect
                      x={bx} y={by} width={bw} height={ROW_H - 4} rx={2}
                      fill={STATUS_FILL[b.a.status]}
                      opacity={0.92}
                      stroke={doomed ? "#ef4444" : "none"}
                      strokeWidth={doomed ? 1.4 : 0}
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
                  stroke={neg ? "#ef4444" : "#5b6272"}
                  strokeWidth={neg ? 1.5 : 0.8}
                  opacity={neg ? 0.95 : 0.4}
                  markerEnd={neg ? "url(#dep-arrow-neg)" : "url(#dep-arrow)"}
                />
                {neg && (
                  <text
                    x={(px + sx) / 2}
                    y={(p.y + s.y) / 2 - 4}
                    fill="#ef4444"
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

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center", padding: "7px 11px", borderTop: `1px solid ${C.line}`, fontSize: 10.5, color: C.dim }}>
        <span><span style={{ color: STATUS_FILL.in_progress }}>■</span> in progress</span>
        <span><span style={{ color: STATUS_FILL.not_started }}>■</span> not started</span>
        <span><span style={{ color: STATUS_FILL.complete }}>■</span> complete</span>
        <span><span style={{ color: "#ef4444" }}>▭</span> not executable as planned</span>
        <span><span style={{ color: "#5b6272" }}>⟶</span> finish-to-start</span>
        <span title="The successor starts before its predecessor finishes — an overlap written into the schedule's own logic.">
          <span style={{ color: "#ef4444" }}>⟶</span> negative lag{inversions > 0 ? ` (${inversions})` : ""}
        </span>
        <span><span style={{ color: C.accent }}>◆</span> key event</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          <span title="Wheel zooms the time axis around the cursor · drag pans">wheel zooms · drag pans</span>
          {(["all", "inversions", "off"] as LogicMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setLogic(m)}
              title={
                m === "all" ? "Every dependency edge" : m === "inversions" ? "Only the negative lags" : "No arrows"
              }
              style={{
                font: "inherit", fontSize: 10, padding: "2px 8px", borderRadius: 5, cursor: "pointer",
                background: logic === m ? "#20222b" : "transparent",
                color: logic === m ? C.text : C.dim,
                border: `1px solid ${logic === m ? C.accent : C.line}`,
              }}
            >
              {m === "all" ? "logic: all" : m === "inversions" ? "inversions" : "logic off"}
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
