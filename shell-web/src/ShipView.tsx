// The whole-of-ship view: every deck as a lane, every located activity drawn
// on the deck it happens on, one shared frame axis top to bottom.
//
// The vertical trace answers "what sits directly above this space"; this
// answers the superintendent's wall question — "where is the WORK" — for the
// entire hull at once. Same alignment discipline as the trace: each lane's
// plate is placed by its own calibration onto the common frame window, so a
// vertical line down the stack is the same frame on every deck.
//
// What a marker is here is different from every other canvas: these are
// ACTIVITIES (the register's rows, the thing a crew is handed), not
// compartment states. An activity is placed at its compartment's frame on its
// compartment's deck, coloured by schedule status, and flagged red when the
// A4 derivation says it cannot execute as planned. What cannot be placed is
// counted, never hidden: unlocated activities and milestones have no
// position, and the footer says exactly how many the drawing is not showing.

import { useEffect, useRef, useState } from "react";
import type { Activity, Deck, DeckStateRow } from "./api";
import { clampZoom, planZoomAt, wheelFactor } from "./camera";
import { plateSlice } from "./VerticalTrace";
import { sheetForDeck } from "./deckSheets";
import { C } from "./theme";

const DIM = C.dim;
const LINE = C.line;

/** viewBox width — matches the trace so the maths reads the same. */
const W = 1000;
const LABEL_W = 92;
/** Lane height: twelve decks have to fit a wall display without scrolling. */
const LANE_H = 72;
const GUTTER = 2;
const RULER_H = 26;
const PAD_FRAMES = 8;
const MAX_SHIP_ZOOM = 8;

const STATUS_FG: Record<Activity["status"], string> = {
  not_started: "#94a3b8",
  in_progress: "#3D6BFF",
  complete: "#22c55e",
};

/** One placed activity chip. */
interface Placed {
  activity: Activity;
  deckCode: string;
  frame: number;
  compartment: string;
  level: number;
}

function tickStep(span: number): number {
  for (const step of [5, 10, 20, 50, 100]) {
    if (span / step <= 12) return step;
  }
  return 200;
}

export function ShipView({
  decks,
  rows,
  activities,
  selected,
  onPick,
}: {
  decks: Deck[];
  rows: DeckStateRow[];
  activities: Activity[];
  /** The selected compartment — its activities ring in accent. */
  selected: string | null;
  /** Routes to the space (deck + compartment), with the options in view. */
  onPick: (deckCode: string, compartment: string) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const wheelRef = useRef<HTMLDivElement>(null);
  const camRef = useRef({ zoom, pan });
  camRef.current = { zoom, pan };
  const dragging = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const el = wheelRef.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent) => {
      const svg = el.querySelector("svg");
      if (!svg) return;
      e.preventDefault();
      const cam = camRef.current;
      const zNew = clampZoom(cam.zoom * wheelFactor(e.deltaY, e.deltaMode, e.ctrlKey), MAX_SHIP_ZOOM);
      if (zNew === cam.zoom) return;
      const box = svg.getBoundingClientRect();
      const perPx = W / box.width;
      const cursor = { x: (e.clientX - box.left) * perPx, y: (e.clientY - box.top) * perPx };
      setPan(planZoomAt(cam, cursor, zNew));
      setZoom(zNew);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const ordered = [...decks].sort((a, b) => a.ordinal - b.ordinal);

  // Where each compartment lives: the register rows carry deck and frame.
  const spaceOf = new Map<string, { deck: string; frame: number | null }>();
  for (const r of rows) {
    spaceOf.set(r.compartment.compartment_no, {
      deck: r.compartment.deck_code,
      frame: r.compartment.frame,
    });
  }

  // Place every activity that CAN be placed; count everything that cannot.
  // Milestones are events, not work — they have no compartment by design.
  const work = activities.filter((a) => !a.is_milestone);
  const placeable: { activity: Activity; deck: string; frame: number; compartment: string }[] = [];
  let unlocated = 0;
  let offRegister = 0;
  for (const a of work) {
    if (a.compartment_no === null) {
      unlocated += 1;
      continue;
    }
    const home = spaceOf.get(a.compartment_no);
    if (!home || home.frame === null) {
      // A located activity whose space the register cannot place — a real
      // state once schedules are ingested, and worth its own count.
      offRegister += 1;
      continue;
    }
    placeable.push({ activity: a, deck: home.deck, frame: home.frame, compartment: a.compartment_no });
  }

  // The frame window is fitted to the placed work, like the trace.
  const frames = placeable.map((p) => p.frame);
  const fLo = frames.length > 0 ? Math.min(...frames) - PAD_FRAMES : 0;
  const fHi = frames.length > 0 ? Math.max(...frames) + PAD_FRAMES : 280;
  const fSpan = Math.max(1, fHi - fLo);
  const xOf = (frame: number) => LABEL_W + ((fHi - frame) / fSpan) * (W - LABEL_W);

  // Stack levels per lane so chips at the same frame do not overlap. Chips are
  // 58 lane-units wide; the gap is that width in frames.
  const gap = (fSpan * 60) / (W - LABEL_W);
  const perDeck = new Map<string, Placed[]>();
  for (const deck of ordered) {
    const mine = placeable
      .filter((p) => p.deck === deck.code)
      .sort((a, b) => a.frame - b.frame || a.activity.code.localeCompare(b.activity.code));
    const occupied: number[] = [];
    const placed: Placed[] = [];
    for (const p of mine) {
      let level = 0;
      while (level < occupied.length && p.frame - (occupied[level] ?? -Infinity) < gap) level += 1;
      occupied[level] = p.frame;
      placed.push({ activity: p.activity, deckCode: p.deck, frame: p.frame, compartment: p.compartment, level });
    }
    perDeck.set(deck.code, placed);
  }

  const H = ordered.length * LANE_H + RULER_H;
  const refused = placeable.filter((p) => p.activity.executability.verdict === "not_executable").length;

  const zoomTo = (zNew: number) => {
    const clamped = clampZoom(zNew, MAX_SHIP_ZOOM);
    setPan(planZoomAt(camRef.current, { x: W / 2, y: H / 2 }, clamped));
    setZoom(clamped);
  };

  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: 8, background: "#0e0f13", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 11px", borderBottom: `1px solid ${LINE}`, fontSize: 11, fontWeight: 600, flexWrap: "wrap" }}>
        <span>Whole ship — every activity, every deck</span>
        <span style={{ color: DIM, fontWeight: 400 }}>
          {placeable.length} placed · one shared frame axis
          {refused > 0 && (
            <>
              {" "}·{" "}
              <b style={{ color: "#f87171" }}>{refused} not executable as planned</b>
            </>
          )}
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 4, alignItems: "center" }}>
          <button onClick={() => zoomTo(zoom / 1.4)} style={navBtn} title="Zoom out (or scroll on the canvas)">−</button>
          <span style={{ fontSize: 9.5, color: DIM, fontWeight: 400, minWidth: 30, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>
            {zoom.toFixed(1)}×
          </span>
          <button onClick={() => zoomTo(zoom * 1.4)} style={navBtn} title="Zoom in (or scroll on the canvas)">+</button>
          <button
            onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
            style={navBtn}
            title="Reset the view"
            disabled={zoom === 1 && pan.x === 0 && pan.y === 0}
          >
            ⟲
          </button>
        </span>
      </div>

      <div ref={wheelRef}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          style={{ width: "100%", display: "block", background: "#0b0c0e", cursor: zoom > 1 ? "grab" : "default", touchAction: "none" }}
          onMouseDown={(e) => {
            dragging.current = { x: e.clientX, y: e.clientY };
          }}
          onMouseMove={(e) => {
            if (!dragging.current) return;
            const box = e.currentTarget.getBoundingClientRect();
            const perPx = W / box.width;
            setPan({
              x: pan.x + (e.clientX - dragging.current.x) * perPx,
              y: pan.y + (e.clientY - dragging.current.y) * perPx,
            });
            dragging.current = { x: e.clientX, y: e.clientY };
          }}
          onMouseUp={() => {
            dragging.current = null;
          }}
          onMouseLeave={() => {
            dragging.current = null;
          }}
        >
          <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
            <defs>
              {ordered.map((deck, i) => (
                <clipPath key={deck.code} id={`ship-lane-${deck.code}`}>
                  <rect x={LABEL_W} y={i * LANE_H + GUTTER} width={W - LABEL_W} height={LANE_H - GUTTER * 2} />
                </clipPath>
              ))}
            </defs>

            {ordered.map((deck, i) => {
              const top = i * LANE_H;
              const sheet = sheetForDeck(deck.code);
              const mine = perDeck.get(deck.code) ?? [];
              return (
                <g key={deck.code}>
                  <rect x={0} y={top} width={W} height={LANE_H} fill={i % 2 === 0 ? "#0e0f13" : "#101118"} />
                  <rect x={LABEL_W} y={top + GUTTER} width={W - LABEL_W} height={LANE_H - GUTTER * 2} fill="#0b0c0e" />
                  {sheet?.calibration && (
                    <g clipPath={`url(#ship-lane-${deck.code})`} opacity={0.75}>
                      {plateSlice(sheet, sheet.calibration, fLo, fHi, top, LANE_H, LABEL_W, W)}
                    </g>
                  )}
                  <rect
                    x={LABEL_W} y={top + GUTTER}
                    width={W - LABEL_W} height={LANE_H - GUTTER * 2}
                    fill="none" stroke="#2b2d36" strokeWidth={1}
                  />
                  <rect x={0} y={top} width={LABEL_W} height={LANE_H} fill={i % 2 === 0 ? "#0e0f13" : "#101118"} />
                  <text x={8} y={top + 15} fill={C.text} fontSize={9.5} fontWeight={600}>
                    {deck.label}
                  </text>
                  <text x={8} y={top + 26} fill="#4b5060" fontSize={8}>
                    {mine.length === 0 ? "no activities" : `${mine.length} activit${mine.length === 1 ? "y" : "ies"}`}
                  </text>

                  {mine.map((p) => {
                    const a = p.activity;
                    const doomed = a.executability.verdict === "not_executable";
                    const isSel = p.compartment === selected;
                    const fg = doomed ? "#fca5a5" : STATUS_FG[a.status];
                    const x = xOf(p.frame);
                    const y = top + 12 + p.level * 13;
                    return (
                      <g
                        key={a.activity_id}
                        onClick={() => onPick(p.deckCode, p.compartment)}
                        style={{ cursor: "pointer" }}
                      >
                        <title>
                          {`${a.code} — ${a.name}\n${a.trade} · ${p.compartment} · ${a.status.replace("_", " ")}${doomed ? "\nNOT EXECUTABLE AS PLANNED — click for the options" : ""}`}
                        </title>
                        <line x1={x} y1={y + 4} x2={x} y2={top + LANE_H - GUTTER} stroke={fg} strokeWidth={0.5} opacity={0.35} />
                        <rect
                          x={x - 28} y={y - 5} width={56} height={11} rx={2.5}
                          fill={doomed ? "rgba(239,68,68,0.16)" : "#0b0c0eE6"}
                          stroke={isSel ? C.accent : doomed ? "#ef4444" : fg}
                          strokeWidth={isSel ? 1.6 : doomed ? 1.2 : 0.8}
                        />
                        <text x={x} y={y + 3} fill={fg} fontSize={7} textAnchor="middle" fontFamily="monospace">
                          {a.code}
                        </text>
                      </g>
                    );
                  })}
                </g>
              );
            })}

            {/* Shared frame ruler. */}
            <g>
              <line x1={LABEL_W} y1={ordered.length * LANE_H} x2={W} y2={ordered.length * LANE_H} stroke="#2b2d36" />
              {(() => {
                const step = tickStep(fSpan);
                const ticks: number[] = [];
                for (let f = Math.ceil(fLo / step) * step; f <= fHi; f += step) ticks.push(f);
                return ticks.map((f) => (
                  <g key={f}>
                    <line x1={xOf(f)} y1={ordered.length * LANE_H} x2={xOf(f)} y2={ordered.length * LANE_H + 4} stroke="#4b5060" />
                    <text x={xOf(f)} y={ordered.length * LANE_H + 20} fill="#6e7480" fontSize={8.5} textAnchor="middle" fontFamily="monospace">
                      {f}
                    </text>
                  </g>
                ));
              })()}
              <text x={W - 2} y={ordered.length * LANE_H + 20} fill="#4b5060" fontSize={8} textAnchor="end">
                bow →
              </text>
              <text x={LABEL_W + 2} y={ordered.length * LANE_H + 20} fill="#4b5060" fontSize={8}>
                frame
              </text>
            </g>
          </g>
        </svg>
      </div>

      {/* What the drawing is NOT showing, counted rather than hidden. */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", padding: "7px 11px", borderTop: `1px solid ${LINE}`, fontSize: 10.5, color: DIM }}>
        <span><span style={{ color: STATUS_FG.in_progress }}>■</span> in progress</span>
        <span><span style={{ color: STATUS_FG.not_started }}>■</span> not started</span>
        <span><span style={{ color: STATUS_FG.complete }}>■</span> complete</span>
        <span><span style={{ color: "#ef4444" }}>■</span> not executable as planned</span>
        {unlocated > 0 && (
          <span style={{ color: "#f59e0b" }} title="The schedule did not say which compartment — visible on the Sequence Board, undrawable here.">
            {unlocated} unlocated (not drawn)
          </span>
        )}
        {offRegister > 0 && (
          <span style={{ color: "#f59e0b" }} title="Located in a compartment the register cannot place on a deck plate.">
            {offRegister} in unplaceable spaces (not drawn)
          </span>
        )}
        {activities.filter((a) => a.is_milestone).length > 0 && (
          <span title="Key events carry dates and no space — see the Sequence Board.">
            {activities.filter((a) => a.is_milestone).length} key events (no space, not drawn)
          </span>
        )}
      </div>
    </div>
  );
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
