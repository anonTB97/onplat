// The activity register — every scheduled activity on the hull, at the grain a
// foreman is actually handed.
//
// This is the screen the attack plan calls the capability decision: an *issue*,
// properly, is an activity that cannot execute as planned, and issues are only
// detectable if the activities are in the platform. Work orders are the
// accounting grain (six rows on this hull); this is the doing grain (a couple of
// hundred), and it is where the platform stops being a viewer of compartment
// states and starts holding the plan itself.
//
// Two register disciplines, both inherited from the Work Orders table:
// the time control MARKS rows in or out of their window, never filters them —
// an omission is indistinguishable from missing data — and unmapped or
// unlocated rows are shown with their gap stated, never hidden, because
// scheduled work the platform cannot place is exactly what a planner needs on
// a list.

import { Fragment, useEffect, useMemo, useState } from "react";
import {
  importSchedule,
  previewSchedule,
  revertSchedule,
  listActivities,
  scheduleAlternatives,
  type Activity,
  type AlternativeRow,
  type AsOf,
  type DeckStateRow,
  type Identity,
  type ImportPreview,
  type ReconciliationMismatch,
  type ScheduleEdge,
  type Window,
  workConflicts,
  type WorkConflicts,
} from "./api";
import { ActivityInspector } from "./ActivityInspector";
import { Loading } from "./Loading";
import { LoadDigest } from "./LoadDigest";
import { ModuleHeader } from "./ModuleHeader";
import { ZoneLanes } from "./ZoneLanes";
import { tdStyle, thStyle, chipStyle, commitBtnStyle, C, errText, mh, msgColor } from "./theme";
import { DiscardButton } from "./DiscardButton";
import { deltaSummary } from "./ingest";

type StatusFilter = "all" | "not_started" | "in_progress" | "complete";

/** The columns the reader may sort by. Absent = the server's schedule order. */
type SortKey =
  | "code" | "name" | "order" | "space" | "trade"
  | "planned" | "exec" | "budget" | "earned" | "status";

/** Worst first when ascending: the refusals are what sorting this column is for. */
const EXEC_RANK: Record<string, number> = {
  not_executable: 0,
  unassessable: 1,
  executable: 2,
};

const STATUS_LABEL: Record<Exclude<StatusFilter, "all">, { label: string; fg: string }> = {
  not_started: { label: "NOT STARTED", fg: "#94a3b8" },
  in_progress: { label: "IN PROGRESS", fg: "#3D6BFF" },
  complete: { label: "COMPLETE", fg: C.ok },
};

/** A planned window at day resolution — the resolution a schedule carries. */
const fmtWindow = (w: { start: number; end: number } | null): string => {
  if (!w) return "no dates";
  return `${fmtDay(w.start)} → ${fmtDay(w.end)}`;
};

/** An instant, to the minute — refusals are priced to the minute, not the day. */
import { fmtDay, fmtDayTime } from "./clock";

/** The as-of stamp an export's filename carries — a file found on a desktop
 *  next month must say which instant it spoke for. */
const stamp = (ms: number | null): string =>
  ms === null ? "" : `-asof-${new Date(ms).toISOString().slice(0, 16).replace(/[:T]/g, "")}`;

/** Client-side CSV download; the blob URL is revoked once clicked. */
function downloadCsv(lines: string[], filename: string): void {
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** The refusal, in one sentence a planner can act on. */
const refusalTitle = (a: Activity): string => {
  const e = a.executability;
  if (e.verdict !== "not_executable") return "";
  const clears = e.earliest_clear
    ? `clears ${fmtDayTime(e.earliest_clear)}`
    : `clears on verification by ${e.clearing_authority.replace(/_/g, " ")}`;
  return (
    `Refused from ${fmtDayTime(e.at)} inside the planned window — ` +
    `${e.rule_code} · ${e.hazard} @ ${e.origin} · ${clears}. ` +
    `Click to open the space with its options.`
  );
};

export default function SequenceBoard({
  identity,
  vesselId,
  hullLabel,
  asOf,
  spaces,
  onOpenSpace,
  onOpenJob,
  zoneFocus = null,
  onZoneFocus,
}: {
  identity: Identity;
  vesselId: string;
  hullLabel: string;
  asOf: AsOf;
  /** Per-space verdicts at the same instant — the zone lanes' gutters read them. */
  spaces: DeckStateRow[];
  onOpenSpace: (compartment: string) => void;
  /** Opens the job card for a work-order code. */
  onOpenJob: (code: string) => void;
  /** The zone in focus, shared with the Deck Explorer through the shell:
   *  the register and the lanes narrow to work located in it (or hinted to
   *  it by the WBS), and say so. */
  zoneFocus?: string | null;
  onZoneFocus?: (zone: string | null) => void;
}) {

  // The day's hot-vs-flammable pairs, served — a schedule that plans flame
  // and vapour into each other should say so on the board that shows the plan.
  const [conflicts, setConflicts] = useState<WorkConflicts | null>(null);
  useEffect(() => {
    let stale = false;
    workConflicts(identity, vesselId, asOf)
      .then((c) => {
        if (!stale) setConflicts(c);
      })
      .catch(() => {
        if (!stale) setConflicts(null);
      });
    return () => {
      stale = true;
    };
  }, [identity, vesselId, asOf]);

  const [allActivities, setActivities] = useState<Activity[] | null>(null);
  // The zone in focus narrows the board to work located in the zone, or
  // hinted to it by its WBS bucket when unlocated — the same placement rule
  // the zone lanes use. Said in the header; never silent.
  const zoneOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of spaces) m.set(r.compartment.compartment_no, r.compartment.zone);
    return m;
  }, [spaces]);
  const activities = useMemo(() => {
    if (!allActivities || !zoneFocus) return allActivities;
    return allActivities.filter(
      (a) =>
        a.is_milestone ||
        (a.compartment_no !== null
          ? zoneOf.get(a.compartment_no) === zoneFocus
          : a.wbs_area === zoneFocus),
    );
  }, [allActivities, zoneFocus, zoneOf]);
  const [asOfMs, setAsOfMs] = useState<number | null>(null);
  const [boardView, setBoardView] = useState<"register" | "lanes" | "spaceLanes" | "digest">("register");
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [pending, setPending] = useState<{ label: string; xer: string; preview: ImportPreview } | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [source, setSource] = useState<string | null>(null);
  const [mismatches, setMismatches] = useState<ReconciliationMismatch[]>([]);
  const [edges, setEdges] = useState<ScheduleEdge[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [trade, setTrade] = useState<string | null>(null);
  const [space, setSpace] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [inWindowOnly, setInWindowOnly] = useState(false);
  const [notExecOnly, setNotExecOnly] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  const [openEvidence, setOpenEvidence] = useState<string | null>(null);
  const [alternatives, setAlternatives] = useState<AlternativeRow[]>([]);
  const [altsSettled, setAltsSettled] = useState(false);
  /** The row under inspection — any click on an activity opens it. */
  const [inspect, setInspect] = useState<Activity | null>(null);
  /** Rows the table renders before it asks: a carrier's register is
   *  thousands of rows, and a table that mounts them all is the slowest
   *  screen in the product. The rest are one click away, and counted. */
  const [tableLimit, setTableLimit] = useState(400);

  useEffect(() => {
    setError(null);
    // Guarded against reordering: with the time control playing, a slow
    // response for one instant must not land after a faster later one.
    let stale = false;
    listActivities(identity, vesselId, asOf)
      .then((r) => {
        if (stale) return;
        setActivities(r.activities);
        setAsOfMs(r.as_of);
        setSource(r.schedule_source);
        setMismatches(r.reconciliation.mismatches);
        setEdges(r.edges);
        // The inspector follows the register: re-point it at the fresh row so
        // it never shows a verdict the board no longer serves.
        setInspect((prev) =>
          prev ? (r.activities.find((x) => x.activity_id === prev.activity_id) ?? null) : null,
        );
      })
      .catch((e: unknown) => {
        if (stale) return;
        setActivities(null);
        setError(String(e));
      });
    return () => {
      stale = true;
    };
  }, [identity, vesselId, asOf, reloadNonce]);

  // The engine's re-sequence proposals for everything refused — same keying
  // as the register, cleared up front so an old hull's proposals never draw
  // under a new hull's bars.
  useEffect(() => {
    setAlternatives([]);
    setAltsSettled(false);
    let stale = false;
    scheduleAlternatives(identity, vesselId, asOf)
      .then((r) => {
        if (!stale) setAlternatives(r.alternatives);
      })
      .catch(() => {
        /* settled-without-rows renders as "unavailable" in the inspector */
      })
      .finally(() => {
        if (!stale) setAltsSettled(true);
      });
    return () => {
      stale = true;
    };
  }, [identity, vesselId, asOf, reloadNonce]);

  // A view switch orphans the inspector: a panel describing one register row
  // must not sit over a heat map it has nothing to say about.
  useEffect(() => {
    setInspect(null);
  }, [boardView]);

  // A hull switch invalidates everything the reader had staged or narrowed:
  // a preview audited against hull A must never be one click from committing
  // into hull B, and a filter naming a trade or space the new hull lacks
  // would empty the register with no visible cause.
  useEffect(() => {
    setPending(null);
    setImportMsg(null);
    setSearch("");
    setTrade(null);
    setSpace(null);
    setStatus("all");
    setSort(null);
    setOpenEvidence(null);
    setInspect(null);
  }, [vesselId]);

  // A new register (import, revert) can drop the selected trade or space;
  // a filter naming a value with no rows behind it resets rather than
  // silently emptying the table.
  useEffect(() => {
    if (activities === null) return;
    const tradesNow = new Set(activities.map((a) => a.trade));
    const spacesNow = new Set(activities.map((a) => a.compartment_no).filter(Boolean));
    setTrade((t) => (t !== null && !tradesNow.has(t) ? null : t));
    setSpace((sp) => (sp !== null && sp !== "unlocated" && !spacesNow.has(sp) ? null : sp));
  }, [activities]);

  const trades = useMemo(
    () => [...new Set((activities ?? []).map((a) => a.trade).filter((t) => t !== "—"))].sort(),
    [activities],
  );

  // Every space the register names, plus the honest bucket for the rows it
  // cannot place — "unlocated" is pickable precisely because those rows are
  // the ones a planner most needs on a list of their own.
  const spaceOptions = useMemo(
    () =>
      [...new Set(
        (activities ?? [])
          .filter((a) => !a.is_milestone)
          .map((a) => a.compartment_no)
          .filter((c): c is string => c !== null),
      )].sort(),
    [activities],
  );

  // Search and the trade/status filters narrow the register — those are the
  // reader's own questions. The instant never does; it marks.
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = (activities ?? []).filter((a) => {
      if (trade && a.trade !== trade) return false;
      if (space === "unlocated") {
        if (a.compartment_no !== null || a.is_milestone) return false;
      } else if (space && a.compartment_no !== space) {
        return false;
      }
      if (status !== "all" && a.status !== status) return false;
      if (inWindowOnly && !a.in_window) return false;
      if (notExecOnly && a.executability.verdict !== "not_executable") return false;
      if (!q) return true;
      return [a.code, a.name, a.compartment_no ?? "", a.work_order_code ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
    // Sorting is the reader's, and stable: no sort = the server's schedule
    // order (planned start, then code). Missing values always sink so "no
    // dates" never floats above the plan.
    if (!sort) return filtered;
    const value = (a: Activity): string | number | null => {
      switch (sort.key) {
        case "code": return a.code;
        case "name": return a.name;
        case "order": return a.work_order_code;
        case "space": return a.compartment_no;
        case "trade": return a.trade === "—" ? null : a.trade;
        case "planned": return a.planned?.start ?? null;
        case "exec": return EXEC_RANK[a.executability.verdict];
        case "budget": return a.is_milestone ? null : a.budget_hours;
        case "earned": return a.is_milestone ? null : a.earned_hours;
        case "status": return a.is_milestone ? null : a.status;
      }
    };
    return [...filtered].sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      const cmp = typeof va === "number" && typeof vb === "number"
        ? va - vb
        : String(va).localeCompare(String(vb));
      return cmp * sort.dir;
    });
  }, [activities, search, trade, space, status, inWindowOnly, notExecOnly, sort]);

  if (error) return <p style={{ color: C.danger }}>Register unavailable ({error}).</p>;
  if (!activities) return <Loading label="Reading the register…" />;

  const remaining = rows.reduce((s, a) => s + a.remaining_hours, 0);
  const inWindow = activities.filter((a) => a.in_window && !a.is_milestone).length;
  const unlocated = activities.filter((a) => a.compartment_no === null && !a.is_milestone).length;
  const derivedLoc = activities.filter(
    (a) => a.compartment_no !== null && a.compartment_reliability !== "high" && !a.is_milestone,
  ).length;
  const refused = activities.filter((a) => a.executability.verdict === "not_executable").length;
  const altByCode = new Map(alternatives.map((r) => [r.activity, r]));
  const viableWindows = new Map<string, Window>(
    alternatives.flatMap((r) =>
      r.alternative.kind === "viable" ? [[r.activity, r.alternative.window] as [string, Window]] : [],
    ),
  );
  const gated = alternatives.filter((r) => r.alternative.kind === "verification_gated").length;

  const th: React.CSSProperties = { ...thStyle, position: "sticky", top: 0, background: C.panel };
  const td: React.CSSProperties = { ...tdStyle, padding: "6px 10px", fontSize: 12 };
  const chip = chipStyle;

  return (
    <div style={{ marginRight: inspect ? 406 : 0, transition: "margin-right 0.15s ease" }}>
      <ModuleHeader
        kicker={`Sequence Board · ${hullLabel}`}
        title={
          boardView === "lanes"
            ? "Work by zone, on one calendar"
            : boardView === "spaceLanes"
              ? "The sequence inside each space"
              : boardView === "digest"
                ? "Where the load sits, week by week"
                : "The activity register"
        }
        stats={[
          { value: activities.length, label: "activities", title: "Every scheduled activity at the grain a crew is handed — the doing grain the six work orders are made of." },
          { value: inWindow, label: "in window now", title: "Planned for the instant on the time control. The instant marks rows, never filters them." },
          (conflicts?.pairs.length ?? 0) > 0 && {
            value: conflicts?.pairs.length ?? 0, label: "hot vs flammable today", tone: C.warn,
            title: `${conflicts?.basis ?? ""}\n\n${(conflicts?.pairs ?? []).slice(0, 5).map((pr) => pr.reason).join("\n")}`,
          },
          refused > 0 && {
            value: refused, label: "not executable", tone: C.danger,
            title: "The activity's space, evaluated over its planned window, refuses work during it — a fact neither the schedule nor the engine holds alone. Click any row or bar for the evidence and the proposal.",
          },
          viableWindows.size > 0 && {
            value: viableWindows.size, label: "viable re-sequences", tone: C.ok,
            title: "Refused work the engine found a later window for — the first window of the same duration the rules in force permit. Drawn as green ghosts on the lanes; proposals only, P6 decides.",
          },
          gated > 0 && {
            value: gated, label: "need verification", tone: "#c4b5fd",
            title: "Refused work whose governing hold clears only on a named authority's verification — no date can honestly be promised. The proposal is the action on the space's options panel.",
          },
          unlocated > 0 && {
            value: unlocated, label: "unlocated", tone: C.warn,
            title: "The schedule did not say which compartment — the dominant risk of every P6 import, shown rather than hidden.",
          },
          derivedLoc > 0 && {
            value: derivedLoc, label: "from task names", tone: C.warn,
            title: "Located from the task's own name rather than an authored field — marked ≈ in the Space column, never presented as authored.",
          },
          mismatches.length > 0 && {
            value: mismatches.length, label: "not reconciled", tone: C.warn,
            title: mismatches
              .map((m) => `${m.code}: item ${m.item_budget}/${m.item_earned} MH vs register ${m.register_budget}/${m.register_earned} MH`)
              .join(" · "),
          },
        ]}
        note={
          source ? (
            <>
              Schedule of record: <b style={{ color: C.bright }}>{source}</b> — served as
              ingested, graded, never smoothed over.
            </>
          ) : (
            <>
              This is the demo&apos;s built-in schedule. Import a real P6 schedule (⭱ Import
              XER) and it takes over every screen — nothing else changes.
            </>
          )
        }
      />

      {/* The board's two shapes, and the door schedules come in and out of.
          Planning tool: the register reads, the lanes sequence, the import is
          how a real P6 export becomes the thing on screen, and the export is
          how what is on screen goes back to whoever plans in spreadsheets. */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
        <button
          style={chip(boardView === "register")}
          onClick={() => setBoardView("register")}
          title="Every activity as a sortable, filterable table — the reading view"
        >
          Register
        </button>
        <button
          style={chip(boardView === "lanes")}
          onClick={() => setBoardView("lanes")}
          title="Swim lanes per zone on one calendar — the cross-zone Gantt"
        >
          Zone lanes
        </button>
        <button
          style={chip(boardView === "spaceLanes")}
          onClick={() => setBoardView("spaceLanes")}
          title="Swim lanes per compartment on the same calendar — the sequence inside each space. Unlocated work keeps its own lane; a WBS hint places at zone grain only, never here."
        >
          Space lanes
        </button>
        <button
          style={chip(boardView === "digest")}
          onClick={() => setBoardView("digest")}
          title="The whole availability as a zone × week (or month) heat map — where the load sits, where the refusals cluster. The right first read of a large ingest."
        >
          Load digest
        </button>
        {zoneFocus && (
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "3px 8px 3px 10px", borderRadius: 6, border: `1px solid ${C.warn}88`, background: "rgba(245,158,11,0.08)", fontSize: 11.5 }}
            title="The zone in focus, shared with the Deck Explorer. Work located in the zone, or hinted to it by its WBS bucket when unlocated, is on the board; the rest of the register is one click away."
          >
            <b style={{ color: C.warn }}>Zone {zoneFocus} in focus</b>
            <span style={{ color: C.dim }}>
              {activities.length.toLocaleString()} of {(allActivities?.length ?? 0).toLocaleString()} activities
            </span>
            {onZoneFocus && (
              <button
                onClick={() => onZoneFocus(null)}
                title="Leave zone focus — the whole register, on every screen"
                style={{ font: "inherit", fontSize: 11, cursor: "pointer", padding: "1px 7px", borderRadius: 4, color: C.text, background: "transparent", border: `1px solid ${C.line}` }}
              >
                ✕
              </button>
            )}
          </span>
        )}
        <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {importMsg && (
            <span style={{ fontSize: 11, color: msgColor(importMsg) }}>{importMsg}</span>
          )}
          <label style={{ ...chip(false), display: "inline-flex", alignItems: "center", gap: 5 }} title="Import a Primavera P6 XER export as this hull's schedule of record. All-or-nothing: one rejected line refuses the file.">
            ⭱ Import XER
            <input
              type="file"
              accept=".xer,text/plain"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                setImportMsg(`⏳ reading ${file.name}…`);
                void file.text().then((xer) =>
                  previewSchedule(identity, vesselId, file.name, xer)
                    .then((r) => {
                      setPending({ label: file.name, xer, preview: r });
                      setImportMsg(null);
                    })
                    .catch((err: unknown) => setImportMsg(errText(err))),
                );
              }}
            />
          </label>
          <button
            style={chip(false)}
            title="Download the register as CSV — every column, including executability and provenance."
            onClick={() => {
              const esc = (v: string) => `"${v.replaceAll('"', '""')}"`;
              const lines = [
                "code,name,work_order,compartment,reliability,trade,start,end,budget_mh,earned_mh,status,executability,source",
                ...activities.map((a) =>
                  [
                    a.code, esc(a.name), a.work_order_code ?? "", a.compartment_no ?? "",
                    a.compartment_reliability, a.trade,
                    a.planned ? new Date(a.planned.start).toISOString() : "",
                    a.planned ? new Date(a.planned.end).toISOString() : "",
                    String(a.budget_hours), String(a.earned_hours), a.status,
                    a.executability.verdict, esc(a.source_ref),
                  ].join(","),
                ),
              ];
              downloadCsv(lines, `register-${source ?? "generated"}${stamp(asOfMs)}.csv`);
            }}
          >
            ⭳ Export CSV
          </button>
          <button
            style={chip(false)}
            title="Download the schedule's dependency links (the 'edges': which activity waits on which, and by how much). The negative lags are the rows worth reading."
            onClick={() => {
              const lines = [
                "pred_code,succ_code,kind,lag_hours",
                ...edges.map((e) => [e.pred_code, e.succ_code, e.kind, String(e.lag_hours)].join(",")),
              ];
              downloadCsv(lines, `edges-${source ?? "generated"}${stamp(asOfMs)}.csv`);
            }}
          >
            ⭳ Logic CSV
          </button>
          {source !== null && (
            <DiscardButton
              what="the ingested schedule"
              title="Throw away the ingested schedule of record; the generated demo register is served again."
              onDiscard={() => {
                setImportMsg("⏳ discarding the ingested schedule…");
                void revertSchedule(identity, vesselId)
                  .then(() => {
                    setImportMsg("✓ back to the generated register");
                    setReloadNonce((n) => n + 1);
                  })
                  .catch((err: unknown) => setImportMsg(errText(err)));
              }}
            />
          )}
        </span>
      </div>

      {/* The dry run's findings, one line per question a planner asks before
          Confirm: what arrives, where it lands, and whether the hours agree.
          Everything here came from the server's preview — nothing is stored
          yet, and Cancel costs nothing. */}
      {pending && (() => {
        const p = pending.preview;
        const m = p.mapping;
        const codes = p.reconciliation.mismatches.map((x) => x.code).join(", ");
        const line: React.CSSProperties = { display: "flex", gap: 6, alignItems: "baseline", fontSize: 12 };
        const tag: React.CSSProperties = {
          fontSize: 9, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase",
          color: C.dim, minWidth: 86,
        };
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 10, padding: "9px 12px", border: `1px solid #f59e0b66`, borderRadius: 8, background: "rgba(245,158,11,0.06)" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <b style={{ fontSize: 12.5 }}>{pending.label}</b>
              <span style={{ fontSize: 11.5, color: C.dim }}>
                {p.activities} activities · {p.edges} edges · {m.milestones} key events — previewed,
                nothing stored.{" "}
                <span style={{ color: p.delta.newly_refused.count > 0 ? C.warn : C.ok }}>
                  {deltaSummary(p.delta)}.
                </span>{" "}
                <b style={{ color: C.warn }}>
                  Confirm replaces the current register ({activities.length} activities) on every screen.
                </b>
              </span>
              <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                <button
                  style={commitBtnStyle}
                  title="Store this schedule as the hull's schedule of record. Reversible: Discard brings the generated register back."
                  onClick={() => {
                    const staged = pending;
                    setPending(null);
                    if (!staged) return;
                    setImportMsg(`⏳ ingesting ${staged.label}…`);
                    void importSchedule(identity, vesselId, staged.label, staged.xer)
                      .then((r) => {
                        setImportMsg(`✓ ${r.label}: ${r.activities} activities, ${r.edges} edges`);
                        setReloadNonce((n) => n + 1);
                      })
                      .catch((err: unknown) => setImportMsg(errText(err)));
                  }}
                >
                  Confirm import
                </button>
                <button
                  style={chip(false)}
                  title="Walk away — the preview cost nothing and nothing was stored."
                  onClick={() => setPending(null)}
                >
                  Cancel
                </button>
              </span>
            </div>
            <div style={line}>
              <span style={tag}>Location</span>
              <span style={{ color: C.bright }}>
                {m.located_authored} of {m.work_activities} authored by the schedule
              </span>
              {m.located_derived.length > 0 && (
                <span
                  style={{ color: C.warn }}
                  title="A compartment number read out of the task's own name (its door placard) — the parser's guess, graded medium and listed so it can be inspected and refused."
                >
                  · {m.located_derived.length} read from task names:{" "}
                  {m.located_derived.slice(0, 8).map((d) => `${d.activity} → ${d.compartment}`).join(", ")}
                  {m.located_derived.length > 8 && ` … +${m.located_derived.length - 8} more (all marked ≈ on the register)`}
                </span>
              )}
              {m.unlocated.length > 0 && (
                <span style={{ color: C.danger, fontWeight: 700 }} title="The schedule did not say where. These rows serve as unlocated — visible on the register, undrawable on the ship. A WBS zone hint places the row in its swim lane at zone grain, nothing finer.">
                  · {m.unlocated.length} unlocated:{" "}
                  {m.unlocated
                    .slice(0, 8)
                    .map((u) => `${u.activity}${u.zone_hint ? ` (${u.zone_hint} per WBS)` : ""}`)
                    .join(", ")}
                  {m.unlocated.length > 8 &&
                    ` … +${m.unlocated.length - 8} more (${m.unlocated.filter((u) => u.zone_hint).length} carry a WBS zone hint)`}
                </span>
              )}
              {m.unlocated.length === 0 && m.located_derived.length === 0 && (
                <span style={{ color: C.ok }}>· every location authored</span>
              )}
            </div>
            {m.unknown_spaces.length > 0 && (
              <div style={line}>
                <span style={tag}>Unknown</span>
                <span style={{ color: C.danger, fontWeight: 700 }} title="Located to a compartment this hull's register does not carry — mapped, and to nowhere this hull knows.">
                  {m.unknown_spaces.slice(0, 8).map((u) => `${u.activity} → ${u.compartment}`).join(", ")}
                  {m.unknown_spaces.length > 8 && ` … +${m.unknown_spaces.length - 8} more`} — not in this hull&apos;s register
                </span>
              </div>
            )}
            <div style={line}>
              <span style={tag}>Hours</span>
              {codes ? (
                <span style={{ color: C.warn }}>does not reconcile: {codes}</span>
              ) : (
                <span style={{ color: C.ok }}>reconciles with the work items</span>
              )}
              {p.reconciliation.unmapped_budget_hours > 0 && (
                <span style={{ color: C.dim }}>
                  · {mh(p.reconciliation.unmapped_budget_hours)} mapped to no work item
                </span>
              )}
            </div>
          </div>
        );
      })()}

      {/* The lanes and the digest place work by the hull's register — the
          shell's shared verdict read. Until it lands, every activity would
          fall into the "no zone" lane and the board would reshuffle a
          moment later; a short wait is more honest than a wrong first frame. */}
      {(boardView === "digest" || boardView === "lanes" || boardView === "spaceLanes") &&
        spaces.length === 0 && (
          <Loading label="Reading the hull's register…" />
        )}

      {boardView === "digest" && spaces.length > 0 && (
        <LoadDigest activities={activities} spaces={spaces} asOf={asOfMs} />
      )}

      {(boardView === "lanes" || boardView === "spaceLanes") && spaces.length > 0 && (
        <ZoneLanes
          activities={activities}
          spaces={spaces}
          edges={edges}
          asOf={asOfMs}
          grain={boardView === "spaceLanes" ? "compartment" : "zone"}
          altWindows={viableWindows}
          onInspect={setInspect}
          onOpenSpace={onOpenSpace}
        />
      )}

      {boardView === "register" && (<>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          title="Narrow the register by anything a row carries — activity code, name, compartment, work order"
          placeholder="Search code, name, space, work order…"
          style={{
            font: "inherit", fontSize: 12, padding: "5px 9px", minWidth: 240,
            background: "#0b0c0e", color: C.text, border: `1px solid ${C.line}`, borderRadius: 6,
          }}
        />
        <button style={chip(trade === null)} onClick={() => setTrade(null)} title="Show every trade's work">
          All trades
        </button>
        {trades.map((t) => (
          <button
            key={t}
            style={chip(trade === t)}
            onClick={() => setTrade(trade === t ? null : t)}
            title={`Show only ${t} work · click again to clear`}
          >
            {t}
          </button>
        ))}
        <span style={{ width: 1, height: 18, background: C.line }} />
        <select
          value={space ?? ""}
          onChange={(e) => setSpace(e.target.value === "" ? null : e.target.value)}
          title="Narrow the register to one compartment — or to the rows the schedule could not place at all."
          style={{
            font: "inherit", fontSize: 11.5, padding: "4px 7px", borderRadius: 6, cursor: "pointer",
            background: space ? C.raised : "#0b0c0e",
            color: space ? C.text : C.dim,
            border: `1px solid ${space ? C.accent : C.line}`,
            fontFamily: space && space !== "unlocated" ? "monospace" : undefined,
            maxWidth: 170,
          }}
        >
          <option value="">All spaces</option>
          <option value="unlocated">not located</option>
          {spaceOptions.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <span style={{ width: 1, height: 18, background: C.line }} />
        {(["all", "not_started", "in_progress", "complete"] as StatusFilter[]).map((k) => (
          <button
            key={k}
            style={chip(status === k)}
            onClick={() => setStatus(k)}
            title={k === "all" ? "Show every status" : `Show only ${STATUS_LABEL[k].label.toLowerCase()} activities`}
          >
            {k === "all" ? "Any status" : STATUS_LABEL[k].label.toLowerCase()}
          </button>
        ))}
        <label
          title="Only activities planned for the instant on the time control"
          style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: C.dim, cursor: "pointer" }}
        >
          <input type="checkbox" checked={inWindowOnly} onChange={(e) => setInWindowOnly(e.target.checked)} />
          In window now
        </label>
        <label
          title="Only the refusals — work whose space refuses it somewhere inside its planned window"
          style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: notExecOnly ? C.danger : C.dim, cursor: "pointer" }}
        >
          <input type="checkbox" checked={notExecOnly} onChange={(e) => setNotExecOnly(e.target.checked)} />
          Not executable
        </label>
        <span style={{ marginLeft: "auto", fontSize: 11.5, color: C.dim }}>
          {rows.length} shown · {mh(remaining)} remaining in them
        </span>
      </div>

      <div style={{ overflow: "auto", maxHeight: "calc(100vh - 330px)", border: `1px solid ${C.line}`, borderRadius: 8 }}>
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 980 }}>
          <thead>
            <tr>
              {(
                [
                  ["Activity", "code", false],
                  ["Name", "name", false],
                  ["Work order", "order", false],
                  ["Space", "space", false],
                  ["Trade", "trade", false],
                  ["Planned", "planned", false],
                  ["Executable?", "exec", false],
                  ["Budget", "budget", true],
                  ["Earned", "earned", true],
                  ["Status", "status", false],
                ] as [string, SortKey, boolean][]
              ).map(([label, key, right]) => {
                const active = sort?.key === key;
                return (
                  <th
                    key={key}
                    tabIndex={0}
                    onClick={() =>
                      // Cycle: schedule order → ascending → descending → back.
                      setSort(
                        !active ? { key, dir: 1 } : sort?.dir === 1 ? { key, dir: -1 } : null,
                      )
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSort(!active ? { key, dir: 1 } : sort?.dir === 1 ? { key, dir: -1 } : null);
                      }
                    }}
                    title="Click to sort · third click restores schedule order"
                    style={{
                      ...th,
                      textAlign: right ? "right" : "left",
                      cursor: "pointer",
                      color: active ? C.text : C.dim,
                      userSelect: "none",
                    }}
                  >
                    {label}
                    {active && (sort?.dir === 1 ? " ↑" : " ↓")}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, tableLimit).map((a) => (
              <Fragment key={a.activity_id}>
              <tr
                onClick={() => setInspect(a)}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setInspect(a);
                }}
                title="Open this activity's inspector — details, evidence, and the suggested alternative"
                style={{
                  // Marked, not filtered: out-of-window rows dim, milestones read
                  // as events rather than work.
                  opacity: a.in_window || a.is_milestone ? 1 : 0.55,
                  background:
                    inspect?.activity_id === a.activity_id
                      ? "rgba(61,107,255,0.10)"
                      : a.is_milestone
                        ? "rgba(61,107,255,0.05)"
                        : undefined,
                  cursor: "pointer",
                }}
              >
                <td style={{ ...td, fontFamily: "monospace", color: C.accent, whiteSpace: "nowrap" }}>
                  {a.code}
                </td>
                <td style={{ ...td, minWidth: 220 }}>
                  {a.name}
                  {a.is_milestone && (
                    <span
                      title="A milestone: a dated event the plan sequences around — not work"
                      style={{ marginLeft: 6, fontSize: 9.5, color: C.accent, fontWeight: 700 }}
                    >
                      KEY EVENT
                    </span>
                  )}
                </td>
                <td style={{ ...td, fontFamily: "monospace", fontSize: 11 }}>
                  {a.work_order_code ?? (
                    <span style={{ color: a.is_milestone ? C.dim : C.warn }} title="Scheduled work nobody has mapped to a work item — a gap, not an omission.">
                      unmapped
                    </span>
                  )}
                </td>
                <td style={{ ...td, fontSize: 11 }}>
                  {a.compartment_no ? (
                    // The chip carries its provenance: an authored location is
                    // plain; a location the ingest read out of the task's own
                    // name wears "≈" and an amber dashed edge — a graded
                    // guess, never presented as authored.
                    <button
                      onClick={(ev) => {
                        ev.stopPropagation();
                        onOpenSpace(a.compartment_no ?? "");
                      }}
                      title={
                        a.compartment_reliability === "high"
                          ? "Open on the deck plan"
                          : "Located from the task's own name — a graded guess, never presented as authored. Open on the deck plan."
                      }
                      style={{
                        font: "inherit", fontSize: 10.5, fontFamily: "monospace", cursor: "pointer",
                        padding: "1px 5px", borderRadius: 4,
                        color: a.compartment_reliability === "high" ? C.bright : "#fbd38d",
                        background: "rgba(148,163,184,0.08)",
                        border: a.compartment_reliability === "high"
                          ? `1px solid ${C.line}`
                          : "1px dashed rgba(245,158,11,0.6)",
                      }}
                    >
                      {a.compartment_reliability !== "high" && "≈ "}
                      {a.compartment_no}
                    </button>
                  ) : a.is_milestone ? (
                    <span style={{ color: C.dim }}>—</span>
                  ) : (
                    <span
                      style={{ color: C.warn }}
                      title={
                        "The schedule did not say. Low-reliability mapping — never presented as authored." +
                        (a.wbs_area
                          ? ` Its WBS bucket sits under ${a.wbs_area} — a zone hint, nothing finer.`
                          : "")
                      }
                    >
                      not located{a.wbs_area ? ` · ${a.wbs_area} per WBS` : ""}
                    </span>
                  )}
                </td>
                <td style={{ ...td, color: C.dim }}>{a.trade}</td>
                <td style={{ ...td, fontFamily: "monospace", fontSize: 10.5, whiteSpace: "nowrap", color: C.dim }}>
                  {fmtWindow(a.planned)}
                  {a.in_window && !a.is_milestone && (
                    <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, color: C.ok }}>●</span>
                  )}
                </td>
                <td style={{ ...td, fontSize: 10, whiteSpace: "nowrap" }}>
                  {a.executability.verdict === "not_executable" ? (
                    <>
                    <button
                      // The activity's own space when located, else the hold's
                      // origin — either way the click lands with options open.
                      onClick={(ev) => {
                        ev.stopPropagation();
                        const e = a.executability;
                        onOpenSpace(
                          a.compartment_no ?? (e.verdict === "not_executable" ? e.origin : ""),
                        );
                      }}
                      title={
                        (a.status === "complete"
                          ? "Already complete — no hours are affected; the space refuses NEW work in that window. "
                          : "") + refusalTitle(a)
                      }
                      style={{
                        font: "inherit", fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4,
                        cursor: "pointer", padding: "2px 7px", borderRadius: 4,
                        color: C.dangerSoft, background: "rgba(239,68,68,0.12)",
                        border: "1px solid rgba(239,68,68,0.45)",
                        opacity: a.status === "complete" ? 0.55 : 1,
                      }}
                    >
                      NOT EXECUTABLE
                    </button>
                    <button
                      onClick={(ev) => {
                        ev.stopPropagation();
                        setOpenEvidence(openEvidence === a.activity_id ? null : a.activity_id);
                      }}
                      title="The evidence, in the open — the same facts the tooltip carries"
                      style={{
                        font: "inherit", fontSize: 9.5, cursor: "pointer", marginLeft: 4,
                        padding: "2px 6px", borderRadius: 4, color: C.dim,
                        background: "transparent", border: `1px solid ${C.line}`,
                      }}
                    >
                      {openEvidence === a.activity_id ? "▾" : "▸"} why
                    </button>
                    </>
                  ) : a.executability.verdict === "unassessable" ? (
                    <span
                      style={{ color: C.dim }}
                      title={
                        a.executability.reason === "unlocated"
                          ? "No compartment is mapped, so there is no space to evaluate — unknown, never presented as fine."
                          : "No planned dates, so there is no “as planned” to test against."
                      }
                    >
                      unknown
                    </span>
                  ) : (
                    <span
                      style={{ color: "rgba(34,197,94,0.65)" }}
                      title="The space permits work at every instant of the planned window, against the hazards on file."
                    >
                      ✓
                    </span>
                  )}
                </td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  {a.is_milestone ? "—" : a.budget_hours.toLocaleString()}
                </td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  {a.is_milestone ? "—" : a.earned_hours.toLocaleString()}
                </td>
                <td style={{ ...td, fontSize: 10, fontWeight: 700, whiteSpace: "nowrap" }}>
                  {a.is_milestone ? (
                    <span style={{ color: C.accent }} title="A dated event, not work — it carries no hours">MILESTONE</span>
                  ) : (
                    <span style={{ color: STATUS_LABEL[a.status].fg }}>{STATUS_LABEL[a.status].label}</span>
                  )}
                </td>
              </tr>
              {openEvidence === a.activity_id && a.executability.verdict === "not_executable" && (
                <tr style={{ background: "rgba(239,68,68,0.04)" }}>
                  <td colSpan={10} style={{ ...td, padding: "6px 12px 10px" }}>
                    {/* The tooltip's facts, in the open: what refuses, where,
                        from when, and how it clears — beside the door to the fix. */}
                    <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center", fontSize: 11 }}>
                      <span style={{ color: C.dim }}>
                        refused from{" "}
                        <b style={{ color: C.dangerSoft, fontFamily: "monospace" }}>{fmtDayTime(a.executability.at)}</b>{" "}
                        inside {fmtWindow(a.planned)}
                      </span>
                      <span style={{ color: C.dim }}>
                        rule <b style={{ color: C.bright, fontFamily: "monospace" }}>{a.executability.rule_code}</b>
                      </span>
                      <span style={{ color: C.dim }}>
                        {a.executability.hazard} @{" "}
                        <button
                          onClick={(ev) => {
                            ev.stopPropagation();
                            const e = a.executability;
                            if (e.verdict === "not_executable") onOpenSpace(e.origin);
                          }}
                          title="Open the hold's origin space"
                          style={{
                            font: "inherit", fontSize: 10.5, fontFamily: "monospace", cursor: "pointer",
                            padding: "1px 5px", borderRadius: 4, color: C.bright,
                            background: "rgba(148,163,184,0.08)", border: `1px solid ${C.line}`,
                          }}
                        >
                          {a.executability.origin}
                        </button>
                      </span>
                      <span style={{ color: a.executability.earliest_clear ? C.warn : "#c4b5fd" }}>
                        {a.executability.earliest_clear
                          ? `clears ${fmtDayTime(a.executability.earliest_clear)} on its own`
                          : `clears on verification by ${a.executability.clearing_authority.replace(/_/g, " ")} — never on a clock`}
                      </span>
                      <span style={{ color: C.dim }}>
                        {a.remaining_hours === 0
                          ? "already complete — nothing at stake"
                          : `${mh(a.remaining_hours)} at stake`}
                      </span>
                    </div>
                  </td>
                </tr>
              )}
              </Fragment>
            ))}
            {rows.length > tableLimit && (
              <tr>
                <td colSpan={10} style={{ ...td, padding: "8px 12px", color: C.dim }}>
                  <button
                    onClick={() => setTableLimit((n) => n + 1000)}
                    title="Render the next thousand rows. Every row is already counted above and in the exports; only the table is paged."
                    style={{
                      font: "inherit", fontSize: 11.5, cursor: "pointer", padding: "3px 10px",
                      borderRadius: 5, color: C.accent, background: "transparent", border: `1px solid ${C.accent}55`,
                    }}
                  >
                    Show {Math.min(1000, rows.length - tableLimit).toLocaleString()} more
                  </button>
                  <span style={{ marginLeft: 10, fontSize: 11 }}>
                    {tableLimit.toLocaleString()} of {rows.length.toLocaleString()} rows rendered — the
                    filters, the sort and the exports cover all of them.
                  </span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      </>)}

      {inspect && (
        <ActivityInspector
              onOpenJob={onOpenJob}
          a={inspect}
          alt={altByCode.get(inspect.code)}
          altsSettled={altsSettled}
          identity={identity}
          vesselId={vesselId}
          asOf={asOf}
          onClose={() => setInspect(null)}
          onOpenSpace={onOpenSpace}
        />
      )}
    </div>
  );
}
