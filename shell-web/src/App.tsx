import { useEffect, useMemo, useState } from "react";
import {
  deckStates,
  listIssues,
  listVessels,
  timeframe,
  whoami,
  type AsOf,
  type DeckStateRow,
  type Issue,
  type Timeframe,
  type VesselSummary,
  type WhoAmI,
} from "./api";
import {
  ClassificationBanner,
  loadRole,
  MARKING_H,
  ModuleRail,
  saveRole,
  StatusStrip,
  TopBar,
  type Altitude,
  type HullChoice,
  type ModuleDef,
  type Persona,
} from "./Chrome";
import DailyOps from "./DailyOps";
import { FirstRun } from "./FirstRun";
import { JobCard } from "./JobCard";
import { DEMO_IDENTITY, PICKABLE_HULLS } from "./demo";
import DeckExplorer from "./DeckExplorer";
import DistributedPackages from "./DistributedPackages";
import FieldGuide from "./FieldGuide";
import CascadeBoard from "./CascadeBoard";
import SourcesBoard from "./SourcesBoard";
import LedgerBoard from "./LedgerBoard";
import LeverageBoard from "./LeverageBoard";
import Reports from "./Reports";
import SequenceBoard from "./SequenceBoard";
import { fmtInstant, isProjection, TimeControl, type Horizon } from "./TimeControl";
import WorkOrders from "./WorkOrders";
import { C } from "./theme";

// The module rail, grouped the way a working day runs rather than the way the
// prototype was built: what is happening now, the plan at its three grains,
// the conflicts and their consequences, the data everything is built from,
// and the record. "Authorization" is gone as a group name — the strip above
// says the tool grants none, and a rail that said otherwise was arguing with
// it. `built` is honest rather than aspirational: a module with no view is
// labelled in the rail so nobody clicks expecting a screen and reads the
// emptiness as broken data.
const MODULES: ModuleDef[] = [
  { group: "Today", label: "Daily Ops", id: "dailyOps", icon: "dailyOps", built: true },
  { group: "", label: "Deck Explorer", id: "deckExplorer", icon: "deckExplorer", built: true },
  { group: "Plan", label: "Sequence Board", id: "sequenceBoard", icon: "sequenceBoard", built: true },
  { group: "", label: "Work Orders", id: "workOrders", icon: "workOrders", built: true },
  { group: "", label: "Distributed Packages", id: "distPackages", icon: "distPackages", built: true },
  { group: "Conflicts", label: "Conflicts & Risk", id: "leverage", icon: "conflicts", built: true },
  { group: "", label: "Deconfliction Cascade", id: "cascade", icon: "cascade", built: true },
  { group: "Data", label: "Data Sources", id: "sources", icon: "sources", built: true },
  { group: "", label: "Portfolio", id: "portfolio", icon: "portfolio", built: true },
  { group: "Record", label: "Decisions Ledger", id: "ledger", icon: "ledger", built: true },
  { group: "", label: "Reports", id: "reports", icon: "reports", built: true },
  { group: "Help", label: "Field Guide", id: "guide", icon: "guide", built: true },
];

const byId = (id: string): ModuleDef =>
  MODULES.find((m) => m.id === id && m.built) ?? (MODULES[1] as ModuleDef);
const DECK_EXPLORER = byId("deckExplorer");
const PORTFOLIO = byId("portfolio");
const INITIAL_ROLE = loadRole();

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
  // A URL names a screen; otherwise the role's front door is where the day
  // opens. Nobody lands on a deck plate because that is where the code starts.
  const [module, setModule] = useState<ModuleDef>(
    MODULES.find((m) => m.id === BOOT.module && m.built) ?? byId(INITIAL_ROLE.landing),
  );
  // Where a route-to-fix came FROM, so the door swings both ways: any jump
  // from another module leaves a "back" chip over the Deck Explorer.
  const [returnTo, setReturnTo] = useState<ModuleDef | null>(null);
  /** The Deck Explorer's selection, reported up for the shareable URL. */
  const [sharedSpace, setSharedSpace] = useState<string | null>(null);
  const [persona, setPersona] = useState<Persona>(INITIAL_ROLE);
  const [altitude, setAltitude] = useState<Altitude>(INITIAL_ROLE.altitude);
  // The zone in focus — one choice, every screen answers for it: the plates
  // and the whole-ship view blot out the rest of the hull, the register and
  // the lanes narrow to it, and next-door work stays visible. Held here
  // rather than inside the Deck Explorer so the Sequence Board reads the
  // same zone, and cleared on a hull switch: a zone is a place on one ship.
  const [zoneFocus, setZoneFocus] = useState<string | null>(null);
  useEffect(() => {
    setZoneFocus(null);
  }, [selected]);
  const [focus, setFocus] = useState<string | null>(null);
  /** The first-run cards can open the legend in the top bar. */
  const [legendOpen, setLegendOpen] = useState(false);
  // Whether the verdict reads below are a real answer. A failed read used to
  // become an empty list, and an empty list reads as "nothing held" on every
  // board — the one thing a failure must never look like.
  const [verdictsOk, setVerdictsOk] = useState<boolean | null>(null);
  // One instant, one horizon, for the whole app. A time control that meant a
  // different moment on each screen would be worse than none — the Deck Explorer
  // and the ship board would disagree about what is held, and neither would be
  // wrong. Held here for the same reason the altitude is.
  const [frame, setFrame] = useState<Timeframe | null>(null);
  const [asOf, setAsOf] = useState<AsOf>(BOOT.asOf ?? null);
  const [horizon, setHorizon] = useState<Horizon>(INITIAL_ROLE.horizon);
  const [playing, setPlaying] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [wall, setWall] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The server-resolved identity — org, assignments, and which trust mode
  // admitted the request. Fetched once; null renders as "identity unknown"
  // rather than guessing from the headers the shell itself sent.
  const [who, setWho] = useState<WhoAmI | null>(null);
  // The job card: one work order's whole story, opened from any board where
  // its code appears. App-owned so every surface opens the SAME card.
  const [jobCode, setJobCode] = useState<string | null>(null);
  // Bumped when a module changes the hull's served facts (an administrative
  // clearance). The shared reads below are keyed on it, so the top bar and the
  // alert bell move in the same refresh as the screen that made the change.
  const [dataEpoch, setDataEpoch] = useState(0);

  useEffect(() => {
    listVessels(DEMO_IDENTITY)
      .then(setVessels)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  useEffect(() => {
    let stale = false;
    whoami(DEMO_IDENTITY)
      .then((w) => {
        if (!stale) setWho(w);
      })
      .catch(() => {
        if (!stale) setWho(null);
      });
    return () => {
      stale = true;
    };
  }, []);

  // The hull's spaces, held at this level so the top bar can search and alert on
  // them. The Deck Explorer fetches its own — one extra read of a small endpoint
  // is a better trade than threading its state up through the chrome.
  useEffect(() => {
    if (!selected) return undefined;
    // Guarded against reordering: with the time control playing, asOf changes
    // every tick — a slow response for one instant landing after a faster
    // later one would leave every consumer of `rows` at the wrong instant.
    let stale = false;
    // Both reads succeed or the pair is marked failed: a bell that counted
    // issues over spaces it could not read would be half an answer wearing
    // the confidence of a whole one.
    const rowsRead = deckStates(DEMO_IDENTITY, selected, asOf);
    const issuesRead = listIssues(DEMO_IDENTITY, selected, asOf);
    // The register lands as soon as it is read — the lanes, the plates and
    // the search all place work by it — while the verdict's confidence waits
    // for the pair. On a carrier-sized hull the issues read is the slow one.
    rowsRead
      .then((r) => {
        if (!stale) setRows(r);
      })
      .catch(() => {
        /* the pair below reports the failure */
      });
    Promise.all([rowsRead, issuesRead])
      .then(([r, i]) => {
        if (stale) return;
        setRows(r);
        setIssues(i.issues);
        setVerdictsOk(true);
      })
      .catch(() => {
        if (stale) return;
        setRows([]);
        setIssues([]);
        setVerdictsOk(false);
      });
    return () => {
      stale = true;
    };
  }, [selected, asOf, dataEpoch]);

  // The hull's time frame. Re-read on hull change and never cached across hulls:
  // each availability has its own bounds, and scrubbing one hull's window over
  // another's data is how a projection ends up outside the range the API accepts.
  useEffect(() => {
    setJobCode(null);
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
        who={who}
        persona={persona}
        onPersona={(p) => {
          setPersona(p);
          saveRole(p);
          // A role is a front door: it decides where the reader starts in all
          // three dimensions — the screen, the height the Deck Explorer opens
          // at, and the time resolution — so nobody navigates to their own
          // morning from somebody else's.
          setAltitude(p.altitude);
          setHorizon(p.horizon);
          setReturnTo(null);
          setModule(byId(p.landing));
        }}
        rows={rows}
        issues={issues}
        verdictsOk={verdictsOk}
        legendOpen={legendOpen}
        onLegendOpened={() => setLegendOpen(false)}
        onJump={jump}
        onOpenIssues={() => setModule(byId("leverage"))}
        outOfScope={outOfScope}
      />

      <StatusStrip rows={rows} issues={issues} verdictsOk={outOfScope ? null : verdictsOk} />

      {/* Time applies to every module, so the control sits in the chrome rather
          than inside one screen. Rendered only once a hull is picked: its bounds
          are that hull's availability. */}
      {jobCode && selected && (
        <JobCard
          identity={DEMO_IDENTITY}
          vesselId={selected}
          code={jobCode}
          asOf={asOf}
          now={frame?.now ?? null}
          spaces={rows}
          onOpenSpace={(no) => {
            setJobCode(null);
            jump(no);
          }}
          onClose={() => setJobCode(null)}
        />
      )}

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
          onClick={() => setModule(PORTFOLIO)}
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

          {!error && selected && module.built && module.id !== "guide" && (
            <FirstRun
              roleName={persona.name}
              opens={persona.opens}
              onOpenGuide={() => setModule(byId("guide"))}
              onOpenLegend={() => setLegendOpen(true)}
            />
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
              horizon={horizon}
              now={frame?.now ?? null}
              onMutated={() => setDataEpoch((n) => n + 1)}
              zoneFocus={zoneFocus}
              onZoneFocus={setZoneFocus}
            />
          )}

          {!error && selected && module.id === "workOrders" && (
            <WorkOrders
              identity={DEMO_IDENTITY}
              onOpenJob={setJobCode}
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
              onOpenJob={setJobCode}
              vesselId={selected}
              hullLabel={hullLabel}
              asOf={asOf}
              spaces={rows}
              verdictsOk={outOfScope ? null : verdictsOk}
              onOpenSpace={jump}
            />
          )}

          {!error && selected && module.id === "sequenceBoard" && (
            <SequenceBoard
              identity={DEMO_IDENTITY}
              onOpenJob={setJobCode}
              vesselId={selected}
              hullLabel={hullLabel}
              asOf={asOf}
              spaces={rows}
              onOpenSpace={jump}
              zoneFocus={zoneFocus}
              onZoneFocus={setZoneFocus}
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
              now={frame?.now ?? null}
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

          {!error && selected && module.id === "reports" && (
            <Reports
              identity={DEMO_IDENTITY}
              vesselId={selected}
              hullLabel={hullLabel}
              asOf={asOf}
              spaces={rows}
              issues={issues}
              verdictsOk={outOfScope ? null : verdictsOk}
              role={persona.name}
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

          {!error && module.id === "guide" && (
            <FieldGuide
              onOpenModule={(id) => {
                const target = MODULES.find((mod) => mod.id === id && mod.built);
                if (target) setModule(target);
              }}
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
                This module is on the plan and has no view yet. It says so rather than
                rendering an empty frame that looks like missing data — and the rail
                marks it <b>soon</b> so the emptiness is never a surprise.
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
