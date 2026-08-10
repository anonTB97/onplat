// What can be done about a held space — and what it would cost.
//
// This is the surface for `wadl-mitigate`. Two things about how it presents, both
// of which are the point rather than decoration:
//
// 1. **Recovered man-hours lead.** A planner is choosing where to spend an
//    attendance, so the number that decides it is how much work each option frees,
//    not which space it is about. The server has already ranked on exactly that.
// 2. **Harm is never behind a disclosure.** If an option would shut a space, that
//    sits next to the benefit at the same weight. An option that frees six spaces
//    and closes one is not an option that frees six, and the only reason a reader
//    would ever miss the difference is if a designer hid it.
//
// Nothing here applies anything. Accepting an option records that a named person
// was shown these choices and took this one; the yard then does the work.

import { useEffect, useState } from "react";
import {
  mitigations,
  recordDecision,
  type Assessment,
  type AsOf,
  type Confidence,
  type DeckStateRow,
  type Identity,
  type Mitigation,
  type MitigationAction,
} from "./api";
import { C, fmtClear, mh, STATE_STYLE } from "./theme";

/** Reads an action as a sentence a supervisor could act on. */
export function actionTitle(a: MitigationAction): string {
  switch (a.kind) {
    case "wait":
      return "Wait for the hold to expire";
    case "discharge":
      return `Clear ${a.hazard}`;
    case "interrupt":
      return `Interrupt the ${a.coupling.replace(/_/g, " ")}`;
  }
}

/** Who has to do it, or an explicit statement that nobody does. */
function actionActor(a: MitigationAction): string {
  switch (a.kind) {
    case "wait":
      return "nobody — it clears itself";
    case "discharge":
      return a.actor;
    case "interrupt":
      return "needs its own work and its own permit";
  }
}

function actionDetail(a: MitigationAction): string {
  switch (a.kind) {
    case "wait":
      return `expires ${fmtClear(a.until)}`;
    case "discharge":
      return `at ${a.origin}`;
    case "interrupt":
      return `between ${a.from} and ${a.to}`;
  }
}

const CONFIDENCE: Record<Confidence, { label: string; gloss: string }> = {
  computed: {
    label: "COMPUTED",
    gloss:
      "The effect was re-evaluated by the engine, and the precondition is a matter of record — the hold's expiry was priced from the hazard's own start.",
  },
  assumes_actor: {
    label: "ASSUMES ATTENDANCE",
    gloss:
      "The effect was re-evaluated by the engine. Whether the named authority can attend, and when, is outside anything this platform knows.",
  },
  assumes_own_authorization: {
    label: "ASSUMES ITS OWN PERMIT",
    gloss:
      "The effect was re-evaluated by the engine. The closure is itself work in a compartment, and whether THAT work is authorized is not modelled here.",
  },
};

const chip = (fg: string, bg: string, border: string): React.CSSProperties => ({
  padding: "1px 6px",
  borderRadius: 4,
  fontSize: 9.5,
  fontWeight: 700,
  fontFamily: "monospace",
  color: fg,
  background: bg,
  border: `1px solid ${border}`,
  whiteSpace: "nowrap",
});

export default function Mitigations({
  identity,
  vesselId,
  compartment,
  asOf,
  spaces,
  onOpenSpace,
}: {
  identity: Identity;
  vesselId: string;
  compartment: string;
  asOf: AsOf;
  /**
   * Every space on the hull with its served state, for the redeployment list.
   *
   * Passed in rather than fetched: the Deck Explorer already holds exactly this,
   * and a second read would be a second answer to "is that space open".
   */
  spaces: DeckStateRow[];
  onOpenSpace: (compartment: string) => void;
}) {
  const [data, setData] = useState<Assessment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reasonFor, setReasonFor] = useState<number | null>(null);
  const [reason, setReason] = useState("");

  useEffect(() => {
    setError(null);
    setReasonFor(null);
    mitigations(identity, vesselId, compartment, asOf)
      .then(setData)
      .catch((e: unknown) => {
        setData(null);
        setError(String(e));
      });
  }, [identity, vesselId, compartment, asOf]);

  const decide = async (option: Mitigation, disposition: "accepted" | "rejected") => {
    setBusy(true);
    try {
      await recordDecision(identity, vesselId, compartment, {
        disposition,
        option,
        reason,
        as_of: asOf,
      });
      setReason("");
      setReasonFor(null);
      setData(await mitigations(identity, vesselId, compartment, asOf));
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (error) return <p style={{ color: C.danger, fontSize: 12 }}>Options unavailable ({error}).</p>;
  if (!data) return null;

  // For each trade booked in this held space, the spaces they could work in
  // instead: authorized now, with hours booked for that trade at this instant.
  // Sorted by hours, because a crew being sent somewhere should be sent where the
  // most of their work is.
  const here = spaces.find((r) => r.compartment.compartment_no === compartment);
  const redeploy = (here?.trades ?? [])
    .map((trade) => {
      const open = spaces
        .filter(
          (r) =>
            r.compartment.compartment_no !== compartment &&
            r.readiness === "go" &&
            r.trades.includes(trade),
        )
        .sort((a, b) => b.remaining_hours - a.remaining_hours);
      return {
        trade,
        spaces: open,
        hours: open.reduce((a, r) => a + r.remaining_hours, 0),
      };
    })
    .filter((r) => r.spaces.length > 0);

  // A space that permits work has nothing to mitigate — including a WARN, which is
  // a condition flagged rather than a hold. Keyed on the state, not on whether the
  // hold list is empty: a WARN space HAS holds, so the old check never fired and the
  // panel told a planner "no single action opens this space" about a space that was
  // open.
  if (data.state === "ALLOW" || data.state === "WARN") {
    const advisories = data.holds.filter((h) => h.state === "WARN");
    return (
      <div style={{ fontSize: 11.5, color: C.dim, marginTop: 10 }}>
        {advisories.length === 0 ? (
          "Nothing is holding this space, so there is nothing to mitigate."
        ) : (
          <>
            Work may proceed here. {advisories.length} condition
            {advisories.length === 1 ? " is" : "s are"} flagged, not holding:
            {advisories.map((h) => (
              <div key={`${h.rule_code}-${h.origin}`} style={{ color: "#ccd1da", marginTop: 3 }}>
                <span style={{ fontFamily: "monospace", color: STATE_STYLE.WARN.fg }}>
                  {h.rule_code}
                </span>{" "}
                {h.hazard} <span style={{ color: C.dim }}>at {h.origin}</span>
              </div>
            ))}
          </>
        )}
      </div>
    );
  }

  return (
    <div style={{ marginTop: 12, borderTop: `1px solid ${C.line}`, paddingTop: 10 }}>
      <div
        style={{
          fontSize: 10,
          letterSpacing: 1,
          textTransform: "uppercase",
          color: C.accent,
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        Options
        <span style={{ color: C.dim, letterSpacing: 0, textTransform: "none", fontSize: 10.5 }}>
          each one re-evaluated by the engine, not looked up
        </span>
      </div>

      {/* No single action opens the space. The list of holds IS the answer — a
          planner reading "this needs both" has what they need, and an empty panel
          would read as "no idea". */}
      {data.options.length === 0 && (
        <div style={{ marginTop: 8 }}>
          <p style={{ fontSize: 12, color: STATE_STYLE.WARN.fg, margin: "0 0 6px" }}>
            No single action opens this space. All{" "}
            {data.holds.filter((h) => h.state !== "WARN").length} holds have to be
            addressed:
          </p>
          {data.holds
            .filter((h) => h.state !== "WARN")
            .map((h) => (
            <div
              key={`${h.rule_code}-${h.origin}-${h.hazard}`}
              style={{ fontSize: 11.5, color: "#ccd1da", padding: "3px 0" }}
            >
              <span style={{ fontFamily: "monospace", color: C.dim }}>{h.rule_code}</span>{" "}
              {h.hazard} <span style={{ color: C.dim }}>at {h.origin}</span>
              <div style={{ fontSize: 10.5, color: C.dim }}>
                {h.earliest_clear === null
                  ? `${h.clearing_authority} must verify it — no clock on this`
                  : `expires ${fmtClear(h.earliest_clear)}`}
                </div>
              </div>
            ))}
        </div>
      )}

      {data.options.map((o, i) => {
        const harm = o.effect.closes.length > 0;
        return (
          <div
            key={`${o.action.kind}-${i}`}
            style={{
              marginTop: 8,
              padding: "8px 9px",
              borderRadius: 6,
              // The best option is marked, because a ranked list whose order is
              // not visible is a list a reader re-sorts by eye.
              border: `1px solid ${i === 0 ? "rgba(61,107,255,0.55)" : C.line}`,
              background: i === 0 ? "rgba(61,107,255,0.07)" : "transparent",
            }}
          >
            <div style={{ display: "flex", gap: 7, alignItems: "baseline", flexWrap: "wrap" }}>
              {i === 0 && <span style={chip(C.accent, "rgba(61,107,255,0.14)", "rgba(61,107,255,0.5)")}>BEST</span>}
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>{actionTitle(o.action)}</span>
              <span style={{ fontSize: 11, color: C.dim }}>{actionDetail(o.action)}</span>
            </div>

            <div style={{ fontSize: 11, color: C.dim, marginTop: 2 }}>
              who: {actionActor(o.action)}
            </div>

            {/* Benefit and harm at the same weight, side by side. */}
            <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap", alignItems: "center" }}>
              <span style={chip("#22c55e", "rgba(34,197,94,0.12)", "rgba(34,197,94,0.4)")}>
                +{mh(o.effect.freed_hours)} · {o.effect.frees.length} space
                {o.effect.frees.length === 1 ? "" : "s"}
              </span>
              {harm && (
                <span
                  title={`Taking this would shut ${o.effect.closes.join(", ")}`}
                  style={chip("#f87171", "rgba(220,38,38,0.14)", "rgba(220,38,38,0.5)")}
                >
                  −{mh(o.effect.closed_hours)} · shuts {o.effect.closes.join(", ")}
                </span>
              )}
              <span
                title={CONFIDENCE[o.confidence].gloss}
                style={chip(C.dim, "rgba(110,116,128,0.12)", "rgba(110,116,128,0.35)")}
              >
                {CONFIDENCE[o.confidence].label}
              </span>
              <span style={{ fontSize: 10.5, color: C.dim }}>
                leaves this space{" "}
                <b style={{ color: STATE_STYLE[o.subject_state].fg }}>{o.subject_state}</b>
              </span>
            </div>

            <div style={{ display: "flex", gap: 6, marginTop: 7, alignItems: "center", flexWrap: "wrap" }}>
              {reasonFor === i ? (
                <>
                  <input
                    autoFocus
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Why? (recorded with the decision)"
                    style={{
                      flex: 1, minWidth: 160, font: "inherit", fontSize: 11.5, padding: "3px 6px",
                      background: "#0b0c0e", color: C.text, border: `1px solid ${C.line}`, borderRadius: 4,
                    }}
                  />
                  <button disabled={busy} onClick={() => void decide(o, "accepted")} style={btn(true)}>
                    Record accept
                  </button>
                  <button disabled={busy} onClick={() => void decide(o, "rejected")} style={btn(false)}>
                    Record reject
                  </button>
                  <button onClick={() => setReasonFor(null)} style={btn(false)}>
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  onClick={() => {
                    setReasonFor(i);
                    setReason("");
                  }}
                  title="Records that you were shown these options and chose this one. It does not clear the hazard or move a date."
                  style={btn(i === 0)}
                >
                  Decide…
                </button>
              )}
            </div>
          </div>
        );
      })}

      {/* The plan, when nothing single works. Shown with its own price so the
          compound case is not merely described — a planner comparing "one
          attendance" against "a wait plus one attendance" needs both costed. */}
      {data.combined && (
        <div
          style={{
            marginTop: 8,
            padding: "8px 9px",
            borderRadius: 6,
            border: `1px solid ${STATE_STYLE.WARN.border}`,
            background: STATE_STYLE.WARN.bg,
          }}
        >
          <div style={{ fontSize: 12.5, fontWeight: 600 }}>
            Cheapest plan — all {data.combined.actions.length} together
          </div>
          {data.combined.actions.map((a, i) => (
            <div key={`${a.kind}-${i}`} style={{ fontSize: 11.5, color: "#ccd1da", marginTop: 3 }}>
              {i + 1}. {actionTitle(a)}{" "}
              <span style={{ color: C.dim }}>({actionActor(a)})</span>
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap", alignItems: "center" }}>
            <span style={chip("#22c55e", "rgba(34,197,94,0.12)", "rgba(34,197,94,0.4)")}>
              +{mh(data.combined.effect.freed_hours)} · {data.combined.effect.frees.length} space
              {data.combined.effect.frees.length === 1 ? "" : "s"}
            </span>
            {data.combined.effect.closes.length > 0 && (
              <span style={chip("#f87171", "rgba(220,38,38,0.14)", "rgba(220,38,38,0.5)")}>
                −{mh(data.combined.effect.closed_hours)} · shuts{" "}
                {data.combined.effect.closes.join(", ")}
              </span>
            )}
            <span
              title={CONFIDENCE[data.combined.confidence].gloss}
              style={chip(C.dim, "rgba(110,116,128,0.12)", "rgba(110,116,128,0.35)")}
            >
              {CONFIDENCE[data.combined.confidence].label}
            </span>
          </div>
        </div>
      )}

      {/* Where the crew booked here could work instead.
          The other half of a mitigation, and the half a planner needs within the
          hour: clearing the hold recovers the space, but it does not recover the
          shift the crew is standing through. Derived from the states the Deck
          Explorer already holds, so it cannot disagree with the deck plan about
          which spaces are open. */}
      {redeploy.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: C.dim }}>
            Meanwhile — where these crews can work now
          </div>
          {redeploy.map((r) => (
            <div key={r.trade} style={{ fontSize: 11.5, marginTop: 5 }}>
              <span style={{ color: "#ccd1da", fontWeight: 600 }}>{r.trade}</span>
              <span style={{ color: C.dim }}> — {mh(r.hours)} open to them elsewhere</span>
              <div style={{ marginTop: 2 }}>
                {r.spaces.map((sp) => (
                  <button
                    key={sp.compartment.compartment_no}
                    onClick={() => onOpenSpace(sp.compartment.compartment_no)}
                    title={`${sp.compartment.name} — ${mh(sp.remaining_hours)} booked, authorized now`}
                    style={{
                      font: "inherit", fontSize: 10.5, fontFamily: "monospace",
                      margin: "0 4px 3px 0", padding: "1px 5px", borderRadius: 4, cursor: "pointer",
                      color: "#22c55e", background: "rgba(34,197,94,0.10)",
                      border: "1px solid rgba(34,197,94,0.35)",
                    }}
                  >
                    {sp.compartment.compartment_no} · {sp.remaining_hours}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* What was already tried. The reason this is on the same panel and not
          behind a tab: the second planner to arrive needs to know the chemist was
          already asked and could not come. */}
      {data.decisions.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: C.dim }}>
            Already decided
          </div>
          {data.decisions.map((d) => {
            const accepted = d.action === "MITIGATION_ACCEPTED";
            let parsed: { reason?: string; option?: { action?: MitigationAction } } = {};
            try {
              parsed = JSON.parse(d.detail) as typeof parsed;
            } catch {
              // A detail that will not parse is still a real ledger entry; show the
              // entry rather than dropping it, because a record you cannot read is
              // itself worth seeing.
            }
            return (
              <div key={d.entry_hash} style={{ fontSize: 11, padding: "4px 0", borderBottom: "1px solid #191a1f" }}>
                <span style={chip(
                  accepted ? "#22c55e" : C.dim,
                  accepted ? "rgba(34,197,94,0.12)" : "rgba(110,116,128,0.12)",
                  accepted ? "rgba(34,197,94,0.4)" : "rgba(110,116,128,0.35)",
                )}>
                  {accepted ? "ACCEPTED" : "REJECTED"}
                </span>{" "}
                <span style={{ color: "#ccd1da" }}>
                  {parsed.option?.action ? actionTitle(parsed.option.action) : "an option"}
                </span>
                {parsed.reason ? <span style={{ color: C.dim }}> — {parsed.reason}</span> : null}
                <div
                  title={`Ledger entry ${d.seq}, hash ${d.entry_hash}`}
                  style={{ color: "#5a6070", fontFamily: "monospace", fontSize: 9.5 }}
                >
                  {fmtClear(d.occurred_at_ms)} · #{d.seq} · {d.entry_hash.slice(0, 12)}…
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const btn = (primary: boolean): React.CSSProperties => ({
  font: "inherit",
  fontSize: 11,
  padding: "3px 9px",
  borderRadius: 5,
  cursor: "pointer",
  background: primary ? "rgba(61,107,255,0.16)" : "transparent",
  color: primary ? C.text : C.dim,
  border: `1px solid ${primary ? C.accent : C.line}`,
});
