// The vertical trace: three decks stacked on one shared frame axis.
//
// This is the view the deck plan cannot give you. A hazard travelling through a
// deck penetration goes *up and down*, so a planner looking at one deck sheet
// cannot see why a space two decks away is suspended. The whole value of this
// screen is the vertical relationship — "what sits directly above this?" — and
// that relationship is only readable if every lane is on the SAME frame axis.
//
// Which is the hard part, and the reason this file exists rather than a few more
// lines in the deck plan. The plates are not drawn to a common scale: the fourth
// deck runs 20.453 px per frame, the flight deck 23.546, and frame 0 sits 420 px
// apart between them. Laying them out with a shared mapping would put frame 160
// in a different place on each lane, and every apparent vertical alignment would
// be a lie. Each lane is therefore positioned by its OWN calibration onto a
// common frame window, so a plumb line drawn down the stack means what it says.

import type { Deck, DeckStateRow } from "./api";
import { sheetForDeck, sheetX, type DeckSheet, type SheetCalibration } from "./deckSheets";
import { C, READINESS_STYLE, STATE_STYLE } from "./theme";

const DIM = C.dim;
const LINE = C.line;

/** viewBox width. */
const W = 1000;
/** Gutter for the deck label on the left. */
const LABEL_W = 92;
/** Height of one deck lane. */
const LANE_H = 150;
/** Height of the shared frame ruler under the stack. */
const RULER_H = 26;
/** Frames of padding either side of the outermost marker. */
const PAD_FRAMES = 8;

interface Lane {
  deck: Deck;
  rows: DeckStateRow[];
  sheet: DeckSheet | undefined;
  top: number;
}

/** Nice tick spacing for the frame ruler — 5, 10, 20 or 50 frames. */
function tickStep(span: number): number {
  for (const step of [5, 10, 20, 50, 100]) {
    if (span / step <= 10) return step;
  }
  return 200;
}

export function VerticalTrace({
  decks,
  rows,
  centreOrdinal,
  selected,
  onSelect,
  onDeck,
  toneOf,
  cascadeEdges,
}: {
  decks: Deck[];
  rows: DeckStateRow[];
  centreOrdinal: number;
  selected: string | null;
  onSelect: (compartment: string) => void;
  onDeck: (code: string) => void;
  toneOf: (r: DeckStateRow) => { fg: string; bg: string; border: string };
  cascadeEdges: [string, string][];
}) {
  const ordered = [...decks].sort((a, b) => a.ordinal - b.ordinal);
  const band = ordered.filter((d) => Math.abs(d.ordinal - centreOrdinal) <= 1);
  const centreIdx = ordered.findIndex((d) => d.ordinal === centreOrdinal);
  const shift = (delta: number) => {
    const next = ordered[Math.min(Math.max(centreIdx + delta, 0), ordered.length - 1)];
    if (next) onDeck(next.code);
  };

  const lanes: Lane[] = band.map((deck, i) => ({
    deck,
    rows: rows.filter((r) => r.compartment.deck_code === deck.code),
    sheet: sheetForDeck(deck.code),
    top: i * LANE_H,
  }));

  // The frame window is fitted to the work actually in the stack, not to the
  // hull's whole 0–280 range. Fitting to the hull left the markers bunched in a
  // third of the canvas with two thirds of empty ship either side, which wastes
  // the only axis this view has.
  const frames = lanes
    .flatMap((l) => l.rows.map((r) => r.compartment.frame))
    .filter((f): f is number => f !== null);
  const fLo = frames.length > 0 ? Math.min(...frames) - PAD_FRAMES : 0;
  const fHi = frames.length > 0 ? Math.max(...frames) + PAD_FRAMES : 280;
  const fSpan = Math.max(1, fHi - fLo);

  /** Shared axis: bow right, so the highest frame is the leftmost pixel. */
  const xOf = (frame: number) => LABEL_W + ((fHi - frame) / fSpan) * (W - LABEL_W);

  const H = lanes.length * LANE_H + RULER_H;
  const selectedRow = rows.find((r) => r.compartment.compartment_no === selected);
  const plumbFrame = selectedRow?.compartment.frame ?? null;

  // Marker positions on the shared axis, for the cascade connectors.
  const placed = new Map<string, { x: number; y: number }>();
  for (const lane of lanes) {
    const levels = laneLevels(lane.rows, fSpan);
    for (const r of lane.rows) {
      const frame = r.compartment.frame;
      if (frame === null) continue;
      placed.set(r.compartment.compartment_no, {
        x: xOf(frame),
        y: lane.top + 34 + (levels.get(r.compartment.compartment_no) ?? 0) * 20,
      });
    }
  }

  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: 8, background: "#0e0f13", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 11px", borderBottom: `1px solid ${LINE}`, fontSize: 11, fontWeight: 600, flexWrap: "wrap" }}>
        <span>Vertical trace — deck above, selected, below</span>
        <span style={{ color: DIM, fontWeight: 400 }}>
          one shared frame axis · each plate placed by its own scale
        </span>
        {plumbFrame !== null && (
          <span style={{ color: STATE_STYLE.SUSPEND.fg, fontWeight: 400 }}>
            · plumb at Fr {plumbFrame}
          </span>
        )}
        <span style={{ marginLeft: "auto", display: "flex", gap: 4, alignItems: "center" }}>
          <button onClick={() => shift(-1)} style={navBtn} title="Shift the window up a deck" disabled={centreIdx <= 0}>▲</button>
          <button onClick={() => shift(1)} style={navBtn} title="Shift the window down a deck" disabled={centreIdx >= ordered.length - 1}>▼</button>
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "stretch" }}>
        {/* The stack ribbon: twelve decks is too many to hold in the head when the
            trace shows three, so this is what says where those three sit. */}
        <div style={{ flex: "0 0 96px", borderRight: `1px solid ${LINE}`, padding: "6px 0" }}>
          <div style={{ fontSize: 9, letterSpacing: 0.7, textTransform: "uppercase", color: DIM, padding: "0 8px 5px" }}>
            Stack
          </div>
          {ordered.map((d) => {
            const inBand = Math.abs(d.ordinal - centreOrdinal) <= 1;
            const isCentre = d.ordinal === centreOrdinal;
            const held = rows.filter((r) => r.compartment.deck_code === d.code && r.readiness === "held").length;
            return (
              <button
                key={d.code}
                onClick={() => onDeck(d.code)}
                title={d.label}
                style={{
                  display: "flex", alignItems: "center", gap: 5, width: "100%", textAlign: "left",
                  font: "inherit", fontSize: 10, cursor: "pointer", padding: "3px 8px",
                  background: isCentre ? "#20222b" : "transparent",
                  color: inBand ? C.text : "#5a6070",
                  border: "none",
                  borderLeft: `3px solid ${isCentre ? C.accent : inBand ? "#353842" : "transparent"}`,
                }}
              >
                <span style={{ flex: 1, lineHeight: 1.2 }}>{d.label}</span>
                {held > 0 && <span style={{ width: 6, height: 6, borderRadius: 3, background: READINESS_STYLE.held.fg, flex: "none" }} />}
              </button>
            );
          })}
        </div>

        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block", background: "#0b0c0e" }}>
          <defs>
            {lanes.map((lane) => (
              <clipPath key={lane.deck.code} id={`lane-${lane.deck.code}`}>
                <rect x={LABEL_W} y={lane.top} width={W - LABEL_W} height={LANE_H} />
              </clipPath>
            ))}
          </defs>

          {lanes.map((lane) => {
            const isCentre = lane.deck.ordinal === centreOrdinal;
            const levels = laneLevels(lane.rows, fSpan);
            return (
              <g key={lane.deck.code}>
                <rect x={0} y={lane.top} width={W} height={LANE_H} fill={isCentre ? "#141720" : "#0e0f13"} />
                {/* The deck's own plate, sliced to the shared frame window. Each
                    lane is placed by its own calibration — that is what makes the
                    lanes comparable at all. */}
                {lane.sheet?.calibration ? (
                  <g clipPath={`url(#lane-${lane.deck.code})`}>
                    {platedLane(lane.sheet, lane.sheet.calibration, fLo, fHi, lane.top)}
                  </g>
                ) : (
                  <text x={(W + LABEL_W) / 2} y={lane.top + LANE_H / 2} fill="#353842" fontSize={10} textAnchor="middle">
                    no plate for this deck
                  </text>
                )}


                {/* Drawn after the plate so the lane edges stay legible through it,
                    and heavier on the selected deck. */}
                <rect
                  x={0} y={lane.top} width={W} height={LANE_H}
                  fill="none" stroke={isCentre ? "#3a3f52" : "#22252f"} strokeWidth={isCentre ? 1.6 : 1}
                />
                <rect x={0} y={lane.top} width={LABEL_W} height={LANE_H} fill={isCentre ? "#141720" : "#0e0f13"} />
                <text x={8} y={lane.top + 15} fill={isCentre ? C.text : DIM} fontSize={10.5} fontWeight={600}>
                  {lane.deck.label}
                </text>
                <text x={8} y={lane.top + 27} fill="#4b5060" fontSize={8.5}>
                  {lane.rows.length === 0 ? "no spaces" : `${lane.rows.length} space${lane.rows.length === 1 ? "" : "s"}`}
                </text>

                {lane.rows.map((r) => {
                  const frame = r.compartment.frame;
                  if (frame === null) return null;
                  const no = r.compartment.compartment_no;
                  const tone = toneOf(r);
                  const isSel = no === selected;
                  const x = xOf(frame);
                  const y = lane.top + 34 + (levels.get(no) ?? 0) * 20;
                  return (
                    <g key={no} onClick={() => onSelect(no)} style={{ cursor: "pointer" }}>
                      <line x1={x} y1={y} x2={x} y2={lane.top + LANE_H} stroke={tone.fg} strokeWidth={0.7} opacity={0.4} />
                      <rect
                        x={x - 40} y={y - 8} width={80} height={16} rx={3}
                        fill="#0b0c0eE6" stroke={isSel ? C.accent : tone.border} strokeWidth={isSel ? 2 : 1}
                      />
                      <text x={x} y={y + 4} fill={tone.fg} fontSize={9} textAnchor="middle" fontFamily="monospace">
                        {no}
                      </text>
                    </g>
                  );
                })}
              </g>
            );
          })}

          {/* The plumb line. The reason the view exists: it makes "directly above"
              a straight line you can follow rather than a claim to be trusted. */}
          {plumbFrame !== null && (
            <g>
              <line
                x1={xOf(plumbFrame)} y1={0} x2={xOf(plumbFrame)} y2={lanes.length * LANE_H}
                stroke={STATE_STYLE.SUSPEND.fg} strokeWidth={1.4} strokeDasharray="5 4" opacity={0.9}
              />
              <text x={xOf(plumbFrame)} y={lanes.length * LANE_H + 11} fill={STATE_STYLE.SUSPEND.fg} fontSize={9} textAnchor="middle">
                Fr {plumbFrame}
              </text>
            </g>
          )}

          {/* The hazard's own route through the stack. */}
          {cascadeEdges.map(([from, to]) => {
            const a = placed.get(from);
            const b = placed.get(to);
            if (!a || !b) return null;
            return (
              <line
                key={`${from}-${to}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke={STATE_STYLE.SUSPEND.fg} strokeWidth={2} strokeDasharray="6 4"
              />
            );
          })}

          {/* Shared frame ruler — one axis for every lane. Without it the stack is
              three unrelated pictures. */}
          <g>
            <line x1={LABEL_W} y1={lanes.length * LANE_H} x2={W} y2={lanes.length * LANE_H} stroke="#2b2d36" />
            {frameTicks(fLo, fHi).map((f) => (
              <g key={f}>
                <line x1={xOf(f)} y1={lanes.length * LANE_H} x2={xOf(f)} y2={lanes.length * LANE_H + 4} stroke="#4b5060" />
                <text x={xOf(f)} y={lanes.length * LANE_H + 20} fill="#6e7480" fontSize={8.5} textAnchor="middle" fontFamily="monospace">
                  {f}
                </text>
              </g>
            ))}
            <text x={W - 2} y={lanes.length * LANE_H + 20} fill="#4b5060" fontSize={8} textAnchor="end">
              bow →
            </text>
            <text x={LABEL_W + 2} y={lanes.length * LANE_H + 20} fill="#4b5060" fontSize={8}>
              frame
            </text>
          </g>
        </svg>
      </div>

      {band.length < 2 && (
        <p style={{ color: DIM, fontSize: 12.5, padding: "10px 12px", margin: 0 }}>
          Only one deck in range — the register needs a deck above or below this one
          for a trace to mean anything.
        </p>
      )}
      {frames.length === 0 && (
        <p style={{ color: DIM, fontSize: 12.5, padding: "10px 12px", margin: 0 }}>
          No compartment in these three decks carries a frame station, so there is
          nothing to place on the axis.
        </p>
      )}
    </div>
  );
}

/**
 * Positions one deck's plate so the frame window `fLo…fHi` spans the lane.
 *
 * Two anchors do all the work: frame `fHi` lands on the lane's left edge and
 * `fLo` on its right. Because both come from THIS plate's calibration, lanes drawn
 * from plates at different scales end up frame-aligned with each other — which is
 * the only reason a plumb line down the stack is meaningful.
 */
function platedLane(
  sheet: DeckSheet,
  cal: SheetCalibration,
  fLo: number,
  fHi: number,
  top: number,
) {
  const left = sheetX(cal, fHi);
  const right = sheetX(cal, fLo);
  const spread = right - left;
  if (spread <= 0) return null;
  const k = (W - LABEL_W) / spread;
  return (
    <image
      href={`decks/${sheet.file}`}
      x={LABEL_W - left * k}
      y={top + LANE_H / 2 - cal.centrelineY * k}
      width={sheet.width * k}
      height={sheet.height * k}
      // Inverted, not just dimmed. The plates are black ink on white paper, and
      // in the deck view that is right because the drawing IS the subject. Here it
      // is a substrate under three lanes of markers, and a white block behind dark
      // chips makes the markers the hardest thing on screen to read. Inverting
      // turns the ink into light lines on the panel's own background, which is
      // what a substrate should look like.
      style={{ filter: "invert(1) brightness(0.62) contrast(1.15)" }}
      preserveAspectRatio="none"
    />
  );
}

/**
 * Stacking level per marker so labels in one lane do not overlap.
 *
 * Measured in frames, because that is the unit the axis is in: a label is 80 of
 * 908 lane units wide, so it covers `fSpan * 80/908` frames.
 */
function laneLevels(rows: DeckStateRow[], fSpan: number): Map<string, number> {
  const gap = (fSpan * 86) / (W - LABEL_W);
  const level = new Map<string, number>();
  const occupied: number[] = [];
  const ordered = rows
    .filter((r) => r.compartment.frame !== null)
    .sort(
      (a, b) =>
        (a.compartment.frame ?? 0) - (b.compartment.frame ?? 0) ||
        a.compartment.compartment_no.localeCompare(b.compartment.compartment_no),
    );
  for (const r of ordered) {
    const frame = r.compartment.frame ?? 0;
    let lane = 0;
    while (lane < occupied.length && frame - (occupied[lane] ?? -Infinity) < gap) lane += 1;
    occupied[lane] = frame;
    level.set(r.compartment.compartment_no, lane);
  }
  return level;
}

/** Round tick frames inside the window. */
function frameTicks(fLo: number, fHi: number): number[] {
  const step = tickStep(fHi - fLo);
  const out: number[] = [];
  for (let f = Math.ceil(fLo / step) * step; f <= fHi; f += step) out.push(f);
  return out;
}

const navBtn: React.CSSProperties = {
  width: 24,
  height: 20,
  borderRadius: 4,
  cursor: "pointer",
  background: "transparent",
  color: C.dim,
  border: `1px solid ${C.line}`,
  font: "inherit",
  fontSize: 9,
  lineHeight: 1,
  padding: 0,
};
