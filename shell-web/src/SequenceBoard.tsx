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
  type Activity,
  type AsOf,
  type DeckStateRow,
  type Identity,
  type ImportPreview,
  type ReconciliationMismatch,
  type ScheduleEdge,
} from "./api";
import { Loading } from "./Loading";
import { ZoneLanes } from "./ZoneLanes";
import { C, mh } from "./theme";

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
  complete: { label: "COMPLETE", fg: "#22c55e" },
};

/** A planned window at day resolution — the resolution a schedule carries. */
const fmtWindow = (w: { start: number; end: number } | null): string => {
  if (!w) return "no dates";
  const d = (ms: number) => new Date(ms).toISOString().slice(5, 10).replace("-", "/");
  return `${d(w.start)} → ${d(w.end)}`;
};

/** An instant, to the minute — refusals are priced to the minute, not the day. */
const fmtInstant = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 16).replace("-", "/").replace("T", " ");

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
    ? `clears ${fmtInstant(e.earliest_clear)}`
    : `clears on verification by ${e.clearing_authority}`;
  return (
    `Refused from ${fmtInstant(e.at)} inside the planned window — ` +
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
}: {
  identity: Identity;
  vesselId: string;
  hullLabel: string;
  asOf: AsOf;
  /** Per-space verdicts at the same instant — the zone lanes' gutters read them. */
  spaces: DeckStateRow[];
  onOpenSpace: (compartment: string) => void;
}) {
  const [activities, setActivities] = useState<Activity[] | null>(null);
  const [asOfMs, setAsOfMs] = useState<number | null>(null);
  const [boardView, setBoardView] = useState<"register" | "lanes">("register");
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [pending, setPending] = useState<{ label: string; xer: string; preview: ImportPreview } | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [source, setSource] = useState<string | null>(null);
  const [mismatches, setMismatches] = useState<ReconciliationMismatch[]>([]);
  const [edges, setEdges] = useState<ScheduleEdge[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [trade, setTrade] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [inWindowOnly, setInWindowOnly] = useState(false);
  const [notExecOnly, setNotExecOnly] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  const [openEvidence, setOpenEvidence] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    listActivities(identity, vesselId, asOf)
      .then((r) => {
        setActivities(r.activities);
        setAsOfMs(r.as_of);
        setSource(r.schedule_source);
        setMismatches(r.reconciliation.mismatches);
        setEdges(r.edges);
      })
      .catch((e: unknown) => {
        setActivities(null);
        setError(String(e));
      });
  }, [identity, vesselId, asOf, reloadNonce]);

  const trades = useMemo(
    () => [...new Set((activities ?? []).map((a) => a.trade).filter((t) => t !== "—"))].sort(),
    [activities],
  );

  // Search and the trade/status filters narrow the register — those are the
  // reader's own questions. The instant never does; it marks.
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = (activities ?? []).filter((a) => {
      if (trade && a.trade !== trade) return false;
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
  }, [activities, search, trade, status, inWindowOnly, notExecOnly, sort]);

  if (error) return <p style={{ color: C.danger }}>Register unavailable ({error}).</p>;
  if (!activities) return <Loading label="Reading the register…" />;

  const remaining = rows.reduce((s, a) => s + a.remaining_hours, 0);
  const inWindow = activities.filter((a) => a.in_window && !a.is_milestone).length;
  const unlocated = activities.filter((a) => a.compartment_no === null && !a.is_milestone).length;
  const derivedLoc = activities.filter(
    (a) => a.compartment_no !== null && a.compartment_reliability !== "high" && !a.is_milestone,
  ).length;
  const refused = activities.filter((a) => a.executability.verdict === "not_executable").length;

  const th: React.CSSProperties = {
    textAlign: "left", padding: "6px 10px", fontSize: 10, letterSpacing: 0.6,
    textTransform: "uppercase", color: C.dim, borderBottom: `1px solid ${C.line}`,
    whiteSpace: "nowrap", position: "sticky", top: 0, background: "#121316",
  };
  const td: React.CSSProperties = {
    padding: "6px 10px", fontSize: 12, borderBottom: "1px solid #191a1f", verticalAlign: "top",
  };
  const chip = (active: boolean): React.CSSProperties => ({
    padding: "3px 9px", borderRadius: 5, cursor: "pointer", font: "inherit", fontSize: 11,
    background: active ? "#20222b" : "transparent",
    color: active ? C.text : C.dim,
    border: `1px solid ${active ? C.accent : C.line}`,
  });

  return (
    <div>
      <div style={{ fontSize: 10, letterSpacing: 1.1, textTransform: "uppercase", color: C.accent }}>
        Sequence Board · {hullLabel}
      </div>
      <h1 style={{ fontSize: 22, margin: "4px 0 2px" }}>The activity register</h1>
      <p style={{ color: C.dim, fontSize: 12.5, margin: "0 0 12px", maxWidth: 780 }}>
        Every scheduled activity at the grain a crew is handed — the accounting view
        of this work is the six rows on Work Orders; this is what those rows are made
        of. <b style={{ color: "#ccd1da" }}>{activities.length}</b> activities ·{" "}
        <b style={{ color: "#ccd1da" }}>{inWindow}</b> planned for the instant on the
        time control
        {unlocated > 0 && (
          <>
            {" "}· <b style={{ color: "#f59e0b" }}>{unlocated}</b>{" "}
            <span title="The schedule did not say which compartment — the dominant risk of every P6 import, shown rather than hidden.">
              with no located compartment
            </span>
          </>
        )}
        {derivedLoc > 0 && (
          <>
            {" "}· <b style={{ color: "#f59e0b" }}>{derivedLoc}</b>{" "}
            <span title="Located from the task's own name rather than an authored field — marked ≈ in the Space column, graded medium, never presented as authored.">
              located from task names
            </span>
          </>
        )}
        {refused > 0 && (
          <>
            {" "}· <b style={{ color: C.danger }}>{refused}</b>{" "}
            <span title="The activity's space, evaluated over its planned window, refuses work during it — a fact neither the schedule nor the engine holds alone.">
              not executable as planned
            </span>
          </>
        )}
        .{" "}
        {source ? (
          <>
            Schedule of record: <b style={{ color: "#ccd1da" }}>{source}</b> — served
            as ingested, graded, never smoothed over.
          </>
        ) : (
          <>
            Generated from the seeded work orders and packages so every hour
            reconciles with the boards; real P6 ingest replaces this register without
            changing the screen.
          </>
        )}
        {mismatches.length > 0 && (
          <>
            {" "}
            <b style={{ color: "#f59e0b" }}>⚠ {mismatches.length}</b>{" "}
            <span
              title={mismatches
                .map(
                  (m) =>
                    `${m.code}: item ${m.item_budget}/${m.item_earned} MH vs register ${m.register_budget}/${m.register_earned} MH`,
                )
                .join(" · ")}
            >
              work item{mismatches.length === 1 ? " does" : "s do"} not reconcile with
              the register
            </span>
            .
          </>
        )}
      </p>

      {/* The board's two shapes, and the door schedules come in and out of.
          Planning tool: the register reads, the lanes sequence, the import is
          how a real P6 export becomes the thing on screen, and the export is
          how what is on screen goes back to whoever plans in spreadsheets. */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
        <button style={chip(boardView === "register")} onClick={() => setBoardView("register")}>
          Register
        </button>
        <button
          style={chip(boardView === "lanes")}
          onClick={() => setBoardView("lanes")}
          title="Swim lanes per zone on one calendar — the cross-zone Gantt"
        >
          Zone lanes
        </button>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {importMsg && <span style={{ fontSize: 11, color: importMsg.startsWith("✓") ? "#22c55e" : C.danger }}>{importMsg}</span>}
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
                void file.text().then((xer) =>
                  previewSchedule(identity, vesselId, file.name, xer)
                    .then((r) => {
                      setPending({ label: file.name, xer, preview: r });
                      setImportMsg(null);
                    })
                    .catch((err: unknown) => setImportMsg(String(err))),
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
            title="Download the schedule's dependency logic — pred, succ, kind, lag. Negative lags are the rows worth reading."
            onClick={() => {
              const lines = [
                "pred_code,succ_code,kind,lag_hours",
                ...edges.map((e) => [e.pred_code, e.succ_code, e.kind, String(e.lag_hours)].join(",")),
              ];
              downloadCsv(lines, `edges-${source ?? "generated"}${stamp(asOfMs)}.csv`);
            }}
          >
            ⭳ Edges CSV
          </button>
          {source !== null && (
            <button
              style={chip(false)}
              title="Discard the ingested schedule and serve the generated register again."
              onClick={() => {
                void revertSchedule(identity, vesselId)
                  .then(() => {
                    setImportMsg("✓ reverted to the generated register");
                    setReloadNonce((n) => n + 1);
                  })
                  .catch((err: unknown) => setImportMsg(String(err)));
              }}
            >
              ⟲ Revert
            </button>
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
                {p.activities} activities · {p.edges} edges · {m.milestones} key events — previewed, nothing stored
              </span>
              <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                <button
                  style={chip(true)}
                  onClick={() => {
                    const staged = pending;
                    setPending(null);
                    if (!staged) return;
                    void importSchedule(identity, vesselId, staged.label, staged.xer)
                      .then((r) => {
                        setImportMsg(`✓ ${r.label}: ${r.activities} activities, ${r.edges} edges`);
                        setReloadNonce((n) => n + 1);
                      })
                      .catch((err: unknown) => setImportMsg(String(err)));
                  }}
                >
                  Confirm import
                </button>
                <button style={chip(false)} onClick={() => setPending(null)}>Cancel</button>
              </span>
            </div>
            <div style={line}>
              <span style={tag}>Location</span>
              <span style={{ color: "#ccd1da" }}>
                {m.located_authored} of {m.work_activities} authored by the schedule
              </span>
              {m.located_derived.length > 0 && (
                <span
                  style={{ color: "#f59e0b" }}
                  title="A placard parsed out of the task's own name — the parser's guess, graded medium and listed so it can be inspected and refused."
                >
                  · {m.located_derived.length} read from task names:{" "}
                  {m.located_derived.map((d) => `${d.activity} → ${d.compartment}`).join(", ")}
                </span>
              )}
              {m.unlocated.length > 0 && (
                <span style={{ color: C.danger, fontWeight: 700 }} title="The schedule did not say where. These rows serve as unlocated — visible on the register, undrawable on the ship. A WBS zone hint places the row in its swim lane at zone grain, nothing finer.">
                  · {m.unlocated.length} unlocated:{" "}
                  {m.unlocated
                    .map((u) => `${u.activity}${u.zone_hint ? ` (${u.zone_hint} per WBS)` : ""}`)
                    .join(", ")}
                </span>
              )}
              {m.unlocated.length === 0 && m.located_derived.length === 0 && (
                <span style={{ color: "#22c55e" }}>· every location authored</span>
              )}
            </div>
            {m.unknown_spaces.length > 0 && (
              <div style={line}>
                <span style={tag}>Unknown</span>
                <span style={{ color: C.danger, fontWeight: 700 }} title="Located to a compartment this hull's register does not carry — mapped, and to nowhere this hull knows.">
                  {m.unknown_spaces.map((u) => `${u.activity} → ${u.compartment}`).join(", ")} — not in this hull&apos;s register
                </span>
              </div>
            )}
            <div style={line}>
              <span style={tag}>Hours</span>
              {codes ? (
                <span style={{ color: "#f59e0b" }}>does not reconcile: {codes}</span>
              ) : (
                <span style={{ color: "#22c55e" }}>reconciles with the work items</span>
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

      {boardView === "lanes" && (
        <ZoneLanes activities={activities} spaces={spaces} edges={edges} asOf={asOfMs} onOpenSpace={onOpenSpace} />
      )}

      {boardView === "register" && (<>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search code, name, space, work order…"
          style={{
            font: "inherit", fontSize: 12, padding: "5px 9px", minWidth: 240,
            background: "#0b0c0e", color: C.text, border: `1px solid ${C.line}`, borderRadius: 6,
          }}
        />
        <button style={chip(trade === null)} onClick={() => setTrade(null)}>All trades</button>
        {trades.map((t) => (
          <button key={t} style={chip(trade === t)} onClick={() => setTrade(trade === t ? null : t)}>
            {t}
          </button>
        ))}
        <span style={{ width: 1, height: 18, background: C.line }} />
        {(["all", "not_started", "in_progress", "complete"] as StatusFilter[]).map((k) => (
          <button key={k} style={chip(status === k)} onClick={() => setStatus(k)}>
            {k === "all" ? "Any status" : STATUS_LABEL[k].label.toLowerCase()}
          </button>
        ))}
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: C.dim, cursor: "pointer" }}>
          <input type="checkbox" checked={inWindowOnly} onChange={(e) => setInWindowOnly(e.target.checked)} />
          In window now
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: notExecOnly ? C.danger : C.dim, cursor: "pointer" }}>
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
                    onClick={() =>
                      // Cycle: schedule order → ascending → descending → back.
                      setSort(
                        !active ? { key, dir: 1 } : sort?.dir === 1 ? { key, dir: -1 } : null,
                      )
                    }
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
            {rows.map((a) => (
              <Fragment key={a.activity_id}>
              <tr
                style={{
                  // Marked, not filtered: out-of-window rows dim, milestones read
                  // as events rather than work.
                  opacity: a.in_window || a.is_milestone ? 1 : 0.55,
                  background: a.is_milestone ? "rgba(61,107,255,0.05)" : undefined,
                }}
              >
                <td style={{ ...td, fontFamily: "monospace", color: C.accent, whiteSpace: "nowrap" }}>
                  {a.code}
                </td>
                <td style={{ ...td, minWidth: 220 }}>
                  {a.name}
                  {a.is_milestone && (
                    <span style={{ marginLeft: 6, fontSize: 9.5, color: C.accent, fontWeight: 700 }}>
                      KEY EVENT
                    </span>
                  )}
                </td>
                <td style={{ ...td, fontFamily: "monospace", fontSize: 11 }}>
                  {a.work_order_code ?? (
                    <span style={{ color: a.is_milestone ? C.dim : "#f59e0b" }} title="Scheduled work nobody has mapped to a work item — a gap, not an omission.">
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
                      onClick={() => onOpenSpace(a.compartment_no ?? "")}
                      title={
                        a.compartment_reliability === "high"
                          ? "Open on the deck plan"
                          : "Located from the task's own name — a graded guess, never presented as authored. Open on the deck plan."
                      }
                      style={{
                        font: "inherit", fontSize: 10.5, fontFamily: "monospace", cursor: "pointer",
                        padding: "1px 5px", borderRadius: 4,
                        color: a.compartment_reliability === "high" ? "#ccd1da" : "#fbd38d",
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
                      style={{ color: "#f59e0b" }}
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
                    <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, color: "#22c55e" }}>●</span>
                  )}
                </td>
                <td style={{ ...td, fontSize: 10, whiteSpace: "nowrap" }}>
                  {a.executability.verdict === "not_executable" ? (
                    <>
                    <button
                      // The activity's own space when located, else the hold's
                      // origin — either way the click lands with options open.
                      onClick={() => {
                        const e = a.executability;
                        onOpenSpace(
                          a.compartment_no ?? (e.verdict === "not_executable" ? e.origin : ""),
                        );
                      }}
                      title={refusalTitle(a)}
                      style={{
                        font: "inherit", fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4,
                        cursor: "pointer", padding: "2px 7px", borderRadius: 4,
                        color: "#fca5a5", background: "rgba(239,68,68,0.12)",
                        border: "1px solid rgba(239,68,68,0.45)",
                      }}
                    >
                      NOT EXECUTABLE
                    </button>
                    <button
                      onClick={() =>
                        setOpenEvidence(openEvidence === a.activity_id ? null : a.activity_id)
                      }
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
                    <span style={{ color: C.accent }}>MILESTONE</span>
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
                        <b style={{ color: "#fca5a5", fontFamily: "monospace" }}>{fmtInstant(a.executability.at)}</b>{" "}
                        inside {fmtWindow(a.planned)}
                      </span>
                      <span style={{ color: C.dim }}>
                        rule <b style={{ color: "#ccd1da", fontFamily: "monospace" }}>{a.executability.rule_code}</b>
                      </span>
                      <span style={{ color: C.dim }}>
                        {a.executability.hazard} @{" "}
                        <button
                          onClick={() => {
                            const e = a.executability;
                            if (e.verdict === "not_executable") onOpenSpace(e.origin);
                          }}
                          title="Open the hold's origin space"
                          style={{
                            font: "inherit", fontSize: 10.5, fontFamily: "monospace", cursor: "pointer",
                            padding: "1px 5px", borderRadius: 4, color: "#ccd1da",
                            background: "rgba(148,163,184,0.08)", border: `1px solid ${C.line}`,
                          }}
                        >
                          {a.executability.origin}
                        </button>
                      </span>
                      <span style={{ color: a.executability.earliest_clear ? "#f59e0b" : "#c4b5fd" }}>
                        {a.executability.earliest_clear
                          ? `clears ${fmtInstant(a.executability.earliest_clear)} on its own`
                          : `clears on verification by ${a.executability.clearing_authority} — never on a clock`}
                      </span>
                      <span style={{ color: C.dim }}>{mh(a.remaining_hours)} at stake</span>
                    </div>
                  </td>
                </tr>
              )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      </>)}
    </div>
  );
}
