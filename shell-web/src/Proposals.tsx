// The Proposals view: every schedule change proposed from this board, with
// where each stands, and the change request that goes back to P6.
//
// This is the return half of the loop the Sequence Board opens. A refusal on
// the board becomes a proposal in the inspector; the proposal is checked by
// the engine and lands in the ledger; this view lists them with a status the
// SERVED schedule decides (open, reflected, superseded, dropped, withdrawn —
// derived on every read, never stored); the change request exports in the
// column layout P6's activity import reads; and the next XER import says
// which proposals P6 took, at the door, before Confirm. Nothing here moves a
// date: P6 stays the scheduler of record, and this board stays honest about
// what it asked for and what came back.

import { useState } from "react";
import {
  withdrawProposal,
  type Identity,
  type ProposalList,
  type ProposalStatus,
  type ScheduleProposal,
} from "./api";
import { fmtDay, fmtDayTime } from "./clock";
import { Loading } from "./Loading";
import { C, chipStyle, tdStyle, thStyle } from "./theme";

const STATUS: Record<ProposalStatus, { label: string; tone: string; gloss: string }> = {
  open: { label: "OPEN", tone: C.accent, gloss: "Proposed; the served schedule still carries the activity where it was." },
  reflected: { label: "REFLECTED", tone: C.ok, gloss: "The served schedule now carries the proposed days — P6 took it." },
  superseded: { label: "SUPERSEDED", tone: C.warn, gloss: "The activity moved, but not to the proposal." },
  dropped: { label: "DROPPED", tone: C.dim, gloss: "The activity is no longer on the register." },
  withdrawn: { label: "WITHDRAWN", tone: C.dim, gloss: "Taken back by a later ledger entry; the original stays in the chain." },
};

const KIND: Record<ScheduleProposal["kind"], string> = {
  engine_window: "engine's window",
  manual: "planner's window",
  hold_pending_verification: "hold pending verification",
};

/** P6's date spelling, UTC: `YYYY-MM-DD HH:MM`. */
const p6Date = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/** The as-of stamp a file carries in its name. */
const stamp = (ms: number | null): string =>
  ms === null ? "" : `-asof-${new Date(ms).toISOString().slice(0, 16).replace(/[:T]/g, "")}`;

function downloadText(lines: string[], filename: string, type: string): void {
  const blob = new Blob([lines.join("\n")], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

const esc = (v: string) => `"${v.replaceAll('"', '""')}"`;

/**
 * The change request, in the column layout P6's activity import reads:
 * Activity ID, Activity Name, Start, Finish, Primary Constraint and its date —
 * then this board's own columns (why, the engine's verdict, the knock-on,
 * the ledger entry) so the request carries its evidence.
 */
export function changeRequestCsv(
  rows: ScheduleProposal[],
  hullLabel: string,
  source: string | null,
  asOf: number | null,
): string[] {
  const head = [
    `# Schedule change request — ${hullLabel} — schedule of record: ${source ?? "the generated demo register"}`,
    `# produced by Shipyard AI Onboard${asOf !== null ? ` as of ${fmtDayTime(asOf)}` : ""} · ${rows.length} open proposal${rows.length === 1 ? "" : "s"}`,
    "# Columns 1–6 are P6's activity-import layout (Start/Finish UTC, constraint Start On or After). Nothing here has been applied; P6 decides.",
    "Activity ID,Activity Name,Start,Finish,Primary Constraint,Primary Constraint Date,Delay Days,Kind,Reason,Engine Verdict,Knock-on,Proposed At,Ledger Seq,Ledger Hash",
  ];
  const body = rows.map((p) => {
    const delay = p.to && p.from ? Math.round((p.to.start - p.from.start) / 86_400_000) : "";
    const verdict =
      p.verdict === null
        ? "no date promised"
        : p.verdict.verdict === "executable"
          ? "executable"
          : p.verdict.verdict === "not_executable"
            ? `refused by ${p.verdict.rule_code} @ ${p.verdict.origin}`
            : "unassessable";
    return [
      p.activity,
      esc(p.name),
      p.to ? p6Date(p.to.start) : "",
      p.to ? p6Date(p.to.end) : "",
      p.to ? "Start On or After" : "Hold pending verification",
      p.to ? p6Date(p.to.start) : "",
      String(delay),
      p.kind,
      esc(p.reason),
      esc(verdict),
      esc(p.pushes.join(" ")),
      p6Date(p.proposed_at_ms),
      String(p.seq),
      p.entry_hash,
    ].join(",");
  });
  return [...head, ...body];
}

export function ProposalsPanel({
  identity,
  vesselId,
  hullLabel,
  list,
  source,
  asOf,
  onChanged,
  onInspect,
}: {
  identity: Identity;
  vesselId: string;
  hullLabel: string;
  list: ProposalList | null;
  source: string | null;
  asOf: number | null;
  /** A withdrawal landed — refetch. */
  onChanged: () => void;
  /** Opens the activity's inspector. */
  onInspect: (code: string) => void;
}) {
  const [filter, setFilter] = useState<ProposalStatus | "all">("all");
  const [withdrawing, setWithdrawing] = useState<{ seq: number; reason: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  if (!list) return <Loading label="Reading the proposals…" />;
  const rows = list.proposals.filter((p) => filter === "all" || p.status === filter);
  const open = list.proposals.filter((p) => p.status === "open");
  const chip = chipStyle;
  const td: React.CSSProperties = { ...tdStyle, padding: "6px 10px", fontSize: 11.5 };
  const th: React.CSSProperties = { ...thStyle, position: "sticky", top: 0, background: C.panel };

  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        <button style={chip(filter === "all")} onClick={() => setFilter("all")} title="Every proposal in the ledger">
          All {list.proposals.length}
        </button>
        {(Object.keys(STATUS) as ProposalStatus[]).map((s) => (
          <button
            key={s}
            style={{ ...chip(filter === s), ...(list.counts[s] > 0 ? { borderColor: STATUS[s].tone } : {}) }}
            onClick={() => setFilter(filter === s ? "all" : s)}
            title={STATUS[s].gloss}
          >
            <span style={{ color: STATUS[s].tone }}>■</span> {STATUS[s].label.toLowerCase()} {list.counts[s]}
          </button>
        ))}
        <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {msg && <span style={{ fontSize: 11, color: msg.startsWith("✓") ? C.ok : C.danger }}>{msg}</span>}
          <button
            style={{ ...chip(false), ...(open.length > 0 ? { color: C.accent, borderColor: C.accent } : {}) }}
            disabled={open.length === 0}
            title="Download the open proposals as a change request in P6's activity-import column layout (Activity ID, Start, Finish, Primary Constraint, …), with this board's reason, verdict, knock-on and ledger entry alongside. Import it in P6 with Import → Spreadsheet, or hand it to the scheduler."
            onClick={() => downloadText(changeRequestCsv(open, hullLabel, source, asOf), `p6-change-request-${hullLabel.replace(/\s+/g, "-")}${stamp(asOf)}.csv`, "text/csv")}
          >
            ⭳ P6 change request ({open.length})
          </button>
        </span>
      </div>

      <p style={{ fontSize: 11, color: C.dim, margin: "0 0 10px", maxWidth: 900 }}>
        {list.status_basis}. Nothing here has been applied — P6 stays the scheduler of record. The next XER
        import names, before Confirm, which of these it reflects.
      </p>

      {rows.length === 0 ? (
        <p style={{ fontSize: 12.5, color: C.dim }}>
          {list.proposals.length === 0
            ? "No proposals yet. Open a refused row — the inspector's “Propose to P6” block turns the engine's alternative, a window of your own, or a hold pending verification into a proposal the ledger remembers."
            : "Nothing with that status."}
        </p>
      ) : (
        <div style={{ overflow: "auto", maxHeight: "calc(100vh - 360px)", border: `1px solid ${C.line}`, borderRadius: 8 }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 1100 }}>
            <thead>
              <tr>
                {["#", "Activity", "Kind", "From", "To", "Engine", "Knock-on", "Reason", "Proposed", "Status", ""].map((h) => (
                  <th key={h} style={th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const st = STATUS[p.status];
                const v = p.verdict;
                return (
                  <tr key={p.seq} style={{ opacity: p.status === "withdrawn" || p.status === "dropped" ? 0.6 : 1 }}>
                    <td style={{ ...td, fontFamily: "monospace", color: C.dim }} title={`ledger entry ${p.seq} · ${p.entry_hash.slice(0, 12)}…`}>{p.seq}</td>
                    <td style={td}>
                      <button
                        onClick={() => onInspect(p.activity)}
                        title="Open the activity's inspector"
                        style={{ font: "inherit", fontSize: 11.5, fontFamily: "monospace", cursor: "pointer", color: C.accent, background: "transparent", border: "none", padding: 0, textDecoration: "underline", textUnderlineOffset: 2 }}
                      >
                        {p.activity}
                      </button>
                      <div style={{ fontSize: 10.5, color: C.dim, maxWidth: 260 }}>{p.name}{p.compartment ? ` · ${p.compartment}` : ""}</div>
                    </td>
                    <td style={{ ...td, color: C.dim, whiteSpace: "nowrap" }}>{KIND[p.kind]}</td>
                    <td style={{ ...td, fontFamily: "monospace", fontSize: 10.5, whiteSpace: "nowrap", color: C.dim }}>
                      {p.from ? `${fmtDay(p.from.start)} → ${fmtDay(p.from.end)}` : "no dates"}
                    </td>
                    <td style={{ ...td, fontFamily: "monospace", fontSize: 10.5, whiteSpace: "nowrap" }}>
                      {p.to ? `${fmtDay(p.to.start)} → ${fmtDay(p.to.end)}` : <span style={{ color: "#c4b5fd" }}>hold — no date</span>}
                      {p.to && p.from && (
                        <span style={{ color: C.dim }}> · {Math.round((p.to.start - p.from.start) / 86_400_000) >= 0 ? "+" : ""}{Math.round((p.to.start - p.from.start) / 86_400_000)}d</span>
                      )}
                    </td>
                    <td style={{ ...td, fontSize: 10.5, whiteSpace: "nowrap" }}>
                      {v === null ? (
                        <span style={{ color: C.dim }}>—</span>
                      ) : v.verdict === "executable" ? (
                        <span style={{ color: C.ok }} title="The engine accepts the proposed window under the hazards live at the instant.">✓ accepts</span>
                      ) : v.verdict === "not_executable" ? (
                        <span style={{ color: C.danger }} title={`Still refused: ${v.rule_code} · ${v.hazard} @ ${v.origin}`}>⚠ {v.rule_code} @ {v.origin}</span>
                      ) : (
                        <span style={{ color: C.dim }}>unassessable</span>
                      )}
                    </td>
                    <td style={{ ...td, fontSize: 10.5, color: p.pushes.length > 0 ? C.warn : C.dim }} title={p.knock_on_basis}>
                      {p.pushes.length > 0 ? p.pushes.join(", ") : "none"}
                    </td>
                    <td style={{ ...td, maxWidth: 260 }}>{p.reason}</td>
                    <td style={{ ...td, fontFamily: "monospace", fontSize: 10.5, whiteSpace: "nowrap", color: C.dim }}>{fmtDayTime(p.proposed_at_ms)}</td>
                    <td style={{ ...td, fontSize: 10, fontWeight: 700, whiteSpace: "nowrap" }}>
                      <span style={{ color: st.tone }} title={st.gloss}>{st.label}</span>
                      {p.status === "superseded" && p.planned_now && (
                        <div style={{ fontSize: 10, fontWeight: 400, color: C.dim }}>now {fmtDay(p.planned_now.start)}</div>
                      )}
                    </td>
                    <td style={{ ...td, whiteSpace: "nowrap" }}>
                      {p.status === "open" && withdrawing?.seq !== p.seq && (
                        <button
                          onClick={() => setWithdrawing({ seq: p.seq, reason: "" })}
                          title="Take this proposal back — a later ledger entry; the original stays in the chain."
                          style={{ font: "inherit", fontSize: 10.5, cursor: "pointer", padding: "2px 7px", borderRadius: 4, color: C.dim, background: "transparent", border: `1px solid ${C.line}` }}
                        >
                          Withdraw
                        </button>
                      )}
                      {withdrawing?.seq === p.seq && (
                        <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                          <input
                            value={withdrawing.reason}
                            onChange={(e) => setWithdrawing({ seq: p.seq, reason: e.target.value })}
                            placeholder="why"
                            style={{ font: "inherit", fontSize: 10.5, padding: "2px 6px", width: 120, background: "#0b0c0e", color: C.text, border: `1px solid ${C.line}`, borderRadius: 4 }}
                          />
                          <button
                            onClick={() => {
                              setMsg(null);
                              void withdrawProposal(identity, vesselId, p.seq, withdrawing.reason)
                                .then(() => {
                                  setMsg(`✓ proposal #${p.seq} withdrawn`);
                                  setWithdrawing(null);
                                  onChanged();
                                })
                                .catch((e: unknown) => setMsg(String(e instanceof Error ? e.message : e)));
                            }}
                            style={{ font: "inherit", fontSize: 10.5, cursor: "pointer", padding: "2px 7px", borderRadius: 4, color: C.danger, background: "transparent", border: `1px solid ${C.danger}66` }}
                          >
                            Confirm
                          </button>
                          <button
                            onClick={() => setWithdrawing(null)}
                            style={{ font: "inherit", fontSize: 10.5, cursor: "pointer", padding: "2px 6px", borderRadius: 4, color: C.dim, background: "transparent", border: `1px solid ${C.line}` }}
                          >
                            ✕
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
