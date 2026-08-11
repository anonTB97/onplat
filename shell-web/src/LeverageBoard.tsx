// The hull's highest-leverage actions.
//
// This is the screen the mitigation work exists for, and it is organised the
// opposite way round from every other board in the product. Everything else reports
// per SPACE. This reports per ACTION, because an action is what a person can be
// sent to do, and one action frees spaces held by several different authorities.
//
// The inversion changes the answer, which is the whole argument for building it. On
// the seeded hull the coating cascade holds five spaces and the energised bus holds
// one, so read per space the coating is obviously the bigger problem. Weighted by
// the man-hours actually booked at this instant, the bus isolation is worth 484 MH
// and the entire coating cascade is worth 80. A planner with one attendance to spend
// should spend it on the bus, and no per-space view would ever tell them that.

import { useEffect, useState } from "react";
import {
  leverage,
  listIssues,
  type AsOf,
  type Confidence,
  type Identity,
  type Mitigation,
  type MitigationAction,
} from "./api";
import IssuesBoard from "./IssuesBoard";
import { actionTitle } from "./Mitigations";
import { Loading } from "./Loading";
import { C, fmtClear, mh } from "./theme";

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  computed: "COMPUTED",
  assumes_actor: "ASSUMES ATTENDANCE",
  assumes_own_authorization: "ASSUMES ITS OWN PERMIT",
};

/** Who has to do it — the column a supervisor reads first. */
function actor(a: MitigationAction): string {
  switch (a.kind) {
    case "wait":
      return "nobody";
    case "discharge":
      return a.actor;
    case "interrupt":
      return "own work + permit";
  }
}

function where(a: MitigationAction): string {
  switch (a.kind) {
    case "wait":
      return fmtClear(a.until);
    case "discharge":
      return a.origin;
    case "interrupt":
      return `${a.from} ↔ ${a.to}`;
  }
}

export default function LeverageBoard({
  identity,
  vesselId,
  hullLabel,
  asOf,
  onOpenSpace,
}: {
  identity: Identity;
  vesselId: string;
  hullLabel: string;
  asOf: AsOf;
  /** Opens a space on the deck plan — every compartment named here is a link. */
  onOpenSpace: (compartment: string) => void;
}) {
  const [actions, setActions] = useState<Mitigation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Issues first: nobody arrives knowing an action; they arrive knowing a
  // problem. The count in the tab label is fetched here so it shows before the
  // tab is opened.
  const [tab, setTab] = useState<"issues" | "actions">("issues");
  const [issueCount, setIssueCount] = useState<number | null>(null);
  const [issueHours, setIssueHours] = useState<number>(0);

  useEffect(() => {
    setError(null);
    leverage(identity, vesselId, asOf)
      .then((r) => setActions(r.actions))
      .catch((e: unknown) => {
        setActions(null);
        setError(String(e));
      });
    listIssues(identity, vesselId, asOf)
      .then((r) => {
        setIssueCount(r.issues.length);
        setIssueHours(r.hours_at_risk);
      })
      .catch(() => setIssueCount(null));
  }, [identity, vesselId, asOf]);

  if (error) {
    return <p style={{ color: C.danger }}>Leverage unavailable ({error}).</p>;
  }
  if (!actions) return <Loading label="Pricing the options…" />;

  const recoverable = actions.reduce(
    (a, m) => a + m.effect.freed_hours - m.effect.closed_hours,
    0,
  );

  const th: React.CSSProperties = {
    textAlign: "left",
    padding: "6px 10px",
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: C.dim,
    borderBottom: `1px solid ${C.line}`,
    whiteSpace: "nowrap",
  };
  const td: React.CSSProperties = {
    padding: "8px 10px",
    fontSize: 12.5,
    borderBottom: "1px solid #191a1f",
    verticalAlign: "top",
  };

  return (
    <div>
      <div style={{ fontSize: 10, letterSpacing: 1.1, textTransform: "uppercase", color: C.accent }}>
        Conflicts &amp; Risk · {hullLabel}
      </div>
      <h1 style={{ fontSize: 22, margin: "4px 0 2px" }}>
        {tab === "issues" ? "What is wrong?" : "What is worth doing first?"}
      </h1>
      <p style={{ color: C.dim, fontSize: 12.5, margin: "0 0 12px", maxWidth: 780 }}>
        {tab === "issues" ? (
          <>
            Every way the platform can show planned work is in trouble, ranked by
            man-hours at risk. One hazard can appear at several grains — a held space,
            a broken plan, a crew&apos;s morning — deliberately: each grain routes to a
            different fix.
          </>
        ) : (
          <>
            Ranked by man-hours recovered, per <b>action</b> rather than per space — one
            action can free spaces held by several different authorities, and the space
            holding the most work is rarely the one holding the most spaces. Every row was
            computed by rebuilding the hull with that action taken and re-evaluating it;
            nothing here is a remedy looked up in a table.
          </>
        )}
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {(
          [
            ["issues", `Issues${issueCount !== null ? ` · ${issueCount}` : ""}`],
            ["actions", `Actions · ${actions.length}`],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            style={{
              font: "inherit", fontSize: 12, fontWeight: 600, cursor: "pointer",
              padding: "5px 14px", borderRadius: 6,
              background: tab === id ? "#20222b" : "transparent",
              color: tab === id ? C.text : C.dim,
              border: `1px solid ${tab === id ? C.accent : C.line}`,
            }}
          >
            {label}
          </button>
        ))}
        {tab === "issues" && issueHours > 0 && (
          <span style={{ alignSelf: "center", fontSize: 11.5, color: C.dim }}>
            <b style={{ color: "#f87171" }}>{mh(issueHours)}</b> at risk across the board
          </span>
        )}
      </div>

      {tab === "issues" ? (
        <>
          <IssuesBoard
            identity={identity}
            vesselId={vesselId}
            asOf={asOf}
            onOpenSpace={onOpenSpace}
          />
          <p style={{ color: C.dim, fontSize: 11.5, marginTop: 10, maxWidth: 780 }}>
            Every row is a door: the route lands on the space with its decision trace
            and options open, where a choice is recorded to the audit ledger.
          </p>
        </>
      ) : actions.length === 0 ? (
        <p style={{ color: C.dim, fontSize: 12.5 }}>
          Nothing on this hull is held at this instant, so there is nothing to unlock.
        </p>
      ) : (
        <>
          <p style={{ fontSize: 12.5, margin: "0 0 10px" }}>
            <b>{actions.length}</b> action{actions.length === 1 ? "" : "s"} available ·{" "}
            <b style={{ color: "#22c55e" }}>{mh(recoverable)}</b> recoverable in total.
            {/* Deliberately not called "recoverable if you do everything": the sets
                overlap, so the actions are alternatives as often as they are
                additions and summing them would double-count. */}
            <span style={{ color: C.dim }}>
              {" "}
              Actions overlap — this is the sum of each row, not a total for doing all of
              them.
            </span>
          </p>

          <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 8 }}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 860 }}>
              <thead>
                <tr>
                  <th style={th}>#</th>
                  <th style={th}>Action</th>
                  <th style={th}>Who</th>
                  <th style={th}>Where / when</th>
                  <th style={{ ...th, textAlign: "right" }}>Recovers</th>
                  <th style={th}>Frees</th>
                  <th style={th}>Cost / caveat</th>
                </tr>
              </thead>
              <tbody>
                {actions.map((m, i) => {
                  const harm = m.effect.closes.length > 0;
                  const net = m.effect.freed_hours - m.effect.closed_hours;
                  return (
                    <tr
                      key={`${m.action.kind}-${i}`}
                      style={{ background: i === 0 ? "rgba(61,107,255,0.06)" : undefined }}
                    >
                      <td style={{ ...td, color: i === 0 ? C.accent : C.dim, fontWeight: 700 }}>
                        {i + 1}
                      </td>
                      <td style={{ ...td, fontWeight: 600 }}>{actionTitle(m.action)}</td>
                      <td style={{ ...td, color: m.action.kind === "wait" ? "#22c55e" : "#ccd1da" }}>
                        {actor(m.action)}
                      </td>
                      <td style={{ ...td, fontFamily: "monospace", fontSize: 11 }}>
                        {where(m.action)}
                      </td>
                      <td
                        style={{
                          ...td,
                          textAlign: "right",
                          fontVariantNumeric: "tabular-nums",
                          fontWeight: 700,
                          color: net > 0 ? "#22c55e" : C.dim,
                        }}
                      >
                        {mh(net)}
                        {harm && (
                          <div style={{ fontSize: 10.5, fontWeight: 400, color: "#f87171" }}>
                            −{mh(m.effect.closed_hours)} lost
                          </div>
                        )}
                      </td>
                      <td style={{ ...td, fontSize: 11 }}>
                        {/* Every space is a link. A planner reading "frees six" wants
                            to go and look at them. */}
                        {m.effect.frees.map((c) => (
                          <button
                            key={c}
                            onClick={() => onOpenSpace(c)}
                            title="Open on the deck plan"
                            style={{
                              font: "inherit",
                              fontSize: 10.5,
                              fontFamily: "monospace",
                              margin: "0 4px 3px 0",
                              padding: "1px 5px",
                              borderRadius: 4,
                              cursor: "pointer",
                              color: "#22c55e",
                              background: "rgba(34,197,94,0.10)",
                              border: "1px solid rgba(34,197,94,0.35)",
                            }}
                          >
                            {c}
                          </button>
                        ))}
                        {harm && (
                          <div style={{ marginTop: 3 }}>
                            <span style={{ color: "#f87171", fontSize: 10.5 }}>shuts </span>
                            {m.effect.closes.map((c) => (
                              <button
                                key={c}
                                onClick={() => onOpenSpace(c)}
                                title="This action would shut this space — open it on the deck plan"
                                style={{
                                  font: "inherit",
                                  fontSize: 10.5,
                                  fontFamily: "monospace",
                                  margin: "0 4px 3px 0",
                                  padding: "1px 5px",
                                  borderRadius: 4,
                                  cursor: "pointer",
                                  color: "#f87171",
                                  background: "rgba(220,38,38,0.12)",
                                  border: "1px solid rgba(220,38,38,0.45)",
                                }}
                              >
                                {c}
                              </button>
                            ))}
                          </div>
                        )}
                      </td>
                      <td style={{ ...td, fontSize: 10.5, color: C.dim, maxWidth: 190 }}>
                        {CONFIDENCE_LABEL[m.confidence]}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p style={{ color: C.dim, fontSize: 11.5, marginTop: 10, maxWidth: 780 }}>
            Decision support. Recording a choice is done on the space itself, from the
            Deck Explorer — nothing on this screen clears a hazard, moves a date or
            grants an authorization.
          </p>
        </>
      )}
    </div>
  );
}
