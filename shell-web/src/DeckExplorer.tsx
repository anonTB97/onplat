import { useEffect, useMemo, useRef, useState } from "react";
import {
  compartmentState,
  deckStates,
  listDecks,
  readiness,
  type Deck,
  type DeckStateRow,
  type Decision,
  type Identity,
  type Rollup,
} from "./api";
import { ShipBoard, ZoneBoard, ZoneHolders, ZoneMatrix, type Drill } from "./ReadinessBoards";
import { SelectorRail } from "./DeckRail";
import { VerticalTrace } from "./VerticalTrace";
import type { Altitude as ChromeAltitude } from "./Chrome";
import { frameToX, layoutPlan, packLanes, xToFrame } from "./deckGeometry";
import {
  halfBeamAt,
  sheetForDeck,
  sheetFrame,
  sheetX,
  sheetY,
  SHEET_SOURCE,
  type DeckSheet,
} from "./deckSheets";
import { C, fmtClear, mh, overlayBucket, OVERLAY_STYLE, STATE_STYLE } from "./theme";

const DIM = C.dim;
const LINE = C.line;
const TEXT = C.text;

/** By space = colour by authorization. By trade = colour by who works here. */
type Lens = "space" | "trade";
/** What you are looking at: one deck, or three decks stacked. */
type View = "single" | "vertical";
/** How it is drawn: the real general-arrangement plate, or a schematic strip. */
type Mode = "drawing" | "schematic";
/**
 * How high above the hull you are reading from — the prototype's organising idea,
 * and the reason the same facts serve three roles: a foreman works one deck, a
 * zone superintendent works a zone, a project superintendent works the hull.
 *
 * Defined in `Chrome` because the *persona* decides where you land, so the shell
 * owns the value and this module is a controlled component over it.
 */
type Altitude = ChromeAltitude;

/** Viewport height for a plate, in CSS px. */
const SHEET_BOX_H = 520;
/** Zoom ceiling. Past this the JPEG's own scan resolution is the limit. */
const MAX_SHEET_ZOOM = 14;
/**
 * Rendered pixels per source pixel below which the plate stops being readable.
 *
 * Measured against the drawings themselves: their compartment numbers and frame
 * ticks are about ten source pixels tall, so under roughly a third scale they
 * turn to grey texture. That is what made the first cut of this view look like a
 * missing image, so the number is a named constant rather than a magic 0.3.
 */
const READABLE_SCALE = 0.3;

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
  altitude,
  onAltitude,
  focusCompartment,
  onFocused,
}: {
  identity: Identity;
  vesselId: string;
  hullLabel: string;
  /** Controlled by the shell, because the persona decides where you land. */
  altitude: Altitude;
  onAltitude: (a: Altitude) => void;
  /** A compartment the chrome asked us to open — from search or an alert. */
  focusCompartment: string | null;
  onFocused: () => void;
}) {
  const [decks, setDecks] = useState<Deck[]>([]);
  const [rows, setRows] = useState<DeckStateRow[]>([]);
  const [rollup, setRollup] = useState<Rollup | null>(null);
  const [selectedDeck, setSelectedDeck] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [zoneFilter, setZoneFilter] = useState<string | null>(null);
  const [lens, setLens] = useState<Lens>("space");
  // Two independent axes, as in the prototype. What you are looking at (one deck
  // or a vertical trace) is a different question from how it is drawn (the real
  // plate or a schematic), and folding them into one three-way control made
  // "schematic vertical trace" unreachable.
  const [view, setView] = useState<View>("single");
  const [mode, setMode] = useState<Mode>("drawing");
  const [overlay, setOverlay] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const [restrictedOnly, setRestrictedOnly] = useState(false);
  const [tradeFilter, setTradeFilter] = useState<string | null>(null);
  const [zoom, setZoom] = useState(0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [hoverFrame, setHoverFrame] = useState<number | null>(null);
  const dragging = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    setError(null);
    setSelected(null);
    setDecision(null);
    Promise.all([
      listDecks(identity, vesselId),
      deckStates(identity, vesselId),
      readiness(identity, vesselId),
    ])
      .then(([d, r, roll]) => {
        setDecks(d);
        setRows(r);
        setRollup(roll);
        setSelectedDeck(d.find((x) => x.compartment_count > 0)?.code ?? d[0]?.code ?? null);
      })
      .catch((e: unknown) => {
        setDecks([]);
        setRows([]);
        setRollup(null);
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

  // A compartment handed in by the chrome — the global search or an alert. Doing
  // this here rather than in the shell keeps one place that knows a compartment's
  // deck, and clears the request so re-picking the same space works.
  useEffect(() => {
    if (!focusCompartment) return;
    const row = rows.find((r) => r.compartment.compartment_no === focusCompartment);
    if (!row) return;
    setSelectedDeck(row.compartment.deck_code);
    setSelected(focusCompartment);
    setZoneFilter(null);
    onAltitude("compartment");
    onFocused();
  }, [focusCompartment, rows, onAltitude, onFocused]);

  // Esc leaves full screen. Expected of anything that takes over the viewport,
  // and the only way out if the toggle scrolls off.
  useEffect(() => {
    if (!fullScreen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullScreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullScreen]);

  // The hops the hazard actually took, deduped across every rule that fired.
  // Drawn on every view: on a deck it shows the path across that deck, and in
  // the vertical trace it shows the part a single deck sheet can never show —
  // the penetration that carried it to another deck.
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

  // Where a cascade leaves this deck. Computed here because it needs every row
  // on the hull, not just the deck on screen — the point of the badge is to name
  // a deck you are not currently looking at.
  const deckJumps = useMemo(() => {
    const byNo = new Map(rows.map((r) => [r.compartment.compartment_no, r.compartment]));
    const ordinalOf = (code: string) => decks.find((d) => d.code === code)?.ordinal ?? 0;
    const labelOf = (code: string) => decks.find((d) => d.code === code)?.label ?? code;
    const out = new Map<string, { deck: string; label: string; up: boolean }>();
    for (const [a, b] of cascadeEdges) {
      const ca = byNo.get(a);
      const cb = byNo.get(b);
      if (!ca || !cb || ca.deck_code === cb.deck_code) continue;
      // Both ends get a badge: a cascade is followed in either direction.
      if (!out.has(a)) {
        out.set(a, { deck: cb.deck_code, label: labelOf(cb.deck_code), up: ordinalOf(cb.deck_code) < ordinalOf(ca.deck_code) });
      }
      if (!out.has(b)) {
        out.set(b, { deck: ca.deck_code, label: labelOf(ca.deck_code), up: ordinalOf(ca.deck_code) < ordinalOf(cb.deck_code) });
      }
    }
    return out;
  }, [rows, decks, cascadeEdges]);

  /** Every compartment the selected space's cascade touches. */
  const cascadePath = useMemo(
    () => new Set(cascadeEdges.flat()),
    [cascadeEdges],
  );

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
        if (zoneFilter && r.compartment.zone !== zoneFilter) return false;
        return true;
      }),
    [rows, restrictedOnly, tradeFilter, zoneFilter],
  );

  const onDeck = useMemo(
    () => visible.filter((r) => r.compartment.deck_code === selectedDeck),
    [visible, selectedDeck],
  );

  const deckOrdinal = decks.find((d) => d.code === selectedDeck)?.ordinal ?? 0;
  const deckLabel = decks.find((d) => d.code === selectedDeck)?.label ?? "—";
  const selectedRow = rows.find((r) => r.compartment.compartment_no === selected);
  const sheet = sheetForDeck(selectedDeck);

  // Reset the framing on any change that moves the camera. Zero means "not
  // framed" and the sheet view resolves it to a readable default.
  useEffect(() => {
    setZoom(0);
    setPan({ x: 0, y: 0 });
  }, [selectedDeck, view, mode, fullScreen]);

  // The drawing needs a plate; fall back to the schematic rather than showing an
  // empty frame for a deck whose plate has no frame axis.
  const effMode: Mode = sheet ? mode : "schematic";

  /**
   * Marker colour. Three colourings, and they answer different questions:
   * authorization (may work proceed), trade (whose crews are here), and the
   * readiness overlay (is anybody actually held up, and does the hold clear on
   * a clock or on a signature). The overlay wins when it is on, because it is
   * the only one of the three that is explicitly a temporary lens.
   */
  const toneOf = (r: DeckStateRow) => {
    if (overlay) {
      const b = OVERLAY_STYLE[overlayBucket(r)];
      return { fg: b.fg, bg: b.bg, border: b.border };
    }
    if (lens === "trade") {
      const t = r.trades[0];
      return t
        ? {
            fg: tradeColour(t, allTrades),
            bg: `${tradeColour(t, allTrades)}22`,
            border: tradeColour(t, allTrades),
          }
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

  const heldCount = rows.filter((r) => r.readiness === "held").length;
  const parsedGeometry = rows.some((r) => r.compartment.geometry_source === "parsed");

  const seg = (active: boolean, disabled = false) => ({
    padding: "5px 11px",
    borderRadius: 6,
    cursor: disabled ? "not-allowed" : "pointer",
    font: "inherit" as const,
    fontSize: 11.5,
    opacity: disabled ? 0.45 : 1,
    background: active ? "#20222b" : "transparent",
    color: active ? TEXT : DIM,
    border: `1px solid ${active ? C.accent : LINE}`,
  });

  /** A segment with the prototype's second line — the role it is meant for. */
  const altBtn = (id: Altitude, label: string, sub: string) => (
    <button
      key={id}
      // The visible label is two lines, so without this the accessible name
      // becomes "Zone Section · superintendent" — which is what a screen reader
      // would read out and what a keyboard user would have to search for.
      aria-label={`${label} altitude — ${sub}`}
      style={{ ...seg(altitude === id), textAlign: "left", padding: "4px 10px" }}
      onClick={() => onAltitude(id)}
    >
      <div style={{ fontSize: 11.5, fontWeight: altitude === id ? 600 : 400 }}>{label}</div>
      <div style={{ fontSize: 9.5, color: altitude === id ? DIM : "#5a6070" }}>{sub}</div>
    </button>
  );

  const drill = (d: Drill) => {
    if (d.zone) setZoneFilter(d.zone);
    if (d.deck) setSelectedDeck(d.deck);
    if (d.compartment) setSelected(d.compartment);
    onAltitude("compartment");
  };

  return (
    <div>
      {/* Title from the prototype. The question is the point of the screen, so it
          is the subtitle rather than a description of the data model. */}
      <div style={{ fontSize: 10, letterSpacing: 1.1, textTransform: "uppercase", color: C.accent }}>
        Deck Explorer · {hullLabel}
      </div>
      <h1 style={{ fontSize: 22, margin: "4px 0 2px" }}>
        Where can people work — and what&rsquo;s stopping them?
      </h1>
      <p style={{ color: DIM, fontSize: 12.5, margin: "0 0 12px", maxWidth: 820 }}>
        Authorization is computed by the rule engine and read through the API — the shell
        never derives it. {heldCount} of {rows.length} compartments have work booked that
        the engine currently refuses.
      </p>

      <div
        style={{
          display: "flex",
          gap: 14,
          alignItems: "flex-start",
          flexWrap: "wrap",
          marginBottom: 12,
        }}
      >
        <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
          <span style={{ fontSize: 9.5, letterSpacing: 0.6, textTransform: "uppercase", color: DIM, paddingTop: 6 }}>
            Altitude
          </span>
          {altBtn("ship", "Ship", "Leadership board")}
          {altBtn("zone", "Zone", "Section · superintendent")}
          {altBtn("compartment", "Compartment", "Foreman · deck plan")}
        </div>

        <div style={{ display: "flex", gap: 6, alignItems: "center", paddingTop: 3 }}>
          <span style={{ fontSize: 9.5, letterSpacing: 0.6, textTransform: "uppercase", color: DIM }}>Lens</span>
          <button style={seg(lens === "space" && !overlay, overlay)} onClick={() => setLens("space")} title="Show me my zone">
            By space
          </button>
          <button style={seg(lens === "trade" && !overlay, overlay)} onClick={() => setLens("trade")} title="Where can my crews work">
            By trade
          </button>
          {/* The prototype's readiness overlay. A toggle, not a third lens: it
              answers "is anyone held up", which is a different axis from what the
              two lenses colour, and it is meant to be switched on and back off. */}
          <button
            style={{
              ...seg(overlay),
              borderColor: overlay ? OVERLAY_STYLE.wait.fg : LINE,
              color: overlay ? TEXT : DIM,
            }}
            onClick={() => setOverlay(!overlay)}
            title="Overlay GO / WAIT / STOP instead of authorization state"
          >
            Readiness overlay
          </button>
        </div>

        {zoneFilter && (
          <button style={{ ...seg(true), marginTop: 3 }} onClick={() => setZoneFilter(null)} title="Clear the zone filter">
            Zone {zoneFilter} ✕
          </button>
        )}
      </div>

      {/* Wraps. Rail + canvas + trace is about 900px of hard minimum, so on a
          1100px laptop the trace was being pushed past the right edge and the
          whole page scrolled sideways. It drops below the canvas instead. */}
      <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
        {!fullScreen && (
          <SelectorRail
            altitude={altitude}
            decks={decks}
            rows={rows}
            rollup={rollup}
            selectedDeck={selectedDeck}
            zoneFilter={zoneFilter}
            onDeck={(code) => {
              setSelectedDeck(code);
              onAltitude("compartment");
            }}
            onZone={(z) => setZoneFilter(zoneFilter === z ? null : z)}
          />
        )}

        <div style={{ flex: "1 1 640px", minWidth: 380 }}>
          {altitude !== "compartment" ? (
            rollup ? (
              <ReadinessAltitude
                altitude={altitude}
                rollup={rollup}
                onDrill={drill}
                zone={zoneFilter}
                rows={visible}
                decks={decks}
                selected={selected}
                toneOf={toneOf}
                onSelect={setSelected}
                cascade={cascadePath}
              />
            ) : (
              <p style={{ color: DIM, fontSize: 12.5 }}>Reading the hull…</p>
            )
          ) : (
            <>
              {/* controls bar — view axis, draw mode, filters, full screen */}
              <div
                style={{
                  display: "flex",
                  gap: 12,
                  alignItems: "center",
                  flexWrap: "wrap",
                  marginBottom: 10,
                }}
              >
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{deckLabel}</div>
                  <div style={{ fontSize: 10.5, color: DIM }}>
                    {onDeck.length} of {rows.filter((r) => r.compartment.deck_code === selectedDeck).length} shown
                    {onDeck.filter((r) => r.readiness === "held").length > 0 &&
                      ` · ${onDeck.filter((r) => r.readiness === "held").length} held`}
                  </div>
                </div>

                <div style={{ display: "flex", gap: 6 }}>
                  <button style={seg(view === "single")} onClick={() => setView("single")}>
                    Single deck
                  </button>
                  <button
                    style={seg(view === "vertical")}
                    onClick={() => setView("vertical")}
                    title="Three decks at once — how a cascade travels between them"
                  >
                    Vertical trace
                  </button>
                </div>

                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    style={seg(effMode === "drawing", !sheet)}
                    onClick={() => sheet && setMode("drawing")}
                    title={sheet ? "The general-arrangement plate for this deck" : "No plate with a frame axis for this deck"}
                  >
                    Drawing
                  </button>
                  <button style={seg(effMode === "schematic")} onClick={() => setMode("schematic")}>
                    Schematic
                  </button>
                </div>

                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: DIM, cursor: "pointer" }}>
                  <input type="checkbox" checked={restrictedOnly} onChange={(e) => setRestrictedOnly(e.target.checked)} />
                  Restricted only
                </label>

                {lens === "trade" && !overlay && allTrades.length > 0 && (
                  <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
                    <button style={seg(tradeFilter === null)} onClick={() => setTradeFilter(null)}>
                      All trades
                    </button>
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

                <button
                  style={{ ...seg(fullScreen), marginLeft: "auto" }}
                  onClick={() => setFullScreen(!fullScreen)}
                  title="Expand the canvas (Esc to exit)"
                >
                  {fullScreen ? "↙ Exit full screen" : "↗ Full screen"}
                </button>
              </div>

              {view === "vertical" ? (
                <VerticalTrace
                  decks={decks}
                  rows={visible}
                  centreOrdinal={deckOrdinal}
                  selected={selected}
                  onSelect={setSelected}
                  onDeck={setSelectedDeck}
                  toneOf={toneOf}
                  cascadeEdges={cascadeEdges}
                />
              ) : effMode === "drawing" && sheet ? (
                <SheetView
                  sheet={sheet}
                  rows={onDeck}
                  selected={selected}
                  onSelect={setSelected}
                  deckJumps={deckJumps}
                  onDeckJump={setSelectedDeck}
                  toneOf={toneOf}
                  zoom={zoom}
                  setZoom={setZoom}
                  pan={pan}
                  setPan={setPan}
                  dragging={dragging}
                  hoverFrame={hoverFrame}
                  setHoverFrame={setHoverFrame}
                  cascadeEdges={cascadeEdges}
                  overlay={overlay}
                  tall={fullScreen}
                />
              ) : (
                <PlanView
                  rows={onDeck}
                  selected={selected}
                  onSelect={setSelected}
                  toneOf={toneOf}
                  zoom={zoom || 1}
                  setZoom={setZoom}
                  pan={pan}
                  setPan={setPan}
                  dragging={dragging}
                  hoverFrame={hoverFrame}
                  setHoverFrame={setHoverFrame}
                  deckLabel={deckLabel}
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

              {/* legend — whichever colouring is actually in force */}
              <div style={{ display: "flex", gap: 14, marginTop: 10, flexWrap: "wrap", fontSize: 11, color: DIM }}>
                {overlay
                  ? (["go", "wait", "stop", "none"] as const).map((b) => (
                      <span key={b} style={{ display: "flex", alignItems: "center", gap: 5 }} title={OVERLAY_STYLE[b].gloss}>
                        <span style={{ width: 9, height: 9, borderRadius: 2, background: OVERLAY_STYLE[b].fg }} />
                        {OVERLAY_STYLE[b].label} — {OVERLAY_STYLE[b].gloss}
                      </span>
                    ))
                  : lens === "space"
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
            </>
          )}
        </div>

        {/* the decision trace — the contract with the safety authority */}
        {altitude === "compartment" && !fullScreen && (
          <aside
            style={{
              flex: "0 1 360px",
              minWidth: 300,
              border: `1px solid ${LINE}`,
              borderRadius: 8,
              padding: 14,
              background: "#121316",
            }}
          >
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
                  <span
                    style={{ fontSize: 10, fontWeight: 700, color: OVERLAY_STYLE[overlayBucket(selectedRow)].fg }}
                    title={OVERLAY_STYLE[overlayBucket(selectedRow)].gloss}
                  >
                    {OVERLAY_STYLE[overlayBucket(selectedRow)].label}
                  </span>
                </div>
                <div style={{ fontSize: 12.5, color: DIM }}>{selectedRow.compartment.name}</div>
                <div style={{ fontSize: 11, color: DIM, marginTop: 2 }}>
                  {selectedRow.compartment.zone} · {selectedRow.compartment.category}
                  {selectedRow.compartment.frame !== null && ` · Fr ${selectedRow.compartment.frame}`}
                  {` · ${selectedRow.compartment.side}`}
                </div>

                {selectedRow.work_order_codes.length > 0 && (
                  <div style={{ marginTop: 9, paddingTop: 9, borderTop: `1px solid ${LINE}` }}>
                    <div style={{ fontSize: 9.5, letterSpacing: 0.6, textTransform: "uppercase", color: DIM }}>
                      Work in this space
                    </div>
                    <div style={{ fontSize: 12, marginTop: 3 }}>{selectedRow.work_order_codes.join(", ")}</div>
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
                      <div style={{ fontSize: 11, color: DIM, marginTop: 4 }}>{step.authority}</div>
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
        )}
      </div>
    </div>
  );
}


/**
 * Ship and zone altitudes, with the one sentence that keeps them honest.
 *
 * Readiness is a different question from authorization — a suspended space with
 * no work booked in it costs nothing today — and these boards count hours, so
 * the distinction is stated where it is being relied on rather than left for a
 * reader to infer from a colour.
 */
function ReadinessAltitude({
  altitude,
  rollup,
  onDrill,
  zone,
  rows,
  decks,
  selected,
  toneOf,
  onSelect,
  cascade,
}: {
  altitude: "ship" | "zone";
  rollup: Rollup;
  onDrill: (d: Drill) => void;
  /** The section to lay out, when one has been picked in the rail. */
  zone: string | null;
  rows: DeckStateRow[];
  decks: Deck[];
  selected: string | null;
  toneOf: (r: DeckStateRow) => { fg: string; bg: string; border: string };
  onSelect: (compartment: string) => void;
  cascade: Set<string>;
}) {
  const group = zone ? rollup.zones.find((z) => z.key === zone) : undefined;
  return (
    <div>
      <p style={{ color: DIM, fontSize: 11.5, margin: "0 0 12px", maxWidth: 800 }}>
        {altitude === "ship"
          ? "Every space on the hull, joined to the work booked in it."
          : "Zones worst first, by the man-hours each is holding."}{" "}
        <b style={{ color: "#ccd1da" }}>Held</b> means work is booked and the engine
        refuses it — the only category costing the availability today. A closed space
        with nothing booked in it is <b style={{ color: "#ccd1da" }}>latent</b>, not held:
        it costs nothing now, and it is somewhere you must not plan into.
      </p>
      {altitude === "ship" ? (
        <ShipBoard rollup={rollup} onDrill={onDrill} />
      ) : zone && group ? (
        // A zone picked in the rail opens as a section, matching the prototype.
        // The cards are for choosing between zones; once you have chosen, the
        // question changes to "what is where inside it", and that is the grid.
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <ZoneMatrix
            zone={zone}
            rows={rows}
            decks={decks}
            selected={selected}
            toneOf={toneOf}
            onSelect={onSelect}
            cascade={cascade}
          />
          <div style={{ border: `1px solid ${LINE}`, borderRadius: 8, padding: 13, background: "#121316" }}>
            <div style={{ fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: DIM }}>
              Who can release Zone {zone}
            </div>
            <ZoneHolders group={group} onDrill={onDrill} />
          </div>
        </div>
      ) : (
        <ZoneBoard rollup={rollup} onDrill={onDrill} />
      )}
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
  sheet, rows, selected, onSelect, deckJumps, onDeckJump, toneOf, zoom, setZoom, pan, setPan,
  dragging, hoverFrame, setHoverFrame, cascadeEdges, overlay, tall,
}: {
  sheet: DeckSheet;
  rows: DeckStateRow[];
  selected: string | null;
  onSelect: (n: string) => void;
  /** Compartment → the other deck its cascade reaches, for the jump badge. */
  deckJumps: Map<string, { deck: string; label: string; up: boolean }>;
  onDeckJump: (code: string) => void;
  toneOf: (r: DeckStateRow) => { fg: string; bg: string; border: string };
  zoom: number;
  setZoom: (z: number) => void;
  pan: { x: number; y: number };
  setPan: (p: { x: number; y: number }) => void;
  dragging: React.MutableRefObject<{ x: number; y: number } | null>;
  hoverFrame: number | null;
  setHoverFrame: (f: number | null) => void;
  cascadeEdges: [string, string][];
  overlay: boolean;
  tall: boolean;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
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
  const maxH = tall ? 820 : SHEET_BOX_H;
  const naturalH = Math.max(1, boxW * (H / W));
  const fit = boxW / W;

  const placed = new Map<string, { x: number; y: number }>();
  if (cal) {
    for (const r of rows) {
      const frame = r.compartment.frame;
      if (frame === null) continue;
      placed.set(r.compartment.compartment_no, {
        x: sheetX(cal, frame),
        y: sheetY(cal, sheet, r.compartment.side, frame),
      });
    }
  }

  // These plates are about nine times wider than they are tall, so fitting one
  // to the panel's width renders it as a ~140px ribbon of a 7000px drawing —
  // every line present and none of it readable, which looks exactly like a
  // missing image. The default is therefore not fit-to-width. It satisfies two
  // constraints instead: the plate has to be readable, and this deck's markers
  // have to be on screen. Whichever binds harder wins, floored at the scale
  // where the plate's own lettering still reads.
  const markerXs = [...placed.values()].map((p) => p.x);
  const span = markerXs.length > 1 ? Math.max(...markerXs) - Math.min(...markerXs) : 0;
  const heightZoom = maxH / naturalH;
  const spanZoom = span > 0 ? W / (span * 1.18) : heightZoom;
  const readableFloor = READABLE_SCALE / fit;
  const framedZoom = Math.max(
    1,
    Math.min(MAX_SHEET_ZOOM, Math.max(readableFloor, Math.floor(Math.min(heightZoom, spanZoom)))),
  );
  /** Zero means "not framed yet" — resolve it to the readable default. */
  const z = zoom || framedZoom;

  const boxH = Math.round(Math.min(maxH, Math.max(150, naturalH * z)));
  const scale = fit * z;
  const vw = boxW / scale;
  const vh = boxH / scale;
  /** Sheet units per screen pixel — markers multiply by this to stay put. */
  const u = 1 / scale;

  // Opening zoomed in means opening somewhere. Centre on the work: the selected
  // compartment, else the middle of this deck's markers. Landing on an empty
  // stretch of hull and making the planner hunt for their own markers restates
  // the problem the framing exists to solve.
  const focus = (() => {
    if (markerXs.length === 0) return W / 2;
    const middle = (Math.min(...markerXs) + Math.max(...markerXs)) / 2;
    const chosen = selected ? placed.get(selected) : undefined;
    // Centre on the span, not on the selection — but re-centre on the selection
    // if the span-centred window would not contain it. Always centring on the
    // selection pushed the other markers off the plate and lit the "3 markers
    // off-screen" warning on a view that had nothing wrong with it.
    if (chosen && Math.abs(chosen.x - middle) > (boxW / (fit * z)) / 2 - 60) return chosen.x;
    return middle;
  })();

  // Clamp the window to the plate, but centre instead of clamping on any axis
  // where the window is larger than the plate — otherwise the drawing sticks to
  // a corner with the slack all on one side.
  const axis = (want: number, extent: number, window: number) =>
    window >= extent ? extent / 2 : Math.min(Math.max(want, window / 2), extent - window / 2);
  const centre = {
    x: axis(focus + pan.x, W, vw),
    y: axis((cal?.centrelineY ?? H / 2) + pan.y, H, vh),
  };

  if (!cal) return null;

  const showLabels = scale >= READABLE_SCALE;

  // Pins sit at their true frame and side; their LABELS get fanned. Same lane
  // packing as the schematic, but measured in the only unit that decides a label
  // collision here — how many frames an 80px label covers at the current scale,
  // which shrinks as you zoom in and the labels stop colliding on their own.
  const labelLanes = packLanes(
    rows.map((r) => ({
      id: r.compartment.compartment_no,
      frame: r.compartment.frame,
      side: r.compartment.side,
    })),
    88 / Math.max(0.001, scale * cal.pxPerFrame),
  );
  const offScreen = [...placed.values()].filter(
    (m) =>
      m.x < centre.x - vw / 2 ||
      m.x > centre.x + vw / 2 ||
      m.y < centre.y - vh / 2 ||
      m.y > centre.y + vh / 2,
  ).length;
  const ready = loaded === sheet.file;
  const hoverRow = rows.find((r) => r.compartment.compartment_no === hovered);

  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: 8, background: "#0e0f13", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 11px", borderBottom: `1px solid ${LINE}`, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, fontWeight: 600 }}>{sheet.label} — general arrangement</span>
        <span style={{ fontSize: 10.5, color: DIM }}>bow right · drag to pan</span>
        {!showLabels && <span style={{ fontSize: 10.5, color: DIM }}>· zoom in for labels</span>}
        {offScreen > 0 && (
          <span style={{ fontSize: 10.5, color: C.danger }} title="Pan, or use Fit width">
            · {offScreen} marker{offScreen === 1 ? "" : "s"} off-screen
          </span>
        )}
        <span style={{ marginLeft: "auto", display: "flex", gap: 5, alignItems: "center" }}>
          <span style={{ fontSize: 10.5, color: DIM, fontVariantNumeric: "tabular-nums", minWidth: 58 }}>
            {hoverFrame !== null ? `Fr ${hoverFrame}` : "—"}
          </span>
          {/* The prototype's three presets. A percentage rather than "4×",
              because on a scanned plate what matters is how big it is relative to
              the original sheet, not relative to fit-to-width. */}
          <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} style={presetBtn} title="The plate's whole length — the overview, not a readable scale">
            Fit width
          </button>
          <button onClick={() => { setZoom(0); setPan({ x: 0, y: 0 }); }} style={presetBtn} title="Readable, framed on this deck's work">
            Fit deck
          </button>
          <button
            onClick={() => { setZoom(Math.min(MAX_SHEET_ZOOM, Math.max(1, Math.round(1 / fit)))); setPan({ x: 0, y: 0 }); }}
            style={presetBtn}
            title="One screen pixel per pixel of the scanned plate"
          >
            100%
          </button>
          <button onClick={() => setZoom(Math.max(1, z - 1))} style={zoomBtn}>−</button>
          <span style={{ fontSize: 10.5, color: DIM, minWidth: 40, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>
            {Math.round(scale * 100)}%
          </span>
          <button onClick={() => setZoom(Math.min(MAX_SHEET_ZOOM, z + 1))} style={zoomBtn}>+</button>
        </span>
      </div>

      <div ref={boxRef} style={{ height: boxH, background: "#f7f7f4", position: "relative" }}>
        {/* Said out loud. A 900KB plate over a slow link otherwise shows an empty
            light panel, which is indistinguishable from a deck with no drawing. */}
        {!ready && (
          <div
            style={{
              position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
              background: "#0e0f13", color: DIM, fontSize: 12, zIndex: 2,
            }}
          >
            Loading {sheet.label} plate…
          </div>
        )}
        <svg
          viewBox={`${centre.x - vw / 2} ${centre.y - vh / 2} ${vw} ${vh}`}
          style={{ width: "100%", height: boxH, display: "block", cursor: dragging.current ? "grabbing" : "grab", touchAction: "none" }}
          onPointerDown={(e) => {
            dragging.current = { x: e.clientX, y: e.clientY };
            (e.target as Element).setPointerCapture?.(e.pointerId);
          }}
          onPointerUp={() => { dragging.current = null; }}
          onPointerLeave={() => { dragging.current = null; setHoverFrame(null); setHovered(null); }}
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
          <image
            href={`decks/${sheet.file}`}
            x={0} y={0} width={W} height={H}
            onLoad={() => setLoaded(sheet.file)}
          />

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
            const no = r.compartment.compartment_no;
            const tone = toneOf(r);
            const isSel = no === selected;
            const isHot = no === hovered;
            const label = isSel || isHot || showLabels;
            const jump = deckJumps.get(no);
            // A cross drawn over the pin for a space that is shut outright. The
            // prototype uses it for off-limits, and it survives being colour-blind
            // or looking at a printout in the sun, which a red dot does not.
            const shut = r.state === "BLOCK";
            return (
              <g
                key={no}
                onClick={() => onSelect(no)}
                onPointerEnter={() => setHovered(no)}
                style={{ cursor: "pointer" }}
              >
                {/* A tick down to the keel line: on a busy plate the pin alone
                    does not make its frame station obvious. */}
                <line x1={at.x} y1={at.y} x2={at.x} y2={cal.centrelineY} stroke={tone.fg} strokeWidth={1.5 * u} opacity={0.6} />
                <circle
                  cx={at.x} cy={at.y} r={(isSel ? 9 : 6.5) * u}
                  fill={tone.fg} fillOpacity={0.9}
                  stroke={isSel ? "#ffffff" : "#101216"} strokeWidth={2 * u}
                />
                {shut && (
                  <g stroke={OVERLAY_STYLE.stop.fg} strokeWidth={2.6 * u} strokeLinecap="round">
                    <line x1={at.x - 8 * u} y1={at.y - 8 * u} x2={at.x + 8 * u} y2={at.y + 8 * u} />
                    <line x1={at.x + 8 * u} y1={at.y - 8 * u} x2={at.x - 8 * u} y2={at.y + 8 * u} />
                  </g>
                )}
                {label && (() => {
                  // Fanned away from the pin, upward for port and downward for
                  // starboard, so a label never crosses the keel line into the
                  // other half of the ship.
                  const lane = labelLanes.get(no) ?? 0;
                  const dir = r.compartment.side === "starboard" ? 1 : -1;
                  const ly = at.y + dir * (24 + lane * 17) * u;
                  return (
                    <g>
                      {lane > 0 && (
                        <line
                          x1={at.x} y1={at.y + dir * 7 * u} x2={at.x} y2={ly - dir * 7 * u}
                          stroke={tone.fg} strokeWidth={1 * u} opacity={0.55}
                        />
                      )}
                      <rect
                        x={at.x - 44 * u} y={ly - 7.5 * u} width={88 * u} height={15 * u} rx={3 * u}
                        fill="#0b0c0e" fillOpacity={0.92} stroke={tone.fg} strokeWidth={1 * u}
                      />
                      {r.rules_fired.length > 0 && (
                        <text x={at.x - 38 * u} y={ly + 3.5 * u} fill={tone.fg} fontSize={9 * u}>
                          ⚑
                        </text>
                      )}
                      <text
                        x={at.x + (r.rules_fired.length > 0 ? 5 : 0) * u} y={ly + 3.5 * u}
                        fill={tone.fg} fontSize={9.5 * u} textAnchor="middle" fontFamily="monospace"
                      >
                        {no}
                      </text>
                    </g>
                  );
                })()}
                {/* Follow the cascade to the deck it reached. Without this the
                    only way to trace a penetration is to remember which deck to
                    click next, and the whole point is that it is not obvious. */}
                {jump && (isSel || isHot) && (
                  <g
                    onClick={(e) => { e.stopPropagation(); onDeckJump(jump.deck); }}
                    style={{ cursor: "pointer" }}
                  >
                    <title>{`Follow the cascade to ${jump.label}`}</title>
                    <circle
                      cx={at.x + 26 * u} cy={at.y - 2 * u} r={8 * u}
                      fill="#0b0c0e" stroke={STATE_STYLE.SUSPEND.fg} strokeWidth={1.6 * u}
                    />
                    <text
                      x={at.x + 26 * u} y={at.y + 2 * u} fill={STATE_STYLE.SUSPEND.fg}
                      fontSize={10 * u} textAnchor="middle"
                    >
                      {jump.up ? "▲" : "▼"}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>

        {/* Hover card. Kept in HTML rather than SVG so its text does not scale
            with the zoom and so it can never be clipped by the viewBox. */}
        {hoverRow && (
          <div
            style={{
              position: "absolute", left: 10, bottom: 10, zIndex: 3, pointerEvents: "none",
              background: "#0b0c0eF2", border: `1px solid ${toneOf(hoverRow).border}`,
              borderRadius: 6, padding: "7px 10px", maxWidth: 340,
            }}
          >
            <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              <span style={{ fontFamily: "monospace", fontSize: 12 }}>{hoverRow.compartment.compartment_no}</span>
              <span style={{ fontSize: 10.5, fontWeight: 700, color: STATE_STYLE[hoverRow.state].fg }}>
                {hoverRow.state}
              </span>
              <span style={{ fontSize: 10.5, fontWeight: 700, color: OVERLAY_STYLE[overlayBucket(hoverRow)].fg }}>
                {OVERLAY_STYLE[overlayBucket(hoverRow)].label}
              </span>
            </div>
            <div style={{ fontSize: 11.5, color: "#ccd1da" }}>{hoverRow.compartment.name}</div>
            <div style={{ fontSize: 10.5, color: DIM }}>
              {hoverRow.compartment.zone} · Fr {hoverRow.compartment.frame} · {hoverRow.compartment.side}
              {hoverRow.remaining_hours > 0 && ` · ${mh(hoverRow.remaining_hours)} left`}
            </div>
            {hoverRow.readiness === "held" && (
              <div style={{ fontSize: 10.5, color: DIM, marginTop: 2 }}>
                cleared by <b style={{ color: "#ccd1da" }}>{hoverRow.clearing_authority || "unnamed authority"}</b> ·{" "}
                {fmtClear(hoverRow.earliest_clear)}
              </div>
            )}
          </div>
        )}
      </div>

      <p style={{ fontSize: 10.5, color: DIM, padding: "7px 11px", margin: 0, borderTop: `1px solid ${LINE}` }}>
        {SHEET_SOURCE}. Frames are read off this plate's own ruler — the plates are
        not drawn to a common scale. Which side of the keel line a pin sits on comes
        from the register; how far off it sits is {Math.round(0.45 * halfBeamAt(cal, 150))}px
        of local half-beam, not a surveyed position.{" "}
        <b>The plate is real; the compartment register pinned to it is notional demo
        data</b>, so a pin marks its frame station, not a space you will find under
        that number on this drawing.
        {overlay && " Readiness overlay is on — colour is GO / WAIT / STOP, not authorization state."}
      </p>
    </div>
  );
}

const presetBtn: React.CSSProperties = {
  height: 22, borderRadius: 5, cursor: "pointer", padding: "0 7px",
  background: "transparent", color: C.dim, border: `1px solid ${C.line}`,
  font: "inherit", fontSize: 10.5, lineHeight: 1,
};

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
