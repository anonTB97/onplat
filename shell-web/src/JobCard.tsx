// The job card: everything the schedule asks of ONE work order, in one
// drawer, reachable from any place its code appears.
//
// This exists because the question a person actually carries around the yard
// is not "what is the state of compartment 3-160-2-Q" — it is "what is MY
// JOB doing": when am I on, where do I go, what is refused, what do I do
// about it. Before this card, answering that meant joining four boards by
// hand (the order on Work Orders, its activities on the Sequence Board, its
// spaces on the Deck Explorer, its conflicts on the day chip). The card does
// the join, in reading order:
//
//   1. what & how much      the order, its hours, its provenance
//   2. when                 this week's slice, and the next activity to start
//   3. the plan             every activity, dated, with its verdict
//   4. where                the spaces, wearing their state right now
//   5. problems & the fix   refusals with their clearing route, conflicts
//
// Everything shown is served truth: verdicts come from the register's own
// executability, states from the engine via the shell, conflicts from the
// day's served pairs. The card computes nothing but layout.

import { useEffect, useMemo, useState } from "react";
import {
  listActivities,
  listPackages,
  listWorkOrders,
  workConflicts,
  type Activity,
  type AsOf,
  type DeckStateRow,
  type Identity,
  type WorkConflicts,
  type WorkOrder,
} from "./api";
import { fmtDay, fmtDayTime } from "./clock";
import { activityWindowHours } from "./windowLoad";
import { ACTIVITY_STATUS, C, mh, overlayBucket, OVERLAY_STYLE } from "./theme";

const DAY = 86_400_000;

/** One refusal drawn from an activity's served executability. */
interface JobRefusal {
  code: string;
  space: string | null;
  rule: string;
  authority: string;
  clear: number | null;
}

export function JobCard({
  identity,
  vesselId,
  code,
  asOf,
  now,
  spaces,
  onOpenSpace,
  onClose,
}: {
  identity: Identity;
  vesselId: string;
  /** The WI / work-order / package code this card is about. */
  code: string;
  asOf: AsOf;
  now: number | null;
  /** Per-space verdicts at the same instant, from the app shell. */
  spaces: DeckStateRow[];
  onOpenSpace: (compartment: string) => void;
  onClose: () => void;
}) {
  const [order, setOrder] = useState<WorkOrder | null>(null);
  const [isPackage, setIsPackage] = useState(false);
  const [acts, setActs] = useState<Activity[]>([]);
  const [conflicts, setConflicts] = useState<WorkConflicts | null>(null);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    let stale = false;
    setSettled(false);
    setOrder(null);
    setActs([]);
    setConflicts(null);
    void Promise.all([
      listWorkOrders(identity, vesselId, asOf).catch(() => []),
      listPackages(identity, vesselId).catch(() => []),
      listActivities(identity, vesselId, asOf).catch(() => null),
      workConflicts(identity, vesselId, asOf).catch(() => null),
    ]).then(([orders, packages, register, cf]) => {
      if (stale) return;
      const o = orders.find((w) => w.code === code) ?? null;
      const p = packages.find((x) => x.code === code) ?? null;
      // A package is a work order too; the card serves both through one shape.
      setOrder(
        o ??
          (p
            ? {
                work_order_id: p.work_order_id,
                code: p.code,
                title: p.name,
                trade: p.trade,
                system: p.system,
                compartment_no: "",
                budget_hours: p.budget_hours,
                earned_hours: p.earned_hours,
                source_ref: "distributed package",
                source_verified: true,
                planned: null,
                in_window: true,
              }
            : null),
      );
      setIsPackage(o === null && p !== null);
      setActs((register?.activities ?? []).filter((a) => a.work_order_code === code));
      setConflicts(cf);
      setSettled(true);
    });
    return () => {
      stale = true;
    };
  }, [identity, vesselId, code, asOf]);

  const at = asOf ?? now;

  // This week's ask: the same pro-rating rule every board uses.
  const week = useMemo(() => {
    if (at === null) return null;
    const t1 = at + 7 * DAY;
    let hours = 0;
    let count = 0;
    for (const a of acts) {
      if (a.is_milestone || a.status === "complete") continue;
      const h = activityWindowHours(a, at, t1);
      if (h > 0) {
        hours += h;
        count += 1;
      }
    }
    return { hours, count, crew: Math.max(count > 0 ? 1 : 0, Math.ceil(hours / (8 * 7))) };
  }, [acts, at]);

  const next = useMemo(
    () =>
      at === null
        ? null
        : (acts
            .filter((a) => !a.is_milestone && a.status === "not_started" && a.planned !== null)
            .sort((a, b) => (a.planned?.start ?? 0) - (b.planned?.start ?? 0))
            .find((a) => (a.planned?.start ?? 0) >= at) ?? null),
    [acts, at],
  );

  const jobSpaces = useMemo(
    () => [...new Set(acts.map((a) => a.compartment_no).filter((s): s is string => s !== null))],
    [acts],
  );

  const refusals: JobRefusal[] = useMemo(
    () =>
      acts.flatMap((a) =>
        a.executability.verdict === "not_executable"
          ? [
              {
                code: a.code,
                space: a.compartment_no,
                rule: a.executability.rule_code,
                authority: a.executability.clearing_authority,
                clear: a.executability.earliest_clear,
              },
            ]
          : [],
      ),
    [acts],
  );

  const myCodes = useMemo(() => new Set(acts.map((a) => a.code)), [acts]);
  const myConflicts = useMemo(
    () =>
      (conflicts?.pairs ?? []).filter(
        (pr) =>
          myCodes.has(pr.hot.code) ||
          myCodes.has(pr.flammable.code) ||
          jobSpaces.includes(pr.hot.space) ||
          jobSpaces.includes(pr.flammable.space),
      ),
    [conflicts, myCodes, jobSpaces],
  );

  // Escape closes — every drawer in this product obeys the same key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const remaining = order ? Math.max(0, order.budget_hours - order.earned_hours) : 0;
  const done = acts.filter((a) => a.status === "complete").length;
  const going = acts.filter((a) => a.status === "in_progress").length;

  const h = (t: string) => (
    <div style={{ fontSize: 9.5, letterSpacing: 0.9, textTransform: "uppercase", color: C.subtle, margin: "12px 0 5px" }}>
      {t}
    </div>
  );

  return (
    <aside
      aria-label={`Job card ${code}`}
      style={{
        position: "fixed", top: 62, right: 12, bottom: 26, width: 430, zIndex: 47,
        background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10,
        boxShadow: "-16px 8px 40px rgba(0,0,0,0.55)", overflowY: "auto", padding: "12px 14px",
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <b style={{ fontFamily: "monospace", fontSize: 15, color: C.accent }}>{code}</b>
        {isPackage && (
          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.5, color: "#c4b5fd", border: "1px solid rgba(167,139,250,0.5)", borderRadius: 4, padding: "1px 6px" }}>
            DISTRIBUTED
          </span>
        )}
        <button
          onClick={onClose}
          title="Close (Esc)"
          style={{ marginLeft: "auto", font: "inherit", fontSize: 12, cursor: "pointer", background: "transparent", color: C.dim, border: `1px solid ${C.line}`, borderRadius: 5, padding: "1px 8px" }}
        >
          ✕
        </button>
      </div>

      {!settled && <p style={{ color: C.dim, fontSize: 12 }}>Reading the job…</p>}
      {settled && !order && (
        <p style={{ color: C.warn, fontSize: 12 }}>
          No work order or package on this hull carries the code {code}. If it came from the
          schedule, the register may not be mapped to a work item yet — that gap is a finding,
          not a dead end: the reconciliation report on Work Orders lists it.
        </p>
      )}

      {order && (
        <>
          <div style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>{order.title}</div>
          <div style={{ fontSize: 11, color: C.dim }}>
            {order.trade} · {order.system} · {order.source_ref}
            {!order.source_verified && <span style={{ color: C.warn }}> · provenance unconfirmed</span>}
          </div>

          {h("What the schedule asks")}
          <div style={{ fontSize: 12, color: C.bright, display: "flex", flexWrap: "wrap", gap: "4px 14px" }}>
            <span><b>{mh(remaining)}</b> remaining of {mh(order.budget_hours)}</span>
            <span>{acts.length} activities — {done} done · {going} under way · {acts.length - done - going} ahead</span>
          </div>
          {week && week.count > 0 && (
            <div style={{ fontSize: 12, color: C.bright, marginTop: 3 }}>
              this week: <b>{week.count}</b> activities · <b>{mh(Math.round(week.hours))}</b> ·
              ≈{week.crew} workers/day
            </div>
          )}
          {next?.planned && (
            <div style={{ fontSize: 12, marginTop: 3 }}>
              next up: <b style={{ fontFamily: "monospace" }}>{next.code}</b> starts{" "}
              <b>{fmtDay(next.planned.start)}</b>
              {next.compartment_no && <> in <b style={{ fontFamily: "monospace" }}>{next.compartment_no}</b></>}
            </div>
          )}
          {week && week.count === 0 && next === null && acts.length > 0 && (
            <div style={{ fontSize: 12, color: C.dim, marginTop: 3 }}>
              nothing scheduled this week and nothing ahead — the remaining work is under way or undated
            </div>
          )}

          {jobSpaces.length > 0 && (
            <>
              {h("Where — and whether the door is open")}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {jobSpaces.map((no) => {
                  const row = spaces.find((r) => r.compartment.compartment_no === no);
                  const bucket = row ? OVERLAY_STYLE[overlayBucket(row)] : null;
                  return (
                    <button
                      key={no}
                      onClick={() => onOpenSpace(no)}
                      title={bucket ? `${bucket.gloss} — open on the deck plan` : "Not in the register — open to see the coverage warning"}
                      style={{
                        font: "inherit", fontFamily: "monospace", fontSize: 10.5, cursor: "pointer",
                        padding: "2px 7px", borderRadius: 4,
                        color: bucket?.fg ?? C.dim, background: bucket?.bg ?? "transparent",
                        border: `1px solid ${bucket?.border ?? C.line}`,
                      }}
                    >
                      {no} {bucket && <b>{bucket.label}</b>}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {h("The plan, dated")}
          <div style={{ display: "flex", flexDirection: "column" }}>
            {acts.length === 0 && (
              <span style={{ fontSize: 11.5, color: C.dim }}>
                The register carries no activities for this code — its hours have no schedule
                behind them yet.
              </span>
            )}
            {acts.map((a) => {
              const refused = a.executability.verdict === "not_executable";
              return (
                <button
                  key={a.activity_id}
                  onClick={() => a.compartment_no && onOpenSpace(a.compartment_no)}
                  title={
                    refused && a.executability.verdict === "not_executable"
                      ? `Refused by ${a.executability.rule_code} — ${a.executability.hazard} in ${a.executability.origin}. Click to open the space and its options.`
                      : a.compartment_no
                        ? "Open this activity's space on the deck plan"
                        : "The schedule did not say where this happens"
                  }
                  style={{
                    display: "flex", gap: 7, alignItems: "baseline", textAlign: "left",
                    padding: "4px 2px", background: "transparent", border: "none",
                    borderBottom: `1px solid ${C.hairline}`, cursor: a.compartment_no ? "pointer" : "default",
                    font: "inherit", fontSize: 11.5, color: C.text,
                  }}
                >
                  <span style={{ color: ACTIVITY_STATUS[a.status].fg, fontSize: 9 }}>●</span>
                  <span style={{ fontFamily: "monospace", color: C.dim, minWidth: 52 }}>{a.code}</span>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {a.name}
                  </span>
                  <span style={{ fontFamily: "monospace", fontSize: 10, color: C.subtle, whiteSpace: "nowrap" }}>
                    {a.planned ? `${fmtDay(a.planned.start)}→${fmtDay(a.planned.end)}` : "undated"}
                  </span>
                  {refused && (
                    <span style={{ fontSize: 8.5, fontWeight: 700, color: C.dangerSoft, background: "rgba(220,38,38,0.14)", border: "1px solid rgba(220,38,38,0.5)", borderRadius: 3, padding: "0 4px" }}>
                      REFUSED
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {(refusals.length > 0 || myConflicts.length > 0) && (
            <>
              {h("Problems — and the route out")}
              {refusals.map((r) => (
                <div key={r.code} style={{ fontSize: 11.5, padding: "5px 8px", marginBottom: 5, borderRadius: 6, background: "rgba(220,38,38,0.07)", border: "1px solid rgba(220,38,38,0.35)" }}>
                  <b style={{ fontFamily: "monospace" }}>{r.code}</b> refused by <b>{r.rule}</b>
                  {r.space && <> in <b style={{ fontFamily: "monospace" }}>{r.space}</b></>} —{" "}
                  {r.clear !== null ? (
                    <>clears <b>{fmtDayTime(r.clear)}</b> on its own</>
                  ) : (
                    <>clears on verification by <b>{r.authority.replace(/_/g, " ")}</b> — someone has to go</>
                  )}
                  {r.space && (
                    <button
                      onClick={() => onOpenSpace(r.space ?? "")}
                      style={{ display: "block", marginTop: 3, font: "inherit", fontSize: 10.5, cursor: "pointer", color: C.accent, background: "transparent", border: "none", padding: 0, textDecoration: "underline" }}
                    >
                      Open the space for the evidence and the mitigation options →
                    </button>
                  )}
                </div>
              ))}
              {myConflicts.slice(0, 4).map((pr, i) => (
                <div key={i} style={{ fontSize: 11.5, padding: "5px 8px", marginBottom: 5, borderRadius: 6, background: "rgba(245,158,11,0.07)", border: "1px solid rgba(245,158,11,0.4)" }}>
                  ⚡ {pr.reason}
                </div>
              ))}
              {myConflicts.length > 4 && (
                <div style={{ fontSize: 10.5, color: C.dim }}>…and {myConflicts.length - 4} more pairs today</div>
              )}
            </>
          )}

          <div style={{ fontSize: 9.5, color: C.faint, marginTop: 12 }}>
            Everything above is served: verdicts from the register&apos;s executability, states from
            the engine, conflicts from today&apos;s pairs. Esc closes.
          </div>
        </>
      )}
    </aside>
  );
}
