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

import { useEffect, useMemo, useState } from "react";
import {
  importSchedule,
  previewSchedule,
  revertSchedule,
  listActivities,
  type Activity,
  type AsOf,
  type DeckStateRow,
  type Identity,
  type ReconciliationMismatch,
  type ScheduleEdge,
} from "./api";
import { ZoneLanes } from "./ZoneLanes";
import { C, mh } from "./theme";

type StatusFilter = "all" | "not_started" | "in_progress" | "complete";

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
  const [pending, setPending] = useState<{ label: string; xer: string; summary: string } | null>(null);
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
    return (activities ?? []).filter((a) => {
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
  }, [activities, search, trade, status, inWindowOnly, notExecOnly]);

  if (error) return <p style={{ color: C.danger }}>Register unavailable ({error}).</p>;
  if (!activities) return null;

  const remaining = rows.reduce((s, a) => s + a.remaining_hours, 0);
  const inWindow = activities.filter((a) => a.in_window && !a.is_milestone).length;
  const unlocated = activities.filter((a) => a.compartment_no === null && !a.is_milestone).length;
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
                      const codes = r.reconciliation.mismatches.map((m) => m.code).join(", ");
                      setPending({
                        label: file.name,
                        xer,
                        summary:
                          `${r.activities} activities, ${r.edges} edges` +
                          (codes ? ` · does not reconcile: ${codes}` : " · reconciles") +
                          (r.reconciliation.unmapped_budget_hours > 0
                            ? ` · ${r.reconciliation.unmapped_budget_hours} MH unmapped`
                            : ""),
                      });
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
              const blob = new Blob([lines.join("\n")], { type: "text/csv" });
              const url = URL.createObjectURL(blob);
              const link = document.createElement("a");
              link.href = url;
              link.download = `register-${source ?? "generated"}.csv`;
              link.click();
              URL.revokeObjectURL(url);
            }}
          >
            ⭳ Export CSV
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

      {pending && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10, padding: "8px 12px", border: `1px solid #f59e0b66`, borderRadius: 8, background: "rgba(245,158,11,0.06)", fontSize: 12 }}>
          <b>{pending.label}</b>
          <span style={{ color: C.dim }}>{pending.summary}</span>
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
      )}

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
              <th style={th}>Activity</th>
              <th style={th}>Name</th>
              <th style={th}>Work order</th>
              <th style={th}>Space</th>
              <th style={th}>Trade</th>
              <th style={th}>Planned</th>
              <th style={th}>Executable?</th>
              <th style={{ ...th, textAlign: "right" }}>Budget</th>
              <th style={{ ...th, textAlign: "right" }}>Earned</th>
              <th style={th}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr
                key={a.activity_id}
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
                    <button
                      onClick={() => onOpenSpace(a.compartment_no ?? "")}
                      title="Open on the deck plan"
                      style={{
                        font: "inherit", fontSize: 10.5, fontFamily: "monospace", cursor: "pointer",
                        padding: "1px 5px", borderRadius: 4, color: "#ccd1da",
                        background: "rgba(148,163,184,0.08)", border: `1px solid ${C.line}`,
                      }}
                    >
                      {a.compartment_no}
                    </button>
                  ) : a.is_milestone ? (
                    <span style={{ color: C.dim }}>—</span>
                  ) : (
                    <span style={{ color: "#f59e0b" }} title="The schedule did not say. Low-reliability mapping — never presented as authored.">
                      not located
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
            ))}
          </tbody>
        </table>
      </div>
      </>)}
    </div>
  );
}
