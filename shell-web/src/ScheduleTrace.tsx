// The trace back to the schedule of record — the receipts behind a package.
//
// The Distributed Packages screen derives: segments, footprints, stranded
// hours. A planner deciding whether to trust those numbers asks the question
// every derivation must survive: WHICH schedule rows is this made of? This
// panel answers it in place — an expandable window under the package showing
// the actual line items of the current schedule of record (the same rows the
// Sequence Board serves), each with its planned window drawn on a shared
// axis, and the provenance header naming the document they came from.
//
// Two honest filters, because the mapping can fail two ways: BY WORK ITEM is
// the real trace (rows whose work-item number is this package's); IN THESE
// SPACES is the fallback lens (rows located in the footprint's compartments,
// whatever work item they carry). A package whose work item maps to zero
// rows is told loudly — that absence is a finding about the crosswalk, not a
// blank to skip.
//
// Fetched lazily on first expand, from the same endpoint the Sequence Board
// reads, so this panel and that board cannot disagree.

import { useEffect, useState } from "react";
import { listActivities, type Activity, type AsOf, type Identity } from "./api";
import { ACTIVITY_STATUS, C, mh } from "./theme";

import { fmtDay, fmtMonth } from "./clock";

// Month gridlines stay on the UTC 1st by design (S10 out of scope: a 4–5 h
// shift at month grain); the labels render in the yard's clock.
function monthStarts(t0: number, t1: number): number[] {
  const out: number[] = [];
  const d = new Date(t0);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  while (t < t1) {
    if (t > t0) out.push(t);
    const n = new Date(t);
    t = Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 1);
  }
  return out;
}

export function ScheduleTrace({
  identity,
  vesselId,
  asOf,
  packageCode,
  packageBudget,
  footprintSpaces,
  onOpenSpace,
}: {
  identity: Identity;
  vesselId: string;
  asOf: AsOf;
  /** The package's work-item code — the trace key into the register. */
  packageCode: string;
  /** The package's own budget, so the hours tie is stated, not implied. */
  packageBudget: number;
  /** The footprint's compartments — the fallback lens. */
  footprintSpaces: string[];
  onOpenSpace: (compartment: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Activity[] | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [asOfMs, setAsOfMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lens, setLens] = useState<"item" | "spaces">("item");

  // Lazy: the register is only read once the reader asks for the receipts.
  useEffect(() => {
    if (!open) return undefined;
    setError(null);
    let stale = false;
    listActivities(identity, vesselId, asOf)
      .then((r) => {
        if (stale) return;
        setRows(r.activities);
        setSource(r.schedule_source);
        setAsOfMs(r.as_of);
      })
      .catch((e: unknown) => {
        if (!stale) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      stale = true;
    };
  }, [open, identity, vesselId, asOf]);

  const spaceSet = new Set(footprintSpaces);
  const byItem = (rows ?? []).filter((a) => a.work_order_code === packageCode);
  const bySpace = (rows ?? []).filter(
    (a) => a.compartment_no !== null && spaceSet.has(a.compartment_no),
  );
  const shown = lens === "item" ? byItem : bySpace;
  const dated = shown.filter((a) => a.planned !== null);
  const shownBudget = shown.reduce((s, a) => s + a.budget_hours, 0);

  const t0 = dated.length > 0 ? Math.min(...dated.map((a) => a.planned?.start ?? 0)) : 0;
  const t1 = dated.length > 0 ? Math.max(...dated.map((a) => a.planned?.end ?? 1)) : 1;
  const span = Math.max(1, t1 - t0);
  const pct = (t: number) => `${(((t - t0) / span) * 100).toFixed(2)}%`;

  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 8, background: C.well, marginBottom: 14 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Open the receipts: the schedule-of-record line items this package is derived from, drawn on their calendar."
        style={{
          display: "flex", gap: 10, alignItems: "baseline", width: "100%", textAlign: "left",
          font: "inherit", cursor: "pointer", padding: "8px 12px",
          background: "transparent", color: C.text, border: "none",
        }}
      >
        <span style={{ fontSize: 11, color: C.accent }}>{open ? "▾" : "▸"}</span>
        <b style={{ fontSize: 11.5 }}>Trace to the schedule of record</b>
        <span style={{ fontSize: 10.5, color: C.dim }}>
          {open && rows
            ? `${byItem.length} line item${byItem.length === 1 ? "" : "s"} carry ${packageCode}`
            : "which schedule rows this package is made of — click to open"}
        </span>
      </button>

      {open && (
        <div style={{ borderTop: `1px solid ${C.line}`, padding: "9px 12px 11px" }}>
          {error !== null ? (
            <p style={{ fontSize: 11.5, color: C.danger, margin: 0 }}>
              Couldn&apos;t read the register ({error}) — the Sequence Board has the same rows.
            </p>
          ) : rows === null ? (
            <p style={{ fontSize: 11.5, color: C.dim, margin: 0 }}>Reading the register…</p>
          ) : (
            <>
              {/* provenance: name the document, tie the hours */}
              <div style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap", marginBottom: 8, fontSize: 11.5 }}>
                <span>
                  Schedule of record:{" "}
                  <b style={{ color: C.bright, fontFamily: "monospace" }}>
                    {source ?? "the generated demo register"}
                  </b>
                </span>
                <span style={{ color: C.dim }}>
                  {lens === "item"
                    ? `${mh(shownBudget)} budgeted on these rows vs ${mh(packageBudget)} in the package`
                    : `${shown.length} rows located in the footprint's ${footprintSpaces.length} spaces`}
                </span>
                <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  {(
                    [
                      ["item", `By work item (${byItem.length})`, "Rows whose work-item number is this package's — the real trace."],
                      ["spaces", `In these spaces (${bySpace.length})`, "Rows located in the footprint's compartments, whatever work item they carry — the fallback lens when the crosswalk is thin."],
                    ] as const
                  ).map(([k, label, gloss]) => (
                    <button
                      key={k}
                      onClick={() => setLens(k)}
                      title={gloss}
                      style={{
                        font: "inherit", fontSize: 10, padding: "1px 8px", borderRadius: 5, cursor: "pointer",
                        background: lens === k ? C.raised : "transparent",
                        color: lens === k ? C.text : C.dim,
                        border: `1px solid ${lens === k ? C.accent : C.line}`,
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </span>
              </div>

              {shown.length === 0 ? (
                <p style={{ fontSize: 11.5, color: C.warn, margin: 0 }}>
                  {lens === "item" ? (
                    <>
                      The current schedule of record maps <b>no line items</b> to {packageCode} —
                      the package&apos;s hours answer to nothing in this schedule. That absence is
                      a crosswalk finding, not a blank: try the &quot;In these spaces&quot; lens,
                      or check the work-item numbers in the imported file.
                    </>
                  ) : (
                    <>No schedule rows are located in this footprint&apos;s spaces.</>
                  )}
                </p>
              ) : (
                <div style={{ maxHeight: 300, overflowY: "auto", border: `1px solid ${C.hairline}`, borderRadius: 6 }}>
                  {/* month axis over the bar column */}
                  <div style={{ display: "grid", gridTemplateColumns: "88px minmax(150px,1.2fr) 84px 70px minmax(220px,2fr)", gap: "0 10px", alignItems: "center", padding: "3px 8px", position: "sticky", top: 0, background: C.panel, borderBottom: `1px solid ${C.hairline}`, zIndex: 1 }}>
                    <span style={{ fontSize: 9, letterSpacing: 0.6, textTransform: "uppercase", color: C.subtle }}>Activity</span>
                    <span style={{ fontSize: 9, letterSpacing: 0.6, textTransform: "uppercase", color: C.subtle }}>Name</span>
                    <span style={{ fontSize: 9, letterSpacing: 0.6, textTransform: "uppercase", color: C.subtle }}>Space</span>
                    <span style={{ fontSize: 9, letterSpacing: 0.6, textTransform: "uppercase", color: C.subtle, textAlign: "right" }} title="Budgeted man-hours on the row">MH</span>
                    <span style={{ position: "relative", height: 14, display: "block" }}>
                      {dated.length > 0 &&
                        monthStarts(t0, t1).map((m) => (
                          <span key={m} style={{ position: "absolute", left: pct(m), fontSize: 8.5, color: C.subtle, fontFamily: "monospace", transform: "translateX(-50%)" }}>
                            {fmtMonth(m)}
                          </span>
                        ))}
                    </span>
                  </div>
                  <div style={{ position: "relative" }}>
                    {shown.map((a) => {
                      const refused = a.executability.verdict === "not_executable";
                      return (
                        <div
                          key={a.activity_id}
                          style={{ display: "grid", gridTemplateColumns: "88px minmax(150px,1.2fr) 84px 70px minmax(220px,2fr)", gap: "0 10px", alignItems: "center", padding: "2.5px 8px", borderBottom: `1px solid ${C.hairline}`, fontSize: 11 }}
                          title={`${a.code} — ${a.name}\n${a.planned ? `${fmtDay(a.planned.start)} → ${fmtDay(a.planned.end)}` : "no dates"} · ${a.status.replace("_", " ")}${refused ? "\nNOT EXECUTABLE as planned — the Sequence Board has the evidence" : ""}`}
                        >
                          <span style={{ fontFamily: "monospace", fontSize: 10.5, color: C.accent, whiteSpace: "nowrap" }}>{a.code}</span>
                          <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: C.text }}>{a.name}</span>
                          <span>
                            {a.compartment_no ? (
                              <button
                                onClick={() => onOpenSpace(a.compartment_no ?? "")}
                                title="Open on the deck plan"
                                style={{
                                  font: "inherit", fontSize: 9.5, fontFamily: "monospace", cursor: "pointer",
                                  padding: "0 4px", borderRadius: 4,
                                  color: a.compartment_reliability === "high" ? C.bright : "#fbd38d",
                                  background: "rgba(148,163,184,0.08)",
                                  border: a.compartment_reliability === "high" ? `1px solid ${C.line}` : "1px dashed rgba(245,158,11,0.6)",
                                }}
                              >
                                {a.compartment_reliability !== "high" && "≈ "}
                                {a.compartment_no}
                              </button>
                            ) : (
                              <span style={{ fontSize: 9.5, color: C.warn }}>—</span>
                            )}
                          </span>
                          <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: C.dim, fontSize: 10.5 }}>
                            {a.is_milestone ? "—" : a.budget_hours.toLocaleString()}
                          </span>
                          <span style={{ position: "relative", height: 12, display: "block", background: "rgba(148,163,184,0.05)", borderRadius: 2 }}>
                            {a.planned && (
                              <span
                                style={{
                                  position: "absolute",
                                  left: pct(a.planned.start),
                                  width: `calc(${(((a.planned.end - a.planned.start) / span) * 100).toFixed(2)}% + 1px)`,
                                  top: 1.5,
                                  bottom: 1.5,
                                  borderRadius: 2,
                                  background: ACTIVITY_STATUS[a.status].fill,
                                  boxShadow: refused ? `0 0 0 1.5px ${C.danger}` : undefined,
                                }}
                              />
                            )}
                            {/* the instant, on every row's track */}
                            {asOfMs !== null && asOfMs >= t0 && asOfMs <= t1 && a.planned && (
                              <span style={{ position: "absolute", left: pct(asOfMs), top: 0, bottom: 0, width: 1, background: "rgba(248,113,113,0.5)" }} />
                            )}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              <p style={{ fontSize: 10, color: C.faint, margin: "7px 0 0" }}>
                The same rows the Sequence Board serves, filtered — this panel cannot disagree with
                it. Red-ringed bars are refused as planned; ≈ marks a location read from the task
                name. The thin red line is the instant on the time control.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
