// The load digest: the whole availability as a zone × period heat map — the
// first thing a planner reads after an ingest, before any Gantt.
//
// A 1,500-activity register cannot be digested row by row, and a Gantt at
// that scale answers "what is this bar" long before it answers "where is the
// load". This board answers the planner's actual opening questions: which
// zones carry the work, in which weeks, where do the refusals cluster, and
// what does the shape look like month over month. Each cell is a zone's
// scheduled man-hours in one period — budget pro-rated across each
// activity's planned window, so a six-week job contributes to six cells
// rather than dog-piling its start date. Refusals ride the same cells as red
// counts: load and trouble, in one look.
//
// Week or month grain is the reader's choice and nothing else changes — the
// same rows, the same pro-rating, a different bucket width. The instant
// marks (the "now" column carries the ▾), never filters, as everywhere.

import { useMemo, useState } from "react";
import type { Activity, DeckStateRow } from "./api";
import { C, chipStyle, mh, zoneColour } from "./theme";

const DAY = 86_400_000;

interface Cell {
  hours: number;
  acts: number;
  refused: number;
}

interface Period {
  label: string;
  start: number;
  end: number;
}

/** Monday 00:00 UTC at or before `ms`. */
function mondayOf(ms: number): number {
  const d = new Date(ms);
  const dow = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow);
}

function monthOf(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function nextMonth(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

const fmtWeek = (ms: number) => new Date(ms).toISOString().slice(5, 10).replace("-", "/");
const fmtMonth = (ms: number) =>
  new Date(ms).toLocaleString("en-US", { month: "short", timeZone: "UTC" });

export function LoadDigest({
  activities,
  spaces,
  asOf,
}: {
  activities: Activity[];
  spaces: DeckStateRow[];
  /** The instant the register was read at — the "now" mark on the columns. */
  asOf: number | null;
}) {
  const [grain, setGrain] = useState<"week" | "month">("week");

  const { lanes, periods, cells, colTotals, peak } = useMemo(() => {
    const zoneOf = new Map<string, string>();
    for (const r of spaces) zoneOf.set(r.compartment.compartment_no, r.compartment.zone);
    const hullZones = new Set(zoneOf.values());
    // The same lane rule as the zone board: located → its zone; unlocated
    // with a WBS hint naming a real zone → that zone (a hint at exactly this
    // grain); anything else → the honest bucket.
    const laneOf = (a: Activity): string => {
      if (a.compartment_no !== null) return zoneOf.get(a.compartment_no) ?? "unzoned";
      if (a.wbs_area !== null && hullZones.has(a.wbs_area)) return a.wbs_area;
      return "unzoned";
    };

    const dated = activities.filter((a) => !a.is_milestone && a.planned !== null);
    if (dated.length === 0) {
      return { lanes: [], periods: [] as Period[], cells: new Map<string, Cell>(), colTotals: [] as Cell[], peak: 0 };
    }
    const t0 = Math.min(...dated.map((a) => a.planned?.start ?? 0));
    const t1 = Math.max(...dated.map((a) => a.planned?.end ?? 0));

    const periods: Period[] = [];
    if (grain === "week") {
      for (let t = mondayOf(t0); t < t1; t += 7 * DAY) {
        periods.push({ label: fmtWeek(t), start: t, end: t + 7 * DAY });
      }
    } else {
      for (let t = monthOf(t0); t < t1; t = nextMonth(t)) {
        periods.push({ label: fmtMonth(t), start: t, end: nextMonth(t) });
      }
    }

    const laneNames = [...new Set(dated.map(laneOf))].sort((a, b) =>
      a === "unzoned" ? 1 : b === "unzoned" ? -1 : a.localeCompare(b),
    );
    const cells = new Map<string, Cell>();
    const key = (lane: string, i: number) => `${lane}·${i}`;
    for (const a of dated) {
      const w = a.planned;
      if (!w) continue;
      const lane = laneOf(a);
      const span = Math.max(1, w.end - w.start);
      const refused = a.executability.verdict === "not_executable";
      for (let i = 0; i < periods.length; i += 1) {
        const p = periods[i];
        if (!p) continue;
        const overlap = Math.min(w.end, p.end) - Math.max(w.start, p.start);
        if (overlap <= 0) continue;
        const cell = cells.get(key(lane, i)) ?? { hours: 0, acts: 0, refused: 0 };
        cell.hours += (a.budget_hours * overlap) / span;
        cell.acts += 1;
        if (refused) cell.refused += 1;
        cells.set(key(lane, i), cell);
      }
    }
    const colTotals: Cell[] = periods.map((_, i) => {
      const t: Cell = { hours: 0, acts: 0, refused: 0 };
      for (const lane of laneNames) {
        const c = cells.get(key(lane, i));
        if (c) {
          t.hours += c.hours;
          t.acts += c.acts;
          t.refused += c.refused;
        }
      }
      return t;
    });
    const peak = Math.max(1, ...[...cells.values()].map((c) => c.hours));
    return { lanes: laneNames, periods, cells, colTotals, peak };
  }, [activities, spaces, grain]);

  if (periods.length === 0) {
    return <p style={{ color: C.dim, fontSize: 12.5 }}>Nothing dated in the register.</p>;
  }

  const cellOf = (lane: string, i: number) => cells.get(`${lane}·${i}`);
  const nowCol = asOf === null ? -1 : periods.findIndex((p) => asOf >= p.start && asOf < p.end);
  const colW = grain === "week" ? 40 : 96;
  const peakCol = colTotals.reduce((best, c, i) => (c.hours > (colTotals[best]?.hours ?? 0) ? i : best), 0);

  const cellBg = (hours: number) => {
    // Log-ish intensity so a monster week does not turn every other cell black.
    const f = Math.pow(Math.min(1, hours / peak), 0.6);
    return `rgba(61,107,255,${(0.04 + 0.5 * f).toFixed(3)})`;
  };

  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 8, background: C.well }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 12px", borderBottom: `1px solid ${C.line}` }}>
        <button style={chipStyle(grain === "week")} onClick={() => setGrain("week")}>
          Week by week
        </button>
        <button style={chipStyle(grain === "month")} onClick={() => setGrain("month")}>
          Month by month
        </button>
        <span style={{ fontSize: 11, color: C.dim, marginLeft: 6 }}>
          Scheduled man-hours by zone — budget pro-rated across each activity&apos;s planned
          window. <span style={{ color: C.dangerSoft }}>Red counts</span> are activities refused
          inside that period.
        </span>
      </div>

      <div style={{ overflowX: "auto", padding: "10px 12px 4px" }}>
        <table style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ minWidth: 96 }} />
              {periods.map((p, i) => (
                <th
                  key={p.start}
                  style={{
                    minWidth: colW, padding: "2px 3px 5px", fontSize: 9, fontWeight: i === nowCol ? 700 : 400,
                    color: i === nowCol ? C.bright : i === peakCol ? C.warn : C.subtle,
                    fontFamily: "monospace", textAlign: "center", whiteSpace: "nowrap",
                  }}
                  title={
                    (i === peakCol ? "The availability's peak load period. " : "") +
                    (i === nowCol ? "The instant on the time control sits in this period." : "")
                  }
                >
                  {i === nowCol && "▾ "}
                  {p.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lanes.map((lane) => {
              const laneTotal = periods.reduce((s, _, i) => s + (cellOf(lane, i)?.hours ?? 0), 0);
              return (
                <tr key={lane}>
                  <td style={{ padding: "0 10px 0 0", whiteSpace: "nowrap" }}>
                    <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: lane === "unzoned" ? C.faint : zoneColour(lane), marginRight: 6, verticalAlign: "baseline" }} />
                    <b style={{ fontSize: 11.5 }}>{lane === "unzoned" ? "No zone" : lane}</b>
                    <span style={{ fontSize: 10, color: C.dim, marginLeft: 6, fontVariantNumeric: "tabular-nums" }}>
                      {mh(Math.round(laneTotal))}
                    </span>
                  </td>
                  {periods.map((p, i) => {
                    const c = cellOf(lane, i);
                    return (
                      <td
                        key={p.start}
                        style={{
                          minWidth: colW, height: 30, padding: 1, textAlign: "center",
                          border: `1px solid ${C.hairline}`,
                          background: c ? cellBg(c.hours) : "transparent",
                          fontSize: 9.5, fontVariantNumeric: "tabular-nums",
                          color: c && c.hours > peak * 0.55 ? "#dfe4ec" : C.dim,
                          position: "relative",
                        }}
                        title={
                          c
                            ? `${lane === "unzoned" ? "No zone" : lane} · ${grain === "week" ? `week of ${p.label}` : p.label}\n` +
                              `${mh(Math.round(c.hours))} scheduled across ${c.acts} activit${c.acts === 1 ? "y" : "ies"}` +
                              (c.refused > 0 ? `\n${c.refused} refused inside this period — read them on the register (Not executable filter)` : "")
                            : undefined
                        }
                      >
                        {c && c.hours >= 1 ? (c.hours >= 995 ? `${(c.hours / 1000).toFixed(1)}k` : Math.round(c.hours)) : ""}
                        {c && c.refused > 0 && (
                          <span style={{ position: "absolute", top: 0, right: 2, color: C.dangerSoft, fontSize: 8.5, fontWeight: 700 }}>
                            {c.refused}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            <tr>
              <td style={{ padding: "4px 10px 2px 0", fontSize: 10, color: C.subtle, textTransform: "uppercase", letterSpacing: 0.6 }}>
                All zones
              </td>
              {colTotals.map((c, i) => (
                <td
                  key={periods[i]?.start ?? i}
                  style={{
                    textAlign: "center", padding: "4px 1px 2px", fontSize: 9.5, fontVariantNumeric: "tabular-nums",
                    color: i === peakCol ? C.warn : C.dim, fontWeight: i === peakCol ? 700 : 400,
                    borderTop: `1px solid ${C.line}`,
                  }}
                  title={c.refused > 0 ? `${c.refused} refusals hull-wide in this period` : undefined}
                >
                  {c.hours >= 1 ? (c.hours >= 995 ? `${(c.hours / 1000).toFixed(1)}k` : Math.round(c.hours)) : ""}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", padding: "6px 12px 9px", fontSize: 10.5, color: C.dim }}>
        <span><span style={{ color: C.warn }}>▮</span> peak period</span>
        <span>▾ the instant on the time control</span>
        <span>
          Unlocated work counts in its WBS-hinted zone — the same lane rule as the zone board,
          so the two screens cannot disagree.
        </span>
        <span style={{ marginLeft: "auto" }}>
          Zoom the story: pick the loud cell here, then read that window on Zone lanes.
        </span>
      </div>
    </div>
  );
}
