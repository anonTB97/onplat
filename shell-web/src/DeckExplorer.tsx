import { useEffect, useMemo, useRef, useState } from "react";
import { clampZoom, planZoomAt, sheetZoomAt, wheelFactor } from "./camera";
import {
  clearHazard,
  compartmentState,
  deckStates,
  getZoneChart,
  importZoneChart,
  listActivities,
  listDecks,
  getGeometry,
  getManningBook,
  listHazards,
  readiness,
  revertZoneChart,
  type Activity,
  type AsOf,
  type Deck,
  type DeckStateRow,
  type Decision,
  type Identity,
  type GeometryInfo,
  type LiveHazard,
  type ManningBook,
  type Rollup,
  type ZoneBound,
  type ZoneChart,
  workConflicts,
  type WorkConflicts,
} from "./api";
import { ShipBoard, ZoneBoard, ZoneHolders, ZoneMatrix, type Drill } from "./ReadinessBoards";
import { SelectorRail } from "./DeckRail";
import { ShipView } from "./ShipView";
import { VerticalTrace } from "./VerticalTrace";
import Mitigations from "./Mitigations";
import { MARKING_H } from "./Chrome";
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
import { C, fmtClear, mh, overlayBucket, OVERLAY_STYLE, STATE_STYLE, zoneColour } from "./theme";
import { parseZoneCsv } from "./ingest";
import { HORIZONS, type Horizon } from "./TimeControl";
import { windowLoadBySpace, windowLoadTotal, type SpaceLoad } from "./windowLoad";
import { DiscardButton } from "./DiscardButton";
import { zoneBands, type ZoneGeometry } from "./zones";
import { fmtDate, fmtDay, fmtMonth } from "./clock";
import { blockLabel, blockStart, utcDayStart } from "./watch";
import { demandByTrade, demandByZone, zoneInteractions } from "./manning";

const DIM = C.dim;

/**
 * The occupancy planning tolerance: workers per space per day above which the
 * plan itself is flagged. A PLANNING HEURISTIC seeded at 6 — the yard's own
 * per-compartment occupancy limits (which depend on the space, the trade mix
 * and the confined-space determination) belong in configuration when this
 * leaves the demo; this constant exists so the flag has one definition.
 */
const CREW_TOLERANCE = 6;
const LINE = C.line;
const TEXT = C.text;

/** By space = colour by authorization. By trade = colour by who works here. */
type Lens = "space" | "trade";
/** What you are looking at: one deck, three decks stacked, or the whole hull. */
type View = "single" | "vertical" | "ship";
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
const TRADE_COLOURS = ["#3D6BFF", C.ok, C.warn, "#c4b5fd", "#f472b6", "#2dd4bf"];
function tradeColour(trade: string, all: string[]): string {
  const i = all.indexOf(trade);
  return i < 0 ? C.subtle : TRADE_COLOURS[i % TRADE_COLOURS.length];
}

/**
 * Which deck to open on: the one carrying the most registered compartments.
 *
 * Was "the first deck with any compartments", which on this class register is the
 * main deck — two spaces out of twenty-four. The Explorer opened on the emptiest
 * populated deck in the hull, which reads as missing data rather than as a deck
 * with two spaces on it, and left the vertical trace stacking the two thinnest
 * lanes available. Opening where the register is densest puts the reader where
 * there is something to read; every other deck is one click away in the rail.
 */
function landingDeck(decks: Deck[]): string | null {
  const best = decks.reduce<Deck | null>(
    (a, b) => (a === null || b.compartment_count > a.compartment_count ? b : a),
    null,
  );
  return (best?.compartment_count ?? 0) > 0 ? (best?.code ?? null) : (decks[0]?.code ?? null);
}

export default function DeckExplorer({
  identity,
  vesselId,
  hullLabel,
  altitude,
  onAltitude,
  focusCompartment,
  onFocused,
  onSpaceChange,
  asOf,
  horizon,
  now,
  onMutated,
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
  /** Reports the selected space upward, for the shell's shareable URL. */
  onSpaceChange?: (no: string | null) => void;
  /**
   * The instant to read the hull at; `null` is live.
   *
   * Every fetch in this screen carries it, so the deck plan, the vertical trace
   * and the readiness boards are all answering about the same moment. Passed
   * down rather than read from a context so it is impossible to add a fetch here
   * that forgets it.
   */
  asOf: AsOf;
  /** The reading window the time control claims: this screen answers for
   *  [instant, instant + horizon) — a shift, a week, a month — not just the
   *  instant itself. */
  horizon: Horizon;
  /** The server's now, for the live (asOf = null) case. */
  now: number | null;
  /** Something on this screen changed the hull's served facts (an
   *  administrative clearance) — the shell should refetch what it shares. */
  onMutated?: () => void;
}) {
  const [decks, setDecks] = useState<Deck[]>([]);
  const [rows, setRows] = useState<DeckStateRow[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [rollup, setRollup] = useState<Rollup | null>(null);
  const [selectedDeck, setSelectedDeck] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  // The raw live facts, joined to the trace so a refusing step can carry the
  // clear action for the hazard behind it. Bumping `epoch` refetches every
  // read on this screen — how a clearance's cascade becomes visible without
  // waiting for the next scrub.
  const [hazards, setHazards] = useState<LiveHazard[]>([]);
  const [epoch, setEpoch] = useState(0);
  // The manning strip: crew demand for the current step against the imported
  // supply. A panel toggle rather than a colour lens — it ADDS numbers to
  // whatever the map is already showing.
  const [showManning, setShowManning] = useState(false);
  const [manningBook, setManningBook] = useState<ManningBook | null>(null);
  // The geometry register (docs/geometry-accuracy.md): its deck coverage
  // bands shade "no deck here" on the plate, and its presence is named in
  // marker titles. The surveyed extents themselves arrive on the rows —
  // the API overlays them, so no view re-derives the grade.
  const [geometry, setGeometry] = useState<GeometryInfo | null>(null);
  // Two error slots, because the two fetches fail for different reasons and need
  // different words. The register is scope-gated: failing it means this hull is
  // not yours. The states are instant-gated too: failing those can just mean the
  // instant is outside the availability, which is not a scope problem and must not
  // be reported as one.
  const [error, setError] = useState<string | null>(null);
  const [instantError, setInstantError] = useState<string | null>(null);

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
  // The zones-and-compartments shading: translucent zone bands and compartment
  // boxes over the plate, so a reader can SEE that the register's geometry was
  // applied properly instead of trusting that it was.
  const [zonesOn, setZonesOn] = useState(false);
  // The ingested zone chart (authored bounds + the server's audit), or null
  // while bands are inferred. Fetched with the rows and refetched after an
  // import or revert.
  const [zoneChart, setZoneChart] = useState<ZoneChart | null>(null);
  const [zoneMsg, setZoneMsg] = useState<string | null>(null);
  const [zonePending, setZonePending] = useState<{
    label: string;
    bounds: ZoneBound[];
    summary: string;
  } | null>(null);
  const [zoneNonce, setZoneNonce] = useState(0);
  const [tradeFilter, setTradeFilter] = useState<string | null>(null);
  const [zoom, setZoom] = useState(0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [hoverFrame, setHoverFrame] = useState<number | null>(null);
  const dragging = useRef<{ x: number; y: number } | null>(null);
  // The window height, tracked so the full-screen plate budgets against the real
  // viewport rather than a guess made at authoring time.
  const [winH, setWinH] = useState(() => window.innerHeight);
  useEffect(() => {
    const onResize = () => setWinH(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // The hull's zone bands and audit — computed ONCE from all rows and shared
  // by the single-deck plate and the whole-ship view, so the two can never
  // disagree about where a zone ends. Hull-wide deliberately: a zone's band on
  // one deck derived only from that deck's spaces would put the same boundary
  // in two different places on two screens, which reads as inaccuracy even
  // when both are internally consistent.
  const zoneGeometry: ZoneGeometry = useMemo(
    () =>
      zoneBands(
        rows.map((r) => ({
          no: r.compartment.compartment_no,
          zone: r.compartment.zone,
          frame: r.compartment.frame,
        })),
        0,
        Math.max(
          280,
          ...rows.map((r) => (r.compartment.frame ?? 0) + 8),
        ),
        zoneChart?.source
          ? { label: zoneChart.source, bounds: zoneChart.bounds }
          : null,
      ),
    [rows, zoneChart],
  );

  // The chart itself. Failure degrades to inferred bands rather than an
  // error: the shading is still true, it just says so with less authority.
  useEffect(() => {
    getZoneChart(identity, vesselId)
      .then(setZoneChart)
      .catch(() => setZoneChart(null));
  }, [identity, vesselId, zoneNonce]);

  /** Spaces the server's audit puts outside their zone's authored bounds. */
  const zoneAlerts = useMemo(
    () => new Set((zoneChart?.audit.out_of_bounds ?? []).map((o) => o.compartment)),
    [zoneChart],
  );

  // Bumped when the chrome routes someone to a space — an alert, a worst-space
  // row, a leverage link — so the options panel can bring the fix into view.
  // Plain marker clicks do not bump it; a reader browsing the plan has not asked
  // to be scrolled anywhere.
  const [revealNonce, setRevealNonce] = useState(0);

  // The hull's register, and the selection reset that belongs to changing hulls.
  // Deliberately NOT keyed on `asOf`: the deck list is time-invariant, and folding
  // it in here is what made every scrub clear the selected compartment — closing
  // the trace panel mid-read, making a scrubbed trace unreachable, and resetting
  // the view every 800 ms under playback.
  useEffect(() => {
    setError(null);
    setSelected(null);
    setDecision(null);
    listDecks(identity, vesselId)
      .then((d) => {
        setDecks(d);
        setSelectedDeck(landingDeck(d));
      })
      .catch((e: unknown) => {
        setDecks([]);
        setError(String(e));
      });
  }, [identity, vesselId]);

  // The states, at the instant. Refetched on every scrub — the alternative,
  // filtering a cached set in the browser, would produce a plausible board with a
  // fabricated trace behind it, which is the one thing this screen must never do.
  // The selection survives, because scrubbing is how you watch one space change.
  useEffect(() => {
    // One stale flag over every fetch in this effect: a slow response from the
    // previous hull must not paint its rows, register, hazards, manning, or
    // deck bands onto the next hull's plates (repo convention: fetches carry
    // stale guards).
    let stale = false;
    Promise.all([deckStates(identity, vesselId, asOf), readiness(identity, vesselId, asOf)])
      .then(([r, roll]) => {
        if (stale) return;
        setRows(r);
        setRollup(roll);
        setInstantError(null);
      })
      .catch((e: unknown) => {
        if (stale) return;
        setRows([]);
        setRollup(null);
        setInstantError(String(e));
      });
    // The register, for the whole-ship view: activities are the markers there,
    // and they carry the instant like every other read on this screen.
    listActivities(identity, vesselId, asOf)
      .then((r) => {
        if (!stale) setActivities(r.activities);
      })
      .catch(() => {
        if (!stale) setActivities([]);
      });
    // The live facts are not instant-scoped: a hazard is on the hull or it is
    // not. (History lives in the ledger, not this list.)
    listHazards(identity, vesselId)
      .then((h) => {
        if (!stale) setHazards(h);
      })
      .catch(() => {
        if (!stale) setHazards([]);
      });
    getManningBook(identity, vesselId)
      .then((m) => {
        if (!stale) setManningBook(m);
      })
      .catch(() => {
        if (!stale) setManningBook(null);
      });
    getGeometry(identity, vesselId)
      .then((g) => {
        if (!stale) setGeometry(g);
      })
      .catch(() => {
        if (!stale) setGeometry(null);
      });
    return () => {
      stale = true;
    };
  }, [identity, vesselId, asOf, epoch]);

  // The reading window: from the instant, one horizon forward. This is what
  // makes Shift / Week / Month change what this screen SAYS, not merely how
  // far the scrubber reaches — the schedule's reality for the chosen window,
  // pro-rated per space by the same rule as the Load digest.
  // Scheduled-work conflicts for the day under the cursor — served business
  // rules (hot-class vs flammable-class through the coupling graph), so the
  // deck plan can draw the pairs and a worker at a kiosk sees them without
  // opening anything.
  const [conflicts, setConflicts] = useState<WorkConflicts | null>(null);
  useEffect(() => {
    let stale = false;
    workConflicts(identity, vesselId, asOf)
      .then((c) => {
        if (!stale) setConflicts(c);
      })
      .catch(() => {
        if (!stale) setConflicts(null);
      });
    return () => {
      stale = true;
    };
  }, [identity, vesselId, asOf, epoch]);

  // At the Day horizon the reading window is the CALENDAR day under the
  // clicker, not [instant, +24h): picking the 08–12Z block must not slide the
  // "this day" numbers into tomorrow morning. Same day-identity the ops board
  // and the work-conflicts endpoint already use.
  const winStart =
    horizon === "day" ? utcDayStart(asOf ?? now ?? 0) : (asOf ?? now ?? 0);
  const horizonSpan = HORIZONS[horizon].span;
  const winEnd =
    horizonSpan !== null
      ? winStart + horizonSpan
      : Math.max(winStart + 1, ...activities.map((a) => a.planned?.end ?? 0));
  const spaceLoad = useMemo(
    () => (winStart > 0 ? windowLoadBySpace(activities, winStart, winEnd) : new Map()),
    [activities, winStart, winEnd],
  );
  const loadTotal = useMemo(
    () =>
      winStart > 0
        ? windowLoadTotal(activities, winStart, winEnd)
        : { hours: 0, count: 0, refused: 0, unlocated: 0 },
    [activities, winStart, winEnd],
  );

  // Selecting a compartment fetches its full trace from the engine-backed
  // endpoint. The client never derives a state itself.
  //
  // Carries `asOf` too, and it has to: the trace panel is the explanation of the
  // marker beside it. A panel reading the live cascade next to a board showing
  // Thursday would be two answers to one question, with nothing on screen to say
  // which instant either belonged to.
  useEffect(() => {
    if (!selected) return;
    compartmentState(identity, vesselId, selected, asOf)
      .then((r) => setDecision(r.decision))
      .catch(() => setDecision(null));
  }, [identity, vesselId, selected, asOf, epoch]);

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
    setRevealNonce((n) => n + 1);
    onFocused();
  }, [focusCompartment, rows, onAltitude, onFocused]);

  // The selection, reported up so the URL can carry it.
  useEffect(() => {
    onSpaceChange?.(selected);
    // The callback identity is the shell's concern, not a reason to re-report.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // A clearance changed the hull's facts: refetch everything on this screen,
  // and tell the shell so its shared reads (top-bar rows, the alert bell)
  // move in the same breath. VR-06: the flip must be one refresh, not a scrub.
  const handleCleared = () => {
    setEpoch((n) => n + 1);
    onMutated?.();
  };

  // Esc backs out one layer at a time: the drawer first, then full screen.
  // Expected of anything that takes over the viewport, and the only way out if
  // the toggle scrolls off.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (selected) setSelected(null);
      else if (fullScreen) setFullScreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullScreen, selected]);

  // Click-to-toggle: selecting the selected space again deselects it. Every
  // canvas routes through this, so "how do I put it down" has one answer
  // (this, or Esc) instead of none.
  const toggleSelect = (no: string) => setSelected((prev) => (prev === no ? null : no));

  /**
   * Selects a space and moves the plan to its deck.
   *
   * The two always travel together. Selecting alone left a redeployment target on
   * another deck highlighted in the panel while the drawing stayed where it was,
   * which reads as the app ignoring the click.
   */
  const openSpace = (compartment: string) => {
    const row = rows.find((r) => r.compartment.compartment_no === compartment);
    if (row) setSelectedDeck(row.compartment.deck_code);
    setSelected(compartment);
  };

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

  // The plate's height budget: a panel in the page normally; in full screen the
  // real window, minus the markings and the canvas chrome around the plate.
  const sheetMaxH = fullScreen ? Math.max(320, winH - 2 * MARKING_H - 200) : SHEET_BOX_H;

  const deckOrdinal = decks.find((d) => d.code === selectedDeck)?.ordinal ?? 0;
  const deckLabel = decks.find((d) => d.code === selectedDeck)?.label ?? "—";
  const selectedRow = rows.find((r) => r.compartment.compartment_no === selected);
  const sheet = sheetForDeck(selectedDeck);

  // Reset the framing on any change that moves the camera. Zero means "not
  // framed" and the sheet view resolves it to a readable default. Full screen is
  // deliberately NOT in this list: it used to be, and entering it threw away the
  // exact framing the reader had just asked to see bigger. The camera clamp
  // re-fits the kept framing to the new viewport instead.
  useEffect(() => {
    setZoom(0);
    setPan({ x: 0, y: 0 });
  }, [selectedDeck, view, mode]);

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
        : { fg: C.subtle, bg: "#1a1c22", border: "#353842" };
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

  if (instantError) {
    return (
      <p style={{ color: STATE_STYLE.WARN.fg }}>
        No answer for this instant ({instantError}). The hull is readable — pick a date
        inside its availability, or press <b>⟲ Now</b>.
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
    background: active ? C.raised : "transparent",
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
      <p style={{ color: DIM, fontSize: 12.5, margin: "0 0 12px", maxWidth: 780 }}>
        Authorization is computed by the rule engine and read through the API — the shell
        never derives it. {heldCount} of {rows.length} compartments have work booked that
        {/* "currently" was true until the time control existed. On a scrubbed
            board it is a lie about the most load-bearing sentence on the screen,
            so the tense follows the instant. */}
        {asOf === null ? " the engine currently refuses." : " the engine refuses at this instant."}
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
          {/* The reading window's reality: what the schedule actually puts on
              this hull between the instant and one horizon out. This is what
              the Shift / Week / Month chips CLAIM, answered — scrub the clock
              or change the horizon and these numbers move with the plan. */}
          {winStart > 0 && (
            <span
              title={`The schedule inside the reading window: ${fmtDate(winStart)} + one ${HORIZONS[horizon].label.toLowerCase()}. Budget is pro-rated by each activity's overlap with the window — the Load digest's rule. Unlocated rows cannot land on a space and are counted, never hidden.`}
              style={{
                marginLeft: "auto", alignSelf: "center", fontSize: 11, color: DIM,
                display: "flex", gap: 10, alignItems: "baseline", whiteSpace: "nowrap",
              }}
            >
              <span style={{ fontSize: 9, letterSpacing: 0.7, textTransform: "uppercase", color: C.subtle }}>
                this {HORIZONS[horizon].label.toLowerCase()}
              </span>
              <b style={{ color: C.bright }}>{loadTotal.count} activities</b>
              <b style={{ color: C.bright }}>{mh(Math.round(loadTotal.hours))}</b>
              {loadTotal.refused > 0 && (
                <b style={{ color: C.danger }}>{loadTotal.refused} refused</b>
              )}
              {loadTotal.unlocated > 0 && (
                <span style={{ color: C.warn }}>{loadTotal.unlocated} unlocated</span>
              )}
              {conflicts !== null && conflicts.pairs.length > 0 && (
                <b
                  style={{ color: C.warn, cursor: "help" }}
                  title={`${conflicts.basis}\n\n${conflicts.pairs.slice(0, 6).map((pr) => pr.reason).join("\n")}${conflicts.pairs.length > 6 ? `\n…and ${conflicts.pairs.length - 6} more` : ""}`}
                >
                  ⚡ {conflicts.pairs.length} hot-vs-flammable today
                </b>
              )}
            </span>
          )}
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
          <button
            style={{
              ...seg(showManning),
              borderColor: showManning ? C.accent : LINE,
              color: showManning ? TEXT : DIM,
            }}
            onClick={() => setShowManning(!showManning)}
            title="Crews for the current step — demand from the schedule, supply from the manning book, zones interacting"
          >
            Manning
          </button>
        </div>

        {zoneFilter && (
          <button style={{ ...seg(true), marginTop: 3 }} onClick={() => setZoneFilter(null)} title="Clear the zone filter">
            Zone {zoneFilter} ✕
          </button>
        )}
      </div>

      {showManning && (
        <ManningPanel
          activities={activities}
          rows={rows}
          conflicts={conflicts}
          book={manningBook}
          horizon={horizon}
          at={asOf ?? now ?? 0}
        />
      )}

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
            load={spaceLoad}
            horizonLabel={HORIZONS[horizon].label.toLowerCase()}
            onDeck={(code) => {
              setSelectedDeck(code);
              onAltitude("compartment");
            }}
            onZone={(z) => setZoneFilter(zoneFilter === z ? null : z)}
          />
        )}

        <div
          style={
            fullScreen
              ? {
                  // A real takeover, not a taller box. The handling markings stay
                  // — they are fixed at z 50 and this sits under them — and
                  // everything else yields.
                  position: "fixed",
                  top: MARKING_H,
                  left: 0,
                  right: 0,
                  bottom: MARKING_H,
                  zIndex: 45,
                  background: C.bg,
                  padding: "12px 16px",
                  overflow: "auto",
                }
              : { flex: "1 1 640px", minWidth: 380 }
          }
        >
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
                onSelect={toggleSelect}
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
                  <button
                    style={seg(view === "ship")}
                    onClick={() => setView("ship")}
                    title="Every activity on every deck, one shared frame axis"
                  >
                    Whole ship
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

                {((view === "single" && effMode === "drawing") || view === "ship") && (
                  <label
                    style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: zonesOn ? TEXT : DIM, cursor: "pointer" }}
                    title="Shade each zone's frame band and each compartment's footprint, so the applied geometry can be checked by eye."
                  >
                    <input type="checkbox" checked={zonesOn} onChange={(e) => setZonesOn(e.target.checked)} />
                    Zones &amp; compartments
                  </label>
                )}

                {/* The zone chart's import door — bands become authored, and
                    the register can start disagreeing with the chart, which is
                    the point. */}
                {zonesOn && ((view === "single" && effMode === "drawing") || view === "ship") && (
                  <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <label
                      style={{ ...seg(false), display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer" }}
                      title="Ingest the yard's zone chart (CSV: zone,lo_frame,hi_frame). All-or-nothing; previews its audit before storing."
                    >
                      ⭱ Zone chart
                      <input
                        type="file"
                        accept=".csv,text/csv,text/plain"
                        style={{ display: "none" }}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = "";
                          if (!file) return;
                          setZoneMsg(`⏳ reading ${file.name}…`);
                          void file.text().then((text) => {
                            const bounds = parseZoneCsv(text);
                            importZoneChart(identity, vesselId, file.name, bounds, true)
                              .then((r) => {
                                const oob = r.audit.out_of_bounds;
                                setZonePending({
                                  label: file.name,
                                  bounds,
                                  summary:
                                    `${r.zones} zones` +
                                    (oob.length > 0
                                      ? ` · would put ${oob.length} space${oob.length === 1 ? "" : "s"} out of bounds: ${oob.map((o) => o.compartment).join(", ")}`
                                      : " · register agrees with the chart") +
                                    (r.audit.unbounded_zones.length > 0
                                      ? ` · unbounded: ${r.audit.unbounded_zones.join(", ")}`
                                      : ""),
                                });
                                setZoneMsg(null);
                              })
                              .catch((err: unknown) => setZoneMsg(String(err)));
                          });
                        }}
                      />
                    </label>
                    {zoneChart?.source && (
                      <DiscardButton
                        what="the zone chart"
                        title="Throw the ingested chart away — zone bands return to this tool's own inference, and say so."
                        onDiscard={() => {
                          setZoneMsg("⏳ discarding the zone chart…");
                          void revertZoneChart(identity, vesselId)
                            .then(() => {
                              setZoneMsg("✓ back to inferred bands");
                              setZoneNonce((n) => n + 1);
                            })
                            .catch((err: unknown) => setZoneMsg(String(err)));
                        }}
                      />
                    )}
                    {zoneMsg && (
                      <span style={{ fontSize: 11, color: zoneMsg.startsWith("✓") ? C.ok : C.danger }}>
                        {zoneMsg}
                      </span>
                    )}
                  </span>
                )}

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

              {/* The chart's dry run: everything the ingest would claim —
                  including the spaces it would put out of bounds — before
                  anything is stored. */}
              {zonePending && (
                <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10, padding: "8px 12px", border: `1px solid #f59e0b66`, borderRadius: 8, background: "rgba(245,158,11,0.06)", fontSize: 12 }}>
                  <b>{zonePending.label}</b>
                  <span style={{ color: DIM }}>{zonePending.summary}</span>
                  <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                    <button
                      style={seg(true)}
                      onClick={() => {
                        const staged = zonePending;
                        setZonePending(null);
                        if (!staged) return;
                        void importZoneChart(identity, vesselId, staged.label, staged.bounds, false)
                          .then((r) => {
                            setZoneMsg(`✓ ${r.label}: ${r.zones} zones authored`);
                            setZoneNonce((n) => n + 1);
                          })
                          .catch((err: unknown) => setZoneMsg(String(err)));
                      }}
                    >
                      Confirm chart
                    </button>
                    <button style={seg(false)} onClick={() => setZonePending(null)}>Cancel</button>
                  </span>
                </div>
              )}

              {view === "ship" ? (
                <ShipView
                  decks={decks}
                  rows={rows}
                  activities={activities}
                  selected={selected}
                  cascadeEdges={cascadeEdges}
                  zonesOn={zonesOn}
                  zones={zoneGeometry}
                  zoneAlerts={zoneAlerts}
                  onPick={(deckCode, compartment) => {
                    if (compartment === selected) {
                      setSelected(null);
                      return;
                    }
                    setSelectedDeck(deckCode);
                    setSelected(compartment);
                    setRevealNonce((n) => n + 1);
                  }}
                />
              ) : view === "vertical" ? (
                <VerticalTrace
                  decks={decks}
                  rows={visible}
                  centreOrdinal={deckOrdinal}
                  selected={selected}
                  onSelect={toggleSelect}
                  onDeck={setSelectedDeck}
                  toneOf={toneOf}
                  cascadeEdges={cascadeEdges}
                />
              ) : effMode === "drawing" && sheet ? (
                <SheetView
                  deckBands={
                    geometry?.register
                      ? {
                          label: geometry.register.label,
                          bands: geometry.register.decks.filter(
                            (d) => d.deck_code === selectedDeck,
                          ),
                        }
                      : null
                  }
                  sheet={sheet}
                  rows={onDeck}
                  selected={selected}
                  onSelect={toggleSelect}
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
                  maxH={sheetMaxH}
                  zonesOn={zonesOn}
                  zones={zoneGeometry}
                  zoneAlerts={zoneAlerts}
                  // Unfiltered deliberately: the shading exists to verify the
                  // register's geometry, and a filter hiding half the zone
                  // would make the check pass vacuously.
                  zoneRows={rows.filter((r) => r.compartment.deck_code === selectedDeck)}
                  load={spaceLoad}
                  windowDays={(winEnd - winStart) / 86_400_000}
                  horizonLabel={HORIZONS[horizon].label.toLowerCase()}
                  conflicts={conflicts}
                />
              ) : (
                <PlanView
                  rows={onDeck}
                  selected={selected}
                  onSelect={toggleSelect}
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
                  load={spaceLoad}
                  windowDays={(winEnd - winStart) / 86_400_000}
                  horizonLabel={HORIZONS[horizon].label.toLowerCase()}
                  conflicts={conflicts}
                />
              )}

              {geometry?.register ? (
                <p style={{ fontSize: 10.5, color: DIM, marginTop: 8 }}>
                  Geometry register <b style={{ color: C.bright }}>{geometry.register.label}</b>{" "}
                  is in force: surveyed spaces draw their frame extent as a band on the
                  plate&apos;s ruler, and shaded regions are where this deck does not
                  exist. Spaces the register does not survey remain placard parses — the
                  hover card says which is which.
                  {(geometry.findings?.placard_disagreements.length ?? 0) > 0 && (
                    <b style={{ color: C.warn }}>
                      {" "}⚠ {geometry.findings?.placard_disagreements.length} surveyed
                      space(s) disagree with their placard — see Data Sources.
                    </b>
                  )}
                </p>
              ) : parsedGeometry ? (
                <p style={{ fontSize: 10.5, color: DIM, marginTop: 8 }}>
                  Positions derived from the placard numbers — this class uses the USN
                  deck-frame-side scheme. A hull whose register carries authored frame
                  and side data uses that instead, and says <b>register</b>. A surveyed
                  geometry register (Data Sources) upgrades pins to true frame extents.
                </p>
              ) : null}

              {/* legend — whichever colouring is actually in force */}
              <div style={{ display: "flex", gap: 14, marginTop: 10, flexWrap: "wrap", fontSize: 11, color: DIM }}>
                {zonesOn && view === "single" && effMode === "drawing" && (
                  <>
                    {[...new Set(rows.filter((r) => r.compartment.deck_code === selectedDeck).map((r) => r.compartment.zone))]
                      .sort()
                      .map((z) => (
                        <span key={z} style={{ display: "flex", alignItems: "center", gap: 5 }} title={`Zone ${z} — band spans its spaces' true hull extent, shared with the whole-ship view`}>
                          <span style={{ width: 9, height: 9, borderRadius: 2, background: zoneColour(z), opacity: 0.8 }} />
                          {z}
                        </span>
                      ))}
                    <span style={{ color: zoneGeometry.overlaps.length > 0 ? "#fbbf24" : C.ok }}>
                      {zoneGeometry.source
                        ? `bands authored by ${zoneGeometry.source}`
                        : "bands inferred from the register"}
                      {" · "}
                      {zoneGeometry.overlaps.length > 0
                        ? zoneGeometry.overlaps
                            .map((o) => `${o.a}∩${o.b} Fr ${o.lo}–${o.hi}`)
                            .join(" · ")
                        : zoneGeometry.source
                          ? "no bounds share hull"
                          : "extents are disjoint — no anomalies"}
                    </span>
                    {(zoneChart?.audit.out_of_bounds.length ?? 0) > 0 && (
                      <span
                        style={{ color: "#f87171", fontWeight: 700 }}
                        title="The register assigns these spaces to a zone whose authored bounds they sit outside. One of the two documents is wrong; the tool's job is to say so, not to pick."
                      >
                        out of authored bounds:{" "}
                        {zoneChart?.audit.out_of_bounds
                          .map((o) => `${o.compartment} (Fr ${o.frame} vs ${o.zone} ${o.lo_frame}–${o.hi_frame})`)
                          .join(" · ")}
                      </span>
                    )}
                    {(zoneChart?.audit.unbounded_zones.length ?? 0) > 0 && (
                      <span style={{ color: C.warn }} title="Zones carrying spaces the chart does not bound — drawn inferred.">
                        chart does not bound {zoneChart?.audit.unbounded_zones.join(", ")}
                      </span>
                    )}
                  </>
                )}
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
            <TracePanel
              row={selectedRow ?? null}
              decision={decision}
              asOf={asOf}
              identity={identity}
              vesselId={vesselId}
              rows={rows}
              onOpenSpace={openSpace}
              reveal={revealNonce}
              spaceLoad={spaceLoad}
              horizonLabel={HORIZONS[horizon].label.toLowerCase()}
              hazards={hazards}
              onCleared={handleCleared}
              epoch={epoch}
            />
          </aside>
        )}

        {/* In full screen the trace and its options ride along as a drawer.
            Losing them was the old behaviour, and it meant the one presentation a
            supervisor actually stands in front of had no explanation of a held
            space and no route to a fix. Same component as the aside — a second
            implementation is how the two would start disagreeing. */}
        {fullScreen && altitude === "compartment" && selectedRow && (
          <div
            style={{
              position: "fixed",
              top: MARKING_H,
              right: 0,
              bottom: MARKING_H,
              width: 400,
              maxWidth: "92vw",
              zIndex: 46,
              background: "#121316",
              borderLeft: `1px solid ${LINE}`,
              boxShadow: "-14px 0 34px rgba(0,0,0,0.55)",
              overflowY: "auto",
              padding: 14,
            }}
          >
            <button
              onClick={() => setSelected(null)}
              title="Close (Esc)"
              style={{
                float: "right", font: "inherit", fontSize: 12, cursor: "pointer",
                background: "transparent", color: DIM, border: `1px solid ${LINE}`,
                borderRadius: 5, padding: "2px 8px",
              }}
            >
              ✕
            </button>
            <TracePanel
              row={selectedRow}
              decision={decision}
              asOf={asOf}
              identity={identity}
              vesselId={vesselId}
              rows={rows}
              onOpenSpace={openSpace}
              reveal={revealNonce}
              spaceLoad={spaceLoad}
              horizonLabel={HORIZONS[horizon].label.toLowerCase()}
              hazards={hazards}
              onCleared={handleCleared}
              epoch={epoch}
            />
          </div>
        )}
      </div>
    </div>
  );
}


/** The manning strip's step: what one click of the clicker covers. */
function manningStep(horizon: Horizon, at: number): { start: number; end: number; noun: string; label: string } {
  const step = HORIZONS[horizon].step;
  if (horizon === "day") {
    const start = blockStart(at);
    return { start, end: start + step, noun: "half-shift", label: `${fmtDay(start)} · ${blockLabel(start)}` };
  }
  if (horizon === "week") return { start: at, end: at + step, noun: "day", label: fmtDay(at) };
  if (horizon === "month") return { start: at, end: at + step, noun: "week", label: `wk of ${fmtDay(at)}` };
  return { start: at, end: at + step, noun: "month", label: fmtMonth(at) };
}

/**
 * Crews, superimposed on the reading. One step of the clicker — a half-shift,
 * a day, a week — priced in PEOPLE: demand from the register by the shared
 * pro-rating rule, supply from the imported manning book (or "demand only",
 * said out loud), zones rolled up with their trade mix, and the zones that
 * are colliding through the hull's physics named as pairs. Everything here is
 * arithmetic over data the screen already fetched; the panel cannot disagree
 * with the map above it.
 */
function ManningPanel({
  activities, rows, conflicts, book, horizon, at,
}: {
  activities: Activity[];
  rows: DeckStateRow[];
  conflicts: WorkConflicts | null;
  book: ManningBook | null;
  horizon: Horizon;
  at: number;
}) {
  const step = manningStep(horizon, at);
  const spaceZone = useMemo(
    () => new Map(rows.map((r) => [r.compartment.compartment_no, r.compartment.zone])),
    [rows],
  );
  const trades = useMemo(
    () => demandByTrade(activities, step.start, step.end),
    [activities, step.start, step.end],
  );
  const { zones, unzonedHours } = useMemo(
    () => demandByZone(activities, spaceZone, step.start, step.end, CREW_TOLERANCE),
    [activities, spaceZone, step.start, step.end],
  );
  const interactions = useMemo(
    () => zoneInteractions(conflicts, spaceZone),
    [conflicts, spaceZone],
  );
  const have = new Map((book?.crews ?? []).map((c) => [c.trade, c.headcount]));
  const totalPeople = trades.reduce((n, t) => n + t.people, 0);
  const ppl = (n: number) => `≈${Math.ceil(n)}`;

  const chipBase: React.CSSProperties = {
    border: `1px solid ${LINE}`, borderRadius: 5, padding: "3px 8px",
    fontSize: 11, whiteSpace: "nowrap",
  };

  return (
    <div
      style={{
        border: `1px solid ${LINE}`, borderRadius: 8, padding: "10px 14px",
        marginBottom: 12, background: "#121316",
        display: "flex", flexDirection: "column", gap: 8,
      }}
    >
      <div style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: DIM }}>
          Manning — this {step.noun}
        </span>
        <span style={{ fontFamily: "monospace", color: C.bright, fontSize: 12 }}>{step.label}</span>
        <b style={{ color: C.bright }}>{ppl(totalPeople)} people on the hull</b>
        <span style={{ color: DIM, fontSize: 11 }}>
          {book
            ? `supply: ${book.label}`
            : "demand only — no manning book loaded (Data Sources → Manning book)"}
        </span>
        {unzonedHours > 0 && (
          <span style={{ color: C.warn, fontSize: 11 }} title="Scheduled hours whose space maps to no zone — counted, never hidden.">
            {mh(Math.round(unzonedHours))} unzoned
          </span>
        )}
      </div>

      {/* Trades: need vs have. The shortfall is the headline, not the list. */}
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 9.5, letterSpacing: 0.6, textTransform: "uppercase", color: C.subtle, minWidth: 48 }}>
          Trades
        </span>
        {trades.length === 0 && <span style={{ color: DIM, fontSize: 11 }}>nothing scheduled this {step.noun}</span>}
        {trades.map((t) => {
          const supply = have.get(t.trade);
          const short = supply !== undefined && Math.ceil(t.people) > supply;
          return (
            <span
              key={t.trade}
              title={`${t.trade}: ${Math.round(t.hours)} MH this ${step.noun} → ${ppl(t.people)} people${supply !== undefined ? ` · book says ${supply} available per half-shift` : " · no manning line"}`}
              style={{
                ...chipBase,
                color: short ? "#fca5a5" : TEXT,
                borderColor: short ? "rgba(239,68,68,0.6)" : LINE,
                background: short ? "rgba(239,68,68,0.08)" : "transparent",
              }}
            >
              {t.trade} <b>{ppl(t.people)}</b>
              {supply !== undefined && (
                <span style={{ color: short ? "#fca5a5" : C.ok }}> / {supply}{short ? " SHORT" : ""}</span>
              )}
            </span>
          );
        })}
      </div>

      {/* Zones: where those people stand. Crowded = some single space in the
          zone implies more people than the working tolerance. */}
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 9.5, letterSpacing: 0.6, textTransform: "uppercase", color: C.subtle, minWidth: 48 }}>
          Zones
        </span>
        {zones.length === 0 && <span style={{ color: DIM, fontSize: 11 }}>no zoned work this {step.noun}</span>}
        {zones.map((z) => {
          const mix = [...z.byTrade.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([t, h]) => `${t} ${ppl(h / ((step.end - step.start) / 3_600_000))}`)
            .join(" · ");
          return (
            <span
              key={z.zone}
              title={`${z.zone}: ${Math.round(z.hours)} MH this ${step.noun} → ${ppl(z.people)} people\n${mix}${z.crowded ? `\n⚠ a space in this zone implies more than ${CREW_TOLERANCE} people at once` : ""}`}
              style={{
                ...chipBase,
                color: TEXT,
                borderColor: z.crowded ? "rgba(245,158,11,0.65)" : LINE,
                background: z.crowded ? "rgba(245,158,11,0.08)" : "transparent",
              }}
            >
              {z.zone} <b>{ppl(z.people)}</b>{z.crowded ? " ⚠" : ""}
              <span style={{ color: DIM }}> · {mix}</span>
            </span>
          );
        })}
      </div>

      {/* Zones against zones: the day's served hot-vs-flammable pairs, rolled
          up to the zone grain — "which sections are fighting each other". */}
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 9.5, letterSpacing: 0.6, textTransform: "uppercase", color: C.subtle, minWidth: 48 }}>
          Zone ⚡ zone
        </span>
        {interactions.length === 0 && (
          <span style={{ color: DIM, fontSize: 11 }}>
            no zones colliding today{conflicts === null ? " (conflicts unavailable)" : ""}
          </span>
        )}
        {interactions.map((x) => (
          <span
            key={`${x.a}-${x.b}`}
            title={x.reasons.join("\n")}
            style={{ ...chipBase, color: C.warn, borderColor: "rgba(245,158,11,0.5)" }}
          >
            {x.a === x.b ? `${x.a} internal` : `${x.a} ⚡ ${x.b}`} · {x.pairs} pair{x.pairs === 1 ? "" : "s"}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * The administrative clearance, where the refusal is (VR-05).
 *
 * The crew verifies the field condition ended — tag-out log sighted, gas-free
 * certificate in hand — and the manager records that here with its basis. The
 * server closes the fact, writes `HAZARD_CLEARED` to the ledger, and every
 * verdict it was driving re-derives on the refetch this triggers. Live-fed
 * conditions (hot work in progress) end themselves; this door is for the ones
 * that end on a person's verification.
 */
function ClearControl({
  identity, vesselId, hazard, onCleared,
}: {
  identity: Identity;
  vesselId: string;
  hazard: LiveHazard;
  onCleared: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [basis, setBasis] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (busy || basis.trim().length === 0) return;
    setBusy(true);
    setError(null);
    clearHazard(identity, vesselId, {
      compartment: hazard.origin,
      kind: hazard.kind,
      basis: basis.trim(),
    })
      .then(() => {
        // No local repaint: the fact is closed server-side and the refetch
        // re-derives every verdict it was driving. Painting green here and
        // being contradicted by the server is exactly DEF-1.
        onCleared();
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      });
  };

  return (
    <div style={{ marginTop: 8, border: `1px solid ${LINE}`, borderRadius: 6, padding: "8px 10px" }}>
      <div style={{ fontSize: 12, color: C.bright }}>{hazard.label}</div>
      <div style={{ fontSize: 11, color: DIM, marginTop: 2 }}>
        <span style={{ fontFamily: "monospace" }}>{hazard.origin}</span> · raised {fmtDate(hazard.since)}
      </div>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          style={{
            marginTop: 6, font: "inherit", fontSize: 11.5, cursor: "pointer",
            background: "transparent", color: C.accent, border: `1px solid ${LINE}`,
            borderRadius: 5, padding: "3px 9px",
          }}
        >
          Record administrative clearance…
        </button>
      )}
      {open && (
        <div style={{ marginTop: 7 }}>
          <div style={{ fontSize: 11, color: DIM, lineHeight: 1.45 }}>
            Only once the field condition is verified ended — tag-out log sighted,
            gas-free certificate in hand. This writes a ledger entry with your
            basis, and every space this fact is holding re-derives immediately.
          </div>
          <input
            value={basis}
            onChange={(e) => setBasis(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder="Basis — what was verified, and by whom"
            autoFocus
            style={{
              marginTop: 6, width: "100%", boxSizing: "border-box", font: "inherit",
              fontSize: 12, padding: "5px 8px", background: "#0d0e11", color: C.bright,
              border: `1px solid ${LINE}`, borderRadius: 5,
            }}
          />
          <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center" }}>
            <button
              onClick={submit}
              disabled={busy || basis.trim().length === 0}
              style={{
                font: "inherit", fontSize: 11.5, fontWeight: 700,
                cursor: busy || basis.trim().length === 0 ? "default" : "pointer",
                background: basis.trim().length === 0 ? "transparent" : "#173322",
                color: basis.trim().length === 0 ? DIM : "#4ade80",
                border: `1px solid ${basis.trim().length === 0 ? LINE : "#2c5c3c"}`,
                borderRadius: 5, padding: "3px 10px",
              }}
            >
              {busy ? "Recording…" : "Clear — write the ledger entry"}
            </button>
            <button
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
              style={{
                font: "inherit", fontSize: 11.5, cursor: "pointer", background: "transparent",
                color: DIM, border: `1px solid ${LINE}`, borderRadius: 5, padding: "3px 9px",
              }}
            >
              Cancel
            </button>
          </div>
          {error && (
            <div style={{ marginTop: 6, fontSize: 11.5, color: C.danger }}>{error}</div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The decision trace and its options — why the space is in its state, and what
 * would change it.
 *
 * One component because it renders in two homes: the aside beside the plan, and
 * the slide-in drawer over the full-screen canvas. Two implementations is how
 * the drawer's answer and the panel's answer would start to differ.
 */
function TracePanel({
  row, decision, asOf, identity, vesselId, rows, onOpenSpace, reveal,
  spaceLoad, horizonLabel, hazards, onCleared, epoch,
}: {
  row: DeckStateRow | null;
  decision: Decision | null;
  asOf: AsOf;
  identity: Identity;
  vesselId: string;
  rows: DeckStateRow[];
  onOpenSpace: (compartment: string) => void;
  reveal: number;
  /** Scheduled load per space inside the reading window. */
  spaceLoad: Map<string, SpaceLoad>;
  horizonLabel: string;
  /** The hull's live recorded facts, for the clear affordance. */
  hazards: LiveHazard[];
  /** A clearance was recorded — refetch, the verdicts have moved. */
  onCleared: () => void;
  /** Bumped per mutation; keys the options panel so its proposals re-derive
   *  too — an options card still offering to clear a cleared bus is stale. */
  epoch: number;
}) {
  return (
    <>
            <div style={{ fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: DIM }}>
              Decision trace
            </div>
            {!row && (
              <p style={{ color: DIM, fontSize: 12.5, marginTop: 8 }}>
                Select a compartment to see why it is in{" "}
                {asOf === null ? "its current state" : "that state at this instant"} — every rule
                that fired, the path the hazard took, and who may clear it.
              </p>
            )}
            {row && (
              <>
                <div style={{ marginTop: 6, display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontFamily: "monospace" }}>{row.compartment.compartment_no}</span>
                  <span style={{ color: STATE_STYLE[row.state].fg, fontWeight: 700, fontSize: 12 }}>
                    {row.state}
                  </span>
                  <span
                    style={{ fontSize: 10, fontWeight: 700, color: OVERLAY_STYLE[overlayBucket(row)].fg }}
                    title={OVERLAY_STYLE[overlayBucket(row)].gloss}
                  >
                    {OVERLAY_STYLE[overlayBucket(row)].label}
                  </span>
                </div>
                <div style={{ fontSize: 12.5, color: DIM }}>{row.compartment.name}</div>
                <div style={{ fontSize: 11, color: DIM, marginTop: 2 }}>
                  {row.compartment.zone} · {row.compartment.category}
                  {row.compartment.frame !== null && ` · Fr ${row.compartment.frame}`}
                  {` · ${row.compartment.side}`}
                </div>

                {row.work_order_codes.length > 0 && (
                  <div style={{ marginTop: 9, paddingTop: 9, borderTop: `1px solid ${LINE}` }}>
                    <div style={{ fontSize: 9.5, letterSpacing: 0.6, textTransform: "uppercase", color: DIM }}>
                      Work in this space
                    </div>
                    <div style={{ fontSize: 12, marginTop: 3 }}>{row.work_order_codes.join(", ")}</div>
                    <div style={{ fontSize: 11, color: DIM }}>
                      {row.trades.join(" · ")} — {row.remaining_hours.toLocaleString()} MH remaining
                    </div>
                    {(() => {
                      const l = spaceLoad.get(row.compartment.compartment_no);
                      const label = horizonLabel;
                      return (
                        <div style={{ fontSize: 11, marginTop: 3, color: l ? C.bright : DIM }}>
                          {l ? (
                            <>
                              this {label}: {l.count} activit{l.count === 1 ? "y" : "ies"} ·{" "}
                              {Math.round(l.hours).toLocaleString()} MH
                              {l.refused > 0 && (
                                <b style={{ color: C.danger }}> · {l.refused} refused</b>
                              )}
                              {l.next && (
                                <span style={{ color: DIM }}>
                                  {" "}· next {l.next.code} on {fmtDay(l.next.start)}
                                </span>
                              )}
                            </>
                          ) : (
                            <>nothing scheduled here this {label}</>
                          )}
                        </div>
                      );
                    })()}
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
                        Cleared by <b style={{ color: C.bright }}>{step.clearing_authority}</b> · earliest{" "}
                        {fmtClear(step.earliest_clear)}
                      </div>
                      <div style={{ fontSize: 10, color: "#5a6070", marginTop: 3, fontFamily: "monospace" }}>
                        rule version {step.rule_version}
                      </div>
                    </div>
                  );
                })}
                {/* The facts behind the trace, with the clear action. The trace
                    above answers WHY the space is shut; each entry here is the
                    ONE recorded fact driving those steps, and clearing it is how
                    the whole set flips — "when we clear that red X, does that
                    clear all the other red?" It must. */}
                {(() => {
                  const steps = decision?.trace ?? [];
                  const facts = hazards.filter((h) =>
                    steps.some((st) => st.source === h.origin && st.hazard === h.label),
                  );
                  if (facts.length === 0) return null;
                  return (
                    <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${LINE}` }}>
                      <div style={{ fontSize: 9.5, letterSpacing: 0.6, textTransform: "uppercase", color: DIM }}>
                        Field conditions holding this space
                      </div>
                      {facts.map((f) => (
                        <ClearControl
                          key={`${f.origin}:${f.kind}`}
                          identity={identity}
                          vesselId={vesselId}
                          hazard={f}
                          onCleared={onCleared}
                        />
                      ))}
                    </div>
                  );
                })()}

                {/* Directly under the trace, because the two answer consecutive
                    questions: the trace says why the space is shut, and this says
                    what would open it. Splitting them across screens would make a
                    planner hold the first in their head while looking for the
                    second. */}
                <Mitigations
                  key={`${row.compartment.compartment_no}:${epoch}`}
                  identity={identity}
                  vesselId={vesselId}
                  compartment={row.compartment.compartment_no}
                  asOf={asOf}
                  spaces={rows}
                  onOpenSpace={onOpenSpace}
                  reveal={reveal}
                />
              </>
            )}
    </>
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
      <p style={{ color: DIM, fontSize: 11.5, margin: "0 0 12px", maxWidth: 780 }}>
        {altitude === "ship"
          ? "Every space on the hull, joined to the work booked in it."
          : "Zones worst first, by the man-hours each is holding."}{" "}
        <b style={{ color: C.bright }}>Held</b> means work is booked and the engine
        refuses it — the only category costing the availability today. A closed space
        with nothing booked in it is <b style={{ color: C.bright }}>latent</b>, not held:
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
  deckBands,
  sheet, rows, selected, onSelect, deckJumps, onDeckJump, toneOf, zoom, setZoom, pan, setPan,
  dragging, hoverFrame, setHoverFrame, cascadeEdges, overlay, maxH, zonesOn, zones, zoneAlerts, zoneRows,
  load, windowDays, horizonLabel, conflicts,
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
  /** Height budget in px. The caller owns this because only it knows whether the
   *  view is a panel in a page or a real full-screen fill of the viewport. */
  maxH: number;
  /** Shade zone bands and compartment footprints over the plate. */
  zonesOn: boolean;
  /** The hull's zone bands and audit, shared with the whole-ship view. */
  zones: ZoneGeometry;
  /** Spaces the server's audit puts outside their zone's authored bounds. */
  zoneAlerts: Set<string>;
  /** Every space on this deck, unfiltered — the shading verifies the register,
   *  and a filtered set would make the check pass vacuously. */
  zoneRows: DeckStateRow[];
  /** Scheduled man-hours per space inside the reading window. */
  load: Map<string, SpaceLoad>;
  /** The reading window's length in days — the crew estimate's denominator. */
  windowDays: number;
  horizonLabel: string;
  /** The day's served hot-vs-flammable pairs, drawn on the plate. */
  conflicts: WorkConflicts | null;
  /** The geometry register's coverage bands for THIS deck, when one is
   *  loaded: where the deck physically exists. Everything outside shades
   *  as "no deck here" — an empty area must not read as "nothing scheduled". */
  deckBands: { label: string; bands: { lo_frame: number; hi_frame: number }[] } | null;
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

  // Wheel and pinch zoom, centred on the cursor — the gesture every reader tries
  // first, and until now the one thing the canvas did not do.
  //
  // A native non-passive listener rather than React's onWheel, because the page
  // must not scroll out from under the gesture and a passive listener cannot
  // prevent that. The camera state is read through a ref so the listener binds
  // once instead of re-attaching every render.
  const camRef = useRef<{
    z: number; centre: { x: number; y: number }; vw: number; vh: number; u: number;
    fit: number; naturalH: number; boxW: number; maxH: number; pan: { x: number; y: number };
  } | null>(null);
  const setZoomRef = useRef(setZoom);
  const setPanRef = useRef(setPan);
  setZoomRef.current = setZoom;
  setPanRef.current = setPan;
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent) => {
      const cam = camRef.current;
      if (!cam) return;
      e.preventDefault();
      // The cursor-fixed solve lives in camera.ts, where it is unit-tested.
      const zNew = clampZoom(cam.z * wheelFactor(e.deltaY, e.deltaMode, e.ctrlKey), MAX_SHEET_ZOOM);
      if (zNew === cam.z) return;
      const box = el.getBoundingClientRect();
      setPanRef.current(sheetZoomAt(cam, e.clientX - box.left, e.clientY - box.top, zNew));
      setZoomRef.current(zNew);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const cal = sheet.calibration;
  const { width: W, height: H } = sheet;
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

  // The camera as of this render, readable from the wheel listener without
  // re-binding it every frame.
  camRef.current = { z, centre, vw, vh, u, fit, naturalH, boxW, maxH, pan };

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

  // Violation focus — one grammar across every canvas: click a refused space
  // and the plate becomes an answer about THAT violation. The selected space
  // and the hazard's route stay lit, everything else dims. A space that
  // permits work focuses nothing.
  const selRow = rows.find((r) => r.compartment.compartment_no === selected);
  const violationFocus = selRow !== undefined && !selRow.permits_work;
  const involved = new Set<string>(
    violationFocus && selected !== null ? [selected, ...cascadeEdges.flat()] : [],
  );

  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: 8, background: C.well, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 11px", borderBottom: `1px solid ${LINE}`, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, fontWeight: 600 }}>{sheet.label} — general arrangement</span>
        <span style={{ fontSize: 10.5, color: DIM }}>bow right · drag to pan</span>
        {!showLabels && <span style={{ fontSize: 10.5, color: DIM }}>· zoom in for labels</span>}
        {offScreen > 0 && (
          <span style={{ fontSize: 10.5, color: C.danger }} title="Pan, or use Fit width">
            · {offScreen} marker{offScreen === 1 ? "" : "s"} off-screen
          </span>
        )}
        {violationFocus && (
          <span style={{ fontSize: 10.5, color: STATE_STYLE.SUSPEND.fg }}>
            · violation focus — everything off the hazard's route dims
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
              background: C.well, color: DIM, fontSize: 12, zIndex: 2,
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

          {/* Deck delineation: where the geometry register says this deck
              does NOT exist, the plate shades — so an empty region reads as
              "no deck here", never as "nothing scheduled here". Bands are the
              drawing's claim; absence of bands claims nothing and shades
              nothing. */}
          {cal && deckBands && deckBands.bands.length > 0 && (() => {
            const maxFrame = Math.ceil(cal.frame0X / cal.pxPerFrame);
            const covered = deckBands.bands
              .map((b) => [Math.max(0, b.lo_frame), Math.min(maxFrame, b.hi_frame)] as [number, number])
              .sort((a, b) => a[0] - b[0]);
            const gaps: [number, number][] = [];
            let cursor = 0;
            for (const [lo, hi] of covered) {
              if (lo > cursor) gaps.push([cursor, lo]);
              cursor = Math.max(cursor, hi);
            }
            if (cursor < maxFrame) gaps.push([cursor, maxFrame]);
            return (
              <g pointerEvents="none">
                {gaps.map(([lo, hi]) => {
                  const xHi = sheetX(cal, hi);
                  const xLo = sheetX(cal, lo);
                  const [gx, gw] = xHi < xLo ? [xHi, xLo - xHi] : [xLo, xHi - xLo];
                  return (
                    <g key={`${lo}-${hi}`}>
                      <rect x={gx} y={0} width={gw} height={H} fill="#0a0b0d" opacity={0.55} />
                      {gw > 260 * u && (
                        <text x={gx + gw / 2} y={H * 0.5} fill="#6a7080" fontSize={15 * u} fontWeight={700} textAnchor="middle" letterSpacing={1.2}>
                          NO DECK HERE · fr {lo}–{hi} · {deckBands.label}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })()}

          {/* Zones & compartments shading — the register's geometry made
              visible so it can be CHECKED, not trusted. A zone is a band of
              frames (the extent of its spaces on this deck, drawn edge to
              edge); a compartment is a box at its own pin. Drawn under the
              markers and over the plate, in the plate's own units so it scales
              with the drawing it is claiming things about. */}
          {zonesOn && cal && (
            <g pointerEvents="none">
              {/* The hull's tiled bands from zones.ts — the same boundaries the
                  whole-ship view draws, clipped by this plate's own camera. */}
              {zones.bands.map((band) => {
                const colour = zoneColour(band.zone);
                const xHi = sheetX(cal, band.hi);
                const xLo = sheetX(cal, band.lo);
                const [bandX, bandW] = xHi < xLo ? [xHi, xLo - xHi] : [xLo, xHi - xLo];
                // Authored bounds draw solid — a chart's word; inferred stay
                // dashed — a guess, and the edge says so.
                const dash = band.authored ? undefined : `${8 * u} ${6 * u}`;
                return (
                  <g key={band.zone}>
                    <rect x={bandX} y={0} width={bandW} height={H} fill={colour} opacity={0.08} />
                    <line x1={bandX} y1={0} x2={bandX} y2={H} stroke={colour} strokeWidth={(band.authored ? 1.8 : 1.4) * u} strokeDasharray={dash} opacity={0.55} />
                    <line x1={bandX + bandW} y1={0} x2={bandX + bandW} y2={H} stroke={colour} strokeWidth={(band.authored ? 1.8 : 1.4) * u} strokeDasharray={dash} opacity={0.55} />
                    {/* Named at both plate edges: whichever edge the camera is
                        looking at, the band says whose it is. */}
                    {[26 * u, H - 14 * u].map((ty) => (
                      <text key={ty} x={bandX + 8 * u} y={ty} fill={colour} fontSize={13 * u} fontWeight={700} letterSpacing={0.8}>
                        {band.zone}
                      </text>
                    ))}
                  </g>
                );
              })}
              {zoneRows.map((r) => {
                const frame = r.compartment.frame;
                if (frame === null) return null;
                const colour = zoneColour(r.compartment.zone);
                const cx = sheetX(cal, frame);
                const cy = sheetY(cal, sheet, r.compartment.side, frame);
                const halfW = Math.abs(sheetX(cal, frame - 2) - sheetX(cal, frame + 2)) / 2;
                const halfH = H * 0.028;
                // The audit's disagreement, drawn where the space sits: the
                // register says this zone, the chart's bounds say elsewhere.
                const alert = zoneAlerts.has(r.compartment.compartment_no);
                return (
                  <g key={r.compartment.compartment_no}>
                    <rect
                      x={cx - halfW} y={cy - halfH} width={halfW * 2} height={halfH * 2} rx={3 * u}
                      fill={colour} opacity={0.16}
                    />
                    <rect
                      x={cx - halfW} y={cy - halfH} width={halfW * 2} height={halfH * 2} rx={3 * u}
                      fill="none" stroke={alert ? C.warn : colour} strokeWidth={(alert ? 2.2 : 1.2) * u}
                      strokeDasharray={alert ? `${5 * u} ${3 * u}` : undefined} opacity={alert ? 1 : 0.85}
                    />
                    {alert && (
                      <text x={cx} y={cy - halfH - 4 * u} fill={C.warn} fontSize={10 * u} fontWeight={700} textAnchor="middle">
                        OUT OF {r.compartment.zone} BOUNDS
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          )}

          {/* The day's hot-vs-flammable pairs, on the drawing itself. */}
          {(conflicts?.pairs ?? []).map((pr, i) => {
            const a = placed.get(pr.hot.space);
            const b = placed.get(pr.flammable.space);
            if (!a || !b || pr.hot.space === pr.flammable.space) return null;
            return (
              <g key={`cf-${i}`} pointerEvents="none">
                <line
                  x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  stroke={C.warn} strokeWidth={2.2 * u} strokeDasharray={`${5 * u} ${5 * u}`} opacity={0.85}
                />
                <title>{pr.reason}</title>
              </g>
            );
          })}
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
            const l = load.get(no);
            // The day-driven rule, same as the schematic: the schedule decides
            // what the plate shows. Quiet open spaces recede to a dot.
            const active = (l?.count ?? 0) > 0 && (l?.hours ?? 0) >= 1;
            const heldQuiet = !active && (r.readiness === "held" || r.state !== "ALLOW");
            const crew = active ? Math.max(1, Math.ceil((l?.hours ?? 0) / (8 * Math.max(1, windowDays)))) : 0;
            const crowded = crew > CREW_TOLERANCE;
            const fwd = r.compartment.fwd_frame;
            const aft = r.compartment.aft_frame;
            const surveyed = fwd !== null && aft !== null;
            const provenance = surveyed
              ? `position: surveyed extent fr ${fwd}–${aft}`
              : r.compartment.geometry_source === "parsed"
                ? "position: parsed from the placard number — forward boundary only, transverse is a legible placement"
                : `position source: ${r.compartment.geometry_source}`;
            const extentBand = surveyed && cal && (
              <g pointerEvents="none">
                <rect
                  x={Math.min(sheetX(cal, fwd), sheetX(cal, aft))}
                  y={at.y - H * 0.024}
                  width={Math.abs(sheetX(cal, fwd) - sheetX(cal, aft))}
                  height={H * 0.048}
                  rx={3 * u}
                  fill={toneOf(r).fg}
                  opacity={0.14}
                />
                <rect
                  x={Math.min(sheetX(cal, fwd), sheetX(cal, aft))}
                  y={at.y - H * 0.024}
                  width={Math.abs(sheetX(cal, fwd) - sheetX(cal, aft))}
                  height={H * 0.048}
                  rx={3 * u}
                  fill="none"
                  stroke={toneOf(r).fg}
                  strokeWidth={1.6 * u}
                  opacity={0.8}
                />
              </g>
            );
            if (!active && !heldQuiet && !isSel && !isHot) {
              return (
                <g key={no} onClick={() => onSelect(no)} onPointerEnter={() => setHovered(no)} style={{ cursor: "pointer" }}>
                  <title>
                    {`${no} — ${r.compartment.name}\nno work this ${horizonLabel} · nothing refuses work here at this instant\n${provenance}\nA candidate site for ad-hoc work — verify gas-free status with the certifying authority before hot work.`}
                  </title>
                  {extentBand}
                  <circle cx={at.x} cy={at.y} r={3.4 * u} fill={OVERLAY_STYLE.go.fg} fillOpacity={0.4} stroke={OVERLAY_STYLE.go.fg} strokeWidth={1 * u} strokeOpacity={0.6} />
                </g>
              );
            }
            const label = isSel || isHot || (showLabels && (active || heldQuiet));
            const jump = deckJumps.get(no);
            const inViolation = involved.has(no);
            const dimmed = violationFocus && !inViolation;
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
                opacity={dimmed ? 0.45 : 1}
              >
                {/* The violation's own spaces get a halo, so the route reads
                    even where lit and dimmed pins sit close. */}
                {violationFocus && inViolation && (
                  <circle
                    cx={at.x} cy={at.y} r={14 * u}
                    fill="none" stroke={isSel ? C.accent : STATE_STYLE.SUSPEND.fg}
                    strokeWidth={1.6 * u} opacity={0.75}
                  />
                )}
                {extentBand}
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
                {/* A held space has a computed route out, and the plan itself
                    says so — a wrench beside the pin, not a fact buried in a
                    panel the reader has not opened yet. */}
                {r.readiness === "held" && (
                  <g>
                    <title>Held — mitigation options exist. Click for the fix.</title>
                    <circle
                      cx={at.x + 12 * u} cy={at.y - 12 * u} r={7.5 * u}
                      fill="#0b0c0e" fillOpacity={0.95} stroke={tone.fg} strokeWidth={1.3 * u}
                    />
                    <text x={at.x + 12 * u} y={at.y - 9 * u} fill={tone.fg} fontSize={9 * u} textAnchor="middle">
                      ⚒
                    </text>
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
                        x={at.x - (active ? 54 : 44) * u} y={ly - 7.5 * u} width={(active ? 108 : 88) * u} height={15 * u} rx={3 * u}
                        fill="#0b0c0e" fillOpacity={0.92} stroke={crowded ? C.warn : tone.fg} strokeWidth={(crowded ? 1.6 : 1) * u}
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
                        {active ? `${no} · ≈${crew}${crowded ? "⚠" : ""}` : no}
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
            <div style={{ fontSize: 10.5, color: "#8a90a0", marginTop: 2 }}>
              {hoverRow.compartment.fwd_frame !== null && hoverRow.compartment.aft_frame !== null
                ? `surveyed extent fr ${hoverRow.compartment.fwd_frame}–${hoverRow.compartment.aft_frame}`
                : hoverRow.compartment.geometry_source === "parsed"
                  ? "position parsed from placard — fwd boundary only"
                  : `position source: ${hoverRow.compartment.geometry_source}`}
            </div>
            <div style={{ fontSize: 11.5, color: C.bright }}>{hoverRow.compartment.name}</div>
            <div style={{ fontSize: 10.5, color: DIM }}>
              {hoverRow.compartment.zone} · Fr {hoverRow.compartment.frame} · {hoverRow.compartment.side}
              {hoverRow.remaining_hours > 0 && ` · ${mh(hoverRow.remaining_hours)} left`}
            </div>
            {hoverRow.readiness === "held" && (
              <div style={{ fontSize: 10.5, color: DIM, marginTop: 2 }}>
                cleared by <b style={{ color: C.bright }}>{hoverRow.clearing_authority || "unnamed authority"}</b> ·{" "}
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
  hoverFrame, setHoverFrame, deckLabel, cascadeEdges, load, windowDays,
  horizonLabel, conflicts,
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
  /** Scheduled man-hours per space inside the reading window. */
  load: Map<string, SpaceLoad>;
  /** The reading window's length in days — the crew estimate's denominator. */
  windowDays: number;
  /** "day" | "week" | "month" | "availability", for the tooltips. */
  horizonLabel: string;
  /** The day's served hot-vs-flammable pairs, drawn as links between pins. */
  conflicts: WorkConflicts | null;
}) {
  const W = 1000;
  const MARKER_W = 92;
  const MARKER_H = 26;
  const maxLoad = Math.max(0, ...rows.map((r) => load.get(r.compartment.compartment_no)?.hours ?? 0));
  void maxLoad;
  const conflictSpaces = new Set(
    (conflicts?.pairs ?? []).flatMap((pr) => [pr.hot.space, pr.flammable.space]),
  );
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

  // Wheel zoom under the cursor. Same non-passive-listener pattern as SheetView,
  // for the same reason: a passive listener cannot stop the page scrolling out
  // from under the gesture. Camera here is translate(pan)·scale(zoom) in viewBox
  // units, so keeping the cursor's point fixed is the standard solve.
  const wheelRef = useRef<HTMLDivElement>(null);
  const camRef = useRef({ zoom, pan });
  camRef.current = { zoom, pan };
  const setZoomRef = useRef(setZoom);
  const setPanRef = useRef(setPan);
  setZoomRef.current = setZoom;
  setPanRef.current = setPan;
  useEffect(() => {
    const el = wheelRef.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent) => {
      const svg = el.querySelector("svg");
      if (!svg) return;
      e.preventDefault();
      const cam = camRef.current;
      // The cursor-fixed solve lives in camera.ts, where it is unit-tested.
      const zNew = clampZoom(cam.zoom * wheelFactor(e.deltaY, e.deltaMode, e.ctrlKey), 4);
      if (zNew === cam.zoom) return;
      const box = svg.getBoundingClientRect();
      // viewBox units per CSS pixel — uniform, because the aspect is preserved.
      const perPx = W / box.width;
      const cursor = { x: (e.clientX - box.left) * perPx, y: (e.clientY - box.top) * perPx };
      setPanRef.current(planZoomAt(cam, cursor, zNew));
      setZoomRef.current(zNew);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Violation focus — one grammar across every canvas: click a refused space
  // and this schematic isolates that violation like the plate and the trace do.
  const selRow = rows.find((r) => r.compartment.compartment_no === selected);
  const violationFocus = selRow !== undefined && !selRow.permits_work;
  const involved = new Set<string>(
    violationFocus && selected !== null ? [selected, ...cascadeEdges.flat()] : [],
  );

  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: 8, background: C.well, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 11px", borderBottom: `1px solid ${LINE}`, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, fontWeight: 600 }}>{deckLabel} — plan</span>
        {violationFocus && (
          <span style={{ fontSize: 10.5, color: STATE_STYLE.SUSPEND.fg }}>
            · violation focus — everything off the hazard's route dims
          </span>
        )}
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

      <div ref={wheelRef}>
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
          <text x={W * 0.955} y={H * 0.5 - 8} fill={C.faint} fontSize={9} textAnchor="end">BOW</text>
          <text x={W * 0.03} y={H * 0.5 - 8} fill={C.faint} fontSize={9}>STERN</text>
          {/* Port is up, starboard is down — looking forward from astern. */}
          <text x={W * 0.5} y={H * 0.15 - 4} fill={C.faint} fontSize={9} textAnchor="middle">PORT</text>
          <text x={W * 0.5} y={H * 0.85 + 11} fill={C.faint} fontSize={9} textAnchor="middle">STBD</text>
          {/* frame ruler */}
          {[40, 80, 120, 160, 200, 240].map((f) => (
            <g key={f}>
              <line x1={frameToX(f) * W} y1={H * 0.1} x2={frameToX(f) * W} y2={H * 0.9} stroke="#1d2029" />
              <text x={frameToX(f) * W} y={H * 0.07} fill={C.faint} fontSize={9} textAnchor="middle">
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

          {/* The day's conflicts, drawn as links before the markers so the
              pins overprint the wire that connects them. */}
          {(conflicts?.pairs ?? []).map((pr, i) => {
            const a = layout.positions.get(pr.hot.space);
            const b = layout.positions.get(pr.flammable.space);
            if (!a || !b || pr.hot.space === pr.flammable.space) return null;
            return (
              <g key={`cf-${i}`} pointerEvents="none">
                <line
                  x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  stroke={C.warn} strokeWidth={1.8} strokeDasharray="3 4" opacity={0.8}
                />
                <title>{pr.reason}</title>
              </g>
            );
          })}
          {rows.map((r) => {
            const at = layout.positions.get(r.compartment.compartment_no);
            if (!at) return null;
            const no = r.compartment.compartment_no;
            const tone = toneOf(r);
            const isSel = no === selected;
            const inViolation = involved.has(no);
            const dimmed = violationFocus && !inViolation;
            const { x, y } = at;
            const l = load.get(no);
            // THE day-driven rule: the schedule decides what the plan shows.
            // A space with work in the reading window is a full marker with
            // its crew loading; a held-or-refusing space stays visible even
            // when quiet (a hold matters to whoever walks past the door); a
            // quiet, open space recedes to a small green dot — still there,
            // still clickable, and exactly what an ad-hoc job goes looking
            // for — instead of a labelled box shouting a name with nothing
            // behind it.
            const active = (l?.count ?? 0) > 0 && (l?.hours ?? 0) >= 1;
            const heldQuiet = !active && (r.readiness === "held" || r.state !== "ALLOW");
            const quiet = !active && !heldQuiet;
            const crew = active ? Math.max(1, Math.ceil((l?.hours ?? 0) / (8 * Math.max(1, windowDays)))) : 0;
            const crowded = crew > CREW_TOLERANCE;
            const inConflict = conflictSpaces.has(no);
            if (quiet && !isSel) {
              return (
                <g key={no} onClick={() => onSelect(no)} style={{ cursor: "pointer" }} opacity={dimmed ? 0.35 : 0.8}>
                  <title>
                    {`${no} — ${r.compartment.name}\nno work this ${horizonLabel} · nothing refuses work here at this instant\nA candidate site for ad-hoc work — verify gas-free status with the certifying authority before hot work.\nClick for the full picture.`}
                  </title>
                  <circle cx={x} cy={y} r={4} fill={OVERLAY_STYLE.go.fg} fillOpacity={0.35} stroke={OVERLAY_STYLE.go.fg} strokeWidth={1} strokeOpacity={0.6} />
                </g>
              );
            }
            const mh2 = MARKER_H + (active ? 8 : 0);
            return (
              <g
                key={no}
                onClick={() => onSelect(no)}
                style={{ cursor: "pointer" }}
                opacity={dimmed ? 0.45 : 1}
              >
                {violationFocus && inViolation && (
                  <rect
                    x={x - MARKER_W / 2 - 4} y={y - mh2 / 2 - 4}
                    width={MARKER_W + 8} height={mh2 + 8} rx={6}
                    fill="none" stroke={isSel ? C.accent : STATE_STYLE.SUSPEND.fg}
                    strokeWidth={1.6} opacity={0.75}
                  />
                )}
                {/* A leader back to the keel line: once a marker is fanned two
                    lanes out, the frame it actually sits at stops being obvious. */}
                <line
                  x1={x} y1={y < H / 2 ? y + mh2 / 2 : y - mh2 / 2}
                  x2={x} y2={H / 2}
                  stroke={tone.border} strokeWidth={0.75} strokeDasharray="3 3" opacity={0.55}
                />
                <rect
                  x={x - MARKER_W / 2} y={y - mh2 / 2}
                  width={MARKER_W} height={mh2} rx={4}
                  fill={tone.bg} stroke={isSel ? C.accent : crowded ? C.warn : tone.border}
                  strokeWidth={isSel || crowded ? 2 : 1}
                />
                <text x={x} y={y + (active ? -1 : 4)} fill={tone.fg} fontSize={10} textAnchor="middle" fontFamily="monospace">
                  {no}
                </text>
                {/* The day's facts, on the marker: hours in the window and the
                    crew it implies (MH ÷ 8-hour shift ÷ days) — the number a
                    supervisor squares against the space's occupancy limit. */}
                {active && (
                  <text x={x} y={y + 11} fill={crowded ? C.warn : DIM} fontSize={8.5} textAnchor="middle">
                    {`${Math.round(l?.hours ?? 0).toLocaleString()} MH · ≈${crew} ppl${crowded ? " ⚠" : ""}`}
                  </text>
                )}
                <title>
                  {`${no} — ${r.compartment.name}\nthis ${horizonLabel}: ${l?.count ?? 0} activit${(l?.count ?? 0) === 1 ? "y" : "ies"} · ${Math.round(l?.hours ?? 0).toLocaleString()} MH · ≈${crew} workers/day (MH ÷ 8-h shift)${crowded ? `\n⚠ over the ${CREW_TOLERANCE}-worker occupancy planning tolerance — stagger trades or shifts` : ""}${(l?.refused ?? 0) > 0 ? `\n${l?.refused} refused in this window` : ""}${inConflict ? "\n⚡ in a hot-vs-flammable pair today — see the link" : ""}`}
                </title>
                {(l?.refused ?? 0) > 0 && (
                  <rect x={x - MARKER_W / 2 + 5} y={y + mh2 / 2 - 4} width={MARKER_W - 10} height={2.5} rx={1} fill={C.danger} opacity={0.9} />
                )}
                {inConflict && (
                  <text x={x + MARKER_W / 2 - 8} y={y - mh2 / 2 + 9} fill={C.warn} fontSize={9} fontWeight={700}>
                    ⚡
                  </text>
                )}
                {r.rules_fired.length > 0 && (
                  <circle cx={x + MARKER_W / 2 - 6} cy={y - mh2 / 2 + 3} r={5} fill={tone.fg} />
                )}
                {/* Same advertisement as the plate view: held means a computed
                    route out exists, and the marker itself says so. */}
                {r.readiness === "held" && (
                  <g>
                    <title>Held — mitigation options exist. Click for the fix.</title>
                    <text x={x - MARKER_W / 2 + 8} y={y - mh2 / 2 - 2} fill={tone.fg} fontSize={9} textAnchor="middle">
                      ⚒
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      </div>
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
