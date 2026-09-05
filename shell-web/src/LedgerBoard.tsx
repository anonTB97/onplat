// The decisions ledger — the platform's memory, read back with its proof.
//
// Everything here was recorded at the moment somebody answered for something:
// a mitigation option accepted or rejected from a space's options panel, an
// issue acknowledged on the board. The screen's one non-negotiable is the
// verdict banner: the server re-hashes the whole chain on every read, and the
// entries are only shown under the result. A ledger screen that skipped that
// would be repeating the tamper-evidence claim on faith — and a broken chain
// is the single most important thing this screen could ever have to say.
//
// Entries are immutable and complete by design; what a row shows is a reading
// of its hashed detail, and the raw record is one click away, always.

import React, { useEffect, useState } from "react";
import { listLedger, type AuditEntry, type Identity, type LedgerReport } from "./api";
import { Loading } from "./Loading";
import { ModuleHeader } from "./ModuleHeader";
import { C } from "./theme";
import { fmtStamp } from "./clock";

/** How each recorded action reads at a glance. */
const ACTION_STYLE: Record<string, { label: string; fg: string; bg: string; border: string }> = {
  MITIGATION_ACCEPTED: {
    label: "OPTION ACCEPTED",
    fg: C.ok,
    bg: "rgba(34,197,94,0.10)",
    border: "rgba(34,197,94,0.45)",
  },
  MITIGATION_REJECTED: {
    label: "OPTION REJECTED",
    fg: C.warn,
    bg: "rgba(245,158,11,0.10)",
    border: "rgba(245,158,11,0.4)",
  },
  ISSUE_ACKNOWLEDGED: {
    label: "ISSUE ACKNOWLEDGED",
    fg: "#93b4ff",
    bg: "rgba(61,107,255,0.10)",
    border: "rgba(61,107,255,0.4)",
  },
};

const FALLBACK_STYLE = {
  label: "",
  fg: "#94a3b8",
  bg: "rgba(148,163,184,0.08)",
  border: "rgba(148,163,184,0.3)",
};

const fmtInstant = (ms: number): string =>
  fmtStamp(ms);

/** A compartment placard, e.g. `3-160-2-Q` — the shape that can route. */
const PLACARD = /^\d+-\d+-\d+-[A-Z]$/;

/** The space a subject can route to, if its shape names one. */
function routableSpace(subject: string | null): string | null {
  if (!subject) return null;
  if (PLACARD.test(subject)) return subject;
  // Issue keys carry their space last: `issue:held:3-148-2-E`.
  const tail = subject.split(":").at(-1) ?? "";
  return PLACARD.test(tail) ? tail : null;
}

/** One line of what the record says, read out of its hashed detail. */
function summarise(e: AuditEntry): string {
  try {
    const d = JSON.parse(e.detail) as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof d.disposition === "string") parts.push(d.disposition);
    if (typeof d.reason === "string" && d.reason) parts.push(`“${d.reason}”`);
    if (typeof d.note === "string" && d.note) parts.push(`“${d.note}”`);
    const issue = d.issue as Record<string, unknown> | undefined;
    if (issue && typeof issue.kind === "string") parts.push(`finding: ${issue.kind}`);
    // A document line names its kind and label: `yard_clock · CVN73-clock.csv`.
    if (typeof d.kind === "string") parts.push(d.kind);
    if (typeof d.label === "string" && d.label) parts.push(d.label);
    return parts.join(" · ") || "recorded without commentary";
  } catch {
    return e.detail.slice(0, 120);
  }
}

export default function LedgerBoard({
  identity,
  vesselId,
  hullLabel,
  onOpenSpace,
}: {
  identity: Identity;
  vesselId: string;
  hullLabel: string;
  onOpenSpace: (compartment: string) => void;
}) {
  const [report, setReport] = useState<LedgerReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openSeq, setOpenSeq] = useState<number | null>(null);

  useEffect(() => {
    setError(null);
    listLedger(identity, vesselId)
      .then(setReport)
      .catch((e: unknown) => {
        setReport(null);
        setError(String(e));
      });
  }, [identity, vesselId]);

  if (error) return <p style={{ color: C.danger }}>Ledger unavailable ({error}).</p>;
  if (!report) return <Loading label="Reading the ledger and re-hashing the chain…" />;

  const td: React.CSSProperties = {
    padding: "7px 10px",
    fontSize: 12,
    borderBottom: `1px solid ${C.hairline}`,
    verticalAlign: "top",
  };

  return (
    <div>
      <ModuleHeader
        kicker={`Decisions Ledger · ${hullLabel}`}
        title="What was answered for, on the record"
        stats={[
          { value: report.entries.length, label: report.entries.length === 1 ? "entry" : "entries" },
        ]}
        note="Every mitigation disposition and issue acknowledgement, append-only and hash-chained. Nothing here applies anything — the platform flags and prices, the yard acts; this is the part a board of inquiry asks about and the part no other system holds."
      />

      {/* The verdict, before the entries. */}
      {report.verified ? (
        <div style={{ display: "inline-flex", gap: 8, alignItems: "center", padding: "6px 12px", marginBottom: 12, borderRadius: 7, fontSize: 12, color: C.ok, background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.4)" }}>
          ✓ chain verifies — {report.entries.length}{" "}
          {report.entries.length === 1 ? "entry" : "entries"}, re-hashed end to end on this read
        </div>
      ) : (
        <div style={{ display: "inline-flex", gap: 8, alignItems: "center", padding: "6px 12px", marginBottom: 12, borderRadius: 7, fontSize: 12, fontWeight: 700, color: "#f87171", background: "rgba(220,38,38,0.10)", border: "1px solid rgba(220,38,38,0.5)" }}>
          ✗ CHAIN BROKEN at seq {report.break?.seq}
          {report.break?.reason === "hash_mismatch"
            ? " — an entry's own fields were altered"
            : " — an entry was inserted, removed or reordered"}
          ; nothing below that point can be trusted
        </div>
      )}

      {report.entries.length === 0 ? (
        <p style={{ color: C.dim, fontSize: 12.5 }}>
          Nothing recorded yet. Decisions land here from a space&apos;s options
          panel; acknowledgements from the Conflicts &amp; Risk board.
        </p>
      ) : (
        <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 8 }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 900 }}>
            <tbody>
              {report.entries.map((e) => {
                const style = ACTION_STYLE[e.action] ?? { ...FALLBACK_STYLE, label: e.action };
                const space = routableSpace(e.subject_ref);
                const open = openSeq === e.seq;
                return (
                  <React.Fragment key={e.seq}>
                    <tr
                      onClick={() => setOpenSeq(open ? null : e.seq)}
                      style={{ cursor: "pointer", background: open ? "#14151b" : undefined }}
                      title="Click for the full record as hashed"
                    >
                      <td style={{ ...td, color: C.dim, fontVariantNumeric: "tabular-nums", width: 40 }}>
                        #{e.seq}
                      </td>
                      <td style={{ ...td, whiteSpace: "nowrap", fontFamily: "monospace", fontSize: 10.5, color: C.dim, width: 130 }}>
                        {fmtInstant(e.occurred_at_ms)}
                      </td>
                      <td style={{ ...td, whiteSpace: "nowrap", width: 175 }}>
                        <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4, padding: "2px 7px", borderRadius: 4, color: style.fg, background: style.bg, border: `1px solid ${style.border}` }}>
                          {style.label}
                        </span>
                      </td>
                      <td style={{ ...td, whiteSpace: "nowrap", width: 160, fontFamily: "monospace", fontSize: 11 }}>
                        {space ? (
                          <button
                            onClick={(ev) => {
                              ev.stopPropagation();
                              onOpenSpace(space);
                            }}
                            title="Open the space this record is about"
                            style={{
                              font: "inherit", fontSize: 10.5, fontFamily: "monospace", cursor: "pointer",
                              padding: "1px 6px", borderRadius: 4, color: C.bright,
                              background: "rgba(148,163,184,0.08)", border: `1px solid ${C.line}`,
                            }}
                          >
                            {e.subject_ref}
                          </button>
                        ) : (
                          <span style={{ color: C.dim }}>{e.subject_ref ?? "—"}</span>
                        )}
                      </td>
                      <td style={{ ...td, minWidth: 240, color: C.bright }}>{summarise(e)}</td>
                      <td
                        style={{ ...td, whiteSpace: "nowrap", fontFamily: "monospace", fontSize: 10, color: C.faint, width: 110 }}
                        title={`entry ${e.entry_hash}\nprev  ${e.prev_hash ?? "genesis"}`}
                      >
                        {e.entry_hash.slice(0, 10)}…
                      </td>
                    </tr>
                    {open && (
                      <tr style={{ background: "#101116" }}>
                        <td colSpan={6} style={{ ...td, padding: "4px 14px 10px" }}>
                          <pre style={{ margin: 0, fontSize: 10.5, color: "#8b93a2", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                            {(() => {
                              try {
                                return JSON.stringify(JSON.parse(e.detail), null, 2);
                              } catch {
                                return e.detail;
                              }
                            })()}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
