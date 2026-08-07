import { useEffect, useMemo, useRef, useState } from "react";
import {
  compartmentState,
  deckStates,
  listDecks,
  type Deck,
  type DeckStateRow,
  type Decision,
  type Identity,
} from "./api";
import { framesPerSpan, frameToX, layoutPlan, packLanes, xToFrame } from "./deckGeometry";
import {
  halfBeamAt,
  sheetForDeck,
  sheetFrame,
  sheetX,
  sheetY,
  SHEET_SOURCE,
  type DeckSheet,
} from "./deckSheets";
import { C, fmtClear, STATE_STYLE } from "./theme";

const DIM = C.dim;
const LINE = C.line;
const TEXT = C.text;

/** By space = colour by authorization. By trade = colour by who works here. */
type Lens = "space" | "trade";
/** The real drawing, the schematic strip, or the three-deck vertical section. */
type View = "sheet" | "plan" | "vertical";

// A stable colour per trade, so a trade keeps its colour across decks.
const TRADE_COLOURS = ["#3D6BFF", "#22c55e", "#f59e0b", "#c4b5fd", "#f472b6", "#2dd4bf"];
function tradeColour(trade: string, all: string[]): string {
  const i = all.indexOf(trade);
  return i < 0 ? "#6e7480" : TRADE_COLOURS[i % TRADE_COLOURS.length];
}

export default function DeckExplorer({
  identity,
  vesselId,
  hullLabel,
}: {
  identity: Identity;
  vesselId: string;
  hullLabel: string;
}) {
  const [decks, setDecks] = useState<Deck[]>([]);
  const [rows, setRows] = useState<DeckStateRow[]>([]);
  const [selectedDeck, setSelectedDeck] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Prototype controls.
  const [lens, setLens] = useState<Lens>("space");
  const [view, setView] = useState<View>("sheet");
  const [restrictedOnly, setRestrictedOnly] = useState(false);
  const [tradeFilter, setTradeFilter] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [hoverFrame, setHoverFrame] = useState<number | null>(null);
  const dragging = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    setError(null);
    setSelected(null);
    setDecision(null);
    Promise.all([listDecks(identity, vesselId), deckStates(identity, vesselId)])
      .then(([d, r]) => {
        setDecks(d);
        setRows(r);
        setSelectedDeck(d[0]?.code ?? null);
      })
      .catch((e: unknown) => {
        setDecks([]);
        setRows([]);
        setError(String(e));
      });
  }, [identity, vesselId]);

  // Selecting a compartment fetches its full trace from the engine-backed
  // endpoint. The client never derives a state itself.
  useEffect(() => {
    if (!selected) return;
    compartmentState(identity, vesselId, selected)
      .then((r) => setDecision(r.decision))
      .catch(() => setDecision(null));
  }, [identity, vesselId, selected]);

  // The hops the hazard actually took, deduped across every rule that fired.
  // Drawn on both views: on the plan it shows the path across a deck, and in
  // the section it shows the part a single deck sheet can never show — the
  // penetration that carried it to another deck.
  const cascadeEdges = useMemo(() => {
    const seen = new Set<string>();
    const edges: [string, string][] = [];
    for (const step of decision?.trace ?? []) {
      for (let i = 0; i + 1 < step.path.length; i += 1) {
        const from = step.path[i];
        const to = step.path[i + 1];
        if (from === undefined || to === undefined) continue;
        const key = `${from}→${to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push([from, to]);
      }
    }
    return edges;
  }, [decision]);

  const allTrades = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => r.trades.forEach((t) => set.add(t)));
    return [...set].sort();
  }, [rows]);

  const visible = useMemo(
    () =>
      rows.filter((r) => {
        if (restrictedOnly && r.state === "ALLOW") return false;
        if (tradeFilter && !r.trades.includes(tradeFilter)) return false;
        return true;
      }),
    [rows, restrictedOnly, tradeFilter],
  );

  const onDeck = useMemo(
    () => visible.filter((r) => r.compartment.deck_code === selectedDeck),
    [visible, selectedDeck],
  );

  const deckOrdinal = decks.find((d) => d.code === selectedDeck)?.ordinal ?? 0;
  const selectedRow = rows.find((r) => r.compartment.compartment_no === selected);
  const sheet = sheetForDeck(selectedDeck);

  // Zoom and pan are per-deck-per-view; carrying them across a deck change
  // leaves you looking at empty sheet and wondering where the ship went.
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [selectedDeck, view]);

  // Colour for a marker under the current lens.
  const toneOf = (r: DeckStateRow) => {
    if (lens === "trade") {
      const t = r.trades[0];
      return t
        ? { fg: tradeColour(t, allTrades), bg: `${tradeColour(t, allTrades)}22`, border: tradeColour(t, allTrades) }
        : { fg: "#6e7480", bg: "#1a1c22", border: "#353842" };
    }
    return STATE_STYLE[r.state];
  };

  if (error) {
    return (
      <p style={{ color: STATE_STYLE.BLOCK.fg }}>
        This hull is out of scope for you, or the API is unreachable ({error}).
      </p>
    );
  }

  const restricted = rows.filter((r) => r.state !== "ALLOW");
  const parsedGeometry = rows.some((r) => r.compartment.geometry_source === "parsed");

  const seg = (active: boolean) => ({
    padding: "5px 11px",
    borderRadius: 6,
    cursor: "pointer",
    font: "inherit" as const,
    fontSize: 11.5,
    background: active ? "#20222b" : "transparent",
    color: active ? TEXT : DIM,
    border: `1px solid ${active ? C.accent : LINE}`,
  });

  return (
    <div>
      <div style={{ fontSize: 10, letterSpacing: 1.1, textTransform: "uppercase", color: C.accent }}>
        Deck Explorer · {hullLabel}
      </div>
      <h1 style={{ fontSize: 22, margin: "4px 0 2px" }}>Compartment authorization</h1>
      <p style={{ color: DIM, fontSize: 12.5, margin: "0 0 12px", maxWidth: 760 }}>
        State is computed by the rule engine and read through the API — the shell never
        derives it. {restricted.length} of {rows.length} compartments are currently
        restricted by a live hazard.
      </p>

      {/* controls: lens · view · filters — the prototype's chrome */}
      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 9.5, letterSpacing: 0.6, textTransform: "uppercase", color: DIM }}>Lens</span>
          <button style={seg(lens === "space")} onClick={() => setLens("space")} title="Show me my zone">
            By space
          </button>
          <button style={seg(lens === "trade")} onClick={() => setLens("trade")} title="Where can my crews work">
            By trade
          </button>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 9.5, letterSpacing: 0.6, textTransform: "uppercase", color: DIM }}>View</span>
          <button
            style={seg(view === "sheet")}
            onClick={() => setView("sheet")}
            disabled={!sheet}
            title={sheet ? "The general-arrangement plate for this deck" : "No plate for this deck"}
          >
            Sheet
          </button>
          <button style={seg(view === "plan")} onClick={() => setView("plan")}>Schematic</button>
          <button
            style={seg(view === "vertical")}
            onClick={() => setView("vertical")}
            title="Three decks at once — how a cascade travels between them"
          >
            Vertical section
          </button>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: DIM, cursor: "pointer" }}>
          <input type="checkbox" checked={restrictedOnly} onChange={(e) => setRestrictedOnly(e.target.checked)} />
          Restricted only
        </label>
        {lens === "trade" && allTrades.length > 0 && (
          <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
            <button style={seg(tradeFilter === null)} onClick={() => setTradeFilter(null)}>All trades</button>
            {allTrades.map((t) => (
              <button
                key={t}
                style={{ ...seg(tradeFilter === t), borderColor: tradeColour(t, allTrades) }}
                onClick={() => setTradeFilter(tradeFilter === t ? null : t)}
              >
                <span style={{ color: tradeColour(t, allTrades) }}>■</span> {t}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* deck rail — ordered downward, which is what makes "directly above" real */}
      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
        {decks.map((d) => {
          const isSel = d.code === selectedDeck;
          const n = rows.filter((r) => r.compartment.deck_code === d.code && r.state !== "ALLOW").length;
          return (
            <button
              key={d.code}
              onClick={() => setSelectedDeck(d.code)}
              style={{
                display: "flex", alignItems: "center", gap: 8, padding: "6px 11px",
                background: isSel ? "#20222b" : "transparent", color: isSel ? TEXT : DIM,
                border: `1px solid ${isSel ? C.accent : LINE}`, borderRadius: 6,
                cursor: "pointer", font: "inherit", fontSize: 12,
              }}
            >
              <span style={{ fontFamily: "monospace", opacity: 0.6 }}>{d.ordinal}</span>
              <span style={{ fontWeight: 600 }}>{d.label}</span>
              {n > 0 && (
                <span style={{
                  minWidth: 16, height: 16, borderRadius: 8, padding: "0 4px",
                  background: STATE_STYLE.BLOCK.fg, color: "#0b0c0e",
                  fontSize: 10, fontWeight: 700, display: "flex",
                  alignItems: "center", justifyContent: "center",
                }}>{n}</span>
              )}
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 18, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 560px", minWidth: 380 }}>
          {view === "vertical" ? (
            <VerticalSection
              decks={decks}
              rows={visible}
              centreOrdinal={deckOrdinal}
              selected={selected}
              onSelect={setSelected}
              toneOf={toneOf}
              cascadeEdges={cascadeEdges}
            />
          ) : view === "sheet" && sheet ? (
            <SheetView
              sheet={sheet}
              rows={onDeck}
              selected={selected}
              onSelect={setSelected}
              toneOf={toneOf}
              zoom={zoom}
              setZoom={setZoom}
              pan={pan}
              setPan={setPan}
              dragging={dragging}
              hoverFrame={hoverFrame}
              setHoverFrame={setHoverFrame}
              cascadeEdges={cascadeEdges}
            />
          ) : (
            <PlanView
              rows={onDeck}
              selected={selected}
              onSelect={setSelected}
              toneOf={toneOf}
              zoom={zoom}
              setZoom={setZoom}
              pan={pan}
              setPan={setPan}
              dragging={dragging}
              hoverFrame={hoverFrame}
              setHoverFrame={setHoverFrame}
              deckLabel={decks.find((d) => d.code === selectedDeck)?.label ?? "—"}
              cascadeEdges={cascadeEdges}
            />
          )}

          {parsedGeometry && (
            <p style={{ fontSize: 10.5, color: DIM, marginTop: 8 }}>
              Positions derived from the placard numbers — this class uses the USN
              deck-frame-side scheme. A hull whose register carries authored frame
              and side data uses that instead, and says <b>register</b>.
            </p>
          )}
        </div>

        {/* the decision trace — the contract with the safety authority */}
        <aside style={{ flex: "0 1 380px", minWidth: 320, border: `1px solid ${LINE}`, borderRadius: 8, padding: 14, background: "#121316" }}>
          <div style={{ fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: DIM }}>
            Decision trace
          </div>
          {!selectedRow && (
            <p style={{ color: DIM, fontSize: 12.5, marginTop: 8 }}>
              Select a compartment to see why it is in its current state — every rule that
              fired, the path the hazard took, and who may clear it.
            </p>
          )}
          {selectedRow && (
            <>
              <div style={{ marginTop: 6, display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontFamily: "monospace" }}>{selectedRow.compartment.compartment_no}</span>
                <span style={{ color: STATE_STYLE[selectedRow.state].fg, fontWeight: 700, fontSize: 12 }}>
                  {selectedRow.state}
                </span>
              </div>
              <div style={{ fontSize: 12.5, color: DIM }}>{selectedRow.compartment.name}</div>
              <div style={{ fontSize: 11, color: DIM, marginTop: 2 }}>
                {selectedRow.compartment.zone} · {selectedRow.compartment.category}
                {selectedRow.compartment.frame !== null && ` · Fr ${selectedRow.compartment.frame}`}
                {` · ${selectedRow.compartment.side}`}
              </div>

              {/* work booked here — what the trade lens is about */}
              {selectedRow.work_order_codes.length > 0 && (
                <div style={{ marginTop: 9, paddingTop: 9, borderTop: `1px solid ${LINE}` }}>
                  <div style={{ fontSize: 9.5, letterSpacing: 0.6, textTransform: "uppercase", color: DIM }}>
                    Work in this space
                  </div>
                  <div style={{ fontSize: 12, marginTop: 3 }}>
                    {selectedRow.work_order_codes.join(", ")}
                  </div>
                  <div style={{ fontSize: 11, color: DIM }}>
                    {selectedRow.trades.join(" · ")} — {selectedRow.remaining_hours.toLocaleString()} MH remaining
                  </div>
                </div>
              )}

              {decision?.trace.length === 0 && (
                <p style={{ color: DIM, fontSize: 12.5, marginTop: 10 }}>
                  No rule applies here. This is an explicit “nothing restricts this space”,
                  not an absence of information.
                </p>
              )}
              {decision?.trace.map((step, i) => {
                const s = STATE_STYLE[step.state];
                return (
                  <div key={`${step.rule_code}-${i}`} style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${LINE}` }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <span style={{ fontWeight: 700, color: s.fg, fontSize: 12 }}>{step.state}</span>
                      <span style={{ fontFamily: "monospace", fontSize: 11 }}>{step.rule_code}</span>
                      <span style={{ fontSize: 11, color: DIM }}>{step.depth} hop</span>
                    </div>
                    <div style={{ fontSize: 12.5, marginTop: 4 }}>{step.reason}</div>
                    <div style={{ fontSize: 11, color: DIM, marginTop: 4, fontFamily: "monospace" }}>
                      {step.path.join(" → ")}
                    </div>
                    {step.via.length > 0 && (
                      <div style={{ fontSize: 11, color: DIM }}>via {step.via.join(", ")}</div>
                    )}
                    <div style={{ fontSize: 11, color: DIM, marginTop: 4 }}>
                      {step.authority}
                    </div>
                    <div style={{ fontSize: 11, color: DIM }}>
                      Cleared by <b style={{ color: "#ccd1da" }}>{step.clearing_authority}</b> · earliest{" "}
                      {fmtClear(step.earliest_clear)}
                    </div>
                    <div style={{ fontSize: 10, color: "#5a6070", marginTop: 3, fontFamily: "monospace" }}>
                      rule version {step.rule_version}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </aside>
      </div>

      {/* legend */}
      <div style={{ display: "flex", gap: 14, marginTop: 12, flexWrap: "wrap", fontSize: 11, color: DIM }}>
        {lens === "space"
          ? (["ALLOW", "WARN", "SUSPEND", "BLOCK"] as const).map((s) => (
              <span key={s} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: STATE_STYLE[s].fg }} />
                {s}
              </span>
            ))
          : allTrades.map((t) => (
              <span key={t} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: tradeColour(t, allTrades) }} />
                {t}
              </span>
            ))}
      </div>
    </div>
  );
}

/**
 * The real general-arrangement plate, with authorization state pinned onto it.
 *
 * This is the view a planner and a deck-plate supervisor can actually argue in
 * front of, because it is the drawing they already use. Everything about it is
 * downstream of one fact: the plate's own frame ruler is the coordinate system,
 * so a compartment's frame maps to a pixel on *this* plate and no other
 * (see deckSheets.ts — the plates are not to a common scale).
 *
 * Labels appear only when there is room for them — selected, hovered, or zoomed
 * in past 2×. At fit-width zoom a carrier deck holds far more compartments than
 * labels, and drawing them all would hide the drawing they are annotating.
 */
function SheetView({
  sheet, rows, selected, onSelect, toneOf, zoom, setZoom, pan, setPan, dragging,
  hoverFrame, setHoverFrame, cascadeEdges,
}: {
  sheet: DeckSheet;
  rows: DeckStateRow[];
  selected: string | null;
  onSelect: (n: string) => void;
  toneOf: (r: DeckStateRow) => { fg: string; bg: string; border: string };
  zoom: number;
  setZoom: (z: number) => void;
  pan: { x: number; y: number };
  setPan: (p: { x: number; y: number }) => void;
  dragging: React.MutableRefObject<{ x: number; y: number } | null>;
  hoverFrame: number | null;
  setHoverFrame: (f: number | null) => void;
  cascadeEdges: [string, string][];
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(1000);

  // The viewport is a fixed-height window onto the plate, so the SVG's own
  // width has to be measured: the viewBox aspect must match the element's, or
  // zooming stretches the drawing.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const measure = () => setBoxW(el.clientWidth || 1000);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cal = sheet.calibration;
  const { width: W, height: H } = sheet;

  // Zoom 1 always fits the plate's full length, because the first question is
  // "where on the ship" and that needs the whole hull in view. The viewport then
  // grows with the zoom instead of staying tall and mostly empty: a 7000×728
  // plate fitted to width is a 90px ribbon, and a 460px box around it is dead
  // space that makes the drawing look broken.
  const fit = boxW / W;
  const boxH = Math.round(Math.min(520, Math.max(150, boxW * (H / W) * zoom)));
  const scale = fit * zoom;
  const vw = boxW / scale;
  const vh = boxH / scale;
  /** Sheet units per screen pixel — markers multiply by this to stay put. */
  const u = 1 / scale;

  // Clamp the window to the plate, but centre instead of clamping on any axis
  // where the window is larger than the plate — otherwise the drawing sticks to
  // the top-left corner with the slack all on one side.
  const axis = (want: number, extent: number, window: number) =>
    window >= extent
      ? extent / 2
      : Math.min(Math.max(want, window / 2), extent - window / 2);
  const centre = {
    x: axis(W / 2 + pan.x, W, vw),
    y: axis((cal?.centrelineY ?? H / 2) + pan.y, H, vh),
  };

  if (!cal) return null;

  const placed = new Map<string, { x: number; y: number }>();
  for (const r of rows) {
    const frame = r.compartment.frame;
    if (frame === null) continue;
    placed.set(r.compartment.compartment_no, {
      x: sheetX(cal, frame),
      y: sheetY(cal, sheet, r.compartment.side, frame),
    });
  }

  const showLabels = zoom >= 2.5;

  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: 8, background: "#0e0f13", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 11px", borderBottom: `1px solid ${LINE}`, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, fontWeight: 600 }}>{sheet.label} — general arrangement</span>
        <span style={{ fontSize: 10.5, color: DIM }}>bow right · drag to pan</span>
        {!showLabels && <span style={{ fontSize: 10.5, color: DIM }}>· zoom in for labels</span>}
        <span style={{ marginLeft: "auto", display: "flex", gap: 5, alignItems: "center" }}>
          <span style={{ fontSize: 10.5, color: DIM, fontVariantNumeric: "tabular-nums", minWidth: 62 }}>
            {hoverFrame !== null ? `Fr ${hoverFrame}` : "—"}
          </span>
          <button onClick={() => setZoom(Math.max(1, zoom - 1))} style={zoomBtn}>−</button>
          <span style={{ fontSize: 10.5, color: DIM, minWidth: 34, textAlign: "center" }}>{zoom.toFixed(0)}×</span>
          <button onClick={() => setZoom(Math.min(14, zoom + 1))} style={zoomBtn}>+</button>
          <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} style={zoomBtn}>Reset</button>
        </span>
      </div>

      <div ref={boxRef} style={{ height: boxH, background: "#f7f7f4" }}>
        <svg
          viewBox={`${centre.x - vw / 2} ${centre.y - vh / 2} ${vw} ${vh}`}
          style={{ width: "100%", height: boxH, display: "block", cursor: dragging.current ? "grabbing" : "grab", touchAction: "none" }}
          onPointerDown={(e) => {
            dragging.current = { x: e.clientX, y: e.clientY };
            (e.target as Element).setPointerCapture?.(e.pointerId);
          }}
          onPointerUp={() => { dragging.current = null; }}
          onPointerLeave={() => { dragging.current = null; setHoverFrame(null); }}
          onPointerMove={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            setHoverFrame(sheetFrame(cal, centre.x - vw / 2 + (e.clientX - box.left) * u));
            if (dragging.current) {
              // Drag moves the sheet under the cursor, so pan is the negated delta.
              setPan({
                x: pan.x - (e.clientX - dragging.current.x) * u,
                y: pan.y - (e.clientY - dragging.current.y) * u,
              });
              dragging.current = { x: e.clientX, y: e.clientY };
            }
          }}
        >
          <image href={`decks/${sheet.file}`} x={0} y={0} width={W} height={H} />

          {/* The hazard's path across this deck, drawn on the drawing itself. */}
          {cascadeEdges.map(([from, to]) => {
            const a = placed.get(from);
            const b = placed.get(to);
            if (!a || !b) return null;
            return (
              <line
                key={`${from}-${to}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke={STATE_STYLE.SUSPEND.fg} strokeWidth={2.5 * u}
                strokeDasharray={`${9 * u} ${6 * u}`}
              />
            );
          })}

          {rows.map((r) => {
            const at = placed.get(r.compartment.compartment_no);
            if (!at) return null;
            const tone = toneOf(r);
            const isSel = r.compartment.compartment_no === selected;
            const isHot = r.compartment.compartment_no === hovered;
            const label = isSel || isHot || showLabels;
            return (
              <g
                key={r.compartment.compartment_no}
                onClick={() => onSelect(r.compartment.compartment_no)}
                onPointerEnter={() => setHovered(r.compartment.compartment_no)}
                onPointerLeave={() => setHovered(null)}
                style={{ cursor: "pointer" }}
              >
                {/* A tick down to the keel line: on a busy plate the pin alone
                    does not make its frame station obvious. */}
                <line
                  x1={at.x} y1={at.y} x2={at.x} y2={cal.centrelineY}
                  stroke={tone.fg} strokeWidth={1.5 * u} opacity={0.6}
                />
                <circle
                  cx={at.x} cy={at.y} r={(isSel ? 9 : 6.5) * u}
                  fill={tone.fg} fillOpacity={0.9}
                  stroke={isSel ? "#ffffff" : "#101216"} strokeWidth={2 * u}
                />
                {label && (
                  <g>
                    <rect
                      x={at.x - 34 * u} y={at.y - 26 * u} width={68 * u} height={15 * u} rx={3 * u}
                      fill="#0b0c0e" fillOpacity={0.9} stroke={tone.fg} strokeWidth={1 * u}
                    />
                    <text
                      x={at.x} y={at.y - 15 * u} fill={tone.fg} fontSize={10 * u}
                      textAnchor="middle" fontFamily="monospace"
                    >
                      {r.compartment.compartment_no}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      <p style={{ fontSize: 10.5, color: DIM, padding: "7px 11px", margin: 0, borderTop: `1px solid ${LINE}` }}>
        {SHEET_SOURCE}. Frames are read off this plate's own ruler — the plates are
        not drawn to a common scale. Which side of the keel line a pin sits on comes
        from the register; how far off it sits is {Math.round(0.45 * halfBeamAt(cal, 150))}px
        of local half-beam, not a surveyed position.{" "}
        <b>The plate is real; the compartment register pinned to it is notional demo
        data</b>, so a pin marks its frame station, not a space you will find under
        that number on this drawing.
      </p>
    </div>
  );
}

/** The deck plan: compartments placed by frame and side, pannable and zoomable. */
function PlanView({
  rows, selected, onSelect, toneOf, zoom, setZoom, pan, setPan, dragging,
  hoverFrame, setHoverFrame, deckLabel, cascadeEdges,
}: {
  rows: DeckStateRow[];
  selected: string | null;
  onSelect: (n: string) => void;
  toneOf: (r: DeckStateRow) => { fg: string; bg: string; border: string };
  zoom: number;
  setZoom: (z: number) => void;
  pan: { x: number; y: number };
  setPan: (p: { x: number; y: number }) => void;
  dragging: React.MutableRefObject<{ x: number; y: number } | null>;
  hoverFrame: number | null;
  setHoverFrame: (f: number | null) => void;
  deckLabel: string;
  cascadeEdges: [string, string][];
}) {
  const W = 1000;
  const MARKER_W = 92;
  const MARKER_H = 26;
  // A lane is a marker plus enough gap that two stacked labels stay legible.
  const LANE_H = 34;

  // The sheet is as tall as the register makes it: a deck with six
  // compartments down one side needs three lanes to port, and squeezing them
  // into a fixed height would put them back on top of each other.
  const layout = useMemo(
    () =>
      layoutPlan(
        rows.map((r) => ({
          id: r.compartment.compartment_no,
          frame: r.compartment.frame,
          side: r.compartment.side,
        })),
        { width: W, markerWidth: MARKER_W, laneHeight: LANE_H, minHeight: 320 },
      ),
    [rows],
  );
  const H = layout.height;

  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: 8, background: "#0e0f13", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 11px", borderBottom: `1px solid ${LINE}`, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, fontWeight: 600 }}>{deckLabel} — plan</span>
        {/* Frame 1 is at the stem and numbering increases aft, and frameToX puts
            frame 0 at x≈0.95 — so this sheet reads bow-right, like the drawings
            the constants were tuned against. Labelled explicitly because getting
            it backwards would put a hazard at the wrong end of the ship. */}
        <span style={{ fontSize: 10.5, color: DIM }}>bow right · stern left</span>
        {(layout.lanes.port > 1 || layout.lanes.starboard > 1 || layout.lanes.centre > 1) && (
          // Said out loud because a planner could otherwise read the fan as
          // athwartships distance. Which side of the keel line a marker sits on
          // is real; how far out it sits is only spacing.
          <span style={{ fontSize: 10.5, color: DIM }} title="Markers are fanned off the keel line so they do not overlap">
            · fanned for legibility — depth is spacing, not distance off centreline
          </span>
        )}
        <span style={{ marginLeft: "auto", display: "flex", gap: 5, alignItems: "center" }}>
          <span style={{ fontSize: 10.5, color: DIM, fontVariantNumeric: "tabular-nums", minWidth: 62 }}>
            {hoverFrame !== null ? `Fr ${hoverFrame}` : "—"}
          </span>
          <button onClick={() => setZoom(Math.max(1, zoom - 0.25))} style={zoomBtn}>−</button>
          <span style={{ fontSize: 10.5, color: DIM, minWidth: 34, textAlign: "center" }}>{zoom.toFixed(2)}×</span>
          <button onClick={() => setZoom(Math.min(4, zoom + 0.25))} style={zoomBtn}>+</button>
          <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} style={zoomBtn}>Reset</button>
        </span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", display: "block", cursor: dragging.current ? "grabbing" : "grab", touchAction: "none" }}
        onPointerDown={(e) => {
          dragging.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
          (e.target as Element).setPointerCapture?.(e.pointerId);
        }}
        onPointerUp={() => { dragging.current = null; }}
        onPointerLeave={() => { dragging.current = null; setHoverFrame(null); }}
        onPointerMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          // Undo pan/zoom so the readout reports the frame under the cursor.
          const xFrac = ((e.clientX - box.left) / box.width - pan.x / W) / zoom;
          setHoverFrame(xToFrame(xFrac));
          if (dragging.current) {
            setPan({ x: e.clientX - dragging.current.x, y: e.clientY - dragging.current.y });
          }
        }}
      >
        <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
          {/* hull outline: a schematic stand-in for the general-arrangement sheet.
              The real sheets are customer-uploaded (drawing_sheet.file_uri) and
              are not carried in the repo. */}
          {/* Stem to the right, transom to the left — see the header note. */}
          <path
            d={`M ${W * 0.97} ${H / 2} Q ${W * 0.91} ${H * 0.16} ${W * 0.7} ${H * 0.15}
                L ${W * 0.04} ${H * 0.15} L ${W * 0.02} ${H / 2} L ${W * 0.04} ${H * 0.85}
                L ${W * 0.7} ${H * 0.85} Q ${W * 0.91} ${H * 0.84} ${W * 0.97} ${H / 2} Z`}
            fill="#14161c"
            stroke="#2b2d36"
            strokeWidth={1.5}
          />
          <line x1={W * 0.02} y1={H / 2} x2={W * 0.97} y2={H / 2} stroke="#242732" strokeDasharray="6 6" />
          <text x={W * 0.955} y={H * 0.5 - 8} fill="#4b5060" fontSize={9} textAnchor="end">BOW</text>
          <text x={W * 0.03} y={H * 0.5 - 8} fill="#4b5060" fontSize={9}>STERN</text>
          {/* Port is up, starboard is down — looking forward from astern. */}
          <text x={W * 0.5} y={H * 0.15 - 4} fill="#4b5060" fontSize={9} textAnchor="middle">PORT</text>
          <text x={W * 0.5} y={H * 0.85 + 11} fill="#4b5060" fontSize={9} textAnchor="middle">STBD</text>
          {/* frame ruler */}
          {[40, 80, 120, 160, 200, 240].map((f) => (
            <g key={f}>
              <line x1={frameToX(f) * W} y1={H * 0.1} x2={frameToX(f) * W} y2={H * 0.9} stroke="#1d2029" />
              <text x={frameToX(f) * W} y={H * 0.07} fill="#4b5060" fontSize={9} textAnchor="middle">
                Fr {f}
              </text>
            </g>
          ))}

          {cascadeEdges.map(([from, to]) => {
            const a = layout.positions.get(from);
            const b = layout.positions.get(to);
            if (!a || !b) return null;
            return (
              <line
                key={`${from}-${to}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke={STATE_STYLE.SUSPEND.fg} strokeWidth={1.6} strokeDasharray="7 5"
              />
            );
          })}

          {rows.map((r) => {
            const at = layout.positions.get(r.compartment.compartment_no);
            if (!at) return null;
            const tone = toneOf(r);
            const isSel = r.compartment.compartment_no === selected;
            const { x, y } = at;
            return (
              <g
                key={r.compartment.compartment_no}
                onClick={() => onSelect(r.compartment.compartment_no)}
                style={{ cursor: "pointer" }}
              >
                {/* A leader back to the keel line: once a marker is fanned two
                    lanes out, the frame it actually sits at stops being obvious. */}
                <line
                  x1={x} y1={y < H / 2 ? y + MARKER_H / 2 : y - MARKER_H / 2}
                  x2={x} y2={H / 2}
                  stroke={tone.border} strokeWidth={0.75} strokeDasharray="3 3" opacity={0.55}
                />
                <rect
                  x={x - MARKER_W / 2} y={y - MARKER_H / 2}
                  width={MARKER_W} height={MARKER_H} rx={4}
                  fill={tone.bg} stroke={isSel ? C.accent : tone.border}
                  strokeWidth={isSel ? 2 : 1}
                />
                <text x={x} y={y + 4} fill={tone.fg} fontSize={10} textAnchor="middle" fontFamily="monospace">
                  {r.compartment.compartment_no}
                </text>
                {r.rules_fired.length > 0 && (
                  <circle cx={x + MARKER_W / 2 - 6} cy={y - MARKER_H / 2 + 3} r={5} fill={tone.fg} />
                )}
              </g>
            );
          })}
        </g>
      </svg>
      {rows.length === 0 && (
        <p style={{ color: DIM, fontSize: 12.5, padding: "10px 12px", margin: 0 }}>
          No compartments on this deck match the current filters.
        </p>
      )}
    </div>
  );
}

const zoomBtn: React.CSSProperties = {
  width: 24, height: 22, borderRadius: 5, cursor: "pointer",
  background: "transparent", color: DIM, border: `1px solid ${LINE}`,
  font: "inherit", fontSize: 12, lineHeight: 1, padding: 0,
};

/**
 * The three-deck vertical section — the view the plan cannot give you.
 *
 * A hazard travelling through a deck penetration goes *up and down*, so a
 * planner looking at one deck sheet cannot see why a space two decks away is
 * suspended. Showing the deck above and below together is what makes that
 * legible, and it is why the register keeps an ordered deck ordinal.
 */
function VerticalSection({
  decks, rows, centreOrdinal, selected, onSelect, toneOf, cascadeEdges,
}: {
  decks: Deck[];
  rows: DeckStateRow[];
  centreOrdinal: number;
  selected: string | null;
  onSelect: (n: string) => void;
  toneOf: (r: DeckStateRow) => { fg: string; bg: string; border: string };
  cascadeEdges: [string, string][];
}) {
  // Above is a SMALLER ordinal: the register numbers decks ascending downward.
  const band = decks
    .filter((d) => Math.abs(d.ordinal - centreOrdinal) <= 1)
    .sort((a, b) => a.ordinal - b.ordinal);

  const W = 1000;
  const MARKER_W = 88;
  const MARKER_H = 24;
  const LANE_H = 30;
  /** Room for the deck label above the markers. */
  const LABEL_H = 38;

  // Each band is only as tall as its own deck needs. Side is not shown here —
  // this is a slice through the hull, so port and starboard project onto the
  // same line and the packing has to consider every compartment together.
  const minGap = framesPerSpan(MARKER_W + 6, W);
  let cursor = 0;
  const bands = band.map((deck) => {
    const onThis = rows.filter((r) => r.compartment.deck_code === deck.code);
    const levels = packLanes(
      onThis.map((r) => ({
        id: r.compartment.compartment_no,
        frame: r.compartment.frame,
        side: r.compartment.side,
      })),
      minGap,
    );
    let lanes = 0;
    for (const l of levels.values()) lanes = Math.max(lanes, l + 1);
    const height = Math.max(96, LABEL_H + Math.max(lanes, 1) * LANE_H + 6);
    const top = cursor;
    cursor += height;
    return { deck, onThis, levels, top, height };
  });
  const H = Math.max(cursor, 96);

  // Marker centres across every band, so a cascade hop can be drawn from the
  // deck it left to the deck it reached. This is the whole reason the section
  // exists — on a single deck sheet that hop is invisible.
  const placed = new Map<string, { x: number; y: number }>();
  for (const b of bands) {
    for (const r of b.onThis) {
      const frame = r.compartment.frame;
      if (frame === null) continue;
      const lane = b.levels.get(r.compartment.compartment_no) ?? 0;
      placed.set(r.compartment.compartment_no, {
        x: frameToX(frame) * W,
        y: b.top + LABEL_H + (lane + 0.5) * LANE_H,
      });
    }
  }

  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: 8, background: "#0e0f13", overflow: "hidden" }}>
      <div style={{ padding: "7px 11px", borderBottom: `1px solid ${LINE}`, fontSize: 11, fontWeight: 600 }}>
        Vertical section — deck above, selected, below
        <span style={{ color: DIM, fontWeight: 400, marginLeft: 8 }}>
          a deck penetration carries heat down and vapour up; this is the view that shows it
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }}>
        {bands.map(({ deck, onThis, levels, top, height }) => {
          const isCentre = deck.ordinal === centreOrdinal;
          return (
            <g key={deck.code}>
              <rect
                x={0} y={top} width={W} height={height}
                fill={isCentre ? "#141720" : "#0e0f13"}
                stroke="#1d2029"
              />
              <text x={10} y={top + 16} fill={isCentre ? TEXT : DIM} fontSize={11} fontWeight={600}>
                {deck.label}
              </text>
              <text x={10} y={top + 30} fill="#4b5060" fontSize={9}>
                ordinal {deck.ordinal}
              </text>
              {onThis.map((r) => {
                const frame = r.compartment.frame;
                if (frame === null) return null;
                const tone = toneOf(r);
                const isSel = r.compartment.compartment_no === selected;
                const x = frameToX(frame) * W;
                const lane = levels.get(r.compartment.compartment_no) ?? 0;
                const y = top + LABEL_H + (lane + 0.5) * LANE_H;
                return (
                  <g key={r.compartment.compartment_no} onClick={() => onSelect(r.compartment.compartment_no)} style={{ cursor: "pointer" }}>
                    <rect
                      x={x - MARKER_W / 2} y={y - MARKER_H / 2}
                      width={MARKER_W} height={MARKER_H} rx={4}
                      fill={tone.bg} stroke={isSel ? C.accent : tone.border} strokeWidth={isSel ? 2 : 1}
                    />
                    <text x={x} y={y + 4} fill={tone.fg} fontSize={9.5} textAnchor="middle" fontFamily="monospace">
                      {r.compartment.compartment_no}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}
        {cascadeEdges.map(([from, to]) => {
          const a = placed.get(from);
          const b = placed.get(to);
          if (!a || !b) return null;
          return (
            <line
              key={`${from}-${to}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke={STATE_STYLE.SUSPEND.fg} strokeWidth={1.8} strokeDasharray="7 5"
            />
          );
        })}
      </svg>
      {band.length < 2 && (
        <p style={{ color: DIM, fontSize: 12.5, padding: "10px 12px", margin: 0 }}>
          Only one deck in range — the register needs a deck above or below this one
          for a section to mean anything.
        </p>
      )}
    </div>
  );
}
