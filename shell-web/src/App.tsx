import { useEffect, useMemo, useState } from "react";
import { deckStates, listVessels, type DeckStateRow, type VesselSummary } from "./api";
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
import { DEMO_IDENTITY, PICKABLE_HULLS } from "./demo";
import DeckExplorer from "./DeckExplorer";
import DistributedPackages from "./DistributedPackages";
import WorkOrders from "./WorkOrders";
import { C } from "./theme";

// The module rail, mirroring the prototype's grouping and order. `built` is
// honest rather than aspirational: a module with no view is labelled in the rail
// so nobody clicks expecting a screen and reads the emptiness as broken data.
const MODULES: ModuleDef[] = [
  { group: "Operate", label: "Daily Ops", id: "placeholder", icon: "dailyOps", built: false },
  { group: "", label: "Deck Explorer", id: "deckExplorer", icon: "deckExplorer", built: true },
  { group: "Plan", label: "Sequence Board", id: "placeholder", icon: "sequenceBoard", built: false },
  { group: "", label: "Work Orders", id: "workOrders", icon: "workOrders", built: true },
  { group: "Decide", label: "Conflicts & Risk", id: "placeholder", icon: "conflicts", built: false },
  { group: "Yard", label: "Portfolio", id: "portfolio", icon: "portfolio", built: true },
  { group: "Authorization", label: "Distributed Packages", id: "distPackages", icon: "distPackages", built: true },
  { group: "", label: "Deconfliction Cascade", id: "placeholder", icon: "cascade", built: false },
];

const DECK_EXPLORER = MODULES[1] as ModuleDef;

export default function App() {
  const [vessels, setVessels] = useState<VesselSummary[]>([]);
  const [rows, setRows] = useState<DeckStateRow[]>([]);
  const [selected, setSelected] = useState<string>(PICKABLE_HULLS[0]?.id ?? "");
  const [module, setModule] = useState<ModuleDef>(DECK_EXPLORER);
  const [persona, setPersona] = useState<Persona>(PERSONAS[0] as Persona);
  const [altitude, setAltitude] = useState<Altitude>((PERSONAS[0] as Persona).altitude);
  const [focus, setFocus] = useState<string | null>(null);
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
    deckStates(DEMO_IDENTITY, selected)
      .then(setRows)
      .catch(() => setRows([]));
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

  const jump = (compartment: string) => {
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
        onSelectVessel={setSelected}
        hullLabel={hullLabel}
        persona={persona}
        onPersona={(p) => {
          setPersona(p);
          // The persona's whole job in this shell: it decides the height the
          // Deck Explorer opens at, so an executive does not navigate down from
          // the hull every morning and a foreman does not start at the hull.
          setAltitude(p.altitude);
          setModule(DECK_EXPLORER);
        }}
        rows={rows}
        onJump={jump}
        outOfScope={outOfScope}
      />

      <GuardrailStrip />

      {/* breadcrumb */}
      <div style={{ display: "flex", gap: 9, alignItems: "center", padding: "7px 16px", borderBottom: "1px solid #191a1f", fontSize: 11.5, flexWrap: "wrap" }}>
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
        <span style={{ color: "#ccd1da" }}>{hullLabel}</span>
        <span style={{ color: "#424656" }}>▸</span>
        <span style={{ color: C.accent, fontWeight: 600 }}>{module.label}</span>

        <span style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center", color: DIMMED }}>
          {/* Where the numbers come from. The prototype shows P6 ingest currency;
              this build has no scheduling import, so it states the provenance it
              does have rather than a plausible-looking date it does not. */}
          <span title="Authorization is evaluated per request against the hull's live hazards; nothing here is cached">
            engine · evaluated live
          </span>
          <span style={{ color: "#424656" }}>·</span>
          <button
            onClick={() => setWall(!wall)}
            title="POD-board presentation — larger type for a ship wall display or 10-ft viewing"
            style={{ background: wall ? "#20222b" : "transparent", border: `1px solid ${wall ? C.accent : C.line}`, borderRadius: 5, padding: "2px 8px", font: "inherit", fontSize: 11, color: wall ? C.text : C.dim, cursor: "pointer" }}
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
          onPick={setModule}
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

          {!error && selected && module.id === "deckExplorer" && (
            <DeckExplorer
              identity={DEMO_IDENTITY}
              vesselId={selected}
              hullLabel={hullLabel}
              altitude={altitude}
              onAltitude={setAltitude}
              focusCompartment={focus}
              onFocused={() => setFocus(null)}
            />
          )}

          {!error && selected && module.id === "workOrders" && (
            <WorkOrders
              identity={DEMO_IDENTITY}
              vesselId={selected}
              hullLabel={hullLabel}
              spaces={rows}
              onOpenSpace={jump}
            />
          )}

          {!error && selected && module.id === "distPackages" && (
            <DistributedPackages identity={DEMO_IDENTITY} vesselId={selected} hullLabel={hullLabel} />
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
                      setSelected(v.vessel_id);
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
