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
import { ModuleHeader } from "./ModuleHeader";
import { chipStyle, C, mh } from "./theme";
import { activityWindowHours, refusalOverlaps } from "./windowLoad";

import { fmtDay, fmtStamp, fmtTime } from "./clock";

/** The activity's slot as a foreman reads it: times inside a day, else days. */
const fmtSlot = (w: { start: number; end: number } | null): string => {
  if (!w) return "undated";
  return w.end - w.start <= 86_400_000
    ? `${fmtDay(w.start)} ${fmtTime(w.start)}–${fmtTime(w.end)}`
    : `${fmtDay(w.start)} → ${fmtDay(w.end)}`;
};

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** "1 activity", "4 activities" — a count that reads as written by a person. */
const nActs = (n: number): string => `${n} ${n === 1 ? "activity" : "activities"}`;

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
  onOpenJob,
}: {
  identity: Identity;
  vesselId: string;
  hullLabel: string;
  asOf: AsOf;
  /** The hull's per-space verdicts at the same instant, from the app shell. */
  spaces: DeckStateRow[];
  onOpenSpace: (compartment: string) => void;
  /** Opens the job card for a work-order code. */
  onOpenJob: (code: string) => void;
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

  // What the SLICE actually holds of an activity: pro-rated by overlap when a
  // shift window is chosen, so a three-month job contributes to tonight only
  // what tonight holds of it. This is what stops every shift reading the same.
  const sliceHours = useMemo(() => {
    return (a: Activity): number =>
      win === null ? a.remaining_hours : activityWindowHours(a, win.start, win.end);
  }, [win]);
  // A refusal DURING the slice, from the served evidence — distinct from the
  // plan-level verdict, which may bite a month from tonight.
  const refusedInSlice = useMemo(() => {
    return (a: Activity): boolean =>
      win !== null && refusalOverlaps(a, win.start, win.end);
  }, [win]);

  // Per trade, heaviest slice first — the order a superintendent walks the
  // morning meeting in. In shift mode the weight is the shift's own hours.
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
        list: list.sort((x, y) => sliceHours(y) - sliceHours(x)),
        remaining: list.reduce((s, a) => s + a.remaining_hours, 0),
        slice: list.reduce((s, a) => s + sliceHours(a), 0),
      }))
      .sort((x, y) => y.slice - x.slice);
  }, [onShift, sliceHours]);

  if (error) return <p style={{ color: C.danger }}>Register unavailable ({error}).</p>;
  if (!activities) return <Loading label="Assembling the morning…" />;

  const heldCount = onShift.filter((a) => a.compartment_no && refused.has(a.compartment_no)).length;
  const doomedCount = onShift.filter((a) => a.executability.verdict === "not_executable").length;
  const refusedNowCount = onShift.filter(refusedInSlice).length;
  const remaining = onShift.reduce((s, a) => s + a.remaining_hours, 0);
  const sliceTotal = onShift.reduce((s, a) => s + sliceHours(a), 0);
  const undatedCount = onShift.filter((a) => a.planned === null).length;

  const badge = (fg: string, bg: string, border: string): React.CSSProperties => ({
    font: "inherit", fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4, cursor: "pointer",
    padding: "2px 7px", borderRadius: 4, color: fg, background: bg, border: `1px solid ${border}`,
  });
  const chip = chipStyle;

  const sliceLabel =
    win === null
      ? `at ${asOfMs !== null ? `${fmtDay(asOfMs)} ${fmtTime(asOfMs)}` : "now"}`
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
      <h2>${esc(g.trade)} <small>${nActs(g.list.length)}${win !== null ? ` · ${Math.round(g.slice).toLocaleString()} MH this shift` : ""} · ${g.remaining.toLocaleString()} MH open total</small></h2>
      <table>
        <tr><th>Activity</th><th>Name</th><th>Slot</th><th>Space</th><th style="text-align:right">${win !== null ? "MH shift / total" : "MH left"}</th><th>Warnings</th></tr>
        ${g.list
          .map((a) => {
            const heldNow = a.compartment_no !== null && refused.has(a.compartment_no);
            const doomed = a.executability.verdict === "not_executable";
            const warns = [
              heldNow ? "HELD NOW" : "",
              doomed && refusedInSlice(a)
                ? "REFUSED THIS SHIFT"
                : doomed
                  ? "NOT EXECUTABLE AS PLANNED"
                  : "",
              a.planned === null ? "UNDATED" : "",
            ].filter(Boolean).join(" · ");
            return `<tr${warns ? ' class="warn"' : ""}>
              <td class="mono">${esc(a.code)}</td><td>${esc(a.name)}</td>
              <td class="mono">${esc(fmtSlot(a.planned))}</td>
              <td class="mono">${esc(a.compartment_no ?? "not located")}</td>
              <td style="text-align:right">${win !== null && a.planned !== null ? `${Math.round(sliceHours(a)).toLocaleString()} / ` : ""}${a.remaining_hours.toLocaleString()}</td>
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
      <p>${esc(sliceLabel)} · ${nActs(onShift.length)} · ${win !== null ? `${Math.round(sliceTotal).toLocaleString()} MH scheduled this shift · ` : ""}${remaining.toLocaleString()} MH open total
      ${heldCount > 0 ? ` · ${heldCount} in a space the engine refuses now` : ""}
      ${doomedCount > 0 ? ` · ${doomedCount} not executable as planned` : ""}</p>
      ${eventRows}${rows}
      <footer>Generated ${fmtStamp(Date.now())} · decision support only — flags risk; the planner decides. Does not modify the schedule.</footer>
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
      <ModuleHeader
        kicker={`Daily Ops · ${hullLabel}`}
        title="The shift board"
        stats={[
          { value: onShift.length, label: onShift.length === 1 ? "activity" : "activities", title: `Planned for ${sliceLabel}` },
          win !== null
            ? {
                value: mh(Math.round(sliceTotal)), label: "scheduled this shift",
                title: `Budget pro-rated by each activity's overlap with the shift window — a long job contributes only what this shift holds of it. Total open on these activities: ${mh(remaining)}. Undated rows carry no window and no shift hours.`,
              }
            : { value: mh(remaining), label: "remaining in them" },
          win !== null && refusedNowCount > 0 && {
            value: refusedNowCount, label: "refused during this shift", tone: C.danger,
            title: "The governing hold's own interval — from its first refusing instant to its earliest clear — overlaps this shift. This crew cannot go tonight.",
          },
          heldCount > 0 && {
            value: heldCount, label: "in refused spaces", tone: C.danger,
            title: "Booked into a space the engine refuses at this instant — live fact, moves with the clock.",
          },
          doomedCount > 0 && {
            value: doomedCount, label: win !== null ? "not executable (plan)" : "not executable", tone: C.warn,
            title: "The space refuses work somewhere inside the activity's own planned window — a property of the plan, not necessarily during this shift.",
          },
          win !== null && undatedCount > 0 && {
            value: undatedCount, label: "undated ride every shift", tone: C.warn,
            title: "No dates in the schedule of record — shown on every shift rather than hidden from all of them, but carrying no shift hours.",
          },
        ]}
        note={
          <>
            Slice: <b style={{ color: C.bright }}>{sliceLabel}</b> — scrub the clock and the
            shift moves with it; the full register is on the Sequence Board.
          </>
        }
      />

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
                {win !== null ? (
                  <span title={`This shift's share, pro-rated by overlap. Total open on these activities: ${mh(g.remaining)}.`}>
                    {nActs(g.list.length)} · <b style={{ color: C.bright }}>{mh(Math.round(g.slice))} this shift</b> · {mh(g.remaining)} total left
                  </span>
                ) : (
                  <>{nActs(g.list.length)} · {mh(g.remaining)} remaining</>
                )}
              </span>
            </header>
            <div>
              {g.list.map((a) => {
                const heldNow = a.compartment_no !== null && refused.has(a.compartment_no);
                const doomed = a.executability.verdict === "not_executable";
                return (
                  <div
                    key={a.activity_id}
                    style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "6px 12px", borderBottom: `1px solid ${C.hairline}`, fontSize: 12 }}
                  >
                    {a.work_order_code ? (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenJob(a.work_order_code ?? "");
                        }}
                        title={`Open the job card for ${a.work_order_code} — the whole order this activity belongs to`}
                        style={{ font: "inherit", fontFamily: "monospace", cursor: "pointer", color: C.accent, whiteSpace: "nowrap", background: "transparent", border: "none", padding: 0, textDecoration: "underline", textUnderlineOffset: 2 }}
                      >
                        {a.code}
                      </button>
                    ) : (
                      <span style={{ fontFamily: "monospace", color: C.accent, whiteSpace: "nowrap" }}>{a.code}</span>
                    )}
                    <span style={{ flex: 1, minWidth: 120 }}>
                      {a.name}
                      <span style={{ color: C.dim, marginLeft: 8, fontFamily: "monospace", fontSize: 10, whiteSpace: "nowrap" }}>
                        {fmtSlot(a.planned)}
                        {a.planned === null && (
                          <span title="No dates in the schedule of record — counted into every shift rather than hidden from all of them." style={{ color: C.warn }}>
                            {" "}⚠
                          </span>
                        )}
                      </span>
                    </span>
                    <span
                      title={win !== null && a.planned !== null ? `${mh(Math.round(sliceHours(a)))} falls inside this shift · ${mh(a.remaining_hours)} open in total` : undefined}
                      style={{ fontSize: 10.5, color: C.dim, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}
                    >
                      {win !== null && a.planned !== null
                        ? `${Math.round(sliceHours(a)).toLocaleString()} / ${a.remaining_hours.toLocaleString()} MH`
                        : mh(a.remaining_hours)}
                    </span>
                    {a.compartment_no ? (
                      <button
                        onClick={() => onOpenSpace(a.compartment_no ?? "")}
                        title={
                          (heldNow
                            ? "The engine refuses this space at this instant — click for why and what would open it."
                            : "Open on the deck plan") +
                          (a.compartment_reliability !== "high"
                            ? " Location read from the task's own name — a graded guess, never presented as authored."
                            : "")
                        }
                        style={
                          heldNow
                            ? badge(C.dangerSoft, "rgba(239,68,68,0.12)", "rgba(239,68,68,0.45)")
                            : {
                                font: "inherit", fontSize: 10, fontFamily: "monospace", cursor: "pointer",
                                padding: "1px 5px", borderRadius: 4, color: C.bright,
                                background: "rgba(148,163,184,0.08)", border: `1px solid ${C.line}`,
                              }
                        }
                      >
                        {a.compartment_reliability !== "high" && "≈ "}
                        {heldNow ? `HELD · ${a.compartment_no}` : a.compartment_no}
                      </button>
                    ) : (
                      <span style={{ fontSize: 10, color: C.warn }} title="The schedule did not say where.">
                        not located
                      </span>
                    )}
                    {doomed && refusedInSlice(a) ? (
                      <button
                        onClick={() => onOpenSpace(a.compartment_no ?? "")}
                        title="The governing hold's interval overlaps THIS shift — this crew cannot go during it. Click for the evidence and the options."
                        style={badge(C.dangerSoft, "rgba(239,68,68,0.12)", "rgba(239,68,68,0.45)")}
                      >
                        REFUSED THIS SHIFT
                      </button>
                    ) : doomed ? (
                      <button
                        onClick={() => onOpenSpace(a.compartment_no ?? "")}
                        title="The space refuses work somewhere inside this activity's planned window — the plan's problem, not necessarily this shift's. Click for the options."
                        style={badge("#fbbf24", "rgba(245,158,11,0.10)", "rgba(245,158,11,0.4)")}
                      >
                        NOT EXECUTABLE
                      </button>
                    ) : null}
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
