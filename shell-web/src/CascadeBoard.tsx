// The Deconfliction Cascade — one action's consequence, painted on the hull.
//
// The Actions tab already ranks what is worth doing; this screen answers the
// question that follows: *if we do it, what happens everywhere else?* Pick an
// action and the whole hull becomes its consequence map — every space it
// frees, every space it would SHUT, and everything it leaves held — before
// anyone is sent. That is what deconfliction is: reading the collision on a
// screen instead of discovering it on a deck.
//
// Every effect here is a counterfactual engine verdict: the server rebuilt
// the world with the action taken and re-evaluated the hull (wadl-mitigate).
// Nothing is interpolated, and harm is never elided — an action that opens
// five spaces and shuts a sixth is drawn with the sixth loudest.

import { useEffect, useMemo, useState } from "react";
import {
  leverage,
  type AsOf,
  type Confidence,
  type DeckStateRow,
  type Identity,
  type Mitigation,
} from "./api";
import { Loading } from "./Loading";
import { actionTitle } from "./Mitigations";
import { C, mh } from "./theme";

const W = 1000;
const LABEL_W = 105;
const LANE_H = 34;
const PAD_FRAMES = 8;

const CONFIDENCE_GLOSS: Record<Confidence, string> = {
  computed: "computed — no assumptions",
  assumes_actor: "assumes the named actor attends",
  assumes_own_authorization: "assumes the closure work is itself authorized",
};

const fmtInstant = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 16).replace("-", "/").replace("T", " ");

export default function CascadeBoard({
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
  /** Per-space verdicts at the same instant — the "before" the map paints over. */
  spaces: DeckStateRow[];
  onOpenSpace: (compartment: string) => void;
}) {
  const [actions, setActions] = useState<Mitigation[] | null>(null);
  const [asOfMs, setAsOfMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState(0);

  useEffect(() => {
    setError(null);
    leverage(identity, vesselId, asOf)
      .then((r) => {
        setActions(r.actions);
        setAsOfMs(r.as_of);
        setSel(0);
      })
      .catch((e: unknown) => {
        setActions(null);
        setError(String(e));
      });
  }, [identity, vesselId, asOf]);

  // Deck lanes from the register itself: every deck that places a space,
  // top of the ship first.
  const lanes = useMemo(() => {
    const decks = new Map<string, { code: string; ordinal: number }>();
    for (const r of spaces) {
      if (r.compartment.frame !== null) {
        decks.set(r.compartment.deck_code, {
          code: r.compartment.deck_code,
          ordinal: r.compartment.deck_ordinal,
        });
      }
    }
    return [...decks.values()].sort((a, b) => a.ordinal - b.ordinal);
  }, [spaces]);

  if (error) return <p style={{ color: C.danger }}>Cascade unavailable ({error}).</p>;
  if (!actions) return <Loading label="Re-evaluating the hull under each action…" />;

  const chosen = actions[Math.min(sel, Math.max(0, actions.length - 1))];
  const freed = new Set(chosen?.effect.frees ?? []);
  const closed = new Set(chosen?.effect.closes ?? []);

  const frames = spaces
    .map((r) => r.compartment.frame)
    .filter((f): f is number => f !== null);
  const fHi = Math.max(280, ...frames.map((f) => f + PAD_FRAMES));
  const xOf = (frame: number) => LABEL_W + ((fHi - frame) / fHi) * (W - LABEL_W - 8);
  const laneTop = new Map(lanes.map((d, i) => [d.code, i * LANE_H]));
  const H = lanes.length * LANE_H + 6;

  // Affected spaces the map cannot place — counted, never hidden.
  const placeable = new Set(
    spaces.filter((r) => r.compartment.frame !== null).map((r) => r.compartment.compartment_no),
  );
  const undrawable = [...freed, ...closed].filter((no) => !placeable.has(no));

  const stillHeld = spaces.filter(
    (r) => !r.permits_work && !freed.has(r.compartment.compartment_no),
  ).length;

  return (
    <div>
      <div style={{ fontSize: 10, letterSpacing: 1.1, textTransform: "uppercase", color: C.accent }}>
        Deconfliction Cascade · {hullLabel}
      </div>
      <h1 style={{ fontSize: 22, margin: "4px 0 2px" }}>If we do it, what happens everywhere else?</h1>
      <p style={{ color: C.dim, fontSize: 12.5, margin: "0 0 14px", maxWidth: 800 }}>
        Pick an action; the hull becomes its consequence map. Every effect is a
        counterfactual engine verdict — the world rebuilt with the action taken and
        re-evaluated
        {asOfMs !== null && (
          <>
            {" "}as of <b style={{ color: "#ccd1da" }}>{fmtInstant(asOfMs)}Z</b>
          </>
        )}
        . Decision support, not automation: this proposes, a planner decides on the
        space&apos;s options panel, and the ledger remembers.
      </p>

      {actions.length === 0 ? (
        <p style={{ color: C.dim, fontSize: 12.5 }}>
          Nothing to deconflict at this instant: no live hold has a computable
          counter-action. Scrub the clock to test another moment.
        </p>
      ) : (
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
          {/* The actions, ranked as the leverage board ranks them. */}
          <div style={{ flex: "0 0 330px", display: "flex", flexDirection: "column", gap: 8 }}>
            {actions.map((a, i) => (
              <ActionCard key={i} a={a} active={i === sel} onPick={() => setSel(i)} />
            ))}
          </div>

          {/* The consequence map. */}
          <div style={{ flex: "1 1 560px", minWidth: 480 }}>
            <div style={{ border: `1px solid ${C.line}`, borderRadius: 8, background: "#0e0f13", overflow: "hidden" }}>
              <div style={{ display: "flex", gap: 14, alignItems: "center", padding: "7px 11px", borderBottom: `1px solid ${C.line}`, fontSize: 11, flexWrap: "wrap" }}>
                <b>{chosen ? actionTitle(chosen.action) : ""}</b>
                <span style={{ color: "#22c55e" }}>
                  frees {freed.size} space{freed.size === 1 ? "" : "s"} · +{mh(chosen?.effect.freed_hours ?? 0)}
                </span>
                {closed.size > 0 && (
                  <b style={{ color: "#f87171" }}>
                    SHUTS {closed.size} space{closed.size === 1 ? "" : "s"} · −{mh(chosen?.effect.closed_hours ?? 0)}
                  </b>
                )}
                <span style={{ color: C.dim }}>{stillHeld} still held either way</span>
              </div>

              <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block", background: "#0b0c0e" }}>
                {lanes.map((deck, i) => (
                  <g key={deck.code}>
                    <rect x={0} y={i * LANE_H} width={W} height={LANE_H} fill={i % 2 === 0 ? "#0e0f13" : "#101118"} />
                    <text x={8} y={i * LANE_H + LANE_H / 2 + 3} fill={C.dim} fontSize={9} fontWeight={600}>
                      {deck.code}
                    </text>
                  </g>
                ))}
                {spaces.map((r) => {
                  const frame = r.compartment.frame;
                  const top = laneTop.get(r.compartment.deck_code);
                  if (frame === null || top === undefined) return null;
                  const no = r.compartment.compartment_no;
                  const isFreed = freed.has(no);
                  const isClosed = closed.has(no);
                  const heldNow = !r.permits_work;
                  // The consequence palette: green = opens, red fill = the
                  // harm, dim red ring = held before and after, grey = open
                  // and untouched.
                  const fill = isClosed
                    ? "rgba(220,38,38,0.55)"
                    : isFreed
                      ? "rgba(34,197,94,0.5)"
                      : "rgba(148,163,184,0.10)";
                  const stroke = isClosed
                    ? "#f87171"
                    : isFreed
                      ? "#22c55e"
                      : heldNow
                        ? "rgba(220,38,38,0.55)"
                        : "rgba(148,163,184,0.3)";
                  const affected = isFreed || isClosed;
                  const x = xOf(frame);
                  const y = top + LANE_H / 2;
                  return (
                    <g key={no} onClick={() => onOpenSpace(no)} style={{ cursor: "pointer" }}>
                      <title>
                        {`${no} — ${r.compartment.name}\n` +
                          (isClosed
                            ? "SHUT by this action — open today, refused after"
                            : isFreed
                              ? "freed by this action"
                              : heldNow
                                ? "held now, and this action does not open it"
                                : "open, unaffected") +
                          `\n${mh(r.remaining_hours)} booked`}
                      </title>
                      <rect
                        x={x - 26} y={y - 8} width={52} height={16} rx={2.5}
                        fill={fill} stroke={stroke} strokeWidth={affected ? 1.6 : 0.8}
                      />
                      <text x={x} y={y + 3.5} fill={affected ? "#f2f3f6" : "#6e7480"} fontSize={6.2} textAnchor="middle" fontFamily="monospace">
                        {no}
                      </text>
                      {isClosed && (
                        <text x={x} y={y - 11} fill="#f87171" fontSize={7.5} fontWeight={700} textAnchor="middle">
                          SHUTS
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>

              <div style={{ display: "flex", gap: 14, flexWrap: "wrap", padding: "7px 11px", borderTop: `1px solid ${C.line}`, fontSize: 10.5, color: C.dim }}>
                <span><span style={{ color: "#22c55e" }}>■</span> freed by this action</span>
                <span><span style={{ color: "#f87171" }}>■</span> shut by this action — the cost, never elided</span>
                <span><span style={{ color: "rgba(220,38,38,0.55)" }}>▭</span> held before and after</span>
                <span><span style={{ color: "rgba(148,163,184,0.4)" }}>▭</span> open, unaffected</span>
                {undrawable.length > 0 && (
                  <span style={{ color: "#f59e0b" }} title="Affected spaces the register cannot place on a deck lane.">
                    affected but unplaceable: {undrawable.join(", ")}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** One ranked action, with its price and its honesty. */
function ActionCard({
  a,
  active,
  onPick,
}: {
  a: Mitigation;
  active: boolean;
  onPick: () => void;
}) {
  const net = a.effect.freed_hours - a.effect.closed_hours;
  return (
    <button
      onClick={onPick}
      style={{
        textAlign: "left", font: "inherit", cursor: "pointer", padding: "9px 12px",
        borderRadius: 8, background: active ? "#171a22" : C.panel, color: C.text,
        border: `1px solid ${active ? C.accent : C.line}`,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
        <b style={{ fontSize: 12.5 }}>{actionTitle(a.action)}</b>
        <span style={{ fontSize: 11.5, fontVariantNumeric: "tabular-nums", color: net > 0 ? "#22c55e" : C.danger, whiteSpace: "nowrap" }}>
          {net >= 0 ? "+" : ""}{mh(net)} net
        </span>
      </div>
      <div style={{ fontSize: 10.5, color: C.dim, marginTop: 3 }}>
        frees {a.effect.frees.length} · shuts{" "}
        <span style={{ color: a.effect.closes.length > 0 ? "#f87171" : undefined, fontWeight: a.effect.closes.length > 0 ? 700 : 400 }}>
          {a.effect.closes.length}
        </span>{" "}
        · <span title={CONFIDENCE_GLOSS[a.confidence]}>{a.confidence.replace(/_/g, " ")}</span>
      </div>
    </button>
  );
}
