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

import { useState } from "react";
import type { DeckStateRow } from "./api";
import { C, mh, zoneColour } from "./theme";

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
  onOpenSpace,
}: {
  spaces: DeckStateRow[];
  steps: WalkStep[];
  onOpenSpace: (compartment: string) => void;
}) {
  const [idx, setIdx] = useState(0);

  const placeable = spaces.filter((r) => r.compartment.frame !== null);
  const decks = [...new Map(
    placeable.map((r) => [r.compartment.deck_code, r.compartment.deck_ordinal]),
  ).entries()].sort((a, b) => a[1] - b[1]);
  const frames = placeable.map((r) => r.compartment.frame ?? 0);
  const fLo = Math.min(...frames) - 6;
  const fHi = Math.max(...frames) + 6;
  const deckY = new Map(decks.map(([code], i) => [code, TOP + (i + 1) * DECK_GAP]));
  const H = TOP + decks.length * DECK_GAP + 26;

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
    const tone = isCurrent ? step?.tone : walkedTone;
    const front = tone
      ? TONE_FILL[tone]
      : heldNow
        ? "rgba(220,38,38,0.28)"
        : "rgba(148,163,184,0.22)";
    const dimmer = isCurrent ? 1 : walkedTone ? 0.75 : 0.6;
    const { sx, sy } = g;
    return (
      <g
        key={no}
        onClick={() => onOpenSpace(no)}
        style={{ cursor: "pointer" }}
        opacity={dimmer}
      >
        <title>
          {`${no} — ${g.row.compartment.name}\n${g.row.compartment.zone} · ${g.row.compartment.deck_code} deck · Fr ${g.row.compartment.frame} ${g.row.compartment.side}\n${heldNow ? "held now" : "permits work"} · ${mh(g.row.remaining_hours)} remaining\nClick to open on the deck plan.`}
        </title>
        {/* zone plinth: the grouping, worn at the base */}
        <path
          d={`M ${sx - 2} ${sy + 2} l ${BOX_W + 4} 0 l ${BOX_KX} ${-BOX_KY} l ${-(BOX_W + 4)} 0 z`}
          fill={zoneColour(g.row.compartment.zone)}
          opacity={0.55}
        />
        {/* front */}
        <rect x={sx} y={sy - BOX_H} width={BOX_W} height={BOX_H} fill={front} stroke="#00000055" strokeWidth={0.4} />
        {/* top */}
        <path
          d={`M ${sx} ${sy - BOX_H} l ${BOX_W} 0 l ${BOX_KX} ${-BOX_KY} l ${-BOX_W} 0 z`}
          fill={front}
          style={{ filter: "brightness(1.55)" }}
          opacity={0.9}
          stroke="#00000044"
          strokeWidth={0.4}
        />
        {/* side */}
        <path
          d={`M ${sx + BOX_W} ${sy - BOX_H} l ${BOX_KX} ${-BOX_KY} l 0 ${BOX_H} l ${-BOX_KX} ${BOX_KY} z`}
          fill="#000000"
          opacity={0.32}
        />
        {isCurrent && (
          <>
            {/* the ring that says "you are here" */}
            <ellipse cx={sx + BOX_W / 2 + 4} cy={sy + 1} rx={20} ry={8} fill="none" stroke={TONE_FG[step?.tone ?? "accent"]} strokeWidth={1.4}>
              <animate attributeName="opacity" values="1;0.25;1" dur="1.6s" repeatCount="indefinite" />
            </ellipse>
            <text
              x={sx + BOX_W / 2 + 4}
              y={sy - BOX_H - 12}
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
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }}>
        {/* deck planes, top of the ship first */}
        {decks.map(([code], i) => {
          const y = TOP + (i + 1) * DECK_GAP;
          return (
            <g key={code}>
              <path
                d={`M ${LABEL_W - 8} ${y + 6} L ${LABEL_W + PLOT_W + 26} ${y + 6} l ${SKEW_X} ${-SKEW_Y} L ${LABEL_W - 8 + SKEW_X} ${y + 6 - SKEW_Y} z`}
                fill={i % 2 === 0 ? "#101118" : "#0d0e13"}
                stroke={C.hairline}
              />
              <text x={10} y={y + 2} fill={C.dim} fontSize={10} fontWeight={700}>
                {code}
              </text>
              <text x={10} y={y + 13} fill={C.faint} fontSize={8}>
                deck
              </text>
            </g>
          );
        })}
        {/* bow marker: the shared orientation every hull canvas keeps */}
        <text x={LABEL_W + PLOT_W + 18} y={TOP + 14} fill={C.faint} fontSize={8.5} letterSpacing={1}>
          BOW ⟶
        </text>

        {drawOrder.map((g) => box(g))}

        {/* the step's arrows, above every box: consequence in flight */}
        {arrows.map(({ from, to }) => {
          const x1 = from.sx + BOX_W / 2 + 4;
          const y1 = from.sy - BOX_H - 4;
          const x2 = to.sx + BOX_W / 2 + 4;
          const y2 = to.sy - BOX_H - 4;
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
