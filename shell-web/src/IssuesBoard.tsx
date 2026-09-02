// The Issues board — the front door the attack plan promised: one screen where
// issues arrive ranked by man-hours at risk, and every row is a door to its
// fix.
//
// Nobody arrives at a planning tool knowing an action; they arrive knowing a
// problem. The Actions tab beside this one answers "what is worth doing"; this
// answers "what is wrong" — and every row routes to the space with its trace
// and options open, which is where a choice is recorded.

import { useEffect, useState } from "react";
import { acknowledgeIssue, listIssues, type AsOf, type Identity, type Issue } from "./api";
import { Loading } from "./Loading";
import { chipStyle, C, fmtClear, mh, STATE_STYLE } from "./theme";

/**
 * Persona-shaped cuts of the board. Each lens is the subset of kinds one job
 * actually answers for — a cut, never a different derivation: the same ranked
 * rows, narrowed to whose morning they belong to.
 */
const LENSES = [
  { id: "all", label: "All", kinds: null },
  {
    id: "holds",
    label: "Holds · zone manager",
    kinds: ["held_with_crews_booked", "compound_hold"],
  },
  {
    id: "plan",
    label: "Plan · scheduler",
    kinds: ["not_executable_as_planned", "negative_lag"],
  },
  {
    id: "flow",
    label: "Flow · test lead",
    kinds: ["stranding_concentration"],
  },
] as const;
type LensId = (typeof LENSES)[number]["id"];

export const KIND: Record<
  Issue["kind"],
  { label: string; fg: string; bg: string; border: string }
> = {
  compound_hold: {
    label: "COMPOUND HOLD",
    fg: C.dangerSoft,
    bg: "rgba(239,68,68,0.12)",
    border: "rgba(239,68,68,0.45)",
  },
  held_with_crews_booked: {
    label: "HELD · CREWS BOOKED",
    fg: C.dangerSoft,
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

import { fmtDay, fmtDayTime } from "./clock";

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
        `${i.trade} · refused from ${fmtDayTime(i.refusal.at)} in its planned window — ` +
        `${i.refusal.rule_code} · ${i.refusal.hazard} @ ${i.refusal.origin} · ` +
        (i.refusal.earliest_clear
          ? `clears ${fmtDayTime(i.refusal.earliest_clear)}`
          : `clears on verification by ${i.refusal.clearing_authority}`)
      );
    case "held_with_crews_booked":
      return (
        `${STATE_STYLE[i.state].label} (${i.state}) · ` +
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
  const [lens, setLens] = useState<LensId>("all");
  const [openOnly, setOpenOnly] = useState(false);
  const [ackFor, setAckFor] = useState<string | null>(null);
  const [ackNote, setAckNote] = useState("");
  const [ackErr, setAckErr] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    setError(null);
    listIssues(identity, vesselId, asOf)
      .then((r) => setIssues(r.issues))
      .catch((e: unknown) => {
        setIssues(null);
        setError(String(e));
      });
  }, [identity, vesselId, asOf, reloadNonce]);

  if (error) return <p style={{ color: C.danger }}>Issues unavailable ({error}).</p>;
  if (!issues) return <Loading label="Deriving the board…" />;

  if (issues.length === 0) {
    return (
      <p style={{ color: C.dim, fontSize: 12.5 }}>
        No issues at this instant: nothing held with crews booked, every activity
        executable as planned, nothing stranded. Scrub the clock to test another
        moment.
      </p>
    );
  }

  const answered = (i: Issue) => i.acknowledged !== null || i.decision !== null;
  const answeredCount = issues.filter(answered).length;
  const lensKinds = LENSES.find((l) => l.id === lens)?.kinds ?? null;
  // The lens and the open-only cut are the reader's own questions — user
  // filters, unlike the instant, which only ever marks. Rank order is the
  // server's and survives every cut.
  const shown = issues.filter(
    (i) =>
      (lensKinds === null || (lensKinds as readonly string[]).includes(i.kind)) &&
      (!openOnly || !answered(i)),
  );

  const td: React.CSSProperties = {
    padding: "8px 10px",
    fontSize: 12.5,
    borderBottom: `1px solid ${C.hairline}`,
    verticalAlign: "top",
  };
  const chip = chipStyle;

  const submitAck = (key: string) => {
    setAckErr(null);
    acknowledgeIssue(identity, vesselId, key, ackNote.trim())
      .then(() => {
        setAckFor(null);
        setAckNote("");
        setReloadNonce((n) => n + 1);
      })
      .catch((e: unknown) => setAckErr(String(e)));
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
        {LENSES.map((l) => (
          <button
            key={l.id}
            style={chip(lens === l.id)}
            onClick={() => setLens(l.id)}
            title={l.kinds === null ? "Every issue, every job" : "The kinds this job answers for — a cut of the same ranked board, not a different derivation"}
          >
            {l.label}
          </button>
        ))}
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: C.dim, cursor: "pointer" }}>
          <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />
          Open only
        </label>
        <span style={{ marginLeft: "auto", fontSize: 11.5, color: C.dim }}>
          {shown.length} shown · {issues.length - answeredCount} open ·{" "}
          <span title="Acknowledged on this board, or carrying a mitigation decision recorded from the space's options panel — joined from the audit ledger.">
            {answeredCount} answered for
          </span>
        </span>
      </div>

      <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 8 }}>
      <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 860 }}>
        <tbody>
          {shown.map((i, idx) => {
            const k = KIND[i.kind];
            const space = fixSpace(i);
            const done = answered(i);
            return (
              <tr
                key={i.key}
                style={{
                  background: idx === 0 && !done ? "rgba(61,107,255,0.06)" : undefined,
                  // Marked, never hidden: an answered issue still derives; it
                  // reads quieter because somebody has already spoken for it.
                  opacity: done ? 0.62 : 1,
                }}
              >
                <td style={{ ...td, color: idx === 0 && !done ? C.accent : C.dim, fontWeight: 700, width: 26 }}>
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
                  {i.decision && (
                    <div style={{ fontSize: 10.5, marginTop: 3, color: i.decision.disposition === "accepted" ? C.ok : C.warn }}>
                      ⚖ option {i.decision.disposition} {fmtDay(i.decision.at)}
                      {i.decision.reason ? ` — ${i.decision.reason}` : ""}
                      <span style={{ color: C.dim }}> · from the space's options panel, in the ledger</span>
                    </div>
                  )}
                  {i.acknowledged && (
                    <div style={{ fontSize: 10.5, marginTop: 3, color: C.ok }}>
                      ✓ acknowledged {fmtDay(i.acknowledged.at)}
                      {i.acknowledged.note ? ` — ${i.acknowledged.note}` : ""}
                    </div>
                  )}
                  {ackFor === i.key && (
                    <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 5 }}>
                      <input
                        autoFocus
                        value={ackNote}
                        onChange={(e) => setAckNote(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") submitAck(i.key); if (e.key === "Escape") setAckFor(null); }}
                        placeholder="Why / what was said — goes to the ledger"
                        style={{
                          font: "inherit", fontSize: 11, padding: "3px 8px", minWidth: 260,
                          background: "#0b0c0e", color: C.text, border: `1px solid ${C.line}`, borderRadius: 5,
                        }}
                      />
                      <button style={chip(true)} onClick={() => submitAck(i.key)}>Record</button>
                      <button style={chip(false)} onClick={() => { setAckFor(null); setAckErr(null); }}>Cancel</button>
                      {ackErr && <span style={{ fontSize: 10.5, color: C.danger }}>{ackErr}</span>}
                    </div>
                  )}
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
                <td style={{ ...td, whiteSpace: "nowrap", width: 210 }}>
                  {space ? (
                    <button
                      onClick={() => onOpenSpace(space)}
                      title="Open the space with its trace and options — where a decision is recorded."
                      style={{
                        font: "inherit", fontSize: 11, cursor: "pointer", padding: "3px 9px",
                        borderRadius: 5, color: C.text, background: C.raised,
                        border: `1px solid ${C.accent}`,
                      }}
                    >
                      Route to fix →
                    </button>
                  ) : (
                    <span
                      title="A schedule finding — the fix is a re-sequence in the schedule of record, not a space."
                      style={{
                        display: "inline-block", fontSize: 11, padding: "3px 9px",
                        borderRadius: 5, color: C.dim, background: "rgba(148,163,184,0.06)",
                        border: `1px dashed ${C.line}`,
                      }}
                    >
                      re-sequence in P6
                    </span>
                  )}
                  {!i.acknowledged && (
                    <button
                      onClick={() => { setAckFor(ackFor === i.key ? null : i.key); setAckNote(""); setAckErr(null); }}
                      title="Record in the audit ledger that somebody answered for this issue. Closes and hides nothing — the row stays as long as its facts hold."
                      style={{
                        font: "inherit", fontSize: 11, cursor: "pointer", padding: "3px 4px", marginLeft: 8,
                        borderRadius: 5, color: C.dim, background: "transparent",
                        border: "1px solid transparent", textDecoration: "underline",
                        textDecorationColor: "#3a3d49", textUnderlineOffset: 3,
                      }}
                    >
                      acknowledge
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </div>
  );
}
