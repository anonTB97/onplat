// The walkthrough hull: the ship in three dimensions, told one step at a time.
//
// Both consequence screens (the Deconfliction Cascade and the Distributed
// Packages) need the same thing a briefing needs: not a map the reader must
// decode alone, but a guided pass — "start here, this is the action; now the
// vent trunk two decks up; now the space it strands". This component is that
// pass. The hull is drawn in a cabinet projection — every deck a plane,
// every compartment an extruded box at its (frame, side, deck) — so
// adjacency reads as adjacency: a neighbour on the same frame one deck up
// LOOKS like a neighbour, which no flat lane view can honestly do.
//
// The walkthrough is a list of steps, each naming the spaces it is about.
// The current step's spaces light up and are labelled; spaces from earlier
// steps keep a quieter tint (the story so far); everything else stays as the
// hull's base truth — held now, or open. Arrows fly from a step's stated
// origin to its spaces, in the step's own tone. Prev/Next, click a step dot,
// or arrow keys; nothing advances on its own, because the reader sets the
// pace of a briefing.
//
// Zone grouping rides along for free: every box wears its zone's colour as a
// base plinth, so "grouped by zone" is visible in the same picture that
// shows deck adjacency — the two groupings the same 24 spaces are usually
// forced to choose between.
//
// Three things make it an environment view rather than a diagram:
//
// * **Tilt.** Affected compartments are not necessarily adjacent — a bus or a
//   vent trunk shuts spaces decks apart. The tilt slider morphs the same
//   scene from a true plan overlay (every deck collapsed onto one plane, so
//   "which frames and sides are touched, anywhere in the ship" reads at a
//   glance) up to the exploded stack (so "which deck" reads). One projection,
//   continuously re-angled; nothing is recomputed but the camera.
// * **The cause layer.** When the caller passes the engine's decision-trace
//   routes, the hazard's actual hop-by-hop path is drawn through the scene —
//   including the pass-through spaces it rides (a trunk, a bus run) that no
//   effect list names. Non-adjacent consequence stops looking arbitrary: the
//   wire that carries it is on screen.
// * **The cast.** Every space any step will visit is tinted from the first
//   frame, so the full footprint of the consequence is visible before the
//   telling reaches it; the stepper spotlights, it never reveals.
//
// The hull itself is sketched behind the scene — a carrier profile when
// tilted up, the deck-edge planform when flattened — so the reader is always
// looking at a ship, not at floating planes.

import { useState } from "react";
import type { DeckStateRow } from "./api";
import { C, mh, STATE_STYLE, zoneColour } from "./theme";

const W = 1240;
const LABEL_W = 86;
const PLOT_W = W - LABEL_W - 60;
const TOP = 34;
const DECK_GAP = 84;
/** The cabinet skew: one unit of athwartships depth, in screen pixels. */
const SKEW_X = 46;
const SKEW_Y = 22;
/** Compartment box footprint and height. */
const BOX_W = 16;
const BOX_KX = 10;
const BOX_KY = 5;
const BOX_H = 13;

/** Athwartships depth: port drawn far, starboard near, centreline between. */
const SIDE_V: Record<string, number> = { port: 0, centreline: 0.5, starboard: 1 };

export type WalkTone = "accent" | "ok" | "danger" | "warn";

const TONE_FG: Record<WalkTone, string> = {
  accent: C.accent,
  ok: C.ok,
  danger: C.danger,
  warn: C.warn,
};
const TONE_FILL: Record<WalkTone, string> = {
  accent: "rgba(61,107,255,0.75)",
  ok: "rgba(34,197,94,0.72)",
  danger: "rgba(220,38,38,0.78)",
  warn: "rgba(245,158,11,0.72)",
};

/** One stop on the tour. */
export interface WalkStep {
  title: string;
  body: string;
  tone: WalkTone;
  /** The spaces this step is about — lit and labelled while current. */
  spaces: string[];
  /** Draw an arrow from this space to each of the step's spaces. */
  arrowFrom?: string;
}

interface BoxGeom {
  sx: number;
  sy: number;
  row: DeckStateRow;
}

export function IsoWalk({
  spaces,
  steps,
  routes = [],
  cast = [],
  onOpenSpace,
}: {
  spaces: DeckStateRow[];
  steps: WalkStep[];
  /** The engine's hop-by-hop hazard routes (decision-trace paths), drawn as
   *  the cause layer. Pass the hops on file NOW — never an interpolation. */
  routes?: [string, string][];
  /** Every space the tour will touch, tinted from the first frame. */
  cast?: { space: string; tone: WalkTone }[];
  onOpenSpace: (compartment: string) => void;
}) {
  const [idx, setIdx] = useState(0);
  /** The camera's angle: 0 = plan (decks collapsed), 1 = exploded stack. */
  const [tilt, setTilt] = useState(1);

  const placeable = spaces.filter((r) => r.compartment.frame !== null);
  const decks = [...new Map(
    placeable.map((r) => [r.compartment.deck_code, r.compartment.deck_ordinal]),
  ).entries()].sort((a, b) => a[1] - b[1]);
  const frames = placeable.map((r) => r.compartment.frame ?? 0);
  const fLo = Math.min(...frames) - 6;
  const fHi = Math.max(...frames) + 6;

  // The tilt is nothing but these three numbers: how far apart the decks
  // sit, how tall a box stands, and how loud each backdrop is. The canvas
  // keeps its exploded height so the layout never jumps under the slider.
  const gap = 12 + (DECK_GAP - 12) * tilt;
  const boxH = 3 + (BOX_H - 3) * tilt;
  const H = TOP + decks.length * DECK_GAP + 26;
  const yOff = ((decks.length * (DECK_GAP - gap)) / 2) * 1;
  const deckY = new Map(decks.map(([code], i) => [code, TOP + yOff + (i + 1) * gap]));

  // Bow (low frame) to the right, as on every other hull canvas here.
  const u = (frame: number) => LABEL_W + ((fHi - frame) / (fHi - fLo)) * PLOT_W;
  const geomOf = (r: DeckStateRow): BoxGeom | null => {
    const frame = r.compartment.frame;
    const y0 = deckY.get(r.compartment.deck_code);
    if (frame === null || y0 === undefined) return null;
    const v = SIDE_V[r.compartment.side] ?? 0.5;
    return { sx: u(frame) + v * SKEW_X, sy: y0 - v * SKEW_Y, row: r };
  };
  const geom = new Map<string, BoxGeom>();
  for (const r of placeable) {
    const g = geomOf(r);
    if (g) geom.set(r.compartment.compartment_no, g);
  }

  const step = steps[Math.min(idx, Math.max(0, steps.length - 1))];
  const current = new Set(step?.spaces ?? []);
  // The story so far: spaces from steps already walked keep their tone,
  // quietly, so the picture accumulates the way the telling does.
  const walked = new Map<string, WalkTone>();
  for (let i = 0; i < Math.min(idx, steps.length); i += 1) {
    for (const no of steps[i]?.spaces ?? []) walked.set(no, steps[i]?.tone ?? "accent");
  }
  const unplaceable = (step?.spaces ?? []).filter((no) => !geom.has(no));

  // The whole footprint, tinted before the telling reaches it.
  const castTone = new Map(cast.map((c) => [c.space, c.tone]));
  // Spaces the hazard rides THROUGH: on a route, but in nobody's effect list.
  const viaSpaces = new Set(
    routes
      .flat()
      .filter((no) => geom.has(no) && !castTone.has(no) && !current.has(no) && !walked.has(no)),
  );
  const routeColour = STATE_STYLE.SUSPEND.fg;

  const arrows =
    step?.arrowFrom && geom.has(step.arrowFrom)
      ? step.spaces
          .filter((no) => geom.has(no) && no !== step.arrowFrom)
          .map((no) => ({ from: geom.get(step.arrowFrom ?? "") as BoxGeom, to: geom.get(no) as BoxGeom }))
      : [];

  /** One compartment as an extruded box: front, top, side — then its plinth. */
  const box = (g: BoxGeom) => {
    const no = g.row.compartment.compartment_no;
    const isCurrent = current.has(no);
    const walkedTone = walked.get(no);
    const heldNow = !g.row.permits_work;
    const tone = isCurrent ? step?.tone : (walkedTone ?? castTone.get(no));
    const front = tone
      ? TONE_FILL[tone]
      : heldNow
        ? "rgba(220,38,38,0.28)"
        : "rgba(148,163,184,0.22)";
    const dimmer = isCurrent ? 1 : walkedTone ? 0.8 : castTone.has(no) ? 0.62 : 0.55;
    const { sx, sy } = g;
    return (
      <g
        key={no}
        onClick={() => onOpenSpace(no)}
        style={{ cursor: "pointer" }}
        opacity={dimmer}
      >
        <title>
          {`${no} — ${g.row.compartment.name}\n${g.row.compartment.zone} · ${g.row.compartment.deck_code} deck · Fr ${g.row.compartment.frame} ${g.row.compartment.side}\n${heldNow ? "held now" : "permits work"} · ${mh(g.row.remaining_hours)} remaining${viaSpaces.has(no) ? "\nA hazard route on file passes through this space." : ""}\nClick to open on the deck plan.`}
        </title>
        {/* zone plinth: the grouping, worn at the base */}
        <path
          d={`M ${sx - 2} ${sy + 2} l ${BOX_W + 4} 0 l ${BOX_KX} ${-BOX_KY} l ${-(BOX_W + 4)} 0 z`}
          fill={zoneColour(g.row.compartment.zone)}
          opacity={0.55}
        />
        {/* front */}
        <rect x={sx} y={sy - boxH} width={BOX_W} height={boxH} fill={front} stroke="#00000055" strokeWidth={0.4} />
        {/* top */}
        <path
          d={`M ${sx} ${sy - boxH} l ${BOX_W} 0 l ${BOX_KX} ${-BOX_KY} l ${-BOX_W} 0 z`}
          fill={front}
          style={{ filter: "brightness(1.55)" }}
          opacity={0.9}
          stroke="#00000044"
          strokeWidth={0.4}
        />
        {/* side */}
        <path
          d={`M ${sx + BOX_W} ${sy - boxH} l ${BOX_KX} ${-BOX_KY} l 0 ${boxH} l ${-BOX_KX} ${BOX_KY} z`}
          fill="#000000"
          opacity={0.32}
        />
        {/* the wire's waypoint: a hazard route rides through, says the trace */}
        {viaSpaces.has(no) && (
          <path
            d={`M ${sx + BOX_W / 2} ${sy - boxH - 11} l 4.5 4.5 l -4.5 4.5 l -4.5 -4.5 z`}
            fill="none"
            stroke={routeColour}
            strokeWidth={1.2}
          />
        )}
        {isCurrent && (
          <>
            {/* the ring that says "you are here" */}
            <ellipse cx={sx + BOX_W / 2 + 4} cy={sy + 1} rx={20} ry={8} fill="none" stroke={TONE_FG[step?.tone ?? "accent"]} strokeWidth={1.4}>
              <animate attributeName="opacity" values="1;0.25;1" dur="1.6s" repeatCount="indefinite" />
            </ellipse>
            <text
              x={sx + BOX_W / 2 + 4}
              y={sy - boxH - 12}
              fill={TONE_FG[step?.tone ?? "accent"]}
              fontSize={9.5}
              fontWeight={700}
              fontFamily="monospace"
              textAnchor="middle"
            >
              {no}
            </text>
          </>
        )}
      </g>
    );
  };

  // Painter's order: top deck first, far side (port) before near, so nearer
  // boxes overprint farther ones the way depth says they should.
  const drawOrder = [...geom.values()].sort(
    (a, b) =>
      a.row.compartment.deck_ordinal - b.row.compartment.deck_ordinal ||
      (SIDE_V[a.row.compartment.side] ?? 0.5) - (SIDE_V[b.row.compartment.side] ?? 0.5) ||
      (b.row.compartment.frame ?? 0) - (a.row.compartment.frame ?? 0),
  );

  const zonesSeen = [...new Set(placeable.map((r) => r.compartment.zone))].sort();

  return (
    <div
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") setIdx((i) => Math.min(i + 1, steps.length - 1));
        if (e.key === "ArrowLeft") setIdx((i) => Math.max(i - 1, 0));
      }}
      style={{ border: `1px solid ${C.line}`, borderRadius: 8, background: C.well, outline: "none" }}
    >
      {/* the camera: how the same scene is angled */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "7px 12px 5px", fontSize: 10, color: C.dim }}>
        <span style={{ textTransform: "uppercase", letterSpacing: 0.9, fontSize: 8.5, color: C.subtle }}>Tilt</span>
        {([["Plan", 0], ["Tilt", 0.55], ["Exploded", 1]] as const).map(([label, t]) => (
          <button
            key={label}
            onClick={() => setTilt(t)}
            title={
              t === 0
                ? "Every deck collapsed onto one plane — which frames and sides are touched, anywhere in the ship"
                : t === 1
                  ? "Decks fully separated — which deck carries what"
                  : "Between the two: vertical structure and plan extent in one look"
            }
            style={{
              font: "inherit", fontSize: 10, padding: "1px 8px", borderRadius: 5, cursor: "pointer",
              background: Math.abs(tilt - t) < 0.05 ? C.raised : "transparent",
              color: Math.abs(tilt - t) < 0.05 ? C.text : C.dim,
              border: `1px solid ${Math.abs(tilt - t) < 0.05 ? C.accent : C.line}`,
            }}
          >
            {label}
          </button>
        ))}
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(tilt * 100)}
          onChange={(e) => setTilt(Number(e.target.value) / 100)}
          title="Tilt the camera: plan overlay ⟷ exploded deck stack"
          style={{ width: 150, accentColor: C.accent }}
        />
        {routes.length > 0 && (
          <span style={{ marginLeft: "auto", color: C.dim }}>
            <span style={{ color: routeColour }}>‒ ‒</span> hazard route on file ·{" "}
            <span style={{ color: routeColour }}>◇</span> rides through
          </span>
        )}
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }}>
        {/* The ship's shell, sketched: a carrier profile while the stack is
            tilted up, fading out as the decks collapse into plan. */}
        {tilt > 0.15 && (() => {
          const first = TOP + yOff + gap;
          const last = TOP + yOff + decks.length * gap;
          const flightY = first - boxH - 22;
          const keelY = last + 16;
          const xL = LABEL_W - 26;
          const xR = LABEL_W + PLOT_W + 40;
          return (
            <g opacity={0.55 * tilt} pointerEvents="none">
              <path
                d={
                  `M ${xL + 10} ${flightY} L ${xR + 8} ${flightY} ` + // flight deck
                  `L ${xR + 2} ${flightY + 14} L ${xR - 30} ${flightY + 26} ` + // bow overhang
                  `C ${xR - 52} ${flightY + 40}, ${xR - 60} ${keelY - 18}, ${xR - 78} ${keelY} ` + // bow rake
                  `L ${xL + 34} ${keelY} ` + // keel
                  `L ${xL + 10} ${keelY - 26} z` // stern
                }
                fill="rgba(148,163,184,0.03)"
                stroke={C.faint}
                strokeWidth={0.8}
              />
              {/* the island, aft-starboard on the flight deck */}
              <path
                d={`M ${xL + (xR - xL) * 0.34} ${flightY} l 0 -13 l 7 0 l 0 -6 l 12 0 l 0 19 z`}
                fill="rgba(148,163,184,0.05)"
                stroke={C.faint}
                strokeWidth={0.8}
              />
            </g>
          );
        })()}
        {/* The deck-edge planform, fading in as the decks flatten to plan. */}
        {tilt < 0.6 && (() => {
          const yBase = TOP + yOff + gap + 10;
          const p = (frame: number, v: number) => `${u(frame) + v * SKEW_X} ${yBase - v * SKEW_Y}`;
          return (
            <path
              d={
                `M ${p(fHi + 4, 0.1)} L ${p(fLo + 18, 0)} ` +
                `Q ${p(fLo - 9, 0.14)} ${p(fLo - 11, 0.5)} ` + // bow taper
                `Q ${p(fLo - 9, 0.86)} ${p(fLo + 18, 1)} ` +
                `L ${p(fHi + 4, 0.9)} z`
              }
              fill="rgba(148,163,184,0.028)"
              stroke={C.faint}
              strokeWidth={0.8}
              opacity={(0.6 - tilt) / 0.6}
              pointerEvents="none"
            />
          );
        })()}

        {/* deck planes, top of the ship first; they quieten as they merge */}
        {decks.map(([code], i) => {
          const y = TOP + yOff + (i + 1) * gap;
          return (
            <g key={code}>
              <path
                d={`M ${LABEL_W - 8} ${y + 6} L ${LABEL_W + PLOT_W + 26} ${y + 6} l ${SKEW_X} ${-SKEW_Y} L ${LABEL_W - 8 + SKEW_X} ${y + 6 - SKEW_Y} z`}
                fill={i % 2 === 0 ? "#101118" : "#0d0e13"}
                stroke={C.hairline}
                opacity={0.25 + 0.75 * tilt}
              />
              {/* At low tilt the labels would overprint in the merged stack;
                  one label speaks for all of them instead. */}
              {tilt >= 0.25 && (
                <>
                  <text x={10} y={y + 2} fill={C.dim} fontSize={10} fontWeight={700} opacity={0.35 + 0.65 * tilt}>
                    {code}
                  </text>
                  <text x={10} y={y + 13} fill={C.faint} fontSize={8} opacity={0.35 + 0.65 * tilt}>
                    deck
                  </text>
                </>
              )}
            </g>
          );
        })}
        {tilt < 0.25 && (
          <text x={10} y={TOP + yOff + gap + 2} fill={C.dim} fontSize={9} fontWeight={700}>
            all decks
            <tspan x={10} dy={11} fill={C.faint} fontSize={8} fontWeight={400}>
              plan
            </tspan>
          </text>
        )}
        {/* bow marker: the shared orientation every hull canvas keeps */}
        <text x={LABEL_W + PLOT_W + 18} y={TOP + 14} fill={C.faint} fontSize={8.5} letterSpacing={1}>
          BOW ⟶
        </text>

        {drawOrder.map((g) => box(g))}

        {/* The cause layer: the engine's decision-trace hops, drawn on file.
            This is why a consequence three decks away is not arbitrary — the
            trunk or bus that carries it is on screen. Hops landing on the
            current step's spaces speak loudest. */}
        {routes.map(([from, to]) => {
          const a = geom.get(from);
          const b = geom.get(to);
          if (!a || !b) return null;
          const x1 = a.sx + BOX_W / 2;
          const y1 = a.sy - boxH / 2;
          const x2 = b.sx + BOX_W / 2;
          const y2 = b.sy - boxH / 2;
          const hot = current.has(to) || current.has(from);
          return (
            <g key={`route-${from}-${to}`} pointerEvents="none">
              <line
                x1={x1} y1={y1} x2={x2} y2={y2}
                stroke={routeColour}
                strokeWidth={hot ? 1.7 : 1}
                strokeDasharray="5 4"
                opacity={hot ? 0.95 : 0.4}
              />
            </g>
          );
        })}

        {/* the step's arrows, above every box: consequence in flight */}
        {arrows.map(({ from, to }) => {
          const x1 = from.sx + BOX_W / 2 + 4;
          const y1 = from.sy - boxH - 4;
          const x2 = to.sx + BOX_W / 2 + 4;
          const y2 = to.sy - boxH - 4;
          const lift = Math.max(26, Math.abs(x2 - x1) / 5 + Math.abs(y2 - y1) / 3);
          return (
            <g key={`${from.row.compartment.compartment_no}->${to.row.compartment.compartment_no}`}>
              <path
                d={`M ${x1} ${y1} Q ${(x1 + x2) / 2} ${Math.min(y1, y2) - lift}, ${x2} ${y2}`}
                fill="none"
                stroke={TONE_FG[step?.tone ?? "accent"]}
                strokeWidth={1.5}
                strokeDasharray="6 4"
                opacity={0.9}
              />
              <circle cx={x2} cy={y2} r={2.6} fill={TONE_FG[step?.tone ?? "accent"]} />
            </g>
          );
        })}
      </svg>

      {/* the telling: step controls and the step itself */}
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "9px 12px", borderTop: `1px solid ${C.line}` }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", paddingTop: 2 }}>
          <button
            onClick={() => setIdx((i) => Math.max(i - 1, 0))}
            disabled={idx === 0}
            style={{
              font: "inherit", fontSize: 12, width: 26, padding: "3px 0", borderRadius: 6,
              cursor: idx === 0 ? "default" : "pointer", background: "transparent",
              color: idx === 0 ? C.faint : C.text, border: `1px solid ${C.line}`,
            }}
          >
            ‹
          </button>
          <span style={{ fontSize: 11, color: C.dim, fontVariantNumeric: "tabular-nums", minWidth: 44, textAlign: "center" }}>
            {idx + 1} / {steps.length}
          </span>
          <button
            onClick={() => setIdx((i) => Math.min(i + 1, steps.length - 1))}
            disabled={idx >= steps.length - 1}
            style={{
              font: "inherit", fontSize: 12, width: 26, padding: "3px 0", borderRadius: 6,
              cursor: idx >= steps.length - 1 ? "default" : "pointer", background: C.raised,
              color: idx >= steps.length - 1 ? C.faint : C.text,
              border: `1px solid ${idx >= steps.length - 1 ? C.line : C.accent}`,
            }}
          >
            ›
          </button>
        </div>
        {/* one dot per step, walkable out of order */}
        <div style={{ display: "flex", gap: 4, alignItems: "center", paddingTop: 7 }}>
          {steps.map((s, i) => (
            <button
              key={`${s.title}-${i}`}
              onClick={() => setIdx(i)}
              title={s.title}
              style={{
                width: 9, height: 9, borderRadius: 5, padding: 0, cursor: "pointer",
                background: i === idx ? TONE_FG[s.tone] : i < idx ? `${TONE_FG[s.tone]}88` : "transparent",
                border: `1px solid ${i <= idx ? TONE_FG[s.tone] : C.faint}`,
              }}
            />
          ))}
        </div>
        {step && (
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: TONE_FG[step.tone] }}>{step.title}</div>
            <div style={{ fontSize: 11.5, color: C.bright, marginTop: 2 }}>{step.body}</div>
            {unplaceable.length > 0 && (
              <div style={{ fontSize: 10.5, color: C.warn, marginTop: 2 }}>
                not placeable on the plates: {unplaceable.join(", ")}
              </div>
            )}
          </div>
        )}
        <div style={{ fontSize: 10, color: C.faint, paddingTop: 7, whiteSpace: "nowrap" }}>
          ← → keys walk · click a box to open it
        </div>
      </div>

      {/* zone legend: the plinth colours, named */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", padding: "6px 12px 8px", fontSize: 10, color: C.dim }}>
        {zonesSeen.map((z) => (
          <span key={z}>
            <span style={{ color: zoneColour(z) }}>▬</span> {z}
          </span>
        ))}
        <span style={{ marginLeft: "auto", color: C.faint }}>
          plinth = zone · column = frame · lane = deck — adjacency reads in all three
        </span>
      </div>
    </div>
  );
}
