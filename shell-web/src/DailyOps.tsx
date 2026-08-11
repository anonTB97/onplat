// Daily Ops — the register's shift-sized slice: what is planned at the instant
// on the time control, per trade, with what stands in its way.
//
// The Sequence Board answers "what is the plan"; this answers the morning
// question — "who goes where today, and what will stop them". Same register,
// same instant-marking discipline, opposite default: here the slice IS the
// point, so out-of-window rows are omitted rather than dimmed. The full list
// is one click away on the Sequence Board, so the omission hides nothing.
//
// Two independent warnings per row, deliberately distinct:
//   SPACE HELD    — the engine refuses the space at *this instant* (live fact,
//                   moves with the time control);
//   NOT EXECUTABLE — the space refuses work somewhere in the activity's own
//                   planned window (a property of the plan; does not move).
// A crew can be sendable now on an activity that is doomed later this shift,
// and vice versa — conflating the two is how boards lie.

import { useEffect, useMemo, useState } from "react";
import {
  listActivities,
  type Activity,
  type AsOf,
  type DeckStateRow,
  type Identity,
} from "./api";
import { Loading } from "./Loading";
import { C, mh } from "./theme";

const fmtTime = (ms: number): string => new Date(ms).toISOString().slice(11, 16);
const fmtDay = (ms: number): string => new Date(ms).toISOString().slice(5, 10).replace("-", "/");

/** The activity's slot as a foreman reads it: times inside a day, else days. */
const fmtSlot = (w: { start: number; end: number } | null): string => {
  if (!w) return "undated";
  return w.end - w.start <= 86_400_000
    ? `${fmtDay(w.start)} ${fmtTime(w.start)}–${fmtTime(w.end)}`
    : `${fmtDay(w.start)} → ${fmtDay(w.end)}`;
};

export default function DailyOps({
  identity,
  vesselId,
  hullLabel,
  asOf,
  spaces,
  onOpenSpace,
}: {
  identity: Identity;
  vesselId: string;
  hullLabel: string;
  asOf: AsOf;
  /** The hull's per-space verdicts at the same instant, from the app shell. */
  spaces: DeckStateRow[];
  onOpenSpace: (compartment: string) => void;
}) {
  const [activities, setActivities] = useState<Activity[] | null>(null);
  const [asOfMs, setAsOfMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    listActivities(identity, vesselId, asOf)
      .then((r) => {
        setActivities(r.activities);
        setAsOfMs(r.as_of);
      })
      .catch((e: unknown) => {
        setActivities(null);
        setError(String(e));
      });
  }, [identity, vesselId, asOf]);

  const refused = useMemo(() => {
    const held = new Set<string>();
    for (const s of spaces) if (!s.permits_work) held.add(s.compartment.compartment_no);
    return held;
  }, [spaces]);

  const onShift = useMemo(
    () => (activities ?? []).filter((a) => a.in_window && !a.is_milestone && a.status !== "complete"),
    [activities],
  );
  const events = useMemo(
    () => (activities ?? []).filter((a) => a.in_window && a.is_milestone),
    [activities],
  );

  // Per trade, heaviest remaining first — the order a superintendent walks the
  // morning meeting in.
  const byTrade = useMemo(() => {
    const groups = new Map<string, Activity[]>();
    for (const a of onShift) {
      const list = groups.get(a.trade) ?? [];
      list.push(a);
      groups.set(a.trade, list);
    }
    return [...groups.entries()]
      .map(([trade, list]) => ({
        trade,
        list: list.sort((x, y) => y.remaining_hours - x.remaining_hours),
        remaining: list.reduce((s, a) => s + a.remaining_hours, 0),
      }))
      .sort((x, y) => y.remaining - x.remaining);
  }, [onShift]);

  if (error) return <p style={{ color: C.danger }}>Register unavailable ({error}).</p>;
  if (!activities) return <Loading label="Assembling the morning…" />;

  const heldCount = onShift.filter((a) => a.compartment_no && refused.has(a.compartment_no)).length;
  const doomedCount = onShift.filter((a) => a.executability.verdict === "not_executable").length;
  const remaining = onShift.reduce((s, a) => s + a.remaining_hours, 0);

  const badge = (fg: string, bg: string, border: string): React.CSSProperties => ({
    font: "inherit", fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4, cursor: "pointer",
    padding: "2px 7px", borderRadius: 4, color: fg, background: bg, border: `1px solid ${border}`,
  });

  return (
    <div>
      <div style={{ fontSize: 10, letterSpacing: 1.1, textTransform: "uppercase", color: C.accent }}>
        Daily Ops · {hullLabel}
      </div>
      <h1 style={{ fontSize: 22, margin: "4px 0 2px" }}>The shift board</h1>
      <p style={{ color: C.dim, fontSize: 12.5, margin: "0 0 14px", maxWidth: 780 }}>
        Every activity planned for{" "}
        <b style={{ color: "#ccd1da" }}>
          {asOfMs !== null ? `${fmtDay(asOfMs)} ${fmtTime(asOfMs)}` : "now"}
        </b>{" "}
        on the time control, by trade —{" "}
        <b style={{ color: "#ccd1da" }}>{onShift.length}</b> activities,{" "}
        <b style={{ color: "#ccd1da" }}>{mh(remaining)}</b> remaining in them
        {heldCount > 0 && (
          <>
            {" "}· <b style={{ color: C.danger }}>{heldCount}</b> in a space the engine refuses
            right now
          </>
        )}
        {doomedCount > 0 && (
          <>
            {" "}· <b style={{ color: "#f59e0b" }}>{doomedCount}</b> not executable as planned
          </>
        )}
        . Scrub the clock and the shift moves with it; the full register is on the
        Sequence Board.
      </p>

      {onShift.length === 0 && events.length === 0 && (
        <p style={{ color: C.dim, fontSize: 12.5 }}>
          Nothing is planned at this instant. Scrub the time control into the
          availability to see a shift.
        </p>
      )}

      {events.length > 0 && (
        <div style={{ marginBottom: 14, padding: "8px 12px", border: `1px solid rgba(61,107,255,0.35)`, borderRadius: 8, background: "rgba(61,107,255,0.05)" }}>
          <div style={{ fontSize: 10, letterSpacing: 0.8, textTransform: "uppercase", color: C.accent, marginBottom: 4 }}>
            Key events in window
          </div>
          {events.map((a) => (
            <div key={a.activity_id} style={{ fontSize: 12 }}>
              <span style={{ fontFamily: "monospace", color: C.accent }}>{a.code}</span>{" "}
              {a.name}
              <span style={{ color: C.dim, marginLeft: 8, fontFamily: "monospace", fontSize: 10.5 }}>
                {fmtSlot(a.planned)}
              </span>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fill,minmax(430px,1fr))", alignItems: "start" }}>
        {byTrade.map((g) => (
          <section key={g.trade} style={{ border: `1px solid ${C.line}`, borderRadius: 8, background: C.panel }}>
            <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "8px 12px", borderBottom: `1px solid ${C.line}` }}>
              <b style={{ fontSize: 13 }}>{g.trade}</b>
              <span style={{ fontSize: 11, color: C.dim }}>
                {g.list.length} activities · {mh(g.remaining)} remaining
              </span>
            </header>
            <div>
              {g.list.map((a) => {
                const heldNow = a.compartment_no !== null && refused.has(a.compartment_no);
                const doomed = a.executability.verdict === "not_executable";
                return (
                  <div
                    key={a.activity_id}
                    style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "6px 12px", borderBottom: "1px solid #191a1f", fontSize: 12 }}
                  >
                    <span style={{ fontFamily: "monospace", color: C.accent, whiteSpace: "nowrap" }}>{a.code}</span>
                    <span style={{ flex: 1, minWidth: 120 }}>
                      {a.name}
                      <span style={{ color: C.dim, marginLeft: 8, fontFamily: "monospace", fontSize: 10 }}>
                        {fmtSlot(a.planned)}
                        {a.planned === null && (
                          <span title="No dates in the schedule of record — counted into every shift rather than hidden from all of them." style={{ color: "#f59e0b" }}>
                            {" "}⚠
                          </span>
                        )}
                      </span>
                    </span>
                    <span style={{ fontSize: 10.5, color: C.dim, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                      {mh(a.remaining_hours)}
                    </span>
                    {a.compartment_no ? (
                      <button
                        onClick={() => onOpenSpace(a.compartment_no ?? "")}
                        title={heldNow ? "The engine refuses this space at this instant — click for why and what would open it." : "Open on the deck plan"}
                        style={
                          heldNow
                            ? badge("#fca5a5", "rgba(239,68,68,0.12)", "rgba(239,68,68,0.45)")
                            : {
                                font: "inherit", fontSize: 10, fontFamily: "monospace", cursor: "pointer",
                                padding: "1px 5px", borderRadius: 4, color: "#ccd1da",
                                background: "rgba(148,163,184,0.08)", border: `1px solid ${C.line}`,
                              }
                        }
                      >
                        {heldNow ? `HELD · ${a.compartment_no}` : a.compartment_no}
                      </button>
                    ) : (
                      <span style={{ fontSize: 10, color: "#f59e0b" }} title="The schedule did not say where.">
                        not located
                      </span>
                    )}
                    {doomed && (
                      <button
                        onClick={() => onOpenSpace(a.compartment_no ?? "")}
                        title="The space refuses work somewhere inside this activity's planned window — the plan, not the moment. Click for the options."
                        style={badge("#fbbf24", "rgba(245,158,11,0.10)", "rgba(245,158,11,0.4)")}
                      >
                        NOT EXECUTABLE
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
