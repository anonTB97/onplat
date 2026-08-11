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

const DAY = 86_400_000;
const HOUR = 3_600_000;

/**
 * The board's slice. "instant" is the register's own in-window mark — what is
 * planned at the moment on the time control. The three shifts are the yard's
 * working day around that same instant, so a superintendent can read tonight's
 * board this afternoon. All times are Z, like every clock in this shell.
 */
type Shift = "instant" | "days" | "swing" | "night";

const SHIFTS: { id: Shift; label: string; gloss: string }[] = [
  { id: "instant", label: "This instant", gloss: "planned at the moment on the time control" },
  { id: "days", label: "Days 0700–1530", gloss: "first shift of the as-of day" },
  { id: "swing", label: "Swing 1530–2400", gloss: "second shift of the as-of day" },
  { id: "night", label: "Night 0000–0700", gloss: "third shift of the as-of day" },
];

/** The shift's window on the as-of day, or null for the instant mode. */
function shiftWindow(asOfMs: number, shift: Shift): { start: number; end: number } | null {
  if (shift === "instant") return null;
  const midnight = Math.floor(asOfMs / DAY) * DAY;
  switch (shift) {
    case "days":
      return { start: midnight + 7 * HOUR, end: midnight + 15.5 * HOUR };
    case "swing":
      return { start: midnight + 15.5 * HOUR, end: midnight + 24 * HOUR };
    case "night":
      return { start: midnight, end: midnight + 7 * HOUR };
  }
}

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
  const [shift, setShift] = useState<Shift>("instant");
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

  // The slice: the in-window mark at the instant, or the chosen shift's window
  // on the as-of day. Undated work is in every slice — counted into each shift
  // rather than hidden from all of them.
  const win = asOfMs !== null ? shiftWindow(asOfMs, shift) : null;
  const inSlice = useMemo(() => {
    return (a: Activity): boolean => {
      if (win === null) return a.in_window;
      if (a.planned === null) return true;
      return a.planned.start < win.end && a.planned.end > win.start;
    };
  }, [win]);
  const onShift = useMemo(
    () => (activities ?? []).filter((a) => inSlice(a) && !a.is_milestone && a.status !== "complete"),
    [activities, inSlice],
  );
  const events = useMemo(
    () => (activities ?? []).filter((a) => inSlice(a) && a.is_milestone),
    [activities, inSlice],
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
  const chip = (active: boolean): React.CSSProperties => ({
    padding: "3px 9px", borderRadius: 5, cursor: "pointer", font: "inherit", fontSize: 11,
    background: active ? "#20222b" : "transparent",
    color: active ? C.text : C.dim,
    border: `1px solid ${active ? C.accent : C.line}`,
  });

  const sliceLabel =
    win === null
      ? `at ${asOfMs !== null ? `${fmtDay(asOfMs)} ${fmtTime(asOfMs)}Z` : "now"}`
      : `${SHIFTS.find((s) => s.id === shift)?.label ?? ""} · ${fmtDay(win.start)} (Z)`;

  // The one-pager. Generated as its own monochrome document rather than
  // printing the app: a shift board goes up on a clipboard wall, where dark
  // panels and accent colours are ink and noise. Everything on it is text —
  // the warnings survive a photocopier, which a red pixel does not.
  const printBoard = () => {
    const esc = (s: string) =>
      s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const rows = byTrade
      .map(
        (g) => `
      <h2>${esc(g.trade)} <small>${g.list.length} activities · ${g.remaining.toLocaleString()} MH remaining</small></h2>
      <table>
        <tr><th>Activity</th><th>Name</th><th>Slot</th><th>Space</th><th style="text-align:right">MH left</th><th>Warnings</th></tr>
        ${g.list
          .map((a) => {
            const heldNow = a.compartment_no !== null && refused.has(a.compartment_no);
            const doomed = a.executability.verdict === "not_executable";
            const warns = [
              heldNow ? "HELD NOW" : "",
              doomed ? "NOT EXECUTABLE AS PLANNED" : "",
              a.planned === null ? "UNDATED" : "",
            ].filter(Boolean).join(" · ");
            return `<tr${warns ? ' class="warn"' : ""}>
              <td class="mono">${esc(a.code)}</td><td>${esc(a.name)}</td>
              <td class="mono">${esc(fmtSlot(a.planned))}</td>
              <td class="mono">${esc(a.compartment_no ?? "not located")}</td>
              <td style="text-align:right">${a.remaining_hours.toLocaleString()}</td>
              <td class="mono">${warns || "—"}</td>
            </tr>`;
          })
          .join("")}
      </table>`,
      )
      .join("");
    const eventRows = events.length
      ? `<p><b>Key events:</b> ${events.map((a) => `${esc(a.code)} ${esc(a.name)} (${esc(fmtSlot(a.planned))})`).join(" · ")}</p>`
      : "";
    const doc = `<!doctype html><html><head><meta charset="utf-8"><title>Shift board — ${esc(hullLabel)}</title>
      <style>
        body { font: 12px/1.45 system-ui, sans-serif; color: #111; margin: 28px; }
        h1 { font-size: 17px; margin: 0 0 2px; } h2 { font-size: 13px; margin: 16px 0 4px; }
        small { font-weight: 400; color: #555; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #999; padding: 3px 7px; text-align: left; font-size: 11px; }
        th { background: #eee; }
        .mono { font-family: ui-monospace, monospace; font-size: 10.5px; }
        .warn td { font-weight: 600; }
        footer { margin-top: 18px; font-size: 10px; color: #555; }
      </style></head><body>
      <h1>Shift board — ${esc(hullLabel)}</h1>
      <p>${esc(sliceLabel)} · ${onShift.length} activities · ${remaining.toLocaleString()} MH remaining
      ${heldCount > 0 ? ` · ${heldCount} in a space the engine refuses now` : ""}
      ${doomedCount > 0 ? ` · ${doomedCount} not executable as planned` : ""}</p>
      ${eventRows}${rows}
      <footer>Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")}Z · decision support only — flags risk; the planner decides. Does not modify the schedule.</footer>
      </body></html>`;
    const w = window.open("", "_blank", "width=900,height=700");
    if (!w) return;
    w.document.write(doc);
    w.document.close();
    w.focus();
    w.print();
  };

  return (
    <div>
      <div style={{ fontSize: 10, letterSpacing: 1.1, textTransform: "uppercase", color: C.accent }}>
        Daily Ops · {hullLabel}
      </div>
      <h1 style={{ fontSize: 22, margin: "4px 0 2px" }}>The shift board</h1>
      <p style={{ color: C.dim, fontSize: 12.5, margin: "0 0 14px", maxWidth: 780 }}>
        Every activity {win === null ? "planned" : "touching"}{" "}
        <b style={{ color: "#ccd1da" }}>{sliceLabel}</b>
        {win === null && " on the time control"}, by trade —{" "}
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

      {/* The slice: this instant, or one of the yard's three shifts on the
          as-of day — so tonight's board is readable this afternoon. */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        {SHIFTS.map((s) => (
          <button key={s.id} style={chip(shift === s.id)} onClick={() => setShift(s.id)} title={s.gloss}>
            {s.label}
          </button>
        ))}
        <button
          style={{ ...chip(false), marginLeft: "auto" }}
          onClick={printBoard}
          title="A monochrome one-pager for the clipboard wall — the warnings survive a photocopier."
        >
          ⎙ Print board
        </button>
      </div>

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
