// The activity inspector: click any work item, get everything the platform
// knows about it, in place — no jumping between screens to answer "what am I
// looking at, why is it red, and what would we do about it".
//
// Four blocks, worst news first: the facts (where, when, whose, how many
// hours); the executability verdict with its evidence; the SUGGESTED
// ALTERNATIVE — the engine's own re-sequence proposal from the
// schedule-alternatives endpoint, never a heuristic; and the space's
// mitigation options from the same assessment the Deck Explorer shows, so
// this panel and that one can never disagree. Every proposal is labelled as
// a proposal: re-sequencing happens in P6, deciding happens on the space's
// options panel, and the ledger remembers.

import { useEffect, useState } from "react";
import {
  mitigations,
  proposeScheduleChange,
  type Activity,
  type AlternativeRow,
  type AsOf,
  type Assessment,
  type Identity,
  type ScheduleProposal,
} from "./api";
import { actionTitle } from "./Mitigations";
import { C, mh } from "./theme";

import { fmtDay, fmtDayTime } from "./clock";

const label: React.CSSProperties = {
  fontSize: 9, fontWeight: 700, letterSpacing: 0.7, textTransform: "uppercase",
  color: C.subtle,
};
const block: React.CSSProperties = {
  border: `1px solid ${C.line}`, borderRadius: 7, padding: "8px 10px",
  display: "flex", flexDirection: "column", gap: 4,
};
const proposeBtn = (tone: string): React.CSSProperties => ({
  font: "inherit", fontSize: 11, cursor: "pointer", padding: "3px 9px", borderRadius: 5,
  color: tone, background: "transparent", border: `1px solid ${tone}66`,
});

export function ActivityInspector({
  a,
  alt,
  altsSettled,
  identity,
  vesselId,
  asOf,
  onClose,
  onOpenSpace,
  onOpenJob,
  onProposed,
}: {
  a: Activity;
  /** A proposal landed in the ledger — the board's Proposals view should refetch. */
  onProposed?: (p: ScheduleProposal) => void;
  /** The engine's re-sequence proposal for this activity, when it is refused. */
  alt: AlternativeRow | undefined;
  /** Whether the alternatives fetch has finished (either way) — so "Computing…"
   *  can honestly become "unavailable" instead of spinning forever. */
  altsSettled: boolean;
  identity: Identity;
  vesselId: string;
  asOf: AsOf;
  onClose: () => void;
  onOpenSpace: (compartment: string) => void;
  /** Opens the job card for this activity's work item. */
  onOpenJob?: (code: string) => void;
}) {
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [optionsError, setOptionsError] = useState(false);
  // The proposal form: a reason (pressed for), an optional start of the
  // planner's own, and what came back. Reset when the row changes — a reason
  // written for one activity must not ride along to the next.
  const [reason, setReason] = useState("");
  const [manualStart, setManualStart] = useState("");
  const [busy, setBusy] = useState(false);
  const [proposed, setProposed] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    setReason("");
    setManualStart("");
    setProposed(null);
  }, [a.activity_id]);

  // A drawer closes on Escape — the norm every menu in this app already keeps.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The space's options, from the same endpoint the Deck Explorer reads.
  useEffect(() => {
    setAssessment(null);
    setOptionsError(false);
    const no = a.compartment_no;
    if (!no) return undefined;
    let stale = false;
    mitigations(identity, vesselId, no, asOf)
      .then((r) => {
        if (!stale) setAssessment(r);
      })
      .catch(() => {
        if (!stale) setOptionsError(true);
      });
    return () => {
      stale = true;
    };
  }, [identity, vesselId, a.compartment_no, asOf]);

  const e = a.executability;
  const refused = e.verdict === "not_executable";
  const dur = a.planned
    ? Math.round((a.planned.end - a.planned.start) / 86_400_000)
    : null;

  return (
    <aside
      style={{
        position: "fixed", right: 12, top: 168, bottom: 34, width: 390, zIndex: 40,
        background: C.panel, border: `1px solid ${refused ? "rgba(239,68,68,0.5)" : C.line}`,
        borderRadius: 10, boxShadow: "0 10px 40px rgba(0,0,0,0.55)",
        display: "flex", flexDirection: "column",
      }}
    >
      <header style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "10px 12px 8px", borderBottom: `1px solid ${C.line}` }}>
        <b style={{ fontFamily: "monospace", color: C.accent, fontSize: 13 }}>{a.code}</b>
        {a.is_milestone ? (
          <span style={{ fontSize: 9.5, fontWeight: 700, color: C.accent }}>KEY EVENT</span>
        ) : (
          <span style={{ fontSize: 9.5, fontWeight: 700, color: a.status === "complete" ? C.ok : a.status === "in_progress" ? "#3D6BFF" : "#94a3b8" }}>
            {a.status.replace("_", " ").toUpperCase()}
          </span>
        )}
        {a.in_window && !a.is_milestone && (
          <span style={{ fontSize: 9, color: C.ok }} title="Planned for the instant on the time control.">● in window</span>
        )}
        <button
          onClick={onClose}
          title="Close (or press Escape) — the row stays where it was"
          style={{
            marginLeft: "auto", font: "inherit", fontSize: 14, cursor: "pointer", lineHeight: 1,
            padding: "4px 10px", borderRadius: 5, color: C.dim, background: "transparent",
            border: `1px solid ${C.line}`,
          }}
        >
          ×
        </button>
      </header>

      <div style={{ overflowY: "auto", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 9 }}>
        <div style={{ fontSize: 13, lineHeight: 1.35 }}>{a.name}</div>

        {/* the facts */}
        <div style={{ ...block }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "5px 12px", fontSize: 11.5 }}>
            <div>
              <div style={label}>Space</div>
              {a.compartment_no ? (
                <button
                  onClick={() => onOpenSpace(a.compartment_no ?? "")}
                  title={
                    a.compartment_reliability === "high"
                      ? "Authored by the schedule. Open on the deck plan."
                      : "Read from the task's own name — a graded guess, marked ≈. Open on the deck plan."
                  }
                  style={{
                    font: "inherit", fontSize: 11, fontFamily: "monospace", cursor: "pointer",
                    padding: "1px 6px", borderRadius: 4,
                    color: a.compartment_reliability === "high" ? C.bright : "#fbd38d",
                    background: "rgba(148,163,184,0.08)",
                    border: a.compartment_reliability === "high" ? `1px solid ${C.line}` : "1px dashed rgba(245,158,11,0.6)",
                  }}
                >
                  {a.compartment_reliability !== "high" && "≈ "}
                  {a.compartment_no}
                </button>
              ) : (
                <span style={{ color: C.warn }}>
                  not located{a.wbs_area ? ` · ${a.wbs_area} per WBS` : ""}
                </span>
              )}
            </div>
            <div>
              <div style={label}>Trade</div>
              {a.trade}
            </div>
            <div>
              <div style={label}>Planned</div>
              <span style={{ fontFamily: "monospace", fontSize: 10.5 }}>
                {a.planned ? `${fmtDay(a.planned.start)} → ${fmtDay(a.planned.end)}` : "no dates"}
              </span>
              {dur !== null && <span style={{ color: C.dim }}> · {dur}d</span>}
            </div>
            <div>
              <div style={label}>Work item</div>
              {a.work_order_code ? (
                onOpenJob ? (
                  <button
                    onClick={() => onOpenJob(a.work_order_code ?? "")}
                    title="Open the job card — the whole order this activity belongs to"
                    style={{ font: "inherit", fontSize: "inherit", cursor: "pointer", color: C.accent, background: "transparent", border: "none", padding: 0, textDecoration: "underline", textUnderlineOffset: 2 }}
                  >
                    {a.work_order_code}
                  </button>
                ) : (
                  a.work_order_code
                )
              ) : (
                <span style={{ color: a.is_milestone ? C.dim : C.warn }}>unmapped</span>
              )}
            </div>
            <div>
              <div style={label}>Hours</div>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                {a.is_milestone ? "—" : `${a.earned_hours.toLocaleString()} / ${a.budget_hours.toLocaleString()} MH · ${mh(a.remaining_hours)} left`}
              </span>
            </div>
            <div>
              <div style={label}>Source</div>
              <span style={{ fontFamily: "monospace", fontSize: 10, color: C.dim, wordBreak: "break-all" }}>{a.source_ref}</span>
            </div>
          </div>
        </div>

        {/* the verdict, with its evidence */}
        {a.is_milestone ? null : refused && e.verdict === "not_executable" ? (
          <div style={{ ...block, border: "1px solid rgba(239,68,68,0.45)", background: "rgba(239,68,68,0.06)" }}>
            <div style={{ ...label, color: C.dangerSoft }}>Not executable as planned</div>
            <div style={{ fontSize: 11.5 }}>
              Refused from <b style={{ fontFamily: "monospace" }}>{fmtDayTime(e.at)}</b> inside the
              planned window — rule <b style={{ fontFamily: "monospace", color: C.bright }}>{e.rule_code}</b>,{" "}
              {e.hazard} @{" "}
              <button
                onClick={() => onOpenSpace(e.origin)}
                title="Open the hold's origin space"
                style={{
                  font: "inherit", fontSize: 10.5, fontFamily: "monospace", cursor: "pointer",
                  padding: "0 5px", borderRadius: 4, color: C.bright,
                  background: "rgba(148,163,184,0.08)", border: `1px solid ${C.line}`,
                }}
              >
                {e.origin}
              </button>
            </div>
            <div style={{ fontSize: 11, color: e.earliest_clear ? C.warn : "#c4b5fd" }}>
              {e.earliest_clear
                ? `clears ${fmtDayTime(e.earliest_clear)} on its own`
                : `clears on verification by ${e.clearing_authority.replace(/_/g, " ")} — never on a clock`}
            </div>
          </div>
        ) : e.verdict === "unassessable" ? (
          <div style={{ ...block }}>
            <div style={{ ...label }}>Executability</div>
            <div style={{ fontSize: 11.5, color: C.dim }}>
              {e.reason === "unlocated"
                ? "Unknown — no compartment is mapped, so there is no space to evaluate. Unknown is never presented as fine."
                : "Unknown — no planned dates, so there is no “as planned” to test against."}
            </div>
          </div>
        ) : (
          <div style={{ ...block }}>
            <div style={{ ...label, color: C.ok }}>Executable as planned</div>
            <div style={{ fontSize: 11.5, color: C.dim }}>
              The space permits this work at every instant of the planned window, against the
              hazards on file.
            </div>
          </div>
        )}

        {/* the engine's proposal */}
        {refused && (
          <div style={{ ...block, border: "1px solid rgba(34,197,94,0.35)" }}>
            <div style={{ ...label, color: C.ok }}>Suggested alternative</div>
            {!alt ? (
              <div style={{ fontSize: 11.5, color: C.dim }}>
                {altsSettled
                  ? "Proposals are unavailable right now — reload the board to retry."
                  : "Computing…"}
              </div>
            ) : alt.alternative.kind === "viable" ? (
              <>
                <div style={{ fontSize: 11.5 }}>
                  Slide <b style={{ color: C.ok }}>+{Math.round(alt.alternative.delay_hours / 24)}d {alt.alternative.delay_hours % 24}h</b>{" "}
                  to{" "}
                  <b style={{ fontFamily: "monospace" }}>
                    {fmtDay(alt.alternative.window.start)} → {fmtDay(alt.alternative.window.end)}
                  </b>{" "}
                  — the first window of the same duration the rules in force permit. The engine
                  re-accepted this window; it is not an estimate.
                </div>
                {alt.pushes.length > 0 && (
                  <div style={{ fontSize: 11, color: C.warn }}>
                    Knock-on: {alt.pushes.length} successor{alt.pushes.length === 1 ? "" : "s"} would
                    start before the proposed finish ({alt.pushes.join(", ")}) — re-sequence
                    together. Read finish-to-start, lags not applied.
                  </div>
                )}
              </>
            ) : alt.alternative.kind === "verification_gated" ? (
              <div style={{ fontSize: 11.5 }}>
                <b style={{ color: "#c4b5fd" }}>No date-certain window can be promised:</b>{" "}
                {alt.alternative.refusal.rule_code} clears only on verification by{" "}
                <b>{alt.alternative.refusal.clearing_authority.replace(/_/g, " ")}</b>. The honest proposal is the
                action, not a date — see the options below.
              </div>
            ) : (
              <div style={{ fontSize: 11.5, color: C.warn }}>
                Nothing of this duration fits before the availability ends — this one needs a
                planner, not a slide.
              </div>
            )}
          </div>
        )}

        {/* the path back to P6: a proposal, engine-checked and ledgered */}
        {refused && !a.is_milestone && (() => {
          const duration = a.planned ? a.planned.end - a.planned.start : 0;
          const send = (kind: ScheduleProposal["kind"], start?: number) => {
            if (!reason.trim()) {
              setProposed({ ok: false, text: "Say why — P6 will be asked to move work on the strength of it." });
              return;
            }
            setBusy(true);
            setProposed(null);
            void proposeScheduleChange(identity, vesselId, {
              activity: a.code,
              kind,
              reason: reason.trim(),
              as_of: asOf,
              ...(start !== undefined ? { start_ms: start, end_ms: start + duration } : {}),
            })
              .then((r) => {
                setBusy(false);
                const v = r.proposal.verdict;
                setProposed({
                  ok: true,
                  text:
                    `Proposed · ledger #${r.proposal.seq} · ` +
                    (v === null
                      ? "no date promised"
                      : v.verdict === "executable"
                        ? "the engine accepts the window"
                        : v.verdict === "not_executable"
                          ? `⚠ the engine still refuses it (${v.rule_code} @ ${v.origin}) — recorded as such`
                          : "engine could not assess") +
                    (r.proposal.pushes.length > 0 ? ` · pushes ${r.proposal.pushes.join(", ")}` : "") +
                    " — see Proposals to export the change request.",
                });
                onProposed?.(r.proposal);
              })
              .catch((err: unknown) => {
                setBusy(false);
                setProposed({ ok: false, text: String(err instanceof Error ? err.message : err) });
              });
          };
          const manualMs = manualStart ? Date.parse(`${manualStart}T06:00:00Z`) : NaN;
          return (
            <div style={{ ...block, border: `1px solid ${C.accent}55` }}>
              <div style={{ ...label, color: C.accent }}>Propose to P6</div>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why — the sentence the change request carries"
                title="Pressed for: a proposal without a reason is refused."
                style={{ font: "inherit", fontSize: 11.5, padding: "4px 7px", background: "#0b0c0e", color: C.text, border: `1px solid ${C.line}`, borderRadius: 5 }}
              />
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                {alt?.alternative.kind === "viable" && (
                  <button
                    disabled={busy}
                    onClick={() => alt.alternative.kind === "viable" && send("engine_window", alt.alternative.window.start)}
                    title="Propose the engine's own window — the first of the same duration the rules permit. Re-checked at the instant before it lands."
                    style={proposeBtn(C.ok)}
                  >
                    Slide to {alt.alternative.kind === "viable" ? fmtDay(alt.alternative.window.start) : ""}
                  </button>
                )}
                {(alt?.alternative.kind === "verification_gated" || e.verdict === "not_executable" && e.earliest_clear === null) && (
                  <button
                    disabled={busy}
                    onClick={() => send("hold_pending_verification")}
                    title="No date can honestly be promised: propose that P6 hold this activity until the named authority verifies the hazard is cleared."
                    style={proposeBtn("#c4b5fd")}
                  >
                    Hold pending verification
                  </button>
                )}
                <input
                  type="date"
                  value={manualStart}
                  onChange={(ev) => setManualStart(ev.target.value)}
                  title="A start of your own — same duration; the engine checks it before it lands."
                  style={{ font: "inherit", fontSize: 11, padding: "3px 6px", background: "#0b0c0e", color: C.text, border: `1px solid ${C.line}`, borderRadius: 5 }}
                />
                <button
                  disabled={busy || Number.isNaN(manualMs)}
                  onClick={() => send("manual", manualMs)}
                  title="Propose this start with the planned duration. Engine-checked; a window the hull still refuses is recorded as such, not blocked."
                  style={proposeBtn(C.accent)}
                >
                  Propose this start
                </button>
              </div>
              {proposed && (
                <div style={{ fontSize: 11, color: proposed.ok ? C.ok : C.danger }}>{proposed.text}</div>
              )}
              <div style={{ fontSize: 10, color: C.faint }}>
                Nothing moves here. The proposal is checked by the engine, lands in the ledger, exports as a
                P6 change request, and the next XER import says whether P6 took it.
              </div>
            </div>
          );
        })()}

        {/* the space's options — same assessment the Deck Explorer shows */}
        {a.compartment_no && optionsError && (
          <div style={{ fontSize: 10.5, color: C.dim }}>
            The space&apos;s options could not be loaded — open the space to see them there.
          </div>
        )}
        {a.compartment_no && assessment && assessment.options.length > 0 && (
          <div style={{ ...block }}>
            <div style={label}>Options in {a.compartment_no}</div>
            {assessment.options.slice(0, 3).map((o, i) => (
              <div key={i} style={{ fontSize: 11.5, display: "flex", gap: 6, alignItems: "baseline" }}>
                <span style={{ color: C.faint }}>{i + 1}.</span>
                <span>
                  {actionTitle(o.action)}{" "}
                  <span style={{ color: C.dim, fontSize: 10.5 }}>
                    — frees {o.effect.frees.length}
                    {o.effect.closes.length > 0 && (
                      <b style={{ color: C.dangerSoft }}> · shuts {o.effect.closes.length}</b>
                    )}
                    {" · "}
                    {o.confidence.replace(/_/g, " ")}
                  </span>
                </span>
              </div>
            ))}
            <button
              onClick={() => onOpenSpace(a.compartment_no ?? "")}
              title="Jump to this space on the Deck Explorer, with its full options panel open — decisions are recorded there, into the ledger."
              style={{
                alignSelf: "flex-start", marginTop: 2, font: "inherit", fontSize: 11, cursor: "pointer",
                padding: "3px 10px", borderRadius: 5, color: C.accent, background: "transparent",
                border: `1px solid ${C.accent}55`,
              }}
            >
              Open the space to decide →
            </button>
          </div>
        )}

        <div style={{ fontSize: 10, color: C.faint, lineHeight: 1.5 }}>
          Proposals, not changes: re-sequencing happens in P6 (Primavera, the yard&apos;s
          scheduler), deciding happens on the space&apos;s options panel, and the ledger
          remembers what was decided.
        </div>
      </div>
    </aside>
  );
}
