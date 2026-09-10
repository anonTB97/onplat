// Week Ahead — what stands between us and the next key event.
//
// Keyed to the schedule of record's next milestone with logic: the work the
// schedule itself says must finish first, ranked worst first by what the
// engine says about each row, with the proposals already headed to P6 shown
// against the activities they move, and a seven-day strip of starts and
// refusals. The derivation is `keyEvents.ts`; this file fetches the register
// (activities and edges), the engine's alternatives and the ledger's
// proposals at the instant, words them, and opens the inspector so a
// proposal can be raised from the row. A failed register read renders
// "unavailable"; a failed alternatives read leaves every refusal under
// MISSES THE EVENT with the reason said, never a quieter word.

import { useEffect, useMemo, useState } from "react";
import { ActivityInspector } from "./ActivityInspector";
import {
  listActivities,
  listProposals,
  scheduleAlternatives,
  type Activity,
  type AlternativeRow,
  type AsOf,
  type DeckStateRow,
  type Identity,
  type ScheduleEdge,
  type ScheduleProposal,
} from "./api";
import { currentClock, fmtDay, fmtDate } from "./clock";
import { keyEventSheet, keyEvents, gatingSet, weekBoard, type KeyEvent, type Tier, type WeekRow } from "./keyEvents";
import { Loading } from "./Loading";
import { ModuleHeader } from "./ModuleHeader";
import { downloadCsv, printReport } from "./Reports";
import { badgeStyle, C, chipStyle, commitBtnStyle, mh, tdStyle, thStyle } from "./theme";

const DAY = 86_400_000;
/** Rows the table renders before it asks — the Issues board's page. */
const PAGE = 50;

const TIER_TONE: Record<Tier, { fg: string; bg: string; border: string }> = {
  0: { fg: C.dangerSoft, bg: "rgba(239,68,68,0.12)", border: "rgba(239,68,68,0.45)" },
  1: { fg: "#fbbf24", bg: "rgba(245,158,11,0.10)", border: "rgba(245,158,11,0.4)" },
  2: { fg: "#fbbf24", bg: "rgba(245,158,11,0.10)", border: "rgba(245,158,11,0.4)" },
  3: { fg: "#fbbf24", bg: "rgba(245,158,11,0.10)", border: "rgba(245,158,11,0.4)" },
  4: { fg: C.ok, bg: "rgba(34,197,94,0.10)", border: "rgba(34,197,94,0.45)" },
};

interface Register {
  activities: Activity[];
  edges: ScheduleEdge[];
  asOf: number;
  source: string | null;
}

export default function WeekAhead({
  identity,
  vesselId,
  hullLabel,
  asOf,
  clockEpoch,
  spaces,
  zoneFocus = null,
  onZoneFocus,
  role,
  onOpenSpace,
  onOpenJob,
}: {
  identity: Identity;
  vesselId: string;
  hullLabel: string;
  asOf: AsOf;
  /** Bumped when the hull's yard clock changes: the day strip is re-derived. */
  clockEpoch: number;
  /** The register at the instant, for space → zone. */
  spaces: DeckStateRow[];
  zoneFocus?: string | null;
  onZoneFocus?: (zone: string | null) => void;
  /** The role producing a printed sheet. */
  role: string;
  onOpenSpace: (compartment: string) => void;
  onOpenJob: (code: string) => void;
}) {
  const [register, setRegister] = useState<Register | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [alternatives, setAlternatives] = useState<AlternativeRow[] | null>(null);
  const [altsSettled, setAltsSettled] = useState(false);
  const [proposals, setProposals] = useState<ScheduleProposal[] | null>(null);
  const [proposalNonce, setProposalNonce] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [inspect, setInspect] = useState<Activity | null>(null);
  const [limit, setLimit] = useState(PAGE);

  // The register with its logic, stale-guarded like every other board's read.
  useEffect(() => {
    let stale = false;
    setError(null);
    listActivities(identity, vesselId, asOf)
      .then((r) => {
        if (stale) return;
        setRegister({ activities: r.activities, edges: r.edges, asOf: r.as_of, source: r.schedule_source });
        setInspect((prev) => (prev ? (r.activities.find((x) => x.activity_id === prev.activity_id) ?? null) : null));
      })
      .catch((e: unknown) => {
        if (stale) return;
        setRegister(null);
        setError(String(e));
      });
    return () => {
      stale = true;
    };
  }, [identity, vesselId, asOf]);

  // The engine's windows for everything refused. Cleared up front; a failure
  // settles as null so the rows say "window unavailable" rather than spin.
  useEffect(() => {
    let stale = false;
    setAlternatives(null);
    setAltsSettled(false);
    scheduleAlternatives(identity, vesselId, asOf)
      .then((r) => {
        if (!stale) setAlternatives(r.alternatives);
      })
      .catch(() => {
        if (!stale) setAlternatives(null);
      })
      .finally(() => {
        if (!stale) setAltsSettled(true);
      });
    return () => {
      stale = true;
    };
  }, [identity, vesselId, asOf]);

  // The ledger's proposals — refetched when one lands from the inspector.
  useEffect(() => {
    let stale = false;
    listProposals(identity, vesselId)
      .then((p) => {
        if (!stale) setProposals(p.proposals);
      })
      .catch(() => {
        if (!stale) setProposals(null);
      });
    return () => {
      stale = true;
    };
  }, [identity, vesselId, proposalNonce]);

  // A hull switch orphans the picker and the inspector.
  useEffect(() => {
    setPicked(null);
    setInspect(null);
    setLimit(PAGE);
  }, [vesselId]);

  const zoneOf = useMemo(() => new Map(spaces.map((r) => [r.compartment.compartment_no, r.compartment.zone])), [spaces]);

  const events = useMemo(
    () => (register ? keyEvents(register.activities, register.edges, register.asOf) : []),
    [register],
  );
  /** Each upcoming event's gating set — the walk is milliseconds per event. */
  const gatingByEvent = useMemo(
    () => new Map(register ? events.map((e) => [e.code, gatingSet(e.code, register.activities, register.edges)]) : []),
    [events, register],
  );
  /** Events the logic ties work to — the ones the picker can key the board to. */
  const withLogic = useMemo(
    () => new Set([...gatingByEvent.entries()].filter(([, g]) => g.size > 0).map(([code]) => code)),
    [gatingByEvent],
  );
  // The default: the earliest event with logic — and with a zone in focus,
  // the earliest whose gating set has work in that zone, so a zone manager
  // opens on their own close-out rather than an empty table for somebody
  // else's. The picker overrides either.
  const byCode = useMemo(() => new Map(register?.activities.map((a) => [a.code, a]) ?? []), [register]);
  const defaultEvent = useMemo((): KeyEvent | null => {
    const withLogicList = events.filter((e) => withLogic.has(e.code));
    if (zoneFocus) {
      const inZone = withLogicList.find((e) =>
        [...(gatingByEvent.get(e.code) ?? [])].some((code) => {
          const a = byCode.get(code);
          return a !== undefined && (a.compartment_no !== null ? zoneOf.get(a.compartment_no) === zoneFocus : a.wbs_area === zoneFocus);
        }),
      );
      if (inZone) return inZone;
    }
    return withLogicList[0] ?? null;
  }, [events, withLogic, zoneFocus, gatingByEvent, byCode, zoneOf]);
  const event: KeyEvent | null = events.find((e) => e.code === picked) ?? defaultEvent;

  const board = useMemo(() => {
    if (!register || !event) return null;
    // `clockEpoch` stands for the module clock the day strip is placed in.
    return weekBoard({ event, events, activities: register.activities, edges: register.edges, alternatives, proposals, fromMs: register.asOf, clock: currentClock(), zone: zoneFocus, zoneOf });
  }, [register, event, events, alternatives, proposals, zoneFocus, zoneOf, clockEpoch]);

  const altByCode = useMemo(() => new Map((alternatives ?? []).map((r) => [r.activity, r])), [alternatives]);

  const sheet = () =>
    board && register ? keyEventSheet(board, { hull: hullLabel, asOfMs: register.asOf, scheduleSource: register.source, producedBy: role }, zoneFocus) : null;

  if (error) return <p style={{ color: C.danger }}>Register unavailable ({error}).</p>;
  if (!register) return <Loading label="Walking the schedule's logic…" />;

  const daysAway = event ? Math.round((event.at - register.asOf) / DAY) : null;
  const t = board?.totals;

  return (
    <div>
      <ModuleHeader
        kicker={`Week Ahead · ${hullLabel}`}
        title={
          event
            ? `What stands between us and ${event.name}`
            : events.length > 0
              ? "No logic ties work to any upcoming key event"
              : "No key event is upcoming in the schedule of record"
        }
        stats={
          event && t
            ? [
                { value: fmtDate(event.at), label: daysAway !== null ? `${daysAway} days away` : "", title: "The event's planned date, from the schedule of record." },
                { value: t.gating, label: "gating activities", title: "The schedule of record's own logic, walked backwards from the event by the shell; milestones and complete rows excluded." },
                { value: mh(Math.round(t.mhLeft)), label: "left in them", title: "Remaining man-hours, from the schedule of record." },
                t.misses > 0 && { value: t.misses, label: "miss the event", tone: C.danger, title: "Refused as planned, and the engine's window ends after the event, is verification-gated, or does not exist." },
                t.slides > 0 && { value: t.slides, label: "slide and still make it", tone: C.warn, title: "Refused as planned; the engine's viable window ends before the event." },
                t.unassessed > 0 && { value: t.unassessed, label: "cannot be assessed", tone: C.warn, title: "Unlocated or undated in the schedule of record — the engine was given no space or no dates." },
                t.plannedPast > 0 && { value: t.plannedPast, label: "planned past the event", tone: C.warn, title: "Executable, but the schedule of record already finishes it after the event." },
                { value: proposals === null ? "unavailable" : t.proposalsOpen, label: "proposals open", tone: proposals === null ? C.warn : undefined, title: "Open schedule change proposals on the gating set — the ledger's, status derived on every read." },
              ]
            : [{ value: events.length, label: "upcoming key events" }]
        }
        note="Keyed to the next key event the schedule's logic ties work to. Every word on a row is the engine's or the schedule's; the shell walks the logic and sorts. Nothing here is an authorization."
      />

      {/* The picker: every upcoming event; the ones no logic points at are dimmed and said. */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        <span style={{ fontSize: 9.5, letterSpacing: 0.6, textTransform: "uppercase", color: C.dim }}>Key event</span>
        {events.map((e) => (
          <button
            key={e.code}
            onClick={() => {
              setPicked(e.code);
              setLimit(PAGE);
              setInspect(null);
            }}
            style={{ ...chipStyle(event?.code === e.code), opacity: withLogic.has(e.code) ? 1 : 0.55 }}
            title={withLogic.has(e.code) ? `${e.code} · ${e.predCount} predecessors in the schedule's logic` : `${e.code} · no logic ties work to this event`}
          >
            {fmtDay(e.at)} {e.name}
          </button>
        ))}
        {events.length === 0 && <span style={{ fontSize: 12, color: C.dim }}>none after {fmtDay(register.asOf)}</span>}
        {zoneFocus && (
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "3px 8px 3px 10px", borderRadius: 6, border: `1px solid ${C.warn}88`, background: "rgba(245,158,11,0.08)", fontSize: 11.5 }}
            title="The zone in focus, shared with the Deck Explorer. Gating work located in the zone, or hinted to it by its WBS bucket when unlocated, is on the board."
          >
            <b style={{ color: C.warn }}>Zone {zoneFocus} in focus</b>
            {onZoneFocus && (
              <button onClick={() => onZoneFocus(null)} title="Leave zone focus — the whole gating set" style={{ font: "inherit", fontSize: 11, cursor: "pointer", padding: "1px 7px", borderRadius: 4, color: C.text, background: "transparent", border: `1px solid ${C.line}` }}>
                ✕
              </button>
            )}
          </span>
        )}
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button disabled={!board} onClick={() => { const r = sheet(); if (r) downloadCsv(r); }} style={{ ...chipStyle(false), opacity: board ? 1 : 0.5 }} title="The board as CSV, with the cut in its first rows">
            ↓ CSV
          </button>
          <button disabled={!board} onClick={() => { const r = sheet(); if (r) printReport(r); }} style={{ ...commitBtnStyle, opacity: board ? 1 : 0.5 }} title="Key-event readiness (R8) — a monochrome one-pager with every figure's layer">
            ⎙ Print sheet
          </button>
        </span>
      </div>

      {board && board.eventsWithoutLogic.length > 0 && (
        <p style={{ fontSize: 11.5, color: C.dim, margin: "0 0 10px" }}>
          No logic ties work to: {board.eventsWithoutLogic.map((e) => `${e.name} (${fmtDay(e.at)})`).join(" · ")}. The schedule dates them; nothing in it must finish first.
        </p>
      )}

      {!event && events.length > 0 && (
        <p style={{ fontSize: 12.5, color: C.warn, margin: "0 0 10px" }}>
          The schedule of record dates {events.length} upcoming key event{events.length === 1 ? "" : "s"} but ties no work to {events.length === 1 ? "it" : "any of them"} — there is no gating set to rank. The events are listed above.
        </p>
      )}

      {altsSettled && alternatives === null && board && board.totals.misses > 0 && (
        <div role="alert" style={{ margin: "0 0 10px", padding: "8px 12px", borderRadius: 6, border: "1px solid rgba(245,158,11,0.55)", background: "rgba(245,158,11,0.12)", color: C.warn, fontSize: 12.5 }}>
          <b>The engine&apos;s windows are unavailable.</b> Every refused row reads MISSES THE EVENT until the alternatives read answers; do not read that as the engine&apos;s verdict on the date.
        </div>
      )}

      {board && (
        <>
          <DaysStrip board={board} />
          <Table
            rows={board.rows}
            limit={limit}
            onMore={() => setLimit((n) => n + PAGE)}
            inspect={inspect}
            onInspect={setInspect}
            onOpenSpace={onOpenSpace}
            onOpenJob={onOpenJob}
          />
        </>
      )}

      {inspect && (
        <ActivityInspector
          a={inspect}
          alt={altByCode.get(inspect.code)}
          altsSettled={altsSettled}
          identity={identity}
          vesselId={vesselId}
          asOf={asOf}
          onClose={() => setInspect(null)}
          onOpenSpace={onOpenSpace}
          onOpenJob={onOpenJob}
          onProposed={() => setProposalNonce((n) => n + 1)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------- pieces */

function DaysStrip({ board }: { board: ReturnType<typeof weekBoard> }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 6, marginBottom: 12 }} title="Over the gating set: activities starting each yard day, and activities the engine refuses during it.">
      {board.days.map((d) => (
        <div key={d.dayStart} style={{ border: `1px solid ${d.refused > 0 ? "rgba(239,68,68,0.45)" : C.line}`, borderRadius: 7, background: C.panel, padding: "6px 9px" }}>
          <div style={{ fontSize: 10.5, color: C.dim, fontFamily: "monospace" }}>{d.label}</div>
          <div style={{ fontSize: 12, marginTop: 3 }}>
            <b style={{ color: C.bright }}>{d.starting}</b> <span style={{ color: C.dim, fontSize: 10.5 }}>starting</span>
          </div>
          <div style={{ fontSize: 12 }}>
            <b style={{ color: d.refused > 0 ? C.danger : C.dim }}>{d.refused}</b> <span style={{ color: C.dim, fontSize: 10.5 }}>refused</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function Table({
  rows,
  limit,
  onMore,
  inspect,
  onInspect,
  onOpenSpace,
  onOpenJob,
}: {
  rows: WeekRow[];
  limit: number;
  onMore: () => void;
  inspect: Activity | null;
  onInspect: (a: Activity) => void;
  onOpenSpace: (no: string) => void;
  onOpenJob: (code: string) => void;
}) {
  if (rows.length === 0) {
    return <p style={{ fontSize: 12.5, color: C.dim }}>No work gates this event in the schedule of record&apos;s logic{" "}— or none of it is in the zone in focus.</p>;
  }
  return (
    <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 8, background: C.panel }}>
      <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 1100 }}>
        <thead>
          <tr>
            <th style={thStyle} title="Worst first: the engine's verdict on the activity against the event date.">Reads</th>
            <th style={thStyle}>Activity</th>
            <th style={thStyle}>Name</th>
            <th style={thStyle}>Space</th>
            <th style={thStyle}>Trade</th>
            <th style={thStyle} title="Schedule of record">Planned</th>
            <th style={{ ...thStyle, textAlign: "right" }} title="Schedule of record">MH left</th>
            <th style={thStyle} title="The engine's governing hold: rule · hazard at origin · who clears it · when">The hold</th>
            <th style={{ ...thStyle, textAlign: "right" }} title="Event date minus planned finish, days — schedule of record">Margin</th>
            <th style={thStyle} title="The newest open or reflected proposal on the activity, from the ledger, against the event date">Proposal</th>
            <th style={thStyle} />
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, limit).map((r) => {
            const a = r.a;
            const open = inspect?.activity_id === a.activity_id;
            return (
              <tr key={a.activity_id} style={{ background: open ? C.raised : undefined, cursor: "pointer" }} onClick={() => onInspect(a)}>
                <td style={tdStyle}>
                  <span style={{ ...badgeStyle(TIER_TONE[r.tier]), whiteSpace: "nowrap" }} title={r.why || "Executable, and the schedule of record finishes it before the event."}>{r.word}</span>
                </td>
                <td style={{ ...tdStyle, fontFamily: "monospace", whiteSpace: "nowrap" }}>
                  {a.work_order_code ? (
                    <button onClick={(e) => { e.stopPropagation(); onOpenJob(a.work_order_code ?? ""); }} title={`Open the job card for ${a.work_order_code}`} style={{ font: "inherit", cursor: "pointer", color: C.accent, background: "transparent", border: "none", padding: 0, textDecoration: "underline", textUnderlineOffset: 2 }}>
                      {a.code}
                    </button>
                  ) : (
                    <span style={{ color: C.accent }}>{a.code}</span>
                  )}
                </td>
                <td style={tdStyle}>{a.name}</td>
                <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                  {a.compartment_no ? (
                    <button onClick={(e) => { e.stopPropagation(); onOpenSpace(a.compartment_no ?? ""); }} title="Open on the plate" style={{ font: "inherit", fontSize: 10.5, fontFamily: "monospace", cursor: "pointer", padding: "1px 5px", borderRadius: 4, color: C.bright, background: "rgba(148,163,184,0.08)", border: `1px solid ${C.line}` }}>
                      {a.compartment_reliability !== "high" && "≈ "}
                      {a.compartment_no}
                    </button>
                  ) : (
                    <span style={{ fontSize: 10.5, color: C.warn }}>not located{a.wbs_area ? ` · ${a.wbs_area} per WBS` : ""}</span>
                  )}
                </td>
                <td style={{ ...tdStyle, fontSize: 11, color: C.dim, whiteSpace: "nowrap" }}>{a.trade}</td>
                <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: 11, whiteSpace: "nowrap" }}>{a.planned ? `${fmtDay(a.planned.start)} → ${fmtDay(a.planned.end)}` : "undated"}</td>
                <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{Math.round(a.remaining_hours).toLocaleString()}</td>
                <td style={{ ...tdStyle, fontSize: 11.5, color: r.hold === "—" ? C.dim : C.bright }}>{r.hold}</td>
                <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums", color: r.marginDays !== null && r.marginDays < 0 ? C.danger : undefined }}>
                  {r.marginDays === null ? "—" : `${r.marginDays} d`}
                </td>
                <td style={{ ...tdStyle, fontSize: 11.5, whiteSpace: "nowrap", color: r.proposal ? (r.proposal.makesIt === false ? C.danger : r.proposal.status === "reflected" ? C.ok : C.accent) : C.dim }}>
                  {r.proposal?.text ?? "—"}
                </td>
                <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                  <span style={{ fontSize: 11, color: C.accent }}>Inspect →</span>
                </td>
              </tr>
            );
          })}
          {rows.length > limit && (
            <tr>
              <td colSpan={11} style={{ padding: "8px 12px", fontSize: 11.5, color: C.dim, borderTop: `1px solid ${C.line}` }}>
                <button onClick={onMore} title="Render the next fifty rows. Every row is already counted in the figures above and in the exports; only the table is paged." style={{ font: "inherit", fontSize: 11.5, cursor: "pointer", padding: "3px 10px", borderRadius: 5, color: C.accent, background: "transparent", border: `1px solid ${C.accent}55` }}>
                  Show {Math.min(PAGE, rows.length - limit)} more
                </button>
                <span style={{ marginLeft: 10 }}>
                  {limit} of {rows.length} rows rendered, worst first — the figures above count all of them.
                </span>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
