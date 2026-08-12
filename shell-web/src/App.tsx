import { useEffect, useMemo, useState } from "react";
import {
  deckStates,
  listIssues,
  listVessels,
  timeframe,
  type AsOf,
  type DeckStateRow,
  type Issue,
  type Timeframe,
  type VesselSummary,
} from "./api";
import {
  ClassificationBanner,
  GuardrailStrip,
  MARKING_H,
  ModuleRail,
  PERSONAS,
  TopBar,
  type Altitude,
  type HullChoice,
  type ModuleDef,
  type Persona,
} from "./Chrome";
import DailyOps from "./DailyOps";
import { DEMO_IDENTITY, PICKABLE_HULLS } from "./demo";
import DeckExplorer from "./DeckExplorer";
import DistributedPackages from "./DistributedPackages";
import CascadeBoard from "./CascadeBoard";
import SourcesBoard from "./SourcesBoard";
import LedgerBoard from "./LedgerBoard";
import LeverageBoard from "./LeverageBoard";
import SequenceBoard from "./SequenceBoard";
import { fmtInstant, isProjection, TimeControl, type Horizon } from "./TimeControl";
import WorkOrders from "./WorkOrders";
import { C } from "./theme";

// The module rail, mirroring the prototype's grouping and order. `built` is
// honest rather than aspirational: a module with no view is labelled in the rail
// so nobody clicks expecting a screen and reads the emptiness as broken data.
const MODULES: ModuleDef[] = [
  { group: "Operate", label: "Daily Ops", id: "dailyOps", icon: "dailyOps", built: true },
  { group: "", label: "Deck Explorer", id: "deckExplorer", icon: "deckExplorer", built: true },
  { group: "Plan", label: "Sequence Board", id: "sequenceBoard", icon: "sequenceBoard", built: true },
  { group: "", label: "Work Orders", id: "workOrders", icon: "workOrders", built: true },
  { group: "Decide", label: "Conflicts & Risk", id: "leverage", icon: "conflicts", built: true },
  { group: "Yard", label: "Portfolio", id: "portfolio", icon: "portfolio", built: true },
  { group: "", label: "Data Sources", id: "sources", icon: "sources", built: true },
  { group: "Authorization", label: "Distributed Packages", id: "distPackages", icon: "distPackages", built: true },
  { group: "", label: "Decisions Ledger", id: "ledger", icon: "ledger", built: true },
  { group: "", label: "Deconfliction Cascade", id: "cascade", icon: "cascade", built: true },
];

const DECK_EXPLORER = MODULES[1] as ModuleDef;

/**
 * The URL's share of the state: #/{hull}/{module}?as_of=…&space=… — enough to
 * hand a colleague "this space, at this instant, on this screen" as a link.
 * Parsed once at boot; written back with replaceState so scrubbing the clock
 * does not bury the back button under a thousand instants.
 */
function parseHash(): { vessel?: string; module?: string; asOf?: number; space?: string } {
  const h = window.location.hash.replace(/^#\/?/, "");
  if (!h) return {};
  const [path, query] = h.split("?");
  const parts = (path ?? "").split("/").filter(Boolean);
  const q = new URLSearchParams(query);
  const asOf = Number(q.get("as_of"));
  return {
    vessel: parts[0],
    module: parts[1],
    asOf: Number.isFinite(asOf) && asOf > 0 ? asOf : undefined,
    space: q.get("space") ?? undefined,
  };
}
const BOOT = parseHash();

export default function App() {
  const [vessels, setVessels] = useState<VesselSummary[]>([]);
  const [rows, setRows] = useState<DeckStateRow[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [selected, setSelected] = useState<string>(BOOT.vessel ?? PICKABLE_HULLS[0]?.id ?? "");
  const [module, setModule] = useState<ModuleDef>(
    MODULES.find((m) => m.id === BOOT.module && m.built) ?? DECK_EXPLORER,
  );
  // Where a route-to-fix came FROM, so the door swings both ways: any jump
  // from another module leaves a "back" chip over the Deck Explorer.
  const [returnTo, setReturnTo] = useState<ModuleDef | null>(null);
  /** The Deck Explorer's selection, reported up for the shareable URL. */
  const [sharedSpace, setSharedSpace] = useState<string | null>(null);
  const [persona, setPersona] = useState<Persona>(PERSONAS[0] as Persona);
  const [altitude, setAltitude] = useState<Altitude>((PERSONAS[0] as Persona).altitude);
  const [focus, setFocus] = useState<string | null>(null);
  // One instant, one horizon, for the whole app. A time control that meant a
  // different moment on each screen would be worse than none — the Deck Explorer
  // and the ship board would disagree about what is held, and neither would be
  // wrong. Held here for the same reason the altitude is.
  const [frame, setFrame] = useState<Timeframe | null>(null);
  const [asOf, setAsOf] = useState<AsOf>(BOOT.asOf ?? null);
  const [horizon, setHorizon] = useState<Horizon>((PERSONAS[0] as Persona).horizon);
  const [playing, setPlaying] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [wall, setWall] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listVessels(DEMO_IDENTITY)
      .then(setVessels)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  // The hull's spaces, held at this level so the top bar can search and alert on
  // them. The Deck Explorer fetches its own — one extra read of a small endpoint
  // is a better trade than threading its state up through the chrome.
  useEffect(() => {
    if (!selected) return;
    deckStates(DEMO_IDENTITY, selected, asOf)
      .then(setRows)
      .catch(() => setRows([]));
    // The issue board, held here because two pieces of chrome spend it: the
    // alert bell's count and the Conflicts & Risk rail badge. One fetch, one
    // number — a bell and a badge that disagreed would be worse than neither.
    listIssues(DEMO_IDENTITY, selected, asOf)
      .then((r) => setIssues(r.issues))
      .catch(() => setIssues([]));
  }, [selected, asOf]);

  // The hull's time frame. Re-read on hull change and never cached across hulls:
  // each availability has its own bounds, and scrubbing one hull's window over
  // another's data is how a projection ends up outside the range the API accepts.
  useEffect(() => {
    if (!selected) {
      setFrame(null);
      return;
    }
    timeframe(DEMO_IDENTITY, selected)
      .then(setFrame)
      .catch(() => setFrame(null));
  }, [selected]);

  // A module that needs a hull is not rendered until there is one. Rendering it
  // with an empty id fired six requests at `/api/vessels//…` on every load and
  // got six 400s back.
  const needsHull = module.id !== "portfolio" && module.id !== "placeholder";

  // Every hull the shell can be pointed at, whether or not the API will serve it.
  const hulls: HullChoice[] = useMemo(
    () =>
      PICKABLE_HULLS.map((h) => ({
        id: h.id,
        label: h.label,
        vessel: vessels.find((v) => v.vessel_id === h.id),
      })),
    [vessels],
  );

  const current = useMemo(
    () => vessels.find((v) => v.vessel_id === selected),
    [vessels, selected],
  );
  // The context names a hull this surface has no data for: say so, rather than
  // silently rendering the previous hull.
  // Only "out of scope" once the vessel list has actually arrived — before that
  // we do not know, and flashing a refusal during load would be a lie.
  const outOfScope = vessels.length > 0 && Boolean(selected) && !current;
  const hullLabel = current
    ? `${current.hull_no} ${current.availability_code}`
    : (PICKABLE_HULLS.find((h) => h.id === selected)?.label ?? "— no hull");

  const projecting = frame !== null && isProjection(asOf, frame.now, horizon);

  /**
   * Points the shell at a hull, clearing the instant in the same update.
   *
   * The reset has to happen here rather than in the timeframe effect. An effect
   * runs *after* the render that changed the hull, so every fetch keyed on
   * `[vesselId, asOf]` had already fired with the previous hull's instant — and a
   * scrubbed instant from a six-month availability is out of range on a hull whose
   * own availability has not opened. The 422 then landed after the corrected
   * fetch succeeded and left a permanent "out of scope" screen on a hull that had
   * loaded perfectly. One state update, one fetch, no race.
   */
  const pickHull = (id: string) => {
    setSelected(id);
    setAsOf(null);
    setPlaying(false);
    setFrame(null);
  };

  // A space named in the boot URL routes exactly like an alert would, once the
  // register is here to resolve it.
  useEffect(() => {
    if (BOOT.space) setFocus(BOOT.space);
  }, []);

  // Write the shareable state back to the URL.
  useEffect(() => {
    const q = new URLSearchParams();
    if (asOf !== null) q.set("as_of", String(asOf));
    if (sharedSpace) q.set("space", sharedSpace);
    const qs = q.toString();
    window.history.replaceState(null, "", `#/${selected}/${module.id}${qs ? `?${qs}` : ""}`);
  }, [selected, module, asOf, sharedSpace]);

  const jump = (compartment: string) => {
    if (module.id !== DECK_EXPLORER.id) setReturnTo(module);
    setModule(DECK_EXPLORER);
    setAltitude("compartment");
    setFocus(compartment);
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: C.bg,
        color: C.text,
        fontFamily: "system-ui, sans-serif",
        // Handling markings are fixed to both edges, so the app sits inside them.
        padding: `${MARKING_H}px 0`,
      }}
    >
      <ClassificationBanner edge="top" />

      <TopBar
        onCollapse={() => setCollapsed(!collapsed)}
        hulls={hulls}
        selected={selected}
        onSelectVessel={pickHull}
        hullLabel={hullLabel}
        persona={persona}
        onPersona={(p) => {
          setPersona(p);
          // The persona's whole job in this shell: it decides where the reader
          // starts in both dimensions — the height the Deck Explorer opens at,
          // so an executive does not navigate down from the hull every morning
          // and a foreman does not start at the hull, and the time resolution,
          // so neither has to change the horizon before reading anything.
          setAltitude(p.altitude);
          setHorizon(p.horizon);
          setModule(DECK_EXPLORER);
        }}
        rows={rows}
        issues={issues}
        onJump={jump}
        onOpenIssues={() => {
          const leverage = MODULES.find((m) => m.id === "leverage");
          if (leverage) setModule(leverage);
        }}
        outOfScope={outOfScope}
      />

      <GuardrailStrip />

      {/* Time applies to every module, so the control sits in the chrome rather
          than inside one screen. Rendered only once a hull is picked: its bounds
          are that hull's availability. */}
      {selected && frame && (
        <TimeControl
          now={frame.now}
          availability={frame.availability}
          horizon={horizon}
          onHorizon={setHorizon}
          asOf={asOf}
          onAsOf={setAsOf}
          playing={playing}
          onPlaying={setPlaying}
        />
      )}

      {/* breadcrumb */}
      <div style={{ display: "flex", gap: 9, alignItems: "center", padding: "7px 16px", borderBottom: `1px solid ${C.hairline}`, fontSize: 11.5, flexWrap: "wrap" }}>
        {outOfScope && (
          <span style={{ padding: "2px 9px", borderRadius: 4, border: "1px solid rgba(220,38,38,0.45)", background: "rgba(220,38,38,0.14)", color: C.danger, fontFamily: "monospace", fontWeight: 700 }}>
            OUT OF SCOPE — not assigned to you
          </span>
        )}
        <button
          onClick={() => setModule(MODULES[5] as ModuleDef)}
          style={{ background: "none", border: "none", padding: 0, font: "inherit", color: C.dim, cursor: "pointer" }}
        >
          Portfolio
        </button>
        <span style={{ color: "#424656" }}>▸</span>
        <span style={{ color: C.bright }}>{hullLabel}</span>
        <span style={{ color: "#424656" }}>▸</span>
        <span style={{ color: C.accent, fontWeight: 600 }}>{module.label}</span>

        <span style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center", color: DIMMED }}>
          {/* Where the numbers come from. The prototype shows P6 ingest currency;
              this build has no scheduling import, so it states the provenance it
              does have rather than a plausible-looking date it does not. */}
          {/* This note used to read "evaluated live" unconditionally. With a
              time control that would be false on every scrubbed board — and
              this is the one line on screen whose whole job is to say where the
              numbers come from. */}
          <span
            title={
              projecting
                ? "Every state on screen was evaluated by the engine AT this instant — a real decision with a real trace, not an interpolation of the live one."
                : "Authorization is evaluated per request against the hull's live hazards; nothing here is cached"
            }
            style={{ color: projecting ? C.warn : undefined }}
          >
            engine · {projecting && frame ? `as of ${fmtInstant(asOf ?? frame.now, horizon)}` : "evaluated live"}
          </span>
          <span style={{ color: "#424656" }}>·</span>
          <button
            onClick={() => setWall(!wall)}
            title="POD-board presentation — larger type for a ship wall display or 10-ft viewing"
            style={{ background: wall ? C.raised : "transparent", border: `1px solid ${wall ? C.accent : C.line}`, borderRadius: 5, padding: "2px 8px", font: "inherit", fontSize: 11, color: wall ? C.text : C.dim, cursor: "pointer" }}
          >
            ⛶ {wall ? "Wall display on" : "Wall display"}
          </button>
        </span>
      </div>

      <div style={{ display: "flex", minHeight: "calc(100vh - 190px)" }}>
        <ModuleRail
          modules={MODULES}
          activeLabel={module.label}
          collapsed={collapsed}
          onPick={(m) => {
            // Picking a module by hand is a new journey; the back chip from the
            // last jump would point somewhere the reader has moved on from.
            setReturnTo(null);
            setModule(m);
          }}
          issueCount={issues.length}
        />

        <main
          style={{
            flex: 1,
            minWidth: 0,
            padding: "16px 20px",
            // Every size in this app is an explicit pixel value, so bumping a
            // root font-size would do nothing. `zoom` scales the whole board,
            // which is exactly what "readable from ten feet" asks for.
            zoom: wall ? 1.3 : undefined,
          }}
        >
          {error && (
            <p style={{ color: C.danger }}>
              API unreachable ({error}). Start it with{" "}
              <code>cargo run -p wadl-api --bin serve</code>.
            </p>
          )}

          {!error && needsHull && !selected && (
            <p style={{ color: C.dim, fontSize: 12.5 }}>Pick a hull to begin.</p>
          )}

          {!error && selected && module.id === "deckExplorer" && returnTo && (
            <button
              onClick={() => {
                const back = returnTo;
                setReturnTo(null);
                if (back) setModule(back);
              }}
              style={{
                position: "sticky", top: MARKING_H + 6, zIndex: 30, marginBottom: 8,
                font: "inherit", fontSize: 12, cursor: "pointer", padding: "5px 12px",
                borderRadius: 6, background: C.raised, color: C.text,
                border: `1px solid ${C.accent}`, boxShadow: "0 6px 18px rgba(0,0,0,0.4)",
              }}
            >
              ← Back to {returnTo.label}
            </button>
          )}
          {!error && selected && module.id === "deckExplorer" && (
            <DeckExplorer
              identity={DEMO_IDENTITY}
              vesselId={selected}
              hullLabel={hullLabel}
              altitude={altitude}
              onAltitude={setAltitude}
              focusCompartment={focus}
              onFocused={() => setFocus(null)}
              onSpaceChange={setSharedSpace}
              asOf={asOf}
            />
          )}

          {!error && selected && module.id === "workOrders" && (
            <WorkOrders
              identity={DEMO_IDENTITY}
              vesselId={selected}
              hullLabel={hullLabel}
              spaces={rows}
              onOpenSpace={jump}
              asOf={asOf}
            />
          )}

          {!error && selected && module.id === "dailyOps" && (
            <DailyOps
              identity={DEMO_IDENTITY}
              vesselId={selected}
              hullLabel={hullLabel}
              asOf={asOf}
              spaces={rows}
              onOpenSpace={jump}
            />
          )}

          {!error && selected && module.id === "sequenceBoard" && (
            <SequenceBoard
              identity={DEMO_IDENTITY}
              vesselId={selected}
              hullLabel={hullLabel}
              asOf={asOf}
              spaces={rows}
              onOpenSpace={jump}
            />
          )}

          {!error && selected && module.id === "leverage" && (
            <LeverageBoard
              identity={DEMO_IDENTITY}
              vesselId={selected}
              hullLabel={hullLabel}
              asOf={asOf}
              onOpenSpace={jump}
            />
          )}

          {!error && selected && module.id === "distPackages" && (
            <DistributedPackages
              identity={DEMO_IDENTITY}
              vesselId={selected}
              hullLabel={hullLabel}
              asOf={asOf}
              spaces={rows}
              onOpenSpace={jump}
            />
          )}

          {!error && selected && module.id === "ledger" && (
            <LedgerBoard
              identity={DEMO_IDENTITY}
              vesselId={selected}
              hullLabel={hullLabel}
              onOpenSpace={jump}
            />
          )}

          {!error && selected && module.id === "cascade" && (
            <CascadeBoard
              identity={DEMO_IDENTITY}
              vesselId={selected}
              hullLabel={hullLabel}
              asOf={asOf}
              spaces={rows}
              onOpenSpace={jump}
            />
          )}

          {!error && selected && module.id === "sources" && (
            <SourcesBoard
              identity={DEMO_IDENTITY}
              vesselId={selected}
              hullLabel={hullLabel}
              asOf={asOf}
              onOpenModule={(id) => {
                const target = MODULES.find((mod) => mod.id === id && mod.built);
                if (target) setModule(target);
              }}
            />
          )}

          {!error && module.id === "portfolio" && (
            <>
              <div style={{ fontSize: 10, letterSpacing: 1.1, textTransform: "uppercase", color: C.accent }}>Portfolio</div>
              <h1 style={{ fontSize: 22, margin: "4px 0 12px" }}>Assigned hulls</h1>
              <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))" }}>
                {vessels.map((v) => (
                  <button
                    key={v.vessel_id}
                    onClick={() => {
                      pickHull(v.vessel_id);
                      setModule(DECK_EXPLORER);
                    }}
                    style={{
                      textAlign: "left", font: "inherit", cursor: "pointer",
                      border: `1px solid ${v.vessel_id === selected ? C.accent : C.line}`,
                      borderRadius: 8, padding: 12, background: C.panel, color: C.text,
                    }}
                  >
                    <div style={{ fontFamily: "monospace", color: C.accent }}>{v.hull_no}</div>
                    <div style={{ fontWeight: 600 }}>{v.name}</div>
                    <div style={{ color: C.dim, fontSize: 12 }}>
                      {v.class_code} · {v.availability_code} · {v.confidence}
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}

          {!error && module.id === "placeholder" && (
            <>
              <div style={{ fontSize: 10, letterSpacing: 1.1, textTransform: "uppercase", color: C.accent }}>{module.label}</div>
              <h1 style={{ fontSize: 22, margin: "4px 0 8px" }}>Not built yet</h1>
              <p style={{ color: C.dim, fontSize: 12.5, maxWidth: 640 }}>
                This module is on the milestone-1 plan and has no view yet. It says so
                rather than rendering an empty frame that looks like missing data — and
                the rail marks it <b>soon</b> so the emptiness is never a surprise.
              </p>
            </>
          )}
        </main>
      </div>

      <ClassificationBanner edge="bottom" />
    </div>
  );
}

const DIMMED = "#7d8494";
