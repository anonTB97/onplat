// The whole-of-ship view: every deck as a lane, and on each lane the two facts
// that only mean something TOGETHER — where the work is, and whether people
// can work there.
//
// Four layers, composed so the conflict is a colour collision instead of a
// cross-referencing exercise:
//
//   ground   — every compartment's footprint box, filled with its ENGINE STATE
//              (can people work here, right now); refused spaces read solid.
//   work     — activity chips stacked above their space, coloured by SCHEDULE
//              STATUS, stems dropping into the space they happen in. Blue
//              chips on a red box IS "crews planned into a space that refuses
//              work" — no lookup required.
//   cause    — the selected space's hazard cascade drawn across the lanes, so
//              "why" travels with "where", like the vertical trace.
//   boundary — the zone bands as a toggle, so "zones applied properly" is
//              checkable across the whole hull at once.
//
// Same alignment discipline as the vertical trace: each lane's plate is placed
// by its own calibration onto one shared frame window, so a vertical line down
// the stack is the same frame on every deck. What cannot be placed is counted,
// never hidden: unlocated activities and milestones have no position, and the
// footer says exactly how many the drawing is not showing.

import { useEffect, useRef, useState } from "react";
import type { Activity, Deck, DeckStateRow } from "./api";
import { clampZoom, planZoomAt, wheelFactor } from "./camera";
import { plateSlice } from "./VerticalTrace";
import { sheetForDeck } from "./deckSheets";
import { C, STATE_STYLE, zoneColour } from "./theme";
import type { ZoneGeometry } from "./zones";

const DIM = C.dim;
const LINE = C.line;

/** viewBox width — matches the trace so the maths reads the same. */
const W = 1000;
const LABEL_W = 92;
/** Lane height: chips above, the space's state box at the base. */
const LANE_H = 86;
const GUTTER = 2;
const RULER_H = 26;
const PAD_FRAMES = 8;
const MAX_SHIP_ZOOM = 8;
/** The state box strip at the base of each lane. */
const BOX_H = 14;

const STATUS_FG: Record<Activity["status"], string> = {
  not_started: "#94a3b8",
  in_progress: "#3D6BFF",
  complete: "#22c55e",
};

interface PlacedChip {
  activity: Activity;
  deckCode: string;
  frame: number;
  compartment: string;
  level: number;
}

/** Chips that could not fit the lane at this zoom, rolled up not dropped. */
interface MoreChip {
  frame: number;
  compartment: string;
  deckCode: string;
  codes: string[];
}

/** Chip stack rows a lane can hold above its state-box strip. */
const MAX_CHIP_LEVELS = 4;

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
  cascadeEdges,
  zonesOn,
  zones,
  zoneAlerts,
  onPick,
}: {
  decks: Deck[];
  rows: DeckStateRow[];
  activities: Activity[];
  /** The selected compartment — its box and chips ring in accent. */
  selected: string | null;
  /** The selected space's hazard route, compartment to compartment. */
  cascadeEdges: [string, string][];
  /** Shade the zone bands across the whole hull. */
  zonesOn: boolean;
  /** The hull's zone bands and audit, shared with the single-deck plate so the
   *  two views cannot disagree about where a zone ends. */
  zones: ZoneGeometry;
  /** Spaces the server's audit puts outside their zone's authored bounds. */
  zoneAlerts?: Set<string>;
  /** Routes to the space (deck + compartment), with the options in view. */
  onPick: (deckCode: string, compartment: string) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  // The time dimension, as a focus rather than a filter: chips whose planned
  // window does not contain the instant dim, so "what runs NOW" reads at a
  // glance while the rest of the plan stays counted and visible.
  const [windowFocus, setWindowFocus] = useState(false);
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
  const laneTop = new Map(ordered.map((d, i) => [d.code, i * LANE_H]));

  // Where each compartment lives, per the register.
  const spaceOf = new Map<string, DeckStateRow>();
  for (const r of rows) spaceOf.set(r.compartment.compartment_no, r);

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
    if (!home || home.compartment.frame === null) {
      offRegister += 1;
      continue;
    }
    placeable.push({
      activity: a,
      deck: home.compartment.deck_code,
      frame: home.compartment.frame,
      compartment: a.compartment_no,
    });
  }

  // The frame window is the WHOLE hull, not the work's extent: the content is
  // the entire deck level and framing the work is the camera's job. Fitting
  // the window to the work made zooming out a no-op — the rest of the ship
  // was cropped away before the camera ever saw it.
  const frames = [
    ...placeable.map((p) => p.frame),
    ...rows.map((r) => r.compartment.frame).filter((f): f is number => f !== null),
  ];
  const fLo = 0;
  const fHi = Math.max(280, ...frames.map((f) => f + PAD_FRAMES));
  const fSpan = Math.max(1, fHi - fLo);
  const xOf = (frame: number) => LABEL_W + ((fHi - frame) / fSpan) * (W - LABEL_W);
  /** Half-width of a state box: about two frames of hull, clamped legible. */
  const boxHalfW = Math.min(34, Math.max(12, (2.2 * (W - LABEL_W)) / fSpan));

  // Chip stack levels per lane so chips at the same frame do not overlap. The
  // collision gap shrinks as the camera zooms in — chips spread back out into
  // their own columns — and whatever still cannot fit within the lane at the
  // current zoom rolls up into a "+n" chip rather than bleeding into the deck
  // below. Aggregated, never dropped: the "+n" names its activities and
  // routes like any chip.
  const gapEff = (fSpan * 60) / ((W - LABEL_W) * zoom);
  const perDeck = new Map<string, { chips: PlacedChip[]; more: MoreChip[] }>();
  for (const deck of ordered) {
    const mine = placeable
      .filter((p) => p.deck === deck.code)
      .sort((a, b) => a.frame - b.frame || a.activity.code.localeCompare(b.activity.code));
    const occupied: number[] = [];
    const chips: PlacedChip[] = [];
    const buckets = new Map<number, MoreChip>();
    for (const p of mine) {
      let level = 0;
      while (level < occupied.length && p.frame - (occupied[level] ?? -Infinity) < gapEff) level += 1;
      if (level < MAX_CHIP_LEVELS) {
        occupied[level] = p.frame;
        chips.push({ activity: p.activity, deckCode: p.deck, frame: p.frame, compartment: p.compartment, level });
      } else {
        const slot = Math.round(p.frame / Math.max(1, gapEff));
        const bucket = buckets.get(slot);
        if (bucket) {
          bucket.codes.push(p.activity.code);
        } else {
          buckets.set(slot, { frame: p.frame, compartment: p.compartment, deckCode: p.deck, codes: [p.activity.code] });
        }
      }
    }
    perDeck.set(deck.code, { chips, more: [...buckets.values()] });
  }

  const lanesH = ordered.length * LANE_H;
  const H = lanesH + RULER_H;
  /** The centre of a compartment's state box, for stems and cascade edges. */
  const boxCentre = (r: DeckStateRow): { x: number; y: number } | null => {
    const frame = r.compartment.frame;
    const top = laneTop.get(r.compartment.deck_code);
    if (frame === null || top === undefined) return null;
    return { x: xOf(frame), y: top + LANE_H - GUTTER - BOX_H / 2 };
  };

  // Violation focus — the same grammar as the vertical trace, on the same
  // trigger: click a refused space and the whole hull becomes an answer about
  // THAT violation. The selected space and every space on the hazard's route
  // stay lit (ground boxes and work chips alike), everything else dims. A
  // space that permits work focuses nothing — there is no violation to
  // isolate.
  const selectedRow = selected !== null ? spaceOf.get(selected) : undefined;
  const violationFocus = selectedRow !== undefined && !selectedRow.permits_work;
  const involved = new Set<string>(
    violationFocus && selected !== null ? [selected, ...cascadeEdges.flat()] : [],
  );

  const refused = placeable.filter((p) => p.activity.executability.verdict === "not_executable").length;
  // The composed fact this view exists for: spaces the engine refuses that
  // have work planned into them.
  const chipsBySpace = new Map<string, number>();
  for (const p of placeable) chipsBySpace.set(p.compartment, (chipsBySpace.get(p.compartment) ?? 0) + 1);
  const conflicted = rows.filter(
    (r) => !r.permits_work && (chipsBySpace.get(r.compartment.compartment_no) ?? 0) > 0,
  ).length;

  const zoomTo = (zNew: number) => {
    const clamped = clampZoom(zNew, MAX_SHIP_ZOOM);
    setPan(planZoomAt(camRef.current, { x: W / 2, y: H / 2 }, clamped));
    setZoom(clamped);
  };

  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: 8, background: "#0e0f13", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 11px", borderBottom: `1px solid ${LINE}`, fontSize: 11, fontWeight: 600, flexWrap: "wrap" }}>
        <span>Whole ship — the work, and whether it can proceed</span>
        <span style={{ color: DIM, fontWeight: 400 }}>
          {placeable.length} activities placed
          {conflicted > 0 && (
            <>
              {" "}·{" "}
              <b style={{ color: "#f87171" }}>
                {conflicted} space{conflicted === 1 ? "" : "s"} refuse{conflicted === 1 ? "s" : ""} work with work planned into {conflicted === 1 ? "it" : "them"}
              </b>
            </>
          )}
          {refused > 0 && (
            <>
              {" "}· <b style={{ color: "#fbbf24" }}>{refused} not executable as planned</b>
            </>
          )}
          {violationFocus && (
            <>
              {" "}·{" "}
              <b style={{ color: STATE_STYLE.SUSPEND.fg }}>
                violation focus — {involved.size === 1
                  ? "the hold is in this space itself"
                  : `${involved.size} spaces on the hazard's route`}; everything else dims
              </b>
            </>
          )}
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 4, alignItems: "center" }}>
          <label
            style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10.5, color: windowFocus ? C.text : DIM, fontWeight: 400, cursor: "pointer", marginRight: 6 }}
            title="Dim work not planned for the instant on the time control — marked, never hidden."
          >
            <input type="checkbox" checked={windowFocus} onChange={(e) => setWindowFocus(e.target.checked)} />
            in-window focus
          </label>
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

            {/* Lane chrome: substrate plates, borders, labels. */}
            {ordered.map((deck, i) => {
              const top = i * LANE_H;
              const sheet = sheetForDeck(deck.code);
              const lane = perDeck.get(deck.code);
              const count = (lane?.chips.length ?? 0) + (lane?.more.reduce((s, m) => s + m.codes.length, 0) ?? 0);
              return (
                <g key={deck.code}>
                  <rect x={0} y={top} width={W} height={LANE_H} fill={i % 2 === 0 ? "#0e0f13" : "#101118"} />
                  <rect x={LABEL_W} y={top + GUTTER} width={W - LABEL_W} height={LANE_H - GUTTER * 2} fill="#0b0c0e" />
                  {sheet?.calibration && (
                    <g clipPath={`url(#ship-lane-${deck.code})`} opacity={0.7}>
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
                    {count === 0 ? "no activities" : `${count} activit${count === 1 ? "y" : "ies"}`}
                  </text>
                </g>
              );
            })}

            {/* Boundary layer: the hull's zone bands — inferred once in
                zones.ts, tiled edge to edge, shared with the single-deck plate
                so no two views can disagree about where a zone ends. */}
            {zonesOn &&
              zones.bands.map((band) => {
                const colour = zoneColour(band.zone);
                const x1 = xOf(band.hi);
                const x2 = xOf(band.lo);
                const [bandX, bandW] = x1 < x2 ? [x1, x2 - x1] : [x2, x1 - x2];
                // Authored bounds draw solid — a chart's word; inferred bands
                // stay dashed — this module's guess, and it says so.
                const dash = band.authored ? undefined : "7 5";
                return (
                  <g key={band.zone} pointerEvents="none">
                    <rect x={bandX} y={0} width={bandW} height={lanesH} fill={colour} opacity={0.06} />
                    <line x1={bandX} y1={0} x2={bandX} y2={lanesH} stroke={colour} strokeWidth={band.authored ? 1.3 : 1} strokeDasharray={dash} opacity={0.5} />
                    <line x1={bandX + bandW} y1={0} x2={bandX + bandW} y2={lanesH} stroke={colour} strokeWidth={band.authored ? 1.3 : 1} strokeDasharray={dash} opacity={0.5} />
                    <text x={bandX + 5} y={9} fill={colour} fontSize={9 / zoom} fontWeight={700} letterSpacing={0.8}>
                      {band.zone}
                    </text>
                  </g>
                );
              })}

            {/* Where extents overlap, the double shading already shows it; the
                bracket names it, so the reader knows the view knows. */}
            {zonesOn &&
              zones.overlaps.map((o) => {
                const x1 = xOf(o.hi);
                const x2 = xOf(o.lo);
                const [ox, ow] = x1 < x2 ? [x1, x2 - x1] : [x2, x1 - x2];
                return (
                  <g key={`${o.a}-${o.b}`} pointerEvents="none">
                    <rect x={ox} y={0} width={ow} height={lanesH} fill="none" stroke="#f59e0b" strokeWidth={0.8} strokeDasharray="3 3" opacity={0.7} />
                    <text x={ox + ow / 2} y={lanesH - 5} fill="#f59e0b" fontSize={8 / zoom} fontWeight={700} textAnchor="middle">
                      {o.a} ∩ {o.b}
                    </text>
                  </g>
                );
              })}

            {/* Ground layer: every compartment's footprint, filled with its
                engine state. This is the "can people work here" answer the
                chips land on. */}
            {rows.map((r) => {
              const c = boxCentre(r);
              if (!c) return null;
              const no = r.compartment.compartment_no;
              const tone = STATE_STYLE[r.state];
              const isSel = no === selected;
              const inViolation = involved.has(no);
              const dimmed = violationFocus && !inViolation;
              // Divided by zoom: the footprint's WIDTH is hull geometry and
              // grows with the drawing, but the strip height, text and strokes
              // are labels and keep their screen size.
              const sc = 1 / zoom;
              const y = c.y - (BOX_H * sc) / 2;
              return (
                <g
                  key={no}
                  onClick={() => onPick(r.compartment.deck_code, no)}
                  style={{ cursor: "pointer" }}
                  opacity={dimmed ? 0.45 : 1}
                >
                  <title>
                    {`${no} — ${r.compartment.name}\n${r.state}${r.permits_work ? "" : " — refuses work"} · ${r.compartment.zone}${r.clearing_authority ? `\ncleared by ${r.clearing_authority}` : ""}`}
                  </title>
                  {/* The violation's own spaces get a halo, so the route reads
                      even where lit and dimmed boxes sit close. */}
                  {violationFocus && inViolation && (
                    <rect
                      x={c.x - boxHalfW - 3 * sc} y={y - 3 * sc}
                      width={boxHalfW * 2 + 6 * sc} height={BOX_H * sc + 6 * sc} rx={4 * sc}
                      fill="none" stroke={isSel ? C.accent : STATE_STYLE.SUSPEND.fg}
                      strokeWidth={1.2 * sc} opacity={0.75}
                    />
                  )}
                  {/* A space the audit puts outside its zone's authored
                      bounds — the chart and the register disagree, and the
                      drawing says so where the space actually sits. */}
                  {zonesOn && zoneAlerts?.has(no) && (
                    <rect
                      x={c.x - boxHalfW - 3 * sc} y={y - 3 * sc}
                      width={boxHalfW * 2 + 6 * sc} height={BOX_H * sc + 6 * sc} rx={4 * sc}
                      fill="none" stroke="#f59e0b"
                      strokeWidth={1.4 * sc} strokeDasharray={`${3 * sc} ${2 * sc}`} opacity={0.9}
                    />
                  )}
                  <rect
                    x={c.x - boxHalfW} y={y} width={boxHalfW * 2} height={BOX_H * sc} rx={2 * sc}
                    fill={tone.fg} opacity={r.permits_work ? 0.1 : 0.26}
                  />
                  <rect
                    x={c.x - boxHalfW} y={y} width={boxHalfW * 2} height={BOX_H * sc} rx={2 * sc}
                    fill="none"
                    stroke={isSel ? C.accent : tone.fg}
                    strokeWidth={(isSel ? 1.8 : r.permits_work ? 0.7 : 1.4) * sc}
                    opacity={r.permits_work && !isSel ? 0.55 : 1}
                  />
                  <text x={c.x} y={y + BOX_H * sc - 4 * sc} fill={tone.fg} fontSize={5.6 * sc} textAnchor="middle" fontFamily="monospace">
                    {no}
                  </text>
                </g>
              );
            })}

            {/* Work layer: the chips, stems dropping into the space they
                happen in. Blue on red is the sentence this view speaks. */}
            {ordered.map((deck) =>
              (perDeck.get(deck.code)?.chips ?? []).map((p) => {
                const a = p.activity;
                const top = laneTop.get(deck.code) ?? 0;
                const doomed = a.executability.verdict === "not_executable";
                const isSel = p.compartment === selected;
                const fg = doomed ? "#fca5a5" : STATUS_FG[a.status];
                const sc = 1 / zoom;
                const x = xOf(p.frame);
                const y = top + (10 + p.level * 12) * sc;
                // The two focuses compose: a chip outside both the violation's
                // route and the instant's window earns both dims.
                const dim =
                  (violationFocus && !involved.has(p.compartment) ? 0.45 : 1) *
                  (windowFocus && !a.in_window ? 0.35 : 1);
                return (
                  <g
                    key={a.activity_id}
                    onClick={() => onPick(p.deckCode, p.compartment)}
                    style={{ cursor: "pointer" }}
                    opacity={dim}
                  >
                    <title>
                      {`${a.code} — ${a.name}\n${a.trade} · ${p.compartment}${a.compartment_reliability !== "high" ? " (≈ read from the task name, not authored)" : ""} · ${a.status.replace("_", " ")}${doomed ? "\nNOT EXECUTABLE AS PLANNED — click for the options" : ""}`}
                    </title>
                    <line
                      x1={x} y1={y + 4 * sc} x2={x} y2={top + LANE_H - GUTTER - BOX_H * sc}
                      stroke={fg} strokeWidth={0.5 * sc} opacity={0.35}
                    />
                    <rect
                      x={x - 28 * sc} y={y - 5 * sc} width={56 * sc} height={11 * sc} rx={2.5 * sc}
                      fill={doomed ? "rgba(239,68,68,0.16)" : "#0b0c0eE6"}
                      stroke={isSel ? C.accent : doomed ? "#ef4444" : fg}
                      strokeWidth={(isSel ? 1.6 : doomed ? 1.2 : 0.8) * sc}
                    />
                    <text x={x} y={y + 3 * sc} fill={fg} fontSize={7 * sc} textAnchor="middle" fontFamily="monospace">
                      {a.code}
                    </text>
                  </g>
                );
              }),
            )}

            {/* The roll-ups: chips the lane could not hold at this zoom. */}
            {ordered.map((deck) =>
              (perDeck.get(deck.code)?.more ?? []).map((m) => {
                const top = laneTop.get(deck.code) ?? 0;
                const sc = 1 / zoom;
                const x = xOf(m.frame);
                const y = top + (10 + MAX_CHIP_LEVELS * 12) * sc;
                return (
                  <g
                    key={`${deck.code}-more-${m.frame}`}
                    onClick={() => onPick(m.deckCode, m.compartment)}
                    style={{ cursor: "pointer" }}
                    opacity={violationFocus && !involved.has(m.compartment) ? 0.45 : 1}
                  >
                    <title>{`${m.codes.length} more here — zoom in to spread them out\n${m.codes.join(", ")}`}</title>
                    <rect x={x - 13 * sc} y={y - 5 * sc} width={26 * sc} height={10 * sc} rx={2.5 * sc} fill="#0b0c0eE6" stroke="#6e7480" strokeWidth={0.8 * sc} />
                    <text x={x} y={y + 3 * sc} fill="#94a3b8" fontSize={6.5 * sc} textAnchor="middle" fontFamily="monospace">
                      +{m.codes.length}
                    </text>
                  </g>
                );
              }),
            )}

            {/* Cause layer: the selected space's hazard route across the hull —
                why the red box is red, travelling with where it is. */}
            {cascadeEdges.map(([from, to]) => {
              const a = spaceOf.get(from);
              const b = spaceOf.get(to);
              const ca = a && boxCentre(a);
              const cb = b && boxCentre(b);
              if (!ca || !cb) return null;
              return (
                <line
                  key={`${from}-${to}`}
                  x1={ca.x} y1={ca.y} x2={cb.x} y2={cb.y}
                  stroke={STATE_STYLE.SUSPEND.fg} strokeWidth={1.6} strokeDasharray="6 4"
                  pointerEvents="none"
                />
              );
            })}

            {/* Shared frame ruler. */}
            <g>
              <line x1={LABEL_W} y1={lanesH} x2={W} y2={lanesH} stroke="#2b2d36" />
              {(() => {
                const step = tickStep(fSpan);
                const ticks: number[] = [];
                for (let f = Math.ceil(fLo / step) * step; f <= fHi; f += step) ticks.push(f);
                return ticks.map((f) => (
                  <g key={f}>
                    <line x1={xOf(f)} y1={lanesH} x2={xOf(f)} y2={lanesH + 4} stroke="#4b5060" />
                    <text x={xOf(f)} y={lanesH + 20} fill="#6e7480" fontSize={8.5} textAnchor="middle" fontFamily="monospace">
                      {f}
                    </text>
                  </g>
                ));
              })()}
              <text x={W - 2} y={lanesH + 20} fill="#4b5060" fontSize={8} textAnchor="end">
                bow →
              </text>
              <text x={LABEL_W + 2} y={lanesH + 20} fill="#4b5060" fontSize={8}>
                frame
              </text>
            </g>
          </g>
        </svg>
      </div>

      {/* Two colour languages, said out loud; and what the drawing is NOT
          showing, counted rather than hidden. */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center", padding: "7px 11px", borderTop: `1px solid ${LINE}`, fontSize: 10.5, color: DIM }}>
        <span style={{ color: "#6e7480", textTransform: "uppercase", fontSize: 8.5, letterSpacing: 0.8 }}>Boxes · space state</span>
        {(["ALLOW", "WARN", "SUSPEND", "BLOCK"] as const).map((s) => (
          <span key={s} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: STATE_STYLE[s].fg }} />
            {s}
          </span>
        ))}
        <span style={{ width: 1, height: 12, background: LINE }} />
        <span style={{ color: "#6e7480", textTransform: "uppercase", fontSize: 8.5, letterSpacing: 0.8 }}>Chips · schedule</span>
        <span><span style={{ color: STATUS_FG.in_progress }}>■</span> in progress</span>
        <span><span style={{ color: STATUS_FG.not_started }}>■</span> not started</span>
        <span><span style={{ color: STATUS_FG.complete }}>■</span> complete</span>
        <span><span style={{ color: "#ef4444" }}>■</span> not executable</span>
        {zonesOn && (
          <>
            <span style={{ width: 1, height: 12, background: LINE }} />
            <span
              style={{ color: zones.overlaps.length > 0 ? "#fbbf24" : "#22c55e" }}
              title="Each band is its zone's spaces' true extent, padded two frames — inferred from the register until a zones register carries authored bounds. Overlaps are reported as facts: legitimate where zones are functional rather than longitudinal, and the place to look hard where a scheme is supposed to partition."
            >
              bands inferred from the register ·{" "}
              {zones.overlaps.length > 0
                ? zones.overlaps
                    .map((o) => `${o.a}∩${o.b} Fr ${o.lo}–${o.hi} (${o.spaces} spaces)`)
                    .join(" · ")
                : "extents are disjoint — no anomalies"}
            </span>
            {zones.unplaced > 0 && (
              <span style={{ color: "#f59e0b" }}>{zones.unplaced} spaces carry no frame (not shaded)</span>
            )}
            {zones.bandless.length > 0 && (
              <span style={{ color: "#f59e0b" }}>no band for {zones.bandless.join(", ")}</span>
            )}
          </>
        )}
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
