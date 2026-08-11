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
// Milestones ride a key-events lane on top, because an undock date is the one
// thing every zone is actually sequenced around.

import type { Activity, DeckStateRow } from "./api";
import { C, mh, zoneColour } from "./theme";

const W = 1240;
const GUTTER_W = 225;
const ROW_H = 15;
const AXIS_H = 30;
const EVENTS_H = 26;
const DAY = 86_400_000;

const STATUS_FILL: Record<Activity["status"], string> = {
  not_started: "#475569",
  in_progress: "#3D6BFF",
  complete: "#1f7a44",
};

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

export function ZoneLanes({
  activities,
  spaces,
  asOf,
  onOpenSpace,
}: {
  activities: Activity[];
  spaces: DeckStateRow[];
  /** The instant the register was read at — the "today" line. */
  asOf: number | null;
  onOpenSpace: (compartment: string) => void;
}) {
  const zoneOf = new Map<string, string>();
  for (const r of spaces) zoneOf.set(r.compartment.compartment_no, r.compartment.zone);

  const dated = activities.filter((a) => !a.is_milestone && a.planned !== null);
  const laneOf = (a: Activity) =>
    (a.compartment_no !== null ? zoneOf.get(a.compartment_no) : undefined) ?? "unzoned";

  const milestones = activities.filter((a) => a.is_milestone && a.planned !== null);
  const allWindows = [...dated, ...milestones].map((a) => a.planned).filter((w) => w !== null);
  if (allWindows.length === 0) {
    return <p style={{ color: C.dim, fontSize: 12.5 }}>Nothing dated in the register.</p>;
  }
  const t0 = Math.min(...allWindows.map((w) => w.start)) - 2 * DAY;
  const t1 = Math.max(...allWindows.map((w) => w.end)) + 2 * DAY;
  const x = (t: number) => GUTTER_W + ((t - t0) / (t1 - t0)) * (W - GUTTER_W - 8);
  const now = asOf ?? t0;
  const weekEnd = now + 7 * DAY;

  // Build lanes: zones in hull order (name-sorted works for Z2..Z7), then the
  // honest bucket for work the register cannot place in a zone.
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

  // Weekly gridlines, anchored to the axis start.
  const weeks: number[] = [];
  for (let t = t0 + ((7 * DAY - ((t0 - 4 * DAY) % (7 * DAY))) % (7 * DAY)); t <= t1; t += 7 * DAY) weeks.push(t);
  const fmtDay = (ms: number) => new Date(ms).toISOString().slice(5, 10).replace("-", "/");

  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 8, background: "#0e0f13", overflowX: "auto" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", minWidth: 900, display: "block" }}>
        {/* Calendar axis: weekly gridlines down the whole board — the shared
            scale that makes cross-zone reading possible at all. */}
        {weeks.map((t) => (
          <g key={t}>
            <line x1={x(t)} y1={AXIS_H - 8} x2={x(t)} y2={H} stroke="#1d1f28" />
            <text x={x(t) + 3} y={AXIS_H - 12} fill="#6e7480" fontSize={8.5} fontFamily="monospace">
              {fmtDay(t)}
            </text>
          </g>
        ))}

        {/* Key events, above every lane: the dates every zone sequences around. */}
        <text x={8} y={AXIS_H + 12} fill={C.accent} fontSize={9} fontWeight={700} letterSpacing={0.8}>
          KEY EVENTS
        </text>
        {milestones.map((m) => {
          const t = m.planned?.start ?? 0;
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

            {lane.bars.map((b) => {
              const doomed = b.a.executability.verdict === "not_executable";
              const bx = x(b.start);
              const bw = Math.max(3, x(b.end) - bx);
              const by = lane.top + 7 + b.level * ROW_H;
              const located = b.a.compartment_no;
              return (
                <g
                  key={b.a.activity_id}
                  onClick={() => located && onOpenSpace(located)}
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

        {/* The as-of line: everything left of it is history, right is plan. */}
        {asOf !== null && (
          <g>
            <line x1={x(now)} y1={AXIS_H - 8} x2={x(now)} y2={H} stroke="#f87171" strokeWidth={1.2} strokeDasharray="5 3" />
            <text x={x(now) + 4} y={H - 6} fill="#f87171" fontSize={8.5}>
              as of {fmtDay(now)}
            </text>
          </g>
        )}
      </svg>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", padding: "7px 11px", borderTop: `1px solid ${C.line}`, fontSize: 10.5, color: C.dim }}>
        <span><span style={{ color: STATUS_FILL.in_progress }}>■</span> in progress</span>
        <span><span style={{ color: STATUS_FILL.not_started }}>■</span> not started</span>
        <span><span style={{ color: STATUS_FILL.complete }}>■</span> complete</span>
        <span><span style={{ color: "#ef4444" }}>▭</span> not executable as planned</span>
        <span><span style={{ color: C.accent }}>◆</span> key event</span>
        <span>lane gutter = this zone's next seven days, from the instant on the time control</span>
      </div>
    </div>
  );
}
