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
  compartmentState,
  leverage,
  type AsOf,
  type Confidence,
  type DeckStateRow,
  type Identity,
  type Mitigation,
} from "./api";
import { IsoWalk, type WalkStep, type WalkTone } from "./IsoWalk";
import { Loading } from "./Loading";
import { ModuleHeader } from "./ModuleHeader";
import { actionTitle } from "./Mitigations";
import { C, chipStyle, mh } from "./theme";

const W = 1000;
const LABEL_W = 105;
const LANE_H = 44;
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
  const [view, setView] = useState<"map" | "walk">("map");

  useEffect(() => {
    setError(null);
    // Cleared up front: the previous instant's counterfactual painted over a
    // new instant's base rows is a lie between two layers of one screen. The
    // stale guard keeps a slow old response from landing after a fast new one.
    setActions(null);
    let stale = false;
    leverage(identity, vesselId, asOf)
      .then((r) => {
        if (stale) return;
        setActions(r.actions);
        setAsOfMs(r.as_of);
        setSel(0);
      })
      .catch((e: unknown) => {
        if (stale) return;
        setActions(null);
        setError(String(e));
      });
    return () => {
      stale = true;
    };
  }, [identity, vesselId, asOf]);

  // The cause layer for the walkthrough: each affected space's decision trace
  // holds the hop-by-hop path its hold actually took (the same trace the Deck
  // Explorer draws). Fetched per chosen action; hops are deduped across the
  // affected set. These are the routes on file NOW — why the freed spaces are
  // held today — never an interpolation of the counterfactual.
  const [routes, setRoutes] = useState<[string, string][]>([]);
  useEffect(() => {
    // Cleared before the fetch, not after: the previous action's routes must
    // not draw under this one's legend while the traces are in flight.
    setRoutes([]);
    const act = actions?.[sel];
    if (!act) {
      return undefined;
    }
    const affected = [...act.effect.frees, ...act.effect.closes];
    let stale = false;
    void Promise.all(
      affected.map((no) => compartmentState(identity, vesselId, no, asOf).catch(() => null)),
    ).then((results) => {
      if (stale) return;
      const seen = new Set<string>();
      const edges: [string, string][] = [];
      for (const r of results) {
        for (const t of r?.decision.trace ?? []) {
          for (let i = 0; i + 1 < t.path.length; i += 1) {
            const a = t.path[i];
            const b = t.path[i + 1];
            if (a === undefined || b === undefined) continue;
            const key = `${a}→${b}`;
            if (seen.has(key)) continue;
            seen.add(key);
            edges.push([a, b]);
          }
        }
      }
      setRoutes(edges);
    });
    return () => {
      stale = true;
    };
  }, [identity, vesselId, asOf, actions, sel]);

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

  // Same-frame neighbours must not print on top of each other: within a
  // lane, dots closer than one dot-width alternate between two sub-rows.
  const rowOf = new Map<string, number>();
  for (const deck of lanes) {
    const mine = spaces
      .filter((r) => r.compartment.deck_code === deck.code && r.compartment.frame !== null)
      .sort((a, b) => (b.compartment.frame ?? 0) - (a.compartment.frame ?? 0));
    const lastX = [-Infinity, -Infinity];
    for (const r of mine) {
      const x = xOf(r.compartment.frame ?? 0);
      const level = x - (lastX[0] ?? -Infinity) >= 18 ? 0 : 1;
      lastX[level] = x;
      rowOf.set(r.compartment.compartment_no, level);
    }
  }

  // The same consequence, as a guided tour: the action first, then every
  // space it frees, then — loudest — every space it shuts, then the net.
  const byName = new Map(spaces.map((r) => [r.compartment.compartment_no, r]));
  // Every space the tour touches, tinted from the first frame — the whole
  // affected environment visible before the telling reaches it.
  const walkCast: { space: string; tone: WalkTone }[] = chosen
    ? [
        ...(chosen.action.kind === "discharge"
          ? [{ space: chosen.action.origin, tone: "accent" as const }]
          : chosen.action.kind === "interrupt"
            ? [
                { space: chosen.action.from, tone: "accent" as const },
                { space: chosen.action.to, tone: "accent" as const },
              ]
            : []),
        ...chosen.effect.frees.map((s) => ({ space: s, tone: "ok" as const })),
        ...chosen.effect.closes.map((s) => ({ space: s, tone: "danger" as const })),
      ]
    : [];
  const walkSteps: WalkStep[] = [];
  if (chosen) {
    const a = chosen.action;
    const originSpaces =
      a.kind === "discharge" ? [a.origin] : a.kind === "interrupt" ? [a.from, a.to] : [];
    const origin = originSpaces[0];
    walkSteps.push({
      title: "Step in: the action",
      tone: "accent",
      body:
        `${actionTitle(a)} — ${CONFIDENCE_GLOSS[chosen.confidence]}. ` +
        "Everything that follows is a counterfactual engine verdict: the world rebuilt with this done, and re-evaluated.",
      spaces: originSpaces,
    });
    for (const no of chosen.effect.frees) {
      const r = byName.get(no);
      walkSteps.push({
        title: `Frees ${no}`,
        tone: "ok",
        body: `${r?.compartment.name ?? "not in the register"} — held now; opens once the action lands. ${mh(r?.remaining_hours ?? 0)} of booked work unblocked.`,
        spaces: [no],
        arrowFrom: origin,
      });
    }
    for (const no of chosen.effect.closes) {
      const r = byName.get(no);
      walkSteps.push({
        title: `SHUTS ${no}`,
        tone: "danger",
        body: `${r?.compartment.name ?? "not in the register"} — open today, refused after. ${mh(r?.remaining_hours ?? 0)} of booked work parked. The cost, never elided.`,
        spaces: [no],
        arrowFrom: origin,
      });
    }
    walkSteps.push({
      title: "Step out: the net",
      tone: closed.size > 0 ? "warn" : "ok",
      body:
        `Frees ${freed.size} space${freed.size === 1 ? "" : "s"} (+${mh(chosen.effect.freed_hours)})` +
        (closed.size > 0 ? `, shuts ${closed.size} (−${mh(chosen.effect.closed_hours)})` : "") +
        ` · ${stillHeld} stay held either way. The decision stays the planner's — on the space's options panel, into the ledger.`,
      spaces: [...freed, ...closed],
    });
  }

  return (
    <div>
      <ModuleHeader
        kicker={`Deconfliction Cascade · ${hullLabel}`}
        title="If we do it, what happens everywhere else?"
        stats={[
          { value: actions.length, label: actions.length === 1 ? "action on offer" : "actions on offer" },
          asOfMs !== null && { value: `${fmtInstant(asOfMs)}Z`, label: "evaluated as of" },
        ]}
        note="Pick an action; the hull becomes its consequence map. Every effect is a counterfactual engine verdict — the world rebuilt with the action taken and re-evaluated. Decision support, not automation: this proposes, a planner decides on the space's options panel, and the ledger remembers."
      />

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
            <div style={{ border: `1px solid ${C.line}`, borderRadius: 8, background: C.well, overflow: "hidden" }}>
              <div style={{ display: "flex", gap: 14, alignItems: "center", padding: "7px 11px", borderBottom: `1px solid ${C.line}`, fontSize: 11, flexWrap: "wrap" }}>
                <b>{chosen ? actionTitle(chosen.action) : ""}</b>
                <span style={{ color: C.ok }}>
                  frees {freed.size} space{freed.size === 1 ? "" : "s"} · +{mh(chosen?.effect.freed_hours ?? 0)}
                </span>
                {closed.size > 0 && (
                  <b style={{ color: "#f87171" }}>
                    SHUTS {closed.size} space{closed.size === 1 ? "" : "s"} · −{mh(chosen?.effect.closed_hours ?? 0)}
                  </b>
                )}
                <span style={{ color: C.dim }}>{stillHeld} still held either way</span>
                <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  <button style={chipStyle(view === "map")} onClick={() => setView("map")} title="Every deck a lane, every space a state dot — the whole consequence at once.">
                    Map
                  </button>
                  <button style={chipStyle(view === "walk")} onClick={() => setView("walk")} title="The hull in three dimensions, stepped through one consequence at a time.">
                    3D walkthrough
                  </button>
                </span>
              </div>

              {view === "walk" ? (
                <IsoWalk
                  key={sel}
                  spaces={spaces}
                  steps={walkSteps}
                  routes={routes}
                  cast={walkCast}
                  onOpenSpace={onOpenSpace}
                />
              ) : (
              <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block", background: "#0b0c0e" }}>
                {lanes.map((deck, i) => (
                  <g key={deck.code}>
                    <rect x={0} y={i * LANE_H} width={W} height={LANE_H} fill={i % 2 === 0 ? C.well : "#101118"} />
                    <text x={8} y={i * LANE_H + LANE_H / 2 + 3} fill={C.dim} fontSize={9} fontWeight={600}>
                      {deck.code}
                    </text>
                  </g>
                ))}
                {/* Every space is a state dot; only the spaces this action
                    TOUCHES earn a printed placard. Twenty-four labels was a
                    collision field — the consequence is the point, and the
                    tooltip still names everything. */}
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
                    ? "rgba(220,38,38,0.6)"
                    : isFreed
                      ? "rgba(34,197,94,0.55)"
                      : heldNow
                        ? "rgba(220,38,38,0.14)"
                        : "rgba(148,163,184,0.12)";
                  const stroke = isClosed
                    ? C.danger
                    : isFreed
                      ? C.ok
                      : heldNow
                        ? "rgba(220,38,38,0.55)"
                        : "rgba(148,163,184,0.3)";
                  const affected = isFreed || isClosed;
                  const x = xOf(frame);
                  const sub = rowOf.get(no) === 1 ? 8 : -4;
                  const y = top + LANE_H / 2 + sub;
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
                        x={x - 6} y={y - 6} width={12} height={12} rx={3}
                        fill={fill} stroke={stroke} strokeWidth={affected ? 1.6 : 0.9}
                      />
                      {affected && (
                        <text
                          x={x} y={sub < 0 ? y - 11 : y + 18}
                          fill={isClosed ? C.danger : C.ok}
                          fontSize={8} fontWeight={700} textAnchor="middle" fontFamily="monospace"
                        >
                          {isClosed ? `SHUTS ${no}` : no}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>
              )}

              {view === "map" && (
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap", padding: "7px 11px", borderTop: `1px solid ${C.line}`, fontSize: 10.5, color: C.dim }}>
                <span><span style={{ color: C.ok }}>■</span> freed by this action</span>
                <span><span style={{ color: C.danger }}>■</span> shut by this action — the cost, never elided</span>
                <span><span style={{ color: "rgba(220,38,38,0.55)" }}>▭</span> held before and after</span>
                <span><span style={{ color: "rgba(148,163,184,0.4)" }}>▭</span> open, unaffected</span>
                {undrawable.length > 0 && (
                  <span style={{ color: C.warn }} title="Affected spaces the register cannot place on a deck lane.">
                    affected but unplaceable: {undrawable.join(", ")}
                  </span>
                )}
              </div>
              )}
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
      title="Pick this action — the map and the walkthrough repaint with its consequence: every space it frees, every space it shuts."
      style={{
        textAlign: "left", font: "inherit", cursor: "pointer", padding: "9px 12px",
        borderRadius: 8, background: active ? "#171a22" : C.panel, color: C.text,
        border: `1px solid ${active ? C.accent : C.line}`,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
        <b style={{ fontSize: 12.5 }}>{actionTitle(a.action)}</b>
        <span style={{ fontSize: 11.5, fontVariantNumeric: "tabular-nums", color: net > 0 ? C.ok : C.danger, whiteSpace: "nowrap" }}>
          {net >= 0 ? "+" : ""}{mh(net)} net
        </span>
      </div>
      {a.action.kind === "interrupt" && (
        <div style={{ fontSize: 10, color: C.subtle, marginTop: 2, fontFamily: "monospace" }}>
          {a.action.from} ⟶ {a.action.to} · {a.action.coupling}
        </div>
      )}
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
