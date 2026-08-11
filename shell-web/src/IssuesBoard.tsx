// The Issues board — the front door the attack plan promised: one screen where
// issues arrive ranked by man-hours at risk, and every row is a door to its
// fix.
//
// Nobody arrives at a planning tool knowing an action; they arrive knowing a
// problem. The Actions tab beside this one answers "what is worth doing"; this
// answers "what is wrong" — and every row routes to the space with its trace
// and options open, which is where a choice is recorded.

import { useEffect, useState } from "react";
import { listIssues, type AsOf, type Identity, type Issue } from "./api";
import { C, fmtClear, mh } from "./theme";

export const KIND: Record<
  Issue["kind"],
  { label: string; fg: string; bg: string; border: string }
> = {
  compound_hold: {
    label: "COMPOUND HOLD",
    fg: "#fca5a5",
    bg: "rgba(239,68,68,0.12)",
    border: "rgba(239,68,68,0.45)",
  },
  held_with_crews_booked: {
    label: "HELD · CREWS BOOKED",
    fg: "#fca5a5",
    bg: "rgba(239,68,68,0.12)",
    border: "rgba(239,68,68,0.45)",
  },
  not_executable_as_planned: {
    label: "NOT EXECUTABLE",
    fg: "#fbbf24",
    bg: "rgba(245,158,11,0.10)",
    border: "rgba(245,158,11,0.4)",
  },
  stranding_concentration: {
    label: "STRANDING",
    fg: "#c4b5fd",
    bg: "rgba(139,92,246,0.12)",
    border: "rgba(139,92,246,0.4)",
  },
  negative_lag: {
    label: "SCHEDULE QUALITY",
    fg: "#94a3b8",
    bg: "rgba(148,163,184,0.08)",
    border: "rgba(148,163,184,0.3)",
  },
};

const fmtInstant = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 16).replace("-", "/").replace("T", " ");

/** What the issue is, in one line a planner can repeat in a meeting. */
export function claim(i: Issue): string {
  switch (i.kind) {
    case "not_executable_as_planned":
      return `${i.activity} — ${i.name}`;
    case "held_with_crews_booked":
      return `${i.compartment} refuses work with crews booked into it`;
    case "compound_hold":
      return `${i.compartment} needs ${i.plan_actions > 0 ? `a ${i.plan_actions}-action plan` : "a plan nothing yet satisfies"} — no single action opens it`;
    case "stranding_concentration":
      return `${i.compartment} is stranding ${i.downstream_segments} downstream segment${i.downstream_segments === 1 ? "" : "s"}`;
    case "negative_lag":
      return `${i.pred} → ${i.succ} overlap ${-i.lag_hours} h`;
  }
}

/** The evidence line: why the platform is entitled to the claim above. */
function evidence(i: Issue): string {
  switch (i.kind) {
    case "not_executable_as_planned":
      return (
        `${i.trade} · refused from ${fmtInstant(i.refusal.at)} in its planned window — ` +
        `${i.refusal.rule_code} · ${i.refusal.hazard} @ ${i.refusal.origin} · ` +
        (i.refusal.earliest_clear
          ? `clears ${fmtInstant(i.refusal.earliest_clear)}`
          : `clears on verification by ${i.refusal.clearing_authority}`)
      );
    case "held_with_crews_booked":
      return (
        `${i.state} · ` +
        (i.earliest_clear
          ? `clears ${fmtClear(i.earliest_clear)} on its own`
          : `needs ${i.clearing_authority} — never elapses on a clock`)
      );
    case "compound_hold":
      return `${i.holds} independent holds pin it; the options panel carries the plan`;
    case "stranding_concentration":
      return `${mh(i.own_remaining)} of its own work is holding test-ready hours elsewhere`;
    case "negative_lag":
      return "the successor starts before its predecessor finishes — legitimate as an overlap, exactly where cure inversions hide";
  }
}

/** Where the fix lives: the space whose options panel answers this issue. */
export function fixSpace(i: Issue): string | null {
  switch (i.kind) {
    case "not_executable_as_planned":
    case "held_with_crews_booked":
    case "compound_hold":
    case "stranding_concentration":
      return i.compartment;
    case "negative_lag":
      return null;
  }
}

export default function IssuesBoard({
  identity,
  vesselId,
  asOf,
  onOpenSpace,
}: {
  identity: Identity;
  vesselId: string;
  asOf: AsOf;
  onOpenSpace: (compartment: string) => void;
}) {
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    listIssues(identity, vesselId, asOf)
      .then((r) => setIssues(r.issues))
      .catch((e: unknown) => {
        setIssues(null);
        setError(String(e));
      });
  }, [identity, vesselId, asOf]);

  if (error) return <p style={{ color: C.danger }}>Issues unavailable ({error}).</p>;
  if (!issues) return null;

  if (issues.length === 0) {
    return (
      <p style={{ color: C.dim, fontSize: 12.5 }}>
        No issues at this instant: nothing held with crews booked, every activity
        executable as planned, nothing stranded. Scrub the clock to test another
        moment.
      </p>
    );
  }

  const td: React.CSSProperties = {
    padding: "8px 10px",
    fontSize: 12.5,
    borderBottom: "1px solid #191a1f",
    verticalAlign: "top",
  };

  return (
    <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 8 }}>
      <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 860 }}>
        <tbody>
          {issues.map((i, idx) => {
            const k = KIND[i.kind];
            const space = fixSpace(i);
            return (
              <tr
                key={`${i.kind}-${idx}`}
                style={{ background: idx === 0 ? "rgba(61,107,255,0.06)" : undefined }}
              >
                <td style={{ ...td, color: idx === 0 ? C.accent : C.dim, fontWeight: 700, width: 26 }}>
                  {idx + 1}
                </td>
                <td style={{ ...td, whiteSpace: "nowrap", width: 170 }}>
                  <span
                    style={{
                      fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4, padding: "2px 7px",
                      borderRadius: 4, color: k.fg, background: k.bg, border: `1px solid ${k.border}`,
                    }}
                  >
                    {k.label}
                  </span>
                </td>
                <td style={{ ...td, minWidth: 260 }}>
                  <div style={{ fontWeight: 600 }}>{claim(i)}</div>
                  <div style={{ color: C.dim, fontSize: 11, marginTop: 2 }}>{evidence(i)}</div>
                </td>
                <td
                  style={{
                    ...td, textAlign: "right", whiteSpace: "nowrap",
                    fontVariantNumeric: "tabular-nums", fontWeight: 700,
                    color: i.hours_at_risk > 0 ? "#f87171" : C.dim,
                  }}
                  title="Man-hours at risk if this issue is ignored — the ranking key."
                >
                  {mh(i.hours_at_risk)}
                </td>
                <td style={{ ...td, whiteSpace: "nowrap", width: 130 }}>
                  {space ? (
                    <button
                      onClick={() => onOpenSpace(space)}
                      title="Open the space with its trace and options — where a decision is recorded."
                      style={{
                        font: "inherit", fontSize: 11, cursor: "pointer", padding: "3px 9px",
                        borderRadius: 5, color: C.text, background: "#20222b",
                        border: `1px solid ${C.accent}`,
                      }}
                    >
                      Route to fix →
                    </button>
                  ) : (
                    <span style={{ color: C.dim, fontSize: 11 }} title="A schedule finding — the fix is a re-sequence in the schedule of record, not a space.">
                      re-sequence
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
