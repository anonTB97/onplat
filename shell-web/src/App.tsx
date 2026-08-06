import { useEffect, useMemo, useState } from "react";
import { listVessels, type VesselSummary } from "./api";
import { DEMO_IDENTITY, PICKABLE_HULLS } from "./demo";
import DeckExplorer from "./DeckExplorer";

// Module rail — mirrors the prototype's grouping. Modules without a view yet say
// so rather than rendering an empty shell.
type ModuleId = "portfolio" | "deckExplorer" | "placeholder";
const MODULES: Array<{ group: string; label: string; id: ModuleId }> = [
  { group: "Operate", label: "Daily Ops", id: "placeholder" },
  { group: "", label: "Deck Explorer", id: "deckExplorer" },
  { group: "Plan", label: "Sequence Board", id: "placeholder" },
  { group: "", label: "Work Orders", id: "placeholder" },
  { group: "Decide", label: "Conflicts & Risk", id: "placeholder" },
  { group: "Yard", label: "Portfolio", id: "portfolio" },
  { group: "Authorization", label: "Distributed Packages", id: "placeholder" },
  { group: "", label: "Deconfliction Cascade", id: "placeholder" },
];

const C = {
  bg: "#0b0c0e",
  panel: "#121316",
  line: "#2b2d36",
  rail: "linear-gradient(180deg,#0f2238 0%,#0b1830 100%)",
  text: "#f2f3f6",
  dim: "#94a3b8",
  accent: "#3D6BFF",
  danger: "#f87171",
};

export default function App() {
  const [vessels, setVessels] = useState<VesselSummary[]>([]);
  const [selected, setSelected] = useState<string>(PICKABLE_HULLS[0].id);
  const [activeModule, setActiveModule] = useState<ModuleId>("deckExplorer");
  const [activeLabel, setActiveLabel] = useState("Deck Explorer");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listVessels(DEMO_IDENTITY)
      .then(setVessels)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  const current = useMemo(
    () => vessels.find((v) => v.vessel_id === selected),
    [vessels, selected],
  );
  // The context names a hull this surface has no data for: say so, rather than
  // silently rendering the previous hull.
  const outOfScope = !current;
  const hullLabel = current
    ? `${current.hull_no} ${current.availability_code}`
    : PICKABLE_HULLS.find((h) => h.id === selected)?.label ?? "—";

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "system-ui, sans-serif" }}>
      {/* guardrail strip */}
      <div style={{ display: "flex", gap: 14, alignItems: "center", padding: "6px 18px", background: C.panel, borderBottom: `1px solid ${C.line}`, fontSize: 12, flexWrap: "wrap" }}>
        <span><b>Decision support</b> — flags risk; the planner decides. Does not modify the schedule.</span>
        <span style={{ color: "#424656" }}>·</span>
        <span style={{ letterSpacing: 0.5 }}>ILLUSTRATIVE / NOTIONAL DATA</span>
        <span style={{ color: "#424656" }}>·</span>
        <span style={{ color: C.accent, fontWeight: 600 }}>IL5 / sovereign</span>
      </div>

      {/* breadcrumb + OUT OF SCOPE banner */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 18px", borderBottom: "1px solid #191a1f", fontSize: 12, flexWrap: "wrap" }}>
        {outOfScope && (
          <span style={{ padding: "2px 9px", borderRadius: 4, border: "1px solid rgba(220,38,38,0.45)", background: "rgba(220,38,38,0.14)", color: C.danger, fontFamily: "monospace", fontWeight: 700 }}>
            OUT OF SCOPE — not assigned to you
          </span>
        )}
        <span style={{ color: C.dim }}>Portfolio</span>
        <span style={{ color: "#424656" }}>▸</span>
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          style={{ background: "#20222b", color: C.text, border: `1px solid ${C.line}`, borderRadius: 6, padding: "4px 8px" }}
        >
          {PICKABLE_HULLS.map((h) => (
            <option key={h.id} value={h.id}>{h.label}</option>
          ))}
        </select>
        <span style={{ color: "#424656" }}>▸</span>
        <span style={{ color: C.accent, fontWeight: 600 }}>{activeLabel}</span>
      </div>

      <div style={{ display: "flex", minHeight: "calc(100vh - 78px)" }}>
        {/* module rail */}
        <nav style={{ width: 220, flex: "none", background: C.rail, borderRight: `1px solid ${C.line}`, padding: "8px 0" }}>
          {MODULES.map((m) => (
            <div key={m.label}>
              {m.group && (
                <div style={{ padding: "12px 15px 4px", fontSize: 9, letterSpacing: 1.3, textTransform: "uppercase", color: "#4b5060" }}>
                  {m.group}
                </div>
              )}
              <div
                onClick={() => { setActiveModule(m.id); setActiveLabel(m.label); }}
                style={{
                  padding: "9px 15px", fontSize: 13, cursor: "pointer",
                  color: m.label === activeLabel ? C.text : "#aab0bd",
                  borderLeft: `3px solid ${m.label === activeLabel ? C.accent : "transparent"}`,
                  background: m.label === activeLabel
                    ? "linear-gradient(90deg,rgba(61,107,255,0.16),rgba(61,107,255,0.02))"
                    : "transparent",
                }}
              >
                {m.label}
              </div>
            </div>
          ))}
        </nav>

        {/* content */}
        <main style={{ flex: 1, minWidth: 0, padding: "18px 22px" }}>
          {error && (
            <p style={{ color: C.danger }}>
              API unreachable ({error}). Start it with{" "}
              <code>cargo run -p wadl-api --bin serve</code>.
            </p>
          )}

          {activeModule === "deckExplorer" && !error && (
            <DeckExplorer identity={DEMO_IDENTITY} vesselId={selected} hullLabel={hullLabel} />
          )}

          {activeModule === "portfolio" && !error && (
            <>
              <div style={{ fontSize: 10, letterSpacing: 1.1, textTransform: "uppercase", color: C.accent }}>Portfolio</div>
              <h1 style={{ fontSize: 22, margin: "4px 0 12px" }}>Assigned hulls</h1>
              <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))" }}>
                {vessels.map((v) => (
                  <div key={v.vessel_id} style={{ border: `1px solid ${v.vessel_id === selected ? C.accent : C.line}`, borderRadius: 8, padding: 12, background: C.panel }}>
                    <div style={{ fontFamily: "monospace", color: C.accent }}>{v.hull_no}</div>
                    <div style={{ fontWeight: 600 }}>{v.name}</div>
                    <div style={{ color: C.dim, fontSize: 12 }}>
                      {v.class_code} · {v.availability_code} · {v.confidence}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {activeModule === "placeholder" && !error && (
            <>
              <div style={{ fontSize: 10, letterSpacing: 1.1, textTransform: "uppercase", color: C.accent }}>{activeLabel}</div>
              <h1 style={{ fontSize: 22, margin: "4px 0 8px" }}>Not built yet</h1>
              <p style={{ color: C.dim, fontSize: 12.5, maxWidth: 620 }}>
                This module is on the milestone-1 plan but has no view yet. It says so
                rather than rendering an empty frame that looks like missing data.
              </p>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
